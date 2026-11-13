/**
 * api.js —— 明星商店全部业务接口（挂载于 /shop/api）
 * ----------------------------------------------------------
 * 认证：复用主平台会话（cookie token → server/core/sessions），
 *       主入口 requireLogin 已拦截未登录访问，这里再兜底 requireAuth。
 * 角色：管理员判断复用 userStore.isAdminId（与门户/用户管理一致）。
 * 响应：统一 { ok:true, data } / { ok:false, error:{ code, message } }（与广播器风格一致）。
 *
 * 端点总览：
 *   店铺    GET /shops(?mine=1)  GET /shops/:id          POST(开店)/PUT/DELETE /shops（店主本人或管理员）
 *   商品    GET /products  GET /products?shopId=  POST/PUT/DELETE /products（店主本人或管理员）
 *   购物车  GET /cart  POST /cart  PUT /cart/:productId  DELETE /cart
 *   订单    POST /orders(上门取货，无地址)  GET /orders  GET /orders/:id  POST /orders/:id/cancel  POST /orders/:id/refund
 *   管理    PUT /admin/orders/:id/status  PUT /admin/orders/:id/refund  GET /admin/stats
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// 平台核心模块（require 缓存保证与主应用是同一实例，共享登录态）
// 路径说明：routes → server(shop) → shop → apps → 项目根，再进 server/core
const sessions = require('../../../../server/core/sessions');
const userStore = require('../../../../server/core/userStore');
const mailer = require('../../../../server/core/mailer');
const store = require('../store');

/** 订单状态流转白名单（管理端可设置的目标状态） */
const ORDER_STATUSES = ['pending', 'confirmed', 'delivering', 'completed', 'cancelled'];

store.init();   // 首次加载时建目录、写种子

// ============ 通用中间件 ============

/**
 * 登录校验：从 cookie 解析当前用户，失败返回 401
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
  // 兼容两种令牌来源：网页端 cookie、原生客户端 Authorization: Bearer
  const token = sessions.getTokenFromRequest(req);
  const userId = token ? sessions.getUserId(token) : undefined;
  if (!userId) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '未登录或登录已过期' } });
  }
  req.userId = userId;                                   // 后续处理器直接取用
  req.isAdmin = userStore.isAdminId(userId);             // 角色标记
  next();
}

/** 管理员校验：非 admin 返回 403 */
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
  }
  next();
}

router.use(requireAuth);   // 全部接口都需要登录（未登录在挂载层已被重定向到统一登录页）

/** 统一成功返回：{ok:true, data} */
const ok = (res, data) => res.json({ ok: true, data });

/**
 * GET /me 当前登录用户信息
 * 供顶栏展示昵称与积分（下单、改分后前端会重新拉取），字段与门户 /api/me 保持一致
 */
router.get('/me', (req, res) => {
  const user = userStore.getUserById(req.userId);
  if (!user) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '未登录或登录已过期' } });
  }
  ok(res, {
    loggedIn: true,
    id: req.userId,
    name: user.name,
    points: user.points ?? 0,
    isAdmin: req.isAdmin
  });
});

/** 图片上传目录：apps/shop/data/uploads（与 shops.json 等数据同层，便于一起备份） */
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

/** 允许上传的图片 MIME 子类型（base64 前缀里的 image/xxx） */
const ALLOWED_IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** 单张图片体积上限（字节）：前端已压缩到 ~1000px，1.5MB 足够，且不超 JSON 请求体 2MB 上限 */
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * POST /upload/image —— 上传商品图片（base64 DataURL 方式）
 * 请求体：{ dataUrl: 'data:image/jpeg;base64,...' }
 * 返回：{ ok:true, data:{ url: '/shop/uploads/xxx.jpg' } }
 * 说明：文件名用「时间戳 + 随机串」保证唯一，避免并发上传互相覆盖
 */
router.post('/upload/image', (req, res) => {
  const dataUrl = req.body && req.body.dataUrl;                 // 前端压缩后的 base64 数据
  const match = typeof dataUrl === 'string'
    ? dataUrl.match(/^data:image\/([a-zA-Z]+);base64,([\s\S]+)$/)  // 拆出格式与数据体
    : null;
  if (!match) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_IMAGE', message: '图片格式不支持，请选择 JPG/PNG/GIF/WEBP' } });
  }

  const rawType = match[1].toLowerCase();                      // 原始 MIME 子类型
  if (ALLOWED_IMAGE_TYPES.indexOf(rawType) < 0) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_IMAGE', message: '图片格式不支持，请选择 JPG/PNG/GIF/WEBP' } });
  }
  const ext = rawType === 'jpeg' ? 'jpg' : rawType;            // 统一 jpg 扩展名

  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');                  // 解码后的图片二进制
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_IMAGE', message: '图片数据解析失败' } });
  }
  if (buffer.length === 0) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_IMAGE', message: '图片内容为空' } });
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ ok: false, error: { code: 'TOO_LARGE', message: '图片过大（超过 4MB），请压缩后再上传' } });
  }

  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const fileName = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;  // 唯一文件名
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
    ok(res, { url: '/shop/uploads/' + fileName });
  } catch (e) {
    res.status(500).json({ ok: false, error: { code: 'SAVE_FAILED', message: '图片保存失败：' + e.message } });
  }
});

// ============ 店铺 ============

/**
 * 归属校验：管理员可管理一切；普通用户只能管理 ownerId 为自己的店铺
 * @param {object} req 经 requireAuth 注入的请求对象（含 userId/isAdmin）
 * @param {object} shop 店铺对象
 * @returns {boolean}
 */
function canManageShop(req, shop) {
  return req.isAdmin || (!!shop && shop.ownerId === req.userId);
}

/** GET /shops 店铺列表（支持 ?q= 名称搜索、?mine=1 只看我开设的）
 *  普通用户：营业中店铺 + 自己开设的（含休息中）；管理员：全部 */
