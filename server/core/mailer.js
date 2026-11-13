/**
 * 邮件服务核心模块
 * ----------------------------------------------------------
 * 职责：
 *   1) 读写邮件服务器配置（server/data/mail-config.json）
 *   2) 对外输出配置时隐藏授权码，只返回「是否已设置」
 *   3) 基于 nodemailer 创建 SMTP 传输器并发送邮件（当前用于「发送测试邮件」）
 *   4) 读写用户邮箱绑定（server/data/mail-bindings.json）
 *
 * 邮箱绑定单独存文件（不写进用户记录）：用户记录只保留 name/psw/role/points 四个字段；
 * 绑定格式为 { "<userId>": { "email": "...", "boundAt": "ISO 时间" } }，同一邮箱可被多个账号绑定。
 *
 * 配置字段：
 *   host         SMTP 服务器地址，如 smtp.qq.com
 *   port         端口，SSL 常用 465，STARTTLS 常用 587
 *   secure       是否使用 SSL/TLS（465 端口填 true）
 *   user         登录邮箱账号，如 xxx@qq.com
 *   pass         邮箱授权码（非登录密码），仅保存在服务端，接口不返回明文
 *   fromName     发件人显示名称，如「明星学校」
 *   fromAddress  发件人地址，留空时使用 user
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

/** 配置文件路径：主项目数据目录下的 mail-config.json */
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'mail-config.json');

/** 用户邮箱绑定文件路径：mail-bindings.json（按 userId 存，与用户记录分离） */
const BINDINGS_FILE = path.join(__dirname, '..', 'data', 'mail-bindings.json');

/** 默认配置（首次使用时为空，表示尚未配置） */
const DEFAULT_CONFIG = {
    host: '',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    fromName: '',
    fromAddress: '',
    updatedAt: ''
};

/**
 * 读取邮件配置（文件不存在或损坏时返回默认空配置）
 * @returns {object} 邮件配置对象（含明文 pass）
 */
function readConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return Object.assign({}, DEFAULT_CONFIG);
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Object.assign({}, DEFAULT_CONFIG, data);
    } catch (e) {
        console.error('[邮件] 读取配置文件失败:', e.message);
        return Object.assign({}, DEFAULT_CONFIG);
    }
}

/**
 * 写入邮件配置（自动创建数据目录）
 * @param {object} config 完整配置对象
 */
function writeConfig(config) {
    const dir = path.dirname(CONFIG_FILE);                    // 数据目录
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * 把端口与 SSL 取值规范化
 * @param {*} port 原始端口
 * @param {*} secure 原始 SSL 标记
 * @returns {{port: number, secure: boolean}} 规范化结果
 */
function normalizePortSecure(port, secure) {
    const n = Number(port);                                   // 端口数字
    const finalPort = Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 465;
    return {
        port: finalPort,
        /* 布尔化：未显式传 true 时，465 端口默认开启 SSL */
        secure: typeof secure === 'boolean' ? secure : finalPort === 465
    };
}

/**
 * 保存配置（前端传来的授权码为空时保留原值，避免误清空）
 * @param {object} body 请求体 { host, port, secure, user, pass, fromName, fromAddress }
 * @returns {object} 保存后的完整配置（含明文 pass，仅供服务端内部使用）
 * @throws {Error} 校验不通过时抛出中文错误
 */
function saveConfig(body) {
    const input = body || {};
    const host = String(input.host || '').trim();              // SMTP 服务器地址
    const user = String(input.user || '').trim();              // 登录邮箱账号
    const fromName = String(input.fromName || '').trim();      // 发件人显示名
    const fromAddress = String(input.fromAddress || '').trim() || user;   // 发件人地址（默认同账号）

    if (!host) throw new Error('请填写 SMTP 服务器地址');
    if (!user) throw new Error('请填写发送邮箱账号');

    const old = readConfig();                                  // 原配置（用于保留授权码）
    const incomingPass = String(input.pass || '');             // 前端提交的授权码
    /* 授权码：留空或仍是掩码占位时沿用旧值 */
    const pass = incomingPass && incomingPass !== '******' ? incomingPass : old.pass;

    if (!pass) throw new Error('请填写邮箱授权码（不是登录密码）');

    const { port, secure } = normalizePortSecure(input.port, input.secure);   // 端口与 SSL

    const config = {
        host,
        port,
        secure,
        user,
        pass,
        fromName,
        fromAddress,
        updatedAt: new Date().toISOString()
    };
    writeConfig(config);
    return config;
}

/**
 * 对外暴露的配置视图（隐藏授权码明文）
 * @returns {object} { host, port, secure, user, fromName, fromAddress, hasPassword, updatedAt }
 */
function getPublicConfig() {
    const cfg = readConfig();
    return {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user,
        fromName: cfg.fromName,
        fromAddress: cfg.fromAddress,
        hasPassword: !!cfg.pass,                               // 是否已保存授权码
        updatedAt: cfg.updatedAt
    };
}

/**
 * 读取全部邮箱绑定（文件不存在或损坏时返回空对象）
 * @returns {object} { [userId]: { email, boundAt } }
 */
function readBindings() {
    try {
        if (!fs.existsSync(BINDINGS_FILE)) return {};
        const raw = fs.readFileSync(BINDINGS_FILE, 'utf8');
        const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        console.error('[邮件] 读取邮箱绑定失败:', e.message);
        return {};
    }
}

/**
 * 写入全部邮箱绑定
 * @param {object} bindings 绑定映射
 */
function writeBindings(bindings) {
    const dir = path.dirname(BINDINGS_FILE);                   // 数据目录
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BINDINGS_FILE, JSON.stringify(bindings, null, 2), 'utf8');
}

