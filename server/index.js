/**
 * 明星学校 —— 统一入口服务
 * ----------------------------------------------------------
 * 六个子应用挂载点（正式代码位于 apps/，docs/ 仅作参考不参与运行）：
 *   /drive      → 明星云网盘（apps/drive）
 *   /roulette   → 幸运转盘（apps/roulette）
 *   /broadcast  → 明星广播器（apps/broadcast）
 *   /shop       → 明星商店（apps/shop）
 *   /quiz       → 学生综合答题平台（apps/quiz，考试 / 练习 / 错题本 / 题库管理）
 *   /live       → 明星直播（apps/live，WebRTC 信令 + 手机麦克风配对）
 *
 * 访问规则：
 *   /          门户首页（公开，显示功能入口）
 *   /login     统一登录页（公开）
 *   其余子应用默认需要登录，未登录自动跳转 /login，登录后跳回
 *   直播例外：手机扫码页（/live/?role=app&...）与 WebSocket 信令不需要登录
 *
 * 会话说明：
 *   统一登录页调用网盘登录接口 /drive/api/auth/login，成功后浏览器
 *   写入 cookie token，网盘内存会话表登记 userId；主应用与网盘共用
 *   该会话，无需另建用户体系。
 */
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');

// 端口必须在加载转盘应用之前确定：转盘的 dotenv 会向 process.env 写入 PORT=8080
const PORT = process.env.PORT || 80;

// 各子应用（入口文件已改为导出 app）
const driveApp = require('../apps/drive/server/index');
const wheelApp = require('../apps/roulette/server/index');
const broadcastApp = require('../apps/broadcast/server/index');
const shopApp = require('../apps/shop/server/index');
// 学生综合答题平台：导出 express app，挂载到 /quiz（登录守卫由下方统一施加）
const quizApp = require('../apps/quiz/server/index');
// 邻语 IM：导出 express app，挂载到 /im（会话 / 消息接口由子应用自身提供）
const imApp = require('../apps/im/server/index');
// 邻语实时推送：消息发送后通过 WebSocket 立即通知在线成员
const imWs = require('../apps/im/server/ws');
// 直播子应用：导出 express app，并额外提供 attachWebSocket 用于挂载信令通道
const liveApp = require('../apps/live/server');

// 统一内存会话表（全站唯一实例：主项目登录、网盘、转盘共用）
const sessions = require('./core/sessions');
// 服务端多语言提示（语言包与前端共用 public/assets/locales）
const i18n = require('./core/i18n');
// 统一用户数据层（server/data/users.json）
const userStore = require('./core/userStore');
// 主项目统一 API（登录 / 用户管理 / 个人资料 / 邮件）
const apiRoutes = require('./routes/api');
// 邮件模块：注册「用户改 ID」回调，让邮箱绑定跟随 ID 迁移
const mailer = require('./core/mailer');
userStore.onIdChange((oldId, newId) => mailer.migrateBinding(oldId, newId));

/** 门户静态页面目录（首页与登录页） */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

// ============ 基础中间件 ============
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));   // 与网盘头像上传接口对齐：base64 图片请求体可达数 MB
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/**
 * 登录校验中间件：保护三个子应用
 * 未登录时：API 请求返回 401 JSON，页面请求重定向到统一登录页并携带回跳地址
 * @param {import('express').Request} req Express 请求对象
 * @param {import('express').Response} res Express 响应对象
 * @param {import('express').NextFunction} next 下一个中间件
 */