router.get('/shops', (req, res) => {
  let shops = store.read('shops', []);
  if (req.query.mine === '1') {
    shops = shops.filter(s => s.ownerId === req.userId || (req.isAdmin && !s.ownerId));
    return ok(res, shops);
  }
  if (!req.isAdmin) {
    shops = shops.filter(s => (s.isOpen && !s.seized) || s.ownerId === req.userId);   // 自己的店休息中/查封后也要可见
  }
  const q = (req.query.q || '').trim();
  if (q) shops = shops.filter(s => s.name.includes(q) || (s.description || '').includes(q));
  ok(res, shops);
});

/** GET /shops/:id 店铺详情 */
router.get('/shops/:id', (req, res) => {
  const shop = store.read('shops', []).find(s => s.id === req.params.id);
  if (!shop) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '店铺不存在' } });
  ok(res, shop);
});

/**
 * 校验/规整店铺字段：只保留白名单字段并补默认值
 * @param {object} body 请求体
 * @returns {object} 规整后的店铺对象
 */
function pickShop(body) {
  return {
    id: body.id,                                           // 编辑时保留原 id
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    category: String(body.category || '综合').trim(),
    image: String(body.image || '').trim(),
    emoji: String(body.emoji || '🏬').trim(),
    isOpen: body.isOpen !== false                          // 缺省视为营业中
  };
}

/** POST /shops 新建店铺（所有登录用户可开店，归属创建者本人） */
router.post('/shops', (req, res) => {
  const shops = store.read('shops', []);
  const shop = pickShop(req.body || {});
  if (!shop.name) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '店铺名称不能为空' } });
  shop.id = store.genId('s');
  shop.ownerId = req.userId;                             // 归属权：创建者本人
  shop.seized = false;                                   // 新店默认未查封
  shop.seizeInfo = null;                                 // 查封记录（违规问题/整改期限等）
  shops.push(shop);
  store.write('shops', shops);
  ok(res, shop);
});

/** PUT /shops/:id 修改店铺（店主本人或管理员） */
router.put('/shops/:id', (req, res) => {
  const shops = store.read('shops', []);
  const idx = shops.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '店铺不存在' } });
  if (!canManageShop(req, shops[idx])) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只有店主本人或管理员可以修改店铺' } });
  }
  const shop = pickShop(Object.assign({}, shops[idx], req.body));
  shop.id = shops[idx].id;                               // id 不允许修改
  shop.ownerId = shops[idx].ownerId;                     // 归属权不允许转让
  shop.seized = shops[idx].seized === true;              // 查封状态沿用原值（编辑资料不得解封）
  shop.seizeInfo = shops[idx].seizeInfo || null;         // 查封记录沿用原值
  if (!shop.name) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '店铺名称不能为空' } });
  shops[idx] = shop;
  store.write('shops', shops);
  ok(res, shop);
});

/** DELETE /shops/:id 删除店铺（店主本人或管理员）：连带下架其全部商品，购物车同步清理 */
router.delete('/shops/:id', (req, res) => {
  const shops = store.read('shops', []);
  const idx = shops.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '店铺不存在' } });
  if (!canManageShop(req, shops[idx])) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只有店主本人或管理员可以删除店铺' } });
  }

  // 收集被删店铺的商品 id，用于清理购物车残留
  const products = store.read('products', []);
  const removedProductIds = new Set(products.filter(p => p.shopId === req.params.id).map(p => p.id));
  store.write('products', products.filter(p => p.shopId !== req.params.id));

  // 清理所有用户购物车里已不存在的商品
  const carts = store.read('carts', {});
  for (const uid of Object.keys(carts)) {
    carts[uid] = (carts[uid] || []).filter(item => !removedProductIds.has(item.productId));
  }
  store.write('carts', carts);

  shops.splice(idx, 1);
  store.write('shops', shops);
  ok(res, { deleted: true });
});

/**
 * POST /admin/shops/:id/seize —— 管理员查封店铺并发送《限期整改告知》
 * 请求体：{ grade, className, deadline, issues: string[] }
 * 行为：店铺置为查封（停止营业）→ 向店主绑定邮箱发送整改通知（未绑定/发送失败不影响查封）
 * 返回：店铺对象 + mailNotice（邮件发送结果文案）
 */
router.post('/admin/shops/:id/seize', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const shops = store.read('shops', []);
  const idx = shops.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '店铺不存在' } });

  const grade = String(body.grade || '').trim();               // 学生年级
  const className = String(body.className || '').trim();       // 学生班级
  const deadline = String(body.deadline || '').trim();         // 整改截止时间
  const issues = (Array.isArray(body.issues) ? body.issues : [])
    .map(s => String(s || '').trim())
    .filter(Boolean);                                          // 违规问题（至少一条）
  if (!grade || !className) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '请填写年级和班级' } });
  if (!deadline) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '请选择整改截止时间' } });
  if (!issues.length) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '请至少填写一条违规问题' } });

  const shop = shops[idx];
  shop.seized = true;                                          // 标记查封
  shop.seizedAt = new Date().toISOString();                    // 查封时间
  shop.isOpen = false;                                         // 查封期间停止营业
  shop.seizeInfo = { grade, className, deadline, issues, at: shop.seizedAt };   // 查封记录（店主可见整改要求）
  store.write('shops', shops);

  /* 发送整改通知：失败不阻断查封，通过 mailNotice 回传给管理员 */
  let mailNotice = '';
  const owner = userStore.getUserById(shop.ownerId) || {};      // 店主用户记录
  const ownerName = owner.name || shop.ownerId || '同学';       // 店主姓名
  const binding = mailer.getBinding(shop.ownerId);              // 店主绑定邮箱
  if (!binding.email) {
    mailNotice = '店主尚未绑定邮箱，未发送整改通知';
  } else {
    try {
      const mail = mailer.buildRectifyMail({ name: ownerName, shopName: shop.name, grade, className, issues, deadline });
      await mailer.sendMail({ to: binding.email, subject: mail.subject, text: mail.text });
      mailNotice = '整改通知已发送至 ' + binding.email;
    } catch (e) {
      mailNotice = '整改通知发送失败：' + (e.message || '未知错误');
    }
  }

  ok(res, Object.assign({}, shop, { mailNotice }));
});

