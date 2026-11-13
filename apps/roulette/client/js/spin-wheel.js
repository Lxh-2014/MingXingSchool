/**
 * SpinWheel 转盘组件（纯 JS + Canvas）
 * 从 React 版 SpinWheel.tsx 1:1 搬运核心绘制与旋转算法
 *
 * 用法：
 *   const wheel = new SpinWheel({
 *     container: document.getElementById('wheel-root'),
 *     size: 400,
 *     fontSize: 'medium', // 'small' | 'medium' | 'large'
 *     options: ['A','B','C'],
 *     colors: ['#FFB84D','#FFD966','#FFA64D'],
 *     backgroundImage: '',
 *     backgroundColor: '',
 *   });
 *   wheel.render();
 *   wheel.spin({ optionIndex: 2, onDone: (result) => ... });
 */

/**
 * 取多语言文案：i18n 框架未加载时回退中文兜底
 * @param {string} key 语言包键（如 roulette.spinWheel.noOptions）
 * @param {string} fallback 中文兜底文案
 * @returns {string} 最终展示文案
 */
function swT(key, fallback) {
  return (window.I18n && window.I18n.t) ? window.I18n.t(key, null, fallback) : (fallback || key);
}

/**
 * 加密级随机数：返回 [0, 1) 区间浮点数
 * 使用 crypto.getRandomValues() 替代 Math.random()，防止结果被预测
 * @returns {number}
 */
function _secureRandom() {
  const arr = new Uint32Array(1);
  window.crypto.getRandomValues(arr);
  return arr[0] / 4294967296;  // 除以 2^32，映射到 [0, 1)
}

class SpinWheel {
  /**
   * @param {object} opts
   */
  constructor(opts = {}) {
    this.container = opts.container;
    this.size = opts.size || 400;
    this.fontSize = opts.fontSize || 'medium';
    this.options = opts.options || [];
    this.colors = opts.colors || this._defaultColors(this.options.length);
    this.backgroundImage = opts.backgroundImage || '';
    this.backgroundColor = opts.backgroundColor || '';
    this.rotation = 0;
    this.spinning = false;

    this._buildDOM();
    this._bindWheel();
  }

  /** 构建 DOM 结构 */
  _buildDOM() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wheel-wrapper';
    wrap.style.width = (this.size + 60) + 'px';
    wrap.style.height = (this.size + 60) + 'px';
    // 背景图由页面 body 统一铺满，转盘容器保持透明透出页面背景
    if (!this.backgroundImage && this.backgroundColor) wrap.style.backgroundColor = this.backgroundColor;

    // 指针
    const pointer = document.createElement('div');
    pointer.className = 'wheel-pointer';
    wrap.appendChild(pointer);

    // 转盘旋转层
    const rotator = document.createElement('div');
    rotator.className = 'wheel-canvas-wrap';
    rotator.style.width = this.size + 'px';
    rotator.style.height = this.size + 'px';
    this.rotator = rotator;
    wrap.appendChild(rotator);

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.width = this.size;
    canvas.height = this.size;
    canvas.className = 'drop-shadow-2xl';
    this.canvas = canvas;
    rotator.appendChild(canvas);

    this.container.appendChild(wrap);
  }

  /** 生成默认配色 */
  _defaultColors(count) {
    const palette = ['#FFB84D', '#FFD966', '#FFA64D', '#FFE699', '#FF9933', '#FFEB99'];
    const out = [];
    for (let i = 0; i < count; i++) out.push(palette[i % palette.length]);
    return out;
  }

  /** 字体配置 */
  _fontConfig() {
    switch (this.fontSize) {
      case 'small': return { size: 12, spacing: 14 };
      case 'large': return { size: 18, spacing: 20 };
      default: return { size: 14, spacing: 16 };
    }
  }

  /** Canvas 手绘 */
  _bindWheel() {
    const ctx = this.canvas.getContext('2d');
    const { size } = this;
    const centerX = size / 2;
    const centerY = size / 2;
    const radius = size / 2 - 20;
    const anglePer = (2 * Math.PI) / Math.max(this.options.length, 1);
    const font = this._fontConfig();

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(-Math.PI / 2); // 第一个选项从顶部开始

    this.options.forEach((option, i) => {
      const start = i * anglePer;
      const end = start + anglePer;
      // 扇形
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = this.colors[i % this.colors.length];
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.stroke();

      // 纵向文字
      ctx.save();
      const mid = start + anglePer / 2;
      ctx.rotate(mid);
      ctx.fillStyle = '#000000';
      ctx.font = `bold ${font.size}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.save();
      const textRadius = radius * 0.65;
      ctx.translate(textRadius, 0);
      ctx.rotate(Math.PI / 2);
      const chars = String(option).split('');
      const charHeight = font.spacing;
      const total = (chars.length - 1) * charHeight;
      const startY = -total / 2;
      chars.forEach((ch, ci) => ctx.fillText(ch, 0, startY + ci * charHeight));
      ctx.restore();
      ctx.restore();
    });

    // 外圈描边
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#FFB84D';
    ctx.lineWidth = 8;
    ctx.stroke();

    // 中心圆
    ctx.beginPath();
    ctx.arc(0, 0, 40, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#FFB84D';
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, 2 * Math.PI);
    ctx.fillStyle = '#FFB84D';
    ctx.fill();

    ctx.restore();
  }

  /** 刷新 */
  render() { this._bindWheel(); this._applyRotation(); }

  _applyRotation() {
    this.rotator.style.transform = `rotate(${this.rotation}deg)`;
  }

  /**
   * 开始转动
   * @param {{optionIndex?: number, onDone?: (result:string)=>void}} opts
   */
  spin(opts = {}) {
    if (this.spinning) return;
    if (!this.options.length) { alert(swT('roulette.spinWheel.noOptions', '转盘没有选项')); return; }

    this.spinning = true;
    const randomIndex = opts.optionIndex !== undefined
      ? opts.optionIndex
      : Math.floor(_secureRandom() * this.options.length);

    const segment = 360 / this.options.length;
    const targetAngle = randomIndex * segment + segment / 2;
    const baseRotation = 360 * 5;                 // 至少 5 圈
    const extraRotation = _secureRandom() * 360;   // 悬念
    const finalRotation = baseRotation + extraRotation + (360 - targetAngle);
    this.rotation += finalRotation;
    this._applyRotation();

    setTimeout(() => {
      this.spinning = false;
      const result = this.options[randomIndex];
      opts.onDone && opts.onDone(result, randomIndex);
    }, 5000);
  }

  /** 更新数据并重绘 */
  setOptions(options) {
    this.options = options;
    this.render();
  }
  setColors(colors) {
    this.colors = colors || this._defaultColors(this.options.length);
    this.render();
  }
  setFontSize(size) {
    this.fontSize = size;
    this.render();
  }
  setBackground(bgImage, bgColor) {
    this.backgroundImage = bgImage || '';
    this.backgroundColor = bgColor || '';
    this._buildDOM();
    this._bindWheel();
    this._applyRotation();
  }
}

// 导出到全局
window.SpinWheel = SpinWheel;
