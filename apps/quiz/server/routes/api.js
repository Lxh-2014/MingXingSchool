/**
 * 学生综合答题平台 —— API 路由
 * ----------------------------------------------------------
 * 全部接口挂在 /quiz/api 下（主入口已施加登录守卫），本文件再解析当前
 * 登录用户，管理类接口额外校验管理员身份。
 *
 * 关键约定：
 *   - 前端传入的 userId 一律忽略，统一使用会话里的登录用户
 *   - 题目答案格式：单选/填空=字符串，多选/连词成句=字符串数组，
 *     连线=对象 { 左项: 右项 }，画板=null 由教师手动批改
 *   - 练习提交后服务端判分；画板题无法自动判分，保留为待人工处理
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const store = require('../store');
const sessions = require('../../../../server/core/sessions');
const userStore = require('../../../../server/core/userStore');

const router = express.Router();

/** 上传文件目录：apps/quiz/data/uploads（题目图片 / 提示音） */
const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * 去掉字符串首尾空白并转小写（判分时忽略大小写与空格）
 * @param {*} v 任意值
 * @returns {string}
 */
function norm(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * 解析当前登录用户
 * @param {import('express').Request} req Express 请求
 * @returns {{id: string, name: string, entry: object} | null} 未登录返回 null
 */
function currentUser(req) {
    const token = sessions.getTokenFromRequest(req);
    const id = token ? sessions.getUserId(token) : null;
    if (!id) return null;
    const entry = userStore.getUserById(id);
    return { id, name: (entry && entry.name) || id, entry: entry || {} };
}

/**
 * 登录守卫：接口未登录返回 401 JSON
 */
function requireUser(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: '请先登录' });
    req.quizUser = user;
    req.userId = user.id;
    next();
}

/**
 * 管理员守卫：在登录守卫基础上校验管理员身份
 */
function requireAdmin(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: '请先登录' });
    if (!userStore.isAdminId(user.id)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    req.quizUser = user;
    req.userId = user.id;
    next();
}

/**
 * 统一成功响应
 * @param {import('express').Response} res 响应对象
 * @param {*} data 返回数据
 */
function ok(res, data) {
    res.json({ ok: true, data: data === undefined ? null : data });
}

/**
 * 统一失败响应（HTTP 200 + ok:false，前端统一弹提示）
 * @param {import('express').Response} res 响应对象
 * @param {string} message 中文错误提示
 * @param {number} [status=400] HTTP 状态码
 */
function fail(res, message, status = 400) {
    res.status(status).json({ ok: false, error: message });
}

/**
 * 判断用户答案是否正确
 * @param {object} question 题目（含 type / correct_answer）
 * @param {*} userAnswer 用户答案
 * @returns {boolean|null} 正确/错误；画板题返回 null（需人工批改）
 */
