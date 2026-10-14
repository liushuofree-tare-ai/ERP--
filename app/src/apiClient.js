// 后端通信层（同一源 /api）：探测、状态同步、文件存取、备份、鉴权。
// 形态约定：
//  · file:// 打开（单机双击模式）→ 一律本地，不请求；
//  · http(s) 打开 → 启动探测 /api/health，通了进入"云端权限 + 本地镜像"；
//  · 所有失败不抛进页面流程：调用方拿返回值/错误码决定降级。
// 乐观锁：pushState 带 baseRevision；被 409 拒绝时由调用方提示用户
// 拉取服务器数据（绝不静默覆盖别的窗口的修改）。

let serverAvailable = false;
let serverRevision = 0;
let serverInfo = null;

export async function detectServer() {
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    serverAvailable = false;
    return { available: false, reason: 'file（单机模式）' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('health HTTP ' + res.status);
    const d = await res.json();
    serverAvailable = !!(d && d.ok && d.dbOk);
    serverRevision = serverAvailable ? (d.revision || 0) : 0;
    serverInfo = d;
    return { available: serverAvailable, revision: serverRevision, info: d };
  } catch (e) {
    serverAvailable = false;
    return { available: false, reason: String(e && e.message || e) };
  }
}

export const isServerAvailable = () => serverAvailable;
export const getServerRevision = () => serverRevision;
export const getServerInfo = () => serverInfo;

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) {
    const err = new Error((data && data.message) || '需要登录');
    err.code = 'NEED_AUTH';
    throw err;
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    err.code = (data && data.code) || ('HTTP_' + res.status);
    err.status = res.status;
    err.currentRevision = data && data.currentRevision;
    throw err;
  }
  return data;
}

/* ---------- 状态 ---------- */
export async function fetchServerState() {
  const d = await jfetch('/api/state');
  serverRevision = d.revision || 0;
  return d;
}

/** 整份状态推送（乐观锁）。成功返回 { ok, revision, savedAt }。 */
export async function pushState(baseRevision, state) {
  const d = await jfetch('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision, state }),
  });
  serverRevision = d.revision || serverRevision;
  return d;
}

/* ---------- 文件（内容寻址，原件/图片） ---------- */
export async function pushFile(rec) {
  const body = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-file-id': rec.id,
      'x-file-kind': rec.kind || 'image',
      'x-file-name': rec.name || '',
      'x-file-mime': rec.mime || 'application/octet-stream',
      'x-file-savedat': rec.savedAt || '',
    },
    body,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    const err = new Error((d && d.message) || 'HTTP ' + res.status);
    err.code = 'FILE_PUSH_FAILED';
    throw err;
  }
  return res.json();
}

/** 拉文件字节；没有（404）返回 null */
export async function fetchFileBytes(id) {
  const res = await fetch('/api/files/' + encodeURIComponent(id));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    id,
    kind: res.headers.get('x-file-kind') || 'image',
    name: res.headers.get('x-file-name') || '',
    mime: res.headers.get('x-file-mime') || 'application/octet-stream',
    bytes,
  };
}

/* ---------- 备份 ---------- */
/** 服务端导出完整备份 zip（格式与本地互导） */
export async function exportServerBackup() {
  const res = await fetch('/api/backup/export');
  let d = null;
  try { d = await res.json(); } catch (e) { d = null; }
  if (!res.ok) throw new Error((d && d.error) || 'HTTP ' + res.status);
  return { bytes: new Uint8Array(await res.arrayBuffer()), fileName: decodeURIComponent((res.headers.get('content-disposition') || '').split("''")[1] || '汽配ERP完整备份.zip') };
}

/** 服务端恢复（zip 字节）。失败抛带 message 的错误。 */
export async function restoreServerBackup(bytes) {
  return jfetch('/api/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  });
}

/** 飞书 Webhook 推送（服务端没配 webhook → 501 明说） */
export async function feishuNotify(text, card) {
  return jfetch('/api/feishu/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, card }),
  });
}

/** 飞书侧信息（webhook/app 是否已配置） */
export async function feishuConfig() {
  return jfetch('/api/feishu/config');
}

/* ---------- 临时下载直链（飞书内置浏览器下载用） ---------- */
export async function makeDownloadToken(bytes, name, mime) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = await jfetch('/api/download-temp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bytesBase64: bytesToBase64(body),
      name, mime,
    }),
  });
  return d;
}

export async function openTempDownload(bytes, name, mime) {
  const d = await makeDownloadToken(bytes, name, mime);
  if (d && d.url) window.open(d.url, '_blank');
  return d;
}

/* ---------- 登录（访问口令模式） ---------- */
export async function loginPassword(password) {
  return jfetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
