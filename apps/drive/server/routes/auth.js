/**
 * 认证路由（重构后：全部走 database.js 统一数据层）
 * - 登录：verifyLogin → 返回 token / userId / isAdmin / avatar / avatarColor
 * - 管理员改密：changePassword(id="Admin", ...)
 * - 用户列表：只返回普通用户名，不包含 Admin
 * - WebView 登录 Admin 拒绝（UA 含 MingXingDrive）
 * - 登录成功时登记 token 到 sessions，供 /admin 路由校验
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { t } = require('../utils/locale');
const db = require('../utils/database');
const sessions = require('../utils/sessions');

const router = express.Router();
const avatarDir = path.join(__dirname, '../assets/user');

/** Android WebView 主动追加到 UA 的特征后缀（见 MainActivity.kt） */
const WEBVIEW_UA_SIGNATURE = 'MingXingDrive';

// 确保头像目录存在
if (!fs.existsSync(avatarDir)) {
    fs.mkdirSync(avatarDir, { recursive: true });
}

/**
 * 根据 userId 拼出登录响应里的 avatar / avatarColor 字段
 * 规则：头像目录存在 <id>.png 即为图片头像，否则无（纯色模式已移除）
 * @param {string} id - 用户 id
 * @returns {{ avatar: string | null, avatarColor: string | null }}
 */
function buildAvatarResponse(id) {
    const file = path.join(avatarDir, `${id}.png`);
    if (fs.existsSync(file)) {
        return { avatar: `/assets/user/${id}.png`, avatarColor: null };
    }
    return { avatar: null, avatarColor: null };
}

/**
 * POST /api/auth/login
 * 用户登录接口（统一支持普通用户与管理员 Admin）
 * 若识别为 WebView 且目标是 Admin，返回 403 要求使用网页登录
 */
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: t('auth.missingUsernameOrPassword') });
    }

    // 双路识别 WebView / App 客户端
    // 1) Android App 后缀在 UA（MingXingDrive/1.0）
    // 2) PC 版 webview/pc 的 api.js 自定义 Header（X-Client-Type）
    const userAgent = (req.headers['user-agent'] || '').toString();
    const clientType = (req.headers['x-client-type'] || '').toString();
    const isWebView = userAgent.includes('MingXingDrive') ||
                      clientType.includes('MingXingDrive-WebView');

    // WebView 禁止登录 Admin（保护管理员账户不被 App 端滥用）
    if (isWebView && username === db.ADMIN_NAME) {
        console.warn(`[Auth] 拦截 WebView 尝试登录 Admin，UA="${userAgent.slice(0, 80)}" header="${clientType}"`);
        return res.status(403).json({
            success: false,
            message: '请使用网页浏览器登录管理员账户'
        });
    }

    // 统一从 users.json 校验
    const r = db.verifyLogin(username, password);
    if (!r.ok) {
        return res.status(401).json({ success: false, message: r.message });
    }

    const id = r.id;
    const entry = db.getUserById(id);

    const token = crypto.randomBytes(16).toString('hex');
    const { avatar, avatarColor } = buildAvatarResponse(id);

    // 登记本次会话（后续 /admin 路由会读这个 token）
    sessions.addSession(token, id);

    res.cookie('token', token, {
        httpOnly: true,
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    });

    res.json({
        success: true,
        message: t('auth.loginSuccess'),
        username,
        isAdmin: r.isAdmin,
        userId: id,
        avatar,
        avatarColor
    });
});

/**
 * GET /api/auth/users
 * 获取所有普通用户列表（不包含 Admin，避免暴露管理员账户）
 */
router.get('/users', (req, res) => {
    res.json({ success: true, users: db.listNormalUserNames() });
});

/**
 * POST /api/auth/admin/change-password
 * 管理员修改自己的密码接口
 * 请求体: { oldPassword: string, newPassword: string }
 */
router.post('/admin/change-password', (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ success: false, message: '缺少旧学号或新学号' });
    }

    const r = db.changePassword(db.ADMIN_ID, oldPassword, newPassword);
    if (!r.ok) {
        return res.status(401).json({ success: false, message: r.message });
    }
    console.log('[Auth] 管理员密码已修改');
    res.json({ success: true, message: r.message });
});

module.exports = router;
module.exports.sessions = sessions;       // 让 index.js 的 /admin 路由可以读到 adminTokens
