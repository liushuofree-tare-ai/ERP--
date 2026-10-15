// 最终报价与对客导出测试（SPEC 第四节第 7 项 + 第二节底线 2）：
// 纯 Node，用与浏览器相同的 src 模块。覆盖：
//  · 定厂快照带税点（包 7 扩展）、最终价按快照口径算（税步用该家
//    标价列的税点；含税跳过）、老快照无税点时回退当前标记；
//  · 「最终报价」列生成：有价写价、没定厂留空、重跑刷新；
//  · 普通版导出：只含选中行列、最终价对、未定厂行不带价；
//  · 带图版导出：原件回写、24 图在、合并在、只有选中行有最终价；
//  · 泄漏断言（两版通用）：工厂原价（546/520/231）与工厂名绝不
//    出现在给客户的文件里——最终价 660.20 是算出来的，不是原价。
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
const { buildCompareRows, choiceFromCell } = await import('../src/compare.js');
const { cellValue } = await import('../src/sheetOps.js');
const { buildQuoteXlsx, buildMinimalXlsx } = await import('../src/xlsx/writeback.js');
const {
  computeFinalPrices, resolveChoiceTaxRatePct, applyFinalQuoteColumn,
  buildPlainExportSheet, buildPicturedExportSheet, finalQuoteColOf,
} = await import('../src/quoteExport.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}

const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SRC_CUST = path.join(FIXTURES, '___2_0dib.xlsx');
const SRC_FACT = path.join(FIXTURES, '_________________3_gmdr.xlsx');
function loadCopy(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qipei-pkg7-'));
  const copy = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, copy);
  const buf = fs.readFileSync(copy);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
const custBytes = loadCopy(SRC_CUST);
const custParsed = parseSheet(readWorkbook(custBytes), 'Sheet1');
const factParsed = parseSheet(readWorkbook(loadCopy(SRC_FACT)), 'TIGGO');
const inqSheet = sheetToFortune(custParsed, 0);
const quoteSheet = sheetToFortune(factParsed, 0);
const PRICING = {
  costCol: null, taxInclusive: false, taxRatePct: '13',
  markupPct: '20', freight: '5', fxRate: '', salesCol: null,
};
const inquiry = {
  sheet: inqSheet,
  ledger: createLedger({ rowCount: custParsed.rowCount }),
  headerRow: 1,
  pricing: PRICING,
};
const quoteJ = {
  sheet: quoteSheet, factoryName: '回表工厂', headerRow: 1,
  priceMark: { col: 9, taxInclusive: true, taxRatePct: '13', periodCol: 10 },
};

/* ================= 定厂快照 + 最终价（含税口径） ================= */
console.log('== 最终价：含税快照口径');
const model = buildCompareRows({ inquiry, quotes: [quoteJ] });
const pricedRows = model.rows.filter((r) => r.cells['回表工厂'].priced);
eq(pricedRows.length, 23, '有价行 23（与包 6 一致）');
const unchosenRow = pricedRows[2]; // 第 3 条有价行故意不定厂
const rowChoices = {};
for (const r of pricedRows) {
  if (r.lineId === unchosenRow.lineId) continue;
  rowChoices[r.lineId] = choiceFromCell(r.cells['回表工厂']);
}
eq(rowChoices['L3'].rawPrice, 546, 'L3 快照原值 = 546');
eq(rowChoices['L3'].taxInclusive, true, 'L3 快照口径 = 含税');
eq(rowChoices['L3'].taxRatePct, '13', 'L3 快照带上了标价列的税点 13（包 7 扩展）');
const finalPrices = computeFinalPrices({ inquiry, rowChoices, quotes: [quoteJ] });
eq(finalPrices.size, 22, '最终价条数 = 23 有价 − 1 未定厂 = 22');
eq(finalPrices.get('L3'), 660.2, 'L3 最终价 = 546×1.2+5 = 660.20（手算期望）');
const rowL4 = model.rows.find((r) => r.oe.trim() === 'F081301110HD');
eq(finalPrices.get(rowL4.lineId), 282.2, '第二行最终价 = 231×1.2+5 = 282.20');
ok(!finalPrices.has(unchosenRow.lineId), '未定厂的行不在最终价表里');

/* ================= 最终价：不含税口径（税步用快照税点） ================= */
console.log('== 最终价：不含税快照口径 + 老快照回退');
const quoteI = {
  sheet: quoteSheet, factoryName: '不含税工厂', headerRow: 1,
  priceMark: { col: 8, taxInclusive: false, taxRatePct: '13', periodCol: 10 },
};
const modelI = buildCompareRows({ inquiry, quotes: [quoteI] });
const cellI3 = modelI.rows[0].cells['不含税工厂'];
eq(cellI3.raw, 520, 'I 列 L3 原值 = 520（不含税）');
const choiceI = choiceFromCell(cellI3);
eq(choiceI.taxRatePct, '13', '不含税快照同样带税点 13');
eq(computeFinalPrices({ inquiry, rowChoices: { L3: choiceI }, quotes: [quoteI] }).get('L3'),
  710.12, '不含税最终价 = 520×1.13×1.2+5 = 710.12（税步用了快照税点）');
const legacyChoice = { ...choiceI };
delete legacyChoice.taxRatePct; // 模拟包 6 时期存的老快照
eq(resolveChoiceTaxRatePct(legacyChoice, [quoteI]), '13', '老快照无税点 → 回退该家当前标记的税点');
eq(computeFinalPrices({ inquiry, rowChoices: { L3: legacyChoice }, quotes: [quoteI] }).get('L3'),
  710.12, '老快照回退后最终价仍是 710.12');
eq(computeFinalPrices({ inquiry, rowChoices: { L3: legacyChoice }, quotes: [] }).get('L3'),
  629, '无从回退时税点按 0：520×1.2+5 = 629.00');

/* ================= 最终报价列生成 ================= */
console.log('== 最终报价列生成');
{
  const { sheet: withFinal, col } = applyFinalQuoteColumn(
    inqSheet, 1, finalPrices, inquiry.ledger);
  eq(col, 7, '最终报价列加在原表最右（H 列，下标 7）');
  eq(cellValue(withFinal, 1, 7), '最终报价', '表头 = 最终报价');
  eq(cellValue(withFinal, 2, 7), 660.2, 'L3 行最终价写入 660.20');
  eq(cellValue(withFinal, unchosenRow.inquiryRow, 7), null, '未定厂行最终价留空（不是 0）');
  const unpricedRow = model.rows.find((r) => !r.cells['回表工厂'].priced);
  eq(cellValue(withFinal, unpricedRow.inquiryRow, 7), null, '没报价的行最终价留空');
  eq(finalQuoteColOf(inqSheet, 1), null, '原询价单未被原地改动（纯函数）');
  // 重跑刷新：把 L3 的定厂改掉，最终价随之变
  const changed = new Map(finalPrices);
  changed.set('L3', 999.99);
  const rerun = applyFinalQuoteColumn(withFinal, 1, changed, inquiry.ledger);
  eq(rerun.col, 7, '重跑认出已有最终报价列，不再新增一列');
  eq(cellValue(rerun.sheet, 2, 7), 999.99, '重跑后最终价刷新为新值');
}

/* ================= 泄漏断言工具 ================= */
function leakCheck(parsed, label) {
  const values = parsed.cells.map((c) => c.value);
  ok(!values.some((v) => v === 546), label + '：不含工厂原价 546');
  ok(!values.some((v) => v === 520), label + '：不含工厂原价 520');
  ok(!values.some((v) => v === 231), label + '：不含工厂原价 231');
  ok(!values.some((v) => typeof v === 'string' && v.includes('回表工厂')),
    label + '：不含工厂名');
  ok(!values.some((v) => typeof v === 'string' && v.includes('不含税工厂')),
    label + '：不含另一家工厂名');
}
const cellOf = (parsed, r, c) => {
  const cell = parsed.cells.find((x) => x.r === r && x.c === c);
  return cell ? cell.value : undefined;
};

/* ================= 普通版导出 ================= */
console.log('== 普通版导出');
{
  const selectedLineIds = new Set(['L3', unchosenRow.lineId]);
  const selectedColKeys = new Set(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'final']);
  const plainSheet = buildPlainExportSheet({
    inquiry, selectedLineIds, selectedColKeys, finalPrices,
  });
  eq(plainSheet.row, 4, '普通版行数 = 标题 + 表头 + 选中 2 行 = 4');
  eq(plainSheet.column, 8, '普通版列数 = 原 7 列 + 最终报价 = 8');
  const bytes = buildMinimalXlsx('Sheet1', plainSheet);
  const out = parseSheet(readWorkbook(bytes), 'Sheet1');
  eq(cellOf(out, 0, 0), '欧冠嘉配件采购需求', '普通版带标题行');
  ok(out.merges.some((m) => m.r === 0 && m.c === 0 && m.cs === 8),
    '普通版标题合并跨全部导出列', out.merges);
  eq(cellOf(out, 1, 6), 'OE码', '普通版表头含 OE 码列');
  eq(cellOf(out, 1, 7), '最终报价', '普通版表头含最终报价列');
  eq(cellOf(out, 2, 6), 'F208401100', '普通版第 1 条选中行是 L3（OE 对上）');
  eq(cellOf(out, 2, 7), 660.2, '普通版 L3 最终价 = 660.20');
  eq(cellOf(out, 3, 6), unchosenRow.oe.trim(), '普通版第 2 条选中行是未定厂行');
  eq(cellOf(out, 3, 7), undefined, '普通版未定厂行最终价留空（无此格）');
  leakCheck(out, '普通版');
}

