// 后端 API 全链路测试（app.inject，不占端口）：
// · 健康检查 / 空库状态
// · 状态整存整取（docs/orders/customers 往返一致）+ 乐观锁（旧 revision → 409）
// · 文件仓库：SHA-256 互验（对不上拒收）/ 上传下载往返 / 批量拉取 / 统计
// · 备份导出（格式与前端兼容）+ 校验拒绝篡改 + 恢复换回旧状态
// · 鉴权：开访问口令后 401 / 登录 / 登录后放行
// · 飞书配置端点未配置时给明确降级
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';

/* DATA_DIR 必须在 import config 前设好（config 在 import 时读环境变量） */
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'qipei-server-'));
process.env.DATA_DIR = DATA_DIR;

const { buildApp } = await import('../src/index.js');
const { getMeta } = await import('../src/db.js');
const { getCurrentRevision } = await import('../src/routes/state.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

/* ---------- 测试数据：与前端存档同构的最小状态 ---------- */
function makeSheet() {
  return {
    name: 'Sheet1', id: 'sheet-1', row: 5, column: 3,
    celldata: [
      { r: 0, c: 0, v: { v: '标题' } },
      { r: 1, c: 0, v: { v: 'OE码' } },
      { r: 2, c: 0, v: { v: 'F208401100' } },
      { r: 3, c: 0, v: { v: 'F081301110' } },
    ],
    config: { merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 3 } } },
    images: [{ id: 'img-1', fileId: null, src: '', left: 0, top: 0, width: 100, height: 80 }],
  };
}
const STATE_V1 = {
  version: 2, savedAt: '2026-10-15T09:00:00.000Z',
  factories: ['甲厂'],
  factoryInfo: { 甲厂: { contact: '老王', note: '周一不接单' } },
  customers: [{ name: '欧冠嘉', contact: '', note: '' }],
  orders: [{
    orderNo: 'ORD2610-0001', createdAt: '2026-10-15T09:00:00.000Z',
    customerName: '欧冠嘉', inquiryDocId: 'doc-inq-1', note: '',
    lines: [{ lineId: 'L3', oe: 'F208401100', name: '散热器格栅', factory: '甲厂', qty: 2, costRaw: 546, costTaxInclusive: true, costTaxRatePct: '', finalPrice: 660.2, shippedQty: 0 }],
    receipts: [], factoryPays: [], shipments: [],
  }],
  orderSeq: 1,
  activeDocId: 'doc-inq-1',
  docs: [{
    docId: 'doc-inq-1', kind: 'inquiry', factoryName: null, inquiryId: null,
    createdAt: '2026-10-15T09:00:00.000Z', note: '首单',
    sheet: makeSheet(), ledger: { version: 1, rows: [{ lineId: 'L1', row: 0 }, { lineId: 'L3', row: 2 }], nextSeq: 6, workColumns: [] },
    pricing: { costCol: null, taxInclusive: false, taxRatePct: '13', markupPct: '20', freight: '5', fxRate: '', salesCol: null },
    source: { fileName: '客户单.xlsx', sheetName: 'Sheet1', sheetIndex: 0 },
    sourceFileId: null, importInfo: '已导入 客户单.xlsx',
    headerRow: 1, priceMark: null, factoryExtras: [], rowChoices: {},
  }],
};

const app = buildApp({ logger: false });
await app.ready();

/* ---------- 1. 健康检查与空库 ---------- */
{
  const h = await app.inject({ method: 'GET', url: '/api/health' });
  ok(h.statusCode === 200, '健康：200');
  const hb = h.json();
  eq([hb.ok, hb.dbOk, hb.revision], [true, true, 0], '健康：db 正常、revision 0');
  const s0 = await app.inject({ method: 'GET', url: '/api/state' });
  const s0b = s0.json();
  eq([s0b.ok, s0b.revision, s0b.state], [true, 0, null], '空库：state 为 null');
}

