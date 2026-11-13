/**
 * page-shop.js —— 明星商店纯 JS 渲染（与主项目 portal/settings 同模式）
 * ----------------------------------------------------------------------
 * index.html 只留 <div id="root"></div>，本文件先 renderShell() 注入骨架，
 * 再初始化 common-ui（Toast、头像菜单等），最后执行路由分发。
 *
 * 职责：
 *   1. renderShell()     —— 把原 index.html 里的侧边栏/顶栏/7 个视图容器/结算条/弹窗 动态注入 #root
 *   2. window.App        —— api 封装、escapeHtml、fmtPoints、登录信息缓存、顶栏用户区初始化
 *   3. 路由系统          —— History API + popstate + SPA 内部跳转委托
 *   4. 所有视图渲染函数 —— renderHome / renderShop / renderCart / renderOrders / renderOrder / renderMyShops / renderAdmin
 *
 * 依赖（由 index.html 外部引入）：
 *   - /assets/common-ui.js   （全局 Toast 兜底、悬浮工具条、头像菜单自动挂载）
 *   - /assets/all.css?v=...  （所有样式，已在末尾含商店段）
 */

/* ==================== Part 0: 多语言文案 helper ==================== */

/**
 * 取商店界面多语言文案：语言包未加载时回退中文兜底，保证界面始终可读
 * @param {string} key 语言包键（shop.* 命名空间）
 * @param {string} fallback 中文兜底原文
 * @param {object} [params] 占位参数，如 {points: 12}
 * @returns {string} 展示文案
 */
function shopT(key, fallback, params) {
  return window.I18n ? window.I18n.t(key, params, fallback) : (fallback || key);
}

/* ==================== Part 1: 骨架渲染 ==================== */

/** renderShell —— 把整个页面骨架注入到 #root，后续路由直接往容器里填内容 */
function renderShell() {
  const ROOT = document.getElementById('root');
  if (!ROOT) return;

  ROOT.innerHTML =
    /* Toast 容器（商店自己的 Toast 系统，和 common-ui 的 .cui-toast 互不干扰） */
    '<div class="toast-container" id="toast-container"></div>' +

    /* 主容器：侧栏 + 主内容 */
    '<div class="main-container">' +

      /* 侧边栏（72px，与主项目对齐） */
      '<aside class="sidebar">' +
        '<div class="sidebar-header">' +
          '<span class="sidebar-logo" title="' + shopT('shop.shell.logoTitle', '明星商店') + '">' +
            '<img src="/assets/home/shop.png" alt="' + shopT('shop.shell.logoAlt', '明星商店') + '">' +
          '</span>' +
        '</div>' +
        '<nav class="sidebar-nav" id="sidebar-nav">' +
          /* 首页 */
          '<a class="nav-item" href="/shop/" data-route="home" title="' + shopT('shop.shell.navHome', '首页逛店') + '" data-i18n-title="shop.shell.navHome">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>' +
          '</a>' +
          /* 购物车（带角标） */
          '<a class="nav-item" href="/shop/cart" data-route="cart" title="' + shopT('shop.shell.navCart', '购物车') + '" data-i18n-title="shop.shell.navCart">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>' +
            '<span class="nav-badge hidden" id="cart-badge">0</span>' +
          '</a>' +
          /* 我的订单 */
          '<a class="nav-item" href="/shop/orders" data-route="orders" title="' + shopT('shop.shell.navOrders', '我的订单') + '" data-i18n-title="shop.shell.navOrders">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10H7v-2h10v2zm0-4H7V7h10v2z"/></svg>' +
          '</a>' +
          /* 我的店铺 */
          '<a class="nav-item" href="/shop/myshops" data-route="myshops" title="' + shopT('shop.shell.navMyShops', '我的店铺') + '" data-i18n-title="shop.shell.navMyShops">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z"/></svg>' +
          '</a>' +
          /* 管理后台（仅管理员可见；JS boot 时移除 .hidden） */
          '<a class="nav-item admin-only hidden" href="/shop/admin" data-route="admin" title="' + shopT('shop.shell.navAdmin', '管理后台') + '" data-i18n-title="shop.shell.navAdmin">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>' +
          '</a>' +
        '</nav>' +
      '</aside>' +

      /* 主内容区：顶栏 + 各视图（SPA 动态填充） */
      '<div class="main-content">' +
        '<header class="topbar">' +
          /* 顶栏左侧：仅返回按钮（详情页/编辑页才会出现，紧贴左边缘） */
          '<div class="topbar-left" id="topbar-left"></div>' +
          '<div class="topbar-right">' +
            /* 顶栏右侧：当前视图主按钮，与头像间隔 16px */
            '<div class="topbar-actions" id="topbar-actions"></div>' +
            '<div class="user-info">' +
              '<div class="user-avatar">' +
                '<img id="user-avatar-img" src="/assets/home/default-avatar.png" alt="' + shopT('shop.shell.userAvatar', '用户头像') + '">' +
              '</div>' +
              '<span class="user-name" id="user-name"></span>' +
            '</div>' +
          '</div>' +
        '</header>' +

        '<main class="content-area">' +
          /* 首页 */
          '<section id="view-home" class="sp-view">' +
            '<div class="sp-toolbar">' +
              '<div class="sp-search">' +
                '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
                '<input type="text" id="home-search" placeholder="' + shopT('shop.home.searchPlaceholder', '搜索店铺或商品') + '" data-i18n-placeholder="shop.home.searchPlaceholder" maxlength="50">' +
              '</div>' +
              '<div class="sp-cats" id="home-cats"></div>' +
            '</div>' +
            '<div class="shop-grid" id="shop-grid"></div>' +
          '</section>' +
          /* 店铺详情 */
          '<section id="view-shop" class="sp-view" hidden>' +
            '<div class="sp-shop-head" id="shop-head"></div>' +
            '<div class="sp-cats" id="shop-cats"></div>' +
            '<div class="goods-grid" id="goods-grid"></div>' +
          '</section>' +
          /* 购物车 */
          '<section id="view-cart" class="sp-view" hidden>' +
            '<div id="cart-list"></div>' +
            '<div class="sp-checkout" id="cart-checkout"></div>' +
          '</section>' +
          /* 我的订单 */
          '<section id="view-orders" class="sp-view" hidden>' +
            '<div id="orders-list"></div>' +
          '</section>' +
          /* 订单详情 */
          '<section id="view-order" class="sp-view" hidden>' +
            '<div id="order-detail"></div>' +
          '</section>' +
          /* 我的店铺 */
          '<section id="view-myshops" class="sp-view" hidden>' +
            '<div id="myshop-list"></div>' +
          '</section>' +
          /* 我的店铺 · 单店商品管理（每个店铺各自一页） */
          '<section id="view-shop-products" class="sp-view" hidden>' +
            '<div id="myshop-products"></div>' +
          '</section>' +
          /* 管理后台 */
          '<section id="view-admin" class="sp-view" hidden>' +
            '<div class="sp-admin-tabs">' +
              '<button class="sp-tab active" data-tab="products" data-i18n="shop.admin.tabProducts">' + shopT('shop.admin.tabProducts', '商品管理') + '</button>' +
              '<button class="sp-tab" data-tab="shops" data-i18n="shop.admin.tabShops">' + shopT('shop.admin.tabShops', '店铺管理') + '</button>' +
              '<button class="sp-tab" data-tab="orders" data-i18n="shop.admin.tabOrders">' + shopT('shop.admin.tabOrders', '订单管理') + '</button>' +
            '</div>' +
            '<div id="admin-products">' +
              '<div class="sp-table-wrap" id="product-table"></div>' +
            '</div>' +
            '<div id="admin-shops" hidden>' +
              '<div class="sp-table-wrap" id="shop-table"></div>' +
            '</div>' +
            '<div id="admin-orders" hidden>' +
              '<div class="sp-status-filter" id="admin-order-filter"></div>' +
              '<div id="admin-orders-list"></div>' +
            '</div>' +
          '</section>' +
        '</main>' +
      '</div>' +
    '</div>' +

    /* 底部结算条 */
    '<div class="sp-cartbar hidden" id="cartbar">' +
      '<span class="sp-cartbar-count" id="cartbar-count">🛒 0</span>' +
      '<span class="sp-cartbar-total" id="cartbar-total">' + shopT('shop.common.points', '{points} 积分', { points: 0 }) + '</span>' +
      '<button class="btn btn-column2" id="cartbar-go" data-i18n="shop.cart.barGo">' + shopT('shop.cart.barGo', '去购物车') + '</button>' +
    '</div>' +

    /* 通用弹窗（规范：.modal-overlay.active 控制显隐） */
    '<div class="modal-overlay" id="modal-overlay">' +
      '<div class="modal">' +
        '<h3 class="modal-title" id="modal-title">' + shopT('shop.common.dialogTitle', '标题') + '</h3>' +
        '<div class="modal-body sp-modal-body" id="modal-body"></div>' +
        '<div class="modal-buttons">' +
          '<button class="btn btn-column5" id="modal-cancel" data-i18n="shop.common.cancel">' + shopT('shop.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="modal-confirm" data-i18n="shop.common.confirm">' + shopT('shop.common.confirm', '确定') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

/* ==================== Part 2: window.App（原 common.js 逻辑） ==================== */

window.App = (function () {
  /** 主题偏好 localStorage 键 */
  var THEME_KEY = 'darkMode';
  /** API 路径前缀（挂载到主项目后接口实际地址为 /shop/api/...） */
  var BASE = '/shop/api';
  /** 当前登录用户信息缓存（initMe 异步填充） */
  var meCache = null;

  /**
   * 初始化主题：商店固定浅色，不再跟随浏览器/系统深色偏好。
   * 只有用户在本站显式保存过 darkMode=true 才启用深色，避免系统深色模式下
   * 部分原生控件、Toast、悬浮工具条被浏览器自动反色成深色。
   */
  function initTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      /* 是否深色：仅认显式保存的偏好，未设置时一律浅色 */
      var isDark = saved === 'true';
      document.body.classList.toggle('dark-mode', isDark);
      /* 通知公共 UI（Toast / 悬浮工具条）不要按系统深色反色 */
      document.body.classList.toggle('cui-light', !isDark);
    } catch (e) {}
  }

  /** 切换主题并持久化 */
  function toggleTheme() {
    var isDark = !document.body.classList.contains('dark-mode');
    document.body.classList.toggle('dark-mode', isDark);
    /* 与公共 UI 的浅色标记保持同步 */
    document.body.classList.toggle('cui-light', !isDark);
    localStorage.setItem(THEME_KEY, String(isDark));
  }

  /**
   * 商店自己的 Toast（.toast-container + .toast 类名）。
   * 和 common-ui.js 的全局 window.showToast(.cui-toast) 互不干扰；
   * API 层统一调用 App.showToast，保持商店独立。
   */
  function showToast(message, type) {
    type = type || 'info';
    var container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    container.appendChild(el);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add('show'); });
    });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  /**
   * 统一 fetch 封装：自动 JSON 序列化、业务错误转 Toast 提示。
   * @param {string} path 接口短路径，如 '/shops'、'/cart'
   * @param {object} options fetch 选项
   * @returns {Promise<object>} body.data
   */
  async function api(path, options) {
    options = options || {};
    var opt = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
    if (opt.body && typeof opt.body === 'object') opt.body = JSON.stringify(opt.body);
    var resp;
    try {
      resp = await fetch(BASE + path, opt);
    } catch (e) {
      showToast(shopT('shop.api.networkError', '网络请求失败，请检查后端是否启动'), 'error');
      throw { code: 'NETWORK', message: shopT('shop.api.networkMessage', '网络请求失败') };
    }
    var rawText = await resp.text();                          /* 先拿原始文本（避免 json() 失败后 body 已被消费） */
    var body;
    try { body = rawText ? JSON.parse(rawText) : null; } catch (e) {
      console.error('[shop.api] ' + opt.method + ' ' + BASE + path, '→ HTTP ' + resp.status, resp.headers.get('content-type'));
      console.error('  原始响应:', rawText.substring(0, 500));
      showToast(shopT('shop.api.badResponse', '服务器返回格式异常 (HTTP {status})，请看 F12 Console', { status: resp.status }), 'error');
      throw { code: 'BAD_RESPONSE', status: resp.status, raw: rawText, message: shopT('shop.api.badResponseMessage', '服务器返回格式异常') };
    }
    if (!resp.ok || body.ok === false) {
      var err = (body && body.error) || { code: resp.status, message: body && body.message ? body.message : shopT('shop.common.requestFailed', '请求失败') };
      showToast(err.message || shopT('shop.common.requestFailed', '请求失败'), 'error');
      throw err;
    }
    return body.data;
  }

  /** HTML 转义（拼接用户输入前必须过一遍防 XSS） */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 拉取并缓存 /api/me 登录信息（平台全局接口，cookie 自动携带）
   * @returns {Promise<object>} {loggedIn, userId, name, isAdmin, avatar, points}
   */
  async function initMe() {
    if (meCache) return meCache;
    try {
      var resp = await fetch('/api/me');
      meCache = await resp.json();
    } catch (e) {
      meCache = { loggedIn: false };
    }
    return meCache;
  }

  /** 取缓存的登录信息（未拉取时返回 null） */
  function getMe() { return meCache; }

  /**
   * 初始化顶栏用户区：填头像、名字。
   * 头像下拉菜单由 common-ui.js 扫描 .user-info .user-avatar 自动挂载。
   */
  async function initTopbarUser() {
    var DEFAULT = '/assets/home/default-avatar.png';
    var avatarImg = document.getElementById('user-avatar-img');
    var nameEl = document.getElementById('user-name');
    if (!avatarImg) return;
    var me = await initMe();
    if (me && me.loggedIn) {
      avatarImg.src = me.avatar || DEFAULT;
      avatarImg.title = me.name || '';
      if (nameEl) nameEl.textContent = me.name || '';
    }
  }

  /** 积分格式化：整数不带尾零，非整数保留两位小数（最多 4 位） */
  function fmtPoints(n) {
    var num = Number(n) || 0;
    if (Number.isInteger(num)) return String(num);
    // 保留最多 4 位小数，去掉末尾多余零
    var s = num.toFixed(4).replace(/\.?0+$/, '');
    return s;
  }

  return {
    initTheme: initTheme, toggleTheme: toggleTheme,
    showToast: showToast, api: api, escapeHtml: escapeHtml,
    initMe: initMe, getMe: getMe, initTopbarUser: initTopbarUser,
    fmtPoints: fmtPoints
  };
})();

/* ==================== Part 3: 路由与视图（原 app.js 逻辑，基本原样搬迁） ==================== */

