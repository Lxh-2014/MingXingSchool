/**
 * "做个决定" SPA 入口
 * =======================================================
 * 路由：/home  /manage  /editor  /wheel/:id
 * （登录/个人资料/用户管理已收口到主项目 /login /settings /usermanagement）
 * 所有页面 DOM 均由本文件动态生成，无硬编码 HTML
 *
 * 全局依赖（index.html 已加载）：
 *   Auth, LocalDB, Modal, Toast, SpinWheel
 */

// ============ 全局工具 ============

/** 应用挂载前缀：明星学校主应用把转盘挂在 /roulette */
const APP_BASE = '/roulette';

/**
 * 取多语言文案：i18n 框架未加载时回退中文兜底
 * @param {string} key 语言包键（如 roulette.actions.spin）
 * @param {string} fallback 中文兜底文案
 * @param {object} [params] 占位参数（如 {count: 3}）
 * @returns {string} 最终展示文案
 */
function rlT(key, fallback, params) {
  return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : (fallback || key);
}

/** 容器快捷引用 */
const $app = () => document.getElementById('app');

/**
 * 渲染一个完整页面（替换 app 节点所有内容）
 * @param {string} html 新页面 HTML
 */
function mount(html) {
  $app().innerHTML = html;
}

/** 小节点（用于动态插入） */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** 绑定暗色切换（body 上，存 localStorage） */
function bindDarkToggle() {
  const saved = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark-mode', saved);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.onclick = () => {
    const on = document.body.classList.toggle('dark-mode');
    localStorage.setItem('darkMode', on ? 'true' : 'false');
  };
}

/**
 * SPA 路由跳转：使用 history.pushState 改地址栏，再调用 route() 重新渲染，不刷新页面
 * @param {string} path 目标路径（应用内相对路径），如 '/home'、'/manage'、'/wheel/xxx'
 */
function goto(path) {
  // 同一地址不重复压栈（实际地址 = 挂载前缀 + 应用内路径）
  if (location.pathname === APP_BASE + path) return;
  history.pushState({}, '', APP_BASE + path);
  route();
}

/** 监听浏览器前进/后退，重新渲染对应页面 */
window.addEventListener('popstate', () => route());

// ==================== 统一应用布局（参考 mingxingdriver：侧边栏 + 顶部栏） ====================

/** 侧边栏导航图标（来自 570+Icons 图标库，fill=currentColor 跟随导航项颜色） */
const NAV_ICONS = {
  // 首页 —— 房子
  home: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.90131 2.73304C4.30891 2.36834 4.51272 2.18599 4.74569 2.12473C4.91239 2.08089 5.0876 2.08089 5.2543 2.12473C5.48727 2.18599 5.69107 2.36834 6.09868 2.73304L7.82333 4.27614C8.20449 4.61718 8.00699 5.24836 7.49942 5.31132C7.32105 5.33344 7.18685 5.48458 7.18598 5.66432L7.17895 7.1266C7.17794 7.33724 7.17744 7.44257 7.1508 7.5282C7.09187 7.71768 6.94307 7.86576 6.75331 7.92378C6.66755 7.95 6.56223 7.95 6.35158 7.95C6.21054 7.95 6.14002 7.95 6.08269 7.93242C5.95581 7.8935 5.8565 7.79419 5.81758 7.66731C5.8 7.60998 5.8 7.53946 5.8 7.39842V6.65C5.8 6.20818 5.44182 5.85 5 5.85C4.55817 5.85 4.2 6.20818 4.2 6.65V7.39C4.2 7.53891 4.2 7.61336 4.18042 7.67361C4.14085 7.79539 4.04538 7.89086 3.9236 7.93043C3.86335 7.95 3.7889 7.95 3.64 7.95C3.41664 7.95 3.30497 7.95 3.21459 7.92064C3.03192 7.86129 2.88871 7.71808 2.82936 7.53541C2.8 7.44503 2.8 7.33336 2.8 7.11V5.69006C2.8 5.50938 2.66693 5.35629 2.48801 5.33113C1.97901 5.25955 1.78626 4.62545 2.16932 4.28271L3.90131 2.73304Z" fill="currentColor"/></svg>',
  // 转盘管理 —— 设置（齿轮）
  manage: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.55999 2.56686C6.09912 1.95654 7.08673 2.52674 6.82774 3.2988C6.68511 3.72449 6.94771 4.17908 7.38776 4.26826C8.18565 4.43017 8.18546 5.57002 7.38742 5.73174C6.94735 5.82094 6.68466 6.27607 6.82737 6.70179C7.08634 7.47379 6.09928 8.04394 5.56013 7.43382C5.26292 7.09737 4.73791 7.09735 4.44053 7.43356C3.90141 8.04388 2.9138 7.47368 3.17279 6.70163C3.31531 6.27607 3.05258 5.82149 2.61277 5.73216C1.8147 5.57043 1.8143 4.43005 2.61226 4.2682C3.0524 4.179 3.31514 3.72392 3.17232 3.29815C2.91367 2.52623 3.90134 1.95636 4.4404 2.5666C4.73771 2.90293 5.26272 2.90324 5.55999 2.56686ZM5.59969 3.96099C5.02577 3.62978 4.29153 3.82641 3.9602 4.40029C3.62913 4.97413 3.8263 5.70758 4.39999 6.03894C4.97383 6.37025 5.70753 6.17418 6.039 5.60049C6.37037 5.02654 6.17365 4.29236 5.59969 3.96099Z" fill="currentColor"/></svg>',
};

