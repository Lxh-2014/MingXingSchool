/*
 * 图标精灵 —— 把所有用到的 SVG 一次性定义在这个文件里，
 * 避免把几十个独立 svg 文件搬进 client/assets/icons/。
 * 每个函数返回 viewBox="0 0 24 24" 的 <path> 集合，外部套一层
 * <span class="icon"><svg viewBox="0 0 24 24">{}</svg></span> 即可。
 * 颜色继承父元素的 currentColor。
 */
const ICONS = {
  // —— 播放控制 ——
  play:    '<path d="M8 5v14l11-7z"/>',
  pause:   '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>',
  stop:    '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  volume:  '<path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>',
  music:   '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>',
  wave:    '<path d="M5 12h2m2 0h2m2 0h2m2 0h2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="6" cy="12" r="1.4"/><circle cx="10" cy="12" r="1.4"/><circle cx="14" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  megaphone:'<path d="M3 9v6h4l6 4V5L7 9H3zm13 0a3 3 0 0 1 0 6v3a6 6 0 0 0 0-12v3z"/>',
  // —— 频道 ——
  playground:'<path d="M3 19h18v2H3zM14 8l-1 4h2l-4 7-1-4H8l4-7h2zM5 8h2v3H5zm12 0h2v3h-2z"/>',
  classroom: '<path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm2 4h10v2H7zm0 4h10v2H7zM9 16h6v2H9z"/>',
  canteen:   '<path d="M6 3h2a2 2 0 0 1 2 2v5a3 3 0 0 1-3 3v5H5v-5a3 3 0 0 1-1-2V5a2 2 0 0 1 2-2zm8 6a3 3 0 0 1 3 3v8h2V8h-3V5a2 2 0 0 0-4 0v3h-2V8h4v1z"/>',
  magic:     '<path d="M18 3l-2 2 3 3 2-2-3-3zm-1.4 1.4L4 17v3h3L20.4 7.6l-3.8-3.2zM5 21h1v-1H5v1z"/>',
  // —— 功能 ——
  sun:      '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-3v2m0 12v2m5-5h2m-14 0h2m9.9-7.9l1.4-1.4M5.7 18.3l1.4-1.4m0-9.8L5.7 5.7m10.6 10.6l-1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  moon:     '<path d="M20 14A8 8 0 1 1 10 4a7 7 0 0 0 10 10z"/>',
  close:    '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  refresh:  '<path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L15 9h5V4l-2 2.3z" fill-rule="evenodd"/>',
  broadcast:'<path d="M12 4l2 4h4l-3 2 1 4-4-2-4 2 1-4-3-2h4l2-4zm-6 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  // —— 其它 ——
  link:     '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  star:     '<path d="M12 2l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z"/>'
};

/**
 * 把命名 icon 变成可直接放进 innerHTML 的 svg 片段。
 * @param {string} name ICONS 里的键
 * @returns {string} <svg>...</svg> 字符串，外部用 <span class="icon"> 包裹
 */
function renderIcon(name) {
  const inner = ICONS[name] || ICONS.star;
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

// 全局挂到 window.ICONS / window.renderIcon，common.js 和各页面脚本都能直接用
window.ICONS = ICONS;
window.renderIcon = renderIcon;
