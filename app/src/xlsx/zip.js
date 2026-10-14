// zip 层：用成熟库 fflate 读写 xlsx（就是 zip）。文件层的一切保真操作
// 都建立在"原样拿到每个 part 的字节"之上，不经过任何会重排内容的模型。
import { unzipSync, zipSync } from 'fflate';

/** 打开一个 xlsx → Map<part路径, Uint8Array>（目录项跳过） */
export function openZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const raw = unzipSync(bytes);
  const parts = new Map();
  for (const name of Object.keys(raw)) {
    if (name.endsWith('/')) continue;
    parts.set(name, raw[name]);
  }
  return parts;
}

/** 把 Map<part路径, Uint8Array> 打回 zip 字节（写路径预留，本包暂未用） */
export function writeZip(parts) {
  const obj = {};
  for (const [name, bytes] of parts) obj[name] = bytes;
  return zipSync(obj);
}

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

export function partText(parts, path) {
  const b = parts.get(path);
  if (!b) return null;
  if (decoder) return decoder.decode(b);
  // 极旧环境兜底（正常不会走到）
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return decodeURIComponent(escape(s));
}

export function partBytes(parts, path) {
  return parts.get(path) || null;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

export function mimeOf(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** 字节 → data URL（浏览器/Node 双实现；大图分块避免爆栈） */
export function bytesToDataUrl(bytes, mime) {
  if (typeof Buffer !== 'undefined') {
    return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + mime + ';base64,' + btoa(bin);
}
