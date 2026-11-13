/**
 * store.js —— 邻语（IM）JSON 存储层
 * ----------------------------------------------------------
 * 数据按会话分目录存放（apps/im/data/）：
 *
 *   data/
 *   ├── group/{会话ID}/
 *   │     ├── config.json     会话配置（成员、群名、群设置、个人偏好、已读等）
 *   │     ├── records.json    聊天记录
 *   │     ├── homework.json   群作业
 *   │     ├── files/          聊天文件
 *   │     ├── images/         聊天图片
 *   │     └── avatar.png      群头像
 *   ├── individual/{会话ID}/
 *   │     ├── config.json     单聊配置
 *   │     ├── records.json    聊天记录
 *   │     ├── files/          聊天文件
 *   │     ├── images/         聊天图片
 *   │     └── avatar.png      头像（若设置）
 *   └── friend-requests.json  好友申请（全局）
 *
 * 设计要点：
 *   - 写入采用「临时文件 + rename」原子替换，避免写一半断电导致 JSON 损坏
 *   - 读取带进程内缓存 + mtime 校验，外部改动文件后下一次读取能自动生效
 *   - 单会话消息最多保留 MAX_PER_CONV 条，防止单文件无限膨胀
 *   - 首次启动若发现旧的扁平数据（conversations.json 等），自动迁移并备份到 data/_legacy
 */
const fs = require('fs');
const path = require('path');

/** 数据根目录：apps/im/data */
const DATA_DIR = path.join(__dirname, '..', 'data');

/** 群聊目录：data/group */
const GROUP_DIR = path.join(DATA_DIR, 'group');

/** 单聊目录：data/individual */
const INDIVIDUAL_DIR = path.join(DATA_DIR, 'individual');

/** 好友申请文件（全局，不属于某个会话） */
const FRIEND_FILE = path.join(DATA_DIR, 'friend-requests.json');

/** 联系人目录：data/contacts，每个用户一个 {userId}.json */
const CONTACTS_DIR = path.join(DATA_DIR, 'contacts');

/** 默认联系人分组（首次使用或文件缺失时自动补齐） */
const DEFAULT_CONTACT_GROUPS = [
  { id: 'default', name: '我的好友' },
  { id: 'family', name: '家人' },
  { id: 'classmate', name: '同学' },
  { id: 'colleague', name: '同事' },
  { id: 'stranger', name: '陌生人' },
  { id: 'block', name: '黑名单' }
];

/** 读取缓存：file → { mtime, data }，避免每次请求都重复解析 JSON */
const cache = new Map();

/** 单个会话最多保留的消息条数（超出后丢弃最旧的消息） */
const MAX_PER_CONV = 500;

/** 群设置默认值：不禁言、不限频、加群需要验证 */
const DEFAULT_SETTINGS = { muteAll: false, rateLimit: 0, joinMode: 'verify' };

/** 允许的加群方式（verify=需要验证，free=无需验证，none=不允许加群） */
const JOIN_MODES = ['verify', 'free', 'none'];

/** 允许的发言限频秒数（0 表示不限制） */
const RATE_LIMITS = [0, 10, 30, 60];

/** 允许的群内身份 */
const IDENT_ROLES = ['班主任', '老师', '家长', '学生', '家委'];

/** 允许的教授科目（仅「老师」身份需要） */
const IDENT_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道法', '体育', '音乐', '美术', '信息技术', '自习', '其他'];

/** 家长与孩子的关系（仅「家长」身份需要） */
const IDENT_RELATIONS = ['妈妈', '爸爸', '姥姥', '姥爷', '奶奶', '爷爷', '姐姐', '哥哥', '弟弟', '妹妹', '家长'];

/**
 * 生成群号：由会话 ID 派生出稳定的 9 位数字
 * 不落盘、不随会话数据变动，避免为「展示用编号」额外维护持久字段
 * @param {string} convId 会话 ID
 * @returns {string} 9 位数字字符串
 */
function convCode(convId) {
  let hash = 0;                                              // 滚动哈希值
  const s = String(convId || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) % 1000000000;
  return String(100000000 + (hash % 900000000));             // 保证固定 9 位
}

