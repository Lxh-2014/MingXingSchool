/**
 * page-im.js —— 邻语（IM）界面逻辑
 * ----------------------------------------------------------
 * 职责：
 *   - renderShell()：注入 72px 侧栏 + 60px 顶栏 + 会话列表 + 聊天区骨架
 *   - 会话列表 / 消息渲染 / 发送 / 引用 / 撤回 / 本地删除 / 已读
 *   - 聊天设置页（群聊：群资料/成员/公告/发言权限；私聊：置顶/免打扰/屏蔽/清空/删除）
 *   - 轮询同步（3 秒一次会话列表，打开会话时 2 秒全量比对消息）
 *   - 移动端（≤768px）单栏切换：会话列表 ⇄ 聊天
 *
 * 约定：
 *   - 所有 DOM 类名以 im- 开头，避免与主项目 / 其他子应用同名冲突
 *   - Toast 统一使用 common-ui.js 提供的 window.showToast
 *   - 接口统一前缀 /im/api，返回 { ok, data } / { ok:false, error:{message} }
 */
(function () {
  'use strict';

  /** 全局状态 */
  var state = {
    me: null,          // 当前登录用户 { id, name, isAdmin, avatar }
    convs: [],         // 会话列表
    activeId: null,    // 当前打开的会话 ID
    messages: [],      // 当前会话的消息数组
    lastMsgId: '',     // 当前会话最后一条消息 ID（增量轮询起点）
    quote: null,       // 当前引用 { id, name, text }
    detail: null,      // 当前会话详情（聊天设置页数据源）
    settingsOpen: false, // 是否处于聊天设置视图
    searchQuery: '', // 会话列表搜索关键词
    searchResults: null, // 全局搜索结果 { users, groups }
    searchTimer: null, // 搜索防抖定时器
    emojiCodes: null, // 表情编码列表（首次打开面板时懒加载）
    friendsOpen: false, // 是否处于「新朋友」好友申请页
    friendsData: null, // 好友申请数据 { incoming, outgoing }
    workOpen: false, // 是否处于「群作业」页
    workList: null, // 作业列表数据
    workDetail: null, // 当前查看的作业详情
    albumOpen: false, // 是否处于「群相册」页
    albumList: null, // 相册列表数据 { albums, canManage }
    albumDetail: null, // 当前查看的相册详情（含照片）
    albumCanManage: false, // 当前用户是否可管理相册（新建/删除）
    albumSelectMode: false, // 相册详情是否处于多选模式
    albumSelected: {}, // 多选模式下已选中的照片（id → true）
    membersExpanded: false, // 群成员网格是否展开全部
    tickTimer: null,   // 会话列表轮询定时器
    msgTimer: null,    // 消息增量轮询定时器
    mobileMsgOpen: false, // 移动端是否处于「聊天」视图
    mode: 'chat',      // 左栏模式：chat=消息，contacts=联系人
    contacts: null,    // 联系人数据 { groups, friends, pendingCount }
    contactId: null,   // 当前选中的联系人 ID
    contactQuery: '',  // 联系人搜索关键词
    contactTab: 'friends', // 联系人底部 tab：friends=好友，groups=群聊
    collapsedGroups: {} // 已折叠的联系人分组（id → true）
  };

  /** 关键 DOM 缓存（渲染后填充） */
  var dom = {};

  // ============ 基础工具 ============

  /**
   * 取多语言文案：i18n 框架未加载时回退中文兜底
   * @param {string} key 语言包键（如 im.shell.send）
   * @param {string} fallback 中文兜底文案
   * @param {object} [params] 占位参数（如 {count: 3}）
   * @returns {string} 展示文案
   */
  function imT(key, fallback, params) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, params, fallback) : fallback;
  }

  /**
   * 快捷选择器
   * @param {string} sel CSS 选择器
   * @param {Document|HTMLElement} [root=document] 查找根节点
   * @returns {HTMLElement|null}
   */
  function $(sel, root) { return (root || document).querySelector(sel); }

  /**
   * HTML 转义，防止消息内容被当作标签解析（XSS 防护）
   * @param {string} s 原始文本
   * @returns {string} 转义后的文本
   */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 绑定长按手势（触屏设备呼出上下文菜单；桌面端仍走 contextmenu）
   * @param {HTMLElement} el 目标元素
   * @param {(x:number, y:number)=>void} onLongPress 长按回调，参数为触点坐标
   */
  function bindLongPress(el, onLongPress) {
    var timer = null;          // 长按计时器
    var startX = 0;            // 触摸起点 X 坐标
    var startY = 0;            // 触摸起点 Y 坐标
    var fired = false;         // 本次触摸是否已触发长按

    /** 取消当前计时（手指移动/抬起/打断时调用） */
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;                  // 多指（双指缩放）不触发
      var t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      fired = false;
      cancel();
      timer = setTimeout(function () {
        fired = true;
        if (navigator.vibrate) navigator.vibrate(10);      // 轻微震动反馈（支持的设备）
        onLongPress(startX, startY);
      }, 480);
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      if (!t) return;
      // 移动超过 10px 视为滚动列表，取消长按
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) cancel();
    }, { passive: true });

    el.addEventListener('touchend', function (e) {
      cancel();
      if (fired) e.preventDefault();                       // 阻止长按抬起后触发的合成点击（如图片放大）
    }, { passive: false });

    el.addEventListener('touchcancel', cancel);
  }

  /**
   * 把任意文本插入到指定 textarea 的光标处（通用工具函数）
   * @param {HTMLTextAreaElement} ta 目标 textarea
   * @param {string} text 要插入的文本内容（如表情短代码、Markdown 图片语法、HTML video 标签等）
   */
  function insertTextIntoTextarea(ta, text) {
    if (!ta) return;
    var start = ta.selectionStart;                              // 光标起点
    var end = ta.selectionEnd;                                  // 光标终点
    var val = ta.value;                                         // textarea 当前值
    ta.value = val.slice(0, start) + text + val.slice(end);     // 替换选中范围或插入光标处
    ta.selectionStart = ta.selectionEnd = start + text.length;  // 光标移到插入内容之后
    ta.focus();                                                 // 保持焦点
  }

  /**
   * 把表情短代码插入到指定 textarea 的光标处（封装 insertTextIntoTextarea）
   * @param {HTMLTextAreaElement} ta 作业/提交内容 textarea
   * @param {string} code 表情编码（如 "1"、"2_3"）
   */
  function insertEmojiCodeIntoTextarea(ta, code) {
    insertTextIntoTextarea(ta, ':' + code + ':');
  }

  /**
   * 弹出表情选择面板（供 textarea 输入使用），选中的表情会以短代码形式插入目标 textarea
   * @param {HTMLTextAreaElement} ta 目标 textarea
   */
  function openEmojiPickerForTextarea(ta) {
    // 如果邻语表情面板已存在，直接复用它的数据源；否则用一个轻量面板
    if (dom.emojiPanel && state.emojiCodes && state.emojiCodes.length) {
      // 已有面板 + 已有数据 → 直接弹面板，但改变点击行为：由 insertEmojiIntoEditor 改为 insertEmojiCodeIntoTextarea
      // 这里简单处理：临时改 insertEmojiIntoEditor 的行为有点复杂，不如直接用同样的 codes 渲染一个小面板
    }
    var picker = document.createElement('div');                 // 临时表情面板
    picker.className = 'im-emoji-panel im-emoji-panel-textarea show';
    picker.style.position = 'fixed';
    picker.style.zIndex = '10000';
    // 懒加载表情列表
    if (state.emojiCodes) {
      renderTextareaEmojiPicker(picker, ta, state.emojiCodes);
    } else {
      picker.innerHTML = '<div class="im-emoji-loading">' + imT('im.emoji.loading', '加载中…') + '</div>';
      api('/emojis').then(function (codes) {
        state.emojiCodes = Array.isArray(codes) ? codes : [];
        renderTextareaEmojiPicker(picker, ta, state.emojiCodes);
      }).catch(function () {
        picker.innerHTML = '<div class="im-emoji-loading">' + imT('im.emoji.empty', '暂无表情') + '</div>';
      });
    }
    document.body.appendChild(picker);
    // 定位到 textarea 右下角
    var rect = ta.getBoundingClientRect();
    var pw = 300;
    var ph = 240;
    var left = Math.min(rect.left, window.innerWidth - pw - 12);
    var top = rect.bottom + 6;
    if (top + ph > window.innerHeight - 12) top = Math.max(8, rect.top - ph - 6);
    picker.style.left = Math.max(8, left) + 'px';
    picker.style.top = Math.max(8, top) + 'px';
    // 点外面收起
    var closer = function (e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('mousedown', closer, true);
      }
    };
    setTimeout(function () { document.addEventListener('mousedown', closer, true); }, 10);
  }

  /**
   * 渲染 textarea 专用的表情面板（懒加载表情图片）
   * @param {HTMLElement} picker 面板容器
   * @param {HTMLTextAreaElement} ta 目标 textarea
   * @param {Array<string>} codes 表情编码列表
   */
  function renderTextareaEmojiPicker(picker, ta, codes) {
    picker.innerHTML = '';
    var cats = document.createElement('div');
    cats.className = 'im-emoji-cats';
    var tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'im-emoji-cat active';
    tab.textContent = imT('im.emoji.super', '超级表情');
    cats.appendChild(tab);
    picker.appendChild(cats);
    var grid = document.createElement('div');
    grid.className = 'im-emoji-grid';
    grid.style.maxHeight = '180px';
    grid.style.overflowY = 'auto';
    codes.forEach(function (code) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'im-emoji-item';
      btn.title = code;
      var img = document.createElement('img');
      img.src = '/im/emoji/' + code + '.png';
      img.alt = code;
      img.loading = 'lazy';
      img.decoding = 'async';
      btn.appendChild(img);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        insertEmojiCodeIntoTextarea(ta, code);
        picker.remove();
        document.removeEventListener('mousedown', arguments.callee, true); // eslint-disable-line no-callee
      });
      grid.appendChild(btn);
    });
    picker.appendChild(grid);
  }

  /**
   * 将表情短代码 :code: 替换成 <img>（在 Markdown 解析出的 HTML 上做，避免破坏原文）
   * 只替换文本节点，不会误伤用户写的 <img src="..."> 里的路径
   * @param {string} html marked 输出的原始 HTML
   * @returns {string} 替换表情后的 HTML（待 DOMPurify 消毒）
   */
  function replaceEmojiShortcodes(html) {
    return String(html).replace(/(>)([^<]*?)(<)/g, function (m, open, text, close) {
      // 在标签之间的纯文本里找 :code: 短代码
      var replaced = text.replace(/:(\d+(?:_\d+)?):/g, function (em, code) {
        return '<img class="im-emoji-img" src="/im/emoji/' + code + '.png" alt=":' + code + ':" title=":' + code + ':">';
      });
      return open + replaced + close;
    });
  }

  /**
   * Markdown 转安全的 HTML（作业内容等富文本展示）
   * 依赖 marked + DOMPurify；两者未加载时退化为转义后的纯文本（保留换行）
   * @param {string} text Markdown 原文（可含 :code: 表情短代码）
   * @returns {string} 可直接写入 innerHTML 的安全 HTML
   */
  function mdToHtml(text) {
    var src = String(text == null ? '' : text);
    if (!window.marked || !window.DOMPurify) {
      // 库未加载时，只做基础的短代码 → 文字提示
      return esc(src).replace(/:(\d+(?:_\d+)?):/g, '[:$1:]').replace(/\n/g, '<br>');
    }
    try {
      var raw = window.marked.parse(src, { breaks: true, gfm: true });   // 支持表格/删除线/自动链接
      raw = replaceEmojiShortcodes(raw);                                 // 替换表情短代码为 <img>
      var box = document.createElement('div');                          // 临时容器（补外链属性）
      // DOMPurify 默认过滤 <video>/<source>，需显式放行；表情 <img> 的 loading/decoding 也保留
      box.innerHTML = window.DOMPurify.sanitize(raw, {
        ADD_TAGS: ['video', 'source'],
        ADD_ATTR: ['controls', 'preload', 'autoplay', 'loop', 'muted', 'playsinline',
                   'width', 'height', 'poster', 'loading', 'decoding']
      });
      Array.prototype.forEach.call(box.querySelectorAll('a'), function (a) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
      // 把 DOMPurify 过滤掉 onerror 后留下的合法 <img> 加上表情类
      Array.prototype.forEach.call(box.querySelectorAll('img[src^="/im/emoji/"]'), function (img) {
        img.classList.add('im-emoji-img');
        img.loading = 'lazy';
        img.decoding = 'async';
      });
      return box.innerHTML;
    } catch (e) {
      return esc(src).replace(/:(\d+(?:_\d+)?):/g, '[:$1:]').replace(/\n/g, '<br>');
    }
  }

  /**
   * 将 Markdown 渲染进指定容器（自动加 im-md 样式类）
   * @param {HTMLElement} el 目标容器
   * @param {string} text Markdown 原文
   */
  function renderMarkdown(el, text) {
    if (!el) return;
    el.classList.add('im-md');
    el.innerHTML = mdToHtml(text);
    // 点缩略图看原图（排除表情小图），与 cursor: zoom-in 对应
    Array.prototype.forEach.call(el.querySelectorAll('img:not(.im-emoji-img)'), function (img) {
      img.addEventListener('click', function () { window.open(img.src, '_blank', 'noopener'); });
    });
  }

  /**
   * 统一请求封装：自动解析 { ok, data } 并抛出中文错误
   * @param {string} path 接口路径（不含 /im/api 前缀）
   * @param {object} [options] fetch 选项
   * @returns {Promise<*>} data 字段
   */
  async function api(path, options) {
    var opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
    var res = await fetch('/im/api' + path, opts);
    var json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(imT('im.chat.toastServerError', '服务器返回异常，请稍后重试'));
    }
    if (!json || !json.ok) {
      // 后端返回的错误文案原样透传，仅在缺失时使用本地兜底
      throw new Error((json && json.error && json.error.message) || imT('im.chat.toastRequestFailed', '请求失败'));
    }
    return json.data;
  }

  /**
   * 取姓名首字作为头像占位文字（中文取第一个字，英文取首字母大写）
   * @param {string} name 用户姓名
   * @returns {string}
   */
  function initial(name) {
    var s = String(name || '').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }

  /** 平台默认头像：与主项目一致，未上传头像时显示默认人形图（不用首字色块） */
  var DEFAULT_AVATAR = '/assets/home/default-avatar.png';

  /**
   * 构造头像元素：优先使用公开头像接口，未上传头像时回退平台默认头像
   * @param {string} name 用户姓名
   * @param {string} userId 用户 ID（用于拉取头像）
   * @param {string} cls 额外类名
   * @returns {HTMLElement} 头像容器
   */
  function makeAvatar(name, userId, cls) {
    var box = document.createElement('div');                  // 头像容器
    box.className = 'im-avatar' + (cls ? ' ' + cls : '');
    box.title = name || '';

    if (userId) {
      var img = document.createElement('img');                // 头像图片
      img.alt = name || userId;
      img.src = '/api/user-avatar/' + encodeURIComponent(userId);
      img.onerror = function () {                             // 该用户未上传头像：改用平台默认头像
        if (img.dataset.fallback) return;                     // 防止默认头像也失败时无限循环
        img.dataset.fallback = '1';
        img.src = DEFAULT_AVATAR;
      };
      box.appendChild(img);
      return box;
    }

    var text = document.createElement('span');                // 无用户 ID 时用首字占位
    text.className = 'im-avatar-text';
    text.textContent = initial(name);
    box.appendChild(text);
    return box;
  }

  /**
   * 在输入区光标处插入「@昵称」，用于群聊长按头像 @ 人
   * @param {string} name 被 @ 的群昵称
   */
  function insertMention(name) {
    if (!state.activeId || !name) return;
    insertEditorNode(document.createTextNode('@' + name + ' '), true);
    dom.input.focus();
  }

  /**
   * 给群聊头像绑定长按 @ 人（500ms），桌面右键也可触发
   * @param {HTMLElement} el 头像元素
   * @param {string} name 群昵称
   */
  function bindAvatarMention(el, name) {
    var timer = null;                                         // 长按定时器
    function start() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        insertMention(name);
      }, 500);
    }
    function stop() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    el.classList.add('im-avatar-mention');
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('contextmenu', function (e) {          // 桌面端右键也可 @
      e.preventDefault();
      stop();
      insertMention(name);
    });
  }

  /**
   * 会话列表里的时间：今天显示 HH:MM，昨天显示「昨天」，更早显示「月/日」
   * @param {string} iso ISO 时间字符串
   * @returns {string}
   */
  function convTimeLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) {
      return imT('im.time.monthDay', '{month}月{day}日', { month: d.getMonth() + 1, day: d.getDate() });
    }
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  /**
   * 日期分组标题：今天 / 昨天 / 具体日期
   * @param {string} iso ISO 时间字符串
   * @returns {string}
   */
  function dayLabel(iso) {
    var d = new Date(iso);
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return imT('im.time.today', '今天');
    var yest = new Date(now.getTime() - 86400000);            // 昨天
    if (d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate()) {
      return imT('im.time.yesterday', '昨天');
    }
    return imT('im.time.fullDate', '{year}年{month}月{day}日', {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()
    });
  }

  /**
   * 判断两条消息是否属于同一天（用于插入日期分隔条）
   * @param {string} a 前一条消息时间
   * @param {string} b 后一条消息时间
   * @returns {boolean}
   */
  function sameDay(a, b) {
    if (!a || !b) return false;
    var da = new Date(a); var db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }

  /**
   * 获取会话对方 ID（单聊用）
   * @param {object} conv 会话对象
   * @returns {string|null}
   */
  function peerId(conv) {
    if (!conv || conv.type !== 'c2c') return null;
    var other = (conv.members || []).find(function (m) { return m.id !== state.me.id; });
    return other ? other.id : null;
  }

  /**
   * 会话在界面上的显示名：优先用「我的备注」，单聊其次显示「对方」名字，最后回退会话标题
   * 单聊标题是创建时的对方名字，若直接用标题，被发起方那边会看到自己的名字
   * @param {object} conv 会话对象（含 prefs / members）
   * @returns {string}
   */
  function convLabel(conv) {
    if (!conv) return imT('im.common.conversation', '会话');
    if (conv.prefs && conv.prefs.remark) return conv.prefs.remark;
    if (conv.type === 'c2c') {
      // 成员可能是对象（含 name）或纯 ID，两种都兼容
      var other = (conv.members || []).find(function (m) {
        var id = m && typeof m === 'object' ? m.id : m;
        return id !== state.me.id;
      });
      if (other) {
        var name = typeof other === 'object' ? other.name : '';
        if (name) return name;
      }
    }
    return conv.title || imT('im.common.conversation', '会话');
  }

  /**
   * 「我的本群身份」常量：可选身份与教授科目
   */
  var IDENT_ROLES = ['老师', '班主任', '学生', '家长', '家委'];
  /** 群成员列表的身份排序权重（数值越小越靠前，未设置身份的排最后） */
  var IDENT_ROLE_RANK = { '班主任': 0, '老师': 1, '家委': 2, '家长': 3, '学生': 4 };
  /** 可选教授科目（仅「老师」身份需要） */
  var IDENT_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道法', '体育', '音乐', '美术', '信息技术', '自习', '其他'];
  /** 家长/家委与孩子的关系（仅「家长」「家委」身份需要） */
  var IDENT_RELATIONS = ['妈妈', '爸爸', '姥姥', '姥爷', '奶奶', '爷爷', '姐姐', '哥哥', '弟弟', '妹妹', '家长'];

  /**
   * 由群内身份生成群昵称
   * 老师/班主任：科目-称呼（如「数学-数大小」）；家长/家委：孩子姓名+关系（如「小明妈妈」）；其余：称呼
   * @param {object} ident 身份对象 { role, subject, nickname, childName, relation }
   * @returns {string} 空字符串表示未设置
   */
  function groupNick(ident) {
    if (!ident) return '';
    if (isTeacherRole(ident.role)) {
      if (!ident.nickname) return '';
      return (ident.subject ? ident.subject + '-' : '') + ident.nickname;
    }
    if (ident.role === '家长' || ident.role === '家委') {
      if (!ident.relation) return ident.nickname || '';
      return (ident.childName || '') + ident.relation;
    }
    return ident.nickname || '';
  }

  /**
   * 群聊里展示发送者名称：优先用本群身份拼出的群昵称，没有则回退真实姓名
   * @param {object|null} conv 会话对象（列表项或详情，含 members）
   * @param {string} senderId 发送者用户 ID
   * @param {string} fallback 消息里记录的发送者姓名
   * @param {string} [senderNick] 后端下发的群昵称（优先使用）
   * @returns {string} 展示名称
   */
  function senderNameFor(conv, senderId, fallback, senderNick) {
    if (senderNick) return senderNick;
    if (conv && conv.type === 'group' && Array.isArray(conv.members)) {
      var member = conv.members.find(function (m) { return m && m.id === senderId; });
      var nick = member ? groupNick(member.identity) : '';
      if (nick) return nick;
    }
    // 单聊：对方消息优先显示我设置的备注名（自己的消息仍用自己的名字）
    var isSelf = !!(state.me && senderId === state.me.id);     // 是否本人发送
    if (!isSelf && conv && conv.type === 'c2c' && conv.prefs && conv.prefs.remark) return conv.prefs.remark;
    return fallback || senderId;
  }

  /** 身份标配色：仅班主任 / 老师 / 家委展示身份标，其余身份不展示 */
  var ROLE_TONES = {
    '班主任': 'im-role-head',
    '老师': 'im-role-teacher',
    '家委': 'im-role-committee'
  };

  /**
   * 生成身份标 HTML（群昵称左侧的小徽标）
   * @param {string} role 群内身份
   * @returns {string} 非班主任/老师/家委时返回空串
   */
  function roleBadgeHtml(role) {
    var tone = ROLE_TONES[role];
    if (!tone) return '';
    return '<span class="im-role-badge ' + tone + '">' + esc(role) + '</span>';
  }

  /**
   * 是否可撤回他人消息：群主、管理员、班主任、老师、家委
   * @param {object|null} conv 当前会话
   * @returns {boolean}
   */
  function canRecallOthers(conv) {
    if (!conv || conv.type !== 'group' || !state.me) return false;
    if (state.me.isAdmin || conv.ownerId === state.me.id) return true;                // 平台管理员 / 群主
    var role = conv.prefs && conv.prefs.identity ? conv.prefs.identity.role : '';     // 我的本群身份
    return role === '班主任' || role === '老师' || role === '家委';
  }

  /**
   * 取成员的展示名：群昵称优先，其次真实姓名，最后回退用户 ID
   * @param {object|null} conv 会话对象（含 members）
   * @param {string} userId 成员用户 ID
   * @returns {string} 展示名
   */
  function memberDisplayName(conv, userId) {
    if (!conv || !Array.isArray(conv.members)) return userId;
    var member = conv.members.find(function (m) { return m && m.id === userId; });
    if (!member) return userId;
    return groupNick(member.identity) || member.name || userId;
  }

  /**
   * 生成撤回提示文案
   * 规则：
   *   - 我撤回别人的：你撤回了成员 X 的一条消息
   *   - 别人撤回我的：X 撤回了你的一条消息
   *   - 别人撤回别人的（我无管理身份）：管理员撤回了一条成员消息
   *   - 别人撤回别人的（我有管理身份）：X 撤回了一条成员消息
   * @param {object} msg 已撤回的消息
   * @param {object|null} conv 消息所在会话
   * @param {boolean} [short] 是否使用短文案（会话列表预览用，不带成员名）
   * @returns {string} 展示文案
   */
  function recallTextFor(msg, conv, short) {
    var byId = msg.recalledBy || msg.senderId;                 // 实际操作者（旧数据没有 recalledBy 时按发送者处理）
    var memberName = senderNameFor(conv, msg.senderId, msg.senderName, msg.senderNick);  // 被撤回消息的成员名
    var isMyMsg = msg.senderId === state.me.id;                // 被撤回的是否是我的消息
    var isSelfRecall = byId === msg.senderId;                  // 发送者自己撤回自己的消息

    if (!isSelfRecall) {
      // 管理身份撤回了成员消息：撤回者显示为「你」/对方群昵称/管理员
      var actor;
      if (byId === state.me.id) {
        actor = imT('im.chat.recallSelf', '你');
      } else if (isMyMsg || canRecallOthers(conv)) {
        actor = memberDisplayName(conv, byId);                 // 撤回的是我的消息，或我本身有管理身份 → 显示撤回者昵称
      } else {
        actor = imT('im.chat.recallAdmin', '管理员');           // 普通成员视角隐去具体撤回者
      }
      if (isMyMsg) {
        return imT('im.chat.recalledMeLine', '{operator}撤回了你的一条消息', { operator: actor });
      }
      if (byId === state.me.id && !short && memberName) {
        return imT('im.chat.recalledMemberLine', '{operator}撤回了成员{member}的一条消息', {
          operator: actor, member: memberName
        });
      }
      return imT('im.chat.recalledMemberNoName', '{operator}撤回了一条成员消息', { operator: actor });
    }

    // 撤回自己发送的消息：沿用原提示
    var selfName = byId === state.me.id ? imT('im.chat.recallSelf', '你') : memberName;
    return imT('im.chat.recalledLine', '{name} 撤回了一条消息', { name: selfName });
  }

  /**
   * 取当前打开的会话对象：优先使用详情，未拉详情时回退到列表项
   * @returns {object|null}
   */
  function activeConv() {
    if (state.detail && state.detail.id === state.activeId) return state.detail;
    return state.convs.find(function (c) { return c.id === state.activeId; }) || null;
  }

  /**
   * 判断是否老师类身份：班主任与老师共用「教授科目 + 称呼」表单与昵称规则
   * @param {string} role 群内身份
   * @returns {boolean} true 表示老师类身份
   */
  function isTeacherRole(role) {
    return role === '老师' || role === '班主任';
  }

  // ============ 骨架渲染 ============

  /** 返回图标 SVG */
  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>';
  /** 刷新图标 SVG */
  var ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  /** 分组折叠箭头（朝右，展开时通过 CSS 旋转朝下） */
  var ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  /** 向下箭头（相册卡片右上角「更多」按钮） */
  var ICON_CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  /** 群相册卡片顶部插画（两张叠放的蓝色照片） */
  var ICON_ALBUM_HERO =
    '<svg viewBox="0 0 90 90" fill="none">' +
      '<defs><linearGradient id="imAlbumHeroG" x1="0" y1="0" x2="1" y2="1">' +
        '<stop stop-color="#d6f6ff"/><stop offset="1" stop-color="#ffe4f8"/></linearGradient></defs>' +
      '<circle cx="45" cy="44" r="32" fill="url(#imAlbumHeroG)"/>' +
      '<g transform="rotate(14 52 40)">' +
        '<rect x="34" y="20" width="34" height="26" rx="4" fill="#2196f3"/>' +
        '<circle cx="60" cy="28" r="3.4" fill="#d9efff"/>' +
      '</g>' +
      '<g transform="rotate(-9 45 50)">' +
        '<rect x="20" y="32" width="46" height="36" rx="5" fill="#2eb3f7"/>' +
        '<circle cx="31" cy="43" r="4.4" fill="#ffffff"/>' +
        '<path d="M20 59l10-8 8 6 9-6 9 8v3a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4z" fill="#3fb95a"/>' +
      '</g>' +
    '</svg>';
  /** 群相册标签图标（蓝色小相册） */
  var ICON_ALBUM_TAG =
    '<svg viewBox="0 0 10 10">' +
      '<rect width="10" height="10" rx="2" fill="#19a3ff"/>' +
      '<circle cx="3.4" cy="3.2" r="1.1" fill="#fff"/>' +
      '<path d="M1 7.3l2.4-2.2 1.7 1.4 1.4-1.1L9 7.3V8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" fill="#fff"/>' +
    '</svg>';

  /** 联系人图标（单人剪影，用于侧边栏） */
  var ICON_CONTACT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';

  /** 空间图标（五角星，用于侧边栏） */
  var ICON_SPACE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 6.1 6.6.5-5 4.3 1.5 6.4L12 17l-5.7 3.3 1.5-6.4-5-4.3 6.6-.5z"/></svg>';

  /** 频道图标（播放/信号，用于侧边栏） */
  var ICON_CHANNEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9v6M12 9v6M16 9v6"/></svg>';
  /** 单聊图标（对话气泡） */
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.2-.6L3 21l1.7-5a8.4 8.4 0 0 1-.7-3.6 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.5z"/><circle cx="9" cy="11" r="1"/><circle cx="13" cy="11" r="1"/><circle cx="17" cy="11" r="1"/></svg>';
  /** 新建单聊图标（加号） */
  var ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  /** 新建群聊图标（人群） */
  var ICON_GROUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>';
  /** 新建群聊图标（对话气泡 + 加号） */
  var ICON_GROUP_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.2-.6L3 21l1.7-5a8.4 8.4 0 0 1-.7-3.6 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.5z"/><path d="M12 8v6M9 11h6"/></svg>';
  /** 加好友图标（人形 + 加号） */
  var ICON_USER_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>';
  /** 更多（聊天设置）图标：三个圆点 */
  var ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  /** 置顶图标（图钉）：会话列表置顶标记 */
  var ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 8 3 3H5l3-3z"/></svg>';
  /** 免打扰图标（静音铃铛）：会话列表静音标记 */
  var ICON_MUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8a6 6 0 0 0-9.2-5.1M6 9v3l-2 4h12"/><path d="M9.5 20a2.5 2.5 0 0 0 4.5 0"/><path d="M3 3l18 18"/></svg>';
  /** 关闭图标（设置侧栏右上角） */
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  /** 搜索图标（会话列表搜索） */
  var ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';
  /** 图片图标（输入区发送图片） */
  var ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>';
  var ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/></svg>';
  /** 文件图标（输入区发送文件） */
  var ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  /** 表情图标：笑脸 */
  var ICON_EMOJI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><circle cx="9" cy="9.5" r="1"/><circle cx="15" cy="9.5" r="1"/></svg>';

  /**
   * 渲染整页骨架（只执行一次）
   * 布局：72px 图标侧栏 + 主区（60px 顶栏 + 左会话列表 + 右聊天区）
   */
  function renderShell() {
    var root = $('#root');
    root.innerHTML = '';

    // ---- 左侧 72px 图标侧栏（logo 回门户 + 消息/联系人/空间/频道） ----
    var rail = document.createElement('aside');
    rail.className = 'im-rail';
    rail.innerHTML =
      '<a class="im-rail-logo" href="/" title="' + imT('im.shell.backToPortal', '返回门户') + '"><img src="/assets/home/logo.png" alt="' + imT('app.name', '明星学校') + '"></a>' +
      // 最外层侧边栏：消息 / 联系人 / 空间 / 频道
      '<nav class="im-rail-nav">' +
        '<button class="im-nav-item im-rail-tab active" data-mode="chat" title="' + imT('im.shell.listTitle', '消息') + '">' + ICON_CHAT + '<span>' + imT('im.shell.listTitle', '消息') + '</span></button>' +
        '<button class="im-nav-item im-rail-tab" data-mode="contacts" title="' + imT('im.contacts.title', '联系人') + '">' + ICON_CONTACT + '<span>' + imT('im.contacts.title', '联系人') + '</span></button>' +
        '<button class="im-nav-item im-rail-tab" data-mode="space" title="' + imT('im.contacts.space', '空间') + '">' + ICON_SPACE + '<span>' + imT('im.contacts.space', '空间') + '</span></button>' +
        '<button class="im-nav-item im-rail-tab" data-mode="channel" title="' + imT('im.contacts.channel', '频道') + '">' + ICON_CHANNEL + '<span>' + imT('im.contacts.channel', '频道') + '</span></button>' +
      '</nav>';

    // ---- 主区 ----
    var main = document.createElement('div');
    main.className = 'im-main';

    // 顶栏：左侧返回按钮 + 会话标题（内容标题，不是应用名）；右侧头像
    var topbar = document.createElement('header');
    topbar.className = 'im-topbar';
    topbar.innerHTML =
      '<div class="im-topbar-left">' +
        '<button class="icon-btn im-back-btn" id="imBack" title="' + imT('im.shell.backToList', '返回会话列表') + '">' + ICON_BACK + '</button>' +
        '<div class="im-chat-title" id="imChatTitle">' + imT('im.common.conversation', '会话') + '</div>' +
      '</div>' +
      '<div class="im-topbar-right">' +
        '<div class="im-topbar-actions">' +
          '<button class="icon-btn" id="imMore" title="' + imT('im.shell.chatSettings', '聊天设置') + '">' + ICON_MORE + '</button>' +
        '</div>' +
        '<div class="user-info">' +
          '<div class="user-avatar" id="imSelfAvatar" title="' + esc(state.me.name) + '"></div>' +
        '</div>' +
      '</div>';

    // 头像：有自定义头像用图片，否则用默认占位图
    var selfAvatar = $('#imSelfAvatar', topbar);
    var selfImg = document.createElement('img');                // 当前用户头像图片
    selfImg.src = state.me.avatar || '/assets/home/default-avatar.png';
    selfImg.alt = state.me.name || '';
    selfAvatar.appendChild(selfImg);

    // 主体：会话列表 + 聊天区
    var body = document.createElement('div');
    body.className = 'im-body';
    body.innerHTML =
      '<aside class="im-conv-pane">' +
        // 列表标题：随侧边栏切换显示「消息 / 联系人」
        '<div class="im-conv-head">' +
          '<span class="im-conv-head-title" id="imConvModeTitle">' + imT('im.shell.listTitle', '消息') + '</span>' +
        '</div>' +
        '<div class="im-conv-view" id="imConvView">' +
          // 搜索栏：常显圆角搜索框 + 右侧新建按钮（+）
          '<div class="im-conv-searchbar">' +
            '<div class="im-conv-search" id="imConvSearch">' +
              '<span class="im-conv-search-icon">' + ICON_SEARCH + '</span>' +
              '<input class="im-conv-search-input" id="imConvSearchInput" placeholder="' + imT('im.shell.search', '搜索') + '">' +
              '<button class="im-conv-search-clear" id="imConvSearchClear" title="' + imT('im.shell.clearSearch', '清除') + '">' + ICON_CLOSE + '</button>' +
            '</div>' +
            '<button class="im-conv-new" id="imNew" title="' + imT('im.shell.newConversation', '新建会话') + '">' + ICON_PLUS + '</button>' +
            '<div class="im-new-menu" id="imNewMenu">' +
              '<button data-act="c2c"><span class="im-new-menu-icon">' + ICON_CHAT + '</span><span>' + imT('im.shell.newC2c', '发起单聊') + '</span></button>' +
              '<button data-act="group"><span class="im-new-menu-icon">' + ICON_GROUP_PLUS + '</span><span>' + imT('im.shell.newGroup', '新建群聊') + '</span></button>' +
            '</div>' +
          '</div>' +
          '<div class="im-conv-list" id="imConvList"></div>' +
        '</div>' +
        // 联系人视图：搜索 + 快捷入口 + 分组好友列表 + 底部 tab
        '<div class="im-contacts-pane" id="imContactsPane">' +
          '<div class="im-contacts-search">' +
            '<span class="im-conv-search-icon">' + ICON_SEARCH + '</span>' +
            '<input class="im-contacts-search-input" id="imContactsSearchInput" placeholder="' + imT('im.contacts.search', '搜索昵称 / 账号 / 备注') + '">' +
            '<button class="im-conv-search-clear" id="imContactsSearchClear" title="' + imT('im.shell.clearSearch', '清除') + '">' + ICON_CLOSE + '</button>' +
          '</div>' +
          '<div class="im-contacts-quick">' +
            '<button class="im-contacts-quick-btn" id="imContactAdd">' + ICON_USER_PLUS + '<span>' + imT('im.contacts.addFriend', '添加好友') + '</span></button>' +
            '<button class="im-contacts-quick-btn" id="imContactNewChat">' + ICON_GROUP_PLUS + '<span>' + imT('im.contacts.newGroupChat', '创建群聊') + '</span></button>' +
            '<button class="im-contacts-quick-btn" id="imContactNewGroup">' + ICON_PLUS + '<span>' + imT('im.contacts.newGroup', '新建分组') + '</span></button>' +
          '</div>' +
          '<div class="im-contacts-list" id="imContactsList"></div>' +
          '<div class="im-contacts-tabs" id="imContactsTabs">' +
            '<button class="im-contacts-tab active" data-tab="friends">' + imT('im.contacts.tabFriends', '好友') + '</button>' +
            '<button class="im-contacts-tab" data-tab="groups">' + imT('im.contacts.tabGroups', '群聊') + '</button>' +
            '<button class="im-contacts-tab" data-tab="new">' + imT('im.contacts.tabNewFriends', '新朋友') +
              '<span class="im-contacts-dot" id="imContactsNewDot"></span></button>' +
          '</div>' +
        '</div>' +
      '</aside>' +
      '<section class="im-chat-pane" id="imChatPane">' +
        '<div class="im-chat-empty" id="imChatEmpty">' + imT('im.shell.emptyChat', '选择一个会话，开始轻声相语') + '</div>' +
        '<div class="im-history" id="imHistory"></div>' +
        '<div class="im-quote-bar" id="imQuoteBar">' +
          '<span class="im-quote-text" id="imQuoteText"></span>' +
          '<button class="im-quote-close" id="imQuoteClose" title="' + imT('im.shell.cancelQuote', '取消引用') + '">×</button>' +
        '</div>' +
        '<div class="im-input-bar">' +
          '<div class="im-input-tools">' +
            '<button class="im-tool-btn" id="imPickEmoji" title="' + imT('im.emoji.pick', '发送表情') + '">' + ICON_EMOJI + '</button>' +
            '<button class="im-tool-btn" id="imPickImage" title="' + imT('im.shell.pickImage', '发送图片') + '">' + ICON_IMAGE + '</button>' +
            '<input type="file" id="imImageFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden>' +
            '<button class="im-tool-btn" id="imPickFile" title="' + imT('im.shell.pickFile', '发送文件') + '">' + ICON_FILE + '</button>' +
            '<input type="file" id="imFileInput" hidden>' +
          '</div>' +
          '<div class="im-emoji-panel" id="imEmojiPanel"></div>' +
          '<div class="im-input im-input-editor" id="imInput" contenteditable="true"></div>' +
          '<div class="im-input-actions">' +
            '<button class="btn btn-column2" id="imSend">' + imT('im.shell.send', '发送') + '</button>' +
          '</div>' +
        '</div>' +
        // 新朋友：好友申请页，覆盖整个聊天区，点顶栏返回箭头退出
        '<div class="im-friends-page" id="imFriendsPage">' +
          '<div class="im-friends-body" id="imFriendsBody"></div>' +
        '</div>' +
        // 联系人资料卡：联系人模式下覆盖聊天区，展示选中好友的完整资料
        '<div class="im-profile-page" id="imContactProfile">' +
          '<div class="im-profile-head">' +
            '<button class="icon-btn" id="imProfileBack" title="' + imT('im.common.back', '返回') + '">' + ICON_BACK + '</button>' +
            '<span class="im-page-title">' + imT('im.contacts.profileTitle', '联系人资料') + '</span>' +
          '</div>' +
          '<div class="im-profile-inner" id="imProfileInner"></div>' +
        '</div>' +
        // 群作业：列表 / 详情覆盖页（群聊设置中进入）
        '<div class="im-work-page" id="imWorkPage">' +
          '<div class="im-work-head">' +
            '<button class="icon-btn" id="imWorkBack" title="' + imT('im.common.back', '返回') + '">' + ICON_BACK + '</button>' +
            '<span class="im-work-head-title" id="imWorkHeadTitle"></span>' +
            '<button class="im-chip-btn im-work-assign" id="imWorkAssign">' + ICON_PLUS +
              '<span>' + imT('im.work.assign', '布置作业') + '</span></button>' +
          '</div>' +
          '<div class="im-work-body" id="imWorkBody"></div>' +
        '</div>' +
        // 群相册：列表 / 详情覆盖页（群聊设置中进入）
        '<div class="im-work-page im-albums-page" id="imAlbumsPage">' +
          '<div class="im-work-head">' +
            '<button class="icon-btn" id="imAlbumsBack" title="' + imT('im.common.back', '返回') + '">' + ICON_BACK + '</button>' +
            '<span class="im-work-head-title" id="imAlbumsHeadTitle"></span>' +
            '<button class="icon-btn im-album-refresh" id="imAlbumsRefresh" title="' + imT('im.album.refresh', '刷新') + '">' + ICON_REFRESH + '</button>' +
            '<button class="im-chip-btn im-album-select" id="imAlbumsSelect"></button>' +
            '<button class="im-chip-btn im-work-assign" id="imAlbumsAction"></button>' +
          '</div>' +
          '<div class="im-album-subbar" id="imAlbumsSub"></div>' +
          '<div class="im-work-body" id="imAlbumsBody"></div>' +
          '<div class="im-album-batch" id="imAlbumsBatch">' +
            '<button class="im-album-batch-btn" id="imAlbumsSelectAll">' + imT('im.album.selectAll', '全选') + '</button>' +
            '<button class="im-album-batch-btn" id="imAlbumsDownload">' + imT('im.album.batchDownload', '批量下载') + '</button>' +
            '<button class="im-album-batch-btn" id="imAlbumsDelete">' + imT('im.album.batchDelete', '批量删除') + '</button>' +
            '<button class="im-album-batch-btn" id="imAlbumsExitSelect">' + imT('im.common.cancel', '取消') + '</button>' +
          '</div>' +
          '<input type="file" id="imAlbumFile" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>' +
        '</div>' +
        // 聊天设置：右侧抽屉，默认收起，点击顶栏「更多」后自右向左展开
        '<div class="im-settings" id="imSettings"></div>' +
      '</section>';

    main.appendChild(topbar);
    main.appendChild(body);
    root.appendChild(rail);
    root.appendChild(main);

    // 缓存 DOM
    dom.convList = $('#imConvList');
    dom.history = $('#imHistory');
    dom.chatEmpty = $('#imChatEmpty');
    dom.chatTitle = $('#imChatTitle');
    dom.quoteBar = $('#imQuoteBar');
    dom.quoteText = $('#imQuoteText');
    dom.input = $('#imInput');
    dom.send = $('#imSend');
    dom.pickImage = $('#imPickImage');
    dom.pickEmoji = $('#imPickEmoji');
    dom.emojiPanel = $('#imEmojiPanel');
    dom.imageFile = $('#imImageFile');
    dom.pickFile = $('#imPickFile');
    dom.fileInput = $('#imFileInput');
    dom.back = $('#imBack');
    dom.more = $('#imMore');
    dom.chatPane = $('#imChatPane');
    dom.settings = $('#imSettings');
    dom.friendsPage = $('#imFriendsPage');
    dom.friendsBody = $('#imFriendsBody');
    dom.workPage = $('#imWorkPage');
    dom.workBody = $('#imWorkBody');
    dom.workHeadTitle = $('#imWorkHeadTitle');
    dom.workAssign = $('#imWorkAssign');
    dom.workBack = $('#imWorkBack');
    dom.albumsPage = $('#imAlbumsPage');
    dom.albumsBody = $('#imAlbumsBody');
    dom.albumsHeadTitle = $('#imAlbumsHeadTitle');
    dom.albumsAction = $('#imAlbumsAction');
    dom.albumsBack = $('#imAlbumsBack');
    dom.albumFileInput = $('#imAlbumFile');
    dom.albumsRefresh = $('#imAlbumsRefresh');
    dom.albumsSelect = $('#imAlbumsSelect');
    dom.albumsSub = $('#imAlbumsSub');
    dom.albumsBatch = $('#imAlbumsBatch');
    dom.searchInput = $('#imConvSearchInput');
    dom.searchClear = $('#imConvSearchClear');
    dom.newBtn = $('#imNew');
    dom.newMenu = $('#imNewMenu');
    dom.modeTabs = document.querySelectorAll('.im-rail-tab');
    dom.modeTitle = $('#imConvModeTitle');
    dom.convView = $('#imConvView');
    dom.contactsPane = $('#imContactsPane');
    dom.contactsList = $('#imContactsList');
    dom.contactsTabs = $('#imContactsTabs');
    dom.contactsSearch = $('#imContactsSearchInput');
    dom.contactsSearchClear = $('#imContactsSearchClear');
    dom.contactsNewDot = $('#imContactsNewDot');
    dom.profilePage = $('#imContactProfile');
    dom.profileInner = $('#imProfileInner');
    dom.profileBack = $('#imProfileBack');

    bindEvents();
  }

  /**
   * 绑定骨架内的交互事件
   */
  function bindEvents() {
    // 返回会话列表（移动端）；设置视图下先返回聊天
    dom.back.addEventListener('click', function () {
      if (state.mode === 'contacts') {                        // 联系人模式：先关资料页，再回消息
        if (window.innerWidth <= 768 && state.mobileMsgOpen) {
          state.mobileMsgOpen = false;
          document.body.classList.remove('im-msg-open');
          return;
        }
        switchMode('chat');
        return;
      }
      if (state.friendsOpen) { closeFriendsPage(); return; }    // 新朋友页：先返回聊天
      if (state.settingsOpen) { closeSettings(); return; }
      state.mobileMsgOpen = false;
      state.activeId = null;
      document.body.classList.remove('im-msg-open');
      dom.chatTitle.textContent = imT('im.common.conversation', '会话');
      dom.history.innerHTML = '';
      dom.chatEmpty.style.display = 'flex';
      dom.quoteBar.classList.remove('show');
      clearEditor();
      renderConvList();
      stopMsgPoll();
      loadConvs();
    });

    // 顶栏「更多」：打开 / 关闭聊天设置页
    dom.more.addEventListener('click', toggleSettings);

    // 会话搜索：放大镜展开 / 收起搜索框
    dom.searchInput.addEventListener('input', function () {
      state.searchQuery = dom.searchInput.value.trim();         // 当前关键词
      dom.searchClear.classList.toggle('show', !!state.searchQuery);
      clearTimeout(state.searchTimer);
      if (!state.searchQuery) {
        state.searchResults = null;
        renderConvList();
        return;
      }
      state.searchResults = null;                               // 先显示搜索中
      renderConvList();
      state.searchTimer = setTimeout(runSearch, 250);            // 防抖后再请求
    });
    dom.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); }   // ESC 清空搜索
    });
    dom.searchClear.addEventListener('click', function () {
      clearSearch();
      dom.searchInput.focus();
    });

    // 新建会话：点「+」展开菜单，选单聊或群聊
    dom.newBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      dom.newMenu.classList.toggle('show');
    });
    dom.newMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');                 // 被点的菜单项
      if (!btn) return;
      dom.newMenu.classList.remove('show');
      var act = btn.getAttribute('data-act');
      openModal(act);
    });
    document.addEventListener('click', function () {
      if (dom.newMenu) dom.newMenu.classList.remove('show');     // 点空白处收起菜单
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dom.newMenu) dom.newMenu.classList.remove('show');
    });

    // 最外层侧边栏：消息 / 联系人 / 空间 / 频道
    Array.prototype.forEach.call(dom.modeTabs, function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-mode');          // 目标栏目
        if (mode === 'space' || mode === 'channel') {
          window.showToast(mode === 'space'
            ? imT('im.contacts.spaceTodo', '空间暂未开放')
            : imT('im.contacts.channelTodo', '频道暂未开放'), 'info');
          return;
        }
        switchMode(mode);
      });
    });

    // 联系人搜索：本地即时过滤（按备注 / 昵称 / 账号）
    dom.contactsSearch.addEventListener('input', function () {
      state.contactQuery = dom.contactsSearch.value.trim();      // 当前关键词
      dom.contactsSearchClear.classList.toggle('show', !!state.contactQuery);
      renderContacts();
    });
    dom.contactsSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); clearContactSearch(); }
    });
    dom.contactsSearchClear.addEventListener('click', function () {
      clearContactSearch();
      dom.contactsSearch.focus();
    });

    // 联系人快捷入口
    $('#imContactAdd').addEventListener('click', function () {
      switchMode('chat');
      openModal('c2c');
    });
    $('#imContactNewChat').addEventListener('click', function () {
      switchMode('chat');
      openModal('group');
    });
    $('#imContactNewGroup').addEventListener('click', function () {
      openGroupNameModal(null);
    });

    // 联系人底部 tab：好友 / 群聊 / 新朋友（新朋友直接跳转申请页）
    dom.contactsTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tab]');                 // 被点的 tab
      if (!btn) return;
      var tab = btn.getAttribute('data-tab');
      if (tab === 'new') {
        highlightContactsTab('new');                            // 保持联系人模式，左侧人形图标高亮
        openFriendsPage();
        return;
      }
      state.contactTab = tab;
      highlightContactsTab(tab);
      renderContacts();
    });

    // 联系人资料页：移动端返回联系人列表
    dom.profileBack.addEventListener('click', function () {
      state.mobileMsgOpen = false;
      document.body.classList.remove('im-msg-open');
    });

    // 发送
    dom.send.addEventListener('click', sendMessage);

    // 表情：打开/收起表情面板，选中的表情插入输入区与文字混排
    dom.pickEmoji.addEventListener('click', function () { toggleEmojiPanel(); });
    document.addEventListener('click', function (e) {
      if (!dom.emojiPanel.classList.contains('show')) return;
      if (dom.emojiPanel.contains(e.target) || dom.pickEmoji.contains(e.target)) return;
      dom.emojiPanel.classList.remove('show');                  // 点面板外收起
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') dom.emojiPanel.classList.remove('show');
    });

    // 群作业页：返回（详情→列表，列表→聊天）/ 布置作业
    dom.workBack.addEventListener('click', function () {
      if (state.workDetail) {
        state.workDetail = null;
        dom.workHeadTitle.textContent = imT('im.work.title', '群作业');
        renderWorkList();
        loadWorkList();
      } else {
        closeWorkPage();
      }
    });
    dom.workAssign.addEventListener('click', function () { openAssignModal(); });

    // 群相册页：详情 → 列表 → 关闭；右上按钮 = 新建相册（列表）/ 上传照片（详情）
    dom.albumsBack.addEventListener('click', function () {
      if (state.albumDetail) {
        state.albumDetail = null;
        openAlbumsList();
        return;
      }
      closeAlbumsPage();
    });
    dom.albumsAction.addEventListener('click', function () {
      if (state.albumDetail) { dom.albumFileInput.click(); return; }   // 详情页：上传照片
      openAlbumNameModal();                                            // 列表页：新建相册
    });
    dom.albumFileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(dom.albumFileInput.files || []);  // 用户选中的照片
      dom.albumFileInput.value = '';                                   // 清空，便于重复选择
      uploadAlbumPhotos(files);
    });
    // 刷新当前视图（列表 / 相册详情）
    dom.albumsRefresh.addEventListener('click', function () {
      if (state.albumDetail) {
        openAlbumDetail(state.albumDetail.id);
      } else {
        loadAlbumsList();
      }
    });
    // 进入 / 退出多选模式
    dom.albumsSelect.addEventListener('click', function () { toggleAlbumSelect(); });
    $('#imAlbumsExitSelect').addEventListener('click', function () { exitAlbumSelect(); });
    $('#imAlbumsSelectAll').addEventListener('click', function () { toggleAlbumSelectAll(); });
    $('#imAlbumsDownload').addEventListener('click', function () { downloadSelectedPhotos(); });
    $('#imAlbumsDelete').addEventListener('click', function () { deleteSelectedPhotos(); });
    // 点击页面其他区域时收起相册卡片的操作菜单
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.im-album-menu, .im-album-menu-btn')) return;
      closeAlbumMenus();
    });

    // 图片：点击工具按钮选图，选完插入输入区（不直接发送）
    dom.pickImage.addEventListener('click', function () { dom.imageFile.click(); });
    dom.imageFile.addEventListener('change', function () {
      var file = dom.imageFile.files && dom.imageFile.files[0];             // 用户选中的图片
      dom.imageFile.value = '';                                             // 清空，便于重复选择同一张
      if (file) pickImage(file);
    });

    // 文件：点击工具按钮选文件，选完直接发送
    dom.pickFile.addEventListener('click', function () { dom.fileInput.click(); });
    dom.fileInput.addEventListener('change', function () {
      var file = dom.fileInput.files && dom.fileInput.files[0];             // 用户选中的文件
      dom.fileInput.value = '';                                             // 清空，便于重复选择同一文件
      if (file) sendFile(file);
    });

    // Ctrl+Enter 发送；单独 Enter 换行
    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    // 取消引用
    $('#imQuoteClose').addEventListener('click', clearQuote);

    // 点击空白处关闭右键菜单
    document.addEventListener('click', function () { hideCtx(); });

    // 移动端尺寸变化：回到桌面宽度时强制显示双栏
    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) document.body.classList.remove('im-msg-open');
    });
  }

  /**
   * 读取文件为 dataUrl
   * @param {File} file 用户选择的图片文件
   * @returns {Promise<string>} dataUrl 字符串
   */
  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();                                        // 浏览器文件读取器
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error(imT('im.chat.toastReadImageFailed', '读取图片失败'))); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 选择图片后插入输入区（缩略图与文字混排，点击发送时才真正上传）
   * @param {File} file 用户选择的图片文件
   */
  async function pickImage(file) {
    if (!state.activeId) { window.showToast(imT('im.chat.toastNeedConversation', '请先选择一个会话'), 'warning'); return; }

    var allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];   // 支持的图片类型
    if (allowed.indexOf(file.type) < 0) { window.showToast(imT('im.chat.toastImageOnly', '仅支持 PNG/JPG/WebP/GIF 图片'), 'warning'); return; }
    if (file.size > 5 * 1024 * 1024) { window.showToast(imT('im.chat.toastImageTooLarge5', '图片不能超过 5MB'), 'warning'); return; }

    try {
      var dataUrl = await readAsDataUrl(file);                              // 图片转为 dataUrl 预览
      insertImageIntoEditor(dataUrl);
    } catch (e) {
      window.showToast(e.message || imT('im.chat.toastReadImageFailed', '读取图片失败'), 'error');
    }
  }

  /**
   * 打开 / 收起表情面板；首次打开时拉取表情列表
   * @returns {Promise<void>}
   */
  async function toggleEmojiPanel() {
    if (!state.activeId) {
      window.showToast(imT('im.chat.toastNeedConversation', '请先选择一个会话'), 'warning');
      return;
    }
    if (dom.emojiPanel.classList.contains('show')) {
      dom.emojiPanel.classList.remove('show');
      return;
    }
    dom.newMenu.classList.remove('show');                       // 与「+」菜单互斥
    dom.emojiPanel.classList.add('show');

    if (state.emojiCodes) { renderEmojiGrid(); return; }
    dom.emojiPanel.innerHTML = '<div class="im-emoji-loading">' +
      imT('im.emoji.loading', '加载中…') + '</div>';
    try {
      state.emojiCodes = await api('/emojis');                  // 表情编码列表
    } catch (e) {
      state.emojiCodes = [];
    }
    renderEmojiGrid();
  }

  /**
   * 渲染表情面板网格（懒加载图片，避免一次性请求几百张 APNG）
   */
  function renderEmojiGrid() {
    var codes = state.emojiCodes || [];                         // 表情编码
    if (!codes.length) {
      dom.emojiPanel.innerHTML = '<div class="im-emoji-loading">' +
        imT('im.emoji.empty', '暂无表情') + '</div>';
      return;
    }
    dom.emojiPanel.innerHTML = '';
    // 分类标签：当前这批 APNG 表情统一归入「超级表情」
    var cats = document.createElement('div');
    cats.className = 'im-emoji-cats';
    var tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'im-emoji-cat active';
    tab.textContent = imT('im.emoji.super', '超级表情');
    cats.appendChild(tab);
    dom.emojiPanel.appendChild(cats);

    var grid = document.createElement('div');                   // 表情网格
    grid.className = 'im-emoji-grid';
    codes.forEach(function (code) {
      var btn = document.createElement('button');               // 单个表情按钮
      btn.type = 'button';
      btn.className = 'im-emoji-item';
      btn.title = code;
      var img = document.createElement('img');                  // 表情缩略图（APNG）
      img.src = '/im/emoji/' + code + '.png';
      img.alt = code;
      img.loading = 'lazy';
      img.decoding = 'async';
      btn.appendChild(img);
      btn.addEventListener('click', function () {
        // 选中表情后保持面板打开，方便连续插入多个表情
        insertEmojiIntoEditor(code);
      });
      grid.appendChild(btn);
    });
    dom.emojiPanel.appendChild(grid);
  }

  /**
   * 把表情插入输入区光标处（与文字同行混排）
   * @param {string} code 表情编码（文件名去掉 .png）
   */
  function insertEmojiIntoEditor(code) {
    var img = document.createElement('img');                    // 输入区内的表情
    img.className = 'im-input-emoji';
    img.src = '/im/emoji/' + code + '.png';
    img.setAttribute('data-emoji', code);
    img.title = imT('im.emoji.removeTip', '点击移除该表情');
    img.addEventListener('click', function () { img.remove(); });
    insertEditorNode(img, false);
  }

  /**
   * 把图片缩略图插入输入区光标处
   * @param {string} dataUrl 图片 dataUrl
   */
  function insertImageIntoEditor(dataUrl) {
    var img = document.createElement('img');                                // 输入区内的图片预览
    img.className = 'im-input-img';
    img.src = dataUrl;
    img.title = imT('im.chat.removeImageTip', '点击移除该图片');
    img.addEventListener('click', function () { img.remove(); });
    insertEditorNode(img, true);
  }

  /**
   * 在输入区光标处插入节点
   * @param {Node} node 要插入的节点
   * @param {boolean} withSpace 是否在其后补一个零宽空格作为可编辑位置
   */
  function insertEditorNode(node, withSpace) {
    var space = withSpace ? document.createTextNode('\u200b') : null;  // 零宽空格占位
    dom.input.focus();

    var sel = window.getSelection();                                        // 当前选区
    var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (range && dom.input.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      if (space) range.insertNode(space);
      range.insertNode(node);
      range.setStartAfter(space || node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      dom.input.appendChild(node);
      if (space) dom.input.appendChild(space);
    }
  }

  /**
   * 把输入区内容解析为有序片段（文字 / 图片 / 表情交错）
   * @returns {{parts:Array<object>, hasImage:boolean, hasEmoji:boolean}}
   *          parts 为发送用片段，hasImage 表示是否含待上传图片，hasEmoji 表示是否含表情
   */
  function serializeEditor() {
    var parts = [];                                                          // 有序片段
    var buf = '';                                                            // 待提交的文字缓冲
    var hasImage = false;                                                    // 是否包含待上传图片
    var hasEmoji = false;                                                    // 是否包含表情

    /**
     * 递归遍历子节点，把 DOM 转成文字 / 图片 / 表情片段
     * @param {Node} node 当前节点
     */
    function walk(node) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) { buf += child.nodeValue; return; }
        if (child.nodeName === 'BR') { buf += '\n'; return; }
        if (child.nodeName === 'IMG') {
          if (buf) { parts.push({ type: 'text', text: buf }); buf = ''; }
          var emojiCode = child.getAttribute('data-emoji');   // 表情图片带 data-emoji
          if (emojiCode) {
            parts.push({ type: 'emoji', code: emojiCode });
            hasEmoji = true;
            return;
          }
          parts.push({ type: 'image', dataUrl: child.getAttribute('src') });
          hasImage = true;
          return;
        }
        if (child.nodeName === 'DIV' || child.nodeName === 'P') {
          walk(child);
          buf += '\n';
          return;
        }
        walk(child);
      });
    }
    walk(dom.input);

    if (buf) parts.push({ type: 'text', text: buf });

    // 去掉首尾空白与空文字片段，避免发出纯空白消息
    if (parts.length && parts[0].type === 'text') parts[0].text = parts[0].text.replace(/^\s+/, '');
    var last = parts[parts.length - 1];
    if (last && last.type === 'text') last.text = last.text.replace(/\s+$/, '');
    parts = parts.filter(function (p) { return p.type !== 'text' || p.text; });

    return { parts: parts, hasImage: hasImage, hasEmoji: hasEmoji };
  }

  /** 清空输入区并复位高度 */
  function clearEditor() {
    dom.input.innerHTML = '';
  }

  /**
   * 文件大小格式化（保留两位小数）
   * @param {number} bytes 字节数
   * @returns {string} 如 122.00 B / 6.39 MB
   */
  function formatSize(bytes) {
    var n = Number(bytes) || 0;                                // 字节数
    if (n < 1024) return n.toFixed(2) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(2) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /**
   * 直接发送文件：读取为 dataUrl → 上传 → 追加到当前会话
   * @param {File} file 用户选择的文件
   */
  async function sendFile(file) {
    if (!state.activeId) {
      window.showToast(imT('im.shell.selectConversation', '请先选择一个会话'), 'warning');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      window.showToast(imT('im.shell.fileTooLarge', '文件不能超过 20MB'), 'warning');
      return;
    }

    var convId = state.activeId;                               // 当前会话 ID
    try {
      var dataUrl = await readAsDataUrl(file);                 // 文件转为 dataUrl
      var msg = await api('/conversations/' + encodeURIComponent(convId) + '/files', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, dataUrl: dataUrl })
      });
      if (state.activeId !== convId) return;                   // 期间切走了会话就不追加
      appendMessage(msg);
      loadConvs();
    } catch (e) {
      window.showToast(e.message || imT('im.shell.sendFileFailed', '文件发送失败'), 'error');
    }
  }

  // ============ 会话列表 ============

  /**
   * 拉取会话列表并渲染
   * @returns {Promise<void>}
   */
  async function loadConvs() {
    try {
      state.convs = await api('/conversations');
    } catch (e) {
      window.showToast(e.message, 'error');
      return;
    }
    renderConvList();
  }

  /** 清空会话搜索关键词并恢复完整列表 */
  function clearSearch() {
    state.searchQuery = '';
    dom.searchInput.value = '';
    dom.searchClear.classList.remove('show');
    renderConvList();
  }

  /**
   * 执行全局搜索：按用户 ID 找用户、按群号找群聊
   * @returns {Promise<void>}
   */
  async function runSearch() {
    var q = state.searchQuery;                                  // 发起请求时的关键词
    if (!q) return;
    try {
      var res = await api('/search?q=' + encodeURIComponent(q));
      if (state.searchQuery !== q) return;                      // 关键词已变化则丢弃旧结果
      state.searchResults = res;
      renderConvList();
    } catch (e) {
      if (state.searchQuery !== q) return;
      state.searchResults = { users: [], groups: [] };
      renderConvList();
      window.showToast(e.message, 'error');
    }
  }

  /**
   * 渲染搜索结果（用户 / 群聊分组，无结果显示空态）
   */
  function renderSearchResults() {
    var res = state.searchResults;                              // 搜索结果
    if (!res) {
      var loading = document.createElement('div');              // 搜索中提示
      loading.className = 'im-conv-empty';
      loading.textContent = imT('im.search.searching', '搜索中…');
      dom.convList.appendChild(loading);
      return;
    }

    if (!res.users.length && !res.groups.length) {
      var empty = document.createElement('div');                // 无结果空态
      empty.className = 'im-search-empty';
      empty.innerHTML = '<div class="im-search-empty-icon">' + ICON_SEARCH + '</div>' +
        '<div class="im-search-empty-text">' + imT('im.search.noResult', '暂无搜索结果') + '</div>';
      dom.convList.appendChild(empty);
      return;
    }

    var q = state.searchQuery;                                  // 分组标题里的关键词

    if (res.users.length) {
      dom.convList.appendChild(makeSearchSection(imT('im.search.users', '{q} - 用户', { q: q })));
      res.users.forEach(function (user) {
        // 已是好友（有单聊）→ 发消息；已发过申请 → 禁用；
        // 对方已申请我 → 去同意；否则 → 加好友
        var actionText = user.hasChat ? imT('im.search.chat', '发消息')
          : user.pending ? imT('im.search.pending', '已申请')
          : user.incoming ? imT('im.search.agree', '去同意')
          : imT('im.search.addFriend', '加好友');
        dom.convList.appendChild(makeSearchRow({
          avatar: makeAvatar(user.name, user.id, 'im-avatar-sm'),
          title: user.name,
          suffix: '(' + user.id + ')',
          sub: '',
          action: actionText,
          disabled: !!user.pending,
          onAction: async function () {
            if (user.incoming) {
              await openFriendsPage();                          // 对方已申请我：直接打开新朋友页处理
              return;
            }
            if (!user.hasChat) {
              // 加好友：发送申请，等对方在「新朋友」中同意
              await api('/friend-requests', { method: 'POST', body: JSON.stringify({ toId: user.id }) });
              window.showToast(imT('im.friends.sent', '好友申请已发送，等待对方同意'), 'success');
              await runSearch();
              return;
            }
            var conv = await api('/conversations', { method: 'POST', body: JSON.stringify({ type: 'c2c', targetId: user.id }) });
            clearSearch();
            await loadConvs();
            selectConv(conv.id);
          }
        }));
      });
    }

    if (res.groups.length) {
      dom.convList.appendChild(makeSearchSection(imT('im.search.groups', '{q} - 群聊', { q: q })));
      res.groups.forEach(function (group) {
        dom.convList.appendChild(makeSearchRow({
          avatar: makeGroupAvatarNode(group.avatar, group.title),
          title: group.title,
          suffix: '(' + group.code + ')',
          sub: imT('im.search.memberCount', '{count} 名成员', { count: group.memberCount }),
          action: group.isMember ? imT('im.search.enter', '进入') : imT('im.search.join', '加入'),
          onAction: async function () {
            if (!group.isMember) await api('/conversations/' + encodeURIComponent(group.id) + '/join', { method: 'POST' });
            clearSearch();
            await loadConvs();
            selectConv(group.id);
          }
        }));
      });
    }
  }

  /**
   * 搜索结果分组标题
   * @param {string} text 标题文字
   * @returns {HTMLElement}
   */
  function makeSearchSection(text) {
    var head = document.createElement('div');
    head.className = 'im-search-sec';
    head.textContent = text;
    return head;
  }

  /**
   * 生成一条搜索结果（头像 + 名称(ID) + 副标题 + 右侧按钮）
   * @param {object} cfg { avatar, title, suffix, sub, action, disabled, onAction }
   * @returns {HTMLElement}
   */
  function makeSearchRow(cfg) {
    var row = document.createElement('div');                    // 结果行
    row.className = 'im-search-row';
    row.appendChild(cfg.avatar);

    var main = document.createElement('div');                   // 中间文本区
    main.className = 'im-search-main';
    var title = document.createElement('div');
    title.className = 'im-search-title';
    title.textContent = cfg.title;
    var suffix = document.createElement('span');                // 蓝色 ID / 群号
    suffix.className = 'im-search-id';
    suffix.textContent = cfg.suffix;
    title.appendChild(suffix);
    main.appendChild(title);
    if (cfg.sub) {
      var sub = document.createElement('div');
      sub.className = 'im-search-sub';
      sub.textContent = cfg.sub;
      main.appendChild(sub);
    }
    row.appendChild(main);

    var btn = document.createElement('button');                 // 右侧操作按钮
    btn.className = 'im-search-btn';
    btn.textContent = cfg.action;
    if (cfg.disabled) btn.disabled = true;                      // 已申请等不可重复操作的场景
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      try {
        await cfg.onAction();
      } catch (e) {
        window.showToast(e.message, 'error');
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
    return row;
  }

  /**
   * 生成群头像节点（有图用图，无图用人群图标）
   * @param {string|null} src 头像地址
   * @param {string} title 群名称（用于 alt）
   * @returns {HTMLElement}
   */
  function makeGroupAvatarNode(src, title) {
    var box = document.createElement('div');
    box.className = 'im-avatar im-avatar-sm' + (src ? '' : ' im-avatar-group');
    if (src) {
      var img = document.createElement('img');
      img.src = src;
      img.alt = title;
      box.appendChild(img);
    } else {
      box.innerHTML = ICON_GROUP;
    }
    return box;
  }

  // ============ 新朋友（好友申请） ============

  /**
   * 打开「新朋友」页：展示收到 / 发出的好友申请，对方同意后才建立单聊
   * @returns {Promise<void>}
   */
  async function openFriendsPage() {
    if (state.settingsOpen) closeSettings();                    // 先关掉聊天设置抽屉
    if (state.searchQuery) {                                    // 清空搜索，恢复左侧完整会话列表
      state.searchQuery = '';
      state.searchResults = null;
      dom.searchInput.value = '';
      dom.searchClear.classList.remove('show');
      renderConvList();
    }
    state.friendsOpen = true;
    state.friendsData = null;
    dom.chatTitle.textContent = imT('im.friends.title', '新朋友');
    dom.friendsPage.classList.add('show');
    // 移动端：切到右侧内容区
    if (window.innerWidth <= 768) {
      state.mobileMsgOpen = true;
      document.body.classList.add('im-msg-open');
    }
    dom.friendsBody.innerHTML = '<div class="im-friends-empty">' +
      imT('im.friends.loading', '加载中…') + '</div>';
    await loadFriends();
  }

  /**
   * 关闭「新朋友」页：恢复到之前的聊天会话或空态
   */
  function closeFriendsPage() {
    state.friendsOpen = false;
    state.friendsData = null;
    dom.friendsPage.classList.remove('show');
    var conv = state.convs.find(function (c) { return c.id === state.activeId; });
    // 移动端且没有打开任何会话时，返回会话列表而不是空白聊天区
    if (!conv && window.innerWidth <= 768) {
      state.mobileMsgOpen = false;
      document.body.classList.remove('im-msg-open');
    }
    dom.chatTitle.textContent = conv
      ? convLabel(conv)
      : imT('im.common.conversation', '会话');
    highlightContactsTab(state.contactTab || 'friends');       // 底部 tab 高亮从「新朋友」恢复
  }

  /**
   * 仅切换联系人页底部 tab 的高亮样式（不触发列表渲染）
   * @param {string} tab 目标 tab：friends / groups / new
   */
  function highlightContactsTab(tab) {
    if (!dom.contactsTabs) return;
    Array.prototype.forEach.call(dom.contactsTabs.querySelectorAll('[data-tab]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
  }

  /**
   * 拉取好友申请列表并渲染
   * @returns {Promise<void>}
   */
  async function loadFriends() {
    try {
      var data = await api('/friend-requests');
      if (!state.friendsOpen) return;                           // 请求期间已关闭页面则丢弃
      state.friendsData = data;
    } catch (e) {
      if (!state.friendsOpen) return;
      dom.friendsBody.innerHTML = '<div class="im-friends-empty">' + esc(e.message) + '</div>';
      return;
    }
    renderFriends();
  }

  /**
   * 渲染好友申请列表（收到的申请 + 我发出的申请）
   */
  function renderFriends() {
    var data = state.friendsData || { incoming: [], outgoing: [] };
    dom.friendsBody.innerHTML = '';

    var incoming = data.incoming || [];                         // 别人申请加我
    var outgoing = data.outgoing || [];                         // 我发出的申请

    if (!incoming.length && !outgoing.length) {
      dom.friendsBody.innerHTML = '<div class="im-friends-empty">' +
        imT('im.friends.empty', '暂无好友申请') + '</div>';
      return;
    }

    if (incoming.length) {
      dom.friendsBody.appendChild(makeFriendsSection(imT('im.friends.incomingSection', '收到的申请')));
      incoming.forEach(function (item) {
        dom.friendsBody.appendChild(makeFriendRow(item, 'incoming'));
      });
    }
    if (outgoing.length) {
      dom.friendsBody.appendChild(makeFriendsSection(imT('im.friends.outgoingSection', '我发出的申请')));
      outgoing.forEach(function (item) {
        dom.friendsBody.appendChild(makeFriendRow(item, 'outgoing'));
      });
    }
  }

  /**
   * 好友申请分组标题
   * @param {string} text 标题文字
   * @returns {HTMLElement}
   */
  function makeFriendsSection(text) {
    var head = document.createElement('div');
    head.className = 'im-friends-sec';
    head.textContent = text;
    return head;
  }

  /**
   * 生成一条好友申请记录
   * @param {object} item 申请数据 { id, userId, name, message, status, time }
   * @param {'incoming'|'outgoing'} dir 方向：收到 / 发出
   * @returns {HTMLElement}
   */
  function makeFriendRow(item, dir) {
    var row = document.createElement('div');                    // 申请行
    row.className = 'im-friend-row';
    row.appendChild(makeAvatar(item.name, item.userId, 'im-avatar-sm'));

    var main = document.createElement('div');                   // 中间文本区
    main.className = 'im-friend-main';
    var name = document.createElement('div');
    name.className = 'im-friend-name';
    name.textContent = item.name || item.userId;
    var uid = document.createElement('span');                   // 蓝色用户 ID
    uid.className = 'im-friend-id';
    uid.textContent = ' (' + item.userId + ')';
    name.appendChild(uid);
    main.appendChild(name);

    var sub = document.createElement('div');                    // 附言 / 状态说明
    sub.className = 'im-friend-sub';
    sub.textContent = item.message || imT('im.friends.requestSub', '请求添加你为好友');
    main.appendChild(sub);
    row.appendChild(main);

    // 右侧：收到且待处理 → 同意 / 拒绝；其余展示状态文字
    if (dir === 'incoming' && item.status === 'pending') {
      var actions = document.createElement('div');              // 操作按钮组
      actions.className = 'im-friend-actions';

      var agreeBtn = document.createElement('button');          // 同意按钮
      agreeBtn.className = 'im-friend-btn primary';
      agreeBtn.textContent = imT('im.friends.accept', '同意');
      agreeBtn.addEventListener('click', async function () {
        agreeBtn.disabled = true;
        try {
          var conv = await api('/friend-requests/' + encodeURIComponent(item.id) + '/accept', { method: 'POST' });
          window.showToast(imT('im.friends.acceptedToast', '已添加为好友'), 'success');
          state.friendsOpen = false;
          dom.friendsPage.classList.remove('show');
          await loadConvs();
          selectConv(conv.id);                                 // 同意后直接进入单聊
        } catch (e) {
          window.showToast(e.message, 'error');
          agreeBtn.disabled = false;
        }
      });

      var rejectBtn = document.createElement('button');         // 拒绝按钮
      rejectBtn.className = 'im-friend-btn';
      rejectBtn.textContent = imT('im.friends.reject', '拒绝');
      rejectBtn.addEventListener('click', async function () {
        rejectBtn.disabled = true;
        try {
          await api('/friend-requests/' + encodeURIComponent(item.id) + '/reject', { method: 'POST' });
          window.showToast(imT('im.friends.rejectedToast', '已拒绝该申请'), 'success');
          await loadFriends();
        } catch (e) {
          window.showToast(e.message, 'error');
          rejectBtn.disabled = false;
        }
      });

      actions.appendChild(agreeBtn);
      actions.appendChild(rejectBtn);
      row.appendChild(actions);
    } else {
      var stateText = document.createElement('span');           // 已处理状态
      stateText.className = 'im-friend-state';
      if (dir === 'incoming') {
        stateText.textContent = item.status === 'accepted'
          ? imT('im.friends.accepted', '已同意')
          : imT('im.friends.rejected', '已拒绝');
      } else {
        stateText.textContent = item.status === 'accepted'
          ? imT('im.friends.peerAccepted', '对方已同意')
          : item.status === 'rejected'
            ? imT('im.friends.peerRejected', '对方已拒绝')
            : imT('im.friends.waiting', '等待对方同意');
      }
      row.appendChild(stateText);
    }

    return row;
  }

  /**
   * 渲染左侧会话列表
   */
  function renderConvList() {
    dom.convList.innerHTML = '';
    if (state.searchQuery) { renderSearchResults(); return; }   // 有关键词时展示搜索结果
    var list = state.convs;                                     // 全部会话
    if (!list.length) {
      var empty = document.createElement('div');              // 空态提示
      empty.className = 'im-conv-empty';
      empty.textContent = imT('im.list.emptyNone', '还没有会话，点右上角「＋」发起单聊');
      dom.convList.appendChild(empty);
      return;
    }

    list.forEach(function (conv) {
      var item = document.createElement('div');                 // 单个会话条目
      item.className = 'im-conv-item' + (conv.id === state.activeId ? ' active' : '');
      item.dataset.id = conv.id;

      // 头像：单聊用对方头像，群聊用人群图标
      var avatarBox;
      if (conv.type === 'c2c') {
        var peer = (conv.members || []).find(function (m) { return m.id !== state.me.id; });
        avatarBox = makeAvatar(peer ? peer.name : conv.title, peer ? peer.id : null, 'im-avatar-sm');
      } else {
        // 群聊：已设置群头像时显示图片，否则回退人群图标
        avatarBox = document.createElement('div');
        avatarBox.className = 'im-avatar im-avatar-sm' + (conv.avatar ? '' : ' im-avatar-group');
        if (conv.avatar) {
          var groupImg = document.createElement('img');                  // 群头像图片
          groupImg.src = conv.avatar;
          groupImg.alt = convLabel(conv);
          avatarBox.appendChild(groupImg);
        } else {
          avatarBox.innerHTML = ICON_GROUP;
        }
      }

      // 最后一条消息预览
      var last = conv.lastMessage;                              // 最后一条可见消息
      var desc = imT('im.list.noMessages', '暂无消息');                                     // 预览文本
      var lastTime = conv.createdAt;                             // 列表右侧时间
      if (last) {
        lastTime = last.time;
        if (last.recalled) {
          // 撤回提示：兼容「本人撤回」与「管理身份撤回成员消息」两种文案（列表用短文案）
          desc = recallTextFor(last, conv, true);
        } else {
          var prefix = last.senderId === state.me.id
            ? imT('im.list.selfPrefix', '我：')
            : (conv.type === 'group'
                ? imT('im.list.senderPrefix', '{name}：', { name: senderNameFor(conv, last.senderId, last.senderName, last.senderNick) })
                : '');
          desc = prefix + String(last.text || '').replace(/\n/g, ' ');
        }
      }

      var mainBox = document.createElement('div');             // 右侧文本区
      mainBox.className = 'im-conv-main';

      // 置顶 / 免打扰（屏蔽）标记：与截图一致，只做小图标提示
      var flags = '';                                          // 标记图标拼接串
      if (conv.prefs && conv.prefs.pinned) {
        flags += '<span class="im-conv-flag" title="' + imT('im.list.pinned', '已置顶') + '">' + ICON_PIN + '</span>';
      }
      if (conv.prefs && (conv.prefs.muted || conv.prefs.blocked)) {
        flags += '<span class="im-conv-flag" title="' + (conv.prefs.blocked
          ? imT('im.list.blocked', '已屏蔽此人')
          : imT('im.list.muted', '消息免打扰')) + '">' + ICON_MUTE + '</span>';
      }

      mainBox.innerHTML =
        '<div class="im-conv-row">' +
          '<span class="im-conv-name">' + esc(convLabel(conv)) + '</span>' +
          (flags ? '<span class="im-conv-tags">' + flags + '</span>' : '') +
          '<span class="im-conv-time">' + convTimeLabel(lastTime) + '</span>' +
        '</div>' +
        '<div class="im-conv-row">' +
          '<span class="im-conv-desc">' + esc(desc).substring(0, 80) + '</span>' +
          (conv.unread > 0 ? '<span class="im-unread">' + (conv.unread > 99 ? '99+' : conv.unread) + '</span>' : '') +
        '</div>';

      item.appendChild(avatarBox);
      item.appendChild(mainBox);
      item.addEventListener('click', function () { selectConv(conv.id); });
      dom.convList.appendChild(item);
    });
  }

  // ============ 联系人 ============

  /** 悬浮资料卡的隐藏延迟定时器 */
  var contactHoverTimer = null;

  /**
   * 切换左栏模式：消息 / 联系人
   * @param {'chat'|'contacts'} mode 目标模式
   */
  function switchMode(mode) {
    state.mode = mode === 'contacts' ? 'contacts' : 'chat';
    var isContacts = state.mode === 'contacts';                // 是否联系人模式
    document.body.classList.toggle('im-contacts-mode', isContacts);
    Array.prototype.forEach.call(dom.modeTabs, function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === state.mode);
    });
    dom.convView.style.display = isContacts ? 'none' : '';
    dom.contactsPane.style.display = isContacts ? 'flex' : 'none';

    if (isContacts) {
      dom.chatTitle.textContent = imT('im.contacts.title', '联系人');
      if (dom.modeTitle) dom.modeTitle.textContent = imT('im.contacts.title', '联系人');
      dom.profilePage.classList.add('show');                   // 右侧资料区（未选中时为空态）
      if (!state.contactId) {
        dom.profileInner.innerHTML = '<div class="im-profile-empty">' +
          imT('im.contacts.pickHint', '选择联系人查看资料') + '</div>';
      }
      if (window.innerWidth <= 768) {                           // 移动端先展示联系人列表
        state.mobileMsgOpen = false;
        document.body.classList.remove('im-msg-open');
      }
      loadContacts();
      return;
    }

    dom.profilePage.classList.remove('show');
    hideContactHover();
    closeContactMenu();
    if (dom.modeTitle) dom.modeTitle.textContent = imT('im.shell.listTitle', '消息');
    var conv = state.convs.find(function (c) { return c.id === state.activeId; });
    dom.chatTitle.textContent = conv ? convLabel(conv) : imT('im.common.conversation', '会话');
    if (window.innerWidth <= 768) {
      state.mobileMsgOpen = false;
      document.body.classList.remove('im-msg-open');
    }
  }

  /**
   * 拉取联系人数据并渲染
   * @returns {Promise<void>}
   */
  async function loadContacts() {
    try {
      state.contacts = await api('/contacts');
    } catch (e) {
      window.showToast(e.message, 'error');
      state.contacts = { groups: [], friends: [], pendingCount: 0 };
    }
    updateContactsDot();
    renderContacts();
  }

  /** 清空联系人搜索关键词并恢复完整分组 */
  function clearContactSearch() {
    state.contactQuery = '';
    dom.contactsSearch.value = '';
    dom.contactsSearchClear.classList.remove('show');
    renderContacts();
  }

  /** 更新「新朋友」tab 的红点（有待处理申请时显示） */
  function updateContactsDot() {
    var count = (state.contacts && state.contacts.pendingCount) || 0;   // 待处理好友申请数
    if (dom.contactsNewDot) dom.contactsNewDot.classList.toggle('show', count > 0);
  }

  /**
   * 判断联系人是否命中搜索关键词
   * @param {object} friend 联系人
   * @param {string} q 小写关键词
   * @returns {boolean}
   */
  function contactMatches(friend, q) {
    if (!q) return true;
    return String(friend.remark || '').toLowerCase().includes(q) ||
      String(friend.name || '').toLowerCase().includes(q) ||
      String(friend.id || '').toLowerCase().includes(q);
  }

  /**
   * 渲染联系人列表（好友分组树 / 群聊列表 / 搜索结果）
   */
  function renderContacts() {
    if (!dom.contactsList) return;
    var data = state.contacts || { groups: [], friends: [] };
    var q = state.contactQuery.toLowerCase();                  // 搜索关键词（小写）
    var friends = (data.friends || []).filter(function (f) { return contactMatches(f, q); });

    dom.contactsList.innerHTML = '';
    updateContactsDot();

    if (state.contactTab === 'groups') { renderContactGroupChats(); return; }

    if (!friends.length) {
      var empty = document.createElement('div');               // 空态提示
      empty.className = 'im-conv-empty';
      empty.textContent = q
        ? imT('im.contacts.noResult', '没有找到匹配的联系人')
        : imT('im.contacts.empty', '还没有好友，点上方「添加好友」发起申请');
      dom.contactsList.appendChild(empty);
      return;
    }

    // 搜索状态：平铺展示结果，不显示分组
    if (q) {
      friends.forEach(function (f) { dom.contactsList.appendChild(makeContactRow(f)); });
      return;
    }

    (data.groups || []).forEach(function (group) {
      var items = friends.filter(function (f) { return f.groupId === group.id; });
      dom.contactsList.appendChild(makeContactGroupHead(group));
      if (state.collapsedGroups[group.id] === true) return;    // 折叠时只显示分组头
      items.forEach(function (f) { dom.contactsList.appendChild(makeContactRow(f)); });
    });
  }

  /**
   * 生成联系人分组头（箭头 + 名称 + 人数 + 操作按钮）
   * @param {{id:string,name:string,count:number}} group 分组
   * @returns {HTMLElement}
   */
  function makeContactGroupHead(group) {
    var collapsed = state.collapsedGroups[group.id] === true;  // 是否折叠
    var head = document.createElement('div');
    head.className = 'im-contact-group';
    head.innerHTML =
      '<span class="im-contact-arrow' + (collapsed ? '' : ' open') + '">' + ICON_CHEVRON + '</span>' +
      '<span class="im-contact-group-name">' + esc(group.name) + '</span>' +
      '<span class="im-contact-group-count">' + group.count + '</span>' +
      '<button class="im-contact-group-more" title="' + imT('im.contacts.groupOps', '分组操作') + '">' + ICON_MORE + '</button>';

    head.addEventListener('click', function (e) {
      if (e.target.closest('.im-contact-group-more')) return;  // 操作按钮不触发折叠
      state.collapsedGroups[group.id] = !collapsed;
      renderContacts();
    });
    head.querySelector('.im-contact-group-more').addEventListener('click', function (e) {
      e.stopPropagation();
      openGroupMenu(group, e.clientX, e.clientY);
    });
    return head;
  }

  /**
   * 生成一条联系人（方形头像 + 备注优先 + 原昵称 + 在线状态点）
   * @param {object} friend 联系人数据
   * @returns {HTMLElement}
   */
  function makeContactRow(friend) {
    var row = document.createElement('div');
    row.className = 'im-contact-row' + (friend.id === state.contactId ? ' active' : '');
    row.dataset.id = friend.id;

    var avatar = document.createElement('div');                // 方形头像容器
    avatar.className = 'im-contact-avatar';
    var img = document.createElement('img');                   // 头像图片
    img.alt = friend.displayName || friend.id;
    img.src = friend.avatar || DEFAULT_AVATAR;
    img.onerror = function () { img.onerror = null; img.src = DEFAULT_AVATAR; };
    avatar.appendChild(img);
    var dot = document.createElement('span');                  // 在线状态圆点
    dot.className = 'im-contact-dot ' + (friend.online ? 'on' : 'off');
    dot.title = friend.online ? imT('im.contacts.online', '在线') : imT('im.contacts.offline', '离线');
    avatar.appendChild(dot);
    row.appendChild(avatar);

    var main = document.createElement('div');                  // 名称区
    main.className = 'im-contact-main';
    var name = document.createElement('div');
    name.className = 'im-contact-name';
    name.textContent = friend.displayName || friend.id;
    main.appendChild(name);

    // 有备注时补一行小号原昵称，方便识别
    if (friend.remark && friend.remark !== friend.name) {
      var sub = document.createElement('div');
      sub.className = 'im-contact-sub';
      sub.textContent = friend.name;
      main.appendChild(sub);
    } else if (friend.blocked) {
      var blockedTag = document.createElement('div');          // 拉黑标记
      blockedTag.className = 'im-contact-sub';
      blockedTag.textContent = imT('im.contacts.blocked', '已拉黑');
      main.appendChild(blockedTag);
    }
    row.appendChild(main);

    row.addEventListener('click', function () { selectContact(friend); });
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      openContactMenu(friend, e.clientX, e.clientY);
    });
    // iOS / 触屏：长按联系人呼出同一菜单
    bindLongPress(row, function (x, y) { openContactMenu(friend, x, y); });
    row.addEventListener('mouseenter', function () { showContactHover(friend, row); });
    row.addEventListener('mouseleave', function () {
      clearTimeout(contactHoverTimer);
      contactHoverTimer = setTimeout(hideContactHover, 160);    // 留出移入卡片的缓冲时间
    });
    return row;
  }

  /**
   * 选中联系人：高亮行 + 右侧资料卡
   * @param {object} friend 联系人数据
   */
  function selectContact(friend) {
    state.contactId = friend.id;
    Array.prototype.forEach.call(dom.contactsList.querySelectorAll('.im-contact-row'), function (row) {
      row.classList.toggle('active', row.dataset.id === friend.id);
    });
    renderContactProfile(friend);
    dom.profilePage.classList.add('show');
    if (window.innerWidth <= 768) {                            // 移动端切到资料页
      state.mobileMsgOpen = true;
      document.body.classList.add('im-msg-open');
    }
  }

  /**
   * 生成资料卡中的一行字段
   * @param {string} label 字段名
   * @param {string} value 字段值
   * @returns {string} HTML 片段
   */
  function profileField(label, value) {
    return '<div class="im-profile-field">' +
      '<span class="im-profile-label">' + esc(label) + '</span>' +
      '<span class="im-profile-value">' + esc(value) + '</span>' +
    '</div>';
  }

  /**
   * 渲染右侧好友资料卡（大头像 / 昵称 / 账号 / 签名 / 标签 / 等级 / 生日 / 地区 + 快捷按钮）
   * @param {object} friend 联系人数据
   */
  function renderContactProfile(friend) {
    var notSet = imT('im.contacts.notSet', '未设置');          // 缺失字段占位
    var statusText = friend.online
      ? imT('im.contacts.online', '在线')
      : imT('im.contacts.offline', '离线');
    var tags = (friend.tags && friend.tags.length) ? friend.tags.join('、') : notSet;

    dom.profileInner.innerHTML =
      '<div class="im-profile-card">' +
        '<div class="im-profile-hero">' +
          '<div class="im-profile-avatar" id="imProfileAvatar"></div>' +
          '<div class="im-profile-idbox">' +
            '<div class="im-profile-name">' + esc(friend.displayName || friend.id) + '</div>' +
            '<div class="im-profile-account">' + imT('im.contacts.account', '账号') + '：' + esc(friend.id) + '</div>' +
            '<div class="im-profile-status">' +
              '<span class="im-contact-dot ' + (friend.online ? 'on' : 'off') + '"></span>' +
              '<span>' + statusText + '</span>' +
              (friend.blocked ? '<span class="im-profile-blocked">' + imT('im.contacts.blocked', '已拉黑') + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="im-profile-fields">' +
          profileField(imT('im.contacts.signature', '个性签名'), friend.signature || notSet) +
          profileField(imT('im.contacts.tags', '标签'), tags) +
          profileField(imT('im.contacts.level', '等级'), 'Lv.' + friend.level) +
          profileField(imT('im.contacts.birthday', '生日'), friend.birthday || notSet) +
          profileField(imT('im.contacts.region', '地区'), friend.region || notSet) +
        '</div>' +
        '<div class="im-profile-actions">' +
          '<button class="btn btn-column2" id="imProfileChat">' + imT('im.contacts.sendMsg', '发消息') + '</button>' +
          '<button class="btn btn-column5" id="imProfileVoice">' + imT('im.contacts.voice', '语音') + '</button>' +
          '<button class="btn btn-column5" id="imProfileVideo">' + imT('im.contacts.video', '视频') + '</button>' +
        '</div>' +
      '</div>';

    // 头像：无自定义头像时回退平台默认头像
    var avatarBox = $('#imProfileAvatar', dom.profileInner);
    var avatarImg = document.createElement('img');
    avatarImg.alt = friend.displayName || friend.id;
    avatarImg.src = friend.avatar || DEFAULT_AVATAR;
    avatarImg.onerror = function () { avatarImg.onerror = null; avatarImg.src = DEFAULT_AVATAR; };
    avatarBox.appendChild(avatarImg);

    $('#imProfileChat', dom.profileInner).addEventListener('click', function () { openContactChat(friend); });
    $('#imProfileVoice', dom.profileInner).addEventListener('click', function () {
      window.showToast(imT('im.contacts.voiceTodo', '语音通话暂未开放'), 'info');
    });
    $('#imProfileVideo', dom.profileInner).addEventListener('click', function () {
      window.showToast(imT('im.contacts.videoTodo', '视频通话暂未开放'), 'info');
    });
  }

  /**
   * 渲染「群聊」tab：列出我加入的群（复用会话列表数据）
   */
  function renderContactGroupChats() {
    var groups = state.convs.filter(function (c) { return c.type === 'group'; });
    dom.contactsList.innerHTML = '';
    if (!groups.length) {
      var empty = document.createElement('div');
      empty.className = 'im-conv-empty';
      empty.textContent = imT('im.contacts.noGroups', '还没有加入任何群聊');
      dom.contactsList.appendChild(empty);
      return;
    }
    groups.forEach(function (conv) {
      var row = document.createElement('div');                 // 群聊行
      row.className = 'im-contact-row';
      var avatar = document.createElement('div');              // 群头像
      avatar.className = 'im-contact-avatar';
      if (conv.avatar) {
        var img = document.createElement('img');
        img.src = conv.avatar;
        img.alt = convLabel(conv);
        avatar.appendChild(img);
      } else {
        avatar.classList.add('group');
        avatar.innerHTML = ICON_GROUP;
      }
      row.appendChild(avatar);
      var main = document.createElement('div');                // 群名与人数
      main.className = 'im-contact-main';
      main.innerHTML = '<div class="im-contact-name">' + esc(convLabel(conv)) + '</div>' +
        '<div class="im-contact-sub">' + imT('im.search.memberCount', '{count} 名成员', { count: (conv.members || []).length }) + '</div>';
      row.appendChild(main);
      row.addEventListener('click', function () {
        switchMode('chat');
        selectConv(conv.id);
      });
      dom.contactsList.appendChild(row);
    });
  }

  /**
   * 从联系人打开对应单聊
   * @param {object} friend 联系人数据
   * @returns {Promise<void>}
   */
  async function openContactChat(friend) {
    hideContactHover();
    closeContactMenu();
    switchMode('chat');
    await loadConvs();
    var conv = state.convs.find(function (c) { return c.id === friend.convId; });
    if (!conv) {
      conv = state.convs.find(function (c) {
        return c.type === 'c2c' && (c.members || []).some(function (m) {
          return m.id === friend.id;
        });
      });
    }
    if (conv) selectConv(conv.id);
    else window.showToast(imT('im.contacts.noConv', '会话不存在，请刷新后重试'), 'warning');
  }

  /**
   * 显示好友悬浮资料卡（签名、资料、快捷发消息、语音视频）
   * @param {object} friend 联系人数据
   * @param {HTMLElement} row 好友行（用于定位）
   */
  function showContactHover(friend, row) {
    clearTimeout(contactHoverTimer);
    hideContactHover();

    var card = document.createElement('div');                  // 悬浮卡片
    card.className = 'im-contact-hover';
    card.id = 'imContactHover';
    card.innerHTML =
      '<div class="im-contact-hover-head">' +
        '<div class="im-contact-hover-avatar" id="imHoverAvatar"></div>' +
        '<div class="im-contact-hover-idbox">' +
          '<div class="im-contact-hover-name">' + esc(friend.displayName || friend.id) + '</div>' +
          '<div class="im-contact-hover-id">' + esc(friend.id) + ' · ' +
            (friend.online ? imT('im.contacts.online', '在线') : imT('im.contacts.offline', '离线')) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="im-contact-hover-sign">' +
        esc(friend.signature || imT('im.contacts.noSignature', '这个人很懒，什么都没写')) + '</div>' +
      '<div class="im-contact-hover-actions">' +
        '<button data-act="profile">' + imT('im.contacts.openProfile', '资料') + '</button>' +
        '<button data-act="chat">' + imT('im.contacts.sendMsg', '发消息') + '</button>' +
        '<button data-act="voice">' + imT('im.contacts.voice', '语音') + '</button>' +
        '<button data-act="video">' + imT('im.contacts.video', '视频') + '</button>' +
      '</div>';

    var hoverImg = document.createElement('img');              // 悬浮卡头像
    hoverImg.alt = friend.displayName || friend.id;
    hoverImg.src = friend.avatar || DEFAULT_AVATAR;
    hoverImg.onerror = function () { hoverImg.onerror = null; hoverImg.src = DEFAULT_AVATAR; };
    $('#imHoverAvatar', card).appendChild(hoverImg);

    card.addEventListener('mouseenter', function () { clearTimeout(contactHoverTimer); });
    card.addEventListener('mouseleave', function () { hideContactHover(); });
    card.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');                // 被点的快捷按钮
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'profile') selectContact(friend);
      else if (act === 'chat') openContactChat(friend);
      else if (act === 'voice') window.showToast(imT('im.contacts.voiceTodo', '语音通话暂未开放'), 'info');
      else if (act === 'video') window.showToast(imT('im.contacts.videoTodo', '视频通话暂未开放'), 'info');
      hideContactHover();
    });

    document.body.appendChild(card);

    // 定位到好友行右侧，超出视口时自动收到左侧 / 上方
    var rect = row.getBoundingClientRect();
    var cw = card.offsetWidth;                                 // 卡片宽度
    var ch = card.offsetHeight;                                // 卡片高度
    var left = rect.right + 10;
    if (left + cw > window.innerWidth - 8) left = Math.max(8, rect.left - cw - 10);
    var top = Math.min(rect.top, window.innerHeight - ch - 8);
    card.style.left = left + 'px';
    card.style.top = Math.max(8, top) + 'px';
  }

  /** 隐藏好友悬浮资料卡 */
  function hideContactHover() {
    var card = $('#imContactHover');
    if (card) card.remove();
  }

  /**
   * 关闭联系人右键菜单
   */
  function closeContactMenu() {
    var menu = $('#imContactMenu');
    if (menu) menu.remove();
  }

  /**
   * 打开联系人右键菜单
   * @param {object} friend 联系人数据
   * @param {number} x 鼠标 X
   * @param {number} y 鼠标 Y
   */
  function openContactMenu(friend, x, y) {
    closeContactMenu();
    hideContactHover();

    var menu = document.createElement('div');                  // 右键菜单容器
    menu.className = 'im-ctx';
    menu.id = 'imContactMenu';

    /** 追加一个菜单项 */
    function item(label, fn, danger) {
      var row = document.createElement('div');
      row.className = 'im-ctx-item' + (danger ? ' danger' : '');
      row.textContent = label;
      row.addEventListener('click', function () { closeContactMenu(); fn(); });
      menu.appendChild(row);
    }
    /** 追加分隔线 */
    function divider() {
      var line = document.createElement('div');
      line.className = 'im-ctx-divider';
      menu.appendChild(line);
    }

    item(imT('im.contacts.openProfile', '打开资料'), function () { selectContact(friend); });
    item(imT('im.contacts.sendMsg', '发送消息'), function () { openContactChat(friend); });
    item(imT('im.contacts.setRemark', '设置备注'), function () { openRemarkModal(friend); });
    item(imT('im.contacts.moveGroup', '移动分组'), function () { renderMoveGroupMenu(menu, friend); });
    item(friend.blocked ? imT('im.contacts.unblock', '解除拉黑') : imT('im.contacts.block', '设置权限（拉黑）'),
      function () { toggleBlocked(friend); });
    divider();
    item(imT('im.contacts.deleteFriend', '删除好友'), function () { deleteFriend(friend); }, true);

    document.body.appendChild(menu);
    // 菜单内部点击不冒泡到 document，避免「移动分组」等二级菜单被立即关闭
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    // 视口边界钳制
    var mw = menu.offsetWidth;                                 // 菜单宽度
    var mh = menu.offsetHeight;                                // 菜单高度
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';

    setTimeout(function () {
      document.addEventListener('click', closeContactMenu, { once: true });
    }, 0);
  }

  /**
   * 把右键菜单内容切换为「移动分组」的分组列表
   * @param {HTMLElement} menu 右键菜单容器
   * @param {object} friend 联系人数据
   */
  function renderMoveGroupMenu(menu, friend) {
    var groups = (state.contacts && state.contacts.groups) || [];
    menu.innerHTML = '<div class="im-ctx-title">' + imT('im.contacts.moveTo', '移动到分组') + '</div>';
    groups.forEach(function (group) {
      var row = document.createElement('div');                 // 分组选项
      row.className = 'im-ctx-item' + (group.id === friend.groupId ? ' active' : '');
      row.textContent = group.name;
      row.addEventListener('click', async function () {
        closeContactMenu();
        try {
          await api('/contacts/friends/' + encodeURIComponent(friend.id), {
            method: 'PATCH',
            body: JSON.stringify({ groupId: group.id })
          });
          window.showToast(imT('im.contacts.moved', '已移动到「{name}」', { name: group.name }), 'success');
          await loadContacts();
        } catch (e) {
          window.showToast(e.message, 'error');
        }
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);                           // 重建内容后重新挂载（点击「移动分组」时已被移除）
  }

  /**
   * 切换好友拉黑状态
   * @param {object} friend 联系人数据
   * @returns {Promise<void>}
   */
  async function toggleBlocked(friend) {
    try {
      await api('/contacts/friends/' + encodeURIComponent(friend.id), {
        method: 'PATCH',
        body: JSON.stringify({ blocked: !friend.blocked })
      });
      window.showToast(friend.blocked
        ? imT('im.contacts.unblockedToast', '已解除拉黑')
        : imT('im.contacts.blockedToast', '已拉黑该好友'), 'success');
      await loadContacts();
      if (state.contactId === friend.id) {
        var updated = (state.contacts.friends || []).find(function (f) { return f.id === friend.id; });
        if (updated) renderContactProfile(updated);
      }
    } catch (e) {
      window.showToast(e.message, 'error');
    }
  }

  /**
   * 删除好友（同时删除双方单聊会话）
   * @param {object} friend 联系人数据
   * @returns {Promise<void>}
   */
  async function deleteFriend(friend) {
    var yes = await confirmDialog({
      title: imT('im.contacts.deleteTitle', '删除好友'),
      text: imT('im.contacts.deleteText', '确定删除好友「{name}」吗？聊天记录也会一并删除。', { name: friend.displayName }),
      okText: imT('im.common.delete', '删除'),
      danger: true
    });
    if (!yes) return;
    try {
      await api('/contacts/friends/' + encodeURIComponent(friend.id), { method: 'DELETE' });
      if (state.contactId === friend.id) {
        state.contactId = null;
        dom.profileInner.innerHTML = '<div class="im-profile-empty">' +
          imT('im.contacts.pickHint', '选择联系人查看资料') + '</div>';
      }
      window.showToast(imT('im.contacts.deletedToast', '已删除好友'), 'success');
      await loadConvs();
      await loadContacts();
    } catch (e) {
      window.showToast(e.message, 'error');
    }
  }

  /**
   * 打开分组操作菜单（改名 / 删除）
   * @param {object} group 分组
   * @param {number} x 鼠标 X
   * @param {number} y 鼠标 Y
   */
  function openGroupMenu(group, x, y) {
    closeContactMenu();
    var menu = document.createElement('div');                  // 分组操作菜单
    menu.className = 'im-ctx';
    menu.id = 'imContactMenu';

    var rename = document.createElement('div');                // 重命名
    rename.className = 'im-ctx-item';
    rename.textContent = imT('im.contacts.renameGroup', '重命名分组');
    rename.addEventListener('click', function () {
      closeContactMenu();
      openGroupNameModal(group);
    });
    menu.appendChild(rename);

    if (group.id !== 'default') {
      var del = document.createElement('div');                 // 删除分组
      del.className = 'im-ctx-item danger';
      del.textContent = imT('im.contacts.deleteGroup', '删除分组');
      del.addEventListener('click', function () {
        closeContactMenu();
        deleteContactGroup(group);
      });
      menu.appendChild(del);
    }

    document.body.appendChild(menu);
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    var mw = menu.offsetWidth;                                 // 菜单宽度
    var mh = menu.offsetHeight;                                // 菜单高度
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
    setTimeout(function () {
      document.addEventListener('click', closeContactMenu, { once: true });
    }, 0);
  }

  /**
   * 新建 / 重命名分组弹窗
   * @param {object|null} group 传入分组表示重命名，null 表示新建
   */
  function openGroupNameModal(group) {
    var editing = !!group;                                     // 是否为重命名
    var mask = document.createElement('div');                  // 遮罩
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal im-contact-modal">' +
        '<div class="im-modal-title">' +
          (editing ? imT('im.contacts.renameGroup', '重命名分组') : imT('im.contacts.newGroup', '新建分组')) +
        '</div>' +
        '<input class="input im-modal-input" id="imGroupNameInput" maxlength="16" ' +
          'placeholder="' + imT('im.contacts.groupNamePlaceholder', '输入分组名称') + '" ' +
          'value="' + esc(editing ? group.name : '') + '">' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imGroupNameSave">' + imT('im.common.save', '保存') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });
    mask.querySelector('#imGroupNameSave').addEventListener('click', async function () {
      var btn = this;                                          // 保存按钮
      var name = mask.querySelector('#imGroupNameInput').value.trim();
      if (!name) { window.showToast(imT('im.contacts.warnGroupName', '请填写分组名称'), 'warning'); return; }
      btn.disabled = true;
      try {
        if (editing) {
          await api('/contacts/groups/' + encodeURIComponent(group.id), {
            method: 'PATCH',
            body: JSON.stringify({ name: name })
          });
        } else {
          await api('/contacts/groups', { method: 'POST', body: JSON.stringify({ name: name }) });
        }
        hideModal(mask);
        window.showToast(editing
          ? imT('im.contacts.groupRenamed', '分组已重命名')
          : imT('im.contacts.groupCreated', '分组已创建'), 'success');
        await loadContacts();
      } catch (e) {
        btn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  /**
   * 删除分组（组内好友移回「我的好友」）
   * @param {object} group 分组
   * @returns {Promise<void>}
   */
  async function deleteContactGroup(group) {
    var yes = await confirmDialog({
      title: imT('im.contacts.deleteGroup', '删除分组'),
      text: imT('im.contacts.deleteGroupText', '删除分组「{name}」后，组内好友将移回「我的好友」。', { name: group.name }),
      okText: imT('im.common.delete', '删除'),
      danger: true
    });
    if (!yes) return;
    try {
      await api('/contacts/groups/' + encodeURIComponent(group.id), { method: 'DELETE' });
      window.showToast(imT('im.contacts.groupDeleted', '分组已删除'), 'success');
      await loadContacts();
    } catch (e) {
      window.showToast(e.message, 'error');
    }
  }

  /**
   * 设置好友备注弹窗
   * @param {object} friend 联系人数据
   */
  function openRemarkModal(friend) {
    var mask = document.createElement('div');                  // 遮罩
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal im-contact-modal">' +
        '<div class="im-modal-title">' + imT('im.contacts.setRemark', '设置备注') + '</div>' +
        '<input class="input im-modal-input" id="imRemarkInput" maxlength="30" ' +
          'placeholder="' + imT('im.contacts.remarkPlaceholder', '输入备注名（留空则显示原昵称）') + '" ' +
          'value="' + esc(friend.remark || '') + '">' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imRemarkSave">' + imT('im.common.save', '保存') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });
    mask.querySelector('#imRemarkSave').addEventListener('click', async function () {
      var btn = this;                                          // 保存按钮
      var remark = mask.querySelector('#imRemarkInput').value.trim();
      btn.disabled = true;
      try {
        await api('/contacts/friends/' + encodeURIComponent(friend.id), {
          method: 'PATCH',
          body: JSON.stringify({ remark: remark })
        });
        hideModal(mask);
        // 备注同步到本地会话数据，会话列表与聊天标题立即生效
        var chatConv = (state.convs || []).find(function (c) {
          if (c.type !== 'c2c') return false;
          return (c.members || []).some(function (m) { return (m && m.id ? m.id : m) === friend.id; });
        });
        if (chatConv) {
          chatConv.prefs = chatConv.prefs || {};
          chatConv.prefs.remark = remark;
          // 当前会话详情缓存也要同步，否则消息发送者名仍用旧备注
          if (state.detail && state.detail.id === chatConv.id) {
            state.detail.prefs = state.detail.prefs || {};
            state.detail.prefs.remark = remark;
          }
          renderConvList();
          if (state.activeId === chatConv.id && !state.albumOpen && !state.workOpen) {
            dom.chatTitle.textContent = convLabel(chatConv);
          }
        }
        window.showToast(imT('im.contacts.remarkSaved', '备注已保存'), 'success');
        await loadContacts();
        var updated = (state.contacts.friends || []).find(function (f) { return f.id === friend.id; });
        if (updated && state.contactId === friend.id) renderContactProfile(updated);
      } catch (e) {
        btn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  // ============ 群作业 ============

  /** 各科目图标（Figma 导出的 40×40 SVG） */
  var HW_ICONS = {
    '语文': '/im/assets/work-icons/chinese.svg',
    '数学': '/im/assets/work-icons/math.svg',
    '英语': '/im/assets/work-icons/english.svg'
  };

  /**
   * 取科目图标地址（未知科目统一用「其他」图标）
   * @param {string} subject 科目名
   * @returns {string} 图标 URL
   */
  function subjectIcon(subject) {
    return HW_ICONS[subject] || '/im/assets/work-icons/other.svg';
  }

  /**
   * 从聊天里的作业卡片进入作业详情
   * @param {string} id 作业 ID
   * @returns {Promise<void>}
   */
  async function openHomeworkFromChat(id) {
    await openWorkPage();
    openWorkDetail(id);
  }

  /**
   * 生成聊天中的作业卡片（标题 + 科目图标 + 「班级作业」脚注）
   * @param {object} part 作业片段 { homeworkId, title, subject }
   * @returns {HTMLElement}
   */
  function makeHomeworkCard(part) {
    var card = document.createElement('div');                 // 作业卡片
    card.className = 'im-hw-card';
    card.innerHTML =
      '<div class="im-hw-card-main">' +
        '<div class="im-hw-card-title">' + esc(part.title) + '</div>' +
        '<img class="im-hw-card-icon" src="' + subjectIcon(part.subject) + '" alt="">' +
      '</div>' +
      '<div class="im-hw-card-foot">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L16 7.5"/></svg>' +
        '<span>' + imT('im.work.classHomework', '班级作业') + '</span>' +
      '</div>';
    card.addEventListener('click', function () { openHomeworkFromChat(part.homeworkId); });
    return card;
  }

  /**
   * 打开群作业页（仅群聊）：展示作业列表，老师可布置作业
   * @returns {Promise<void>}
   */
  async function openWorkPage() {
    var conv = activeConv();
    if (!conv || conv.type !== 'group') return;
    if (state.settingsOpen) closeSettings();
    state.workOpen = true;
    state.workDetail = null;
    dom.workPage.classList.add('show');
    dom.chatTitle.textContent = imT('im.work.title', '群作业');
    dom.workHeadTitle.textContent = imT('im.work.title', '群作业');
    dom.workAssign.style.display = 'none';
    // 移动端：切到右侧内容区
    if (window.innerWidth <= 768) {
      state.mobileMsgOpen = true;
      document.body.classList.add('im-msg-open');
    }
    dom.workBody.innerHTML = '<div class="im-work-empty">' + imT('im.work.loading', '加载中…') + '</div>';
    await loadWorkList();
  }

  /**
   * 关闭群作业页：恢复聊天标题
   */
  function closeWorkPage() {
    state.workOpen = false;
    state.workDetail = null;
    dom.workPage.classList.remove('show');
    var conv = activeConv();
    dom.chatTitle.textContent = conv ? convLabel(conv) : imT('im.common.conversation', '会话');
  }

  /**
   * 拉取当前群聊的作业列表
   * @returns {Promise<void>}
   */
  async function loadWorkList() {
    var conv = activeConv();
    if (!conv) return;
    try {
      var data = await api('/conversations/' + encodeURIComponent(conv.id) + '/homework');
      if (!state.workOpen) return;
      state.workList = data;
      dom.workAssign.style.display = data.canManage ? '' : 'none';
      renderWorkList();
    } catch (e) {
      if (!state.workOpen) return;
      dom.workBody.innerHTML = '<div class="im-work-empty">' + esc(e.message) + '</div>';
    }
  }

  /**
   * 渲染作业列表（按布置日期分组）
   */
  function renderWorkList() {
    var data = state.workList || { list: [] };
    var list = data.list || [];
    dom.workBody.innerHTML = '';

    if (!list.length) {
      dom.workBody.innerHTML = '<div class="im-work-empty">' +
        imT('im.work.empty', '还没有作业') + '</div>';
      return;
    }

    var lastDay = '';                                           // 上一组的日期标题
    var groupEl = null;                                         // 当前日期分组卡片
    list.forEach(function (item) {
      var label = dayLabel(item.createdAt);
      if (label !== lastDay) {
        lastDay = label;
        groupEl = document.createElement('div');               // 一组同一天的作业卡片
        groupEl.className = 'im-work-group';
        var sec = document.createElement('div');               // 日期分组标题
        sec.className = 'im-work-sec';
        sec.textContent = label;
        var divider = document.createElement('div');           // 标题与列表间的分隔线
        divider.className = 'im-work-divider';
        groupEl.appendChild(sec);
        groupEl.appendChild(divider);
        dom.workBody.appendChild(groupEl);
      }
      groupEl.appendChild(makeWorkRow(item));
    });
  }

  /**
   * 生成一条作业列表行
   * @param {object} item 作业数据
   * @returns {HTMLElement}
   */
  function makeWorkRow(item) {
    var row = document.createElement('div');                   // 作业行
    row.className = 'im-work-row';

    var icon = document.createElement('img');                  // 左侧科目图标（设计稿 SVG）
    icon.className = 'im-work-icon';
    icon.src = subjectIcon(item.subject);
    icon.alt = '';

    var main = document.createElement('div');                  // 中间标题与摘要
    main.className = 'im-work-row-main';
    var title = document.createElement('div');
    title.className = 'im-work-row-title';
    title.textContent = item.title;
    var sub = document.createElement('div');
    sub.className = 'im-work-row-sub';
    sub.textContent = item.content.replace(/\s+/g, ' ');
    main.appendChild(title);
    main.appendChild(sub);

    var badge = document.createElement('span');                // 右侧状态徽标
    if (item.canManage) {
      badge.className = 'im-work-badge done';
      badge.textContent = imT('im.work.submittedCount', '已提交 {count} 人', { count: item.submittedCount });
    } else {
      var st = workStatus(item);
      badge.className = 'im-work-badge ' + st.cls;
      badge.textContent = st.text;
    }

    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(badge);

    // 老师 / 群主 / 管理员：悬停显示编辑、删除按钮
    if (item.canManage) {
      var actions = document.createElement('div');
      actions.className = 'im-work-actions';
      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'im-work-act';
      editBtn.title = imT('im.work.edit', '编辑');
      editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>';
      editBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openAssignModal(item);
      });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'im-work-act danger';
      delBtn.title = imT('im.work.delete', '删除');
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
      delBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var yes = await confirmDialog({
          title: imT('im.work.deleteTitle', '删除作业'),
          text: imT('im.work.deleteConfirm', '删除后学生将无法再查看这份作业，确定删除吗？'),
          okText: imT('im.work.delete', '删除'),
          danger: true
        });
        if (!yes) return;
        try {
          await api('/homework/' + encodeURIComponent(item.id), { method: 'DELETE' });
          window.showToast(imT('im.work.deleted', '作业已删除'), 'success');
          await loadWorkList();
        } catch (err) {
          window.showToast(err.message, 'error');
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
    }

    row.addEventListener('click', function () { openWorkDetail(item.id); });
    return row;
  }

  /**
   * 计算学生对某次作业的状态
   * @param {object} item 作业数据
   * @returns {{text:string, cls:string}}
   */
  function workStatus(item) {
    if (!item.needSubmit) return { text: imT('im.work.noSubmit', '无需提交'), cls: 'muted' };
    if (item.grade) {
      return item.grade === '需修改'
        ? { text: imT('im.work.needFix', '需修改'), cls: 'warn' }
        : { text: imT('im.work.reviewed', '已批改'), cls: 'done' };
    }
    if (item.submitted) return { text: imT('im.work.done', '已完成'), cls: 'done' };
    return { text: imT('im.work.needSubmit', '需提交'), cls: 'todo' };
  }

  /**
   * 打开作业详情
   * @param {string} id 作业 ID
   * @returns {Promise<void>}
   */
  async function openWorkDetail(id) {
    dom.workBody.innerHTML = '<div class="im-work-empty">' + imT('im.work.loading', '加载中…') + '</div>';
    dom.workHeadTitle.textContent = imT('im.work.detail', '作业详情');
    dom.workAssign.style.display = 'none';
    try {
      state.workDetail = await api('/homework/' + encodeURIComponent(id));
    } catch (e) {
      dom.workBody.innerHTML = '<div class="im-work-empty">' + esc(e.message) + '</div>';
      return;
    }
    renderWorkDetail();
  }

  /**
   * 渲染作业详情：作业内容 + 我的提交（学生）或提交列表（老师）
   */
  function renderWorkDetail() {
    var item = state.workDetail;
    if (!item) { renderWorkList(); return; }
    dom.workBody.innerHTML = '';

    var card = document.createElement('div');                  // 作业内容卡片
    card.className = 'im-work-card';
    card.innerHTML =
      '<div class="im-work-card-head">' +
        '<span class="im-work-subject">' + esc(item.subject) + '</span>' +
        '<span class="im-work-card-title">' + esc(item.title) + '</span>' +
      '</div>' +
      '<div class="im-work-card-meta">' + esc(item.creatorName) + ' · ' + esc(convTimeLabel(item.createdAt)) + '</div>' +
      '<div class="im-work-card-content" id="imWorkDetailContent"></div>';
    dom.workBody.appendChild(card);
    renderMarkdown(card.querySelector('#imWorkDetailContent'), item.content);

    // 独立附件列表仅用于「旧数据兼容」：content 里没嵌入附件 URL 时才显示
    // 新数据的附件已通过 Markdown 语法嵌进 content，renderMarkdown 会自动渲染
    var atts = Array.isArray(item.attachments) ? item.attachments : [];   // 附件列表
    var contentText = item.content || '';                                 // Markdown 原文
    // 筛选出「content 里找不到 URL」的旧附件（需要独立展示）
    var orphanAtts = atts.filter(function (f) {
      return f && f.url && contentText.indexOf(f.url) < 0;               // 原文里没出现这个 URL
    });
    if (orphanAtts.length) {
      var attWrap = document.createElement('div');           // 附件容器
      attWrap.className = 'im-hw-detail-attach';
      orphanAtts.forEach(function (f) {
        if (f.kind === 'image') {
          var img = document.createElement('img');           // 图片缩略图
          img.className = 'im-hw-attach-thumb';
          img.src = f.url;
          img.alt = f.name;
          img.title = f.name;
          img.addEventListener('click', function () { window.open(f.url, '_blank', 'noopener'); });
          attWrap.appendChild(img);
        } else if (f.kind === 'video') {
          var video = document.createElement('video');       // 内联视频播放器
          video.className = 'im-hw-attach-video';
          video.src = f.url;
          video.controls = true;
          video.preload = 'metadata';
          attWrap.appendChild(video);
        } else {
          var row = document.createElement('a');             // 文件下载行
          row.className = 'im-hw-attach-file';
          row.href = f.url;
          row.target = '_blank';
          row.rel = 'noopener';
          row.innerHTML = '<span class="im-hw-attach-icon">' + ICON_FILE + '</span>' +
            '<span class="im-hw-attach-name">' + esc(f.name) + '</span>' +
            '<span class="im-hw-attach-size">' + formatSize(f.size || 0) + '</span>';
          attWrap.appendChild(row);
        }
      });
      dom.workBody.appendChild(attWrap);
    }

    if (item.canManage) {
      // 老师：提交情况
      var sec = document.createElement('div');
      sec.className = 'im-work-sec';
      sec.textContent = imT('im.work.submissions', '提交情况') + ' · ' +
        imT('im.work.submittedCount', '已提交 {count} 人', { count: (item.submissions || []).length });
      dom.workBody.appendChild(sec);

      if (!(item.submissions || []).length) {
        var empty = document.createElement('div');
        empty.className = 'im-work-empty';
        empty.textContent = imT('im.work.noSubmissions', '还没有同学提交');
        dom.workBody.appendChild(empty);
      }
      (item.submissions || []).forEach(function (sub) {
        dom.workBody.appendChild(makeSubmissionRow(sub));
      });
      return;
    }

    // 学生：我的作业
    var mine = document.createElement('div');
    mine.className = 'im-work-card';
    var head = document.createElement('div');
    head.className = 'im-work-card-head';
    head.innerHTML = '<span class="im-work-card-title">' + imT('im.work.mySubmission', '我的作业') + '</span>';
    mine.appendChild(head);

    if (item.submitted) {
      var text = document.createElement('div');
      text.className = 'im-work-card-content';
      renderMarkdown(text, item.myText);
      mine.appendChild(text);

      if (item.grade) {
        var review = document.createElement('div');
        review.className = 'im-work-review';
        review.innerHTML = '<span class="im-work-grade">' + esc(item.grade) + '</span>' +
          (item.comment ? '<span class="im-work-comment">' + esc(item.comment) + '</span>' : '');
        mine.appendChild(review);
      }
    } else {
      var tip = document.createElement('div');
      tip.className = 'im-work-empty';
      tip.textContent = item.needSubmit
        ? imT('im.work.notSubmitted', '尚未提交，点击下方按钮完成作业')
        : imT('im.work.noSubmit', '无需提交');
      mine.appendChild(tip);
    }
    dom.workBody.appendChild(mine);

    if (item.needSubmit && (!item.grade || item.grade === '需修改')) {
      var submitBtn = document.createElement('button');        // 提交 / 修改按钮
      submitBtn.className = 'btn btn-column2 im-work-main-btn';
      submitBtn.textContent = item.submitted
        ? (item.grade === '需修改' ? imT('im.work.resubmit', '重新提交') : imT('im.work.editSubmit', '修改作业'))
        : imT('im.work.submitBtn', '提交作业');
      submitBtn.addEventListener('click', function () { openSubmitModal(item); });
      dom.workBody.appendChild(submitBtn);
    }
  }

  /**
   * 生成老师视角的一条提交记录
   * @param {object} sub 提交数据
   * @returns {HTMLElement}
   */
  function makeSubmissionRow(sub) {
    var row = document.createElement('div');                   // 提交行
    row.className = 'im-work-sub-row';
    row.appendChild(makeAvatar(sub.name, sub.userId, 'im-avatar-sm'));

    var main = document.createElement('div');                  // 学生姓名与答案摘要
    main.className = 'im-work-sub-main';
    main.innerHTML = '<div class="im-work-sub-name">' + esc(sub.name) +
      (sub.grade ? '<span class="im-work-grade">' + esc(sub.grade) + '</span>' : '') + '</div>' +
      '<div class="im-work-sub-text">' + esc(sub.text || '') + '</div>';

    var btn = document.createElement('button');                // 检查作业
    btn.className = 'im-friend-btn';
    btn.textContent = sub.grade
      ? imT('im.work.reviewedBtn', '已批改')
      : imT('im.work.review', '检查作业');
    btn.addEventListener('click', function () { openReviewModal(sub); });

    row.appendChild(main);
    row.appendChild(btn);
    return row;
  }

  /**
   * 布置 / 编辑作业弹窗
   * @param {object} [item] 传入则为编辑模式，不传为布置模式
   */
  function openAssignModal(item) {
    var editing = !!item;                                      // 是否编辑已有作业
    var data = state.workList || {};
    var subjects = data.subjects || ['语文', '数学', '英语', '综合'];
    var picked = editing ? item.subject : (subjects[0] || '综合');   // 当前选中的科目

    var mask = document.createElement('div');                  // 遮罩
    mask.className = 'im-modal-mask im-modal-page';
    mask.innerHTML =
      '<div class="im-modal im-hw-modal">' +
        '<div class="im-modal-title">' + (editing ? imT('im.work.editTitle', '编辑作业') : imT('im.work.assign', '布置作业')) + '</div>' +
        '<div class="im-hw-field"><div class="im-hw-label">' + imT('im.work.subject', '科目') + '</div>' +
          '<div class="im-hw-subjects" id="imHwSubjects">' +
            subjects.map(function (s) {
              return '<button type="button" class="im-hw-subject' + (s === picked ? ' active' : '') +
                '" data-subject="' + esc(s) + '">' + esc(s) + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="im-hw-field"><div class="im-hw-label">' + imT('im.work.titleLabel', '作业标题') + '</div>' +
          '<input class="input im-modal-input" id="imHwTitle" maxlength="50" placeholder="' +
            imT('im.work.titlePlaceholder', '输入作业标题') + '" value="' + esc(editing ? item.title : '') + '"></div>' +
        '<div class="im-hw-field"><div class="im-hw-label">' + imT('im.work.content', '作业内容') + '</div>' +
          '<textarea class="input im-hw-textarea" id="imHwContent" maxlength="3000" placeholder="' +
            imT('im.work.contentPlaceholder', '在这里输入作业内容') + '">' + esc(editing ? item.content : '') + '</textarea>' +
          '<div class="im-hw-toolbar">' +
            '<button type="button" class="im-hw-tool" data-tool="emoji">' + ICON_EMOJI + '<span>' + imT('im.work.attachEmoji', '表情') + '</span></button>' +
            '<button type="button" class="im-hw-tool" data-tool="image">' + ICON_IMAGE + '<span>' + imT('im.work.attachImage', '图片') + '</span></button>' +
            '<button type="button" class="im-hw-tool" data-tool="video">' + ICON_VIDEO + '<span>' + imT('im.work.attachVideo', '视频') + '</span></button>' +
            '<button type="button" class="im-hw-tool" data-tool="file">' + ICON_FILE + '<span>' + imT('im.work.attachFile', '文件') + '</span></button>' +
          '</div>' +
          '<div class="im-hw-attach-list" id="imHwAttach"></div>' +
        '</div>' +
        '<input type="file" id="imHwFileImage" accept="image/*" multiple hidden>' +
        '<input type="file" id="imHwFileVideo" accept="video/*" multiple hidden>' +
        '<input type="file" id="imHwFileAny" multiple hidden>' +
        '<label class="im-hw-check"><input type="checkbox" id="imHwNeedSubmit"' + (editing && item.needSubmit === false ? '' : ' checked') + '>' +
          '<span>' + imT('im.work.needSubmitLabel', '需要学生在线提交作业') + '</span></label>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imHwPublish">' +
            (editing ? imT('im.work.saveEdit', '保存') : imT('im.work.publishAssign', '布置')) + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);

    mask.querySelector('#imHwSubjects').addEventListener('click', function (e) {
      var btn = e.target.closest('.im-hw-subject');
      if (!btn) return;
      picked = btn.getAttribute('data-subject');
      Array.prototype.forEach.call(mask.querySelectorAll('.im-hw-subject'), function (b) {
        b.classList.toggle('active', b === btn);
      });
    });
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });

    var hwFiles = (editing && Array.isArray(item.attachments) ? item.attachments : []).slice();   // 已选附件
    var attachBox = mask.querySelector('#imHwAttach');        // 附件列表容器

    /**
     * 从 textarea 内容中移除指定附件对应的嵌入语法块
     * 支持 Markdown 图片 ![name](url)、Markdown 文件 [name](url)、HTML <video src="url">...</video>
     * @param {string} content textarea 当前值
     * @param {object} attach 附件对象 { kind, url, name, size }
     * @returns {string} 移除后的内容
     */
    function removeAttachFromContent(content, attach) {
      var text = content;
      var url = attach.url;
      // 1) 移除 HTML video 标签（可能跨行，非贪婪匹配）
      text = text.replace(new RegExp('\\s*<video[^>]*src=["\']' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>.*?</video>\\s*', 'gs'), '\n');
      // 2) 移除 Markdown 图片语法 ![name](url) —— URL 后面不能有 )
      text = text.replace(new RegExp('\\s*!\\[[^\\]]*\\]\\([' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)\\s*', 'g'), '\n');
      // 3) 移除 Markdown 文件链接 [name](url)
      text = text.replace(new RegExp('\\s*\\[[^\\]]*\\]\\([' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)(?:\\s*\\([^)]*\\))?\\s*', 'g'), '\n');
      // 清理多余的连续空行
      text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
      return text;
    }

    /**
     * 渲染弹窗内的附件列表（图片缩略图 / 视频行 / 文件行）
     */
    function renderAttach() {
      attachBox.innerHTML = '';
      attachBox.style.display = hwFiles.length ? '' : 'none';
      hwFiles.forEach(function (f, i) {
        var chip = document.createElement('div');              // 附件条目
        if (f.kind === 'image') {
          chip.className = 'im-hw-attach-img';
          chip.innerHTML = '<img src="' + esc(f.url) + '" alt="' + esc(f.name) + '">';
        } else {
          chip.className = 'im-hw-attach-row';
          chip.innerHTML =
            '<span class="im-hw-attach-icon">' + (f.kind === 'video' ? ICON_VIDEO : ICON_FILE) + '</span>' +
            '<span class="im-hw-attach-name">' + esc(f.name) + '</span>' +
            '<span class="im-hw-attach-size">' + formatSize(f.size || 0) + '</span>';
        }
        var del = document.createElement('button');            // 移除按钮
        del.type = 'button';
        del.className = 'im-hw-attach-del';
        del.innerHTML = ICON_CLOSE;
        del.title = imT('im.work.removeAttach', '同时移除正文里的附件语法');
        del.addEventListener('click', function () {
          hwFiles.splice(i, 1);
          // 同步从 textarea 正文里删除对应的嵌入语法块
          var ta = mask.querySelector('#imHwContent');
          if (ta && f.url) {
            ta.value = removeAttachFromContent(ta.value, f);
          }
          renderAttach();
        });
        chip.appendChild(del);
        attachBox.appendChild(chip);
      });
    }

    /**
     * 上传一个附件并把嵌入语法插入 textarea 光标处
     * 同时 push 到 hwFiles 数组用于删除管理（旧数据兼容 / 发布时 attachments 字段）
     * @param {File} file 用户选择的文件
     * @param {string} kind 附件类型 image/video/file
     */
    async function uploadAttach(file, kind) {
      if (hwFiles.length >= 9) { window.showToast(imT('im.work.attachLimit', '附件最多 9 个'), 'warning'); return; }
      try {
        var dataUrl = await readAsDataUrl(file);               // 文件转 dataUrl 上传
        var conv = activeConv();
        var r = await api('/conversations/' + encodeURIComponent(conv.id) + '/homework-attachments', {
          method: 'POST',
          body: JSON.stringify({ kind: kind, name: file.name, dataUrl: dataUrl })
        });
        hwFiles.push(r);                                       // 保留用于删除管理与旧数据兼容
        // ★ 核心改造：把嵌入语法插入 textarea 光标处，附件直接嵌进 Markdown 原文
        var ta = mask.querySelector('#imHwContent');
        if (ta) {
          var nameEsc = r.name.replace(/[\[\]()]/g, '\\$&');   // Markdown 链接名中的特殊字符转义
          var urlEsc = r.url.replace(/\)/g, '%29');            // URL 中的 ) 要转义
          var syntax;                                          // 嵌入语法字符串
          if (kind === 'image') {
            syntax = '![' + nameEsc + '](' + urlEsc + ')\n';   // Markdown 图片语法
          } else if (kind === 'video') {
            // marked 默认不识别 video 语法，必须写 HTML 标签（DOMPurify 已放行）
            syntax = '\n<video src="' + urlEsc + '" controls preload="metadata" playsinline width="100%"></video>\n';
          } else {
            syntax = '[' + nameEsc + '](' + urlEsc + ') (' + formatSize(r.size || 0) + ')\n';  // Markdown 文件链接
          }
          insertTextIntoTextarea(ta, syntax);
        }
        renderAttach();                                        // 仍渲染独立列表（展示已上传附件，支持删除）
      } catch (e) {
        window.showToast(e.message, 'error');
      }
    }

    // 工具栏：表情/图片/视频/文件 四个按钮分别处理
    mask.querySelector('.im-hw-toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('.im-hw-tool');
      if (!btn) return;
      var tool = btn.getAttribute('data-tool');                // emoji / image / video / file
      if (tool === 'emoji') {
        openEmojiPickerForTextarea(mask.querySelector('#imHwContent'));   // 表情面板以短代码形式插入
      } else {
        mask.querySelector('#imHwFile' + (tool === 'image' ? 'Image' : tool === 'video' ? 'Video' : 'Any')).click();
      }
    });
    [['#imHwFileImage', 'image'], ['#imHwFileVideo', 'video'], ['#imHwFileAny', 'file']].forEach(function (pair) {
      mask.querySelector(pair[0]).addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files);    // 本次选中的文件
        this.value = '';
        files.forEach(function (f) { uploadAttach(f, pair[1]); });
      });
    });
    renderAttach();

    mask.querySelector('#imHwPublish').addEventListener('click', async function () {
      var btn = this;                                          // 布置 / 保存按钮
      var title = mask.querySelector('#imHwTitle').value.trim();
      var content = mask.querySelector('#imHwContent').value.trim();
      var needSubmit = mask.querySelector('#imHwNeedSubmit').checked;
      if (!title) { window.showToast(imT('im.work.warnTitle', '请填写作业标题'), 'warning'); return; }
      if (!content) { window.showToast(imT('im.work.warnContent', '请填写作业内容'), 'warning'); return; }
      btn.disabled = true;
      try {
        var conv = activeConv();
        if (editing) {
          await api('/homework/' + encodeURIComponent(item.id), {
            method: 'PUT',
            body: JSON.stringify({ subject: picked, title, content, needSubmit, attachments: hwFiles })
          });
          window.showToast(imT('im.work.edited', '作业已更新'), 'success');
        } else {
          await api('/conversations/' + encodeURIComponent(conv.id) + '/homework', {
            method: 'POST',
            body: JSON.stringify({ subject: picked, title, content, needSubmit, attachments: hwFiles })
          });
          window.showToast(imT('im.work.assigned', '作业已布置'), 'success');
        }
        hideModal(mask);
        await loadWorkList();
        if (editing && state.workDetail && state.workDetail.id === item.id) openWorkDetail(item.id);
      } catch (e) {
        btn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  /**
   * 完成 / 修改作业弹窗（支持 Markdown 富文本 + 表情 + 嵌入附件）
   * @param {object} item 作业数据
   */
  function openSubmitModal(item) {
    var mask = document.createElement('div');                  // 遮罩
    mask.className = 'im-modal-mask im-modal-page';
    mask.innerHTML =
      '<div class="im-modal im-hw-modal">' +
        '<div class="im-modal-title">' + imT('im.work.submitTitle', '完成作业') + '</div>' +
        '<textarea class="input im-hw-textarea" id="imHwAnswer" maxlength="3000" placeholder="' +
          imT('im.work.submitPlaceholder', '在这里输入你要完成的作业内容') + '">' + esc(item.myText || '') + '</textarea>' +
        '<div class="im-hw-toolbar" style="margin-top:8px">' +
          '<button type="button" class="im-hw-tool" data-tool="emoji">' + ICON_EMOJI + '<span>' + imT('im.work.attachEmoji', '表情') + '</span></button>' +
          '<button type="button" class="im-hw-tool" data-tool="image">' + ICON_IMAGE + '<span>' + imT('im.work.attachImage', '图片') + '</span></button>' +
          '<button type="button" class="im-hw-tool" data-tool="video">' + ICON_VIDEO + '<span>' + imT('im.work.attachVideo', '视频') + '</span></button>' +
          '<button type="button" class="im-hw-tool" data-tool="file">' + ICON_FILE + '<span>' + imT('im.work.attachFile', '文件') + '</span></button>' +
        '</div>' +
        '<input type="file" id="imHwSubmitFileImage" accept="image/*" multiple hidden>' +
        '<input type="file" id="imHwSubmitFileVideo" accept="video/*" multiple hidden>' +
        '<input type="file" id="imHwSubmitFileAny" multiple hidden>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imHwSubmit">' + imT('im.work.submit', '提交') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);

    var answerTa = mask.querySelector('#imHwAnswer');         // 提交内容 textarea

    /**
     * 上传附件到服务器并把嵌入语法插入提交 textarea 光标处
     * @param {File} file 用户选中的文件
     * @param {string} kind image / video / file
     */
    async function uploadSubmitAttach(file, kind) {
      try {
        var dataUrl = await readAsDataUrl(file);               // 文件转 dataUrl 上传
        var conv = activeConv();
        var r = await api('/conversations/' + encodeURIComponent(conv.id) + '/homework-attachments', {
          method: 'POST',
          body: JSON.stringify({ kind: kind, name: file.name, dataUrl: dataUrl })
        });
        // 把嵌入语法插入 textarea 光标处
        var nameEsc = r.name.replace(/[\[\]()]/g, '\\$&');
        var urlEsc = r.url.replace(/\)/g, '%29');
        var syntax;
        if (kind === 'image') {
          syntax = '![' + nameEsc + '](' + urlEsc + ')\n';
        } else if (kind === 'video') {
          syntax = '\n<video src="' + urlEsc + '" controls preload="metadata" playsinline width="100%"></video>\n';
        } else {
          syntax = '[' + nameEsc + '](' + urlEsc + ') (' + formatSize(r.size || 0) + ')\n';
        }
        insertTextIntoTextarea(answerTa, syntax);
      } catch (e) {
        window.showToast(e.message, 'error');
      }
    }

    // 工具栏点击：表情 / 图片 / 视频 / 文件
    mask.querySelector('.im-hw-toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('.im-hw-tool');
      if (!btn) return;
      var tool = btn.getAttribute('data-tool');
      if (tool === 'emoji') {
        openEmojiPickerForTextarea(answerTa);
      } else {
        mask.querySelector('#imHwSubmitFile' + (tool === 'image' ? 'Image' : tool === 'video' ? 'Video' : 'Any')).click();
      }
    });
    [['#imHwSubmitFileImage', 'image'], ['#imHwSubmitFileVideo', 'video'], ['#imHwSubmitFileAny', 'file']].forEach(function (pair) {
      mask.querySelector(pair[0]).addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files);
        this.value = '';
        files.forEach(function (f) { uploadSubmitAttach(f, pair[1]); });
      });
    });

    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });
    mask.querySelector('#imHwSubmit').addEventListener('click', async function () {
      var btn = this;                                          // 提交按钮
      var text = mask.querySelector('#imHwAnswer').value.trim();
      if (!text) { window.showToast(imT('im.work.warnAnswer', '请填写作业内容'), 'warning'); return; }
      btn.disabled = true;
      try {
        state.workDetail = await api('/homework/' + encodeURIComponent(item.id) + '/submit', {
          method: 'POST', body: JSON.stringify({ text })
        });
        hideModal(mask);
        window.showToast(imT('im.work.submitted', '作业已提交'), 'success');
        renderWorkDetail();
        loadWorkList();                                        // 顺带刷新列表状态
      } catch (e) {
        btn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  /**
   * 老师批改作业弹窗：等级 + 评语
   * @param {object} sub 学生提交记录
   */
  function openReviewModal(sub) {
    var grades = ['A+', 'A', 'B', 'C', '需修改'];
    var picked = sub.grade || '';                              // 当前选中的等级

    var mask = document.createElement('div');                  // 遮罩
    mask.className = 'im-modal-mask im-modal-page';
    mask.innerHTML =
      '<div class="im-modal im-hw-modal">' +
        '<div class="im-modal-title">' + imT('im.work.reviewTitle', '检查作业') + ' · ' + esc(sub.name) + '</div>' +
        '<div class="im-hw-answer" id="imHwAnswerText"></div>' +
        '<div class="im-hw-field"><div class="im-hw-label">' + imT('im.work.grade', '评语') + '</div>' +
          '<div class="im-hw-subjects" id="imHwGrades">' +
            grades.map(function (g) {
              return '<button type="button" class="im-hw-subject' + (g === picked ? ' active' : '') +
                '" data-grade="' + esc(g) + '">' + esc(g) + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<textarea class="input im-hw-textarea" id="imHwComment" maxlength="500" placeholder="' +
          imT('im.work.commentPlaceholder', '填写本次作业的评语') + '">' + esc(sub.comment || '') + '</textarea>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imHwReview">' + imT('im.work.publishReview', '发布评语') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);
    renderMarkdown(mask.querySelector('#imHwAnswerText'), sub.text);

    mask.querySelector('#imHwGrades').addEventListener('click', function (e) {
      var btn = e.target.closest('.im-hw-subject');
      if (!btn) return;
      picked = btn.getAttribute('data-grade');
      Array.prototype.forEach.call(mask.querySelectorAll('.im-hw-subject'), function (b) {
        b.classList.toggle('active', b === btn);
      });
    });
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });

    mask.querySelector('#imHwReview').addEventListener('click', async function () {
      var btn = this;                                          // 发布按钮
      var comment = mask.querySelector('#imHwComment').value.trim();
      btn.disabled = true;
      try {
        var item = state.workDetail;
        await api('/homework/' + encodeURIComponent(item.id) + '/review', {
          method: 'POST', body: JSON.stringify({ userId: sub.userId, grade: picked, comment })
        });
        hideModal(mask);
        window.showToast(imT('im.work.reviewedToast', '评语已发布'), 'success');
        var detail = await api('/homework/' + encodeURIComponent(item.id));
        state.workDetail = detail;
        renderWorkDetail();
        loadWorkList();
      } catch (e) {
        btn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  // ============ 群相册 ============

  /**
   * 相册页标题：群相册 · 群名
   * @returns {string}
   */
  function albumPageTitle() {
    var conv = activeConv();
    return imT('im.album.title', '群相册') + (conv ? ' · ' + convLabel(conv) : '');
  }

  /**
   * 打开群相册页（仅群聊）：进入后先展示相册列表，也可直接打开某个相册
   * @param {string} [albumId] 指定相册 ID（聊天卡片跳转用）
   * @returns {Promise<void>}
   */
  async function openAlbumsPage(albumId) {
    var conv = activeConv();
    if (!conv || conv.type !== 'group') return;
    if (state.settingsOpen) closeSettings();
    state.albumOpen = true;
    state.albumDetail = null;
    state.albumList = null;
    exitAlbumSelect();
    dom.albumsPage.classList.add('show');
    dom.chatTitle.textContent = albumPageTitle();
    dom.albumsHeadTitle.textContent = albumPageTitle();
    dom.albumsAction.style.display = 'none';                  // 等接口返回后再决定是否显示
    dom.albumsSub.style.display = 'none';
    dom.albumsSelect.style.display = 'none';
    // 移动端：切到右侧内容区
    if (window.innerWidth <= 768) {
      state.mobileMsgOpen = true;
      document.body.classList.add('im-msg-open');
    }
    if (albumId) {
      await openAlbumDetail(albumId);
      return;
    }
    await loadAlbumsList();
  }

  /**
   * 关闭群相册页：恢复聊天标题
   */
  function closeAlbumsPage() {
    exitAlbumSelect();
    state.albumOpen = false;
    state.albumDetail = null;
    state.albumList = null;
    dom.albumsPage.classList.remove('show');
    dom.albumsSub.style.display = 'none';
    dom.albumsSelect.style.display = 'none';
    var conv = activeConv();
    dom.chatTitle.textContent = conv ? convLabel(conv) : imT('im.common.conversation', '会话');
  }

  /**
   * 回到相册列表（详情页点返回时调用）
   */
  function openAlbumsList() {
    state.albumDetail = null;
    state.albumSelectMode = false;
    state.albumSelected = {};
    dom.albumsBatch.classList.remove('show');
    dom.albumsSelect.style.display = 'none';
    dom.albumsSub.style.display = 'none';
    dom.albumsHeadTitle.textContent = albumPageTitle();
    loadAlbumsList();
  }

  /**
   * 拉取当前群的相册列表
   * @returns {Promise<void>}
   */
  async function loadAlbumsList() {
    var conv = activeConv();
    if (!conv) return;
    dom.albumsBody.innerHTML = '<div class="im-album-empty">' + imT('im.album.loading', '加载中…') + '</div>';
    try {
      var data = await api('/conversations/' + encodeURIComponent(conv.id) + '/albums');
      if (!state.albumOpen || state.albumDetail) return;
      state.albumList = data;
      state.albumCanManage = data.canManage === true;
      renderAlbumsList();
    } catch (e) {
      if (!state.albumOpen) return;
      dom.albumsBody.innerHTML = '<div class="im-album-empty">' + esc(e.message) + '</div>';
    }
  }

  /**
   * 渲染相册列表：封面 + 名称 + 创建者，有权限时显示删除按钮
   */
  function renderAlbumsList() {
    var data = state.albumList || { albums: [] };              // 相册列表数据
    var albums = data.albums || [];

    // 右上按钮：有管理权限时显示「新建相册」
    if (state.albumCanManage) {
      dom.albumsAction.style.display = '';
      dom.albumsAction.textContent = imT('im.album.newAlbum', '新建相册');
    } else {
      dom.albumsAction.style.display = 'none';
    }

    if (!albums.length) {
      dom.albumsBody.innerHTML = '<div class="im-album-empty">' +
        imT('im.album.empty', '还没有相册') +
        (state.albumCanManage
          ? '<div class="im-album-empty-sub">' + imT('im.album.emptyHint', '点右上角「新建相册」，上传班级照片吧') + '</div>'
          : '') +
        '</div>';
      return;
    }

    var grid = document.createElement('div');                  // 相册卡片网格
    grid.className = 'im-album-grid';
    albums.forEach(function (album) {
      var card = document.createElement('div');                // 单个相册卡片
      card.className = 'im-album-card';
      card.innerHTML =
        '<div class="im-album-cover">' +
          (album.cover
            ? '<img src="' + esc(album.cover) + '" alt="" loading="lazy">'
            : '<span class="im-album-ph">' + ICON_IMAGE + '</span>') +
          (state.albumCanManage
            ? '<button type="button" class="im-album-menu-btn" title="' +
                esc(imT('im.album.more', '更多')) + '">' + ICON_CHEVRON_DOWN + '</button>'
            : '') +
          '<span class="im-album-count">' + esc(String(album.count)) + '</span>' +
        '</div>' +
        (state.albumCanManage
          ? '<div class="im-album-menu">' +
              '<button type="button" class="im-album-menu-item" data-act="edit">' +
                esc(imT('im.album.edit', '编辑')) + '</button>' +
              '<button type="button" class="im-album-menu-item" data-act="cover">' +
                esc(imT('im.album.setCover', '设置封面')) + '</button>' +
              '<button type="button" class="im-album-menu-item" data-act="delete">' +
                esc(imT('im.album.delete', '删除')) + '</button>' +
            '</div>'
          : '') +
        '<div class="im-album-name">' + esc(album.name) + '</div>';

      card.addEventListener('click', function (e) {
        // 菜单按钮与菜单项由各自逻辑处理，避免误触进入相册详情
        if (e.target.closest('.im-album-menu-btn') || e.target.closest('.im-album-menu')) return;
        openAlbumDetail(album.id);
      });

      var menuBtn = card.querySelector('.im-album-menu-btn');  // 右上角「更多」按钮
      if (menuBtn) {
        menuBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var menu = card.querySelector('.im-album-menu');     // 当前卡片的操作菜单
          var opened = menu.classList.contains('show');        // 菜单是否已展开
          closeAlbumMenus();
          if (!opened) menu.classList.add('show');
        });
      }

      var menu = card.querySelector('.im-album-menu');         // 卡片操作菜单
      if (menu) {
        menu.addEventListener('click', function (e) {
          var item = e.target.closest('.im-album-menu-item');  // 被点击的菜单项
          if (!item) return;
          e.stopPropagation();
          closeAlbumMenus();
          var act = item.dataset.act;                          // 操作类型
          if (act === 'edit') renameAlbumModal(album);
          else if (act === 'cover') openCoverPicker(album);
          else if (act === 'delete') deleteAlbum(album);
        });
      }

      grid.appendChild(card);
    });
    dom.albumsBody.innerHTML = '';
    dom.albumsBody.appendChild(grid);
  }

  /**
   * 关闭所有相册卡片操作菜单
   */
  function closeAlbumMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('.im-album-menu.show'), function (m) {
      m.classList.remove('show');
    });
  }

  /**
   * 编辑相册名称弹窗
   * @param {object} album 相册摘要
   */
  function renameAlbumModal(album) {
    var mask = document.createElement('div');                  // 弹窗遮罩
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal im-contact-modal">' +
        '<div class="im-modal-title">' + imT('im.album.renameTitle', '编辑相册') + '</div>' +
        '<input class="input im-modal-input" id="imAlbumRenameInput" maxlength="20" value="' +
          esc(album.name) + '" placeholder="' + imT('im.album.albumNamePlaceholder', '输入相册名称') + '">' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imAlbumRenameSave">' + imT('im.common.save', '保存') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);
    var input = mask.querySelector('#imAlbumRenameInput');     // 名称输入框
    input.focus();
    input.select();
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });
    var saveBtn = mask.querySelector('#imAlbumRenameSave');    // 保存按钮
    saveBtn.addEventListener('click', async function () {
      var name = input.value.trim();                           // 新的相册名称
      if (!name) { window.showToast(imT('im.album.nameRequired', '请填写相册名称'), 'warning'); return; }
      var conv = activeConv();
      if (!conv) return;
      saveBtn.disabled = true;
      try {
        var data = await api('/conversations/' + encodeURIComponent(conv.id) +
          '/albums/' + encodeURIComponent(album.id), {
          method: 'PATCH',
          body: JSON.stringify({ name: name })
        });
        // 同步列表中的相册数据并重绘
        if (state.albumList && Array.isArray(state.albumList.albums)) {
          state.albumList.albums.forEach(function (a) {
            if (a.id === album.id) a.name = data.name;
          });
        }
        hideModal(mask);
        renderAlbumsList();
        window.showToast(imT('im.album.renamed', '相册名称已更新'), 'success');
      } catch (e) {
        saveBtn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  /**
   * 选择封面弹窗：展示相册内照片，点选一张设为封面
   * @param {object} album 相册摘要
   * @returns {Promise<void>}
   */
  async function openCoverPicker(album) {
    var conv = activeConv();
    if (!conv) return;
    var detail = null;                                          // 相册详情（含照片）
    try {
      detail = await api('/conversations/' + encodeURIComponent(conv.id) +
        '/albums/' + encodeURIComponent(album.id));
    } catch (e) {
      window.showToast(e.message, 'error');
      return;
    }
    var photos = (detail.album && detail.album.photos) || [];
    if (!photos.length) {
      window.showToast(imT('im.album.noPhotos', '相册里还没有照片'), 'warning');
      return;
    }

    var mask = document.createElement('div');                  // 弹窗遮罩
    mask.className = 'im-modal-mask';
    var gridHtml = photos.map(function (p) {
      var active = p.id === (detail.album.coverPhotoId || ''); // 是否为当前封面
      return '<button type="button" class="im-cover-pick' + (active ? ' active' : '') +
        '" data-id="' + esc(p.id) + '"><img src="' + esc(p.src) + '" alt=""></button>';
    }).join('');
    mask.innerHTML =
      '<div class="im-modal im-album-cover-modal">' +
        '<div class="im-modal-title">' + imT('im.album.setCover', '设置封面') + '</div>' +
        '<div class="im-cover-grid">' + gridHtml + '</div>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });
    mask.querySelectorAll('.im-cover-pick').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var photoId = btn.dataset.id;                          // 选中的照片 ID
        try {
          var data = await api('/conversations/' + encodeURIComponent(conv.id) +
            '/albums/' + encodeURIComponent(album.id), {
            method: 'PATCH',
            body: JSON.stringify({ coverPhotoId: photoId })
          });
          // 同步列表封面并重绘
          if (state.albumList && Array.isArray(state.albumList.albums)) {
            state.albumList.albums.forEach(function (a) {
              if (a.id === album.id) {
                a.cover = data.cover;
                a.coverPhotoId = data.coverPhotoId;
              }
            });
          }
          hideModal(mask);
          renderAlbumsList();
          window.showToast(imT('im.album.coverUpdated', '封面已更新'), 'success');
        } catch (e) {
          window.showToast(e.message, 'error');
        }
      });
    });
  }

  /**
   * 打开相册详情（按日期分组的照片流）
   * @param {string} id 相册 ID
   * @returns {Promise<void>}
   */
  async function openAlbumDetail(id) {
    var conv = activeConv();
    if (!conv) return;
    dom.albumsBody.innerHTML = '<div class="im-album-empty">' + imT('im.album.loading', '加载中…') + '</div>';
    try {
      var data = await api('/conversations/' + encodeURIComponent(conv.id) +
        '/albums/' + encodeURIComponent(id));
      if (!state.albumOpen) return;
      state.albumDetail = data.album;
      state.albumCanManage = data.canManage === true;
      state.albumSelectMode = false;
      state.albumSelected = {};
      dom.albumsBatch.classList.remove('show');
      dom.albumsHeadTitle.textContent = data.album.name;
      dom.albumsAction.style.display = '';
      dom.albumsAction.textContent = imT('im.album.upload', '上传至相册');
      dom.albumsSelect.style.display = (data.album.photos || []).length ? '' : 'none';
      dom.albumsSelect.textContent = imT('im.album.select', '选择');
      renderAlbumSub();
      renderAlbumDetail();
    } catch (e) {
      if (!state.albumOpen) return;
      dom.albumsBody.innerHTML = '<div class="im-album-empty">' + esc(e.message) + '</div>';
    }
  }

  /**
   * 渲染相册副标题：创建者与创建时间 / 多选时显示已选数量
   */
  function renderAlbumSub() {
    var album = state.albumDetail;
    if (!album) { dom.albumsSub.style.display = 'none'; return; }
    dom.albumsSub.style.display = '';
    if (state.albumSelectMode) {
      dom.albumsSub.innerHTML = '<span>' +
        esc(imT('im.album.selectedCount', '已选中 {count} 个', { count: selectedPhotoIds().length })) + '</span>';
      dom.albumsSelect.textContent = imT('im.common.cancel', '取消');
      return;
    }
    var created = formatAlbumDate(album.createdAt);
    dom.albumsSub.innerHTML = '<span>' + esc(album.createdByName || '') +
      esc(imT('im.album.createdAt', '于 {date} 创建', { date: created })) + '</span>';
  }

  /**
   * 日期分组标题：首组显示完整年月日，后续显示「M月D日」
   * @param {string} iso 时间
   * @param {boolean} full 是否完整显示年月日
   * @returns {string}
   */
  function albumDayLabel(iso, full) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return full ? (d.getFullYear() + '年' + pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日') : md;
  }

  /**
   * 创建者/创建时间的日期格式：YYYY年MM月DD日
   * @param {string} iso 时间
   * @returns {string}
   */
  function formatAlbumDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '年' + pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日';
  }

  /**
   * 照片时间格式：YYYY年MM月DD日 HH:mm
   * @param {string} iso 时间
   * @returns {string}
   */
  function formatAlbumTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return formatAlbumDate(iso) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /**
   * 数字补零
   * @param {number} n 数字
   * @returns {string}
   */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 渲染相册详情：按日期 + 上传者分组展示照片，支持多选
   */
  function renderAlbumDetail() {
    var album = state.albumDetail;                             // 当前相册
    if (!album) return;
    var photos = album.photos || [];
    renderAlbumSub();

    if (!photos.length) {
      dom.albumsBody.innerHTML = '<div class="im-album-empty">' +
        imT('im.album.noPhotos', '相册里还没有照片') +
        '<div class="im-album-empty-sub">' +
          imT('im.album.noPhotosHint', '点右上角「上传至相册」添加第一张照片') + '</div></div>';
      dom.albumsSelect.style.display = 'none';
      return;
    }

    var wrap = document.createElement('div');                  // 日期分组容器
    dom.albumsSelect.style.display = '';                       // 有照片时才显示「选择」入口
    var lastDay = '';                                          // 上一个日期 key
    var dayBlock = null;                                       // 当前日期分组
    var lastUploader = '';                                     // 当前上传者 ID
    var photoGrid = null;                                       // 当前上传者的照片网格

    photos.forEach(function (photo) {
      var day = String(photo.time || '').slice(0, 10);         // 按自然日分组
      if (day !== lastDay) {
        dayBlock = document.createElement('div');
        dayBlock.className = 'im-album-day';
        var head = document.createElement('div');              // 日期标题
        head.className = 'im-album-day-title';
        head.textContent = albumDayLabel(photo.time, !lastDay);
        dayBlock.appendChild(head);
        wrap.appendChild(dayBlock);
        lastDay = day;
        lastUploader = '';
      }
      if (photo.uploaderId !== lastUploader) {
        var uploader = document.createElement('div');          // 上传者行
        uploader.className = 'im-album-uploader';
        uploader.textContent = photo.uploaderName || imT('im.album.unknownUser', '群成员');
        dayBlock.appendChild(uploader);
        photoGrid = document.createElement('div');
        photoGrid.className = 'im-album-photos';
        dayBlock.appendChild(photoGrid);
        lastUploader = photo.uploaderId;
      }
      photoGrid.appendChild(makeAlbumPhotoCell(photo));
    });

    dom.albumsBody.innerHTML = '';
    dom.albumsBody.appendChild(wrap);
  }

  /**
   * 生成单张照片单元格（多选模式下显示勾选圈）
   * @param {object} photo 照片
   * @returns {HTMLElement}
   */
  function makeAlbumPhotoCell(photo) {
    var item = document.createElement('div');                  // 照片格子
    item.className = 'im-album-photo' + (state.albumSelected[photo.id] ? ' selected' : '');
    item.dataset.id = photo.id;

    var img = document.createElement('img');                   // 照片缩略图
    img.src = photo.src;
    img.alt = imT('im.album.photoAlt', '相册照片');
    img.loading = 'lazy';
    img.title = photo.uploaderName || '';
    item.appendChild(img);

    if (state.albumSelectMode) {
      var check = document.createElement('span');              // 勾选圈
      check.className = 'im-album-check';
      item.appendChild(check);
    }

    item.addEventListener('click', function () {
      if (state.albumSelectMode) {
        if (state.albumSelected[photo.id]) delete state.albumSelected[photo.id];
        else state.albumSelected[photo.id] = true;
        item.classList.toggle('selected', !!state.albumSelected[photo.id]);
        renderAlbumSub();
        return;
      }
      openPhotoDetail(photo);
    });
    return item;
  }

  /**
   * 已选中的照片 ID 列表
   * @returns {Array<string>}
   */
  function selectedPhotoIds() {
    return Object.keys(state.albumSelected).filter(function (id) { return state.albumSelected[id]; });
  }

  /**
   * 已选中的照片对象列表
   * @returns {Array<object>}
   */
  function selectedPhotos() {
    var ids = selectedPhotoIds();
    var photos = (state.albumDetail && state.albumDetail.photos) || [];
    return photos.filter(function (p) { return ids.indexOf(p.id) >= 0; });
  }

  /**
   * 是否可删除某张照片：管理员或上传者本人
   * @param {object} photo 照片
   * @returns {boolean}
   */
  function canDeletePhoto(photo) {
    return state.albumCanManage || photo.uploaderId === (state.me && state.me.id);
  }

  /**
   * 进入 / 退出多选模式
   */
  function toggleAlbumSelect() {
    if (state.albumSelectMode) { exitAlbumSelect(); return; }
    var album = state.albumDetail;
    if (!album || !(album.photos || []).length) return;
    state.albumSelectMode = true;
    state.albumSelected = {};
    dom.albumsBatch.classList.add('show');
    dom.albumsAction.style.display = 'none';
    renderAlbumDetail();
  }

  /**
   * 退出多选模式，恢复普通浏览
   */
  function exitAlbumSelect() {
    state.albumSelectMode = false;
    state.albumSelected = {};
    if (!dom.albumsSelect) return;
    dom.albumsBatch.classList.remove('show');
    dom.albumsSelect.textContent = imT('im.album.select', '选择');
    dom.albumsSelect.style.display = state.albumDetail ? '' : 'none';
    if (state.albumDetail) {
      dom.albumsAction.style.display = '';
      renderAlbumDetail();
    }
  }

  /**
   * 全选 / 取消全选
   */
  function toggleAlbumSelectAll() {
    var photos = (state.albumDetail && state.albumDetail.photos) || [];
    var allSelected = photos.length > 0 && selectedPhotoIds().length === photos.length;
    state.albumSelected = {};
    if (!allSelected) photos.forEach(function (p) { state.albumSelected[p.id] = true; });
    renderAlbumDetail();
  }

  /**
   * 批量下载选中照片（浏览器逐个保存）
   * @returns {Promise<void>}
   */
  async function downloadSelectedPhotos() {
    var photos = selectedPhotos();
    if (!photos.length) {
      window.showToast(imT('im.album.pickFirst', '请先选择照片'), 'warning');
      return;
    }
    var album = state.albumDetail;
    for (var i = 0; i < photos.length; i++) {
      try {
        var res = await fetch(photos[i].src);                  // 同源请求，自动带登录态
        if (!res.ok) continue;
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');                   // 触发下载
        a.href = url;
        a.download = (album.name || '相册') + '-' + (i + 1) + '.' + ((blob.type.split('/')[1]) || 'jpg');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      } catch (_) { /* 单张失败不影响其余照片 */ }
    }
  }

  /**
   * 批量删除选中照片（仅删除自己有权限的照片）
   * @returns {Promise<void>}
   */
  async function deleteSelectedPhotos() {
    var conv = activeConv();                                   // 当前会话
    var album = state.albumDetail;
    if (!conv || !album) return;
    var photos = selectedPhotos().filter(canDeletePhoto);
    if (!photos.length) {
      window.showToast(imT('im.album.noDeletable', '没有可删除的照片'), 'warning');
      return;
    }
    var yes = await confirmDialog({
      title: imT('im.album.batchDelete', '批量删除'),
      text: imT('im.album.batchDeleteText', '确定删除选中的 {count} 张照片吗？', { count: photos.length }),
      okText: imT('im.common.delete', '删除'),
      danger: true
    });
    if (!yes) return;

    var deleted = [];                                          // 已删除的照片 ID
    for (var i = 0; i < photos.length; i++) {
      try {
        await api('/conversations/' + encodeURIComponent(conv.id) + '/albums/' +
          encodeURIComponent(album.id) + '/photos/' + encodeURIComponent(photos[i].id), { method: 'DELETE' });
        deleted.push(photos[i].id);
      } catch (_) { /* 单张失败继续处理其余照片 */ }
    }
    album.photos = (album.photos || []).filter(function (p) { return deleted.indexOf(p.id) < 0; });
    exitAlbumSelect();
    window.showToast(imT('im.album.batchDeleted', '已删除 {count} 张照片', { count: deleted.length }), 'success');
  }

  /**
   * 照片详情弹窗：大图 + 上传者 + 时间 + 点赞 + 评论
   * @param {object} photo 照片对象（与 state.albumDetail 中同一引用）
   */
  function openPhotoDetail(photo) {
    var conv = activeConv();
    var album = state.albumDetail;
    if (!conv || !album) return;

    var mask = document.createElement('div');                  // 弹窗遮罩
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal im-photo-modal">' +
        '<div class="im-photo-modal-head">' +
          '<span>' + imT('im.album.detail', '详情') + '</span>' +
          '<button class="im-photo-modal-close" type="button">×</button>' +
        '</div>' +
        '<div class="im-photo-modal-body">' +
          '<div class="im-photo-modal-figure"><img alt=""></div>' +
          '<div class="im-photo-modal-meta">' +
            '<span class="im-photo-modal-user"></span>' +
            '<span class="im-photo-modal-time"></span>' +
          '</div>' +
          '<div class="im-photo-modal-actions">' +
            '<button class="im-photo-like" type="button"></button>' +
            '<button class="im-photo-del" type="button">' + imT('im.common.delete', '删除') + '</button>' +
          '</div>' +
          '<div class="im-photo-comments"></div>' +
          '<div class="im-photo-comment-form">' +
            '<input class="input im-photo-comment-input" maxlength="200" ' +
              'placeholder="' + imT('im.album.commentPlaceholder', '写评论…') + '">' +
            '<button class="btn btn-column2 im-photo-comment-send" type="button">' +
              imT('im.album.sendComment', '发送') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    showModal(mask);

    var figure = mask.querySelector('.im-photo-modal-figure img');  // 大图
    figure.src = photo.src;
    mask.querySelector('.im-photo-modal-user').textContent = photo.uploaderName || '';
    mask.querySelector('.im-photo-modal-time').textContent = formatAlbumTime(photo.time);
    mask.querySelector('.im-photo-modal-close').addEventListener('click', function () { hideModal(mask); });
    mask.addEventListener('click', function (e) { if (e.target === mask) hideModal(mask); });

    /**
     * 刷新点赞按钮与评论列表
     */
    function renderPhotoMeta() {
      var likeBtn = mask.querySelector('.im-photo-like');
      likeBtn.textContent = (photo.liked ? imT('im.album.liked', '已赞') : imT('im.album.like', '赞')) +
        (photo.likeCount ? ' ' + photo.likeCount : '');
      likeBtn.classList.toggle('liked', !!photo.liked);

      var box = mask.querySelector('.im-photo-comments');
      var comments = photo.comments || [];
      box.innerHTML = comments.length
        ? comments.map(function (c) {
            return '<div class="im-photo-comment"><b>' + esc(c.userName || '') + '</b>' +
              '<span>' + esc(c.text) + '</span></div>';
          }).join('')
        : '<div class="im-photo-comments-empty">' + imT('im.album.noComments', '还没有评论') + '</div>';
    }
    renderPhotoMeta();

    // 点赞 / 取消点赞
    mask.querySelector('.im-photo-like').addEventListener('click', async function () {
      try {
        var data = await api('/conversations/' + encodeURIComponent(conv.id) + '/albums/' +
          encodeURIComponent(album.id) + '/photos/' + encodeURIComponent(photo.id) + '/like', { method: 'POST' });
        photo.liked = data.liked;
        photo.likeCount = data.likeCount;
        renderPhotoMeta();
      } catch (e) {
        window.showToast(e.message, 'error');
      }
    });

    // 删除照片（仅上传者本人或管理员可见）
    var delBtn = mask.querySelector('.im-photo-del');
    if (!canDeletePhoto(photo)) delBtn.style.display = 'none';
    delBtn.addEventListener('click', async function () {
      hideModal(mask);
      await deleteAlbumPhoto(photo);
    });

    // 发送评论
    var input = mask.querySelector('.im-photo-comment-input');
    var sendBtn = mask.querySelector('.im-photo-comment-send');
    async function sendComment() {
      var text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        var data = await api('/conversations/' + encodeURIComponent(conv.id) + '/albums/' +
          encodeURIComponent(album.id) + '/photos/' + encodeURIComponent(photo.id) + '/comments', {
          method: 'POST',
          body: JSON.stringify({ text: text })
        });
        photo.comments = data.comments || [];
        input.value = '';
        renderPhotoMeta();
      } catch (e) {
        window.showToast(e.message, 'error');
      } finally {
        sendBtn.disabled = false;
      }
    }
    sendBtn.addEventListener('click', sendComment);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendComment();
    });
  }

  /**
   * 新建相册弹窗
   */
  function openAlbumNameModal() {
    var mask = document.createElement('div');                  // 遮罩
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal im-contact-modal">' +
        '<div class="im-modal-title">' + imT('im.album.newAlbum', '新建相册') + '</div>' +
        '<input class="input im-modal-input" id="imAlbumNameInput" maxlength="20" ' +
          'placeholder="' + imT('im.album.albumNamePlaceholder', '输入相册名称') + '">' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imAlbumNameSave">' + imT('im.album.create', '创建') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.dataset.act === 'cancel') hideModal(mask);
    });
    mask.querySelector('#imAlbumNameSave').addEventListener('click', async function () {
      var btn = this;                                          // 创建按钮
      var name = mask.querySelector('#imAlbumNameInput').value.trim();
      if (!name) { window.showToast(imT('im.album.nameRequired', '请填写相册名称'), 'warning'); return; }
      var conv = activeConv();
      if (!conv) return;
      btn.disabled = true;
      try {
        await api('/conversations/' + encodeURIComponent(conv.id) + '/albums', {
          method: 'POST',
          body: JSON.stringify({ name: name })
        });
        hideModal(mask);
        window.showToast(imT('im.album.created', '相册已创建'), 'success');
        loadAlbumsList();
      } catch (e) {
        btn.disabled = false;
        window.showToast(e.message, 'error');
      }
    });
  }

  /**
   * 上传照片到当前相册（所有群成员都可以上传）
   * @param {Array<File>} files 用户选中的本地图片
   * @returns {Promise<void>}
   */
  async function uploadAlbumPhotos(files) {
    var album = state.albumDetail;                             // 当前相册
    var conv = activeConv();
    if (!album || !conv || !files.length) return;
    if (files.length > 9) {
      window.showToast(imT('im.album.tooMany', '一次最多上传 9 张照片'), 'warning');
      return;
    }
    var btn = dom.albumsAction;                                // 上传按钮（显示进度）
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = imT('im.album.uploading', '上传中…');
    try {
      var photos = [];                                         // 图片 dataUrl 列表
      for (var i = 0; i < files.length; i++) {
        if (files[i].size > 5 * 1024 * 1024) {
          throw new Error(imT('im.album.tooLarge', '单张图片不能超过 5MB'));
        }
        photos.push(await readAsDataUrl(files[i]));
      }
      var data = await api('/conversations/' + encodeURIComponent(conv.id) +
        '/albums/' + encodeURIComponent(album.id) + '/photos', {
        method: 'POST',
        body: JSON.stringify({ photos: photos })
      });
      if (!state.albumDetail || state.albumDetail.id !== album.id) return;
      state.albumDetail.photos = (data.photos || []).concat(state.albumDetail.photos || []);
      renderAlbumDetail();
      window.showToast(imT('im.album.uploaded', '{count} 张照片已上传', { count: photos.length }), 'success');
    } catch (e) {
      window.showToast(e.message || imT('im.album.uploadFailed', '上传失败，请重试'), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /**
   * 删除相册（含照片文件）
   * @param {object} album 相册摘要
   * @returns {Promise<void>}
   */
  async function deleteAlbum(album) {
    var conv = activeConv();
    if (!conv) return;
    var yes = await confirmDialog({
      title: imT('im.album.deleteAlbum', '删除相册'),
      text: imT('im.album.deleteAlbumText', '删除「{name}」后其中的照片将一并移除，无法恢复。', { name: album.name }),
      okText: imT('im.common.delete', '删除'),
      danger: true
    });
    if (!yes) return;
    try {
      await api('/conversations/' + encodeURIComponent(conv.id) +
        '/albums/' + encodeURIComponent(album.id), { method: 'DELETE' });
      window.showToast(imT('im.album.deleted', '相册已删除'), 'success');
      loadAlbumsList();
    } catch (e) {
      window.showToast(e.message, 'error');
    }
  }

  /**
   * 删除单张照片
   * @param {object} photo 照片对象
   * @returns {Promise<void>}
   */
  async function deleteAlbumPhoto(photo) {
    var conv = activeConv();
    var album = state.albumDetail;
    if (!conv || !album) return;
    var yes = await confirmDialog({
      title: imT('im.album.deletePhoto', '删除照片'),
      text: imT('im.album.deletePhotoText', '确定删除这张照片吗？'),
      okText: imT('im.common.delete', '删除'),
      danger: true
    });
    if (!yes) return;
    try {
      await api('/conversations/' + encodeURIComponent(conv.id) + '/albums/' +
        encodeURIComponent(album.id) + '/photos/' + encodeURIComponent(photo.id), { method: 'DELETE' });
      album.photos = (album.photos || []).filter(function (p) { return p.id !== photo.id; });
      renderAlbumDetail();
      window.showToast(imT('im.album.photoDeleted', '照片已删除'), 'success');
    } catch (e) {
      window.showToast(e.message, 'error');
    }
  }

  // ============ 打开会话 / 消息渲染 ============

  /**
   * 打开指定会话：加载消息、标记已读、开始轮询
   * @param {string} convId 会话 ID
   * @returns {Promise<void>}
   */
  async function selectConv(convId) {
    var conv = state.convs.find(function (c) { return c.id === convId; });
    if (!conv) return;

    if (state.settingsOpen) closeSettings();                   // 切换会话时退出设置视图
    if (state.friendsOpen) {                                   // 切换会话时关闭新朋友页
      state.friendsOpen = false;
      dom.friendsPage.classList.remove('show');
    }
    if (state.workOpen) closeWorkPage();                       // 切换会话时关闭群作业页
    // 切换会话时清空搜索，避免列表一直停留在筛选状态
    if (state.searchQuery) {
      state.searchQuery = '';
      dom.searchInput.value = '';
      dom.searchClear.classList.remove('show');
    }
    state.membersExpanded = false;
    state.detail = null;
    state.activeId = convId;
    state.quote = null;
    dom.quoteBar.classList.remove('show');
    dom.chatTitle.textContent = convLabel(conv);
    dom.chatEmpty.style.display = 'none';

    // 同步地址栏为分享格式：群聊 g{群号}，单聊 i{对方用户ID}，方便直接复制链接
    var linkKey = '';
    if (conv.type === 'group') {
      linkKey = 'g' + conv.code;
    } else {
      var peer = (conv.members || []).find(function (m) { return m && m.id !== state.me.id; });
      if (peer) linkKey = 'i' + peer.id;
    }
    if (linkKey && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', location.pathname + '?conversation=' + encodeURIComponent(linkKey));
    }

    // 移动端：切到聊天视图
    if (window.innerWidth <= 768) {
      state.mobileMsgOpen = true;
      document.body.classList.add('im-msg-open');
    }

    renderConvList();
    try {
      state.messages = await api('/conversations/' + encodeURIComponent(convId) + '/messages');
    } catch (e) {
      window.showToast(e.message, 'error');
      state.messages = [];
    }
    state.lastMsgId = state.messages.length ? state.messages[state.messages.length - 1].id : '';
    renderMessages();

    // 标记已读（未读角标立即清零）
    api('/conversations/' + encodeURIComponent(convId) + '/read', { method: 'POST' })
      .then(function () {
        var c = state.convs.find(function (x) { return x.id === convId; });
        if (c) c.unread = 0;
        renderConvList();
      })
      .catch(function () { /* 已读失败不影响聊天 */ });

    startMsgPoll();
  }

  /**
   * 全量渲染当前会话消息（带日期分隔与滚动到底部）
   */
  function renderMessages() {
    dom.history.innerHTML = '';
    var prevTime = '';                                         // 上一条消息时间（判断是否跨天）
    state.messages.forEach(function (msg) {
      if (!sameDay(prevTime, msg.time)) {
        dom.history.appendChild(makeDayDivider(msg.time));
      }
      dom.history.appendChild(makeMsgRow(msg));
      prevTime = msg.time;
    });
    scrollToBottom();
  }

  /**
   * 构造日期分隔条
   * @param {string} iso 消息时间
   * @returns {HTMLElement}
   */
  function makeDayDivider(iso) {
    var div = document.createElement('div');                   // 分隔条容器
    div.className = 'im-day';
    div.textContent = dayLabel(iso);
    return div;
  }

  /**
   * 生成文件消息卡片（文件名 + 大小 + 文件图标，点击下载）
   * @param {object} part 文件片段 { name, size, url }
   * @returns {HTMLElement} 文件卡片节点
   */
  function makeFileCard(part) {
    var card = document.createElement('a');                    // 整张卡片可点击下载
    card.className = 'im-file-card';
    card.href = part.url;
    card.setAttribute('download', part.name || '');

    var info = document.createElement('div');                  // 左侧信息区
    info.className = 'im-file-info';

    var name = document.createElement('div');                  // 文件名（最多两行）
    name.className = 'im-file-name';
    name.textContent = part.name || '文件';
    name.title = part.name || '';

    var size = document.createElement('div');                  // 文件大小
    size.className = 'im-file-size';
    size.textContent = formatSize(part.size);

    info.appendChild(name);
    info.appendChild(size);

    var icon = document.createElement('span');                 // 右侧文件图标
    icon.className = 'im-file-icon';
    icon.innerHTML = ICON_FILE;

    card.appendChild(info);
    card.appendChild(icon);
    return card;
  }

  /**
   * 生成群相册卡片消息（新建相册 / 上传照片时群里展示）
   * 布局对齐 Figma「群相册6 / 群相册7」
   * @param {object} part 卡片数据 { albumId, albumName, action, count, cover }
   * @returns {HTMLElement} 卡片节点
   */
  function makeAlbumCard(part) {
    var card = document.createElement('div');                   // 卡片容器
    var isUpload = part.action === 'upload';                    // 是否「上传照片」卡片
    card.className = 'im-album-card-msg' + (isUpload ? ' upload' : '');

    var title = isUpload
      ? imT('im.album.cardAlbum', '群相册《{name}》', { name: part.albumName || '' })
      : imT('im.album.cardCreate', '创建了群相册《{name}》', { name: part.albumName || '' });

    if (isUpload) {
      // 上传卡片：封面大图 + 灰色数量说明 + 相册名
      card.innerHTML =
        (part.cover
          ? '<img class="im-album-msg-cover" src="' + esc(part.cover) + '" alt="" loading="lazy">'
          : '<div class="im-album-msg-hero">' + ICON_ALBUM_HERO + '</div>') +
        '<div class="im-album-msg-count">' +
          esc(imT('im.album.cardUpload', '上传{count}张照片', { count: part.count || 0 })) + '</div>' +
        '<div class="im-album-msg-title">' + esc(title) + '</div>' +
        '<div class="im-album-msg-line"></div>' +
        '<div class="im-album-msg-foot">' + ICON_ALBUM_TAG +
          '<span>' + esc(imT('im.album.title', '群相册')) + '</span></div>';
    } else {
      // 新建卡片：渐变插画 + 说明文字 + 去上传按钮
      card.innerHTML =
        '<div class="im-album-msg-hero">' + ICON_ALBUM_HERO + '</div>' +
        '<div class="im-album-msg-title">' + esc(title) + '</div>' +
        '<button type="button" class="im-album-msg-btn">' +
          esc(imT('im.album.cardGo', '去上传')) + '</button>' +
        '<div class="im-album-msg-line"></div>' +
        '<div class="im-album-msg-foot">' + ICON_ALBUM_TAG +
          '<span>' + esc(imT('im.album.title', '群相册')) + '</span></div>';
    }

    card.addEventListener('click', function () { openAlbumFromChat(part.albumId); });
    return card;
  }

  /**
   * 从聊天卡片进入相册：确保在群会话中并直接打开对应相册
   * @param {string} albumId 相册 ID
   */
  function openAlbumFromChat(albumId) {
    var conv = activeConv();
    if (!conv || conv.type !== 'group') return;
    openAlbumsPage(albumId);
  }

  /** 全角标点：linkify 可能把它并入地址，识别后再按标点拆分 */
  var FULLWIDTH_RE = /([\u3000-\u303f\uff00-\uffef]+)/;
  /** 地址末尾的 ASCII 标点（识别后剔除） */
  var LINK_TRAIL_RE = /[).,;:!?]+$/;

  /**
   * 生成消息内的链接元素（新窗口打开，点击不触发消息选中）
   * @param {string} label 显示文本
   * @param {string} href 跳转地址
   * @returns {HTMLAnchorElement}
   */
  function makeTextLink(label, href) {
    var link = document.createElement('a');
    link.className = 'im-link';
    link.href = href;
    link.textContent = label;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', function (e) { e.stopPropagation(); });
    return link;
  }

  /**
   * 用 linkifyjs 识别文本中的链接并渲染为可点击超链接
   * 先把文本按全角标点切块（linkify 会把它并入地址），再逐块识别，避免递归
   * 非链接部分用文本节点插入，保留原有换行与空格
   * @param {HTMLElement} container 目标容器
   * @param {string} text 原始文本
   */
  function appendTextWithLinks(container, text) {
    var raw = String(text == null ? '' : text);
    var lib = window.linkify;                                  // linkifyjs 全局对象
    if (!lib || typeof lib.find !== 'function') {
      container.appendChild(document.createTextNode(raw));     // 库未加载时退化为纯文本
      return;
    }
    // 按全角标点切块：标点单独成块直接输出，其余块交给 linkify 识别
    raw.split(FULLWIDTH_RE).forEach(function (chunk) {
      if (!chunk) return;
      if (FULLWIDTH_RE.test(chunk)) {
        container.appendChild(document.createTextNode(chunk));
        return;
      }
      var last = 0;                                            // 当前块内已处理到的位置
      lib.find(chunk).forEach(function (m) {
        if (!m || !m.isLink || m.start < last) return;
        if (m.start > last) container.appendChild(document.createTextNode(chunk.slice(last, m.start)));
        if (m.type === 'email') {
          container.appendChild(makeTextLink(m.value, m.href));
        } else {
          var url = m.value.replace(LINK_TRAIL_RE, '');        // 去掉尾部 ASCII 标点
          // 裸域名（如 ptszx.idsp.yunxiao.com）没有协议，必须补 https://，否则会被当成站内相对路径
          var href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
          container.appendChild(makeTextLink(url, href));
          var tail = m.value.slice(url.length);                // 被剔除的尾部标点
          if (tail) container.appendChild(document.createTextNode(tail));
        }
        last = m.end;
      });
      if (last < chunk.length) container.appendChild(document.createTextNode(chunk.slice(last)));
    });
  }

  /**
   * 构造单条消息 DOM
   * @param {object} msg 消息对象
   * @returns {HTMLElement} 消息行
   */
  function makeMsgRow(msg) {
    var row = document.createElement('div');                   // 消息行
    var isSelf = msg.senderId === state.me.id;                 // 是否自己发送

    row.className = 'im-msg ' + (msg.recalled ? 'im-msg-recall' : (isSelf ? 'im-msg-self' : 'im-msg-other'));
    row.dataset.id = msg.id;

    // 撤回消息：居中灰色提示，无头像无气泡（群聊展示群昵称）
    if (msg.recalled) {
      row.innerHTML = '<div class="im-recall-text">' + esc(recallTextFor(msg, activeConv())) + '</div>';
      return row;
    }

    // 头像 + 内容（群聊里头像与姓名都用群昵称对应的展示名）
    var displayName = senderNameFor(activeConv(), msg.senderId, msg.senderName, msg.senderNick);   // 展示用发送者名称
    var avatar = makeAvatar(displayName, msg.senderId, 'im-avatar-sm');
    // 群聊支持长按头像 @ 人（单聊不显示 @）
    if (activeConv() && activeConv().type === 'group') bindAvatarMention(avatar, displayName);
    var main = document.createElement('div');                   // 消息内容容器
    main.className = 'im-msg-main';

    var head = document.createElement('div');                   // 发送者姓名 + 身份标（群聊/他人消息显示）
    head.className = 'im-sender';
    head.innerHTML = roleBadgeHtml(msg.senderRole) + '<span class="im-sender-name">' + esc(displayName) + '</span>';
    // 自己发送的消息默认不显示名字；但设置过身份标（班主任/老师/家委）时展示「身份标 + 群昵称」
    if (isSelf && !msg.senderRole) head.style.display = 'none';

    var quote = null;
    if (msg.quote) {
      quote = document.createElement('div');                    // 引用块
      quote.className = 'im-quote';
      quote.textContent = imT('im.chat.quoteLine', '{name}：{text}', { name: msg.quote.name, text: msg.quote.text });
    }

    var bubble = document.createElement('div');                 // 消息气泡
    bubble.className = 'im-bubble';

    /**
     * 生成可点击查看原图的图片节点
     * @param {string} src 图片地址
     * @returns {HTMLElement}
     */
    function makePic(src) {
      var pic = document.createElement('img');
      pic.className = 'im-bubble-img';
      pic.src = src;
      pic.alt = imT('im.chat.imageAlt', '图片');
      pic.addEventListener('click', function () { window.open(src, '_blank'); });
      return pic;
    }

    if (Array.isArray(msg.parts) && msg.parts.length) {
      // 图文 / 表情混排：按顺序渲染文字、图片与表情
      var hasText = msg.parts.some(function (p) { return p.type === 'text'; });
      var hasImage = msg.parts.some(function (p) { return p.type === 'image'; });
      var hasEmoji = msg.parts.some(function (p) { return p.type === 'emoji'; });
      // 只有「单个表情、没有文字和图片」时才按超级表情展示：120×120、无气泡底色
      // 连续发送多个表情时仍按小表情混排，避免整条消息被放大
      var emojiOnly = hasEmoji && !hasText && !hasImage && msg.parts.length === 1;
      if (!hasText && !hasEmoji) bubble.className += ' im-bubble-media';  // 纯图片消息去掉气泡底色
      if (emojiOnly) {
        bubble.className += ' im-bubble-super';
      } else {
        bubble.className += ' im-bubble-rich';
        if (hasEmoji) bubble.className += ' im-bubble-emoji-rich'; // 表情与文字同行显示
      }
      msg.parts.forEach(function (part) {
        if (part.type === 'image') { bubble.appendChild(makePic(part.src)); return; }
        if (part.type === 'file') { bubble.appendChild(makeFileCard(part)); return; }
        if (part.type === 'emoji') {
          var em = document.createElement('img');               // 气泡内的表情（APNG）
          em.className = 'im-bubble-emoji';
          em.src = '/im/emoji/' + part.code + '.png';
          em.alt = '[表情]';
          bubble.appendChild(em);
          return;
        }
        if (part.type === 'homework') {                          // 群作业卡片
          bubble.appendChild(makeHomeworkCard(part));
          return;
        }
        if (part.type === 'album') {                             // 群相册卡片
          bubble.appendChild(makeAlbumCard(part));
          return;
        }
        var span = document.createElement('span');
        span.className = 'im-bubble-text';
        appendTextWithLinks(span, part.text);                    // 文本中的链接自动转成可点击
        bubble.appendChild(span);
      });
    } else if (msg.image) {
      bubble.className += ' im-bubble-media';
      bubble.appendChild(makePic(msg.image));
    } else {
      appendTextWithLinks(bubble, msg.text);                     // 旧数据：纯文本消息同样识别链接
    }

    main.appendChild(head);
    if (quote) main.appendChild(quote);
    main.appendChild(bubble);

    row.appendChild(avatar);
    row.appendChild(main);

    // 右键菜单（仅未撤回消息）
    bubble.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openCtx(msg.id, e.clientX, e.clientY);
    });
    // iOS / 触屏：长按气泡呼出同一菜单（Safari 不会触发 contextmenu）
    bindLongPress(bubble, function (x, y) { openCtx(msg.id, x, y); });
    return row;
  }

  /**
   * 滚动到消息底部
   */
  function scrollToBottom() {
    dom.history.scrollTop = dom.history.scrollHeight;
  }

  /**
   * 增量追加新消息（轮询/发送后调用）
   * @param {object} msg 消息对象
   */
  function appendMessage(msg) {
    if (!msg || state.messages.some(function (m) { return m.id === msg.id; })) return;  // 去重
    var prev = state.messages.length ? state.messages[state.messages.length - 1] : null;
    if (!prev || !sameDay(prev.time, msg.time)) {
      dom.history.appendChild(makeDayDivider(msg.time));
    }
    state.messages.push(msg);
    state.lastMsgId = msg.id;
    dom.history.appendChild(makeMsgRow(msg));
    scrollToBottom();
    dom.chatEmpty.style.display = 'none';
  }

  // ============ 发送 ============

  /**
   * 发送当前输入区内容（文字或图文混排，支持引用）
   * @returns {Promise<void>}
   */
  async function sendMessage() {
    if (!state.activeId) {
      window.showToast(imT('im.chat.toastNeedConversation', '请先选择一个会话'), 'warning');
      return;
    }

    var parsed = serializeEditor();                             // 输入区的有序片段
    if (!parsed.parts.length) return;

    dom.send.disabled = true;                                   // 防重复点击
    try {
      var msg;
      if (parsed.hasImage || parsed.hasEmoji) {
        // 含图片或表情：走图文接口，图片由服务端落盘，表情只记录编码
        msg = await api('/conversations/' + encodeURIComponent(state.activeId) + '/images', {
          method: 'POST',
          body: JSON.stringify({ parts: parsed.parts })
        });
      } else {
        var text = parsed.parts.map(function (p) { return p.text; }).join('');   // 纯文字
        var payload = { text: text };                           // 请求体
        if (state.quote) payload.quoteId = state.quote.id;
        msg = await api('/conversations/' + encodeURIComponent(state.activeId) + '/messages', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
      appendMessage(msg);
      clearEditor();
      clearQuote();
      loadConvs();                                              // 刷新列表预览与排序
    } catch (e) {
      window.showToast(e.message, 'error');
    } finally {
      dom.send.disabled = false;
      dom.input.focus();
    }
  }

  /**
   * 清除引用状态
   */
  function clearQuote() {
    state.quote = null;
    dom.quoteBar.classList.remove('show');
    dom.quoteText.textContent = '';
  }

  // ============ 右键菜单 ============

  /**
   * 打开消息右键菜单（位置自动限制在视口内）
   * @param {string} msgId 消息 ID
   * @param {number} x 鼠标 X
   * @param {number} y 鼠标 Y
   */
  function openCtx(msgId, x, y) {
    hideCtx();
    var msg = state.messages.find(function (m) { return m.id === msgId; });
    if (!msg) return;

    var menu = document.createElement('div');                  // 右键菜单容器
    menu.className = 'im-ctx';
    menu.id = 'imCtx';

    var items = [
      { op: 'copy', label: imT('im.chat.ctxCopy', '复制文本') },
      { op: 'quote', label: imT('im.chat.ctxQuote', '引用回复') },
      { op: 'delete', label: imT('im.chat.ctxDelete', '删除（本地）') }
    ];
    if (msg.senderId === state.me.id) {
      items.push({ op: 'recall', label: imT('im.chat.ctxRecall', '撤回消息') });
    } else if (canRecallOthers(activeConv())) {
      // 班主任 / 老师 / 家委 / 群主 / 管理员：可撤回成员消息
      items.push({ op: 'recall', label: imT('im.chat.ctxRecallMember', '撤回成员消息') });
    }

    items.forEach(function (it, idx) {
      if (idx === 2) {                                         // 「删除」前插入分隔线
        var divider = document.createElement('div');
        divider.className = 'im-ctx-divider';
        menu.appendChild(divider);
      }
      var row = document.createElement('div');                 // 菜单项
      row.className = 'im-ctx-item';
      row.textContent = it.label;
      row.dataset.op = it.op;
      menu.appendChild(row);
    });

    menu.addEventListener('click', function (e) {
      var op = e.target && e.target.dataset ? e.target.dataset.op : '';
      if (op) handleCtx(op, msg);
      hideCtx();
    });

    document.body.appendChild(menu);

    // 视口边界钳制：贴边时向内收，避免菜单超出屏幕
    var mw = menu.offsetWidth;                                 // 菜单宽度
    var mh = menu.offsetHeight;                                // 菜单高度
    var left = Math.min(x, window.innerWidth - mw - 8);        // 安全左坐标
    var top = Math.min(y, window.innerHeight - mh - 8);        // 安全上坐标
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
  }

  /**
   * 关闭右键菜单
   */
  function hideCtx() {
    var menu = $('#imCtx');
    if (menu) menu.remove();
  }

  /**
   * 处理右键菜单操作
   * @param {string} op 操作类型：copy / quote / delete / recall
   * @param {object} msg 目标消息
   * @returns {Promise<void>}
   */
  async function handleCtx(op, msg) {
    if (op === 'copy') {
      try {
        await navigator.clipboard.writeText(msg.text);
        window.showToast(imT('im.chat.toastCopied', '已复制'), 'success');
      } catch (e) {
        window.showToast(imT('im.chat.toastCopyFailed', '复制失败，请手动选择文本'), 'error');
      }
      return;
    }

    if (op === 'quote') {
      state.quote = { id: msg.id, name: senderNameFor(activeConv(), msg.senderId, msg.senderName, msg.senderNick), text: String(msg.text).slice(0, 60) };
      dom.quoteText.textContent = imT('im.chat.quoteBar', '引用 {name}：{text}', {
        name: state.quote.name, text: state.quote.text
      });
      dom.quoteBar.classList.add('show');
      dom.input.focus();
      return;
    }

    if (op === 'delete') {
      try {
        await api('/messages/' + encodeURIComponent(msg.id), { method: 'DELETE' });
        state.messages = state.messages.filter(function (m) { return m.id !== msg.id; });
        renderMessages();
        loadConvs();
        window.showToast(imT('im.chat.toastDeleted', '已本地删除'), 'info');
      } catch (e) {
        window.showToast(e.message, 'error');
      }
      return;
    }

    if (op === 'recall') {
      try {
        await api('/messages/' + encodeURIComponent(msg.id) + '/recall', { method: 'POST' });
        var target = state.messages.find(function (m) { return m.id === msg.id; });
        if (target) {
          target.recalled = true;
          target.recalledBy = state.me.id;                       // 立即标记操作者，保证提示文案正确
          target.text = '';
          target.quote = null;
        }
        renderMessages();
        loadConvs();
        window.showToast(imT('im.chat.toastRecalled', '已撤回一条消息'), 'info');
      } catch (e) {
        window.showToast(e.message, 'error');
      }
    }
  }

  // ============ 轮询同步 ============

  /**
   * 判断服务端返回的消息列表与当前列表是否有差异
   * 只比较「长度 + 每条 ID + 撤回标记」：无需比对正文，足够覆盖新增、撤回、删除三种变化
   * @param {Array<object>} list 服务端返回的最新消息列表
   * @returns {boolean} 有变化返回 true
   */
  function msgListChanged(list) {
    if (list.length !== state.messages.length) return true;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];                                         // 服务端消息
      var b = state.messages[i];                               // 本地消息
      if (a.id !== b.id || !!a.recalled !== !!b.recalled) return true;
    }
    return false;
  }

  /**
   * 启动消息轮询（2 秒一次全量拉取并比对；页面不可见时跳过）
   * 为什么用全量而不是 after 增量：增量只能看到新消息，
   * 无法感知「他人撤回了较早的消息」，会导致多端显示不一致。
   */
  function startMsgPoll() {
    stopMsgPoll();
    state.msgTimer = setInterval(async function () {
      if (!state.activeId || document.visibilityState !== 'visible') return;
      var convId = state.activeId;                             // 本次轮询对应的会话 ID
      try {
        var list = await api('/conversations/' + encodeURIComponent(convId) + '/messages');
        if (state.activeId !== convId) return;                 // 请求期间已切到别的会话，丢弃结果
        if (!msgListChanged(list)) return;                     // 无变化不重绘，避免界面闪动

        var hadNew = list.length > state.messages.length;       // 是否有新消息到达
        state.messages = list;
        state.lastMsgId = list.length ? list[list.length - 1].id : '';
        renderMessages();

        // 有新消息且会话仍处于打开状态：静默标记已读，避免把自己已看的消息算未读
        if (hadNew) {
          api('/conversations/' + encodeURIComponent(convId) + '/read', { method: 'POST' })
            .then(function () {
              var c = state.convs.find(function (x) { return x.id === convId; });
              if (c) c.unread = 0;
              renderConvList();
            })
            .catch(function () { /* 已读失败静默 */ });
        }
      } catch (e) { /* 轮询失败静默重试，避免打扰用户 */ }
    }, 2000);
  }

  /**
   * 停止消息轮询
   */
  function stopMsgPoll() {
    if (state.msgTimer) { clearInterval(state.msgTimer); state.msgTimer = null; }
  }

  /**
   * 启动会话列表轮询（3 秒一次；页面不可见时跳过）
   */
  function startTickPoll() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      loadConvs();
    }, 3000);
  }

  // ============ 聊天设置页（群资料 / 私聊设置） ============

  /**
   * 打开 / 关闭聊天设置页（顶栏「更多」按钮触发）
   */
  function toggleSettings() {
    if (state.friendsOpen) { closeFriendsPage(); return; }      // 新朋友页下点更多：先返回聊天
    if (state.settingsOpen) { closeSettings(); return; }
    openSettings();
  }

  /**
   * 打开聊天设置侧栏：先拉取会话详情，再渲染设置内容并自右向左展开
   * @returns {Promise<void>}
   */
  async function openSettings() {
    if (!state.activeId) {
      window.showToast(imT('im.chat.toastNeedConversation', '请先选择一个会话'), 'warning');
      return;
    }
    var convId = state.activeId;                                // 本次要设置的目标会话
    try {
      var detail = await api('/conversations/' + encodeURIComponent(convId));
      if (state.activeId !== convId) return;                    // 请求期间切了会话，丢弃结果
      state.detail = detail;
    } catch (e) {
      window.showToast(e.message, 'error');
      return;
    }
    state.settingsOpen = true;
    state.membersExpanded = false;
    renderSettings();
    // 抽屉已在骨架中存在（初始 translateX(100%)），加类即触发滑入动画
    document.body.classList.add('im-settings-open');
    dom.more.title = imT('im.shell.closeChatSettings', '关闭聊天设置');
  }

  /**
   * 关闭聊天设置侧栏：滑出后恢复聊天视图（不对聊天内容做任何隐藏）
   */
  function closeSettings() {
    state.settingsOpen = false;
    state.detail = null;
    document.body.classList.remove('im-settings-open');
    dom.more.title = imT('im.shell.chatSettings', '聊天设置');
  }

  /**
   * 开关控件 HTML（iOS 风格滑块，checked 由 :checked 兄弟选择器驱动）
   * @param {string} id 复选框 id
   * @param {boolean} checked 是否开启
   * @param {boolean} disabled 是否只读
   * @returns {string}
   */
  function switchHtml(id, checked, disabled) {
    return '<label class="im-switch' + (disabled ? ' is-disabled' : '') + '">' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
      '<span></span></label>';
  }

  /**
   * 群聊资料页 HTML（对照图一）
   * @param {object} conv 会话详情
   * @param {boolean} isOwner 是否群主或管理员
   * @returns {string}
   */
  function groupSettingsHtml(conv, isOwner) {
    var prefs = conv.prefs || {};                                         // 我的偏好

    return '' +
      '<div class="im-set-card im-set-profile">' +
        '<div class="im-avatar im-avatar-md' + (conv.avatar ? '' : ' im-avatar-group') + '" id="imSetAvatar"' +
          ' title="' + (isOwner ? imT('im.settings.avatarTip', '点击设置群头像') : '') + '"' + (isOwner ? ' style="cursor:pointer"' : '') + '>' +
          (conv.avatar ? '<img src="' + esc(conv.avatar) + '" alt="">' : ICON_GROUP) +
        '</div>' +
        '<div class="im-set-profile-main">' +
          '<div class="im-set-profile-name">' + esc(convLabel(conv)) + '</div>' +
          '<div class="im-set-profile-code">' + imT('im.settings.groupCode', '群号 {code}', { code: esc(conv.code) }) + '</div>' +
        '</div>' +
        '<button class="im-chip-btn" id="imSetShare">' + imT('im.settings.share', '分享') + '</button>' +
      '</div>' +

      '<div class="im-set-card">' +
        '<div class="im-set-card-head">' +
          '<span class="im-set-card-title">' + imT('im.settings.membersTitle', '群聊成员') + '</span>' +
          '<button class="im-set-link" id="imSetMembersToggle">' +
            imT('im.settings.membersToggle', '查看{count}名群成员 ›', { count: conv.members.length }) + '</button>' +
        '</div>' +
        '<div class="im-set-members" id="imSetMembers"></div>' +
      '</div>' +

      '<div class="im-set-section">' + imT('im.settings.myIdentity', '我的本群身份') + '</div>' +
      '<div class="im-set-card">' +
        '<div class="im-set-row" id="imSetIdentity">' +
          '<span class="' + (groupNick(prefs.identity) ? '' : 'im-set-placeholder') + '">' +
            esc(groupNick(prefs.identity) || imT('im.settings.identityUnset', '未设置，点此填写')) +
          '</span>' +
          '<span class="im-set-arrow">›</span>' +
        '</div>' +
      '</div>' +

      // 班级应用：群作业（老师布置、学生提交、老师批改）
      '<div class="im-set-section">' + imT('im.work.apps', '班级应用') + '</div>' +
      '<div class="im-set-card">' +
        '<div class="im-set-row" id="imSetHomework">' +
          '<span>' + imT('im.work.entry', '群作业') + '</span>' +
          '<span class="im-set-arrow">›</span>' +
        '</div>' +
        '<div class="im-set-row" id="imSetAlbums">' +
          '<span>' + imT('im.album.entry', '群相册') + '</span>' +
          '<span class="im-set-arrow">›</span>' +
        '</div>' +
      '</div>' +

      // 群主 / 管理员：解散群聊（危险操作，置于最下方）
      (isOwner
        ? '<div class="im-set-card">' +
            '<div class="im-set-row im-set-center im-set-danger" id="imSetDissolve"><span>' + imT('im.settings.dissolveGroup', '解散群聊') + '</span></div>' +
          '</div>'
        : '');
  }

  /**
   * 私聊设置页 HTML（对照图二）
   * @param {object} conv 会话详情
   * @returns {string}
   */
  function c2cSettingsHtml(conv) {
    var prefs = conv.prefs || {};                                         // 我的偏好
    return '' +
      '<div class="im-set-card">' +
        '<div class="im-set-row"><span>' + imT('im.settings.setPinned', '设为置顶') + '</span>' + switchHtml('imSetPinned', prefs.pinned === true, false) + '</div>' +
      '</div>' +
      '<div class="im-set-card">' +
        '<div class="im-set-row im-set-center im-set-danger" id="imSetDelete"><span>' + imT('im.settings.deleteFriend', '删除好友') + '</span></div>' +
      '</div>';
  }

  /**
   * 渲染设置侧栏内容（按会话类型分支，并重建事件绑定）
   */
  function renderSettings() {
    var conv = state.detail;
    if (!conv || !dom.settings) return;
    var isGroup = conv.type === 'group';
    var isOwner = !!(state.me.isAdmin || conv.ownerId === state.me.id);   // 群主或管理员
    // 头部：手机端显示返回箭头（整页返回聊天），桌面端显示关闭按钮
    var head = '<div class="im-set-head">' +
      '<button class="icon-btn im-set-back" id="imSetBack" title="' + imT('im.common.back', '返回') + '">' + ICON_BACK + '</button>' +
      '<span class="im-set-head-title">' + imT('im.settings.title', '聊天设置') + '</span>' +
      '<button class="icon-btn im-set-close" id="imSetClose" title="' + imT('im.common.close', '关闭') + '">' + ICON_CLOSE + '</button>' +
    '</div>';
    dom.settings.innerHTML = head + (isGroup ? groupSettingsHtml(conv, isOwner) : c2cSettingsHtml(conv));
    $('#imSetClose').addEventListener('click', closeSettings);
    $('#imSetBack').addEventListener('click', closeSettings);
    if (isGroup) {
      renderMembersGrid($('#imSetMembers'), conv, state.membersExpanded, isOwner);
      bindGroupEvents(conv, isOwner);
    } else {
      bindC2cEvents(conv);
    }
  }

  /**
   * 渲染群成员头像网格（前 8 个 + 邀请 / 移出入口，展开后显示全部）
   * @param {HTMLElement} container 网格容器
   * @param {object} conv 会话详情
   * @param {boolean} expanded 是否展开全部
   * @param {boolean} isOwner 是否群主或管理员
   */
  function renderMembersGrid(container, conv, expanded, isOwner) {
    container.innerHTML = '';
    // 按身份排序：班主任 > 老师 > 家委 > 家长 > 学生 > 未设置（同身份保持原顺序）
    var sortedMembers = conv.members.slice().sort(function (a, b) {
      var ra = IDENT_ROLE_RANK[(a.identity && a.identity.role) || ''];     // a 的排序权重
      var rb = IDENT_ROLE_RANK[(b.identity && b.identity.role) || ''];     // b 的排序权重
      return (ra === undefined ? 99 : ra) - (rb === undefined ? 99 : rb);
    });
    var list = expanded ? sortedMembers : sortedMembers.slice(0, 8);          // 展示的成员
    list.forEach(function (m) {
      var item = document.createElement('div');                           // 单个成员格
      item.className = 'im-set-member';
      item.appendChild(makeAvatar(m.name, m.id, 'im-avatar-md'));
      var name = document.createElement('span');                          // 姓名（超出省略）
      name.className = 'im-set-member-name';
      // 已设置本群身份时展示群昵称（科目-称呼），否则展示账号姓名
      var nick = groupNick(m.identity);
      name.textContent = nick || m.name;
      name.title = nick
        ? imT('im.settings.memberTitle', '{role} {name}（{nick}）', { role: m.identity.role || '', name: m.name, nick: nick })
        : m.name;
      item.appendChild(name);
      container.appendChild(item);
    });

    // 邀请成员
    var invite = document.createElement('div');                           // 「邀请」按钮格
    invite.className = 'im-set-member';
    invite.id = 'imSetInvite';
    invite.innerHTML = '<span class="im-set-member-btn">' + ICON_PLUS + '</span><span class="im-set-member-name">' + imT('im.settings.invite', '邀请') + '</span>';
    container.appendChild(invite);

    // 群主 / 管理员可移出成员
    if (isOwner) {
      var remove = document.createElement('div');                         // 「移出」按钮格
      remove.className = 'im-set-member';
      remove.id = 'imSetRemove';
      remove.innerHTML = '<span class="im-set-member-btn">−</span><span class="im-set-member-name">' + imT('im.settings.remove', '移出') + '</span>';
      container.appendChild(remove);
    }
  }

  /**
   * 修改「我」的会话偏好并刷新列表（置顶会改变排序）
   * @param {string} convId 会话 ID
   * @param {object} body 偏好字段
   * @param {string} [successMsg] 成功提示
   * @returns {Promise<void>}
   */
  async function patchPrefs(convId, body, successMsg) {
    try {
      var prefs = await api('/conversations/' + encodeURIComponent(convId) + '/prefs', {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      if (state.detail) state.detail.prefs = prefs;
      await loadConvs();
      renderSettings();
      if (successMsg) window.showToast(successMsg, 'success');
    } catch (e) {
      window.showToast(e.message, 'error');
    }
  }

  /**
   * 绑定群聊设置页的事件
   * @param {object} conv 会话详情
   * @param {boolean} isOwner 是否群主或管理员
   */
  function bindGroupEvents(conv, isOwner) {

    // 分享：复制「群名（群号）」
    $('#imSetShare').addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(imT('im.settings.shareText', '{name}（群号 {code}）', {
          name: convLabel(conv), code: conv.code
        }));
        window.showToast(imT('im.settings.shareCopied', '群号已复制，可分享给同学'), 'success');
      } catch (e) {
        window.showToast(imT('im.settings.shareCopyFailed', '复制失败，请手动记下群号 {code}', { code: conv.code }), 'error');
      }
    });

    // 群头像：群主或管理员可点击更换
    var avatarBtn = $('#imSetAvatar');
    if (avatarBtn && isOwner) avatarBtn.addEventListener('click', function () { pickGroupAvatar(conv); });

    // 展开 / 收起成员网格
    $('#imSetMembersToggle').addEventListener('click', function () {
      state.membersExpanded = !state.membersExpanded;
      renderSettings();
    });

    var inviteBtn = $('#imSetInvite');                                   // 邀请按钮
    if (inviteBtn) inviteBtn.addEventListener('click', function () { openInviteModal(conv); });
    var removeBtn = $('#imSetRemove');                                   // 移出按钮
    if (removeBtn) removeBtn.addEventListener('click', function () { openRemoveModal(conv); });

    // 我的本群身份（打开编辑弹窗，保存后作为群昵称展示）
    $('#imSetIdentity').addEventListener('click', function () { openIdentityModal(conv); });

    // 群作业：进入作业列表页
    $('#imSetHomework').addEventListener('click', function () { openWorkPage(); });

    // 群相册：进入相册列表页
    $('#imSetAlbums').addEventListener('click', function () { openAlbumsPage(); });

    // 解散群聊（群主 / 管理员）：二次确认后删除整个会话
    var dissolveBtn = $('#imSetDissolve');                               // 解散按钮（仅群主/管理员渲染）
    if (dissolveBtn) {
      dissolveBtn.addEventListener('click', async function () {
        var yes = await confirmDialog({
          title: imT('im.settings.dissolveGroup', '解散群聊'),
          text: imT('im.settings.dissolveConfirmText', '解散后该群及其聊天记录、作业、相册将一并移除，无法恢复。'),
          okText: imT('im.settings.dissolveConfirmOk', '解散'),
          danger: true
        });
        if (!yes) return;
        try {
          await api('/conversations/' + encodeURIComponent(conv.id), { method: 'DELETE' });
          resetAfterConvRemoved(conv);
          await loadConvs();
          window.showToast(imT('im.settings.dissolved', '已解散该群聊'), 'success');
        } catch (e) {
          window.showToast(e.message, 'error');
        }
      });
    }
  }

  /**
   * 会话被删除（删除好友 / 解散群聊）后清理界面状态
   * @param {object} conv 被删除的会话
   */
  function resetAfterConvRemoved(conv) {
    state.convs = state.convs.filter(function (c) { return c.id !== conv.id; });
    state.activeId = null;
    state.detail = null;
    state.settingsOpen = false;
    document.body.classList.remove('im-settings-open');
    dom.history.innerHTML = '';
    dom.chatEmpty.style.display = 'flex';
    dom.chatTitle.textContent = imT('im.common.conversation', '会话');
    dom.more.title = imT('im.shell.chatSettings', '聊天设置');
    stopMsgPoll();
    renderConvList();
  }

  /**
   * 绑定私聊设置页的事件（对照图二）
   * @param {object} conv 会话详情
   */
  function bindC2cEvents(conv) {
    var path = '/conversations/' + encodeURIComponent(conv.id);          // 会话接口路径

    $('#imSetPinned').addEventListener('change', function (e) {
      patchPrefs(conv.id, { pinned: e.target.checked }, e.target.checked
        ? imT('im.settings.pinnedOn', '已置顶该会话')
        : imT('im.settings.pinnedOff', '已取消置顶'));
    });

    // 删除好友（连同会话与消息一起移除）
    $('#imSetDelete').addEventListener('click', async function () {
      var yes = await confirmDialog({
        title: imT('im.settings.deleteFriend', '删除好友'),
        text: imT('im.settings.deleteConfirmText', '删除后该会话及其聊天记录将一并移除，无法恢复。'),
        okText: imT('im.settings.deleteConfirmOk', '删除'),
        danger: true
      });
      if (!yes) return;
      try {
        await api(path, { method: 'DELETE' });
        resetAfterConvRemoved(conv);
        await loadConvs();
        window.showToast(imT('im.settings.deleted', '已删除该会话'), 'success');
      } catch (e) {
        window.showToast(e.message, 'error');
      }
    });
  }

  // ============ 弹窗（严格按 docs/弹窗.html：遮罩淡入 + 面板 0.9 → 1 放大） ============

  /** 弹窗过渡时长（毫秒），与 all.css 中 .im-modal 的 0.3s 保持一致 */
  var MODAL_ANIM = 300;

  /**
   * 以动画方式打开弹窗：挂载后强制重排，下一帧再补 .show 触发过渡（与工程规范一致）
   * @param {HTMLElement} mask 遮罩节点
   */
  function showModal(mask) {
    document.body.appendChild(mask);
    mask.offsetHeight;                                       // 强制重排，确保透明初始态已被浏览器记录
    requestAnimationFrame(function () { mask.classList.add('show'); });
    document.body.style.overflow = 'hidden';                 // 打开期间锁定背景滚动
  }

  /**
   * 以动画方式关闭弹窗：移除 .show 触发淡出缩小，过渡结束后再删除节点
   * @param {HTMLElement} mask 遮罩节点
   * @param {Function} [onDone] 节点移除后的回调
   */
  function hideModal(mask, onDone) {
    mask.classList.remove('show');
    document.body.style.overflow = '';                       // 恢复背景滚动
    setTimeout(function () {
      mask.remove();
      if (onDone) onDone();
    }, MODAL_ANIM);
  }

  /**
   * 修改「我的本群身份」弹窗（对照 QQ「修改我的群身份」）
   * 身份信息保存后作为我在该群的群昵称展示
   * @param {object} conv 会话详情
   */
  function openIdentityModal(conv) {
    var saved = (conv.prefs && conv.prefs.identity) || {};                // 已保存的群身份
    var draft = {                                                         // 编辑中的身份值（切换身份时保留）
      subject: saved.subject || '',
      nickname: saved.nickname || '',
      childName: saved.childName || '',
      relation: saved.relation || ''
    };
    var mask = document.createElement('div');                             // 遮罩
    // 手机端整页展示（im-modal-page）；桌面端仍居中弹窗
    mask.className = 'im-modal-mask im-modal-page';
    var roleOpts = IDENT_ROLES.map(function (r) {
      return '<option value="' + r + '"' + (saved.role === r ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
    var subjectOpts = IDENT_SUBJECTS.map(function (s) {
      return '<option value="' + s + '"' + (saved.subject === s ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    var relationOpts = IDENT_RELATIONS.map(function (r) {
      return '<option value="' + r + '"' + (saved.relation === r ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
    mask.innerHTML =
      '<div class="im-modal im-ident-modal">' +
        // 手机端整页标题栏（桌面端隐藏）：返回 + 标题
        '<div class="im-page-head">' +
          '<button class="icon-btn" id="imIdentBack" title="' + imT('im.common.back', '返回') + '">' + ICON_BACK + '</button>' +
          '<span class="im-page-title">' + imT('im.identity.title', '修改我的群身份') + '</span>' +
          '<span class="im-page-head-space"></span>' +
        '</div>' +
        '<div class="im-page-body">' +
        '<div class="im-modal-title">' + imT('im.identity.title', '修改我的群身份') + '</div>' +
        '<div class="im-ident-tip">' + imT('im.identity.tipNickname', '身份信息将以群昵称展示：') + '</div>' +
        '<div class="im-ident-preview">' +
          '<div class="im-ident-preview-head">' +
            '<span class="im-ident-avatar" id="imIdentAvatar"></span>' +
            '<span class="im-ident-name" id="imIdentName"></span>' +
            '<span class="im-ident-badge" id="imIdentBadge"></span>' +
          '</div>' +
          '<div class="im-ident-sample">' + imT('im.identity.sample', '家校群内身份标识展示') + '</div>' +
        '</div>' +
        '<div class="im-ident-tip">' + imT('im.identity.tipFill', '填写身份方便老师、家长沟通交流') + '</div>' +
        '<div class="im-ident-form">' +
          '<div class="im-ident-row">' +
            '<label class="im-ident-label" for="imIdentRole">' + imT('im.identity.roleLabel', '群内身份') + '<em>*</em></label>' +
            '<select class="im-ident-select" id="imIdentRole">' +
              '<option value="">' + imT('im.common.select', '请选择') + '</option>' + roleOpts +
            '</select>' +
          '</div>' +
          '<div id="imIdentDynamic"></div>' +
        '</div>' +
        '</div>' +
        '<div class="im-modal-actions im-ident-actions">' +
          '<button class="btn btn-column2" id="imIdentOk">' + imT('im.common.confirm', '确定') + '</button>' +
          '<button class="btn btn-column5" id="imIdentCancel">' + imT('im.common.cancel', '取消') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);

    var avatarBox = $('#imIdentAvatar', mask);                            // 预览头像容器
    avatarBox.appendChild(makeAvatar(state.me.name, state.me.id, 'im-avatar-md'));
    var nameEl = $('#imIdentName', mask);                                 // 预览群昵称
    var badgeEl = $('#imIdentBadge', mask);                               // 预览身份徽标
    var roleEl = $('#imIdentRole', mask);                                 // 身份下拉
    var dynamicEl = $('#imIdentDynamic', mask);                           // 随身份变化的表单行容器

    /** 生成「教授科目 + 称呼」行（老师 / 班主任身份） */
    function teacherRows() {
      return '<div class="im-ident-row">' +
          '<label class="im-ident-label" for="imIdentSubject">' + imT('im.identity.subjectLabel', '教授科目') + '<em>*</em></label>' +
          '<select class="im-ident-select" id="imIdentSubject">' +
            '<option value="">' + imT('im.common.select', '请选择') + '</option>' + subjectOpts +
          '</select>' +
        '</div>' +
        '<div class="im-ident-row">' +
          '<label class="im-ident-label" for="imIdentNick">' + imT('im.identity.nickLabel', '称呼') + '<em>*</em></label>' +
          '<input class="im-ident-input" id="imIdentNick" maxlength="20" placeholder="' + imT('im.identity.nickPlaceholder', '例如：数大小') + '">' +
        '</div>';
    }

    /** 生成「孩子姓名 + 你是孩子的」行（家长 / 家委身份，对照 QQ 截图） */
    function parentRows() {
      return '<div class="im-ident-row">' +
          '<label class="im-ident-label" for="imIdentChild">' + imT('im.identity.childLabel', '孩子姓名') + '<em>*</em></label>' +
          '<input class="im-ident-input" id="imIdentChild" maxlength="20" placeholder="' + imT('im.identity.childPlaceholder', '请输入孩子姓名') + '">' +
        '</div>' +
        '<div class="im-ident-row">' +
          '<label class="im-ident-label" for="imIdentRelation">' + imT('im.identity.relationLabel', '你是孩子的') + '<em>*</em></label>' +
          '<select class="im-ident-select" id="imIdentRelation">' +
            '<option value="">' + imT('im.common.select', '请选择') + '</option>' + relationOpts +
          '</select>' +
        '</div>';
    }

    /** 生成「称呼」行（学生身份） */
    function nickRow() {
      return '<div class="im-ident-row">' +
          '<label class="im-ident-label" for="imIdentNick">' + imT('im.identity.nickLabel', '称呼') + '<em>*</em></label>' +
          '<input class="im-ident-input" id="imIdentNick" maxlength="20" placeholder="' + imT('im.identity.nickPlaceholder', '例如：数大小') + '">' +
        '</div>';
    }

    /** 把当前行里的输入值读回草稿，避免切换身份时丢失已填内容 */
    function captureDraft() {
      var subjectEl = $('#imIdentSubject', mask);                         // 科目下拉
      var nickEl = $('#imIdentNick', mask);                               // 称呼输入
      var childEl = $('#imIdentChild', mask);                             // 孩子姓名输入
      var relationEl = $('#imIdentRelation', mask);                       // 与孩子关系下拉
      if (subjectEl) draft.subject = subjectEl.value;
      if (nickEl) draft.nickname = nickEl.value;
      if (childEl) draft.childName = childEl.value;
      if (relationEl) draft.relation = relationEl.value;
    }

    /** 按当前身份重建表单行，回填草稿值并重新绑定事件 */
    function buildRows() {
      var role = roleEl.value;                                            // 当前选择的身份
      dynamicEl.innerHTML = isTeacherRole(role) ? teacherRows() : ((role === '家长' || role === '家委') ? parentRows() : nickRow());
      var subjectEl = $('#imIdentSubject', mask);                         // 科目下拉
      var nickEl = $('#imIdentNick', mask);                               // 称呼输入
      var childEl = $('#imIdentChild', mask);                             // 孩子姓名输入
      var relationEl = $('#imIdentRelation', mask);                       // 与孩子关系下拉
      if (subjectEl) {
        subjectEl.value = draft.subject;
        subjectEl.addEventListener('change', function () { draft.subject = subjectEl.value; syncPreview(); });
      }
      if (nickEl) {
        nickEl.value = draft.nickname;
        nickEl.addEventListener('input', function () { draft.nickname = nickEl.value; syncPreview(); });
      }
      if (childEl) {
        childEl.value = draft.childName;
        childEl.addEventListener('input', function () { draft.childName = childEl.value; syncPreview(); });
      }
      if (relationEl) {
        relationEl.value = draft.relation;
        relationEl.addEventListener('change', function () { draft.relation = relationEl.value; syncPreview(); });
      }
      syncPreview();
    }

    /** 同步预览：按身份拼出群昵称，身份作为徽标 */
    function syncPreview() {
      var role = roleEl.value;                                            // 当前身份
      var nick;                                                           // 预览用群昵称
      if (isTeacherRole(role)) {
        nick = (draft.subject ? draft.subject + '-' : '') + (draft.nickname.trim() || imT('im.identity.defaultNick', '你的称呼'));
      } else if (role === '家长' || role === '家委') {
        nick = (draft.childName.trim() + draft.relation) || imT('im.identity.defaultNick', '你的称呼');
      } else {
        nick = draft.nickname.trim() || imT('im.identity.defaultNick', '你的称呼');
      }
      nameEl.textContent = nick;
      badgeEl.textContent = role || '';
      badgeEl.style.display = role ? '' : 'none';
    }

    // 切换身份时先保存已填内容，再按新身份重建表单
    roleEl.addEventListener('change', function () { captureDraft(); buildRows(); });
    buildRows();

    /** 关闭弹窗（带收起动画） */
    function close() {
      document.removeEventListener('keydown', onKey);
      hideModal(mask);
    }
    /** ESC 关闭 */
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    $('#imIdentCancel', mask).addEventListener('click', close);
    $('#imIdentBack', mask).addEventListener('click', close);
    $('#imIdentOk', mask).addEventListener('click', async function () {
      captureDraft();
      var role = roleEl.value;                                            // 用户选择的身份
      var identity;                                                       // 待保存的身份
      if (!role) { window.showToast(imT('im.identity.warnRole', '请选择群内身份'), 'warning'); return; }
      if (isTeacherRole(role)) {
        if (!draft.subject) { window.showToast(imT('im.identity.warnSubject', '请选择教授科目'), 'warning'); return; }
        if (!draft.nickname.trim()) { window.showToast(imT('im.identity.warnNick', '请填写称呼'), 'warning'); return; }
        identity = { role: role, subject: draft.subject, nickname: draft.nickname.trim(), childName: '', relation: '' };
      } else if (role === '家长' || role === '家委') {
        if (!draft.childName.trim()) { window.showToast(imT('im.identity.warnChild', '请填写孩子姓名'), 'warning'); return; }
        if (!draft.relation) { window.showToast(imT('im.identity.warnRelation', '请选择你是孩子的'), 'warning'); return; }
        identity = { role: role, subject: '', nickname: draft.nickname.trim(), childName: draft.childName.trim(), relation: draft.relation };
      } else {
        if (!draft.nickname.trim()) { window.showToast(imT('im.identity.warnNick', '请填写称呼'), 'warning'); return; }
        identity = { role: role, subject: '', nickname: draft.nickname.trim(), childName: '', relation: '' };
      }
      close();
      await patchPrefs(conv.id, { identity: identity }, imT('im.identity.saved', '群身份已保存'));
      // 同步更新成员数据中的我的身份，让成员网格立即显示新群昵称
      var me = ((state.detail && state.detail.members) || []).find(function (m) { return m.id === state.me.id; });
      if (me) me.identity = identity;
      renderSettings();
    });
  }

  function pickGroupAvatar(conv) {
    var input = document.createElement('input');                         // 临时文件选择框
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];                          // 用户选择的图片文件
      if (!file) { input.remove(); return; }
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        window.showToast(imT('im.settings.avatarOnly', '仅支持 PNG/JPG/WebP 图片'), 'warning');
        input.remove();
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        window.showToast(imT('im.settings.avatarTooLarge', '图片不能超过 2MB'), 'warning');
        input.remove();
        return;
      }
      var reader = new FileReader();                                     // 把图片读成 dataURL
      reader.onload = async function () {
        try {
          var data = await api('/conversations/' + encodeURIComponent(conv.id) + '/avatar', {
            method: 'PATCH',
            body: JSON.stringify({ dataUrl: reader.result })
          });
          var url = data.avatar;                                         // 新头像地址（带时间戳防缓存）
          conv.avatar = url;
          (state.convs || []).forEach(function (c) { if (c.id === conv.id) c.avatar = url; });
          window.showToast(imT('im.settings.avatarUpdated', '群头像已更新'), 'success');
          renderSettings();
          renderConvList();
        } catch (e) {
          window.showToast(e.message || imT('im.settings.avatarUploadFailed', '上传失败，请重试'), 'error');
        } finally {
          input.remove();
        }
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  /**
   * 邀请成员弹窗（支持按 ID / 姓名搜索候选）
   * @param {object} conv 会话详情
   */
  function openInviteModal(conv) {
    var mask = document.createElement('div');                           // 遮罩
    // 手机端整页展示（im-modal-page）；桌面端仍居中弹窗
    mask.className = 'im-modal-mask im-modal-page';
    mask.innerHTML =
      '<div class="im-modal">' +
        // 手机端整页标题栏（桌面端隐藏）：取消 + 标题
        '<div class="im-page-head">' +
          '<button class="im-page-text-btn" id="imInviteCancelTop">' + imT('im.common.cancel', '取消') + '</button>' +
          '<span class="im-page-title">' + imT('im.invite.title', '邀请成员') + '</span>' +
          '<span class="im-page-head-space"></span>' +
        '</div>' +
        '<div class="im-page-body">' +
        '<div class="im-modal-title">' + imT('im.invite.title', '邀请成员') + '</div>' +
        '<input class="input im-modal-input" id="imInviteInput" placeholder="' + imT('im.invite.placeholder', '用户 ID，多个用英文逗号分隔') + '">' +
        '<div class="im-suggest" id="imInviteSuggest"></div>' +
        '</div>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" id="imInviteCancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn btn-column2" id="imInviteOk">' + imT('im.settings.invite', '邀请') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);

    var input = $('#imInviteInput', mask);                               // 成员 ID 输入框
    attachUserSuggest(input, $('#imInviteSuggest', mask));               // 候选建议

    /** 关闭弹窗（移除 ESC 监听并播放收起动画） */
    function close() { document.removeEventListener('keydown', onKey); hideModal(mask); }
    /** ESC 关闭 */
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    // 点击遮罩空白处关闭（与 docs/弹窗.html 规范一致）
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    $('#imInviteCancel', mask).addEventListener('click', function () {
      document.removeEventListener('keydown', onKey);
      close();
    });
    // 手机端整页标题栏的「取消」
    $('#imInviteCancelTop', mask).addEventListener('click', function () {
      document.removeEventListener('keydown', onKey);
      close();
    });

    $('#imInviteOk', mask).addEventListener('click', async function () {
      var ids = input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);  // 待邀请 ID
      if (!ids.length) { window.showToast(imT('im.invite.warnIds', '请填写要邀请的用户 ID'), 'warning'); return; }
      try {
        state.detail = await api('/conversations/' + encodeURIComponent(conv.id) + '/members', {
          method: 'POST',
          body: JSON.stringify({ memberIds: ids })
        });
        document.removeEventListener('keydown', onKey);
        close();
        await loadConvs();
        renderSettings();
        window.showToast(imT('im.invite.success', '成员已加入群聊'), 'success');
      } catch (e) {
        window.showToast(e.message, 'error');
      }
    });

    setTimeout(function () { input.focus(); }, 30);
  }

  /**
   * 移出成员弹窗（仅群主 / 管理员可见）
   * @param {object} conv 会话详情
   */
  function openRemoveModal(conv) {
    var mask = document.createElement('div');                           // 遮罩
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal">' +
        '<div class="im-modal-title">' + imT('im.remove.title', '移出成员') + '</div>' +
        '<div class="im-pick-list" id="imRemoveList"></div>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" id="imRemoveClose">' + imT('im.common.close', '关闭') + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);

    /**
     * 填充可移出成员列表（群主不可移出）
     */
    function fill() {
      var box = $('#imRemoveList', mask);                                // 列表容器
      box.innerHTML = '';
      var candidates = (state.detail.members || []).filter(function (m) {
        return m.id !== state.detail.ownerId;
      });
      if (!candidates.length) {
        box.innerHTML = '<div class="im-set-placeholder">' + imT('im.remove.empty', '暂无可移出的成员') + '</div>';
        return;
      }
      candidates.forEach(function (m) {
        var row = document.createElement('div');                         // 单个成员行
        row.className = 'im-pick-row';
        row.textContent = m.name + '（' + m.id + '）';
        row.addEventListener('click', async function () {
          try {
            state.detail = await api('/conversations/' + encodeURIComponent(conv.id) +
              '/members/' + encodeURIComponent(m.id), { method: 'DELETE' });
            await loadConvs();
            renderSettings();
            fill();
            window.showToast(imT('im.remove.success', '已移出 {name}', { name: m.name }), 'success');
          } catch (e) {
            window.showToast(e.message, 'error');
          }
        });
        box.appendChild(row);
      });
    }
    fill();

    /** 关闭弹窗（移除 ESC 监听并播放收起动画） */
    function close() { document.removeEventListener('keydown', onKey); hideModal(mask); }
    /** ESC 关闭 */
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    // 点击遮罩空白处关闭
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    $('#imRemoveClose', mask).addEventListener('click', close);
  }

  /**
   * 通用确认弹窗
   * @param {object} opt { title, text, okText, danger }
   * @returns {Promise<boolean>} 确认返回 true，取消 / ESC 返回 false
   */
  function confirmDialog(opt) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div');                           // 遮罩
      var finished = false;                                                // 防止重复收尾
      // 确认类弹窗：手机端保持居中卡片（内容型弹窗才全屏）
      mask.className = 'im-modal-mask im-modal-compact';
      mask.innerHTML =
        '<div class="im-modal">' +
          '<div class="im-modal-title">' + esc(opt.title || imT('im.modal.defaultTitle', '确认操作')) + '</div>' +
          '<div class="im-modal-text">' + esc(opt.text || '') + '</div>' +
          '<div class="im-modal-actions">' +
            '<button class="btn btn-column5" data-act="cancel">' + imT('im.common.cancel', '取消') + '</button>' +
            '<button class="btn ' + (opt.danger ? 'btn-column4' : 'btn-column2') + '" data-act="ok">' +
              esc(opt.okText || imT('im.common.confirm', '确定')) + '</button>' +
          '</div>' +
        '</div>';
      showModal(mask);

      /** 收尾：移除监听、播放收起动画并回传结果 */
      function done(result) {
        if (finished) return;
        finished = true;
        document.removeEventListener('keydown', onKey);
        hideModal(mask);
        resolve(result);
      }
      /** ESC 视为取消 */
      function onKey(e) { if (e.key === 'Escape') done(false); }
      document.addEventListener('keydown', onKey);

      mask.addEventListener('click', function (e) {
        if (e.target === mask) { done(false); return; }                   // 点遮罩取消
        var act = e.target && e.target.dataset ? e.target.dataset.act : '';
        if (act === 'cancel') done(false);
        if (act === 'ok') done(true);
      });
    });
  }

  /**
   * 给输入框绑定「按 ID / 姓名搜索用户」的候选建议
   * @param {HTMLInputElement} input 输入框
   * @param {HTMLElement} suggest 建议容器
   */
  function attachUserSuggest(input, suggest) {
    var timer = null;                                                  // 输入防抖计时器
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();                                      // 关键词
      if (!q) { suggest.innerHTML = ''; return; }
      timer = setTimeout(async function () {
        try {
          var users = await api('/users?q=' + encodeURIComponent(q));
          suggest.innerHTML = '';
          users.forEach(function (u) {
            var row = document.createElement('div');                   // 候选用户行
            row.className = 'im-suggest-item';
            row.textContent = u.name + '（' + u.id + '）';
            row.addEventListener('click', function () {
              input.value = u.id;
              suggest.innerHTML = '';
            });
            suggest.appendChild(row);
          });
        } catch (e) { /* 搜索失败静默 */ }
      }, 250);
    });
  }

  // ============ 新建会话弹窗 ============

  /**
   * 打开新建会话弹窗
   * @param {'c2c'|'group'} type 会话类型
   */
  function openModal(type) {
    var isGroup = type === 'group';                            // 是否群聊
    var mask = document.createElement('div');                  // 遮罩层
    mask.className = 'im-modal-mask';
    mask.innerHTML =
      '<div class="im-modal">' +
        '<div class="im-modal-title">' + (isGroup
          ? imT('im.shell.newGroup', '新建群聊')
          : imT('im.shell.newC2c', '发起单聊')) + '</div>' +
        (isGroup ? '<input class="input im-modal-input" id="imGroupName" placeholder="' +
          imT('im.create.groupNamePlaceholder', '群聊名称（最多 30 字）') + '" maxlength="30">' : '') +
        '<input class="input im-modal-input" id="imTargetIds" placeholder="' +
          (isGroup
            ? imT('im.create.memberIdsPlaceholder', '成员用户 ID，多个用英文逗号分隔')
            : imT('im.create.targetIdPlaceholder', '对方用户 ID')) + '">' +
        '<div class="im-suggest" id="imSuggest"></div>' +
        '<div class="im-modal-actions">' +
          '<button class="btn btn-column5" id="imModalCancel">' + imT('im.common.cancel', '取消') + '</button>' +
          '<button class="btn ' + (isGroup ? 'btn-column3' : 'btn-column2') + '" id="imModalOk">' +
            (isGroup ? imT('im.create.createGroup', '创建群聊') : imT('im.create.startChat', '发起会话')) + '</button>' +
        '</div>' +
      '</div>';
    showModal(mask);

    var input = $('#imTargetIds', mask);                       // ID 输入框

    // 输入 ID / 姓名时给出候选用户（单聊才显示建议，群聊需多个 ID 故不提示）
    if (!isGroup) attachUserSuggest(input, $('#imSuggest', mask));

    /** 关闭弹窗（移除 ESC 监听并播放收起动画） */
    function close() {
      document.removeEventListener('keydown', onKey);           // 移除键盘监听
      hideModal(mask);
    }
    /** ESC 关闭 */
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    // 点击遮罩空白处关闭
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    $('#imModalCancel', mask).addEventListener('click', close);
    $('#imModalOk', mask).addEventListener('click', async function () {
      var ids = input.value.trim();                            // 输入的 ID 文本
      if (!ids) { window.showToast(imT('im.create.warnIds', '请填写用户 ID'), 'warning'); return; }

      try {
        var conv;
        if (isGroup) {
          var title = $('#imGroupName', mask).value.trim();     // 群聊名称
          if (!title) { window.showToast(imT('im.create.warnGroupName', '请填写群聊名称'), 'warning'); return; }
          var memberIds = ids.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          conv = await api('/conversations', {
            method: 'POST',
            body: JSON.stringify({ type: 'group', title: title, memberIds: memberIds })
          });
        } else {
          conv = await api('/conversations', {
            method: 'POST',
            body: JSON.stringify({ type: 'c2c', targetId: ids })
          });
        }
        close();
        await loadConvs();
        selectConv(conv.id);
        window.showToast(isGroup
          ? imT('im.create.groupCreated', '群聊创建成功')
          : imT('im.create.chatCreated', '会话已创建'), 'success');
      } catch (e) {
        window.showToast(e.message, 'error');                  // 后端返回中文错误（用户不存在等）
      }
    });

    setTimeout(function () { input.focus(); }, 30);
  }

  // ============ 启动 ============

  /**
   * 处理深链：/im?conversation=g{群号} 或 /im?conversation=i{用户ID}
   * 群聊：已在会话中直接打开，否则按群号搜索并加入；单聊：已存在直接打开，
   * 否则按用户 ID 搜索并发起好友申请（需对方同意）
   * @returns {Promise<boolean>} 是否已按深链处理
   */
  async function openFromDeepLink() {
    var raw = new URLSearchParams(location.search).get('conversation');
    if (!raw) return false;

    var matched = /^([gi])(.+)$/.exec(raw.trim());              // g=群聊 i=用户
    if (!matched) return false;

    // 参数只消费一次，清掉地址栏避免刷新重复执行
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', location.pathname);
    }

    var kind = matched[1];                                      // 链接类型
    var id = decodeURIComponent(matched[2]);                    // 群号 / 用户 ID
    var conv;                                                   // 命中的会话

    if (kind === 'g') {
      conv = state.convs.find(function (c) { return c.type === 'group' && c.code === id; });
      if (conv) { await selectConv(conv.id); return true; }

      // 不在我的会话列表：按群号搜索
      var found;
      try {
        found = await api('/search?q=' + encodeURIComponent(id));
      } catch (e) {
        window.showToast(e.message, 'error');
        return true;
      }
      var group = (found.groups || []).find(function (g) { return g.code === id; });
      if (!group) {
        window.showToast(imT('im.deepLink.groupNotFound', '群聊不存在或已解散'), 'warning');
        return true;
      }
      try {
        if (!group.isMember) await api('/conversations/' + group.id + '/join', { method: 'POST' });
        await loadConvs();
        var target = state.convs.find(function (c) { return c.id === group.id; });
        if (target) await selectConv(target.id);
        else window.showToast(imT('im.deepLink.joinFailed', '加入群聊失败'), 'error');
      } catch (e) {
        window.showToast(e.message, 'error');
      }
      return true;
    }

    // i：按用户 ID 打开单聊
    conv = state.convs.find(function (c) {
      return c.type === 'c2c' && Array.isArray(c.members) &&
        c.members.some(function (m) { return m.id === id; });
    });
    if (conv) { await selectConv(conv.id); return true; }

    var res;
    try {
      res = await api('/search?q=' + encodeURIComponent(id));
    } catch (e) {
      window.showToast(e.message, 'error');
      return true;
    }
    var user = (res.users || []).find(function (u) { return u.id === id; });
    if (!user) {
      window.showToast(imT('im.deepLink.userNotFound', '用户不存在'), 'warning');
      return true;
    }
    if (user.incoming) {
      await openFriendsPage();                                  // 对方已申请我：去新朋友页同意
      return true;
    }
    if (user.pending) {
      window.showToast(imT('im.friends.sent', '好友申请已发送，等待对方同意'), 'info');
      return true;
    }
    try {
      await api('/friend-requests', { method: 'POST', body: JSON.stringify({ toId: id }) });
      window.showToast(imT('im.friends.sent', '好友申请已发送，等待对方同意'), 'success');
    } catch (e) {
      window.showToast(e.message, 'error');
    }
    return true;
  }

  /**
   * 初始化：拉取当前用户 → 渲染骨架 → 加载会话 → 打开默认会话
   * @returns {Promise<void>}
   */
  async function init() {
    try {
      state.me = await api('/me');
    } catch (e) {
      window.showToast(e.message, 'error');
      return;
    }
    renderShell();
    document.title = imT('app.name', '明星学校');
    await loadConvs();

    // 深链优先；未命中时桌面端默认打开第一个会话，移动端停留列表
    var handled = await openFromDeepLink();
    if (!handled && state.convs.length && window.innerWidth > 768) {
      selectConv(state.convs[0].id);
    }
    startTickPoll();
  }

  /**
   * 页面入口：等语言包加载完成后再初始化，确保首屏文案即为当前语言
   */
  function startImPage() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  if (window.I18n && window.I18n.ready) window.I18n.ready(startImPage);
  else startImPage();
})();
