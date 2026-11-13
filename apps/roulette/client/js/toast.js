/**
 * Toast 提示（右上角、从右侧滑入）
 * 参考：UI设计规范.md / 提示.html
 *   初始态：opacity:0 + translateX(100%)
 *   显示态：双层 requestAnimationFrame 后追加 .show 类触发过渡
 *   自动消失：3000ms 后移除 .show，再等 300ms 过渡结束再删 DOM
 */
const Toast = (function () {
  function ensureContainer() {
    let c = document.querySelector('.toast-container');
    if (!c) {
      c = document.createElement('div');
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  function show(msg, type = 'info', duration = 3000) {
    const container = ensureContainer();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);

    // 强制重排，确保隐藏初始态已被浏览器应用
    toast.offsetHeight;
    // 双层 rAF 后再添加 .show，触发过渡
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('show'));
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return {
    success: (m) => show(m, 'success'),
    error:   (m) => show(m, 'error'),
    warning: (m) => show(m, 'warning'),
    info:    (m) => show(m, 'info'),
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Toast;
window.Toast = Toast;