/**
 * POST /admin/shops/:id/unseize —— 管理员解封店铺（清除查封记录，营业状态由管理员再切换）
 */
router.post('/admin/shops/:id/unseize', requireAdmin, (req, res) => {
  const shops = store.read('shops', []);
  const shop = shops.find(s => s.id === req.params.id);
  if (!shop) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '店铺不存在' } });
  shop.seized = false;                                         // 解除查封
  shop.seizeInfo = null;                                       // 清除查封记录
  delete shop.seizedAt;
  store.write('shops', shops);
  ok(res, shop);
});

// ============ 商品 ============

/**
 * 商品列表：支持 ?shopId= 按店铺过滤、?q= 名称搜索
 * 普通用户只看到在售（isAvailable）商品；店主看自己店铺时可见下架商品；管理员可见全部
 */
router.get('/products', (req, res) => {
  let products = store.read('products', []);
  const shopId = req.query.shopId || '';
  const q = (req.query.q || '').trim();
  if (shopId) products = products.filter(p => p.shopId === shopId);
  if (q) products = products.filter(p => p.name.includes(q));
  if (!req.isAdmin) {
    // 带 shopId 且是店主本人的：不过滤下架商品（便于店铺管理）；否则只看在售
    let ownerView = false;
    if (shopId) {
      const shop = store.read('shops', []).find(s => s.id === shopId);
      ownerView = canManageShop(req, shop);
    }
    if (!ownerView) products = products.filter(p => p.isAvailable);
  }
  ok(res, products);
});

/**
 * 规整选项数组：去掉空 label，priceDelta 保留两位小数
 * 规格与套餐共用同一套选项结构，避免两份实现漂移
 * @param {Array} options 原始选项数组
 * @returns {Array<{label:string, priceDelta:number}>}
 */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .filter(o => o && typeof o.label === 'string' && o.label.trim())
    .map(o => ({
      label: o.label.trim(),
      priceDelta: Math.round((Number(o.priceDelta) || 0) * 100) / 100
    }));
}

/**
 * 校验/规整商品规格（美团式多规格：多组规格 × 每组多选项 × 每项价格加成）
 * specs 结构：[{ name: "口味", required: true, options: [{ label: "原味", priceDelta: 0 }, ...] }]
 * - 空/null specs 视为「无规格商品」，直接用 base price
 * - 有 specs 的商品，规格组合最终价格 = base price + 各选项 priceDelta 之和
 */
function normalizeSpecs(raw) {
  if (!Array.isArray(raw)) return null;
  const result = [];
  for (const group of raw) {
    if (!group || typeof group.name !== 'string' || !group.name.trim()) continue;
    const normOpts = normalizeOptions(group.options);
    if (normOpts.length === 0) continue;
    result.push({
      name: group.name.trim(),
      required: group.required !== false,            // 缺省必选
      options: normOpts
    });
  }
  return result.length > 0 ? result : null;
}

/**
 * 校验/规整套餐分组（美团式：每组设固定件数，同一选项可重复选）
 * comboGroups 结构：[{ name: "主食", count: 1, options: [{ label, priceDelta }] }]
 * - count 固定件数（买家在该组需恰好选 count 件；0 表示该组可不选）
 * - 兼容旧数据：没有 count 时回退读取 minSelect
 * - 无有效选项的组自动丢弃
 * @param {Array} raw 原始套餐分组
 * @returns {Array|null} 规整后的分组；无有效分组返回 null
 */
function normalizeComboGroups(raw) {
  if (!Array.isArray(raw)) return null;
  const result = [];
  for (const group of raw) {
    if (!group || typeof group.name !== 'string' || !group.name.trim()) continue;
    const normOpts = normalizeOptions(group.options);
    if (normOpts.length === 0) continue;

    let count = parseInt(group.count, 10);
    if (!Number.isFinite(count)) count = parseInt(group.minSelect, 10);   // 兼容旧版 min/max 数据
    if (!Number.isFinite(count) || count < 0) count = 1;
    count = Math.min(count, 20);

    result.push({
      name: group.name.trim(),
      count,
      options: normOpts
    });
  }
  return result.length > 0 ? result : null;
}

/**
 * 规整用户提交的套餐选择：只保留有组名/选项名的条目，件数限制 1~20
 * @param {Array} raw 前端提交的 combo 数组
 * @returns {Array<{groupName:string, label:string, count:number}>}
 */
function normalizeComboSelections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(s => s && typeof s.groupName === 'string' && typeof s.label === 'string')
    .map(s => ({
      groupName: s.groupName.trim(),
      label: s.label.trim(),
      count: Math.max(1, Math.min(20, parseInt(s.count, 10) || 1))
    }))
    .filter(s => s.groupName && s.label);
}

/**
 * 计算套餐最终单价：套餐价 + Σ(选项加价 × 件数)
 * 同时校验每组件数是否等于该组固定件数、选项是否存在
 * @param {object} product 商品（含 price + comboGroups）
 * @param {Array<{groupName:string,label:string,count:number}>} selections 用户所选套餐明细
 * @returns {number} 最终单价
 */
function computeComboPrice(product, selections) {
  const groups = Array.isArray(product.comboGroups) ? product.comboGroups : null;
  if (!groups) return product.price;

  let delta = 0;
  for (const s of selections) {
    const group = groups.find(g => g.name === s.groupName);
    if (!group) throw new Error('套餐分组「' + s.groupName + '」不存在');
    const opt = group.options.find(o => o.label === s.label);
    if (!opt) throw new Error('套餐选项「' + s.label + '」已下架');
    delta += opt.priceDelta * s.count;
  }
  for (const g of groups) {
    const total = selections
      .filter(s => s.groupName === g.name)
      .reduce((n, s) => n + s.count, 0);
    if (total !== g.count) throw new Error('「' + g.name + '」需选 ' + g.count + ' 件');
  }
  return Math.round((product.price + delta) * 100) / 100;
}

