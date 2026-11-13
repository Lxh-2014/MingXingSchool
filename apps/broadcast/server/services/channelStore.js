/**
 * channelStore —— 四个频道的运行时状态（内存 Map，不持久化）。
 * 状态对象形状：
 *   { id, name, iconKey, icon, color, status: 'idle'|'playing'|'paused',
 *     audioId, audioName, audioFile, durationSec, seq, startedAt, updatedAt, listeners }
 *
 * durationSec 由客户端在 loadedmetadata 后 POST 回写，这样新加入听众
 * 不解锁也能显示进度百分比。服务端启动时不预先算（避免引入 ffprobe）。
 */
const { CHANNELS } = require('../config/channels');

// Map<channelId, stateObject>
const states = new Map();

/**
 * 深拷贝频道配置为状态对象，启动时一次性初始化四个固定频道。
 */
function init() {
  for (const ch of CHANNELS) {
    states.set(ch.id, {
      id: ch.id,
      name: ch.name,
      iconKey: ch.icon,          // 字段名保持兼容，值是 SVG 文件名
      icon: ch.icon,             // 直接引用 .svg 文件（client/ 下）
      color: ch.color,
      status: 'idle',
      audioId: null,
      audioName: null,
      audioFile: null,          // 中途加入时组装 audio src 用
      durationSec: null,          // 音频总时长（秒），客户端上报
      seq: 0,
      startedAt: null,
      updatedAt: null,
      listeners: 0
    });
  }
}

/**
 * 返回所有频道状态快照（不含 listeners 的精确同步——listeners 由 sseHub 维护并叠加）。
 * @returns {Array<object>}
 */
function snapshotAll() {
  return Array.from(states.values());
}

/**
 * 单个频道快照（不含 listeners）。
 * @param {string} channelId
 * @returns {object|null}
 */
function snapshot(channelId) {
  return states.get(channelId) || null;
}

/**
 * 更新 listeners 计数（+1 或 -1）。由 sseHub 在 attach/close 时调用。
 * @param {string} channelId
 * @param {number} delta +1 / -1
 */
function addListener(channelId, delta) {
  const s = states.get(channelId);
  if (!s) return;
  s.listeners = Math.max(0, (s.listeners || 0) + delta);
}

/**
 * 内部通用动作：改状态 + 条件递增 seq + 更新 updatedAt，返回 {nextSeq, changed}。
 * @param {string} channelId
 * @param {function} mutator 接收 state，返回 {targetStatus, needSeqBump, extraPatch}
 */
function apply(channelId, mutator) {
  const s = states.get(channelId);
  if (!s) return { state: null, changed: false, nextSeq: null };
  const { targetStatus, needSeqBump, extraPatch } = mutator(s);
  const changed = s.status !== targetStatus || needSeqBump;
  if (changed) {
    s.status = targetStatus;
    if (needSeqBump) s.seq += 1;
    s.updatedAt = Date.now();
    Object.assign(s, extraPatch || {});
  }
  return { state: s, changed, nextSeq: s.seq };
}

/**
 * 投放音频并从头播放。
 * seq 规则：无论状态如何都 +1（让听众重新从头播）。
 * durationSec 在客户端后续 loadedmetadata 后通过 reportDuration 上报，
 * play 时先重置为 null 等下一次投放时再重新上报（避免残留旧时长）。
 */
function play(channelId, audio) {
  return apply(channelId, (s) => ({
    targetStatus: 'playing',
    needSeqBump: true,
    extraPatch: {
      audioId: audio.id,
      audioName: audio.name,
      audioFile: audio.file,
      durationSec: null,          // 重置 —— 让新音频的听众重新上报
      startedAt: Date.now()
    }
  }));
}

/**
 * 客户端上报音频总时长 —— 只写 durationSec，不 bump seq
 * （时长对所有听众一样，后续 SSE 快照会自动带到）。
 * @param {string} channelId
 * @param {number} durationSec
 */
function reportDuration(channelId, durationSec) {
  const s = states.get(channelId);
  if (!s || s.status !== 'playing') return null;
  if (typeof durationSec !== 'number' || !isFinite(durationSec) || durationSec <= 0) return null;
  if (s.durationSec === durationSec) return null;   // 相同不浪费广播
  s.durationSec = durationSec;
  s.updatedAt = Date.now();
  return s;
}

/**
 * 操作台拖动进度条跳转：把 startedAt 重算为「现在 - 目标位置秒数」。
 * 收听页收到新快照后按 startedAt 重新 seek 对齐，实现全房间一起跳进度。
 * 只在 playing 状态有效；返回更新后的状态，无效返回 null。
 * @param {string} channelId
 * @param {number} positionSec 目标位置（秒），从 0 开始
 */
function seek(channelId, positionSec) {
  const s = states.get(channelId);
  if (!s || s.status !== 'playing') return null;
  if (typeof positionSec !== 'number' || !isFinite(positionSec) || positionSec < 0) return null;
  // 超过总时长按"播完"处理不了，直接钳制到末尾前一秒，避免听众 seek 后立即 ended
  const maxPos = (s.durationSec && s.durationSec > 0) ? Math.max(0, s.durationSec - 1) : null;
  if (maxPos !== null) positionSec = Math.min(positionSec, maxPos);
  s.startedAt = Date.now() - Math.floor(positionSec * 1000);
  s.seq += 1;                       // 状态实质变化，递增 seq
  s.updatedAt = Date.now();
  return s;
}

/**
 * 暂停（幂等）。
 */
function pause(channelId) {
  return apply(channelId, (s) => ({
    targetStatus: s.status === 'playing' ? 'paused' : s.status,
    needSeqBump: s.status === 'playing',
    extraPatch: {}
  }));
}

/**
 * 继续播放（幂等）。idle 状态下 resume 无意义，返回 {changed:false}。
 */
function resume(channelId) {
  return apply(channelId, (s) => ({
    targetStatus: s.status === 'paused' ? 'playing' : s.status,
    needSeqBump: s.status === 'paused',
    extraPatch: { startedAt: Date.now() }
  }));
}

/**
 * 停止（幂等）。
 */
function stop(channelId) {
  return apply(channelId, (s) => ({
    targetStatus: 'idle',
    needSeqBump: s.status !== 'idle',
    extraPatch: { audioId: null, audioName: null, audioFile: null, durationSec: null, startedAt: null }
  }));
}

init(); // 模块加载时立即初始化

module.exports = {
  init, snapshotAll, snapshot, addListener,
  play, pause, resume, stop, reportDuration, seek
};