/**
 * 规整会话设置：缺省字段补默认值，非法值回落默认
 * @param {object} conv 会话对象
 * @returns {{muteAll:boolean, rateLimit:number, joinMode:string}}
 */
function normalizeSettings(conv) {
  const s = (conv && conv.settings) || {};
  const rate = Number(s.rateLimit);                          // 发言间隔秒数
  return {
    muteAll: s.muteAll === true,
    rateLimit: RATE_LIMITS.includes(rate) ? rate : 0,
    joinMode: JOIN_MODES.includes(s.joinMode) ? s.joinMode : DEFAULT_SETTINGS.joinMode
  };
}

/**
 * 规整「我的本群身份」：身份、科目、称呼、孩子姓名、与孩子关系（用于群昵称展示）
 * @param {object} raw 原始身份对象
 * @returns {{role:string, subject:string, nickname:string, childName:string, relation:string}}
 */
function normalizeIdentity(raw) {
  const p = raw || {};
  return {
    role: IDENT_ROLES.includes(p.role) ? p.role : '',                       // 群内身份
    subject: IDENT_SUBJECTS.includes(p.subject) ? p.subject : '',           // 教授科目（老师）
    nickname: String(p.nickname || '').slice(0, 20),                        // 称呼（老师/学生/其他）
    childName: String(p.childName || '').slice(0, 20),                      // 孩子姓名（家长）
    relation: IDENT_RELATIONS.includes(p.relation) ? p.relation : ''        // 与孩子的关系（家长）
  };
}

/**
 * 规整某成员的个人会话偏好
 * @param {object} raw 原始偏好对象
 * @returns {{pinned:boolean, muted:boolean, blocked:boolean, remark:string, clearedAt:string, identity:object}}
 */
function normalizePrefs(raw) {
  const p = raw || {};
  return {
    pinned: p.pinned === true,                               // 置顶
    muted: p.muted === true,                                 // 免打扰（不产生未读）
    blocked: p.blocked === true,                             // 屏蔽此人（仅单聊）
    remark: String(p.remark || ''),                          // 备注名
    clearedAt: String(p.clearedAt || ''),                    // 清空聊天记录的时间点
    identity: normalizeIdentity(p.identity)                  // 我的本群身份（群昵称来源）
  };
}

/**
 * 取某成员对该会话的偏好（缺省返回默认值）
 * @param {object} conv 会话对象
 * @param {string} userId 用户 ID
 * @returns {object} 偏好对象
 */
function getPrefs(conv, userId) {
  return normalizePrefs(conv && conv.prefs && conv.prefs[userId]);
}

/** 确保目录存在 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 生成短 ID：前缀 + 时间戳36进制 + 4位随机，够用且可读
 * @param {string} prefix ID 前缀（c=会话 m=消息）
 * @returns {string}
 */
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 读取一个 JSON 文件（带缓存与 mtime 热更新）
 * @param {string} file 文件绝对路径
 * @param {*} fallback 文件不存在时的默认值
 * @returns {*}
 */
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const mtime = fs.statSync(file).mtimeMs;                   // 文件修改时间（缓存键）
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;           // 命中缓存直接返回
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtime, data });
    return data;
  } catch (e) {
    // JSON 损坏：备份坏文件后返回默认值，保证服务不崩
    try { fs.copyFileSync(file, file + '.corrupt'); } catch (_) { /* 忽略备份失败 */ }
    return fallback;
  }
}

/**
 * 写入一个 JSON 文件（原子替换 + 刷新缓存）
 * @param {string} file 文件绝对路径
 * @param {*} data 要写入的数据
 */
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';                                 // 临时文件（写完再改名）
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  cache.set(file, { mtime: fs.statSync(file).mtimeMs, data });
}

/**
 * 会话类型对应的根目录
 * @param {string} type 会话类型 group / c2c
 * @returns {string} 目录绝对路径
 */
function kindDir(type) {
  return type === 'group' ? GROUP_DIR : INDIVIDUAL_DIR;
}

/**
 * 取会话所在目录：group/{id} 或 individual/{id}
 * @param {object} conv 会话对象
 * @returns {string} 目录绝对路径
 */
function convDir(conv) {
  return path.join(kindDir(conv.type), String(conv.id));
}

