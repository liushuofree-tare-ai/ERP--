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

/* ---------- 服务器血统标记（防首次接触闷头覆盖） ----------
 * 本浏览器只要「采纳过服务器数据」或「成功推上去过」，就记一笔。
 * 从没记过的浏览器打开一个已有数据的服务器时，它的本地存档多半是
 * 示例数据或别处带来的——绝不能凭本地时间戳新就把服务器覆盖掉。
 * 标记只在血统接续点写（pushState 成功 / adoptRemoteState），
 * 单纯读一次状态不算——读完就盖章会让防线形同虚设。 */
const SEEN_KEY = 'qipei_v2_server_seen_rev';
export function markServerSeen(revision) {
  try { localStorage.setItem(SEEN_KEY, String(revision || 0)); } catch (e) { /* 存不上不拦业务 */ }
}
export function hasSeenServer() {
  try { return localStorage.getItem(SEEN_KEY) !== null; } catch (e) { return false; }
}

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
  markServerSeen(serverRevision);
  return d;
}

/* ---------- 新鲜度探针（双人同用：对方已保存新版时，提醒本机拉取） ---------- */

/** 只读健康检查拿服务器当前 revision/savedAt，不动本地的同步基准。失败返回 null。 */
export async function peekServerRevision() {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.ok) return null;
    return { revision: d.revision || 0, savedAt: d.savedAt || null };
  } catch (e) {
    return null;
  }
}

/**
 * 纯判定：该不该弹「请拉取最新数据」。
 * 服务器版本比本机基准新、且这个版本还没被用户用「稍后再说」压下去过 → 弹。
 */
export function shouldPromptStale(knownRevision, remoteRevision, dismissedRevision) {
  return remoteRevision > knownRevision && remoteRevision > (dismissedRevision || 0);
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