/** 操作类图标按钮（来自 570+Icons 图标库，fill=currentColor 跟随按钮颜色） */
const ACTION_ICONS = {
  // 复制 —— 3.编辑工具/复制
  copy: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.18213 3.94972C4.69925 3.94972 5.05183 3.9507 5.31787 3.98293C5.57404 4.01404 5.69747 4.06941 5.78174 4.14113C5.81343 4.1682 5.84351 4.19832 5.87061 4.23C5.94254 4.31422 5.99858 4.43738 6.02979 4.69386C6.06207 4.9599 6.06201 5.31235 6.06201 5.82961V6.42921C6.06201 7.10594 6.06225 7.44503 5.87061 7.66945C5.84351 7.70116 5.81344 7.73024 5.78174 7.75734C5.55732 7.94901 5.21826 7.94972 4.5415 7.94972H3.58154C2.90508 7.94972 2.56666 7.94897 2.34229 7.75734C2.31058 7.73024 2.28051 7.70116 2.25342 7.66945C2.06177 7.44503 2.06201 7.10595 2.06201 6.42921V5.46925C2.06201 4.79284 2.06193 4.4544 2.25342 4.23C2.2806 4.19817 2.31046 4.16832 2.34229 4.14113C2.51059 3.9974 2.74309 3.96156 3.13428 3.95265L3.58154 3.94972H4.18213ZM6.41748 2.05031C7.09407 2.05031 7.43232 2.05018 7.65674 2.24171C7.6886 2.26893 7.71839 2.29872 7.74561 2.33058C7.93726 2.555 7.93799 2.89315 7.93799 3.56984V4.5298C7.93799 5.20645 7.93719 5.54463 7.74561 5.76906C7.7184 5.80092 7.6886 5.83071 7.65674 5.85793C7.52192 5.97302 7.34606 6.01935 7.08044 6.03796C6.96129 6.0463 6.86279 5.94905 6.86279 5.82961C6.86279 5.33235 6.86327 4.92267 6.82373 4.59718C6.78302 4.26248 6.69442 3.96269 6.479 3.71046C6.42468 3.64691 6.36485 3.58703 6.30127 3.53273C6.04906 3.31763 5.74915 3.22865 5.41455 3.188C5.08908 3.14854 4.67923 3.14992 4.18213 3.14992C4.04967 3.14992 3.94152 3.04103 3.95047 2.90888C3.96852 2.64215 4.01402 2.46572 4.12939 2.33058C4.15661 2.29873 4.1864 2.26892 4.21826 2.24171C4.44268 2.05012 4.78088 2.05031 5.45752 2.05031H6.41748Z" fill="currentColor"/></svg>',
  // 下载/导出 —— 2.媒体与科技/下载
  download: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.2998 6.94922C7.68632 6.94922 7.99987 7.26293 8 7.64941C8 8.03601 7.6864 8.34961 7.2998 8.34961H2.7002C2.3136 8.34961 2 8.03601 2 7.64941C2.00013 7.26293 2.31368 6.94922 2.7002 6.94922H7.2998ZM5.19727 1.65039C5.52845 1.65061 5.79688 1.91877 5.79688 2.25V2.36853C5.79688 2.68589 5.79688 2.84457 5.87995 2.95245C5.89273 2.96905 5.90372 2.98135 5.91878 2.99591C6.01664 3.09058 6.19631 3.11089 6.55563 3.15151C6.74452 3.17286 6.87085 3.21353 6.95312 3.29102C7.06689 3.39831 7.13496 3.54591 7.1416 3.70215C7.15171 3.94024 6.90921 4.21913 6.42578 4.77734L5.8584 5.43262C5.48026 5.86926 5.29135 6.08837 5.04883 6.10938C5.01465 6.11231 4.97949 6.11231 4.94531 6.10938C4.70283 6.08832 4.51386 5.86923 4.13574 5.43262L3.56836 4.77734C3.08496 4.21916 2.84341 3.94023 2.85352 3.70215C2.86016 3.54592 2.92726 3.39831 3.04102 3.29102C3.12328 3.21351 3.24962 3.17284 3.43851 3.15149C3.79783 3.11089 3.97749 3.09058 4.07536 2.99592C4.09041 2.98135 4.10141 2.96905 4.11419 2.95245C4.19727 2.84457 4.19727 2.68589 4.19727 2.36853V2.25C4.19727 1.91863 4.4655 1.65039 4.79688 1.65039H5.19727Z" fill="currentColor"/></svg>',
  // 编辑 —— 3.编辑工具/铅笔
  edit: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.54598 3.44428C7.78016 3.20995 7.77956 2.82988 7.54529 2.59561L7.40442 2.45474C7.17016 2.22048 6.79008 2.21988 6.55576 2.45405L6.47091 2.53891C6.35127 2.65854 6.29145 2.71836 6.28566 2.79191C6.28484 2.80236 6.28484 2.81285 6.28566 2.8233C6.29145 2.89685 6.35127 2.95667 6.47091 3.07631L6.92373 3.52913C7.04336 3.64877 7.10318 3.70858 7.17674 3.71437C7.18718 3.7152 7.19768 3.7152 7.20812 3.71437C7.28168 3.70858 7.3415 3.64877 7.46113 3.52913L7.54598 3.44428ZM2.52511 7.47493C2.61022 7.56001 2.73896 7.58371 2.84897 7.535L3.77014 7.12621C3.88222 7.07636 3.98448 7.00578 4.07122 6.91905L6.35749 4.63277C6.47713 4.51314 6.53694 4.45332 6.54273 4.37976C6.54356 4.36932 6.54356 4.35882 6.54273 4.34838C6.53694 4.27482 6.47713 4.215 6.35749 4.09537L5.90467 3.64254C5.78503 3.52291 5.72522 3.46309 5.65166 3.4573C5.64121 3.45648 5.63072 3.45648 5.62028 3.4573C5.54672 3.46309 5.4869 3.52291 5.36727 3.64254L3.08099 5.92882C2.99425 6.01556 2.92367 6.11781 2.87383 6.22989L2.46504 7.15107C2.41634 7.26108 2.44001 7.38983 2.52511 7.47493Z" fill="currentColor"/></svg>',
  // 删除 —— 2.媒体与科技/垃圾桶
  trash: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 2.05029C5.76257 2.05029 5.98515 2.21883 6.06641 2.45361C6.10253 2.558 6.18935 2.6499 6.2998 2.6499H7.2002C7.53136 2.64999 7.79959 2.91838 7.7998 3.24951C7.79981 3.5153 7.62704 3.74086 7.3877 3.81982C7.28641 3.85317 7.19565 3.93402 7.19043 4.04053L7.08789 6.14209C7.04847 6.95025 7.02876 7.35484 6.79004 7.61963C6.75621 7.65712 6.71976 7.69216 6.68066 7.72412C6.40456 7.94965 5.99955 7.94971 5.19043 7.94971H4.80957C4.00065 7.94971 3.59641 7.94952 3.32031 7.72412C3.28106 7.69206 3.2439 7.65726 3.20996 7.61963C2.97124 7.35484 2.95153 6.95025 2.91211 6.14209L2.80957 4.04053C2.80435 3.93403 2.71358 3.85317 2.6123 3.81982C2.37297 3.74084 2.2002 3.51528 2.2002 3.24951C2.20041 2.91839 2.46867 2.65002 2.7998 2.6499H3.7002C3.81065 2.6499 3.89747 2.558 3.93359 2.45361C4.01485 2.21883 4.23745 2.05031 4.5 2.05029H5.5ZM4.11328 4.15088C3.86639 4.1587 3.67198 4.36387 3.67773 4.61084L3.72266 6.51025C3.72866 6.7599 3.9369 6.95648 4.18652 6.94873C4.4336 6.94103 4.62793 6.7359 4.62207 6.48877L4.57715 4.58936C4.57104 4.3398 4.36284 4.14313 4.11328 4.15088ZM5.88672 4.15088C5.63716 4.14313 5.42896 4.3398 5.42285 4.58936L5.37793 6.48877C5.37208 6.73587 5.56644 6.94099 5.81348 6.94873C6.06309 6.95648 6.27133 6.7599 6.27734 6.51025L6.32227 4.61084C6.32802 4.36384 6.13365 4.15866 5.88672 4.15088Z" fill="currentColor"/></svg>',
  // 移除/关闭 —— 1.用户界面/叉号
  close: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.3435 2.66698C6.61678 2.39384 7.06039 2.39296 7.33373 2.666C7.6068 2.93926 7.60668 3.3829 7.33373 3.65623L6.79608 4.19388C6.43718 4.55279 6.25773 4.73224 6.24036 4.95291C6.23789 4.98424 6.23789 5.01572 6.24036 5.04706C6.25773 5.26773 6.43718 5.44718 6.79608 5.80609L7.33373 6.34373C7.60672 6.61705 7.60676 7.06068 7.33373 7.33397C7.06039 7.60701 6.61678 7.60613 6.3435 7.33299L5.80585 6.79534C5.44694 6.43644 5.26749 6.25699 5.04682 6.23962C5.01549 6.23715 4.98401 6.23715 4.95267 6.23962C4.732 6.25699 4.55255 6.43644 4.19365 6.79534L3.656 7.33299C3.38263 7.60636 2.93913 7.60636 2.66576 7.33299C2.39298 7.05958 2.39357 6.61691 2.66674 6.34373L3.20439 5.80609C3.56329 5.44718 3.74274 5.26773 3.76011 5.04706C3.76258 5.01572 3.76258 4.98424 3.76011 4.95291C3.74274 4.73224 3.56329 4.55279 3.20439 4.19388L2.66674 3.65623C2.39355 3.38304 2.39292 2.94039 2.66576 2.66698C2.93913 2.39361 3.38263 2.39361 3.656 2.66698L4.19365 3.20462C4.55255 3.56353 4.732 3.74298 4.95267 3.76035C4.98401 3.76282 5.01549 3.76282 5.04682 3.76035C5.26749 3.74298 5.44694 3.56353 5.80585 3.20463L6.3435 2.66698Z" fill="currentColor"/></svg>',
  // 返回 —— 4.形状与符号/左箭头
  back: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.38644 2.29964C6.71789 2.10083 7.14845 2.20851 7.34738 2.53987C7.54627 2.87135 7.43859 3.30188 7.10715 3.50081L5.69385 4.34824C5.2363 4.62259 5.00753 4.75976 4.98692 4.95874C4.98409 4.9861 4.98408 5.01368 4.98691 5.04103C5.00746 5.24002 5.23619 5.37726 5.69366 5.65174L7.10715 6.49983C7.43854 6.69873 7.54615 7.12931 7.34738 7.46077C7.14844 7.79216 6.7179 7.8989 6.38644 7.70003L2.89426 5.60432C2.43799 5.33047 2.4379 4.66915 2.89426 4.39534L6.38644 2.29964Z" fill="currentColor"/></svg>',
  // 上移 —— 左箭头绕中心顺时针旋转90°
  up: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path transform="rotate(90 5 5)" d="M6.38644 2.29964C6.71789 2.10083 7.14845 2.20851 7.34738 2.53987C7.54627 2.87135 7.43859 3.30188 7.10715 3.50081L5.69385 4.34824C5.2363 4.62259 5.00753 4.75976 4.98692 4.95874C4.98409 4.9861 4.98408 5.01368 4.98691 5.04103C5.00746 5.24002 5.23619 5.37726 5.69366 5.65174L7.10715 6.49983C7.43854 6.69873 7.54615 7.12931 7.34738 7.46077C7.14844 7.79216 6.7179 7.8989 6.38644 7.70003L2.89426 5.60432C2.43799 5.33047 2.4379 4.66915 2.89426 4.39534L6.38644 2.29964Z" fill="currentColor"/></svg>',
  // 下移 —— 左箭头绕中心逆时针旋转90°
  down: '<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path transform="rotate(-90 5 5)" d="M6.38644 2.29964C6.71789 2.10083 7.14845 2.20851 7.34738 2.53987C7.54627 2.87135 7.43859 3.30188 7.10715 3.50081L5.69385 4.34824C5.2363 4.62259 5.00753 4.75976 4.98692 4.95874C4.98409 4.9861 4.98408 5.01368 4.98691 5.04103C5.00746 5.24002 5.23619 5.37726 5.69366 5.65174L7.10715 6.49983C7.43854 6.69873 7.54615 7.12931 7.34738 7.46077C7.14844 7.79216 6.7179 7.8989 6.38644 7.70003L2.89426 5.60432C2.43799 5.33047 2.4379 4.66915 2.89426 4.39534L6.38644 2.29964Z" fill="currentColor"/></svg>',
};

