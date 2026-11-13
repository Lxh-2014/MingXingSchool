/**
 * 邻语（IM）—— 应用装配入口
 * ----------------------------------------------------------
 * 职责：
 *   - express 中间件（JSON body parser、全局错误兜底）
 *   - 挂载 /api 业务路由（用户 / 会话 / 消息 / 撤回 / 已读）
 *   - express.static 托管 client/ 静态资源（HTML 禁缓存）
 *   - 导出 app 供明星学校主应用挂载到 /im（登录守卫由主入口统一施加）
 */
const express = require('express');
const path = require('path');

const apiRouter = require('./routes/api');
const store = require('./store');

/** 独立运行时的默认端口（正式环境由主入口挂载，不单独监听） */
const PORT = process.env.IM_PORT || 3700;

const app = express();

// JSON body：消息正文最多 2000 字；图片/文件走 base64，放宽到 30MB
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// —— /api 业务路由 ——
app.use('/api', apiRouter);

// —— client 静态托管 ——
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR, {
  redirect: false,                                    // 关闭目录重定向（/im → /im/），交给下方兜底
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // HTML 文档完全禁用缓存：确保页面修改即时生效
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
    }
  }
}));

// —— 表情包静态托管：项目根 docs/emoji（APNG 动图），长期缓存 ——
app.use('/emoji', express.static(path.resolve(__dirname, '..', '..', '..', 'docs', 'emoji'), {
  index: false,
  maxAge: '7d'
}));

// —— 通配兜底：任何未匹配路径都回 index.html（避免刷新 404） ——
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
  console.error('[im-server] 未捕获错误：', err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

// 导出 app，供明星学校主应用挂载到 /im
module.exports = app;

// —— 启动（仅独立运行时监听，便于单独调试） ——
if (require.main === module) {
  store.init();
  app.listen(PORT, () => {
    console.log('\n====== 邻语 启动成功 ======');
    console.log(`监听地址:  http://localhost:${PORT}`);
    console.log(`数据目录:  ${store.DATA_DIR}`);
    console.log('===========================\n');
  });
}
