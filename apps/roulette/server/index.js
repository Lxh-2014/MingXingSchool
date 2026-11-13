/**
 * 做个决定平台 - Node.js + JSON 文件存储（已接入明星学校统一认证）
 * ----------------------------------------------------------
 * 认证说明：
 *   不再自带登录/JWT。统一使用主项目 cookie 会话（token）与统一用户库
 *   （server/data/users.json）。未登录由主项目 /roulette 守卫拦截。
 *
 * 数据源：
 *   主项目 server/data/users.json —— 用户表（统一用户库，只读）
 *   wheel/{id}.json               —— 转盘表（每个转盘一个文件）
 *
 * 接口：
 *   GET   /api/auth/me           当前用户（cookie 会话）
 *   GET   /api/wheels            GET/POST/PATCH/DELETE /api/wheels/:id
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

/** 统一用户数据层（主项目） */
const userStore = require(path.join(__dirname, '..', '..', '..', 'server', 'core', 'userStore'));
/** 统一内存会话表（主项目，与网盘/主登录共享同一实例） */
const sessions = require(path.join(__dirname, '..', '..', '..', 'server', 'core', 'sessions'));
/** 转盘数据存储层（wheel/*.json） */
const store = require('./data/store');

// 注册用户 id 变更回调：主项目用户改 ID 时，同步迁移转盘归属（user_id 字段）
userStore.onIdChange((oldId, newId) => {
  const n = store.reassignOwner(oldId, newId);
  if (n > 0) console.log(`[转盘] 用户 ${oldId} 改名为 ${newId}，已迁移 ${n} 个转盘归属`);
});

/**
 * 把转盘条目转成 API 返回格式（id 已由存储层拼入对象）
 * 附带 creator_name：从统一用户库查创建者显示名（查不到回退 user_id）
 * @param {{id:string, user_id:string, name:string, options?:any, colors?:any, background_image?:string|null, background_color?:string|null, is_private?:boolean, sort_order?:number, created_at?:string, updated_at?:string}} w
 */
function toWheel(w) {
  if (!w) return null;
  const owner = userStore.getUserById(w.user_id);   // 创建者条目（统一用户库）
  return {
    id: w.id,
    user_id: w.user_id,
    creator_name: owner ? owner.name : w.user_id,   // 创建者显示名
    name: w.name,
    options: Array.isArray(w.options) ? w.options : [],
    colors: w.colors || null,
    background_image: w.background_image || null,
    background_color: w.background_color || null,
    is_private: !!w.is_private,
    sort_order: w.sort_order || 0,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

const app = express();

// ============ 中间件 ============
// cookie 解析：主项目已在挂载前解析过，这里重复解析是为了支持独立运行模式
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'client'), {
  // HTML 文档禁用启发式缓存：每次都向服务器验证，确保页面更新即时生效
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));

/**
 * 从 cookie 会话解析当前登录用户 id
 * @param {import('express').Request} req Express 请求对象
 * @returns {string | undefined} 未登录返回 undefined
 */
function currentUserId(req) {
  const token = req.cookies && req.cookies.token;
  return token ? sessions.getUserId(token) : undefined;
}

/**
 * cookie 会话认证中间件（替代原 JWT Bearer）
 * 认证通过后挂 req.user = { sub, username, role }，字段与原 JWT payload 一致
 */
function requireAuth(req, res, next) {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或登录已过期' });
  const entry = userStore.getUserById(userId);
  if (!entry) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.user = {
    sub: userId,                                        // 用户 id（与原 JWT payload.sub 一致）
    username: entry.name,                               // 姓名
    role: entry.role || (userId === userStore.ADMIN_ID ? 'admin' : 'user'),  // 角色
  };
  next();
}

/** 管理员权限 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ============ Auth API ============

/**
 * 当前用户信息（cookie 会话版）
 * 响应格式与原 JWT 版一致：{ id, username, role, theme }
 */