/**
 * 套餐选择文本（购物车/订单展示用），按组聚合，如："主食：牛肉面×1；饮品：可乐×2"
 * @param {Array<{groupName:string,label:string,count:number}>} selections 套餐明细
 * @returns {string}
 */
function joinComboText(selections) {
  if (!Array.isArray(selections) || selections.length === 0) return '';
  const order = [];                              // 分组首次出现顺序，保证展示稳定
  const map = new Map();                         // groupName → 该组选择明细
  for (const s of selections) {
    if (!map.has(s.groupName)) { map.set(s.groupName, []); order.push(s.groupName); }
    map.get(s.groupName).push(s);
  }
  return order.map(g => g + '：' + map.get(g).map(s => s.label + '×' + s.count).join('、')).join('；');
}

/**
 * 套餐购物车行身份 key：productId + 规范化选择串
 * 选择相同的套餐合并为同一行，任一选项/件数不同则拆行
 * @param {string} productId 商品 id
 * @param {Array} selections 套餐明细
 * @returns {string}
 */
function comboLineKey(productId, selections) {
  const canonical = selections
    .map(s => s.groupName + ':' + s.label + ':' + s.count)
    .sort()
    .join(',');
  return productId + '|c|' + canonical;
}

/**
 * 计算规格组合的最终单价
 * @param {object} product 商品（含 price + specs）
 * @param {Array} specLabels 用户所选规格选项的 label 数组
 * @returns {number} 最终单价
 */
function computeSpecPrice(product, specLabels) {
  if (!product.specs || !Array.isArray(specLabels)) return product.price;
  let delta = 0;
  for (const group of product.specs) {
    const picked = specLabels.find(l => {
      const opt = group.options.find(o => o.label === l);
      if (opt) { delta += opt.priceDelta; return true; }
      return false;
    });
    if (!picked && group.required) {
      throw new Error('规格组「' + group.name + '」未选择');
    }
  }
  return Math.round((product.price + delta) * 100) / 100;
}

/** 规格选项标签拼接（购物车/订单展示用），如："大份/加冰" */
function joinSpecText(specLabels) {
  if (!Array.isArray(specLabels) || specLabels.length === 0) return '';
  return specLabels.filter(Boolean).join('/');
}

/**
 * 购物车行身份 key：productId + specText 联合
 * 同一商品选不同规格 → 不同 key → 不同购物车行
 */
function cartLineKey(productId, specText) {
  return productId + (specText ? '|' + specText : '');
}

/**
 * 校验/规整商品字段
 * @param {object} body 请求体
 * @returns {object}
 */
function pickProduct(body) {
  const price = Number(body.price);
  return {
    id: body.id,
    shopId: String(body.shopId || ''),
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    price: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : 0,
    image: String(body.image || '').trim(),
    emoji: String(body.emoji || '🛒').trim(),
    category: String(body.category || '其他').trim(),
    isAvailable: body.isAvailable !== false,                // 缺省视为在售
    /* 套餐与规格互斥：套餐商品按分组任选件数计价，普通商品按规格单选加价 */
    isCombo: body.isCombo === true,
    comboGroups: body.isCombo === true ? normalizeComboGroups(body.comboGroups) : null,
    specs: body.isCombo === true ? null : normalizeSpecs(body.specs)   // null 表示无规格（直接加购）
  };
}

/**
 * 套餐合法性校验：开启套餐但没有任何有效分组时拒绝保存
 * @param {object} product 规整后的商品
 * @returns {string|null} 错误文案；合法返回 null
 */
function validateCombo(product) {
  if (product.isCombo && (!product.comboGroups || product.comboGroups.length === 0)) {
    return '套餐至少需要一个分组（含组名和至少一个选项）';
  }
  return null;
}

/** POST /products 新建商品（店主本人或管理员，校验目标店铺归属） */
router.post('/products', (req, res) => {
  const products = store.read('products', []);
  const product = pickProduct(req.body || {});
  if (!product.name) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '商品名称不能为空' } });
  const comboError = validateCombo(product);
  if (comboError) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: comboError } });
  const shop = store.read('shops', []).find(s => s.id === product.shopId);
  if (!shop) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '所属店铺不存在' } });
  if (!canManageShop(req, shop)) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只能往自己开设的店铺上架商品' } });
  }
  product.id = store.genId('p');
  product.sales = 0;                                       // 销量从 0 起步
  products.push(product);
  store.write('products', products);
  ok(res, product);
});

/** PUT /products/:id 修改商品（商品所属店铺的店主本人或管理员） */
router.put('/products/:id', (req, res) => {
  const products = store.read('products', []);
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '商品不存在' } });
  const shop = store.read('shops', []).find(s => s.id === products[idx].shopId);
  if (!canManageShop(req, shop)) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只能管理自己店铺的商品' } });
  }
  const product = pickProduct(Object.assign({}, products[idx], req.body));
  product.id = products[idx].id;                           // id 不允许修改
  product.sales = products[idx].sales || 0;                // 销量不允许直接改
  if (!product.name) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '商品名称不能为空' } });
  const comboError = validateCombo(product);
  if (comboError) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: comboError } });
  products[idx] = product;
  store.write('products', products);
  ok(res, product);
});

/** DELETE /products/:id 删除商品（商品所属店铺的店主本人或管理员）：同步清理购物车 */
router.delete('/products/:id', (req, res) => {
  const products = store.read('products', []);
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '商品不存在' } });
  const shop = store.read('shops', []).find(s => s.id === products[idx].shopId);
  if (!canManageShop(req, shop)) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只能管理自己店铺的商品' } });
  }

  const carts = store.read('carts', {});
  for (const uid of Object.keys(carts)) {
    carts[uid] = (carts[uid] || []).filter(item => item.productId !== req.params.id);
  }
  store.write('carts', carts);

  products.splice(idx, 1);
  store.write('products', products);
  ok(res, { deleted: true });
});

