/**
 * common-ui —— 明星学校平台公共 UI 骨架（一次维护，全站生效）
 *
 * 在任意页面 </body> 前引入一行即可：
 *   <script src="/assets/common-ui.js"></script>
 *
 * 自动注入三件公共物：
 *   1. 标签页图标（favicon）：页面没有 <link rel="icon"> 时补平台 Logo
 *   2. 右上角 Toast 提示：样式照 docs/提示.html 设计稿（success/error/warning/info 四类，
 *      深色模式反色）；若页面已自定义 window.showToast 则尊重页面自己的实现
 *   3. 右侧悬浮工具条：分享 = 复制当前页链接；关闭 = 回到门户首页；
 *      左缘半圆把手可收起（"<"）/展开（">"）工具条，状态记忆在 localStorage；
 *      半透明黑底（#000 50%），深色模式 / 页面手动深色（body.dark-mode）自动反色
 *
 * 本文件自包含（无外部依赖），样式挂在专属类名下，不会与页面样式冲突。
 */
(function () {
  'use strict';

  /* ==================== 1. 标签页图标 ==================== */
  // 页面已声明图标就尊重页面配置（网盘/转盘有自己的图标）；否则补平台 Logo
  if (!document.querySelector('link[rel="icon"]')) {
    var icon = document.createElement('link'); // 新建的 favicon 标签
    icon.rel = 'icon';
    icon.type = 'image/png';
    icon.href = '/assets/home/logo.png';
    document.head.appendChild(icon);
  }

  /* ==================== 2. 公共样式（Toast + 工具条） ==================== */
  var style = document.createElement('style'); // 公共样式标签
  style.textContent =
    /* ---- Toast 提示 ---- */
    '.cui-toast-container{position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;}' +
    '.cui-toast{background:#fff;color:#333;padding:12px 20px;border-radius:8px;font-size:14px;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.15);border:1px solid #e1e5eb;max-width:300px;' +
      'opacity:0;transform:translateX(100%);transition:all .3s ease;}' +
    '.cui-toast.show{opacity:1;transform:translateX(0);}' +
    '.cui-toast.success{border-color:#27ae60;color:#27ae60;}' +
    '.cui-toast.error{border-color:#e74c3c;color:#e74c3c;}' +
    '.cui-toast.warning{border-color:#f1c40f;color:#f1c40f;}' +
    '.cui-toast.info{border-color:#3498db;color:#3498db;}' +
    /* ---- 悬浮工具条：贴右缘垂直居中，黑色 50% 透明底；左缘把手可收起/展开 ---- */
    '.cui-dock{position:fixed;right:0;top:50%;transform:translateY(-50%);display:flex;' +
      'align-items:center;z-index:9000;}' +
    '.cui-dock-panel{background:rgba(0,0,0,.5);border-radius:26px 0 0 26px;padding:10px 0;' +
      'display:flex;flex-direction:column;align-items:center;gap:6px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:80px;overflow:hidden;' +
      'transition:max-width .25s ease,opacity .25s ease,padding .25s ease;}' +
    '.cui-dock.collapsed .cui-dock-panel{max-width:0;padding:0;opacity:0;}' +
    /* 把手：面板左缘的半圆凸出块，点击切换收起/展开 */
    '.cui-dock-toggle{width:30px;height:64px;border:none;background:rgba(0,0,0,.5);color:#fff;' +
      'border-radius:15px 0 0 15px;display:flex;align-items:center;justify-content:center;' +
      'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:background .15s ease;padding:0;}' +
    '.cui-dock-toggle:hover{background:rgba(0,0,0,.65);}' +
    '.cui-dock-toggle svg{width:16px;height:16px;}' +
    '.cui-dock-btn{width:52px;padding:8px 0 6px;border:none;background:transparent;color:#fff;' +
      'display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;border-radius:14px;' +
      'transition:transform .15s ease;font-family:inherit;}' +
    '.cui-dock-btn:hover{background:transparent;}' +   /* 悬停不加底色 */
    '.cui-dock-btn:active{transform:scale(.94);background:transparent;}' +
    '.cui-dock-btn svg{width:22px;height:22px;}' +
    '.cui-dock-btn span{font-size:12px;line-height:1;}' +
    /* ---- 深色反色：跟随系统（门户）或页面手动深色（body.dark-mode）---- */
    '@media (prefers-color-scheme: dark){' +
      'body:not(.cui-light) .cui-toast{background:#1a1b1f;color:#eaeaea;border-color:#242424;box-shadow:0 4px 12px rgba(0,0,0,.3);}' +
      'body:not(.cui-light) .cui-toast.success{border-color:#51cf66;color:#51cf66;}' +
      'body:not(.cui-light) .cui-toast.error{border-color:#ff6b6b;color:#ff6b6b;}' +
      'body:not(.cui-light) .cui-toast.warning{border-color:#ffd43b;color:#ffd43b;}' +
      'body:not(.cui-light) .cui-toast.info{border-color:#339af0;color:#339af0;}' +
      'body:not(.cui-light) .cui-dock-panel{background:rgba(255,255,255,.5);box-shadow:0 4px 16px rgba(0,0,0,.4);}' +
      'body:not(.cui-light) .cui-dock-toggle{background:rgba(255,255,255,.5);color:#333;box-shadow:0 4px 16px rgba(0,0,0,.4);}' +
      'body:not(.cui-light) .cui-dock-toggle:hover{background:rgba(255,255,255,.75);}' +
      'body:not(.cui-light) .cui-dock-btn{color:#333;}' +
    '}' +
    'body.cui-dark .cui-toast,body.dark-mode .cui-toast{background:#1a1b1f;color:#eaeaea;border-color:#242424;box-shadow:0 4px 12px rgba(0,0,0,.3);}' +
    'body.cui-dark .cui-toast.success,body.dark-mode .cui-toast.success{border-color:#51cf66;color:#51cf66;}' +
    'body.cui-dark .cui-toast.error,body.dark-mode .cui-toast.error{border-color:#ff6b6b;color:#ff6b6b;}' +
    'body.cui-dark .cui-toast.warning,body.dark-mode .cui-toast.warning{border-color:#ffd43b;color:#ffd43b;}' +
    'body.cui-dark .cui-toast.info,body.dark-mode .cui-toast.info{border-color:#339af0;color:#339af0;}' +
    'body.cui-dark .cui-dock-panel,body.dark-mode .cui-dock-panel{background:rgba(255,255,255,.5);box-shadow:0 4px 16px rgba(0,0,0,.4);}' +
    'body.cui-dark .cui-dock-toggle,body.dark-mode .cui-dock-toggle{background:rgba(255,255,255,.5);color:#333;box-shadow:0 4px 16px rgba(0,0,0,.4);}' +
    'body.cui-dark .cui-dock-toggle:hover,body.dark-mode .cui-dock-toggle:hover{background:rgba(255,255,255,.75);}' +
    'body.cui-dark .cui-dock-btn,body.dark-mode .cui-dock-btn{color:#333;}' +
    /* ---- 手机端缩小 ---- */
    '@media (max-width:768px){' +
      '.cui-dock-panel{padding:8px 0;}' +
      '.cui-dock-btn{width:46px;}' +
      '.cui-dock-btn svg{width:20px;height:20px;}' +
      '.cui-dock-toggle{width:24px;height:52px;}' +
    '}';
  document.head.appendChild(style);

  /* ==================== 3. Toast（页面未自定义时才提供） ==================== */
  if (typeof window.showToast !== 'function') {
    /**
     * 显示右上角 Toast 提示
     * @param {string} message 提示内容（中文）
     * @param {string} [type='info'] 提示类型：success / error / warning / info
     */
    window.showToast = function (message, type) {
      // 容器：懒创建，页面右上角纵向排列
      var container = document.querySelector('.cui-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.className = 'cui-toast-container';
        document.body.appendChild(container);
      }
      var toast = document.createElement('div'); // 单条提示元素（每次新建，互不影响）
      toast.className = 'cui-toast ' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);

      // 双层 requestAnimationFrame：确保浏览器先应用初始隐藏态，再触发滑入淡入过渡
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          toast.classList.add('show');
        });
      });

      // 3 秒后滑出，过渡结束（300ms）后删除节点
      setTimeout(function () {
        toast.classList.remove('show');
        setTimeout(function () { toast.remove(); }, 300);
      }, 3000);
    };
  }

  /* ==================== 4. 右侧悬浮工具条 ==================== */
  /** 工具条收起状态在 localStorage 的键名（'true' = 已收起，只显示把手） */
  var DOCK_KEY = 'cuiDockCollapsed';

  /** 收起/展开把手箭头（"＞" = 面板将收向右缘，"＜" = 面板将向左展开） */
  var TOGGLE_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"></polyline></svg>';
  var TOGGLE_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';

  // 工具条 HTML：收起/展开把手 + 面板（展开态显示"＞"提示收起方向朝右，收起态显示"＜"提示展开方向朝左）
  var collapsed0 = localStorage.getItem(DOCK_KEY) === 'true'; // 初始收起态（记忆上次偏好）
  var dock = document.createElement('div'); // 工具条容器元素
  dock.className = 'cui-dock' + (collapsed0 ? ' collapsed' : '');
  dock.innerHTML =
    '<button class="cui-dock-toggle" title="' + (collapsed0 ? '展开工具条' : '收起工具条') + '">' +
      (collapsed0 ? TOGGLE_LEFT : TOGGLE_RIGHT) +
    '</button>' +
    '<div class="cui-dock-panel">' +
      '<button class="cui-dock-btn" data-act="share" title="复制链接">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
          '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle>' +
          '<circle cx="18" cy="19" r="3"></circle><path d="M8.7 13.5l6.6 4M15.3 6.5l-6.6 4"></path>' +
        '</svg><span>分享</span></button>' +
      '<button class="cui-dock-btn" data-act="close" title="回到门户">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
          '<path d="M6 6l12 12M18 6L6 18"></path>' +
        '</svg><span>关闭</span></button>' +
    '</div>';
  document.body.appendChild(dock);

  // 把手点击：切换面板收起/展开，并记忆偏好
  dock.querySelector('.cui-dock-toggle').addEventListener('click', function () {
    var collapsed = dock.classList.toggle('collapsed');            // 切换收起态
    localStorage.setItem(DOCK_KEY, collapsed ? 'true' : 'false');  // 持久化偏好
    var t = dock.querySelector('.cui-dock-toggle');                // 把手元素
    t.title = collapsed ? '展开工具条' : '收起工具条';
    t.innerHTML = collapsed ? TOGGLE_LEFT : TOGGLE_RIGHT;
  });

  // 事件委托：一次绑定处理两个按钮
  dock.addEventListener('click', async function (e) {
    // 点击动作分发：向上找按钮元素
    var btn = e.target.closest('.cui-dock-btn');
    if (!btn) return;

    if (btn.dataset.act === 'share') {
      // 分享 = 复制当前页面链接到剪贴板
      var url = window.location.href;                 // 要复制的页面链接
      try {
        await navigator.clipboard.writeText(url);     // 优先使用剪贴板 API（需 https 或 localhost）
        window.showToast('链接已复制', 'success');
      } catch (err) {
        // 降级方案：临时 textarea + execCommand（旧浏览器或非安全上下文）
        var input = document.createElement('textarea'); // 临时输入框元素
        input.value = url;
        document.body.appendChild(input);
        input.select();
        var ok = false;                               // 复制是否成功
        try { ok = document.execCommand('copy'); } catch (e2) {}
        document.body.removeChild(input);
        window.showToast(ok ? '链接已复制' : '复制失败，请手动复制地址栏链接', ok ? 'success' : 'error');
      }
    } else if (btn.dataset.act === 'close') {
      // 关闭 = 回到门户首页：主项目内走 SPA 内部导航（不整页刷新），其余场景整页跳转
      if (window.MainLayout && typeof MainLayout.nav === 'function') MainLayout.nav('/', true);
      else window.location.href = '/';
    }
  });

  /* ==================== 5. 平台偏好：深色模式 ==================== */
  // 深色模式：按设置页保存的偏好给 body 加 dark-mode 类（与网盘/转盘的深色体系兼容，幂等）
  try {
    if (localStorage.getItem('darkMode') === 'true') {
      document.body.classList.add('dark-mode');
    }
  } catch (e) { /* localStorage 不可用时忽略 */ }

  /* ==================== 6. 头像下拉菜单（子应用自动挂载） ==================== */
  // figma 123_41 设计：上段头像+姓名/ID → 积分行 → 分割线 → 退出登录。
  // 仅对子应用页面生效（body 带 dc-app / rc-app / bc-app / sp-app / qz-app 标识）；
  // 主项目页面（无标识类）由 main-layout.js 自己维护菜单，避免双重挂载。
  // 样式复用全站 all.css 的 avatar-menu-* 类；点空白处关闭。

  /** 退出登录图标（与 main-layout.js 一致的等效重绘 SVG） */
  var CUI_ICON_LOGOUT = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2H3.5C2.67 2 2 2.67 2 3.5v9C2 13.33 2.67 14 3.5 14H6M10.5 11L14 8L10.5 5M14 8H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /** 积分图标（金色星币 SVG，与 main-layout.js 一致） */
  var CUI_ICON_COIN = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#f5a623" stroke="#d48806"/><path d="M8 4.6l.9 1.83 2.02.29-1.46 1.42.35 2.01L8 9.2l-1.81.95.35-2.01-1.46-1.42 2.02-.29L8 4.6z" fill="#fff"/></svg>';

  /** /api/me 请求共享 Promise（多头像并发时只发一次） */
  var cuiMePromise = null;

  /**
   * 构建头像下拉菜单并挂到用户区
   * @param {HTMLElement} info 顶栏 .user-info 容器
   * @param {HTMLElement} avatar .user-avatar 头像容器（点击开/关菜单）
   * @param {object} me /api/me 返回的登录信息
   */
  function cuiBuildMenu(info, avatar, me) {
    var menu = document.createElement('div');            // 下拉菜单容器
    menu.className = 'avatar-menu';
    menu.hidden = true;

    // 上段：菜单内大头像 + 姓名/ID 纵排
    var imgSrc = (avatar.querySelector('img') || {}).src || '/assets/home/default-avatar.png';
    var head = document.createElement('div');            // 上段容器
    head.className = 'avatar-menu-head';
    head.innerHTML =
      '<img class="avatar-menu-avatar" src="' + imgSrc + '" alt="头像">' +
      '<div class="avatar-menu-meta">' +
        '<p class="avatar-menu-name">' + (me.name || '') + '</p>' +
        '<p class="avatar-menu-id">' + (me.userId || '') + '</p>' +
      '</div>';

    // 积分行：金币图标 + 积分数值（纯展示，管理员在用户管理页维护）
    var pointRow = document.createElement('div');        // 积分行
    pointRow.className = 'avatar-menu-point';
    pointRow.innerHTML = CUI_ICON_COIN;
    var pointText = document.createElement('span');      // 积分数值
    pointText.className = 'avatar-menu-point-text';
    pointText.textContent = String(me.points ?? 0);
    pointRow.appendChild(pointText);

    // 分割线 + 退出登录行
    var divider = document.createElement('div');         // 分隔线
    divider.className = 'avatar-menu-divider';
    var row = document.createElement('div');             // 退出登录行（hover 有底色）
    row.className = 'avatar-menu-row';
    row.innerHTML = CUI_ICON_LOGOUT;
    var rowText = document.createElement('span');        // 退出登录文字
    rowText.className = 'avatar-menu-row-text';
    rowText.textContent = '退出登录';
    row.appendChild(rowText);
    row.addEventListener('click', function () {
      // 退出登录：销毁会话后回统一登录页
      fetch('/api/logout', { method: 'POST' }).catch(function () {})
        .then(function () { window.location.href = '/login'; });
    });

    menu.appendChild(head);
    menu.appendChild(pointRow);
    menu.appendChild(divider);
    menu.appendChild(row);

    // 点头像开/关菜单（阻止冒泡避免立刻被空白关闭逻辑收掉）
    avatar.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    info.appendChild(menu);
  }

  /**
   * 扫描页面中的 .user-info 并为未处理的头像挂菜单（幂等，可反复调用）
   */
  function cuiScanMenus() {
    // 仅子应用页面自动挂载；主项目页面由 main-layout.js 维护
    var isSubApp = document.body.classList.contains('dc-app') ||
                   document.body.classList.contains('rc-app') ||
                   document.body.classList.contains('bc-app') ||
                   document.body.classList.contains('sp-app') ||
                   document.body.classList.contains('qz-app') ||
                   document.body.classList.contains('im-app');
    if (!isSubApp) return;

    var avatars = document.querySelectorAll('.user-info .user-avatar');
    for (var i = 0; i < avatars.length; i++) {
      var avatar = avatars[i];                           // 当前头像容器
      if (avatar.dataset.cuiMenu) continue;              // 已处理过
      var info = avatar.closest('.user-info');           // 所属用户区
      if (!info || info.querySelector('.avatar-menu')) continue;  // 已有菜单（页面自带）
      avatar.dataset.cuiMenu = '1';                      // 先上锁防并发重复挂载
      cuiMePromise = cuiMePromise || fetch('/api/me').then(function (r) { return r.json(); });
      (function (infoRef, avatarRef) {
        cuiMePromise.then(function (me) {
          if (me && me.loggedIn) cuiBuildMenu(infoRef, avatarRef, me);
        }).catch(function () { /* 网络异常：静默跳过，不影响页面 */ });
      })(info, avatar);
    }
  }

  // 初始扫描 + DOM 变化时防抖重扫（网盘/转盘动态渲染顶栏的场景）
  cuiScanMenus();
  document.addEventListener('DOMContentLoaded', cuiScanMenus);
  window.addEventListener('load', cuiScanMenus);
  if (window.MutationObserver) {
    var cuiScanTimer = null;                             // 防抖计时器
    new MutationObserver(function () {
      clearTimeout(cuiScanTimer);
      cuiScanTimer = setTimeout(cuiScanMenus, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // 点击空白处关闭已打开的头像菜单（document 级只注册一次）
  document.addEventListener('click', function (e) {
    var open = document.querySelector('.avatar-menu:not([hidden])');   // 当前打开的菜单
    if (!open) return;
    if (open.contains(e.target)) return;                               // 点在菜单内：保留
    var owner = open.parentElement;                                    // 菜单归属的 .user-info
    if (owner && owner.contains(e.target)) return;                     // 点在头像上：由 toggle 处理
    open.hidden = true;                                                // 其余空白处：关闭
  });

  /* ================= 禁用浏览器原生右键菜单 ================= */
  /* 全站统一：屏蔽默认右键菜单。
     页面内的自定义右键逻辑（如网盘文件菜单、IM 右键 @）绑定在元素上，
     仍会先于本监听执行，不受影响；此处只负责拦掉浏览器自带的菜单。 */
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });
})();
