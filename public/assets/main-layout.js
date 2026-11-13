/**
 * 明星学校 · 主项目共享布局渲染器（门户首页 / 设置 / 用户管理 三页共用）
 * 职责：用 JS 动态渲染 侧边栏 + 顶栏（页面 HTML 中不再写结构 markup），
 *       拉取 /api/me 渲染顶栏用户区。侧边栏固定 72px 不可关闭，logo 不做跳转。
 * 依赖：/assets/all.css（全站唯一样式表）、/assets/common-ui.js（Toast 等公共件，可选）。
 */
window.MainLayout = (function () {
  /**
   * 取多语言文案：i18n 框架未加载时回退到中文兜底，保证页面始终可读
   * @param {string} key 语言包键
   * @param {string} fallback 中文兜底文案
   * @returns {string} 展示文案
   */
  function t(key, fallback) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, null, fallback) : fallback;
  }

  /** 首页导航图标（SVG） */
  var ICON_HOME = '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.90131 2.73304C4.30891 2.36834 4.51272 2.18599 4.74569 2.12473C4.91239 2.08089 5.0876 2.08089 5.2543 2.12473C5.48727 2.18599 5.69107 2.36834 6.09868 2.73304L7.82333 4.27614C8.20449 4.61718 8.00699 5.24836 7.49942 5.31132C7.32105 5.33344 7.18685 5.48458 7.18598 5.66432L7.17895 7.1266C7.17794 7.33724 7.17744 7.44257 7.1508 7.5282C7.09187 7.71768 6.94307 7.86576 6.75331 7.92378C6.66755 7.95 6.56223 7.95 6.35158 7.95C6.21054 7.95 6.14002 7.95 6.08269 7.93242C5.95581 7.8935 5.8565 7.79419 5.81758 7.66731C5.8 7.60998 5.8 7.53946 5.8 7.39842V6.65C5.8 6.20818 5.44182 5.85 5 5.85C4.55817 5.85 4.2 6.20818 4.2 6.65V7.39C4.2 7.53891 4.2 7.61336 4.18042 7.67361C4.14085 7.79539 4.04538 7.89086 3.9236 7.93043C3.86335 7.95 3.7889 7.95 3.64 7.95C3.41664 7.95 3.30497 7.95 3.21459 7.92064C3.03192 7.86129 2.88871 7.71808 2.82936 7.53541C2.8 7.44503 2.8 7.33336 2.8 7.11V5.69006C2.8 5.50938 2.66693 5.35629 2.48801 5.33113C1.97901 5.25955 1.78626 4.62545 2.16932 4.28271L3.90131 2.73304Z" fill="currentColor"/></svg>';

  /** 设置导航图标（SVG） */
  var ICON_GEAR = '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5.56 2.57C6.1 1.96 7.09 2.53 6.83 3.3c-.14.43.12.88.56.97.79.16.79 1.3 0 1.46-.44.09-.7.55-.56.98.26.77-.73 1.34-1.27.73-.29-.34-.82-.34-1.11 0-.54.61-1.53.04-1.27-.73.14-.43-.12-.88-.56-.97-.79-.16-.79-1.3 0-1.46.44-.09.7-.55.56-.98C2.91 2.53 3.9 1.96 4.44 2.57c.29.34.82.34 1.12 0zM5.6 3.96c-.57-.33-1.3-.13-1.63.54-.33.57-.13 1.3.54 1.64.57.33 1.3.13 1.63-.54.33-.57.13-1.3-.54-1.64z"></path></svg>';

  /** 用户管理导航图标（SVG，仅管理员可见） */
  var ICON_USER = '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.97363 5.30566C5.07554 5.32502 5.1343 5.37209 5.25098 5.46582C5.88039 5.9717 5.91987 6.70982 5.91992 6.83008C5.91985 7.01516 5.73474 7.75382 3.61035 7.75391C1.4856 7.75391 1.30086 7.01476 1.30078 6.83008C1.30082 6.70997 1.33962 5.97177 1.96875 5.46582C2.08542 5.37203 2.14412 5.32504 2.24609 5.30566C2.26052 5.30293 2.27637 5.30096 2.29102 5.2998C2.39458 5.29167 2.51793 5.34549 2.76465 5.45312C3.02364 5.56612 3.30974 5.62891 3.61035 5.62891C3.9107 5.62885 4.19637 5.56604 4.45508 5.45312C4.70175 5.34546 4.82516 5.29169 4.92871 5.2998C4.94333 5.30096 4.95923 5.30294 4.97363 5.30566ZM8.2998 5.64941C8.54808 5.64953 8.74975 5.85136 8.75 6.09961C8.75 6.34807 8.54823 6.54969 8.2998 6.5498H7.2002C6.95167 6.5498 6.75 6.34814 6.75 6.09961C6.75025 5.85129 6.95182 5.64941 7.2002 5.64941H8.2998ZM8.2998 3.9502C8.54824 3.9503 8.75 4.15193 8.75 4.40039C8.74977 4.64866 8.5481 4.85048 8.2998 4.85059H6.59961C6.35139 4.85038 6.14964 4.6486 6.14941 4.40039C6.14941 4.15199 6.35125 3.9504 6.59961 3.9502H8.2998ZM3.61035 2.2002C4.3246 2.20042 4.90332 2.77981 4.90332 3.49414C4.90307 4.20826 4.32444 4.78689 3.61035 4.78711C2.89607 4.78711 2.31666 4.20839 2.31641 3.49414C2.31641 2.77967 2.89592 2.2002 3.61035 2.2002ZM8.2998 2.25C8.54833 2.25 8.75 2.45167 8.75 2.7002C8.74982 2.94857 8.54822 3.15039 8.2998 3.15039H6C5.75159 3.15038 5.54999 2.94857 5.5498 2.7002C5.5498 2.45167 5.75148 2.25001 6 2.25H8.2998Z" fill="currentColor"/></svg>';

  /** 邮件导航图标（SVG，仅管理员可见） */
  var ICON_MAIL = '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.9 2.9h6.2c.3314 0 .6.2686.6.6v3.8c0 .3314-.2686.6-.6.6H1.9c-.3314 0-.6-.2686-.6-.6V3.5c0-.3314.2686-.6.6-.6Z" stroke="currentColor" stroke-width="0.9" stroke-linejoin="round"/><path d="M1.6 3.3l3.1 2.2c.18.13.42.13.6 0l3.1-2.2" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** 退出登录图标（SVG 16px，figma 导出的图标文件编码损坏，此处为等效重绘） */
  var ICON_LOGOUT = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2H3.5C2.67 2 2 2.67 2 3.5v9C2 13.33 2.67 14 3.5 14H6M10.5 11L14 8L10.5 5M14 8H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** 积分图标（金色星币 SVG 16px，头像菜单积分行用） */
  var ICON_COIN = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#f5a623" stroke="#d48806"/><path d="M8 4.6l.9 1.83 2.02.29-1.46 1.42.35 2.01L8 9.2l-1.81.95.35-2.01-1.46-1.42 2.02-.29L8 4.6z" fill="#fff"/></svg>';

  /** 收起/展开箭头图标已随侧边栏还原需求移除（展开/收起属于悬浮工具条） */

  /** 共享导航表：href 与激活标识一致；title 为中文兜底，titleKey 为语言包键；admin = 仅管理员可见的导航项 */
  var NAV_ITEMS = [
    { href: '/', title: '首页', titleKey: 'nav.home', icon: ICON_HOME },
    { href: '/settings', title: '设置', titleKey: 'nav.settings', icon: ICON_GEAR },
    { href: '/usermanagement', title: '用户管理', titleKey: 'nav.userManagement', icon: ICON_USER, admin: true },
    { href: '/mail', title: '邮件', titleKey: 'nav.mail', icon: ICON_MAIL, admin: true }
  ];

  /**
   * 应用上次保存的深色模式偏好（读取 localStorage.darkMode）
   */
  function applySavedDarkMode() {
    document.body.classList.toggle('dark-mode', localStorage.getItem('darkMode') === 'true');
  }

  /* ==================== SPA 路由（与转盘/广播器一致：pushState 切换，不整页刷新） ==================== */

  /** 主项目页面路由表：pathname → 页面入口标识（页面逻辑在 pages-main.js / page-mail.js 注册到 MainPages） */
  var PAGE_ROUTES = { '/': 'page-home', '/settings': 'page-settings', '/usermanagement': 'page-usermanagement', '/mail': 'page-mail' };

  /** 当前激活的 pathname（SPA 同页去重依据，由 loadPage / render 维护） */
  var currentPath = null;

  /**
   * 设置浏览器标签页标题：全站统一固定为站点名，并跟随当前语言
   */
  function applySiteTitle() {
    document.title = t('app.name', '明星学校');
  }

  // 语言切换后同步更新标签页标题（页面无需整体重渲染也能立即生效）
  document.addEventListener('i18n:changed', applySiteTitle);

  // 语言包异步加载完成后校正一次（首屏渲染时可能尚未加载完成）
  if (window.I18n && window.I18n.ready) window.I18n.ready(applySiteTitle);

  /** 登录态缓存：上一次 /api/me 的结果（SPA 切页时先按缓存即时渲染顶栏，消除头像闪动） */
  var cachedMe = null;

  /**
   * SPA 页面切换：pushState + 调用目标页面入口函数（pages-main.js），不整页刷新
   * @param {string} pathname 目标路径（'/' | '/settings' | '/usermanagement'）
   * @param {boolean} push 是否压入历史栈（浏览器前进/后退回调时传 false）
   */
  function loadPage(pathname, push) {
    var route = PAGE_ROUTES[pathname];
    if (!route) { window.location.href = pathname; return; }   // 非主项目三页（如 /login、子应用）走整页跳转
    if (pathname === currentPath) return;                      // 同页不重复加载
    currentPath = pathname;
    if (push) history.pushState({}, '', pathname);

    var root = document.getElementById('root');
    if (root) root.innerHTML = '';                             // 清空旧页面（入口函数会重新渲染布局）

    // 样式：HTML 壳已统一引入全站唯一样式表 /assets/all.css，SPA 切页无需再注入任何 CSS

    // 页面逻辑：脚本已在 HTML 壳中加载（pages-main.js），按 pathname 调用对应入口函数
    var entry = window.MainPages && window.MainPages[pathname];
    /* 当前页脚本未加载该页面逻辑（如从设置页跳到 /mail）时，退回整页跳转，避免空白页 */
    if (!entry) { window.location.href = pathname; return; }
    entry();
  }

  // 浏览器前进/后退：按当前地址切换对应页面
  window.addEventListener('popstate', function () { loadPage(location.pathname, false); });

  /** 侧边栏导航项缓存：href -> 元素（供登录态回来后点亮管理员导航） */
  var navCache = {};

  /**
   * 创建侧边栏（logo + 导航；固定 72px，logo 不跳转，禁止关闭）
   * @param {string} active 当前激活导航 href
   * @param {boolean} showUserMgmt 是否渲染"用户管理"导航位（主项目各页面均传 true，登录后按 isAdmin 决定显隐）
   * @returns {HTMLElement} 侧边栏元素
   */
  function buildSidebar(active, showUserMgmt) {
    var sidebar = document.createElement('aside');         // 侧边栏容器
    sidebar.className = 'sidebar';

    // Logo：仅展示平台 Logo，不绑定任何跳转（主项目禁止侧边栏回到门户页）
    var header = document.createElement('div');            // Logo 容器
    header.className = 'sidebar-header';
    var logo = document.createElement('div');              // Logo 本体
    logo.className = 'sidebar-logo';
    logo.title = t('nav.logoTitle', '明星学校');
    var logoImg = document.createElement('img');           // 平台 Logo 图片
    logoImg.src = '/assets/home/logo.png';
    logoImg.alt = t('nav.logoTitle', '明星学校');
    logo.appendChild(logoImg);
    header.appendChild(logo);
    sidebar.appendChild(header);

    // 导航区：首页 / 设置 / 用户管理（管理员）
    var nav = document.createElement('nav');               // 导航容器
    nav.className = 'sidebar-nav';
    navCache = {};                                         // 每次重建清空导航缓存
    NAV_ITEMS.forEach(function (it) {
      if (it.admin && !showUserMgmt) return;               // 该页不提供用户管理入口（如门户首页）
      var item = document.createElement('div');            // 单个导航项
      item.className = 'nav-item' + (it.href === active ? ' active' : '');
      item.title = t(it.titleKey, it.title);
      item.dataset.href = it.href;
      item.innerHTML = it.icon;
      if (it.admin) item.style.display = 'none';           // 管理员导航默认隐藏，确认 isAdmin 后再显示
      item.addEventListener('click', function () { loadPage(it.href, true); });
      nav.appendChild(item);
      navCache[it.href] = item;                            // 记入缓存供后续点亮
    });
    sidebar.appendChild(nav);

    return sidebar;
  }

  /**
   * 渲染顶栏用户信息：头像（点击弹出用户菜单：姓名/ID + 退出登录，点空白处关闭）
   * 桌面端仅头像（名字悬浮 title 查看），小屏显示"头像+名字"靠左
   * @param {HTMLElement} box 用户信息容器
   * @param {object|null} me /api/me 结果（null = 未登录渲染为空）
   */
  function renderUserInfo(box, me) {
    box.innerHTML = '';
    if (!me || !me.loggedIn) return;
    var avatar = document.createElement('div');            // 头像容器（点击弹出菜单）
    avatar.className = 'user-avatar';
    avatar.title = me.name || '';                          // 悬浮头像显示名字（title 组件）
    var img = document.createElement('img');               // 头像图片：有则显示，无则用平台默认头像
    img.src = me.avatar || '/assets/home/default-avatar.png';
    img.alt = me.name || t('common.avatar', '头像');
    avatar.appendChild(img);
    var name = document.createElement('span');             // 姓名：桌面端隐藏，小屏显示在头像旁
    name.className = 'user-name';
    name.textContent = me.name || '';

    // ---- 用户下拉菜单（figma 设计：256 宽圆角卡片，上段头像+姓名/ID，下段退出登录行） ----
    var menu = document.createElement('div');              // 下拉菜单容器
    menu.className = 'avatar-menu';
    menu.hidden = true;                                    // 默认隐藏，点头像显示
    var head = document.createElement('div');              // 上段：头像 + 姓名/ID
    head.className = 'avatar-menu-head';
    var mAv = document.createElement('img');               // 菜单内大头像
    mAv.className = 'avatar-menu-avatar';
    mAv.src = img.src;
    mAv.alt = me.name || t('common.avatar', '头像');
    var meta = document.createElement('div');              // 姓名/ID 纵排
    meta.className = 'avatar-menu-meta';
    var mName = document.createElement('p');               // 姓名行
    mName.className = 'avatar-menu-name';
    mName.textContent = me.name || '';
    var mId = document.createElement('p');                 // ID 行
    mId.className = 'avatar-menu-id';
    mId.textContent = (me.userId || '');
    meta.appendChild(mName);
    meta.appendChild(mId);
    head.appendChild(mAv);
    head.appendChild(meta);
    // 积分行（figma 123_41：头像信息与分割线之间的纯展示行）
    var pointRow = document.createElement('div');          // 积分行：金币图标 + 「积分：N」
    pointRow.className = 'avatar-menu-point';
    pointRow.innerHTML = ICON_COIN;
    var pointText = document.createElement('span');        // 积分文字
    pointText.className = 'avatar-menu-point-text';
    pointText.textContent = String(me.points ?? 0);
    pointRow.appendChild(pointText);
    var divider = document.createElement('div');           // 分隔线
    divider.className = 'avatar-menu-divider';
    var row = document.createElement('div');               // 退出登录行（hover/按下有底色）
    row.className = 'avatar-menu-row';
    row.innerHTML = ICON_LOGOUT;
    var rowText = document.createElement('span');          // 退出登录文字
    rowText.className = 'avatar-menu-row-text';
    rowText.textContent = t('common.logout', '退出登录');
    row.appendChild(rowText);
    row.addEventListener('click', function () {
      // 退出登录：销毁会话后回统一登录页
      fetch('/api/logout', { method: 'POST' }).catch(function () { /* 网络异常也继续跳转 */ })
        .then(function () { window.location.href = '/login'; });
    });
    menu.appendChild(head);
    menu.appendChild(pointRow);
    menu.appendChild(divider);
    menu.appendChild(row);

    // 点头像开/关菜单；阻止冒泡避免立刻被空白关闭逻辑收掉
    avatar.addEventListener('click', function () {
      if (menu.hidden) {
        // 桌面端按头像实际位置锚定（右对齐、贴头像下方 10px），不依赖祖先定位链；
        // 小屏清空内联样式，交给 CSS 的全宽下拉抽屉
        if (window.innerWidth > 768) {
          var ar = avatar.getBoundingClientRect();           // 头像视口坐标
          var ur = box.getBoundingClientRect();              // 用户区视口坐标
          var vx = Math.max(8, ar.right - 256);              // 期望菜单视口左缘（右对齐头像右缘，且不出屏幕左侧）
          menu.style.top = (ar.bottom - ur.top + 10) + 'px';
          menu.style.left = (vx - ur.left) + 'px';
        } else {
          menu.style.top = '';
          menu.style.left = '';
        }
      }
      menu.hidden = !menu.hidden;
    });

    box.appendChild(avatar);
    box.appendChild(name);
    box.appendChild(menu);
  }

  // 点击空白处关闭已打开的头像菜单（document 级只注册一次，SPA 切页共用）
  document.addEventListener('click', function (e) {
    var open = document.querySelector('.avatar-menu:not([hidden])');   // 当前打开的菜单
    if (!open) return;
    if (open.contains(e.target)) return;                               // 点在菜单内：保留
    var owner = open.parentElement;                                    // 菜单归属的 .user-info（含头像）
    if (owner && owner.contains(e.target)) return;                     // 点在头像上：由 toggle 处理
    open.hidden = true;                                                // 其余空白处：关闭
  });

  /**
   * 渲染整页布局：侧边栏 + 顶栏 + 内容容器，并拉取登录态
   * @param {object} opts
   *   active       当前激活导航 href：'/' | '/settings' | '/usermanagement'
   *   showUserMgmt 是否提供"用户管理"导航位（true 时仅管理员可见）
   *   padded       内容区是否加默认内边距（门户的桌面背景页传 false）
   *   actions      Function(me, actionsBox) 顶栏右侧动作按钮（如登录/退出），可空
   * @returns {Promise<{me: object|null, content: HTMLElement}>} 登录信息与内容容器
   */
  function render(opts) {
    opts = opts || {};
    applySavedDarkMode();                                  // 先应用深色偏好，避免闪白
    currentPath = PAGE_ROUTES[opts.active] ? opts.active : currentPath;  // 记录当前页面（SPA 去重依据）
    applySiteTitle();                                      // 标签页标题统一为站点名

    var container = document.getElementById('root') || document.body;  // 挂载点
    container.innerHTML = '';

    var wrap = document.createElement('div');              // 整体布局容器
    wrap.className = 'main-container';

    // 侧边栏
    wrap.appendChild(buildSidebar(opts.active, opts.showUserMgmt !== false));

    // 主内容：顶栏 + 内容区
    var main = document.createElement('main');             // 主内容列
    main.className = 'main-content';

    var topbar = document.createElement('header');         // 顶栏（无标题文字，仅右侧用户区/动作按钮）
    topbar.className = 'topbar';

    var right = document.createElement('div');             // 顶栏右侧：动作按钮 + 用户信息
    right.className = 'topbar-right';
    var actionsBox = document.createElement('div');        // 动作按钮容器（登录/退出等）
    actionsBox.className = 'topbar-actions';
    var userInfo = document.createElement('div');          // 用户信息容器
    userInfo.className = 'user-info';
    right.appendChild(actionsBox);
    right.appendChild(userInfo);
    topbar.appendChild(right);
    main.appendChild(topbar);

    var content = document.createElement('div');           // 内容滚动区
    content.className = 'content-area' + (opts.padded ? ' padded' : '');
    main.appendChild(content);

    wrap.appendChild(main);
    container.appendChild(wrap);

    // 先用缓存的登录态同步渲染顶栏（消除 SPA 切页时头像/按钮的闪动）
    var actionsDone = false;                               // 动作按钮是否已用缓存渲染过
    if (cachedMe) {
      renderUserInfo(userInfo, cachedMe);
      if (typeof opts.actions === 'function') { opts.actions(cachedMe, actionsBox); actionsDone = true; }
    }

    // 拉取最新登录态：刷新用户区 + 管理员导航显隐 + 未用缓存渲染过的动作按钮
    return fetch('/api/me')
      .then(function (r) { return r.json(); })
      .catch(function () { return { loggedIn: false }; })
      .then(function (me) {
        cachedMe = me;                                     // 更新缓存供下次切页即时渲染
        if (userInfo.isConnected) {                        // 页面未切换才更新（防旧请求污染新页面）
          renderUserInfo(userInfo, me);
          if (!actionsDone && typeof opts.actions === 'function') opts.actions(me, actionsBox);
        }
        if (me && me.loggedIn && me.isAdmin) {
          // 管理员：点亮侧边栏所有管理员导航项（用户管理 / 邮件）
          NAV_ITEMS.forEach(function (it) {
            if (!it.admin) return;
            var item = navCache[it.href];                  // 对应的导航项
            if (item) item.style.display = '';
          });
        }
        return { me: me, content: content };
      });
  }

  return { render: render, nav: loadPage };
})();
