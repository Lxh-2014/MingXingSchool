const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const https = require('https');
const fs = require('fs');
const { t } = require('./utils/locale');
const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const db = require('./utils/database');

const app = express();
const PORT = 8000;  // 服务器端口

const avatarDir = path.join(__dirname, 'assets/user');

// 确保头像目录存在
if (!fs.existsSync(avatarDir)) {
    fs.mkdirSync(avatarDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

/**
 * 认证中间件 - 检查请求是否携带有效的 token cookie
 * 对于 /api/ 路径返回 JSON 错误，对于页面路径返回重定向
 */
function checkAuth(req, res, next) {
    const token = req.cookies.token;  // 从 cookie 中获取 token
    if (token) {
        next();
    } else {
        // API 路径返回 JSON 错误，页面路径返回重定向
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ success: false, message: '未登录或登录已过期' });
        } else {
            res.redirect('/login');
        }
    }
}

app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);

// 头像上传接口（与其他 API 保持一致，不使用 checkAuth 中间件）
app.post('/api/avatar/upload', (req, res) => {
    const { userId } = req.body;
    const base64Data = req.body.avatarData;

    if (!userId || !base64Data) {
        console.log('头像上传失败: 缺少参数', { userId: !!userId, avatarData: !!base64Data });
        return res.status(400).json({ success: false, message: '缺少参数' });
    }

    try {
        // 提取图片格式和base64数据
        const match = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) {
            return res.status(400).json({ success: false, message: '无效的图片格式' });
        }

        const format = match[1];
        const base64String = match[2];

        // 仅允许支持的格式
        const allowedFormats = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
        if (!allowedFormats.includes(format.toLowerCase())) {
            return res.status(400).json({ success: false, message: '不支持的图片格式' });
        }

        // 解码base64数据
        const buffer = Buffer.from(base64String, 'base64');

        // 保存头像文件（统一使用 png 格式）
        const avatarPath = path.join(avatarDir, `${userId}.png`);
        fs.writeFileSync(avatarPath, buffer);

        // 把 users.json 里的头像状态更新为 picture
        if (!db.setAvatarPicture(userId)) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }

        console.log(`头像上传成功: ${userId}.png`);
        // avatar 路径带 /drive 前缀：本服务由主服务挂载在 /drive 下，静态目录实际地址为 /drive/assets/user
        res.json({ success: true, message: '头像上传成功', avatar: `/drive/assets/user/${userId}.png` });
    } catch (error) {
        console.error('头像上传失败:', error);
        res.status(500).json({ success: false, message: '头像上传失败: ' + error.message });
    }
});

// 获取头像
app.get('/api/avatar/:userId', (req, res) => {
    const { userId } = req.params;
    const avatarPath = path.join(avatarDir, `${userId}.png`);

    if (fs.existsSync(avatarPath)) {
        res.sendFile(avatarPath);
    } else {
        res.status(404).json({ success: false, message: '头像不存在' });
    }
});

// 保存头像颜色接口（改为写 users.json 的 color 字段）
app.post('/api/avatar/color', (req, res) => {
    const { userId, color } = req.body;

    if (!userId || color === undefined) {
        return res.status(400).json({ success: false, message: '缺少参数' });
    }

    // 空字符串 = 清除颜色
    if (color === '') {
        db.clearAvatarSetting(userId);
        return res.json({ success: true, message: '颜色清除成功' });
    }

    // 验证颜色格式（简单验证 #hex）
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
        return res.status(400).json({ success: false, message: '无效的颜色格式' });
    }

    if (!db.setAvatarColor(userId, color)) {
        return res.status(404).json({ success: false, message: '用户不存在' });
    }
    res.json({ success: true, message: '颜色保存成功' });
});

// 获取头像颜色接口（改为从 users.json 读 color 字段）
app.get('/api/avatar/color/:userId', (req, res) => {
    const { userId } = req.params;
    const entry = db.getUserById(userId);
    if (!entry || entry.avatar !== 'color') {
        return res.json({ success: true, color: null });
    }
    res.json({ success: true, color: entry.color || null });
});

// 获取版本号
app.get('/api/version', (req, res) => {
    const packageJson = require('../package.json');
    res.json({ version: packageJson.version });
});

// 远程版本文件配置
const VERSION_HOST = 'lxh-2014.github.io';          // 远程版本文件所在主机
const VERSION_PATH = '/MingXingDrive-Update/version.json';  // 远程版本文件路径

/**
 * 判断IP是否为环回/无效地址（DNS被路由器或运营商劫持时，域名常被解析到127.0.0.1）
 * @param {string} ip - 待判断的IPv4/IPv6地址
 * @returns {boolean} 属于环回或无效地址时返回true
 */
function isLoopbackIP(ip) {
    if (!ip) return true;
    if (ip === '::1' || ip === '::') return true;
    // 匹配 127.x.x.x 段以及 0.0.0.0
    return /^127\./.test(ip) || ip === '0.0.0.0';
}