/**
 * 按会话 ID 查找已存在的目录（不知道类型时遍历 group / individual）
 * @param {string} convId 会话 ID
 * @returns {string|null} 目录绝对路径，找不到返回 null
 */
function findConvDir(convId) {
  const id = String(convId);
  const dirs = [path.join(GROUP_DIR, id), path.join(INDIVIDUAL_DIR, id)];
  return dirs.find(d => fs.existsSync(d)) || null;
}

/**
 * 列出全部会话目录
 * @returns {Array<string>} 目录绝对路径数组
 */
function listConvDirs() {
  const result = [];                                          // 会话目录集合
  [GROUP_DIR, INDIVIDUAL_DIR].forEach(root => {
    if (!fs.existsSync(root)) return;
    fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .forEach(d => result.push(path.join(root, d.name)));
  });
  return result;
}

/**
 * 读取会话目录下的 config.json
 * @param {string} dir 会话目录
 * @returns {object|null}
 */
function readConfig(dir) {
  const cfg = readJson(path.join(dir, 'config.json'), null);
  return cfg && typeof cfg === 'object' ? cfg : null;
}

/** 读取全部会话（按目录扫描 config.json） */
function loadConversations() {
  const list = [];                                            // 会话集合
  listConvDirs().forEach(dir => {
    const cfg = readConfig(dir);
    if (cfg && cfg.id) list.push(cfg);
  });
  return list;
}

/**
 * 保存会话列表：逐个写入各自目录的 config.json，并清理已不存在的会话目录
 * @param {Array<object>} list 全量会话
 */
function saveConversations(list) {
  const keep = new Set((list || []).map(c => String(c.id)));   // 仍需保留的会话 ID
  (list || []).forEach(conv => {
    writeJson(path.join(convDir(conv), 'config.json'), conv);
  });
  // 目录已存在但会话被删除（如解散群）→ 整目录移除
  listConvDirs().forEach(dir => {
    const cfg = readConfig(dir);
    if (!cfg || !keep.has(String(cfg.id))) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略删除失败 */ }
    }
  });
}

/** 读取全部消息（汇总各会话的 records.json） */
function loadMessages() {
  const all = [];                                             // 全部消息
  listConvDirs().forEach(dir => {
    const cfg = readConfig(dir);
    const records = readJson(path.join(dir, 'records.json'), []);
    if (!Array.isArray(records)) return;
    records.forEach(m => {
      if (m && m.convId === undefined && cfg) m.convId = cfg.id;   // 兼容缺省 convId
      if (m) all.push(m);
    });
  });
  return all;
}

/**
 * 保存全部消息：按 convId 分组写回各自会话的 records.json
 * @param {Array<object>} list 全量消息
 */
function saveMessages(list) {
  const grouped = new Map();                                  // 目录 → 该会话的消息数组
  (list || []).forEach(m => {
    if (!m || !m.convId) return;
    const dir = findConvDir(m.convId);
    if (!dir) return;
    if (!grouped.has(dir)) grouped.set(dir, []);
    grouped.get(dir).push(m);
  });
  // 所有会话都要写一遍，确保被删除的消息从文件中消失
  listConvDirs().forEach(dir => {
    writeJson(path.join(dir, 'records.json'), grouped.get(dir) || []);
  });
}

/** 读取全部群作业（汇总各会话的 homework.json） */
function loadHomework() {
  const all = [];                                             // 全部作业
  listConvDirs().forEach(dir => {
    const cfg = readConfig(dir);
    const records = readJson(path.join(dir, 'homework.json'), []);
    if (!Array.isArray(records)) return;
    records.forEach(h => {
      if (h && h.convId === undefined && cfg) h.convId = cfg.id;   // 兼容缺省 convId
      if (h) all.push(h);
    });
  });
  return all;
}

/**
 * 保存全部群作业：按 convId 分组写回各自会话的 homework.json
 * @param {Array<object>} list 全量作业
 */
function saveHomework(list) {
  const grouped = new Map();                                  // 目录 → 该会话的作业数组
  (list || []).forEach(h => {
    if (!h || !h.convId) return;
    const dir = findConvDir(h.convId);
    if (!dir) return;
    if (!grouped.has(dir)) grouped.set(dir, []);
    grouped.get(dir).push(h);
  });
  listConvDirs().forEach(dir => {
    const items = grouped.get(dir);                           // 该会话的作业
    const hasFile = fs.existsSync(path.join(dir, 'homework.json'));
    if (!items && !hasFile) return;                           // 单聊且从未布置作业：不生成空文件
    writeJson(path.join(dir, 'homework.json'), items || []);
  });
}

