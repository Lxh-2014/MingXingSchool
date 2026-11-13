/**
 * 明星学校 · 邮件中心页面逻辑
 * ----------------------------------------------------------
 * 路由：/mail（仅管理员）
 * 功能（第一期）：邮件服务器（SMTP）配置的读取、保存，以及发送测试邮件
 * 设计约定：页面 HTML 仅有 #root，全部结构由本文件渲染；
 *           样式统一走 /assets/all.css（邮件相关样式在文件末尾 .mail-* 段）。
 */
window.MainPages = window.MainPages || {};

(function () {
  /** 当前已保存的配置（GET /api/mail/config 的结果），用于回显与「是否已配置」提示 */
  var currentConfig = null;

  /**
   * 请求封装：JSON 提交 + 中文错误规范化
   * @param {string} method HTTP 方法
   * @param {string} url 请求地址
   * @param {object} [body] 请求体
   * @returns {Promise<object>} 响应 JSON
   */
  async function api(method, url, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };   // 请求参数
    if (body !== undefined) opts.body = JSON.stringify(body);
    var resp = await fetch(url, opts);
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || data.success === false) {
      throw new Error(data.message || ('请求失败（HTTP ' + resp.status + '）'));
    }
    return data;
  }

  /**
   * 创建表单项容器
   * @param {string} labelText 字段名
   * @param {HTMLElement} control 表单控件
   * @param {string} [hint] 补充说明（可空）
   * @returns {HTMLElement} 表单项元素
   */
  function field(labelText, control, hint) {
    var wrap = document.createElement('div');          // 单个表单项容器
    wrap.className = 'form-group mail-field';
    var label = document.createElement('label');       // 字段名
    label.className = 'label';
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (hint) {
      var h = document.createElement('p');             // 字段补充说明
      h.className = 'form-hint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  /**
   * 创建输入框
   * @param {object} opt { id, type, placeholder, value }
   * @returns {HTMLInputElement} 输入框元素
   */
  function input(opt) {
    var el = document.createElement('input');          // 输入框
    el.className = 'input';
    el.id = opt.id;
    el.type = opt.type || 'text';
    if (opt.placeholder) el.placeholder = opt.placeholder;
    if (opt.value !== undefined && opt.value !== null) el.value = opt.value;
    return el;
  }

  /**
   * 构建「邮件服务器」配置卡片
   * @returns {HTMLElement} 卡片元素
   */
  function buildConfigCard() {
    var card = document.createElement('section');      // 配置卡片
    card.className = 'settings-card';

    var title = document.createElement('h2');          // 卡片标题
    title.textContent = '邮件服务器';
    var desc = document.createElement('p');            // 卡片说明
    desc.className = 'desc';
    card.appendChild(title);
    card.appendChild(desc);

    var status = document.createElement('p');          // 配置状态提示行
    status.className = 'mail-status';
    status.id = 'mail-status';
    card.appendChild(status);

    // ---- 第一行：服务器地址 + 端口 + 加密方式（三列紧凑排布） ----
    var row1 = document.createElement('div');          // 第一行容器
    row1.className = 'mail-grid';
    var hostInput = input({ id: 'm-host', placeholder: 'smtp.qq.com' });
    var portInput = input({ id: 'm-port', type: 'number', value: '465' });
    var secureSelect = document.createElement('select');   // 加密方式下拉
    secureSelect.className = 'input';
    secureSelect.id = 'm-secure';
    secureSelect.innerHTML =
      '<option value="ssl">SSL / TLS（465）</option>' +
      '<option value="starttls">STARTTLS（587）</option>' +
      '<option value="none">不加密（25）</option>';
    row1.appendChild(field('SMTP 服务器', hostInput));
    row1.appendChild(field('端口', portInput));
    row1.appendChild(field('加密方式', secureSelect));
    card.appendChild(row1);

    // ---- 第二行：账号 + 授权码 ----
    var row2 = document.createElement('div');          // 第二行容器
    row2.className = 'mail-grid';
    var userInput = input({ id: 'm-user', placeholder: 'xxx@qq.com' });
    var passInput = input({ id: 'm-pass', type: 'password', placeholder: '邮箱授权码' });
    row2.appendChild(field('邮箱账号', userInput));
    card.appendChild(row2);

    // ---- 第三行：发件人名称 + 发件人地址 ----
    var row3 = document.createElement('div');          // 第三行容器
    row3.className = 'mail-grid';
    var fromNameInput = input({ id: 'm-fromname', placeholder: '明星学校' });
    var fromAddrInput = input({ id: 'm-fromaddr', placeholder: '留空则与邮箱账号相同' });
    row3.appendChild(field('发件人名称', fromNameInput));
    row3.appendChild(field('发件人地址', fromAddrInput));
    card.appendChild(row3);

    // ---- 操作按钮 ----
    var actions = document.createElement('div');       // 按钮行容器
    actions.className = 'mail-actions';
    var saveBtn = document.createElement('button');    // 保存配置按钮
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-column2';
    saveBtn.textContent = '保存配置';
    actions.appendChild(saveBtn);
    card.appendChild(actions);

    /**
     * 把配置数据回显到表单
     * @param {object} cfg 服务端返回的配置（无授权码明文）
     */
    function fillForm(cfg) {
      cfg = cfg || {};
      hostInput.value = cfg.host || '';
      portInput.value = cfg.port || 465;
      secureSelect.value = cfg.secure === false
        ? (Number(cfg.port) === 587 ? 'starttls' : 'none')
        : 'ssl';
      userInput.value = cfg.user || '';
      fromNameInput.value = cfg.fromName || '';
      fromAddrInput.value = cfg.fromAddress || '';
      /* 授权码：已保存则只给占位提示，留空表示不修改 */
      passInput.value = '';
      passInput.placeholder = cfg.hasPassword ? '已保存，留空则保持不变' : '邮箱授权码';
      status.textContent = cfg.host
        ? '当前状态：已配置（' + (cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString() : '时间未知') + '）'
        : '当前状态：尚未配置';
      status.className = 'mail-status' + (cfg.host ? ' is-done' : '');
    }

    /* 加密方式切换时自动带出常用端口，减少手填 */
    secureSelect.addEventListener('change', function () {
      portInput.value = secureSelect.value === 'ssl' ? '465' : (secureSelect.value === 'starttls' ? '587' : '25');
    });

    /* 保存配置 */
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      try {
        var body = {
          host: hostInput.value.trim(),
          port: Number(portInput.value) || 465,
          secure: secureSelect.value === 'ssl',
          user: userInput.value.trim(),
          pass: passInput.value,                        // 留空则服务端沿用旧授权码
          fromName: fromNameInput.value.trim(),
          fromAddress: fromAddrInput.value.trim()
        };
        var data = await api('PUT', '/api/mail/config', body);
        currentConfig = data.config;
        fillForm(currentConfig);
        showToast('邮件配置已保存', 'success');
      } catch (err) {
        showToast(err.message || '保存失败', 'error');
      } finally {
        saveBtn.disabled = false;
      }
    });

    card._fillForm = fillForm;                          // 暴露回显方法给入口使用
    return card;
  }

  /**
   * 构建「发送测试邮件」卡片
   * @returns {HTMLElement} 卡片元素
   */
  function buildTestCard() {
    var card = document.createElement('section');       // 测试卡片
    card.className = 'settings-card';
    var title = document.createElement('h2');           // 卡片标题
    title.textContent = '发送测试邮件';
    var desc = document.createElement('p');             // 卡片说明
    desc.className = 'desc';
    card.appendChild(title);
    card.appendChild(desc);

    var toInput = input({ id: 'm-test-to' });
    card.appendChild(field('收件人', toInput));
    var hint = document.createElement('p');              // 发送说明
    hint.className = 'form-hint';
    card.appendChild(hint);

    var actions = document.createElement('div');         // 按钮行容器
    actions.className = 'mail-actions';
    var sendBtn = document.createElement('button');      // 发送测试按钮
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-column3';
    sendBtn.textContent = '发送测试邮件';
    actions.appendChild(sendBtn);
    card.appendChild(actions);

    sendBtn.addEventListener('click', async function () {
      var to = toInput.value.trim();                     // 测试收件人
      if (!to) {
        showToast('请填写收件人邮箱', 'warning');
        return;
      }
      sendBtn.disabled = true;
      var oldText = sendBtn.textContent;
      sendBtn.textContent = '发送中…';
      try {
        await api('POST', '/api/mail/test', { to: to });
        showToast('测试邮件已发送，请查收', 'success');
      } catch (err) {
        showToast(err.message || '发送失败', 'error');
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = oldText;
      }
    });

    return card;
  }

  /**
   * 构建「处罚邮件」卡片
   * 说明：选择已绑定邮箱的学生 → 填写违纪信息 → 按固定模板生成纪律告知邮件并发送
   * @returns {HTMLElement} 卡片元素
   */
  function buildDisciplineCard() {
    var card = document.createElement('section');        // 处罚邮件卡片
    card.className = 'settings-card';
    var title = document.createElement('h2');            // 卡片标题
    title.textContent = '处罚邮件';
    var desc = document.createElement('p');              // 卡片说明
    desc.className = 'desc';
    card.appendChild(title);
    card.appendChild(desc);

    // ---- 学生选择（仅列出已绑定邮箱的用户） ----
    var studentSelect = document.createElement('select'); // 学生下拉
    studentSelect.className = 'input';
    studentSelect.id = 'd-student';
    studentSelect.innerHTML = '<option value="">正在加载已绑定邮箱的学生…</option>';
    card.appendChild(field('学生', studentSelect, '未列出说明该学生尚未绑定邮箱，可去用户管理绑定。'));

    // ---- 违纪日期 + 年级 + 班级（一行三列） ----
    var row1 = document.createElement('div');            // 第一行容器
    row1.className = 'mail-grid';
    var dateInput = input({ id: 'd-date', type: 'date' });
    var gradeInput = input({ id: 'd-grade', placeholder: '如：七' });
    var classInput = input({ id: 'd-class', placeholder: '如：3' });
    row1.appendChild(field('违纪日期', dateInput));
    row1.appendChild(field('年级', gradeInput));
    row1.appendChild(field('班级', classInput));
    card.appendChild(row1);

    // ---- 违纪原因 ----
    var reasonInput = input({ id: 'd-reason', placeholder: '如：上课期间多次扰乱课堂纪律' });
    card.appendChild(field('违纪原因', reasonInput));

    // ---- 处理决定（多行，一行一条） ----
    var punishInput = document.createElement('textarea'); // 处理决定多行输入
    punishInput.className = 'input mail-textarea';
    punishInput.id = 'd-punish';
    punishInput.rows = 4;
    punishInput.placeholder = '每行一条';

    // ---- 正文预览 ----
    var previewTitle = document.createElement('p');      // 预览小标题
    previewTitle.className = 'mail-preview-title';
    previewTitle.textContent = '正文预览';
    var previewBox = document.createElement('pre');      // 预览内容
    previewBox.className = 'mail-preview';
    previewBox.id = 'd-preview';
    card.appendChild(previewTitle);
    card.appendChild(previewBox);

    // ---- 发送按钮 ----
    var actions = document.createElement('div');         // 按钮行容器
    actions.className = 'mail-actions';
    var sendBtn = document.createElement('button');      // 发送处罚邮件按钮
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-column4';
    sendBtn.textContent = '发送处罚邮件';
    actions.appendChild(sendBtn);
    card.appendChild(actions);

    /**
     * 读取表单内容并生成预览文本（与后端模板保持一致）
     * @returns {object} { subject, text }
     */
    function compose() {
      var name = studentSelect.value
        ? (studentSelect.options[studentSelect.selectedIndex].getAttribute('data-name') || '')
        : '';                                            // 学生姓名（取自选项属性）
      var dateRaw = dateInput.value;                      // 违纪日期 YYYY-MM-DD
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateRaw);
      var dateText = m ? (m[1] + '年' + m[2] + '月' + m[3] + '日') : dateRaw;
      var reason = reasonInput.value.trim();              // 违纪原因
      var punishments = punishInput.value.split('\n')
        .map(function (s) { return s.replace(/^\s*\d+[.、]\s*/, '').trim(); })
        .filter(function (s) { return !!s; });            // 去掉用户手写的编号与空行
      var grade = gradeInput.value.trim();                // 年级
      var className = classInput.value.trim();            // 班级
      var punishText = punishments.map(function (p, i) { return (i + 1) + '. ' + p; }).join('\n');
      var text = [
        '尊敬的' + name + '家长：',
        '您好！现就贵校学生' + name + '近期违纪情况及处理决定向您告知。',
        '该生于' + dateText + '，因' + reason + '，违反了《中小学生守则》相关条款。',
        '经学校德育处 / 班主任调查核实、研究讨论，现作出如下处理：',
        punishText,
        '学生的成长需要家校协同配合，请您重视本次事件，和孩子耐心沟通，引导其认识错误、规范言行。',
        '如您有疑问，可与班主任联系。',
        '顺颂安祺！',
        '明星学校 ' + grade + '年级 ' + className + '班'
      ].join('\n');                                       // 正文
      return { subject: '【纪律告知】关于' + name + '同学违纪行为的处理通知', text: text };
    }

    /** 刷新预览区 */
    function updatePreview() {
      var mail = compose();
      previewBox.textContent = '主题：' + mail.subject + '\n\n' + mail.text;
    }

    /* 任一输入变化即刷新预览 */
    [studentSelect, dateInput, reasonInput, punishInput, gradeInput, classInput].forEach(function (el) {
      el.addEventListener('input', updatePreview);
      el.addEventListener('change', updatePreview);
    });

    // 默认日期为今天
    var now = new Date();                                 // 当前时间
    var mm = String(now.getMonth() + 1).padStart(2, '0'); // 月
    var dd = String(now.getDate()).padStart(2, '0');      // 日
    dateInput.value = now.getFullYear() + '-' + mm + '-' + dd;
    updatePreview();

    /**
     * 拉取可发送对象（已绑定邮箱的用户）并填充下拉
     */
    async function loadStudents() {
      try {
        var data = await api('GET', '/api/mail/students');
        var students = data.students || [];
        studentSelect.innerHTML = students.length
          ? '<option value="">请选择学生</option>'
          : '<option value="">暂无已绑定邮箱的学生</option>';
        students.forEach(function (s) {
          var opt = document.createElement('option');    // 学生选项
          opt.value = s.userId;
          opt.textContent = s.name + '（' + s.email + '）';
          opt.setAttribute('data-name', s.name);         // 预览需要姓名
          studentSelect.appendChild(opt);
        });
        updatePreview();
      } catch (err) {
        studentSelect.innerHTML = '<option value="">加载学生失败</option>';
        showToast(err.message || '加载学生列表失败', 'error');
      }
    }

    sendBtn.addEventListener('click', async function () {
      var userId = studentSelect.value;                   // 目标学生
      var reason = reasonInput.value.trim();              // 违纪原因
      if (!userId) { showToast('请选择学生', 'warning'); return; }
      if (!dateInput.value) { showToast('请填写违纪日期', 'warning'); return; }
      if (!reason) { showToast('请填写违纪原因', 'warning'); return; }
      var punishments = punishInput.value.split('\n')
        .map(function (s) { return s.replace(/^\s*\d+[.、]\s*/, '').trim(); })
        .filter(function (s) { return !!s; });
      if (!punishments.length) { showToast('请至少填写一条处理决定', 'warning'); return; }
      if (!gradeInput.value.trim() || !classInput.value.trim()) {
        showToast('请填写年级和班级', 'warning');
        return;
      }

      sendBtn.disabled = true;
      var oldText = sendBtn.textContent;
      sendBtn.textContent = '发送中…';
      try {
        var data = await api('POST', '/api/mail/discipline', {
          userId: userId,
          date: dateInput.value,
          reason: reason,
          punishments: punishments,
          grade: gradeInput.value.trim(),
          className: classInput.value.trim()
        });
        showToast(data.message || '处罚邮件已发送', 'success');
      } catch (err) {
        showToast(err.message || '发送失败', 'error');
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = oldText;
      }
    });

    card._loadStudents = loadStudents;                   // 暴露给入口调用
    return card;
  }

  /**
   * 渲染无权限提示（非管理员直接进入 /mail 时）
   * @param {HTMLElement} content MainLayout 内容容器
   */
  function renderDenied(content) {
    var card = document.createElement('section');        // 提示卡片
    card.className = 'settings-card';
    var title = document.createElement('h2');            // 卡片标题
    title.textContent = '无权访问';
    var desc = document.createElement('p');              // 说明文字
    desc.className = 'desc';
    desc.textContent = '邮件配置仅管理员可见。如需发邮件，请联系管理员。';
    card.appendChild(title);
    card.appendChild(desc);
    content.appendChild(card);
  }

  /** 邮件页入口：渲染布局 + 配置卡片 + 测试卡片（未登录跳登录页，非管理员显示无权限） */
  window.MainPages['/mail'] = function () {
    MainLayout.render({
      active: '/mail',
      showUserMgmt: true,        // 继承主项目侧边栏配置（管理员项由登录态控制显隐）
      padded: true
    }).then(async function (res) {
      if (!res.me.loggedIn) {
        window.location.href = '/login?next=' + encodeURIComponent('/mail');
        return;
      }
      if (!res.me.isAdmin) {
        renderDenied(res.content);
        return;
      }
      var wrap = document.createElement('div');          // 卡片纵排容器
      wrap.className = 'settings-wrap mail-columns';
      var configCard = buildConfigCard();                // 配置卡片
      var testCard = buildTestCard();                    // 测试卡片
      var disciplineCard = buildDisciplineCard();        // 处罚邮件卡片
      /* 左栏：服务器配置 + 发送测试；右栏：处罚邮件（整改通知由商店「查封」触发） */
      var colLeft = document.createElement('div');       // 左栏容器
      colLeft.className = 'mail-col';
      var colRight = document.createElement('div');      // 右栏容器
      colRight.className = 'mail-col';
      colLeft.appendChild(configCard);
      colLeft.appendChild(testCard);
      colRight.appendChild(disciplineCard);
      wrap.appendChild(colLeft);
      wrap.appendChild(colRight);
      res.content.appendChild(wrap);
      disciplineCard._loadStudents();                    // 拉取已绑定邮箱的学生列表

      try {
        var data = await api('GET', '/api/mail/config');
        currentConfig = data.config;
        configCard._fillForm(currentConfig);
        /* 首次进入默认把发件人地址填进测试收件人，方便自测 */
        var toInput = document.getElementById('m-test-to');
        if (toInput && currentConfig && currentConfig.fromAddress) toInput.value = currentConfig.fromAddress;
      } catch (err) {
        showToast(err.message || '读取邮件配置失败', 'error');
      }
    });
  };
})();

/* ==================== 初始加载：按当前地址执行页面入口 ==================== */
(function () {
  var entry = window.MainPages[location.pathname];         // 当前地址对应的页面入口
  if (entry) entry();
  /* 直接访问其他主项目路径时（如 /settings），交给共享布局整页跳转 */
  else if (location.pathname !== '/') window.location.href = location.pathname;
})();