// ============ 购物车（按登录用户隔离） ============

/**
 * 组装购物车视图：把 {productId, specLabels, unitPrice, quantity} 关联上商品与店铺信息，
 * 已下架/已删除的商品自动剔除
 * @param {string} userId 用户 ID
 * @returns {{items: Array, totalAmount: number, count: number}}
 */
function buildCartView(userId) {
  const carts = store.read('carts', {});
  const rawItems = carts[userId] || [];
  const products = store.read('products', []);
  const shops = store.read('shops', []);

  const items = [];
  for (const raw of rawItems) {
    const product = products.find(p => p.id === raw.productId);
    if (!product || !product.isAvailable) continue;       // 失效商品不进视图
    const shop = shops.find(s => s.id === product.shopId);
    if (shop && shop.seized) continue;                    // 查封店铺的商品不进入购物车视图（暂停营业）
    items.push({
      lineKey: raw.lineKey,                               // 购物车行唯一标识（productId|specText）
      productId: product.id,
      name: product.name,
      basePrice: product.price,                           // 商品原价（给前端展示用）
      unitPrice: raw.unitPrice != null ? raw.unitPrice : product.price,  // 该行实际单价（可能含规格加价）
      specText: raw.specText || '',                       // 规格文本，如 "大份/加冰"
      specLabels: raw.specLabels || [],                   // 所选规格 label 数组
      isCombo: !!product.isCombo,                         // 是否套餐商品
      comboSelections: raw.comboSelections || [],         // 套餐明细 [{groupName,label,count}]
      comboText: raw.comboText || '',                     // 套餐展示文本
      emoji: product.emoji,
      image: product.image,
      quantity: raw.quantity,
      shopId: product.shopId,
      shopName: shop ? shop.name : '未知店铺',
      hasSpecs: Array.isArray(product.specs) && product.specs.length > 0
    });
  }
  const totalAmount = Math.round(items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0) * 100) / 100;
  const count = items.reduce((sum, it) => sum + it.quantity, 0);
  return { items, totalAmount, count };
}

/** GET /cart 当前用户购物车 */
router.get('/cart', (req, res) => ok(res, buildCartView(req.userId)));

/**
 * POST /cart 加入购物车 {productId, specs?, combo?, quantity?}
 * - specs: 普通商品所选规格 label 数组，如 ["辣味","大份"]
 * - combo: 套餐商品所选明细，如 [{groupName:"主食",label:"牛肉面",count:1}, ...]
 * 普通商品用 productId + specText 做 identity；套餐商品用 productId + 规范化套餐选择串
 */
router.post('/cart', (req, res) => {
  const body = req.body || {};
  const productId = String(body.productId || '');
  const quantity = Math.max(1, Math.min(99, parseInt(body.quantity, 10) || 1));
  const specLabels = Array.isArray(body.specs) ? body.specs.map(s => String(s).trim()).filter(Boolean) : [];

  const products = store.read('products', []);
  const product = products.find(p => p.id === productId && p.isAvailable);
  if (!product) return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '商品不存在或已下架' } });

  /* 查封店铺暂停营业：禁止加购 */
  const shop = store.read('shops', []).find(s => s.id === product.shopId);
  if (shop && shop.seized) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '该店铺已被查封，暂时无法购买' } });
  }

  let lineKey;                                           // 购物车行唯一标识
  let unitPrice;                                         // 该行实际单价
  let specText = '';                                     // 规格展示文本
  let specsToUse = [];                                   // 实际采用的规格 label
  let comboSelections = [];                              // 套餐明细
  let comboText = '';                                    // 套餐展示文本

  if (product.isCombo) {
    /* 套餐：校验各组件数是否选够，价格 = 套餐价 + 选项加价 × 件数 */
    comboSelections = normalizeComboSelections(body.combo);
    try { unitPrice = computeComboPrice(product, comboSelections); }
    catch (e) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: e.message } });
    }
    comboText = joinComboText(comboSelections);
    lineKey = comboLineKey(productId, comboSelections);
  } else {
    /* 普通商品：有 specs 必须选全，无 specs 忽略传入的规格 */
    specsToUse = specLabels;
    if (Array.isArray(product.specs) && product.specs.length > 0) {
      const missing = product.specs.filter(g => g.required && !specLabels.some(l => g.options.some(o => o.label === l)));
      if (missing.length > 0) {
        return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '请选择完整规格' } });
      }
    } else {
      specsToUse = [];                                   // 无规格商品强制清空
    }
    try { unitPrice = computeSpecPrice(product, specsToUse); }
    catch (e) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: e.message } });
    }
    specText = joinSpecText(specsToUse);
    lineKey = cartLineKey(productId, specText);
  }

  const carts = store.read('carts', {});
  const list = carts[req.userId] || [];
  const existing = list.find(item => item.lineKey === lineKey);
  if (existing) {
    existing.quantity = Math.min(99, existing.quantity + quantity);
  } else {
    list.push({
      lineKey,
      productId,
      specText,
      specLabels: specsToUse,
      comboSelections,
      comboText,
      unitPrice,
      quantity
    });
  }
  carts[req.userId] = list;
  store.write('carts', carts);
  ok(res, buildCartView(req.userId));
});

/**
 * PUT /cart/line/:lineKey 设置数量 {quantity}
 * quantity <= 0 视为移除该行
 * 用 lineKey（productId|specText）定位购物车行，解决多规格下 productId 不唯一的问题
 */
router.put('/cart/line/:lineKey', (req, res) => {
  const quantity = parseInt((req.body || {}).quantity, 10);
  if (!Number.isFinite(quantity)) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '数量格式不正确' } });
  }
  const carts = store.read('carts', {});
  const list = carts[req.userId] || [];
  const filtered = quantity <= 0
    ? list.filter(item => item.lineKey !== req.params.lineKey)
    : list.map(item => item.lineKey === req.params.lineKey
      ? Object.assign({}, item, { quantity: Math.min(99, quantity) })
      : item);
  carts[req.userId] = filtered;
  store.write('carts', carts);
  ok(res, buildCartView(req.userId));
});