/**
 * 群相册数据文件路径：data/group/{会话ID}/albums.json
 * @param {string} convId 群会话 ID
 * @returns {string} 文件绝对路径
 */
function albumsFile(convId) {
  return path.join(GROUP_DIR, String(convId), 'albums.json');
}

/**
 * 读取某个群的相册数据（文件缺失时返回空相册列表）
 * @param {string} convId 群会话 ID
 * @returns {{albums: Array<object>}} 相册数组，照片数组内 newest 在前
 */
function loadAlbums(convId) {
  const raw = readJson(albumsFile(convId), null);              // 原始文件内容
  const albums = raw && Array.isArray(raw.albums) ? raw.albums : [];
  return { albums: albums.filter(a => a && a.id) };
}

/**
 * 保存某个群的全部相册
 * @param {string} convId 群会话 ID
 * @param {Array<object>} albums 全量相册数组
 */
function saveAlbums(convId, albums) {
  writeJson(albumsFile(convId), { albums: Array.isArray(albums) ? albums : [] });
}

/**
 * 读取全部好友申请
 * @returns {Array<object>}
 */
function loadFriendRequests() {
  const list = readJson(FRIEND_FILE, []);
  return Array.isArray(list) ? list : [];
}

/**
 * 保存全部好友申请
 * @param {Array<object>} list
 */
function saveFriendRequests(list) {
  writeJson(FRIEND_FILE, list);
}

/**
 * 联系人文件路径：data/contacts/{userId}.json
 * @param {string} userId 用户 ID
 * @returns {string} 文件绝对路径
 */
function contactsFile(userId) {
  return path.join(CONTACTS_DIR, String(userId) + '.json');
}

/**
 * 规整联系人数据：补全默认分组、修正非法字段
 * 友链字段：groupId（所属分组）、remark（备注名）、blocked（是否拉黑）
 * @param {object} raw 原始联系人数据
 * @returns {{groups:Array<{id:string,name:string}>, friends:Object}}
 */
function normalizeContacts(raw) {
  const src = raw || {};
  const rawGroups = (Array.isArray(src.groups) ? src.groups : [])
    .map(g => ({
      id: String((g && g.id) || '').trim(),
      name: String((g && g.name) || '').trim().slice(0, 16)
    }))
    .filter(g => g.id && g.name);
  const rawMap = new Map(rawGroups.map(g => [g.id, g]));      // 原始分组 ID → 分组
  const defaultIds = new Set(DEFAULT_CONTACT_GROUPS.map(g => g.id));
  const groups = DEFAULT_CONTACT_GROUPS.map(g => ({           // 默认分组固定排在最前（允许改名）
    id: g.id,
    name: (rawMap.get(g.id) && rawMap.get(g.id).name) || g.name
  }));
  rawGroups.forEach(g => {                                    // 追加用户自建分组
    if (defaultIds.has(g.id) || groups.some(x => x.id === g.id)) return;
    groups.push(g);
  });
  const seen = new Set(groups.map(g => g.id));                // 全部有效分组 ID

  const friends = {};                                         // 规整后的好友元数据
  const rawFriends = (src && typeof src.friends === 'object' && src.friends) || {};
  Object.keys(rawFriends).forEach(fid => {
    const item = rawFriends[fid] || {};
    friends[fid] = {
      groupId: seen.has(item.groupId) ? item.groupId : 'default',  // 分组失效时回到我的好友
      remark: String(item.remark || '').slice(0, 30),              // 备注名（优先展示）
      blocked: item.blocked === true                               // 是否拉黑
    };
  });

  return { groups: groups, friends: friends };
}

/**
 * 读取某用户的联系人数据（文件不存在时返回默认结构）
 * @param {string} userId 用户 ID
 * @returns {{groups:Array<{id:string,name:string}>, friends:Object}}
 */
function loadContacts(userId) {
  return normalizeContacts(readJson(contactsFile(userId), null));
}

