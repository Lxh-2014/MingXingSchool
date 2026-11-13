/**
 * store.js —— 学生综合答题平台 JSON 存储层
 * ----------------------------------------------------------
 * 数据文件全部位于 apps/quiz/data/ 下：
 *   subjects.json            练习科目
 *   units.json               练习单元
 *   lessons.json             练习课程
 *   practice_questions.json  练习题目
 *   practice_records.json    练习答题记录
 *   practice_sessions.json   练习会话（一次练习一条，用于课程完成判定与统计）
 *   wrong_questions.json     错题本
 *   sound_settings.json      提示音设置
 *
 * 设计要点：
 *   - 首次读取时自动建目录并写入初始数据，无需手工初始化
 *   - 写入采用「临时文件 + rename」原子替换，避免写一半导致 JSON 损坏
 *   - 读取带进程内缓存 + mtime 校验，外部改动文件后下一次读取自动生效
 */
const fs = require('fs');
const path = require('path');

/** 数据目录：apps/quiz/data */
const DATA_DIR = path.join(__dirname, '..', 'data');

/** 各数据文件绝对路径（键名即数据名，路由层通过 read/write 读写） */
const FILES = {
    subjects: path.join(DATA_DIR, 'subjects.json'),
    units: path.join(DATA_DIR, 'units.json'),
    lessons: path.join(DATA_DIR, 'lessons.json'),
    practice_questions: path.join(DATA_DIR, 'practice_questions.json'),
    practice_records: path.join(DATA_DIR, 'practice_records.json'),
    practice_sessions: path.join(DATA_DIR, 'practice_sessions.json'),
    wrong_questions: path.join(DATA_DIR, 'wrong_questions.json'),
    sound_settings: path.join(DATA_DIR, 'sound_settings.json')
};

/** 读取缓存：file → { mtime, data }，避免每次请求重复解析 JSON */
const cache = new Map();

/** 当前时间 ISO 字符串，统一记录时间格式 */
function now() {
    return new Date().toISOString();
}

/** 确保数据目录存在 */
function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 生成短 ID：前缀 + 时间戳36进制 + 4位随机
 * @param {string} prefix ID 前缀（s=科目 u=单元 l=课程 p=练习 w=错题）
 * @returns {string}
 */
function genId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 读取一个 JSON 数据文件（带缓存与 mtime 热更新）
 * @param {string} name 数据名（FILES 的键）
 * @param {*} fallback 文件不存在或损坏时的默认值
 * @returns {*} 解析后的数据
 */
function read(name, fallback) {
    const file = FILES[name];
    if (!FILES[name]) throw new Error('未知数据文件：' + name);
    if (!fs.existsSync(file)) {
        write(name, fallback);
        return fallback;
    }
    const mtime = fs.statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.data;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache.set(file, { mtime, data });
        return data;
    } catch (e) {
        // JSON 损坏：备份坏文件后重建默认值，保证服务不崩
        try { fs.copyFileSync(file, file + '.corrupt'); } catch (_) { /* 忽略备份失败 */ }
        write(name, fallback);
        return fallback;
    }
}

/**
 * 写入一个 JSON 数据文件（原子替换 + 刷新缓存）
 * @param {string} name 数据名（FILES 的键）
 * @param {*} data 要写入的数据
 */
function write(name, data) {
    ensureDir();
    const file = FILES[name];
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    cache.set(file, { mtime: fs.statSync(file).mtimeMs, data });
}

// ==================== 初始数据：首次启动自动填充，保证开箱可用 ====================

/** 可选选项对象（文本 + 可选图片） */
function opt(text) { return { text: text }; }

/**
 * 初始科目数据
 */
const SEED_SUBJECTS = [
    { id: 'sub-yw', name: '语文', icon: '📖', description: '字词积累与阅读理解', display_order: 1, is_active: true, created_at: now() },
    { id: 'sub-sx', name: '数学', icon: '🔢', description: '数与运算、乘法口诀', display_order: 2, is_active: true, created_at: now() },
    { id: 'sub-yy', name: '英语', icon: '🌍', description: '日常表达与问候语', display_order: 3, is_active: true, created_at: now() }
];

