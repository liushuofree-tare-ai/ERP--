// 服务端完整备份导出与恢复（与前端 qipei-erp-v2-backup 格式逐字段兼容：
// manifest.json + data.json + files/<id>，前端导出的包后端能恢复，
// 后端导出的包前端双开页面也能恢复——两边是一条格式）。
// 恢复语义与前端 applyBackup 的 M5 修复同源：先写文件后换状态，
// 单事务原子提交，失败回滚；备份没有的孤儿文件不删（留给下次收敛）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { getDb, filePathOf, inTransaction, setMeta } from '../db.js';
import { FILES_DIR } from '../config.js';
import { assembleState, getCurrentRevision, replaceStateInTx } from './state.js';

const BACKUP_FORMAT = 'qipei-erp-v2-backup';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return '汽配ERP完整备份-' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
    '-' + p(date.getHours()) + p(date.getMinutes()) + '.zip';
}

/** 采集 → 备份 zip 字节。没有存档（revision=0）时明确失败。 */
export function buildServerBackupZip() {
  if (getCurrentRevision() === 0) {
    return { ok: false, error: '还没有保存过工作（先导入一张表干点活），现在没有可备份的数据' };
  }
  const state = assembleState();
  const archiveJson = JSON.stringify(state, null, 2);
  const files = [];
  const entries = {};
  const db = getDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY id').all();
  for (const r of rows) {
    let bytes;
    try {
      const p = filePathOf(r.id); // 白名单校验 + 不存在时会抛 ENOENT
      bytes = fs.readFileSync(p);
    } catch (e) {
      return { ok: false, error: '文件仓库不完整：「' + (r.name || r.id) + '」读不到（先修复数据目录再备份），这次没有生成备份' };
    }
    files.push({
      id: r.id, kind: r.kind, name: r.name, mime: r.mime,
      size: bytes.length, savedAt: r.saved_at, sha256: sha256(bytes),
    });
    entries['files/' + r.id] = [new Uint8Array(bytes), { level: 0 }];
  }
  const counts = {
    docs: state.docs.length,
    inquiries: state.docs.filter((d) => d && d.kind === 'inquiry').length,
    quotes: state.docs.filter((d) => d && d.kind === 'quote').length,
    orders: state.orders.length,
    factories: state.factories.length,
    files: files.length,
  };
  const manifest = {
    format: BACKUP_FORMAT,
    appVersion: 'server',
    exportedAt: new Date().toISOString(),
    counts,
    archive: { path: 'data.json', bytes: enc.encode(archiveJson).length, sha256: sha256(enc.encode(archiveJson)) },
    files: files.map((f) => ({
      id: f.id, path: 'files/' + f.id, kind: f.kind, name: f.name,
      mime: f.mime, size: f.size, savedAt: f.savedAt, sha256: f.sha256,
    })),
  };
  entries['manifest.json'] = [enc.encode(JSON.stringify(manifest, null, 2)), { level: 0 }];
  entries['data.json'] = [enc.encode(archiveJson), { level: 0 }];
  return { ok: true, bytes: zipSync(entries), manifest, fileName: backupFileName() };
}

/**
 * 校验备份 zip（与前端 parseAndValidateBackup 同一套规则）：
 * 清单格式 → data.json 形状与哈希 → 逐文件大小 + 哈希。
 */