function judge(question, userAnswer) {
    const type = question.type;
    const correct = question.correct_answer;
    if (type === 'drawing') return null;
    if (userAnswer === undefined || userAnswer === null || userAnswer === '') return false;

    if (type === 'multiple_choice') {
        const a = Array.isArray(userAnswer) ? userAnswer.map(norm).sort() : [norm(userAnswer)];
        const b = Array.isArray(correct) ? correct.map(norm).sort() : [];
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    if (type === 'sentence_order') {
        const a = Array.isArray(userAnswer) ? userAnswer.map(norm) : String(userAnswer).split(',').map(norm).filter(Boolean);
        const b = Array.isArray(correct) ? correct.map(norm) : [];
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    if (type === 'matching') {
        let ua = userAnswer;
        if (typeof ua === 'string') { try { ua = JSON.parse(ua); } catch (_) { return false; } }
        if (!ua || typeof ua !== 'object') return false;
        const keys = Object.keys(correct || {});
        if (Object.keys(ua).length !== keys.length) return false;
        return keys.every(k => {
            const uk = Object.keys(ua).find(x => norm(x) === norm(k));
            return uk !== undefined && norm(ua[uk]) === norm(correct[k]);
        });
    }
    // 单选 / 填空
    return norm(userAnswer) === norm(correct);
}

/**
 * 记录或累计错题（同一用户 + 同一来源 + 同一题只保留一条，错误次数 +1）
 * @param {string} userId 用户 id
 * @param {object} q 题目
 * @param {'practice'} source 题目来源
 * @param {object} meta 附加归属（subjectId / lessonId）
 */
function upsertWrong(userId, q, source, meta) {
    const list = store.read('wrong_questions', []);
    const hit = list.find(w => w.user_id === userId && w.question_type === source && w.question_id === q.id);
    if (hit) {
        hit.wrong_count = (hit.wrong_count || 1) + 1;
        hit.last_wrong_at = store.now();
    } else {
        list.push({
            id: store.genId('w'),
            user_id: userId,
            question_id: q.id,
            question_type: source,
            subject_id: (meta && meta.subjectId) || null,
            lesson_id: (meta && meta.lessonId) || null,
            wrong_count: 1,
            last_wrong_at: store.now(),
            created_at: store.now()
        });
    }
    store.write('wrong_questions', list);
}

/**
 * 答对后移除对应错题记录
 * @param {string} userId 用户 id
 * @param {string} questionId 题目 id
 * @param {'practice'} source 题目来源
 */
function removeWrong(userId, questionId, source) {
    const list = store.read('wrong_questions', []);
    const next = list.filter(w => !(w.user_id === userId && w.question_id === questionId && w.question_type === source));
    if (next.length !== list.length) store.write('wrong_questions', next);
}

// ==================== 当前用户 ====================

/** 当前登录用户信息（角色 / 积分 / 头像） */
router.get('/me', requireUser, (req, res) => {
    const u = req.quizUser;
    ok(res, {
        id: u.id,
        name: u.name,
        isAdmin: userStore.isAdminId(u.id),
        points: u.entry.points || 0,
        avatar: userStore.hasAvatarFile(u.id) ? '/drive/assets/user/' + encodeURIComponent(u.id) + '.png' : null
    });
});

// ==================== 科目 / 单元 / 课程 ====================

/** 科目列表 */
router.get('/subjects', requireUser, (req, res) => {
    const list = store.read('subjects', []).slice()
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    ok(res, list);
});

/** 新建科目 */
router.post('/subjects', requireAdmin, (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, '请输入科目名称');
    const list = store.read('subjects', []);
    const subject = {
        id: store.genId('s'),
        name,
        icon: req.body.icon || '📘',
        description: req.body.description || null,
        display_order: Number(req.body.display_order) || (list.length + 1),
        is_active: req.body.is_active !== false,
        created_at: store.now()
    };
    list.push(subject);
    store.write('subjects', list);
    ok(res, subject);
});

/** 修改科目 */
router.patch('/subjects/:id', requireAdmin, (req, res) => {
    const list = store.read('subjects', []);
    const s = list.find(x => x.id === req.params.id);
    if (!s) return fail(res, '科目不存在', 404);
    ['name', 'icon', 'description', 'display_order', 'is_active'].forEach(k => {
        if (k in req.body) s[k] = req.body[k];
    });
    store.write('subjects', list);
    ok(res, s);
});

/** 删除科目（连带单元 / 课程 / 练习题目） */
router.delete('/subjects/:id', requireAdmin, (req, res) => {
    const sid = req.params.id;
    const subjects = store.read('subjects', []);
    const next = subjects.filter(s => s.id !== sid);
    if (next.length === subjects.length) return fail(res, '科目不存在', 404);
    store.write('subjects', next);
    const units = store.read('units', []);
    const unitIds = units.filter(u => u.subject_id === sid).map(u => u.id);
    store.write('units', units.filter(u => u.subject_id !== sid));
    store.write('lessons', store.read('lessons', []).filter(l => !unitIds.includes(l.unit_id)));
    store.write('practice_questions', store.read('practice_questions', []).filter(q => q.subject_id !== sid));
    ok(res);
});

/** 单元列表（可按科目筛选） */
router.get('/units', requireUser, (req, res) => {
    let list = store.read('units', []).slice();
    if (req.query.subjectId) list = list.filter(u => u.subject_id === req.query.subjectId);
    list.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    ok(res, list);
});

/** 新建单元 */
router.post('/units', requireAdmin, (req, res) => {
    if (!req.body.subject_id) return fail(res, '请选择所属科目');
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, '请输入单元名称');
    const list = store.read('units', []);
    const unit = {
        id: store.genId('u'),
        subject_id: req.body.subject_id,
        name,
        description: req.body.description || null,
        display_order: Number(req.body.display_order) || (list.filter(u => u.subject_id === req.body.subject_id).length + 1),
        created_at: store.now()
    };
    list.push(unit);
    store.write('units', list);
    ok(res, unit);
});

