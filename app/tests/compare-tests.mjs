// 比价定厂逻辑测试（SPEC 第三节对齐模型 + 第四节第 6 项归一口径）：
// 纯 Node，用与浏览器相同的 src/compare 模块。
// 覆盖：价格归一（含税原样 / 不含税加税点 / 空与非数字不冒充 0）、
// 周期列识别、按各自表头行对齐（两边表头不在同一行）、报价单多报
// 行的 factoryExtras、缺行不报价，以及真实文件全链路（23 行有价、
// OE F208401100 的含税价 546）。
import { DOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readWorkbook, parseSheet } = await import('../src/xlsx/workbook.js');
const { sheetToFortune } = await import('../src/xlsx/toFortuneSheet.js');
const { createLedger } = await import('../src/ledger.js');
const {
  normalizePrice, detectPeriodColumn, computeFactoryExtras, buildCompareRows,
} = await import('../src/compare.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}

/** 2D 数组 → 规范表（celldata 形状） */
function mkSheet(rowsArr) {
  const celldata = [];
  rowsArr.forEach((row, r) => {
    row.forEach((v, c) => {
      if (v !== null && v !== undefined && v !== '') {
        celldata.push({ r, c, v: { v, m: String(v) } });
      }
    });
  });
  return {
    name: 'S', row: rowsArr.length,
    column: Math.max(...rowsArr.map((r) => r.length)),
    celldata, config: {},
  };
}

/* ================= 价格归一 ================= */
console.log('== 价格归一（统一成含税价比）');
eq(normalizePrice(546, { col: 9, taxInclusive: true, taxRatePct: '13' }), 546,
  '含税 546 → 546（原样）');
eq(normalizePrice(520, { col: 8, taxInclusive: false, taxRatePct: '13' }), 587.6,
  '不含税 520 · 税点 13 → 587.60');
eq(normalizePrice(520, { col: 8, taxInclusive: false, taxRatePct: '0' }), 520,
  '不含税 520 · 税点 0 → 520');
eq(normalizePrice('231', { col: 9, taxInclusive: true, taxRatePct: '' }), 231,
  '数字字符串也能归一');
eq(normalizePrice('', { col: 9, taxInclusive: true, taxRatePct: '13' }), null,
  '空价 → null（没报价）');
eq(normalizePrice('待确认', { col: 9, taxInclusive: true, taxRatePct: '13' }), null,
  '文字价 → null');
eq(normalizePrice(null, { col: 9, taxInclusive: true, taxRatePct: '13' }), null,
  '缺格 → null');
eq(normalizePrice(100, null), null, '没标价列 → null');
eq(normalizePrice(0, { col: 9, taxInclusive: true, taxRatePct: '13' }), 0,
  '明确填的 0 是合法报价（与"没报价"区分）');

/* ================= 周期列识别 ================= */
console.log('== 周期列识别');
{
  const sh = mkSheet([
    ['标题', null, null, null],
    ['序号', '单价', '备货周期（天）', '备注'],
    [1, 100, 30, ''],
  ]);
  eq(detectPeriodColumn(sh, 1), 2, '标题含"周期"的列被认出');
  const sh2 = mkSheet([['序号', '交期', '单价'], [1, '现货', 5]]);
  eq(detectPeriodColumn(sh2, 0), 1, '标题含"交期"的列也被认出');
  const sh3 = mkSheet([['序号', '单价'], [1, 5]]);
  eq(detectPeriodColumn(sh3, 0), null, '没有周期列 → null');
}

/* ================= 对齐：两边表头不在同一行 ================= */
console.log('== 行对齐（按各自表头行、按位置、继承 lineId）');
{
  // 询价单：标题行 0、表头行 1、数据行 2..4（3 行）
  const inqSheet = mkSheet([
    ['客户采购需求'],
    ['序号', '产品', 'OE码'],
    [1, '格栅', 'OE-A'],
    [2, '保险杠', 'OE-B'],
    [3, '大灯', 'OE-C'],
  ]);
  const inqLedger = createLedger({ rowCount: 5 });
  const inquiry = { sheet: inqSheet, ledger: inqLedger, headerRow: 1 };
  // 报价单：两行标题、表头行 2、数据行 3..6（4 行，比询价单多 1 行）
  const quoteSheet = mkSheet([
    ['工厂回表'],
    ['填写说明'],
    ['序号', '产品', '单价（含税）', '备货周期'],
    [1, '格栅', 300, '现货'],
    [2, '保险杠', 450, 30],
    [3, '大灯', '', '年后'],
    [4, '尾翼（多报）', 99, '现货'],
  ]);
  const quoteLedger = createLedger({ rowCount: 7 });
  const { extras, nextSeq } = computeFactoryExtras(
    inquiry, quoteSheet, quoteLedger);
  eq(extras.length, 1, '报价单多 1 行 → 1 条 factoryExtra');
  eq(extras[0].row, 6, 'extra 落在报价单物理第 7 行（下标 6）');
  eq(extras[0].lineId, 'L8', 'extra 用账本 nextSeq 分配新 lineId');
  eq(extras[0].factoryExtra, true, 'extra 打了 factoryExtra 标记');
  eq(nextSeq, 9, 'nextSeq 顺延一位');

  const quote = {
    sheet: quoteSheet, factoryName: '甲厂', headerRow: 2,
    priceMark: { col: 2, taxInclusive: true, taxRatePct: '13', periodCol: 3 },
    factoryExtras: extras,
  };
  const model = buildCompareRows({ inquiry, quotes: [quote] });
  eq(model.rows.length, 3, '比价行数 = 询价单数据行数 3（多报行不进比价表）');
  eq(model.rows[0].lineId, 'L3', '第 1 条数据行继承询价单账本 lineId L3');
  eq(model.rows[0].oe, 'OE-A', 'OE 按询价单表头列读');
  eq(model.rows[0].cells['甲厂'].normalized, 300,
    '对齐到报价单第 1 条数据行（物理行 3）的价 300，不是表头/标题');
  eq(model.rows[0].cells['甲厂'].period, '现货', '周期跟着对齐行走');
  eq(model.rows[1].cells['甲厂'].normalized, 450, '第 2 行对齐 450');
  eq(model.rows[2].cells['甲厂'].priced, false, '第 3 行报价为空 → 没报价');
  eq(model.rows[2].cells['甲厂'].normalized, null, '没报价的归一价是 null 不是 0');
  eq(model.rows[0].lowest, 300, '最低价提示 = 300');
  eq(model.rows[0].lowestFactories, ['甲厂'], '最低提示指向甲厂');

  // 报价单行数比询价单少：缺的行就是没报价
  const shortQuote = {
    sheet: mkSheet([
      ['序号', '单价'],
      [1, 111],
    ]),
    factoryName: '乙厂', headerRow: 0,
    priceMark: { col: 1, taxInclusive: false, taxRatePct: '10', periodCol: null },
  };
  const model2 = buildCompareRows({ inquiry, quotes: [shortQuote] });
  eq(model2.rows[0].cells['乙厂'].normalized, 122.1,
    '乙厂不含税 111 · 税点 10 → 122.10（各自口径各自换算）');
  eq(model2.rows[1].cells['乙厂'].priced, false, '乙厂缺第 2 行 → 没报价');
  eq(model2.rows[1].cells['乙厂'].quoteRow, null, '缺行 quoteRow = null');
  eq(model2.rows[0].lowestFactories, ['乙厂'],
    '第 1 行两家都有价时最低是乙厂 122.10（比甲厂 300 低）');
}

/* ================= 真实文件全链路 ================= */
console.log('== 真实文件：客户单 + 工厂回表（如实上传、标 J 列含税）');
const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SRC_CUST = path.join(FIXTURES, '___2_0dib.xlsx');
const SRC_FACT = path.join(FIXTURES, '_________________3_gmdr.xlsx');
function loadCopy(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qipei-pkg6-'));
  const copy = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, copy);
  const buf = fs.readFileSync(copy);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
{
  const custParsed = parseSheet(readWorkbook(loadCopy(SRC_CUST)), 'Sheet1');
  const factParsed = parseSheet(readWorkbook(loadCopy(SRC_FACT)), 'TIGGO');
  const inqSheet = sheetToFortune(custParsed, 0);
  const quoteSheet = sheetToFortune(factParsed, 0);
  const inquiry = {
    sheet: inqSheet,
    ledger: createLedger({ rowCount: custParsed.rowCount }),
    headerRow: 1,
  };
  const quote = {
    sheet: quoteSheet,
    ledger: createLedger({ rowCount: factParsed.rowCount }),
    factoryName: '回表工厂',
    headerRow: 1,
    priceMark: { col: 9, taxInclusive: true, taxRatePct: '13', periodCol: 10 },
  };
  eq(detectPeriodColumn(quoteSheet, 1), 10, '工厂回表周期列自动认出 = K 列（备货周期（天））');
  const model = buildCompareRows({ inquiry, quotes: [quote] });
  eq(model.rows.length, 37, '比价行数 = 37（两边数据行一样多）');
  const rowA = model.rows.find((r) => r.oe === 'F208401100');
  ok(!!rowA, '比价表里有 OE F208401100 这一行');
  eq(rowA && rowA.cells['回表工厂'].raw, 546, 'F208401100 原值 = 546');
  eq(rowA && rowA.cells['回表工厂'].normalized, 546, 'F208401100 含税归一价 = 546');
  eq(rowA && rowA.lowest, 546, 'F208401100 最低提示 = 546');
  const pricedCount = model.rows.filter((r) => r.cells['回表工厂'].priced).length;
  eq(pricedCount, 23, '有价行数 = 23（与回表 J 列非空数据格数一致）');
  const rowB = model.rows.find((r) => r.oe.trim() === 'F081301110HD');
  eq(rowB && rowB.cells['回表工厂'].normalized, 231,
    '第二条数据行（OE F081301110HD）的价对齐到 231（没串行）');
  const unpriced = model.rows.filter((r) => !r.cells['回表工厂'].priced);
  ok(unpriced.every((r) => r.cells['回表工厂'].normalized === null),
    '没报价的行归一价全是 null（' + unpriced.length + ' 行）');
  const { extras } = computeFactoryExtras(inquiry, quoteSheet, quote.ledger);
  eq(extras.length, 0, '两边行数相同 → 没有 factoryExtra');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
