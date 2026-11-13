/**
 * Modal 对话框
 * 参考：UI设计规范.md / 弹窗.html
 *   遮罩：半透明 + blur(8px)
 *   动画：scale(0.9)→1 + 淡入 0.3s cubic-bezier
 *   关闭：点击遮罩、ESC、打开期间 body 禁滚动
 */
const Modal = (function () {
  /**
   * 取多语言文案：i18n 框架未加载时回退中文兜底
   * @param {string} key 语言包键（如 roulette.modal.confirm）
   * @param {string} fallback 中文兜底文案
   * @returns {string} 最终展示文案
   */
  function modalT(key, fallback) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, null, fallback) : (fallback || key);
  }

  /**
   * 打开弹窗
   * @param {string} html 弹窗内部 HTML（包含 .modal-title、.modal-body、.modal-buttons）
   * @returns {{ el, close }} 弹窗元素与关闭函数
   */
  function open(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(overlay);

    // 强制重排后下一帧添加 active 触发过渡
    overlay.offsetHeight;
    requestAnimationFrame(() => overlay.classList.add('active'));
    document.body.style.overflow = 'hidden';

    const close = () => {
      overlay.classList.remove('active');
      document.body.style.overflow = '';
      setTimeout(() => overlay.remove(), 300);
    };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);

    // 关闭时解绑
    const obs = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', escHandler);
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });

    return { el: overlay, close };
  }

  /** 通用确认弹窗（普通确认蓝色按钮，危险操作红色按钮，与弹窗.html一致） */
  function confirm(title, description, confirmText, cancelText, danger = false) {
    return new Promise((resolve) => {
      // 按钮文案：未显式传入时取多语言默认值
      const okText = confirmText || modalT('roulette.modal.confirm', '确认');
      const noText = cancelText || modalT('roulette.modal.cancel', '取消');
      // 主按钮样式：危险操作红色(列4)，普通确认蓝色(列2)
      const primary = danger ? 'btn-column4' : 'btn-column2';
      const modal = open(`
        <div class="modal-title">${title}</div>
        <div class="modal-body">${description || ''}</div>
        <div class="modal-buttons" style="margin-top: 20px;">
          <button class="btn btn-column5" data-act="cancel">${noText}</button>
          <button class="btn ${primary}" data-act="ok">${okText}</button>
        </div>
      `);
      modal.el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'ok') { modal.close(); resolve(true); }
        else if (act === 'cancel' || e.target === modal.el) { modal.close(); resolve(false); }
      });
    });
  }

  /**
   * 表单弹窗（与弹窗.html的新建/重命名弹窗一致：标题 + modal-input 输入框 + 按钮区）
   * @param {Object} opts 配置项
   * @param {string} opts.title 弹窗标题
   * @param {Array} opts.fields 字段数组：{name, label, placeholder, value, type}
   * @param {Function} [opts.onSubmit] 提交回调，返回 false 可阻止关闭
   * @param {Function} [opts.onCancel] 取消回调
   * @param {string} [opts.okText='保存'] 确认按钮文字
   */
  function form({ title, fields, onSubmit, onCancel, okText }) {
    // 各字段直接渲染为 .modal-input（无 label，提示语用 placeholder 承载）
    const rows = fields.map(f => `
      <input id="fld-${f.name}" class="modal-input" type="${f.type || 'text'}"
             placeholder="${f.placeholder || f.label || ''}" value="${f.value || ''}">
    `).join('');
    const modal = open(`
      <div class="modal-title">${title}</div>
      ${rows}
      <div class="modal-buttons">
        <button class="btn btn-column5" data-act="cancel">${modalT('roulette.modal.cancel', '取消')}</button>
        <button class="btn btn-column2" data-act="ok">${okText || modalT('roulette.modal.save', '保存')}</button>
      </div>
    `);

    /** 收集所有字段当前值并执行提交 */
    function submit() {
      const values = {};
      fields.forEach(f => { values[f.name] = document.getElementById('fld-' + f.name).value; });
      if (onSubmit) {
        const ret = onSubmit(values);
        if (ret !== false) modal.close();
      } else modal.close();
    }

    // 输入框内按回车等价于点击确认
    fields.forEach(f => {
      const input = document.getElementById('fld-' + f.name);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });

    modal.el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') submit();
      else if (act === 'cancel' || e.target === modal.el) { modal.close(); onCancel && onCancel(); }
    });
    return modal;
  }

  return { open, confirm, form };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Modal;
window.Modal = Modal;
