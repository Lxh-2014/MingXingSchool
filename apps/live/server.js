/**
 * 明星直播 —— WebRTC 网页直播信令服务
 * =====================================================================
 * 设计原则：
 *   1. 不使用数据库：所有频道、配对令牌、连接关系只保存在服务端内存中。
 *   2. 后端只做信令转发（SDP / ICE），不转发任何音视频媒体流。
 *      手机端采集麦克风后，通过 WebRTC P2P 直连主播网页。
 *   3. 四个频道 ch1 / ch2 / ch3 / ch4 完全隔离：
 *      每个频道各自维护一个主播连接、一个手机端连接、若干观众连接和一个配对令牌。
 *      主播通过 WebRTC 把音视频直接推给每一位观众，服务端只转发信令。
 *   4. 手机扫码 URL 由主播网页生成，二维码图片由本服务用 qrcode 渲染。
 *
 * 独立部署：
 *   cd apps/live
 *   npm install
 *   npm start                 # 默认 http://localhost:8081
 *   浏览器打开 http://localhost:8081 作为主播端
 *   手机与电脑同一局域网，扫描页面二维码进入手机端
 *
 * 挂载到明星学校主项目：
 *   主服务把本应用的 express app 挂到 /live，
 *   并调用 attachWebSocket(httpServer, '/live') 接入 /live/ws 信令通道。
 *
 * 环境变量：
 *   PORT        独立运行时的端口，默认 8081
 *   STUN_URLS   逗号分隔的 STUN 地址，默认使用 Google 公共 STUN
 * =====================================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

/** 独立运行时的默认端口 */
const DEFAULT_PORT = 8081;

/** 支持的频道列表：与前端侧边栏 1~4 一一对应 */
const CHANNELS = ['ch1', 'ch2', 'ch3', 'ch4'];

/** 单条 WebSocket 消息允许的最大字节数（SDP 通常只有几 KB） */
const MAX_PAYLOAD = 128 * 1024;

/** 单个频道允许同时观看的最大人数（纯内存直播，避免主播端连接数爆炸） */
const MAX_VIEWERS = 20;

/**
 * 读取 STUN 服务器配置
 * 默认使用 Google 公共 STUN；局域网内即使没有外网，主机候选（host candidate）也能直连。
 * @returns {Array<{urls: string[]}>} RTCPeerConnection 可用的 iceServers 配置
 */
function buildIceServers() {
  // 允许通过环境变量覆盖，多个地址用英文逗号分隔
  const raw = process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
  const urls = raw
    .split(',')
    .map(function (item) { return item.trim(); })
    .filter(Boolean);
  return urls.length ? [{ urls: urls }] : [];
}

/** 全局 ICE 配置（所有频道共用） */
const ICE_SERVERS = buildIceServers();

/**
 * 生成配对令牌
 * 使用加密安全随机数，16 位十六进制字符串，足够避免被猜中。
 * @returns {string} 配对令牌
 */
function newToken() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 计算某个 IPv4 地址的“局域网优先级”
 * 数值越小越优先：192.168 网段 > 10 网段 > 172.16~31 网段 > 其他公网地址。
 * 这样可避免把 VPN / 虚拟网卡地址（例如 26.x、100.x）误当成手机可访问的地址。
 * @param {string} ip IPv4 地址
 * @returns {number} 优先级分值
 */
function lanPriority(ip) {
  if (ip.indexOf('192.168.') === 0) return 0;
  if (ip.indexOf('10.') === 0) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 3;
}

/**
 * 获取本机局域网 IPv4 地址列表
 * 主播通过 localhost 打开页面时，二维码里必须替换成局域网 IP，手机才能访问。
 * 169.254.x.x 是系统自动分配的链路本地地址，手机无法访问，直接排除。
 * @returns {string[]} 按可用性排序的局域网 IPv4 地址
 */
function getLanIps() {
  const result = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (info) {
      // Node 18+ 的 family 可能是字符串 'IPv4'，兼容旧写法数字 4
      const isIPv4 = info.family === 'IPv4' || info.family === 4;
      if (!isIPv4 || info.internal) return;
      if (info.address.indexOf('169.254.') === 0) return;
      result.push(info.address);
    });
  });
  // 按网段优先级排序，保证二维码默认使用最可能被手机访问的地址
  result.sort(function (a, b) { return lanPriority(a) - lanPriority(b); });
  return result;
}

