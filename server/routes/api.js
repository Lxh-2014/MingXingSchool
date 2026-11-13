/**
 * 主项目统一 API 路由
 * ----------------------------------------------------------
 * 认证：
 *   POST /api/auth/login   统一登录（含 Android WebView 拦截 Admin）
 * 用户管理（仅 Admin）：
 *   GET    /api/users          用户列表
 *   POST   /api/users          创建用户
 *   PATCH  /api/users/:id      修改用户（name/password/role/id）
 *   DELETE /api/users/:id      删除用户
 * 个人资料（登录用户本人）：
 *   PATCH  /api/profile        修改自己的偏好（兼容保留，不再持久化）
 *
 * 会话与网盘共用 server/core/sessions（cookie token），登录后全站生效。
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 统一用户数据层 */
const store = require('../core/userStore');
/** 统一内存会话表（与网盘共享同一实例） */
const sessions = require('../core/sessions');
/** 邮件配置与发送（SMTP） */
const mailer = require('../core/mailer');
/** 服务端多语言提示（语言包与前端共用 public/assets/locales） */
const i18n = require('../core/i18n');

const router = express.Router();

/** 网盘头像图片目录（头像图片统一存这里，URL 为 /drive 前缀下公开） */
const avatarDir = path.join(__dirname, '../../apps/drive/server/assets/user');

/** Android WebView 主动追加到 UA 的特征后缀（见 MainActivity.kt） */
const WEBVIEW_UA_SIGNATURE = 'MingXingDrive';

// 确保头像目录存在
if (!fs.existsSync(avatarDir)) {
    fs.mkdirSync(avatarDir, { recursive: true });
}

/**
 * 从 cookie 会话解析当前登录用户 id
 * @param {import('express').Request} req Express 请求对象
 * @returns {string | undefined} 未登录返回 undefined
 */
function currentUserId(req) {
    // 同源网页用 cookie，离线跨域客户端用 Authorization: Bearer
    const token = sessions.getTokenFromRequest(req);
    return token ? sessions.getUserId(token) : undefined;
}

/**
 * 登录守卫：要求有效会话，失败返回 401 JSON
 */
function requireAuth(req, res, next) {
    const userId = currentUserId(req);
    if (!userId) {
        const lang = i18n.resolveLang(req);   // 本请求偏好的语言
        return res.status(401).json({ success: false, message: i18n.t('server.auth.notLoggedIn', {}, lang) });
    }
    req.userId = userId;   // 挂到请求上供后续处理使用
    next();
}

/**
 * 管理员守卫：在登录守卫基础上要求 Admin 角色，失败返回 403
 */
function requireAdmin(req, res, next) {
    const userId = currentUserId(req);
    const lang = i18n.resolveLang(req);        // 本请求偏好的语言
    if (!userId) return res.status(401).json({ success: false, message: i18n.t('server.auth.notLoggedIn', {}, lang) });
    if (!store.isAdminId(userId)) return res.status(403).json({ success: false, message: i18n.t('server.auth.adminRequired', {}, lang) });
    req.userId = userId;
    next();
}

/**
 * 根据 userId 拼出登录/个人信息响应里的 avatar / avatarColor 字段
 * 规则：网盘头像目录存在 <id>.png 即为图片头像，否则无头像（纯色模式已移除）
 * @param {string} id 用户 id
 * @returns {{ avatar: string | null, avatarColor: string | null }}
 */
function buildAvatarResponse(id) {
    const file = path.join(avatarDir, `${id}.png`);
    if (fs.existsSync(file)) {
        return { avatar: `/drive/assets/user/${id}.png`, avatarColor: null };
    }
    return { avatar: null, avatarColor: null };
}

/**
 * POST /api/auth/login
 * 统一登录接口（公开访问）：校验姓名密码，签发 cookie 会话
 * 响应字段与原网盘登录接口一致，便于前端无缝切换
 */
