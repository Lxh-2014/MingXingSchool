/**
 * 会话管理（转发层）
 * 实际会话表已统一收口到主项目 server/core/sessions.js，
 * 此处仅 re-export，保证网盘与主项目共享同一份内存会话。
 */
module.exports = require('../../../../server/core/sessions');
