/**
 * 明星商店 —— 应用装配入口
 * ----------------------------------------------------------
 * 职责：
 *   - express 中间件（JSON body parser、全局错误兜底）
 *   - 挂载 /api 业务路由（店铺/商品/购物车/地址/订单/管理）
 *   - express.static 托管 client/ 静态资源（HTML 禁缓存）
 *   - 通配路由兜底回 index.html（SPA 安全网）
 *   - 导出 app 供明星学校主应用挂载到 /shop（登录守卫由主入口统一施加）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const apiRouter = require('./routes/api');
const store = require('./store');

const PORT = process.env.PORT || 3600;

const app = express();

// JSON body，限制 2MB（商品图片走 URL，正常请求体很小，留足余量）
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// —— /api 业务路由 ——
app.use('/api', apiRouter);

// —— 上传图片静态托管（商品图片，文件名唯一，可长缓存） ——
// 访问路径：/shop/uploads/<文件名>（子应用由主入口挂载在 /shop 下）
const UPLOAD_DIR = path.resolve(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// —— client 静态托管 ——
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR, {
  // 关闭 express.static 的目录重定向（/shop → /shop/），由下方通配兜底统一处理
  redirect: false,
  // HTML 文档完全禁用缓存：每次都向服务器验证，确保修改即时生效
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
    }
  }
}));

/**
 * 通配兜底：任何未匹配路径都回 index.html（SPA History API 路由安全网）
 * 显式加 no-store 防缓存，确保每次请求都拿最新 HTML。
 */
app.get('*', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// —— 全局错误兜底（防炸） ——
app.use((err, req, res, next) => {
  /* 请求体超限：body-parser 抛 413，需转成统一 JSON 格式，前端才能正常提示 */
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: { code: 'TOO_LARGE', message: '图片太大，请选择小一些的图片' } });
  }
  console.error('[shop-server] 未捕获错误：', err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

// 导出 app，供明星学校主应用挂载到 /shop
module.exports = app;

// —— 启动（仅独立运行时监听） ——
if (require.main === module) {
  store.init();
  app.listen(PORT, () => {
    console.log('\n====== 明星商店 启动成功 ======');
    console.log(`监听地址:  http://localhost:${PORT}`);
    console.log(`数据目录:  ${store.DATA_DIR}`);
    console.log('================================\n');
  });
}