/**
 * 频道房间表：channel -> { token, host, app, viewers, viewerSeq }
 * token 为该频道当前有效的配对令牌；host / app 为对应的 WebSocket 连接；
 * viewers 为观看端连接表（viewerId -> WebSocket）；viewerSeq 用于生成递增的观众编号。
 */
const rooms = new Map();

/**
 * 获取或创建指定频道的房间对象
 * @param {string} channel 频道标识（ch1~ch4）
 * @returns {{token: string|null, host: WebSocket|null, app: WebSocket|null, viewers: Map<string, WebSocket>, viewerSeq: number}}
 */
function getRoom(channel) {
  if (!rooms.has(channel)) {
    rooms.set(channel, {
      token: null,
      host: null,
      app: null,
      viewers: new Map(),   // 观看端连接表：viewerId -> WebSocket
      viewerSeq: 0          // 观众编号自增计数
    });
  }
  return rooms.get(channel);
}

/**
 * 安全发送 JSON 消息
 * 连接已关闭时直接忽略，避免抛异常影响其他频道。
 * @param {WebSocket|null|undefined} ws 目标连接
 * @param {object} payload 消息体
 */
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * 断开某个频道中的手机端，并向其说明原因
 * @param {object} room 频道房间
 * @param {string} reason 断开原因（展示在手机端）
 */
function closeApp(room, reason) {
  if (!room.app) return;
  send(room.app, { type: 'app:closed', message: reason });
  try {
    room.app.close();
  } catch (err) {
    // 连接可能已经断开，忽略即可
  }
  room.app = null;
}

/**
 * 断开某个频道中的所有观众，并向其说明原因
 * 主播下播或重连时调用，避免观众端一直等待已失效的 P2P 连接。
 * @param {object} room 频道房间
 * @param {string} reason 断开原因（展示在观众端）
 */
function closeViewers(room, reason) {
  if (!room.viewers) return;
  room.viewers.forEach(function (viewer) {
    send(viewer, { type: 'viewer:closed', message: reason });
    try {
      viewer.close();
    } catch (err) {
      // 连接可能已经断开，忽略即可
    }
  });
  room.viewers.clear();
}

/**
 * 释放某个连接占用的频道资源
 * 主播断开时：通知手机端与所有观众；
 * 手机端断开时：通知主播手机端已离开；
 * 观众断开时：通知主播该观众已离开。
 * @param {WebSocket} ws 即将释放的连接
 */
function leaveRoom(ws) {
  const channel = ws.channel;
  if (!channel) return;
  const room = rooms.get(channel);
  if (!room) return;

  if (ws.role === 'host' && room.host === ws) {
    room.host = null;
    // 主播离线：手机端无法继续 P2P，主动断开
    if (room.app) {
      send(room.app, { type: 'app:host-left' });
      try { room.app.close(); } catch (err) { /* 忽略 */ }
      room.app = null;
    }
    // 主播离线：所有观众的 P2P 也随之失效，主动关闭
    closeViewers(room, '主播已下播');
    // 令牌保留，主播刷新页面后可继续使用同一张二维码重新配对
  } else if (ws.role === 'app' && room.app === ws) {
    room.app = null;
    send(room.host, { type: 'app:left' });
  } else if (ws.role === 'viewer' && room.viewers.has(ws.viewerId)) {
    room.viewers.delete(ws.viewerId);
    // 通知主播释放对应的 PeerConnection 并刷新观看人数
    send(room.host, {
      type: 'viewer:left',
      viewerId: ws.viewerId,
      count: room.viewers.size
    });
  }
}

// =====================================================================
// HTTP 接口
// =====================================================================

const app = express();

// 页面本身不缓存，保证更新即时生效
// 路由：/ 与 /stream 为主播页，/channel/:n 为观看页（n = 1~4）
// /media 为桌面客户端嵌入式画面页（仅视频，页面控件全部由原生外壳提供）
app.get(['/', '/index.html', '/stream', '/channel/:n', '/media'], function (req, res) {
  // 非法频道编号统一回落到 1 号观看页，避免出现空频道
  if (req.params.n !== undefined) {
    const n = parseInt(req.params.n, 10);
    if (!(n >= 1 && n <= CHANNELS.length)) {
      return res.redirect((req.baseUrl || '') + '/channel/1');
    }
  }
  res.set('Cache-Control', 'no-cache');
  // 嵌入式画面页只包含视频元素，用于桌面客户端 WebView2 承载直播画面
  if (req.path.replace(/\/+$/, '') === '/media') {
    return res.sendFile(path.join(__dirname, 'media.html'));
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * GET /api/info
 * 提供 STUN 配置、局域网 IP、频道列表，供主播端和手机端初始化使用。
 */
app.get('/api/info', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    channels: CHANNELS,
    iceServers: ICE_SERVERS,
    lanIps: getLanIps(),
    // req.socket.localPort 是实际监听端口（无论独立运行还是挂载在主服务上）
    port: req.socket.localPort || DEFAULT_PORT
  });
});

