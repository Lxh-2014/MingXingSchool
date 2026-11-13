/**
 * Auth 会话管理（cookie 统一会话版）
 * ----------------------------------------------------------
 * 登录态由主项目 cookie（token）承载，本模块只负责：
 *   - 拉取当前用户（/roulette/api/auth/me）
 *   - 登出（调主项目 /api/logout 清除 cookie）
 *   - 未登录守卫（跳统一登录页 /login）
 */
const Auth = (function () {
  /** 本地缓存的用户信息键（仅加速渲染，权威以服务端为准） */
  const CACHE_KEY = 'wheel_app_user';

  /** 读缓存用户 */
  function getCached() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) { return null; } }
  /** 写缓存用户 */
  function setCached(obj) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch (_) {} }
  /** 清缓存用户 */
  function clearCached() { try { localStorage.removeItem(CACHE_KEY); } catch (_) {} }

  /**
   * 登出：请求主项目统一登出接口销毁会话并清除 cookie
   */
  async function logout() {
    clearCached();
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
  }

  /**
   * 获取当前会话（带缓存，401 时清缓存）
   * @returns {{ user: object } | null} 未登录返回 null
   */
  async function getCurrent() {
    try {
      const user = await LocalDB.me();
      const fresh = { user, loginAt: Date.now() };
      setCached(fresh);
      return fresh;
    } catch (err) {
      if (err.status === 401) { clearCached(); return null; }
      return getCached();
    }
  }

  /**
   * 登录守卫：未登录跳转主项目统一登录页
   * @param {string} redirectTo 统一登录页地址
   */
  async function requireLogin(redirectTo = '/login') {
    const current = await getCurrent();
    if (!current) {
      const loc = new URL(window.location.href);
      window.location.href = `${redirectTo}?next=${encodeURIComponent(loc.pathname)}`;
      return null;
    }
    return current;
  }

  return { getCached, logout, getCurrent, requireLogin };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Auth;
