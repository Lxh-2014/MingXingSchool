/*
 * app.js —— SPA 路由器（参考 mingxingdriver 的三件套：parseUrl / navigate / popstate）。
 *
 * 本项目特有：
 *   - 切换视图前先执行旧视图的 teardown（关 SSE、清定时器、解绑监听）
 *   - 侧边栏激活项高亮（无指示条、无动画）
 *   - 顶栏无标题文字（统一平台规范，仅右侧头像+用户名）；主题初始化在此幂等执行
 *
 * 视图约定（每个视图文件只定义不执行）：
 *   window.ConsoleView.init() → 返回 teardown()
 *   window.ChannelView.init(频道名) → 返回 teardown()
 */

window.Router = (function(){
  const { initTheme } = window.App;

  /**
   * 取多语言文案：i18n 框架未加载时回退中文兜底
   * @param {string} key 语言包键（如 app.name）
   * @param {string} fallback 中文兜底文案
   * @param {object} [params] 占位参数
   * @returns {string} 展示文案
   */
  function bcT(key, fallback, params) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : fallback;
  }

  /**
   * 同步标签页标题为站点名（语言切换后也要重设）
   */
  function syncTitle() {
    document.title = bcT('app.name', '明星学校');
  }

  // —— 取 DOM ——
  const viewConsole = document.getElementById('view-console');
  const viewChannel = document.getElementById('view-channel');
  const nav = document.getElementById('sidebar-nav');

  /** 当前视图的销毁函数，切换前先调用 */
  let currentTeardown = null;

  /**
   * 根据 URL 解析要显示的视图。
   * '/' → 控制台；'/channel/:name' → 收听页（name 支持中文编码）。
   * 兼容挂载前缀 /broadcast（明星学校主应用）。
   * @returns {{view:'console'}|{view:'channel',name:string}}
   */
  function parseUrl() {
    const path = location.pathname.replace(/^\/broadcast/, '');
    const m = /^\/channel\/(.+)$/.exec(path);
    if (m) return { view: 'channel', name: decodeURIComponent(m[1]) };
    return { view: 'console' };
  }

  /** 执行视图切换：先销毁旧视图，再按当前 URL 渲染新视图。 */
  function render() {
    if (currentTeardown) { currentTeardown(); currentTeardown = null; }

    const route = parseUrl();
    const isChannel = route.view === 'channel';
    viewConsole.hidden = isChannel;
    viewChannel.hidden = !isChannel;

    // 侧边栏激活态：频道项按 data-channel 匹配，首页项在非频道视图时激活
    nav.querySelectorAll('.nav-item').forEach(item => {
      const ch = item.dataset.channel;
      item.classList.toggle('active', isChannel ? ch === route.name : !ch);
    });

    // 标签页标题统一为站点名（两种视图共用）
    syncTitle();

    // 顶栏已无标题文字（统一平台规范），这里不再写顶栏文案

    currentTeardown = isChannel
      ? window.ChannelView.init(route.name)
      : window.ConsoleView.init();
  }

  /**
   * SPA 导航：pushState 后原地切换视图，不刷新页面。
   * @param {string} path 形如 '/' 或 '/channel/教室'
   */
  function navigate(path) {
    history.pushState(null, '', path);
    render();
  }

  // 浏览器前进/后退 → 重新渲染
  window.addEventListener('popstate', render);

  // 侧边栏导航拦截：所有导航项原地切换（不再开新标签/整页刷新）
  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a.nav-item');
    if (!a) return;
    e.preventDefault();
    // href 是相对路径（配合 <base href="/broadcast/">），先按 baseURI 解析成完整路径，
    // 让 pushState 得到带挂载前缀的 URL（如 /broadcast/channel/教室），刷新后仍在挂载路径内
    const target = new URL(a.getAttribute('href'), document.baseURI);
    navigate(target.pathname);
  });

  /**
   * 页面启动：兜底初始化主题、渲染顶栏用户区、首次渲染，并监听语言切换。
   * 由 I18n.ready 调用，确保首屏渲染时语言包已就绪。
   */
  function boot() {
    // 兜底初始化主题（防闪白脚本已写过 body class，这里幂等；顶栏主题切换按钮已按规范移除）
    initTheme();

    // 顶栏用户区初始化：拉取 /api/me 渲染头像与用户名（布局壳统一网盘）
    window.App.initTopbarUser();

    // 首次渲染（defer 脚本执行时 DOM 已就绪）
    render();

    // 语言切换 → 重翻译静态标注 + 重渲染当前视图（文案全部按新语言取）
    if (window.I18n && window.I18n.onChange) {
      window.I18n.onChange(() => {
        if (window.I18n.applyDom) window.I18n.applyDom(document);
        render();
      });
    }
  }

  // 语言包就绪后再启动；i18n 框架缺失时直接启动，兜底中文照常可用
  if (window.I18n && window.I18n.ready) window.I18n.ready(boot);
  else boot();

  return { navigate };
})();
