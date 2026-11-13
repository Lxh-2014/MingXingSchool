// 把各 HTML 里的 Supabase 引用批量替换为 LocalDB
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'client', 'pages');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

for (const f of files) {
  let c = fs.readFileSync(path.join(dir, f), 'utf8');
  // 1. 去掉 config.js 引用（不再需要）
  c = c.replace(/<script src="\/config\.js"><\/script>\s*/g, '');
  // 2. supabase-client 替换为 local-db-client
  c = c.replace(/<script src="\/js\/supabase-client\.js"><\/script>/g,
    '<script src="/js/local-db-client.js"></script>');
  // 3. Supabase.xxx → LocalDB.xxx
  c = c.replace(/Supabase\./g, 'LocalDB.');
  // 4. profile.html 里 LocalDB.request 已经不存在了，改为 LocalDB.listProfiles 再本地查重
  //    但那是页面内部逻辑，后面手动调整
  fs.writeFileSync(path.join(dir, f), c, 'utf8');
  console.log('updated', f);
}
console.log('done');
