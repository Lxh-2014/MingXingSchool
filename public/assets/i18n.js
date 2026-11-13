/**
 * i18n.js —— 明星学校全站国际化框架（前端核心）
 * ----------------------------------------------------------
 * 用法：
 *   1. 在页面 <head> 中引入：<script src="/assets/i18n.js"></script>
 *   2. 页面脚本渲染文案时调用：I18n.t('nav.home', null, '首页')（第三个参数为中文兜底）
 *   3. 需要确保语言包加载完成后再渲染时：I18n.ready(function () { ... })
 *   4. 切换语言：I18n.setLang('en-US')，会写入 localStorage.mx-lang 与 cookie.lang
 *   5. 纯静态文案可直接在 HTML 上标注：data-i18n / data-i18n-placeholder / data-i18n-title
 *
 * 语言包位置：/assets/locales/<lang>.json（前后端共用，服务端见 server/core/i18n.js）
 * 语言识别优先级：URL ?lang= > localStorage.mx-lang > cookie.lang > 浏览器语言 > zh-CN
 */
(function (global) {
  'use strict';

  /** localStorage 中的语言偏好键（刻意与网盘子应用的 lang 键区分，避免互相覆盖） */
  var STORAGE_KEY = 'mx-lang';

  /** 服务端读取的语言 cookie 名 */
  var COOKIE_KEY = 'lang';

  /** 当前支持的语言代码 */
  var SUPPORTED = ['zh-CN', 'en-US'];

  /** 默认语言（中文） */
  var DEFAULT_LANG = 'zh-CN';

  /** 语言包根路径（由主服务 public 目录静态托管） */
  var PACK_BASE = '/assets/locales/';

  /** 当前语言代码 */
  var currentLang = DEFAULT_LANG;

  /** 当前语言包对象 */
  var dict = {};

  /** 兜底语言包（默认中文），英文缺失键时回落 */
  var fallbackDict = {};

  /** 语言包是否已加载完成 */
  var loaded = false;

  /** ready() 等待队列：语言包加载完成后依次执行 */
  var waiters = [];

  /** 对外 API 对象（提前声明，便于内部回调返回） */
  var api;

  /**
   * 规整语言代码：zh* → zh-CN，en* → en-US，其他返回空字符串
   * @param {string} value 原始语言标识
   * @returns {string} 受支持的语言代码，不支持时为空
   */
  function normalizeLang(value) {
    var raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.indexOf('zh') === 0) return 'zh-CN';
    if (raw.indexOf('en') === 0) return 'en-US';
    return '';
  }

  /**
   * 读取指定名称的 cookie
   * @param {string} name cookie 名
   * @returns {string} cookie 值，未找到为空字符串
   */
  function readCookie(name) {
    var match = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(document.cookie || '');
    return match ? decodeURIComponent(match[1]) : '';
  }

  /**
   * 按优先级识别本次应使用的语言
   * @returns {string} 语言代码（保证是受支持的语言）
   */
  function detectLang() {
    var fromQuery = '';
    try {
      fromQuery = (new URLSearchParams(global.location.search)).get('lang') || '';
    } catch (e) { /* 老浏览器不支持 URLSearchParams 时忽略 */ }

    var fromStorage = '';
    try { fromStorage = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { /* 隐私模式忽略 */ }

    return normalizeLang(fromQuery) ||
           normalizeLang(fromStorage) ||
           normalizeLang(readCookie(COOKIE_KEY)) ||
           normalizeLang(global.navigator.language) ||
           DEFAULT_LANG;
  }

  /**
   * 持久化语言选择：localStorage + cookie（cookie 供服务端提示信息使用）
   * @param {string} lang 语言代码
   */
  function saveLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* 隐私模式忽略 */ }
    try {
      document.cookie = COOKIE_KEY + '=' + encodeURIComponent(lang) +
        ';path=/;max-age=31536000;SameSite=Lax';
    } catch (e) { /* cookie 被禁用时忽略 */ }
  }

  /**
   * 拉取一个语言包 JSON
   * @param {string} lang 语言代码
   * @returns {Promise<object>} 语言包对象，失败时返回空对象（不阻断页面）
   */
  function fetchPack(lang) {
    return fetch(PACK_BASE + lang + '.json', { cache: 'no-cache' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .catch(function (err) {
        console.warn('[i18n] 语言包加载失败：' + lang, err);
        return {};
      });
  }

  /**
   * 从语言包对象中按 a.b.c 路径取值
   * @param {object} source 语言包对象
   * @param {string} key 点分键
   * @returns {*} 命中的值，未命中返回 undefined
   */
  function getByPath(source, key) {
    var parts = String(key || '').split('.');
    var node = source;
    for (var i = 0; i < parts.length; i++) {
      if (!node || typeof node !== 'object') return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  /**
   * 替换文案中的 {name} 占位符
   * @param {string} text 原始文案
   * @param {object} params 占位参数
   * @returns {string} 替换后的文案
   */
  function format(text, params) {
    if (!params || typeof params !== 'object') return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return params[name] !== undefined && params[name] !== null ? String(params[name]) : match;
    });
  }

  /**
   * 取多语言文案
   * @param {string} key 语言包键（如 nav.home）
   * @param {object} [params] 占位参数（如 {name:'张三'}）
   * @param {string} [defaultText] 全部语言包都缺失时的兜底文案（通常是中文原文）
   * @returns {string} 最终展示文案
   */
  function t(key, params, defaultText) {
    var value = getByPath(dict, key);
    if (typeof value !== 'string') value = getByPath(fallbackDict, key);
    if (typeof value !== 'string') value = defaultText;
    if (typeof value !== 'string') return key;
    return format(value, params);
  }

  /**
   * 翻译 DOM 中带 data-i18n* 标注的属性/文本
   * @param {HTMLElement|Document} [root] 翻译范围，默认整篇文档
   */
  function applyDom(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]') : [];
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key, null, el.textContent);

      var htmlKey = el.getAttribute('data-i18n-html');
      if (htmlKey) el.innerHTML = t(htmlKey, null, el.innerHTML);

      var phKey = el.getAttribute('data-i18n-placeholder');
      if (phKey) el.setAttribute('placeholder', t(phKey, null, el.getAttribute('placeholder')));

      var titleKey = el.getAttribute('data-i18n-title');
      if (titleKey) el.setAttribute('title', t(titleKey, null, el.getAttribute('title')));

      var ariaKey = el.getAttribute('data-i18n-aria-label');
      if (ariaKey) el.setAttribute('aria-label', t(ariaKey, null, el.getAttribute('aria-label')));
    });
  }

  /**
   * 同步 <html lang> 属性（影响无障碍朗读与浏览器翻译判断）
   * @param {string} lang 语言代码
   */
  function setHtmlLang(lang) {
    try { document.documentElement.lang = lang; } catch (e) { /* 忽略 */ }
  }

  /**
   * 加载指定语言：当前语言包 + 默认中文兜底包，完成后执行等待队列
   * @param {string} lang 语言代码
   * @returns {Promise<object>} 完成后返回 I18n API
   */
  function load(lang) {
    var code = normalizeLang(lang) || DEFAULT_LANG;      // 目标语言（保证受支持）
    currentLang = code;
    saveLang(code);
    setHtmlLang(code);

    // 英文模式同时拉中文包：英文包缺失的键自动回落中文，避免出现裸键名
    var tasks = [fetchPack(code)];
    tasks.push(code === DEFAULT_LANG ? Promise.resolve({}) : fetchPack(DEFAULT_LANG));

    return Promise.all(tasks).then(function (res) {
      dict = res[0] || {};
      fallbackDict = code === DEFAULT_LANG ? (res[0] || {}) : (res[1] || {});
      loaded = true;
      applyDom(document);

      var queue = waiters.splice(0, waiters.length);     // 取出等待队列并清空
      queue.forEach(function (fn) {
        try { fn(); } catch (err) { console.error('[i18n] ready 回调执行失败', err); }
      });
      return api;
    });
  }

  /**
   * 等待语言包加载完成
   * @param {Function} [callback] 加载完成后的回调
   * @returns {Promise<object>} 完成后返回 I18n API
   */
  function ready(callback) {
    if (loaded) {
      if (typeof callback === 'function') {
        try { callback(); } catch (err) { console.error('[i18n] ready 回调执行失败', err); }
      }
      return Promise.resolve(api);
    }
    return new Promise(function (resolve) {
      waiters.push(function () {
        if (typeof callback === 'function') callback();
        resolve(api);
      });
    });
  }

  /**
   * 切换语言：重新加载语言包并广播 i18n:changed 事件
   * @param {string} lang 目标语言代码
   * @returns {Promise<object>} 切换完成后的 I18n API
   */
  function setLang(lang) {
    var code = normalizeLang(lang);
    if (!code || code === currentLang) return Promise.resolve(api);
    loaded = false;                                      // 重新加载期间 ready 继续排队
    return load(code).then(function (result) {
      document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: code } }));
      return result;
    });
  }

  /**
   * 监听语言切换
   * @param {Function} handler 回调，参数为 { lang }
   */
  function onChange(handler) {
    document.addEventListener('i18n:changed', function (e) {
      handler(e.detail || { lang: currentLang });
    });
  }

  api = {
    t: t,
    ready: ready,
    setLang: setLang,
    applyDom: applyDom,
    onChange: onChange,
    supported: SUPPORTED.slice()
  };

  // 语言代码通过 getter 暴露，始终返回当前值
  Object.defineProperty(api, 'lang', {
    get: function () { return currentLang; }
  });

  global.I18n = api;

  // 初始化：识别语言并异步加载语言包（不阻塞页面解析）
  load(detectLang());

  // 文档解析完成后再翻译一遍静态标注，覆盖脚本之后才出现的节点
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyDom(document); });
  } else {
    applyDom(document);
  }
})(window);