/** 修改单元 */
router.patch('/units/:id', requireAdmin, (req, res) => {
    const list = store.read('units', []);
    const u = list.find(x => x.id === req.params.id);
    if (!u) return fail(res, '单元不存在', 404);
    ['subject_id', 'name', 'description', 'display_order'].forEach(k => {
        if (k in req.body) u[k] = req.body[k];
    });
    store.write('units', list);
    ok(res, u);
});

/** 删除单元（连带课程 / 练习题目） */
router.delete('/units/:id', requireAdmin, (req, res) => {
    const uid = req.params.id;
    const units = store.read('units', []);
    const next = units.filter(u => u.id !== uid);
    if (next.length === units.length) return fail(res, '单元不存在', 404);
    store.write('units', next);
    const lessons = store.read('lessons', []);
    const lessonIds = lessons.filter(l => l.unit_id === uid).map(l => l.id);
    store.write('lessons', lessons.filter(l => l.unit_id !== uid));
    store.write('practice_questions', store.read('practice_questions', []).filter(q => !lessonIds.includes(q.lesson_id)));
    ok(res);
});

/** 课程列表（可按单元筛选） */
router.get('/lessons', requireUser, (req, res) => {
    let list = store.read('lessons', []).slice();
    if (req.query.unitId) list = list.filter(l => l.unit_id === req.query.unitId);
    list.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    ok(res, list);
});

/** 新建课程 */
router.post('/lessons', requireAdmin, (req, res) => {
    if (!req.body.unit_id) return fail(res, '请选择所属单元');
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, '请输入课程名称');
    const list = store.read('lessons', []);
    const lesson = {
        id: store.genId('l'),
        unit_id: req.body.unit_id,
        name,
        description: req.body.description || null,
        icon: req.body.icon || 'star',
        display_order: Number(req.body.display_order) || (list.filter(l => l.unit_id === req.body.unit_id).length + 1),
        created_at: store.now()
    };
    list.push(lesson);
    store.write('lessons', list);
    ok(res, lesson);
});

/** 修改课程 */
router.patch('/lessons/:id', requireAdmin, (req, res) => {
    const list = store.read('lessons', []);
    const l = list.find(x => x.id === req.params.id);
    if (!l) return fail(res, '课程不存在', 404);
    ['unit_id', 'name', 'description', 'icon', 'display_order'].forEach(k => {
        if (k in req.body) l[k] = req.body[k];
    });
    store.write('lessons', list);
    ok(res, l);
});

/** 删除课程（连带练习题目） */
router.delete('/lessons/:id', requireAdmin, (req, res) => {
    const lid = req.params.id;
    const list = store.read('lessons', []);
    const next = list.filter(l => l.id !== lid);
    if (next.length === list.length) return fail(res, '课程不存在', 404);
    store.write('lessons', next);
    store.write('practice_questions', store.read('practice_questions', []).filter(q => q.lesson_id !== lid));
    ok(res);
});

// ==================== 练习题目 ====================

/** 练习题目列表（按科目 / 课程筛选；学员仅返回已启用科目的题目） */
router.get('/practice-questions', requireUser, (req, res) => {
    let list = store.read('practice_questions', []).slice();
    if (req.query.subjectId) list = list.filter(q => q.subject_id === req.query.subjectId);
    if (req.query.lessonId) list = list.filter(q => q.lesson_id === req.query.lessonId);
    list.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    ok(res, list);
});

/** 新建练习题目 */
router.post('/practice-questions', requireAdmin, (req, res) => {
    const body = req.body || {};
    if (!body.subject_id) return fail(res, '请选择所属科目');
    if (!body.content || !String(body.content).trim()) return fail(res, '请输入题目内容');
    if (!body.type) return fail(res, '请选择题型');
    const list = store.read('practice_questions', []);
    const q = {
        id: store.genId('p'),
        subject_id: body.subject_id,
        lesson_id: body.lesson_id || null,
        type: body.type,
        content: body.content,
        options: body.options === undefined ? null : body.options,
        correct_answer: body.correct_answer === undefined ? null : body.correct_answer,
        image_url: body.image_url || null,
        audio_url: body.audio_url || null,
        explanation: body.explanation || null,
        display_order: Number(body.display_order) || (list.filter(x => x.subject_id === body.subject_id).length + 1),
        created_at: store.now()
    };
    list.push(q);
    store.write('practice_questions', list);
    ok(res, q);
});

