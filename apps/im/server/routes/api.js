/**
 * api.js —— 邻语（IM）全部业务接口（挂载于 /im/api）
 * ----------------------------------------------------------
 * 认证：复用主平台会话（cookie token → server/core/sessions），
 *       主入口 requireLogin 已拦截未登录访问，这里再兜底 requireAuth。
 * 响应：统一 { ok:true, data } / { ok:false, error:{ code, message } }（与商店/广播器风格一致）。
 *
 * 端点总览：
 *   资料    GET  /me
 *   用户    GET  /users?q=  (按 ID / 姓名模糊搜索，用于加好友与拉群)
 *   会话    GET  /conversations                   会话列表（含最后一条消息、未读数、偏好）
 *           GET  /conversations/:id               会话详情（群资料/成员/设置/我的偏好）
 *           POST /conversations                   创建单聊 / 群聊
 *           PATCH /conversations/:id              修改群名 / 群公告 / 群设置（群主或管理员）
 *           PATCH /conversations/:id/prefs        修改我的偏好（置顶/免打扰/屏蔽/备注）
 *           DELETE /conversations/:id             删除会话（单聊任何人；群聊群主或管理员）
 *           DELETE /conversations/:id/messages    清空我的聊天记录
 *           POST /conversations/:id/members       邀请成员进群
 *           DELETE /conversations/:id/members/:uid 移出成员（群主或管理员）
 *           POST /conversations/:id/read          标记已读
 *           GET  /conversations/:id/messages      拉取消息（支持 after 增量）
 *           POST /conversations/:id/messages      发送消息（支持引用，受禁言/限频约束）
 *   消息    POST /messages/:id/recall             撤回（仅发送者）
 *           DELETE /messages/:id                  本地删除（只影响自己）
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// 平台核心模块（require 缓存保证与主应用是同一实例，共享登录态）
// 路径说明：routes → server(im) → im → apps → 项目根，再进 server/core
const sessions = require('../../../../server/core/sessions');
const userStore = require('../../../../server/core/userStore');
const store = require('../store');
// WebSocket 实时推送：消息入库后立即通知在线成员（未连接时为空操作）
const ws = require('../ws');

store.init();   // 首次加载时建目录与空数据文件

/** 单条消息正文最大长度 */
const MAX_TEXT = 2000;

/** 表情包目录：项目根 docs/emoji（由 /im/emoji 静态路由对外提供） */
const EMOJI_DIR = path.join(__dirname, '..', '..', '..', '..', 'docs', 'emoji');

/** 合法表情编码（文件名去掉 .png，允许 270_1 这类重名后缀） */
const EMOJI_CODE_RE = /^[0-9]+(_[0-9]+)?$/;

/** 单个聊天文件最大字节数（20MB） */
const FILE_MAX_BYTES = 20 * 1024 * 1024;

/** 单张聊天图片最大字节数（5MB） */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 允许的图片 MIME → 落盘扩展名 */
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };

/**
 * 会话头像文件路径：{会话目录}/avatar.png
 * @param {object} conv 会话对象
 * @returns {string} 绝对路径
 */
function avatarFile(conv) {
  return path.join(store.convDir(conv), 'avatar.png');
}

/**
 * 判断会话是否已设置头像文件
 * @param {object} conv 会话对象
 * @returns {boolean}
 */
function hasGroupAvatar(conv) {
  return fs.existsSync(avatarFile(conv));
}

/**
 * 在全部会话目录中定位附件文件
 * @param {'images'|'files'} sub 子目录名
 * @param {string} name 文件名
 * @returns {{conv:object, file:string}|null} 找到返回会话与绝对路径
 */
function locateAttachment(sub, name) {
  const safe = path.basename(name);                           // 防目录穿越
  const dirs = store.listConvDirs();
  for (const dir of dirs) {
    const file = path.join(dir, sub, safe);
    if (!fs.existsSync(file)) continue;
    const cfgPath = path.join(dir, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.id) return { conv: cfg, file };
    } catch (_) { /* 忽略损坏的 config */ }
  }
  return null;
}

// ============ 通用工具 ============

/**
 * 登录校验：从 cookie / Bearer 解析当前用户，失败返回 401
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
  const token = sessions.getTokenFromRequest(req);           // 会话令牌（cookie 或 Bearer）
  const userId = token ? sessions.getUserId(token) : undefined;
  if (!userId) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '未登录或登录已过期' } });
  }
  const user = userStore.getUserById(userId);                // 用户条目（含姓名）
  if (!user) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '用户不存在' } });
  }
  req.userId = userId;                                       // 当前用户 ID
  req.userName = user.name;                                  // 当前用户姓名
  req.isAdmin = userStore.isAdminId(userId);                 // 是否管理员
  next();
}

router.use(requireAuth);   // 全部接口都需要登录

/** 统一成功返回：{ok:true,data} */
const ok = (res, data) => res.json({ ok: true, data });

/**
 * 统一失败返回
 * @param {import('express').Response} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {string} code 业务错误码
 * @param {string} message 中文错误提示
 */
const fail = (res, status, code, message) =>
  res.status(status).json({ ok: false, error: { code, message } });

/**
 * 判断用户是否在会话成员中
 * @param {object} conv 会话对象
 * @param {string} userId 用户 ID
 * @returns {boolean}
 */
function isMember(conv, userId) {
  return !!(conv && Array.isArray(conv.members) && conv.members.includes(userId));
}

/**
 * 把会话转成前端展示结构：补上成员姓名、未读数
 * @param {object} conv 会话对象（可带 lastMessage）
 * @param {string} userId 当前用户 ID
 * @returns {object}
 */
function convView(conv, userId) {
  const members = Array.isArray(conv.members) ? conv.members : [];            // 成员 ID 列表
  const memberNames = members.map(id => {
    const u = userStore.getUserById(id);
    const prefs = store.getPrefs(conv, id);                                   // 该成员的偏好（含本群身份）
    return {
      id,
      name: u ? u.name : id,
      avatar: u && userStore.hasAvatarFile(id) ? `/api/user-avatar/${encodeURIComponent(id)}` : null,
      identity: prefs.identity                                                 // 本群身份（群昵称来源）
    };
  });

  return {
    id: conv.id,
    type: conv.type,
    title: conv.title,
    code: conv.type === 'group' ? store.convCode(conv.id) : '',   // 群号（仅群聊展示）
    avatar: conv.type === 'group' && hasGroupAvatar(conv)       // 群头像 URL（未设置则为 null）
      ? `/im/api/conversations/${encodeURIComponent(conv.id)}/avatar`
      : null,
    announcement: String(conv.announcement || ''),                // 群公告
    settings: store.normalizeSettings(conv),                      // 群发言/加群设置
    prefs: store.getPrefs(conv, userId),                          // 我对该会话的偏好
    members: memberNames,
    ownerId: conv.ownerId,
    createdAt: conv.createdAt,
    lastMessage: conv.lastMessage || null,
    unread: 0                       // 未读数由调用方统一计算（列表接口），新建会话时默认 0
  };
}

/**
 * 计算成员在该群的群昵称（规则与前端 groupNick 一致）
 * 老师/班主任：科目-称呼；家长/家委：孩子姓名+关系；其余：称呼
 * @param {object} conv 会话对象
 * @param {string} userId 成员用户 ID
 * @returns {string} 未设置时返回空串
 */
function groupNickOf(conv, userId) {
  if (!conv || conv.type !== 'group') return '';
  const ident = store.getPrefs(conv, userId).identity || {};       // 该成员的本群身份
  if (!ident.nickname && !ident.relation) return '';
  if (ident.role === '老师' || ident.role === '班主任') {
    return ident.nickname ? (ident.subject ? `${ident.subject}-` : '') + ident.nickname : '';
  }
  if (ident.role === '家长' || ident.role === '家委') {
    if (!ident.relation) return ident.nickname || '';
    return (ident.childName || '') + ident.relation;
  }
  return ident.nickname || '';
}

/**
 * 给消息补上发送者的群昵称与身份（senderNick / senderRole）
 * 好处：成员退群后其历史消息仍能展示群昵称与身份标，前端无需再从成员列表查找
 * @param {object} conv 会话对象
 * @param {object} msg 消息对象
 * @returns {object} 带 senderNick、senderRole 的新对象
 */
function withSenderNick(conv, msg) {
  if (!msg) return msg;
  const isGroup = !!(conv && conv.type === 'group');                // 单聊不展示身份
  const ident = isGroup ? (store.getPrefs(conv, msg.senderId).identity || {}) : {};
  const view = Object.assign({}, msg, {
    senderNick: groupNickOf(conv, msg.senderId),
    senderRole: isGroup ? (ident.role || '') : ''
  });

  // 撤回消息：补上操作者信息，前端据此区分「本人撤回」与「撤回成员消息」
  if (msg.recalled) {
    const byId = msg.recalledBy || msg.senderId;                     // 实际操作撤回的人
    const byUser = userStore.getUserById(byId);                      // 操作者用户条目
    view.recalledByAdmin = userStore.isAdminId(byId);                // 是否平台管理员
    view.recalledByName = view.recalledByAdmin
      ? '管理员'
      : (byUser ? byUser.name : '');
    view.memberRecall = !!(msg.recalledBy && msg.recalledBy !== msg.senderId);
  }
  return view;
}

/**
 * 发送前的通用校验：全员禁言与发言限频
 * @param {object} conv 会话对象
 * @param {import('express').Request} req 请求对象（含 userId / isAdmin）
 * @returns {{status:number, code:string, message:string}|null} 无限制时返回 null
 */