router.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const lang = i18n.resolveLang(req);                    // 本次响应使用的语言

    if (!username || !password) {
        return res.status(400).json({ success: false, message: i18n.t('server.auth.missingCredentials', {}, lang) });
    }

    // 双路识别 WebView / App 客户端：
    // 1) Android App 的 UA 后缀（MingXingDrive/1.0）
    // 2) PC 客户端自定义 Header（X-Client-Type）
    const userAgent = (req.headers['user-agent'] || '').toString();
    const clientType = (req.headers['x-client-type'] || '').toString();
    const isWebView = userAgent.includes(WEBVIEW_UA_SIGNATURE) ||
                      clientType.includes('MingXingDrive-WebView');

    // WebView 禁止登录 Admin（保护管理员账户不被 App 端滥用）
    if (isWebView && username === store.ADMIN_NAME) {
        console.warn(`[Auth] 拦截 WebView 尝试登录 Admin，UA="${userAgent.slice(0, 80)}" header="${clientType}"`);
        return res.status(403).json({
            success: false,
            message: i18n.t('server.auth.adminWebOnly', {}, lang)
        });
    }

    // 统一用户库校验
    const r = store.verifyLogin(username, password);
    if (!r.ok) {
        // userStore 目前返回中文原因，这里按原因映射到语言包键（后续可改为返回错误码）
        const key = r.message === '用户不存在' ? 'server.auth.userNotFound' : 'server.auth.wrongPassword';
        return res.status(401).json({ success: false, message: i18n.t(key, {}, lang) });
    }

    const id = r.id;
    const entry = store.getUserById(id);

    // 生成随机 token 并登记会话
    const token = crypto.randomBytes(16).toString('hex');
    const { avatar } = buildAvatarResponse(id);
    sessions.addSession(token, id);

    // 写入 httpOnly cookie（24 小时有效）
    res.cookie('token', token, {
        httpOnly: true,
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    });

    console.log(`[Auth] 用户 "${username}"（${id}）登录成功`);
    res.json({
        success: true,
        message: i18n.t('server.auth.loginSuccess', {}, lang),
        username,
        isAdmin: r.isAdmin,
        userId: id,
        avatar,
        // 网页客户端使用 Bearer token 跨域鉴权；cookie 仍然照常写入供同源页面使用
        token
    });
});

/**
 * POST /api/auth/ticket
 * 为网页客户端生成一次性登录票据（需已登录）
 * 用途：客户端从 file:// 或其它域打开 /drive 等子应用时，顶层导航无法带上
 *       Authorization 头，先换票再让服务器写 cookie。
 */
router.post('/auth/ticket', requireAuth, (req, res) => {
    const token = sessions.getTokenFromRequest(req);          // 当前请求携带的会话 token
    if (!token) {
        return res.status(401).json({ success: false, message: i18n.t('server.auth.notLoggedIn', {}, i18n.resolveLang(req)) });
    }
    const ticket = sessions.createLoginTicket(token, req.userId);   // 一次性票据
    res.json({ success: true, ticket, expiresIn: 120 });
});

/**
 * 校验客户端回跳路径：仅允许站内已知前缀，防开放重定向
 * @param {*} value 原始 next 参数
 * @returns {string} 安全的站内路径
 */
function safeClientNext(value) {
    const next = typeof value === 'string' ? value : '/';
    if (!next.startsWith('/') || next.startsWith('//')) return '/';
    const allowed = ['/', '/drive', '/roulette', '/broadcast', '/shop', '/settings', '/usermanagement', '/mail', '/client'];
    const matched = allowed.some(prefix => next === prefix || next.startsWith(prefix + '/'));
    return matched ? next : '/';
}

/**
 * GET /api/auth/open?ticket=xxx&next=/drive
 * 消费一次性票据，写入登录 cookie 后跳转子应用
 * 说明：这是顶层页面导航，cookie 会在服务器域下正常落盘。
 */
router.get('/auth/open', (req, res) => {
    const ticket = String(req.query.ticket || '');            // 客户端传入的票据
    const result = sessions.consumeLoginTicket(ticket);       // 一次性消费
    if (!result) {
        res.status(400).type('html').send(
            '<!DOCTYPE html><meta charset="utf-8"><title>登录票据无效</title>' +
            '<div style="font-family:sans-serif;max-width:460px;margin:80px auto;line-height:1.8">' +
            '<h2>登录票据无效或已过期</h2><p>请回到网页客户端重新打开该应用。</p></div>'
        );
        return;
    }

    res.cookie('token', result.token, {
        httpOnly: true,
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    });
    res.redirect(safeClientNext(req.query.next));
});

/**
 * GET /api/users
 * 全量用户列表（仅 Admin），字段已脱敏（不含密码哈希）
 */
router.get('/users', requireAdmin, (req, res) => {
    res.json({ success: true, users: store.listUsers() });
});

/**
 * POST /api/users
 * 创建新用户（仅 Admin），请求体：{ name, password, id? }（id 可选：自定义用户 ID，留空自动生成）
 */
