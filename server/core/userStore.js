/**
 * 统一用户库（主项目核心模块）
 * ----------------------------------------------------------
 * 全平台唯一的用户数据层：登录认证、用户管理、个人偏好（主题）都读写
 * server/data/users/ 目录——每个用户一个 JSON 文件（<id>.json），
 * 与转盘数据（wheel/<id>.json）相同的存储风格。
 * 网盘（登录/头像）与转盘（角色/转盘归属）通过本模块共享同一份数据。
 *
 * 采用一人一文件的原因：旧方案是单个 users.json 大文件，任何一次写操作
 * 都要 JSON.parse→JSON.stringify 全量重写，JS 引擎会把纯数字键自动重排，
 * 文件顺序不受控且并发写有丢数据风险；一人一文件只动单个用户，无重排问题。
 *
 * 首次启动自动迁移：检测到旧的 users.json 时，把其中所有用户导入 users/
 * 目录，然后把旧文件改名为 users.json.bak 留作备份。
 *
 * 用户条目字段（仅保留三项；头像状态由网盘头像目录是否存在 <id>.png 决定）：
 *   name        姓名（登录用，唯一）
 *   psw         SHA-256 学号哈希（无盐）
 *   role        角色：'admin' | 'user'
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 用户目录：每个用户一个 <id>.json */
const USERS_DIR = path.join(__dirname, '..', 'data', 'users');
/** 旧版单文件路径（迁移源） */
const LEGACY_FILE = path.join(__dirname, '..', 'data', 'users.json');
/** 管理员固定 userId */
const ADMIN_ID = 'Admin';
/** 管理员固定姓名 */
const ADMIN_NAME = 'Admin';
/** 管理员默认学号哈希（明文 admin123，仅用于自动补齐缺失的管理员） */
const ADMIN_DEFAULT_HASH = hashPassword('admin123');

/**
 * 计算 SHA-256 学号哈希
 * @param {string} password 明文学号
 * @returns {string} 64 位小写十六进制哈希
 */
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

/** 确保用户目录存在 */
function ensureDir() {
    if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
}

/**
 * 把旧版 users.json 迁移为一 人一文件（只在旧文件存在时执行一次）
 * 迁移完成后旧文件改名为 users.json.bak 留作备份
 */
