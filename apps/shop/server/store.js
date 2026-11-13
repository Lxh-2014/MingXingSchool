/**
 * store.js —— 明星商店 JSON 存储层（替代原 Supabase 数据库）
 * ----------------------------------------------------------
 * 数据文件全部位于 apps/shop/data/ 下：
 *   shops.json      店铺列表
 *   products.json   商品列表
 *   carts.json      购物车（按 userId 分组：{ [userId]: [{productId, quantity}] }）
 *   orders.json     订单列表（上门取货模式，无收货地址）
 *
 * 设计要点：
 *   - 首次访问时自动建目录并写入种子数据，无需手工初始化
 *   - 写入采用「临时文件 + rename」原子替换，避免写一半断电导致 JSON 损坏
 *   - 读取带进程内缓存 + mtime 校验，外部改动文件后下一次读取能自动生效
 */
const fs = require('fs');
const path = require('path');

/** 数据目录：apps/shop/data */
const DATA_DIR = path.join(__dirname, '..', 'data');

/** 各数据文件绝对路径 */
const FILES = {
  shops: path.join(DATA_DIR, 'shops.json'),
  products: path.join(DATA_DIR, 'products.json'),
  carts: path.join(DATA_DIR, 'carts.json'),
  orders: path.join(DATA_DIR, 'orders.json')
};

/** 读取缓存：file → { mtime, data }，避免每次请求都重复解析 JSON */
const cache = new Map();

/** 确保数据目录存在 */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 生成短 ID：时间戳36进制 + 4位随机，够用且可读
 * @param {string} prefix ID 前缀（s=店铺 p=商品 o=订单）
 * @returns {string}
 */
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 读取一个 JSON 数据文件（带缓存与 mtime 热更新）
 * @param {'shops'|'products'|'carts'|'orders'} name 数据名
 * @param {*} fallback 文件不存在时的默认值
 * @returns {*}
 */
function read(name, fallback) {
  const file = FILES[name];
  if (!fs.existsSync(file)) {
    // 文件不存在：写种子并返回默认值
    ensureDir();
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
    // JSON 损坏：备份坏文件后返回默认值，保证服务不崩
    try { fs.copyFileSync(file, file + '.corrupt'); } catch (_) { /* 忽略备份失败 */ }
    write(name, fallback);
    return fallback;
  }
}

/**
 * 写入一个 JSON 数据文件（原子替换 + 刷新缓存）
 * @param {'shops'|'products'|'carts'|'orders'} name 数据名
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

// ============ 种子数据：首次启动自动填充，让商店开箱即用 ============

/** 种子店铺（4 家，覆盖常见分类；ownerId=Admin 表示平台自营店，仅管理员可管理） */
const SEED_SHOPS = [
  { id: 's01', ownerId: 'Admin', name: '文轩书屋', description: '教辅图书、文具用品一站购齐', category: '图书文具', isOpen: true },
  { id: 's02', ownerId: 'Admin', name: '馋嘴小铺', description: '课间解馋的健康零食', category: '零食饮品', isOpen: true },
  { id: 's03', ownerId: 'Admin', name: '活力运动城', description: '体育课必备装备与器材', category: '体育用品', isOpen: true },
  { id: 's04', ownerId: 'Admin', name: '生活杂货社', description: '纸巾、水杯等日常好物', category: '日用百货', isOpen: true }
];

/** 种子商品（每店 4 件；image 为空时前端用 emoji 占位） */
const SEED_PRODUCTS = [
  { id: 'p01', shopId: 's01', name: '田字格练习本', description: '语文作业标配，30 页装', price: 2.5, image: '', emoji: '📓', category: '文具', sales: 128, isAvailable: true },
  { id: 'p02', shopId: 's01', name: '中性笔 0.5mm', description: '黑色子弹头，顺滑不断墨', price: 3, image: '', emoji: '🖊️', category: '文具', sales: 260, isAvailable: true },
  { id: 'p03', shopId: 's01', name: '《城南旧事》', description: '七年级推荐阅读书目', price: 18, image: '', emoji: '📘', category: '图书', sales: 66, isAvailable: true },
  { id: 'p04', shopId: 's01', name: '便携订书机', description: '迷你款，含一盒订书钉', price: 8.8, image: '', emoji: '📌', category: '文具', sales: 45, isAvailable: true },
  { id: 'p05', shopId: 's02', name: '海苔卷', description: '独立小包装，8 支入', price: 5, image: '', emoji: '🍘', category: '零食', sales: 320, isAvailable: true },
  { id: 'p06', shopId: 's02', name: '全麦苏打饼干', description: '低糖配方，解饿不腻', price: 6.5, image: '', emoji: '🍪', category: '零食', sales: 210, isAvailable: true },
  { id: 'p07', shopId: 's02', name: '矿泉水 550ml', description: '校园直供，整箱更优惠', price: 2, image: '', emoji: '💧', category: '饮品', sales: 500, isAvailable: true },
  { id: 'p08', shopId: 's02', name: '纯牛奶 250ml', description: '课间加餐补充营养', price: 4, image: '', emoji: '🥛', category: '饮品', sales: 180, isAvailable: true },
  { id: 'p09', shopId: 's03', name: '跳绳（计数款）', description: '体测必备，自带计数器', price: 15, image: '', emoji: '🪢', category: '器材', sales: 95, isAvailable: true },
  { id: 'p10', shopId: 's03', name: '羽毛球（3 只装）', description: '稳定耐打，训练级', price: 12, image: '', emoji: '🏸', category: '器材', sales: 73, isAvailable: true },
  { id: 'p11', shopId: 's03', name: '护腕', description: '透气吸汗，运动防护', price: 9.9, image: '', emoji: '🧤', category: '护具', sales: 40, isAvailable: true },
  { id: 'p12', shopId: 's03', name: '足球 5 号', description: '标准 5 号球，耐磨皮面', price: 45, image: '', emoji: '⚽', category: '器材', sales: 28, isAvailable: true },
  { id: 'p13', shopId: 's04', name: '抽纸（便携装）', description: '3 层加厚，小包随身带', price: 3.5, image: '', emoji: '🧻', category: '日用', sales: 400, isAvailable: true },
  { id: 'p14', shopId: 's04', name: '保温水杯 500ml', description: '食品级不锈钢，早午读保温', price: 29, image: '', emoji: '🥤', category: '日用', sales: 58, isAvailable: true },
  { id: 'p15', shopId: 's04', name: '挂钩（免钉 6 只）', description: '宿舍/教室收纳好帮手', price: 6, image: '', emoji: '🪝', category: '日用', sales: 88, isAvailable: true },
  { id: 'p16', shopId: 's04', name: '雨伞（折叠款）', description: '五折超轻，书包里不占地方', price: 25, image: '', emoji: '☂️', category: '日用', sales: 35, isAvailable: true }
];

/** 初始化：目录 + 种子文件（幂等，已有文件不覆盖） */
function init() {
  ensureDir();
  if (!fs.existsSync(FILES.shops)) write('shops', SEED_SHOPS);
  if (!fs.existsSync(FILES.products)) write('products', SEED_PRODUCTS);
  if (!fs.existsSync(FILES.carts)) write('carts', {});
  if (!fs.existsSync(FILES.orders)) write('orders', []);
}

module.exports = { init, read, write, genId, DATA_DIR };