app.get('/api/auth/me', requireAuth, (req, res) => {
  const entry = userStore.getUserById(req.user.sub);
  if (!entry) return res.status(404).json({ error: '用户不存在' });
  // 头像地址：网盘头像目录存在 <id>.png 即返回图片 URL，否则 null（前端回退平台默认头像图）
  // 注意：用户数据已精简为 name/psw/role 三字段，avatar 状态只能按头像文件是否存在推导
  const avatar = userStore.hasAvatarFile(req.user.sub) ? `/drive/assets/user/${req.user.sub}.png` : null;
  res.json({
    id: req.user.sub,
    username: entry.name,
    role: req.user.role,
    theme: entry.theme || 'blue',
    avatar,
  });
});

// ============ Wheels ============

/** 转盘列表（按角色过滤私密转盘可见性） */
app.get('/api/wheels', requireAuth, (req, res) => {
  const list = store.listWheels({ userId: req.user.sub, admin: req.user.role === 'admin' });
  res.json(list.map(toWheel));
});

/**
 * 单个转盘（公开转盘无需登录；私密转盘要求 cookie 会话且为 owner 或 admin）
 */
app.get('/api/wheels/:id', (req, res) => {
  const id = req.params.id;
  const raw = store.findWheelById(id);
  if (!raw) return res.status(404).json({ error: '转盘不存在' });
  if (raw.is_private) {
    const userId = currentUserId(req);
    if (!userId) return res.status(403).json({ error: '无权访问私密转盘' });
    const isOwner = userId === raw.user_id;
    const isAdmin = userStore.isAdminId(userId);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: '无权访问私密转盘' });
  }
  res.json(toWheel(raw));
});

/** 创建转盘 */
app.post('/api/wheels', requireAuth, (req, res) => {
  const { name, options, colors, background_image, background_color, is_private } = req.body || {};
  if (!name) return res.status(400).json({ error: '请输入转盘名称' });
  if (!Array.isArray(options)) return res.status(400).json({ error: 'options 必须是数组' });

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const saved = store.saveWheel(id, {
    user_id: req.user.sub,
    name,
    options,
    colors: colors || null,
    background_image: background_image || null,
    background_color: background_color || null,
    is_private: !!is_private,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  });
  res.json(toWheel(saved));
});

/** 更新转盘 */
app.patch('/api/wheels/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const raw = store.findWheelById(id);
  if (!raw) return res.status(404).json({ error: '转盘不存在' });
  if (req.user.role !== 'admin' && raw.user_id !== req.user.sub) return res.status(403).json({ error: '无权修改' });

  const body = req.body || {};
  const changes = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) changes.name = body.name;
  if (Array.isArray(body.options)) changes.options = body.options;
  if (body.colors !== undefined) changes.colors = body.colors || null;
  if (body.background_image !== undefined) changes.background_image = body.background_image || null;
  if (body.background_color !== undefined) changes.background_color = body.background_color || null;
  if (body.is_private !== undefined) changes.is_private = !!body.is_private;

  const saved = store.saveWheel(id, changes);
  res.json(toWheel(saved));
});

/** 删除转盘 */
app.delete('/api/wheels/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const raw = store.findWheelById(id);
  if (!raw) return res.status(404).json({ error: '转盘不存在' });
  if (req.user.role !== 'admin' && raw.user_id !== req.user.sub) return res.status(403).json({ error: '无权删除' });
  store.deleteWheel(id);
  res.json({ ok: true });
});

// ============ 静态页面路由 ============
// 登录/个人资料/用户管理已收口到主项目（/login /settings /usermanagement），不再提供
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
app.get('/manage', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
app.get('/editor', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
app.get('/editor/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
app.get('/wheel/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// 兜底 SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// 导出 app，供明星学校主应用挂载到 /roulette
module.exports = app;

// 仅独立运行（node server/index.js）时才启动监听
if (require.main === module) {
  const PORT_NUM = process.env.PORT || 8080;
  app.listen(PORT_NUM, () => {
    console.log(`
╔══════════════════════════════════════════╗
║  做个决定平台  🎡                         ║
║  Node.js + JSON 文件存储                  ║
║  http://localhost:${PORT_NUM}                ║
╚══════════════════════════════════════════╝
`);
  });
}
