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
      kind TEXT NOT NULL CHECK(kind IN ('inquiry','quote','custquote')),
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
      qty_col INTEGER,
      export_col_keys_json TEXT,
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
  migrateDocumentsTable(db);
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

/* documents 表演进（包 20）：kind 放行 custquote（最终报价单）、补 qty_col
 * （转订单数量列）与 export_col_keys_json（对客导出记住的列勾选）。
 * 旧库就地迁移：加列走 ALTER；CHECK 约束 SQLite 改不了，只能整表重建
 * （复制数据 → 换名 → 重建索引），全程一笔事务，失败回滚。
 * 新库建表语句已是新结构，下面两道检查都会直接跳过。 */
const DOCUMENTS_NEW_SCHEMA = `
  CREATE TABLE documents_new (
    doc_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('inquiry','quote','custquote')),
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
    qty_col INTEGER,
    export_col_keys_json TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT NOT NULL
  )`;
const DOCUMENTS_COLUMNS = 'doc_id, kind, inquiry_id, factory_name, customer_name, note, header_row, source_file_id, source_json, import_info, pricing_json, price_mark_json, ledger_json, row_choices_json, factory_extras_json, sheet_json, qty_col, export_col_keys_json, sort_order, created_at, updated_at';

function migrateDocumentsTable(db) {
  const cols = db.prepare('PRAGMA table_info(documents)').all().map((r) => r.name);
  if (!cols.includes('qty_col')) db.exec('ALTER TABLE documents ADD COLUMN qty_col INTEGER');
  if (!cols.includes('export_col_keys_json')) db.exec('ALTER TABLE documents ADD COLUMN export_col_keys_json TEXT');
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get();
  if (!row || !row.sql || row.sql.includes("'custquote'")) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(DOCUMENTS_NEW_SCHEMA);
    db.exec('INSERT INTO documents_new (' + DOCUMENTS_COLUMNS + ') SELECT ' + DOCUMENTS_COLUMNS + ' FROM documents');
    db.exec('DROP TABLE documents');
    db.exec('ALTER TABLE documents_new RENAME TO documents');
    db.exec('CREATE INDEX IF NOT EXISTS idx_docs_inquiry ON documents(inquiry_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_docs_customer ON documents(customer_name)');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
    throw e;
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
