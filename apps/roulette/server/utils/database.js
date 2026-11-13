/**
 * 本地 SQLite 数据库封装（基于 sql.js，纯 JS 实现，跨平台）
 * 每个 Node 进程持有同一个数据库实例；server 关闭前把内存里的数据库写回文件。
 */
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// 单例数据库实例
let _db = null;

/** 数据库文件路径（相对项目根目录） */
const DB_FILE = path.join(__dirname, '..', '..', process.env.DB_FILE || 'wheel.db');

/**
 * 打开或创建数据库
 * @returns {Promise<import('sql.js').Database>}
 */
async function open() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  let buf;
  if (fs.existsSync(DB_FILE)) {
    buf = fs.readFileSync(DB_FILE);
  } else {
    // 初次启动：建空库 + 表结构
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'user',
        theme TEXT DEFAULT 'blue',
        created_at TEXT DEFAULT (datetime('now')),
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wheels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        options TEXT NOT NULL,
        colors TEXT,
        background_image TEXT,
        background_color TEXT,
        is_private INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES profiles(id)
      );
      CREATE INDEX IF NOT EXISTS idx_wheels_user ON wheels(user_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
    `);
    saveToFile(db);
    buf = fs.readFileSync(DB_FILE);
    db.close();
  }
  _db = new SQL.Database(buf);
  return _db;
}

/** 把数据库内容写回磁盘 */
function saveToFile(db) {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

/**
 * 关闭数据库（同时持久化）
 */
function close() {
  if (_db) {
    saveToFile(_db);
    _db.close();
    _db = null;
  }
}

/** 把 rows 包装成 { columns:[], values:[[...]] } 格式，方便遍历 */
function exec(db, sql, params) {
  return db.exec(sql, params || []);
}

/**
 * 直接执行 INSERT/UPDATE/DELETE
 * @returns {number} 影响行数
 */
function run(db, sql, params) {
  db.run(sql, params || []);
  return db.getRowsModified();
}

/** 把查询结果转为对象数组 */
function rows(db, sql, params) {
  const result = exec(db, sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

/** 取一条 */
function first(db, sql, params) {
  const list = rows(db, sql, params);
  return list[0] || null;
}

module.exports = { open, close, run, rows, first, exec, saveToFile };
