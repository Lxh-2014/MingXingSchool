/**
 * 主项目统一会话管理（全站唯一实例）
 * 登录成功时登记 token → userId 映射；Admin 的 token 同时记录到 adminTokens。
 * 网盘等子应用通过 re-export 本模块共享同一份会话表，保证登出全站生效。
 * 仅内存存储，服务器重启即清空。
 *
 * 网页客户端补充：
 *   - 支持从 Authorization: Bearer <token> 读取 token（跨域离线客户端使用）
 *   - 提供一次性登录票据：客户端打开 /drive 等子应用时先换票据，
 *     服务器再写 cookie 并跳转，避免跨域 cookie 无法直接携带的问题。
 */
const crypto = require('crypto');

/** token → userId 的会话表 */
const sessions = new Map();
/** 管理员 token 集合（便于快速校验管理接口访问权限） */
const adminTokens = new Set();
/** 一次性登录票据表：ticket → { token, userId, expiresAt } */
const loginTickets = new Map();
/** 一次性票据有效期（毫秒），只用于打开子应用的瞬间换票 */
const TICKET_TTL = 2 * 60 * 1000;

/**
 * 登记一次登录会话
 * @param {string} token - cookie 里签发的 token
 * @param {string} userId - 该 token 对应的用户 id
 */
function addSession(token, userId) {
    sessions.set(token, userId);
    if (userId === 'Admin') adminTokens.add(token);
}

/**
 * 根据 token 取回 userId
 * @param {string} token - cookie 里的 token
 * @returns {string | undefined} 未登录则 undefined
 */
function getUserId(token) {
    return sessions.get(token);
}

/**
 * 立即使某 token 失效（登出）
 * @param {string} token
 */
function removeSession(token) {
    sessions.delete(token);
    adminTokens.delete(token);
}

/**
 * 用户改 ID 后迁移所有会话（改 ID 的用户无需重新登录）
 * @param {string} oldId 旧用户 id
 * @param {string} newId 新用户 id
 */
function reassignUser(oldId, newId) {
  for (const [token, uid] of sessions) {
    if (uid === oldId) sessions.set(token, newId);
  }
  // Admin 的 id 固定不允许改，adminTokens 无需处理
}

/**
 * 从请求中提取会话 token：优先 cookie，其次 Authorization: Bearer
 * @param {import('express').Request} req Express 请求对象
 * @returns {string|undefined} 未携带 token 返回 undefined
 */
function getTokenFromRequest(req) {
  if (!req) return undefined;
  const cookieToken = req.cookies && req.cookies.token;
  if (cookieToken) return cookieToken;

  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : undefined;
}

/**
 * 清理已过期的一次性票据
 */
function cleanupTickets() {
  const now = Date.now();
  for (const [ticket, item] of loginTickets) {
    if (!item || item.expiresAt <= now) loginTickets.delete(ticket);
  }
}

/**
 * 创建一次性登录票据
 * @param {string} token 已登录的会话 token
 * @param {string} userId 对应用户 id
 * @returns {string} 随机票据字符串
 */
function createLoginTicket(token, userId) {
  cleanupTickets();
  const ticket = crypto.randomBytes(24).toString('hex');
  loginTickets.set(ticket, {
    token,                                             // 会话 token
    userId,                                            // 用户 id（便于排查）
    expiresAt: Date.now() + TICKET_TTL                 // 过期时间
  });
  return ticket;
}

/**
 * 消费一次性登录票据（无论成功与否都立即删除，防止重复使用）
 * @param {string} ticket 票据字符串
 * @returns {{token:string,userId:string}|null} 有效返回会话信息，无效/过期返回 null
 */
function consumeLoginTicket(ticket) {
  const item = loginTickets.get(ticket);
  loginTickets.delete(ticket);
  if (!item || item.expiresAt <= Date.now()) return null;
  if (!sessions.has(item.token)) return null;
  return { token: item.token, userId: item.userId };
}

module.exports = {
  addSession,
  getUserId,
  removeSession,
  reassignUser,
  adminTokens,
  getTokenFromRequest,
  createLoginTicket,
  consumeLoginTicket
};