/** 初始单元数据 */
const SEED_UNITS = [
    { id: 'unit-yw-1', subject_id: 'sub-yw', name: '第一单元 · 字词积累', description: '生字认读与词语搭配', display_order: 1, created_at: now() },
    { id: 'unit-yw-2', subject_id: 'sub-yw', name: '第二单元 · 阅读理解', description: '短文理解与句子排序', display_order: 2, created_at: now() },
    { id: 'unit-sx-1', subject_id: 'sub-sx', name: '第一单元 · 数与运算', description: '加减法与乘法口诀', display_order: 1, created_at: now() },
    { id: 'unit-yy-1', subject_id: 'sub-yy', name: '第一单元 · 日常表达', description: '问候与自我介绍', display_order: 1, created_at: now() }
];

/** 初始课程数据 */
const SEED_LESSONS = [
    { id: 'les-yw-1', unit_id: 'unit-yw-1', name: '生字认读', description: '常见生字的读音与写法', icon: 'star', display_order: 1, created_at: now() },
    { id: 'les-yw-2', unit_id: 'unit-yw-1', name: '词语搭配', description: '把词语连成通顺的句子', icon: 'dumbbell', display_order: 2, created_at: now() },
    { id: 'les-yw-3', unit_id: 'unit-yw-2', name: '短文理解', description: '读短文回答问题', icon: 'trophy', display_order: 1, created_at: now() },
    { id: 'les-sx-1', unit_id: 'unit-sx-1', name: '加减法', description: '100 以内加减法', icon: 'star', display_order: 1, created_at: now() },
    { id: 'les-sx-2', unit_id: 'unit-sx-1', name: '乘法口诀', description: '九九乘法表', icon: 'trophy', display_order: 2, created_at: now() },
    { id: 'les-yy-1', unit_id: 'unit-yy-1', name: '问候语', description: 'Hello / Good morning 等', icon: 'star', display_order: 1, created_at: now() }
];

