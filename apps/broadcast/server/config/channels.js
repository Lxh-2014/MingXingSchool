/**
 * 固定四个频道配置。
 * 写死在服务端，不向用户开放增删改。
 * id 为英文 key（SSE 订阅、REST 路由用），name 为中文显示名。
 * color 用于前端卡片主题色（不随 dark-mode 变化）。
 * icon 是前端 SVG 图标的文件名（放在 client/ 根目录下，由 express static 直接暴露）。
 */
const CHANNELS = [
  { id: 'playground', name: '操场',     icon: '/操场.svg',     color: '#3CB371' },
  { id: 'classroom',  name: '教室',     icon: '/教室.svg',     color: '#1CB0F6' },
  { id: 'canteen',    name: '食堂',     icon: '/食堂.svg',     color: '#FF7BAC' },
  { id: 'magic',      name: '魔法教室', icon: '/魔法教室.svg', color: '#9B59B6' }
];

// id <-> name 双向映射，方便路由同时接受英文 id 和中文 URL 编码名
const byId = Object.fromEntries(CHANNELS.map(c => [c.id, c]));
const byName = Object.fromEntries(CHANNELS.map(c => [c.name, c]));

/**
 * 根据路由参数查找频道对象。
 * 路由参数可能是英文 id（playground）或 URL 编码的中文（%E6%95%99%E5%AE%A4）。
 * @param {string} key - 路由传入的频道标识
 * @returns {object|null} 频道配置对象或 null
 */
function resolve(key) {
  if (!key) return null;
  if (byId[key]) return byId[key];
  const decoded = decodeURIComponent(key);
  if (byId[decoded]) return byId[decoded];
  if (byName[decoded]) return byName[decoded];
  if (byName[key]) return byName[key];
  return null;
}

module.exports = { CHANNELS, byId, byName, resolve };
