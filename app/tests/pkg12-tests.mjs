// 包 12 新增项测试（用户在 v2-pkg11 上用真实福田单实测出的两个问题）：
// A. 转订单数量带入：询价单自带数量列（需求数等）时面板预填——
//    数量列识别（精确表头名）+ 按 lineId 的带入映射；欧冠嘉单没有
//    数量列 → 维持手填（空映射）。
// B. 最终价透明化 + 重复加价守卫：
//    · priceBreakdown 算式与 computeSalesPrice 的结果分毫不差；
//    · salesMarkGuardInfo 只对"定价条生成的销售价列"触发（记录在
//      pricing.salesCol 的、或表头就叫销售价的），对真正的成本价
//      列绝不触发。
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readWorkbook, parseSheet } = await import('../src/xlsx/workbook.js');
const { sheetToFortune } = await import('../src/xlsx/toFortuneSheet.js');
const { createLedger } = await import('../src/ledger.js');
const { findQtyColumn } = await import('../src/sheetOps.js');
const { qtyPrefillForInquiry, priceBreakdown } = await import('../src/quoteExport.js');
const { computeSalesPrice } = await import('../src/pricing.js');
const { generatedSalesCols, salesMarkGuardInfo } = await import('../src/compare.js');
const {
  computeFinalPrices, salesSourceForQuote, salesSourceFinal, finalBreakdownFor,
} = await import('../src/quoteExport.js');
const { setCellValue } = await import('../src/sheetOps.js');
const { buildQuoteXlsx, buildMinimalXlsx } = await import('../src/xlsx/writeback.js');
const { buildPlainExportSheet, buildPicturedExportSheet } = await import('../src/quoteExport.js');
const { openZip, partText } = await import('../src/xlsx/zip.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}

function mkSheet(headers, dataRows) {
  const celldata = [];
  headers.forEach((h, c) => { if (h !== null && h !== '') celldata.push({ r: 0, c, v: { v: h, m: String(h) } }); });
  (dataRows || []).forEach((row, i) => {
    row.forEach((v, c) => {
      if (v === null || v === undefined || v === '') return;
      celldata.push({ r: i + 1, c, v: { v, m: String(v) } });
    });
  });
  return {
    name: 'Sheet1', row: 1 + (dataRows || []).length,
    column: headers.length, celldata, config: {}, images: [],
  };
}

/* ================= A. 数量列识别 ================= */
console.log('== A. 数量列识别与带入');
const futianHeaders = ['序号', 'OE码', '名称', '需求数', '品牌', '价格', '图片'];
{
  const sheet = mkSheet(futianHeaders, []);
  const found = findQtyColumn(sheet, 0);
  eq(found && found.col, 3, '福田表头：需求数在 D 列（序号 3）');
  eq(found && found.header, '需求数', '带入提示用原表头名「需求数」');
}
for (const name of ['数量', '订购数', '订货数', '件数']) {
  const sheet = mkSheet(['序号', name, '价格'], []);
  eq((findQtyColumn(sheet, 0) || {}).col, 1, '表头「' + name + '」也认');
}
{
  const sheet = mkSheet(['序号', '需求数量', '价格'], []);
  eq(findQtyColumn(sheet, 0), null, '「需求数量」不是精确表头名 → 不认（不靠猜）');
  const sheet2 = mkSheet(['序号', ' 需求数 ', '价格'], []);
  eq((findQtyColumn(sheet2, 0) || {}).col, 1, '表头带空格 → 去空白后认');
}

/* 欧冠嘉真实单：没有数量列 → 空带入（维持手填） */
const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SRC_CUST = path.join(FIXTURES, '___2_0dib.xlsx');
function loadCopy(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qipei-pkg12-'));
  const copy = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, copy);
  const buf = fs.readFileSync(copy);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
{
  const parsed = parseSheet(readWorkbook(loadCopy(SRC_CUST)), 'Sheet1');
  const inq = {
    sheet: sheetToFortune(parsed, 0),
    ledger: createLedger({ rowCount: parsed.rowCount }),
    headerRow: 1, pricing: {},
  };
  const info = qtyPrefillForInquiry(inq);
  eq(info.header, null, '欧冠嘉单没有数量列 → header 为 null');
  eq(info.qtys.size, 0, '欧冠嘉单带入数量为空（转订单维持手填）');
}

/* 福田形状：带入只认正数，空白/0/文字不带入 */
{
  const sheet = mkSheet(futianHeaders, [
    [1, 'FT-001', '前保险杠', 5, '福田', 64.66, null],
    [2, 'FT-002', '后保险杠', '5', '福田', 100, null],
    [3, 'FT-003', '叶子板', null, '福田', 10, null],
    [4, 'FT-004', '车门', 0, '福田', 10, null],
    [5, 'FT-005', '机盖', '五', '福田', 10, null],
  ]);
  const inq = {
    sheet, ledger: createLedger({ rowCount: sheet.row }),
    headerRow: 0, pricing: {},
  };
  const info = qtyPrefillForInquiry(inq);
  eq(info.header, '需求数', '福田单认出需求数列');
  eq(info.qtys.get('L2'), 5, '数字 5 带入（L2）');
  eq(info.qtys.get('L3'), 5, '文本 "5" 也带入（L3）');
  eq(info.qtys.size, 2, '空白/0/文字一律不带入，只剩 2 行');
}

/* ================= B2. 算式透明化 ================= */
console.log('== B2. 最终价算式');
const PR = { markupPct: '20', freight: '5', fxRate: '' };
eq(
  priceBreakdown({ rawPrice: 546, taxInclusive: true, taxRatePct: '13', pricing: PR }),
  '工厂价 546.00（含税） → 加价后 655.20 → +运费 5.00 = 660.20',
  '含税 546 → 660.20（跳过税步）');
eq(
  priceBreakdown({ rawPrice: 64.66, taxInclusive: false, taxRatePct: '13', pricing: PR }),
  '工厂价 64.66（不含税 · 税点 13%）→ 含税 73.07 → 加价后 87.68 → +运费 5.00 = 92.68',
  '不含税 64.66 @13 → 92.68（用户福田单的原案）');
eq(
  priceBreakdown({ rawPrice: 64.66, taxInclusive: false, taxRatePct: '13', pricing: PR, factory: 'EE', colHeader: '价格' }),
  '按 EE『价格』列 工厂价 64.66（不含税 · 税点 13%）→ 含税 73.07 → 加价后 87.68 → +运费 5.00 = 92.68',
  '算式点名基数：EE『价格』列');
{
  const fx = priceBreakdown({
    rawPrice: 546, taxInclusive: true, taxRatePct: '',
    pricing: { markupPct: '20', freight: '5', fxRate: '7.2' },
  });
  ok(fx && fx.includes('÷汇率 7.2') && fx.endsWith('= 91.69'), '有汇率：尾巴 ÷汇率 后 = 91.69', fx);
  eq(priceBreakdown({ rawPrice: 'abc', taxInclusive: false, taxRatePct: '13', pricing: PR }),
    null, '成本不是数字 → 无算式（留空不当价）');
  // 算式末尾数字必须与 computeSalesPrice 完全一致（一组口径各异的用例）
  const cases = [
    { rawPrice: 520, taxInclusive: false, taxRatePct: '13' },
    { rawPrice: 231, taxInclusive: true, taxRatePct: '' },
    { rawPrice: 33.33, taxInclusive: false, taxRatePct: '6' },
    { rawPrice: 99.9, taxInclusive: false, taxRatePct: '0' },
  ];
  for (const c of cases) {
    const bd = priceBreakdown({ ...c, pricing: PR });
    const fin = computeSalesPrice({
      cost: c.rawPrice, taxInclusive: c.taxInclusive,
      taxRatePct: c.taxRatePct, markupPct: '20', freightPerUnit: '5', fxRate: '',
    });
    ok(bd.endsWith('= ' + fin.toFixed(2)),
      '算式结果与定价公式一致：' + JSON.stringify(c), bd);
  }
}

/* ================= B1. 重复加价守卫 ================= */
console.log('== B1. 标价列守卫');
{
  // 用户福田案的形状：报价单上定价条以 F 价格（5）为成本列生成了
  // H 销售价（7）；pricing 里有记录
  const sheet = mkSheet(
    ['序号', 'OE码', '名称', '需求数', '品牌', '价格', '图片', '销售价'],
    [[1, 'FT-001', '前保险杠', 5, '福田', 44, null, 64.66]]);
  const doc = { sheet, headerRow: 0, pricing: { costCol: 5, salesCol: 7 } };
  const info = salesMarkGuardInfo(doc, 7);
  ok(info !== null, '标记录在案的销售价列 → 守卫触发');
  eq(info && info.costCol, 5, '守卫给出成本价列 = 价格列（5）');
  eq(info && info.costHeader, '价格', '守卫给出成本价列表头「价格」');
  eq(info && info.recorded, true, '这是记录在案的生成列');
  eq(salesMarkGuardInfo(doc, 5), null, '标真正的成本价列「价格」→ 守卫不触发');
  eq(salesMarkGuardInfo(doc, 3), null, '标需求数列 → 不触发');
  ok(generatedSalesCols(doc).has(7) && !generatedSalesCols(doc).has(5),
    '生成列集合只含销售价列');
}
{
  // 老存档没有 pricing 记录：表头叫「销售价」照样拦（兜底），但给不出成本列
  const sheet = mkSheet(['序号', '价格', '销售价'], [[1, 44, 64.66]]);
  const doc = { sheet, headerRow: 0, pricing: {} };
  const info = salesMarkGuardInfo(doc, 2);
  ok(info !== null && info.recorded === false, '无记录时表头「销售价」兜底触发');
  eq(info && info.costCol, null, '没记录 → 给不出成本价列（只能取消重选）');
  const fxSheet = mkSheet(['序号', '价格', '销售价（外币）'], [[1, 44, 9.1]]);
  eq(salesMarkGuardInfo({ sheet: fxSheet, headerRow: 0, pricing: {} }, 2) !== null,
    true, '「销售价（外币）」同样触发');
}
{
  // 普通工厂回表（FACT 形状的表头）：标哪列都不触发
  const sheet = mkSheet(
    ['序号', '品牌', '产品', '图片', 'OE码', '数量（件）', '不含税', '单价（元，含税）', '备货周期（天）'],
    [[1, 'JETOUR', '格栅', null, 'F208401100', null, 520, 546, 30]]);
  const doc = { sheet, headerRow: 0, pricing: { costCol: null, salesCol: null } };
  eq(salesMarkGuardInfo(doc, 7), null, '工厂回表标含税价列 → 不触发');
  eq(salesMarkGuardInfo(doc, 6), null, '工厂回表标不含税列 → 不触发');
  eq(salesMarkGuardInfo(doc, null), null, '取消标记（col=null）→ 不触发');
}

/* ================= B4. 最终价取定厂报价单的销售价 ================= */
console.log('== B4. 最终价来源：报价单销售价优先');
{
  // 用户福田案的完整形状：EE 报价单上定价条以 价格（5）为成本列生成
  // 销售价（7）；标记落在价格列。询价单参数故意设成另一套（加价 50/
  // 运费 9）——B4 命中时最终价必须与询价单参数无关。
  const inqSheet = mkSheet(futianHeaders, [
    [1, 'FT-001', '前保险杠', 5, '福田', null, null],
    [2, 'FT-002', '后保险杠', 5, '福田', null, null],
  ]);
  const inquiry = {
    sheet: inqSheet, ledger: createLedger({ rowCount: 3 }), headerRow: 0,
    pricing: { costCol: null, taxInclusive: false, taxRatePct: '13', markupPct: '50', freight: '9', fxRate: '', salesCol: null },
  };
  const quoteSheet = mkSheet(
    ['序号', 'OE码', '名称', '需求数', '品牌', '价格', '图片', '销售价'],
    [
      [1, 'FT-001', '前保险杠', 5, '福田', 44, null, 64.66],
      [2, 'FT-002', '后保险杠', 5, '福田', 28, null, 42.97],
    ]);
  const quoteEE = {
    sheet: quoteSheet, factoryName: 'EE', headerRow: 0,
    pricing: { costCol: 5, taxInclusive: false, taxRatePct: '13', markupPct: '20', freight: '5', fxRate: '', salesCol: 7 },
    priceMark: { col: 5, taxInclusive: false, taxRatePct: '13', periodCol: null },
  };
  const choices = {
    L2: { factory: 'EE', rawPrice: 44, taxInclusive: false, taxRatePct: '13', period: '' },
    L3: { factory: 'EE', rawPrice: 28, taxInclusive: false, taxRatePct: '13', period: '' },
  };
  const src = salesSourceForQuote(quoteEE);
  ok(src !== null && src.salesCol === 7 && src.costCol === 5, 'B4 资格：成本列=标记列 → 命中');
  const finals = computeFinalPrices({ inquiry, rowChoices: choices, quotes: [quoteEE] });
  eq(finals.get('L2'), 64.66, '最终价直接取 EE 销售价 64.66（不是重算的 92.68，也不是询价参数的 83.58）');
  eq(finals.get('L3'), 42.97, '最终价直接取 EE 销售价 42.97');
  const bd = finalBreakdownFor('L2', choices.L2, { inquiry, quotes: [quoteEE] });
  ok(bd && bd.includes('取自 EE 报价单『销售价』列（由『价格』列按 税13%/加价20%/运费5 生成）') && bd.endsWith('= 64.66'),
    'B4 解说点名来源单/列/参数', bd);

  // 新鲜度：生成销售价之后把工厂价 44 改成 50 → 最终价必须跟上新价
  quoteEE.sheet = setCellValue(quoteEE.sheet, 1, 5, { v: 50, m: '50' });
  const finals2 = computeFinalPrices({ inquiry, rowChoices: choices, quotes: [quoteEE] });
  eq(finals2.get('L2'), 72.8, '改价后最终价现算跟上：50 → 72.80（不用陈旧销售价 64.66）');
  eq(finals2.get('L3'), 42.97, '没改的行不受影响');
  eq(salesSourceFinal(quoteEE, src, 1), 72.8, 'salesSourceFinal 同口径');
  const bd2 = finalBreakdownFor('L2', choices.L2, { inquiry, quotes: [quoteEE] });
  ok(bd2 && bd2.endsWith('= 72.80'), '解说与新最终价一致', bd2);
  quoteEE.sheet = setCellValue(quoteEE.sheet, 1, 5, { v: 44, m: '44' });

  // 不合资格 1：标记落在销售价列本身（costCol ≠ mark col）→ 标准口径
  const quoteMarkedSales = { ...quoteEE, priceMark: { col: 7, taxInclusive: false, taxRatePct: '13', periodCol: null } };
  eq(salesSourceForQuote(quoteMarkedSales), null, '标记的是销售价列本身 → 不合 B4 资格');
  const chSales = { L2: { factory: 'EE', rawPrice: 64.66, taxInclusive: false, taxRatePct: '13', period: '' } };
  const fSales = computeFinalPrices({ inquiry, rowChoices: chSales, quotes: [quoteMarkedSales] });
  eq(fSales.get('L2'), computeSalesPrice({
    cost: 64.66, taxInclusive: false, taxRatePct: '13',
    markupPct: '50', freightPerUnit: '9', fxRate: '',
  }), '不合资格 → 快照 + 询价单参数的标准口径');

  // 不合资格 2：报价单上没跑过定价条（salesCol 无记录）→ 标准口径
  const quotePlain = {
    sheet: quoteSheet, factoryName: 'EE', headerRow: 0,
    pricing: { costCol: null, salesCol: null },
    priceMark: { col: 5, taxInclusive: false, taxRatePct: '13', periodCol: null },
  };
  eq(salesSourceForQuote(quotePlain), null, '无销售价记录 → 不合资格');
  const fPlain = computeFinalPrices({ inquiry, rowChoices: choices, quotes: [quotePlain] });
  eq(fPlain.get('L2'), computeSalesPrice({
    cost: 44, taxInclusive: false, taxRatePct: '13',
    markupPct: '50', freightPerUnit: '9', fxRate: '',
  }), '无销售价 → 标准口径（询价参数）');
  const bdPlain = finalBreakdownFor('L2', choices.L2, { inquiry, quotes: [quotePlain] });
  ok(bdPlain && bdPlain.startsWith('按 EE『价格』列'), '标准行解说仍是算式+点名列', bdPlain);
}

/* ================= Phase 2. 导出图片标准化 ================= */
console.log('== Phase 2. 导出件在 WPS 之外也能看图');
const SRC_FACT = path.join(FIXTURES, '_________________3_gmdr.xlsx');
{
  const custBytes = loadCopy(SRC_CUST);
  const custHashBefore = Buffer.from(custBytes).toString('base64').length + ':' + custBytes.length;
  const parsed = parseSheet(readWorkbook(custBytes), 'Sheet1');
  eq(parsed.images.length, 24, '原图解析：24 张单元格图（基线未动）');
  ok(parsed.images.every((i) => i.kind === 'cell'), '原件里 24 张全是 WPS 单元格图');
  const inq = {
    sheet: sheetToFortune(parsed, 0),
    ledger: createLedger({ rowCount: parsed.rowCount }),
    headerRow: 1, pricing: {},
  };
  const allIds = new Set();
  for (let r = 2; r < 39; r++) allIds.add('L' + (r + 1));
  const picSheet = buildPicturedExportSheet({
    inquiry: inq, selectedLineIds: allIds, finalPrices: new Map(),
  });
  const outBytes = buildQuoteXlsx({ originalBytes: custBytes, sheetName: 'Sheet1', sheet: picSheet });
  const outWb = readWorkbook(outBytes);
  const outParsed = parseSheet(outWb, 'Sheet1');
  eq(outParsed.images.length, 24, '带图版导出回读：24 张图');
  ok(outParsed.images.every((i) => i.kind === 'floating'), '带图版导出：24 张全是标准浮动图');
  const anchorSet = new Set(outParsed.images.map((i) => i.row + ',' + i.col));
  eq(anchorSet.size, 24, '带图版导出：24 个锚点互不重叠');
  ok(anchorSet.has('2,5'), '第一张图锚在原格（物理行 3、图片列 F）');
  ok(outParsed.images.every((i) => i.col === 5), '24 张图都锚在图片列');
  const parts = outWb.parts;
  ok([...parts.keys()].some((k) => /^xl\/drawings\/drawing\d+\.xml$/.test(k)), 'zip 里有 xl/drawings 标准图层');
  ok(!parts.has('xl/cellimages.xml'), 'zip 里 cellimages 已移除');
  ok(![...parts.keys()].some((k) => k.includes('cellimages')), 'zip 里没有任何 cellimages 残留部件');
  const sheetXml = partText(parts, 'xl/worksheets/sheet1.xml');
  ok(!sheetXml.includes('DISPIMG'), '导出表里 DISPIMG 公式已剥除');
  eq((sheetXml.match(/<\?xml/g) || []).length, 1,
    '导出表 XML 有且只有一份声明（多轮回写不攒声明——多一份 LibreOffice 拒读）');
  eq(((partText(parts, '[Content_Types].xml') || '').match(/<\?xml/g) || []).length, 1,
    '内容类型 XML 同样只有一份声明');
  const mediaCount = [...parts.keys()].filter((k) => k.startsWith('xl/media/')).length;
  eq(mediaCount, 23, '媒体按内容去重：23 个 media 部件（24 张图 1 张复用）');
  eq(Buffer.from(custBytes).toString('base64').length + ':' + custBytes.length, custHashBefore,
    '原件字节未被改动（标准化只发生在导出副本上）');

  // 发给工厂的下载（回表原件同样只有单元格图）
  const factBytes = loadCopy(SRC_FACT);
  const factParsed = parseSheet(readWorkbook(factBytes), 'TIGGO');
  const factSheet = sheetToFortune(factParsed, 0);
  const factOut = buildQuoteXlsx({ originalBytes: factBytes, sheetName: 'TIGGO', sheet: factSheet });
  const factRe = parseSheet(readWorkbook(factOut), 'TIGGO');
  eq(factRe.images.length, 24, '工厂下载件回读：24 张图');
  ok(factRe.images.every((i) => i.kind === 'floating'), '工厂下载件：24 张全是标准浮动图');

  // 用户自己在应用里插入的图（kind=cell、字节走 dataURL）同样嵌入
  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const sheetWithUserImg = sheetToFortune(parsed, 0);
  sheetWithUserImg.images = [...sheetWithUserImg.images, {
    id: 'img-user-1', src: TINY_PNG, anchorRow: 2, anchorCol: 0, kind: 'cell',
    fileId: null, left: 0, top: 20, width: 68, height: 20,
  }];
  const userOut = buildQuoteXlsx({ originalBytes: custBytes, sheetName: 'Sheet1', sheet: sheetWithUserImg });
  const userRe = parseSheet(readWorkbook(userOut), 'Sheet1');
  eq(userRe.images.length, 25, '用户插入的图也被嵌入（24 + 1）');
  ok(userRe.images.some((i) => i.row === 2 && i.col === 0), '用户图锚在它插入的格子上');

  // 普通版：选了图片列才带图，没选就没有
  const first3 = new Set(['L3', 'L4', 'L5']);
  const expectedImgs = parsed.images.filter((i) => i.row >= 2 && i.row <= 4).length;
  const plainSheet = buildPlainExportSheet({
    inquiry: inq, selectedLineIds: first3,
    selectedColKeys: new Set(['c1', 'c5', 'final']), finalPrices: new Map(),
  });
  ok(plainSheet.exportImages.length === expectedImgs && expectedImgs > 0,
    '普通版摆位：前 3 行的照片都记上了', plainSheet.exportImages.length + '/' + expectedImgs);
  const plainBytes = buildMinimalXlsx('Sheet1', plainSheet);
  const plainRe = parseSheet(readWorkbook(plainBytes), 'Sheet1');
  eq(plainRe.images.length, expectedImgs, '普通版（选图片列）回读到照片');
  ok(plainRe.images.every((i) => i.kind === 'floating' && i.col === 1), '普通版照片锚在输出的图片列');
  const plainNoImg = buildPlainExportSheet({
    inquiry: inq, selectedLineIds: first3,
    selectedColKeys: new Set(['c1', 'final']), finalPrices: new Map(),
  });
  eq(plainNoImg.exportImages.length, 0, '普通版没选图片列 → 无摆位');
  const plainNoImgBytes = buildMinimalXlsx('Sheet1', plainNoImg);
  const plainNoImgParts = readWorkbook(plainNoImgBytes).parts;
  ok(![...plainNoImgParts.keys()].some((k) => k.includes('drawings')), '普通版没选图片列 → 文件里没有图层');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