/**
 * PUT /cart/:productId 兼容旧接口（无规格商品的快捷改量）
 * 自动找到该 productId 的唯一一行（有多行规格时返回错误提示前端改用 lineKey 接口）
 */
router.put('/cart/:productId', (req, res) => {
  const carts = store.read('carts', {});
  const list = carts[req.userId] || [];
  const matches = list.filter(item => item.productId === req.params.productId);
  if (matches.length === 0) {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '购物车中没有该商品' } });
  }
  if (matches.length > 1) {
    return res.status(400).json({ ok: false, error: { code: 'SPEC_REQUIRED', message: '该商品有多种规格，请使用 lineKey 接口' } });
  }
  req.params.lineKey = matches[0].lineKey;
  // 直接复用上面的 lineKey 处理器逻辑
  const quantity = parseInt((req.body || {}).quantity, 10);
  if (!Number.isFinite(quantity)) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '数量格式不正确' } });
  }
  const filtered = quantity <= 0
    ? list.filter(item => item.lineKey !== matches[0].lineKey)
    : list.map(item => item.lineKey === matches[0].lineKey
      ? Object.assign({}, item, { quantity: Math.min(99, quantity) })
      : item);
  carts[req.userId] = filtered;
  store.write('carts', carts);
  ok(res, buildCartView(req.userId));
});

/** DELETE /cart 清空当前用户购物车 */
router.delete('/cart', (req, res) => {
  const carts = store.read('carts', {});
  carts[req.userId] = [];
  store.write('carts', carts);
  ok(res, buildCartView(req.userId));
});

// ============ 订单 ============

/** 订单状态中文映射（前端展示用，后端只存英文枚举；delivering=待取货，无配送环节；refunded=退款完成） */
const STATUS_TEXT = {
  pending: '待确认', confirmed: '已确认', delivering: '待取货', completed: '已完成', cancelled: '已取消', refunded: '已退款'
};

/**
 * 结算订单收入：把订单金额按店铺拆分后加给各店铺主人
 * 规则：
 *   1. 同一店铺多件商品合并成一笔，避免重复写用户文件
 *   2. 无归属（无 ownerId）的店铺不结算
 *   3. 店主自己购买自己店铺的商品不结算，避免刷分
 * @param {object} order 已构造好的订单（含 items）
 * @param {string} buyerId 买家 id
 * @returns {Array<{shopId:string, shopName:string, ownerId:string, amount:number, settled:boolean}>} 结算明细
 */
function settleOrderIncome(order, buyerId) {
  const shops = store.read('shops', []);

  /** shopId → 待结算明细（同一店铺累加） */
  const incomeMap = new Map();
  for (const it of order.items) {
    const shop = shops.find(s => s.id === it.shopId);
    if (!shop || !shop.ownerId) continue;                  // 无归属店铺跳过
    if (shop.ownerId === buyerId) continue;                // 自购不结算

    /** 当前店铺的累计条目 */
    const entry = incomeMap.get(shop.id) || {
      shopId: shop.id,
      shopName: shop.name,
      ownerId: shop.ownerId,
      amount: 0
    };
    // 行小计 = 快照单价 × 数量（浮点保留 4 位，避免 0.1*3 出现长尾小数）
    entry.amount = Math.round((entry.amount + it.price * it.quantity) * 10000) / 10000;
    incomeMap.set(shop.id, entry);
  }

  const incomes = [...incomeMap.values()];
  for (const inc of incomes) {
    const owner = userStore.getUserById(inc.ownerId);
    if (!owner) {                                          // 店主账号已被删除
      inc.settled = false;
      continue;
    }
    const newPts = Math.round(((owner.points ?? 0) + inc.amount) * 10000) / 10000;
    const result = userStore.setPoints(inc.ownerId, newPts);
    inc.settled = !!result.ok;
  }
  return incomes;
}

/**
 * 反向结算订单收入：退款通过后，从各店主积分里扣回当初结算给他们的金额
 * 说明：店主可能已花掉部分积分，平台积分允许为负，不做下限拦截
 * @param {object} order 订单（含 shopIncomes 结算快照）
 * @returns {Array<{ownerId:string, amount:number, reversed:boolean}>} 扣回明细
 */
function reverseOrderIncomes(order) {
  /** 扣回结果明细，随订单落盘便于事后核对 */
  const result = [];
  for (const inc of order.shopIncomes || []) {
    if (!inc.settled) {                                   // 当初未结算成功，无需扣回
      result.push({ ownerId: inc.ownerId, amount: inc.amount, reversed: false });
      continue;
    }
    const owner = userStore.getUserById(inc.ownerId);
    if (!owner) {                                         // 店主账号已被删除
      result.push({ ownerId: inc.ownerId, amount: inc.amount, reversed: false });
      continue;
    }
    const newPts = Math.round(((owner.points ?? 0) - inc.amount) * 10000) / 10000;
    const r = userStore.setPoints(inc.ownerId, newPts);
    result.push({ ownerId: inc.ownerId, amount: inc.amount, reversed: !!r.ok });
  }
  return result;
}

/**
 * 下单：把当前购物车整体转成订单（平台为上门取货模式，无需收货地址）
 * 请求体：{note?}
 */