/**
 * 保存某用户的联系人数据
 * @param {string} userId 用户 ID
 * @param {object} data 联系人数据 { groups, friends }
 * @returns {object} 规整后落盘的数据
 */
function saveContacts(userId, data) {
  const next = normalizeContacts(data);
  writeJson(contactsFile(userId), next);
  return next;
}

/**
 * 把旧版扁平数据迁移到按会话分目录的结构
 * 旧文件（conversations.json / messages.json / homework.json / avatars / images / files）
 * 迁移完成后统一移动到 data/_legacy 备份，避免重复迁移
 */
function migrateLegacy() {
  const legacyConv = path.join(DATA_DIR, 'conversations.json');
  if (!fs.existsSync(legacyConv)) return;

  try {
    const convs = JSON.parse(fs.readFileSync(legacyConv, 'utf8')) || [];
    const messages = readJson(path.join(DATA_DIR, 'messages.json'), []) || [];
    const homework = readJson(path.join(DATA_DIR, 'homework.json'), []) || [];

    convs.forEach(conv => {
      const dir = convDir(conv);
      ensureDir(dir);
      writeJson(path.join(dir, 'config.json'), conv);
      writeJson(path.join(dir, 'records.json'), messages.filter(m => m.convId === conv.id));
      // 作业只属于群聊：单聊不生成 homework.json
      const hw = homework.filter(h => h.convId === conv.id);
      if (conv.type === 'group' || hw.length) writeJson(path.join(dir, 'homework.json'), hw);

      // 群头像：data/avatars/{id}.png → {会话目录}/avatar.png
      const avatar = path.join(DATA_DIR, 'avatars', conv.id + '.png');
      if (fs.existsSync(avatar)) {
        ensureDir(dir);
        fs.renameSync(avatar, path.join(dir, 'avatar.png'));
      }

      // 会话内的图片 / 文件：按消息里引用的文件名搬进对应子目录
      const records = messages.filter(m => m.convId === conv.id);
      const imageNames = new Set();                           // 本会话引用的图片文件名
      const fileNames = new Set();                            // 本会话引用的文件名
      records.forEach(m => {
        if (m.image) imageNames.add(path.basename(m.image));
        (m.parts || []).forEach(p => {
          if (p.type === 'image' && p.src) imageNames.add(path.basename(p.src));
          if (p.type === 'file' && p.url) fileNames.add(path.basename(p.url));
        });
      });
      moveAssets('images', imageNames, path.join(dir, 'images'));
      moveAssets('files', fileNames, path.join(dir, 'files'));
    });

    // 旧数据备份
    const backup = path.join(DATA_DIR, '_legacy');
    ensureDir(backup);
    ['conversations.json', 'messages.json', 'homework.json'].forEach(name => {
      const src = path.join(DATA_DIR, name);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(backup, name));
    });
    ['avatars', 'images', 'files'].forEach(name => {
      const src = path.join(DATA_DIR, name);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(backup, name));
    });
    console.log('[im] 旧数据已迁移到 group/individual 目录结构');
  } catch (e) {
    console.error('[im] 旧数据迁移失败：', e.message);
  }
}

/**
 * 迁移附件：把旧目录中的指定文件搬进会话子目录
 * @param {string} from 旧目录名（images / files）
 * @param {Set<string>} names 需要搬运的文件名
 * @param {string} target 目标目录
 */
function moveAssets(from, names, target) {
  if (!names.size) return;
  ensureDir(target);
  names.forEach(name => {
    const src = path.join(DATA_DIR, from, name);
    if (!fs.existsSync(src)) return;
    try { fs.renameSync(src, path.join(target, name)); } catch (_) { /* 忽略单个文件失败 */ }
  });
}

/**
 * 初始化：建目录、准备好友申请文件，并在需要时迁移旧数据
 */
function init() {
  ensureDir(DATA_DIR);
  ensureDir(GROUP_DIR);
  ensureDir(INDIVIDUAL_DIR);
  ensureDir(CONTACTS_DIR);
  if (!fs.existsSync(FRIEND_FILE)) writeJson(FRIEND_FILE, []);
  migrateLegacy();
}

/**
 * 按 ID 查找会话
 * @param {string} convId 会话 ID
 * @returns {object|null} 找不到返回 null
 */
