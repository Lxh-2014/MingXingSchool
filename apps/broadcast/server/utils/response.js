/**
 * 统一 REST 响应体工具。
 * 所有路由返回 {ok: true, data} 或 {ok: false, error:{code, message}}，
 * 便于前端 common.js 做统一解析。
 */

/**
 * 返回成功响应。
 * @param {import('express').Response} res Express 响应对象
 * @param {*} data 响应数据
 */
function ok(res, data) {
  res.json({ ok: true, data });
}

/**
 * 返回失败响应（HTTP 400 / 500 可由 code 区分）。
 * @param {import('express').Response} res Express 响应对象
 * @param {number} status HTTP 状态码
 * @param {string} code 业务错误码（英文，便于前端分类）
 * @param {string} message 面向用户的中文提示
 */
function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message } });
}

module.exports = { ok, fail };
