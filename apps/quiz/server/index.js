/**
 * 学生综合答题平台 —— 应用装配入口
 * ----------------------------------------------------------
 * 职责：
 *   - express 中间件（JSON body parser、错误兜底）
 *   - 挂载 /api 业务路由
 *   - 静态托管 client/ 与 data/uploads/（题目图片 / 提示音）
 *   - 通配路由兜底回 index.html（History API 路由安全网）
 *   - 导出 app 供明星学校主应用挂载到 /quiz（登录守卫由主入口统一施加）
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const apiRouter = require('./routes/api');
const store = require('./store');

const PORT = process.env.PORT || 3700;

const app = express();

// JSON body 上限 10MB：题目图片 / 提示音走 base64 上传
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 启动时确保数据文件存在（幂等）
store.init();

// —— /api 业务路由 ——
app.use('/api', apiRouter);

// —— 未匹配的 /api 请求返回 JSON 404（避免被下面的 SPA 兜底成 HTML） ——
app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: '接口不存在' });
});

// —— 上传文件静态托管（题目图片、提示音） ——
const UPLOAD_DIR = path.resolve(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// —— client 静态托管（HTML 禁缓存，确保改动即时生效） ——
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR, {
    redirect: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set({
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
        }
    }
}));

/** 通配兜底：未匹配路径都回 index.html（前端自行按 pathname 路由） */
app.get('*', (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// —— 全局错误兜底 ——
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ ok: false, error: '文件太大，请选择小一些的文件' });
    }
    console.error('[quiz-server] 未捕获错误：', err);
    res.status(500).json({ ok: false, error: '服务器内部错误' });
});

module.exports = app;

// 独立运行时的监听（主项目挂载时不走这里）
if (require.main === module) {
    app.listen(PORT, () => {
        console.log('\n====== 学生综合答题平台 启动成功 ======');
        console.log(`监听地址:  http://localhost:${PORT}`);
        console.log(`数据目录:  ${store.DATA_DIR}`);
        console.log('======================================\n');
    });
}
