/**
 * audioStore —— 扫描 audio/ 目录，对外提供音频列表与单曲查询。
 * 磁盘是唯一真相；每次请求都 readdir + stat，省去 mtime 缓存复杂度
 * （目录里通常只有几十到几百 mp3，同步读取代价可忽略）。
 *
 * id 生成策略：取 "文件名（去扩展名）+ mtime 毫秒" 的短哈希
 * （Node 内置 crypto.createHash('md5').digest('hex').slice(0, 8)），
 * 避免同目录下同名但不同内容的文件撞 key。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_DIR = path.resolve(__dirname, '..', '..', 'audio');

/**
 * 启动时确保 audio/ 目录存在，不存在则创建空目录。
 */
function ensureDir() {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

/**
 * 生成稳定的音频 id。
 * @param {string} name 文件名（含扩展名）
 * @param {number} mtimeMs 最后修改时间（毫秒）
 * @returns {string} 8 字符十六进制短哈希
 */
function makeId(name, mtimeMs) {
  const src = `${name}|${mtimeMs}`;
  return crypto.createHash('md5').update(src).digest('hex').slice(0, 8);
}

/**
 * 返回 audio/ 目录下所有可识别音频文件。
 * 支持 mp3 / wav / ogg / m4a / flac / wma（大小写不敏感）。
 * @returns {Array<{id,name,file,size,mtime}>}
 */
function list() {
  ensureDir();
  const accepted = /\.(mp3|wav|ogg|m4a|flac|wma)$/i;
  let entries;
  try {
    entries = fs.readdirSync(AUDIO_DIR);
  } catch (e) {
    return [];
  }
  const items = [];
  for (const name of entries) {
    if (!accepted.test(name)) continue;
    const full = path.join(AUDIO_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    if (!stat.isFile()) continue;
    items.push({
      id: makeId(name, stat.mtimeMs),
      name: path.basename(name, path.extname(name)), // 去除扩展名的显示名
      file: name,                                     // 保留原始文件名供静态托管
      size: stat.size,
      mtime: stat.mtimeMs
    });
  }
  // 按 mtime 倒序：最近放入的排在最前
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

/**
 * 按 id 查找单条音频。
 * @param {string} id 音频 id
 * @returns {object|null} 音频对象或 null
 */
function find(id) {
  return list().find(a => a.id === id) || null;
}

module.exports = { AUDIO_DIR, ensureDir, list, find };
