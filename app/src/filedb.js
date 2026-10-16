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
// crypto.subtle 只在安全上下文（https / localhost）可用；用 http://公网IP
// 访问服务器版时它缺失——早期版本用 FNV 兜底 id，不是真哈希，服务器按
// 内容寻址校验一律拒收，图片永远传不上去还不报错（包 21 修）。现在兜底
// 是纯 JS 的真 SHA-256，两条路径产出的 id 完全一致。
//
// 所有函数失败时返回 null/false/空统计，绝不抛错打断页面——调用方据
// 返回值决定是否降级回包 2 的行为（图片只进 localStorage / 会话可见）。

import { bytesToDataUrl } from './xlsx/zip.js';
import { isServerAvailable, pushFile, fetchFileBytes } from './apiClient.js';

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

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** 纯 JS SHA-256（FIPS 180-4）：crypto.subtle 缺失时的兜底，必须产真哈希 */
export function sha256HexSync(u8) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const l = u8.length;
  const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  padded.set(u8);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, (l * 8) >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(l / 0x20000000) >>> 0);
  const w = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getInt32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 字节 → 内容哈希（十六进制）。优先 crypto.subtle，缺失时纯 JS 真 SHA-256 */
export async function hashBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof window !== 'undefined' && window.crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', u8);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* 落到纯 JS 兜底 */ }
  }
  return sha256HexSync(u8);
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
 * 落两处：本地 IndexedDB（离线事实源）+ 服务器（在线模式，云端事实源）。
 * 任何一处成功都返回元数据（不含字节）；只有两处全失败才返回 null。
 */
export async function putFile(rec) {
  const localMeta = await putLocal(rec);
  let serverMeta = null;
  if (rec && rec.id && rec.bytes && isServerAvailable()) {
    try { serverMeta = await pushFile(rec); } catch (e) { /* 云端推送失败不挡本地 */ }
  }
  if (localMeta) return localMeta;
  if (serverMeta && serverMeta.ok) {
    return {
      id: serverMeta.id, kind: rec.kind || 'image', mime: rec.mime || '',
      name: rec.name || '', size: serverMeta.size || 0, savedAt: rec.savedAt || null,
      where: 'server',
    };
  }
  return null;
}

/** 本地 IndexedDB 写入（原 putFile 主体；本地失败返回 null） */
async function putLocal(rec) {
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

/**
 * 按 id 读整条记录（含字节）。顺序：本地 → 服务器（在线模式回源）。
 * 本地没有但云端有：回 Cached 后不写回本地（下次仍走云端，避免本地
 * 配额误差造成"看起来存上了其实没有"的假象——原件下载用完即弃）。
 */
export async function getFile(id) {
  const db = await openDb();
  if (db && id) {
    const hit = await new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    if (hit) return hit;
  }
  if (!id || !isServerAvailable()) return null;
  try {
    const rec = await fetchFileBytes(id);
    return rec; // { id, kind, name, mime, bytes }；没有返回 null
  } catch (e) {
    return null;
  }
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