router.post('/users', requireAdmin, (req, res) => {
    const { name, password, id } = req.body || {};
    const r = store.createUser(name, password, id);
    res.status(r.ok ? 200 : 400).json({ success: r.ok, message: r.message, id: r.id });
});

/**
 * PATCH /api/users/:id
 * 修改指定用户（仅 Admin）。请求体可含任意子集：
 * { name?, password?, role?, points?, id? }（password 即重置密码；points 即设置积分；id 即改 ID，需最后执行）
 */
router.patch('/users/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const results = [];   // 依次收集各字段操作结果

    if (body.password !== undefined) results.push(store.resetPassword(id, body.password));
    if (body.name !== undefined) results.push(store.setName(id, body.name));
    if (body.role !== undefined) results.push(store.setRole(id, body.role));
    if (body.points !== undefined) results.push(store.setPoints(id, body.points));
    // theme/color/avatar 字段已从用户数据移除，忽略对应请求
    // 改 ID 放最后：其他字段先按旧 id 修改完成，再整体改名
    let newId = null;
    if (body.id !== undefined && body.id !== id) {
        const r = store.setId(id, body.id);
        if (r.ok) newId = String(body.id).trim();
        results.push(r);
    }

    if (!results.length) {
        return res.status(400).json({ success: false, message: '没有要更新的字段' });
    }
    const failed = results.find(r => !r.ok);
    if (failed) return res.status(400).json({ success: false, message: failed.message });

    res.json({ success: true, message: '已保存', newId });
});

/**
 * DELETE /api/users/:id
 * 删除用户（仅 Admin，不能删除 Admin 本人账户）
 */
router.delete('/users/:id', requireAdmin, (req, res) => {
    const r = store.deleteUser(req.params.id);
    res.status(r.ok ? 200 : 400).json({ success: r.ok, message: r.message });
});

/**
 * PATCH /api/profile
 * 兼容保留（转盘皮肤功能已移除）：不持久化任何数据，直接返回成功
 */
router.patch('/profile', requireAuth, (req, res) => {
    res.json({ success: true, message: '已保存' });
});

/**
 * POST /api/profile/password
 * 登录用户修改自己的密码（需旧密码验证），请求体：{ oldPassword, newPassword }
 */
router.post('/profile/password', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
        return res.status(400).json({ success: false, message: '缺少旧密码或新密码' });
    }
    const r = store.changePassword(req.userId, oldPassword, newPassword);
    res.status(r.ok ? 200 : 401).json({ success: r.ok, message: r.message });
});

/**
 * GET /api/mail/me
 * 读取当前登录用户绑定的邮箱（未绑定返回空字符串）
 */
router.get('/mail/me', requireAuth, (req, res) => {
    res.json({ success: true, binding: mailer.getBinding(req.userId) });
});

/**
 * PUT /api/mail/me
 * 绑定 / 修改 / 解绑当前用户的邮箱；请求体：{ email }
 * email 为空字符串表示解绑；同一邮箱允许被多个账号绑定
 */