function findConversation(convId) {
  return loadConversations().find(c => c.id === convId) || null;
}

/**
 * 列出某用户参与的全部会话（置顶优先，其次按最后消息时间倒序）
 * @param {string} userId 当前用户 ID
 * @returns {Array<object>} 会话对象数组（含 lastMessage / prefs / settings / code）
 */
function listConversationsFor(userId) {
  const conversations = loadConversations();                 // 全部会话
  const messages = loadMessages();                           // 全部消息
  return conversations
    .filter(c => Array.isArray(c.members) && c.members.includes(userId))
    .map(c => {
      const prefs = getPrefs(c, userId);                      // 我的会话偏好
      const cleared = Date.parse(prefs.clearedAt) || 0;       // 清空聊天记录的时间点
      // 该会话下对当前用户可见的消息（排除我本地删除的、清空时间点之前的）
      const visible = messages.filter(m =>
        m.convId === c.id &&
        !(m.hiddenFor || []).includes(userId) &&
        (!cleared || Date.parse(m.time) > cleared)
      );
      const last = visible.length ? visible[visible.length - 1] : null;   // 最后一条消息
      return Object.assign({}, c, {
        lastMessage: last,
        myPrefs: prefs,                                       // 我的会话偏好（不覆盖原始 prefs 映射，避免丢其他成员数据）
        settings: normalizeSettings(c),
        code: convCode(c.id)
      });
    })
    .sort((a, b) => {
      const pa = a.myPrefs || {};                              // 我的偏好（置顶排序用）
      const pb = b.myPrefs || {};
      if (pa.pinned !== pb.pinned) return pa.pinned ? -1 : 1;  // 置顶优先
      const ta = a.lastMessage ? Date.parse(a.lastMessage.time) : Date.parse(a.createdAt);
      const tb = b.lastMessage ? Date.parse(b.lastMessage.time) : Date.parse(b.createdAt);
      return tb - ta;
    });
}

/**
 * 创建会话（已存在同目标单聊时直接复用）
 * @param {object} conv 会话对象（id/type/title/members/ownerId 等）
 * @returns {object} 实际使用的会话对象
 */
function createConversation(conv) {
  const list = loadConversations();
  const item = Object.assign({ createdAt: new Date().toISOString(), reads: {} }, conv);
  list.push(item);
  saveConversations(list);
  return item;
}

/**
 * 追加一条消息
 * @param {object} msg 消息对象（id/convId/senderId/senderName/text/time/quote 等）
 * @returns {object} 写入的消息对象
 */
function addMessage(msg) {
  const list = loadMessages();
  list.push(msg);

  // 超出上限时裁剪该会话最旧的消息，保证文件体积可控
  let sameConv = list.filter(m => m.convId === msg.convId);   // 本会话的全部消息
  if (sameConv.length > MAX_PER_CONV) {
    const drop = sameConv.length - MAX_PER_CONV;              // 需要丢弃的条数
    const dropIds = new Set(sameConv.slice(0, drop).map(m => m.id));
    const kept = list.filter(m => !dropIds.has(m.id));
    saveMessages(kept);
    return msg;
  }

  saveMessages(list);
  return msg;
}

/**
 * 列出某会话中当前用户可见的消息
 * @param {string} convId 会话 ID
 * @param {string} userId 当前用户 ID
 * @param {string|null} afterId 只返回该消息之后的新消息（轮询增量用）
 * @returns {Array<object>}
 */
function listMessages(convId, userId, afterId) {
  const conv = findConversation(convId);                     // 会话本体（用于取清空时间点）
  const prefs = getPrefs(conv, userId);                      // 我的会话偏好
  const cleared = Date.parse(prefs.clearedAt) || 0;          // 清空聊天记录的时间点
  const all = loadMessages().filter(m =>
    m.convId === convId &&
    !(m.hiddenFor || []).includes(userId) &&
    (!cleared || Date.parse(m.time) > cleared)
  );
  if (!afterId) return all;
  const idx = all.findIndex(m => m.id === afterId);          // 增量位置
  return idx >= 0 ? all.slice(idx + 1) : all;
}

/**
 * 按 ID 查找消息
 * @param {string} msgId 消息 ID
 * @returns {object|null}
 */