function requireLogin(req, res, next) {
  // 登录接口必须在未登录状态可访问，否则无法完成登录（req.path 已去掉挂载前缀）
  if (req.path === '/api/auth/login') return next();

  const token = sessions.getTokenFromRequest(req);   // cookie 或 Authorization: Bearer
  const userId = token ? sessions.getUserId(token) : undefined;
  if (userId) return next();

  // API 类请求按请求语言返回 JSON 错误
  if (req.originalUrl.includes('/api/')) {
    return res.status(401).json({
      success: false,
      message: i18n.t('server.auth.notLoggedIn', {}, i18n.resolveLang(req))
    });
  }
  // 页面请求：跳统一登录页，next 记录登录后要回到的地址
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// ============ 子应用挂载（先挂登录守卫） ============
app.use('/drive', requireLogin, driveApp);
app.use('/roulette', requireLogin, wheelApp);
app.use('/broadcast', requireLogin, broadcastApp);
app.use('/shop', requireLogin, shopApp);
// 学生综合答题平台：考试 / 练习 / 错题本 / 题库管理
app.use('/quiz', requireLogin, quizApp);
app.use('/im', requireLogin, (req, res, next) => {
  // Android 原生 HttpURLConnection 不支持 PATCH，允许用 POST + 覆盖头还原为 PATCH
  if (req.method === 'POST' && req.get('X-HTTP-Method-Override') === 'PATCH') {
    req.method = 'PATCH';
  }
  next();
}, imApp);

/**
 * 直播子应用的登录 / 角色守卫
 * 角色划分：
 *   ?role=app          手机扫码采集麦克风的页面，由外部设备打开，必须免登录
 *   /channel/:n        观看页（n = 1~4），任意已登录用户都可进入
 *   ?role=viewer       旧版观看页参数，保留兼容
 *   /stream            主播页，仅管理员可进入；普通用户自动转到 1 号频道观看页
 *   /（直播首页）      已登录用户一律转到观看页，主播页从观看页侧边栏「设置」进入
 * WebSocket 信令走 HTTP Upgrade，不经过 express 中间件；主播身份由 verifyHost 校验。
 * @param {import('express').Request} req Express 请求
 * @param {import('express').Response} res Express 响应
 * @param {import('express').NextFunction} next 下一个中间件
 */
function requireLoginForLive(req, res, next) {
  // 手机端页面及其配置请求携带 role=app，直接放行
  if (req.query.role === 'app') return next();

  // /channel/N 观看页路由（req.path 已去掉挂载前缀 /live；仅 1~4 为合法频道）
  const channelRoute = /^\/channel\/([1-4])\/?$/.exec(req.path || '');  // 观看页路径匹配结果

  // 桌面客户端嵌入式画面页 /media：登录即可访问（主播权限由信令层 verifyHost 校验）
  const mediaRoute = /^\/media\/?$/.test(req.path || '');               // 是否为嵌入式画面页

  const token = sessions.getTokenFromRequest(req);
  const userId = token ? sessions.getUserId(token) : undefined;
  if (!userId) return requireLogin(req, res, next);

  // 直播首页 /live：所有用户（含管理员）默认进入观看页，
  // 主播页需从观看页侧边栏「设置」进入 /live/stream，避免管理员直接落到主播端
  if ((req.path === '/' || req.path === '') && !req.query.role) {
    const chNum = parseInt(String(req.query.ch || '').replace(/^ch/i, ''), 10);  // 频道编号（ch1 → 1）
    const target = (chNum >= 1 && chNum <= 4) ? chNum : 1;
    return res.redirect('/live/channel/' + target);
  }

  // 观看页与画面页：已登录即可（管理员、普通用户都能观看）
  if (req.query.role === 'viewer' || channelRoute || mediaRoute) return next();

  // 主播页仅管理员可用（入口按钮也只对管理员展示）
  if (!userStore.isAdminId(userId)) {
    if (req.originalUrl.includes('/api/')) {
      return res.status(403).json({ success: false, message: '仅管理员可使用直播功能' });
    }
    // 普通用户访问主播页时自动转入观看页（优先沿用路径中的频道编号）
    const num = channelRoute ? channelRoute[1] : '1';
    return res.redirect('/live/channel/' + num);
  }
  return next();
}
app.use('/live', requireLoginForLive, liveApp);

/**
 * 从 WebSocket Upgrade 请求中提取登录 token
 * Upgrade 请求不经过 express 中间件，req.cookies 为空，需手动解析 cookie 头；
 * 同时兼容 Authorization: Bearer（桌面 / 离线客户端）。
 * @param {import('http').IncomingMessage} req Upgrade 请求
 * @returns {string|undefined} 会话 token
 */
function tokenFromUpgradeRequest(req) {
  const rawCookie = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : '';
  const cookieMatch = /(?:^|;\s*)token=([^;]+)/.exec(rawCookie);
  if (cookieMatch) return decodeURIComponent(cookieMatch[1]);

  const header = (req.headers && req.headers.authorization) ? String(req.headers.authorization) : '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  return bearer ? bearer[1].trim() : undefined;
}

// ============ 主项目统一 API ============
// 网页客户端支持离线打开（file://），因此 /api 需要允许跨域读取响应。
// 客户端使用 Authorization: Bearer token，不依赖跨站 cookie，故关闭 credentials。
// 注意：同源页面仍正常走 cookie；这里的 CORS 只影响跨域请求的响应头。
app.use('/api', function (req, res, next) {
  // Chrome 私有网络访问（PNA）：允许 file:// 客户端访问本机 / 局域网服务器
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.set('Access-Control-Allow-Private-Network', 'true');
  }
  next();
}, cors({
  origin: true,                                            // 反射请求来源，兼容 file:// 的 null
  credentials: false,                                      // 客户端用 Bearer token，不需要跨域 cookie
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Type', 'Accept']
}));

