/**
 * 明星学校 · 主项目三页逻辑整合文件（门户首页 / 设置 / 用户管理）
 * 三个页面的脚本合并于此，各自用 IIFE 隔离作用域（避免函数重名冲突），
 * 并注册到 window.MainPages 入口表：MainLayout 的 SPA 路由按 pathname 调用对应入口。
 * 文件末尾按当前地址自动执行对应页面入口（首次加载）。
 */
window.MainPages = {};

/**
 * 取多语言文案：i18n 未加载时回退中文兜底
 * @param {string} key 语言包键
 * @param {string} fallback 中文兜底文案
 * @param {object} [params] 占位参数
 * @returns {string} 展示文案
 */
function mxT(key, fallback, params) {
  return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : fallback;
}

/* ==================== 门户首页（原 page-home.js） ==================== */
(function () {

  /** 平板桌面应用入口表：key=语言包键，name=中文兜底名，icon=图标图片，href=跳转地址，tip=中文兜底提示 */
  var HOME_APPS = [
    { key: 'drive',     name: '明星云网盘', icon: '/assets/home/drive.png',      fallback: '', href: '/drive',                                       tip: '存有教学资料、校园文件等'             },
    { key: 'roulette',  name: '明星转盘',   icon: '/assets/home/roulette.png',   fallback: '', href: '/roulette',                                    tip: '自由创建一个属于自己的转盘'           },
    { key: 'broadcast', name: '明星广播器', icon: '/assets/home/broadcast.png',  fallback: '', href: '/broadcast',                                   tip: '学校专用的广播系统'                   },
    { key: 'live',      name: '明星直播',   icon: '/assets/home/live.png',       fallback: '', href: '/live/channel/1',                             tip: 'WebRTC 网页直播，默认进入观看页'        },
    { key: 'shop',      name: '明星商店',   icon: '/assets/home/shop.png',       fallback: '', href: '/shop',                                        tip: '校园购物平台，逛店购物下单'           },
    { key: 'quiz',      name: '综合答题',   icon: '/assets/home/quiz.png?v=2',       fallback: '', href: '/quiz',                                        tip: '闯关练习与错题本'                    },
    { key: 'im',        name: '邻语',       icon: '/assets/home/im.png',         fallback: '', href: '/im',                                          tip: '同网为邻，轻声相语（校园聊天）'        },
    { key: 'qq',        name: 'QQ',        icon: '/assets/home/qq.png',         fallback: '', href: 'https://pd.qq.com/g/MingXing233',              tip: '学校的QQ频道',             ext: true },
    { key: 'grade',     name: '成绩',       icon: '/assets/home/grade.png',      fallback: '', href: 'https://www.kdocs.cn/etapps/query/q/MzRYzQLE', tip: '查看成绩情况',             ext: true }
  ];

  /**
   * 渲染平板桌面（应用图标网格）到内容区
   * @param {HTMLElement} content MainLayout 提供的内容容器
   * @param {object|null} me /api/me 登录信息（用于判断管理员专属入口）
   */
  function renderPadScreen(content, me) {
    var isAdmin = !!(me && me.loggedIn && me.isAdmin);       // 当前用户是否为管理员
    var pad = document.createElement('div');               // 桌面背景容器（铺满内容区）
    pad.className = 'pad-screen';
    var grid = document.createElement('div');              // 应用图标网格
    grid.className = 'app-grid';

    HOME_APPS.forEach(function (app) {
      if (app.adminOnly && !isAdmin) return;                // 管理员专属入口对普通用户隐藏
      var item = document.createElement('a');              // 单个应用入口
      item.className = 'app-item';
      item.href = app.href;
      item.title = mxT('home.apps.' + app.key + '.tip', app.tip);
      if (app.ext) { item.target = '_blank'; item.rel = 'noopener noreferrer'; }

      var icon = document.createElement('img');            // 应用图标：加载失败回退外链
      icon.className = 'app-icon-img';
      icon.src = app.icon;
      icon.alt = mxT('home.apps.' + app.key + '.name', app.name);
      icon.addEventListener('error', function () { if (app.fallback && icon.src !== app.fallback) icon.src = app.fallback; });

      var label = document.createElement('div');           // 应用名称（白色文字）
      label.className = 'app-name';
      label.textContent = mxT('home.apps.' + app.key + '.name', app.name);

      item.appendChild(icon);
      item.appendChild(label);
      grid.appendChild(item);
    });

    pad.appendChild(grid);
    content.appendChild(pad);
  }

  /**
   * 顶栏动作按钮：仅未登录时显示"登录"入口；已登录不显示任何按钮
   * （退出登录已按需求移到设置页顶栏）
   * @param {object} me /api/me 登录信息
   * @param {HTMLElement} box 顶栏动作按钮容器
   */
  function renderTopbarActions(me, box) {
    if (me && me.loggedIn) return;                         // 已登录：门户顶栏无动作按钮
    var btn = document.createElement('button');            // 登录入口按钮
    btn.className = 'pill-btn primary';
    btn.textContent = mxT('common.login', '登 录');
    btn.addEventListener('click', function () { window.location.href = '/login'; });
    box.appendChild(btn);
  }

  /** 首页入口：渲染布局 + 平板桌面（侧边栏含用户管理入口，仅管理员可见） */
  window.MainPages['/'] = function () {
    MainLayout.render({
      title: '明星学校',
      active: '/',
      showUserMgmt: true,        // 主项目所有页面侧边栏都提供用户管理入口（仅管理员可见）
      padded: false,
      actions: renderTopbarActions
    }).then(function (res) {
      renderPadScreen(res.content, res.me);
    });
  };
})();