function migrateLegacyFile() {
    ensureDir();
    if (!fs.existsSync(LEGACY_FILE)) return;
    let raw = fs.readFileSync(LEGACY_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // 去 BOM
    try {
        const users = JSON.parse(raw);
        for (const [id, entry] of Object.entries(users)) {
            fs.writeFileSync(path.join(USERS_DIR, `${id}.json`), JSON.stringify(sanitizeEntry(entry), null, 2));
        }
        fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.bak');
        console.log(`[用户库] 已把旧版 users.json 迁移为一 人一文件（${Object.keys(users).length} 个用户），备份为 users.json.bak`);
    } catch (e) {
        console.error('[用户库] 迁移旧版 users.json 失败:', e.message);
    }
}

/**
 * 规范化积分：接受任意数（整数或小数，可正可负，不限位数）
 * 保留最多 4 位小数（避免浮点误差无限累积）
 * @param {*} value 原始积分（数字或字符串）
 * @returns {number|null} 规范化后的积分数字；非法值（非数字）返回 null
 */
function normalizePoints(value) {
    if (value === undefined || value === null) return 0;
    const s = String(value).trim();                    // 去掉首尾空白后的积分文本
    if (s === '') return 0;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;       // 接受整数或小数（可带负号）
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    // 保留 4 位小数截断浮点噪声
    return Math.round(n * 10000) / 10000;
}

/**
 * 清洗用户条目：只保留 name / psw / role / points 四个字段
 * （created_at/theme/color/avatar 已废弃，读写时一律丢弃；points 可为任意整数，缺省 0）
 * @param {object} entry 原始条目
 * @returns {object} 精简后的条目
 */
function sanitizeEntry(entry) {
    return {
        name: entry.name,                                  // 姓名
        psw: entry.psw,                                    // 学号哈希
        role: entry.role || 'user',                        // 角色（缺省普通用户）
        points: normalizePoints(entry.points) ?? 0         // 积分（任意位数整数，非法值回落 0）
    };
}

/**
 * 启动时清洗存量用户文件：剥离已废弃字段（仅在发现多余字段时重写）
 */
function sanitizeExistingFiles() {
    if (!fs.existsSync(USERS_DIR)) return;
    let cleaned = 0;                                   // 清洗过的文件计数
    for (const f of fs.readdirSync(USERS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const file = path.join(USERS_DIR, f);
        try {
            const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
            const pts = normalizePoints(entry.points);   // 规范化后的积分（用于判断是否需要重写）
            // 缺 points / 积分非法 / 积分需规范（如字符串数字）的旧文件也重写一次
            if ('avatar' in entry || 'color' in entry || 'theme' in entry || 'created_at' in entry
                || !('points' in entry) || pts === null || pts !== entry.points) {
                fs.writeFileSync(file, JSON.stringify(sanitizeEntry(entry), null, 2));
                cleaned++;
            }
        } catch (_) { /* 解析失败的文件交给 readUser 的容错处理 */ }
    }
    if (cleaned > 0) console.log(`[用户库] 已清洗 ${cleaned} 个用户文件的废弃字段并补齐 points 字段`);
}

/**
 * 读取单个用户文件
 * @param {string} id 用户 id
 * @returns {object | null} 不存在或解析失败返回 null
 */
function readUser(id) {
    // 文件名安全校验：id 只允许字母数字、连字符、下划线（防路径穿越）
    if (!/^[\w-]+$/.test(String(id))) return null;
    const file = path.join(USERS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.error(`[用户库] 解析用户文件 ${id}.json 失败:`, e.message);
        return null;
    }
}

/**
 * 写入单个用户文件
 * @param {string} id 用户 id
 * @param {object} entry 用户条目
 */
function writeUser(id, entry) {
    ensureDir();
    fs.writeFileSync(path.join(USERS_DIR, `${id}.json`), JSON.stringify(sanitizeEntry(entry), null, 2));
}

/**
 * 读取全部用户（返回排序后的 [id, entry] 数组，绕开 JS 对象纯数字键自动前置的问题）
 * 排序规则：固定账号（Admin、Lxh2014）按 FIXED_ORDER 置顶，其余按 id 自然升序
 * （数字段按数值比较，如 3-1 排在 4-2 前）
 * @returns {Array<[string, object]>}
 */
/** 置顶的固定账号 id 及其相对顺序 */
const FIXED_ORDER = ['Admin', 'Lxh2014'];
/** 用户 id 变更回调列表：setId 触发，子应用（如转盘）注册以迁移各自按 id 归属的数据 */
const idChangeListeners = [];
function loadEntries() {
    ensureDir();
    const entries = [];
    for (const f of fs.readdirSync(USERS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);                     // 去掉 .json 后缀得到 id
        const entry = readUser(id);
        if (entry) entries.push([id, entry]);
    }
    return entries.sort((a, b) => {
        // 固定账号按 FIXED_ORDER 的位次排；不在名单里的统一排在固定账号之后
        const rankA = FIXED_ORDER.indexOf(a[0]); const rankA2 = rankA >= 0 ? rankA : FIXED_ORDER.length;
        const rankB = FIXED_ORDER.indexOf(b[0]); const rankB2 = rankB >= 0 ? rankB : FIXED_ORDER.length;
        if (rankA2 !== rankB2) return rankA2 - rankB2;
        return String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN', { numeric: true });
    });
}

/**
 * 读取全部用户（字典形式，仅供兼容；注意 JS 对象会把纯数字键自动前置，需要顺序时用 loadEntries）
 * @returns {Record<string, object>} 用户字典（键为 userId）
 */
function loadUsers() {
    return Object.fromEntries(loadEntries());
}

/**
 * 启动时检查管理员账户：不存在或字段缺失则自动补齐
 */
function ensureAdmin() {
    migrateLegacyFile();
    sanitizeExistingFiles();
    const entry = readUser(ADMIN_ID);
    if (!entry) {
        console.warn(`[用户库] 未检测到管理员账户，正在自动创建（默认学号 admin123）`);
        writeUser(ADMIN_ID, {
            name: ADMIN_NAME,
            psw: ADMIN_DEFAULT_HASH,
            role: 'admin'
        });
        console.log('[用户库] 管理员账户检查完成');
        return;
    }
    let changed = false;
    if (entry.name !== ADMIN_NAME) { entry.name = ADMIN_NAME; changed = true; }
    if (!entry.psw) { entry.psw = ADMIN_DEFAULT_HASH; changed = true; }
    if (entry.role !== 'admin') { entry.role = 'admin'; changed = true; }
    if (changed) writeUser(ADMIN_ID, entry);
    console.log('[用户库] 管理员账户检查完成');
}

/**
 * 根据 userId 取用户条目
 * @param {string} id 用户 id
 * @returns {object | null} 不存在返回 null
 */
function getUserById(id) {
    return readUser(id);
}

/**
 * 根据姓名反查 userId（登录用）
 * @param {string} name 姓名
 * @returns {string | null} 找到返回 userId，否则 null
 */
function findIdByName(name) {
    for (const [id, entry] of Object.entries(loadUsers())) {
        if (entry.name === name) return id;
    }
    return null;
}

/**
 * 校验姓名 + 明文学号
 * @param {string} name 姓名
 * @param {string} plainPassword 明文学号
 * @returns {{ ok: boolean, isAdmin: boolean, message: string, id?: string }}
 */
function verifyLogin(name, plainPassword) {
    const id = findIdByName(name);
    if (!id) return { ok: false, isAdmin: false, message: '用户不存在' };
    const entry = getUserById(id);
    if (entry.psw !== hashPassword(plainPassword)) {
        return { ok: false, isAdmin: isAdminId(id), message: '学号错误' };
    }
    return { ok: true, isAdmin: isAdminId(id), message: '登录成功', id };
}

/**
 * 判断某用户是否管理员（固定 Admin 或 role 字段）
 * @param {string} id 用户 id
 * @returns {boolean}
 */
function isAdminId(id) {
    const entry = getUserById(id);
    return id === ADMIN_ID || (!!entry && entry.role === 'admin');
}

/**
 * 创建新用户（用户管理页用）
 * @param {string} name 姓名（必须全局唯一）
 * @param {string} plainPassword 明文学号（长度不限）
 * @param {string} [customId] 自定义 id（可选；留空则自动生成数字 id）
 * @returns {{ ok: boolean, message: string, id?: string }}
 */
function createUser(name, plainPassword, customId) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, message: '请输入姓名' };
    if (!plainPassword) return { ok: false, message: '请输入学号' };
    if (findIdByName(trimmed)) return { ok: false, message: '姓名已存在' };

    // 自定义 id：校验合法性（字母/数字/连字符/下划线）与唯一性；不填则自动生成
    ensureDir();
    let id;
    if (customId !== undefined && customId !== null && String(customId).trim() !== '') {
        id = String(customId).trim();
        if (!/^[\w-]+$/.test(id)) return { ok: false, message: 'ID 只能包含字母、数字、连字符、下划线' };
        if (fs.existsSync(path.join(USERS_DIR, `${id}.json`))) return { ok: false, message: 'ID 已被占用' };
    } else {
        // 生成新 id：扫描现有数字文件名，取最大值 +1（避免与既有 id 冲突）
        let maxNum = -1;
        for (const f of fs.readdirSync(USERS_DIR)) {
            if (!f.endsWith('.json')) continue;
            const key = f.slice(0, -5);
            const n = Number(key);
            if (Number.isInteger(n) && String(n) === key && n > maxNum) maxNum = n;
        }
        id = String(maxNum + 1);
    }

    writeUser(id, {
        name: trimmed,
        psw: hashPassword(plainPassword),
        role: 'user'
    });
    return { ok: true, message: '用户创建成功', id };
}