function sendBlocked(conv, req) {
  const settings = store.normalizeSettings(conv);                           // 群发言设置
  const isOwner = req.isAdmin || conv.ownerId === req.userId;               // 群主或管理员

  // 全员禁言：只有群主（管理员）可以发言
  if (conv.type === 'group' && settings.muteAll && !isOwner) {
    return { status: 403, code: 'FORBIDDEN', message: '全员禁言中，只有群主可以发言' };
  }

  // 发言限频：距本人上一条消息不足间隔时拒绝
  if (settings.rateLimit > 0) {
    const last = store.lastMessageBy(conv.id, req.userId);                  // 我上一条消息
    const elapsed = last ? (Date.now() - Date.parse(last.time)) / 1000 : Infinity;   // 已等待秒数
    if (elapsed < settings.rateLimit) {
      const wait = Math.ceil(settings.rateLimit - elapsed);                 // 还需等待秒数
      return { status: 429, code: 'TOO_FREQUENT', message: `发言过于频繁，请 ${wait} 秒后再试` };
    }
  }
  return null;
}

// ============ 当前用户 ============

/**
 * GET /me
 * 当前登录用户信息（前端顶栏头像、姓名、管理员判断）
 */
router.get('/me', (req, res) => {
  ok(res, {
    loggedIn: true,
    id: req.userId,
    name: req.userName,
    isAdmin: req.isAdmin,
    avatar: userStore.hasAvatarFile(req.userId) ? `/api/user-avatar/${encodeURIComponent(req.userId)}` : null
  });
});

// ============ 用户搜索 ============

/**
 * GET /users?q=关键词
 * 按用户 ID 或姓名模糊搜索（最多 10 条），供「发起单聊 / 拉群」选择成员
 * 不返回密码等敏感字段；不包含自己
 */
router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();  // 搜索关键词（统一小写）
  if (!q) return ok(res, []);
  const list = userStore.listUsers()
    .filter(u => u.id !== req.userId)
    .filter(u => u.id.toLowerCase().includes(q) || String(u.name).toLowerCase().includes(q))
    .slice(0, 10)
    .map(u => ({
      id: u.id,
      name: u.name,
      avatar: u.avatar ? `/api/user-avatar/${encodeURIComponent(u.id)}` : null
    }));
  ok(res, list);
});

// ============ 会话 ============

/**
 * GET /conversations
 * 当前用户参与的会话列表：按最后消息时间倒序，附带未读数
 */
router.get('/conversations', (req, res) => {
  const allMessages = store.loadMessages();                  // 全部消息（用于统计未读）
  const list = store.listConversationsFor(req.userId).map(conv => {
    const readAt = (conv.reads && conv.reads[req.userId]) || '';             // 我的最后已读时间
    const cleared = Date.parse(conv.prefs && conv.prefs.clearedAt) || 0;     // 我的清空聊天记录时间点
    // 免打扰 / 屏蔽的会话不计未读，避免侧栏出现红点
    const muted = !!(conv.prefs && (conv.prefs.muted || conv.prefs.blocked));
    const unread = muted ? 0 : allMessages.filter(m =>
      m.convId === conv.id &&
      m.senderId !== req.userId &&
      !m.recalled &&
      !(m.hiddenFor || []).includes(req.userId) &&
      (!cleared || Date.parse(m.time) > cleared) &&
      (!readAt || m.time > readAt)
    ).length;                                                                // 未读条数
    const view = convView(conv, req.userId);
    view.unread = unread;
    view.lastMessage = withSenderNick(conv, view.lastMessage);   // 列表预览也带群昵称
    return view;
  });
  ok(res, list);
});

/**
 * GET /conversations/:id
 * 会话详情：群资料、成员、群设置、我的偏好（聊天设置页数据源）
 */
router.get('/conversations/:id', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  ok(res, convView(conv, req.userId));
});

/**
 * PATCH /conversations/:id
 * body: { title?, announcement?, settings?:{muteAll,rateLimit,joinMode} }
 * 修改群名 / 群公告 / 群设置，仅群主（或管理员）可操作
 */
router.patch('/conversations/:id', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!(req.isAdmin || conv.ownerId === req.userId)) {
    return fail(res, 403, 'FORBIDDEN', '只有群主或管理员可以修改群资料');
  }

  const body = req.body || {};
  const patch = {};                                          // 待写入的字段

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return fail(res, 400, 'BAD_REQUEST', '群聊名称不能为空');
    if (title.length > 30) return fail(res, 400, 'BAD_REQUEST', '群聊名称最多 30 个字');
    patch.title = title;
  }
  if (body.announcement !== undefined) {
    patch.announcement = String(body.announcement).trim().slice(0, 500);   // 公告最长 500 字
  }
  if (body.settings !== undefined && typeof body.settings === 'object') {
    const cur = store.normalizeSettings(conv);                             // 现有设置
    const next = Object.assign({}, cur, body.settings);
    patch.settings = {
      muteAll: next.muteAll === true,
      rateLimit: [0, 10, 30, 60].includes(Number(next.rateLimit)) ? Number(next.rateLimit) : cur.rateLimit,
      joinMode: ['verify', 'free', 'none'].includes(next.joinMode) ? next.joinMode : cur.joinMode
    };
  }

  const updated = store.updateConversation(conv.id, patch);
  ok(res, convView(updated, req.userId));
});

/**
 * PATCH /conversations/:id/prefs
 * body: { pinned?, muted?, blocked?, remark? }
 * 修改「我」对该会话的偏好（置顶 / 免打扰 / 屏蔽 / 备注），只影响本人
 */
router.patch('/conversations/:id/prefs', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const body = req.body || {};
  const patch = {};
  ['pinned', 'muted', 'blocked'].forEach(key => {
    if (body[key] !== undefined) patch[key] = body[key] === true;
  });
  if (body.remark !== undefined) patch.remark = String(body.remark).trim().slice(0, 30);   // 备注最多 30 字
  if (body.identity !== undefined && typeof body.identity === 'object') {
    const ident = body.identity;
    patch.identity = {                                       // 我的本群身份（老师：科目+称呼；家长：孩子姓名+关系）
      role: String(ident.role || ''),
      subject: String(ident.subject || ''),
      nickname: String(ident.nickname || '').trim().slice(0, 20),
      childName: String(ident.childName || '').trim().slice(0, 20),
      relation: String(ident.relation || '')
    };
  }
  const prefs = store.updatePrefs(conv.id, req.userId, patch);
  ok(res, prefs);
});

/**
 * GET /conversations/:id/avatar
 * 群头像图片：仅群成员可访问，未设置时返回 404
 */
router.get('/conversations/:id/avatar', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv || !isMember(conv, req.userId)) return res.status(404).end();
  const file = avatarFile(conv);                             // 头像文件路径
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(file);
});

/**
 * PATCH /conversations/:id/avatar
 * body: { dataUrl: 'data:image/png;base64,...' }
 * 设置群头像（仅群主或管理员），图片不超过 2MB
 */
router.patch('/conversations/:id/avatar', (req, res, next) => {
  try {
    const conv = store.findConversation(req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
    if (conv.type !== 'group') return fail(res, 400, 'NOT_GROUP', '仅群聊可以设置群头像');
    if (!(req.isAdmin || conv.ownerId === req.userId)) {
      return fail(res, 403, 'FORBIDDEN', '只有群主或管理员可以设置群头像');
    }
    const raw = String((req.body && req.body.dataUrl) || '');
    const matched = raw.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);   // 解析 base64 图片
    if (!matched) return fail(res, 400, 'INVALID_IMAGE', '仅支持 PNG/JPG/WebP 图片');
    const buf = Buffer.from(matched[2], 'base64');                              // 图片二进制
    if (!buf.length) return fail(res, 400, 'INVALID_IMAGE', '图片内容为空');
    if (buf.length > 2 * 1024 * 1024) return fail(res, 400, 'IMAGE_TOO_LARGE', '图片不能超过 2MB');
    const file = avatarFile(conv);                            // 群头像存储路径
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    ok(res, { avatar: `/im/api/conversations/${encodeURIComponent(conv.id)}/avatar?v=${Date.now()}` });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /conversations/:id
 * 删除会话：单聊任何一方可删（双方会话一并移除），群聊仅群主或管理员解散
 */
router.delete('/conversations/:id', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (conv.type === 'group' && !(req.isAdmin || conv.ownerId === req.userId)) {
    return fail(res, 403, 'FORBIDDEN', '只有群主或管理员可以解散群聊');
  }
  store.deleteConversation(conv.id);                            // 整个会话目录（含记录/作业/图片/文件/头像）一并移除
  ok(res, { deleted: true });
});

/**
 * DELETE /conversations/:id/messages
 * 清空「我」的聊天记录：只记录时间点，不影响其他成员的记录
 */
router.delete('/conversations/:id/messages', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  store.clearMessagesForUser(conv.id, req.userId);
  ok(res, { cleared: true });
});

/**
 * GET /search?q=群号/用户ID
 * 全局搜索：按用户 ID 匹配用户、按群号匹配群聊（不限于已加入的会话）
 */
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();                            // 搜索关键词
  if (!q) return ok(res, { users: [], groups: [] });
  const lower = q.toLowerCase();                                          // 用户 ID 统一小写比较

  const conversations = store.loadConversations();                         // 全部会话
  const requests = store.loadFriendRequests();                             // 全部好友申请

  const users = userStore.listUsers()
    .filter(u => u.id !== req.userId && String(u.id).toLowerCase().includes(lower))
    .slice(0, 10)
    .map(u => {
      // 是否已有单聊（视为已是好友）
      const hasChat = conversations.some(c => c.type === 'c2c' && Array.isArray(c.members) &&
        c.members.includes(req.userId) && c.members.includes(u.id));
      // 是否已发过待处理的好友申请
      const pending = requests.some(r => r.fromId === req.userId && r.toId === u.id && r.status === 'pending');
      // 对方是否已向我发过待处理的好友申请
      const incoming = requests.some(r => r.fromId === u.id && r.toId === req.userId && r.status === 'pending');
      return {
        id: u.id,
        name: u.name,
        avatar: userStore.hasAvatarFile(u.id) ? `/api/user-avatar/${encodeURIComponent(u.id)}` : null,
        hasChat,
        pending,
        incoming
      };
    });

  const groups = store.loadConversations()
    .filter(c => c.type === 'group' && String(store.convCode(c.id)).includes(q))
    .slice(0, 10)
    .map(c => ({
      id: c.id,
      code: store.convCode(c.id),
      title: c.title || '群聊',
      avatar: hasGroupAvatar(c) ? `/im/api/conversations/${encodeURIComponent(c.id)}/avatar` : null,
      memberCount: (c.members || []).length,
      isMember: (c.members || []).includes(req.userId)
    }));

  ok(res, { users, groups });
});