router.put('/mail/me', requireAuth, (req, res) => {
    try {
        const binding = mailer.setBinding(req.userId, (req.body && req.body.email) || '');
        res.json({
            success: true,
            message: binding.email ? '邮箱已保存' : '已解绑邮箱',
            binding
        });
    } catch (e) {
        /* 格式校验失败统一 400，提示可直接展示给用户 */
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * GET /api/mail/config
 * 读取邮件服务器配置（仅管理员）；授权码只返回「是否已设置」布尔值
 */
router.get('/mail/config', requireAdmin, (req, res) => {
    res.json({ success: true, config: mailer.getPublicConfig() });
});

/**
 * PUT /api/mail/config
 * 保存邮件服务器配置（仅管理员）；请求体：{ host, port, secure, user, pass, fromName, fromAddress }
 * pass 留空表示沿用已保存的授权码
 */
router.put('/mail/config', requireAdmin, (req, res) => {
    try {
        mailer.saveConfig(req.body || {});
        res.json({ success: true, message: '邮件配置已保存', config: mailer.getPublicConfig() });
    } catch (e) {
        /* 校验类错误统一 400，便于前端直接展示中文提示 */
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * GET /api/mail/bindings
 * 管理员查看所有用户绑定的邮箱，返回 [{ userId, email, boundAt }]
 */
router.get('/mail/bindings', requireAdmin, (req, res) => {
    res.json({ success: true, bindings: mailer.listBindings() });
});

/**
 * PUT /api/mail/bindings/:userId
 * 管理员为指定用户绑定 / 修改 / 解绑邮箱；请求体：{ email }
 * email 为空字符串表示解绑；同一邮箱允许被多个账号绑定
 */
router.put('/mail/bindings/:userId', requireAdmin, (req, res) => {
    const userId = req.params.userId;                          // 目标用户 id
    if (!store.getUserById(userId)) {
        return res.status(404).json({ success: false, message: '用户不存在' });
    }
    try {
        const binding = mailer.setBinding(userId, (req.body && req.body.email) || '');
        res.json({
            success: true,
            message: binding.email ? '邮箱已保存' : '已解绑邮箱',
            binding
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * GET /api/mail/students
 * 处罚邮件用：列出可发送对象（已绑定邮箱的用户，仅管理员）
 * 返回 [{ userId, name, email }]
 */
router.get('/mail/students', requireAdmin, (req, res) => {
    const byId = {};                                            // id → 邮箱
    mailer.listBindings().forEach(b => { byId[b.userId] = b.email; });
    const students = store.listUsers()
        .filter(u => byId[u.id])
        .map(u => ({ userId: u.id, name: u.name, email: byId[u.id] }));
    res.json({ success: true, students });
});

/**
 * POST /api/mail/discipline
 * 发送纪律告知（处罚）邮件（仅管理员）
 * 请求体：{ userId, date, reason, punishments: string[], grade, className }
 * 收件人取该用户已绑定的邮箱，正文按固定模板生成
 */
router.post('/mail/discipline', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const userId = String(body.userId || '').trim();            // 目标学生 id
    const user = store.getUserById(userId);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    const binding = mailer.getBinding(userId);                  // 学生绑定的邮箱
    if (!binding.email) {
        return res.status(400).json({ success: false, message: '该用户尚未绑定邮箱，请先在用户管理中绑定' });
    }

    const date = String(body.date || '').trim();                // 违纪日期
    const reason = String(body.reason || '').trim();            // 违纪原因
    if (!date) return res.status(400).json({ success: false, message: '请填写违纪日期' });
    if (!reason) return res.status(400).json({ success: false, message: '请填写违纪原因' });

    const punishments = (Array.isArray(body.punishments) ? body.punishments : [])
        .map(p => String(p || '').trim())
        .filter(Boolean);                                        // 处理决定（至少一条）
    if (!punishments.length) {
        return res.status(400).json({ success: false, message: '请至少填写一条处理决定' });
    }

    const mail = mailer.buildDisciplineMail({
        name: user.name,
        date,
        reason,
        punishments,
        grade: body.grade,
        className: body.className
    });

    try {
        const result = await mailer.sendMail({
            to: binding.email,
            subject: mail.subject,
            text: mail.text
        });
        res.json({
            success: true,
            message: `已发送至 ${binding.email}`,
            subject: mail.subject,
            messageId: result.messageId
        });
    } catch (e) {
        const detail = e && e.message ? `：${e.message}` : '';
        res.status(500).json({ success: false, message: '处罚邮件发送失败' + detail });
    }
});

/**
 * POST /api/mail/test
 * 使用已保存的配置发送一封测试邮件（仅管理员）；请求体：{ to }
 */
router.post('/mail/test', requireAdmin, async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim();   // 测试收件人
    if (!to) return res.status(400).json({ success: false, message: '请填写测试收件人邮箱' });
    /* 简单邮箱格式校验，避免明显无效地址发到 SMTP 才报错 */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ success: false, message: '收件人邮箱格式不正确' });
    }
    try {
        const result = await mailer.sendMail({
            to,
            subject: '明星学校 · 邮件配置测试',
            text: '这是一封来自明星学校的测试邮件。\n\n如果你收到这封邮件，说明邮件服务配置成功。',
            html: '<p>这是一封来自<b>明星学校</b>的测试邮件。</p><p>如果你收到这封邮件，说明邮件服务配置成功。</p>'
        });
        res.json({ success: true, message: '测试邮件已发送，请查收', messageId: result.messageId });
    } catch (e) {
        /* SMTP 报错原文附加在中文提示后，便于排查授权码/端口问题 */
        const detail = e && e.message ? `：${e.message}` : '';
        res.status(500).json({ success: false, message: '测试邮件发送失败' + detail });
    }
});

module.exports = router;