/**
 * 通过加密DNS（DoH，走443端口）查询域名真实IPv4地址
 * 用于传统DNS（53端口）被劫持时的兜底解析
 * @param {string} hostname - 待查询的域名
 * @returns {Promise<string|null>} 查询成功返回IPv4地址，失败返回null
 */
function resolveIPByDoH(hostname) {
    return new Promise((resolve) => {
        // 阿里云公共DoH服务的JSON查询接口
        const dohURL = `https://223.5.5.5/resolve?name=${encodeURIComponent(hostname)}&type=A`;
        const dohReq = https.get(dohURL, {
            headers: { 'accept': 'application/dns-json' },
            timeout: 6000
        }, (dohRes) => {
            let body = '';  // DoH响应内容
            dohRes.on('data', (chunk) => { body += chunk; });
            dohRes.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    // 从应答记录中取出第一条A记录（type为1表示IPv4地址）
                    const aRecord = (json.Answer || []).find((item) => item.type === 1);
                    resolve(aRecord ? aRecord.data : null);
                } catch (err) {
                    resolve(null);
                }
            });
        });
        dohReq.on('error', () => resolve(null));
        dohReq.on('timeout', () => {
            dohReq.destroy();
            resolve(null);
        });
    });
}

/**
 * 向指定IP发起HTTPS请求获取远程版本文件内容
 * @param {string|null} ip - 指定连接的IP；为null时按系统DNS正常解析
 * @returns {Promise<string>} 版本文件的原始文本内容
 */
function requestVersionFile(ip) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: ip || VERSION_HOST,
            port: 443,
            path: VERSION_PATH,
            method: 'GET',
            headers: { 'Host': VERSION_HOST },  // 指定HTTP主机头
            servername: VERSION_HOST,           // 指定TLS的SNI，保证证书校验正常
            timeout: 8000                        // 请求超时时间（毫秒）
        };

        const request = https.request(options, (httpsRes) => {
            let data = '';  // 响应数据累积
            httpsRes.on('data', (chunk) => { data += chunk; });
            httpsRes.on('end', () => {
                if (httpsRes.statusCode !== 200) {
                    reject(new Error('远程服务器返回状态码: ' + httpsRes.statusCode));
                    return;
                }
                resolve(data);
            });
        });

        request.on('error', reject);
        request.on('timeout', () => {
            request.destroy(new Error('请求远程版本超时'));
        });
        request.end();
    });
}

// 代理获取远程版本号（避免 CORS，并兼容本地DNS被劫持的网络环境）
app.get('/api/remote-version', async (req, res) => {
    try {
        let useIP = null;  // 最终连接使用的IP，null表示走系统DNS

        // 第一步：检查系统DNS的解析结果是否异常
        try {
            const dns = require('dns').promises;
            const lookupResult = await dns.lookup(VERSION_HOST, { family: 4 });
            if (isLoopbackIP(lookupResult.address)) {
                console.warn(`系统DNS将 ${VERSION_HOST} 解析到异常地址 ${lookupResult.address}，改用DoH兜底解析...`);
                useIP = await resolveIPByDoH(VERSION_HOST);
            }
        } catch (dnsErr) {
            // 系统DNS查询本身失败时，同样尝试DoH兜底
            useIP = await resolveIPByDoH(VERSION_HOST);
        }

        // 第二步：获取并解析远程版本文件
        const rawData = await requestVersionFile(useIP);
        const versionData = JSON.parse(rawData);

        // 返回完整的版本数据，确保 can_UpdateVersions 字段存在
        res.json({
            version: versionData.version,
            can_UpdateVersions: versionData.can_UpdateVersions || []
        });
    } catch (error) {
        console.error('获取远程版本失败:', error.message);
        res.status(502).json({ error: '获取远程版本失败: ' + error.message });
    }
});

// 网盘自带 /settings 与 /admin 页面已删除：设置收口到主项目 /settings，
// 用户管理收口到主项目 /usermanagement，管理功能不再挂在网盘路径下

app.get('/files/*', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.get('/files', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.use((req, res, next) => {
    const url = req.path;
    // 挂载到主应用后，登录统一走根 /login，不再渲染网盘自带登录页
    if (url === '/') {
        res.sendFile(path.join(__dirname, '../client/index.html'));
    } else if (url === '/login') {
        res.redirect('/login');
    } else {
        next();
    }
});

app.use(express.static(path.join(__dirname, '../client'), {
  // HTML 文档禁用启发式缓存：每次都向服务器验证，确保页面更新即时生效
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));
app.use('/docs', express.static(path.join(__dirname, '../docs')));
app.use('/assets/user', express.static(avatarDir));

// 导出 app，供明星学校主应用挂载到 /drive
module.exports = app;

// 仅独立运行（node server/index.js）时才启动监听
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`${t('server.startupMessage')}: http://127.0.0.1:${PORT}`);
    });
}