/** 修改练习题目 */
router.patch('/practice-questions/:id', requireAdmin, (req, res) => {
    const list = store.read('practice_questions', []);
    const q = list.find(x => x.id === req.params.id);
    if (!q) return fail(res, '题目不存在', 404);
    ['subject_id', 'lesson_id', 'type', 'content', 'options', 'correct_answer', 'image_url', 'audio_url', 'explanation', 'display_order'].forEach(k => {
        if (k in req.body) q[k] = req.body[k];
    });
    store.write('practice_questions', list);
    ok(res, q);
});

/** 删除练习题目 */
router.delete('/practice-questions/:id', requireAdmin, (req, res) => {
    const list = store.read('practice_questions', []);
    const next = list.filter(q => q.id !== req.params.id);
    if (next.length === list.length) return fail(res, '题目不存在', 404);
    store.write('practice_questions', next);
    ok(res);
});

// ==================== 练习记录 / 练习会话 ====================

/** 我的练习答题记录（管理员可加 all=1） */
router.get('/practice-records', requireUser, (req, res) => {
    const isAdmin = userStore.isAdminId(req.userId);
    let list = store.read('practice_records', []).slice();
    if (!(req.query.all === '1' && isAdmin)) list = list.filter(r => r.user_id === req.userId);
    if (req.query.subjectId) list = list.filter(r => r.subject_id === req.query.subjectId);
    list.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    ok(res, list);
});

/**
 * 完成一次练习：保存逐题记录 + 练习会话 + 维护错题本
 * body: { subjectId, lessonId, timeSpent, answers: [{ questionId, userAnswer, isCorrect }] }
 */
router.post('/practice-sessions', requireUser, (req, res) => {
    const body = req.body || {};
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (!answers.length) return fail(res, '没有可提交的答题内容');
    const subjectId = body.subjectId;
    if (!subjectId) return fail(res, '缺少科目信息');
    const pool = store.read('practice_questions', []);
    const questions = pool.filter(q => q.subject_id === subjectId);
    const subject = store.read('subjects', []).find(s => s.id === subjectId) || null;
    const lesson = body.lessonId ? store.read('lessons', []).find(l => l.id === body.lessonId) : null;
    const unit = lesson ? store.read('units', []).find(u => u.id === lesson.unit_id) : null;

    let correctCount = 0;                                // 答对题数
    const records = [];
    answers.forEach(a => {
        const q = questions.find(x => x.id === a.questionId);
        if (!q) return;
        const isCorrect = a.isCorrect === true || judge(q, a.userAnswer) === true;
        if (isCorrect) correctCount++;
        records.push({
            id: store.genId('pr'),
            user_id: req.userId,
            subject_id: subjectId,
            question_id: q.id,
            user_answer: a.userAnswer === undefined ? '' : a.userAnswer,
            is_correct: isCorrect,
            completed_at: store.now()
        });
        if (isCorrect) removeWrong(req.userId, q.id, 'practice');
        else upsertWrong(req.userId, q, 'practice', { subjectId, lessonId: body.lessonId || null });
    });
    const total = records.length || answers.length;
    const rate = Number(((correctCount / total) * 100).toFixed(2));
    const session = {
        id: store.genId('ps'),
        user_id: req.userId,
        subject_id: subjectId,
        lesson_id: body.lessonId || null,
        total_questions: total,
        correct_count: correctCount,
        time_spent: Number(body.timeSpent) || 0,
        correct_rate: rate,
        completed_at: store.now(),
        record_id: records.length ? records[0].id : null,
        user_name: req.quizUser.name,
        subject_name: subject ? subject.name : null,
        unit_name: unit ? unit.name : null,
        lesson_name: lesson ? lesson.name : null
    };
    const allRecords = store.read('practice_records', []);
    store.write('practice_records', allRecords.concat(records));
    const sessionsList = store.read('practice_sessions', []);
    sessionsList.push(session);
    store.write('practice_sessions', sessionsList);
    ok(res, session);
});

