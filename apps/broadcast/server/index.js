/**
 * 应用装配入口。
 * 职责：
 *   - express 中间件（JSON body parser、错误兜底）
 *   - 挂载 /api/audio 与 /api/channels 路由
 *   - /api/events 聚合 SSE 端点（单独路由，避开 channels/:id 通配）
 *   - express.static 托管 audio/ 与 client/，前者需要 fallthrough:false
 *     让 <audio> 收到 404 时是真实 HTTP 响应而非 HTML 错误页
 *   - /channel/:name 通配 → channel.html（收听页，name 允许中文）
 *   - 启动日志：监听端口、audio 目录状态、四个频道清单
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const channelsRouter = require('./routes/channels');
const audioRouter = require('./routes/audio');
const channels = require('./config/channels');
const audioStore = require('./services/audioStore');

const PORT = process.env.PORT || 3000;

const app = express();

// JSON body，限制 1MB（投放请求体很小，给冗余值就够）
app.use(express.json({ limit: '1mb' }));

// —— /api/audio ——
app.use('/api/audio', audioRouter);

// —— /api/channels ——
app.use('/api/channels', channelsRouter);

// —— /api/events 聚合 SSE（控制台专用）—— 单独挂，避免被 channels/:id 吃掉
app.get('/api/events', (req, res) => {
  // 懒加载，避免循环依赖
  const sseHub = require('./services/sseHub');
  sseHub.attach(res, null);
});

// —— /audio/:file 静态托管 ——
// 必须 fallthrough:false，否则目录内没有时会继续往下匹配，
// 让 <audio src> 收到的 404 被 express.static 自己处理成 HTTP 404，保持可读流行为
const AUDIO_DIR = audioStore.AUDIO_DIR;
audioStore.ensureDir();
app.use('/audio', express.static(AUDIO_DIR, {
  fallthrough: false,
  setHeaders: (res) => {
    // 音频不走缓存，便于用户替换同名文件
    res.setHeader('Cache-Control', 'no-cache');
  }
}));
// express.static 404 兜底为 {ok:false, error:{code:'AUDIO_NOT_FOUND'}}
app.use('/audio', (err, req, res, next) => {
  // fallthrough:false 触发的是 express 404 Error
  res.status(404).json({ ok: false, error: { code: 'AUDIO_NOT_FOUND', message: '音频文件不存在' } });
});

// —— client 静态托管 ——
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR, {
  // HTML 文档禁用启发式缓存：每次都向服务器验证，确保页面更新即时生效
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));

// —— /channel/:name 通配 → index.html（SPA 入口，前端路由器按 URL 渲染对应频道）——
// name 可能是中文编码（如 /channel/%E6%95%99%E5%AE%A4），express 会自动 decodeURI
app.get('/channel/:name', (req, res) => {
  // 允许任意路径都进入收听页，前端自行校验频道名是否合法
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// —— 全局错误兜底（防炸）——
app.use((err, req, res, next) => {
  console.error('[server] 未捕获错误：', err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

// 导出 app，供明星学校主应用挂载到 /broadcast
module.exports = app;

// —— 启动（仅独立运行时监听）——
if (require.main === module) {
  app.listen(PORT, () => {
    const audioList = audioStore.list();
    console.log('\n====== 明星广播器 启动成功 ======');
    console.log(`监听地址:  http://localhost:${PORT}`);
    console.log(`控制台:    http://localhost:${PORT}/`);
    console.log(`音频目录:  ${AUDIO_DIR}`);
    console.log(`音频数量:  ${audioList.length}`);
    if (audioList.length === 0) {
      console.log('  提示：audio 目录为空，请把 mp3 文件放入 ' + AUDIO_DIR);
      console.log('  放完后点控制台顶部「重新扫描」或直接刷新页面即可');
    }
    console.log('频道列表:');
    for (const ch of channels.CHANNELS) {
      console.log(`  - ${ch.name}  http://localhost:${PORT}/channel/${encodeURIComponent(ch.name)}`);
    }
    console.log('================================\n');
  });
}
