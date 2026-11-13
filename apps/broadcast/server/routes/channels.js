/**
 * channels 路由 —— 频道状态 REST + SSE 事件订阅。
 * 路由参数 :id 同时接受英文 id（playground）或 URL 编码的中文（教室）。
 */
const express = require('express');
const router = express.Router();
const channels = require('../config/channels');
const channelStore = require('../services/channelStore');
const audioStore = require('../services/audioStore');
const sseHub = require('../services/sseHub');
const { ok, fail } = require('../utils/response');

/** 内部工具：解析路由参数，不存在则返回 HTTP 400 */
function resolveOrFail(req, res) {
  const id = decodeURIComponent(req.params.id);
  const cfg = channels.resolve(id);
  if (!cfg) {
    fail(res, 400, 'CHANNEL_NOT_FOUND',
      `频道不存在：${id}。可选值：${channels.CHANNELS.map(c => c.name).join('、')}`);
    return null;
  }
  return cfg;
}

/**
 * GET /api/channels —— 返回四个频道的当前状态。
 */
router.get('/', (req, res) => {
  ok(res, channelStore.snapshotAll());
});

/**
 * GET /api/channels/:id —— 返回单频道状态。
 */
router.get('/:id', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  ok(res, channelStore.snapshot(cfg.id));
});

/**
 * GET /api/channels/:id/events —— 单频道 SSE。
 * 收听页用；连上即推 snapshot，后续只收该频道的 command/error。
 */
router.get('/:id/events', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  sseHub.attach(res, cfg.id);
});

/**
 * POST /api/channels/:id/play —— 投放音频并从头播放，或从头重放当前音频。
 * audioId 可选：传入则投放新音频；不传则重放频道当前的 audio（paused/playing 均适用）。
 */
router.post('/:id/play', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  const { audioId } = req.body || {};

  let audio;
  if (audioId) {
    audio = audioStore.find(audioId);
    if (!audio) return fail(res, 400, 'AUDIO_NOT_FOUND', '音频文件不存在或已被移动');
  } else {
    // 重放当前：必须频道已有 audio
    const cur = channelStore.snapshot(cfg.id);
    if (!cur || !cur.audioId) {
      return fail(res, 400, 'NO_CURRENT_AUDIO', '当前频道没有音频可以重放');
    }
    audio = { id: cur.audioId, name: cur.audioName, file: cur.audioFile };
  }

  const { state, nextSeq } = channelStore.play(cfg.id, {
    id: audio.id, name: audio.name, file: audio.file
  });
  sseHub.broadcast(cfg.id, 'command', {
    action: 'play',
    seq: nextSeq,
    audioId: audio.id,
    url: `/audio/${encodeURIComponent(audio.file)}`
  });
  ok(res, state);
});

/**
 * POST /api/channels/:id/pause —— 暂停（幂等）。
 */
router.post('/:id/pause', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  const { state, changed, nextSeq } = channelStore.pause(cfg.id);
  if (changed) sseHub.broadcast(cfg.id, 'command', { action: 'pause', seq: nextSeq });
  ok(res, state);
});

/**
 * POST /api/channels/:id/resume —— 继续播放（幂等）。
 */
router.post('/:id/resume', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  const { state, changed, nextSeq } = channelStore.resume(cfg.id);
  if (changed) sseHub.broadcast(cfg.id, 'command', { action: 'resume', seq: nextSeq });
  ok(res, state);
});

/**
 * POST /api/channels/:id/stop —— 停止（幂等）。
 */
router.post('/:id/stop', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  const { state, changed, nextSeq } = channelStore.stop(cfg.id);
  if (changed) sseHub.broadcast(cfg.id, 'command', { action: 'stop', seq: nextSeq });
  ok(res, state);
});

/**
 * POST /api/channels/:id/duration —— 客户端上报音频总时长。
 * 请求体：{ durationSec: number }
 * 任何一个听众首次 loadedmetadata 后上报，其他听众就能看到进度百分比。
 * 只广播 snapshot（不发 command），因为是"状态字段更新"而非"播放指令"。
 */
router.post('/:id/duration', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  const dur = Number(req.body && req.body.durationSec);
  const next = channelStore.reportDuration(cfg.id, dur);
  if (next) {
    sseHub.broadcast(cfg.id, 'snapshot', next);
  }
  ok(res, next);
});

/**
 * POST /api/channels/:id/seek —— 操作台拖动进度条跳转播放位置。
 * 请求体：{ positionSec: number }
 * 把 startedAt 重算为「现在 - 位置秒数」，收听页收到新快照后自动 seek 对齐。
 */
router.post('/:id/seek', (req, res) => {
  const cfg = resolveOrFail(req, res);
  if (!cfg) return;
  const pos = Number(req.body && req.body.positionSec);
  const next = channelStore.seek(cfg.id, pos);
  if (!next) {
    return fail(res, 400, 'SEEK_REJECTED', '当前频道未在播放，无法跳转进度');
  }
  sseHub.broadcast(cfg.id, 'snapshot', next);
  ok(res, next);
});

/**
 * GET /api/events —— 聚合 SSE，控制台专用。
 * 只订阅一次，收到全部频道的 snapshot 刷新，避免 HTTP/1.1 每域 6 连接上限。
 */
router.get('/_aggregate/events', (req, res) => {
  sseHub.attach(res, null);
});

module.exports = router;