function findMessage(msgId) {
  return loadMessages().find(m => m.id === msgId) || null;
}

/**
 * 撤回消息（本人可撤回自己的；班主任 / 老师 / 家委 / 群主 / 管理员可撤回他人消息）
 * @param {string} msgId 消息 ID
 * @param {string} userId 操作者用户 ID
 * @param {boolean} [canRecallOthers] 是否具备撤回他人消息的权限
 * @returns {{ok:boolean, message:string, memberRecall?:boolean}}
 */
function recallMessage(msgId, userId, canRecallOthers) {
  const list = loadMessages();
  const msg = list.find(m => m.id === msgId);
  if (!msg) return { ok: false, message: '消息不存在' };
  const isSelf = msg.senderId === userId;                     // 是否撤回自己发送的消息
  if (!isSelf && !canRecallOthers) return { ok: false, message: '只能撤回自己发送的消息' };
  if (msg.recalled) return { ok: false, message: '该消息已撤回' };
  msg.recalled = true;                                        // 标记撤回（保留占位，所有人可见提示）
  msg.recalledBy = userId;                                    // 记录实际操作者，用于区分「本人撤回」与「撤回成员消息」
  msg.text = '';                                              // 清空正文，避免内容残留
  msg.quote = null;
  saveMessages(list);
  return { ok: true, message: '已撤回', memberRecall: !isSelf };
}

/**
 * 本地删除消息（只对当前用户隐藏，不影响其他人）
 * @param {string} msgId 消息 ID
 * @param {string} userId 当前用户 ID
 * @returns {boolean} 是否成功
 */
function hideMessage(msgId, userId) {
  const list = loadMessages();
  const msg = list.find(m => m.id === msgId);
  if (!msg) return false;
  const hidden = Array.isArray(msg.hiddenFor) ? msg.hiddenFor : [];
  if (!hidden.includes(userId)) hidden.push(userId);
  msg.hiddenFor = hidden;
  saveMessages(list);
  return true;
}

/**
 * 标记会话已读（记录当前用户最后已读时间）
 * @param {string} convId 会话 ID
 * @param {string} userId 当前用户 ID
 * @param {string} [time] 已读时间，缺省为当前时间
 */
function markRead(convId, userId, time) {
  const list = loadConversations();
  const conv = list.find(c => c.id === convId);
  if (!conv) return;
  conv.reads = conv.reads || {};
  conv.reads[userId] = time || new Date().toISOString();
  saveConversations(list);
}

/**
 * 更新某成员对该会话的个人偏好（置顶 / 免打扰 / 屏蔽 / 备注 / 清空时间点）
 * @param {string} convId 会话 ID
 * @param {string} userId 用户 ID
 * @param {object} patch 需要修改的偏好字段
 * @returns {object|null} 更新后的偏好；会话不存在返回 null
 */
function updatePrefs(convId, userId, patch) {
  const list = loadConversations();
  const conv = list.find(c => c.id === convId);
  if (!conv) return null;
  conv.prefs = conv.prefs || {};
  const next = Object.assign(getPrefs(conv, userId), patch || {});
  conv.prefs[userId] = normalizePrefs(next);                 // 统一规整后落盘
  saveConversations(list);
  return conv.prefs[userId];
}

/**
 * 更新会话资料（群名 / 群公告 / 群设置）
 * @param {string} convId 会话 ID
 * @param {object} patch 只允许 title、announcement、settings 三个字段
 * @returns {object|null} 更新后的会话；不存在返回 null
 */
function updateConversation(convId, patch) {
  const list = loadConversations();
  const conv = list.find(c => c.id === convId);
  if (!conv) return null;
  if (patch.title !== undefined) conv.title = String(patch.title);
  if (patch.announcement !== undefined) conv.announcement = String(patch.announcement);
  if (patch.settings !== undefined) conv.settings = normalizeSettings({ settings: patch.settings });
  saveConversations(list);
  return conv;
}

/**
 * 清空某成员的聊天记录：记录一个时间点，之后只展示该时间点之后的消息
 * （消息本身保留，不影响其他成员）
 * @param {string} convId 会话 ID
 * @param {string} userId 用户 ID
 * @returns {object|null} 更新后的偏好
 */