/**
 * POST /conversations/:id/join
 * 搜索到群后自助加群（已在群内直接返回会话）
 */
router.post('/conversations/:id/join', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '群聊不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '只有群聊可以加入');
  if ((conv.members || []).includes(req.userId)) return ok(res, convView(conv, req.userId));

  const updated = store.addMembers(conv.id, [req.userId]);                // 把自己加入群成员
  ok(res, convView(updated, req.userId));
});

/**
 * GET /friend-requests
 * 好友申请列表：incoming（别人申请加我）、outgoing（我发出的申请）
 */
router.get('/friend-requests', (req, res) => {
  const all = store.loadFriendRequests();                                 // 全部申请
  const decorate = (r, uid) => {
    const u = userStore.getUserById(uid);
    return {
      id: r.id,
      userId: uid,
      name: u ? u.name : uid,
      avatar: userStore.hasAvatarFile(uid) ? `/api/user-avatar/${encodeURIComponent(uid)}` : null,
      message: r.message,
      status: r.status,
      time: r.time
    };
  };
  const incoming = all.filter(r => r.toId === req.userId)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .map(r => decorate(r, r.fromId));
  const outgoing = all.filter(r => r.fromId === req.userId)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .map(r => decorate(r, r.toId));
  ok(res, { incoming, outgoing });
});

/**
 * POST /friend-requests
 * body { toId, message }：发送好友申请，需对方同意后才建立单聊
 */
router.post('/friend-requests', (req, res) => {
  const body = req.body || {};
  const toId = String(body.toId || '').trim();                            // 对方用户 ID
  const message = String(body.message || '').trim().slice(0, 50);         // 申请附言
  if (!toId) return fail(res, 400, 'BAD_REQUEST', '请选择要添加的用户');
  if (toId === req.userId) return fail(res, 400, 'BAD_REQUEST', '不能添加自己为好友');
  if (!userStore.getUserById(toId)) return fail(res, 404, 'NOT_FOUND', '该用户不存在');

  const conversations = store.loadConversations();                        // 全部会话
  const alreadyFriend = conversations.some(c => c.type === 'c2c' && Array.isArray(c.members) &&
    c.members.includes(req.userId) && c.members.includes(toId));
  if (alreadyFriend) return fail(res, 400, 'BAD_REQUEST', '你们已经是好友了');

  const requests = store.loadFriendRequests();                            // 全部好友申请
  if (requests.some(r => r.fromId === req.userId && r.toId === toId && r.status === 'pending')) {
    return fail(res, 400, 'BAD_REQUEST', '已发送过申请，请等待对方同意');
  }
  if (requests.some(r => r.fromId === toId && r.toId === req.userId && r.status === 'pending')) {
    return fail(res, 400, 'BAD_REQUEST', '对方已向你发送好友申请，请在「新朋友」中同意');
  }

  const item = {
    id: store.genId('f'),
    fromId: req.userId,
    toId,
    message,
    status: 'pending',
    time: new Date().toISOString()
  };
  requests.push(item);
  store.saveFriendRequests(requests);
  ok(res, item);
});

/**
 * POST /friend-requests/:id/accept
 * 同意好友申请：自动建立单聊（已是好友则直接复用）
 */
router.post('/friend-requests/:id/accept', (req, res) => {
  const requests = store.loadFriendRequests();
  const item = requests.find(r => r.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '申请不存在');
  if (item.toId !== req.userId) return fail(res, 403, 'FORBIDDEN', '无权处理该申请');
  if (item.status !== 'pending') return fail(res, 400, 'BAD_REQUEST', '该申请已处理');

  item.status = 'accepted';
  store.saveFriendRequests(requests);

  const conversations = store.loadConversations();
  const exist = conversations.find(c => c.type === 'c2c' && Array.isArray(c.members) &&
    c.members.length === 2 && c.members.includes(item.fromId) && c.members.includes(item.toId));
  const conv = exist || store.createConversation({
    id: store.genId('c'),
    type: 'c2c',
    title: (userStore.getUserById(item.fromId) || {}).name || item.fromId,
    members: [req.userId, item.fromId],
    ownerId: item.fromId
  });
  ok(res, convView(conv, req.userId));
});

/**
 * POST /friend-requests/:id/reject
 * 拒绝好友申请
 */
router.post('/friend-requests/:id/reject', (req, res) => {
  const requests = store.loadFriendRequests();
  const item = requests.find(r => r.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '申请不存在');
  if (item.toId !== req.userId) return fail(res, 403, 'FORBIDDEN', '无权处理该申请');
  if (item.status !== 'pending') return fail(res, 400, 'BAD_REQUEST', '该申请已处理');
  item.status = 'rejected';
  store.saveFriendRequests(requests);
  ok(res, item);
});

// ============ 联系人 ============

/**
 * 组装当前用户的联系人数据（好友来源：已有的单聊会话对端）
 * @param {string} userId 当前用户 ID
 * @returns {{groups:Array<object>, friends:Array<object>, pendingCount:number}}
 */
function buildContacts(userId) {
  const data = store.loadContacts(userId);                          // 我的联系人元数据（分组 + 备注）
  const conversations = store.loadConversations();                  // 全部会话
  const userMap = new Map(userStore.listUsers().map(u => [u.id, u]));   // 用户 ID → 用户条目
  const seen = new Set();                                           // 已收集的好友 ID（避免重复单聊）
  const friends = [];                                               // 好友展示列表

  conversations.forEach(conv => {
    if (conv.type !== 'c2c' || !Array.isArray(conv.members) || !conv.members.includes(userId)) return;
    const peerId = conv.members.find(id => id !== userId);          // 单聊对端用户 ID
    if (!peerId || seen.has(peerId)) return;
    seen.add(peerId);

    const meta = data.friends[peerId] || { groupId: 'default', remark: '', blocked: false };
    const u = userMap.get(peerId);
    const points = u ? (u.points || 0) : 0;                         // 用户积分（用于推导等级）
    friends.push({
      id: peerId,
      name: (u && u.name) || peerId,                                // 原昵称
      remark: meta.remark || '',                                    // 备注名（优先展示）
      displayName: meta.remark || (u && u.name) || peerId,          // 实际展示名
      avatar: userStore.hasAvatarFile(peerId) ? `/api/user-avatar/${encodeURIComponent(peerId)}` : null,
      online: ws.isOnline(peerId),                                  // 是否有在线连接
      groupId: meta.groupId,
      blocked: meta.blocked === true,
      convId: conv.id,
      signature: '',                                                // 平台暂无个性签名字段
      tags: [],                                                     // 标签（暂无数据源）
      level: Math.floor(points / 100) + 1,                          // 等级：每 100 积分升 1 级
      points: points,
      birthday: '',                                                 // 生日（暂无数据源）
      region: ''                                                    // 地区（暂无数据源）
    });
  });

  // 在线好友排前面，同状态按展示名排序
  friends.sort((a, b) => (a.online === b.online
    ? a.displayName.localeCompare(b.displayName, 'zh-CN')
    : (a.online ? -1 : 1)));

  const groups = data.groups.map(g => ({
    id: g.id,
    name: g.name,
    count: friends.filter(f => f.groupId === g.id).length          // 分组内好友数
  }));
  const pendingCount = store.loadFriendRequests()
    .filter(r => r.toId === userId && r.status === 'pending').length;

  return { groups: groups, friends: friends, pendingCount: pendingCount };
}

/**
 * GET /contacts
 * 联系人页数据：分组列表 + 好友列表（含在线状态/备注/等级）+ 待处理好友申请数
 */
router.get('/contacts', (req, res) => {
  ok(res, buildContacts(req.userId));
});

/**
 * GET /contacts/search?q=
 * 在联系人中按备注 / 昵称 / 用户 ID 搜索
 */
router.get('/contacts/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();          // 搜索关键词
  const data = buildContacts(req.userId);
  if (!q) return ok(res, data);
  const friends = data.friends.filter(f =>
    String(f.remark || '').toLowerCase().includes(q) ||
    String(f.name || '').toLowerCase().includes(q) ||
    String(f.id).toLowerCase().includes(q)
  );
  ok(res, { groups: data.groups, friends: friends, pendingCount: data.pendingCount });
});

/**
 * POST /contacts/groups
 * body { name }：新增自定义分组
 */
