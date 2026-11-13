/**
 * ws.js —— 邻语实时消息推送（WebSocket）
 * ----------------------------------------------------------
 * 路径：/im/ws?token=xxx（原生客户端）；同源浏览器可只靠 cookie token
 * 推送格式（服务端 → 客户端，客户端无需发业务消息）：
 *   { type:'ready' }                                              连接就绪
 *   { type:'message', conversationId, conversation, message }     新消息
 * conversation: { id, type, title }
 * message: 与 REST 接口返回一致（含 senderId / senderNick / parts 等）
 *
 * 设计说明：
 *   - 与直播信令共用同一个 HTTP/HTTPS 服务器，用 noServer 模式按路径分流
 *   - 用一个 Map<userId, Set<ws>> 维护在线连接，同一账号可多端同时在线
 *   - 心跳由服务端定期 ping，半分钟内无 pong 的连接直接断开
 */
const { WebSocketServer } = require('ws');
const sessions = require('../../../server/core/sessions');
const store = require('./store');

/** 在线连接表：userId → 该用户的所有连接 */
const clients = new Map();

/** 是否已挂载到 HTTP 服务（未挂载时广播为空操作，便于独立运行/测试） */
let attached = false;

/**
 * 从升级请求中解析登录令牌
 * 优先 query 参数（原生客户端无法设置 header），其次同源 cookie
 * @param {import('http').IncomingMessage} req 升级请求
 * @returns {string} 令牌，未携带时为空串
 */
function tokenFromRequest(req) {
  let token = '';
  try {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token') || '';
  } catch (e) {
    token = '';
  }
  if (token) return token;

  const rawCookie = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : '';
  const cookieMatch = /(?:^|;\s*)token=([^;]+)/.exec(rawCookie);
  return cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
}

/**
 * 把服务器地址列表统一成数组
 * @param {object|object[]} server HTTP/HTTPS 服务器
 * @returns {object[]}
 */
function toServerList(server) {
  return Array.isArray(server) ? server : [server];
}

/**
 * 向单个用户的所有在线连接推送一条消息
 * @param {string} userId 用户 ID
 * @param {object} payload 推送内容
 */
function pushToUser(userId, payload) {
  if (!userId) return;
  const set = clients.get(userId);
  if (!set || !set.size) return;
  const text = JSON.stringify(payload);
  set.forEach(function (ws) {
    // 1 === WebSocket.OPEN，避免依赖常量名
    if (ws.readyState === 1) {
      try {
        ws.send(text);
      } catch (e) {
        // 发送失败交给 close 事件清理
      }
    }
  });
}

/**
 * 广播新消息给会话全体成员
 * @param {object} conv 会话对象（含 members）
 * @param {object} message 已带 senderNick / senderRole 的消息对象
 */
function notifyMessage(conv, message) {
  if (!attached || !conv || !message) return;
  const members = Array.isArray(conv.members) ? conv.members : [];

  // 每个成员单独推送：附带该成员的会话偏好（免打扰 / 屏蔽由客户端判断）
  members.forEach(function (userId) {
    pushToUser(userId, {
      type: 'message',
      conversationId: conv.id,
      conversation: {
        id: conv.id,
        type: conv.type,
        title: conv.title,
        prefs: store.getPrefs(conv, userId)
      },
      message: message
    });
  });
}

/**
 * 挂载 WebSocket 服务
 * @param {object|object[]} servers 需要监听 upgrade 的 HTTP/HTTPS 服务器
 * @param {string} [basePath] 应用挂载前缀（主项目为 '/im'，独立运行为 ''）
 */
function attachWebSocket(servers, basePath) {
  /** 统一成不带尾部斜杠的前缀 */
  const prefix = (basePath || '').replace(/\/+$/, '');
  /** 邻语推送路径，例如 '/im/ws' */
  const wsPath = prefix + '/ws';

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  /**
   * 处理 WebSocket 升级请求：只接管本应用路径，其余放行给其他模块
   * @param {import('http').IncomingMessage} req 升级请求
   * @param {import('stream').Duplex} socket 底层连接
   * @param {Buffer} head 已读取的握手数据
   */
  function handleUpgrade(req, socket, head) {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (e) {
      return;
    }
    if (pathname !== wsPath) return;
    wss.handleUpgrade(req, socket, head, function (ws) {
      wss.emit('connection', ws, req);
    });
  }

  toServerList(servers).forEach(function (item) {
    item.on('upgrade', handleUpgrade);
  });

  wss.on('connection', function (ws, req) {
    const token = tokenFromRequest(req);
    const userId = token ? sessions.getUserId(token) : undefined;
    if (!userId) {
      // 4001：未登录或登录已过期，客户端据此停止重连并提示重新登录
      ws.close(4001, '未登录');
      return;
    }

    ws.userId = userId;
    ws.isAlive = true;
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);

    ws.on('pong', function () { ws.isAlive = true; });
    ws.on('close', function () {
      const set = clients.get(userId);
      if (!set) return;
      set.delete(ws);
      if (!set.size) clients.delete(userId);
    });
    ws.on('error', function () {
      // 忽略单条连接错误，close 事件会完成清理
    });

    try {
      ws.send(JSON.stringify({ type: 'ready' }));
    } catch (e) {
      // 刚连接就断开时忽略
    }
  });

  // 心跳：定期 ping，上一轮未回 pong 的连接视为僵尸连接
  const heartbeat = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (e) { /* 忽略 */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* 忽略 */ }
    });
  }, 30000);
  heartbeat.unref && heartbeat.unref();

  wss.on('close', function () { clearInterval(heartbeat); });

  attached = true;
}

/**
 * 判断某用户当前是否有在线连接（联系人列表的在线状态来源）
 * @param {string} userId 用户 ID
 * @returns {boolean} 有任意一个处于打开状态的连接即为在线
 */
function isOnline(userId) {
  const set = clients.get(userId);
  if (!set || !set.size) return false;
  let online = false;                                          // 是否存在可用连接
  set.forEach(function (ws) {
    if (ws.readyState === 1) online = true;                    // 1 === WebSocket.OPEN
  });
  return online;
}

module.exports = { attachWebSocket, notifyMessage, isOnline };