/**
 * 删除用户（不能删除 Admin）
 * @param {string} id 用户 id
 * @returns {{ ok: boolean, message: string }}
 */
function deleteUser(id) {
    if (id === ADMIN_ID) return { ok: false, message: '不能删除管理员账户' };
    const file = path.join(USERS_DIR, `${id}.json`);
    if (!/^[\w-]+$/.test(String(id)) || !fs.existsSync(file)) return { ok: false, message: '用户不存在' };
    fs.unlinkSync(file);
    return { ok: true, message: '用户已删除' };
}

/**
 * 修改指定用户学号（Admin 重置用，无需旧学号）
 * @param {string} id 用户 id
 * @param {string} plainNew 新学号明文（长度不限）
 * @returns {{ ok: boolean, message: string }}
 */
function resetPassword(id, plainNew) {
    if (!plainNew) return { ok: false, message: '请输入学号' };
    const entry = getUserById(id);
    if (!entry) return { ok: false, message: '用户不存在' };
    entry.psw = hashPassword(plainNew);
    writeUser(id, entry);
    return { ok: true, message: '学号重置成功' };
}

/**
 * 修改指定用户学号（需要旧学号验证，用户自助改密）
 * @param {string} id 用户 id
 * @param {string} plainOld 旧学号明文
 * @param {string} plainNew 新学号明文
 * @returns {{ ok: boolean, message: string }}
 */