router.post('/contacts/groups', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 16);
  if (!name) return fail(res, 400, 'BAD_REQUEST', '请填写分组名称');
  const data = store.loadContacts(req.userId);
  if (data.groups.some(g => g.name === name)) return fail(res, 400, 'BAD_REQUEST', '分组名称已存在');
  const group = { id: store.genId('cg'), name: name };
  data.groups.push(group);
  store.saveContacts(req.userId, data);
  ok(res, group);
});

/**
 * PATCH /contacts/groups/:id
 * body { name }：分组改名
 */
router.patch('/contacts/groups/:id', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 16);
  if (!name) return fail(res, 400, 'BAD_REQUEST', '请填写分组名称');
  const data = store.loadContacts(req.userId);
  const group = data.groups.find(g => g.id === req.params.id);
  if (!group) return fail(res, 404, 'NOT_FOUND', '分组不存在');
  group.name = name;
  store.saveContacts(req.userId, data);
  ok(res, group);
});

/**
 * DELETE /contacts/groups/:id
 * 删除分组：组内好友自动移回「我的好友」（默认分组不可删除）
 */
router.delete('/contacts/groups/:id', (req, res) => {
  if (req.params.id === 'default') return fail(res, 400, 'BAD_REQUEST', '「我的好友」分组不可删除');
  const data = store.loadContacts(req.userId);
  const idx = data.groups.findIndex(g => g.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'NOT_FOUND', '分组不存在');
  data.groups.splice(idx, 1);
  Object.keys(data.friends).forEach(fid => {
    if (data.friends[fid].groupId === req.params.id) data.friends[fid].groupId = 'default';
  });
  store.saveContacts(req.userId, data);
  ok(res, { deleted: true });
});

/**
 * PATCH /contacts/friends/:id
 * body { remark, groupId, blocked }：修改好友备注 / 所在分组 / 拉黑状态
 */
router.patch('/contacts/friends/:id', (req, res) => {
  const friendId = req.params.id;
  const data = store.loadContacts(req.userId);
  const meta = data.friends[friendId] || { groupId: 'default', remark: '', blocked: false };
  const body = req.body || {};

  if (body.remark !== undefined) meta.remark = String(body.remark).trim().slice(0, 30);
  if (body.groupId !== undefined) {
    if (!data.groups.some(g => g.id === body.groupId)) return fail(res, 400, 'BAD_REQUEST', '分组不存在');
    meta.groupId = String(body.groupId);
  }
  if (body.blocked !== undefined) meta.blocked = body.blocked === true;

  data.friends[friendId] = meta;
  store.saveContacts(req.userId, data);

  // 备注与拉黑同步到单聊会话偏好，保证聊天标题、消息发送者名与会话列表都按备注展示
  const conv = store.loadConversations().find(c => c.type === 'c2c' &&
    Array.isArray(c.members) && c.members.includes(req.userId) && c.members.includes(friendId));
  if (conv) {
    const patch = {};                                                // 需要同步的会话偏好
    if (body.remark !== undefined) patch.remark = meta.remark;
    if (body.blocked !== undefined) patch.blocked = meta.blocked;
    if (Object.keys(patch).length) store.updatePrefs(conv.id, req.userId, patch);
  }
  ok(res, meta);
});

/**
 * DELETE /contacts/friends/:id
 * 删除好友：移除双方的单聊会话目录与本人联系人元数据
 */
router.delete('/contacts/friends/:id', (req, res) => {
  const friendId = req.params.id;
  const conv = store.loadConversations().find(c => c.type === 'c2c' &&
    Array.isArray(c.members) && c.members.includes(req.userId) && c.members.includes(friendId));
  if (!conv) return fail(res, 404, 'NOT_FOUND', '好友不存在');

  store.deleteConversation(conv.id);                                 // 整个会话目录移除

  const data = store.loadContacts(req.userId);
  delete data.friends[friendId];
  store.saveContacts(req.userId, data);
  ok(res, { deleted: true });
});

/**
 * POST /conversations/:id/members
 * body: { memberIds:[...] }
 * 邀请成员进群（任何成员都可以邀请）
 */
router.post('/conversations/:id/members', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '只有群聊可以邀请成员');

  const rawIds = Array.isArray(req.body && req.body.memberIds) ? req.body.memberIds : [];
  const ids = rawIds.map(s => String(s).trim()).filter(id => id && !conv.members.includes(id));
  if (!ids.length) return fail(res, 400, 'BAD_REQUEST', '请填写要邀请的用户 ID');
  const missing = ids.filter(id => !userStore.getUserById(id));           // 不存在的用户
  if (missing.length) return fail(res, 404, 'NOT_FOUND', '以下用户不存在：' + missing.join('、'));

  const updated = store.addMembers(conv.id, ids);
  ok(res, convView(updated, req.userId));
});

/**
 * DELETE /conversations/:id/members/:uid
 * 移出群成员：仅群主或管理员，且不能移出群主本人
 */
router.delete('/conversations/:id/members/:uid', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!(req.isAdmin || conv.ownerId === req.userId)) {
    return fail(res, 403, 'FORBIDDEN', '只有群主或管理员可以移出成员');
  }
  const targetId = String(req.params.uid);
  if (!conv.members.includes(targetId)) return fail(res, 404, 'NOT_FOUND', '该成员不在群里');
  if (targetId === conv.ownerId) return fail(res, 400, 'BAD_REQUEST', '不能移出群主');

  const updated = store.removeMember(conv.id, targetId);
  ok(res, convView(updated, req.userId));
});

/**
 * POST /conversations
 * body: { type:'c2c', targetId } | { type:'group', title, memberIds }
 * 单聊：同一对用户只保留一个会话（已存在则直接返回）
 * 群聊：创建者自动成为成员
 */
router.post('/conversations', (req, res) => {
  const type = String((req.body && req.body.type) || '');    // 会话类型
  const body = req.body || {};

  if (type === 'c2c') {
    const targetId = String(body.targetId || '').trim();     // 对方用户 ID
    if (!targetId) return fail(res, 400, 'BAD_REQUEST', '请填写对方用户 ID');
    if (targetId === req.userId) return fail(res, 400, 'BAD_REQUEST', '不能和自己发起会话');
    const target = userStore.getUserById(targetId);          // 对方用户条目
    if (!target) return fail(res, 404, 'NOT_FOUND', '该用户不存在');

    // 查重：两人之间的单聊已存在则直接复用（避免重复会话）
    const exist = store.loadConversations().find(c =>
      c.type === 'c2c' && Array.isArray(c.members) &&
      c.members.length === 2 && c.members.includes(req.userId) && c.members.includes(targetId)
    );
    if (exist) return ok(res, convView(exist, req.userId));

    const conv = store.createConversation({
      id: store.genId('c'),
      type: 'c2c',
      title: target.name || targetId,
      members: [req.userId, targetId],
      ownerId: req.userId
    });
    return ok(res, convView(conv, req.userId));
  }

  if (type === 'group') {
    const title = String(body.title || '').trim();           // 群聊名称
    if (!title) return fail(res, 400, 'BAD_REQUEST', '请填写群聊名称');
    if (title.length > 30) return fail(res, 400, 'BAD_REQUEST', '群聊名称最多 30 个字');

    // 成员 ID 去重并剔除自己（创建者稍后自动加入）
    const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [];
    const memberIds = rawIds.map(s => String(s).trim()).filter(id => id && id !== req.userId);
    const missing = memberIds.filter(id => !userStore.getUserById(id));      // 不存在的成员
    if (missing.length) {
      return fail(res, 404, 'NOT_FOUND', '以下用户不存在：' + missing.join('、'));
    }

    const conv = store.createConversation({
      id: store.genId('c'),
      type: 'group',
      title,
      members: [req.userId].concat(memberIds),
      ownerId: req.userId
    });
    return ok(res, convView(conv, req.userId));
  }

  fail(res, 400, 'BAD_REQUEST', '未知的会话类型');
});

/**
 * POST /conversations/:id/read
 * 标记该会话已读（记录当前用户最后已读时间）
 */
router.post('/conversations/:id/read', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  store.markRead(conv.id, req.userId);
  ok(res, { read: true });
});

/**
 * GET /conversations/:id/messages?after=消息ID
 * 拉取会话消息；after 用于轮询增量（只返回该消息之后的新消息）
 */
router.get('/conversations/:id/messages', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  const after = req.query.after ? String(req.query.after) : null;           // 增量起点
  ok(res, store.listMessages(conv.id, req.userId, after).map(m => withSenderNick(conv, m)));
});

/**
 * POST /conversations/:id/messages
 * body: { text, quoteId? }
 * 发送消息：正文不可为空，最长 2000 字；quoteId 指向被引用的消息
 */
router.post('/conversations/:id/messages', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const blocked = sendBlocked(conv, req);                                   // 禁言 / 限频校验
  if (blocked) return fail(res, blocked.status, blocked.code, blocked.message);

  const text = String((req.body && req.body.text) || '').trim();            // 消息正文
  if (!text) return fail(res, 400, 'BAD_REQUEST', '消息不能为空');
  if (text.length > MAX_TEXT) return fail(res, 400, 'BAD_REQUEST', `消息最多 ${MAX_TEXT} 字`);

  // 引用块：只保存被引用消息的发送者、正文摘要与 ID（原消息被撤回后仍可展示）
  let quote = null;
  const quoteId = req.body && req.body.quoteId ? String(req.body.quoteId) : '';
  if (quoteId) {
    const src = store.findMessage(quoteId);                                  // 被引用的消息
    if (!src || src.convId !== conv.id || src.recalled) {
      return fail(res, 400, 'BAD_REQUEST', '引用的消息不存在或已撤回');
    }
    quote = { id: src.id, name: src.senderName, text: String(src.text).slice(0, 60) };
  }

  const msg = store.addMessage({
    id: store.genId('m'),
    convId: conv.id,
    senderId: req.userId,
    senderName: req.userName,
    text,
    time: new Date().toISOString(),
    quote,
    recalled: false,
    hiddenFor: []
  });

  // 发送即视为已读，避免自己发言后仍显示未读
  store.markRead(conv.id, req.userId, msg.time);
  const view = withSenderNick(conv, msg);                                 // 带群昵称/身份的返回结构
  ws.notifyMessage(conv, view);                                           // 实时推送给会话成员
  ok(res, view);
});

