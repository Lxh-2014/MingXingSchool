/**
 * audio 路由：/api/audio —— 音频列表与扫描。
 */
const express = require('express');
const router = express.Router();
const audioStore = require('../services/audioStore');
const { ok } = require('../utils/response');

/**
 * GET /api/audio —— 返回当前 audio/ 目录下的所有音频。
 */
router.get('/', (req, res) => {
  ok(res, { list: audioStore.list() });
});

/**
 * POST /api/audio/rescan —— 显式重扫（等同于 GET /api/audio）。
 * 用户拖完音频文件无需重启，直接调用即可刷新列表。
 */
router.post('/rescan', (req, res) => {
  ok(res, { list: audioStore.list() });
});

module.exports = router;
