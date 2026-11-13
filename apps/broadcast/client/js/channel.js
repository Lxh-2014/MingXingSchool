/*
 * channel.js —— 频道收听视图（ChannelView，含 autoplay 解锁三层兜底）。
 *
 * 只定义不执行：路由器 app.js 切到收听视图时调 init(频道名)，返回销毁函数 teardown。
 *
 * 启动流程：
 *   1) init(频道名) → 校验合法 → 渲染大卡片标题
 *   2) 订阅 /api/channels/:id/events SSE；连上即推 snapshot，客户端按状态决定要不要播
 *   3) 首次点击（解锁遮罩）在 <audio> 上做静音预热：
 *        muted=true → play() → pause() → muted=false
 *      —— 播放许可绑定在该元素上，后续可静默 play()；切视图不丢失（audio 是全局元素）
 *   4) 收到 command.play：设 src 即从头播 → play()
 *      被 NotAllowedError 拒 → 置 blocked + 显示常驻浮层 + 存 pending 指令
 *      用户再点浮层 → 从 pending 重播（仍是"从头播"语义）
 *   5) visibilitychange 回到可见时立即补 play()
 *
 * seq 规则：服务端递增，客户端按 lastSeq 丢弃过期/重复指令。
 */

window.ChannelView = (function(){
  // renderIcon 来自 icons.js（挂 window），其他工具来自 App
  const { api, subscribe, showToast, escapeHtml } = window.App;
  const { renderIcon } = window;

  /**
   * 取多语言文案：i18n 框架未加载时回退中文兜底
   * @param {string} key 语言包键（如 broadcast.channel.back）
   * @param {string} fallback 中文兜底文案
   * @param {object} [params] 占位参数（如 {name: '张三'}）
   * @returns {string} 展示文案
   */
  function bcT(key, fallback, params) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : fallback;
  }

  /**
   * 频道 id → 界面展示名的语言包键映射（频道 id / URL 里的频道名属于数据键，不翻译）
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

  // —— 取 DOM（元素在主壳里，跟随视图切换常驻） ——
  const audioEl = document.getElementById('audio');
  const unlockOverlay = document.getElementById('unlock-overlay');
  const blockedFloat = document.getElementById('blocked-float');
  const blockedBtn = document.getElementById('blocked-btn');
  const cardIcon = document.getElementById('card-icon');
  const cardName = document.getElementById('card-name');
  const cardBadge = document.getElementById('card-badge');
  const cardNow = document.getElementById('card-now');
  const cardHint = document.getElementById('card-hint');
  const playerUI = document.getElementById('player-ui');
  const playerIcon = document.getElementById('player-icon');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const unlockIcon = document.getElementById('unlock-icon');
  const blockedIcon = document.getElementById('blocked-icon');

  /** 路径前缀：挂载到明星学校 /broadcast，音频 src 需要拼上 */
  const BASE = '/broadcast';

  const CHANNELS_FRONT = [
    { id: 'playground', name: '操场',     icon: '操场.svg',     color: '#3CB371' },
    { id: 'classroom',  name: '教室',     icon: '教室.svg',     color: '#1CB0F6' },
    { id: 'canteen',    name: '食堂',     icon: '食堂.svg',     color: '#FF7BAC' },
    { id: 'magic',      name: '魔法教室', icon: '魔法教室.svg', color: '#9B59B6' }
  ];

  // —— 运行时状态（每次 init 重置） ——
  /** 当前频道的配置 */
  let cfg = null;
  /** 是否已完成首次手势解锁（许可绑定在全局 <audio> 元素上，切视图不丢失） */
  let unlocked = false;
  /** 浏览器当前是否阻止了自动播放 */
  let blocked = false;
  /** 最后处理的指令 seq，丢弃过期/重复 */
  let lastSeq = 0;
  /** 被拦截时暂存的最新 play 指令 */
  let pendingCommand = null;
  /** 最后一次 snapshot 里的频道状态（解锁后可从中拿 url 重设 src） */
  let lastSnapshot = null;
  /** SSE 连接句柄，teardown 时关闭 */
  let es = null;
  /** 提示行每秒刷新定时器，teardown 时清除 */
  let hintTimer = null;
  /** 本视图全部事件监听的统一中止器，teardown 时一次性解除 */
  let listenerAbort = null;

  // ========== 渲染 ==========

  function renderCard() {
    if (!cfg) {
      cardName.textContent = bcT('broadcast.channel.unknown', '未知频道');
      cardHint.textContent = bcT('broadcast.channel.invalidHint', '请从侧边栏进入合法频道：{list}', {
        list: CHANNELS_FRONT.map(c => channelLabel(c)).join('、')
      });
      cardIcon.style.background = '#888';
      cardIcon.innerHTML = renderIcon('star');
      unlockOverlay.classList.add('hidden');
      return;
    }
    cardIcon.style.background = cfg.color;
    cardIcon.innerHTML = `<img class="icon" src="${cfg.icon}" alt="${escapeHtml(channelLabel(cfg))}">`;
    cardName.textContent = channelLabel(cfg);
    if (unlockIcon) unlockIcon.innerHTML = renderIcon('megaphone');
    if (playerIcon) playerIcon.innerHTML = renderIcon('volume');
  }

  /** 根据频道状态更新卡片徽章 / 当前音频 / 动画 / 提示行。 */
  function renderState(s) {
    if (!s) return;
    cardBadge.className = `badge ${s.status} status-badge`;
    cardBadge.textContent = {
      idle: bcT('broadcast.status.idle', '空闲'),
      playing: bcT('broadcast.status.playing', '播放中'),
      paused: bcT('broadcast.status.paused', '已暂停')
    }[s.status] || s.status;
    // 音乐名称 —— 每次都重新渲染，防止"切换后没刷新"（哪怕是同一音频重投）
    if (s.audioName) cardNow.textContent = escapeHtml(s.audioName);
    else cardNow.textContent = bcT('broadcast.channel.waiting', '等待投放…');
    updateHint(s);
    playerUI.classList.toggle('playing', s.status === 'playing');
  }

  /** 提示行 —— 有总时长就显示 "已播 / 总时长"，否则只显示已播。 */
  function updateHint(s) {
    if (!s) return;
    if (s.status === 'playing') {
      const seekSec = calcSeekSec(s);
      cardHint.textContent = playingHintText(seekSec, s.durationSec);
    } else if (s.status === 'paused') {
      cardHint.textContent = bcT('broadcast.channel.hintPaused', '已暂停 · 点击继续收听');
    } else {
      cardHint.textContent = bcT('broadcast.channel.hintIdle', '收听该频道，接收控制台投放的音频');
    }
  }

  /**
   * 生成"播放进度"提示文案（有总时长时显示 "已播 / 总时长"）
   * @param {number} sec 已播放秒数
   * @param {number} [dur] 总时长秒数，0 或空表示未知
   * @returns {string} 提示文案
   */
  function playingHintText(sec, dur) {
    if (dur && dur > 0) {
      return bcT('broadcast.channel.hintPlayingTotal', '已播放 {time} / {total} · 由控制台投放', {
        time: formatSec(sec),
        total: formatSec(dur)
      });
    }
    return bcT('broadcast.channel.hintPlaying', '已播放 {time} · 由控制台投放', { time: formatSec(sec) });
  }

  /**
   * 把秒数格式化成 mm:ss（方便在提示行里显示）。
   */
  function formatSec(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  /** 用 channelStore 里的 audioFile 字段组装 src。 */
  function buildUrl(s) {
    if (!s || !s.audioFile) return null;
    return BASE + '/audio/' + encodeURIComponent(s.audioFile);
  }

  // ========== 播放核心 ==========

  async function tryPlay() {
    if (!audioEl.src) return;
    try {
      await audioEl.play();
      setBlocked(false);
    } catch (e) {
      setBlocked(true);
      showToast(bcT('broadcast.toast.autoplayBlocked', '浏览器阻止了自动播放，请点击页面继续'), 'warning');
    }
  }

  function setBlocked(b) {
    blocked = b;
    blockedFloat.classList.toggle('hidden', !b);
  }

  function stopAudio() {
    try { audioEl.pause(); audioEl.currentTime = 0; } catch (e) {}
    audioEl.removeAttribute('src');
    audioEl.load();
  }

  function pauseAudio() { try { audioEl.pause(); } catch (e) {} }
  function resumeAudio() { tryPlay(); }

  // ========== SSE 事件处理 ==========

  function handleCommand(cmd) {
    if (!cmd || typeof cmd.seq !== 'number') return;
    if (cmd.seq <= lastSeq) return;
    lastSeq = cmd.seq;

    switch (cmd.action) {
      case 'play':
        // 重设 src = 从头播（cmd.url 形如 /audio/xxx，拼挂载前缀）
        audioEl.src = BASE + cmd.url;
        audioEl.muted = false;
        audioEl.load();
        setBlocked(false);
        tryPlay();
        break;
      case 'pause':
        pauseAudio();
        break;
      case 'resume':
        resumeAudio();
        break;
      case 'stop':
        stopAudio();
        setBlocked(false);
        break;
    }
  }

  function handleSnapshot(s) {
    let mine = s;
    if (Array.isArray(s)) mine = s.find(x => x.id === (cfg && cfg.id));
    if (!mine || !cfg || mine.id !== cfg.id) return;

    lastSnapshot = mine;
    renderState(mine);
    const url = buildUrl(mine);
    if (mine.status === 'playing') {
      if (!unlocked) {
        // 还没解锁 —— 存 pending，等用户点击
        if (url) pendingCommand = { action: 'play', url, seq: mine.seq };
      } else if (url) {
        // "切换时重新调取"的核心：不管 src 变没变，只要收到新 playing 快照（seq 变了），
        // 就按服务端 startedAt 重算 seek，强制对齐一次，然后 play。
        const seekSec = calcSeekSec(mine);
        if (audioEl.src !== location.origin + url) {
          // 真的换了音频 → 重新 load + seek
          audioEl.src = url;
          audioEl.muted = false;
          audioEl.load();
          if (seekSec > 0) {
            audioEl.addEventListener('loadedmetadata', function onMeta() {
              try { audioEl.currentTime = seekSec; } catch (e) {}
              audioEl.removeEventListener('loadedmetadata', onMeta);
              tryPlay();
            }, { once: true });
          } else {
            tryPlay();
          }
        } else {
          // 同一音频但收到新快照 → 重新 seek 对齐一次（解决客户端/服务端时钟漂移）
          if (seekSec > 0) {
            try { audioEl.currentTime = seekSec; } catch (e) {}
          }
          if (audioEl.paused) tryPlay();
        }
      }
    } else if (mine.status === 'idle') {
      stopAudio();
    } else if (mine.status === 'paused') {
      if (url && audioEl.src !== location.origin + url) {
        audioEl.src = url;
        audioEl.load();
      }
      pauseAudio();
    }
  }

  /**
   * 根据服务端 startedAt 计算"已播放多少秒"。
   * 用于新加入或网络抖动后重新对齐进度。
   * @param {object} mine - 频道状态对象，需含 startedAt
   * @returns {number} 已播放秒数（向下取整）
   */
  function calcSeekSec(mine) {
    if (!mine.startedAt) return 0;
    const elapsed = Date.now() - mine.startedAt;
    if (elapsed <= 0) return 0;
    return Math.floor(elapsed / 1000);
  }

  // ========== 首次解锁 ==========

  /**
   * 解锁流程：
   *  1) 先把 src 设好 + 算出要 seek 到的秒数（从 startedAt 倒推）
   *  2) muted=true 预热 play → pause（currentTime 暂存）
   *  3) muted=false，正式加载
   *  4) loadedmetadata 后 seek 到位 → tryPlay
   */
  async function doUnlock() {
    unlockOverlay.classList.add('hidden');

    // ① 预先把 url 准备好，并算出 seek 目标秒数
    const cmdToPlay = pendingCommand;
    const snapToPlay = lastSnapshot && lastSnapshot.status === 'playing' ? lastSnapshot : null;
    let targetUrl = null;
    if (cmdToPlay && cmdToPlay.url) targetUrl = cmdToPlay.url;
    else if (snapToPlay) targetUrl = buildUrl(snapToPlay);
    // 要 seek 到的已播放秒数（从服务端 startedAt 倒推）
    const seekSec = snapToPlay ? calcSeekSec(snapToPlay) : 0;

    if (targetUrl) {
      audioEl.src = targetUrl;
      audioEl.muted = true;
      audioEl.load();
    } else {
      audioEl.muted = true;
    }

    try {
      // ② 静音预热 —— 绑定播放许可到这个 <audio> 元素
      await audioEl.play();
      audioEl.pause();
      audioEl.muted = false;
      unlocked = true;
      try { sessionStorage.setItem('broadcaster_unlocked_' + cfg.id, '1'); } catch (e) {}

      // ③ 正式加载 + seek 到位 + play
      if (targetUrl) {
        audioEl.load();
        if (seekSec > 0) {
          await new Promise((resolve) => {
            function onMeta() {
              try { audioEl.currentTime = seekSec; } catch (e) {}
              audioEl.removeEventListener('loadedmetadata', onMeta);
              resolve();
            }
            audioEl.addEventListener('loadedmetadata', onMeta, { once: true });
            // 兜底：元数据加载不到时给个超时
            setTimeout(resolve, 3000);
          });
        }
        await tryPlay();
      } else if (blocked) {
        setBlocked(false);
        tryPlay();
      } else if (audioEl.src && audioEl.paused) {
        tryPlay();
      }

      if (cmdToPlay) pendingCommand = null;
    } catch (e) {
      audioEl.muted = false;
      showToast(bcT('broadcast.toast.playRejected', '浏览器策略拒绝了播放，请刷新页面重试'), 'error');
    }
  }

  // ========== 视图生命周期（由路由器 app.js 调用） ==========

  /**
   * 初始化收听视图：渲染卡片、绑定事件、订阅该频道的 SSE。
   * @param {string} name 频道中文名或 id（来自 URL /channel/:name）
   * @returns {Function} 销毁函数 teardown：关 SSE、清定时器、解除全部监听。
   *          注意：不清 stop 音频 —— 全局 <audio> 继续播，切回视图免解锁
   */
  function init(name) {
    // —— 重置运行时状态 ——
    cfg = CHANNELS_FRONT.find(c => c.name === name || c.id === name);
    unlocked = false;
    blocked = false;
    lastSeq = 0;
    pendingCommand = null;
    lastSnapshot = null;
    listenerAbort = new AbortController();
    const { signal } = listenerAbort;

    renderCard();
    if (!cfg) {
      if (statusText) statusText.textContent = bcT('broadcast.status.notFound', '频道不存在');   // 控制台内嵌视图无状态元素，判空
      return function teardown() {};
    }

    // 会话内已解锁过（同一 tab 生命周期内用户点过，<audio> 元素被复用，许可仍有效）
    // 但需要做一次实际 play() 才能验证许可未失效（chrome 跨 tab 会保留，刷新可能不保留）
    try { unlocked = sessionStorage.getItem('broadcaster_unlocked_' + cfg.id) === '1'; } catch (e) {}

    if (unlocked) {
      // 已解锁 → 直接隐藏遮罩，收到指令就真的去 play()（被拒了才显浮层）
      unlockOverlay.classList.add('hidden');
    } else {
      unlockOverlay.classList.remove('hidden');
    }

    // —— 事件绑定（都带 signal，teardown 一次性解除，防止切视图后重复叠加） ——
    unlockOverlay.addEventListener('click', doUnlock, { signal });
    blockedBtn.addEventListener('click', () => {
      if (!unlocked) return doUnlock();
      tryPlay();
    }, { signal });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && unlocked && audioEl.src) tryPlay();
    }, { signal });
    audioEl.addEventListener('error', () => {
      showToast(bcT('broadcast.toast.audioLoadFailed', '音频加载失败，可能文件已被删除'), 'error');
      stopAudio();
      setBlocked(false);
    }, { signal });
    // 播完自动 → 通知服务端 stop，让所有听众一起回到 idle
    audioEl.addEventListener('ended', async () => {
      try {
        await api(`/api/channels/${cfg.id}/stop`, { method: 'POST' });
      } catch (e) {
        // api() 已 Toast，静默即可
      }
    }, { signal });
    // loadedmetadata → 把时长上报给服务端，让其他新加入听众也能看到 "已播 / 总时长"
    // 只在服务端还没记录或差距明显时上报（减少 SSE 广播）
    audioEl.addEventListener('loadedmetadata', () => {
      const dur = audioEl.duration;
      if (!dur || !isFinite(dur) || dur <= 0) return;
      if (!lastSnapshot || lastSnapshot.status !== 'playing') return;
      if (lastSnapshot.durationSec && Math.abs(lastSnapshot.durationSec - dur) < 0.5) return; // 已经对上了
      api(`/api/channels/${cfg.id}/duration`, {
        method: 'POST',
        body: { durationSec: Math.round(dur * 10) / 10 }
      }).catch(() => {});
    }, { signal });

    // 每秒刷新一次提示行的已播进度（SSE 只在状态变化时推，进度要本地滚）
    if (hintTimer) clearInterval(hintTimer);
    hintTimer = setInterval(() => {
      if (lastSnapshot && lastSnapshot.status === 'playing') updateHint(lastSnapshot);
    }, 1000);

    // —— 订阅该频道 SSE ——
    es = subscribe(`/api/channels/${cfg.id}/events`, {
      open: () => {
        if (!statusDot || !statusText) return;    // 控制台内嵌视图无状态元素，判空（独立收听页保留）
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
      snapshot: handleSnapshot,
      command: (cmd) => {
        if (cmd.action === 'play' && !unlocked) {
          // 未解锁先暂存；url 是服务端发的 /audio/xxx，这里拼上挂载前缀，
          // 解锁后 doUnlock 直接用它设 audioEl.src
          pendingCommand = { ...cmd, url: cmd.url ? BASE + cmd.url : cmd.url };
          showToast(bcT('broadcast.toast.newAudioUnlock', '有新投放的音频，点击解锁收听'), 'info');
          return;
        }
        handleCommand(cmd);
      },
      error: (payload) => {
        showToast(payload.message || bcT('broadcast.toast.channelError', '频道发生错误'), 'error');
      }
    });

    return teardown;
  }

  /** 销毁收听视图：停订阅/定时器/监听，隐藏收听页专属浮层，但不停止播放（全局 audio 继续播）。 */
  function teardown() {
    if (es) { es.close(); es = null; }
    if (hintTimer) { clearInterval(hintTimer); hintTimer = null; }
    if (listenerAbort) { listenerAbort.abort(); listenerAbort = null; }
    // 收听页专属浮层不能带到控制台视图（SPA 共用一个壳）
    unlockOverlay.classList.add('hidden');
    blockedFloat.classList.add('hidden');
  }

  return { init };
})();