function changePassword(id, plainOld, plainNew) {
    const entry = getUserById(id);
    if (!entry) return { ok: false, message: '用户不存在' };
    if (entry.psw !== hashPassword(plainOld)) return { ok: false, message: '旧学号不正确' };
    if (!plainNew) return { ok: false, message: '请输入新学号' };
    entry.psw = hashPassword(plainNew);
    writeUser(id, entry);
    return { ok: true, message: '学号修改成功' };
}

/**
 * 更新姓名（重名检查）
 * @param {string} id 用户 id
 * @param {string} name 新姓名
 * @returns {{ ok: boolean, message: string }}
 */
function setName(id, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, message: '姓名不能为空' };
    const entry = getUserById(id);
    if (!entry) return { ok: false, message: '用户不存在' };
    const owner = findIdByName(trimmed);
    if (owner && owner !== id) return { ok: false, message: '姓名已存在' };
    entry.name = trimmed;
    writeUser(id, entry);
    return { ok: true, message: '姓名已更新' };
}

/**
 * 注册用户 id 变更回调（setId 时触发，用于子应用迁移按 id 关联的数据）
 * @param {(oldId: string, newId: string) => void} fn 回调函数
 */
function onIdChange(fn) {
    if (typeof fn === 'function') idChangeListeners.push(fn);
}

/**
 * 修改用户 id（用户管理页"改ID"）
 * 联动处理：用户文件改名 → 会话表迁移（无需重新登录）→ 网盘头像文件改名 → 通知子应用迁移归属数据
 * @param {string} id 旧用户 id
 * @param {string} newId 新用户 id（字母/数字/连字符/下划线，全局唯一）
 * @returns {{ ok: boolean, message: string }}
 */
function setId(id, newId) {
    const trimmed = (newId || '').trim();
    if (!trimmed) return { ok: false, message: 'ID 不能为空' };
    if (!/^[\w-]+$/.test(trimmed)) return { ok: false, message: 'ID 只能包含字母、数字、连字符、下划线' };
    if (id === ADMIN_ID) return { ok: false, message: '不能修改 Admin 的 ID' };
    if (trimmed === id) return { ok: true, message: 'ID 未变化' };
    const oldFile = path.join(USERS_DIR, `${id}.json`);
    const newFile = path.join(USERS_DIR, `${trimmed}.json`);
    if (!/^[\w-]+$/.test(String(id)) || !fs.existsSync(oldFile)) return { ok: false, message: '用户不存在' };
    if (fs.existsSync(newFile)) return { ok: false, message: '新 ID 已被占用' };

    // 1. 改名用户文件
    fs.renameSync(oldFile, newFile);
    // 2. 迁移会话（被改 ID 的用户保持登录态）
    try {
        const sessions = require('./sessions');
        sessions.reassignUser(id, trimmed);
    } catch (_) { /* 会话模块不可用时忽略 */ }
    // 3. 网盘头像文件改名（如存在）
    try {
        const avatarDir = path.join(__dirname, '..', '..', 'apps', 'drive', 'server', 'assets', 'user');
        const oldAvatar = path.join(avatarDir, `${id}.png`);
        if (fs.existsSync(oldAvatar)) {
            fs.renameSync(oldAvatar, path.join(avatarDir, `${trimmed}.png`));
        }
    } catch (e) { console.error('[用户库] 迁移头像文件失败:', e.message); }
    // 4. 通知子应用迁移各自按 id 关联的数据（如转盘归属）
    for (const fn of idChangeListeners) {
        try { fn(id, trimmed); } catch (e) { console.error('[用户库] id 变更回调执行失败:', e.message); }
    }
    return { ok: true, message: 'ID 已修改' };
}