/**
 * GET /api/qrcode?text=...
 * 把主播端生成的配对链接渲染为 PNG 二维码。
 * 限制 text 长度，避免被当作任意图片生成器滥用。
 */
app.get('/api/qrcode', async function (req, res) {
  const text = String(req.query.text || '');
  if (!text || text.length > 1024) {
    return res.status(400).json({ ok: false, message: '二维码内容为空或过长' });
  }
  try {
    const buffer = await QRCode.toBuffer(text, {
      type: 'png',
      width: 420,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#FFFFFF' }
    });
    res.set('Cache-Control', 'no-store');
    res.type('png').send(buffer);
  } catch (err) {
    console.error('[live] 生成二维码失败：', err);
    res.status(500).json({ ok: false, message: '二维码生成失败' });
  }
});

// favicon 兜底：避免日志里出现无意义的 404
app.get('/favicon.ico', function (req, res) {
  res.status(204).end();
});

// 统一错误兜底（防止异步异常导致进程退出）
app.use(function (err, req, res, next) {
  console.error('[live] 未捕获错误：', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: '服务器内部错误' });
});

// =====================================================================
// WebSocket 信令
// =====================================================================

/**
 * 把 WebSocket 信令服务挂到指定的 HTTP 服务上
 * 注意：express 无法处理 HTTP Upgrade，因此必须在主服务的 http.Server 上单独挂载。
 * @param {import('http').Server|import('https').Server|Array} server 单个服务器，或需要共用同一套房间状态的服务器数组
 *        （主项目同时提供 HTTP 与 HTTPS 时传数组：信令只在入口处解析一次，房间/心跳仍是同一份，避免 ws 与 wss 连不上面）
 * @param {string} [basePath] 应用挂载前缀，独立运行为 ''，主项目为 '/live'
 * @param {{verifyHost?: (req: import('http').IncomingMessage) => boolean}} [options]
 *        verifyHost 用于校验“主播身份”（主项目传入管理员校验）；不传则默认允许开播（独立运行）
 */
function attachWebSocket(server, basePath, options) {
  // 统一成不带尾部斜杠的前缀
  const prefix = (basePath || '').replace(/\/+$/, '');
  /** 本应用的信令路径，例如独立运行 '/ws'，主项目 '/live/ws' */
  const signalPath = prefix + '/ws';
  /** 主播身份校验函数（未提供时视为允许） */
  const verifyHost = (options && typeof options.verifyHost === 'function') ? options.verifyHost : null;
  /** 需要监听 upgrade 的服务器列表（HTTP / HTTPS 可共用同一个 wss） */
  const servers = Array.isArray(server) ? server : [server];

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  /**
   * 处理一次 WebSocket 升级请求
   * @param {import('http').IncomingMessage} req 升级请求
   * @param {import('stream').Duplex} socket 底层 socket
   * @param {Buffer} head 已读取的握手数据
   */
  function handleUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (err) {
      return;
    }
    // 不属于本应用的升级请求直接放行，避免影响其他 WebSocket 模块
    if (pathname !== signalPath) return;
    wss.handleUpgrade(req, socket, head, function (ws) {
      // 在握手阶段就确定该连接是否具备“开播”权限，viewer / app 不受此限制
      let hostAllowed = true;
      if (verifyHost) {
        try {
          hostAllowed = !!verifyHost(req);
        } catch (err) {
          hostAllowed = false;
        }
      }
      ws.hostAllowed = hostAllowed;                     // 是否允许调用 host:join
      wss.emit('connection', ws, req);
    });
  }

  servers.forEach(function (item) {
    item.on('upgrade', handleUpgrade);
  });

  // 心跳：定期清理掉线连接，避免房间被僵尸连接占用
  const heartbeat = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (err) { /* 忽略 */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (err) { /* 忽略 */ }
    });
  }, 30000);
  wss.on('close', function () { clearInterval(heartbeat); });

  wss.on('connection', function (ws) {
    ws.isAlive = true;
    ws.on('pong', function () { ws.isAlive = true; });

    ws.on('message', function (raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return send(ws, { type: 'error', message: '消息格式错误' });
      }
      if (!msg || typeof msg.type !== 'string') return;
      handleMessage(ws, msg);
    });

    ws.on('close', function () { leaveRoom(ws); });
    ws.on('error', function () {
      // 连接异常时 onclose 会继续触发，这里无需额外处理
    });
  });

  return wss;
}

