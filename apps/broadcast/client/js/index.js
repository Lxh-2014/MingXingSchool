/*
 * index.js —— 控制台视图（ConsoleView）。
 *
 * 只定义不执行：路由器 app.js 切到控制台视图时调 init()，返回销毁函数 teardown。
 * 做的事：
 *   1) init 时拉一次 /api/audio 和 /api/channels，渲染页面
 *   2) 订阅 /api/events 聚合 SSE，snapshot 一来就全量重绘频道卡片 + 音频状态
 *   3) 投放按钮 → Modal 选频道 → POST /api/channels/:id/play
 *   4) 频道卡「停止」按钮 → POST /api/channels/:id/stop
 *   5) 播放中的频道卡显示可拖动进度滑条（POST seek 全房间跳转）
 *   6) 时长探测：播放中但无人上报时长时，用隐藏 Audio 拉 metadata 并上报
 */

window.ConsoleView = (function(){
  // 从 App 解构主要工具，renderIcon 来自 icons.js（挂 window）
  const { api, subscribe, showToast, escapeHtml } = window.App;
  const { renderIcon } = window;

  /**
   * 取多语言文案：i18n 框架未加载时回退中文兜底
   * @param {string} key 语言包键（如 broadcast.console.play）
   * @param {string} fallback 中文兜底文案
   * @param {object} [params] 占位参数（如 {count: 3}）
   * @returns {string} 展示文案
   */
  function bcT(key, fallback, params) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : fallback;
  }

  /**
   * 频道 id → 界面展示名的语言包键映射（频道 id 属于后端数据键，本身不翻译）
   */
  const CHANNEL_LABEL_KEYS = {
    playground: 'broadcast.channels.playground',
    classroom: 'broadcast.channels.classroom',
    canteen: 'broadcast.channels.canteen',
    magic: 'broadcast.channels.magic'
  };

  /**
   * 取频道展示名（按当前语言翻译，缺失时回退配置里的中文名）
   * @param {object} cfg 频道配置对象（需含 id 与 name）
   * @returns {string} 展示名
   */
  function channelLabel(cfg) {
    return bcT(CHANNEL_LABEL_KEYS[cfg.id], cfg.name);
  }

  // —— 页面状态 ——
  /** 当前选中要投放的音频 id */
  let pendingAudioId = null;
  /** 弹窗里当前选中的频道 id 集合（支持多选） */
  let pendingChannelIds = new Set();
  /** 频道配置缓存（服务端 config/channels.js 里的固定四个） */
  let channelsCfg = [];
  /** 音频列表缓存 */
  let audioList = [];
  /** 聚合 SSE 连接句柄，teardown 时关闭防止重复订阅 */
  let es = null;
  /** 卡片进度行刷新定时器，teardown 时清除 */
  let progressTimer = null;
  /** 最新一次快照的频道状态缓存（滑条每秒回写时读取，避免重新请求） */
  let statesCache = {};
  /** 时长探测中的隐藏 Audio 元素（channelId -> element），防止重复探测 */
  const durationProbes = new Map();

  // —— 取 DOM ——
  const gridEl = document.getElementById('channel-grid');
  const audioWrap = document.getElementById('audio-list-wrap');
  const audioCount = document.getElementById('audio-count');
  const rescanBtn = document.getElementById('btn-rescan');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const modal = document.getElementById('modal-overlay');
  const modalInfo = document.getElementById('modal-audio-info');
  const channelPick = document.getElementById('channel-pick-list');
  const modalCancel = document.getElementById('modal-cancel');
  const modalConfirm = document.getElementById('modal-confirm');

  /** 路径前缀：挂载到明星学校 /broadcast，音频探测等直接请求需要拼上 */
  const BASE = '/broadcast';

  // —— 频道配置（与后端 server/config/channels.js 保持一致）——
  // 前端也要这份，否则无法知道频道 icon/color
  // 图标用相对路径（配合 <base href="/broadcast/">），收听页深层路径也能正确解析
  const CHANNELS_FRONT = [
    { id: 'playground', name: '操场',     icon: '操场.svg',     color: '#3CB371' },
    { id: 'classroom',  name: '教室',     icon: '教室.svg',     color: '#1CB0F6' },
    { id: 'canteen',    name: '食堂',     icon: '食堂.svg',     color: '#FF7BAC' },
    { id: 'magic',      name: '魔法教室', icon: '魔法教室.svg', color: '#9B59B6' }
  ];
  channelsCfg = CHANNELS_FRONT;

  /**
   * 时长探测：频道在播但还没人上报总时长时，用隐藏 Audio 只拉取 metadata
   * （不播放、无需用户手势），拿到 duration 后上报服务端，让操作台滑条立即可用。
   * @param {Object} st 单个频道快照状态
   */
  function probeDuration(st) {
    if (durationProbes.has(st.id)) return;      // 已在探测中
    const cfg = CHANNELS_FRONT.find(c => c.id === st.id);
    if (!cfg || !st.audioFile) return;
    const probe = new Audio(`${BASE}/audio/${encodeURIComponent(st.audioFile)}`);
    probe.preload = 'metadata';                  // 只拉元数据，不下载全部音频
    durationProbes.set(st.id, probe);
    probe.addEventListener('loadedmetadata', () => {
      durationProbes.delete(st.id);
      if (probe.duration && isFinite(probe.duration) && probe.duration > 0) {
        api(`/api/channels/${st.id}/duration`, {
          method: 'POST',
          body: { durationSec: Math.round(probe.duration * 10) / 10 }
        }).catch(() => {});                      // api() 内部已 Toast 错误
      }
      probe.removeAttribute('src');              // 释放加载，绝不发出声音
      probe.load();
    }, { once: true });
    probe.addEventListener('error', () => durationProbes.delete(st.id), { once: true });
  }

  /** 对所有"播放中但时长未知"的频道发起探测（每次快照后调用）。 */
  function probeMissingDurations(states) {
    states.forEach(s => {
      if (s.status === 'playing' && !(s.durationSec && s.durationSec > 0)) probeDuration(s);
    });
  }

  // ========== 渲染 ==========

  /** 根据服务端 channelStore.snapshotAll() 渲染四张频道卡。 */
  function renderChannels(states) {
    const byId = Object.fromEntries(states.map(s => [s.id, s]));
    statesCache = byId;    // 缓存给滑条每秒回写用
    probeMissingDurations(states);    // 时长未知时自己探测，让滑条尽快可用
    gridEl.innerHTML = '';
    for (const cfg of channelsCfg) {
      const s = byId[cfg.id] || { status: 'idle', audioName: null };
      /** 频道展示名（按当前语言翻译，频道 id 不翻译） */
      const label = channelLabel(cfg);
      /** 状态徽章文案（idle/playing/paused 是状态枚举值，本身不翻译） */
      const badgeText = {
        idle: bcT('broadcast.status.idle', '空闲'),
        playing: bcT('broadcast.status.playing', '播放中'),
        paused: bcT('broadcast.status.paused', '已暂停')
      }[s.status];
      const nowHtml = s.audioName
        ? `<strong>${escapeHtml(s.audioName)}</strong>`
        : escapeHtml(bcT('broadcast.console.nowNone', '当前无播放'));
      // 进度提示行（播放中显示已播秒数，其他状态显示对应提示）
      let hintHtml;
      if (s.status === 'playing' && s.startedAt) {
        const durAttr = s.durationSec ? ` data-duration="${s.durationSec}"` : '';
        hintHtml = `<span class="channel-hint" data-started="${s.startedAt}"${durAttr}>${escapeHtml(playingHintText(elapsedSec(s.startedAt), s.durationSec))}</span>`;
      } else if (s.status === 'paused') {
        hintHtml = `<span class="channel-hint">${escapeHtml(bcT('broadcast.status.paused', '已暂停'))}</span>`;
      } else {
        hintHtml = `<span class="channel-hint muted">${escapeHtml(bcT('broadcast.console.hintIdle', '未在播放'))}</span>`;
      }

      // 可拖动进度滑条：只在"播放中且已知总时长"时显示（拖动 → POST seek 全房间跳转）
      let seekHtml = '';
      if (s.status === 'playing' && s.durationSec && s.durationSec > 0) {
        const dur = Math.floor(s.durationSec);
        const cur = elapsedSec(s.startedAt);
        seekHtml = `
          <div class="channel-seek">
            <input type="range" class="seek-slider" min="0" max="${dur}" step="1"
                   value="${Math.min(cur, dur)}" data-id="${cfg.id}" aria-label="${escapeHtml(bcT('broadcast.console.progress', '播放进度'))}">
            <span class="seek-time">${fmtSec(cur)} / ${fmtSec(s.durationSec)}</span>
          </div>`;
      }

      const card = document.createElement('div');
      card.className = 'card channel-card';
      card.dataset.id = cfg.id;     // 卡片本身也带 data-id，便于 SSE 刷新后精确选中
      // 只留「停止」按钮；投放通过下方音频列表的「投放」按钮完成
      card.innerHTML = `
        <div class="channel-card-head">
          <div class="channel-icon" style="background:${cfg.color}">
            <img class="icon" src="${cfg.icon}" alt="${escapeHtml(label)}">
          </div>
          <div class="channel-meta">
            <h3 class="channel-name">${escapeHtml(label)}</h3>
            <span class="badge ${s.status}">${badgeText}</span>
          </div>
          <span class="channel-listener" title="${escapeHtml(bcT('broadcast.console.listenersTitle', '当前收听人数'))}">
            ${renderIcon('broadcast')} ${s.listeners || 0}
          </span>
        </div>
        <div class="channel-now">${nowHtml}</div>
        ${hintHtml}
        ${seekHtml}
        <div class="channel-controls" style="grid-template-columns:1fr;">
          <button class="btn btn-column4" data-action="stop" data-id="${cfg.id}" title="${escapeHtml(bcT('broadcast.console.stop', '停止'))}">
            ${escapeHtml(bcT('broadcast.console.stop', '停止'))}
          </button>
        </div>
      `;
      gridEl.appendChild(card);
    }
  }

  /**
   * 根据服务端 startedAt 算出已播放的秒数。
   * @param {number} startedAt - 服务端记录的播放开始时间（毫秒）
   * @returns {number} 已播放秒数（向下取整）
   */
  function elapsedSec(startedAt) {
    if (!startedAt) return 0;
    const el = Date.now() - startedAt;
    return el > 0 ? Math.floor(el / 1000) : 0;
  }

  /**
   * 把秒数格式化成 mm:ss。
   * @param {number} sec - 秒数
   * @returns {string} 形如 "01:23"
   */
  function fmtSec(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  /**
   * 生成"播放进度"提示文案（有总时长时显示 "已播 / 总时长"）
   * @param {number} sec 已播放秒数
   * @param {number} [dur] 总时长秒数，0 或空表示未知
   * @returns {string} 提示文案
   */
  function playingHintText(sec, dur) {
    if (dur && dur > 0) {
      return bcT('broadcast.console.hintPlayingTotal', '已播放 {time} / {total} · 由控制台投放', {
        time: fmtSec(sec),
        total: fmtSec(dur)
      });
    }
    return bcT('broadcast.console.hintPlaying', '已播放 {time} · 由控制台投放', { time: fmtSec(sec) });
  }

  /**
   * 启动每秒刷新：1) 提示行文字 2) 进度滑条位置（拖动中的跳过）。
   * init 时调用，teardown 时清除。
   */
  function startProgressTimer() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      // 1) 提示行文字（每秒按当前语言重新取文案，切换语言后也保持同步）
      document.querySelectorAll('.channel-hint[data-started]').forEach(el => {
        const started = Number(el.dataset.started);
        const dur = Number(el.dataset.duration);
        el.textContent = playingHintText(elapsedSec(started), dur);
      });
      // 2) 进度滑条位置（拖动中的跳过，避免打断用户）
      document.querySelectorAll('.seek-slider').forEach(sl => {
        if (sl.dataset.dragging === '1') return;
        const st = statesCache[sl.dataset.id];
        if (!st || st.status !== 'playing' || !st.startedAt) return;
        const max = Number(sl.max) || 0;
        const sec = Math.min(elapsedSec(st.startedAt), max);
        sl.value = sec;
        const timeEl = sl.parentElement.querySelector('.seek-time');
        if (timeEl) timeEl.textContent = `${fmtSec(sec)} / ${fmtSec(st.durationSec)}`;
      });
    }, 1000);
  }

  /** 根据服务端 audioStore.list() 渲染音频列表。 */
  function renderAudios(list) {
    audioList = list;
    audioCount.textContent = list.length
      ? bcT('broadcast.console.audioCount', '（{count}）', { count: list.length })
      : '';
    audioWrap.innerHTML = '';
    if (!list.length) {
      audioWrap.innerHTML = `
        <div class="empty-hint">
          <div class="icon">${renderIcon('music')}</div>
          <div><strong>${escapeHtml(bcT('broadcast.console.audioEmptyTitle', 'audio 目录为空'))}</strong></div>
          <div style="margin-top:6px;">${bcT('broadcast.console.audioEmptyHelp', '请把 mp3 文件放入 <code>audio/</code> 目录，然后点「重新扫描」。')}</div>
        </div>`;
      return;
    }
    for (const a of list) {
      const row = document.createElement('div');
      row.className = 'audio-item';
      const sizeKB = (a.size / 1024).toFixed(1);
      row.innerHTML = `
        <span class="icon">${renderIcon('music')}</span>
        <div class="audio-info">
          <div class="audio-name">${escapeHtml(a.name)}</div>
          <div class="audio-meta">${sizeKB} KB · ${new Date(a.mtime).toLocaleString()}</div>
        </div>
        <button class="btn btn-column2" data-play="${a.id}" data-name="${escapeHtml(a.name)}">
          ${escapeHtml(bcT('broadcast.console.play', '投放'))}
        </button>
      `;
      audioWrap.appendChild(row);
    }
  }

  /** 渲染投放弹窗里的频道选择。 */
  function renderChannelPick() {
    channelPick.innerHTML = '';
    for (const cfg of channelsCfg) {
      const item = document.createElement('div');
      item.className = 'channel-pick-item';
      item.dataset.id = cfg.id;
      item.innerHTML = `
        <div class="channel-icon" style="background:${cfg.color}">
          <img class="icon" src="${cfg.icon}" alt="${escapeHtml(channelLabel(cfg))}">
        </div>
        <p class="channel-name">${escapeHtml(channelLabel(cfg))}</p>
      `;
      item.addEventListener('click', () => {
        // 多选：点一次选中，再点一次取消选中
        if (pendingChannelIds.has(cfg.id)) {
          pendingChannelIds.delete(cfg.id);
          item.classList.remove('selected');
        } else {
          pendingChannelIds.add(cfg.id);
          item.classList.add('selected');
        }
        updateConfirmState();
      });
      channelPick.appendChild(item);
    }
  }

  /**
   * 根据当前选中的频道数量更新「投放」按钮的可用状态。
   * 文案恒为「投放」，不随选中数量变化；只是没选任何频道时置灰禁用。
   */
  function updateConfirmState() {
    modalConfirm.disabled = pendingChannelIds.size === 0;
    modalConfirm.textContent = bcT('broadcast.console.play', '投放');
  }

  // ========== 操作 ==========

  /** 打开投放弹窗。 */
  function openPlayModal(audioId, audioName) {
    pendingAudioId = audioId;
    pendingChannelIds = new Set();
    modal.classList.add('active');
    modalInfo.textContent = bcT('broadcast.console.modalInfo', '将投放：{name}。请选择目标频道（可多选）。', { name: audioName });
    channelPick.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    updateConfirmState();
  }

  function closePlayModal() {
    modal.classList.remove('active');
    pendingAudioId = null;
    pendingChannelIds = new Set();
  }

  /**
   * 执行投放：逐个 POST /api/channels/:id/play。
   * @param {string[]} channelIds 目标频道 id 列表（支持多个）
   * @returns {Promise<void>}
   */
  async function doPlay(channelIds) {
    // 成功投放的频道展示名，用于汇总 Toast
    const okNames = [];
    for (const channelId of channelIds) {
      const cfg = channelsCfg.find(c => c.id === channelId);
      try {
        await api(`/api/channels/${channelId}/play`, {
          method: 'POST',
          body: { audioId: pendingAudioId }
        });
        if (cfg) okNames.push(channelLabel(cfg));
      } catch (e) {
        // api() 已经 Toast 过具体错误，这里继续投下一个频道
      }
    }
    if (okNames.length === 1) {
      showToast(bcT('broadcast.console.toastPlayedOne', '已投放到「{name}」', { name: okNames[0] }), 'success');
    } else if (okNames.length > 1) {
      showToast(bcT('broadcast.console.toastPlayedMany', '已投放到 {count} 个频道：{names}', {
        count: okNames.length,
        names: okNames.join('、')
      }), 'success');
    }
    // 服务端已广播 snapshot，本地不用手动改
  }

  async function doAction(action, channelId) {
    try {
      await api(`/api/channels/${channelId}/${action}`, { method: 'POST' });
      const label = {
        pause: bcT('broadcast.status.paused', '已暂停'),
        resume: bcT('broadcast.toast.resumed', '继续播放'),
        stop: bcT('broadcast.toast.stopped', '已停止')
      }[action];
      showToast(label, 'success');
    } catch (e) { /* 已 Toast */ }
  }

  async function rescan() {
    try {
      const data = await api('/api/audio/rescan', { method: 'POST' });
      renderAudios(data.list);
      showToast(bcT('broadcast.console.toastRescan', '重新扫描完成：{count} 个音频', { count: data.list.length }), 'info');
    } catch (e) { /* 已 Toast */ }
  }

  // ========== 事件绑定 ==========

  // 音频列表「投放」按钮（事件委托）
  audioWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (!btn) return;
    openPlayModal(btn.dataset.play, btn.dataset.name);
  });

  // 频道卡片控制按钮（事件委托）
  gridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    doAction(btn.dataset.action, btn.dataset.id);
  });

  // ========== 进度滑条交互（事件委托到网格，SSE 重绘后依然有效） ==========

  // 拖动中：标记 + 实时刷新时间文字（此时定时器不回写滑条位置）
  gridEl.addEventListener('input', (e) => {
    const sl = e.target.closest('.seek-slider');
    if (!sl) return;
    sl.dataset.dragging = '1';
    const timeEl = sl.parentElement.querySelector('.seek-time');
    const st = statesCache[sl.dataset.id];
    if (timeEl) {
      const total = st && st.durationSec ? st.durationSec : 0;
      timeEl.textContent = `${fmtSec(Number(sl.value))} / ${fmtSec(total)}`;
    }
  });

  // 松手：POST seek → 服务端重算 startedAt 并广播 → 全部听众 seek 对齐，卡片重绘到新位置
  gridEl.addEventListener('change', (e) => {
    const sl = e.target.closest('.seek-slider');
    if (!sl) return;
    delete sl.dataset.dragging;
    api(`/api/channels/${sl.dataset.id}/seek`, {
      method: 'POST',
      body: { positionSec: Number(sl.value) }
    }).catch(() => {});   // api() 内部已 Toast 错误
  });

  // 弹窗
  modalCancel.addEventListener('click', closePlayModal);
  modalConfirm.addEventListener('click', async () => {
    if (!pendingAudioId || pendingChannelIds.size === 0) return;
    modalConfirm.disabled = true;
    await doPlay([...pendingChannelIds]);
    closePlayModal();
  });
  // 点击遮罩空白处关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePlayModal();
  });
  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closePlayModal();
  });

  rescanBtn.addEventListener('click', rescan);

  // ========== 视图生命周期（由路由器 app.js 调用） ==========

  /**
   * 初始化控制台视图：启动进度定时器、拉数据并建立 SSE 订阅。
   * @returns {Function} 销毁函数 teardown：关 SSE、清定时器、丢弃探测、收起弹窗
   */
  function init() {
    startProgressTimer();
    start();

    return function teardown() {
      if (es) { es.close(); es = null; }
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      // 丢弃进行中的时长探测
      durationProbes.forEach(p => { p.removeAttribute('src'); p.load(); });
      durationProbes.clear();
      // 若弹窗开着时切走，收起来避免盖在其他视图上
      modal.classList.remove('active');
    };
  }

  /** 同步一次并建立 SSE 订阅。 */
  async function start() {
    try {
      const [audio, channels] = await Promise.all([
        api('/api/audio'),
        api('/api/channels')
      ]);
      renderAudios(audio.list);
      renderChannels(channels);
      renderChannelPick();

      es = subscribe('/api/events', {
        open: () => {
          // 顶栏连接状态指示已按规范移除，元素不存在时跳过（仅独立收听页保留）
          if (!statusDot || !statusText) return;
          statusDot.classList.remove('connecting', 'disconnected');
          statusDot.classList.add('connected');
          statusText.textContent = bcT('broadcast.status.connected', '已连接');
        },
        close: () => {
          if (!statusDot || !statusText) return;    // 元素不存在时跳过
          statusDot.classList.remove('connecting', 'connected');
          statusDot.classList.add('disconnected');
          statusText.textContent = bcT('broadcast.status.disconnected', '已断开（自动重连中）');
        },
        snapshot: (allChannels) => renderChannels(allChannels)
      });
    } catch (e) {
      if (!statusDot || !statusText) return;        // 元素不存在时跳过
      statusDot.classList.add('disconnected');
      statusText.textContent = bcT('broadcast.status.connectFailed', '连接失败');
    }
  }

  return { init };
})();
