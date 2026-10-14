// 完整备份与恢复（SPEC 第四节第 12 项）：一份 .zip 里装——
//   manifest.json  清单：应用版本、导出时间、单据计数、每个文件的
//                  大小与 SHA-256（恢复时逐件核对，对不上就拒绝）；
//   data.json      业务存档原文（localStorage 里那份，一字不改）；
//   files/<id>     文件仓库里的每个文件字节（原文件 + 图片）。
// 恢复的铁规矩：先全部校验（清单、data.json 形状、每件大小+哈希），
// 全过了才动当前数据；校验不过就用人话报错、当前数据一根汗毛不碰。
// AI 接口钥匙不在备份里——它单独存（aiConfig.js），不跟业务数据走。
import { zipSync, unzipSync } from 'fflate';
import { DB_KEY } from './store.js';
import { listAllFiles, putFile, deleteFile } from './filedb.js';
import { APP_VERSION } from './version.js';

export const BACKUP_FORMAT = 'qipei-erp-v2-backup';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

/** 字节 → SHA-256 十六进制（与 filedb 同策略：subtle 缺失时 FNV 兜底） */
export async function sha256Hex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (globalThis.crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', u8);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* 落到兜底 */ }
  }
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < u8.length; i++) {
    h1 = Math.imul(h1 ^ u8[i], 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + u8[i]) >>> 0;
  }
  return 'fnv' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') +
    u8.length.toString(16);
}

/**
 * 拼备份清单（纯函数，便于测试）。files 是已算好哈希的文件元数据：
 * [{ id, kind, name, mime, size, savedAt, sha256 }]。
 */
export function buildManifest({ version, exportedAt, archiveJson, archiveSha256, files }) {
  let counts = { docs: 0, inquiries: 0, quotes: 0, orders: 0, factories: 0, files: (files || []).length };
  try {
    const a = JSON.parse(archiveJson);
    if (a && Array.isArray(a.docs)) {
      counts.docs = a.docs.length;
      counts.inquiries = a.docs.filter((d) => d && d.kind === 'inquiry').length;
      counts.quotes = a.docs.filter((d) => d && d.kind === 'quote').length;
    }
    if (a && Array.isArray(a.orders)) counts.orders = a.orders.length;
    if (a && Array.isArray(a.factories)) counts.factories = a.factories.length;
  } catch (e) { /* 计数算不出不挡备份本身，恢复校验会把关 */ }
  return {
    format: BACKUP_FORMAT,
    appVersion: version,
    exportedAt,
    counts,
    archive: { path: 'data.json', bytes: enc.encode(archiveJson).length, sha256: archiveSha256 },
    files: (files || []).map((f) => ({
      id: f.id, path: 'files/' + f.id, kind: f.kind || 'image',
      name: f.name || '', mime: f.mime || 'application/octet-stream',
      size: f.size, savedAt: f.savedAt || null, sha256: f.sha256,
    })),
  };
}

/**
 * 记录清单 + 存档原文 → 备份 zip 字节（纯函数）。
 * records: [{ id, kind, name, mime, savedAt, bytes }]（文件仓库的记录）。
 */
export async function buildBackupZip({ version, exportedAt, archiveJson, records }) {
  const metas = [];
  const entries = {};
  for (const rec of records || []) {
    const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
    const meta = {
      id: rec.id, kind: rec.kind || 'image', name: rec.name || '',
      mime: rec.mime || 'application/octet-stream', size: bytes.length,
      savedAt: rec.savedAt || null, sha256: await sha256Hex(bytes),
    };
    metas.push(meta);
    entries['files/' + rec.id] = [bytes, { level: 0 }];
  }
  const archiveSha256 = await sha256Hex(enc.encode(archiveJson));
  const manifest = buildManifest({ version, exportedAt, archiveJson, archiveSha256, files: metas });
  entries['manifest.json'] = [enc.encode(JSON.stringify(manifest, null, 2)), { level: 0 }];
  entries['data.json'] = [enc.encode(archiveJson), { level: 0 }];
  return { bytes: zipSync(entries), manifest };
}

/**
 * 拆一份备份并全面校验（不碰任何现有数据）。
 * 返回 { ok, errors: [人话…], manifest, archiveJson, files: [{id,…,bytes}] }。
 */
