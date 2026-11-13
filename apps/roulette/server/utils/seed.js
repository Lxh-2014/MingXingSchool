/**
 * 种子脚本：从 CSV 导入 profiles / wheels
 * 密码策略：
 *   - PRD 2.1 明确定义的 5 个账号使用 PRD 原始密码（SHA-256 哈希）
 *   - 其余 CSV 里的历史用户用【姓名本身】作为初始密码
 *
 * 运行： npm run seed
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, saveToFile, close } = require('./database');

/** 密码哈希（与 server.js 保持一致） */
function hash(pwd) { return crypto.createHash('sha256').update(pwd, 'utf8').digest('hex'); }

// ============ PRD 2.1 预设账号密码表 ============
const PRD_PASSWORD_MAP = {
  '刘校长': 'lq535384',   // 管理员
  '刘潇月': '0',          // 管理员
  '涵猫':   '1',          // 学生
  '星星':   '2',          // 学生
  '小小':   '3-1',        // 学生
};

// ============ CSV 文件路径 ============
const DEFAULT_CSV_DIR = path.join(require('os').homedir(), 'Downloads');
const CSV_DIR = process.env.SEED_DIR || DEFAULT_CSV_DIR;
const PROFILES_CSV = path.join(CSV_DIR, 'profiles_rows.csv');
const WHEELS_CSV = path.join(CSV_DIR, 'wheels_rows.csv');

/** 简易 CSV 解析 */
function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuote = false; }
      else field += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const headers = rows.shift();
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

async function main() {
  const dbFile = path.join(__dirname, '..', '..', process.env.DB_FILE || 'wheel.db');
  if (fs.existsSync(dbFile)) { fs.unlinkSync(dbFile); console.log('已删除旧数据库'); }

  const db = await open();

  // ===== 导入 profiles =====
  if (fs.existsSync(PROFILES_CSV)) {
    const profiles = csvToObjects(fs.readFileSync(PROFILES_CSV, 'utf8'));
    let prdMatch = 0, fallback = 0;
    for (const p of profiles) {
      const rawPwd = PRD_PASSWORD_MAP[p.username] !== undefined
        ? PRD_PASSWORD_MAP[p.username]
        : p.username;  // fallback：姓名作为密码
      const h = hash(rawPwd);
      db.run(
        `INSERT INTO profiles (id, username, role, theme, created_at, password_hash) VALUES (?,?,?,?,?,?)`,
        [p.id, p.username, p.role || 'user', p.theme || 'blue', p.created_at || null, h]
      );
      if (PRD_PASSWORD_MAP[p.username] !== undefined) {
        prdMatch++;
        console.log(`  ✅ ${p.username}(${p.role || 'user'}) ← PRD 原始密码 "${rawPwd}"`);
      } else {
        fallback++;
        console.log(`  🔸 ${p.username}(user) ← 非 PRD 用户，初始密码 "${rawPwd}"（即姓名本身）`);
      }
    }
    console.log(`✅ profiles 导入 ${profiles.length} 条（${prdMatch} 条 PRD 预设 + ${fallback} 条历史 fallback）`);
  } else {
    console.log('⚠️  未找到 profiles_rows.csv');
  }

  // ===== 导入 wheels =====
  if (fs.existsSync(WHEELS_CSV)) {
    const wheels = csvToObjects(fs.readFileSync(WHEELS_CSV, 'utf8'));
    for (const w of wheels) {
      const colors = w.colors || null;
      db.run(
        `INSERT INTO wheels (id, user_id, name, options, colors, background_image, background_color, is_private, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          w.id, w.user_id, w.name,
          w.options || '[]',
          colors,
          w.background_image || null,
          w.background_color || null,
          w.is_private === 'true' ? 1 : 0,
          w.sort_order || 0,
          w.created_at || null,
          w.updated_at || null,
        ]
      );
    }
    console.log(`✅ wheels 导入 ${wheels.length} 条`);
  } else {
    console.log('⚠️  未找到 wheels_rows.csv');
  }

  saveToFile(db);
  close();
  console.log('\n🎉 种子完成！数据库：', dbFile);
  console.log('💡 登录方式：姓名 + 密码（5 个 PRD 预设用 PRD 原始密码，其余用姓名本身）');
}

main().catch(err => { console.error('种子失败:', err); process.exit(1); });