/**
 * 保存一张 dataUrl 图片到会话的 images 目录
 * @param {string} dataUrl data:image/png;base64,xxx
 * @param {string} msgId 消息 ID（文件名前缀）
 * @param {number} index 本条消息内第几张图片（从 1 开始）
 * @param {object} conv 所属会话
 * @returns {{url:string}|{error:string}} 成功返回访问地址，失败返回中文原因
 */
function saveImageFile(dataUrl, msgId, index, conv) {
  const matched = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/);
  if (!matched) return { error: '仅支持 PNG/JPG/WebP/GIF 图片' };

  const buf = Buffer.from(matched[2], 'base64');                            // 图片二进制内容
  if (!buf.length) return { error: '图片内容为空' };
  if (buf.length > IMAGE_MAX_BYTES) return { error: '图片不能超过 5MB' };

  const fileName = msgId + '-' + index + '.' + IMAGE_EXT[matched[1]];       // 落盘文件名
  const dir = path.join(store.convDir(conv), 'images');                    // 会话自己的图片目录
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buf);
  return { url: `/im/api/images/${fileName}` };
}

/**
 * GET /emojis
 * 可用表情列表：读取 docs/emoji 下的 png 文件名，按数字顺序返回表情编码
 */
router.get('/emojis', (req, res) => {
  let codes = [];
  try {
    codes = fs.readdirSync(EMOJI_DIR)
      .filter(f => /\.png$/i.test(f))
      .map(f => f.replace(/\.png$/i, ''))
      .filter(c => EMOJI_CODE_RE.test(c));
  } catch (e) {
    codes = [];                                                 // 目录不存在时返回空列表
  }
  codes.sort((a, b) => {
    const na = parseInt(a.split('_')[0], 10) || 0;              // 主编号
    const nb = parseInt(b.split('_')[0], 10) || 0;
    return na - nb || a.localeCompare(b);
  });
  ok(res, codes);
});

/**
 * POST /conversations/:id/images
 * 发送图文消息：body.parts 为有序片段
 *   [{type:'text',text} | {type:'image',dataUrl} | {type:'emoji',code}]
 * 兼容旧参数 { dataUrl }：等价于只发一张图片
 */
router.post('/conversations/:id/images', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const blocked = sendBlocked(conv, req);                                   // 禁言 / 限频校验
  if (blocked) return fail(res, blocked.status, blocked.code, blocked.message);

  const body = req.body || {};
  const raw = Array.isArray(body.parts) ? body.parts : [{ type: 'image', dataUrl: body.dataUrl }];
  if (raw.length > 60) return fail(res, 400, 'BAD_REQUEST', '一次最多发送 60 个片段');

  const msgId = store.genId('m');                                           // 消息 ID 同时作为文件名前缀
  const parts = [];                                                          // 规整后的片段列表
  let imageCount = 0;                                                        // 已保存的图片张数
  let hasEmoji = false;                                                      // 是否包含表情

  for (const item of raw) {
    if (item && item.type === 'text') {
      const text = String(item.text || '');
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (item && item.type === 'emoji') {
      // 表情直接引用 docs/emoji 下的静态文件，不落盘复制
      const code = String(item.code || '').replace(/\.png$/i, '');
      if (!EMOJI_CODE_RE.test(code)) return fail(res, 400, 'BAD_REQUEST', '表情编码不合法');
      if (!fs.existsSync(path.join(EMOJI_DIR, code + '.png'))) {
        return fail(res, 404, 'NOT_FOUND', '表情不存在');
      }
      parts.push({ type: 'emoji', code });
      hasEmoji = true;
      continue;
    }
    const saved = saveImageFile(item && item.dataUrl, msgId, ++imageCount, conv);
    if (saved.error) return fail(res, 400, 'BAD_REQUEST', saved.error);
    parts.push({ type: 'image', src: saved.url });
  }
  if (!parts.length) return fail(res, 400, 'BAD_REQUEST', '消息不能为空');

  // 文字摘要：用于会话列表预览与引用；无文字时纯表情显示 [表情]，否则显示 [图片]
  const preview = parts.filter(p => p.type === 'text').map(p => p.text).join(' ').trim()
    || (hasEmoji ? '[表情]' : '[图片]');
  const firstImage = parts.find(p => p.type === 'image');                   // 兼容旧字段

  const msg = store.addMessage({
    id: msgId,
    convId: conv.id,
    senderId: req.userId,
    senderName: req.userName,
    text: preview.slice(0, MAX_TEXT),
    image: firstImage ? firstImage.src : '',
    parts,
    time: new Date().toISOString(),
    quote: null,
    recalled: false,
    hiddenFor: []
  });

  store.markRead(conv.id, req.userId, msg.time);
  const view = withSenderNick(conv, msg);                                 // 带群昵称/身份的返回结构
  ws.notifyMessage(conv, view);                                           // 实时推送给会话成员
  ok(res, view);
});

/**
 * POST /conversations/:id/files
 * 直接发送文件：body { name, dataUrl }，落盘后返回文件消息
 */
router.post('/conversations/:id/files', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const blocked = sendBlocked(conv, req);                                   // 禁言 / 限频校验
  if (blocked) return fail(res, blocked.status, blocked.code, blocked.message);

  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 120);                 // 原始文件名（用于展示与下载）
  if (!name) return fail(res, 400, 'BAD_REQUEST', '请选择要发送的文件');

  const matched = String(body.dataUrl || '').match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!matched) return fail(res, 400, 'BAD_REQUEST', '文件格式不支持');

  const buf = Buffer.from(matched[2], 'base64');                            // 文件二进制内容
  if (!buf.length) return fail(res, 400, 'BAD_REQUEST', '文件内容为空');
  if (buf.length > FILE_MAX_BYTES) return fail(res, 400, 'BAD_REQUEST', '文件不能超过 20MB');

  const msgId = store.genId('m');                                           // 消息 ID
  const ext = (path.extname(name).match(/^\.[A-Za-z0-9]{1,12}$/) || [''])[0];   // 保留安全的扩展名
  const fileName = msgId + '-1' + ext;                                      // 落盘文件名
  const dir = path.join(store.convDir(conv), 'files');                     // 会话自己的文件目录
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buf);

  const msg = store.addMessage({
    id: msgId,
    convId: conv.id,
    senderId: req.userId,
    senderName: req.userName,
    text: '[文件] ' + name,
    image: '',
    parts: [{
      type: 'file',
      name,
      size: buf.length,
      mime: matched[1] || 'application/octet-stream',
      url: `/im/api/files/${fileName}`
    }],
    time: new Date().toISOString(),
    quote: null,
    recalled: false,
    hiddenFor: []
  });

  store.markRead(conv.id, req.userId, msg.time);
  const view = withSenderNick(conv, msg);                                 // 带群昵称/身份的返回结构
  ws.notifyMessage(conv, view);                                           // 实时推送给会话成员
  ok(res, view);
});

/**
 * GET /files/:name
 * 下载聊天文件（仅会话成员可访问，按原文件名下载）
 */
