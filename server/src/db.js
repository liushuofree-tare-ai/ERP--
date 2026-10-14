// SQLite 数据层（node:sqlite 内置模块，零原生依赖）：
// · WAL 模式 + NORMAL 同步：读多写少场景高并发且掉电只丢最后一次检查点
// · 7 张表：system_meta / customers / factories / documents / orders / files / audit_logs
// · 金额与订单状态不落冗余列——前端 orders.js 现算（底线 4：口径只有一套）
// · 事务封装：整份状态替换是原子的，中途失败回滚到旧状态
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, FILES_DIR, DATA_DIR, BACKUPS_DIR } from './config.js';

let db = null;

export function closeDb() {
  if (!db) return;
  try { db.close(); } catch (e) { /* 已关闭 */ }
  db = null;
}

export function getDb() {
  if (db) return db;
  for (const dir of [DATA_DIR, FILES_DIR, BACKUPS_DIR, path.dirname(DB_PATH)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      name TEXT PRIMARY KEY,
      contact TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factories (
      name TEXT PRIMARY KEY,
      contact TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('inquiry','quote')),
      inquiry_id TEXT,
      factory_name TEXT,
      customer_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      header_row INTEGER,
      source_file_id TEXT,
      source_json TEXT,
      import_info TEXT NOT NULL DEFAULT '',
      pricing_json TEXT,
      price_mark_json TEXT,
      ledger_json TEXT,
      row_choices_json TEXT,
      factory_extras_json TEXT,
      sheet_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_inquiry ON documents(inquiry_id);
    CREATE INDEX IF NOT EXISTS idx_docs_customer ON documents(customer_name);
    CREATE TABLE IF NOT EXISTS orders (
      order_no TEXT PRIMARY KEY,
      inquiry_doc_id TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      lines_json TEXT NOT NULL DEFAULT '[]',
      receipts_json TEXT NOT NULL DEFAULT '[]',
      factory_pays_json TEXT NOT NULL DEFAULT '[]',
      shipments_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_inquiry ON orders(inquiry_doc_id);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_name);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('original','image')),
      name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      saved_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT 'local',
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureMeta('revision', '0');
  ensureMeta('order_seq', '0');
  ensureMeta('active_doc_id', 'doc-inquiry');
  return db;
}

function ensureMeta(key, fallback) {
  const row = getDb().prepare('SELECT value FROM system_meta WHERE key = ?').get(key);
  if (!row) {
    getDb().prepare('INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, fallback, new Date().toISOString());
  }
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM system_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  getDb().prepare(`
    INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

/** 事务封装：fn 全过才提交，任何一步失败回滚（applyBackup / saveState 都靠它） */
export function inTransaction(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw e;
  }
}

/** 文件在磁盘上的路径（id 内容寻址，杜绝路径穿越：id 服务器侧只当文件名） */
export function filePathOf(id) {
  // 白名单字符校验：id 只能是 orig-/img- 前缀 + 十六进制
  if (!/^(orig|img)-[0-9a-f]{4,64}$/.test(id)) throw new Error('非法文件 id: ' + id);
  return path.join(FILES_DIR, id);
}