/**
 * GET /api/health
 * 公开健康检查：供网页客户端「连接服务器」页探测地址是否可用
 */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: '明星学校', time: new Date().toISOString() });
});

// ============ 公开头像接口 ============

/** 用户头像目录：与网盘头像上传接口共用同一个物理目录（<id>.png） */
const AVATAR_DIR = path.join(__dirname, '..', 'apps', 'drive', 'server', 'assets', 'user');

/**
 * GET /api/user-avatar/:id
 * 公开头像接口：不校验登录即可获取用户头像
 * 为什么需要：/drive/assets/user 受登录守卫保护，未携带有效 token 的请求（如 Android 客户端）
 * 会被 302 跳转到登录页而拿不到图片，表现为头像一直空白。
 * 用户未设置头像时返回 404，客户端展示默认占位图。
 */
app.get('/api/user-avatar/:id', (req, res) => {
  const id = String(req.params.id || '');
  // 只允许字母、数字、下划线与连字符：与头像文件命名规则一致，同时防止路径穿越
  if (!/^[\w-]+$/.test(id)) {
    return res.status(400).json({ ok: false, message: '用户 ID 不合法' });
  }
  const file = path.join(AVATAR_DIR, id + '.png');
  if (!fs.existsSync(file)) {
    return res.status(404).json({ ok: false, message: '该用户未设置头像' });
  }
  // 头像可能被重新上传覆盖而地址不变，因此不允许使用旧缓存
  res.set('Cache-Control', 'no-cache');
  res.sendFile(file);
});

// 登录接口公开，其余接口在 routes/api.js 内部自行校验会话/管理员
app.use('/api', apiRoutes);

// ============ 主应用公共接口 ============

/**
 * GET /api/me
 * 返回当前登录状态与用户信息，供门户/设置页右上角展示
 * 包含：userId、name、isAdmin、头像（图片 URL 或纯色）、转盘皮肤
 */
app.get('/api/me', (req, res) => {
  const token = sessions.getTokenFromRequest(req);   // cookie 或 Bearer token
  const userId = token ? sessions.getUserId(token) : undefined;
  if (!userId) return res.json({ loggedIn: false });

  const entry = userStore.getUserById(userId);
  if (!entry) return res.json({ loggedIn: false });

  // 拼头像字段：网盘头像目录存在 <userId>.png 即为图片头像，否则无（纯色模式已移除）
  const avatar = userStore.hasAvatarFile(userId) ? `/drive/assets/user/${userId}.png` : null;

  res.json({
    loggedIn: true,
    userId,
    name: entry.name,
    isAdmin: userStore.isAdminId(userId),
    points: entry.points ?? 0,                                    // 积分（任意位数整数，缺省 0；超长时以字符串返回）
    avatar
  });
});

/**
 * POST /api/logout
 * 统一登出：销毁网盘内存会话并清除登录 cookie
 */
app.post('/api/logout', (req, res) => {
  const token = sessions.getTokenFromRequest(req);   // cookie 或 Bearer token
  if (token) sessions.removeSession(token);
  res.clearCookie('token');
  res.json({ success: true, message: '已退出登录' });
});

// ============ 门户页面 ============

/**
 * GET /login
 * 统一登录页
 */
app.get('/login', (req, res) => {
  // HTML 文档禁用启发式缓存：每次都向服务器验证，确保页面更新即时生效
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

/**
 * GET /settings
 * 平台设置中心（需登录）：头像、外观、转盘皮肤等
 */
app.get('/settings', requireLogin, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'settings.html'));
});

/**
 * GET /usermanagement
 * 用户管理页（需登录，页面内部再校验 Admin 角色）
 */
app.get('/usermanagement', requireLogin, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'usermanagement.html'));
});

/**
 * GET /mail
 * 邮件中心（需登录，页面内部再校验 Admin 角色）：邮件服务器配置、测试发送
 */
app.get('/mail', requireLogin, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'mail.html'));
});

// 门户静态资源（页面内引用的本地资源）
app.use(express.static(PUBLIC_DIR));

/**
 * GET /
 * 门户首页（公开访问），显示三个功能入口
 */