/**
 * 处理客户端信令消息
 * 所有频道操作都先校验频道合法性，确保 ch1~ch4 互不串流。
 * @param {WebSocket} ws 当前连接
 * @param {object} msg 客户端消息
 */
function handleMessage(ws, msg) {
  const channel = msg.channel;
  const validChannel = CHANNELS.includes(channel);

  // ---------- 主播端：加入频道 ----------
  if (msg.type === 'host:join') {
    if (!validChannel) return send(ws, { type: 'error', message: '频道不存在' });
    // 主项目挂载时会校验管理员身份，避免普通用户绕过页面直接开播
    if (ws.hostAllowed === false) {
      send(ws, { type: 'error', message: '仅管理员可以开启直播' });
      try { ws.close(); } catch (err) { /* 忽略 */ }
      return;
    }

    // 如果该连接之前绑定过其他频道，先释放旧房间
    if (ws.channel && ws.channel !== channel) leaveRoom(ws);

    const room = getRoom(channel);

    // 同一频道只允许一个主播；旧主播连接被顶下线
    if (room.host && room.host !== ws) {
      send(room.host, { type: 'error', message: '该频道已有其他主播接入，当前连接已断开' });
      try { room.host.close(); } catch (err) { /* 忽略 */ }
    }

    room.host = ws;
    ws.role = 'host';
    ws.channel = channel;

    // 复用已有令牌，保证主播刷新页面后二维码仍然有效；没有则生成新的
    if (!room.token) room.token = newToken();

    // 新主播进入时，旧手机端无法继续使用，先断开
    if (room.app) closeApp(room, '主播已重新连接，请重新扫码配对');
    // 旧观众的 PeerConnection 已随旧主播失效，统一关闭
    if (room.viewers && room.viewers.size) closeViewers(room, '主播已重新连接');

    send(ws, { type: 'host:joined', channel: channel, token: room.token });
    return;
  }

  // ---------- 主播端：刷新配对令牌 ----------
  if (msg.type === 'host:refresh-token') {
    if (!ws.channel) return send(ws, { type: 'error', message: '请先加入频道' });
    const room = getRoom(ws.channel);
    room.token = newToken();
    // 旧令牌立即失效，已配对的手机端也一并断开
    closeApp(room, '配对码已更新，请重新扫码');
    send(ws, { type: 'host:token', channel: ws.channel, token: room.token });
    return;
  }

  // ---------- 主播端：踢掉手机端 ----------
  if (msg.type === 'host:kick') {
    if (!ws.channel) return;
    const room = getRoom(ws.channel);
    closeApp(room, '主播已断开手机端');
    send(ws, { type: 'app:left' });
    return;
  }

  // ---------- 主播端：转发 SDP / ICE 给手机端 ----------
  if (msg.type === 'host:signal') {
    if (ws.role !== 'host') return;
    const room = getRoom(ws.channel);
    if (!room.app) return send(ws, { type: 'error', message: '手机端尚未连接' });
    // 只转发信令数据，不含任何媒体内容
    send(room.app, { type: 'signal', from: 'host', data: msg.data || null });
    return;
  }

  // ---------- 主播端：转发 SDP / ICE 给指定观众 ----------
  if (msg.type === 'host:viewer-signal') {
    if (ws.role !== 'host') return;
    const room = getRoom(ws.channel);
    const viewerId = String(msg.viewerId || '');
    const target = room.viewers.get(viewerId);
    if (!target) return;
    // 服务端只转发信令，视频 / 音频由主播浏览器直接 P2P 发给观众
    send(target, { type: 'signal', from: 'host', data: msg.data || null });
    return;
  }

  // ---------- 观看端：加入频道 ----------
  if (msg.type === 'viewer:join') {
    if (!validChannel) return send(ws, { type: 'viewer:rejected', message: '频道不存在' });
    const room = getRoom(channel);

    // 主播尚未开播：拒绝进入，客户端稍后自动重试
    if (!room.host) return send(ws, { type: 'viewer:rejected', message: '主播尚未开播，请稍候' });

    // 同一连接重复申请同一频道：直接复用已有观众编号
    if (ws.role === 'viewer' && ws.channel === channel && room.viewers.has(ws.viewerId)) {
      return send(ws, {
        type: 'viewer:joined',
        channel: channel,
        viewerId: ws.viewerId,
        count: room.viewers.size
      });
    }

    if (room.viewers.size >= MAX_VIEWERS) {
      return send(ws, { type: 'viewer:rejected', message: '该频道观看人数已满（最多 ' + MAX_VIEWERS + ' 人）' });
    }

    // 该连接之前可能绑定过其他频道，先释放旧资源
    if (ws.channel && ws.channel !== channel) leaveRoom(ws);

    room.viewerSeq += 1;
    const viewerId = 'v' + room.viewerSeq;     // 生成的观众编号，用于区分多条 PeerConnection
    room.viewers.set(viewerId, ws);
    ws.role = 'viewer';
    ws.channel = channel;
    ws.viewerId = viewerId;

    send(ws, {
      type: 'viewer:joined',
      channel: channel,
      viewerId: viewerId,
      count: room.viewers.size
    });
    // 通知主播端：为这位观众创建 PeerConnection 并发送 Offer
    send(room.host, {
      type: 'viewer:joined',
      viewerId: viewerId,
      count: room.viewers.size
    });
    return;
  }

  // ---------- 观看端：转发 SDP / ICE 给主播端 ----------
  if (msg.type === 'viewer:signal') {
    if (ws.role !== 'viewer') return;
    const room = getRoom(ws.channel);
    if (!room.host) return;
    send(room.host, { type: 'viewer:signal', viewerId: ws.viewerId, data: msg.data || null });
    return;
  }

  // ---------- 观看端：主动离开 ----------
  if (msg.type === 'viewer:leave') {
    leaveRoom(ws);
    return;
  }

  // ---------- 手机端：使用配对令牌加入频道 ----------
  if (msg.type === 'app:join') {
    if (!validChannel) return send(ws, { type: 'app:rejected', message: '频道不存在' });
    const room = getRoom(channel);

    if (!room.host) {
      return send(ws, { type: 'app:rejected', message: '主播尚未开始直播，请稍后重试' });
    }
    if (!room.token || String(msg.token || '') !== room.token) {
      return send(ws, { type: 'app:rejected', message: '配对令牌无效或已过期，请重新扫码' });
    }
    if (room.app && room.app !== ws) {
      return send(ws, { type: 'app:rejected', message: '该频道已有手机端连接，请先断开旧设备' });
    }

    room.app = ws;
    ws.role = 'app';
    ws.channel = channel;

    send(ws, { type: 'app:joined', channel: channel });
    // 通知主播端：可以创建 PeerConnection 并发 Offer
    send(room.host, { type: 'app:joined', channel: channel });
    return;
  }

  // ---------- 手机端：转发 SDP / ICE 给主播端 ----------
  if (msg.type === 'app:signal') {
    if (ws.role !== 'app') return;
    const room = getRoom(ws.channel);
    if (!room.host) return;
    send(room.host, { type: 'signal', from: 'app', data: msg.data || null });
    return;
  }

  // ---------- 手机端：主动离开 ----------
  if (msg.type === 'app:leave') {
    leaveRoom(ws);
    return;
  }
}

