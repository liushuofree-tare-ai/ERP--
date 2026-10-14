// 包 9 测试：总览台账现算、AI 摘要、AI 配置隔离、完整备份清单与校验。
// 覆盖 brief 的硬要求：
//  · 摘要在虚构存档上数字对得上（总额/单龄/高频 OE），且超长会截断并注明；
//  · AI 钥匙只进独立键 qipei_v2_ai，永不进业务存档（不进备份）；
//  · 备份清单逐件记大小 + SHA-256（与 node:crypto 独立实现互验），
//    校验能拒掉"清单把大小写错"和"文件字节被换"两种篡改。
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

/* Node 里没有 localStorage：装一个内存版（aiConfig/store 只在函数内用） */
{
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m,
  };
}

const { buildOverview } = await import('../src/overview.js');
const { buildAiDigest, DIGEST_CAP } = await import('../src/aiDigest.js');
const { loadAiConfig, saveAiConfig, AI_CFG_KEY } = await import('../src/aiConfig.js');
const {
  buildManifest, buildBackupZip, parseAndValidateBackup, sha256Hex,
} = await import('../src/backup.js');
const { DB_KEY } = await import('../src/store.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function has(text, sub, label) {
  ok(typeof text === 'string' && text.includes(sub), label, typeof text === 'string' ? text.slice(0, 120) + '…' : text);
}

const enc = new TextEncoder();
const nodeSha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/* ---------- 虚构存档（沿用真实链的数字：8013 / 6615 / 超收 100） ---------- */
const order1 = {
  orderNo: 'ORD2610-0001', createdAt: '2026-10-01T10:00:00.000Z',
  customerName: '欧冠嘉', inquiryDocId: 'doc-inquiry',
  lines: [
    { lineId: 'L3', oe: 'F208401100', name: '散热器格栅', factory: '回表工厂',
      qty: 10, costRaw: 546, costTaxInclusive: true, costTaxRatePct: '',
      finalPrice: 660.20, shippedQty: 10 },
    { lineId: 'L4', oe: 'F081301110HD', name: '保险杠', factory: '回表工厂',
      qty: 5, costRaw: 231, costTaxInclusive: true, costTaxRatePct: '',
      finalPrice: 282.20, shippedQty: 5 },
  ],
  receipts: [{ amount: 8013 }, { amount: 100 }],
  factoryPays: [{ factory: '回表工厂', amount: 6615 }],
};
const order2 = {
  orderNo: 'ORD2610-0002', createdAt: '2026-10-10T10:00:00.000Z',
  customerName: '欧冠嘉', inquiryDocId: 'doc-inquiry',
  lines: [
    { lineId: 'L3', oe: 'F208401100', name: '散热器格栅', factory: '回表工厂',
      qty: 2, costRaw: 546, costTaxInclusive: true, costTaxRatePct: '',
      finalPrice: 660.20, shippedQty: 0 },
  ],
  receipts: [],
  factoryPays: [],
};
const ledgerRows = Array.from({ length: 39 }, (_, i) => ({ lineId: 'L' + (i + 1), row: i }));
const state = {
  docs: [
    { docId: 'doc-inquiry', kind: 'inquiry', customerName: '欧冠嘉',
      source: { fileName: '___2_0dib.xlsx' }, ledger: { rows: ledgerRows },
      rowChoices: { L3: {}, L4: {} } },
    { docId: 'doc-quote-1', kind: 'quote', factoryName: '回表工厂',
      priceMark: { col: 9, taxInclusive: true } },
  ],
  factories: ['回表工厂'],
  orders: [order1, order2],
};