/* ---------- 2. 状态整存整取 ---------- */
{
  const put = await app.inject({ method: 'PUT', url: '/api/state', payload: { baseRevision: null, state: STATE_V1 } });
  ok(put.statusCode === 200, '保存：200', put.json());
  eq(put.json().revision, 1, '保存：revision = 1');
  const get = await app.inject({ method: 'GET', url: '/api/state' });
  const gb = get.json();
  ok(gb.ok && gb.revision === 1 && gb.state, '读取：有状态');
  const st = gb.state;
  const outDoc = st.docs[0];
  const inDoc = STATE_V1.docs[0];
  eq(st.docs.length, 1, '往返：doc 数量');
  eq(outDoc.docId, inDoc.docId, '往返：docId');
  eq(outDoc.kind, 'inquiry', '往返：kind');
  eq(outDoc.headerRow, 1, '往返：headerRow');
  eq(outDoc.source, inDoc.source, '往返：source');
  eq(outDoc.rowChoices, inDoc.rowChoices, '往返：rowChoices');
  eq(outDoc.sheet.celldata.length, inDoc.sheet.celldata.length, '往返：sheet 格子数');
  eq(outDoc.sheet.config.merge['0_0'].cs, 3, '往返：合并配置');
  eq(st.orders.length, 1, '往返：订单数');
  eq(st.orders[0].lines[0].finalPrice, 660.2, '往返：订单行快照');
  eq(st.customers[0].name, '欧冠嘉', '往返：客户');
  eq(st.factories, ['甲厂'], '往返：工厂名单');
  eq(st.factoryInfo['甲厂'], { contact: '老王', note: '周一不接单' }, '往返：工厂信息');
  eq(st.orderSeq, 1, '往返：订单流水');
  eq(st.activeDocId, 'doc-inq-1', '往返：活动单');
  eq(getMeta('saved_at'), '2026-10-15T09:00:00.000Z', '往返：savedAt');
}

/* ---------- 3. 乐观锁 ---------- */
{
  const cur = await app.inject({ method: 'PUT', url: '/api/state', payload: { baseRevision: getCurrentRevision(), state: STATE_V1 } });
  ok(cur.statusCode === 200, '锁：当前 revision 保存成功', cur.json());
  eq(cur.json().revision, 2, '锁：revision 递增到 2');
  const stale = await app.inject({ method: 'PUT', url: '/api/state', payload: { baseRevision: 1, state: STATE_V1 } });
  eq(stale.statusCode, 409, '锁：旧 revision → 409');
  const body = stale.json();
  eq(body.code, 'REVISION_CONFLICT', '锁：冲突编码');
  ok(body.currentRevision === 2, '锁：响应带当前 revision', body);
}

