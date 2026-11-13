/**
 * i18n.js —— 明星学校服务端国际化模块
 * ----------------------------------------------------------
 * 与前端共用同一份语言包：public/assets/locales/<lang>.json
 * 语言识别优先级：?lang= > cookie.lang > Accept-Language > zh-CN
 * 用法：
 *   const i18n = require('./core/i18n');
 *   const lang = i18n.resolveLang(req);
 *   res.json({ message: i18n.t('server.auth.notLoggedIn', {}, lang) });
 */
const fs = require('fs');
const path = require('path');

/** 语言包目录（与前端共用） */
const LOCALE_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'locales');

/** 支持的语言代码 */
const SUPPORTED_LANGS = ['zh-CN', 'en-US'];

/** 默认语言（中文） */
const DEFAULT_LANG = 'zh-CN';

/** 语言包缓存：lang → 解析后的对象，避免每次请求重复读盘 */
const cache = new Map();

/**
 * 规整语言代码：zh* → zh-CN，en* → en-US，其他返回空字符串
 * @param {string} value 原始语言标识
 * @returns {string} 受支持的语言代码，不支持时为空
 */
function normalizeLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('zh')) return 'zh-CN';
  if (raw.startsWith('en')) return 'en-US';
  return '';
}

/**
 * 读取指定语言的词条对象（带进程内缓存）
 * @param {string} lang 语言代码
 * @returns {object} 语言包对象，读取失败时返回空对象
 */
function loadDict(lang) {
  const code = normalizeLang(lang) || DEFAULT_LANG;
  if (cache.has(code)) return cache.get(code);

  let dict = {};
  try {
    const file = path.join(LOCALE_DIR, code + '.json');
    let raw = fs.readFileSync(file, 'utf8');
    // 去掉 Windows 编辑器可能写入的 UTF-8 BOM，否则 JSON.parse 会报错
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    dict = JSON.parse(raw);
  } catch (err) {
    console.warn('[i18n] 语言包加载失败：' + code, err.message);
  }
  cache.set(code, dict);
  return dict;
}

/**
 * 从语言包对象中按 a.b.c 路径取值
 * @param {object} source 语言包对象
 * @param {string} key 点分键
 * @returns {*} 命中的值，未命中返回 undefined
 */
function getByPath(source, key) {
  const parts = String(key || '').split('.');
  let node = source;
  for (let i = 0; i < parts.length; i++) {
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
  return text.replace(/\{(\w+)\}/g, (match, name) => (
    params[name] !== undefined && params[name] !== null ? String(params[name]) : match
  ));
}

/**
 * 取多语言文案
 * @param {string} key 语言包键（如 server.auth.notLoggedIn）
 * @param {object} [params] 占位参数
 * @param {string} [lang] 语言代码，缺省中文
 * @returns {string} 最终文案；全部缺失时返回键名
 */
function t(key, params, lang) {
  const dict = loadDict(lang);
  let value = getByPath(dict, key);

  // 非默认语言缺失该键时，回落默认中文包
  if (typeof value !== 'string' && normalizeLang(lang) !== DEFAULT_LANG) {
    value = getByPath(loadDict(DEFAULT_LANG), key);
  }
  if (typeof value !== 'string') return key;
  return format(value, params);
}

/**
 * 解析请求中的 cookie
 * @param {import('express').Request} req Express 请求对象
 * @returns {object} cookie 键值表
 */
function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const result = {};
  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const name = part.slice(0, index).trim();
    if (!name) return;
    try {
      result[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch (e) {
      result[name] = part.slice(index + 1).trim();
    }
  });
  return result;
}

/**
 * 解析请求希望使用的语言
 * @param {import('express').Request} req Express 请求对象
 * @returns {string} 受支持的语言代码
 */
function resolveLang(req) {
  const queryLang = req.query && req.query.lang;                 // URL 显式指定
  const cookieLang = parseCookies(req).lang;                     // 前端切换后写入的 cookie
  const accept = String((req.headers && req.headers['accept-language']) || '');  // 浏览器偏好

  return normalizeLang(queryLang) ||
         normalizeLang(cookieLang) ||
         normalizeLang(accept.split(',')[0]) ||
         DEFAULT_LANG;
}

module.exports = {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  normalizeLang,
  loadDict,
  t,
  resolveLang
};