/* ==================== 设置页（原 page-settings.js） ==================== */
(function () {

  /** 默认头像（未上传头像时显示的占位图） */
  var DEFAULT_AVATAR = '/assets/home/default-avatar.png';

  /** 当前登录用户信息（/api/me 返回） */
  var currentUser = null;

  /** 顶栏头像容器（初始化时赋值，供上传/恢复默认后立即刷新） */
  var topAvatarBox = null;

  /** 卡片内头像大预览容器（初始化时赋值） */
  var previewBox = null;

  /**
   * 渲染头像到指定元素：已上传显示图片，未上传显示平台默认头像（容器无底色）
   * @param {HTMLElement} el 头像容器
   * @param {object} info 用户信息 { avatar }
   */
  function renderAvatar(el, info) {
    el.innerHTML = '';
    el.title = (info && info.name) || '';                  // 悬浮头像显示名字（title 组件）
    var img = document.createElement('img');               // 头像图片元素
    img.src = info.avatar
      ? info.avatar + (info.avatar.includes('?') ? '' : '?t=' + Date.now())  // 图片头像（带时间戳防缓存）
      : DEFAULT_AVATAR;                                                      // 默认头像占位图
    el.appendChild(img);
  }

  /**
   * 上传头像图片：读取文件为 base64 后提交到网盘头像接口
   * @param {File} file 用户选择的图片文件
   */
  async function uploadAvatar(file) {
    if (!currentUser) return;
    const reader = new FileReader();   // 文件读取器：转为 base64 DataURL
    reader.onload = async () => {
      try {
        const resp = await fetch('/drive/api/avatar/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUser.userId, avatarData: reader.result })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.message || mxT('settings.avatarUploadFailed', '头像上传失败'));
        showToast(mxT('settings.avatarUploaded', '头像上传成功'), 'success');
        renderAvatar(topAvatarBox, { avatar: reader.result });   // 本地立即预览
        renderAvatar(previewBox, { avatar: reader.result });
      } catch (err) {
        showToast(err.message || mxT('settings.avatarUploadFailed', '头像上传失败'), 'error');
      }
    };
    reader.readAsDataURL(file);
  }

  /**
   * 恢复默认头像：清除服务端头像设置（之后显示平台默认头像）
   */
  async function clearAvatar() {
    if (!currentUser) return;
    try {
      // color 传空字符串 = 清除头像模式
      const resp = await fetch('/drive/api/avatar/color', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.userId, color: '' })
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || mxT('settings.operationFailed', '操作失败'));
      showToast(mxT('settings.avatarRestored', '已恢复默认头像'), 'success');
      renderAvatar(topAvatarBox, {});                        // 立即回退默认头像
      renderAvatar(previewBox, {});
    } catch (err) {
      showToast(err.message || mxT('settings.operationFailed', '操作失败'), 'error');
    }
  }

  /**
   * 应用深色模式到当前页面并持久化（common-ui 会同步全站）
   * @param {boolean} on 是否开启深色
   */
  function applyDarkMode(on) {
    document.body.classList.toggle('dark-mode', on);
    localStorage.setItem('darkMode', on ? 'true' : 'false');
  }

  /**
   * 顶栏动作按钮：无（退出登录已统一收进头像下拉菜单）
   * @param {object} me /api/me 登录信息
   * @param {HTMLElement} box 顶栏动作按钮容器
   */
  function renderTopbarActions() {}

  /**
   * 构建设置卡片区域并绑定交互
   * @param {HTMLElement} content MainLayout 提供的内容容器
   */
  function buildSettings(content) {
    const wrap = document.createElement('div');            // 卡片纵排容器
    wrap.className = 'settings-wrap';

    // ---- 卡片 1：个人资料（头像） ----
    const profileCard = document.createElement('section'); // 个人资料卡片
    profileCard.className = 'settings-card';
    profileCard.innerHTML =
      '<h2>' + mxT('settings.profileTitle', '个人资料') + '</h2>' +
      '<p class="desc">' + mxT('settings.profileDesc', '设置你的头像：上传自定义图片') + '</p>';
    const row = document.createElement('div');             // 头像预览 + 操作按钮行
    row.className = 'card-row';
    const preview = document.createElement('div');         // 头像大预览
    preview.className = 'avatar-preview';
    const actions = document.createElement('div');         // 按钮列
    actions.className = 'avatar-actions';
    const uploadBtn = document.createElement('button');    // 上传图片按钮
    uploadBtn.className = 'btn btn-column2';
    uploadBtn.type = 'button';
    uploadBtn.textContent = mxT('settings.uploadImage', '上传图片');
    const clearBtn = document.createElement('button');     // 恢复默认按钮
    clearBtn.className = 'btn btn-column5';
    clearBtn.type = 'button';
    clearBtn.textContent = mxT('settings.restoreDefault', '恢复默认');
    const fileInput = document.createElement('input');     // 隐藏的文件选择框
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    actions.appendChild(uploadBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(fileInput);
    row.appendChild(preview);
    row.appendChild(actions);
    profileCard.appendChild(row);
    wrap.appendChild(profileCard);

    // ---- 卡片 2：外观设置（深色模式） ----
    const darkCard = document.createElement('section');    // 外观设置卡片
    darkCard.className = 'settings-card';
    darkCard.innerHTML =
      '<h2>' + mxT('settings.appearanceTitle', '外观设置') + '</h2>' +
      '<p class="desc">' + mxT('settings.appearanceDesc', '深色模式，改动即时生效并自动保存') + '</p>' +
      '<div class="setting-row">' +
        '<div class="setting-label">' + mxT('settings.darkMode', '深色模式') +
          '<small>' + mxT('settings.darkModeDesc', '护眼的深色主题，全站生效') + '</small></div>' +
        '<label class="switch"><input type="checkbox" id="darkSwitch"><span class="slider"></span></label>' +
      '</div>';
    wrap.appendChild(darkCard);

    // ---- 卡片 3：语言设置（语言包机制统一走 /assets/i18n.js） ----
    const langCard = document.createElement('section');    // 语言设置卡片
    langCard.className = 'settings-card';
    langCard.innerHTML =
      '<h2>' + mxT('settings.languageTitle', '语言设置') + '</h2>' +
      '<p class="desc">' + mxT('settings.languageDesc', '切换全站界面语言，选择后自动保存') + '</p>' +
      '<div class="setting-row">' +
        '<div class="setting-label">' + mxT('settings.languageLabel', '界面语言') + '</div>' +
        '<select class="input" id="langSelect" style="max-width:180px">' +
          '<option value="zh-CN">简体中文</option>' +
          '<option value="en-US">English</option>' +
        '</select>' +
      '</div>';
    wrap.appendChild(langCard);

    // ---- 卡片 4：邮箱绑定（绑定后管理员可向该邮箱发送通知） ----
    const mailCard = document.createElement('section');    // 邮箱绑定卡片
    mailCard.className = 'settings-card';
    mailCard.innerHTML =
      '<h2>' + mxT('settings.emailTitle', '邮箱绑定') + '</h2>' +
      '<p class="desc">' + mxT('settings.emailDesc', '绑定后管理员可向该邮箱发送通知邮件；同一邮箱可被多个账号绑定，可随时解绑。') + '</p>' +
      '<div class="form-group">' +
        '<label class="label" for="bindEmail">' + mxT('settings.emailLabel', '邮箱地址') + '</label>' +
        '<input class="input" id="bindEmail" type="email" maxlength="254" placeholder="' + mxT('settings.emailPlaceholder', '如 xxx@qq.com') + '" autocomplete="email">' +
      '</div>' +
      '<p class="form-hint" id="bindHint">' + mxT('settings.readingBinding', '正在读取绑定状态…') + '</p>' +
      '<div class="mail-actions">' +
        '<button class="btn btn-column2" type="button" id="bindSave">' + mxT('common.save', '保存') + '</button>' +
        '<button class="btn btn-column5" type="button" id="bindClear">' + mxT('common.unbind', '解绑') + '</button>' +
      '</div>';
    wrap.appendChild(mailCard);

    content.appendChild(wrap);

    // ---- 交互绑定 ----
    uploadBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) uploadAvatar(e.target.files[0]);
      e.target.value = '';                                 // 允许重复选择同一文件
    });
    clearBtn.addEventListener('click', clearAvatar);

    const darkSwitch = darkCard.querySelector('#darkSwitch'); // 深色开关
    darkSwitch.checked = localStorage.getItem('darkMode') === 'true';
    darkSwitch.addEventListener('change', function () {
      applyDarkMode(darkSwitch.checked);
      showToast(
        darkSwitch.checked
          ? mxT('settings.darkEnabled', '已开启深色模式')
          : mxT('settings.darkDisabled', '已关闭深色模式'),
        'info'
      );
    });

    // ---- 语言切换：保存后重新渲染本页，使页面文案立即生效 ----
    const langSelect = langCard.querySelector('#langSelect');   // 语言下拉框
    langSelect.value = (window.I18n && window.I18n.lang) || 'zh-CN';
    langSelect.addEventListener('change', function () {
      const next = langSelect.value;                            // 目标语言代码
      if (!window.I18n) return;
      window.I18n.setLang(next).then(function () {
        // 兼容网盘子应用已有的语言键 localStorage.lang，进入网盘后保持同一语言
        try { localStorage.setItem('lang', next === 'en-US' ? 'en_us' : 'zh_cn'); } catch (e) { /* 忽略 */ }
        window.MainPages['/settings']();                        // 重新渲染设置页
      });
    });

    // ---- 邮箱绑定 ----
    const bindInput = mailCard.querySelector('#bindEmail');     // 邮箱输入框
    const bindHint = mailCard.querySelector('#bindHint');       // 绑定状态提示
    const bindSave = mailCard.querySelector('#bindSave');       // 保存按钮
    const bindClear = mailCard.querySelector('#bindClear');     // 解绑按钮

    /**
     * 用绑定结果刷新输入框、状态提示与解绑按钮显隐
     * @param {{email: string, boundAt: string}} binding 绑定结果
     */
    function applyBinding(binding) {
      const email = binding && binding.email ? binding.email : '';   // 当前绑定邮箱（空=未绑定）
      bindInput.value = email;
      bindHint.textContent = email
        ? mxT('settings.boundTo', '已绑定：{email}', { email: email })
        : mxT('settings.notBound', '尚未绑定邮箱');
      bindClear.style.display = email ? '' : 'none';               // 未绑定时不显示解绑
    }

    /** 读取当前用户邮箱绑定并回显 */
    async function loadBinding() {
      try {
        const resp = await fetch('/api/mail/me');
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !data.success) throw new Error(data.message || mxT('settings.readBindingFailed', '读取邮箱绑定失败'));
        applyBinding(data.binding);
      } catch (err) {
        bindHint.textContent = err.message || mxT('settings.readBindingFailed', '读取邮箱绑定失败');
      }
    }

    /**
     * 提交绑定 / 解绑
     * @param {string} email 邮箱地址，空字符串表示解绑
     */
    async function saveBinding(email) {
      bindSave.disabled = true;
      bindClear.disabled = true;
      try {
        const resp = await fetch('/api/mail/me', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        });
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !data.success) throw new Error(data.message || mxT('settings.saveFailed', '保存失败'));
        applyBinding(data.binding);
        showToast(data.message || mxT('settings.saved', '已保存'), 'success');
      } catch (err) {
        showToast(err.message || mxT('settings.saveFailed', '保存失败'), 'error');
      } finally {
        bindSave.disabled = false;
        bindClear.disabled = false;
      }
    }

    bindSave.addEventListener('click', function () {
      const email = bindInput.value.trim();                       // 用户输入的邮箱
      if (!email) { showToast(mxT('settings.fillEmail', '请填写邮箱地址'), 'warning'); return; }
      saveBinding(email);
    });
    bindClear.addEventListener('click', function () {
      if (!window.confirm(mxT('settings.unbindConfirm', '确定要解绑当前邮箱吗？解绑后管理员将无法向你发送邮件。'))) return;
      saveBinding('');
    });
    loadBinding();

    return { preview: preview };
  }

  /** 设置页入口：渲染布局（退出按钮在顶栏）+ 设置卡片；未登录跳统一登录页 */
  window.MainPages['/settings'] = function () {
    MainLayout.render({
      title: '设置',
      active: '/settings',
      showUserMgmt: true,        // 仅设置页侧边栏提供用户管理入口（仅管理员可见）
      padded: true,
      actions: renderTopbarActions
    }).then(async function (res) {
      if (!res.me.loggedIn) {
        window.location.href = '/login?next=' + encodeURIComponent('/settings');
        return;
      }
      currentUser = res.me;
      // 顶栏用户区由 MainLayout 渲染（仅头像，名字悬浮 title 查看）；此处取引用并填充卡片
      topAvatarBox = document.querySelector('.topbar .user-avatar');        // 顶栏头像容器
      const parts = buildSettings(res.content);
      previewBox = parts.preview;
      renderAvatar(topAvatarBox, res.me);
      renderAvatar(previewBox, res.me);
    });
  };
})();

