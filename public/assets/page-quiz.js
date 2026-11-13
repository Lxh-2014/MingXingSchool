/**
 * page-quiz.js —— 学生综合答题平台前端（纯 JS 渲染）
 * ----------------------------------------------------------------------
 * 页面由 index.html 提供的 <div id="root"> 挂载，本文件负责：
 *   1. renderShell()   注入侧边栏 / 顶栏 / 内容容器
 *   2. 路由系统        History API（无 hash），基础路径 /quiz
 *   3. 所有页面视图    练习 / 错题本 / 个人中心 / 练习与系统管理
 *
 * 依赖：/assets/all.css（末尾 qz- 样式段）、/assets/common-ui.js（Toast）
 */
(function () {
    'use strict';

    /** 接口基础路径（主项目把本应用挂载在 /quiz 下） */
    var API = '/quiz/api';
    /** 应用基础路径（前端路由前缀） */
    var BASE = '/quiz';
    /** 当前登录用户（/quiz/api/me 返回，管理员入口据此显示） */
    var ME = null;
    /** 当前路由路径（用于侧边栏高亮与同页去重） */
    var CURRENT = '';

    /* ==================== 通用工具 ==================== */

    /**
     * HTML 转义，防止题目内容里的特殊字符破坏结构
     * @param {*} v 任意值
     * @returns {string} 转义后的字符串
     */
    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * 轻提示：优先使用 common-ui 的 showToast，缺失时退回控制台
     * @param {string} msg 提示文案
     * @param {string} [type='info'] success/error/info
     */
    function toast(msg, type) {
        if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
        else console.log('[quiz]', msg);
    }

    /**
     * 统一接口请求：自动带 cookie，解析 { ok, data, error } 结构
     * @param {string} path 接口路径（不含 /quiz/api 前缀）
     * @param {object} [options] { method, body }
     * @returns {Promise<*>} 成功时 resolve data，失败 reject Error
     */
    function api(path, options) {
        var opts = options || {};
        var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
        if (opts.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }
        return fetch(API + path, init)
            .then(function (r) {
                return r.json().catch(function () {
                    return { ok: false, error: '服务返回异常（HTTP ' + r.status + '）' };
                });
            })
            .then(function (res) {
                if (!res || res.ok !== true) throw new Error((res && res.error) || '请求失败');
                return res.data;
            });
    }

    /** 内容容器（#qz-view），各页面渲染目标 */
    function view() {
        return document.getElementById('qz-view');
    }

    /**
     * 时间格式化：ISO → YYYY-MM-DD HH:mm
     * @param {string} iso ISO 时间字符串
     * @returns {string}
     */
    function fmtTime(iso) {
        if (!iso) return '-';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '-';
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    /**
     * 秒数格式化为「x 分 y 秒」
     * @param {number} sec 秒
     * @returns {string}
     */
    function fmtDuration(sec) {
        var s = Number(sec) || 0;
        if (s < 60) return s + ' 秒';
        return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    }

    /** 题型中文名映射 */
    var TYPE_LABEL = {
        single_choice: '单选题',
        multiple_choice: '多选题',
        fill_blank: '填空题',
        matching: '连线题',
        sentence_order: '连词成句',
        drawing: '画板题'
    };

    /**
     * 解析题目选项为统一数组（字符串 / 对象 / 键值对象三种原始格式）
     * @param {object} q 题目
     * @returns {Array<{text:string, image?:string, audio?:string}>}
     */
    function parseOptions(q) {
        var o = q && q.options;
        if (!o) return [];
        if (Array.isArray(o)) {
            return o.map(function (x) { return typeof x === 'string' ? { text: x } : (x || { text: '' }); });
        }
        if (Array.isArray(o.left)) return [];       // 连线题的左右项单独处理
        return Object.keys(o).map(function (k) {
            var x = o[k];
            return typeof x === 'string' ? { text: x } : (x || { text: '' });
        });
    }

    /**
     * 连线题左右项解析
     * @param {object} q 题目
     * @returns {{left: string[], right: string[]}}
     */
    function parseMatching(q) {
        var o = (q && q.options) || {};
        var toText = function (arr) {
            return (arr || []).map(function (x) { return typeof x === 'string' ? x : (x && x.text) || ''; });
        };
        return { left: toText(o.left), right: toText(o.right) };
    }

    /**
     * 展示用户答案的文本形式
     * @param {*} ans 用户答案
     * @returns {string}
     */
    function answerText(ans) {
        if (ans === undefined || ans === null || ans === '') return '（未作答）';
        if (Array.isArray(ans)) return ans.join(' / ');
        if (typeof ans === 'object') return Object.keys(ans).map(function (k) { return k + ' → ' + ans[k]; }).join('；');
        if (String(ans).indexOf('data:image') === 0) return '（画板作答）';
        return String(ans);
    }

    /**
     * 展示正确答案的文本形式
     * @param {object} q 题目
     * @returns {string}
     */
    function correctText(q) {
        if (!q || q.correct_answer === null || q.correct_answer === undefined) return '（人工批改）';
        return answerText(q.correct_answer);
    }

    /* ==================== Toast 兜底（common-ui 缺失时） ==================== */

    /* ==================== 骨架 ==================== */

    /** 侧边栏 SVG 图标表 */
    var ICONS = {
        home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
        practice: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/></svg>',
        wrong: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V8h2v5z"/></svg>',
        me: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z"/></svg>',
        admin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.4 13a7.8 7.8 0 000-2l2.1-1.6-2-3.4-2.5 1a7.3 7.3 0 00-1.7-1l-.4-2.7h-4l-.4 2.7a7.3 7.3 0 00-1.7 1l-2.5-1-2 3.4L4.6 11a7.8 7.8 0 000 2l-2.1 1.6 2 3.4 2.5-1a7.3 7.3 0 001.7 1l.4 2.7h4l.4-2.7a7.3 7.3 0 001.7-1l2.5 1 2-3.4L19.4 13zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>'
    };

    /** 侧边栏导航配置（admin=true 仅管理员可见） */
    var NAV = [
        { path: '/', label: '首页', icon: ICONS.home },
        { path: '/practice-select', label: '练习', icon: ICONS.practice },
        { path: '/wrong-questions', label: '错题本', icon: ICONS.wrong },
        { path: '/profile', label: '我的', icon: ICONS.me },
        { path: '/manage', label: '管理后台', icon: ICONS.admin, admin: true }
    ];

    /** 注入页面骨架（侧边栏 + 顶栏 + 内容区 + 模态框 + Toast 容器） */
    function renderShell() {
        var root = document.getElementById('root');
        if (!root) return;
        root.innerHTML =
            '<div class="main-container">' +
                '<aside class="sidebar">' +
                    '<div class="sidebar-header"><span class="sidebar-logo" title="综合答题"><img src="/assets/home/quiz.png?v=2" alt="综合答题"></span></div>' +
                    '<nav class="sidebar-nav" id="qz-nav"></nav>' +
                '</aside>' +
                '<div class="main-content">' +
                    '<header class="topbar">' +
                        '<div class="topbar-left" id="qz-topbar-left"></div>' +
                        '<div class="topbar-right">' +
                            '<div class="topbar-actions" id="qz-actions"></div>' +
                            '<div class="user-info" id="qz-user"></div>' +
                        '</div>' +
                    '</header>' +
                    '<main class="content-area qz-content"><div id="qz-view"></div></main>' +
                '</div>' +
            '</div>' +
            '<div class="qz-modal-root" id="qz-modal-root"></div>' +
            '<div class="qz-toast-box" id="qz-toast"></div>';

        renderNav();
    }

    /** 渲染侧边栏导航（管理员项按 ME 显隐） */
    function renderNav() {
        var nav = document.getElementById('qz-nav');
        if (!nav) return;
        nav.innerHTML = '';
        NAV.forEach(function (item) {
            if (item.admin && !(ME && ME.isAdmin)) return;
            var active = isNavActive(item.path);
            var a = document.createElement('a');
            a.className = 'nav-item' + (active ? ' active' : '');
            a.href = BASE + (item.path === '/' ? '' : item.path);
            a.title = item.label;
            a.innerHTML = item.icon;
            a.addEventListener('click', function (e) {
                e.preventDefault();
                go(item.path);
            });
            nav.appendChild(a);
        });
    }

    /**
     * 判断导航是否高亮
     * @param {string} path 导航路径
     * @returns {boolean}
     */
    function isNavActive(path) {
        if (path === '/') return CURRENT === '/';
        if (path === '/manage') return CURRENT.indexOf('/manage') === 0 || CURRENT.indexOf('/practice-manage') === 0 || CURRENT.indexOf('/admin') === 0;
        if (path === '/practice-select') return CURRENT.indexOf('/practice') === 0;
        return CURRENT === path;
    }

    /** 渲染顶栏用户区（头像 + 姓名，点击进入我的页面） */
    function renderUser() {
        var box = document.getElementById('qz-user');
        if (!box || !ME) return;
        box.innerHTML =
            '<div class="user-avatar" title="' + esc(ME.name) + '">' +
                '<img src="' + esc(ME.avatar || '/assets/home/default-avatar.png') + '" alt="头像">' +
            '</div>' +
            '<span class="user-name">' + esc(ME.name) + '</span>';
        box.style.cursor = 'pointer';
        box.onclick = function () { go('/profile'); };
    }

    /** 设置顶栏左侧返回按钮 */
    function setBack(target) {
        var box = document.getElementById('qz-topbar-left');
        if (!box) return;
        box.innerHTML = '';
        if (!target) return;
        var btn = document.createElement('button');
        btn.className = 'qz-back';
        btn.title = '返回';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>';
        btn.addEventListener('click', function () { go(target); });
        box.appendChild(btn);
    }

    /* ==================== 路由 ==================== */

    /**
     * 应用内跳转（History API，不整页刷新）
     * @param {string} path 应用内路径，如 '/practice-select'
     * @param {boolean} [push=true] 是否压入历史栈
     */
    function go(path, push) {
        var target = BASE + (path === '/' ? '' : path);
        if (push !== false) history.pushState({}, '', target);
        renderRoute();
    }

    /**
     * 从当前地址解析应用内路径与查询参数
     * @returns {{path: string, query: object}}
     */
    function parseLocation() {
        var url = new URL(window.location.href);
        var path = url.pathname.replace(/\/+$/, '');
        if (path.indexOf(BASE) === 0) path = path.slice(BASE.length) || '/';
        var query = {};
        url.searchParams.forEach(function (v, k) { query[k] = v; });
        return { path: path, query: query };
    }

    /** 路由分发：按路径渲染对应页面 */
    function renderRoute() {
        var loc = parseLocation();
        CURRENT = loc.path;
        var p = loc.path;
        var q = loc.query;
        var box = view();
        if (!box) return;
        box.innerHTML = '<div class="qz-empty">加载中…</div>';
        setBack(null);
        renderNav();

        // 页面级返回按钮
        var backMap = {
            '/practice-select': '/',
            '/profile': '/',
            '/wrong-questions': '/',
            '/practice-records': '/practice-select',
            '/manage': '/',
            '/settings-manage': '/manage',
            '/practice-manage': '/manage',
            '/practice-manage/records': '/practice-manage',
            '/practice-manage/subjects': '/practice-manage',
            '/practice-manage/units': '/practice-manage',
            '/practice-manage/lessons': '/practice-manage',
            '/practice-manage/questions': '/practice-manage',
            '/admin/users': '/settings-manage',
            '/manage/sound-settings': '/settings-manage'
        };
        if (backMap[p]) setBack(backMap[p]);

        if (p === '/') return viewHome();
        if (p === '/practice-select') return viewPracticeSelect();
        if (/^\/practice\/[^/]+\/path$/.test(p)) return viewLessonPath(p.split('/')[2]);
        if (/^\/practice\/[^/]+\/banks$/.test(p)) return viewQuickPractice(p.split('/')[2]);
        if (/^\/practice\/[^/]+\/lesson\/[^/]+$/.test(p)) return viewPracticeExam({ subjectId: p.split('/')[2], lessonId: p.split('/')[4], query: q });
        if (/^\/practice\/[^/]+\/exam$/.test(p)) return viewPracticeExam({ subjectId: p.split('/')[2], lessonId: null, query: q });
        if (p === '/practice/complete') { setBack('/practice-select'); return viewPracticeComplete(); }
        if (p === '/practice-records') return viewPracticeRecords(q);
        if (p === '/wrong-questions') return viewWrong();
        if (p === '/wrong-questions/practice') { setBack('/wrong-questions'); return viewWrongPractice(); }
        if (p === '/wrong-questions/complete') { setBack('/wrong-questions'); return viewWrongComplete(); }
        if (p === '/profile') return viewProfile();
        if (p === '/manage') { setBack('/'); return viewManageHub(); }
        if (p === '/settings-manage') { setBack('/manage'); return viewSettingsHub(); }
        if (p === '/manage/sound-settings') return viewSoundSettings();
        if (p === '/practice-manage') return viewPracticeManageHub();
        if (p === '/practice-manage/subjects') return viewSubjectManage();
        if (p === '/practice-manage/units') return viewUnitManage();
        if (p === '/practice-manage/lessons') return viewLessonManage();
        if (p === '/practice-manage/questions') return viewPracticeQuestionManage(q);
        if (p === '/practice-manage/records') return viewPracticeRecords(Object.assign({ all: '1' }, q));
        if (p === '/admin/users') return viewUserManage();
        box.innerHTML = '<div class="qz-empty">页面不存在</div>';
    }

    /* ==================== 通用 UI 组件 ==================== */

    /**
     * 打开模态框
     * @param {object} opts { title, body(HTMLElement|string), width, onOk(text), okText, cancelText, hideFooter }
     * @returns {{el: HTMLElement, close: Function, body: HTMLElement}}
     */
    function openModal(opts) {
        var root = document.getElementById('qz-modal-root');
        var mask = document.createElement('div');
        mask.className = 'qz-modal-mask';
        var modal = document.createElement('div');
        modal.className = 'qz-modal';
        if (opts.width) modal.style.maxWidth = opts.width;
        var head = document.createElement('div');
        head.className = 'qz-modal-head';
        head.innerHTML = '<h3>' + esc(opts.title || '') + '</h3>';
        var closeBtn = document.createElement('button');
        closeBtn.className = 'qz-modal-close';
        closeBtn.innerHTML = '×';
        closeBtn.title = '关闭';
        head.appendChild(closeBtn);
        var body = document.createElement('div');
        body.className = 'qz-modal-body';
        if (typeof opts.body === 'string') body.innerHTML = opts.body;
        else if (opts.body) body.appendChild(opts.body);
        modal.appendChild(head);
        modal.appendChild(body);

        function close() { mask.remove(); }

        if (!opts.hideFooter) {
            var foot = document.createElement('div');
            foot.className = 'qz-modal-foot';
            var cancel = document.createElement('button');
            cancel.className = 'qz-btn secondary';
            cancel.textContent = opts.cancelText || '取消';
            cancel.addEventListener('click', close);
            var ok = document.createElement('button');
            ok.className = 'qz-btn primary';
            ok.textContent = opts.okText || '保存';
            ok.addEventListener('click', function () {
                if (typeof opts.onOk === 'function') {
                    var keep = opts.onOk(function (msg, type) { toast(msg, type); });
                    if (keep === false) return;                 // 校验失败不关闭
                }
                close();
            });
            foot.appendChild(cancel);
            foot.appendChild(ok);
            modal.appendChild(foot);
        }
        mask.appendChild(modal);
        root.appendChild(mask);
        closeBtn.addEventListener('click', close);
        return { el: modal, body: body, close: close };
    }

    /**
     * 二次确认
     * @param {string} message 提示文案
     * @param {Function} onOk 确认回调
     * @param {string} [okText='删除'] 确认按钮文字
     */
    function confirmDialog(message, onOk, okText) {
        openModal({
            title: '请确认',
            body: '<p class="qz-confirm-text">' + esc(message) + '</p>',
            okText: okText || '删除',
            onOk: function () { onOk(); }
        });
    }

    /**
     * 生成表单字段 HTML
     * @param {Array} fields 字段配置 { key,label,type,options,placeholder,value }
     * @returns {string}
     */
    function fieldHtml(fields) {
        return fields.map(function (f) {
            var val = f.value == null ? '' : f.value;
            var input;
            if (f.type === 'textarea') {
                input = '<textarea class="qz-textarea" data-k="' + esc(f.key) + '" rows="' + (f.rows || 3) + '" placeholder="' + esc(f.placeholder || '') + '">' + esc(val) + '</textarea>';
            } else if (f.type === 'select') {
                input = '<select class="qz-select" data-k="' + esc(f.key) + '">' + (f.options || []).map(function (o) {
                    return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(val) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
                }).join('') + '</select>';
            } else if (f.type === 'checkbox') {
                return '<label class="qz-field qz-check"><input type="checkbox" data-k="' + esc(f.key) + '"' + (val ? ' checked' : '') + '> <span>' + esc(f.label) + '</span></label>';
            } else {
                input = '<input class="qz-input" data-k="' + esc(f.key) + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder || '') + '">';
            }
            return '<label class="qz-field"><span>' + esc(f.label) + '</span>' + input + '</label>';
        }).join('');
    }

    /**
     * 从模态框读取字段值
     * @param {HTMLElement} body 模态框正文
     * @returns {object} 键值对象
     */
    function readFields(body) {
        var out = {};
        body.querySelectorAll('[data-k]').forEach(function (el) {
            var k = el.getAttribute('data-k');
            out[k] = el.type === 'checkbox' ? el.checked : el.value;
        });
        return out;
    }

    /**
     * 通用表格
     * @param {string[]} heads 表头
     * @param {Array<Array<string>>} rows 行（单元格为 HTML 字符串）
     * @param {string} [empty] 空状态文案
     * @returns {string}
     */
    function table(heads, rows, empty) {
        if (!rows.length) return '<div class="qz-empty">' + esc(empty || '暂无数据') + '</div>';
        return '<div class="qz-table-wrap"><table class="qz-table"><thead><tr>' +
            heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
            '</tr></thead><tbody>' +
            rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }

    /** 页面标题块 */
    function pageHead(title, sub, actionsHtml) {
        return '<div class="qz-page-head"><div><h1 class="qz-title">' + esc(title) + '</h1>' +
            (sub ? '<p class="qz-sub">' + esc(sub) + '</p>' : '') + '</div>' +
            '<div class="qz-head-actions">' + (actionsHtml || '') + '</div></div>';
    }

    /** 空状态 */
    function emptyBox(text, actionHtml) {
        return '<div class="qz-empty"><div>' + esc(text) + '</div>' + (actionHtml ? '<div class="qz-empty-action">' + actionHtml + '</div>' : '') + '</div>';
    }

    /**
     * 评分圆环（SVG）
     * @param {number} rate 正确率 0-100
     * @param {number} size 尺寸
     * @returns {string}
     */
    function scoreRing(rate, size) {
        var r = (size || 120) / 2 - 8;
        var c = 2 * Math.PI * r;
        var v = Math.max(0, Math.min(100, Number(rate) || 0));
        return '<div class="qz-ring" style="width:' + size + 'px;height:' + size + 'px">' +
            '<svg viewBox="0 0 ' + size + ' ' + size + '">' +
                '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="qz-ring-bg"/>' +
                '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="qz-ring-fg" ' +
                    'stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - v / 100)) + '"/>' +
            '</svg>' +
            '<div class="qz-ring-text"><b>' + v.toFixed(0) + '</b><span>%</span></div></div>';
    }

    /* ==================== 答题控件 ==================== */

    /**
     * 构建答题输入控件
     * @param {object} q 题目
     * @param {*} initial 初始答案
     * @param {Function} onChange 值变化回调（参数为新答案）
     * @param {object} [opts] { disabled, showAudio, submitOnEnter }
     * @returns {HTMLElement}
     */
    function buildAnswerInput(q, initial, onChange, opts) {
        opts = opts || {};
        var box = document.createElement('div');
        box.className = 'qz-answer';
        var value = initial;

        /** 触发变更 */
        function emit(v) { value = v; onChange(v); }

        if (q.type === 'single_choice') {
            var options = parseOptions(q);
            options.forEach(function (o) {
                var row = document.createElement('div');
                row.className = 'qz-option' + (value === o.text ? ' selected' : '');
                row.innerHTML = '<span class="qz-option-dot"></span><span class="qz-option-text">' + esc(o.text) + '</span>';
                if (o.image) row.innerHTML += '<img class="qz-option-img" src="' + esc(o.image) + '" alt="">';
                if (o.audio) {
                    var play = document.createElement('button');
                    play.className = 'qz-audio-btn';
                    play.type = 'button';
                    play.textContent = '🔊';
                    play.title = '播放读音';
                    play.addEventListener('click', function (e) {
                        e.stopPropagation();
                        new Audio(o.audio).play().catch(function () { toast('音频播放失败', 'error'); });
                    });
                    row.appendChild(play);
                }
                row.addEventListener('click', function () {
                    if (opts.disabled) return;
                    box.querySelectorAll('.qz-option').forEach(function (x) { x.classList.remove('selected'); });
                    row.classList.add('selected');
                    emit(o.text);
                });
                box.appendChild(row);
            });
        } else if (q.type === 'multiple_choice') {
            var selected = Array.isArray(value) ? value.slice() : [];
            parseOptions(q).forEach(function (o) {
                var row = document.createElement('div');
                row.className = 'qz-option' + (selected.indexOf(o.text) >= 0 ? ' selected' : '');
                row.innerHTML = '<span class="qz-option-check"></span><span class="qz-option-text">' + esc(o.text) + '</span>';
                if (o.image) row.innerHTML += '<img class="qz-option-img" src="' + esc(o.image) + '" alt="">';
                row.addEventListener('click', function () {
                    if (opts.disabled) return;
                    var i = selected.indexOf(o.text);
                    if (i >= 0) selected.splice(i, 1); else selected.push(o.text);
                    row.classList.toggle('selected');
                    emit(selected.slice());
                });
                box.appendChild(row);
            });
        } else if (q.type === 'fill_blank') {
            var input = document.createElement('input');
            input.className = 'qz-input qz-fill-input';
            input.placeholder = '请输入答案';
            input.value = value == null ? '' : value;
            input.disabled = !!opts.disabled;
            input.addEventListener('input', function () { emit(input.value); });
            box.appendChild(input);
        } else if (q.type === 'matching') {
            var pairs = (value && typeof value === 'object' && !Array.isArray(value)) ? Object.assign({}, value) : {};
            var m = parseMatching(q);
            var selectedLeft = null;                       // 当前选中的左侧项
            var wrap = document.createElement('div');
            wrap.className = 'qz-matching';
            var leftCol = document.createElement('div');
            leftCol.className = 'qz-match-col';
            var rightCol = document.createElement('div');
            rightCol.className = 'qz-match-col';
            var hint = document.createElement('div');
            hint.className = 'qz-match-hint';
            hint.textContent = '先点左侧项，再点右侧项即可连线';

            /** 重绘连线状态 */
            function paint() {
                leftCol.innerHTML = '<div class="qz-match-col-title">左侧</div>';
                rightCol.innerHTML = '<div class="qz-match-col-title">右侧</div>';
                m.left.forEach(function (text) {
                    var item = document.createElement('div');
                    item.className = 'qz-match-item' + (selectedLeft === text ? ' selected' : '') + (pairs[text] ? ' paired' : '');
                    item.innerHTML = '<span>' + esc(text) + '</span>' + (pairs[text] ? '<em>' + esc(pairs[text]) + '</em>' : '');
                    item.addEventListener('click', function () {
                        if (opts.disabled) return;
                        if (pairs[text]) { delete pairs[text]; emit(Object.assign({}, pairs)); paint(); return; }
                        selectedLeft = selectedLeft === text ? null : text;
                        paint();
                    });
                    leftCol.appendChild(item);
                });
                m.right.forEach(function (text) {
                    var usedBy = Object.keys(pairs).find(function (k) { return pairs[k] === text; });
                    var item = document.createElement('div');
                    item.className = 'qz-match-item' + (usedBy ? ' paired' : '');
                    item.textContent = text;
                    item.addEventListener('click', function () {
                        if (opts.disabled) return;
                        if (!selectedLeft) { toast('请先选择左侧项目', 'info'); return; }
                        // 一个右侧项只能被一个左侧项使用
                        Object.keys(pairs).forEach(function (k) { if (pairs[k] === text) delete pairs[k]; });
                        pairs[selectedLeft] = text;
                        selectedLeft = null;
                        emit(Object.assign({}, pairs));
                        paint();
                    });
                    rightCol.appendChild(item);
                });
            }
            paint();
            wrap.appendChild(leftCol);
            wrap.appendChild(rightCol);
            box.appendChild(hint);
            box.appendChild(wrap);
            var tip = document.createElement('div');
            tip.className = 'qz-match-hint';
            tip.textContent = '再次点击左侧已连线的项目可取消连线';
            box.appendChild(tip);
        } else if (q.type === 'sentence_order') {
            var pool = Array.isArray(q.options) ? q.options.slice() : [];
            var answer = Array.isArray(value) ? value.slice() : [];
            var poolBox = document.createElement('div');
            poolBox.className = 'qz-order-pool';
            var ansBox = document.createElement('div');
            ansBox.className = 'qz-order-answer';
            var paintOrder = function () {
                poolBox.innerHTML = '<div class="qz-order-title">待选词语</div>';
                ansBox.innerHTML = '<div class="qz-order-title">已选顺序（点击可移除）</div>';
                pool.forEach(function (w, i) {
                    if (answer.indexOf(w) >= 0) return;
                    var chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'qz-chip';
                    chip.textContent = w;
                    chip.addEventListener('click', function () {
                        if (opts.disabled) return;
                        answer.push(w);
                        emit(answer.slice());
                        paintOrder();
                    });
                    poolBox.appendChild(chip);
                });
                answer.forEach(function (w, i) {
                    var chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'qz-chip active';
                    chip.textContent = (i + 1) + '. ' + w;
                    chip.addEventListener('click', function () {
                        if (opts.disabled) return;
                        answer.splice(i, 1);
                        emit(answer.slice());
                        paintOrder();
                    });
                    ansBox.appendChild(chip);
                });
                if (!poolBox.querySelector('.qz-chip')) poolBox.innerHTML += '<span class="qz-dim">已全部选完</span>';
                if (!ansBox.querySelector('.qz-chip')) ansBox.innerHTML += '<span class="qz-dim">请点击上方词语</span>';
            };
            paintOrder();
            box.appendChild(poolBox);
            box.appendChild(ansBox);
        } else if (q.type === 'drawing') {
            var canvas = document.createElement('canvas');
            canvas.className = 'qz-canvas';
            canvas.width = 900;
            canvas.height = 520;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#1f2937';
            var drawing = false;
            var last = null;

            /** 取画布坐标（考虑 CSS 缩放） */
            function pos(e) {
                var r = canvas.getBoundingClientRect();
                return {
                    x: (e.clientX - r.left) * (canvas.width / r.width),
                    y: (e.clientY - r.top) * (canvas.height / r.height)
                };
            }
            canvas.addEventListener('pointerdown', function (e) {
                if (opts.disabled) return;
                drawing = true;
                last = pos(e);
                canvas.setPointerCapture(e.pointerId);
            });
            canvas.addEventListener('pointermove', function (e) {
                if (!drawing || opts.disabled) return;
                var p = pos(e);
                ctx.beginPath();
                ctx.moveTo(last.x, last.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                last = p;
            });
            canvas.addEventListener('pointerup', function () {
                drawing = false;
                emit(canvas.toDataURL('image/png'));
            });
            canvas.addEventListener('pointerleave', function () { drawing = false; });

            var tools = document.createElement('div');
            tools.className = 'qz-canvas-tools';
            var clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'qz-btn ghost';
            clear.textContent = '清空画板';
            clear.addEventListener('click', function () {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                emit(null);
            });
            tools.appendChild(clear);
            box.appendChild(canvas);
            box.appendChild(tools);
            // 允许老师/学生上传已画好的图片作为答案
            var upload = document.createElement('label');
            upload.className = 'qz-upload-inline';
            upload.innerHTML = '<span>或上传图片作答</span><input type="file" accept="image/*">';
            upload.querySelector('input').addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                    var img = new Image();
                    img.onload = function () { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); emit(canvas.toDataURL('image/png')); };
                    img.src = reader.result;
                };
                reader.readAsDataURL(file);
            });
            box.appendChild(upload);
        }
        return box;
    }

    /**
     * 播放提示音
     * @param {string} url 音频地址
     */
    function playSound(url) {
        if (!url) return;
        try { new Audio(url).play().catch(function () { }); } catch (_) { /* 忽略 */ }
    }

    /**
     * 读取提示音设置（答题页用）
     * @returns {Promise<object>}
     */
    function loadSounds() {
        return api('/sound-settings').catch(function () { return {}; });
    }

    /* ==================== 首页 ==================== */

    /** 首页：欢迎语 + 练习数据 + 功能入口 */
    function viewHome() {
        var box = view();
        Promise.all([
            api('/practice-sessions').catch(function () { return []; }),
            api('/wrong-questions').catch(function () { return []; }),
            api('/subjects').catch(function () { return []; })
        ]).then(function (res) {
            var sessions = res[0] || [];                 // 当前用户的练习会话记录
            var wrongs = res[1] || [];                   // 当前用户的错题列表
            var subjects = res[2] || [];                 // 启用的练习科目
            var correctTotal = sessions.reduce(function (s, x) { return s + Number(x.correct_count || 0); }, 0);
            var questionTotal = sessions.reduce(function (s, x) { return s + Number(x.total_questions || 0); }, 0);
            var practiceRate = questionTotal ? (correctTotal / questionTotal) * 100 : 0;

            box.innerHTML =
                '<section class="qz-hero">' +
                    '<div><p class="qz-hero-hi">你好，' + esc(ME ? ME.name : '同学') + '</p>' +
                    '<h1>今天也要认真学习哦</h1>' +
                    '<p class="qz-hero-desc">闯关练习、快速刷题、错题回顾，一站式搞定。</p>' +
                    '<div class="qz-hero-actions">' +
                        '<button class="qz-btn primary" id="hero-practice">去练习</button>' +
                    '</div></div>' +
                    '<div class="qz-hero-ring">' + scoreRing(practiceRate, 132) + '<span>练习正确率</span></div>' +
                '</section>' +
                '<section class="qz-stats">' +
                    '<div class="qz-stat"><b>' + sessions.length + '</b><span>练习次数</span></div>' +
                    '<div class="qz-stat"><b>' + practiceRate.toFixed(1) + '%</b><span>练习正确率</span></div>' +
                    '<div class="qz-stat warn"><b>' + wrongs.length + '</b><span>错题数量</span></div>' +
                    '<div class="qz-stat"><b>' + subjects.length + '</b><span>练习科目</span></div>' +
                '</section>' +
                '<section class="qz-grid two">' +
                    '<div class="qz-card"><div class="qz-card-h"><h3>最近练习</h3><button class="qz-link" id="go-records">记录</button></div>' +
                        '<div class="qz-card-b"><div class="qz-quick-list">' + (sessions.slice(0, 3).map(function (s) {
                            return '<div class="qz-quick-row"><span>' + esc(s.subject_name || '练习') + (s.lesson_name ? ' · ' + esc(s.lesson_name) : '') + '</span><em>' + Number(s.correct_rate || 0).toFixed(0) + '%</em></div>';
                        }).join('') || '<div class="qz-dim">还没有练习记录</div>') + '</div></div></div>' +
                    '<div class="qz-card clickable" id="card-wrong"><div class="qz-card-h"><h3>错题本</h3><span class="qz-badge">' + wrongs.length + '</span></div>' +
                        '<div class="qz-card-b"><p class="qz-dim">把做错的题目集中复习，答对后自动移除。</p></div></div>' +
                    '<div class="qz-card clickable" id="card-practice"><div class="qz-card-h"><h3>练习中心</h3></div>' +
                        '<div class="qz-card-b"><p class="qz-dim">按学习路径闯关，或选择课程快速练习。</p></div></div>' +
                    '<div class="qz-card clickable" id="card-profile"><div class="qz-card-h"><h3>我的</h3></div>' +
                        '<div class="qz-card-b"><p class="qz-dim">查看练习数据，了解学习进度。</p></div></div>' +
                '</section>' +
                (ME && ME.isAdmin ? '<section class="qz-card"><div class="qz-card-h"><h3>管理员入口</h3></div><div class="qz-card-b qz-admin-links">' +
                    '<button class="qz-btn secondary" data-go="/practice-manage/subjects">练习管理</button>' +
                    '<button class="qz-btn secondary" data-go="/manage/sound-settings">提示音设置</button>' +
                    '<button class="qz-btn secondary" data-go="/admin/users">用户管理</button>' +
                '</div></section>' : '');

            document.getElementById('hero-practice').onclick = function () { go('/practice-select'); };
            document.getElementById('go-records').onclick = function () { go('/practice-records'); };
            document.getElementById('card-wrong').onclick = function () { go('/wrong-questions'); };
            document.getElementById('card-practice').onclick = function () { go('/practice-select'); };
            document.getElementById('card-profile').onclick = function () { go('/profile'); };
            box.querySelectorAll('[data-go]').forEach(function (b) {
                b.addEventListener('click', function () { go(b.getAttribute('data-go')); });
            });
        });
    }

    /* ==================== 练习 ==================== */

    /**
     * 前端判分（与后端一致，用于练习即时反馈）
     * @param {object} q 题目
     * @param {*} ans 用户答案
     * @returns {boolean}
     */
    function judgeAnswer(q, ans) {
        var norm = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
        var correct = q.correct_answer;
        if (q.type === 'drawing') return false;
        if (ans === undefined || ans === null || ans === '') return false;
        if (q.type === 'multiple_choice') {
            var a = Array.isArray(ans) ? ans.map(norm).sort() : [norm(ans)];
            var b = Array.isArray(correct) ? correct.map(norm).sort() : [];
            return a.length === b.length && a.every(function (v, i) { return v === b[i]; });
        }
        if (q.type === 'sentence_order') {
            var x = Array.isArray(ans) ? ans.map(norm) : String(ans).split(',').map(norm).filter(Boolean);
            var y = Array.isArray(correct) ? correct.map(norm) : [];
            return x.length === y.length && x.every(function (v, i) { return v === y[i]; });
        }
        if (q.type === 'matching') {
            var ua = ans;
            if (typeof ua === 'string') { try { ua = JSON.parse(ua); } catch (_) { return false; } }
            if (!ua || typeof ua !== 'object') return false;
            var keys = Object.keys(correct || {});
            if (Object.keys(ua).length !== keys.length) return false;
            return keys.every(function (k) {
                var uk = Object.keys(ua).find(function (z) { return norm(z) === norm(k); });
                return uk !== undefined && norm(ua[uk]) === norm(correct[k]);
            });
        }
        return norm(ans) === norm(correct);
    }

    /** 练习科目选择 */
    function viewPracticeSelect() {
        var box = view();
        Promise.all([api('/subjects'), api('/practice-questions')]).then(function (res) {
            var subjects = (res[0] || []).filter(function (s) { return s.is_active !== false; });
            var questions = res[1] || [];
            box.innerHTML = pageHead('练习中心', '按学习路径闯关，或选择快速练习') +
                '<div class="qz-subject-grid">' + subjects.map(function (s) {
                    var count = questions.filter(function (q) { return q.subject_id === s.id; }).length;
                    return '<div class="qz-card qz-subject-card"><div class="qz-card-b">' +
                        '<div class="qz-subject-icon">' + esc(s.icon || '📘') + '</div>' +
                        '<h3>' + esc(s.name) + '</h3>' +
                        '<p class="qz-dim">' + esc(s.description || '') + '</p>' +
                        '<p class="qz-dim">共 ' + count + ' 道练习题</p>' +
                        '<div class="qz-subject-actions">' +
                            '<button class="qz-btn primary" data-path="' + esc(s.id) + '"' + (count ? '' : ' disabled') + '>学习路径</button>' +
                            '<button class="qz-btn secondary" data-quick="' + esc(s.id) + '"' + (count ? '' : ' disabled') + '>快速练习</button>' +
                        '</div>' +
                    '</div></div>';
                }).join('') + '</div>' +
                (subjects.length ? '' : emptyBox('暂无科目，请联系管理员添加'));

            box.querySelectorAll('[data-path]').forEach(function (b) {
                b.addEventListener('click', function () { go('/practice/' + b.getAttribute('data-path') + '/path'); });
            });
            box.querySelectorAll('[data-quick]').forEach(function (b) {
                b.addEventListener('click', function () { go('/practice/' + b.getAttribute('data-quick') + '/banks'); });
            });
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /**
     * 学习路径（单元 → 课程，多邻国式闯关）
     * @param {string} subjectId 科目 id
     */
    function viewLessonPath(subjectId) {
        var box = view();
        setBack('/practice-select');
        Promise.all([
            api('/subjects'),
            api('/units?subjectId=' + encodeURIComponent(subjectId)),
            api('/lessons'),
            api('/practice-sessions/completed-lessons?subjectId=' + encodeURIComponent(subjectId))
        ]).then(function (res) {
            var subject = (res[0] || []).find(function (s) { return s.id === subjectId; });
            var units = res[1] || [];
            var lessons = res[2] || [];
            var completed = res[3] || [];
            if (!subject) { box.innerHTML = emptyBox('科目不存在'); return; }
            if (!units.length) { box.innerHTML = pageHead(subject.name, '') + emptyBox('该科目暂无课程，请联系管理员添加'); return; }

            var html = pageHead(subject.icon + ' ' + subject.name, '完成前一个课程后解锁下一个课程（正确率 ≥ 60% 视为完成）');
            units.forEach(function (unit) {
                var unitLessons = lessons.filter(function (l) { return l.unit_id === unit.id; });
                if (!unitLessons.length) return;
                html += '<section class="qz-unit"><div class="qz-unit-head"><h3>' + esc(unit.name) + '</h3>' +
                    (unit.description ? '<p class="qz-dim">' + esc(unit.description) + '</p>' : '') + '</div>' +
                    '<div class="qz-path">';
                unitLessons.forEach(function (l, i) {
                    var done = completed.indexOf(l.id) >= 0;
                    var prevDone = i === 0 || completed.indexOf(unitLessons[i - 1].id) >= 0;
                    var locked = !prevDone;
                    var icon = l.icon === 'trophy' ? '🏆' : l.icon === 'dumbbell' ? '🏋️' : '⭐';
                    html += '<div class="qz-path-node ' + (done ? 'done' : locked ? 'locked' : 'open') + '">' +
                        '<div class="qz-path-dot">' + (locked ? '🔒' : done ? '✅' : icon) + '</div>' +
                        '<div class="qz-path-card"><h4>' + esc(l.name) + '</h4>' +
                            (l.description ? '<p class="qz-dim">' + esc(l.description) + '</p>' : '') +
                            '<button class="qz-btn ' + (locked ? 'secondary' : 'primary') + ' block" data-lesson="' + esc(l.id) + '"' + (locked ? ' disabled' : '') + '>' +
                                (locked ? '未解锁' : done ? '重新练习' : '开始练习') + '</button>' +
                        '</div></div>';
                });
                html += '</div></section>';
            });
            box.innerHTML = html;
            box.querySelectorAll('[data-lesson]').forEach(function (b) {
                b.addEventListener('click', function () {
                    go('/practice/' + subjectId + '/lesson/' + b.getAttribute('data-lesson'));
                });
            });
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /**
     * 快速练习：把科目题目每 5 题分一组，逐组解锁
     * @param {string} subjectId 科目 id
     */
    function viewQuickPractice(subjectId) {
        var box = view();
        setBack('/practice-select');
        Promise.all([
            api('/subjects'),
            api('/practice-questions?subjectId=' + encodeURIComponent(subjectId)),
            api('/practice-records?subjectId=' + encodeURIComponent(subjectId))
        ]).then(function (res) {
            var subject = (res[0] || []).find(function (s) { return s.id === subjectId; });
            var questions = res[1] || [];
            var records = res[2] || [];
            if (!subject) { box.innerHTML = emptyBox('科目不存在'); return; }
            if (!questions.length) { box.innerHTML = pageHead(subject.name, '') + emptyBox('该科目暂无练习题'); return; }

            var size = 5;
            var groups = [];
            for (var i = 0; i < questions.length; i += size) {
                var qs = questions.slice(i, i + size);
                var doneAll = qs.every(function (q) {
                    return records.some(function (r) { return r.question_id === q.id && r.is_correct; });
                });
                groups.push({ no: groups.length + 1, questions: qs, done: doneAll });
            }

            box.innerHTML = pageHead(subject.icon + ' ' + subject.name, '每 5 题为一组，答对全部题目即完成本组') +
                '<div class="qz-group-list">' + groups.map(function (g, i) {
                    var locked = i > 0 && !groups[i - 1].done;
                    return '<div class="qz-card qz-group-card ' + (g.done ? 'done' : locked ? 'locked' : '') + '"><div class="qz-card-b qz-flex-between">' +
                        '<div class="qz-group-info"><div class="qz-group-icon">' + (locked ? '🔒' : g.done ? '✅' : '📝') + '</div>' +
                            '<div><h3>第 ' + g.no + ' 组</h3><p class="qz-dim">' + g.questions.length + ' 道题' + (g.done ? ' · 已完成' : '') + '</p></div></div>' +
                        '<button class="qz-btn ' + (locked ? 'secondary' : 'primary') + '" data-group="' + i + '"' + (locked ? ' disabled' : '') + '>' +
                            (locked ? '未解锁' : g.done ? '重新练习' : '开始') + '</button>' +
                    '</div></div>';
                }).join('') + '</div>';

            box.querySelectorAll('[data-group]').forEach(function (b) {
                b.addEventListener('click', function () {
                    var g = groups[Number(b.getAttribute('data-group'))];
                    var ids = g.questions.map(function (q) { return q.id; }).join(',');
                    go('/practice/' + subjectId + '/exam?questions=' + encodeURIComponent(ids));
                });
            });
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /* ==================== 答题页整页骨架（Figma 290_96） ==================== */

    /** 答题页图标：退出 X（设计稿 18×18，灰色描边） */
    var ICON_EXAM_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
    /** 答题页图标：剩余生命红心（设计稿 33×32，颜色由 CSS currentColor 控制） */
    var ICON_EXAM_HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.7-9.4-9C1.3 8.5 3 5 6.4 5c2 0 3.4 1.1 4.3 2.3l1.3 1.7 1.3-1.7C14.2 6.1 15.6 5 17.6 5 21 5 22.7 8.5 21.4 12c-1.9 4.3-9.4 9-9.4 9z"/></svg>';

    /**
     * 判断答案是否为空（未作答）
     * @param {*} v 答案值
     * @returns {boolean} true 表示尚未作答
     */
    function isAnswerEmpty(v) {
        return v === undefined || v === null || v === '' ||
            (Array.isArray(v) && !v.length) ||
            (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    }

    /**
     * 构建答题页整页骨架（进度行 + 题干 + 作答区 + 底部操作条）
     * @param {object} o 配置对象
     * @param {number} o.percent 进度百分比（0~100）
     * @param {number} o.remain 剩余题数（显示在红心右侧）
     * @param {string} o.content 题干 HTML（已转义，可含 <br>）
     * @param {string} [o.extra] 题干下方的附加内容（图片/音频 HTML）
     * @param {string} [o.feedback] 检查后的反馈 HTML
     * @param {boolean} o.checked 是否已检查答案
     * @param {boolean} o.last 是否为最后一题
     * @returns {string} 页面 HTML
     */
    function examShell(o) {
        return '<div class="qz-exam">' +
            '<div class="qz-exam-progress">' +
                '<button class="qz-exam-close" id="exam-close" type="button" title="退出练习">' + ICON_EXAM_CLOSE + '</button>' +
                '<div class="qz-exam-track"><i style="width:' + o.percent + '%"></i></div>' +
                '<span class="qz-exam-heart">' + ICON_EXAM_HEART + '</span>' +
                '<span class="qz-exam-remain">' + o.remain + '</span>' +
            '</div>' +
            '<p class="qz-exam-q">' + o.content + '</p>' +
            (o.extra || '') +
            '<div class="qz-exam-answer" id="qz-answer-slot"></div>' +
            (o.feedback || '') +
            '<div class="qz-exam-bottom"><div class="qz-exam-actions">' +
                '<button class="qz-exam-skip" id="skip-btn" type="button">跳过</button>' +
                (o.checked
                    ? '<button class="qz-exam-primary" id="next-btn" type="button">' + (o.last ? '完成练习' : '下一题') + '</button>'
                    : '<button class="qz-exam-primary" id="check-btn" type="button" disabled>检查</button>') +
            '</div></div>' +
        '</div>';
    }

    /**
     * 挂载作答控件并同步「检查」按钮的可用状态
     * @param {object} q 题目
     * @param {*} initial 初始答案
     * @param {Function} onChange 答案变化回调
     * @param {boolean} disabled 是否已检查（禁止修改）
     * @returns {void}
     */
    function mountAnswer(q, initial, onChange, disabled) {
        var slot = document.getElementById('qz-answer-slot');
        if (!slot) return;
        slot.appendChild(buildAnswerInput(q, initial, function (v) {
            onChange(v);
            var btn = document.getElementById('check-btn');
            if (btn) btn.disabled = isAnswerEmpty(v);
        }, { disabled: disabled }));
        var checkBtn = document.getElementById('check-btn');
        if (checkBtn) checkBtn.disabled = isAnswerEmpty(initial);
    }

    /**
     * 练习答题页
     * @param {object} ctx { subjectId, lessonId, query }
     */
    function viewPracticeExam(ctx) {
        var box = view();
        var subjectId = ctx.subjectId;
        var lessonId = ctx.lessonId || null;
        var soundSettings = {};
        Promise.all([
            api('/subjects'),
            api('/practice-questions' + (lessonId ? '?lessonId=' + encodeURIComponent(lessonId) : '?subjectId=' + encodeURIComponent(subjectId))),
            api('/lessons'),
            loadSounds()
        ]).then(function (res) {
            var subject = (res[0] || []).find(function (s) { return s.id === subjectId; });
            var questions = res[1] || [];
            var lessons = res[2] || [];
            soundSettings = res[3] || {};
            // 指定题目 id（快速练习分组）
            if (ctx.query && ctx.query.questions) {
                var ids = decodeURIComponent(ctx.query.questions).split(',');
                questions = questions.filter(function (q) { return ids.indexOf(q.id) >= 0; })
                    .sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
            }
            var lesson = lessonId ? lessons.find(function (l) { return l.id === lessonId; }) : null;
            if (!questions.length) { box.innerHTML = emptyBox('暂无练习题'); return; }

            var idx = 0;                                  // 当前题下标
            var answers = {};                             // 题目 id → 用户答案
            var results = {};                             // 题目 id → 是否答对
            var startAll = Date.now();                    // 整组开始时间

            /**
             * 渲染当前题
             * @param {boolean} checked 是否已检查
             */
            function paint(checked) {
                var q = questions[idx];
                var result = results[q.id];
                // 题干下方的附加内容（图片 / 音频）
                var extra =
                    (q.image_url ? '<img class="qz-question-img" src="' + esc(q.image_url) + '" alt="题目图片">' : '') +
                    (q.audio_url ? '<audio class="qz-audio" controls src="' + esc(q.audio_url) + '"></audio>' : '');
                // 检查后的反馈卡片（占用底部操作条上方的留白区）
                var feedback = checked
                    ? '<div class="qz-exam-feedback"><div class="qz-feedback ' + (result ? 'ok' : 'bad') + '">' +
                        '<b>' + (result ? '回答正确！' : '回答错误') + '</b>' +
                        '<p>正确答案：' + esc(correctText(q)) + '</p>' +
                        (q.explanation ? '<p class="qz-dim">解析：' + esc(q.explanation) + '</p>' : '') +
                    '</div></div>'
                    : '';
                box.innerHTML = examShell({
                    percent: Math.round((idx + 1) / questions.length * 100),
                    remain: questions.length - idx,
                    content: esc(q.content).replace(/\n/g, '<br>'),
                    extra: extra,
                    feedback: feedback,
                    checked: checked,
                    last: idx === questions.length - 1
                });

                document.getElementById('exam-close').onclick = function () {
                    go(subjectId ? '/practice/' + subjectId + '/path' : '/practice-select');
                };
                document.getElementById('skip-btn').onclick = function () {
                    if (idx === questions.length - 1) finish();
                    else { idx++; paint(false); }
                };
                mountAnswer(q, answers[q.id], function (v) { answers[q.id] = v; }, checked);

                if (!checked) {
                    document.getElementById('check-btn').onclick = function () {
                        var v = answers[q.id];
                        if (isAnswerEmpty(v)) {
                            toast('请先作答再检查', 'error');
                            return;
                        }
                        var ok = judgeAnswer(q, v);
                        results[q.id] = ok;
                        playSound(ok ? soundSettings.correct_sound : soundSettings.incorrect_sound);
                        paint(true);
                    };
                } else {
                    document.getElementById('next-btn').onclick = function () {
                        if (idx === questions.length - 1) finish();
                        else { idx++; paint(false); }
                    };
                }
            }

            /** 完成练习：提交会话 → 跳转完成页 */
            function finish() {
                var correctCount = Object.keys(results).filter(function (k) { return results[k]; }).length;
                var payload = {
                    subjectId: subjectId,
                    lessonId: lessonId,
                    timeSpent: Math.max(1, Math.floor((Date.now() - startAll) / 1000)),
                    answers: questions.map(function (q) {
                        return { questionId: q.id, userAnswer: answers[q.id] === undefined ? null : answers[q.id], isCorrect: results[q.id] === true };
                    })
                };
                api('/practice-sessions', { method: 'POST', body: payload }).then(function (session) {
                    sessionStorage.setItem('quizLastPractice', JSON.stringify({
                        session: session,
                        correct: correctCount,
                        total: questions.length,
                        subjectName: subject ? subject.name : '练习',
                        lessonName: lesson ? lesson.name : '',
                        detail: questions.map(function (q, i) {
                            return { no: i + 1, content: q.content, type: q.type, correct: results[q.id] === true };
                        })
                    }));
                    playSound(soundSettings.complete_sound);
                    go('/practice/complete');
                }).catch(function (e) { toast('保存练习记录失败：' + e.message, 'error'); });
            }

            paint(false);
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /** 练习完成页（数据来自 sessionStorage） */
    function viewPracticeComplete() {
        var box = view();
        var raw = sessionStorage.getItem('quizLastPractice');
        if (!raw) { box.innerHTML = emptyBox('没有可展示的练习结果'); return; }
        var data = JSON.parse(raw);
        var rate = data.total ? (data.correct / data.total) * 100 : 0;
        box.innerHTML =
            '<div class="qz-result-head">' + scoreRing(rate, 140) +
                '<div class="qz-result-meta"><h1>' + (rate >= 60 ? '练习完成，继续加油！' : '练习完成，再复习一下') + '</h1>' +
                    '<p class="qz-dim">' + esc(data.subjectName) + (data.lessonName ? ' · ' + esc(data.lessonName) : '') + '</p>' +
                    '<div class="qz-result-tags">' +
                        '<span>答对 <b>' + data.correct + '</b> / ' + data.total + '</span>' +
                        '<span>正确率 <b>' + rate.toFixed(1) + '%</b></span>' +
                        '<span>用时 <b>' + fmtDuration(data.session.time_spent) + '</b></span>' +
                    '</div>' +
                    '<div class="qz-result-actions">' +
                        '<button class="qz-btn primary" id="back-path">返回学习路径</button>' +
                        '<button class="qz-btn secondary" id="to-home">返回首页</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<h2 class="qz-section-title">答题概览</h2>' +
            '<div class="qz-review-mini">' + data.detail.map(function (d) {
                return '<div class="qz-mini-row ' + (d.correct ? 'ok' : 'bad') + '"><span>第 ' + d.no + ' 题</span>' +
                    '<em>' + esc(String(d.content).slice(0, 42)) + '</em><b>' + (d.correct ? '正确' : '错误') + '</b></div>';
            }).join('') + '</div>';
        document.getElementById('back-path').onclick = function () { go('/practice/' + data.session.subject_id + '/path'); };
        document.getElementById('to-home').onclick = function () { go('/'); };
    }

    /**
     * 练习记录（学员看自己；管理员传 all=1 看全部）
     * @param {object} query 查询参数
     */
    function viewPracticeRecords(query) {
        var box = view();
        var isAdminView = query && query.all === '1';
        api('/practice-sessions' + (isAdminView ? '?all=1' : '')).then(function (list) {
            var rows = (list || []).map(function (s) {
                return [
                    fmtTime(s.completed_at),
                    esc(s.user_name || ''),
                    esc(s.subject_name || '-') + (s.lesson_name ? ' · ' + esc(s.lesson_name) : ''),
                    Number(s.correct_count || 0) + ' / ' + Number(s.total_questions || 0),
                    Number(s.correct_rate || 0).toFixed(1) + '%',
                    fmtDuration(s.time_spent)
                ];
            });
            box.innerHTML = pageHead(isAdminView ? '练习记录查询' : '我的练习记录', isAdminView ? '查看全站学员的练习情况' : '按时间倒序展示你的练习会话') +
                table(['完成时间', '学员', '科目 / 课程', '答对', '正确率', '用时'], rows, '暂无练习记录');
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /* ==================== 错题本 ==================== */

    /** 错题本列表 */
    function viewWrong() {
        var box = view();
        api('/wrong-questions').then(function (list) {
            var all = list || [];
            /** 渲染错题列表区域 */
            function paintList() {
                var rows = all;
                var area = document.getElementById('wrong-list');
                if (!rows.length) { area.innerHTML = emptyBox('暂无错题，继续保持！'); return; }
                area.innerHTML = rows.map(function (w) {
                    var q = w.question || {};
                    return '<div class="qz-card qz-wrong-card"><div class="qz-card-b">' +
                        '<div class="qz-review-head"><span class="qz-badge practice">练习</span>' +
                            '<span class="qz-dim">' + esc(w.subject_name || '') + ' · 错 ' + (w.wrong_count || 1) + ' 次 · ' + fmtTime(w.last_wrong_at) + '</span>' +
                            '<button class="qz-link danger" data-del="' + esc(w.id) + '">移除</button></div>' +
                        '<div class="qz-review-content">' + esc(q.content || '') + '</div>' +
                        '<div class="qz-review-row"><span>正确答案</span><em>' + esc(correctText(q)) + '</em></div>' +
                        (q.explanation ? '<div class="qz-review-row explain"><span>解析</span><em>' + esc(q.explanation) + '</em></div>' : '') +
                    '</div></div>';
                }).join('');
                area.querySelectorAll('[data-del]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        var id = b.getAttribute('data-del');
                        confirmDialog('确定从错题本移除这道题吗？', function () {
                            api('/wrong-questions/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
                                all = all.filter(function (w) { return w.id !== id; });
                                document.getElementById('wrong-total').textContent = all.length;
                                paintList();
                                toast('已移除', 'success');
                            }).catch(function (e) { toast(e.message, 'error'); });
                        }, '移除');
                    });
                });
            }

            box.innerHTML = pageHead('我的错题本', '答错的题目会自动收录，答对后自动移除',
                '<button class="qz-btn danger ghost" id="clear-wrong"' + (all.length ? '' : ' disabled') + '>清空错题</button>') +
                '<div class="qz-stats small">' +
                    '<div class="qz-stat"><b id="wrong-total">' + all.length + '</b><span>错题总数</span></div>' +
                    '<div class="qz-stat"><b>' + all.filter(function (w) { return w.subject_name; }).map(function (w) { return w.subject_name; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; }).length + '</b><span>涉及科目</span></div>' +
                '</div>' +
                '<div class="qz-toolbar">' +
                    '<div class="qz-dim">答错的题目会自动收录，答对后自动移除</div>' +
                    '<button class="qz-btn primary" id="start-wrong"' + (all.length ? '' : ' disabled') + '>开始错题练习</button>' +
                '</div>' +
                '<div id="wrong-list"></div>';

            paintList();
            document.getElementById('start-wrong').onclick = function () {
                if (!all.length) return;
                sessionStorage.setItem('quizWrongPractice', JSON.stringify(all));
                go('/wrong-questions/practice');
            };
            document.getElementById('clear-wrong').onclick = function () {
                confirmDialog('确定清空全部错题吗？此操作不可恢复。', function () {
                    api('/wrong-questions', { method: 'DELETE' }).then(function () {
                        all = [];
                        document.getElementById('wrong-total').textContent = '0';
                        paintList();
                        toast('错题已清空', 'success');
                    }).catch(function (e) { toast(e.message, 'error'); });
                }, '清空');
            };
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /** 错题练习 */
    function viewWrongPractice() {
        var box = view();
        var raw = sessionStorage.getItem('quizWrongPractice');
        if (!raw) { box.innerHTML = emptyBox('没有可练习的错题'); return; }
        var pool = JSON.parse(raw);
        var questions = pool.map(function (w) { return w.question; }).filter(Boolean);
        if (!questions.length) { box.innerHTML = emptyBox('错题对应的题目已不存在'); return; }

        var idx = 0;                                   // 当前题下标
        var answers = {};                              // 题目 id → 答案
        var results = {};                              // 题目 id → 是否答对
        var startAll = Date.now();
        // 提示音不强制加载，失败忽略
        var soundSettings = {};
        loadSounds().then(function (s) { soundSettings = s || {}; });

        /** 渲染当前题 */
        function paint(checked) {
            var q = questions[idx];
            var ok = results[q.id];
            // 检查后的反馈卡片（错题练习用专属文案）
            var feedback = checked
                ? '<div class="qz-exam-feedback"><div class="qz-feedback ' + (ok ? 'ok' : 'bad') + '">' +
                    '<b>' + (ok ? '回答正确，已从错题本移除' : '还是答错了，再复习一下') + '</b>' +
                    '<p>正确答案：' + esc(correctText(q)) + '</p>' +
                    (q.explanation ? '<p class="qz-dim">解析：' + esc(q.explanation) + '</p>' : '') +
                '</div></div>'
                : '';
            box.innerHTML = examShell({
                percent: Math.round((idx + 1) / questions.length * 100),
                remain: questions.length - idx,
                content: esc(q.content).replace(/\n/g, '<br>'),
                extra: (q.image_url ? '<img class="qz-question-img" src="' + esc(q.image_url) + '" alt="题目图片">' : '') +
                       (q.audio_url ? '<audio class="qz-audio" controls src="' + esc(q.audio_url) + '"></audio>' : ''),
                feedback: feedback,
                checked: checked,
                last: idx === questions.length - 1
            });

            document.getElementById('exam-close').onclick = function () { go('/wrong-questions'); };
            document.getElementById('skip-btn').onclick = function () {
                if (idx === questions.length - 1) finish();
                else { idx++; paint(false); }
            };
            mountAnswer(q, answers[q.id], function (v) { answers[q.id] = v; }, checked);

            if (!checked) {
                document.getElementById('check-btn').onclick = function () {
                    var v = answers[q.id];
                    if (isAnswerEmpty(v)) { toast('请先作答', 'error'); return; }
                    var correct = judgeAnswer(q, v);
                    results[q.id] = correct;
                    playSound(correct ? soundSettings.correct_sound : soundSettings.incorrect_sound);
                    if (correct) {
                        // 答对后从错题本移除（找到对应错题条目）
                        var hit = pool.find(function (w) { return w.question_id === q.id; });
                        if (hit) api('/wrong-questions/' + encodeURIComponent(hit.id), { method: 'DELETE' }).catch(function () { });
                    }
                    paint(true);
                };
            } else {
                document.getElementById('next-btn').onclick = function () {
                    if (idx === questions.length - 1) finish();
                    else { idx++; paint(false); }
                };
            }
        }

        /** 完成错题练习 */
        function finish() {
            var correct = Object.keys(results).filter(function (k) { return results[k]; }).length;
            sessionStorage.setItem('quizWrongResult', JSON.stringify({
                total: questions.length,
                correct: correct,
                timeSpent: Math.max(1, Math.floor((Date.now() - startAll) / 1000)),
                detail: questions.map(function (q, i) { return { no: i + 1, content: q.content, correct: results[q.id] === true }; })
            }));
            go('/wrong-questions/complete');
        }

        paint(false);
    }

    /** 错题练习完成页 */
    function viewWrongComplete() {
        var box = view();
        var raw = sessionStorage.getItem('quizWrongResult');
        if (!raw) { box.innerHTML = emptyBox('没有可展示的结果'); return; }
        var data = JSON.parse(raw);
        var rate = data.total ? (data.correct / data.total) * 100 : 0;
        box.innerHTML =
            '<div class="qz-result-head">' + scoreRing(rate, 140) +
                '<div class="qz-result-meta"><h1>错题练习完成</h1>' +
                    '<p class="qz-dim">答对的题目已自动从错题本移除</p>' +
                    '<div class="qz-result-tags"><span>答对 <b>' + data.correct + '</b> / ' + data.total + '</span>' +
                        '<span>用时 <b>' + fmtDuration(data.timeSpent) + '</b></span></div>' +
                    '<div class="qz-result-actions">' +
                        '<button class="qz-btn primary" id="back-wrong">查看错题本</button>' +
                        '<button class="qz-btn secondary" id="to-home">返回首页</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="qz-review-mini">' + data.detail.map(function (d) {
                return '<div class="qz-mini-row ' + (d.correct ? 'ok' : 'bad') + '"><span>第 ' + d.no + ' 题</span>' +
                    '<em>' + esc(String(d.content).slice(0, 42)) + '</em><b>' + (d.correct ? '正确' : '错误') + '</b></div>';
            }).join('') + '</div>';
        document.getElementById('back-wrong').onclick = function () { go('/wrong-questions'); };
        document.getElementById('to-home').onclick = function () { go('/'); };
    }

    /* ==================== 我的 ==================== */

    /** 个人中心 */
    function viewProfile() {
        var box = view();
        Promise.all([
            api('/me'),
            api('/practice-sessions'),
            api('/wrong-questions')
        ]).then(function (res) {
            var me = res[0];                              // 当前登录用户
            var sessions = res[1] || [];                  // 练习会话记录
            var wrongs = res[2] || [];                    // 错题列表
            var qTotal = sessions.reduce(function (s, x) { return s + Number(x.total_questions || 0); }, 0);
            var qCorrect = sessions.reduce(function (s, x) { return s + Number(x.correct_count || 0); }, 0);

            box.innerHTML = pageHead('我的主页', '查看个人学习数据与快捷入口') +
                '<div class="qz-profile">' +
                    '<div class="qz-card qz-profile-card"><div class="qz-card-b">' +
                        '<img class="qz-profile-avatar" src="' + esc(me.avatar || '/assets/home/default-avatar.png') + '" alt="头像">' +
                        '<h2>' + esc(me.name) + '</h2>' +
                        '<p class="qz-dim">ID：' + esc(me.id) + '</p>' +
                        '<div class="qz-profile-tags"><span class="qz-badge' + (me.isAdmin ? ' admin' : '') + '">' + (me.isAdmin ? '管理员' : '学生') + '</span>' +
                            '<span class="qz-badge">积分 ' + Number(me.points || 0) + '</span></div>' +
                    '</div></div>' +
                    '<div class="qz-profile-main">' +
                        '<div class="qz-stats">' +
                            '<div class="qz-stat"><b>' + sessions.length + '</b><span>练习次数</span></div>' +
                            '<div class="qz-stat"><b>' + (qTotal ? (qCorrect / qTotal * 100).toFixed(1) + '%' : '-') + '</b><span>练习正确率</span></div>' +
                            '<div class="qz-stat warn"><b>' + wrongs.length + '</b><span>错题数量</span></div>' +
                        '</div>' +
                        '<div class="qz-card"><div class="qz-card-h"><h3>快捷入口</h3></div><div class="qz-card-b qz-admin-links">' +
                            '<button class="qz-btn secondary" data-go="/practice-select">练习中心</button>' +
                            '<button class="qz-btn secondary" data-go="/wrong-questions">错题本</button>' +
                            '<button class="qz-btn secondary" data-go="/practice-records">练习记录</button>' +
                            (me.isAdmin ? '<button class="qz-btn secondary" data-go="/manage">管理后台</button>' : '') +
                        '</div></div>' +
                        '<div class="qz-card"><div class="qz-card-h"><h3>最近练习</h3></div><div class="qz-card-b">' +
                            (sessions.slice(0, 5).map(function (s) {
                                return '<div class="qz-quick-row"><span>' + fmtTime(s.created_at) + ' · ' +
                                    esc(s.subject_name || '练习') + (s.lesson_name ? ' · ' + esc(s.lesson_name) : '') + '</span><em>' +
                                    Number(s.correct_rate || 0).toFixed(0) + '%</em></div>';
                            }).join('') || '<div class="qz-dim">还没有练习记录</div>') +
                        '</div></div>' +
                    '</div>' +
                '</div>';

            box.querySelectorAll('[data-go]').forEach(function (b) {
                b.addEventListener('click', function () { go(b.getAttribute('data-go')); });
            });
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /* ==================== 管理：入口页 ==================== */

    /** 管理后台入口 */
    function viewManageHub() {
        var box = view();
        box.innerHTML = pageHead('管理后台', '练习、题目与系统配置管理') +
            '<div class="qz-hub-grid">' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/practice-manage"><div class="qz-card-b"><div class="qz-hub-icon">🧩</div><h3>练习管理</h3><p class="qz-dim">科目、单元、课程与习题</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/manage/sound-settings"><div class="qz-card-b"><div class="qz-hub-icon">🔔</div><h3>提示音设置</h3><p class="qz-dim">答对 / 答错 / 完成提示音</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/settings-manage"><div class="qz-card-b"><div class="qz-hub-icon">⚙️</div><h3>设置管理</h3><p class="qz-dim">提示音与用户管理入口</p></div></a>' +
            '</div>';
        box.querySelectorAll('a.qz-hub-card').forEach(function (a) {
            a.addEventListener('click', function (e) { e.preventDefault(); go(a.getAttribute('href').slice(BASE.length) || '/'); });
        });
    }

    /** 设置管理入口（提示音 / 用户管理） */
    function viewSettingsHub() {
        var box = view();
        box.innerHTML = pageHead('设置管理', '系统级配置入口') +
            '<div class="qz-hub-grid">' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/manage/sound-settings"><div class="qz-card-b"><div class="qz-hub-icon">🔔</div><h3>提示音设置</h3><p class="qz-dim">配置答对 / 答错 / 完成提示音</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/admin/users"><div class="qz-card-b"><div class="qz-hub-icon">👥</div><h3>用户管理</h3><p class="qz-dim">查看主项目用户与积分</p></div></a>' +
            '</div>';
        box.querySelectorAll('a.qz-hub-card').forEach(function (a) {
            a.addEventListener('click', function (e) { e.preventDefault(); go(a.getAttribute('href').slice(BASE.length) || '/'); });
        });
    }

    /** 练习管理入口 */
    function viewPracticeManageHub() {
        var box = view();
        box.innerHTML = pageHead('练习管理', '维护练习科目、单元、课程与习题') +
            '<div class="qz-hub-grid">' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/practice-manage/subjects"><div class="qz-card-b"><div class="qz-hub-icon">📘</div><h3>科目管理</h3><p class="qz-dim">新增 / 编辑 / 删除科目</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/practice-manage/units"><div class="qz-card-b"><div class="qz-hub-icon">🗂️</div><h3>单元管理</h3><p class="qz-dim">按科目维护单元</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/practice-manage/lessons"><div class="qz-card-b"><div class="qz-hub-icon">🎯</div><h3>课程管理</h3><p class="qz-dim">按单元维护课程</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/practice-manage/questions"><div class="qz-card-b"><div class="qz-hub-icon">📝</div><h3>习题管理</h3><p class="qz-dim">维护课程练习题目</p></div></a>' +
                '<a class="qz-card qz-hub-card" href="' + BASE + '/practice-manage/records"><div class="qz-card-b"><div class="qz-hub-icon">📈</div><h3>记录查询</h3><p class="qz-dim">查看全站练习会话</p></div></a>' +
            '</div>';
        box.querySelectorAll('a.qz-hub-card').forEach(function (a) {
            a.addEventListener('click', function (e) { e.preventDefault(); go(a.getAttribute('href').slice(BASE.length) || '/'); });
        });
    }

    /**
     * 打开练习题目编辑表单
     * @param {object} cfg { data, subjects, lessons, defaultSubject, onSaved }
     */
    function openQuestionForm(cfg) {
        var data = cfg.data || null;
        var subjects = cfg.subjects || [];
        var lessons = cfg.lessons || [];
        var qOptions = data ? parseOptions(data) : [];
        var m = data && data.type === 'matching' ? parseMatching(data) : { left: [], right: [] };

        /** 选项文本（每行一个） */
        var optionsText = qOptions.map(function (o) { return o.text; }).join('\n');
        /** 正确答案文本 */
        var correctValue = '';
        if (data && data.correct_answer != null) {
            if (Array.isArray(data.correct_answer)) correctValue = data.correct_answer.join('\n');
            else if (typeof data.correct_answer === 'object') {
                correctValue = Object.keys(data.correct_answer).map(function (k) { return k + '=' + data.correct_answer[k]; }).join('\n');
            } else correctValue = String(data.correct_answer);
        }

        var body = document.createElement('div');
        body.className = 'qz-form';
        body.innerHTML =
            '<label class="qz-field"><span>题型</span><select class="qz-select" id="q-type">' +
                Object.keys(TYPE_LABEL).map(function (t) {
                    return '<option value="' + t + '"' + (data && data.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>';
                }).join('') + '</select></label>' +
            '<label class="qz-field"><span>题目内容</span><textarea class="qz-textarea" id="q-content" rows="3">' + esc(data ? data.content : '') + '</textarea></label>' +
            '<div class="qz-form-row"><label class="qz-field"><span>所属科目</span><select class="qz-select" id="q-subject">' +
                    subjects.map(function (s) {
                        var sel = data ? data.subject_id === s.id : cfg.defaultSubject === s.id;
                        return '<option value="' + esc(s.id) + '"' + (sel ? ' selected' : '') + '>' + esc(s.name) + '</option>';
                    }).join('') + '</select></label>' +
                  '<label class="qz-field"><span>所属课程（可选）</span><select class="qz-select" id="q-lesson"><option value="">不归属课程</option>' +
                    lessons.map(function (l) {
                        return '<option value="' + esc(l.id) + '"' + (data && data.lesson_id === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>';
                    }).join('') + '</select></label></div>' +
            '<div id="q-dynamic"></div>' +
            '<div class="qz-form-row">' +
                '<label class="qz-field"><span>图片地址（可选）</span><input class="qz-input" id="q-image" value="' + esc(data ? data.image_url || '' : '') + '" placeholder="可上传或粘贴 URL"></label>' +
                '<label class="qz-field"><span>音频地址（可选）</span><input class="qz-input" id="q-audio" value="' + esc(data ? data.audio_url || '' : '') + '" placeholder="可上传或粘贴 URL"></label>' +
            '</div>' +
            '<div class="qz-form-row">' +
                '<label class="qz-upload-inline"><span>上传题目图片</span><input type="file" id="q-image-file" accept="image/*"></label>' +
                '<label class="qz-upload-inline"><span>上传题目音频</span><input type="file" id="q-audio-file" accept="audio/*"></label>' +
            '</div>' +
            '<label class="qz-field"><span>解析（可选）</span><textarea class="qz-textarea" id="q-explain" rows="2">' + esc(data ? data.explanation || '' : '') + '</textarea></label>';

        /** 根据题型渲染动态区域 */
        function paintDynamic() {
            var type = body.querySelector('#q-type').value;
            var area = body.querySelector('#q-dynamic');
            if (type === 'single_choice' || type === 'multiple_choice') {
                area.innerHTML =
                    '<label class="qz-field"><span>选项（每行一个）</span><textarea class="qz-textarea" id="q-options" rows="4">' + esc(optionsText) + '</textarea></label>' +
                    '<label class="qz-field"><span>正确答案（' + (type === 'multiple_choice' ? '多个用逗号分隔' : '填写选项原文') + '）</span><input class="qz-input" id="q-correct" value="' + esc(correctValue) + '"></label>';
            } else if (type === 'fill_blank') {
                area.innerHTML = '<label class="qz-field"><span>正确答案</span><input class="qz-input" id="q-correct" value="' + esc(correctValue) + '"></label>';
            } else if (type === 'sentence_order') {
                area.innerHTML =
                    '<label class="qz-field"><span>词语（每行一个，乱序展示）</span><textarea class="qz-textarea" id="q-options" rows="4">' + esc(optionsText) + '</textarea></label>' +
                    '<label class="qz-field"><span>正确顺序（每行一个，按顺序填写）</span><textarea class="qz-textarea" id="q-correct" rows="4">' + esc(correctValue) + '</textarea></label>';
            } else if (type === 'matching') {
                area.innerHTML =
                    '<div class="qz-form-row">' +
                        '<label class="qz-field"><span>左侧项（每行一个）</span><textarea class="qz-textarea" id="q-left" rows="4">' + esc(m.left.join('\n')) + '</textarea></label>' +
                        '<label class="qz-field"><span>右侧项（每行一个）</span><textarea class="qz-textarea" id="q-right" rows="4">' + esc(m.right.join('\n')) + '</textarea></label>' +
                    '</div>' +
                    '<label class="qz-field"><span>正确配对（每行：左项=右项）</span><textarea class="qz-textarea" id="q-correct" rows="4">' + esc(correctValue) + '</textarea></label>';
            } else {
                area.innerHTML = '<p class="qz-dim">画板题由学生手绘作答，无法自动判分，需教师人工评分。</p>';
            }
        }

        paintDynamic();
        body.querySelector('#q-type').addEventListener('change', paintDynamic);

        /** 上传文件到服务端并写回输入框 */
        function bindUpload(inputId, targetId) {
            body.querySelector(inputId).addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                    api('/upload', { method: 'POST', body: { dataUrl: reader.result } })
                        .then(function (r) { body.querySelector(targetId).value = r.url; toast('上传成功', 'success'); })
                        .catch(function (err) { toast('上传失败：' + err.message, 'error'); });
                };
                reader.readAsDataURL(file);
            });
        }
        bindUpload('#q-image-file', '#q-image');
        bindUpload('#q-audio-file', '#q-audio');

        openModal({
            title: data ? '编辑题目' : '新增题目',
            body: body,
            width: '760px',
            onOk: function (notify) {
                var type = body.querySelector('#q-type').value;
                var content = body.querySelector('#q-content').value.trim();
                if (!content) { notify('请输入题目内容', 'error'); return false; }
                var val = function (id) { var el = body.querySelector(id); return el ? el.value.trim() : ''; };
                var payload = {
                    type: type,
                    content: content,
                    image_url: val('#q-image') || null,
                    audio_url: val('#q-audio') || null,
                    explanation: val('#q-explain') || null,
                    options: null,
                    correct_answer: null
                };
                if (type === 'single_choice' || type === 'multiple_choice') {
                    var opts = val('#q-options').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
                    if (opts.length < 2) { notify('请至少填写两个选项', 'error'); return false; }
                    payload.options = opts;
                    var raw = val('#q-correct');
                    if (!raw) { notify('请填写正确答案', 'error'); return false; }
                    if (type === 'single_choice') {
                        payload.correct_answer = raw;
                    } else {
                        var arr = raw.split(/[,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
                        if (!arr.length) { notify('请填写正确答案', 'error'); return false; }
                        payload.correct_answer = arr;
                    }
                } else if (type === 'fill_blank') {
                    var c = val('#q-correct');
                    if (!c) { notify('请填写正确答案', 'error'); return false; }
                    payload.correct_answer = c;
                } else if (type === 'sentence_order') {
                    var words = val('#q-options').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
                    var order = val('#q-correct').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
                    if (words.length < 2 || order.length < 2) { notify('词语和正确顺序至少各两行', 'error'); return false; }
                    payload.options = words;
                    payload.correct_answer = order;
                } else if (type === 'matching') {
                    var left = val('#q-left').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
                    var right = val('#q-right').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
                    var pairs = {};
                    val('#q-correct').split('\n').forEach(function (line) {
                        var parts = line.split('=');
                        if (parts.length >= 2) pairs[parts[0].trim()] = parts.slice(1).join('=').trim();
                    });
                    if (!left.length || !right.length || !Object.keys(pairs).length) { notify('请填写左右项与正确配对', 'error'); return false; }
                    payload.options = { left: left, right: right };
                    payload.correct_answer = pairs;
                }
                payload.subject_id = body.querySelector('#q-subject').value;
                payload.lesson_id = body.querySelector('#q-lesson').value || null;
                var req = data
                    ? api('/practice-questions/' + encodeURIComponent(data.id), { method: 'PATCH', body: payload })
                    : api('/practice-questions', { method: 'POST', body: payload });
                req.then(function () { toast('保存成功', 'success'); cfg.onSaved && cfg.onSaved(); })
                    .catch(function (e) { notify('保存失败：' + e.message, 'error'); });
            }
        });
    }

    /* ==================== 管理：提示音 ==================== */

    /** 提示音设置 */
    function viewSoundSettings() {
        var box = view();
        setBack('/manage');
        var settings = {};
        var labels = [
            { key: 'correct_sound', label: '答对提示音' },
            { key: 'incorrect_sound', label: '答错提示音' },
            { key: 'complete_sound', label: '完成提示音' }
        ];

        /** 渲染设置项 */
        function paint() {
            box.innerHTML = pageHead('提示音设置', '为答题过程配置音效，支持 MP3 / WAV / OGG', '<button class="qz-btn primary" id="save-sound">保存设置</button>') +
                '<div class="qz-card"><div class="qz-card-b qz-sound-list">' +
                    labels.map(function (l) {
                        var url = settings[l.key];
                        return '<div class="qz-sound-row">' +
                            '<div class="qz-sound-info"><b>' + l.label + '</b>' +
                                (url ? '<audio controls src="' + esc(url) + '"></audio>' : '<span class="qz-dim">未设置</span>') +
                            '</div>' +
                            '<div class="qz-sound-actions">' +
                                '<label class="qz-upload-inline"><span>选择音频</span><input type="file" accept="audio/*" data-up="' + l.key + '"></label>' +
                                (url ? '<button class="qz-link danger" data-clear="' + l.key + '">清除</button>' : '') +
                            '</div>' +
                        '</div>';
                    }).join('') + '</div></div>';

            box.querySelectorAll('[data-up]').forEach(function (input) {
                input.addEventListener('change', function (e) {
                    var file = e.target.files && e.target.files[0];
                    var key = input.getAttribute('data-up');
                    if (!file) return;
                    var reader = new FileReader();
                    reader.onload = function () {
                        api('/upload', { method: 'POST', body: { dataUrl: reader.result } })
                            .then(function (r) { settings[key] = r.url; toast('上传成功，记得保存', 'success'); paint(); })
                            .catch(function (err) { toast('上传失败：' + err.message, 'error'); });
                    };
                    reader.readAsDataURL(file);
                });
            });
            box.querySelectorAll('[data-clear]').forEach(function (b) {
                b.addEventListener('click', function () {
                    settings[b.getAttribute('data-clear')] = null;
                    paint();
                });
            });
            document.getElementById('save-sound').onclick = function () {
                api('/sound-settings', { method: 'PUT', body: settings })
                    .then(function () { toast('提示音已保存', 'success'); })
                    .catch(function (e) { toast('保存失败：' + e.message, 'error'); });
            };
        }

        api('/sound-settings').then(function (s) {
            settings = s || {};
            paint();
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /* ==================== 管理：科目 / 单元 / 课程 / 习题 ==================== */

    /** 科目管理 */
    function viewSubjectManage() {
        var box = view();
        setBack('/practice-manage');

        /** 加载并渲染科目列表 */
        function load() {
            api('/subjects').then(function (subjects) {
                var rows = subjects.map(function (s) {
                    return [
                        '<span class="qz-emoji">' + esc(s.icon || '') + '</span>',
                        esc(s.name),
                        '<div class="qz-cell-clip">' + esc(s.description || '') + '</div>',
                        String(s.display_order || 0),
                        s.is_active === false ? '停用' : '启用',
                        '<button class="qz-link" data-edit="' + esc(s.id) + '">编辑</button>' +
                        '<button class="qz-link danger" data-del="' + esc(s.id) + '">删除</button>'
                    ];
                });
                box.innerHTML = pageHead('科目管理', '科目是练习的第一层分类', '<button class="qz-btn primary" id="add-subject">新增科目</button>') +
                    table(['图标', '科目名称', '描述', '排序', '状态', '操作'], rows, '暂无科目');
                document.getElementById('add-subject').onclick = function () { edit(null); };
                box.querySelectorAll('[data-edit]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        edit(subjects.find(function (s) { return s.id === b.getAttribute('data-edit'); }));
                    });
                });
                box.querySelectorAll('[data-del]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        confirmDialog('删除科目会连同其单元、课程、习题一起删除，确定吗？', function () {
                            api('/subjects/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' })
                                .then(function () { toast('已删除', 'success'); load(); })
                                .catch(function (e) { toast(e.message, 'error'); });
                        });
                    });
                });
            }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
        }

        /**
         * 新建 / 编辑科目
         * @param {object|null} s 科目
         */
        function edit(s) {
            var body = document.createElement('div');
            body.innerHTML = fieldHtml([
                { key: 'name', label: '科目名称', value: s ? s.name : '' },
                { key: 'icon', label: '图标（emoji）', value: s ? s.icon : '📘' },
                { key: 'description', label: '描述', value: s ? s.description || '' : '' },
                { key: 'display_order', label: '排序', type: 'number', value: s ? s.display_order : 1 },
                { key: 'is_active', label: '启用', type: 'checkbox', value: s ? s.is_active !== false : true }
            ]);
            openModal({
                title: s ? '编辑科目' : '新增科目',
                body: body,
                onOk: function (notify) {
                    var v = readFields(body);
                    if (!v.name.trim()) { notify('请输入科目名称', 'error'); return false; }
                    var payload = { name: v.name.trim(), icon: v.icon, description: v.description, display_order: Number(v.display_order) || 1, is_active: v.is_active };
                    var req = s ? api('/subjects/' + encodeURIComponent(s.id), { method: 'PATCH', body: payload })
                                : api('/subjects', { method: 'POST', body: payload });
                    req.then(function () { toast('保存成功', 'success'); load(); })
                        .catch(function (e) { notify(e.message, 'error'); });
                }
            });
        }

        load();
    }

    /** 单元管理 */
    function viewUnitManage() {
        var box = view();
        setBack('/practice-manage');
        var currentSubject = '';

        /** 加载科目与单元 */
        function load() {
            Promise.all([api('/subjects'), api('/units' + (currentSubject ? '?subjectId=' + encodeURIComponent(currentSubject) : ''))])
                .then(function (res) {
                    var subjects = res[0] || [];
                    var units = res[1] || [];
                    // 首次进入：默认选中第一个科目，并重新拉取该科目的单元
                    if (!currentSubject && subjects.length) {
                        currentSubject = subjects[0].id;
                        return api('/units?subjectId=' + encodeURIComponent(currentSubject)).then(function (list) {
                            render(subjects, list);
                        });
                    }
                    render(subjects, units);
                }).catch(function (e) { box.innerHTML = emptyBox(e.message); });

            /**
             * 渲染单元表格
             * @param {Array} subjects 科目
             * @param {Array} units 单元
             */
            function render(subjects, units) {
                var rows = units.map(function (u) {
                    var subject = subjects.find(function (s) { return s.id === u.subject_id; });
                    return [
                        esc(subject ? subject.name : '-'),
                        esc(u.name),
                        '<div class="qz-cell-clip">' + esc(u.description || '') + '</div>',
                        String(u.display_order || 0),
                        '<button class="qz-link" data-edit="' + esc(u.id) + '">编辑</button>' +
                        '<button class="qz-link danger" data-del="' + esc(u.id) + '">删除</button>'
                    ];
                });
                box.innerHTML = pageHead('单元管理', '单元隶属于科目', '<button class="qz-btn primary" id="add-unit">新增单元</button>') +
                    '<div class="qz-toolbar"><label class="qz-inline-field"><span>科目</span><select class="qz-select" id="subject-filter">' +
                        subjects.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === currentSubject ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
                    '</select></label></div>' +
                    table(['科目', '单元名称', '描述', '排序', '操作'], rows, '暂无单元');
                document.getElementById('subject-filter').onchange = function () { currentSubject = this.value; load(); };
                document.getElementById('add-unit').onclick = function () { edit(null, subjects); };
                box.querySelectorAll('[data-edit]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        edit(units.find(function (u) { return u.id === b.getAttribute('data-edit'); }), subjects);
                    });
                });
                box.querySelectorAll('[data-del]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        confirmDialog('删除单元会连同课程、习题一起删除，确定吗？', function () {
                            api('/units/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' })
                                .then(function () { toast('已删除', 'success'); load(); })
                                .catch(function (e) { toast(e.message, 'error'); });
                        });
                    });
                });
            }
        }

        /**
         * 新建 / 编辑单元
         * @param {object|null} u 单元
         * @param {Array} subjects 科目列表
         */
        function edit(u, subjects) {
            var body = document.createElement('div');
            body.innerHTML = fieldHtml([
                { key: 'subject_id', label: '所属科目', type: 'select', value: u ? u.subject_id : currentSubject, options: subjects.map(function (s) { return { value: s.id, label: s.name }; }) },
                { key: 'name', label: '单元名称', value: u ? u.name : '' },
                { key: 'description', label: '描述', value: u ? u.description || '' : '' },
                { key: 'display_order', label: '排序', type: 'number', value: u ? u.display_order : 1 }
            ]);
            openModal({
                title: u ? '编辑单元' : '新增单元',
                body: body,
                onOk: function (notify) {
                    var v = readFields(body);
                    if (!v.name.trim()) { notify('请输入单元名称', 'error'); return false; }
                    var payload = { subject_id: v.subject_id, name: v.name.trim(), description: v.description, display_order: Number(v.display_order) || 1 };
                    var req = u ? api('/units/' + encodeURIComponent(u.id), { method: 'PATCH', body: payload })
                                : api('/units', { method: 'POST', body: payload });
                    req.then(function () { currentSubject = v.subject_id; toast('保存成功', 'success'); load(); })
                        .catch(function (e) { notify(e.message, 'error'); });
                }
            });
        }

        load();
    }

    /** 课程管理 */
    function viewLessonManage() {
        var box = view();
        setBack('/practice-manage');
        var currentUnit = '';

        /** 加载数据 */
        function load() {
            api('/subjects').then(function (subjects) {
                return api('/units').then(function (units) {
                    return api('/lessons').then(function (lessons) {
                        render(subjects, units, lessons);
                    });
                });
            }).catch(function (e) { box.innerHTML = emptyBox(e.message); });

            /**
             * 渲染
             * @param {Array} subjects 科目
             * @param {Array} units 单元
             * @param {Array} lessons 课程
             */
            function render(subjects, units, lessons) {
                if (!currentUnit && units.length) currentUnit = units[0].id;
                var filtered = lessons.filter(function (l) { return !currentUnit || l.unit_id === currentUnit; });
                var rows = filtered.map(function (l) {
                    var unit = units.find(function (u) { return u.id === l.unit_id; });
                    var subject = unit ? subjects.find(function (s) { return s.id === unit.subject_id; }) : null;
                    return [
                        esc(subject ? subject.name : '-'),
                        esc(unit ? unit.name : '-'),
                        esc(l.name),
                        l.icon,
                        String(l.display_order || 0),
                        '<button class="qz-link" data-edit="' + esc(l.id) + '">编辑</button>' +
                        '<button class="qz-link danger" data-del="' + esc(l.id) + '">删除</button>'
                    ];
                });
                box.innerHTML = pageHead('课程管理', '课程隶属于单元，是学习路径的节点', '<button class="qz-btn primary" id="add-lesson">新增课程</button>') +
                    '<div class="qz-toolbar"><label class="qz-inline-field"><span>单元</span><select class="qz-select" id="unit-filter">' +
                        units.map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.id === currentUnit ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') +
                    '</select></label></div>' +
                    table(['科目', '单元', '课程名称', '图标', '排序', '操作'], rows, '该单元暂无课程');
                document.getElementById('unit-filter').onchange = function () { currentUnit = this.value; load(); };
                document.getElementById('add-lesson').onclick = function () { edit(null, units); };
                box.querySelectorAll('[data-edit]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        edit(lessons.find(function (l) { return l.id === b.getAttribute('data-edit'); }), units);
                    });
                });
                box.querySelectorAll('[data-del]').forEach(function (b) {
                    b.addEventListener('click', function () {
                        confirmDialog('删除课程会连同习题一起删除，确定吗？', function () {
                            api('/lessons/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' })
                                .then(function () { toast('已删除', 'success'); load(); })
                                .catch(function (e) { toast(e.message, 'error'); });
                        });
                    });
                });
            }
        }

        /**
         * 新建 / 编辑课程
         * @param {object|null} l 课程
         * @param {Array} units 单元列表
         */
        function edit(l, units) {
            var body = document.createElement('div');
            body.innerHTML = fieldHtml([
                { key: 'unit_id', label: '所属单元', type: 'select', value: l ? l.unit_id : currentUnit, options: units.map(function (u) { return { value: u.id, label: u.name }; }) },
                { key: 'name', label: '课程名称', value: l ? l.name : '' },
                { key: 'description', label: '描述', value: l ? l.description || '' : '' },
                { key: 'icon', label: '图标', type: 'select', value: l ? l.icon : 'star', options: [{ value: 'star', label: '⭐ 星星' }, { value: 'trophy', label: '🏆 奖杯' }, { value: 'dumbbell', label: '🏋️ 哑铃' }] },
                { key: 'display_order', label: '排序', type: 'number', value: l ? l.display_order : 1 }
            ]);
            openModal({
                title: l ? '编辑课程' : '新增课程',
                body: body,
                onOk: function (notify) {
                    var v = readFields(body);
                    if (!v.name.trim()) { notify('请输入课程名称', 'error'); return false; }
                    var payload = { unit_id: v.unit_id, name: v.name.trim(), description: v.description, icon: v.icon, display_order: Number(v.display_order) || 1 };
                    var req = l ? api('/lessons/' + encodeURIComponent(l.id), { method: 'PATCH', body: payload })
                                : api('/lessons', { method: 'POST', body: payload });
                    req.then(function () { currentUnit = v.unit_id; toast('保存成功', 'success'); load(); })
                        .catch(function (e) { notify(e.message, 'error'); });
                }
            });
        }

        load();
    }

    /**
     * 习题管理
     * @param {object} query 查询参数（subjectId / lessonId）
     */
    function viewPracticeQuestionManage(query) {
        var box = view();
        setBack('/practice-manage');
        var currentSubject = query.subjectId || '';
        var currentLesson = query.lessonId || '';

        /** 加载并渲染 */
        function load() {
            Promise.all([api('/subjects'), api('/units'), api('/lessons'), api('/practice-questions')])
                .then(function (res) {
                    var subjects = res[0] || [];
                    var units = res[1] || [];
                    var lessons = res[2] || [];
                    var all = res[3] || [];
                    if (!currentSubject && subjects.length) currentSubject = subjects[0].id;
                    var lessonIds = lessons.filter(function (l) {
                        var unit = units.find(function (u) { return u.id === l.unit_id; });
                        return !currentSubject || (unit && unit.subject_id === currentSubject);
                    }).map(function (l) { return l.id; });
                    var filtered = all.filter(function (q) {
                        if (q.subject_id !== currentSubject) return false;
                        if (currentLesson && q.lesson_id !== currentLesson) return false;
                        return true;
                    });
                    var rows = filtered.map(function (q, i) {
                        var lesson = lessons.find(function (l) { return l.id === q.lesson_id; });
                        return [
                            String(i + 1),
                            esc(TYPE_LABEL[q.type] || q.type),
                            '<div class="qz-cell-clip">' + esc(q.content) + '</div>',
                            esc(lesson ? lesson.name : '-'),
                            '<button class="qz-link" data-edit="' + esc(q.id) + '">编辑</button>' +
                            '<button class="qz-link danger" data-del="' + esc(q.id) + '">删除</button>'
                        ];
                    });
                    box.innerHTML = pageHead('习题管理', '共 ' + filtered.length + ' 道练习题', '<button class="qz-btn primary" id="add-pq">新增习题</button>') +
                        '<div class="qz-toolbar">' +
                            '<label class="qz-inline-field"><span>科目</span><select class="qz-select" id="pq-subject">' +
                                subjects.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === currentSubject ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
                            '</select></label>' +
                            '<label class="qz-inline-field"><span>课程</span><select class="qz-select" id="pq-lesson"><option value="">全部课程</option>' +
                                lessons.filter(function (l) { return lessonIds.indexOf(l.id) >= 0; }).map(function (l) {
                                    return '<option value="' + esc(l.id) + '"' + (l.id === currentLesson ? ' selected' : '') + '>' + esc(l.name) + '</option>';
                                }).join('') +
                            '</select></label>' +
                        '</div>' +
                        table(['#', '题型', '题目', '课程', '操作'], rows, '暂无习题');

                    document.getElementById('pq-subject').onchange = function () {
                        currentSubject = this.value; currentLesson = ''; load();
                    };
                    document.getElementById('pq-lesson').onchange = function () { currentLesson = this.value; load(); };
                    document.getElementById('add-pq').onclick = function () {
                        openQuestionForm({
                            data: null, subjects: subjects, lessons: lessons,
                            defaultSubject: currentSubject, onSaved: load
                        });
                    };
                    box.querySelectorAll('[data-edit]').forEach(function (b) {
                        b.addEventListener('click', function () {
                            var q = filtered.find(function (x) { return x.id === b.getAttribute('data-edit'); });
                            openQuestionForm({ data: q, subjects: subjects, lessons: lessons, onSaved: load });
                        });
                    });
                    box.querySelectorAll('[data-del]').forEach(function (b) {
                        b.addEventListener('click', function () {
                            confirmDialog('确定删除这道习题吗？', function () {
                                api('/practice-questions/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' })
                                    .then(function () { toast('已删除', 'success'); load(); })
                                    .catch(function (e) { toast(e.message, 'error'); });
                            });
                        });
                    });
                }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
        }

        load();
    }

    /** 用户管理（读取主项目用户，增删改跳转统一用户管理） */
    function viewUserManage() {
        var box = view();
        setBack('/settings-manage');
        api('/admin/users').then(function (users) {
            var rows = users.map(function (u) {
                return [
                    esc(u.name),
                    esc(u.id),
                    u.is_admin ? '<span class="qz-badge admin">管理员</span>' : '学生',
                    String(u.points || 0)
                ];
            });
            box.innerHTML = pageHead('用户管理', '用户数据由主项目统一维护',
                '<a class="qz-btn secondary" href="/usermanagement" target="_blank" rel="noopener noreferrer">打开统一用户管理</a>') +
                table(['姓名', 'ID', '角色', '积分'], rows, '暂无用户');
        }).catch(function (e) { box.innerHTML = emptyBox(e.message); });
    }

    /* ==================== 启动 ==================== */

    /**
     * 启动：渲染骨架 → 拉取当前用户 → 渲染路由
     */
    function boot() {
        renderShell();
        api('/me').then(function (me) {
            ME = me;
            renderNav();
            renderUser();
            renderRoute();
        }).catch(function () {
            // 会话失效：交回主项目登录页，登录后回到答题首页
            window.location.href = '/login?next=' + encodeURIComponent('/quiz');
        });
        window.addEventListener('popstate', renderRoute);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