/**
 * 校验邮箱格式
 * @param {string} email 邮箱地址
 * @returns {boolean} 是否合法
 */
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * 读取某个用户绑定的邮箱
 * @param {string} userId 用户 id
 * @returns {{email: string, boundAt: string}} 未绑定返回空字符串邮箱
 */
function getBinding(userId) {
    const bindings = readBindings();
    const item = bindings[userId];
    if (!item) return { email: '', boundAt: '' };
    return { email: item.email || '', boundAt: item.boundAt || '' };
}

/**
 * 绑定 / 修改 / 解绑用户邮箱（同一邮箱允许被多个账号绑定，不做唯一性校验）
 * @param {string} userId 用户 id
 * @param {string} email 邮箱地址；传空字符串表示解绑
 * @returns {{email: string, boundAt: string}} 绑定后的结果
 * @throws {Error} 邮箱格式不合法时抛出中文错误
 */
function setBinding(userId, email) {
    const value = String(email || '').trim();                  // 规范化后的邮箱
    const bindings = readBindings();
    if (!value) {
        delete bindings[userId];                               // 解绑：移除该用户的记录
        writeBindings(bindings);
        return { email: '', boundAt: '' };
    }
    if (!isValidEmail(value)) throw new Error('邮箱格式不正确，请检查后重试');
    const item = { email: value, boundAt: new Date().toISOString() };
    bindings[userId] = item;
    writeBindings(bindings);
    return item;
}

/**
 * 迁移邮箱绑定（用户改 ID 时由 userStore 的 onIdChange 回调触发）
 * @param {string} oldId 旧用户 id
 * @param {string} newId 新用户 id
 */
function migrateBinding(oldId, newId) {
    const bindings = readBindings();
    if (!bindings[oldId]) return;
    bindings[newId] = bindings[oldId];                         // 绑定记录跟到新 ID
    delete bindings[oldId];
    writeBindings(bindings);
}

/**
 * 获取所有已绑定邮箱的用户（供后续管理员群发使用）
 * @returns {Array<{userId: string, email: string, boundAt: string}>} 绑定列表
 */
function listBindings() {
    const bindings = readBindings();
    return Object.keys(bindings).map(function (userId) {
        return {
            userId,
            email: bindings[userId].email || '',
            boundAt: bindings[userId].boundAt || ''
        };
    }).filter(function (it) { return !!it.email; });
}

/** 基于已保存配置创建 SMTP 传输器
 * @param {object} cfg 邮件配置
 * @returns {import('nodemailer').Transporter} 传输器实例
 */
function createTransport(cfg) {
    return nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        /* 邮件服务器证书异常时直接报错，避免静默失败 */
        tls: { rejectUnauthorized: false },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
    });
}

/**
 * 生成「纪律告知」邮件的主题与正文
 * 模板（管理员可自行调整以下文案）：
 *   主题：【纪律告知】关于[姓名]同学违纪行为的处理通知
 *   正文：致家长 → 事情经过 → 处理决定列表 → 家校配合 → 落款（学校 + 年级班级）
 * @param {object} data { name, date, reason, punishments, grade, className }
 * @returns {{subject: string, text: string}} 主题与正文（纯文本）
 */
function buildDisciplineMail(data) {
    const name = String(data.name || '').trim();               // 学生姓名
    const reason = String(data.reason || '').trim();            // 违纪原因
    const dateRaw = String(data.date || '').trim();             // 违纪日期（YYYY-MM-DD）
    const grade = String(data.grade || '').trim();              // 年级，如「七」
    const className = String(data.className || '').trim();       // 班级，如「3」
    const punishments = (data.punishments || [])
        .map(function (p) { return String(p || '').trim(); })
        .filter(function (p) { return !!p; });                   // 去掉空行的处理决定

    /* 日期格式化为「XXXX年XX月XX日」，解析失败时原样使用 */
    let dateText = dateRaw;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateRaw);
    if (m) dateText = `${m[1]}年${m[2]}月${m[3]}日`;

    const punishText = punishments
        .map(function (p, i) { return `${i + 1}. ${p}`; })
        .join('\n');                                             // 编号后的处理决定

    const subject = `【纪律告知】关于${name}同学违纪行为的处理通知`;
    const text = [
        `尊敬的${name}家长：`,
        `您好！现就贵校学生${name}近期违纪情况及处理决定向您告知。`,
        `该生于${dateText}，因${reason}，违反了《中小学生守则》相关条款。`,
        '经学校德育处 / 班主任调查核实、研究讨论，现作出如下处理：',
        punishText,
        '学生的成长需要家校协同配合，请您重视本次事件，和孩子耐心沟通，引导其认识错误、规范言行。',
        '如您有疑问，可与班主任联系。',
        '顺颂安祺！',
        `明星学校 ${grade}年级 ${className}班`
    ].join('\n');
    return { subject, text };
}

