/**
 * sseHub —— SSE 连接管理与事件分发。
 * 两个维度的订阅：
 *   1. 单频道：Map<channelId, Set<res>> —— 频道收听页用，只收某一个频道
 *   2. 聚合：Set<res>                    —— 控制台用，收全部频道快照
 *
 * 服务端 → 客户端事件类型：
 *   event: snapshot  —— 状态对齐（首次连接、重连恢复）
 *   event: command   —— 实时指令（play / pause / resume / stop，含 seq）
 *   event: error     —— 错误广播（如音频文件被删）
 */
const channelStore = require('./channelStore');

// 单频道订阅表：Map<channelId, Set<res>>
const channelClients = new Map();
// 聚合订阅表：Set<res>
const aggregateClients = new Set();
// 心跳定时器句柄（每个 res 一个）
const timers = new WeakMap();
// res -> channelId，用于 close 时清理
const resToChannel = new WeakMap();

const HEARTBEAT_MS = 20000; // 20s 发一次心跳，阻止反代/浏览器断连

/**
 * 往一个 SSE 连接写一条事件。
 * @param {import('express').Response} res
 * @param {string} eventName
 * @param {object|string} payload
 */
function writeEvent(res, eventName, payload) {
  if (res.writableEnded) return;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${data}\n\n`);
}

/**
 * 通用 attach：统一写 SSE 响应头、retry、心跳、close 清理。
 * @param {import('express').Response} res
 * @param {string|null} channelId 指定频道 id；null 表示聚合订阅
 */
function attach(res, channelId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  if (channelId) {
    resToChannel.set(res, channelId);
    const set = channelClients.get(channelId) ?? new Set();
    channelClients.set(channelId, set);
    set.add(res);
    channelStore.addListener(channelId, +1);
    // 连接即推单频道快照
    writeEvent(res, 'snapshot', channelStore.snapshot(channelId));
  } else {
    aggregateClients.add(res);
    // 连接即推全量快照
    writeEvent(res, 'snapshot', channelStore.snapshotAll());
  }

  // 20s 心跳：注释行 ": ping"，浏览器忽略但阻止中间层超时断连
  const hb = setInterval(() => {
    if (!res.writable || res.writableEnded) return;
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  timers.set(res, hb);

  res.req.on('close', () => {
    clearInterval(hb);
    if (channelId) {
      const set = channelClients.get(channelId);
      if (set) {
        set.delete(res);
        channelStore.addListener(channelId, -1);
        if (set.size === 0) channelClients.delete(channelId);
      }
    } else {
      aggregateClients.delete(res);
    }
  });
}

/**
 * 向某频道的所有订阅者广播事件（command/error/snapshot）。
 * 同时向聚合订阅者推送一条全量快照，保证控制台总是看到最新状态。
 * @param {string} channelId
 * @param {string} eventName
 * @param {object} payload
 */
function broadcast(channelId, eventName, payload) {
  // 1) 单频道订阅者（收听页）收原始 command/error
  const set = channelClients.get(channelId);
  if (set) {
    const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      if (res.writable && !res.writableEnded) res.write(line);
    }
  }
  // 2) 聚合订阅者（控制台）收全量 snapshot（让卡片刷新）
  if (aggregateClients.size > 0) {
    const snap = channelStore.snapshotAll();
    const line = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const res of aggregateClients) {
      if (res.writable && !res.writableEnded) res.write(line);
    }
  }
}

/**
 * 向**全部**订阅者广播事件（用于 snapshotAll 全量刷新或系统级 error）。
 * @param {string} eventName
 * @param {object} payload
 */
function broadcastAll(eventName, payload) {
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const set of channelClients.values()) {
    for (const res of set) if (res.writable && !res.writableEnded) res.write(line);
  }
  for (const res of aggregateClients) if (res.writable && !res.writableEnded) res.write(line);
}

module.exports = { attach, broadcast, broadcastAll };