router.post('/orders', (req, res) => {
  const cartView = buildCartView(req.userId);
  if (cartView.items.length === 0) {
    return res.status(400).json({ ok: false, error: { code: 'EMPTY_CART', message: '购物车是空的，先去挑点好物吧' } });
  }

  // ========== 积分扣减校验（必须在写订单前，失败不污染数据） ==========
  const user = userStore.getUserById(req.userId);
  if (!user) return res.status(400).json({ ok: false, error: { code: 'USER_NOT_FOUND', message: '用户不存在' } });
  const currentPoints = user.points ?? 0;
  const needPoints = cartView.totalAmount;
  if (currentPoints < needPoints - 0.0001) {                 // 浮点容差
    return res.status(400).json({
      ok: false,
      error: {
        code: 'POINTS_NOT_ENOUGH',
        message: '积分不足（需要 ' + needPoints + ' 积分，当前 ' + currentPoints + ' 积分）'
      }
    });
  }
  // 扣积分（正常情况：总积分 -= 订单金额；浮点数保留 4 位小数）
  const newPoints = Math.round((currentPoints - needPoints) * 10000) / 10000;
  const setResult = userStore.setPoints(req.userId, newPoints);
  if (!setResult.ok) {
    return res.status(500).json({ ok: false, error: { code: 'POINTS_DEDUCT_FAILED', message: '积分扣减失败，请联系管理员' } });
  }
  // ==================================================================

  const orders = store.read('orders', []);
  const now = new Date().toISOString();
  const order = {
    id: store.genId('o'),
    userId: req.userId,
    items: cartView.items.map(it => ({
      productId: it.productId, productName: it.name,
      price: it.unitPrice,                                     // 订单快照价（含规格加价后）
      basePrice: it.basePrice,                                 // 商品原价（给管理员看加价幅度用）
      specText: it.specText,                                   // 规格快照，如 "大份/加冰"
      isCombo: it.isCombo,                                     // 是否套餐商品
      comboText: it.comboText,                                 // 套餐快照文本
      comboSelections: it.comboSelections,                     // 套餐选择明细
      quantity: it.quantity, emoji: it.emoji, image: it.image, shopId: it.shopId, shopName: it.shopName
    })),
    totalAmount: cartView.totalAmount,
    pickup: true,                                              // 固定上门取货（到店自提）
    note: String((req.body || {}).note || '').trim(),
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };
  // 收入结算：把订单金额按店铺拆给各店铺主人（需在写订单前，明细会随订单一起落盘）
  order.shopIncomes = settleOrderIncome(order, req.userId);

  orders.unshift(order);                                   // 新订单排最前
  store.write('orders', orders);

  // 清空购物车并累计销量
  const carts = store.read('carts', {});
  carts[req.userId] = [];
  store.write('carts', carts);
  const products = store.read('products', []);
  for (const it of order.items) {
    const product = products.find(p => p.id === it.productId);
    if (product) product.sales = (product.sales || 0) + it.quantity;
  }
  store.write('products', products);

  ok(res, Object.assign({}, order, { remainingPoints: newPoints }));
});

/**
 * 补全订单项的封面：老订单快照没有 image 字段，按 productId 回查当前商品补齐
 * @param {object} order 订单对象
 * @param {Array} products 商品列表（外部传入避免重复读盘）
 * @returns {object} items 已带 image 的订单副本
 */
function fillOrderImages(order, products) {
  const items = (order.items || []).map(it => {
    if (it.image) return it;                                  // 已有图直接用
    const product = products.find(p => p.id === it.productId);
    return Object.assign({}, it, {
      image: product ? product.image : '',                    // 回查商品图
      emoji: it.emoji || (product ? product.emoji : '🛒')     // 无 emoji 时用商品 emoji 兜底
    });
  });
  return Object.assign({}, order, { items });
}

/**
 * GET /orders 订单列表
 * 管理员可传 ?all=1 查看全部订单；默认只看自己的
 */
router.get('/orders', (req, res) => {
  let orders = store.read('orders', []);
  const all = req.query.all === '1' && req.isAdmin;
  if (!all) orders = orders.filter(o => o.userId === req.userId);
  const q = (req.query.q || '').trim();
  if (q) orders = orders.filter(o =>
    o.id.includes(q) ||
    o.items.some(it => it.productName.includes(q)));
  const products = store.read('products', []);               // 商品表：补齐封面图用
  ok(res, orders.map(o => Object.assign(fillOrderImages(o, products), {
    statusText: STATUS_TEXT[o.status] || o.status
  })));
});

/** GET /orders/:id 订单详情（本人或管理员可见） */
router.get('/orders/:id', (req, res) => {
  const order = store.read('orders', []).find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '订单不存在' } });
  if (order.userId !== req.userId && !req.isAdmin) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '无权查看该订单' } });
  }
  const products = store.read('products', []);
  ok(res, Object.assign(fillOrderImages(order, products), {
    statusText: STATUS_TEXT[order.status] || order.status
  }));
});

/** POST /orders/:id/cancel 用户取消自己的订单（仅待确认状态可取消） */
router.post('/orders/:id/cancel', (req, res) => {
  const orders = store.read('orders', []);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '订单不存在' } });
  if (order.userId !== req.userId) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只能取消自己的订单' } });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '当前状态不可取消，请联系管理员' } });
  }
  order.status = 'cancelled';
  order.updatedAt = new Date().toISOString();
  store.write('orders', orders);
  ok(res, Object.assign({}, order, { statusText: STATUS_TEXT[order.status] }));
});

/** POST /orders/:id/refund 用户申请退款（提交后进入待审核，管理员通过才返还积分） */
router.post('/orders/:id/refund', (req, res) => {
  const orders = store.read('orders', []);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '订单不存在' } });
  if (order.userId !== req.userId) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '只能为自己的订单申请退款' } });
  }
  if (order.status === 'cancelled') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '订单已取消，无需申请退款' } });
  }
  if (order.status === 'refunded' || order.refundStatus === 'approved') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '该订单已退款' } });
  }
  if (order.refundStatus === 'pending') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '退款申请正在审核中，请耐心等待' } });
  }
  const now = new Date().toISOString();
  /** 退款理由：用户选填，最多 100 字 */
  const reason = String((req.body || {}).reason || '').trim().slice(0, 100);
  order.refundStatus = 'pending';                          // pending=待审核 / approved=已退款 / rejected=已拒绝
  order.refundReason = reason;
  order.refundAmount = order.totalAmount;                  // 记录申请时的退款金额快照
  order.refundRequestedAt = now;
  order.refundHandledAt = null;
  order.refundHandledBy = null;
  order.refundRejectReason = '';
  order.updatedAt = now;
  store.write('orders', orders);
  ok(res, Object.assign({}, order, { statusText: STATUS_TEXT[order.status] }));
});