/** 练习会话列表（学员看自己；管理员传 all=1 看全部并支持筛选） */
router.get('/practice-sessions', requireUser, (req, res) => {
    const isAdmin = userStore.isAdminId(req.userId);
    let list = store.read('practice_sessions', []).slice();
    if (!(req.query.all === '1' && isAdmin)) list = list.filter(s => s.user_id === req.userId);
    if (req.query.subjectId) list = list.filter(s => s.subject_id === req.query.subjectId);
    if (req.query.userName) list = list.filter(s => String(s.user_name || '').includes(req.query.userName));
    if (req.query.subjectName) list = list.filter(s => String(s.subject_name || '').includes(req.query.subjectName));
    list.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    ok(res, list.slice(0, Number(req.query.limit) || 200));
});

/** 已完成课程集合（正确率 ≥ 60% 视为完成，用于解锁下一课程） */
router.get('/practice-sessions/completed-lessons', requireUser, (req, res) => {
    const subjectId = req.query.subjectId;
    const list = store.read('practice_sessions', [])
        .filter(s => s.user_id === req.userId && s.lesson_id && s.subject_id === subjectId && Number(s.correct_rate) >= 60);
    ok(res, Array.from(new Set(list.map(s => s.lesson_id))));
});

// ==================== 错题本 ====================

/** 我的错题列表（附带题目原文与所属名称） */
router.get('/wrong-questions', requireUser, (req, res) => {
    const list = store.read('wrong_questions', []).filter(w => w.user_id === req.userId);
    const practiceQuestions = store.read('practice_questions', []);
    const subjects = store.read('subjects', []);
    const lessons = store.read('lessons', []);
    const rows = list.map(w => {
        const q = practiceQuestions.find(x => x.id === w.question_id);
        return Object.assign({}, w, {
            question: q || null,
            subject_name: (subjects.find(s => s.id === w.subject_id) || {}).name || null,
            lesson_name: (lessons.find(l => l.id === w.lesson_id) || {}).name || null
        });
    }).filter(w => w.question);
    rows.sort((a, b) => String(b.last_wrong_at).localeCompare(String(a.last_wrong_at)));
    ok(res, rows);
});

/** 手动移除一条错题 */
router.delete('/wrong-questions/:id', requireUser, (req, res) => {
    const list = store.read('wrong_questions', []);
    const next = list.filter(w => !(w.id === req.params.id && w.user_id === req.userId));
    if (next.length === list.length) return fail(res, '错题不存在', 404);
    store.write('wrong_questions', next);
    ok(res);
});

/** 清空我的错题 */
router.delete('/wrong-questions', requireUser, (req, res) => {
    const list = store.read('wrong_questions', []);
    store.write('wrong_questions', list.filter(w => w.user_id !== req.userId));
    ok(res);
});

// ==================== 提示音设置 ====================

/** 读取提示音（所有登录用户可读，用于答题时播放） */
router.get('/sound-settings', requireUser, (req, res) => {
    const s = store.read('sound_settings', {});
    ok(res, Object.assign({ id: 'default', correct_sound: null, incorrect_sound: null, complete_sound: null }, s));
});

/** 保存提示音设置（管理员） */
router.put('/sound-settings', requireAdmin, (req, res) => {
    const s = store.read('sound_settings', {});
    ['correct_sound', 'incorrect_sound', 'complete_sound'].forEach(k => {
        if (k in req.body) s[k] = req.body[k] || null;
    });
    s.updated_at = store.now();
    store.write('sound_settings', s);
    ok(res, s);
});

// ==================== 用户 ====================

/** 用户列表（管理员） */
router.get('/admin/users', requireAdmin, (req, res) => {
    const users = userStore.listUsers();
    ok(res, users.map(u => Object.assign({}, u, {
        is_admin: userStore.isAdminId(u.id)
    })));
});

// ==================== 文件上传（题目图片 / 提示音） ====================

/**
 * 上传 base64 文件（题目图片 / 音频），返回可访问 URL
 * body: { dataUrl: 'data:image/png;base64,...', kind: 'image'|'audio' }
 */
router.post('/upload', requireAdmin, (req, res) => {
    const dataUrl = String(req.body.dataUrl || '');
    const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!m) return fail(res, '文件格式不正确');
    const mime = m[1];
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg' };
    const ext = extMap[mime];
    if (!ext) return fail(res, '仅支持 PNG/JPG/WEBP/GIF 图片或 MP3/WAV/OGG 音频');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) return fail(res, '文件不能超过 8MB');
    const name = store.genId('f') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    ok(res, { url: '/quiz/uploads/' + name });
});

module.exports = router;
