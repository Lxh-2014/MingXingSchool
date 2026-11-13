/**
 * JSON 文件存储层（转盘数据）
 * ---------------------------------------------------------------
 * 存储位置：
 *   wheel/{id}.json —— 每个转盘一个文件
 *   用户数据已统一收口到主项目 server/data/users.json，本模块不再管理用户。
 *
 * 设计原则：
 *   - 同步读写（Express 单进程，Node 同步 fs 足够快）
 *   - 原子写入（先写 .tmp 再 rename，避免崩溃损坏）
 */
const fs = require('fs');
const path = require('path');

/** 转盘分文件存储目录（项目根目录下的 wheel 文件夹） */
const WHEELS_DIR = path.join(__dirname, '..', '..', 'wheel');
/** 锁文件路径 */
const LOCK_FILE = path.join(__dirname, '.store.lock');

// 确保转盘目录存在
if (!fs.existsSync(WHEELS_DIR)) fs.mkdirSync(WHEELS_DIR, { recursive: true });

/**
 * 安全读取 JSON 文件
 * @param {string} file 文件绝对路径
 * @returns {Record<string, any>} 解析后的对象；文件不存在或损坏则返回空对象并重置文件
 */
function loadJSON(file) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch (err) {
    console.error(`[store] 读取 ${path.basename(file)} 失败，已重置为空：`, err.message);
    fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
    return {};
  }
}

/**
 * 原子写入 JSON（先写 .tmp，再 rename 覆盖）
 * @param {string} file 目标文件
 * @param {Record<string, any>} data 要写入的对象
 */
function saveJSON(file, data) {
  const tmp = file + '.tmp';
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file); // Windows 上 renameSync 覆盖同一目录文件是安全的
}

// ============ Wheels API（分文件存储：wheel/{id}.json） ============

/** 转盘文件路径 */
function wheelFile(id) { return path.join(WHEELS_DIR, `${id}.json`); }

/**
 * 读取所有转盘（遍历 wheel 目录下所有 .json 文件）
 * @returns {Record<string, any>} { [id]: wheelData }
 */
function loadWheels() {
  const all = {};
  if (!fs.existsSync(WHEELS_DIR)) return all;
  const files = fs.readdirSync(WHEELS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const id = file.slice(0, -5); // 去掉 .json 后缀
    try {
      const text = fs.readFileSync(path.join(WHEELS_DIR, file), 'utf8');
      if (!text.trim()) continue;
      all[id] = JSON.parse(text);
    } catch (err) {
      console.error(`[store] 读取转盘文件 ${file} 失败，已跳过：`, err.message);
    }
  }
  return all;
}

/** 根据 ID 查找转盘 */
function findWheelById(id) {
  const file = wheelFile(id);
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    return { id, ...JSON.parse(text) };
  } catch (err) {
    console.error(`[store] 读取转盘 ${id} 失败：`, err.message);
    return null;
  }
}

/**
 * 用户改 ID 后迁移转盘归属（user_id 字段整体替换）
 * @param {string} oldId 旧用户 id
 * @param {string} newId 新用户 id
 * @returns {number} 迁移的转盘数量
 */
function reassignOwner(oldId, newId) {
  let count = 0;
  for (const [wid, w] of Object.entries(loadWheels())) {
    if (w.user_id === oldId) {
      saveWheel(wid, { user_id: newId });
      count++;
    }
  }
  return count;
}

/** 保存/更新转盘（写入 wheel/{id}.json） */
function saveWheel(id, wheel) {
  const file = wheelFile(id);
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  const merged = { ...existing, ...wheel };
  saveJSON(file, merged);
  return { id, ...merged };
}

/** 批量写入转盘（接收 { [id]: wheel } 对象，逐文件写入） */
function saveAllWheels(wheelsObj) {
  for (const id in wheelsObj) {
    saveJSON(wheelFile(id), wheelsObj[id]);
  }
}

/** 删除转盘（删除 wheel/{id}.json） */
function deleteWheel(id) {
  const file = wheelFile(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** 列出转盘（按创建时间降序，支持按 user_id / is_private 过滤） */
function listWheels({ userId, admin } = {}) {
  const all = loadWheels();
  const list = Object.entries(all).map(([id, w]) => ({ id, ...w }));
  let filtered = list;
  if (!admin) {
    filtered = filtered.filter(w => !w.is_private || w.user_id === userId);
  }
  filtered.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return filtered;
}

module.exports = {
  // Wheels
  loadWheels, findWheelById, saveWheel, saveAllWheels, deleteWheel, listWheels,
  // 用户改 ID 后迁移转盘归属
  reassignOwner,
  // 底层
  saveJSON, WHEELS_DIR,
};