export async function parseAndValidateBackup(input) {
  const errors = [];
  let parts;
  try {
    parts = unzipSync(input instanceof Uint8Array ? input : new Uint8Array(input));
  } catch (e) {
    return { ok: false, errors: ['这个文件打不开（不是完好的 zip 备份文件）'], manifest: null, archiveJson: null, files: [] };
  }
  // 清单
  let manifest = null;
  if (!parts['manifest.json']) {
    errors.push('备份里缺清单文件 manifest.json，这可能不是本系统导出的完整备份');
  } else {
    try { manifest = JSON.parse(dec.decode(parts['manifest.json'])); } catch (e) { manifest = null; }
    if (!manifest) errors.push('备份清单读不懂（manifest.json 已损坏）');
    else if (manifest.format !== BACKUP_FORMAT) {
      errors.push('这不是本系统的完整备份（清单格式对不上），已拒绝恢复');
      manifest = null;
    }
  }
  // 业务存档
  let archiveJson = null;
  let archiveObj = null;
  if (!parts['data.json']) {
    errors.push('备份里缺业务数据 data.json');
  } else {
    archiveJson = dec.decode(parts['data.json']);
    try { archiveObj = JSON.parse(archiveJson); } catch (e) { archiveObj = null; }
    if (!archiveObj || archiveObj.version !== 2 || !Array.isArray(archiveObj.docs)) {
      errors.push('备份里的业务数据形状不对（不是本系统的存档），已拒绝恢复');
      archiveJson = null;
    } else if (manifest && manifest.archive && manifest.archive.sha256) {
      const actual = await sha256Hex(parts['data.json']);
      if (actual !== manifest.archive.sha256) {
        errors.push('业务数据和清单对不上（data.json 可能被改动过），已拒绝恢复');
        archiveJson = null;
      }
    }
  }
  // 逐个文件核对大小 + 哈希
  const files = [];
  if (manifest && Array.isArray(manifest.files)) {
    for (const meta of manifest.files) {
      const bytes = parts[meta.path || ('files/' + meta.id)];
      if (!bytes) {
        errors.push('备份里少了一个文件：' + (meta.name || meta.id));
        continue;
      }
      if (bytes.length !== meta.size) {
        errors.push('文件「' + (meta.name || meta.id) + '」大小对不上（清单记 ' +
          meta.size + ' 字节，实际 ' + bytes.length + ' 字节），备份可能已损坏');
        continue;
      }
      const actual = await sha256Hex(bytes);
      if (actual !== meta.sha256) {
        errors.push('文件「' + (meta.name || meta.id) + '」内容对不上（校验值不一致），备份可能已损坏');
        continue;
      }
      files.push({
        id: meta.id, kind: meta.kind, name: meta.name, mime: meta.mime,
        savedAt: meta.savedAt, bytes,
      });
    }
  }
  return { ok: errors.length === 0, errors, manifest, archiveJson, files };
}

/* ---------- 浏览器侧：采集与落盘（校验在 parseAndValidateBackup） ---------- */

/** 建议的备份文件名：汽配ERP完整备份-YYYYMMDD-HHmm.zip */
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return '汽配ERP完整备份-' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
    '-' + p(date.getHours()) + p(date.getMinutes()) + '.zip';
}

/**
 * 采集当前全部数据 → 备份 zip。返回 { ok, bytes, manifest, fileName }
 * 或 { ok: false, error: 人话 }。没有存档/仓库打不开时明确失败，
 * 绝不生成一份残缺的"完整备份"。
 */
export async function collectBackupBytes() {
  let archiveJson = null;
  try { archiveJson = localStorage.getItem(DB_KEY); } catch (e) { /* 读不到按没有处理 */ }
  if (!archiveJson) {
    return { ok: false, error: '还没有保存过工作（先导入一张表干点活），现在没有可备份的数据' };
  }
  const records = await listAllFiles();
  if (records === null) {
    return { ok: false, error: '文件仓库打不开，没法把原文件和图片打进备份，这次没有生成备份' };
  }
  const exportedAt = new Date().toISOString();
  const { bytes, manifest } = await buildBackupZip({
    version: APP_VERSION, exportedAt, archiveJson, records,
  });
  return { ok: true, bytes, manifest, fileName: backupFileName() };
}

/** 轻量选项：只导出业务存档 JSON 原文（不含原文件/图片字节） */
export function readArchiveJson() {
  try { return localStorage.getItem(DB_KEY); } catch (e) { return null; }
}

/**
 * 把一份已校验通过的备份落盘。调用方必须先 parseAndValidateBackup 且
 * ok 才可调。返回 { ok, error? }；失败时调用方不要刷新页面。
 *
 * BUG M5 修复：旧实现"先清后写"（clearFiles → clearSaved → 逐件写），
 * 中途任何一步失败，旧数据已经被清掉，恢复本身成了数据丢失点。
 * 现在改为"先写后清"，并把清仓推迟到确认全部写成功之后：
 *   1. 先把备份里的文件逐件写进仓库（同 id 覆盖写，幂等）；
 *      fileId 是内容寻址的 SHA-256，同 id 必然同内容，覆盖不会写错；
 *   2. 再把存档原文写回 localStorage；
 *   3. 两者都确认成功后，才清掉仓库里"这次备份没有的"残留文件；
 * 任何一步失败都立即中止，当前数据保持原样可用。
 */
export async function applyBackup(validated) {
  if (!validated || !validated.ok) {
    return { ok: false, error: '这份备份没有通过校验，不能恢复' };
  }
  const wantedIds = new Set((validated.files || []).map((f) => f.id));
  const written = [];
  for (const f of validated.files) {
    const rec = await putFile({
      id: f.id, kind: f.kind, name: f.name, mime: f.mime,
      savedAt: f.savedAt || undefined, bytes: f.bytes,
    });
    if (!rec) {
      return { ok: false, error: '写入文件「' + (f.name || f.id) + '」失败，恢复已中止，当前数据没有动' };
    }
    written.push(f.id);
  }
  // 存档原文回写：这一步失败时文件已写进去，但旧存档仍在，用户的工作照旧可用
  try {
    localStorage.setItem(DB_KEY, validated.archiveJson);
  } catch (e) {
    return { ok: false, error: '业务存档写不回去（浏览器存储空间不足？），恢复已中止，当前数据没有动' };
  }
  // 全部成功后才清掉备份以外的残留文件（清不掉不影响本次恢复结果）
  try {
    const existing = await listAllFiles();
    if (existing) {
      for (const r of existing) {
        if (!wantedIds.has(r.id)) await deleteFile(r.id);
      }
    }
  } catch (e) { /* 残留文件不挡恢复；仓库里的孤儿由下次备份自然收敛 */ }
  return { ok: true, restoredFiles: written.length };
}