// 导出 express app，供主项目 app.use('/live', liveApp) 挂载
module.exports = app;
module.exports.attachWebSocket = attachWebSocket;
module.exports.CHANNELS = CHANNELS;
module.exports.ICE_SERVERS = ICE_SERVERS;

// =====================================================================
// 独立运行入口（被主项目 require 时不会执行）
// =====================================================================
if (require.main === module) {
  const PORT = Number(process.env.PORT) || DEFAULT_PORT;
  const server = http.createServer(app);
  attachWebSocket(server, '');

  server.listen(PORT, '0.0.0.0', function () {
    const lanIps = getLanIps();
    console.log('==================================================');
    console.log('  明星直播 已启动');
    console.log(`  主播端:    http://localhost:${PORT}/`);
    if (lanIps.length) {
      console.log(`  局域网:    http://${lanIps[0]}:${PORT}/  （手机扫码后进入手机麦克风页）`);
    }
    console.log(`  信令路径:  ws://localhost:${PORT}/ws`);
    console.log(`  STUN:      ${ICE_SERVERS.length ? ICE_SERVERS[0].urls.join(', ') : '未配置'}`);
    console.log('  提示: 手机浏览器采集麦克风需要 HTTPS 或 localhost；');
    console.log('        若手机端由原生 APP 实现，则不受该限制。');
    console.log('==================================================');
  });
}