/**
 * 生成统一应用布局 HTML（侧边栏 + 顶部栏 + 内容区）
 * @param {object} session 当前会话
 * @param {string} active 当前激活的导航路径（如 '/home'）
 * @param {string} contentHtml 内容区 HTML
 * @returns {string} 完整页面 HTML
 */
function appLayout(session, active, contentHtml) {
  const me = session.profile || session.user || {}; // 当前用户信息
  const isAdmin = me.role === 'admin'; // 是否管理员，决定是否显示“用户管理”入口
  const name = me.username || me.name || ''; // 显示名
  const avatarUrl = me.avatar || '/assets/home/default-avatar.png'; // 头像：优先用户上传图，否则用平台默认头像图

  // 导航项列表（个人资料/用户管理已收口到主项目设置页，不再提供）
  const items = [
    { href: '/home', icon: NAV_ICONS.home, title: rlT('roulette.nav.home', '首页') },
    { href: '/manage', icon: NAV_ICONS.manage, title: rlT('roulette.nav.manage', '转盘管理') },
  ];

  const nav = items.map(it => `
    <div class="nav-item ${it.href === active ? 'active' : ''}" data-nav="${it.href}" title="${it.title}">${it.icon}</div>
  `).join('');

  return `
    <div class="main-container">
      <aside class="sidebar">
        <div class="sidebar-header"><span class="sidebar-logo" title="${rlT('roulette.title', '明星转盘')}" style="display:flex;overflow:hidden;border-radius:12px;"><img src="assets/icon.png" alt="logo" style="width:100%;height:100%;object-fit:cover;"></span></div>
        <nav class="sidebar-nav">${nav}</nav>
      </aside>
      <div class="main-content">
        <header class="topbar">
          <div class="user-info">
            <div class="user-avatar" title="${name}"><img src="${avatarUrl}" alt="${rlT('roulette.layout.avatarAlt', '头像')}"></div>
            <span class="user-name">${name}</span>
          </div>
        </header>
        <div class="content-area">${contentHtml}</div>
      </div>
    </div>
  `;
}

/** 绑定侧边栏导航点击跳转（每个页面 mount 后调用） */
function bindAppNav() {
  document.querySelectorAll('[data-nav]').forEach(item => {
    item.addEventListener('click', () => goto(item.dataset.nav));
  });
}

// ============ Router ============

/**
 * 根据当前 pathname 分发页面
 */