export function validateBackupZip(inputBytes) {
  const errors = [];
  let parts;
  try {
    parts = unzipSync(inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes));
  } catch (e) {
    return { ok: false, errors: ['这个文件打不开（不是完好的 zip 备份文件）'], archiveJson: null, files: [] };
  }
  let manifest = null;
  if (!parts['manifest.json']) errors.push('备份里缺清单文件 manifest.json，这可能不是本系统导出的完整备份');
  else {
    try { manifest = JSON.parse(dec.decode(parts['manifest.json'])); } catch (e) { manifest = null; }
    if (!manifest) errors.push('备份清单读不懂（manifest.json 已损坏）');
    else if (manifest.format !== BACKUP_FORMAT) {
      errors.push('这不是本系统的完整备份（清单格式对不上），已拒绝恢复');
      manifest = null;
    }
  }
  let archiveJson = null;
  if (!parts['data.json']) errors.push('备份里缺业务数据 data.json');
  else {
    archiveJson = dec.decode(parts['data.json']);
    let obj = null;
    try { obj = JSON.parse(archiveJson); } catch (e) { obj = null; }
    if (!obj || obj.version !== 2 || !Array.isArray(obj.docs)) {
      errors.push('备份里的业务数据形状不对（不是本系统的存档），已拒绝恢复');
      archiveJson = null;
    } else if (manifest && manifest.archive && manifest.archive.sha256) {
      if (sha256(parts['data.json']) !== manifest.archive.sha256) {
        errors.push('业务数据和清单对不上（data.json 可能被改动过），已拒绝恢复');
        archiveJson = null;
      }
    }
  }
  const files = [];
  if (manifest && Array.isArray(manifest.files)) {
    for (const meta of manifest.files) {
      const bytes = parts[meta.path || ('files/' + meta.id)];
      if (!bytes) { errors.push('备份里少了一个文件：' + (meta.name || meta.id)); continue; }
      if (bytes.length !== meta.size) {
        errors.push('文件「' + (meta.name || meta.id) + '」大小对不上，备份可能已损坏');
        continue;
      }
      if (sha256(bytes) !== meta.sha256) {
        errors.push('文件「' + (meta.name || meta.id) + '」内容对不上，备份可能已损坏');
        continue;
      }
      files.push({ id: meta.id, kind: meta.kind, name: meta.name, mime: meta.mime, savedAt: meta.savedAt, bytes });
    }
  }
  return { ok: errors.length === 0, errors, archiveJson, files };
}

/** 恢复：先写文件、再整份换状态（单事务），失败回滚当前数据。 */
export function applyServerBackup(validated, { actor = 'local' } = {}) {
  if (!validated || !validated.ok) {
    return { ok: false, error: '这份备份没有通过校验，不能恢复' };
  }
  const wantedIds = new Set((validated.files || []).map((f) => f.id));
  let stateObj = null;
  try { stateObj = JSON.parse(validated.archiveJson); } catch (e) {
    return { ok: false, error: '存档读不懂，不能恢复' };
  }
  for (const f of validated.files) {
    let p;
    try { p = filePathOf(f.id); } catch (e) { return { ok: false, error: '非法文件 id：' + f.id }; }
    fs.writeFileSync(p, Buffer.from(f.bytes));
  }
  inTransaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM files').run();
    const ins = db.prepare(`
      INSERT INTO files (id, kind, name, mime, size, sha256, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const f of validated.files) {
      ins.run(f.id, f.kind || 'image', f.name || '', f.mime || 'application/octet-stream',
        f.bytes.length, sha256(f.bytes), f.savedAt || new Date().toISOString());
    }
    fs.mkdirSync(FILES_DIR, { recursive: true });
    for (const name of fs.readdirSync(FILES_DIR)) {
      if (!wantedIds.has(name)) {
        try { fs.unlinkSync(path.join(FILES_DIR, name)); } catch (e) { /* 磁盘孤儿不影响恢复 */ }
      }
    }
    const revision = replaceStateInTx(stateObj, { actor, action: 'restore_backup' });
    setMeta('revision', String(revision));
    return revision;
  });
  return { ok: true, restoredFiles: validated.files.length };
}

export function registerBackupRoutes(app) {
  app.get('/api/backup/export', async (req, reply) => {
    const res = buildServerBackupZip();
    if (!res.ok) {
      reply.code(400).send({ ok: false, error: res.error });
      return;
    }
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(res.fileName))
      .send(Buffer.from(res.bytes));
  });

  app.post('/api/backup/restore', async (req, reply) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
      reply.code(400).send({ ok: false, message: '请求体不是二进制（需要 application/zip）' });
      return;
    }
    const validated = validateBackupZip(new Uint8Array(bytes));
    if (!validated.ok) {
      reply.code(400).send({ ok: false, errors: validated.errors, message: validated.errors.join('；') });
      return;
    }
    try {
      const res = applyServerBackup(validated, { actor: 'restore' });
      return res;
    } catch (e) {
      reply.code(500).send({ ok: false, message: '恢复失败：' + String(e && e.message || e) });
    }
  });
}