/** PUT /admin/orders/:id/refund 管理员审核退款 {approve:boolean, note?} */
router.put('/admin/orders/:id/refund', requireAdmin, (req, res) => {
  const body = req.body || {};
  const approve = body.approve === true;                   // 只有显式 true 才算通过，避免误操作
  const orders = store.read('orders', []);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '订单不存在' } });
  if (order.refundStatus !== 'pending') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '该订单没有待审核的退款申请' } });
  }

  const now = new Date().toISOString();
  /** 退款金额：优先用申请时的快照，兼容历史订单 */
  const amount = order.refundAmount != null ? order.refundAmount : order.totalAmount;

  // ===== 拒绝：只记录处理结果，不动积分 =====
  if (!approve) {
    order.refundStatus = 'rejected';
    order.refundRejectReason = String(body.note || '').trim().slice(0, 100);
    order.refundHandledAt = now;
    order.refundHandledBy = req.userId;
    order.updatedAt = now;
    store.write('orders', orders);
    return ok(res, Object.assign({}, order, { statusText: STATUS_TEXT[order.status] }));
  }

  // ===== 通过：先返还买家积分，再从店主收入中扣回，全部成功才落盘 =====
  const buyer = userStore.getUserById(order.userId);
  if (!buyer) {
    return res.status(400).json({ ok: false, error: { code: 'USER_NOT_FOUND', message: '买家账号不存在，无法退款' } });
  }
  const buyerPoints = Math.round(((buyer.points ?? 0) + amount) * 10000) / 10000;
  const refundResult = userStore.setPoints(order.userId, buyerPoints);
  if (!refundResult.ok) {
    return res.status(500).json({ ok: false, error: { code: 'REFUND_FAILED', message: '退款失败：买家积分返还失败，请重试' } });
  }
  order.refundReversedIncomes = reverseOrderIncomes(order); // 反向结算明细，随订单落盘
  order.refundStatus = 'approved';
  order.refundRejectReason = '';
  order.refundHandledAt = now;
  order.refundHandledBy = req.userId;
  order.status = 'refunded';                               // 订单状态置为已退款
  order.updatedAt = now;
  store.write('orders', orders);
  ok(res, Object.assign({}, order, { statusText: STATUS_TEXT[order.status] }));
});

/**
 * 构建「待取件通知」邮件（订单首次变为待取货时自动发给买家绑定邮箱）
 * 模板：
 *   主题：【待取件通知】请前来领取[商品概要]
 *   正文：XX 同学 → 您好 → 已准备完毕 → 疑问联系班主任 → 顺颂商祺
 * @param {object} order 订单对象
 * @returns {{subject: string, text: string}} 邮件主题与纯文本正文
 */
function buildPickupMail(order) {
  const buyer = userStore.getUserById(order.userId) || {};   // 买家用户记录
  const name = buyer.name || order.userId;                    // 称呼用姓名，缺失时退回 id
  const items = order.items || [];                            // 订单商品明细
  const first = items[0] ? items[0].productName : '商品';      // 首个商品名
  const totalCount = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0); // 商品总件数
  const summary = items.length > 1 ? `${first}等${totalCount}件商品` : first;   // 商品概要

  const subject = `【待取件通知】请前来领取${summary}`;
  const text = [
    `${name}同学：`,
    '您好！',
    `您的${summary}已准备完毕，现通知前来领取。`,
    '如您有疑问，可与班主任联系。',
    '顺颂商祺！'
  ].join('\n');
  return { subject, text };
}

/** PUT /admin/orders/:id/status 管理员更新订单状态 {status}
 *  说明：状态首次变为 delivering（待取货）时，自动向买家绑定邮箱发送待取件通知 */
router.put('/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '非法的订单状态' } });
  }
  const orders = store.read('orders', []);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '订单不存在' } });
  const prevStatus = order.status;                              // 变更前状态（用于判断是否首次进入待取货）
  order.status = status;
  order.updatedAt = new Date().toISOString();
  store.write('orders', orders);

  /* 首次进入待取货 → 自动发待取件通知；发送失败不影响状态更新，仅回传提示 */
  let mailNotice = '';
  if (status === 'delivering' && prevStatus !== 'delivering') {
    try {
      const binding = mailer.getBinding(order.userId);           // 买家绑定邮箱
      if (binding.email) {
        const mail = buildPickupMail(order);
        await mailer.sendMail({ to: binding.email, subject: mail.subject, text: mail.text });
        mailNotice = `待取件通知已发送至 ${binding.email}`;
      } else {
        mailNotice = '买家尚未绑定邮箱，未发送待取件通知';
      }
    } catch (e) {
      mailNotice = '待取件通知发送失败：' + (e.message || '未知错误');
    }
  }

  ok(res, Object.assign({}, order, { statusText: STATUS_TEXT[order.status], mailNotice }));
});

/** GET /admin/stats 管理员统计：订单数/销售额/热销商品 Top5 */
router.get('/admin/stats', requireAdmin, (req, res) => {
  const orders = store.read('orders', []).filter(o => o.status !== 'cancelled' && o.status !== 'refunded');
  const today = new Date().toISOString().slice(0, 10);
  const productSales = new Map();                          // 商品名 → 销量
  for (const o of orders) {
    for (const it of o.items) {
      productSales.set(it.productName, (productSales.get(it.productName) || 0) + it.quantity);
    }
  }
  const topProducts = [...productSales.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, sales]) => ({ name, sales }));
  ok(res, {
    totalOrders: orders.length,
    totalRevenue: Math.round(orders.reduce((s, o) => s + o.totalAmount, 0) * 100) / 100,
    todayOrders: orders.filter(o => (o.createdAt || '').slice(0, 10) === today).length,
    topProducts
  });
});

module.exports = router;