/**
 * 设置用户角色（admin / user）
 * @param {string} id 用户 id
 * @param {string} role 角色名
 * @returns {{ ok: boolean, message: string }}
 */
function setRole(id, role) {
    if (role !== 'admin' && role !== 'user') return { ok: false, message: '无效的角色' };
    const entry = getUserById(id);
    if (!entry) return { ok: false, message: '用户不存在' };
    if (id === ADMIN_ID && role !== 'admin') return { ok: false, message: '不能修改管理员的角色' };
    entry.role = role;
    writeUser(id, entry);
    return { ok: true, message: '角色已更新' };
}

/**
 * 设置用户积分（用户管理页"积分"按钮；管理员改分）
 * @param {string} id 用户 id
 * @param {number|string} points 新积分（任意数，整数或小数均可）
 * @returns {{ ok: boolean, message: string }}
 */
function setPoints(id, points) {
    const n = normalizePoints(points);
    if (n === null) return { ok: false, message: '积分必须是数字（可带小数）' };
    const entry = getUserById(id);
    if (!entry) return { ok: false, message: '用户不存在' };
    entry.points = n;
    writeUser(id, entry);
    return { ok: true, message: '积分已更新' };
}

/**
 * 全量用户列表（含 Admin，字段脱敏后供管理页展示；管理员置顶，组内按 id 升序）
 * 头像状态由网盘头像目录的 <id>.png 是否存在推导（'picture' | null）
 * @returns {Array<{id, name, role, avatar}>}
 */
function listUsers() {
    return loadEntries().map(([id, u]) => ({
        id,
        name: u.name,
        role: u.role || (id === ADMIN_ID ? 'admin' : 'user'),
        points: normalizePoints(u.points) ?? 0,                   // 积分（任意位数整数，缺省 0）
        avatar: hasAvatarFile(id) ? 'picture' : null
    }));
}

/**
 * 判断某用户是否有图片头像（网盘头像目录存在 <id>.png）
 * @param {string} id 用户 id
 * @returns {boolean}
 */
function hasAvatarFile(id) {
    if (!/^[\w-]+$/.test(String(id))) return false;
    const file = path.join(__dirname, '..', '..', 'apps', 'drive', 'server', 'assets', 'user', `${id}.png`);
    return fs.existsSync(file);
}

// 模块加载时：先迁移旧文件，再确保管理员存在
ensureAdmin();

module.exports = {
    hashPassword,
    loadUsers,
    loadEntries,
    saveUsers: (users) => {                     // 兼容旧接口：整字典写回 = 逐个写用户文件
        for (const [id, entry] of Object.entries(users || {})) writeUser(id, entry);
    },
    getUserById,
    findIdByName,
    findUserByName: (name) => {
        const id = findIdByName(name);
        return id ? getUserById(id) : null;
    },
    verifyLogin,
    isAdminId,
    createUser,
    deleteUser,
    resetPassword,
    changePassword,
    setName,
    setId,
    setRole,
    setPoints,
    listUsers,
    hasAvatarFile,
    ADMIN_ID,
    ADMIN_NAME,
    onIdChange
};