/* ---------- 总览台账 ---------- */
{
  const ov = buildOverview(state);
  eq(ov.counts, { inquiries: 1, quotes: 1, orders: 2 }, '总览计数：询价 1 / 报价 1 / 订单 2');
  eq(ov.totals.receivable, 9333.40, '总应收 = 8013 + 660.20×2 = 9333.40');
  eq(ov.totals.received, 8113, '总已收 = 8013 + 100（超收那笔也在）');
  eq(ov.totals.unpaid, 1220.40, '总未收 = 9333.40 − 8113 = 1220.40');
  eq(ov.totals.payable, 7707, '总应付 = 6615 + 546×2 = 7707');
  eq(ov.totals.unpaidPay, 1092, '总未付 = 7707 − 6615 = 1092');
  eq(ov.totals.pendingShipLines, 1, '待发货行数：只有 order2 的一行没发');
  eq(ov.customers.length, 1, '客户台账合并成一行（询价单与订单同名合并）');
  eq(ov.customers[0], { name: '欧冠嘉', inquiries: 1, orders: 2, receivable: 9333.40, received: 8113, unpaid: 1220.40 },
    '客户行：欧冠嘉 询价 1 · 订单 2 · 应收 9333.40 · 未收 1220.40');
  eq(ov.factories.length, 1, '工厂台账一行');
  eq(ov.factories[0], { name: '回表工厂', quotes: 1, orderLines: 3, payable: 7707, paid: 6615, unpaid: 1092 },
    '工厂行：回表工厂 报价 1 · 订单行 3 · 应付 7707 · 未付 1092');
  const empty = buildOverview({ docs: [], factories: [], orders: [] });
  eq(empty.counts, { inquiries: 0, quotes: 0, orders: 0 }, '空存档总览不炸');
  eq(empty.totals.pendingShipLines, 0, '空存档待发货 0');
}

/* ---------- AI 摘要 ---------- */
{
  const now = new Date('2026-10-11T12:00:00.000Z');
  const digest = buildAiDigest(state, { now });
  has(digest, '询价单 1 张 · 报价单 1 张 · 订单 2 单', '摘要：单据计数');
  has(digest, '总应收 9333.40', '摘要：总应收');
  has(digest, '未收 1220.40', '摘要：总未收');
  has(digest, '客户「欧冠嘉」：询价单 1 张 · 订单 2 单', '摘要：客户行');
  has(digest, '工厂「回表工厂」：报价单 1 张 · 订单行 3 行', '摘要：工厂行');
  has(digest, '订单 ORD2610-0001', '摘要：订单号在');
  has(digest, '（距今 10 天）', '摘要：单龄（10 月 1 日 → 10 月 11 日 = 10 天）');
  has(digest, '待发货 1 行', '摘要：待发货行数');
  has(digest, 'OE F208401100「散热器格栅」：出现在 2 个订单行 · 合计 12 件', '摘要：高频 OE 跨订单合并计数');
  has(digest, '已标价列（第 10 列，含税）', '摘要：报价单标价状态');
  has(digest, '39 行 · 已定厂 2 行', '摘要：询价单行数与定厂进度');
  ok(!digest.includes('已截断'), '摘要：正常数据量不截断');

  const many = {
    docs: [], factories: [],
    orders: Array.from({ length: 500 }, (_, i) => ({
      ...order2, orderNo: 'ORD2610-' + String(i + 1).padStart(4, '0'),
    })),
  };
  const big = buildAiDigest(many, { now });
  ok(big.length <= DIGEST_CAP + 80, '摘要：500 单时封顶（≤ 上限 + 截断注）', big.length);
  has(big, '摘要已截断', '摘要：超长时注明已截断');
}

/* ---------- AI 配置隔离 ---------- */
{
  localStorage.clear();
  localStorage.setItem(DB_KEY, '{"version":2,"docs":[],"note":"业务存档"}');
  const before = localStorage.getItem(DB_KEY);
  const saved = saveAiConfig({
    baseUrl: 'https://example.com/v1', apiKey: 'sk-secret-123', model: 'TestModel',
  });
  eq(saved.apiKey, 'sk-secret-123', '配置：保存返回值带钥匙');
  eq([...localStorage._map.keys()], [DB_KEY, AI_CFG_KEY], '配置：只多了独立键 qipei_v2_ai');
  eq(localStorage.getItem(DB_KEY), before, '配置：业务存档一字未动');
  ok(!localStorage.getItem(DB_KEY).includes('sk-secret-123'), '配置：钥匙没漏进业务存档（不进备份）');
  eq(loadAiConfig(), { baseUrl: 'https://example.com/v1', apiKey: 'sk-secret-123', model: 'TestModel' },
    '配置：读回一致');
  localStorage.clear();
  eq(loadAiConfig(), { baseUrl: 'https://api.ant-ling.com/v1', apiKey: '', model: 'Ling-3.1-flash' },
    '配置：没存过时给默认（百灵地址 + Ling-3.1-flash）');
}