async function route() {
  // 去掉挂载前缀得到应用内路径；前缀不存在时（独立运行）保持原路径
  const rawPath = location.pathname;
  const path = rawPath.startsWith(APP_BASE) ? (rawPath.slice(APP_BASE.length) || '/') : rawPath;

  // 每次切换页面先清除转盘背景图，避免上一页残留
  document.body.style.backgroundImage = '';

  // 应用根路径：已登录直接进首页，未登录跳统一登录页（以 cookie 会话为准，而非本地缓存）
  if (path === '/') {
    try {
      const me = await LocalDB.me();
      Auth.setCached?.({ user: me, loginAt: Date.now() });   // 维护本地缓存，供独立转盘页加速判断
      goto('/home');
      return;
    } catch (err) {
      window.location.href = '/login';
      return;
    }
  }

  // 登录页已统一到主应用 /login，此处兜底跳转
  if (path === '/login') {
    window.location.href = '/login';
    return;
  }

  // 独立转盘页：未登录也可访问（公开转盘），有缓存则继续走校验
  const cached = Auth.getCached?.();
  if (!cached && path.startsWith('/wheel/')) {
    renderWheelStandalone(null, path.split('/')[2]);
    bindDarkToggle();
    return;
  }

  // 统一 cookie 会话校验：me 接口拿最新用户信息（未登录/过期 → 清缓存并跳统一登录页）
  let session = null;
  try {
    const me = await LocalDB.me();
    Auth.setCached?.({ user: me, loginAt: Date.now() });   // 维护本地缓存（/wheel/ 独立页加速判断用）
    session = { user: me, profile: me };   // 兼容旧字段：user/profile 均指向当前用户
  } catch (err) {
    Auth.clearCached?.();
    window.location.href = '/login';
    return;
  }

  // 路由分发
  if (path === '/home') renderHome(session);
  else if (path === '/manage') renderManage(session);
  else if (path === '/editor') await renderEditor(session, null);
  else if (path.startsWith('/editor/')) await renderEditor(session, path.split('/')[2]);
  else if (path.startsWith('/wheel/')) renderWheelStandalone(session, path.split('/')[2]);
  else goto('/home');

  bindDarkToggle();
}

// ================================================================
// 首页 —— 选择转盘 + 开始转动
// ================================================================

function renderHome(session) {
  const content = `
    <!-- 移动端转盘切换（桌面端通过右侧面板选择） -->
    <div class="wheel-picker-mobile" style="margin-bottom:16px;">
      <select id="wheel-select-mobile" class="input" style="width:100%;"></select>
    </div>

    <div class="home-layout">
      <div class="home-main">
        <div id="wheel-root" style="display:flex; justify-content:center; padding:20px 0;"></div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; width:fit-content; margin:20px auto 0;">
          <button id="spin-btn" class="btn btn-column2" style="grid-column:1 / -1; width:100%;">${rlT('roulette.actions.spin', '开始转动')}</button>
          <button id="shuffle-btn" class="btn btn-column5">${rlT('roulette.actions.shuffle', '打乱选项')}</button>
          <button id="standalone-btn" class="btn btn-column5">${rlT('roulette.home.standalone', '独立页面')}</button>
        </div>
      </div>

      <aside id="wheel-picker" class="wheel-picker-panel-col">
        <div class="wheel-picker-search">
          <input id="wheel-picker-search" class="input" type="text" placeholder="${rlT('roulette.home.searchPlaceholder', '搜索')}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
        </div>
        <div id="wheel-picker-list" class="wheel-picker-list"></div>
      </aside>
    </div>
  `;

  mount(appLayout(session, '/home', content));
  bindAppNav();

  const pickerSearch = document.getElementById('wheel-picker-search');
  const pickerList = document.getElementById('wheel-picker-list');
  const mobileSelect = document.getElementById('wheel-select-mobile');
  const wheelRoot = document.getElementById('wheel-root');
  const spinBtn = document.getElementById('spin-btn');
  const shuffleBtn = document.getElementById('shuffle-btn');
  const standaloneBtn = document.getElementById('standalone-btn');

  let wheels = [];
  let currentWheel = null;
  let shuffledOptions = [];
  let wheel = null;
  let fontSize = 'medium';

  /** 获取当前响应式转盘尺寸 */
  function getWheelSize() {
    const vw = window.innerWidth;
    if (vw <= 480) return Math.min(vw - 80, 340);
    if (vw <= 768) return Math.min(vw - 160, 420);
    return 500;
  }

  /** 重新创建转盘实例（用于 resize 时） */
  function rebuildWheel() {
    if (!currentWheel) return;
    const opts = shuffledOptions.length ? shuffledOptions : (currentWheel.options || []);
    wheelRoot.innerHTML = '';
    wheel = new SpinWheel({
      container: wheelRoot,
      size: getWheelSize(),
      fontSize,
      options: opts,
      colors: currentWheel.colors || undefined,
      backgroundImage: currentWheel.background_image || '',
      backgroundColor: currentWheel.background_color || '',
    });
    wheel.render();
  }

  /** 监听窗口尺寸变化，自动重建转盘 */
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(rebuildWheel, 200);
  });

  async function loadWheels() {
    wheels = await LocalDB.listWheels();
    if (wheels.length === 0) {
      pickerList.innerHTML = `<div class="wheel-picker-empty">${rlT('roulette.home.emptyWheels', '暂无转盘')}</div>`;
      mobileSelect.innerHTML = `<option value="">${rlT('roulette.home.emptyWheelsOption', '（暂无转盘，请先创建）')}</option>`;
      return;
    }
    renderPickerList('');
    // 填充移动端下拉
    mobileSelect.innerHTML = '';
    wheels.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name;
      mobileSelect.appendChild(opt);
    });
    mobileSelect.addEventListener('change', (e) => selectWheel(e.target.value));
    if (wheels.length > 0) selectWheel(wheels[0].id);
  }

  /** 渲染侧边栏转盘列表（支持搜索过滤） */
  function renderPickerList(keyword) {
    const filtered = wheels.filter(w => !keyword || w.name.toLowerCase().includes(keyword.toLowerCase()));
    pickerList.innerHTML = '';
    if (filtered.length === 0) {
      pickerList.innerHTML = `<div class="wheel-picker-empty">${rlT('roulette.home.noMatch', '无匹配结果')}</div>`;
      return;
    }
    filtered.forEach(w => {
      const item = document.createElement('div');
      item.className = 'wheel-picker-item' + (currentWheel && currentWheel.id === w.id ? ' active' : '');
      item.textContent = w.name;
      item.onclick = () => selectWheel(w.id);
      pickerList.appendChild(item);
    });
  }

  /** 搜索输入实时过滤列表 */
  pickerSearch.addEventListener('input', (e) => renderPickerList(e.target.value.trim()));

  function selectWheel(id) {
    currentWheel = wheels.find(w => w.id === id);
    if (!currentWheel) return;
    // 更新右侧列表选中态
    pickerList.querySelectorAll('.wheel-picker-item').forEach(el => {
      el.classList.toggle('active', el.textContent === currentWheel.name);
    });
    // 同步移动端下拉
    mobileSelect.value = id;
    shuffledOptions = (currentWheel.options || []).slice();
    mountWheel();
  }

  function mountWheel() {
    if (!currentWheel) return;
    const opts = shuffledOptions.length ? shuffledOptions : (currentWheel.options || []);
    // 将转盘背景图铺满整个页面
    if (currentWheel.background_image) {
      document.body.style.backgroundImage = `url(${currentWheel.background_image})`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundRepeat = 'no-repeat';
      document.body.style.backgroundAttachment = 'fixed';
    } else {
      document.body.style.backgroundImage = '';
    }
    wheel = new SpinWheel({
      container: wheelRoot,
      size: getWheelSize(),
      fontSize,
      options: opts,
      colors: currentWheel.colors || undefined,
      backgroundImage: currentWheel.background_image || '',
      backgroundColor: currentWheel.background_color || '',
    });
    wheel.render();
  }

  /** 执行一次转盘转动 */
  function doSpin() {
    if (!wheel || wheel.spinning) return;
    if ((shuffledOptions.length || 0) === 0) return Toast.error(rlT('roulette.home.noOptions', '该转盘没有选项'));
    spinBtn.disabled = true;
    spinBtn.textContent = rlT('roulette.actions.spinning', '转动中...');
    wheel.spin({
      onDone: () => {
        spinBtn.disabled = false;
        spinBtn.textContent = rlT('roulette.actions.spin', '开始转动');
      },
    });
  }

  spinBtn.addEventListener('click', doSpin);

  /** 按空格键自动触发转盘转动 */
  function onKeyDown(e) {
    if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT') {
      e.preventDefault();
      // 模拟按钮按压动画（与鼠标点击 :active 效果一致）
      spinBtn.classList.add('btn-pressed');
      setTimeout(() => spinBtn.classList.remove('btn-pressed'), 150);
      doSpin();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  shuffleBtn.addEventListener('click', () => {
    if (!currentWheel || (currentWheel.options || []).length === 0) return;
    shuffledOptions = currentWheel.options.slice().sort(() => _secureRandom() - 0.5);
    mountWheel();
    Toast.success(rlT('roulette.home.shuffled', '选项已打乱'));
  });

  standaloneBtn.addEventListener('click', () => {
    if (currentWheel) goto(`/wheel/${currentWheel.id}`);
  });

  loadWheels();
}