/* ================= 带图版导出 ================= */
console.log('== 带图版导出');
{
  const selectedLineIds = new Set(['L3', unchosenRow.lineId]);
  const picSheet = buildPicturedExportSheet({ inquiry, selectedLineIds, finalPrices });
  const bytes = buildQuoteXlsx({
    originalBytes: custBytes, sheetName: 'Sheet1', sheet: picSheet,
  });
  const out = parseSheet(readWorkbook(bytes), 'Sheet1');
  // 勾选=真删（2026-10-15 改判）：只选 2 行 → 文件里只剩标题+表头+这 2 行，
  // 未选行连数据带图一并消失，不再是"隐藏起来还在原表里"
  eq(out.rowCount, 4, '带图版行数 = 标题 + 表头 + 选中 2 行 = 4（未选行真删）');
  const keptImgRows = new Set([2, unchosenRow.inquiryRow]);
  const expectedImgs = custParsed.images.filter((i) => keptImgRows.has(i.row)).length;
  eq(out.images.length, expectedImgs, '带图版图片只剩选中行上的（' + expectedImgs + ' 张）');
  ok(out.images.every((i) => i.row === 2 || i.row === 3), '带图版图片锚点已重映射到新行号');
  ok(out.merges.some((m) => m.r === 0 && m.c === 0 && m.rs === 1 && m.cs === 7),
    '带图版原件合并 A1:G1 还在', out.merges);
  eq(out.colCount, 8, '带图版列数 = 原 7 列 + 最终报价 = 8');
  eq(cellOf(out, 1, 7), '最终报价', '带图版最终报价列表头在 H 列');
  eq(cellOf(out, 2, 7), 660.2, '带图版 L3 最终价 = 660.20');
  eq(cellOf(out, 3, 7), undefined,
    '带图版选中行里未定厂的那行（现第 3 行）最终价留空');
  ok(!out.cells.some((c) => c.value === 'F081301110HD'),
    '带图版未选中的 L4 行已真删（OE 在文件里找不到）');
  eq(cellOf(out, 2, 6), 'F208401100', '带图版客户原值（OE）原样回写');
  eq(cellOf(out, 2, 4), '散热器格栅', '带图版客户原值（产品）原样回写');
  leakCheck(out, '带图版');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