/* ==================== 用户管理页（原 page-usermanagement.js） ==================== */
(function () {

  /** 全部用户缓存（/api/users 返回） */
  var allUsers = [];        // 全量用户列表（管理员置顶，组内按 id 升序，来自服务端）

  /** 邮箱绑定缓存：{ userId: email }，来自 /api/mail/bindings */
  var mailBindings = {};

  /** 通用弹窗确认回调（打开弹窗时赋值） */
  var modalConfirm = null;  // 确认弹窗的确认回调（openModal 时挂上）

  /**
   * 请求封装：JSON 提交 + 中文错误规范化
   * @param {string} method HTTP 方法
   * @param {string} url 请求地址
   * @param {object} [body] 请求体
   * @returns {Promise<object>} 响应 JSON
   */
  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // 403 = 非管理员访问，展示无权限视图
      if (resp.status === 403) { showDenied(); }
      throw new Error(data.message || `请求失败（HTTP ${resp.status}）`);
    }
    return data;
  }

  /**
   * 显示无权限视图（非管理员）
   */
  function showDenied() {
    document.getElementById('mgmtPanel').style.display = 'none';
    document.getElementById('deniedBox').style.display = 'block';
  }

  /**
   * 拉取并渲染用户列表（同时拉取邮箱绑定，供表格「邮箱」列展示）
   */
  async function loadUsers() {
    const data = await api('GET', '/api/users');
    allUsers = data.users || [];
    const bind = await api('GET', '/api/mail/bindings');
    mailBindings = {};                                     // 重建 id → 邮箱映射
    (bind.bindings || []).forEach(it => { mailBindings[it.userId] = it.email; });
    renderTable();
  }

  /**
   * 渲染用户表格
   */
  function renderTable() {
    const tbody = document.getElementById('userTbody');
    tbody.innerHTML = '';
    allUsers.forEach(u => {
      const tr = document.createElement('tr');

      // 用户列：小头像 + 姓名（无头像用平台默认头像图）
      const tdUser = document.createElement('td');
      tdUser.className = 'col-user';
      const av = document.createElement('span');
      av.className = 'mini-avatar';
      const img = document.createElement('img');             // 头像图片
      img.src = u.avatar === 'picture' ? `/drive/assets/user/${u.id}.png` : '/assets/home/default-avatar.png';
      av.appendChild(img);
      tdUser.appendChild(av);
      tdUser.appendChild(document.createTextNode(' ' + u.name));

      // 其余列：ID / 积分 / 角色
      const tdId = document.createElement('td');
      tdId.className = 'col-id';
      tdId.textContent = u.id;
      tdId.title = u.id;                                     // 悬浮查看完整 ID
      const tdPoints = document.createElement('td');         // 积分列（头像菜单展示值，管理员可改）
      tdPoints.className = 'hide-mobile points-cell';
      const pointsText = String(u.points ?? 0);              // 积分完整文本（超大整数以字符串返回）
      // 超过 5 位只显示前 5 位 + 省略号，完整数值放 title 供悬浮查看
      tdPoints.textContent = pointsText.length > 5 ? pointsText.slice(0, 5) + '…' : pointsText;
      tdPoints.title = pointsText;
      const tdRole = document.createElement('td');
      tdRole.className = 'hide-mobile col-role';
      tdRole.innerHTML = `<span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${u.role === 'admin' ? '管理员' : '用户'}</span>`;

      // 邮箱列：展示已绑定邮箱（未绑定显示 —），超宽截断，完整值悬浮查看
      const tdMail = document.createElement('td');
      tdMail.className = 'hide-mobile col-mail';
      const boundEmail = mailBindings[u.id] || '';           // 该用户当前绑定的邮箱
      tdMail.textContent = boundEmail || '—';
      if (boundEmail) tdMail.title = boundEmail;

      // 操作列：重置学号 / 重命名 / 积分 / 邮箱 / 改ID / 权限组 / 删除（Admin 行不提供改ID、删除与权限组切换）
      const tdOps = document.createElement('td');
      const ops = document.createElement('div');
      ops.className = 'row-actions';
      ops.appendChild(mkBtn('重置学号', 'btn-column2 btn-sm', () => promptResetPwd(u)));
      ops.appendChild(mkBtn('重命名', 'btn-column5 btn-sm', () => promptRename(u)));
      ops.appendChild(mkBtn('积分', 'btn-column5 btn-sm', () => promptPoints(u)));
      ops.appendChild(mkBtn('邮箱', 'btn-column5 btn-sm', () => promptBindMail(u)));
      if (u.id !== 'Admin') {
        ops.appendChild(mkBtn('改ID', 'btn-column5 btn-sm', () => promptChangeId(u)));
        ops.appendChild(mkBtn('切换权限组', 'btn-column5 btn-sm', () => promptRole(u)));
        ops.appendChild(mkBtn('删除', 'btn-column4 btn-sm', () => confirmDelete(u)));
      }
      tdOps.appendChild(ops);

      tr.append(tdUser, tdId, tdPoints, tdMail, tdRole, tdOps);
      tbody.appendChild(tr);
    });
  }

  /**
   * 生成一个操作小按钮
   * @param {string} text 按钮文字
   * @param {string} cls 附加类名
   * @param {Function} onClick 点击回调
   * @returns {HTMLButtonElement}
   */
  function mkBtn(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  /* ==================== 通用弹窗 ==================== */

  /**
   * 打开输入弹窗
   * @param {string} title 标题
   * @param {string} desc 说明
   * @param {string} placeholder 输入框占位符
   * @param {string} initial 初始值
   * @param {boolean} isPassword 是否学号框
   * @param {Function} onOk 确认回调（参数为输入值）
   */
  function openModal(title, desc, placeholder, initial, isPassword, onOk) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalDesc').textContent = desc;
    const input = document.getElementById('modalInput');
    input.value = initial || '';
    input.placeholder = placeholder || '';
    input.type = isPassword ? 'password' : 'text';
    modalConfirm = onOk;
    document.getElementById('modalOverlay').classList.add('active');
    document.getElementById('modalBox').classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 100);
  }

  /**
   * 关闭输入弹窗
   */
  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    document.getElementById('modalBox').classList.remove('active');
    document.getElementById('modalInput').type = 'text';
    document.body.style.overflow = '';
    modalConfirm = null;
  }

  /* ==================== 各操作 ==================== */

  /**
   * 新建用户弹窗（姓名 + 学号 + 自定义ID，一次一个输入框，三步完成）
   */
  function promptCreate() {
    openModal('新建用户', '第一步：输入姓名（全局唯一）', '姓名', '', false, (name) => {
      openModal('新建用户', '第二步：设置初始学号（长度不限）', '学号', '', true, (pwd) => {
        openModal('新建用户', '第三步：自定义 ID（字母/数字/连字符/下划线，留空自动生成）', 'ID（可选）', '', false, async (cid) => {
          try {
            await api('POST', '/api/users', { name, password: pwd, id: (cid || '').trim() || undefined });
            showToast('用户创建成功', 'success');
            await loadUsers();
          } catch (err) { showToast(err.message, 'error'); }
        });
      });
    });
  }

  /**
   * 重置学号弹窗
   * @param {object} u 目标用户
   */
  function promptResetPwd(u) {
    openModal(`重置学号 · ${u.name}`, `为「${u.name}」设置新学号（长度不限），无需旧学号`, '新学号', '', true, async (pwd) => {
      try {
        await api('PATCH', `/api/users/${encodeURIComponent(u.id)}`, { password: pwd });
        showToast('学号重置成功', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  /**
   * 改 ID 弹窗（会话、网盘头像、转盘归属自动迁移）
   * @param {object} u 目标用户
   */
  function promptChangeId(u) {
    openModal(`改 ID · ${u.name}`, `将「${u.name}」的 ID 由 ${u.id} 改为（字母/数字/连字符/下划线，全局唯一；登录状态与网盘头像、转盘归属自动迁移）`, '新 ID', u.id, false, async (newId) => {
      try {
        await api('PATCH', `/api/users/${encodeURIComponent(u.id)}`, { id: (newId || '').trim() });
        showToast('ID 修改成功', 'success');
        await loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  /**
   * 重命名弹窗
   * @param {object} u 目标用户
   */
  function promptRename(u) {
    openModal(`重命名 · ${u.name}`, '输入新的姓名', '新姓名', u.name, false, async (name) => {
      try {
        await api('PATCH', `/api/users/${encodeURIComponent(u.id)}`, { name });
        showToast('姓名已更新', 'success');
        await loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  /**
   * 设置积分弹窗（头像菜单展示该值；任意数字，可为负）
   * @param {object} u 目标用户
   */
  function promptPoints(u) {
    openModal(`设置积分 · ${u.name}`, `为「${u.name}」设置积分（整数，不限位数，可带负号）`, '积分数值', String(u.points ?? 0), false, async (val) => {
      try {
        await api('PATCH', `/api/users/${encodeURIComponent(u.id)}`, { points: (val || '').trim() });
        showToast('积分已更新', 'success');
        await loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  /**
   * 绑定邮箱弹窗（管理员直接为指定用户绑定 / 修改 / 解绑邮箱；留空提交即解绑）
   * @param {object} u 目标用户
   */
  function promptBindMail(u) {
    const current = mailBindings[u.id] || '';                 // 当前已绑定邮箱（空=未绑定）
    const desc = current
      ? `当前绑定：${current}。输入新邮箱可修改；清空后确认即解绑。`
      : `「${u.name}」尚未绑定邮箱。绑定后管理员可向其发送通知邮件。`;
    openModal(`绑定邮箱 · ${u.name}`, desc, '邮箱地址，如 xxx@qq.com', current, false, async (val) => {
      try {
        await api('PUT', `/api/mail/bindings/${encodeURIComponent(u.id)}`, { email: (val || '').trim() });
        showToast((val || '').trim() ? '邮箱已保存' : '已解绑邮箱', 'success');
        await loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  /**
   * 关闭权限组选择弹窗
   */
  function closeRoleModal() {
    document.getElementById('roleOverlay').classList.remove('active');
    document.getElementById('roleBox').classList.remove('active');
    document.body.style.overflow = '';   // 恢复页面滚动
  }

  /**
   * 打开权限组选择弹窗（两个大按钮：普通用户 / 管理员，点选即生效）
   * @param {object} u 目标用户
   */
  function promptRole(u) {
    // 弹窗标题与说明：显示当前权限组，方便确认
    document.getElementById('roleTitle').textContent = '切换权限组';
    document.getElementById('roleDesc').textContent =
      `为「${u.name}」选择权限组（当前：${u.role === 'admin' ? '管理员' : '普通用户'}）`;
    /** 应用所选权限组并刷新列表 */
    const apply = async (role) => {
      try {
        await api('PATCH', `/api/users/${encodeURIComponent(u.id)}`, { role });
        showToast(role === 'admin' ? '已设为管理员' : '已设为普通用户', 'success');
        closeRoleModal();
        await loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    };
    // 两个选项按钮：点击即提交
    document.getElementById('roleUser').onclick = () => apply('user');
    document.getElementById('roleAdmin').onclick = () => apply('admin');
    document.getElementById('roleOverlay').classList.add('active');
    document.getElementById('roleBox').classList.add('active');
    document.body.style.overflow = 'hidden';   // 弹窗期间禁止背景滚动
  }

  /**
   * 创建权限组选择弹窗的结构（隐藏，由 promptRole 唤起；SPA 反复进入需防重复创建）
   */
  function buildRoleModal() {
    if (document.getElementById('roleBox')) return;        // 已存在则不重复创建
    const overlay = document.createElement('div');   // 遮罩层
    overlay.className = 'modal-overlay';
    overlay.id = 'roleOverlay';
    const box = document.createElement('div');       // 弹窗主体
    box.className = 'modal';
    box.id = 'roleBox';
    box.innerHTML =
      '<h3 id="roleTitle">切换权限组</h3>' +
      '<p id="roleDesc"></p>' +
      '<div class="role-options">' +
        '<button class="btn btn-column2" id="roleUser" type="button">普通用户</button>' +
        '<button class="btn btn-column1" id="roleAdmin" type="button">管理员</button>' +
      '</div>' +
      '<div class="modal-buttons"><button class="btn btn-column5" id="roleCancel" type="button">取消</button></div>';
    document.body.appendChild(overlay);
    document.body.appendChild(box);
    // 取消按钮 / 点遮罩关闭
    document.getElementById('roleCancel').addEventListener('click', closeRoleModal);
    overlay.addEventListener('click', closeRoleModal);
  }

  /**
   * 删除用户（确认弹窗复用输入弹窗但禁用输入框）
   * @param {object} u 目标用户
   */
  function confirmDelete(u) {
    openModal(`删除用户 · ${u.name}`, `确定删除「${u.name}」？该操作不可恢复！`, '', '', false, async () => {
      try {
        await api('DELETE', `/api/users/${encodeURIComponent(u.id)}`);
        showToast('用户已删除', 'success');
        await loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  /**
   * 构建管理面板（卡片 + 表格骨架）与无权限提示，挂到内容区
   * @param {HTMLElement} content MainLayout 提供的内容容器
   */
  function buildPanel(content) {
    // 无权限提示（默认隐藏）
    const denied = document.createElement('div');          // 无权限提示容器
    denied.className = 'denied';
    denied.id = 'deniedBox';
    denied.innerHTML = '<h2>无权访问</h2><p>该页面仅对管理员开放，请联系管理员。</p>';
    const backBtn = document.createElement('button');      // 返回首页按钮
    backBtn.className = 'btn btn-column5';
    backBtn.type = 'button';
    backBtn.style.marginTop = '20px';
    backBtn.textContent = '返回首页';
    backBtn.addEventListener('click', function () { MainLayout.nav('/', true); });
    denied.appendChild(backBtn);
    content.appendChild(denied);

    // 管理面板（默认隐藏，确认管理员后显示）
    const panel = document.createElement('div');           // 管理面板容器
    panel.className = 'mgmt-wrap';
    panel.id = 'mgmtPanel';
    panel.style.display = 'none';
    const card = document.createElement('div');            // 用户列表卡片
    card.className = 'mgmt-card';
    const head = document.createElement('div');            // 卡片头：标题 + 新建按钮
    head.className = 'card-head';
    head.innerHTML = '<div><h2>全部用户</h2><p class="desc">创建账号、重置学号、调整角色或删除用户</p></div>';
    const addBtn = document.createElement('button');       // 新建用户按钮
    addBtn.className = 'btn btn-column2';
    addBtn.id = 'addBtn';
    addBtn.type = 'button';
    addBtn.textContent = '＋ 新建用户';
    addBtn.addEventListener('click', promptCreate);
    head.appendChild(addBtn);
    card.appendChild(head);

    // 表格骨架（固定列宽：colgroup 百分比 + table-layout: fixed）
    card.insertAdjacentHTML('beforeend',
      '<table class="user-table">' +
      '<colgroup>' +
      '<col class="col-user"><col class="col-id"><col class="col-points"><col class="col-mail"><col class="col-role"><col class="col-ops">' +
      '</colgroup>' +
      '<thead><tr>' +
      '<th>用户</th><th>ID</th>' +
      '<th class="hide-mobile">积分</th>' +
      '<th class="hide-mobile">邮箱</th>' +
      '<th class="hide-mobile">角色</th>' +
      '<th>操作</th></tr></thead><tbody id="userTbody"></tbody></table>');
    panel.appendChild(card);
    content.appendChild(panel);
  }

  /**
   * 构建通用弹窗（挂到 body，全页复用；SPA 反复进入需防重复创建）
   */
  function buildModal() {
    if (document.getElementById('modalBox')) return;       // 已存在则不重复创建
    const overlay = document.createElement('div');         // 遮罩层
    overlay.className = 'modal-overlay';
    overlay.id = 'modalOverlay';
    const box = document.createElement('div');             // 弹窗主体
    box.className = 'modal';
    box.id = 'modalBox';
    box.innerHTML =
      '<h3 id="modalTitle">标题</h3>' +
      '<p id="modalDesc">说明</p>' +
      '<input type="text" class="modal-input" id="modalInput" placeholder="">' +
      '<div class="modal-buttons">' +
        '<button class="btn btn-column5" id="modalCancel" type="button">取消</button>' +
        '<button class="btn btn-column3" id="modalOk" type="button">确定</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.appendChild(box);

    // 弹窗交互：取消 / 遮罩 / ESC 关闭；确定执行回调
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeRoleModal(); } });
    document.getElementById('modalOk').addEventListener('click', () => {
      const val = document.getElementById('modalInput').value;   // 输入框当前值
      const cb = modalConfirm;
      closeModal();
      if (cb) cb(val);
    });
  }

  /** 用户管理页入口：渲染布局 + 面板 + 弹窗；未登录跳统一登录页，非管理员显示无权限视图 */
  window.MainPages['/usermanagement'] = function () {
    MainLayout.render({
      title: '用户管理',
      active: '/usermanagement',
      showUserMgmt: true,        // 主项目所有页面侧边栏都提供用户管理入口（仅管理员可见），本页高亮
      padded: true
    }).then(async function (res) {
      if (!res.me.loggedIn) {
        window.location.href = '/login?next=' + encodeURIComponent('/usermanagement');
        return;
      }
      buildPanel(res.content);
      buildModal();
      buildRoleModal();
      if (!res.me.isAdmin) { showDenied(); return; }         // 非管理员显示无权限视图
      document.getElementById('mgmtPanel').style.display = '';
      try { await loadUsers(); } catch (_) { /* 403 已由 api() 处理 */ }
    });
  };
})();

/* ==================== 初始加载：按当前地址执行对应页面入口 ==================== */
(function () {
  /** 执行当前地址对应的页面入口 */
  function start() {
    var entry = window.MainPages[location.pathname];         // 当前地址对应的页面入口
    if (entry) entry();
  }

  // 等语言包加载完成后再渲染，确保首屏文案即为当前语言
  if (window.I18n && window.I18n.ready) window.I18n.ready(start);
  else start();
})();
