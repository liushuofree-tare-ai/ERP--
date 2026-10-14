// 文件仓库（IndexedDB）：存二进制字节——导入的原文件（原件留底）与
// 表格图片。localStorage 只存工作现场与图片"引用"（见 store.js），
// 字节一律放这里，避免照片撑爆 localStorage 的 5–10MB 配额（包 2 实测
// 照片多的导入会溢出，图片只能当次会话可见；本包把图片转正为耐久存储）。
//
// ID 设计（内容寻址）：
//   图片   id = 'img-'  + SHA-256(字节) 前 20 位十六进制
//   原文件 id = 'orig-' + SHA-256(字节) 前 20 位十六进制
// 相同字节 → 相同 id → 仓库里只存一份，多个锚点/多次导入引用同一份，
// 天然去重（真实客户单 24 张图里就有 2 张字节相同，去重后存 23 份）。
// crypto.subtle 不可用时退化为 FNV-1a 哈希（id 仍稳定，只是抗撞性弱）。
//
// 所有函数失败时返回 null/false/空统计，绝不抛错打断页面——调用方据
// 返回值决定是否降级回包 2 的行为（图片只进 localStorage / 会话可见）。

import { bytesToDataUrl } from './xlsx/zip.js';

export const FILE_DB_NAME = 'qipei_v2_files';
const FILE_DB_VERSION = 1;
const STORE = 'files';
const PROBE_ID = '__filedb_probe__';

let dbPromise = null;
let dbFailed = false;

/** 打开（并按需建）文件仓库；失败返回 null，且不缓存失败以便重试 */
function openDb() {
  if (dbFailed && !dbPromise) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!window.indexedDB) { dbPromise = null; dbFailed = true; resolve(null); return; }
    let req;
    try { req = indexedDB.open(FILE_DB_NAME, FILE_DB_VERSION); } catch (e) {
      dbPromise = null; dbFailed = true; resolve(null); return;
    }
    req.onerror = () => { dbPromise = null; dbFailed = true; resolve(null); };
    req.onblocked = () => { /* 别的页面占着旧版本时等一等，onsuccess/onerror 会跟上 */ };
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(STORE, { keyPath: 'id' }); } catch (e) { /* 已存在 */ }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

/** 仓库是否可用（自检与降级判断用） */
export async function isFileDbAvailable() {
  return !!(await openDb());
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('事务失败'));
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

/* ---------- 哈希与编码 ---------- */

/** 字节 → 内容哈希（十六进制）。优先 SHA-256，缺失时 FNV-1a 兜底 */
export async function hashBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
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

/** 图片字节 → 仓库 id */
export async function imageIdFor(bytes) {
  return 'img-' + (await hashBytes(bytes)).slice(0, 20);
}

/** 原文件字节 → 仓库 id */
export async function originalIdFor(bytes) {
  return 'orig-' + (await hashBytes(bytes)).slice(0, 20);
}

/** data URL → { bytes, mime }（导入时把 xlsx 层的 data URL 转回字节存仓库） */
export function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (m[2]) {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
}

/** 字节 → data URL（恢复时给 FortuneSheet 当图片 src） */
export function fileBytesToDataUrl(bytes, mime) {
  return bytesToDataUrl(bytes, mime || 'application/octet-stream');
}

/* ---------- 仓库操作 ---------- */

/**
 * 存一份文件。rec: { id, kind: 'image'|'original', bytes, mime, name? }
 * 返回存入的元数据（不含字节）；失败返回 null。
 */
export async function putFile(rec) {
  const db = await openDb();
  if (!db || !rec || !rec.id || !rec.bytes) return null;
  const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
  const full = {
    id: rec.id,
    kind: rec.kind || 'image',
    mime: rec.mime || 'application/octet-stream',
    name: rec.name || '',
    size: bytes.length,
    savedAt: rec.savedAt || new Date().toISOString(),
    bytes,
  };
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(full);
    await txDone(tx);
    const { bytes: _omit, ...meta } = full;
    return meta;
  } catch (e) {
    return null;
  }
}

/** 按 id 读整条记录（含字节）；没有/失败返回 null */
export async function getFile(id) {
  const db = await openDb();
  if (!db || !id) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

/** 按 id 删除；返回是否执行了删除事务 */
export async function deleteFile(id) {
  const db = await openDb();
  if (!db || !id) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
    return true;
  } catch (e) {
    return false;
  }
}

/** 清空整个仓库（「清空重开」用）；返回是否成功 */
export async function clearFiles() {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 仓库统计（自检页用）：只汇总元数据，不把字节读进内存清单。
 * 返回 { originalCount, originalBytes, imageCount, imageBytes, totalCount, totalBytes }
 */
export async function fileStats() {
  const empty = {
    originalCount: 0, originalBytes: 0,
    imageCount: 0, imageBytes: 0,
    totalCount: 0, totalBytes: 0,
  };
  const db = await openDb();
  if (!db) return empty;
  const all = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
  const st = { ...empty };
  for (const rec of all) {
    if (!rec || rec.id === PROBE_ID) continue;
    const size = rec.size != null ? rec.size : (rec.bytes ? rec.bytes.length : 0);
    st.totalCount += 1;
    st.totalBytes += size;
    if (rec.kind === 'original') { st.originalCount += 1; st.originalBytes += size; }
    else { st.imageCount += 1; st.imageBytes += size; }
  }
  return st;
}

/**
 * 列出仓库里的原件记录（只回元数据，不带字节）：
 * [{ id, name, size, savedAt }]。存档迁移/恢复时按原文件名找回
 * sourceFileId 用——包 3/4 的存档里没记原件 id，靠文件名对上号。
 */
export async function listOriginals() {
  const db = await openDb();
  if (!db) return [];
  const all = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
  return all
    .filter((rec) => rec && rec.kind === 'original')
    .map((rec) => ({
      id: rec.id, name: rec.name || '',
      size: rec.size != null ? rec.size : (rec.bytes ? rec.bytes.length : 0),
      savedAt: rec.savedAt || null,
    }));
}

/**
 * 列出仓库里的全部记录（含字节）：完整备份导出用（包 9）。
 * 仓库打不开时返回 null（与"仓库是空的 []"区分——备份据此报错，
 * 绝不悄悄生成一份缺原文件/图片的"完整备份"）。
 */
export async function listAllFiles() {
  const db = await openDb();
  if (!db) return null;
  const all = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  if (!all) return null;
  return all.filter((rec) => rec && rec.id !== PROBE_ID);
}

/**
 * 仓库往返自检（自检页调用）：写一条探针 → 读回逐字节比对 → 删除。
 * 用的是真实仓库 qipei_v2_files，而不是另开的测试库——验的就是生产路径。
 */
export async function idbSelfTest() {
  if (!window.indexedDB) return { ok: false, detail: '浏览器不支持 IndexedDB' };
  const probe = new Uint8Array([113, 105, 112, 101, 105, 45, 118, 50]); // "qipei-v2"
  const put = await putFile({
    id: PROBE_ID, kind: 'image', bytes: probe, mime: 'application/octet-stream',
  });
  if (!put) return { ok: false, detail: '往图片仓库写数据失败（浏览器可能禁用了 IndexedDB，或空间不足）' };
  const got = await getFile(PROBE_ID);
  await deleteFile(PROBE_ID);
  const good = !!(got && got.bytes && got.bytes.length === probe.length &&
    probe.every((b, i) => got.bytes[i] === b));
  return good
    ? { ok: true, detail: '读写正常（导入的原文件与图片字节就存这里，关页重开也在）' }
    : { ok: false, detail: '写进去了但读不回来，图片可能存不住' };
}