/* ---------- 4. 文件仓库 ---------- */
const FILE_BYTES = Buffer.from('ORIGINAL-XLSX-BYTES');
const FILE_ID = 'orig-' + sha256Hex(FILE_BYTES).slice(0, 20);
{
  const bad = await app.inject({
    method: 'POST', url: '/api/files',
    headers: { 'content-type': 'application/octet-stream', 'x-file-id': 'orig-00000000000000000000', 'x-file-kind': 'original' },
    payload: FILE_BYTES,
  });
  eq(bad.statusCode, 400, '文件：id 与内容不匹配 → 400');
  const good = await app.inject({
    method: 'POST', url: '/api/files',
    headers: { 'content-type': 'application/octet-stream', 'x-file-id': FILE_ID, 'x-file-kind': 'original', 'x-file-name': '客户单.xlsx', 'x-file-mime': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    payload: FILE_BYTES,
  });
  eq(good.statusCode, 200, '文件：上传成功', good.json());
  const got = await app.inject({ method: 'GET', url: '/api/files/' + FILE_ID });
  eq(got.statusCode, 200, '文件：下载 200');
  ok(Buffer.from(got.rawPayload).equals(FILE_BYTES), '文件：字节往返一致');
  const st = await app.inject({ method: 'GET', url: '/api/files-stats' });
  ok(st.json().originalCount === 1, '文件：统计 1 个原件', st.json());
  const again = await app.inject({
    method: 'POST', url: '/api/files',
    headers: { 'content-type': 'application/octet-stream', 'x-file-id': FILE_ID, 'x-file-kind': 'original' },
    payload: FILE_BYTES,
  });
  eq(again.statusCode, 200, '文件：同 id 重传幂等');
  const bg = await app.inject({ method: 'POST', url: '/api/files/batch-get', payload: { ids: [FILE_ID, 'img-notexist'] } });
  const bgb = bg.json();
  ok(bgb.ok && Object.keys(bgb.files).length === 1, '文件：批量拉取只返回存在的', Object.keys(bgb.files || {}));
}

/* ---------- 5. 原件挂进状态（备份要用） ---------- */
{
  STATE_V1.docs[0].sourceFileId = FILE_ID;
  const put = await app.inject({ method: 'PUT', url: '/api/state', payload: { baseRevision: getCurrentRevision(), state: STATE_V1 } });
  ok(put.statusCode === 200, '状态：挂上原件 id 再存', put.json());
}

/* ---------- 6. 备份导出 + 恢复 ---------- */
{
  const ex = await app.inject({ method: 'GET', url: '/api/backup/export' });
  eq(ex.statusCode, 200, '备份导出：200', ex.body && String(ex.body).slice(0, 120));
  ok(String(ex.headers['content-disposition']).includes('attachment'), '备份导出：附件头');
  const bytes = ex.rawPayload;
  const parts = unzipSync(new Uint8Array(bytes));
  ok(!!parts['manifest.json'] && !!parts['data.json'], '备份：zip 含清单与存档');
  const manifest = JSON.parse(new TextDecoder().decode(parts['manifest.json']));
  eq(manifest.format, 'qipei-erp-v2-backup', '备份：格式标识（前端可恢复）');
  eq(manifest.counts.docs, 1, '备份：单据计数');
  eq(manifest.counts.files, 1, '备份：文件计数');
  eq(manifest.archive.sha256, sha256Hex(parts['data.json']), '备份：data.json 哈希互验');
  const dataObj = JSON.parse(new TextDecoder().decode(parts['data.json']));
  eq(dataObj.docs[0].sourceFileId, FILE_ID, '备份：存档里带了原件引用');
  ok(!!parts['files/' + FILE_ID], '备份：原文件字节在包里');

  // 恢复：先把当前状态改坏，再恢复备份，应回到备份版本
  const broken = JSON.parse(JSON.stringify(STATE_V1));
  broken.docs[0].docId = 'doc-inq-broken';
  broken.orders = [];
  const br = await app.inject({ method: 'PUT', url: '/api/state', payload: { baseRevision: getCurrentRevision(), state: broken } });
  ok(br.statusCode === 200, '恢复前置：当前状态改成坏样子');
  const res = await app.inject({ method: 'POST', url: '/api/backup/restore', headers: { 'content-type': 'application/zip' }, payload: bytes });
  ok(res.statusCode === 200 && res.json().ok === true, '恢复：成功', res.json());
  eq(res.json().restoredFiles, 1, '恢复：文件计数');
  const gs = await app.inject({ method: 'GET', url: '/api/state' });
  const st = gs.json().state;
  eq(st.docs[0].docId, 'doc-inq-1', '恢复：状态换回备份里的');
  eq(st.orders.length, 1, '恢复：订单回来');
  ok(st.docs[0].sourceFileId === FILE_ID, '恢复：原件引用在');

  // 篡改拒绝：等长换字节（inject 只认 Buffer，Uint8Array 会被 JSON 序列化）
  parts['files/' + FILE_ID] = Buffer.from('TAMPERED-ORIGINAL!!'); // 恰好 19 字节，命中内容校验
  const tampered = zipSync(parts);
  const bad = await app.inject({ method: 'POST', url: '/api/backup/restore', headers: { 'content-type': 'application/zip' }, payload: Buffer.from(tampered) });
  eq(bad.statusCode, 400, '篡改：文件字节被换 → 拒绝');
  ok(String(bad.json().message || '').includes('内容对不上'), '篡改：原因点名内容', bad.json());
}

/* ---------- 7. 鉴权（独立实例 + 独立口令） ---------- */
{
  const authApp = buildApp({ accessPassword: 'qipei-pass', authSecret: 'fixed-test-secret', logger: false });
  const blocked = await authApp.inject({ method: 'GET', url: '/api/state' });
  eq(blocked.statusCode, 401, '鉴权：未登录 → 401');
  eq(blocked.json().code, 'NEED_AUTH', '鉴权：NEED_AUTH');
  const hOk = await authApp.inject({ method: 'GET', url: '/api/health' });
  eq(hOk.statusCode, 200, '鉴权：health 不拦');
  // 前端页面/静态资源不设防：应用外壳本身不含数据，拦了浏览器根本加载不出登录入口
  const page = await authApp.inject({ method: 'GET', url: '/' });
  ok(page.statusCode !== 401, '鉴权：页面不拦（应用先加载、再在应用内登录）', page.statusCode);
  const wrong = await authApp.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } });
  eq(wrong.statusCode, 401, '鉴权：错误口令 → 401');
  const right = await authApp.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'qipei-pass' } });
  eq(right.statusCode, 200, '鉴权：正确口令 → 200');
  const setCookie = String(right.headers['set-cookie'] || '');
  ok(setCookie.includes('erp_auth='), '鉴权：种登录 Cookie', setCookie);
  const token = /erp_auth=([^;]+)/.exec(setCookie);
  const okReq = await authApp.inject({ method: 'GET', url: '/api/state', cookies: { erp_auth: token ? token[1] : '' } });
  eq(okReq.statusCode, 200, '鉴权：登录后放行');
  await authApp.close();
}

/* ---------- 8. 飞书端点降级（未配置也给明确回答） ---------- */
{
  const fc = await app.inject({ method: 'GET', url: '/api/feishu/config' });
  const fcb = fc.json();
  ok(fcb.ok === true && typeof fcb.webhook === 'boolean' && typeof fcb.app === 'boolean', '飞书：config 端点可答', fcb);
  const nf = await app.inject({ method: 'POST', url: '/api/feishu/notify', payload: { text: 'test' } });
  ok([501, 502, 200].includes(nf.statusCode), '飞书：notify 未配置 501 / 已配置 200-502', nf.statusCode);
}

await app.close();
const { closeDb } = await import('../src/db.js');
closeDb();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
if (fail > 0) process.exit(1);