function clearMessagesForUser(convId, userId) {
  return updatePrefs(convId, userId, { clearedAt: new Date().toISOString() });
}

/**
 * 删除整个会话：直接移除会话目录（含聊天记录、作业、图片、文件、头像）
 * @param {string} convId 会话 ID
 * @returns {boolean} 是否删除成功
 */
function deleteConversation(convId) {
  const conv = findConversation(convId);
  if (!conv) return false;
  const dir = convDir(conv);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略删除失败 */ }
  return true;
}

/**
 * 向群聊追加成员（已在群内的自动跳过）
 * @param {string} convId 会话 ID
 * @param {Array<string>} memberIds 待加入的用户 ID
 * @returns {object|null} 更新后的会话；不存在返回 null
 */
function addMembers(convId, memberIds) {
  const list = loadConversations();
  const conv = list.find(c => c.id === convId);
  if (!conv) return null;
  const members = Array.isArray(conv.members) ? conv.members.slice() : [];
  (memberIds || []).forEach(id => { if (!members.includes(id)) members.push(id); });
  conv.members = members;
  saveConversations(list);
  return conv;
}

/**
 * 从群聊移出成员
 * @param {string} convId 会话 ID
 * @param {string} userId 被移出的用户 ID
 * @returns {object|null} 更新后的会话；不存在返回 null
 */
function removeMember(convId, userId) {
  const list = loadConversations();
  const conv = list.find(c => c.id === convId);
  if (!conv) return null;
  conv.members = (conv.members || []).filter(id => id !== userId);
  saveConversations(list);
  return conv;
}

/**
 * 取某人在该会话中发出的最后一条消息（用于发言限频校验）
 * @param {string} convId 会话 ID
 * @param {string} senderId 发送者用户 ID
 * @returns {object|null}
 */
function lastMessageBy(convId, senderId) {
  const list = loadMessages().filter(m => m.convId === convId && m.senderId === senderId);
  return list.length ? list[list.length - 1] : null;
}

/**
 * 同步作业卡片消息：编辑作业后更新卡片标题与科目
 * @param {string} homeworkId 作业 ID
 * @param {{title:string, subject:string}} patch 新的标题与科目
 * @returns {number} 受影响的消息条数
 */
function updateHomeworkCard(homeworkId, patch) {
  const messages = loadMessages();
  let count = 0;                                                   // 受影响的消息条数
  messages.forEach(m => {
    const parts = m.parts || [];
    if (!parts.some(p => p.type === 'homework' && p.homeworkId === homeworkId)) return;
    parts.forEach(p => {
      if (p.type === 'homework' && p.homeworkId === homeworkId) {
        p.title = patch.title;
        p.subject = patch.subject;
      }
    });
    m.text = '【作业】' + patch.title;                              // 会话列表预览同步
    count++;
  });
  if (count) saveMessages(messages);
  return count;
}

/**
 * 删除作业时移除对应的聊天卡片消息
 * @param {string} homeworkId 作业 ID
 */
function removeHomeworkMessages(homeworkId) {
  const messages = loadMessages();
  const rest = messages.filter(m =>
    !(m.parts || []).some(p => p.type === 'homework' && p.homeworkId === homeworkId));
  if (rest.length !== messages.length) saveMessages(rest);
}

module.exports = {
  DATA_DIR,
  GROUP_DIR,
  INDIVIDUAL_DIR,
  init,
  genId,
  convDir,
  findConvDir,
  listConvDirs,
  loadConversations,
  saveConversations,
  loadFriendRequests,
  saveFriendRequests,
  CONTACTS_DIR,
  DEFAULT_CONTACT_GROUPS,
  loadContacts,
  saveContacts,
  loadHomework,
  saveHomework,
  loadAlbums,
  saveAlbums,
  updateHomeworkCard,
  removeHomeworkMessages,
  findConversation,
  listConversationsFor,
  createConversation,
  loadMessages,
  saveMessages,
  listMessages,
  addMessage,
  findMessage,
  recallMessage,
  hideMessage,
  markRead,
  convCode,
  normalizeSettings,
  getPrefs,
  updatePrefs,
  updateConversation,
  clearMessagesForUser,
  deleteConversation,
  addMembers,
  removeMember,
  lastMessageBy
};