(function () {
  var App = window.App;
  /** 快速选择器 */
  var $ = function (sel) { return document.querySelector(sel); };
  /** SPA 路由前缀 */
  var BASE_PATH = '/shop';

  /** 统一按钮图标（SVG 线性图标，与转盘 /editor 完全同款，避免用文本字符 ↑↓✕←） */
  var ICONS = {
    /* 返回：左箭头 */
    back: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.38644 2.29964C6.71789 2.10083 7.14845 2.20851 7.34738 2.53987C7.54627 2.87135 7.43859 3.30188 7.10715 3.50081L5.69385 4.34824C5.2363 4.62259 5.00753 4.75976 4.98692 4.95874C4.98409 4.9861 4.98408 5.01368 4.98691 5.04103C5.00746 5.24002 5.23619 5.37726 5.69366 5.65174L7.10715 6.49983C7.43854 6.69873 7.54615 7.12931 7.34738 7.46077C7.14844 7.79216 6.7179 7.8989 6.38644 7.70003L2.89426 5.60432C2.43799 5.33047 2.4379 4.66915 2.89426 4.39534L6.38644 2.29964Z" fill="currentColor"/></svg>',
    /* 上移：左箭头顺时针旋转 90° */
    up: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path transform="rotate(90 5 5)" d="M6.38644 2.29964C6.71789 2.10083 7.14845 2.20851 7.34738 2.53987C7.54627 2.87135 7.43859 3.30188 7.10715 3.50081L5.69385 4.34824C5.2363 4.62259 5.00753 4.75976 4.98692 4.95874C4.98409 4.9861 4.98408 5.01368 4.98691 5.04103C5.00746 5.24002 5.23619 5.37726 5.69366 5.65174L7.10715 6.49983C7.43854 6.69873 7.54615 7.12931 7.34738 7.46077C7.14844 7.79216 6.7179 7.8989 6.38644 7.70003L2.89426 5.60432C2.43799 5.33047 2.4379 4.66915 2.89426 4.39534L6.38644 2.29964Z" fill="currentColor"/></svg>',
    /* 下移：左箭头逆时针旋转 90° */
    down: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path transform="rotate(-90 5 5)" d="M6.38644 2.29964C6.71789 2.10083 7.14845 2.20851 7.34738 2.53987C7.54627 2.87135 7.43859 3.30188 7.10715 3.50081L5.69385 4.34824C5.2363 4.62259 5.00753 4.75976 4.98692 4.95874C4.98409 4.9861 4.98408 5.01368 4.98691 5.04103C5.00746 5.24002 5.23619 5.37726 5.69366 5.65174L7.10715 6.49983C7.43854 6.69873 7.54615 7.12931 7.34738 7.46077C7.14844 7.79216 6.7179 7.8989 6.38644 7.70003L2.89426 5.60432C2.43799 5.33047 2.4379 4.66915 2.89426 4.39534L6.38644 2.29964Z" fill="currentColor"/></svg>',
    /* 移除：叉号 */
    close: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.3435 2.66698C6.61678 2.39384 7.06039 2.39296 7.33373 2.666C7.6068 2.93926 7.60668 3.3829 7.33373 3.65623L6.79608 4.19388C6.43718 4.55279 6.25773 4.73224 6.24036 4.95291C6.23789 4.98424 6.23789 5.01572 6.24036 5.04706C6.25773 5.26773 6.43718 5.44718 6.79608 5.80609L7.33373 6.34373C7.60672 6.61705 7.60676 7.06068 7.33373 7.33397C7.06039 7.60701 6.61678 7.60613 6.3435 7.33299L5.80585 6.79534C5.44694 6.43644 5.26749 6.25699 5.04682 6.23962C5.01549 6.23715 4.98401 6.23715 4.95267 6.23962C4.732 6.25699 4.55255 6.43644 4.19365 6.79534L3.656 7.33299C3.38263 7.60636 2.93913 7.60636 2.66576 7.33299C2.39298 7.05958 2.39357 6.61691 2.66674 6.34373L3.20439 5.80609C3.56329 5.44718 3.74274 5.26773 3.76011 5.04706C3.76258 5.01572 3.76258 4.98424 3.76011 4.95291C3.74274 4.73224 3.56329 4.55279 3.20439 4.19388L2.66674 3.65623C2.39355 3.38304 2.39292 2.94039 2.66576 2.66698C2.93913 2.39361 3.38263 2.39361 3.656 2.66698L4.19365 3.20462C4.55255 3.56353 4.732 3.74298 4.95267 3.76035C4.98401 3.76282 5.01549 3.76282 5.04682 3.76035C5.26749 3.74298 5.44694 3.56353 5.80585 3.20463L6.3435 2.66698Z" fill="currentColor"/></svg>',
    /* 删除：垃圾桶 */
    trash: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 2.05029C5.76257 2.05029 5.98515 2.21883 6.06641 2.45361C6.10253 2.558 6.18935 2.6499 6.2998 2.6499H7.2002C7.53136 2.64999 7.79959 2.91838 7.7998 3.24951C7.79981 3.5153 7.62704 3.74086 7.3877 3.81982C7.28641 3.85317 7.19565 3.93402 7.19043 4.04053L7.08789 6.14209C7.04847 6.95025 7.02876 7.35484 6.79004 7.61963C6.75621 7.65712 6.71976 7.69216 6.68066 7.72412C6.40456 7.94965 5.99955 7.94971 5.19043 7.94971H4.80957C4.00065 7.94971 3.59641 7.94952 3.32031 7.72412C3.28106 7.69206 3.2439 7.65726 3.20996 7.61963C2.97124 7.35484 2.95153 6.95025 2.91211 6.14209L2.80957 4.04053C2.80435 3.93403 2.71358 3.85317 2.6123 3.81982C2.37297 3.74084 2.2002 3.51528 2.2002 3.24951C2.20041 2.91839 2.46867 2.65002 2.7998 2.6499H3.7002C3.81065 2.6499 3.89747 2.558 3.93359 2.45361C4.01485 2.21883 4.23745 2.05031 4.5 2.05029H5.5ZM4.11328 4.15088C3.86639 4.1587 3.67198 4.36387 3.67773 4.61084L3.72266 6.51025C3.72866 6.7599 3.9369 6.95648 4.18652 6.94873C4.4336 6.94103 4.62793 6.7359 4.62207 6.48877L4.57715 4.58936C4.57104 4.3398 4.36284 4.14313 4.11328 4.15088ZM5.88672 4.15088C5.63716 4.14313 5.42896 4.3398 5.42285 4.58936L5.37793 6.48877C5.37208 6.73587 5.56644 6.94099 5.81348 6.94873C6.06309 6.95648 6.27133 6.7599 6.27734 6.51025L6.32227 4.61084C6.32802 4.36384 6.13365 4.15866 5.88672 4.15088Z" fill="currentColor"/></svg>',
    /* 新增：加号 */
    plus: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 2.2C5.33137 2.2 5.59961 2.46824 5.59961 2.79961V4.40039H7.20039C7.53176 4.40039 7.8 4.66863 7.8 5C7.8 5.33137 7.53176 5.59961 7.20039 5.59961H5.59961V7.20039C5.59961 7.53176 5.33137 7.8 5 7.8C4.66863 7.8 4.40039 7.53176 4.40039 7.20039V5.59961H2.79961C2.46824 5.59961 2.2 5.33137 2.2 5C2.2 4.66863 2.46824 4.40039 2.79961 4.40039H4.40039V2.79961C4.40039 2.46824 4.66863 2.2 5 2.2Z" fill="currentColor"/></svg>',
    /* 确认/保存：对勾 */
    check: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.20703 2.93261C8.44292 3.1685 8.44292 3.55117 8.20703 3.78706L4.52344 7.47065C4.3767 7.61739 4.21191 7.7357 4.03125 7.81636C3.85439 7.89521 3.65564 7.93436 3.45508 7.92866C3.25468 7.92263 3.06758 7.87252 2.9043 7.79878C2.74117 7.72483 2.58429 7.62796 2.44727 7.50776L1.16309 6.38276C0.919811 6.17004 0.894619 5.80072 1.10645 5.55756C1.31836 5.31451 1.68692 5.28819 1.92969 5.49995L3.12793 6.5478C3.1758 6.58966 3.21413 6.6132 3.24023 6.62788C3.25312 6.63506 3.26185 6.63841 3.26367 6.63862C3.29044 6.64196 3.32202 6.63502 3.35645 6.61909L3.36426 6.61421L6.99121 2.98921C7.22801 2.75247 7.61144 2.75244 7.84863 2.98921L8.20703 2.93261Z" fill="currentColor"/></svg>',
    /* 编辑：铅笔（店铺管理顶栏） */
    edit: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.8 1.9a1.13 1.13 0 0 1 1.6 0l.6.6a1.13 1.13 0 0 1 0 1.6l-4.2 4.2-2.4.6.6-2.4 3.8-3.8Z" stroke="currentColor" stroke-width="0.9" stroke-linejoin="round"/><path d="M6.2 2.5l1.5 1.5" stroke="currentColor" stroke-width="0.9"/></svg>'
  };

  /**
   * SPA 内部跳转：pushState + 手动触发 route（不整页刷新）
   * @param {string} path 不含 /shop 前缀的路径，如 '/cart'
   */
  function navigate(path) {
    history.pushState({}, '', BASE_PATH + path);
    route();
  }

  /** 店铺详情页当前分类筛选 */
  var shopFilterCat = '';
  /** 首页当前分类筛选 */
  var homeFilterCat = '';

  /* ===== 工具函数 ===== */

  /**
   * 渲染封面：有图用图（失败兜底 emoji），无图用 emoji 圆角块
   * @param {object} item {image, emoji}
   * @param {string} cls 附加类名
   */
  function coverHtml(item, cls) {
    cls = cls || '';
    if (item.image) {
      return '<img class="sp-cover ' + cls + '" src="' + App.escapeHtml(item.image) + '" alt="" onerror="this.outerHTML=\'<div class=\\\'sp-cover sp-cover-emoji ' + cls + '\\\'>' + App.escapeHtml(item.emoji || '🛒') + '</div>\'">';
    }
    return '<div class="sp-cover sp-cover-emoji ' + cls + '">' + App.escapeHtml(item.emoji || '🛒') + '</div>';
  }

  /**
   * 打开通用弹窗（严格遵循 docs/弹窗.html 规范）
   * @param {{title, body, confirmText?, danger?, onConfirm}} cfg
   */
  function openModal(cfg) {
    var overlay = $('#modal-overlay');
    $('#modal-title').textContent = cfg.title;
    $('#modal-body').innerHTML = cfg.body;
    var btn = $('#modal-confirm');
    btn.textContent = cfg.confirmText || shopT('shop.common.confirm', '确定');
    btn.className = cfg.danger ? 'btn btn-column4' : 'btn btn-column2';
    var fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', async function () {
      try {
        var keepOpen = await cfg.onConfirm();
        if (!keepOpen) closeModal();
      } catch (e) { /* api 已 Toast */ }
    });
    overlay.classList.remove('active');
    overlay.offsetHeight;
    requestAnimationFrame(function () { overlay.classList.add('active'); });
    document.body.style.overflow = 'hidden';
  }

  /** 关闭弹窗 */
  function closeModal() {
    document.querySelectorAll('.modal-overlay.active').forEach(function (m) { m.classList.remove('active'); });
    document.body.style.overflow = '';
  }

  /** 绑定弹窗关闭行为（遮罩点击 + ESC） */
  function initModalClose() {
    $('#modal-cancel').addEventListener('click', closeModal);
    $('#modal-overlay').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });
  }

  /**
   * 危险操作二次确认弹窗
   * @param {string} text 提示文案
   * @param {Function} onConfirm 确认回调
   */
  function confirmDanger(text, onConfirm) {
    openModal({
      title: shopT('shop.common.confirmTitle', '请确认'),
      body: '<p>' + App.escapeHtml(text) + '</p><p style="margin-top:8px;color:var(--text-secondary);font-size:13px;">' + shopT('shop.common.irreversible', '此操作不可撤销') + '</p>',
      confirmText: shopT('shop.common.confirmOk', '确认'),
      danger: true,
      onConfirm: async function () { await onConfirm(); }
    });
  }

  /**
   * 订单状态 → 徽章 HTML
   * @param {string} status 状态枚举
   * @returns {string}
   */
  function statusBadge(status) {
    var map = {
      pending:    { cls: 'badge idle',    text: shopT('shop.order.statusPending', '待确认') },
      confirmed:  { cls: 'badge playing', text: shopT('shop.order.statusConfirmed', '已确认') },
      delivering: { cls: 'badge playing', text: shopT('shop.order.statusDelivering', '待取货') },
      completed:  { cls: 'badge done',    text: shopT('shop.order.statusCompleted', '已完成') },
      cancelled:  { cls: 'badge error',   text: shopT('shop.order.statusCancelled', '已取消') },
      refunded:   { cls: 'badge error',   text: shopT('shop.order.statusRefunded', '已退款') }
    };
    var it = map[status] || { cls: 'badge idle', text: status };
    return '<span class="' + it.cls + ' status-badge">' + it.text + '</span>';
  }

  /**
   * 退款状态徽标（已退款由订单状态徽标体现，这里只标审核中/被拒绝）
   * @param {object} o 订单
   * @returns {string} HTML 片段，无退款记录时返回空串
   */
  function refundBadge(o) {
    if (o.refundStatus === 'pending') return '<span class="badge playing status-badge">' + shopT('shop.order.refundPending', '退款审核中') + '</span>';
    if (o.refundStatus === 'rejected') return '<span class="badge error status-badge">' + shopT('shop.order.refundRejected', '退款被拒绝') + '</span>';
    return '';
  }

  /**
   * 构建退款区块 HTML（订单详情页）：展示退款进度 / 申请入口
   * @param {object} o 订单
   * @returns {string}
   */
  function refundBoxHtml(o) {
    /* 已取消、已退款、审核中、已通过都不允许再申请 */
    var canApply = o.status !== 'cancelled' && o.status !== 'refunded' &&
      o.refundStatus !== 'pending' && o.refundStatus !== 'approved';
    /** 退款状态说明行 */
    var lines = [];
    /** 退款金额展示值：优先用申请快照，兼容历史订单 */
    var amount = o.refundAmount != null ? o.refundAmount : o.totalAmount;
    if (o.refundStatus === 'pending') {
      lines.push('<div class="sp-refund-state">' + shopT('shop.order.refundPending', '退款审核中') + '</div>');
      lines.push('<div>' + shopT('shop.order.refundAmount', '申请金额：{points} 积分', { points: App.fmtPoints(amount) }) + '</div>');
      if (o.refundReason) lines.push('<div>' + shopT('shop.order.refundReason', '申请理由：{reason}', { reason: App.escapeHtml(o.refundReason) }) + '</div>');
      lines.push('<div>' + shopT('shop.order.refundTime', '提交时间：{time}', { time: App.escapeHtml((o.refundRequestedAt || '').replace('T', ' ').slice(0, 16)) }) + '</div>');
    } else if (o.refundStatus === 'approved') {
      lines.push('<div class="sp-refund-state">' + shopT('shop.order.statusRefunded', '已退款') + '</div>');
      lines.push('<div>' + shopT('shop.order.refundReturned', '已返还 {points} 积分', { points: App.fmtPoints(amount) }) + '</div>');
    } else if (o.refundStatus === 'rejected') {
      lines.push('<div class="sp-refund-state">' + shopT('shop.order.refundRequestRejected', '退款申请被拒绝') + '</div>');
      if (o.refundRejectReason) lines.push('<div>' + shopT('shop.order.rejectReason', '拒绝理由：{reason}', { reason: App.escapeHtml(o.refundRejectReason) }) + '</div>');
    }
    var action = canApply
      ? '<div class="sp-refund-actions"><button class="btn btn-column5" id="order-refund-btn">' +
          (o.refundStatus === 'rejected' ? shopT('shop.order.applyRefundAgain', '再次申请退款') : shopT('shop.order.applyRefund', '申请退款')) + '</button></div>'
      : '';
    if (!action && lines.length === 0) return '';
    return '<div class="sp-refund-box">' +
      (lines.length ? lines.join('') : '<div>' + shopT('shop.order.refundTip', '对订单不满意？可申请退款，需管理员审核通过后才会返还积分。') + '</div>') +
      action +
    '</div>';
  }

  /* ===== 购物车角标 / 结算条 ===== */

  /** 刷新侧栏购物车角标 + 结算条 */
  async function refreshCartBadge() {
    try {
      var cart = await App.api('/cart');
      var badge = $('#cart-badge');
      if (badge) {
        badge.textContent = String(cart.count);
        badge.classList.toggle('hidden', cart.count === 0);
      }
      $('#cartbar-count').textContent = shopT('shop.cart.barCount', '🛒 {count}', { count: cart.count });
      $('#cartbar-total').textContent = shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(cart.totalAmount) });
      $('#cartbar').classList.toggle('hidden', cart.count === 0);
    } catch (e) { /* 未登录/网络静默 */ }
  }

  /**
   * 加购入口：套餐商品弹出套餐分组选择器，有规格商品弹出规格选择器，无规格直接加购
   * @param {object} product 商品对象（含 id, price, specs, isCombo, comboGroups）
   */
  async function addToCart(product) {
    // 套餐商品 → 弹套餐分组选择器
    if (product.isCombo) {
      return openComboSheet(product);
    }
    // 有规格组 → 弹规格选择器
    if (product.specs && Array.isArray(product.specs) && product.specs.length > 0) {
      return openSpecSheet(product);
    }
    // 无规格 → 直接加购
    var cart = await App.api('/cart', { method: 'POST', body: { productId: product.id, quantity: 1 } });
    App.showToast(shopT('shop.cart.added', '已加入购物车'), 'success');
    applyCartView(cart);
  }

  /* ===== 规格选择弹窗（美团式底部 Bottom Sheet） ===== */

  /**
   * 打开规格选择弹窗
   * @param {object} product 商品（含 specs: [{name, required, options:[{label, priceDelta}]}]）
   */
  function openSpecSheet(product) {
    // 初始状态：默认选第一组的第一个选项
    var selected = {};
    for (var i = 0; i < product.specs.length; i++) {
      var group = product.specs[i];
      selected[group.name] = group.options.length > 0 ? group.options[0].label : null;
    }
    // 用户每次改规格步进器的数量（弹窗内部计数）
    var sheetQty = 1;

    /** 根据当前选择计算规格总价 */
    function calcPrice() {
      var delta = 0;
      var labels = [];
      for (var j = 0; j < product.specs.length; j++) {
        var g = product.specs[j];
        var picked = selected[g.name];
        if (picked) {
          labels.push(picked);
          var opt = g.options.find(function (o) { return o.label === picked; });
          if (opt) delta += opt.priceDelta || 0;
        }
      }
      return {
        labels: labels,
        specText: labels.join('/'),
        unitPrice: Math.round((product.price + delta) * 100) / 100
      };
    }

    /** 渲染弹窗 */
    function render() {
      var priceInfo = calcPrice();
      var specHtml = product.specs.map(function (group) {
        var optsHtml = group.options.map(function (opt) {
          var active = selected[group.name] === opt.label ? ' sp-spec-active' : '';
          var delta = opt.priceDelta || 0;
          var deltaText = delta !== 0
            ? (delta > 0
                ? shopT('shop.spec.priceDeltaUp', ' +{points} 积分', { points: App.fmtPoints(delta) })
                : shopT('shop.spec.priceDeltaDown', ' -{points} 积分', { points: App.fmtPoints(-delta) }))
            : '';
          return '<button class="sp-spec-opt' + active + '" data-group="' + App.escapeHtml(group.name) + '" data-label="' + App.escapeHtml(opt.label) + '">' +
            '<span>' + App.escapeHtml(opt.label) + '</span>' +
            (deltaText ? '<span class="sp-spec-delta">' + deltaText + '</span>' : '') +
          '</button>';
        }).join('');
        return '<div class="sp-spec-group">' +
          '<div class="sp-spec-title">' + App.escapeHtml(group.name) + (group.required ? '' : shopT('shop.spec.optional', '（可选）')) + '</div>' +
          '<div class="sp-spec-opts">' + optsHtml + '</div>' +
        '</div>';
      }).join('');

      var priceBlock = '';
      if (priceInfo.unitPrice !== product.price) {
        priceBlock = '<span class="sp-spec-baseprice">' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(product.price) }) + '</span>';
      }

      sheet.innerHTML =
        '<div class="sp-spec-mask" data-close="1"></div>' +
        '<div class="sp-spec-sheet">' +
          '<div class="sp-spec-handle"></div>' +
          '<div class="sp-spec-head">' +
            coverHtml(product, 'sp-spec-cover') +
            '<div class="sp-spec-head-info">' +
              '<div class="sp-spec-name">' + App.escapeHtml(product.name) + '</div>' +
              '<div class="sp-spec-price">' + priceBlock + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(priceInfo.unitPrice) }) + '</div>' +
              (priceInfo.specText ? '<div class="sp-spec-selected">' + shopT('shop.spec.selected', '已选：{text}', { text: App.escapeHtml(priceInfo.specText) }) + '</div>' : '') +
            '</div>' +
            '<button class="sp-spec-close" data-close="1">×</button>' +
          '</div>' +
          '<div class="sp-spec-body">' + specHtml + '</div>' +
          '<div class="sp-spec-foot">' +
            '<div class="sp-spec-stepper">' +
              '<button class="sp-spec-step" data-delta="-1">−</button>' +
              '<span class="sp-spec-qty">' + sheetQty + '</span>' +
              '<button class="sp-spec-step" data-delta="1">＋</button>' +
            '</div>' +
            '<button class="sp-spec-submit">' + shopT('shop.spec.submit', '加入购物车（积分 {total}）', { total: App.fmtPoints(priceInfo.unitPrice * sheetQty) }) + '</button>' +
          '</div>' +
        '</div>';
      bindEvents();
    }

    /** 绑定弹窗事件（每次 render 后重新绑） */
    function bindEvents() {
      // 遮罩/关闭按钮
      sheet.querySelectorAll('[data-close="1"]').forEach(function (el) {
        el.addEventListener('click', closeSheet);
      });
      // 规格选项点击
      sheet.querySelectorAll('.sp-spec-opt').forEach(function (opt) {
        opt.addEventListener('click', function () {
          selected[opt.dataset.group] = opt.dataset.label;
          render();
        });
      });
      // 数量步进
      sheet.querySelectorAll('.sp-spec-step').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var next = sheetQty + Number(btn.dataset.delta);
          sheetQty = Math.max(1, Math.min(99, next));
          render();
        });
      });
      // 提交加购
      sheet.querySelector('.sp-spec-submit').addEventListener('click', async function () {
        var priceInfo = calcPrice();
        // 校验必选规格
        for (var k = 0; k < product.specs.length; k++) {
          var g2 = product.specs[k];
          if (g2.required && !priceInfo.labels.some(function (l) { return g2.options.some(function (o) { return o.label === l; }); })) {
            App.showToast(shopT('shop.spec.requiredTip', '请选择「{name}」', { name: g2.name }), 'error');
            return;
          }
        }
        closeSheet();
        try {
          var cart = await App.api('/cart', {
            method: 'POST',
            body: { productId: product.id, specs: priceInfo.labels, quantity: sheetQty }
          });
          App.showToast(shopT('shop.cart.added', '已加入购物车'), 'success');
          applyCartView(cart);
        } catch (e) { /* 已被 api 层兜底提示 */ }
      });
    }

    /**
     * 关闭弹窗：先去掉 open 类触发退场过渡，过渡播完再移除节点
     * 等待时长需 ≥ CSS 的 0.28s，否则动画会被中途掐断
     */
    function closeSheet() {
      sheet.classList.remove('sp-spec-open');
      setTimeout(function () { if (sheet.parentNode) sheet.parentNode.removeChild(sheet); }, 300);
    }

    // 创建弹窗容器并渲染
    var sheet = document.createElement('div');
    sheet.className = 'sp-spec-root';
    document.body.appendChild(sheet);
    render();

    /* 播放进入动画：
       Firefox 中元素刚插入 DOM、样式尚未完成首次计算时直接加类，
       会把 translateY(100%) 与 translateY(0) 合并成同一个计算值，transition 不会触发。
       因此先强制同步一次布局（读取 offsetHeight），让浏览器记录「收起」初始态，再加类。 */
    void sheet.offsetHeight;
    sheet.classList.add('sp-spec-open');
  }

  /* ===== 套餐选择弹窗（美团式：分组任选 + 件数步进） ===== */

  /**
   * 判断套餐里是否存在选项加价（卡片价格需要显示「起」）
   * @param {object} product 商品
   * @returns {boolean}
   */
  function comboHasDelta(product) {
    var groups = Array.isArray(product.comboGroups) ? product.comboGroups : [];
    return groups.some(function (g) {
      return (g.options || []).some(function (o) { return (o.priceDelta || 0) > 0; });
    });
  }

  /**
   * 打开套餐选择弹窗
   * @param {object} product 套餐商品（含 comboGroups: [{name,count,options:[{label,priceDelta}]}]）
   */
  function openComboSheet(product) {
    var groups = Array.isArray(product.comboGroups) ? product.comboGroups : [];
    if (groups.length === 0) { App.showToast(shopT('shop.combo.noGroups', '该套餐暂未配置分组'), 'error'); return; }

    /** 每组固定件数（兼容旧数据 minSelect） */
    function groupCount(g) {
      var n = g.count != null ? Number(g.count) : Number(g.minSelect);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    /** 每组已选数量：selected[组下标][选项名] = 件数 */
    var selected = groups.map(function (g) {
      var map = {};
      /* 默认预选：用第一个选项填满该组固定件数，买家可再增减 */
      var need = groupCount(g);
      if (need > 0 && g.options.length > 0) map[g.options[0].label] = need;
      return map;
    });
    /** 购买份数（弹窗底部步进器控制） */
    var sheetQty = 1;

    /**
     * 取某组当前已选总件数
     * @param {number} gi 分组下标
     * @returns {number}
     */
    function groupTotal(gi) {
      var map = selected[gi] || {};
      return Object.keys(map).reduce(function (n, k) { return n + map[k]; }, 0);
    }

    /**
     * 展平为接口所需的 combo 明细数组
     * @returns {Array<{groupName:string,label:string,count:number}>}
     */
    function flattenSelections() {
      var list = [];
      groups.forEach(function (g, gi) {
        var map = selected[gi] || {};
        Object.keys(map).forEach(function (label) {
          if (map[label] > 0) list.push({ groupName: g.name, label: label, count: map[label] });
        });
      });
      return list;
    }

    /**
     * 根据当前选择计算单价：套餐价 + Σ(选项加价 × 件数)
     * @returns {number}
     */
    function calcPrice() {
      var delta = 0;
      flattenSelections().forEach(function (s) {
        var g = groups.find(function (x) { return x.name === s.groupName; });
        if (!g) return;
        var opt = g.options.find(function (o) { return o.label === s.label; });
        if (opt) delta += (opt.priceDelta || 0) * s.count;
      });
      return Math.round((product.price + delta) * 100) / 100;
    }

    /**
     * 找出第一个件数不等于固定件数的分组
     * @returns {object|null} 不满足的分组；全部满足返回 null
     */
    function firstInvalidGroup() {
      for (var i = 0; i < groups.length; i++) {
        if (groupTotal(i) !== groupCount(groups[i])) return groups[i];
      }
      return null;
    }

    /** 渲染弹窗内容 */
    function render() {
      var unitPrice = calcPrice();
      var invalid = firstInvalidGroup();
      var itemCount = groups.reduce(function (n, g, gi) { return n + groupTotal(gi); }, 0);

      var groupHtml = groups.map(function (g, gi) {
        var total = groupTotal(gi);
        var need = groupCount(g);
        var ruleText = need > 0 ? shopT('shop.combo.ruleFixed', '选 {count} 件', { count: need }) : shopT('shop.combo.ruleFree', '可不选');
        var lackText = need > 0 && total < need ? shopT('shop.combo.lack', ' · 还差 {count} 件', { count: need - total }) : '';
        var optsHtml = g.options.map(function (opt) {
          var count = (selected[gi] && selected[gi][opt.label]) || 0;
          var delta = opt.priceDelta || 0;
          var deltaText = delta !== 0
            ? (delta > 0
                ? shopT('shop.combo.priceDeltaUp', ' +{points} 积分', { points: App.fmtPoints(delta) })
                : shopT('shop.combo.priceDeltaDown', ' -{points} 积分', { points: App.fmtPoints(-delta) }))
            : '';
          return '<div class="sp-combo-opt' + (count > 0 ? ' active' : '') + '">' +
            '<div class="sp-combo-opt-info">' +
              '<span class="sp-combo-opt-label">' + App.escapeHtml(opt.label) + '</span>' +
              (deltaText ? '<span class="sp-combo-opt-delta">' + deltaText + '</span>' : '') +
            '</div>' +
            '<div class="sp-combo-stepper">' +
              '<button class="sp-combo-step" data-group="' + gi + '" data-label="' + App.escapeHtml(opt.label) + '" data-delta="-1"' + (count <= 0 ? ' disabled' : '') + '>−</button>' +
              '<span class="sp-combo-num">' + count + '</span>' +
              '<button class="sp-combo-step" data-group="' + gi + '" data-label="' + App.escapeHtml(opt.label) + '" data-delta="1"' + (total >= need ? ' disabled' : '') + '>＋</button>' +
            '</div>' +
          '</div>';
        }).join('');
        return '<div class="sp-combo-group">' +
          '<div class="sp-combo-group-head">' +
            '<span class="sp-combo-group-name">' + App.escapeHtml(g.name) + '</span>' +
            '<span class="sp-combo-rule' + (total < need ? ' sp-combo-lack' : '') + '">' + ruleText + lackText + '</span>' +
          '</div>' +
          '<div class="sp-combo-opts">' + optsHtml + '</div>' +
        '</div>';
      }).join('');

      sheet.innerHTML =
        '<div class="sp-spec-mask" data-close="1"></div>' +
        '<div class="sp-spec-sheet sp-combo-sheet">' +
          '<div class="sp-spec-handle"></div>' +
          '<div class="sp-spec-head">' +
            coverHtml(product, 'sp-spec-cover') +
            '<div class="sp-spec-head-info">' +
              '<div class="sp-spec-name"><span class="sp-combo-tag">' + shopT('shop.goods.comboTag', '套餐') + '</span>' + App.escapeHtml(product.name) + '</div>' +
              '<div class="sp-spec-price">' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(unitPrice) }) + '</div>' +
              '<div class="sp-spec-selected">' + shopT('shop.combo.perSet', '每份共 {count} 件', { count: itemCount }) + '</div>' +
            '</div>' +
            '<button class="sp-spec-close" data-close="1">×</button>' +
          '</div>' +
          '<div class="sp-spec-body sp-combo-body">' + groupHtml + '</div>' +
          '<div class="sp-spec-foot">' +
            '<div class="sp-spec-stepper">' +
              '<button class="sp-spec-step" data-qty="-1">−</button>' +
              '<span class="sp-spec-qty">' + sheetQty + '</span>' +
              '<button class="sp-spec-step" data-qty="1">＋</button>' +
            '</div>' +
            '<button class="sp-spec-submit" id="sp-combo-submit"' + (invalid ? ' disabled' : '') + '>' +
              (invalid
                ? shopT('shop.combo.submitMissing', '请选满「{name}」', { name: App.escapeHtml(invalid.name) })
                : shopT('shop.spec.submit', '加入购物车（积分 {total}）', { total: App.fmtPoints(unitPrice * sheetQty) })) +
            '</button>' +
          '</div>' +
        '</div>';
      bindEvents();
    }

    /** 绑定弹窗事件（每次 render 后重新绑） */
    function bindEvents() {
      sheet.querySelectorAll('[data-close="1"]').forEach(function (el) {
        el.addEventListener('click', closeSheet);
      });

      /* 套餐选项件数步进：达到该组固定件数时 ＋ 禁用，为 0 时 − 禁用 */
      sheet.querySelectorAll('.sp-combo-step').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var gi = Number(btn.dataset.group);
          var label = btn.dataset.label;
          var map = selected[gi];
          var next = (map[label] || 0) + Number(btn.dataset.delta);
          if (next <= 0) delete map[label];
          else map[label] = Math.min(next, groupCount(groups[gi]));
          render();
        });
      });

      /* 购买份数步进 */
      sheet.querySelectorAll('.sp-spec-step[data-qty]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          sheetQty = Math.max(1, Math.min(99, sheetQty + Number(btn.dataset.qty)));
          render();
        });
      });

      /* 提交加购 */
      var submit = sheet.querySelector('#sp-combo-submit');
      if (submit) {
        submit.addEventListener('click', async function () {
          var bad = firstInvalidGroup();
          if (bad) {
            App.showToast(shopT('shop.combo.badGroupTip', '「{name}」需选 {count} 件', { name: bad.name, count: groupCount(bad) }), 'error');
            return;
          }
          var payload = flattenSelections();               // 套餐明细快照
          closeSheet();
          try {
            var cart = await App.api('/cart', {
              method: 'POST',
              body: { productId: product.id, combo: payload, quantity: sheetQty }
            });
            App.showToast(shopT('shop.cart.added', '已加入购物车'), 'success');
            applyCartView(cart);
          } catch (e) { /* 已被 api 层兜底提示 */ }
        });
      }
    }

    /** 关闭弹窗：先退场动画再移除节点（等待时长需 ≥ CSS 0.28s） */
    function closeSheet() {
      sheet.classList.remove('sp-spec-open');
      setTimeout(function () { if (sheet.parentNode) sheet.parentNode.removeChild(sheet); }, 300);
    }

    /* 创建弹窗容器并渲染 */
    var sheet = document.createElement('div');
    sheet.className = 'sp-spec-root sp-combo-root';
    document.body.appendChild(sheet);
    render();

    /* 强制同步一次布局，让浏览器记录 translateY(100%) 初始态后再加 open 类（Firefox 需要） */
    void sheet.offsetHeight;
    sheet.classList.add('sp-spec-open');
  }

  /** 用接口返回的 cart 同步角标和结算条 */
  function applyCartView(cart) {
    var badge = $('#cart-badge');
    if (badge) {
      badge.textContent = String(cart.count);
      badge.classList.toggle('hidden', cart.count === 0);
    }
    $('#cartbar-count').textContent = shopT('shop.cart.barCount', '🛒 {count}', { count: cart.count });
    $('#cartbar-total').textContent = shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(cart.totalAmount) });
    $('#cartbar').classList.toggle('hidden', cart.count === 0);
  }

  /* ===== 视图：首页 ===== */

  /** 渲染首页：分类筛选 + 店铺网格 */
  async function renderHome() {
    showSection('view-home');
    setTopbarActions([]);                                   // 首页无主操作
    var data = await Promise.all([App.api('/shops'), App.api('/products')]);
    var shops = data[0], products = data[1];
    var cats = [...new Set(shops.map(function (s) { return s.category; }).filter(Boolean))];

    // 分类 chips：首项为「全部」（data-cat 为空字符串表示不筛选，避免把展示文案当筛选值）
    var catBox = $('#home-cats');
    catBox.innerHTML = [''].concat(cats).map(function (c) {
      var label = c ? App.escapeHtml(c) : shopT('shop.cats.all', '全部');
      return '<button class="sp-chip ' + (c === homeFilterCat ? 'active' : '') + '" data-cat="' + App.escapeHtml(c) + '">' + label + '</button>';
    }).join('');
    catBox.querySelectorAll('.sp-chip').forEach(function (chip) {
      chip.addEventListener('click', function () { homeFilterCat = chip.dataset.cat; renderHome(); });
    });

    // 关键词搜索
    var q = $('#home-search').value.trim();
    var filtered = shops.filter(function (s) {
      var catOk = !homeFilterCat || s.category === homeFilterCat;
      if (!catOk) return false;
      if (!q) return true;
      return s.name.includes(q) || (s.description || '').includes(q)
        || products.some(function (p) { return p.shopId === s.id && p.name.includes(q); });
    });

    var grid = $('#shop-grid');
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="sp-empty">' + shopT('shop.home.empty', '没有找到匹配的店铺，换个关键词试试～') + '</div>';
      return;
    }
    grid.innerHTML = filtered.map(function (s) {
      var count = products.filter(function (p) { return p.shopId === s.id; }).length;
      return '<a class="shop-card" href="/shop/shop/' + s.id + '">' +
        coverHtml(s, 'sp-cover-shop') +
        '<div class="shop-card-body">' +
          '<div class="shop-card-name">' + App.escapeHtml(s.name) + (s.seized ? '<span class="badge error status-badge">' + shopT('shop.shopBadge.seized', '已查封') + '</span>' : (s.isOpen === false ? '<span class="badge error status-badge">' + shopT('shop.shopBadge.resting', '休息中') + '</span>' : '')) + '</div>' +
          '<div class="shop-card-desc">' + App.escapeHtml(s.description || '') + '</div>' +
          '<div class="shop-card-meta">' +
            '<span class="sp-tag">' + App.escapeHtml(s.category || shopT('shop.shop.categoryFallback', '综合')) + '</span>' +
            '<span>' + shopT('shop.shop.itemCount', '{count} 件商品', { count: count }) + '</span>' +
          '</div>' +
        '</div>' +
      '</a>';
    }).join('');
  }

  /* ===== 视图：店铺详情 ===== */

  /** 渲染店铺详情页 */
  async function renderShop(shopId) {
    showSection('view-shop');
    shopFilterCat = '';
    var shop = await App.api('/shops/' + shopId);
    $('#shop-head').innerHTML =
      coverHtml(shop, 'sp-cover-shop') +
      '<div class="sp-shop-info">' +
        '<div class="sp-shop-name">' + App.escapeHtml(shop.name) + '</div>' +
        '<div class="sp-shop-desc">' + App.escapeHtml(shop.description || '') + '</div>' +
        '<span class="sp-tag">' + App.escapeHtml(shop.category || shopT('shop.shop.categoryFallback', '综合')) + '</span>' +
      '</div>';
    /* 返回首页：顶栏最左的返回图标按钮 */
    setTopbarActions([{ icon: ICONS.back, title: shopT('shop.common.back', '返回'), back: true, onClick: function () { navigate('/'); } }]);

    var products = await App.api('/products?shopId=' + encodeURIComponent(shopId));
    var cats = [...new Set(products.map(function (p) { return p.category; }).filter(Boolean))];
    var catBox = $('#shop-cats');
    catBox.innerHTML = cats.length === 0 ? '' : [''].concat(cats).map(function (c) {
      var label = c ? App.escapeHtml(c) : shopT('shop.cats.all', '全部');
      return '<button class="sp-chip ' + (c === shopFilterCat ? 'active' : '') + '" data-cat="' + App.escapeHtml(c) + '">' + label + '</button>';
    }).join('');
    catBox.querySelectorAll('.sp-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        shopFilterCat = chip.dataset.cat;
        catBox.querySelectorAll('.sp-chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
        paintGoods();
      });
    });

    /** 按当前分类筛选重绘商品网格 */
    function paintGoods() {
      var list = products.filter(function (p) { return !shopFilterCat || p.category === shopFilterCat; });
      var grid = $('#goods-grid');
      if (list.length === 0) {
        grid.innerHTML = '<div class="sp-empty">' + shopT('shop.shop.emptyGoods', '这家店暂时没有商品～') + '</div>';
        return;
      }
      grid.innerHTML = list.map(function (p) {
        var hasSpecs = p.specs && Array.isArray(p.specs) && p.specs.length > 0;
        /* 套餐商品价格可能因加价选项浮动，显示「起」 */
        var priceSuffix = (p.isCombo && comboHasDelta(p)) ? shopT('shop.goods.priceFrom', '起') : '';
        // 套餐标「套餐」角标，有规格商品标「选规格」角标
        var specBadge = p.isCombo
          ? '<span class="goods-combo-tip">' + shopT('shop.goods.comboTag', '套餐') + '</span>'
          : (hasSpecs ? '<span class="goods-spec-tip">' + shopT('shop.goods.specTag', '选规格') + '</span>' : '');
        return '<div class="goods-card">' +
          coverHtml(p) +
          '<div class="goods-name">' + App.escapeHtml(p.name) + '</div>' +
          '<div class="goods-desc">' + App.escapeHtml(p.description || '') + '</div>' +
          '<div class="goods-foot">' +
            '<span class="goods-price">' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(p.price) }) + priceSuffix + specBadge + '</span>' +
            '<span class="goods-sales">' + shopT('shop.goods.sales', '已售 {count}', { count: p.sales || 0 }) + '</span>' +
            '<button class="sp-add-btn" data-id="' + p.id + '" title="' + shopT('shop.goods.addToCartTitle', '加入购物车') + '">' + ICONS.plus + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
      // 绑定 click handler（闭包捕获商品对象，避免每次点击遍历 list）
      grid.querySelectorAll('.sp-add-btn').forEach(function (btn) {
        var pid = btn.dataset.id;
        var product = list.find(function (x) { return x.id === pid; });
        if (!product) return;
        btn.addEventListener('click', function () { addToCart(product).catch(function () {}); });
      });
    }
    paintGoods();
  }

  /* ===== 视图：购物车 ===== */

  /** 渲染购物车：按店铺分组 + 上门取货确认 + 提交订单 */
  async function renderCart() {
    showSection('view-cart', { hideCartbar: true });
    var cart = await App.api('/cart');
    applyCartView(cart);

    var listBox = $('#cart-list');
    if (cart.items.length === 0) {
      listBox.innerHTML = '<div class="sp-empty">' + shopT('shop.cart.emptyPrefix', '购物车空空如也，') +
        '<a href="/shop/">' + shopT('shop.cart.goShopping', '去逛逛店铺 →') + '</a></div>';
      $('#cart-checkout').innerHTML = '';
      setTopbarActions([]);                                   // 空购物车没有可执行的主操作
      return;
    }

    // 按店铺分组
    var groups = new Map();
    for (var i = 0; i < cart.items.length; i++) {
      var it = cart.items[i];
      if (!groups.has(it.shopName)) groups.set(it.shopName, []);
      groups.get(it.shopName).push(it);
    }
    listBox.innerHTML = [...groups.entries()].map(function (pair) {
      var shopName = pair[0], items = pair[1];
      return '<div class="cart-group">' +
        '<div class="cart-group-title">' + App.escapeHtml(shopName) + '</div>' +
        items.map(function (it) {
          /* 套餐展示「套餐：主食：牛肉面×1；饮品：可乐×2」，普通商品展示「规格：大份/加冰」 */
          var specBadge = it.isCombo
            ? (it.comboText ? '<div class="cart-row-spec">' + shopT('shop.cart.comboLabel', '套餐：{text}', { text: App.escapeHtml(it.comboText) }) + '</div>' : '')
            : (it.specText ? '<div class="cart-row-spec">' + shopT('shop.cart.specLabel', '规格：{text}', { text: App.escapeHtml(it.specText) }) + '</div>' : '');
          // 原价（有规格/套餐加价时显示划线对比）
          var baseLine = (it.specText || it.comboText) && it.unitPrice !== it.basePrice
            ? '<span class="cart-row-baseprice">' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(it.basePrice) }) + '</span>'
            : '';
          return '<div class="cart-row" data-linekey="' + App.escapeHtml(it.lineKey) + '">' +
            coverHtml(it, 'sp-cover-sm') +
            '<div class="cart-row-main">' +
              '<div class="cart-row-name">' + App.escapeHtml(it.name) + '</div>' +
              specBadge +
              '<div class="cart-row-price">' + baseLine + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(it.unitPrice) }) + '</div>' +
            '</div>' +
            '<div class="sp-stepper">' +
              '<button class="step-btn" data-delta="-1">−</button>' +
              '<span class="step-num">' + it.quantity + '</span>' +
              '<button class="step-btn" data-delta="1">＋</button>' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');

    // 数量步进（用 lineKey 定位，兼容多规格同一商品）
    listBox.querySelectorAll('.cart-row').forEach(function (row) {
      var lineKey = row.dataset.linekey;
      row.querySelectorAll('.step-btn').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var numEl = row.querySelector('.step-num');
          var next = Number(numEl.textContent) + Number(btn.dataset.delta);
          var cart2 = await App.api('/cart/line/' + encodeURIComponent(lineKey), { method: 'PUT', body: { quantity: next } });
          if (cart2.count === 0) { renderCart(); return; }
          applyCartView(cart2);
          renderCart();
        });
      });
    });

    // 结算区（提交订单按钮已移到顶栏，这里只保留取货方式/备注/合计）
    var checkout = $('#cart-checkout');
    checkout.innerHTML =
      '<div class="sp-checkout-row"><label>' + shopT('shop.cart.pickupMethod', '取货方式') + '</label><span>' + shopT('shop.cart.pickupValue', '🚶 上门取货（到店自提，无需地址）') + '</span></div>' +
      '<div class="sp-checkout-row"><label>' + shopT('shop.cart.noteLabel', '备注') + '</label><input type="text" id="order-note" maxlength="100" placeholder="' + shopT('shop.cart.notePlaceholder', '选填，如：课间来取') + '"></div>' +
      '<div class="sp-checkout-row sp-checkout-total"><span>' + shopT('shop.cart.total', '合计') + '</span><strong>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(cart.totalAmount) }) + '</strong></div>';

    /** 提交购物车为订单，成功后跳到订单详情 */
    async function submitOrder() {
      var order = await App.api('/orders', {
        method: 'POST',
        body: { note: $('#order-note').value }
      });
      App.showToast(shopT('shop.cart.orderSuccess', '下单成功！'), 'success');
      await refreshCartBadge();
      navigate('/order/' + order.id);
    }

    /* 提交订单：顶栏主按钮（对勾图标） */
    setTopbarActions([{ icon: ICONS.check, title: shopT('shop.cart.submitTitle', '提交订单'), onClick: submitOrder }]);
  }

  /* ===== 视图：我的订单 ===== */

  /** 渲染订单列表（普通用户看自己的；管理员后台看全部） */
  async function renderOrders(adminMode) {
    adminMode = adminMode || false;
    showSection(adminMode ? null : 'view-orders', { hideCartbar: true });
    if (!adminMode) setTopbarActions([]);                     // 我的订单无主操作
    var orders = await App.api(adminMode ? '/orders?all=1' : '/orders');
    var box = $('#orders-list');
    if (orders.length === 0) {
      box.innerHTML = '<div class="sp-empty">' + shopT('shop.order.emptyPrefix', '还没有订单，') +
        '<a href="/shop/">' + shopT('shop.cart.goShopping', '去逛逛店铺 →') + '</a></div>';
      return;
    }
    box.innerHTML = orders.map(orderCardHtml).join('');
    bindOrderCardEvents(box);
  }

  /** 单张订单卡片 HTML */
  function orderCardHtml(o) {
    var first = o.items[0];
    var more = o.items.length > 1 ? shopT('shop.order.moreItems', ' 等{count}种商品', { count: o.items.length }) : '';
    return '<a class="order-card" href="/shop/order/' + o.id + '">' +
      '<div class="order-card-top">' +
        '<span class="order-no">' + shopT('shop.order.no', '单号 {id}', { id: App.escapeHtml(o.id) }) + '</span>' +
        '<span class="order-card-badges">' + statusBadge(o.status) + refundBadge(o) + '</span>' +
      '</div>' +
      '<div class="order-card-mid">' +
        coverHtml(first, 'sp-cover-sm') +
        '<div>' +
          '<div>' + App.escapeHtml(first.productName) + (more ? '<span class="order-more">' + more + '</span>' : '') + '</div>' +
          '<div class="order-time">' + App.escapeHtml((o.createdAt || '').replace('T', ' ').slice(0, 16)) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="order-card-bottom">' +
        '<span>' + shopT('shop.order.itemCount', '共 {count} 件', { count: o.items.reduce(function (s, it) { return s + it.quantity; }, 0) }) + '</span>' +
        '<strong>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(o.totalAmount) }) + '</strong>' +
      '</div>' +
    '</a>';
  }

  /** 绑定订单卡片取消按钮 */
  function bindOrderCardEvents(box) {
    box.querySelectorAll('[data-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var oid = btn.dataset.cancel;
        confirmDanger(shopT('shop.order.cancelConfirm', '确定要取消这个订单吗？'), async function () {
          await App.api('/orders/' + oid + '/cancel', { method: 'POST' });
          App.showToast(shopT('shop.order.cancelled', '订单已取消'), 'success');
          refreshCartBadge();
          renderOrders();
        });
      });
    });
  }

  /* ===== 视图：订单详情 ===== */

  /** 渲染订单详情 */
  async function renderOrder(orderId) {
    showSection('view-order', { hideCartbar: true });
    /* 订单详情：顶栏最左的返回图标按钮 */
    setTopbarActions([{ icon: ICONS.back, title: shopT('shop.common.back', '返回'), back: true, onClick: function () { history.back(); } }]);
    var o = await App.api('/orders/' + orderId);
    $('#order-detail').innerHTML =
      '<div class="sp-panel">' +
        '<div class="sp-panel-head"><h3>' + shopT('shop.order.detailTitle', '订单 {id}', { id: App.escapeHtml(o.id) }) + '</h3>' + statusBadge(o.status) + '</div>' +
        '<div class="sp-panel-body">' +
          o.items.map(function (it) {
            var specBadge = it.isCombo
              ? (it.comboText ? '<div class="cart-row-spec">' + shopT('shop.cart.comboLabel', '套餐：{text}', { text: App.escapeHtml(it.comboText) }) + '</div>' : '')
              : (it.specText ? '<div class="cart-row-spec">' + shopT('shop.cart.specLabel', '规格：{text}', { text: App.escapeHtml(it.specText) }) + '</div>' : '');
            return '<div class="cart-row">' +
              coverHtml(it, 'sp-cover-sm') +
              '<div class="cart-row-main">' +
                '<div class="cart-row-name">' + App.escapeHtml(it.productName) + '<span class="order-more">' + App.escapeHtml(it.shopName) + '</span></div>' +
                specBadge +
                '<div class="cart-row-price">' + shopT('shop.order.unitPriceLine', '{points} 积分 × {quantity}', { points: App.fmtPoints(it.price), quantity: it.quantity }) + '</div>' +
              '</div>' +
              '<strong>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(it.price * it.quantity) }) + '</strong>' +
            '</div>';
          }).join('') +
          '<div class="sp-order-meta">' +
            '<div>' + shopT('shop.order.pickupMeta', '取货方式：🚶 上门取货（到店自提）') + '</div>' +
            (o.note ? '<div>' + shopT('shop.order.noteMeta', '备注：{note}', { note: App.escapeHtml(o.note) }) + '</div>' : '') +
            '<div>' + shopT('shop.order.createdAt', '下单时间：{time}', { time: App.escapeHtml((o.createdAt || '').replace('T', ' ').slice(0, 16)) }) + '</div>' +
            '<div class="sp-order-total">' + shopT('shop.order.totalLabel', '合计') + ' <strong>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(o.totalAmount) }) + '</strong></div>' +
          '</div>' +
          refundBoxHtml(o) +
          (o.status === 'pending' ? '<div class="sp-panel-actions"><button class="btn btn-column5" id="order-cancel-btn">' + shopT('shop.order.cancelBtn', '取消订单') + '</button></div>' : '') +
        '</div>' +
      '</div>';
    var refundBtn = $('#order-refund-btn');
    if (refundBtn) {
      refundBtn.addEventListener('click', function () { openRefundApply(orderId); });
    }
    var cancelBtn = $('#order-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        confirmDanger(shopT('shop.order.cancelConfirm', '确定要取消这个订单吗？'), async function () {
          await App.api('/orders/' + orderId + '/cancel', { method: 'POST' });
          App.showToast(shopT('shop.order.cancelled', '订单已取消'), 'success');
          renderOrder(orderId);
        });
      });
    }
  }

  /**
   * 打开退款申请弹窗：填写理由后提交，订单进入待审核状态
   * @param {string} orderId 订单 id
   */
  function openRefundApply(orderId) {
    openModal({
      title: shopT('shop.order.refundModalTitle', '申请退款'),
      body:
        '<p class="sp-modal-tip">' + shopT('shop.order.refundModalTip', '提交后需管理员审核，审核通过后才会把积分退回你的账户。') + '</p>' +
        '<div class="sp-field"><label>' + shopT('shop.order.refundReasonLabel', '退款理由（选填）') + '</label><input id="refund-reason" maxlength="100" type="text" placeholder="' + shopT('shop.order.refundReasonPlaceholder', '例如：商品与描述不符') + '"></div>',
      confirmText: shopT('shop.order.refundSubmit', '提交申请'),
      onConfirm: async function () {
        var reason = ($('#refund-reason').value || '').trim();
        await App.api('/orders/' + orderId + '/refund', { method: 'POST', body: { reason: reason } });
        App.showToast(shopT('shop.order.refundSubmitted', '退款申请已提交，等待管理员审核'), 'success');
        renderOrder(orderId);
      }
    });
  }

  /* ===== 视图：我的店铺 ===== */

  /** 渲染我的店铺列表（商品管理为每个店铺单独的页面） */
  async function renderMyShops() {
    showSection('view-myshops', { hideCartbar: true });
    /* 开新店铺：顶栏主按钮（加号图标） */
    setTopbarActions([{ icon: ICONS.plus, title: shopT('shop.myshops.newShop', '开新店铺'), onClick: function () { openShopForm(null, renderMyShops); } }]);
    var shops = await App.api('/shops?mine=1');
    var list = $('#myshop-list');

    if (shops.length === 0) {
      list.innerHTML = '<div class="sp-empty">' + shopT('shop.myshops.empty', '你还没有开店，点顶栏的 ＋ 当老板吧！') + '</div>';
      return;
    }

    var products = await App.api('/products');
    /* 卡片结构严格按参考稿 117_6：封面 → 店名/副标题 → 营业状态标签 → 灰色「管理商品」方块 */
    list.innerHTML = shops.map(function (s) {
      var count = products.filter(function (p) { return p.shopId === s.id; }).length;
      return '<div class="myshop-card" data-id="' + s.id + '">' +
        coverHtml(s, 'sp-cover-sm') +
        '<div class="myshop-main">' +
          '<div class="myshop-name">' + App.escapeHtml(s.name) + '</div>' +
          '<div class="myshop-sub">' + shopT('shop.myshops.metaLine', '{category} · {count} 件商品', { category: App.escapeHtml(s.category || shopT('shop.shop.categoryFallback', '综合')), count: count }) + '</div>' +
        '</div>' +
        /* 营业状态标签：点击即切换「营业 / 休息」 */
        '<button class="sp-status-chip ' + (s.seized ? 'closed' : (s.isOpen ? 'open' : 'closed')) + '" data-toggle="' + s.id + '" title="' + (s.seized ? shopT('shop.myshops.toggleBlocked', '店铺已被查封，无法切换营业状态') : shopT('shop.myshops.toggleHint', '点击切换营业状态')) + '"' + (s.seized ? ' disabled' : '') + '>' +
          (s.seized ? shopT('shop.myshops.seized', '已查封') : (s.isOpen ? shopT('shop.myshops.open', '营业') : shopT('shop.myshops.rest', '休息'))) +
        '</button>' +
        /* 蓝色按钮（多邻国风格）：进入该店铺单独的「店铺管理」页面 */
        '<button class="sp-manage-block" data-manage="' + s.id + '">' + shopT('shop.myshops.manageProducts', '管理商品') + '</button>' +
      '</div>';
    }).join('');

    list.querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var shop = shops.find(function (s) { return s.id === btn.dataset.toggle; });
        await App.api('/shops/' + shop.id, { method: 'PUT', body: { isOpen: !shop.isOpen } });
        App.showToast(shop.isOpen ? shopT('shop.myshops.rested', '店铺已休息') : shopT('shop.myshops.opened', '店铺已营业'), 'success');
        renderMyShops();
      });
    });
    list.querySelectorAll('[data-manage]').forEach(function (btn) {
      btn.addEventListener('click', function () { navigate('/myshops/' + btn.dataset.manage + '/products'); });
    });
  }

  /**
   * 渲染单个店铺的商品管理页（店主视图，每个店铺各自独立一页）
   * @param {string} shopId 店铺 id
   */
  async function renderMyShopProducts(shopId) {
    showSection('view-shop-products', { hideCartbar: true });
    var shops = await App.api('/shops?mine=1');
    var shop = shops.find(function (s) { return s.id === shopId; });
    var box = $('#myshop-products');
    if (!shop) {
      box.innerHTML = '<div class="sp-empty">' + shopT('shop.myshops.noPermission', '店铺不存在或无权管理') + '</div>';
      return;
    }
    /* 店铺编辑：复用店铺表单弹窗，保存后刷新本页数据 */
    var openEdit = function () {
      openShopForm(shop, function () { renderMyShopProducts(shopId); });
    };
    /* 店铺删除：确认后连同商品一起删除并回到我的店铺列表 */
    var delShop = function () {
      confirmDanger(shopT('shop.myshops.deleteConfirm', '删除店铺会连带删除其全部商品，确定删除？'), async function () {
        await App.api('/shops/' + shop.id, { method: 'DELETE' });
        App.showToast(shopT('shop.myshops.deleted', '店铺已删除'), 'success');
        navigate('/myshops');
      });
    };
    /* 顶栏：返回（最左）→ 编辑店铺 / 删除店铺 / 新增商品（右侧，与头像间隔 16px） */
    setTopbarActions([
      { icon: ICONS.back, title: shopT('shop.common.back', '返回'), back: true, onClick: function () { navigate('/myshops'); } },
      { icon: ICONS.edit, title: shopT('shop.shopForm.editTitle', '编辑店铺'), onClick: openEdit },
      { icon: ICONS.trash, title: shopT('shop.myshops.deleteShop', '删除店铺'), onClick: delShop },
      {
        icon: ICONS.plus,
        title: shopT('shop.myshops.newProduct', '新增商品'),
        onClick: function () { navigate('/admin/product/new?from=myshops&shopId=' + encodeURIComponent(shopId)); }
      }
    ]);
    var products = await App.api('/products?shopId=' + encodeURIComponent(shopId));
    /* 页面结构严格按参考稿 131_89：整宽店铺信息条（下圆角） + 商品内容区 */
    box.innerHTML =
      '<div class="sp-shopmgmt-head">' +
        coverHtml(shop, 'sp-cover-sm') +
        '<div class="myshop-main">' +
          '<div class="sp-shopmgmt-name">' + App.escapeHtml(shop.name) + '</div>' +
          '<div class="sp-shopmgmt-sub">' + shopT('shop.myshops.metaLine', '{category} · {count} 件商品', { category: App.escapeHtml(shop.category || shopT('shop.shop.categoryFallback', '综合')), count: products.length }) + '</div>' +
        '</div>' +
        '<span class="sp-status-chip ' + (shop.seized ? 'closed' : (shop.isOpen ? 'open' : 'closed')) + '">' + (shop.seized ? shopT('shop.myshops.seized', '已查封') : (shop.isOpen ? shopT('shop.myshops.open', '营业') : shopT('shop.myshops.rest', '休息'))) + '</span>' +
      '</div>' +
      '<div class="sp-shopmgmt-body">' +
        (products.length === 0
          ? '<div class="sp-empty">' + shopT('shop.myshops.noProducts', '还没有商品，点顶栏的 ＋ 上架第一件好物') + '</div>'
          : '<div class="sp-table-wrap"><table class="sp-table">' +
              '<thead><tr><th>' + shopT('shop.table.product', '商品') + '</th><th>' + shopT('shop.table.category', '分类') + '</th><th>' + shopT('shop.table.price', '价格') + '</th><th>' + shopT('shop.table.sales', '销量') + '</th><th>' + shopT('shop.table.status', '状态') + '</th><th>' + shopT('shop.table.actions', '操作') + '</th></tr></thead>' +
              '<tbody>' +
                products.map(function (p) {
                  return '<tr>' +
                    '<td>' + coverHtml(p, 'sp-cover-xs') + ' ' + App.escapeHtml(p.name) + '</td>' +
                    '<td>' + App.escapeHtml(p.category) + '</td>' +
                    '<td>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(p.price) }) + '</td>' +
                    '<td>' + (p.sales || 0) + '</td>' +
                    '<td>' + (p.isAvailable ? shopT('shop.product.onSale', '在售') : '<span class="sp-danger">' + shopT('shop.product.offSale', '已下架') + '</span>') + '</td>' +
                    '<td class="sp-row-actions">' +
                      '<button class="btn btn-column5" data-edit="' + p.id + '">' + shopT('shop.common.edit', '编辑') + '</button>' +
                      '<button class="btn btn-column5" data-toggle="' + p.id + '">' + (p.isAvailable ? shopT('shop.product.delist', '下架') : shopT('shop.product.relist', '上架')) + '</button>' +
                      '<button class="btn btn-column5 sp-danger" data-del="' + p.id + '">' + shopT('shop.common.delete', '删除') + '</button>' +
                    '</td>' +
                  '</tr>';
                }).join('') +
              '</tbody>' +
            '</table></div>') +
      '</div>';

    box.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { navigate('/admin/product/' + btn.dataset.edit + '?from=myshops&shopId=' + encodeURIComponent(shopId)); });
    });
    box.querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var p = products.find(function (x) { return x.id === btn.dataset.toggle; });
        await App.api('/products/' + p.id, { method: 'PUT', body: { isAvailable: !p.isAvailable } });
        App.showToast(p.isAvailable ? shopT('shop.product.delisted', '已下架') : shopT('shop.product.relisted', '已上架'), 'success');
        renderMyShopProducts(shopId);
      });
    });
    box.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmDanger(shopT('shop.product.deleteConfirm', '删除商品会同时从所有用户购物车移除，确定删除？'), async function () {
          await App.api('/products/' + btn.dataset.del, { method: 'DELETE' });
          App.showToast(shopT('shop.product.deleted', '商品已删除'), 'success');
          renderMyShopProducts(shopId);
        });
      });
    });
  }

  /* ===== 视图：管理后台 ===== */

  /** 当前管理 tab */
  var adminTab = 'products';

  /** 管理后台入口：按当前 tab 分发 */
  async function renderAdmin() {
    var me = await App.initMe();
    if (!me.loggedIn || !me.isAdmin) {
      showSection('view-admin', { hideCartbar: true });
      setTopbarActions([]);
      $('.sp-admin-tabs').hidden = true;
      ['admin-products', 'admin-shops', 'admin-orders'].forEach(function (id) { $('#' + id).hidden = false; });
      $('#admin-products').innerHTML = '<div class="sp-empty">' + shopT('shop.admin.onlyAdmin', '此页面仅管理员可见') + '</div>';
      $('#admin-shops').hidden = true;
      $('#admin-orders').hidden = true;
      return;
    }
    $('.sp-admin-tabs').hidden = false;
    showSection('view-admin', { hideCartbar: true });
    $('.sp-admin-tabs').querySelectorAll('.sp-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === adminTab);
    });
    $('#admin-products').hidden = adminTab !== 'products';
    $('#admin-shops').hidden = adminTab !== 'shops';
    $('#admin-orders').hidden = adminTab !== 'orders';

    /* 顶栏主按钮随 tab 切换：商品管理=新增商品，店铺管理=新增店铺，订单管理无 */
    if (adminTab === 'products') {
      setTopbarActions([{ icon: ICONS.plus, title: shopT('shop.myshops.newProduct', '新增商品'), onClick: function () { navigate('/admin/product/new'); } }]);
    } else if (adminTab === 'shops') {
      setTopbarActions([{ icon: ICONS.plus, title: shopT('shop.admin.newShopBtn', '新增店铺'), onClick: function () { openShopForm(null, renderAdminShops); } }]);
    } else {
      setTopbarActions([]);
    }

    if (adminTab === 'products') await renderAdminProducts();
    if (adminTab === 'shops') await renderAdminShops();
    if (adminTab === 'orders') await renderAdminOrders();
  }

  /** 管理：商品表格 + CRUD */
  async function renderAdminProducts() {
    var data = await Promise.all([App.api('/products'), App.api('/shops')]);
    var products = data[0], shops = data[1];
    var shopName = function (id) { var s = shops.find(function (x) { return x.id === id; }); return s ? s.name : '—'; };
    $('#product-table').innerHTML =
      '<table class="sp-table"><thead><tr><th>' + shopT('shop.table.product', '商品') + '</th><th>' + shopT('shop.table.shop', '店铺') + '</th><th>' + shopT('shop.table.category', '分类') + '</th><th>' + shopT('shop.table.price', '价格') + '</th><th>' + shopT('shop.table.sales', '销量') + '</th><th>' + shopT('shop.table.status', '状态') + '</th><th>' + shopT('shop.table.actions', '操作') + '</th></tr></thead><tbody>' +
      products.map(function (p) {
        return '<tr>' +
          '<td>' + coverHtml(p, 'sp-cover-xs') + ' ' + App.escapeHtml(p.name) + '</td>' +
          '<td>' + App.escapeHtml(shopName(p.shopId)) + '</td>' +
          '<td>' + App.escapeHtml(p.category) + '</td>' +
          '<td>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(p.price) }) + '</td>' +
          '<td>' + (p.sales || 0) + '</td>' +
          '<td>' + (p.isAvailable ? shopT('shop.product.onSale', '在售') : '<span class="sp-danger">' + shopT('shop.product.offSale', '已下架') + '</span>') + '</td>' +
          '<td class="sp-row-actions">' +
            '<button class="btn btn-column5" data-edit="' + p.id + '">' + shopT('shop.common.edit', '编辑') + '</button>' +
            '<button class="btn btn-column5" data-toggle="' + p.id + '">' + (p.isAvailable ? shopT('shop.product.delist', '下架') : shopT('shop.product.relist', '上架')) + '</button>' +
            '<button class="btn btn-column5 sp-danger" data-del="' + p.id + '">' + shopT('shop.common.delete', '删除') + '</button>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';

    $('#product-table').querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { navigate('/admin/product/' + btn.dataset.edit); });
    });
    $('#product-table').querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var p = products.find(function (x) { return x.id === btn.dataset.toggle; });
        await App.api('/products/' + p.id, { method: 'PUT', body: { isAvailable: !p.isAvailable } });
        App.showToast(p.isAvailable ? shopT('shop.product.delisted', '已下架') : shopT('shop.product.relisted', '已上架'), 'success');
        renderAdminProducts();
      });
    });
    $('#product-table').querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmDanger(shopT('shop.product.deleteConfirm', '删除商品会同时从所有用户购物车移除，确定删除？'), async function () {
          await App.api('/products/' + btn.dataset.del, { method: 'DELETE' });
          App.showToast(shopT('shop.product.deleted', '商品已删除'), 'success');
          renderAdminProducts();
        });
      });
    });
  }

  /**
   * 刷新选项行的上移/下移可用状态（首行禁上移，末行禁下移）
   * 规格编辑器与套餐编辑器共用
   * @param {HTMLElement} optList 选项行容器
   */
  function refreshSpecOptionOrder(optList) {
    var rows = optList.querySelectorAll('.sp-spec-opt-row');
    rows.forEach(function (r, i) {
      var up = r.querySelector('[data-opt-up]');
      var down = r.querySelector('[data-opt-down]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === rows.length - 1;
    });
  }

  /**
   * 追加一行规格/套餐选项（名称 + 加价 + 上移/下移/删除）
   * 规格编辑器与套餐编辑器共用，创建时直接绑定事件，避免全量重绘丢焦点
   * @param {HTMLElement} optList 选项行容器
   * @param {string} label 选项名
   * @param {number} delta 加价（积分）
   */
  function appendSpecOptionRow(optList, label, delta) {
    var row = document.createElement('div');
    row.className = 'sp-spec-opt-row';
    row.innerHTML =
      '<input type="text" class="sp-spec-opt-label input" placeholder="' + shopT('shop.specEditor.optLabelPlaceholder', '选项名（如 大杯）') + '" value="' + App.escapeHtml(label || '') + '">' +
      '<input type="number" class="sp-spec-opt-delta input" min="-9999" step="0.1" placeholder="' + shopT('shop.specEditor.optDeltaPlaceholder', '加价') + '" value="' + App.escapeHtml(String(delta != null ? delta : 0)) + '">' +
      '<span class="sp-spec-opt-unit">' + shopT('shop.specEditor.pointsUnit', '积分') + '</span>' +
      '<button type="button" class="icon-btn" data-opt-up title="' + shopT('shop.specEditor.moveUp', '上移') + '">' + ICONS.up + '</button>' +
      '<button type="button" class="icon-btn" data-opt-down title="' + shopT('shop.specEditor.moveDown', '下移') + '">' + ICONS.down + '</button>' +
      '<button type="button" class="icon-btn danger" data-opt-del title="' + shopT('shop.specEditor.removeOption', '移除') + '">' + ICONS.close + '</button>';

    /* 上移：插到上一行之前 */
    row.querySelector('[data-opt-up]').onclick = function () {
      var prev = row.previousElementSibling;
      if (prev) { optList.insertBefore(row, prev); refreshSpecOptionOrder(optList); }
    };
    /* 下移 */
    row.querySelector('[data-opt-down]').onclick = function () {
      var next = row.nextElementSibling;
      if (next) { optList.insertBefore(row, next.nextElementSibling); refreshSpecOptionOrder(optList); }
    };
    /* 删除：至少保留一个 */
    row.querySelector('[data-opt-del]').onclick = function () {
      if (optList.children.length > 1) { row.remove(); refreshSpecOptionOrder(optList); }
      else { App.showToast(shopT('shop.specEditor.keepOneOption', '至少保留一个规格选项'), 'warning'); }
    };
    optList.appendChild(row);
    refreshSpecOptionOrder(optList);
  }

  /**
   * 规格编辑器（参考转盘编辑器模式：DOM API 直接增删，不 render 全量重绘）
   * - appendGroup() / appendSpecOptionRow() 创建时直接绑 onclick
   * - 每行独立操作：上移/下移/删除，不影响其他行
   * - collect() 从 DOM 实时收集（保存时调用）
   * @param {Array} initialSpecs [{ name, required, options: [{ label, priceDelta }] }]
   */
  function initSpecEditor(initialSpecs, hostId) {
    var host = document.getElementById(hostId || 'f-p-specs');
    if (!host) return;
    host.className = 'sp-spec-editor';                                    /* 加 .sp-spec-editor 类让 all.css 选择器生效 */
    host.innerHTML = '';

    /* ---------- 顶部标题条 ---------- */
    var titleBar = document.createElement('div');
    titleBar.className = 'sp-spec-editor-head';
    titleBar.innerHTML =
      '<span class="sp-spec-editor-hint">' + shopT('shop.specEditor.hint', '规格选填（留空即为无规格商品）') + '</span>' +
      '<button type="button" class="btn btn-column5 btn-sm" id="sp-spec-add-group">' + ICONS.plus + ' ' + shopT('shop.specEditor.addGroup', '新增规格组') + '</button>';
    host.appendChild(titleBar);

    /* ---------- 空态提示 ---------- */
    var emptyHint = document.createElement('div');
    emptyHint.className = 'sp-spec-empty-hint';
    emptyHint.textContent = shopT('shop.specEditor.emptyHint', '还没有规格组，点右上角「新增规格组」开始配置');
    host.appendChild(emptyHint);

    /** 刷新空态显示 */
    function refreshEmptyHint() {
      var hasGroups = host.querySelectorAll('.sp-spec-group').length > 0;
      emptyHint.style.display = hasGroups ? 'none' : '';
    }

    /** 规格组：上移/下移/删除按钮的可用性 */
    function refreshGroupOrder() {
      var groups = host.querySelectorAll('.sp-spec-group');
      groups.forEach(function (g, i) {
        var up = g.querySelector('[data-group-up]');
        var down = g.querySelector('[data-group-down]');
        if (up) up.disabled = i === 0;
        if (down) down.disabled = i === groups.length - 1;
      });
    }

    /** 选项行：上移/下移按钮的可用性（复用公共实现） */
    var refreshOptionOrder = refreshSpecOptionOrder;
    /** 追加规格选项行（复用公共实现） */
    var appendOptionRow = appendSpecOptionRow;

    /** 追加一个规格组（参考转盘 appendOptionRow） */
    function appendGroup(groupData) {
      var gEl = document.createElement('div');
      gEl.className = 'sp-spec-group';
      gEl.innerHTML =
        '<div class="sp-spec-group-head">' +
          '<input type="text" class="sp-spec-group-name input" placeholder="' + shopT('shop.specEditor.groupNamePlaceholder', '如：份量 / 甜度') + '" value="' + App.escapeHtml(groupData ? groupData.name || '' : '') + '">' +
          '<label class="sp-spec-group-req">' +
            '<input type="checkbox" ' + (groupData && groupData.required === false ? '' : 'checked') + '> ' + shopT('shop.specEditor.required', '必选') +
          '</label>' +
          '<div class="sp-spec-group-actions">' +
            '<button type="button" class="icon-btn" data-group-up title="' + shopT('shop.specEditor.moveUp', '上移') + '">' + ICONS.up + '</button>' +
            '<button type="button" class="icon-btn" data-group-down title="' + shopT('shop.specEditor.moveDown', '下移') + '">' + ICONS.down + '</button>' +
            '<button type="button" class="icon-btn danger" data-group-del title="' + shopT('shop.specEditor.delGroup', '删除组') + '">' + ICONS.trash + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sp-spec-opt-list"></div>' +
        '<button type="button" class="btn btn-column5 btn-sm sp-spec-add-opt-btn">' + ICONS.plus + ' ' + shopT('shop.specEditor.addOption', '新增规格选项') + '</button>';

      var optList = gEl.querySelector('.sp-spec-opt-list');

      /* 渲染已有选项 */
      var opts = groupData && groupData.options ? groupData.options : [{ label: '', priceDelta: 0 }];
      opts.forEach(function (o) { appendOptionRow(optList, o.label, o.priceDelta); });

      /* 新增选项按钮 */
      gEl.querySelector('.sp-spec-add-opt-btn').onclick = function () {
        appendOptionRow(optList, '', 0);
      };

      /* 组上移 */
      gEl.querySelector('[data-group-up]').onclick = function () {
        var prev = gEl.previousElementSibling;
        if (prev && prev.classList.contains('sp-spec-group')) {
          host.insertBefore(gEl, prev); refreshGroupOrder();
        }
      };
      /* 组下移 */
      gEl.querySelector('[data-group-down]').onclick = function () {
        var next = gEl.nextElementSibling;
        while (next && !next.classList.contains('sp-spec-group')) next = next.nextElementSibling;
        if (next) { host.insertBefore(gEl, next.nextElementSibling); refreshGroupOrder(); }
      };
      /* 删组 */
      gEl.querySelector('[data-group-del]').onclick = function () {
        if (host.querySelectorAll('.sp-spec-group').length > 1) {
          gEl.remove(); refreshGroupOrder(); refreshEmptyHint();
        } else { App.showToast(shopT('shop.specEditor.keepOneGroup', '至少保留一个规格组'), 'warning'); }
      };

      /* 插入到 emptyHint 之前 */
      host.insertBefore(gEl, emptyHint);
      refreshGroupOrder();
      refreshEmptyHint();
    }

    /* ---------- 绑定「新增规格组」按钮 ---------- */
    titleBar.querySelector('#sp-spec-add-group').onclick = function () {
      appendGroup({ name: '', required: true, options: [{ label: '', priceDelta: 0 }] });
    };

    /* ---------- 初始化：渲染已有规格 ---------- */
    var initial = (initialSpecs && initialSpecs.length) ? initialSpecs : null;
    if (initial) {
      initial.forEach(function (g) { appendGroup(g); });
    }
    refreshEmptyHint();

    /**
     * 从 DOM 收集规格数据（保存商品时调用）
     * 参考转盘：[...inputs].map(i => i.value) 模式
     */
    host.collect = function () {
      var groups = host.querySelectorAll('.sp-spec-group');
      var result = [];
      groups.forEach(function (gEl) {
        var name = gEl.querySelector('.sp-spec-group-name').value.trim();
        if (!name) return;                                        // 空组名跳过
        var required = gEl.querySelector('.sp-spec-group-req input').checked;
        var options = [];
        gEl.querySelectorAll('.sp-spec-opt-row').forEach(function (oEl) {
          var label = oEl.querySelector('.sp-spec-opt-label').value.trim();
          if (!label) return;                                     // 空选项跳过
          var delta = Number(oEl.querySelector('.sp-spec-opt-delta').value);
          if (!Number.isFinite(delta)) delta = 0;
          options.push({ label: label, priceDelta: Math.round(delta * 100) / 100 });
        });
        if (options.length === 0) return;                         // 无选项的组跳过
        result.push({ name: name, required: required, options: options });
      });
      return result.length > 0 ? result : null;
    };
  }

  /**
   * 套餐分组编辑器（美团式：每组设固定件数，同一选项可重复选）
   * 与规格编辑器同风格：DOM API 直接增删，不 render 全量重绘，避免输入框焦点丢失
   * 数据结构：[{ name, count, options: [{ label, priceDelta }] }]
   * @param {Array} initialGroups 初始套餐分组
   * @param {string} hostId 挂载容器 id
   */
  function initComboEditor(initialGroups, hostId) {
    var host = document.getElementById(hostId || 'ped-combo-groups');
    if (!host) return;
    host.className = 'sp-spec-editor sp-combo-editor';
    host.innerHTML = '';

    /* ---------- 顶部标题条 ---------- */
    var titleBar = document.createElement('div');
    titleBar.className = 'sp-spec-editor-head';
    titleBar.innerHTML =
      '<span class="sp-spec-editor-hint">' + shopT('shop.comboEditor.hint', '买家在每组内需恰好选 N 件，同一选项可重复选') + '</span>' +
      '<button type="button" class="btn btn-column5 btn-sm" id="sp-combo-add-group">' + ICONS.plus + ' ' + shopT('shop.comboEditor.addGroup', '新增分组') + '</button>';
    host.appendChild(titleBar);

    /* ---------- 空态提示 ---------- */
    var emptyHint = document.createElement('div');
    emptyHint.className = 'sp-spec-empty-hint';
    emptyHint.textContent = shopT('shop.comboEditor.emptyHint', '还没有套餐分组，点右上角「新增分组」开始配置');
    host.appendChild(emptyHint);

    /** 刷新空态显示 */
    function refreshEmptyHint() {
      var hasGroups = host.querySelectorAll('.sp-combo-group-card').length > 0;
      emptyHint.style.display = hasGroups ? 'none' : '';
    }

    /** 套餐组：上移/下移按钮的可用性 */
    function refreshGroupOrder() {
      var groups = host.querySelectorAll('.sp-combo-group-card');
      groups.forEach(function (g, i) {
        var up = g.querySelector('[data-group-up]');
        var down = g.querySelector('[data-group-down]');
        if (up) up.disabled = i === 0;
        if (down) down.disabled = i === groups.length - 1;
      });
    }

    /** 追加一个套餐分组 */
    function appendGroup(groupData) {
      var gEl = document.createElement('div');
      gEl.className = 'sp-spec-group sp-combo-group-card';

      /* 固定件数：兼容旧的 minSelect 字段，缺省 1 件 */
      var initCount = groupData
        ? (groupData.count != null ? Number(groupData.count) : Number(groupData.minSelect))
        : 1;
      if (!Number.isFinite(initCount) || initCount < 0) initCount = 1;
      initCount = Math.min(initCount, 20);

      gEl.innerHTML =
        '<div class="sp-spec-group-head">' +
          '<input type="text" class="sp-combo-group-name input" placeholder="' + shopT('shop.comboEditor.groupNamePlaceholder', '分组名（如 主食 / 饮品）') + '" value="' + App.escapeHtml(groupData ? groupData.name || '' : '') + '">' +
          '<div class="sp-spec-group-actions">' +
            '<button type="button" class="icon-btn" data-group-up title="' + shopT('shop.specEditor.moveUp', '上移') + '">' + ICONS.up + '</button>' +
            '<button type="button" class="icon-btn" data-group-down title="' + shopT('shop.specEditor.moveDown', '下移') + '">' + ICONS.down + '</button>' +
            '<button type="button" class="icon-btn danger" data-group-del title="' + shopT('shop.specEditor.delGroup', '删除组') + '">' + ICONS.trash + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sp-combo-count-row">' +
          '<label>' + shopT('shop.comboEditor.countLabel', '件数') + '</label>' +
          '<input type="number" class="sp-combo-count input" min="0" max="20" step="1" value="' + initCount + '">' +
          '<span class="sp-combo-count-unit">' + shopT('shop.comboEditor.countUnit', '件') + '</span>' +
        '</div>' +
        '<div class="sp-spec-opt-list"></div>' +
        '<button type="button" class="btn btn-column5 btn-sm sp-spec-add-opt-btn">' + ICONS.plus + ' ' + shopT('shop.comboEditor.addOption', '新增选项') + '</button>';

      var optList = gEl.querySelector('.sp-spec-opt-list');

      /* 渲染已有选项 */
      var opts = groupData && groupData.options ? groupData.options : [{ label: '', priceDelta: 0 }];
      opts.forEach(function (o) { appendSpecOptionRow(optList, o.label, o.priceDelta); });

      /* 新增选项按钮 */
      gEl.querySelector('.sp-spec-add-opt-btn').onclick = function () {
        appendSpecOptionRow(optList, '', 0);
      };

      /* 组上移 */
      gEl.querySelector('[data-group-up]').onclick = function () {
        var prev = gEl.previousElementSibling;
        if (prev && prev.classList.contains('sp-combo-group-card')) {
          host.insertBefore(gEl, prev); refreshGroupOrder();
        }
      };
      /* 组下移 */
      gEl.querySelector('[data-group-down]').onclick = function () {
        var next = gEl.nextElementSibling;
        while (next && !next.classList.contains('sp-combo-group-card')) next = next.nextElementSibling;
        if (next) { host.insertBefore(gEl, next.nextElementSibling); refreshGroupOrder(); }
      };
      /* 删组 */
      gEl.querySelector('[data-group-del]').onclick = function () {
        if (host.querySelectorAll('.sp-combo-group-card').length > 1) {
          gEl.remove(); refreshGroupOrder(); refreshEmptyHint();
        } else { App.showToast(shopT('shop.comboEditor.keepOneGroup', '至少保留一个套餐分组'), 'warning'); }
      };

      host.insertBefore(gEl, emptyHint);
      refreshGroupOrder();
      refreshEmptyHint();
    }

    /* ---------- 绑定「新增分组」按钮 ---------- */
    titleBar.querySelector('#sp-combo-add-group').onclick = function () {
      appendGroup({ name: '', count: 1, options: [{ label: '', priceDelta: 0 }] });
    };

    /* ---------- 初始化：渲染已有分组 ---------- */
    if (Array.isArray(initialGroups) && initialGroups.length > 0) {
      initialGroups.forEach(function (g) { appendGroup(g); });
    }
    refreshEmptyHint();

    /**
     * 从 DOM 收集套餐分组数据（保存商品时调用）
     * @returns {Array|null} [{ name, count, options }]；无有效分组返回 null
     */
    host.collect = function () {
      var result = [];
      host.querySelectorAll('.sp-combo-group-card').forEach(function (gEl) {
        var name = gEl.querySelector('.sp-combo-group-name').value.trim();
        if (!name) return;                                        // 空组名跳过

        var count = parseInt(gEl.querySelector('.sp-combo-count').value, 10);
        if (!Number.isFinite(count) || count < 0) count = 0;
        count = Math.min(count, 20);                              // 0 表示该组可不选

        var options = [];
        gEl.querySelectorAll('.sp-spec-opt-row').forEach(function (oEl) {
          var label = oEl.querySelector('.sp-spec-opt-label').value.trim();
          if (!label) return;                                     // 空选项跳过
          var delta = Number(oEl.querySelector('.sp-spec-opt-delta').value);
          if (!Number.isFinite(delta)) delta = 0;
          options.push({ label: label, priceDelta: Math.round(delta * 100) / 100 });
        });
        if (options.length === 0) return;                         // 无选项的组跳过

        result.push({
          name: name,
          count: count,
          options: options
        });
      });
      return result.length > 0 ? result : null;
    };
  }

  /**
   * 压缩用户选择的图片：等比缩放到最长边 ≤ maxSide，统一转 JPEG（质量 0.85）
   * 目的：把手机原图（常见 3~8MB）压到几百 KB，避免上传超时和请求体超限
   * @param {File} file 用户选择的图片文件
   * @param {number} [maxSide=1000] 最长边像素上限
   * @returns {Promise<string>} base64 DataURL
   */
  function compressImage(file, maxSide) {
    maxSide = maxSide || 1000;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();                     // 文件读取器：先读成 DataURL
      reader.onerror = function () { reject(new Error(shopT('shop.img.readFailed', '图片读取失败'))); };
      reader.onload = function () {
        var img = new Image();                           // 用于拿到原始宽高
        img.onerror = function () { reject(new Error(shopT('shop.img.unsupported', '图片格式不支持'))); };
        img.onload = function () {
          /* 等比缩放：小图不放大，大图缩到最长边 maxSide */
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';                     // JPEG 无透明通道，先铺白底避免透明区变黑
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 新增/编辑商品弹窗表单
   * @param {object|null} product 编辑时传原商品
   * @param {Array} shops 店铺列表（下拉选择）
   * @param {Function} [afterSave] 保存后的刷新回调
   */
  /**
   * 商品编辑独立页面（参考转盘 /editor 模式）
   * - 有返回按钮 → /admin
   * - 独立卡片表单 + 规格编辑器
   * - 底部保存/取消按钮
   * @param {string|null} productId null=新增，字符串=编辑
   */
  async function renderProductEditor(productId) {
    var isNew = !productId;

    /* 读取 URL 查询参数：shopId 用于新增时预选店铺，from 用于决定保存/返回去向 */
    var params = new URLSearchParams(location.search);
    var presetShopId = params.get('shopId') || '';
    /* 返回去向：店主视图带 shopId 时回到该店铺的独立商品管理页，否则回我的店铺/管理后台 */
    var backPath = params.get('from') === 'myshops'
      ? (presetShopId ? '/myshops/' + presetShopId + '/products' : '/myshops')
      : '/admin';

    /* 找到或创建 view-product-editor（插入 .content-area 跟其他视图同级） */
    var editor = document.getElementById('view-product-editor');
    if (!editor) {
      editor = document.createElement('section');
      editor.id = 'view-product-editor';
      editor.className = 'sp-view';
      /* 必须挂在 .content-area 下（跟其余视图同级），否则会被 100vh 的主容器挤出可视区变空白 */
      var host = document.querySelector('.content-area') || document.querySelector('.main-container');
      if (host) host.appendChild(editor);
      else document.getElementById('root').appendChild(editor);
    }
    /* 统一显隐：showSection 会隐藏所有其他 .sp-view */
    showSection('view-product-editor');

    /* 加载数据：店铺列表 + 商品列表（编辑时从中 find 目标商品，后端没有单条查询接口） */
    var data = await Promise.all([App.api('/shops'), App.api('/products')]);
    var shops = data[0], products = data[1];
    var product = productId ? (products.find(function (x) { return x.id === productId; }) || null) : null;
    if (productId && !product) { App.showToast(shopT('shop.productForm.notFound', '商品不存在'), 'warning'); navigate(backPath); return; }

    var p = product || { shopId: presetShopId || (shops[0] ? shops[0].id : ''), name: '', description: '', price: '', category: '', emoji: '🛒', image: '', isAvailable: true, specs: null, isCombo: false, comboGroups: null };

    editor.innerHTML =
      '<div class="sp-editor-page">' +
        '<div class="card">' +
          '<div class="sp-editor-head">' +
            '<h2 class="sp-editor-title">' + (isNew ? shopT('shop.productForm.newTitle', '新增商品') : shopT('shop.productForm.editTitle', '编辑商品')) + '</h2>' +
          '</div>' +
          '<div class="form-group"><label class="label">' + shopT('shop.productForm.shopLabel', '所属店铺') + '</label>' +
            '<select id="ped-shop" class="input">' + shops.map(function (s) { return '<option value="' + s.id + '" ' + (s.id === p.shopId ? 'selected' : '') + '>' + App.escapeHtml(s.name) + '</option>'; }).join('') + '</select>' +
          '</div>' +
          '<div class="form-group"><label class="label">' + shopT('shop.productForm.nameLabel', '商品名称') + '</label><input id="ped-name" maxlength="40" type="text" class="input" value="' + App.escapeHtml(p.name) + '" placeholder="' + shopT('shop.productForm.namePlaceholder', '商品名称') + '"></div>' +
          '<div class="form-group"><label class="label">' + shopT('shop.productForm.descLabel', '描述') + '</label><input id="ped-desc" maxlength="80" type="text" class="input" value="' + App.escapeHtml(p.description) + '" placeholder="' + shopT('shop.productForm.descPlaceholder', '一句话介绍（选填）') + '"></div>' +
          '<div class="form-group"><label class="label" id="ped-price-label">' + shopT('shop.productForm.priceLabel', '价格（积分）') + '</label><input id="ped-price" type="number" min="0" step="0.1" class="input" value="' + App.escapeHtml(p.price) + '" placeholder="0.00"></div>' +
          '<div class="form-group"><label class="label">' + shopT('shop.productForm.catLabel', '分类') + '</label><input id="ped-cat" maxlength="20" type="text" class="input" value="' + App.escapeHtml(p.category) + '" placeholder="' + shopT('shop.productForm.catPlaceholder', '如：文具 / 零食') + '"></div>' +
          '<div class="form-group"><label class="label">' + shopT('shop.productForm.emojiLabel', 'Emoji 占位') + '</label><input id="ped-emoji" maxlength="4" type="text" class="input" value="' + App.escapeHtml(p.emoji) + '" placeholder="' + shopT('shop.productForm.emojiPlaceholder', '无图时显示，如 📓') + '"></div>' +
          '<div class="form-group">' +
            '<label class="label">' + shopT('shop.productForm.imageLabel', '商品图片（选填）') + '</label>' +
            '<div class="sp-upload">' +
              '<div class="sp-upload-preview" id="ped-image-preview"></div>' +
              '<div class="sp-upload-actions">' +
                '<button type="button" class="btn btn-column5 btn-sm" id="ped-image-pick">' + shopT('shop.productForm.uploadImage', '上传图片') + '</button>' +
                '<button type="button" class="btn btn-column5 btn-sm" id="ped-image-clear">' + shopT('shop.productForm.removeImage', '移除图片') + '</button>' +
                '<input type="file" id="ped-image-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>' +
              '</div>' +
            '</div>' +
            '<input id="ped-image" maxlength="300" type="text" class="input" value="' + App.escapeHtml(p.image) + '" placeholder="' + shopT('shop.productForm.imagePlaceholder', '上传后自动填入，也可粘贴外链图片地址') + '">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="sp-switch-row">' +
              '<input type="checkbox" id="ped-avail" ' + (p.isAvailable ? 'checked' : '') + '>' +
              '<div>' +
                '<div class="sp-switch-title">' + shopT('shop.productForm.availableTitle', '在售') + '</div>' +
                '<div class="sp-switch-desc">' + shopT('shop.productForm.availableDesc', '关闭后用户端看不到这件商品') + '</div>' +
              '</div>' +
            '</label>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="sp-switch-row">' +
              '<input type="checkbox" id="ped-combo" ' + (p.isCombo ? 'checked' : '') + '>' +
              '<div>' +
                '<div class="sp-switch-title">' + shopT('shop.productForm.comboTitle', '套餐商品') + '</div>' +
                '<div class="sp-switch-desc">' + shopT('shop.productForm.comboDesc', '开启后买家按分组任选件数（与规格互斥）') + '</div>' +
              '</div>' +
            '</label>' +
          '</div>' +
          '<div class="form-group" id="ped-specs-wrap">' +
            '<label class="label">' + shopT('shop.productForm.specsLabel', '规格（选填）') + '</label>' +
            '<div id="ped-specs"></div>' +
          '</div>' +
          '<div class="form-group" id="ped-combo-wrap" hidden>' +
            '<label class="label">' + shopT('shop.productForm.comboGroupsLabel', '套餐分组（每组设固定件数）') + '</label>' +
            '<div id="ped-combo-groups"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    /* 初始化规格编辑器与套餐分组编辑器（两者互斥，由「套餐商品」开关切换） */
    initSpecEditor(p.specs || [], 'ped-specs');
    initComboEditor(p.comboGroups || [], 'ped-combo-groups');

    /**
     * 同步「套餐 / 规格」两种模式的显隐与价格标签文案
     */
    function syncComboMode() {
      var isCombo = $('#ped-combo').checked;                       // 当前是否套餐商品
      $('#ped-specs-wrap').hidden = isCombo;
      $('#ped-combo-wrap').hidden = !isCombo;
      $('#ped-price-label').textContent = isCombo ? shopT('shop.productForm.comboPriceLabel', '套餐价（积分）') : shopT('shop.productForm.priceLabel', '价格（积分）');
    }
    $('#ped-combo').addEventListener('change', syncComboMode);
    syncComboMode();

    /* ---------- 商品图片：预览 + 上传 ---------- */
    /** 刷新图片预览：有地址显示图片（加载失败回退 emoji），无地址直接显示 emoji */
    function refreshImagePreview() {
      var url = $('#ped-image').value.trim();                       // 当前图片地址
      var box = $('#ped-image-preview');                            // 预览容器
      var emoji = $('#ped-emoji').value.trim() || '🛒';             // 无图时的 emoji 占位
      if (!url) {
        box.innerHTML = '<span class="sp-upload-emoji">' + App.escapeHtml(emoji) + '</span>';
        return;
      }
      box.innerHTML = '<img alt="" src="' + App.escapeHtml(url) + '">';
      var imgEl = box.querySelector('img');
      imgEl.onerror = function () {
        box.innerHTML = '<span class="sp-upload-emoji">' + App.escapeHtml(emoji) + '</span>';
      };
    }
    refreshImagePreview();

    /* 点「上传图片」触发隐藏的 file input */
    $('#ped-image-pick').onclick = function () { $('#ped-image-file').click(); };
    /* 点「移除图片」清空地址并刷新预览 */
    $('#ped-image-clear').onclick = function () {
      $('#ped-image').value = '';
      refreshImagePreview();
    };
    /* 手动改地址或 emoji 时同步预览 */
    $('#ped-image').addEventListener('input', refreshImagePreview);
    $('#ped-emoji').addEventListener('input', function () {
      if (!$('#ped-image').value.trim()) refreshImagePreview();
    });

    /* 选中文件 → 压缩 → 上传 → 回填地址 */
    $('#ped-image-file').addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0];               // 用户选中的文件
      if (!file) return;
      if (!/^image\//.test(file.type)) { App.showToast(shopT('shop.productForm.pickImage', '请选择图片文件'), 'warning'); return; }

      var pickBtn = $('#ped-image-pick');
      pickBtn.disabled = true;
      pickBtn.textContent = shopT('shop.productForm.uploading', '上传中…');
      try {
        var dataUrl = await compressImage(file);                    // 压缩后的 base64
        var result = await App.api('/upload/image', { method: 'POST', body: { dataUrl: dataUrl } });
        $('#ped-image').value = result.url;                         // 服务端返回的可访问地址
        refreshImagePreview();
        App.showToast(shopT('shop.productForm.uploadSuccess', '图片上传成功'), 'success');
      } catch (err) {
        /* App.api 内部已弹出错误提示，这里只做兜底静默 */
      } finally {
        pickBtn.disabled = false;
        pickBtn.textContent = shopT('shop.productForm.uploadImage', '上传图片');
        e.target.value = '';                                       // 清空选择，允许重复选同一文件
      }
    });

    /**
     * 保存商品（顶栏主按钮触发）
     * 校验字段与规格/套餐结构后写接口，成功回到来源视图
     */
    async function saveProduct() {
      var isCombo = $('#ped-combo').checked;                         // 当前是否为套餐商品
      var specsHost = document.getElementById('ped-specs');
      var comboHost = document.getElementById('ped-combo-groups');
      var specs = isCombo ? null : (specsHost && specsHost.collect ? specsHost.collect() : null);
      var comboGroups = isCombo ? (comboHost && comboHost.collect ? comboHost.collect() : null) : null;
      var body = {
        shopId: $('#ped-shop').value,
        name: $('#ped-name').value.trim(),
        description: $('#ped-desc').value.trim(),
        price: Number($('#ped-price').value),
        category: $('#ped-cat').value.trim() || '其他',
        emoji: $('#ped-emoji').value.trim() || '🛒',
        image: $('#ped-image').value.trim(),
        isAvailable: $('#ped-avail').checked,
        isCombo: isCombo,
        specs: specs,
        comboGroups: comboGroups
      };
      if (!body.name) { App.showToast(shopT('shop.productForm.nameRequired', '商品名称不能为空'), 'warning'); return; }
      if (!Number.isFinite(body.price) || body.price < 0) { App.showToast(shopT('shop.productForm.priceInvalid', '价格格式不正确'), 'warning'); return; }
      if (isCombo) {
        if (!comboGroups || comboGroups.length === 0) {
          App.showToast(shopT('shop.productForm.comboNeedGroup', '套餐至少需要一个分组（含组名和至少一个选项）'), 'warning'); return;
        }
        for (var ci = 0; ci < comboGroups.length; ci++) {
          var cg = comboGroups[ci];                                 // 当前套餐分组
          if (cg.options.length === 0) {
            App.showToast(shopT('shop.productForm.comboGroupNeedOption', '分组「{name}」至少需要一个选项', { name: cg.name }), 'warning'); return;
          }
        }
      }
      if (!isCombo && specs) {
        for (var si = 0; si < specs.length; si++) {
          if (specs[si].options.length === 0) {
            App.showToast(shopT('shop.productForm.specGroupNeedOption', '规格组「{name}」至少需要一个选项', { name: specs[si].name }), 'warning'); return;
          }
        }
      }
      if (productId) await App.api('/products/' + productId, { method: 'PUT', body: body });
      else await App.api('/products', { method: 'POST', body: body });
      App.showToast(shopT('shop.productForm.saved', '商品已保存'), 'success');
      navigate(backPath);
    }

    /* 顶栏：返回按钮贴左边缘，保存在头像左侧 */
    setTopbarActions([
      { icon: ICONS.back, title: shopT('shop.common.back', '返回'), back: true, onClick: function () { navigate(backPath); } },
      { icon: ICONS.check, title: shopT('shop.common.save', '保存'), onClick: saveProduct }
    ]);
  }

  /** 管理：店铺表格 + CRUD */
  async function renderAdminShops() {
    var shops = await App.api('/shops');
    $('#shop-table').innerHTML =
      '<table class="sp-table"><thead><tr><th>' + shopT('shop.table.shop', '店铺') + '</th><th>' + shopT('shop.table.category', '分类') + '</th><th>' + shopT('shop.table.status', '状态') + '</th><th>' + shopT('shop.table.actions', '操作') + '</th></tr></thead><tbody>' +
      shops.map(function (s) {
        return '<tr>' +
          '<td>' + coverHtml(s, 'sp-cover-xs') + ' ' + App.escapeHtml(s.name) + '<div class="sp-cell-sub">' + App.escapeHtml(s.description || '') + '</div></td>' +
          '<td>' + App.escapeHtml(s.category) + '</td>' +
          '<td>' + (s.seized ? '<span class="sp-danger">' + shopT('shop.myshops.seized', '已查封') + '</span>' : (s.isOpen ? shopT('shop.admin.shopOpen', '营业中') : '<span class="sp-danger">' + shopT('shop.admin.shopRest', '休息中') + '</span>')) + '</td>' +
          '<td class="sp-row-actions">' +
            '<button class="btn btn-column5" data-edit="' + s.id + '">' + shopT('shop.common.edit', '编辑') + '</button>' +
            '<button class="btn btn-column5" data-toggle="' + s.id + '"' + (s.seized ? ' disabled' : '') + '>' + (s.isOpen ? shopT('shop.myshops.rest', '休息') : shopT('shop.myshops.open', '营业')) + '</button>' +
            (s.seized
              ? '<button class="btn btn-column5" data-unseize="' + s.id + '">' + shopT('shop.admin.unseize', '解封') + '</button>'
              : '<button class="btn btn-column5 sp-danger" data-seize="' + s.id + '">' + shopT('shop.admin.seize', '查封') + '</button>') +
            '<button class="btn btn-column5 sp-danger" data-del="' + s.id + '">' + shopT('shop.common.delete', '删除') + '</button>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';

    $('#shop-table').querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { openShopForm(shops.find(function (s) { return s.id === btn.dataset.edit; })); });
    });
    $('#shop-table').querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var s = shops.find(function (x) { return x.id === btn.dataset.toggle; });
        await App.api('/shops/' + s.id, { method: 'PUT', body: { isOpen: !s.isOpen } });
        App.showToast(s.isOpen ? shopT('shop.myshops.rested', '店铺已休息') : shopT('shop.admin.shopOpened', '店铺已开业'), 'success');
        renderAdminShops();
      });
    });
    $('#shop-table').querySelectorAll('[data-seize]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openSeizeForm(shops.find(function (s) { return s.id === btn.dataset.seize; }));
      });
    });
    $('#shop-table').querySelectorAll('[data-unseize]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmDanger(shopT('shop.admin.unseizeConfirm', '解封后店铺需重新设置营业状态，确定解封？'), async function () {
          await App.api('/admin/shops/' + btn.dataset.unseize + '/unseize', { method: 'POST' });
          App.showToast(shopT('shop.admin.unseized', '店铺已解封'), 'success');
          renderAdminShops();
        });
      });
    });
    $('#shop-table').querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmDanger(shopT('shop.myshops.deleteConfirm', '删除店铺会连带删除其全部商品，确定删除？'), async function () {
          await App.api('/shops/' + btn.dataset.del, { method: 'DELETE' });
          App.showToast(shopT('shop.myshops.deleted', '店铺已删除'), 'success');
          renderAdminShops();
        });
      });
    });
  }

  /**
   * 查封店铺弹窗：填写年级/班级/整改截止时间/违规问题，确认后查封并发送整改通知邮件
   * @param {object} shop 目标店铺
   */
  function openSeizeForm(shop) {
    if (!shop) return;
    openModal({
      title: shopT('shop.admin.seizeTitle', '查封店铺 · 发送整改通知'),
      body:
        '<div class="sp-field"><label>' + shopT('shop.admin.seizeShopName', '店铺名称') + '</label><input type="text" value="' + App.escapeHtml(shop.name) + '" disabled></div>' +
        '<div class="sp-field"><label>' + shopT('shop.admin.grade', '年级') + '</label><input id="f-z-grade" type="text" maxlength="10" placeholder="' + shopT('shop.admin.gradePlaceholder', '如：七') + '"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.admin.className', '班级') + '</label><input id="f-z-class" type="text" maxlength="10" placeholder="' + shopT('shop.admin.classPlaceholder', '如：3') + '"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.admin.deadline', '整改截止时间') + '</label><input id="f-z-deadline" type="datetime-local"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.admin.issues', '违规问题（每行一条）') + '</label><textarea id="f-z-issues" rows="4" class="input" placeholder="' + shopT('shop.admin.issuesPlaceholder', '每行一条，例如：\n商品宣传含夸大功效用语\n在售商品超出学校允许品类') + '"></textarea></div>' +
        '<p class="sp-modal-tip">' + shopT('shop.admin.seizeTip', '查封后店铺立即停止营业、无法加购，并向店主绑定邮箱发送《限期整改告知》。') + '</p>',
      confirmText: shopT('shop.admin.seizeConfirm', '确认查封'),
      danger: true,
      onConfirm: async function () {
        var grade = $('#f-z-grade').value.trim();                 // 年级
        var className = $('#f-z-class').value.trim();             // 班级
        var deadline = $('#f-z-deadline').value;                   // 整改截止时间
        var issues = $('#f-z-issues').value.split('\n')
          .map(function (s) { return s.replace(/^\s*\d+[.、]\s*/, '').trim(); })
          .filter(function (s) { return !!s; });                   // 违规问题（自动去手写编号）
        if (!grade || !className) { App.showToast(shopT('shop.admin.needGradeClass', '请填写年级和班级'), 'warning'); return true; }
        if (!deadline) { App.showToast(shopT('shop.admin.needDeadline', '请选择整改截止时间'), 'warning'); return true; }
        if (!issues.length) { App.showToast(shopT('shop.admin.needIssue', '请至少填写一条违规问题'), 'warning'); return true; }

        var data = await App.api('/admin/shops/' + shop.id + '/seize', {
          method: 'POST',
          body: { grade: grade, className: className, deadline: deadline, issues: issues }
        });
        App.showToast(shopT('shop.admin.seizedToast', '店铺已查封'), 'success');
        if (data && data.mailNotice) {
          App.showToast(data.mailNotice, data.mailNotice.indexOf('失败') >= 0 ? 'warning' : 'info');
        }
        renderAdminShops();
      }
    });
  }

  /**
   * 新增/编辑店铺弹窗表单
   * @param {object|null} shop 编辑时传原店铺
   * @param {Function} [afterSave] 保存后的刷新回调
   */
  function openShopForm(shop, afterSave) {
    var s = shop || { name: '', description: '', category: '', emoji: '🏬', image: '', isOpen: true };
    openModal({
      title: shop ? shopT('shop.shopForm.editTitle', '编辑店铺') : shopT('shop.shopForm.newTitle', '新增店铺'),
      body:
        '<div class="sp-field"><label>' + shopT('shop.shopForm.nameLabel', '店铺名称') + '</label><input id="f-s-name" maxlength="30" type="text" value="' + App.escapeHtml(s.name) + '" placeholder="' + shopT('shop.shopForm.namePlaceholder', '店铺名称') + '"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.shopForm.descLabel', '简介') + '</label><input id="f-s-desc" maxlength="60" type="text" value="' + App.escapeHtml(s.description) + '" placeholder="' + shopT('shop.shopForm.descPlaceholder', '一句话介绍（选填）') + '"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.shopForm.catLabel', '分类') + '</label><input id="f-s-cat" maxlength="20" type="text" value="' + App.escapeHtml(s.category) + '" placeholder="' + shopT('shop.shopForm.catPlaceholder', '如：图书文具 / 零食饮品') + '"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.shopForm.emojiLabel', 'Emoji 占位') + '</label><input id="f-s-emoji" maxlength="4" type="text" value="' + App.escapeHtml(s.emoji) + '" placeholder="' + shopT('shop.shopForm.emojiPlaceholder', '无图时显示，如 🏬') + '"></div>' +
        '<div class="sp-field"><label>' + shopT('shop.shopForm.imageLabel', '图片 URL') + '</label><input id="f-s-image" maxlength="300" type="text" value="' + App.escapeHtml(s.image) + '" placeholder="' + shopT('shop.shopForm.imagePlaceholder', '选填，填写外链图片地址') + '"></div>' +
        '<div class="sp-field sp-field-inline"><label>' + shopT('shop.shopForm.openLabel', '营业中') + '</label><input type="checkbox" id="f-s-open" ' + (s.isOpen ? 'checked' : '') + '></div>',
      confirmText: shopT('shop.common.save', '保存'),
      onConfirm: async function () {
        var body = {
          name: $('#f-s-name').value.trim(),
          description: $('#f-s-desc').value.trim(),
          category: $('#f-s-cat').value.trim() || '综合',
          emoji: $('#f-s-emoji').value.trim() || '🏬',
          image: $('#f-s-image').value.trim(),
          isOpen: $('#f-s-open').checked
        };
        if (!body.name) { App.showToast(shopT('shop.shopForm.nameRequired', '店铺名称不能为空'), 'warning'); return true; }
        if (shop) await App.api('/shops/' + shop.id, { method: 'PUT', body: body });
        else await App.api('/shops', { method: 'POST', body: body });
        App.showToast(shopT('shop.shopForm.saved', '店铺已保存'), 'success');
        (afterSave || renderAdminShops)();
      }
    });
  }

  /** 当前订单管理筛选 */
  var adminOrderFilter = '';

  /** 管理：订单列表（全量 + 状态/退款筛选 + 下拉流转 + 退款审核） */
  async function renderAdminOrders() {
    var orders = await App.api('/orders?all=1');
    var filterBox = $('#admin-order-filter');
    /* refund 为虚拟筛选：只看有待审核退款申请的订单 */
    var cats = ['', 'pending', 'confirmed', 'delivering', 'completed', 'cancelled', 'refunded', 'refund'];
    var labels = {
      '': shopT('shop.cats.all', '全部'),
      pending: shopT('shop.order.statusPending', '待确认'),
      confirmed: shopT('shop.order.statusConfirmed', '已确认'),
      delivering: shopT('shop.order.statusDelivering', '待取货'),
      completed: shopT('shop.order.statusCompleted', '已完成'),
      cancelled: shopT('shop.order.statusCancelled', '已取消'),
      refunded: shopT('shop.order.statusRefunded', '已退款'),
      refund: shopT('shop.admin.refundFilter', '待退款审核')
    };
    filterBox.innerHTML = cats.map(function (c) {
      return '<button class="sp-chip ' + (c === adminOrderFilter ? 'active' : '') + '" data-st="' + c + '">' + labels[c] + '</button>';
    }).join('');
    filterBox.querySelectorAll('.sp-chip').forEach(function (chip) {
      chip.addEventListener('click', function () { adminOrderFilter = chip.dataset.st; renderAdminOrders(); });
    });

    var list = orders.filter(function (o) {
      if (adminOrderFilter === 'refund') return o.refundStatus === 'pending';
      return !adminOrderFilter || o.status === adminOrderFilter;
    });
    var box = $('#admin-orders-list');
    if (list.length === 0) {
      box.innerHTML = '<div class="sp-empty">' + shopT('shop.admin.noMatchOrders', '暂无符合条件的订单') + '</div>';
      return;
    }
    box.innerHTML = list.map(function (o) {
      var more = o.items.length > 1 ? '<span class="order-more">' + shopT('shop.order.moreItems', ' 等{count}种商品', { count: o.items.length }) + '</span>' : '';
      return '<div class="order-card sp-admin-order">' +
        '<div class="order-card-top"><span class="order-no">' + shopT('shop.order.no', '单号 {id}', { id: App.escapeHtml(o.id) }) + '</span>' +
          '<span class="order-card-badges">' + statusBadge(o.status) + refundBadge(o) + '</span></div>' +
        '<div class="order-card-mid">' +
          coverHtml(o.items[0], 'sp-cover-sm') +
          '<div>' +
            '<div>' + App.escapeHtml(o.items[0].productName) + more + '</div>' +
            '<div class="order-time">' + App.escapeHtml((o.createdAt || '').replace('T', ' ').slice(0, 16)) + shopT('shop.admin.pickupShort', ' · 🚶 上门取货') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="order-card-bottom">' +
          '<span>' + shopT('shop.order.itemCount', '共 {count} 件', { count: o.items.reduce(function (s, it) { return s + it.quantity; }, 0) }) + '</span>' +
          '<strong>' + shopT('shop.common.points', '{points} 积分', { points: App.fmtPoints(o.totalAmount) }) + '</strong>' +
        '</div>' +
        refundAdminHtml(o) +
        '<div class="sp-admin-order-foot">' +
          (o.status === 'refunded'
            ? '<span class="sp-refund-state">' + shopT('shop.admin.refundedLocked', '已退款，状态不可再变更') + '</span>'
            : '<select data-oid="' + o.id + '" class="sp-status-select">' +
                '<option value="pending" ' + (o.status === 'pending' ? 'selected' : '') + '>' + shopT('shop.order.statusPending', '待确认') + '</option>' +
                '<option value="confirmed" ' + (o.status === 'confirmed' ? 'selected' : '') + '>' + shopT('shop.order.statusConfirmed', '已确认') + '</option>' +
                '<option value="delivering" ' + (o.status === 'delivering' ? 'selected' : '') + '>' + shopT('shop.order.statusDelivering', '待取货') + '</option>' +
                '<option value="completed" ' + (o.status === 'completed' ? 'selected' : '') + '>' + shopT('shop.order.statusCompleted', '已完成') + '</option>' +
                '<option value="cancelled" ' + (o.status === 'cancelled' ? 'selected' : '') + '>' + shopT('shop.order.statusCancelled', '已取消') + '</option>' +
              '</select>') +
          '<a class="sp-link" href="/shop/order/' + o.id + '">' + shopT('shop.admin.viewDetail', '查看详情') + '</a>' +
        '</div>' +
      '</div>';
    }).join('');

    box.querySelectorAll('.sp-status-select').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        /* 后端在首次进入「待取货」时会自动发待取件邮件，mailNotice 用于提示发送结果 */
        var resp = await App.api('/admin/orders/' + sel.dataset.oid + '/status', { method: 'PUT', body: { status: sel.value } });
        App.showToast(shopT('shop.admin.statusUpdated', '订单状态已更新'), 'success');
        if (resp && resp.mailNotice) App.showToast(resp.mailNotice, resp.mailNotice.indexOf('失败') >= 0 ? 'warning' : 'info');
        renderAdminOrders();
      });
    });

    /* 同意退款：二次确认后返还买家积分并扣回店主收入 */
    box.querySelectorAll('[data-refund-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var oid = btn.dataset.refundApprove;
        confirmDanger(shopT('shop.admin.approveConfirm', '确认通过该退款申请？将把积分返还给买家，并从店主收入中扣回。'), async function () {
          await App.api('/admin/orders/' + oid + '/refund', { method: 'PUT', body: { approve: true } });
          App.showToast(shopT('shop.admin.approved', '退款已通过，积分已返还'), 'success');
          renderAdminOrders();
        });
      });
    });

    /* 拒绝退款：弹窗填写拒绝理由（选填） */
    box.querySelectorAll('[data-refund-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var oid = btn.dataset.refundReject;
        openModal({
          title: shopT('shop.admin.rejectTitle', '拒绝退款'),
          body:
            '<p class="sp-modal-tip">' + shopT('shop.admin.rejectTip', '拒绝后买家仍可再次提交退款申请。') + '</p>' +
            '<div class="sp-field"><label>' + shopT('shop.admin.rejectNoteLabel', '拒绝理由（选填）') + '</label><input id="refund-reject-note" maxlength="100" type="text" placeholder="' + shopT('shop.admin.rejectNotePlaceholder', '例如：商品已取走') + '"></div>',
          confirmText: shopT('shop.admin.rejectConfirm', '确认拒绝'),
          danger: true,
          onConfirm: async function () {
            var note = ($('#refund-reject-note').value || '').trim();
            await App.api('/admin/orders/' + oid + '/refund', { method: 'PUT', body: { approve: false, note: note } });
            App.showToast(shopT('shop.admin.rejected', '已拒绝该退款申请'), 'success');
            renderAdminOrders();
          }
        });
      });
    });
  }

  /**
   * 管理端退款审核区块 HTML（仅展示待审核 / 已拒绝；已退款由状态徽标体现）
   * @param {object} o 订单
   * @returns {string}
   */
  function refundAdminHtml(o) {
    /** 退款金额展示值：优先用申请快照 */
    var amount = o.refundAmount != null ? o.refundAmount : o.totalAmount;
    if (o.refundStatus === 'pending') {
      return '<div class="sp-admin-refund">' +
        '<div class="sp-refund-state">' + shopT('shop.admin.refundPendingAmount', '待审核退款 · {points} 积分', { points: App.fmtPoints(amount) }) + '</div>' +
        (o.refundReason ? '<div>' + shopT('shop.order.refundReason', '申请理由：{reason}', { reason: App.escapeHtml(o.refundReason) }) + '</div>' : '<div>' + shopT('shop.admin.refundNoReason', '买家未填写理由') + '</div>') +
        '<div class="sp-refund-actions">' +
          '<button class="btn btn-column2 btn-sm" data-refund-approve="' + o.id + '">' + shopT('shop.admin.approveRefund', '同意退款') + '</button>' +
          '<button class="btn btn-column4 btn-sm" data-refund-reject="' + o.id + '">' + shopT('shop.admin.rejectRefund', '拒绝退款') + '</button>' +
        '</div>' +
      '</div>';
    }
    if (o.refundStatus === 'rejected') {
      return '<div class="sp-admin-refund">' +
        '<div class="sp-refund-state">' + shopT('shop.admin.refundRejectedState', '退款已被拒绝') + '</div>' +
        (o.refundRejectReason ? '<div>' + shopT('shop.order.rejectReason', '拒绝理由：{reason}', { reason: App.escapeHtml(o.refundRejectReason) }) + '</div>' : '') +
      '</div>';
    }
    return '';
  }

  /* ===== 路由调度 ===== */

  /**
   * 显示指定视图、隐藏所有其它 .sp-view（包括动态创建的 view-product-editor），并同步侧栏高亮
   * @param {string|null} sectionId 视图 id；null 时不碰显隐（调用方自行控制，如 renderAdmin 内部切换 tab）
   * @param {{hideCartbar?:boolean}} opts
   */
  function showSection(sectionId, opts) {
    opts = opts || {};
    if (sectionId) {
      /* sectionId 有值 → 统一控制所有 .sp-view 的显隐 */
      document.querySelectorAll('.sp-view').forEach(function (el) {
        el.hidden = el.id !== sectionId;
        el.classList.toggle('active', el.id === sectionId);
      });
      /* 切换视图先清空顶栏动作，避免上一页的按钮在新页面数据加载期间仍可点击 */
      setTopbarActions([]);
    }
    /* cartbar 显隐 */
    if (sectionId && opts.hideCartbar) $('#cartbar').classList.add('hidden');
    else if (!opts.hideCartbar) $('#cartbar').classList.remove('hidden');
    /* 侧栏高亮 */
    var seg = currentSegments()[0] || 'home';
    var navRoute = { shop: 'home', order: 'orders' }[seg] || seg;
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(function (item) {
      item.classList.toggle('active', item.dataset.route === navRoute);
    });
    $('.content-area').scrollTop = 0;
  }

  /**
   * 渲染顶栏动作按钮（页面主按钮统一放顶栏，统一用图标按钮样式）
   * 带 back:true 的动作（返回按钮）渲染在顶栏最左；其余动作渲染在头像左侧，与头像间隔 16px
   * @param {Array<{icon:string, title:string, onClick:Function, back?:boolean}>} actions 动作列表；传空数组清空
   */
  function setTopbarActions(actions) {
    var leftBox = document.getElementById('topbar-left');     // 顶栏左侧容器（仅返回按钮）
    var rightBox = document.getElementById('topbar-actions'); // 顶栏右侧容器（其余主按钮）
    if (!leftBox || !rightBox) return;
    leftBox.innerHTML = '';
    rightBox.innerHTML = '';
    (actions || []).forEach(function (act) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-btn';   // 统一图标按钮样式，不做主次区分
      btn.title = act.title || '';
      btn.setAttribute('aria-label', act.title || '');
      btn.innerHTML = act.icon || '';
      if (typeof act.onClick === 'function') btn.addEventListener('click', act.onClick);
      (act.back ? leftBox : rightBox).appendChild(btn);
    });
  }

  /**
   * 解析当前 pathname 的路径段（去掉 /shop 前缀）
   * @returns {string[]} 路径段数组
   */
  function currentSegments() {
    var p = location.pathname;
    if (p.startsWith(BASE_PATH)) p = p.slice(BASE_PATH.length);
    if (!p.startsWith('/')) p = '/' + p;
    return p.split('/').filter(Boolean);
  }

  /** 解析路由并分发 */
  async function route() {
    var parts = currentSegments();
    try {
      if (parts.length === 0) await renderHome();
      else if (parts[0] === 'shop' && parts[1]) await renderShop(parts[1]);
      else if (parts[0] === 'cart') await renderCart();
      else if (parts[0] === 'orders') await renderOrders(false);
      else if (parts[0] === 'order' && parts[1]) await renderOrder(parts[1]);
      else if (parts[0] === 'myshops' && parts[1] && parts[2] === 'products') await renderMyShopProducts(parts[1]);
      else if (parts[0] === 'myshops') await renderMyShops();
      else if (parts[0] === 'admin' && parts[1] === 'product' && parts[2] === 'new') await renderProductEditor(null);
      else if (parts[0] === 'admin' && parts[1] === 'product' && parts[2]) await renderProductEditor(parts[2]);
      else if (parts[0] === 'admin') await renderAdmin();
      else await renderHome();
    } catch (e) {
      console.error('[shop] 视图渲染失败：', e);
    }
  }

  /* ===== boot ===== */

  /**
   * 等待 i18n 语言包就绪后再执行初始化（语言包加载失败时直接执行，保证兜底中文可用）
   * @param {Function} cb 初始化回调
   */
  function whenI18nReady(cb) {
    if (window.I18n && typeof window.I18n.ready === 'function') window.I18n.ready(cb);
    else cb();
  }

  /** 语言切换后重新渲染当前视图，并刷新顶栏/结算条等动态文案 */
  function onLangChange() {
    document.title = shopT('app.name', '明星学校');
    route();
    refreshCartBadge();
  }

  /** 页面启动：renderShell → 权限注入 → 事件绑定 → 首次路由 */
  async function boot() {
    // 标签页标题：站点名（随语言切换而变化）
    document.title = shopT('app.name', '明星学校');

    // 第一步：注入骨架（必须在所有 DOM 查询之前）
    renderShell();

    // 主题初始化（body 上已经有了 dark-mode 检测脚本前置处理，但 App.initTheme 做幂等兜底）
    App.initTheme();

    initModalClose();

    // 管理员可见管理后台入口
    var me = await App.initMe();
    if (me && me.isAdmin) {
      document.querySelectorAll('.admin-only').forEach(function (el) { el.classList.remove('hidden'); });
    }

    // 顶栏用户区（头像 + 名字；头像菜单由 common-ui.js 扫描 .user-info 自动挂载）
    App.initTopbarUser();

    // 首页搜索防抖
    var searchTimer = null;
    $('#home-search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { renderHome(); }, 300);
    });

    // 管理后台 tab 切换
    document.querySelectorAll('.sp-admin-tabs .sp-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { adminTab = tab.dataset.tab; renderAdmin(); });
    });

    // 结算条 → 购物车
    $('#cartbar-go').addEventListener('click', function () { navigate('/cart'); });

    // 浏览器前进/后退
    window.addEventListener('popstate', route);

    // 链接委托：页内 /shop/ 开头的 <a> 改走 SPA 跳转（不整页刷新）
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest('a[href^="/shop/"]');
      if (!a || a.target === '_blank') return;
      e.preventDefault();
      navigate(a.getAttribute('href').slice(BASE_PATH.length) || '/');
    });

    await route();
    refreshCartBadge();

    // 切换语言后重绘视图与动态文案（静态骨架靠 data-i18n 属性由框架自动更新）
    if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(onLangChange);
  }

  // DOMContentLoaded 时启动（此时 common-ui.js 已在 </body> 前加载完）；先等语言包就绪再渲染
  document.addEventListener('DOMContentLoaded', function () { whenI18nReady(boot); });
})();
