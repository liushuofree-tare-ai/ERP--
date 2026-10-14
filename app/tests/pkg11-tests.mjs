// 包 11 测试：导出行枚举统一、客户注册表播种/改名联动/删除规则、
// 工厂改名全域同步、报价单 inquiryId 迁移、多询价单比价隔离。
// 覆盖用户反馈的四件事背后的硬规则：
//  · 示例单（无账本）与真实单（有账本）的导出行枚举必须一致——
//    此前示例单枚举为 0 行，"勾了也导不出"；
//  · 改名是全域的：客户改名同步询价单 + 订单 + 注册表；工厂改名
//    同步报价单 + 定厂快照 + 订单行 + 订单付款 + 工厂名单；
//  · 删除是拦得住的：有历史单据的一律给原因，不许删；
//  · 旧存档（无 inquiryId、无 customers）启动迁移后补齐且幂等；
//  · 两张询价单的报价单/定厂互不串扰（按 inquiryId 隔离）。
import assert from 'node:assert';

const { inquiryDataRows } = await import('../src/quoteExport.js');
const { buildCompareRows } = await import('../src/compare.js');
const { createLedger } = await import('../src/ledger.js');
const {
  migrateState, quotesForInquiry, renameCustomer, renameFactory,
  customerDeleteBlock, factoryDeleteBlock, inquiryDeleteBlock,
  seedCustomerNames, buildCustomerModel, buildFactoryModel,
} = await import('../src/registry.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}

/* ---------- 造表小工具（规范格式 sheet） ---------- */
function sheetOf(cellRows, rowTotal) {
  const celldata = [];
  cellRows.forEach((row, r) => row.forEach((v, c) => {
    if (v !== null && v !== undefined && v !== '') celldata.push({ r, c, v: { v } });
  }));
  return {
    name: 'Sheet1', row: rowTotal || cellRows.length,
    column: Math.max(...cellRows.map((r) => r.length)), celldata, config: {},
  };
}
const HEADER = ['序号', '品牌', '品牌', '车型', '产品', '图片', 'OE码'];

/* ---------- 1. 导出行枚举：示例单（无账本）与真实单（有账本）一致 ---------- */
{
  // 与 main.jsx 的 initialData 同形：row=12、表头在第 2 行（物理 1）、数据 2 行
  const sampleSheet = sheetOf([
    ['欧冠嘉配件采购需求'],
    HEADER,
    [1, 'JETOUR', '奇瑞捷途', 'jetour x90 plus', '散热器格栅', null, 'F208401100'],
    [2, 'JETOUR', '奇瑞捷途', 'jetour x90 plus', '前保险杠', null, 'F208403101'],
  ], 12);
  const noLedger = inquiryDataRows({ docId: 's', kind: 'inquiry', sheet: sampleSheet, ledger: null });
  eq(noLedger.length, 10, '枚举：无账本示例单数出 10 行（与最终报价条的 dataRowCount 口径一致）');
  ok(noLedger.every((x) => !!x.lineId), '枚举：无账本时每行都有兜底 lineId（不再全是 null）');
  eq(noLedger[0].lineId, 'L3', '枚举：第一条数据行（物理行 2）lineId = L3（建账口径 L(行+1)）');
  eq(noLedger[1].lineId, 'L4', '枚举：第二条数据行 lineId = L4');

  const ledger = createLedger({ fileName: '示例数据', sheetName: 'Sheet1', sheetIndex: 0, rowCount: 12 });
  const withLedger = inquiryDataRows({ docId: 's', kind: 'inquiry', sheet: sampleSheet, ledger });
  eq(withLedger.map((x) => x.lineId), noLedger.map((x) => x.lineId),
    '枚举：有账本与无账本兜底给出的 lineId 完全一致');
  ok(withLedger.filter((x) => x.lineId).length >= 2,
    '枚举：导出面板按 lineId 过滤后至少剩 2 行真实数据（此前为 0）');

  // 真实单形状：39 行、表头物理行 1（headerRow 存档）、账本 39 行
  const realSheet = sheetOf([['标题'], HEADER, [1, null, null, null, '散热器格栅', null, 'F208401100']], 39);
  const realLedger = createLedger({ fileName: '客户单.xlsx', sheetName: 'Sheet1', sheetIndex: 0, rowCount: 39 });
  const realRows = inquiryDataRows({
    docId: 'r', kind: 'inquiry', sheet: realSheet, ledger: realLedger, headerRow: 1,
  });
  eq(realRows.length, 37, '枚举：真实单 37 条数据行');
  eq(realRows[0].lineId, 'L3', '枚举：真实单第一条数据行 L3');
}

/* ---------- 2. 迁移：pkg10 形状存档 → 补 inquiryId + 播种客户 ---------- */
{
  const sheet = sheetOf([['老单'], HEADER, [1, null, null, null, '零件', null, 'OE123']], 3);
  const ledger = createLedger({ fileName: '老单.xlsx', sheetName: 'Sheet1', sheetIndex: 0, rowCount: 3 });
  const pkg10Archive = {
    version: 2, savedAt: '2026-10-11T00:00:00.000Z',
    factories: ['老工厂'], activeDocId: 'doc-inquiry', orderSeq: 1,
    docs: [
      { docId: 'doc-inquiry', kind: 'inquiry', factoryName: null, customerName: '老客户',
        sheet, ledger, rowChoices: { L3: { factory: '老工厂', rawPrice: 100 } } },
      { docId: 'doc-quote-1', kind: 'quote', factoryName: '老工厂', sheet, ledger },
      // ↑ 没有 inquiryId、整个存档没有 customers —— 包 10 的形状
    ],
    orders: [{
      orderNo: 'ORD2610-0001', createdAt: '2026-10-05T10:00:00.000Z',
      customerName: '老客户', inquiryDocId: 'doc-inquiry',
      lines: [{ lineId: 'L3', oe: 'OE123', name: '零件', factory: '老工厂',
        qty: 2, costRaw: 100, costTaxInclusive: true, costTaxRatePct: '',
        finalPrice: 150, shippedQty: 0 }],
      receipts: [], factoryPays: [], shipments: [],
    }],
  };
  const snapshot = JSON.stringify(pkg10Archive);
  const { state, changed } = migrateState(pkg10Archive);
  eq(changed, true, '迁移：pkg10 存档被迁移');
  eq(state.docs[1].inquiryId, 'doc-inquiry', '迁移：报价单补上 inquiryId = 唯一询价单');
  eq(state.customers, [{ name: '老客户', contact: '', note: '' }],
    '迁移：客户注册表从单据播种（询价单/订单同名只一条）');
  eq(state.orders, pkg10Archive.orders, '迁移：订单原样不动');
  eq(JSON.stringify(pkg10Archive), snapshot, '迁移：不原地改入参');
  const again = migrateState(state);
  eq(again.changed, false, '迁移：幂等（再迁一次无变化）');
  ok(again.state === state, '迁移：无变化时原样返回');

  // 已有注册表条目（带联系人）时：保留，只补缺名
  const withReg = {
    ...pkg10Archive,
    customers: [{ name: '老客户', contact: '张三', note: '老主顾' }],
    docs: [...pkg10Archive.docs,
      { docId: 'doc-inq-2', kind: 'inquiry', customerName: '新客户', sheet, ledger }],
  };
  const m2 = migrateState(withReg);
  eq(m2.state.customers, [
    { name: '老客户', contact: '张三', note: '老主顾' },
    { name: '新客户', contact: '', note: '' },
  ], '迁移：已有条目的联系人/备注保留，只补没登记的客户名');
  eq(seedCustomerNames(pkg10Archive.docs, pkg10Archive.orders), ['老客户'],
    '播种：询价单与订单同名合并');
}

/* ---------- 3. 客户改名：全域同步 + 冲突拦截 ---------- */
function mgmtFixture() {
  const sheet = sheetOf([['t'], HEADER, [1, null, null, null, '零件', null, 'OE1']], 3);
  const ledger = createLedger({ fileName: 'f.xlsx', sheetName: 'Sheet1', sheetIndex: 0, rowCount: 3 });
  return {
    docs: [
      { docId: 'inq-a', kind: 'inquiry', customerName: '欧冠嘉', sheet, ledger, rowChoices: {} },
      { docId: 'inq-b', kind: 'inquiry', customerName: '别的客户', sheet, ledger, rowChoices: {} },
      { docId: 'q-a', kind: 'quote', factoryName: '甲厂', inquiryId: 'inq-a', sheet, ledger },
    ],
    orders: [
      { orderNo: 'ORD-1', customerName: '欧冠嘉', inquiryDocId: 'inq-a',
        lines: [{ lineId: 'L3', factory: '甲厂', qty: 1, costRaw: 10, costTaxInclusive: true, costTaxRatePct: '', finalPrice: 20, shippedQty: 0 }],
        receipts: [], factoryPays: [{ factory: '甲厂', amount: 5 }], shipments: [] },
      { orderNo: 'ORD-2', customerName: '别的客户', inquiryDocId: 'inq-b',
        lines: [], receipts: [], factoryPays: [], shipments: [] },
    ],
    customers: [
      { name: '欧冠嘉', contact: '李经理', note: '' },
      { name: '别的客户', contact: '', note: '' },
      { name: '闲置客户', contact: '', note: '' },
    ],
    factories: ['甲厂', '乙厂'],
  };
}
{
  const st = mgmtFixture();
  const res = renameCustomer(st, '欧冠嘉', '欧冠嘉汽配');
  ok(res !== null, '客户改名：成功返回新状态');
  eq(res.docs.find((d) => d.docId === 'inq-a').customerName, '欧冠嘉汽配', '客户改名：询价单同步');
  eq(res.docs.find((d) => d.docId === 'inq-b').customerName, '别的客户', '客户改名：别人的询价单不动');
  eq(res.orders.find((o) => o.orderNo === 'ORD-1').customerName, '欧冠嘉汽配', '客户改名：订单同步');
  eq(res.orders.find((o) => o.orderNo === 'ORD-2').customerName, '别的客户', '客户改名：别人的订单不动');
  eq(res.customers.find((c) => c.name === '欧冠嘉汽配').contact, '李经理', '客户改名：注册表条目改名且联系人保留');
  eq(st.docs.find((d) => d.docId === 'inq-a').customerName, '欧冠嘉', '客户改名：不原地改入参');
  eq(renameCustomer(st, '欧冠嘉', '别的客户'), null, '客户改名：新名被别的客户占用 → 拒绝');
  eq(renameCustomer(st, '欧冠嘉', '欧冠嘉'), null, '客户改名：新旧同名 → 拒绝');
  eq(renameCustomer(st, '欧冠嘉', '  '), null, '客户改名：空名 → 拒绝');
}

/* ---------- 4. 工厂改名：报价单/定厂/订单行/付款/名单全同步 ---------- */
{
  const st = mgmtFixture();
  st.docs[0].rowChoices = { L3: { factory: '甲厂', rawPrice: 10, taxInclusive: true, taxRatePct: '', period: '' } };
  const res = renameFactory(st, '甲厂', '甲厂新名');
  ok(res !== null, '工厂改名：成功返回新状态');
  eq(res.docs.find((d) => d.docId === 'q-a').factoryName, '甲厂新名', '工厂改名：报价单同步');
  eq(res.docs.find((d) => d.docId === 'inq-a').rowChoices.L3.factory, '甲厂新名', '工厂改名：定厂快照同步');
  eq(res.orders[0].lines[0].factory, '甲厂新名', '工厂改名：订单行同步');
  eq(res.orders[0].factoryPays[0].factory, '甲厂新名', '工厂改名：订单付款记录同步');
  eq(res.factories, ['甲厂新名', '乙厂'], '工厂改名：名单同步且别人不动');
  eq(renameFactory(st, '甲厂', '乙厂'), null, '工厂改名：新名被别的工厂占用 → 拒绝');
  eq(renameFactory(st, '甲厂', '甲厂'), null, '工厂改名：新旧同名 → 拒绝');
}

/* ---------- 5. 删除规则 ---------- */
{
  const st = mgmtFixture();
  const b1 = customerDeleteBlock(st, '欧冠嘉');
  ok(typeof b1 === 'string' && b1.includes('询价单'), '客户删除：有询价单 → 拦下且原因点名询价单', b1);
  const onlyOrder = {
    docs: [], orders: st.orders, customers: st.customers, factories: [],
  };
  const b2 = customerDeleteBlock(onlyOrder, '别的客户');
  ok(typeof b2 === 'string' && b2.includes('订单'), '客户删除：只有订单 → 拦下且原因点名订单', b2);
  eq(customerDeleteBlock(st, '闲置客户'), null, '客户删除：无单据 → 可删');

  const f1 = factoryDeleteBlock(st, '甲厂');
  ok(typeof f1 === 'string' && f1.includes('报价单'), '工厂删除：有报价单 → 拦下且原因点名报价单', f1);
  const chosenOnly = {
    docs: [{ docId: 'i', kind: 'inquiry', rowChoices: { L3: { factory: '丙厂' } } }],
    orders: [], factories: ['丙厂'],
  };
  const f2 = factoryDeleteBlock(chosenOnly, '丙厂');
  ok(typeof f2 === 'string' && f2.includes('定厂'), '工厂删除：只有定厂记录 → 拦下且原因点名定厂', f2);
  eq(factoryDeleteBlock(st, '乙厂'), null, '工厂删除：无单据 → 可删');

  const i1 = inquiryDeleteBlock(st.orders, 'inq-a');
  ok(typeof i1 === 'string' && i1.includes('ORD-1'), '询价单删除：已转订单 → 拦下且原因点名单号', i1);
  eq(inquiryDeleteBlock(st.orders, 'inq-x'), null, '询价单删除：没转过订单 → 可删');
}

/* ---------- 6. 多询价单隔离：报价单按 inquiryId 归属，比价只读本单的 ---------- */
{
  const inqSheetA = sheetOf([['A单'], HEADER,
    [1, null, null, null, '甲零件', null, 'OE-A']], 3);
  const inqSheetB = sheetOf([['B单'], HEADER,
    [1, null, null, null, '乙零件', null, 'OE-B']], 3);
  const quoteSheet = (price) => sheetOf([['回表'], [...HEADER, '价格'],
    [1, null, null, null, 'x', null, 'OE-X', price]], 3);
  const led = () => createLedger({ fileName: 'f', sheetName: 'Sheet1', sheetIndex: 0, rowCount: 3 });
  const docs = [
    { docId: 'inq-a', kind: 'inquiry', sheet: inqSheetA, ledger: led(), headerRow: 1, rowChoices: {} },
    { docId: 'inq-b', kind: 'inquiry', sheet: inqSheetB, ledger: led(), headerRow: 1, rowChoices: {} },
    { docId: 'q-a', kind: 'quote', factoryName: '工厂A', inquiryId: 'inq-a',
      sheet: quoteSheet(111), ledger: led(), headerRow: 1,
      priceMark: { col: 7, taxInclusive: true, taxRatePct: '', periodCol: null } },
    { docId: 'q-b', kind: 'quote', factoryName: '工厂B', inquiryId: 'inq-b',
      sheet: quoteSheet(999), ledger: led(), headerRow: 1,
      priceMark: { col: 7, taxInclusive: true, taxRatePct: '', periodCol: null } },
  ];
  eq(quotesForInquiry(docs, 'inq-b').map((d) => d.docId), ['q-b'], '隔离：inq-b 只名下 q-b 一张报价单');
  eq(quotesForInquiry(docs, 'inq-a').map((d) => d.docId), ['q-a'], '隔离：inq-a 只名下 q-a 一张报价单');
  const modelB = buildCompareRows({
    inquiry: docs[1], quotes: quotesForInquiry(docs, 'inq-b'),
  });
  eq(modelB.factories, ['工厂B'], '隔离：B 单比价只出现工厂B');
  eq(modelB.rows.length, 1, '隔离：B 单比价 1 行');
  eq(modelB.rows[0].cells['工厂B'].raw, 999, '隔离：B 单读到的是工厂B的价 999，不是 A 的 111');
  eq(modelB.rows[0].oe, 'OE-B', '隔离：B 单行身份是 B 的 OE');
  const modelA = buildCompareRows({
    inquiry: docs[0], quotes: quotesForInquiry(docs, 'inq-a'),
  });
  eq(modelA.rows[0].cells['工厂A'].raw, 111, '隔离：A 单读到工厂A的价 111');
}

/* ---------- 7. 管理页读模型 ---------- */
{
  const st = mgmtFixture();
  const cm = buildCustomerModel(st);
  const oug = cm.find((m) => m.entry.name === '欧冠嘉');
  eq(oug.stats, { inquiries: 1, orders: 1, receivable: 20, received: 0, unpaid: 20 },
    '客户模型：欧冠嘉 询价 1 · 订单 1 · 应收 20（现算）');
  eq(oug.inquiries.map((q) => q.docId), ['inq-a'], '客户模型：名下询价单清单');
  eq(oug.inquiries[0].status, '已转订单', '客户模型：询价单状态派生（有订单 → 已转订单）');
  eq(oug.orders.map((o) => o.orderNo), ['ORD-1'], '客户模型：名下订单清单');
  const idle = cm.find((m) => m.entry.name === '闲置客户');
  eq(idle.stats, { inquiries: 0, orders: 0, receivable: 0, received: 0, unpaid: 0 },
    '客户模型：闲置客户全 0 也列出来');

  const fm = buildFactoryModel(st);
  const jia = fm.find((m) => m.name === '甲厂');
  eq(jia.stats.quotes, 1, '工厂模型：甲厂报价单 1');
  eq(jia.stats.orderLines, 1, '工厂模型：甲厂订单行 1');
  eq(jia.stats.payable, 10, '工厂模型：甲厂应付 10（成本含税口径）');
  eq(jia.stats.paid, 5, '工厂模型：甲厂已付 5');
  eq(jia.quoteDocs.map((q) => q.docId), ['q-a'], '工厂模型：名下报价单清单带归属');
  eq(jia.orders.map((o) => o.orderNo), ['ORD-1'], '工厂模型：相关订单清单');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
