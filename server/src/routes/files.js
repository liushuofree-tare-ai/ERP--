// 内容寻址文件仓库：原件（orig-…）与图片（img-…）。
// · 上传前服务端重算 SHA-256 并与 id 互验：id 就是内容本身，撒不了谎
// · 字节落 DATA_DIR/files/<id>，元数据落 files 表（表是磁盘的索引镜像）
// · 幂等：同 id 重传覆盖写（同 id 必同内容），天然去重
// · 临时下载直链（download-temp）：给飞书内置浏览器等不认 blob: 下载
//   的环境用——POST 字节换 5 分钟有效的 token，GET 标准附件流
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb, filePathOf } from '../db.js';
import { FILES_DIR, DOWNLOAD_TOKEN_TTL_MS } from '../config.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** id 与内容互验：'orig-x' / 'img-x' + sha256 前缀 */
export function verifyFileId(id, bytes) {
  const m = /^(orig|img)-([0-9a-f]+)$/.exec(id || '');
  if (!m) return false;
  return sha256(bytes).startsWith(m[2]);
}

export function saveFileRecord(id, kind, name, mime, bytes, savedAt) {
  const db = getDb();
  fs.writeFileSync(filePathOf(id), bytes);
  db.prepare(`
    INSERT INTO files (id, kind, name, mime, size, sha256, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name,
      mime=excluded.mime, size=excluded.size, sha256=excluded.sha256, saved_at=excluded.saved_at
  `).run(id, kind, name || '', mime || 'application/octet-stream',
    bytes.length, sha256(bytes), savedAt || new Date().toISOString());
}

export function fileStats() {
  const rows = getDb().prepare(
    "SELECT kind, COUNT(*) AS cnt, SUM(size) AS bytes FROM files GROUP BY kind").all();
  const st = { originalCount: 0, originalBytes: 0, imageCount: 0, imageBytes: 0, totalCount: 0, totalBytes: 0 };
  for (const r of rows) {
    st.totalCount += r.cnt;
    st.totalBytes += r.bytes || 0;
    if (r.kind === 'original') { st.originalCount = r.cnt; st.originalBytes = r.bytes || 0; }
    else { st.imageCount = r.cnt; st.imageBytes = r.bytes || 0; }
  }
  return st;
}

const fileMetaRow = (id) => getDb().prepare(
  'SELECT id, kind, name, mime, size, sha256, saved_at FROM files WHERE id = ?').get(id);

/* ---------- 临时下载直链（飞书内置浏览器兼容） ---------- */
const downloadTokens = new Map(); // token → { bytes, name, mime, expiresAt }

function sha256Of(b) {
  return createHash('sha256').update(b).digest('hex');
}

let tokenSeq = 0;

export function registerFileRoutes(app) {
  // 原始二进制上传：前端 putFile 走这条路（fetch body 传 Uint8Array）
  app.post('/api/files', async (req, reply) => {
    const bytes = req.body;
    const id = String(req.headers['x-file-id'] || '');
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
      reply.code(400).send({ ok: false, message: '请求体不是二进制（需要 application/octet-stream）' });
      return;
    }
    if (!verifyFileId(id, new Uint8Array(bytes))) {
      reply.code(400).send({ ok: false, message: '文件 id 与内容不匹配（SHA-256 校验失败）' });
      return;
    }
    saveFileRecord(id, String(req.headers['x-file-kind'] || 'image'),
      String(req.headers['x-file-name'] || ''),
      String(req.headers['x-file-mime'] || 'application/octet-stream'),
      new Uint8Array(bytes));
    return { ok: true, id, size: bytes.length };
  });

  // 批量上传（导入 24 张图一次性落库）：JSON + base64
  app.post('/api/files/batch', async (req, reply) => {
    const files = (req.body && req.body.files) || [];
    if (!Array.isArray(files) || !files.length) {
      reply.code(400).send({ ok: false, message: 'files 数组为空' });
      return;
    }
    const saved = [];
    const failed = [];
    for (const f of files) {
      try {
        const bytes = new Uint8Array(Buffer.from(f.bytesBase64 || '', 'base64'));
        if (!verifyFileId(f.id, bytes)) { failed.push({ id: f.id, reason: '校验失败' }); continue; }
        saveFileRecord(f.id, f.kind || 'image', f.name || '', f.mime || '',
          bytes, f.savedAt);
        saved.push(f.id);
      } catch (e) {
        failed.push({ id: f.id, reason: String(e && e.message || e) });
      }
    }
    return { ok: failed.length === 0, saved: saved.length, savedIds: saved, failed };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const meta = fileMetaRow(req.params.id);
    let p;
    try { p = filePathOf(req.params.id); } catch (e) { reply.code(400).send({ ok: false, message: e.message }); return; }
    if (!meta || !fs.existsSync(p)) {
      reply.code(404).send({ ok: false, message: '文件不存在' });
      return;
    }
    // 本 ERP 的文件是 Excel 与图片（≤50MB），整读成 Buffer 发送：
    // 生产与测试（inject 不收流）走同一条路径，行为一致
    reply
      .header('content-type', meta.mime || 'application/octet-stream')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(fs.readFileSync(p));
  });

  // 首屏恢复 24 张图一条请求拉齐（免 24 次 GET）
  app.post('/api/files/batch-get', async (req, reply) => {
    const ids = (req.body && req.body.ids) || [];
    const out = {};
    for (const id of ids.slice(0, 500)) {
      const meta = fileMetaRow(id);
      const p = (() => { try { return filePathOf(id); } catch (e) { return null; } })();
      if (meta && p && fs.existsSync(p)) {
        out[id] = { mime: meta.mime, dataUrl: 'data:' + meta.mime + ';base64,' + fs.readFileSync(p).toString('base64') };
      }
    }
    return { ok: true, files: out };
  });

  app.get('/api/files-stats', async () => ({ ok: true, ...fileStats() }));

  // 换取临时下载直链（飞书 WebView 等环境用）
  app.post('/api/download-temp', async (req) => {
    const { bytesBase64, name, mime } = req.body || {};
    const bytes = Buffer.from(bytesBase64 || '', 'base64');
    if (!bytes.length) return { ok: false, message: '空文件' };
    tokenSeq += 1;
    const token = 'dt-' + Date.now().toString(36) + '-' + tokenSeq + '-' + sha256Of(bytes).slice(0, 12);
    downloadTokens.set(token, {
      bytes, name: String(name || 'download'), mime: String(mime || 'application/octet-stream'),
      expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
    for (const [t, v] of downloadTokens) {
      if (v.expiresAt < Date.now()) downloadTokens.delete(t);
    }
    return { ok: true, token, url: '/api/download-temp/' + token, expiresAt: new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MS).toISOString() };
  });

  app.get('/api/download-temp/:token', async (req, reply) => {
    const v = downloadTokens.get(req.params.token);
    if (!v || v.expiresAt < Date.now()) {
      reply.code(404).send({ ok: false, message: '下载链接不存在或已过期' });
      return;
    }
    downloadTokens.delete(req.params.token); // 一次性
    reply.header('content-type', v.mime)
      .header('content-disposition', buildDisposition(v.name))
      .send(v.bytes);
  });
}

/** Content-Disposition 附件名（RFC 5987，中文文件名走 filename*） */
function buildDisposition(name) {
  const safe = String(name).replace(/["\\\r\n]/g, '');
  try {
    const utf8 = encodeURIComponent(safe);
    return "attachment; filename*=UTF-8''" + utf8 + "; filename=\"" +
      safe.replace(/[^\x20-\x7e]/g, '_') + '"';
  } catch (e) {
    return 'attachment; filename="download"';
  }
}
