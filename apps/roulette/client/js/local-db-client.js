/**
 * 本地 DB 客户端（Express /api/* 封装）
 * 登录态由主项目 cookie 承载：同源 fetch 自动携带，无需手动管理 token。
 */
const LocalDB = (function () {
  /** API 路径前缀：挂载到明星学校后，接口实际地址为 /roulette/api/... */
  const API_PREFIX = '/roulette';

  /**
   * 统一 fetch 封装（自动携带 cookie，JSON 解析与错误规范化）
   */
  async function request(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

    const resp = await fetch(API_PREFIX + path, opts);
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) {
      const err = new Error((data && data.error) || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ============ Auth ============
  function me() { return request('GET', '/api/auth/me'); }

  // ============ Wheels ============
  function listWheels() { return request('GET', '/api/wheels'); }
  function getWheel(id) { return request('GET', `/api/wheels/${id}`); }
  function createWheel(payload) { return request('POST', '/api/wheels', payload); }
  function updateWheel(id, payload) { return request('PATCH', `/api/wheels/${id}`, payload); }
  function deleteWheel(id) { return request('DELETE', `/api/wheels/${id}`); }

  return {
    me, logout: async function () { try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {} },
    listWheels, getWheel, createWheel, updateWheel, deleteWheel,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LocalDB;
window.LocalDB = LocalDB;