router.get('/files/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(404).end();

  const found = locateAttachment('files', name);                            // 在各会话目录中定位文件
  if (!found || !isMember(found.conv, req.userId)) return res.status(404).end();

  const msgId = name.split('-')[0];                                         // 由文件名还原消息 ID
  const msg = store.findMessage(msgId);
  const part = msg && (msg.parts || []).find(p => p.type === 'file' && p.url === `/im/api/files/${name}`);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(part ? part.name : name)}`);
  res.sendFile(found.file);
});

/**
 * GET /images/:name
 * 读取聊天图片（仅所属会话成员可访问）
 */
router.get('/images/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp|gif)$/.test(name)) return res.status(404).end();

  const found = locateAttachment('images', name);                           // 在各会话目录中定位图片
  if (!found || !isMember(found.conv, req.userId)) return res.status(404).end();

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(found.file);
});

// ============ 消息操作 ============

/**
 * POST /messages/:id/recall
 * 撤回消息（本人可撤回自己的；班主任 / 老师 / 家委 / 群主 / 管理员可撤回他人消息）
 */
router.post('/messages/:id/recall', (req, res) => {
  const msg = store.findMessage(req.params.id);
  if (!msg) return fail(res, 404, 'NOT_FOUND', '消息不存在');
  const conv = store.findConversation(msg.convId);
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  // 群内管理身份：群主 / 管理员 / 班主任 / 老师 / 家委 可撤回成员消息
  const role = conv.type === 'group' ? store.getPrefs(conv, req.userId).identity.role : '';
  const canRecallOthers = !!(req.isAdmin || conv.ownerId === req.userId ||
    ['班主任', '老师', '家委'].includes(role));
  const result = store.recallMessage(msg.id, req.userId, canRecallOthers);
  if (!result.ok) return fail(res, 403, 'FORBIDDEN', result.message);
  ok(res, { recalled: true, memberRecall: !!result.memberRecall });
});

/**
 * DELETE /messages/:id
 * 本地删除：只对当前用户隐藏，不删除其他人的记录
 */
router.delete('/messages/:id', (req, res) => {
  const msg = store.findMessage(req.params.id);
  if (!msg) return fail(res, 404, 'NOT_FOUND', '消息不存在');
  const conv = store.findConversation(msg.convId);
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  store.hideMessage(msg.id, req.userId);
  ok(res, { deleted: true });
});

// ============ 群作业 ============

/** 作业可选科目 */
const HW_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道法', '体育', '音乐', '美术', '信息技术', '自习', '综合'];

/** 作业评语等级 */
const HW_GRADES = ['A+', 'A', 'B', 'C', '需修改'];

/** 作业附件类型（与前端工具栏的 图片/视频/文件 对应） */
const HW_ATTACH_KINDS = ['image', 'video', 'file'];

/** 作业附件大小限制：图片 5MB、视频 50MB、文件 20MB */
const HW_ATTACH_LIMITS = { image: 5 * 1024 * 1024, video: 50 * 1024 * 1024, file: 20 * 1024 * 1024 };

/** 单份作业最多附件数 */
const HW_ATTACH_MAX = 9;

/**
 * 规整作业附件列表：只保留本服务落盘的附件地址，防止外链与非法数据
 * @param {*} raw 前端提交的附件数组
 * @returns {Array<{kind:string,url:string,name:string,size:number}>}
 */
function normalizeHomeworkAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, HW_ATTACH_MAX).map(a => {
    if (!a || !HW_ATTACH_KINDS.includes(a.kind)) return null;             // 类型不合法
    const url = String(a.url || '');
    const name = String(a.name || '').trim().slice(0, 120);
    const size = Number(a.size) || 0;
    // 只接受本接口生成的附件地址（含会话 ID 与落盘文件名两段）
    if (!/^\/im\/api\/homework-attachments\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(url)) return null;
    if (!name) return null;
    return { kind: a.kind, url, name, size };
  }).filter(Boolean);
}

/**
 * 是否可布置 / 批改作业：老师、班主任、群主或管理员
 * @param {object} conv 会话对象
 * @param {object} req 请求对象（含 userId / isAdmin）
 * @returns {boolean}
 */
function canManageHomework(conv, req) {
  if (req.isAdmin || conv.ownerId === req.userId) return true;
  const role = store.getPrefs(conv, req.userId).identity.role;           // 我在该群的老师身份
  return role === '老师' || role === '班主任';
}

/**
 * 作业列表视图：附带我的提交状态与统计
 * @param {object} item 作业记录
 * @param {object} conv 会话对象
 * @param {object} req 请求对象
 * @returns {object}
 */
function homeworkView(item, conv, req) {
  const sub = (item.submissions || {})[req.userId] || null;             // 我的提交
  return {
    id: item.id,
    subject: item.subject,
    title: item.title,
    content: item.content,
    needSubmit: item.needSubmit !== false,
    creatorId: item.creatorId,
    creatorName: item.creatorName,
    createdAt: item.createdAt,
    attachments: normalizeHomeworkAttachments(item.attachments),
    canManage: canManageHomework(conv, req),
    submitted: !!sub,
    myText: sub ? sub.text : '',
    grade: sub ? String(sub.grade || '') : '',
    comment: sub ? String(sub.comment || '') : '',
    submittedAt: sub ? sub.updatedAt : '',
    submittedCount: Object.keys(item.submissions || {}).length,
    memberCount: Array.isArray(conv.members) ? conv.members.length : 0
  };
}

/**
 * GET /conversations/:id/homework
 * 群作业列表（按布置时间倒序）
 */
router.get('/conversations/:id/homework', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '仅群聊支持作业');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const list = store.loadHomework()
    .filter(h => h.convId === conv.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(h => homeworkView(h, conv, req));
  ok(res, { list, canManage: canManageHomework(conv, req), subjects: HW_SUBJECTS });
});

/**
 * POST /conversations/:id/homework
 * 布置作业（老师 / 班主任 / 群主 / 管理员）
 */
router.post('/conversations/:id/homework', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '仅群聊支持作业');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!canManageHomework(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师可以布置作业');

  const body = req.body || {};
  const subject = String(body.subject || '');
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!HW_SUBJECTS.includes(subject)) return fail(res, 400, 'BAD_REQUEST', '请选择科目');
  if (!title) return fail(res, 400, 'BAD_REQUEST', '请填写作业标题');
  if (title.length > 50) return fail(res, 400, 'BAD_REQUEST', '标题不能超过 50 个字');
  if (!content) return fail(res, 400, 'BAD_REQUEST', '请填写作业内容');
  if (content.length > 3000) return fail(res, 400, 'BAD_REQUEST', '作业内容不能超过 3000 个字');

  const user = userStore.getUserById(req.userId);                       // 布置人
  const item = {
    id: store.genId('h'),
    convId: conv.id,
    subject,
    title,
    content,
    needSubmit: body.needSubmit !== false,
    attachments: normalizeHomeworkAttachments(body.attachments),
    creatorId: req.userId,
    creatorName: user ? user.name : req.userId,
    createdAt: new Date().toISOString(),
    submissions: {}
  };
  const all = store.loadHomework();
  all.push(item);
  store.saveHomework(all);

  // 布置后往群里发一条作业卡片消息，点卡片可进入作业详情
  const msg = store.addMessage({
    id: store.genId('m'),
    convId: conv.id,
    senderId: req.userId,
    senderName: user ? user.name : req.userId,
    text: '【作业】' + title,
    image: '',
    parts: [{ type: 'homework', homeworkId: item.id, title, subject }],
    time: new Date().toISOString(),
    quote: null,
    recalled: false,
    hiddenFor: []
  });
  store.markRead(conv.id, req.userId, msg.time);
  ws.notifyMessage(conv, withSenderNick(conv, msg));                      // 作业卡片消息实时推送

  ok(res, homeworkView(item, conv, req));
});

/**
 * GET /homework/:id
 * 作业详情：老师看全部提交，学生只看自己的提交
 */
router.get('/homework/:id', (req, res) => {
  const item = store.loadHomework().find(h => h.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '作业不存在');
  const conv = store.findConversation(item.convId);
  if (!conv || !isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const view = homeworkView(item, conv, req);
  const manage = view.canManage;
  const submissions = [];
  const subs = item.submissions || {};

  if (manage) {
    // 老师视角：列出已提交的同学
    conv.members.forEach(id => {
      const sub = subs[id];
      if (!sub) return;
      const u = userStore.getUserById(id);
      submissions.push({
        userId: id,
        name: u ? u.name : id,
        avatar: u && userStore.hasAvatarFile(id) ? `/api/user-avatar/${encodeURIComponent(id)}` : null,
        text: sub.text,
        grade: String(sub.grade || ''),
        comment: String(sub.comment || ''),
        updatedAt: sub.updatedAt
      });
    });
  } else if (subs[req.userId]) {
    const sub = subs[req.userId];
    submissions.push({
      userId: req.userId,
      name: view.creatorName,
      text: sub.text,
      grade: String(sub.grade || ''),
      comment: String(sub.comment || ''),
      updatedAt: sub.updatedAt
    });
  }
  view.submissions = submissions;
  ok(res, view);
});

/**
 * POST /homework/:id/submit
 * 学生提交 / 修改作业（已评优后不可修改；评语为「需修改」时可重新提交）
 */
router.post('/homework/:id/submit', (req, res) => {
  const item = store.loadHomework().find(h => h.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '作业不存在');
  const conv = store.findConversation(item.convId);
  if (!conv || !isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (item.needSubmit === false) return fail(res, 400, 'BAD_REQUEST', '该作业无需在线提交');

  const text = String((req.body || {}).text || '').trim();
  if (!text) return fail(res, 400, 'BAD_REQUEST', '请填写作业内容');
  if (text.length > 3000) return fail(res, 400, 'BAD_REQUEST', '作业内容不能超过 3000 个字');

  item.submissions = item.submissions || {};
  const old = item.submissions[req.userId];                              // 原提交
  if (old && old.grade && old.grade !== '需修改') {
    return fail(res, 400, 'BAD_REQUEST', '作业已被老师批改，不能修改');
  }

  item.submissions[req.userId] = {
    text,
    grade: old ? String(old.grade || '') : '',
    comment: old ? String(old.comment || '') : '',
    updatedAt: new Date().toISOString()
  };
  const all = store.loadHomework().map(h => h.id === item.id ? item : h);
  store.saveHomework(all);
  ok(res, homeworkView(item, conv, req));
});

/**
 * POST /homework/:id/review
 * 老师批改：写等级与评语
 */
router.post('/homework/:id/review', (req, res) => {
  const item = store.loadHomework().find(h => h.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '作业不存在');
  const conv = store.findConversation(item.convId);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!canManageHomework(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师可以批改作业');

  const body = req.body || {};
  const userId = String(body.userId || '');
  const grade = String(body.grade || '');
  const comment = String(body.comment || '').trim();
  if (!isMember(conv, userId)) return fail(res, 400, 'BAD_REQUEST', '该同学不在群聊中');
  if (grade && !HW_GRADES.includes(grade)) return fail(res, 400, 'BAD_REQUEST', '评语等级不合法');
  if (comment.length > 500) return fail(res, 400, 'BAD_REQUEST', '评语不能超过 500 个字');

  const sub = (item.submissions || {})[userId];
  if (!sub) return fail(res, 404, 'NOT_FOUND', '该同学尚未提交作业');
  sub.grade = grade;
  sub.comment = comment;
  sub.reviewedAt = new Date().toISOString();

  const all = store.loadHomework().map(h => h.id === item.id ? item : h);
  store.saveHomework(all);
  ok(res, { reviewed: true });
});

/**
 * 同步聊天中的作业卡片标题/科目（编辑作业后调用）
 * @param {object} item 作业记录
 */
function syncHomeworkCard(item) {
  store.updateHomeworkCard(item.id, { title: item.title, subject: item.subject });
}

/**
 * PUT /homework/:id
 * 编辑作业（老师 / 班主任 / 群主 / 管理员）
 */
router.put('/homework/:id', (req, res) => {
  const all = store.loadHomework();
  const item = all.find(h => h.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '作业不存在');
  const conv = store.findConversation(item.convId);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!canManageHomework(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师可以编辑作业');

  const body = req.body || {};
  const subject = String(body.subject || '');
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!HW_SUBJECTS.includes(subject)) return fail(res, 400, 'BAD_REQUEST', '请选择科目');
  if (!title) return fail(res, 400, 'BAD_REQUEST', '请填写作业标题');
  if (title.length > 50) return fail(res, 400, 'BAD_REQUEST', '标题不能超过 50 个字');
  if (!content) return fail(res, 400, 'BAD_REQUEST', '请填写作业内容');
  if (content.length > 3000) return fail(res, 400, 'BAD_REQUEST', '作业内容不能超过 3000 个字');

  item.subject = subject;
  item.title = title;
  item.content = content;
  item.needSubmit = body.needSubmit !== false;
  item.attachments = normalizeHomeworkAttachments(body.attachments);
  item.updatedAt = new Date().toISOString();
  store.saveHomework(all);
  syncHomeworkCard(item);                                              // 聊天卡片同步新标题
  ok(res, homeworkView(item, conv, req));
});

/**
 * DELETE /homework/:id
 * 删除作业（老师 / 班主任 / 群主 / 管理员），同时移除群里的作业卡片消息
 */
router.delete('/homework/:id', (req, res) => {
  const all = store.loadHomework();
  const item = all.find(h => h.id === req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '作业不存在');
  const conv = store.findConversation(item.convId);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!canManageHomework(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师可以删除作业');

  store.saveHomework(all.filter(h => h.id !== item.id));
  store.removeHomeworkMessages(item.id);                               // 移除群里的作业卡片
  ok(res, { deleted: true });
});

/**
 * POST /conversations/:id/homework-attachments
 * 上传作业附件（图片/视频/文件）：body { kind, name, dataUrl }
 * 落盘到 group/{会话ID}/homework-files/，返回附件描述（不发消息）
 */
router.post('/conversations/:id/homework-attachments', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '仅群聊支持作业');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!canManageHomework(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师可以布置作业');

  const body = req.body || {};
  const kind = String(body.kind || '');                                 // 附件类型 image/video/file
  const name = String(body.name || '').trim().slice(0, 120);            // 原始文件名（用于展示）
  if (!HW_ATTACH_KINDS.includes(kind)) return fail(res, 400, 'BAD_REQUEST', '附件类型不支持');
  if (!name) return fail(res, 400, 'BAD_REQUEST', '请选择要上传的文件');

  const matched = String(body.dataUrl || '').match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!matched) return fail(res, 400, 'BAD_REQUEST', '文件格式不支持');
  const buf = Buffer.from(matched[2], 'base64');                        // 附件二进制内容
  if (!buf.length) return fail(res, 400, 'BAD_REQUEST', '文件内容为空');
  if (buf.length > HW_ATTACH_LIMITS[kind]) {
    return fail(res, 400, 'BAD_REQUEST',
      kind === 'image' ? '图片不能超过 5MB' : kind === 'video' ? '视频不能超过 50MB' : '文件不能超过 20MB');
  }

  const ext = (path.extname(name).match(/^\.[A-Za-z0-9]{1,12}$/) || [''])[0];   // 保留安全的扩展名
  const fileName = store.genId('a') + ext;                              // 落盘文件名（与原始名解耦）
  const dir = path.join(store.convDir(conv), 'homework-files');         // 会话的作业附件目录
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buf);

  ok(res, {
    kind,
    name,
    size: buf.length,
    url: '/im/api/homework-attachments/' + conv.id + '/' + fileName
  });
});

/**
 * GET /homework-attachments/:convId/:name
 * 访问作业附件：仅限该群成员下载/预览
 */
router.get('/homework-attachments/:convId/:name', (req, res) => {
  const conv = store.findConversation(req.params.convId);
  if (!conv || conv.type !== 'group') return res.status(404).end();
  if (!isMember(conv, req.userId)) return res.status(404).end();

  const name = String(req.params.name || '');                           // 落盘文件名
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name.includes('..')) return res.status(404).end();
  const file = path.join(store.convDir(conv), 'homework-files', name);
  if (!fs.existsSync(file)) return res.status(404).end();

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
});

// ============ 群相册 ============

/** 单个相册一次最多上传的照片数 */
const ALBUM_MAX_UPLOAD = 9;

/** 单个相册最多保留的照片数（防止单文件无限膨胀） */
const ALBUM_MAX_PHOTOS = 500;

/** 单个群最多可创建的相册数 */
const ALBUM_MAX_ALBUMS = 50;

/**
 * 是否可管理群相册（新建 / 删除相册）：群主、管理员、老师、班主任
 * @param {object} conv 会话对象
 * @param {object} req 请求对象（含 userId / isAdmin）
 * @returns {boolean}
 */
function canManageAlbums(conv, req) {
  if (req.isAdmin || conv.ownerId === req.userId) return true;
  const role = store.getPrefs(conv, req.userId).identity.role;           // 我在该群的老师身份
  return role === '老师' || role === '班主任';
}

/**
 * 相册图片目录：{会话目录}/albums
 * @param {object} conv 会话对象
 * @returns {string} 绝对路径
 */
function albumDir(conv) {
  return path.join(store.convDir(conv), 'albums');
}

/**
 * 保存一张相册照片到会话的 albums 目录
 * @param {string} dataUrl data:image/png;base64,xxx
 * @param {object} conv 所属会话
 * @param {string} photoId 照片 ID（同时作为文件名前缀）
 * @returns {{file:string}|{error:string}} 成功返回落盘文件名
 */
function saveAlbumPhoto(dataUrl, conv, photoId) {
  const matched = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/);
  if (!matched) return { error: '仅支持 PNG/JPG/WebP/GIF 图片' };

  const buf = Buffer.from(matched[2], 'base64');                            // 图片二进制内容
  if (!buf.length) return { error: '图片内容为空' };
  if (buf.length > IMAGE_MAX_BYTES) return { error: '图片不能超过 5MB' };

  const file = photoId + '.' + IMAGE_EXT[matched[1]];                       // 落盘文件名
  const dir = albumDir(conv);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  return { file };
}

/**
 * 相册对外结构：补上照片访问地址、封面、点赞与评论
 * @param {object} album 相册原始数据
 * @param {boolean} detail 是否附带完整照片列表（详情页用）
 * @param {string} viewerId 当前查看者 ID（用于计算「我是否点过赞」）
 * @returns {object}
 */
function albumView(album, detail, viewerId) {
  const photos = Array.isArray(album.photos) ? album.photos : [];           // 相册内照片（newest 在前）
  // 封面：优先使用手动设置的封面照片，照片被删除或未设置时回退到最新一张
  const coverPhoto = (album.coverPhotoId && photos.find(p => p.id === album.coverPhotoId)) || photos[0] || null;
  const view = {
    id: album.id,
    name: album.name,
    count: photos.length,
    cover: coverPhoto ? '/im/api/album-photos/' + coverPhoto.file : '',
    coverPhotoId: coverPhoto ? coverPhoto.id : '',
    createdBy: album.createdBy,
    createdByName: album.createdByName,
    createdAt: album.createdAt
  };
  if (detail) {
    view.photos = photos.map(p => {
      const likes = Array.isArray(p.likes) ? p.likes : [];                  // 点赞记录
      return {
        id: p.id,
        src: '/im/api/album-photos/' + p.file,
        uploaderId: p.uploaderId,
        uploaderName: p.uploaderName,
        time: p.time,
        likeCount: likes.length,
        liked: likes.some(l => l && l.userId === viewerId),
        comments: (Array.isArray(p.comments) ? p.comments : []).map(c => ({
          id: c.id,
          userId: c.userId,
          userName: c.userName,
          text: c.text,
          time: c.time
        }))
      };
    });
  }
  return view;
}

/**
 * 往群里发一条群相册卡片消息（创建相册 / 上传照片时触发）
 * @param {object} conv 会话
 * @param {object} req 请求对象（取发送人）
 * @param {object} part 卡片数据 { albumId, albumName, action, count, cover }
 * @param {string} text 会话列表预览文案
 */
function sendAlbumCard(conv, req, part, text) {
  const msg = store.addMessage({
    id: store.genId('m'),
    convId: conv.id,
    senderId: req.userId,
    senderName: req.userName,
    text,
    image: '',
    parts: [Object.assign({ type: 'album' }, part)],
    time: new Date().toISOString(),
    quote: null,
    recalled: false,
    hiddenFor: []
  });
  store.markRead(conv.id, req.userId, msg.time);
  ws.notifyMessage(conv, withSenderNick(conv, msg));                        // 卡片消息实时推送
}

/**
 * GET /conversations/:id/albums
 * 群相册列表（仅群聊）
 */
router.get('/conversations/:id/albums', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '仅群聊支持群相册');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const data = store.loadAlbums(conv.id);
  ok(res, {
    albums: data.albums.map(a => albumView(a, false, req.userId)),
    canManage: canManageAlbums(conv, req)
  });
});

/**
 * POST /conversations/:id/albums
 * 新建相册：body { name }（群主 / 管理员 / 老师）
 */
router.post('/conversations/:id/albums', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '仅群聊支持群相册');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!canManageAlbums(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师或群主可以新建相册');

  const name = String((req.body || {}).name || '').trim().slice(0, 20);     // 相册名称
  if (!name) return fail(res, 400, 'BAD_REQUEST', '请填写相册名称');

  const data = store.loadAlbums(conv.id);
  if (data.albums.length >= ALBUM_MAX_ALBUMS) return fail(res, 400, 'BAD_REQUEST', '相册数量已达上限');

  const album = {
    id: store.genId('a'),
    name,
    createdBy: req.userId,
    createdByName: req.userName,
    createdAt: new Date().toISOString(),
    photos: []
  };
  data.albums.unshift(album);                                              // 新建的相册排在最前
  store.saveAlbums(conv.id, data.albums);
  // 往群里发一条「创建了群相册」卡片消息
  sendAlbumCard(conv, req, {
    albumId: album.id,
    albumName: album.name,
    action: 'create'
  }, '【群相册】' + album.name);
  ok(res, albumView(album, true, req.userId));
});

/**
 * GET /conversations/:id/albums/:albumId
 * 相册详情（含全部照片）
 */
router.get('/conversations/:id/albums/:albumId', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  ok(res, { album: albumView(album, true, req.userId), canManage: canManageAlbums(conv, req) });
});

/**
 * PATCH /conversations/:id/albums/:albumId
 * 编辑相册：body { name?, coverPhotoId? }（群主 / 管理员 / 老师）
 * coverPhotoId 传空串表示恢复默认封面（最新一张照片）
 */
router.patch('/conversations/:id/albums/:albumId', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (conv.type !== 'group') return fail(res, 400, 'BAD_REQUEST', '仅群聊支持群相册');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!canManageAlbums(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师或群主可以编辑相册');

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  const body = req.body || {};

  // 修改相册名称
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 20);               // 新相册名称
    if (!name) return fail(res, 400, 'BAD_REQUEST', '请填写相册名称');
    album.name = name;
  }

  // 设置封面：必须是相册内已存在的照片
  if (body.coverPhotoId !== undefined) {
    const photos = Array.isArray(album.photos) ? album.photos : [];          // 相册内照片
    const coverId = String(body.coverPhotoId || '');
    if (coverId && !photos.some(p => String(p.id) === coverId)) {
      return fail(res, 400, 'BAD_REQUEST', '封面照片不存在');
    }
    album.coverPhotoId = coverId;                                           // 空串 = 恢复默认
  }

  store.saveAlbums(conv.id, data.albums);
  ok(res, albumView(album, true, req.userId));
});

/**
 * POST /conversations/:id/albums/:albumId/photos
 * 上传照片：body { photos: [dataUrl] }，所有群成员都可以上传
 */
router.post('/conversations/:id/albums/:albumId/photos', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const blocked = sendBlocked(conv, req);                                  // 禁言 / 限频校验
  if (blocked) return fail(res, blocked.status, blocked.code, blocked.message);

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  const raw = (req.body || {}).photos;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);              // 兼容单张上传
  if (!list.length) return fail(res, 400, 'BAD_REQUEST', '请选择照片');
  if (list.length > ALBUM_MAX_UPLOAD) return fail(res, 400, 'BAD_REQUEST', '一次最多上传 9 张照片');

  const photos = Array.isArray(album.photos) ? album.photos : [];
  if (photos.length + list.length > ALBUM_MAX_PHOTOS) {
    return fail(res, 400, 'BAD_REQUEST', '相册照片数量已达上限');
  }

  const saved = [];                                                        // 本次新增的照片
  for (const dataUrl of list) {
    const id = store.genId('p');
    const result = saveAlbumPhoto(dataUrl, conv, id);
    if (result.error) return fail(res, 400, 'BAD_REQUEST', result.error);
    saved.push({
      id,
      file: result.file,
      uploaderId: req.userId,
      uploaderName: req.userName,
      time: new Date().toISOString(),
      likes: [],
      comments: []
    });
  }

  album.photos = saved.concat(photos);                                      // newest 在前
  store.saveAlbums(conv.id, data.albums);
  // 往群里发一条「上传 N 张图片」卡片消息（带封面，点卡片进相册）
  sendAlbumCard(conv, req, {
    albumId: album.id,
    albumName: album.name,
    action: 'upload',
    count: saved.length,
    cover: '/im/api/album-photos/' + saved[0].file
  }, '【群相册】' + album.name + ' 上传' + saved.length + '张图片');
  ok(res, { photos: albumView(album, true, req.userId).photos.slice(0, saved.length) });
});

/**
 * DELETE /conversations/:id/albums/:albumId
 * 删除相册（群主 / 管理员 / 老师），同时删除相册内的照片文件
 */
router.delete('/conversations/:id/albums/:albumId', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');
  if (!canManageAlbums(conv, req)) return fail(res, 403, 'FORBIDDEN', '只有老师或群主可以删除相册');

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  const files = (album.photos || []).map(p => p.file);                      // 需要清理的图片文件
  store.saveAlbums(conv.id, data.albums.filter(a => a.id !== album.id));
  files.forEach(file => {
    try { fs.unlinkSync(path.join(albumDir(conv), file)); } catch (_) { /* 文件已不存在，忽略 */ }
  });
  ok(res, { deleted: true });
});

/**
 * POST /conversations/:id/albums/:albumId/photos/:photoId/like
 * 点赞 / 取消点赞（同一用户再次点击即取消）
 */
router.post('/conversations/:id/albums/:albumId/photos/:photoId/like', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  const photos = Array.isArray(album.photos) ? album.photos : [];
  const photo = photos.find(p => String(p.id) === String(req.params.photoId));
  if (!photo) return fail(res, 404, 'NOT_FOUND', '照片不存在');

  const likes = Array.isArray(photo.likes) ? photo.likes : [];
  const index = likes.findIndex(l => l && l.userId === req.userId);        // 我是否已点赞
  if (index >= 0) likes.splice(index, 1);
  else likes.push({ userId: req.userId, userName: req.userName, time: new Date().toISOString() });
  photo.likes = likes;
  store.saveAlbums(conv.id, data.albums);
  ok(res, { liked: index < 0, likeCount: likes.length });
});

/**
 * POST /conversations/:id/albums/:albumId/photos/:photoId/comments
 * 发表照片评论：body { text }
 */
router.post('/conversations/:id/albums/:albumId/photos/:photoId/comments', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const text = String((req.body || {}).text || '').trim().slice(0, 200);   // 评论内容
  if (!text) return fail(res, 400, 'BAD_REQUEST', '评论内容不能为空');

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  const photos = Array.isArray(album.photos) ? album.photos : [];
  const photo = photos.find(p => String(p.id) === String(req.params.photoId));
  if (!photo) return fail(res, 404, 'NOT_FOUND', '照片不存在');

  const comments = Array.isArray(photo.comments) ? photo.comments : [];
  if (comments.length >= 200) return fail(res, 400, 'BAD_REQUEST', '评论数量已达上限');
  comments.push({
    id: store.genId('cm'),
    userId: req.userId,
    userName: req.userName,
    text,
    time: new Date().toISOString()
  });
  photo.comments = comments;
  store.saveAlbums(conv.id, data.albums);
  ok(res, {
    comments: comments.map(c => ({
      id: c.id, userId: c.userId, userName: c.userName, text: c.text, time: c.time
    }))
  });
});

/**
 * DELETE /conversations/:id/albums/:albumId/photos/:photoId
 * 删除照片：上传者本人或群主 / 管理员 / 老师
 */
router.delete('/conversations/:id/albums/:albumId/photos/:photoId', (req, res) => {
  const conv = store.findConversation(req.params.id);
  if (!conv) return fail(res, 404, 'NOT_FOUND', '会话不存在');
  if (!isMember(conv, req.userId)) return fail(res, 403, 'FORBIDDEN', '你不在该会话中');

  const data = store.loadAlbums(conv.id);
  const album = data.albums.find(a => String(a.id) === String(req.params.albumId));
  if (!album) return fail(res, 404, 'NOT_FOUND', '相册不存在');

  const photos = Array.isArray(album.photos) ? album.photos : [];
  const photo = photos.find(p => String(p.id) === String(req.params.photoId));
  if (!photo) return fail(res, 404, 'NOT_FOUND', '照片不存在');
  if (photo.uploaderId !== req.userId && !canManageAlbums(conv, req)) {
    return fail(res, 403, 'FORBIDDEN', '只能删除自己上传的照片');
  }

  album.photos = photos.filter(p => p.id !== photo.id);
  store.saveAlbums(conv.id, data.albums);
  try { fs.unlinkSync(path.join(albumDir(conv), photo.file)); } catch (_) { /* 文件已不存在，忽略 */ }
  ok(res, { deleted: true });
});

/**
 * GET /album-photos/:name
 * 读取群相册照片（仅所属群成员可访问）
 */
router.get('/album-photos/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp|gif)$/.test(name)) return res.status(404).end();

  const found = locateAttachment('albums', name);                           // 在各会话目录中定位照片
  if (!found || !isMember(found.conv, req.userId)) return res.status(404).end();

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(found.file);
});

// —— 全局错误兜底（单条接口异常不拖垮整个子应用） ——
router.use((err, req, res, next) => {
  console.error('[im-api] 未捕获错误：', err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

module.exports = router;
