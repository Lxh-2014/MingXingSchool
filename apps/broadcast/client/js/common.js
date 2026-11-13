/**
 * App —— 前端单例工具集合。
 * 职责：主题初始化（含首屏闪白防护）、Toast 提示、api 封装、SSE 订阅、escapeHtml。
 * 所有页面共用此对象。
 */
window.App = (() => {
  const THEME_KEY = 'darkMode';
  /** 路径前缀：挂载到明星学校后，接口实际地址为 /broadcast/api/... */
  const BASE = '/broadcast';

  /**
   * 取多语言文案：i18n 框架未加载时回退中文兜底
   * @param {string} key 语言包键（如 broadcast.error.network）
   * @param {string} fallback 中文兜底文案
   * @param {object} [params] 占位参数
   * @returns {string} 展示文案
   */
  function bcT(key, fallback, params) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : fallback;
  }

  /**
   * 初始化主题：
   *   1) 如果 <html> 上已有 data-theme 就不再改（那是 <head> 里联内脚本先加的，防闪白）
   *   2) 否则读 localStorage，没有时跟随系统偏好
   */
  function initTheme() {
    if (document.documentElement.dataset.theme === 'loaded') return;
    const saved = localStorage.getItem(THEME_KEY);
    let isDark;
    if (saved !== null) {
      isDark = saved === 'true';
    } else {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.dataset.theme = 'loaded';
    document.body.classList.toggle('dark-mode', isDark);
  }

  /** 切换主题。 */
  function toggleTheme() {
    const isDark = !document.body.classList.contains('dark-mode');
    document.body.classList.toggle('dark-mode', isDark);
    localStorage.setItem(THEME_KEY, String(isDark));
  }

  /**
   * Toast 提示（双层 rAF 确保先应用隐藏态再触发过渡）。
   * @param {string} message 文案
   * @param {'success'|'error'|'warning'|'info'} type 类型
   */
  function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => { el.classList.add('show'); });
    });

    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  /**
   * 统一 fetch 封装：自动处理 {ok:false} 的业务错误、网络错误转成中文 Toast。
   * @param {string} path
   * @param {object} options fetch 选项
   * @returns {Promise} 成功时 resolve(data)，失败时 reject({code, message})
   */
  async function api(path, options = {}) {
    const opt = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
    if (opt.body && typeof opt.body === 'object') opt.body = JSON.stringify(opt.body);
    let resp;
    try {
      resp = await fetch(BASE + path, opt);
    } catch (e) {
      showToast(bcT('broadcast.error.network', '网络请求失败，请检查后端是否启动'), 'error');
      throw { code: 'NETWORK', message: bcT('broadcast.error.networkShort', '网络请求失败') };
    }
    let body;
    try { body = await resp.json(); } catch (e) {
      showToast(bcT('broadcast.error.badResponse', '服务器返回格式异常'), 'error');
      throw { code: 'BAD_RESPONSE', message: bcT('broadcast.error.badResponse', '服务器返回格式异常') };
    }
    if (!resp.ok || body.ok === false) {
      const err = body.error || { code: resp.status, message: bcT('broadcast.error.requestFailed', '请求失败') };
      showToast(err.message || bcT('broadcast.error.requestFailed', '请求失败'), 'error');
      throw err;
    }
    return body.data;
  }

  /**
   * 启动一个 EventSource 订阅。断线自动重连（浏览器原生行为）。
   * @param {string} path SSE URL
   * @param {object} handlers { snapshot, command, error, open, close }
   * @returns {EventSource}
   */
  function subscribe(path, handlers = {}) {
    const es = new EventSource(BASE + path);
    if (handlers.open) es.addEventListener('open', handlers.open);
    if (handlers.close) {
      es.addEventListener('close', handlers.close);
      es.onerror = handlers.close; // 断线也算 close
    }
    es.addEventListener('snapshot', (e) => {
      if (handlers.snapshot) handlers.snapshot(JSON.parse(e.data));
    });
    es.addEventListener('command', (e) => {
      if (handlers.command) handlers.command(JSON.parse(e.data));
    });
    es.addEventListener('error', (e) => {
      // EventSource 原生 error（断线/刷新中断）没有 data，直接忽略，避免 JSON.parse(undefined) 抛错
      if (!e.data) return;
      if (handlers.error) handlers.error(JSON.parse(e.data));
    });
    return es;
  }

  /** HTML 转义。 */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 初始化顶栏用户区（统一网盘顶栏：头像 + 用户名）。
   * 通过主项目全局 /api/me 获取当前登录用户（cookie 会话鉴权，同源自动携带），
   * 已上传头像用返回的 avatar，为空或未登录时回退平台默认头像；
   * 请求失败静默降级（保持默认头像、用户名留空），不影响广播器核心功能。
   */
  async function initTopbarUser() {
    const DEFAULT_AVATAR = '/assets/home/default-avatar.png'; // 平台默认头像（未登录/未上传时兜底）
    const avatarImg = document.getElementById('user-avatar-img'); // 顶栏头像图片元素
    const nameEl = document.getElementById('user-name');          // 顶栏用户名（桌面隐藏，小屏显示）
    if (!avatarImg) return;                                   // 非 SPA 壳页面（如 channel.html）没有用户区，直接跳过
    try {
      const resp = await fetch('/api/me');                        // 主项目全局接口，返回 {loggedIn,name,avatar,...}
      const me = await resp.json();                               // 登录信息对象
      if (me && me.loggedIn) {
        avatarImg.src = me.avatar || DEFAULT_AVATAR;              // 有上传头像用上传的，否则用默认头像
        avatarImg.title = me.name || '';                          // 悬浮头像显示名字（title 组件）
        if (nameEl) nameEl.textContent = me.name || '';           // 用户名（桌面隐藏，小屏显示）
      }
    } catch (e) {
      // 未登录 / 网络异常：保持默认头像与空用户名，不弹错误打扰
    }
  }

  return {
    initTheme, toggleTheme,
    showToast, api, subscribe,
    escapeHtml, initTopbarUser
  };
})();

// 页面加载完成后立即初始化
document.addEventListener('DOMContentLoaded', () => window.App.initTheme());
