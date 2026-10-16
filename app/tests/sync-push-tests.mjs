/* 云端自动推送回归（包 19 实测抓到的老 bug）：
 * saveWorkAndSync 的可用性判断曾写反——服务器在线时反而只存本地、
 * 从不推送（服务器 revision 永远不动，双人同步无从谈起）。
 * 本测试用桩 fetch + 桩 localStorage 验证：
 *   1) 服务器在线 → 保存必须真发出 PUT /api/state 且状态置 ok；
 *   2) 基准版本落后 → 409 映射为 conflict（弹窗逻辑的地基）。 */

/* ---- 桩 localStorage ---- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

/* ---- 桩 fetch：一个带 revision 的假服务器 ---- */
let serverRev = 0;
let putCount = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (status, obj) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => obj, headers: { get: () => null },
  });
  if (u.endsWith('/api/health')) return json(200, { ok: true, dbOk: true, revision: serverRev, savedAt: null });
  if (u.endsWith('/api/state') && (opts.method || 'GET') === 'PUT') {
    putCount += 1;
    const body = JSON.parse(opts.body);
    if (body.baseRevision !== serverRev) {
      return json(409, { ok: false, code: 'REVISION_CONFLICT', currentRevision: serverRev, message: '版本冲突' });
    }
    serverRev += 1;
    return json(200, { ok: true, revision: serverRev, savedAt: new Date().toISOString() });
  }
  throw new Error('未桩的请求：' + u);
};

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) throw new Error('FAIL: ' + name);
  console.log('  ✓', name);
}
const tick = () => new Promise((r) => setTimeout(r, 60));

const api = await import('../src/apiClient.js');
const det = await api.detectServer();
ok(det.available === true, '探测：桩服务器在线');
const store = await import('../src/store.js');

console.log('== 服务器在线时保存必须真推送');
store.saveWorkAndSync({ docs: [], orders: [], customers: [], factories: [], orderSeq: 0, activeDocId: 'doc-inquiry' });
await tick();
ok(putCount === 1, '发出了一次 PUT /api/state（写反时这里是 0）');
ok(store.lastSyncInfo().status === 'ok', '同步状态 ok');
ok(api.getServerRevision() === 1, '本地基准版本跟到 rev 1');

console.log('== 基准落后时 409 → conflict');
serverRev = 5; // 假装同事连存了几版
store.saveWorkAndSync({ docs: [], orders: [], customers: [], factories: [], orderSeq: 0, activeDocId: 'doc-inquiry' });
await tick();
ok(store.lastSyncInfo().status === 'conflict', '同步状态 conflict');
ok(store.lastSyncInfo().currentRevision === 5, 'conflict 带回服务器当前版本 5');

console.log('\n汇总：PASS ' + n + ' / FAIL 0');