app.get('/', (req, res) => {
  // HTML 文档禁用启发式缓存：每次都向服务器验证，确保页面更新即时生效
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ============ 启动 ============
// 直播应用需要同时处理 HTTP 页面与 WebSocket 信令，
// 因此改用 http.createServer 创建服务，再把 Upgrade 交给直播应用处理。

/** 证书目录（Let's Encrypt 签发的泛域名证书 *.mingxingschool.cc.cd 放在 docs/ 下） */
const CERT_DIR = path.join(__dirname, '..', 'docs');
/** 证书链路径（服务器证书 + 中间证书，顺序为「站点证书在前」）：可用环境变量 SSL_CERT 覆盖 */
const SSL_CERT = process.env.SSL_CERT || path.join(CERT_DIR, 'mingxingschool.cc.cd-fullchain.pem');
/** 私钥路径：可用环境变量 SSL_KEY 覆盖 */
const SSL_KEY = process.env.SSL_KEY || path.join(CERT_DIR, 'mingxingschool.cc.cd-privkey.pem');
/** HTTPS 监听端口（公网默认 443）：可用环境变量 HTTPS_PORT 覆盖，端口被占用时改成 8443 等 */
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);

/**
 * 创建 HTTPS 服务（证书缺失或读取失败时返回 null，让 HTTP 照常运行）
 * @returns {import('https').Server|null} HTTPS 服务器实例
 */
function createHttpsServer() {
  if (!fs.existsSync(SSL_CERT) || !fs.existsSync(SSL_KEY)) {
    console.log('[https] 未找到证书，跳过 HTTPS：', SSL_CERT);
    return null;
  }
  try {
    /** TLS 选项：禁用 TLS 1.0/1.1（浏览器与微信内置浏览器均已不支持） */
    const tlsOptions = {
      cert: fs.readFileSync(SSL_CERT),
      key: fs.readFileSync(SSL_KEY),
      minVersion: 'TLSv1.2'
    };
    return https.createServer(tlsOptions, app);
  } catch (err) {
    console.error('[https] 证书或私钥读取失败，已跳过 HTTPS：', err.message);
    return null;
  }
}

/** 主 HTTP 服务（局域网与内网设备继续用 http:// 访问） */
const httpServer = http.createServer(app);
/** HTTPS 服务（公网域名走 https://），证书不可用时为 null */
const httpsServer = createHttpsServer();
/** 需要挂载 WebSocket 的服务器列表：HTTP、HTTPS 共用同一个信令实例，房间状态是同一份 */
const socketServers = httpsServer ? [httpServer, httpsServer] : [httpServer];

liveApp.attachWebSocket(socketServers, '/live', {
  /**
   * 校验开播权限：只有管理员 token 才允许 host:join
   * 观看端（viewer）与手机端（app）不受此限制。
   * @param {import('http').IncomingMessage} req Upgrade 请求
   * @returns {boolean} 是否允许开播
   */
  verifyHost: function (req) {
    const token = tokenFromUpgradeRequest(req);
    const userId = token ? sessions.getUserId(token) : undefined;
    return !!(userId && userStore.isAdminId(userId));
  }
});

// 邻语实时推送：浏览器/原生客户端连接 /im/ws 即可收到新消息
imWs.attachWebSocket(socketServers, '/im');

/**
 * 监听错误统一转成中文提示：端口占用 / 权限不足是部署时最常见的两类问题
 * @param {number} port 监听端口
 * @returns {(err: NodeJS.ErrnoException) => void} 错误处理函数
 */
function makeListenErrorHandler(port) {
  return function (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`[启动失败] 端口 ${port} 已被占用，请先关闭占用该端口的程序，或用环境变量改端口`);
    } else if (err.code === 'EACCES') {
      console.error(`[启动失败] 端口 ${port} 权限不足，请右键「以管理员身份运行」PowerShell 后再启动`);
    } else {
      console.error(`[启动失败] 端口 ${port} 监听失败：`, err.message);
    }
    process.exitCode = 1;
  };
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log('  明星学校 已启动');
  console.log(`  门户首页:  http://localhost:${PORT}/`);
  console.log(`  统一登录:  http://localhost:${PORT}/login`);
  console.log('  功能入口:');
  console.log(`    - 明星云网盘  http://localhost:${PORT}/drive`);
  console.log(`    - 幸运转盘    http://localhost:${PORT}/roulette`);
  console.log(`    - 明星广播器  http://localhost:${PORT}/broadcast`);
  console.log(`    - 明星商店    http://localhost:${PORT}/shop`);
  console.log(`    - 综合答题    http://localhost:${PORT}/quiz`);
  console.log(`    - 邻语        http://localhost:${PORT}/im`);
  console.log(`    - 明星直播    http://localhost:${PORT}/live/stream  （观看页 /live/channel/1~4）`);
  console.log('==================================================');
});
httpServer.on('error', makeListenErrorHandler(PORT));

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`  HTTPS:      https://www.mingxingschool.cc.cd/   （本机 https://localhost:${HTTPS_PORT}/）`);
    console.log('==================================================');
  });
  httpsServer.on('error', makeListenErrorHandler(HTTPS_PORT));
}
