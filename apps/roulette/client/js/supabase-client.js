/**
 * Supabase REST 客户端（fetch 封装）
 * 浏览器端直连，免 npm 依赖；兼容原项目 anon key
 */
const Supabase = (function () {
  /** 从 window.APP_CONFIG 或硬编码读取 */
  function getConfig() {
    const cfg = (typeof window !== 'undefined' && window.APP_CONFIG) || {};
    return {
      url: cfg.SUPABASE_URL || '',
      key: cfg.SUPABASE_ANON_KEY || '',
    };
  }

  /**
   * 发起 Supabase REST 调用
   * @param {string} method GET|POST|PUT|PATCH|DELETE
   * @param {string} path   rest/v1 下的表名或 auth/v1 路径
   * @param {object|string} queryOrBody 查询串对象 或 请求体
   * @param {object} options  { select, auth:true/false }
   */
  async function request(method, path, queryOrBody, options = {}) {
    const { url, key } = getConfig();
    if (!url || !key) throw new Error('Supabase 未配置');
    const isAuth = path.startsWith('/auth/v1');
    const fullPath = isAuth ? path : `/rest/v1/${path}`;
    let fullUrl = url + fullPath;
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (options.select) headers['Prefer'] = 'return=representation';

    let body = null;
    if (['GET', 'DELETE'].includes(method)) {
      const params = new URLSearchParams();
      if (typeof queryOrBody === 'object' && queryOrBody) {
        Object.entries(queryOrBody).forEach(([k, v]) => {
          if (v !== undefined && v !== null) {
            params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
          }
        });
      }
      const qs = params.toString();
      if (qs) fullUrl += (fullUrl.includes('?') ? '&' : '?') + qs;
    } else {
      body = typeof queryOrBody === 'string' ? queryOrBody : JSON.stringify(queryOrBody || {});
    }

    const resp = await fetch(fullUrl, { method, headers, body });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) {
      const err = new Error((data && (data.message || data.error_description || data.error)) || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return { data, headers: resp.headers };
  }

  // ============ Auth ============
  /** 获取当前登录用户 */
  async function getSession() {
    const { data } = await request('GET', '/auth/v1/user');
    return data; // { id, email, user_metadata, ... } 或 null
  }

  /** 邮箱学号登录（用虚拟邮箱编码姓名） */
  async function signInWithPassword(email, password) {
    return request('POST', '/auth/v1/token?grant_type=password', { email, password });
  }

  /** 注册 */
  async function signUp(email, password, metadata) {
    return request('POST', '/auth/v1/signup', {
      email, password,
      data: metadata,
    });
  }

  /** 登出 */
  async function signOut() {
    try { await request('POST', '/auth/v1/logout', {}); } catch (_) {}
    // 清 cookie（浏览器端由 SDK 管理，但 cookie 是 httpOnly 时只能服务端清；这里兜底）
    document.cookie.split(';').forEach(c => {
      const name = c.split('=')[0].trim();
      document.cookie = `${name}=;path=/;expires=${new Date().toUTCString()}`;
    });
    // localStorage 也清掉
    Object.keys(localStorage).filter(k => k.startsWith('supabase')).forEach(k => localStorage.removeItem(k));
  }

  // ============ 辅助 ============
  /** 姓名 → 虚拟邮箱（复刻原项目规则） */
  function usernameToEmail(username) {
    const encoded = btoa(encodeURIComponent(username))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${encoded}@miaoda.com`;
  }

  /** 学号补零到 6 位（兼容原项目 Supabase 6 位最小限制） */
  function padPassword(password) {
    return password.length < 6 ? password.padEnd(6, '0') : password;
  }

  // ============ Profiles ============
  async function getProfile(userId) {
    const { data } = await request('GET', 'profiles', { id: `eq.${userId}`, select: '*' });
    return Array.isArray(data) ? data[0] : null;
  }
  async function getAllProfiles() {
    const { data } = await request('GET', 'profiles', { order: 'created_at.asc' });
    return data || [];
  }
  async function updateProfile(userId, changes) {
    return request('PATCH', `profiles?id=eq.${userId}`, changes, { select: true });
  }
  async function deleteProfile(userId) {
    return request('DELETE', `profiles?id=eq.${userId}`, {}, { select: false });
  }

  // ============ Wheels ============
  async function listWheels(query = {}) {
    const q = Object.assign({ select: '*' }, query);
    const { data } = await request('GET', 'wheels', q);
    return Array.isArray(data) ? data : [];
  }
  async function getWheel(id) {
    const { data } = await request('GET', `wheels?id=eq.${id}`, { select: '*' });
    return Array.isArray(data) ? data[0] : null;
  }
  async function createWheel(payload) {
    const { data } = await request('POST', 'wheels', payload, { select: true });
    return data;
  }
  async function updateWheel(id, payload) {
    const { data } = await request('PATCH', `wheels?id=eq.${id}`, payload, { select: true });
    return data;
  }
  async function deleteWheel(id) {
    return request('DELETE', `wheels?id=eq.${id}`, {}, { select: false });
  }

  return {
    request, getSession, signInWithPassword, signUp, signOut,
    usernameToEmail, padPassword,
    getProfile, getAllProfiles, updateProfile, deleteProfile,
    listWheels, getWheel, createWheel, updateWheel, deleteWheel,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Supabase;