/** 初始练习题目（覆盖 6 种题型，便于验证渲染与判分） */
const SEED_PRACTICE_QUESTIONS = [
    {
        id: 'pq-1', subject_id: 'sub-yw', lesson_id: 'les-yw-1', type: 'single_choice',
        content: '“春”字的正确读音是？', options: [opt('chūn'), opt('cūn'), opt('chēn'), opt('chuēn')],
        correct_answer: 'chūn', image_url: null, audio_url: null, explanation: '“春”读 chūn，第一声。', display_order: 1, created_at: now()
    },
    {
        id: 'pq-2', subject_id: 'sub-yw', lesson_id: 'les-yw-1', type: 'single_choice',
        content: '下列词语中没有错别字的一项是？', options: [opt('再接再励'), opt('再接再厉'), opt('再接再利'), opt('再接再立')],
        correct_answer: '再接再厉', image_url: null, audio_url: null, explanation: '正确写法是“再接再厉”。', display_order: 2, created_at: now()
    },
    {
        id: 'pq-3', subject_id: 'sub-yw', lesson_id: 'les-yw-1', type: 'fill_blank',
        content: '“一寸光阴一寸金”的下一句是：________。', options: null,
        correct_answer: '寸金难买寸光阴', image_url: null, audio_url: null, explanation: '出自《增广贤文》。', display_order: 3, created_at: now()
    },
    {
        id: 'pq-4', subject_id: 'sub-yw', lesson_id: 'les-yw-2', type: 'multiple_choice',
        content: '下列哪些词可以用来形容春天？', options: [opt('鸟语花香'), opt('冰天雪地'), opt('春暖花开'), opt('烈日炎炎')],
        correct_answer: ['鸟语花香', '春暖花开'], image_url: null, audio_url: null, explanation: '其余两项分别形容冬天和夏天。', display_order: 1, created_at: now()
    },
    {
        id: 'pq-5', subject_id: 'sub-yw', lesson_id: 'les-yw-2', type: 'matching',
        content: '把左右两边搭配成正确的词语。',
        options: { left: [opt('明亮的'), opt('清澈的'), opt('勤劳的')], right: [opt('眼睛'), opt('河水'), opt('蜜蜂')] },
        correct_answer: { '明亮的': '眼睛', '清澈的': '河水', '勤劳的': '蜜蜂' },
        image_url: null, audio_url: null, explanation: '形容词与名词合理搭配。', display_order: 2, created_at: now()
    },
    {
        id: 'pq-6', subject_id: 'sub-yw', lesson_id: 'les-yw-2', type: 'sentence_order',
        content: '把下面的词语排成通顺的句子。', options: ['小明', '在家里', '认真地', '写作业'],
        correct_answer: ['小明', '在家里', '认真地', '写作业'],
        image_url: null, audio_url: null, explanation: '按“谁 + 在哪里 + 怎样 + 做什么”排序。', display_order: 3, created_at: now()
    },
    {
        id: 'pq-7', subject_id: 'sub-yw', lesson_id: 'les-yw-3', type: 'single_choice',
        content: '《静夜思》的作者是谁？', options: [opt('杜甫'), opt('李白'), opt('白居易'), opt('王维')],
        correct_answer: '李白', image_url: null, audio_url: null, explanation: '《静夜思》是李白的代表作。', display_order: 1, created_at: now()
    },
    {
        id: 'pq-8', subject_id: 'sub-sx', lesson_id: 'les-sx-1', type: 'single_choice',
        content: '27 + 35 = ？', options: [opt('52'), opt('62'), opt('63'), opt('72')],
        correct_answer: '62', image_url: null, audio_url: null, explanation: '27 + 35 = 62。', display_order: 1, created_at: now()
    },
    {
        id: 'pq-9', subject_id: 'sub-sx', lesson_id: 'les-sx-1', type: 'fill_blank',
        content: '90 - 46 = ________。', options: null,
        correct_answer: '44', image_url: null, audio_url: null, explanation: '90 - 46 = 44。', display_order: 2, created_at: now()
    },
    {
        id: 'pq-10', subject_id: 'sub-sx', lesson_id: 'les-sx-2', type: 'fill_blank',
        content: '七八________。', options: null,
        correct_answer: '五十六', image_url: null, audio_url: null, explanation: '7 × 8 = 56。', display_order: 1, created_at: now()
    },
    {
        id: 'pq-11', subject_id: 'sub-sx', lesson_id: 'les-sx-2', type: 'single_choice',
        content: '6 × 9 = ？', options: [opt('54'), opt('45'), opt('56'), opt('63')],
        correct_answer: '54', image_url: null, audio_url: null, explanation: '六九五十四。', display_order: 2, created_at: now()
    },
    {
        id: 'pq-12', subject_id: 'sub-yy', lesson_id: 'les-yy-1', type: 'single_choice',
        content: '“早上好”用英语怎么说？', options: [opt('Good morning'), opt('Good night'), opt('Good afternoon'), opt('Goodbye')],
        correct_answer: 'Good morning', image_url: null, audio_url: null, explanation: 'Good morning 表示早上好。', display_order: 1, created_at: now()
    },
    {
        id: 'pq-13', subject_id: 'sub-yy', lesson_id: 'les-yy-1', type: 'single_choice',
        content: '初次见面说“很高兴认识你”，应选？', options: [opt('Nice to meet you'), opt('See you later'), opt('Thank you'), opt('Sorry')],
        correct_answer: 'Nice to meet you', image_url: null, audio_url: null, explanation: 'Nice to meet you 表示很高兴认识你。', display_order: 2, created_at: now()
    }
];

/** 提示音默认设置 */
const SEED_SOUND = {
    id: 'default',
    correct_sound: null,
    incorrect_sound: null,
    complete_sound: null,
    created_at: now(),
    updated_at: now()
};

/**
 * 初始化：创建目录与全部数据文件（幂等，已有文件不覆盖）
 */
function init() {
    ensureDir();
    if (!fs.existsSync(FILES.subjects)) write('subjects', SEED_SUBJECTS);
    if (!fs.existsSync(FILES.units)) write('units', SEED_UNITS);
    if (!fs.existsSync(FILES.lessons)) write('lessons', SEED_LESSONS);
    if (!fs.existsSync(FILES.practice_questions)) write('practice_questions', SEED_PRACTICE_QUESTIONS);
    if (!fs.existsSync(FILES.practice_records)) write('practice_records', []);
    if (!fs.existsSync(FILES.practice_sessions)) write('practice_sessions', []);
    if (!fs.existsSync(FILES.wrong_questions)) write('wrong_questions', []);
    if (!fs.existsSync(FILES.sound_settings)) write('sound_settings', SEED_SOUND);
}

module.exports = { init, read, write, genId, now, DATA_DIR };
