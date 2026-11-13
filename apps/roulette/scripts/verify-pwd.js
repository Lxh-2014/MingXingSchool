// 直接读 wheel.db 验证学号
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

(async () => {
  const DB = path.join(__dirname, '..', 'wheel.db');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB));
  const rows = db.exec('SELECT username, role, password_hash FROM profiles');
  for (const r of rows[0].values) {
    const [user, role, hash] = r;
    const raw = role === 'admin' ? 'admin123' : (user.length < 6 ? user.padEnd(6, '0') : user);
    const ok = await bcrypt.compare(raw, hash);
    console.log(`${user}(${role}) raw="${raw}" match=${ok} hash_prefix=${hash?.slice(0,10)}`);
  }
  // 直接验证一条：涵猫 / 涵猫0000
  const ok2 = await bcrypt.compare('涵猫0000', rows[0].values.find(r => r[0]==='涵猫')[2]);
  console.log('涵猫/涵猫0000 direct =', ok2);
  db.close();
})();
