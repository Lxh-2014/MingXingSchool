/**
 * 明星学校 · 登录页逻辑（JS 渲染）
 * 动态渲染登录卡片并绑定统一登录流程：调用 /api/auth/login，
 * 成功后写入网盘所需本地存储，跳转 next 或首页。
 */

/**
 * 取多语言文案：i18n 框架未加载时回退中文兜底
 * @param {string} key 语言包键
 * @param {string} fallback 中文兜底文案
 * @returns {string} 展示文案
 */
function t(key, fallback) {
  return (window.I18n && window.I18n.t) ? window.I18n.t(key, null, fallback) : fallback;
}

/**
 * 校验回跳地址：仅允许站内路径，拒绝 // 开头的协议相对 URL（防开放重定向）
 * @param {string|null} next URL 中的 next 参数
 * @returns {string} 安全的跳转地址，默认回首页
 */
function safeNext(next) {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}

/**
 * 登录态预检：已登录用户不应再看到登录表单，直接跳回 next 或首页
 */
async function redirectIfLoggedIn() {
  try {
    const resp = await fetch('/api/me');
    const me = await resp.json();
    if (me && me.loggedIn) {
      const params = new URLSearchParams(window.location.search);
      window.location.replace(safeNext(params.get('next')));
      return true;
    }
  } catch (e) { /* 接口异常时照常渲染登录表单 */ }
  return false;
}

/**
 * 统一登录流程：调用主项目统一登录接口 /api/auth/login
 * 成功后服务端写入 cookie 会话（网盘/转盘/广播器共用），前端只需
 * 写入网盘页面初始化所需的本地存储即可，最后跳转到 next 或首页。
 * @param {string} username 姓名
 * @param {string} password 学号
 */
async function doLogin(username, password) {
  const resp = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error(data.message || t('login.failed', '姓名或学号错误'));
  }

  // 写入网盘前端初始化所需的本地存储（网盘 app.js 据此识别登录态）
  localStorage.setItem('username', data.username);
  localStorage.setItem('userId', data.userId);
  if (data.avatar) localStorage.setItem('avatarImage', data.avatar);
  else localStorage.removeItem('avatarImage');
}

/**
 * 渲染登录卡片到 #root 并绑定表单提交
 */
function renderLoginPage() {
  const root = document.getElementById('root');          // 挂载点
  root.innerHTML = '';                                   // 支持切换语言后重新渲染，先清空旧内容
  document.title = t('app.name', '明星学校');

  const container = document.createElement('div');       // 登录容器：淡蓝背景全屏居中
  container.className = 'login-container';

  const box = document.createElement('div');             // 登录卡片
  box.className = 'login-box';

  // Logo + 标题
  const logo = document.createElement('div');            // Logo 区
  logo.className = 'login-logo';
  logo.innerHTML =
    '<img class="login-logo-img" src="/assets/home/logo.png" alt="' + t('login.title', '明星学校') + '">' +
    '<h1>' + t('login.title', '明星学校') + '</h1>' +
    '<p>' + t('login.subtitle', '登录以继续使用') + '</p>';

  // 表单
  const form = document.createElement('form');           // 登录表单
  form.className = 'login-form';
  form.innerHTML =
    '<input type="text" id="username" class="login-input" placeholder="' + t('login.namePlaceholder', '请输入姓名') + '" autocomplete="username" required>' +
    '<input type="password" id="password" class="login-input" placeholder="' + t('login.idPlaceholder', '请输入学号') + '" autocomplete="current-password" required>' +
    '<p id="errorMsg" class="login-error"></p>' +
    '<button type="submit" id="submitBtn" class="btn btn-column2 login-btn">' + t('login.submit', '登 录') + '</button>';

  box.appendChild(logo);
  box.appendChild(form);
  container.appendChild(box);
  root.appendChild(container);

  // 绑定表单提交
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();  // 姓名
    const password = document.getElementById('password').value;         // 学号
    const btn = document.getElementById('submitBtn');                   // 提交按钮
    const errorMsg = document.getElementById('errorMsg');               // 错误提示

    // 提交前清空旧错误并锁定按钮，防止重复提交
    errorMsg.textContent = '';
    btn.disabled = true;
    btn.textContent = t('login.submitting', '登录中…');

    try {
      await doLogin(username, password);
      // 登录成功：跳回来源页或首页
      const params = new URLSearchParams(window.location.search);
      window.location.href = safeNext(params.get('next'));
    } catch (err) {
      errorMsg.textContent = err.message || t('login.failedLater', '登录失败，请稍后重试');
      btn.disabled = false;
      btn.textContent = t('login.submit', '登 录');
    }
  });
}

// 入口：等语言包加载完成后再渲染，确保首屏文案即为当前语言
function startLoginPage() {
  redirectIfLoggedIn().then((redirected) => { if (!redirected) renderLoginPage(); });
}
if (window.I18n && window.I18n.ready) window.I18n.ready(startLoginPage);
else startLoginPage();