/* ---------- 备份清单与校验 ---------- */
{
  const archiveJson = JSON.stringify({
    version: 2, docs: state.docs, orders: [order1], factories: ['回表工厂'],
  });
  const origBytes = enc.encode('ORIGINAL-BYTES-客户原表');
  const imgBytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
  const records = [
    { id: 'orig-aaa', kind: 'original', name: '客户单.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      savedAt: '2026-10-11T08:00:00.000Z', bytes: origBytes },
    { id: 'img-bbb', kind: 'image', name: '', mime: 'image/png',
      savedAt: '2026-10-11T08:00:00.000Z', bytes: imgBytes },
  ];
  const { bytes, manifest } = await buildBackupZip({
    version: 'v2-pkg9', exportedAt: '2026-10-11T16:00:00.000Z', archiveJson, records,
  });
  eq(manifest.appVersion, 'v2-pkg9', '备份清单：应用版本记进去了');
  eq(manifest.counts.orders, 1, '备份清单：订单计数');
  eq(manifest.counts.files, 2, '备份清单：文件计数');
  eq(manifest.counts.inquiries, 1, '备份清单：询价单计数');
  eq(manifest.files[0].sha256, nodeSha(origBytes), '备份清单：原件 SHA-256 与独立实现互验');
  eq(manifest.files[1].sha256, nodeSha(imgBytes), '备份清单：图片 SHA-256 与独立实现互验');
  eq(manifest.files[1].size, imgBytes.length, '备份清单：文件大小记对了');
  eq(manifest.archive.sha256, nodeSha(enc.encode(archiveJson)), '备份清单：data.json 的 SHA-256');
  eq(await sha256Hex(imgBytes), nodeSha(imgBytes), 'sha256Hex 与 node:crypto 一致');

  const good = await parseAndValidateBackup(bytes);
  eq(good.ok, true, '备份校验：完好备份通过');
  eq(good.errors, [], '备份校验：完好备份零错误');
  eq(good.archiveJson, archiveJson, '备份校验：存档原文一字不差带回来');
  eq(good.files.length, 2, '备份校验：两个文件都带回来');
  eq(Buffer.from(good.files[0].bytes).equals(Buffer.from(origBytes)), true, '备份校验：原件字节一致');

  // 篡改一：清单把文件大小写错 → 必须拒
  const lieManifest = buildManifest({
    version: 'v2-pkg9', exportedAt: '2026-10-11T16:00:00.000Z', archiveJson,
    archiveSha256: nodeSha(enc.encode(archiveJson)),
    files: [
      { id: 'orig-aaa', kind: 'original', name: '客户单.xlsx', mime: records[0].mime,
        size: origBytes.length, savedAt: null, sha256: nodeSha(origBytes) },
      { id: 'img-bbb', kind: 'image', name: '', mime: 'image/png',
        size: 999, savedAt: null, sha256: nodeSha(imgBytes) },
    ],
  });
  const lieZip = zipSync({
    'manifest.json': enc.encode(JSON.stringify(lieManifest)),
    'data.json': enc.encode(archiveJson),
    'files/orig-aaa': origBytes,
    'files/img-bbb': imgBytes,
  });
  const lie = await parseAndValidateBackup(lieZip);
  eq(lie.ok, false, '备份校验：清单大小写错 → 拒绝');
  ok(lie.errors.some((e) => e.includes('大小对不上')), '备份校验：拒绝原因点名大小', lie.errors);

  // 篡改二：文件字节被换（长度相同）→ 哈希对不上，必须拒
  const swapped = new Uint8Array([9, 9, 9, 9, 9, 9, 9]);
  const tamperedZip = zipSync({
    'manifest.json': enc.encode(JSON.stringify(manifest)),
    'data.json': enc.encode(archiveJson),
    'files/orig-aaa': origBytes,
    'files/img-bbb': swapped,
  });
  const tampered = await parseAndValidateBackup(tamperedZip);
  eq(tampered.ok, false, '备份校验：文件字节被换 → 拒绝');
  ok(tampered.errors.some((e) => e.includes('内容对不上')), '备份校验：拒绝原因点名内容', tampered.errors);

  // 篡改三：根本不是 zip
  const junk = await parseAndValidateBackup(new Uint8Array([1, 2, 3, 4]));
  eq(junk.ok, false, '备份校验：不是 zip → 拒绝');
}

/* ---------- M5：恢复走"先写后清"，写失败时当前数据一根汗毛不动 ---------- */
{
  // filedb 走真实代码路径需要 IndexedDB：装一个内存桩（Node 无此全局）。
  // 注意 filedb.openDb 会缓存 dbPromise——桩必须在首次调用前装好。
  const mem = new Map();
  let failPut = false;
  const reqOf = (fn) => {
    const req = { result: undefined, onsuccess: null, onerror: null };
    Promise.resolve().then(() => {
      try { req.result = fn(); if (req.onsuccess) req.onsuccess(); }
      catch (e) { if (req.onerror) req.onerror(e); }
    });
    return req;
  };
  const fakeDb = {
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null, _ops: null, objectStore() { return storeApiWithOps(tx); } };
      Promise.resolve().then(() => {
        try { for (const op of (tx._ops || [])) op(); Promise.resolve().then(() => { if (tx.oncomplete) tx.oncomplete(); }); }
        catch (e) { if (tx.onerror) tx.onerror(e); }
      });
      return tx;
    },
  };
  function storeApiWithOps(tx) {
    const ops = [];
    tx._ops = ops;
    return {
      put(rec) { ops.push(() => { if (failPut) throw new Error('模拟配额不足'); mem.set(rec.id, rec); }); },
      get(id) { return reqOf(() => mem.get(id) || null); },
      delete(id) { ops.push(() => { mem.delete(id); }); },
      clear() { ops.push(() => { mem.clear(); }); },
      getAll() { return reqOf(() => [...mem.values()]); },
    };
  }
  globalThis.window = globalThis;
  globalThis.indexedDB = {
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null };
      Promise.resolve().then(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        req.result = fakeDb;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };

  const { applyBackup, buildBackupZip: bbz, parseAndValidateBackup: pav } =
    await import('../src/backup.js');
  const { putFile } = await import('../src/filedb.js');

  // 当前现场：仓库里有一张旧图 img-old + 存档指向它
  const currentArchive = JSON.stringify({ version: 2, docs: [], current: true });
  localStorage.setItem(DB_KEY, currentArchive);
  await putFile({ id: 'img-old', kind: 'image', bytes: enc.encode('OLD-IMAGE'), mime: 'image/png' });

  // 备份：原件 + 图片（不含 img-old）
  const backupArchive = JSON.stringify({ version: 2, docs: state.docs, orders: [order1], factories: ['回表工厂'] });
  const backupOrig = enc.encode('ORIGINAL-BYTES-客户原表');
  const backupImg = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
  const backup = await bbz({
    version: 'v2-m5', exportedAt: '2026-10-12T09:00:00.000Z', archiveJson: backupArchive,
    records: [
      { id: 'orig-aaa', kind: 'original', name: '客户单.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: backupOrig },
      { id: 'img-bbb', kind: 'image', name: '', mime: 'image/png', bytes: backupImg },
    ],
  });
  const validated = await pav(backup.bytes);
  eq(validated.ok, true, 'M5 前置：备份校验通过');

  // ① 写入失败（模拟配额不足）：恢复中止，当前数据原样
  failPut = true;
  const failed = await applyBackup(validated);
  eq(failed.ok, false, 'M5 ①：写入失败 → 恢复中止');
  ok((failed.error || '').includes('写入文件'), 'M5 ①：报错点名写入失败', failed.error);
  eq(localStorage.getItem(DB_KEY), currentArchive, 'M5 ①：当前存档一字未动（先写后清，不先清后写）');
  ok(mem.has('img-old'), 'M5 ①：仓库里的旧文件原样（没有任何东西被清掉）');
  failPut = false;

  // ② 全部写成功后：存档换新 + 孤儿文件（备份没有的 img-old）被清掉
  const applied = await applyBackup(validated);
  eq(applied.ok, true, 'M5 ②：恢复成功');
  eq(applied.restoredFiles, 2, 'M5 ②：写入 2 个文件');
  eq(localStorage.getItem(DB_KEY), backupArchive, 'M5 ②：存档换成备份原文');
  ok(mem.has('orig-aaa') && mem.has('img-bbb'), 'M5 ②：备份里的文件都在');
  ok(!mem.has('img-old'), 'M5 ②：孤儿文件已清（备份没有的不留）');

  // ③ 幂等：再恢复一次结果一致
  const again = await applyBackup(validated);
  eq(again.ok, true, 'M5 ③：重复恢复仍成功（同 id 覆盖写幂等）');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