/**
 * 生成「整改通知」邮件（学生线上店铺违规限期整改）
 * 模板：
 *   主题：【整改通知】关于[姓名]同学线上店铺违规事项限期整改告知
 *   正文：家长称呼 → 学生/年级班级/店铺名称 → 违规问题列表 → 通知要求 1~4 → 陈述期 → 落款
 * @param {object} data { name, grade, className, shopName, issues, deadline }
 *   deadline 为 datetime-local 格式（如 2026-10-30T18:00），输出为「XXXX 年 XX 月 XX 日 XX 时」
 * @returns {{subject: string, text: string}} 主题与正文（纯文本）
 */
function buildRectifyMail(data) {
    const name = String(data.name || '').trim();                // 学生姓名
    const grade = String(data.grade || '').trim();              // 年级
    const className = String(data.className || '').trim();      // 班级
    const shopName = String(data.shopName || '').trim();        // 店铺名称
    const issues = (data.issues || [])
        .map(function (s) { return String(s || '').trim(); })
        .filter(function (s) { return !!s; });                   // 违规问题（去空行）

    /* 截止时间格式化：2026-10-30T18:00 → 2026 年 10 月 30 日 18 时 */
    const raw = String(data.deadline || '').trim();
    const dm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
    const deadlineText = dm
        ? `${dm[1]} 年 ${dm[2]} 月 ${dm[3]} 日 ${dm[4]} 时`
        : raw;

    const issueText = issues
        .map(function (s, i) { return `${i + 1}. ${s}`; })
        .join('\n');                                             // 编号后的违规问题

    const subject = `【整改通知】关于${name}同学线上店铺违规事项限期整改告知`;
    const text = [
        `${name}家长：`,
        '您好！',
        `学生：${name}，${grade}年级${className}班`,
        `店铺名称：${shopName}`,
        '学校支持学生合规开展线上店铺实践经营，但经核查，该店铺存在以下违规问题：',
        issueText,
        '上述行为违反学校《学生线上实践店铺管理办法》，存在纠纷、合规及舆情风险。',
        '现通知要求：',
        `1. 请于${deadlineText}前完成整改：下架违规商品、删除违规宣传内容、妥善处理已有投诉订单，完成自查；`,
        '2. 整改完成后提交整改说明，报送至校长核验；',
        '3. 整改期间，店铺可正常经营合规品类，仅限合规商品、合规宣传；',
        '4. 若逾期未整改、整改不合格，将暂停店铺经营资格，直至整改验收通过；由此引发的交易纠纷、平台处罚、经济损失，由学生及家长自行承担。',
        '您可在收到本通知 3 个工作日内沟通陈述。',
        '明星学校'
    ].join('\n');
    return { subject, text };
}

/**
 * 发送一封邮件（当前用于测试发送，后续群发也复用此函数）
 * @param {object} payload { to, subject, text, html }
 * @returns {Promise<{messageId: string}>} 发送结果
 * @throws {Error} 配置缺失或发送失败时抛出中文错误
 */
async function sendMail(payload) {
    const cfg = readConfig();
    if (!cfg.host || !cfg.user || !cfg.pass) {
        throw new Error('邮件服务尚未配置，请先填写并保存邮件配置');
    }
    const to = String((payload && payload.to) || '').trim();   // 收件人地址
    if (!to) throw new Error('请填写收件人邮箱');

    const transporter = createTransport(cfg);
    try {
        /* 部分服务器 verify 与 sendMail 行为不同，这里直接发送并用结果判断 */
        const info = await transporter.sendMail({
            from: cfg.fromName
                ? `"${cfg.fromName}" <${cfg.fromAddress || cfg.user}>`
                : (cfg.fromAddress || cfg.user),
            to,
            subject: (payload && payload.subject) || '明星学校 · 邮件配置测试',
            text: (payload && payload.text) || '这是一封来自明星学校的测试邮件，收到即表示邮件服务配置成功。',
            html: (payload && payload.html) || ''
        });
        return { messageId: info.messageId || '' };
    } finally {
        transporter.close();                                   // 释放连接，避免残留 socket
    }
}

module.exports = {
    readConfig,
    getPublicConfig,
    saveConfig,
    sendMail,
    buildDisciplineMail,
    buildRectifyMail,
    getBinding,
    setBinding,
    migrateBinding,
    listBindings
};