function renderManage(session) {
  const isAdmin = session.profile?.role === 'admin';
  const userId = session.user?.id || session.profile?.id;

  const content = `
    <div class="flex justify-end items-center" style="margin-bottom:16px;">
      <div class="flex gap-2">
        <input id="import-input" type="file" accept=".json" style="display:none;">
        <button id="batch-btn" class="btn btn-column5 btn-sm">${rlT('roulette.manage.batchMode', '多选')}</button>
        <button id="import-btn" class="btn btn-column5 btn-sm">${rlT('roulette.manage.import', '导入')}</button>
        <button id="create-btn" class="btn btn-column2 btn-sm">${rlT('roulette.manage.create', '＋ 创建转盘')}</button>
      </div>
    </div>
    <div id="batch-bar" style="display:none; margin-bottom:12px;">
      <div class="flex items-center gap-3" style="padding:10px 14px; background:var(--bg-card, var(--white)); border:1px solid var(--border-color); border-radius:10px;">
        <label class="flex items-center gap-2" style="cursor:pointer; font-size:14px; color:var(--text-primary);">
          <input type="checkbox" id="select-all"> ${rlT('roulette.manage.selectAll', '全选')}
        </label>
        <span id="selected-count" class="text-muted" style="font-size:13px;">${rlT('roulette.manage.selectedCount', '已选 {count} 项', { count: 0 })}</span>
        <div style="flex:1;"></div>
        <button id="batch-export" class="btn btn-column5 btn-sm">${rlT('roulette.manage.batchExport', '批量导出')}</button>
        <button id="batch-delete" class="btn btn-column4 btn-sm">${rlT('roulette.manage.batchDelete', '批量删除')}</button>
        <button id="batch-cancel" class="btn btn-column5 btn-sm">${rlT('roulette.actions.cancel', '取消')}</button>
      </div>
    </div>
    <div id="wheel-list"></div>
  `;

  mount(appLayout(session, '/manage', content));
  bindAppNav();

  let wheels = [];
  let batchMode = false;
  let selectedIds = new Set();

  async function loadData() {
    try { wheels = await LocalDB.listWheels(); } catch (e) { wheels = []; }
    renderList();
  }

  function renderList() {
    const listEl = document.getElementById('wheel-list');
    if (!listEl) return;
    if (wheels.length === 0) {
      listEl.innerHTML = `<div class="list-empty">${rlT('roulette.manage.empty', '还没有转盘，点击右上角"创建转盘"开始吧')}</div>`;
      return;
    }
    listEl.innerHTML = wheels.map(w => {
      const opts = (w.options || []).map(o => `<span class="badge badge-muted" style="margin:2px;">${o}</span>`).join('');
      const canEdit = isAdmin || w.user_id === userId;
      const priv = w.is_private ? `<span class="badge badge-danger">${rlT('roulette.manage.private', '私密')}</span>` : '';
      const checked = selectedIds.has(w.id) ? 'checked' : '';
      return `
        <div class="list-row">
          <div class="flex items-start gap-3">
            ${batchMode && canEdit ? `<input type="checkbox" class="batch-check" data-id="${w.id}" ${checked} style="margin-top:6px; flex-shrink:0;">` : ''}
            <div style="flex:1; min-width:0;">
              <div class="flex items-center gap-2 wrap" style="margin-bottom:8px;">
                <h3 style="font-size:17px; font-weight:600; color:var(--text-title); word-break:break-all;">${w.name}</h3>
                ${priv}
                <span class="badge badge-muted">${rlT('roulette.manage.optionCount', '{count} 项', { count: (w.options || []).length })}</span>
              </div>
              <div class="font-mono text-muted" style="font-size:12px; margin-bottom:6px; word-break:break-all;">
                ${rlT('roulette.manage.creatorLine', '创建者：{creator}　·　ID：{id}', { creator: w.creator_name || w.user_id, id: w.id })}
                <button class="icon-btn icon-btn-sm" data-copy="${w.id}" title="${rlT('roulette.manage.copyId', '复制 ID')}">${ACTION_ICONS.copy}</button>
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:4px;">${opts}</div>
            </div>
            ${canEdit && !batchMode ? `
            <div class="flex gap-2" style="flex-shrink:0;">
              <button class="icon-btn" data-export="${w.id}" title="${rlT('roulette.manage.export', '导出')}">${ACTION_ICONS.download}</button>
              <button class="icon-btn" data-edit="${w.id}" title="${rlT('roulette.manage.edit', '编辑')}">${ACTION_ICONS.edit}</button>
              <button class="icon-btn danger" data-delete="${w.id}" title="${rlT('roulette.actions.delete', '删除')}">${ACTION_ICONS.trash}</button>
            </div>` : ''}
          </div>
        </div>`;
    }).join('');

    if (!batchMode) {
      listEl.querySelectorAll('[data-export]').forEach(b => b.onclick = () => exportWheel(b.dataset.export));
      listEl.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => goto('/editor/' + b.dataset.edit));
      listEl.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => deleteWheel(b.dataset.delete));
    }
    listEl.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
      copyText(b.dataset.copy);
    });

    // 批量模式下绑定复选框事件
    if (batchMode) {
      listEl.querySelectorAll('.batch-check').forEach(ch => {
        ch.onchange = () => {
          if (ch.checked) selectedIds.add(ch.dataset.id);
          else selectedIds.delete(ch.dataset.id);
          refreshBatchBar();
        };
      });
    }
  }

  function exportWheel(id) {
    const w = wheels.find(x => x.id === id); if (!w) return;
    const data = { name: w.name, options: w.options, colors: w.colors, background_image: w.background_image };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${w.name}.json`; a.click();
    URL.revokeObjectURL(a.href);
    Toast.success(rlT('roulette.manage.exportSuccess', '导出成功'));
  }

  /** 刷新批量操作栏状态 */
  function refreshBatchBar() {
    const bar = document.getElementById('batch-bar');
    const countEl = document.getElementById('selected-count');
    if (!bar || !countEl) return;
    countEl.textContent = rlT('roulette.manage.selectedCount', '已选 {count} 项', { count: selectedIds.size });
  }

  /** 进入/退出批量模式 */
  function setBatchMode(on) {
    batchMode = on;
    if (!on) { selectedIds.clear(); }
    document.getElementById('batch-bar').style.display = on ? 'block' : 'none';
    document.getElementById('batch-btn').style.display = on ? 'none' : 'inline-block';
    document.getElementById('select-all').checked = false;
    refreshBatchBar();
    renderList();
  }

  // 批量操作事件绑定
  document.getElementById('batch-btn').onclick = () => setBatchMode(true);
  document.getElementById('batch-cancel').onclick = () => setBatchMode(false);

  document.getElementById('select-all').onclick = (e) => {
    const allIds = wheels.filter(w => isAdmin || w.user_id === userId).map(w => w.id);
    if (e.target.checked) { allIds.forEach(id => selectedIds.add(id)); }
    else { allIds.forEach(id => selectedIds.delete(id)); }
    renderList();
    refreshBatchBar();
  };

  document.getElementById('batch-export').onclick = () => {
    if (selectedIds.size === 0) return Toast.error(rlT('roulette.manage.selectForExport', '请先选择要导出的转盘'));
    const items = wheels.filter(w => selectedIds.has(w.id));
    const blob = createZip(items.map(w => {
      const json = JSON.stringify({
        name: w.name, options: w.options, colors: w.colors, background_image: w.background_image
      }, null, 2);
      return { name: `${w.name}.json`, content: new TextEncoder().encode(json) };
    }));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = rlT('roulette.manage.batchExportFileName', '批量导出-{time}.zip', { time: Date.now() });
    a.click();
    URL.revokeObjectURL(a.href);
    Toast.success(rlT('roulette.manage.exportedCount', '已导出 {count} 个转盘', { count: selectedIds.size }));
  };

  document.getElementById('batch-delete').onclick = async () => {
    if (selectedIds.size === 0) return Toast.error(rlT('roulette.manage.selectForDelete', '请先选择要删除的转盘'));
    const ok = await Modal.confirm(
      rlT('roulette.manage.batchDeleteTitle', '批量删除'),
      rlT('roulette.manage.batchDeleteConfirm', '确定删除选中的 {count} 个转盘？此操作无法撤销。', { count: selectedIds.size }),
      rlT('roulette.actions.delete', '删除'),
      rlT('roulette.actions.cancel', '取消'),
      true
    );
    if (!ok) return;
    let success = 0;
    for (const id of [...selectedIds]) {
      try { await LocalDB.deleteWheel(id); success++; } catch (e) { /* skip */ }
    }
    selectedIds.clear();
    await loadData();
    refreshBatchBar();
    Toast.success(rlT('roulette.manage.deletedCount', '已删除 {count} 个转盘', { count: success }));
  };

  /** 复制文本到剪贴板，支持 HTTP 环境降级 */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        Toast.success(rlT('roulette.manage.idCopied', 'ID 已复制'));
      }).catch(() => {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  /** 降级复制方案：使用临时 textarea */
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      Toast.success(rlT('roulette.manage.idCopied', 'ID 已复制'));
    } catch (e) {
      Toast.error(rlT('roulette.manage.copyFailed', '复制失败，请手动复制'));
    }
    document.body.removeChild(ta);
  }

  document.getElementById('import-btn').onclick = () => document.getElementById('import-input').click();
  document.getElementById('import-input').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!f.name.endsWith('.json')) return Toast.error(rlT('roulette.manage.selectJsonFile', '请选择 JSON 文件'));
    try {
      const data = JSON.parse(await f.text());
      if (!data.name || !Array.isArray(data.options)) return Toast.error(rlT('roulette.manage.invalidFile', '文件格式不正确'));
      if (wheels.some(w => w.name === data.name)) {
        return Toast.error(rlT('roulette.manage.duplicateName', '转盘名称"{name}"已存在', { name: data.name }));
      }
      const result = await LocalDB.createWheel({ name: data.name, options: data.options, colors: data.colors || null, background_image: data.background_image || null });
      if (result) {
        Toast.success(rlT('roulette.manage.importSuccess', '导入成功'));
        await loadData();
      } else Toast.error(rlT('roulette.manage.importFailed', '导入失败'));
    } catch (err) { Toast.error(rlT('roulette.manage.parseFailed', '文件解析失败')); }
    e.target.value = '';
  };

  document.getElementById('create-btn').onclick = () => goto('/editor');

  async function deleteWheel(id) {
    const ok = await Modal.confirm(
      rlT('roulette.manage.deleteTitle', '删除转盘'),
      rlT('roulette.manage.deleteConfirm', '此操作无法撤销，确定删除？'),
      rlT('roulette.actions.delete', '删除'),
      rlT('roulette.actions.cancel', '取消'),
      true
    );
    if (!ok) return;
    try {
      await LocalDB.deleteWheel(id);
      Toast.success(rlT('roulette.manage.deleteSuccess', '删除成功'));
      await loadData();
    } catch (err) { Toast.error(rlT('roulette.manage.deleteFailed', '删除失败：{message}', { message: err.message })); }
  }

  loadData();
}

// ================================================================
// 转盘创建/编辑（独立页面）
// ================================================================

/**
 * 渲染转盘创建/编辑页面（独立页面，不再使用弹窗）
 * @param {Object} session 当前登录会话
 * @param {string|null} id 转盘 ID，null 表示创建
 */
async function renderEditor(session, id) {
  let w = null;
  if (id) {
    try { w = await LocalDB.getWheel(id); } catch (e) { w = null; }
    if (!w) { Toast.error(rlT('roulette.editor.notFound', '转盘不存在')); goto('/manage'); return; }
  }
  const isNew = !id;

  const content = `
    <div class="card">
      <div class="flex items-center gap-3" style="margin-bottom:20px;">
        <button class="icon-btn" id="editor-back" title="${rlT('roulette.actions.back', '返回')}">${ACTION_ICONS.back}</button>
        <h2 style="font-size:18px; font-weight:600; color:var(--text-title);">${isNew ? rlT('roulette.editor.createTitle', '创建转盘') : rlT('roulette.editor.editTitle', '编辑转盘')}</h2>
      </div>
      <div class="form-group">
        <label class="label">${rlT('roulette.editor.name', '转盘名称')}</label>
        <input id="ed-name" class="input" placeholder="${rlT('roulette.editor.namePlaceholder', '请输入名称')}" value="${w ? w.name : ''}">
      </div>
      <div class="form-group">
        <div class="flex gap-3 items-center" style="border:1px solid var(--border-color); padding:14px; border-radius:10px;">
          <div style="flex:1;">
            <div style="font-weight:500;">${rlT('roulette.editor.private', '私密转盘')}</div>
            <div class="text-muted" style="font-size:12px;">${rlT('roulette.editor.privateHint', '开启后，只有你和管理员可见')}</div>
          </div>
          <div id="ed-private" class="switch ${w && w.is_private ? 'on' : ''}" data-checked="${w && w.is_private ? 'true' : 'false'}"></div>
        </div>
      </div>
      <div class="form-group">
        <div class="flex justify-between" style="margin-bottom:8px;">
          <label class="label" style="margin:0;">${rlT('roulette.editor.optionsLabel', '选项列表')}</label>
          <button type="button" id="add-option-btn" class="btn btn-column5 btn-sm">${rlT('roulette.editor.addOption', '添加')}</button>
        </div>
        <div id="ed-options" class="flex-col gap-2" style="display:flex;"></div>
      </div>
      <div class="form-group">
          <div class="flex justify-between" style="margin-bottom:8px;">
            <label class="label" style="margin:0;">${rlT('roulette.editor.colorsLabel', '配色（留空则使用默认）')}</label>
            <button type="button" id="add-color-btn" class="btn btn-column5 btn-sm">${rlT('roulette.editor.addColor', '添加颜色')}</button>
          </div>
          <div id="ed-colors" class="flex-col gap-2" style="display:flex;"></div>
        </div>
      <div class="form-group">
        <label class="label">${rlT('roulette.editor.bgImageLabel', '背景图片 URL（可选）')}</label>
        <input id="ed-bgimg" class="input" placeholder="https://..." value="${w && w.background_image ? w.background_image : ''}">
      </div>
      <div class="form-group">
        <label class="label">${rlT('roulette.editor.bgColorLabel', '纯色背景（可选）')}</label>
        <div class="flex gap-2 items-center">
          <input id="ed-bgcolor" type="color" value="${w && w.background_color ? w.background_color : '#ffffff'}" style="width:40px; height:36px; border:1px solid var(--border-color); border-radius:10px; cursor:pointer; background:transparent;">
          <input id="ed-bgcolor-text" class="input" placeholder="#FF5733" value="${w && w.background_color ? w.background_color : ''}">
        </div>
      </div>
      <div class="flex gap-3 justify-end" style="margin-top:24px;">
        <button type="button" id="editor-cancel" class="btn btn-column5">${rlT('roulette.actions.cancel', '取消')}</button>
        <button type="button" id="editor-save" class="btn btn-column2">${rlT('roulette.actions.save', '保存')}</button>
      </div>
    </div>`;

  mount(appLayout(session, '/manage', content));
  bindAppNav();

  const nameEl = document.getElementById('ed-name');
  const privateEl = document.getElementById('ed-private');
  const optionsEl = document.getElementById('ed-options');
  const colorsEl = document.getElementById('ed-colors');
  const bgImgEl = document.getElementById('ed-bgimg');
  const bgColorEl = document.getElementById('ed-bgcolor');
  const bgColorTextEl = document.getElementById('ed-bgcolor-text');

  /**
   * 添加一个选项输入行（含上移/下移/移除按钮）
   * @param {string} [val] 输入框初始值
   */
  function appendOptionRow(val) {
    const row = document.createElement('div');
    row.className = 'flex gap-2 items-center';
    row.innerHTML = `
      <input class="input" style="flex:1; min-width:0;" placeholder="${rlT('roulette.editor.optionPlaceholder', '输入选项')}" value="${val === undefined ? '' : val}">
      <button type="button" class="icon-btn" data-up title="${rlT('roulette.editor.moveUp', '上移')}">${ACTION_ICONS.up}</button>
      <button type="button" class="icon-btn" data-down title="${rlT('roulette.editor.moveDown', '下移')}">${ACTION_ICONS.down}</button>
      <button type="button" class="icon-btn" data-del title="${rlT('roulette.editor.remove', '移除')}">${ACTION_ICONS.close}</button>`;

    // 上移：插到上一行之前
    row.querySelector('[data-up]').onclick = () => {
      const prev = row.previousElementSibling;
      if (prev) optionsEl.insertBefore(row, prev);
      refreshOrderButtons();
    };
    // 下移：插到下一行之后（下一行为末行时 insertBefore(…, null) 等同追加）
    row.querySelector('[data-down]').onclick = () => {
      const next = row.nextElementSibling;
      if (next) optionsEl.insertBefore(row, next.nextElementSibling);
      refreshOrderButtons();
    };
    // 移除：至少保留一个选项
    row.querySelector('[data-del]').onclick = () => {
      if (optionsEl.children.length > 1) { row.remove(); refreshOrderButtons(); }
      else Toast.error(rlT('roulette.editor.keepOneOption', '至少保留一个选项'));
    };
    optionsEl.appendChild(row);
    refreshOrderButtons();
  }

  /** 按每行当前位置刷新上移/下移按钮的禁用状态（首行禁上移、末行禁下移） */
  function refreshOrderButtons() {
    [...optionsEl.children].forEach((r, i) => {
      r.querySelector('[data-up]').disabled = i === 0;
      r.querySelector('[data-down]').disabled = i === optionsEl.children.length - 1;
    });
  }

  /** 添加一个配色输入行 */
  function appendColorRow(val) {
    const row = document.createElement('div');
    row.className = 'flex gap-2 items-center';
    row.innerHTML = `<input type="color" value="${val || '#FFB84D'}" style="width:40px; height:36px; border:1px solid var(--border-color); border-radius:10px; cursor:pointer; background:transparent;"><input class="input" placeholder="#FFB84D" value="${val || '#FFB84D'}"><button class="icon-btn" title="${rlT('roulette.editor.remove', '移除')}">${ACTION_ICONS.close}</button>`;
    const inputs = row.querySelectorAll('input');
    inputs[0].oninput = () => { inputs[1].value = inputs[0].value; };
    inputs[1].oninput = () => { if (/^#[0-9a-fA-F]{6}$/.test(inputs[1].value)) inputs[0].value = inputs[1].value; };
    row.querySelector('button').onclick = () => row.remove();
    colorsEl.appendChild(row);
  }

  (w ? (w.options || []) : ['']).forEach(o => appendOptionRow(o));
  (w ? (w.colors || []) : []).forEach(c => appendColorRow(c));
  privateEl.onclick = () => { privateEl.dataset.checked = privateEl.dataset.checked !== 'true' ? 'true' : 'false'; privateEl.classList.toggle('on'); };
  bgColorEl.oninput = () => bgColorTextEl.value = bgColorEl.value;
  bgColorTextEl.onchange = () => { if (/^#[0-9a-fA-F]{6}$/.test(bgColorTextEl.value)) bgColorEl.value = bgColorTextEl.value; else bgColorTextEl.value = bgColorEl.value; };
  document.getElementById('add-option-btn').onclick = () => appendOptionRow('');
  document.getElementById('add-color-btn').onclick = () => appendColorRow('#FFB84D');
  document.getElementById('editor-back').onclick = () => goto('/manage');
  document.getElementById('editor-cancel').onclick = () => goto('/manage');
  document.getElementById('editor-save').onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) return Toast.error(rlT('roulette.editor.nameRequired', '请输入转盘名称'));
    const options = [...optionsEl.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    const colors = [...colorsEl.querySelectorAll('input[type=color]')].map(c => c.value);
    const payload = {
      name,
      options: options.length ? options : [],
      colors: colors.length ? colors : null,
      background_image: bgImgEl.value.trim() || null,
      background_color: bgColorTextEl.value.trim() || null,
      is_private: privateEl.dataset.checked === 'true',
    };
    try {
      if (w) await LocalDB.updateWheel(w.id, payload);
      else await LocalDB.createWheel(payload);
      Toast.success(w ? rlT('roulette.editor.updateSuccess', '更新成功') : rlT('roulette.editor.createSuccess', '创建成功'));
      goto('/manage');
    } catch (err) { Toast.error(rlT('roulette.editor.saveFailed', '保存失败：{message}', { message: err.message })); }
  };
  setTimeout(() => nameEl.focus(), 100);
}

// ================================================================
// 独立转盘页面（无 navbar，全屏转动）
// ================================================================

function renderWheelStandalone(session, id) {
  mount(`
    <div style="height:100vh; overflow:auto; padding:40px 20px; display:flex; flex-direction:column; align-items:center;">
      <button id="back-btn" class="icon-btn" style="position:absolute; top:16px; left:16px;" title="${rlT('roulette.standalone.backHome', '返回首页')}">${ACTION_ICONS.back}</button>
      <div id="wheel-root" style="flex:1; display:flex; align-items:center; justify-content:center; width:100%;"></div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; width:fit-content; margin:24px auto 0;">
        <button id="spin-btn" class="btn btn-column2" style="grid-column:1 / -1; width:100%;">${rlT('roulette.actions.spin', '开始转动')}</button>
        <button id="shuffle-btn" class="btn btn-column5">${rlT('roulette.actions.shuffle', '打乱选项')}</button>
        <button id="fullscreen-btn" class="btn btn-column5">${rlT('roulette.standalone.fullscreen', '全屏模式')}</button>
      </div>
    </div>
  `);

  let wheel = null;
  let current = null;
  const spinBtn = document.getElementById('spin-btn');
  const root = document.getElementById('wheel-root');

  /** 获取当前响应式转盘尺寸 */
  function getStandaloneSize() {
    const vw = window.innerWidth;
    if (vw <= 480) return Math.min(vw - 80, 340);
    if (vw <= 768) return Math.min(vw - 160, 420);
    return 520;
  }

  /** 重建转盘（打乱/resize 时调用） */
  function rebuildStandalone(options) {
    root.innerHTML = '';
    wheel = new SpinWheel({
      container: root, size: getStandaloneSize(), fontSize: 'medium',
      options: options || current.options, colors: current.colors || undefined,
      backgroundImage: current.background_image || '',
      backgroundColor: current.background_color || '',
    });
    wheel.render();
  }

  /** 监听窗口尺寸变化，自动重建转盘 */
  let _saResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_saResizeTimer);
    _saResizeTimer = setTimeout(() => { if (current) rebuildStandalone(); }, 200);
  });

  (async () => {
    try {
      // request() 会自动带上已登录的 Bearer Token；未登录则匿名访问公开转盘
      current = await LocalDB.getWheel(id);
    } catch {
      // 无 token 可能是公开转盘，也可能需要登录
      Toast.error(rlT('roulette.standalone.notFound', '转盘不存在或无权访问'));
      setTimeout(() => goto('/home'), 1500);
      return;
    }
    if (!current) return;

    // 将转盘背景图铺满整个页面
    if (current.background_image) {
      document.body.style.backgroundImage = `url(${current.background_image})`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundRepeat = 'no-repeat';
      document.body.style.backgroundAttachment = 'fixed';
    }

    rebuildStandalone(current.options);

    /** 执行一次转盘转动 */
    function doSpinStandalone() {
      if (!wheel || wheel.spinning) return;
      spinBtn.disabled = true; spinBtn.textContent = rlT('roulette.actions.spinning', '转动中...');
      wheel.spin({
        onDone: () => {
          spinBtn.disabled = false; spinBtn.textContent = rlT('roulette.actions.spin', '开始转动');
        },
      });
    }

    spinBtn.addEventListener('click', doSpinStandalone);

    /** 按空格键自动触发转盘转动 */
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT') {
        e.preventDefault();
        spinBtn.classList.add('btn-pressed');
        setTimeout(() => spinBtn.classList.remove('btn-pressed'), 150);
        doSpinStandalone();
      }
    });

    // 打乱选项：随机重排 options 并重新渲染
    const shuffleBtn = document.getElementById('shuffle-btn');
    if (shuffleBtn) {
      shuffleBtn.onclick = () => {
        if (!current || !current.options) return;
        const shuffled = [...current.options].sort(() => _secureRandom() - 0.5);
        current.options = shuffled;
        rebuildStandalone(shuffled);
      };
    }

    // 全屏模式：切换浏览器全屏，并根据状态更新按钮文字
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
      // 全屏状态变化时更新按钮文字
      const updateFullscreenText = () => {
        fullscreenBtn.textContent = document.fullscreenElement
          ? rlT('roulette.standalone.exitFullscreen', '退出全屏')
          : rlT('roulette.standalone.fullscreen', '全屏模式');
      };
      document.addEventListener('fullscreenchange', updateFullscreenText);
      fullscreenBtn.onclick = () => {
        const el = document.documentElement;
        if (!document.fullscreenElement) {
          el.requestFullscreen?.().catch(() => Toast.error(rlT('roulette.standalone.fullscreenFailed', '无法进入全屏')));
        } else {
          document.exitFullscreen?.();
        }
      };
    }
  })();

  document.getElementById('back-btn').onclick = () => goto('/home');
}

// ============ 启动 ============

/**
 * 根据当前语言刷新浏览器标签页标题
 */
function syncDocumentTitle() {
  document.title = rlT('app.name', '明星学校');
}

/**
 * 执行一段需要在语言包就绪后才运行的逻辑（i18n 未加载时直接执行）
 * @param {Function} cb 待执行回调
 */
function whenI18nReady(cb) {
  if (window.I18n && window.I18n.ready) window.I18n.ready(cb);
  else cb();
}

// 首次渲染依赖语言包，故用 I18n.ready 包裹；语言切换后重新渲染整页
document.addEventListener('DOMContentLoaded', () => {
  whenI18nReady(() => {
    syncDocumentTitle();
    route();
  });

  if (window.I18n && window.I18n.onChange) {
    window.I18n.onChange(() => {
      syncDocumentTitle();
      route();
    });
  }
});
