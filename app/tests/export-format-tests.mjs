// 导出格式回归（2026-10-15）：
//  · 工作层的列宽 / 行高 / 单元格样式 → 带图版与普通版两种导出都要带上；
//  · 带图版的勾选：未勾选的行列在导出件里真删（旧"隐藏"方案已废），
//    选中行列的内容/最终价/图片按新行列号重映射；
//  · 没有格式改动时，不动原件的样式表。
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const { readWorkbook, parseSheet } = await import('../src/xlsx/workbook.js');
const { sheetToFortune } = await import('../src/xlsx/toFortuneSheet.js');
const { buildQuoteXlsx, buildMinimalXlsx } = await import('../src/xlsx/writeback.js');
const { setCellValue, appendColumn } = await import('../src/sheetOps.js');
const { parseXml, children, descendants } = await import('../src/xlsx/xml.js');
const { createLedger } = await import('../src/ledger.js');
const { buildPicturedExportSheet } = await import('../src/quoteExport.js');

const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ORIG = new Uint8Array(fs.readFileSync(path.join(FIXTURES, '___2_0dib.xlsx')));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}

const text = (parts, name) => new TextDecoder().decode(parts[name]);

/** 读某个单元格的样式：加粗 / 字号 / 字色 / 底色 / 水平对齐 */
function styleOf(parts, ref) {
  const sheet = parseXml(text(parts, 'xl/worksheets/sheet1.xml')).documentElement;
  const cell = descendants(sheet, 'c').find((c) => c.getAttribute('r') === ref);
  const s = cell ? cell.getAttribute('s') : null;
  if (s === null) return {};
  const st = parseXml(text(parts, 'xl/styles.xml')).documentElement;
  const xf = children(descendants(st, 'cellXfs')[0], 'xf')[Number(s)];
  const font = children(descendants(st, 'fonts')[0], 'font')[Number(xf.getAttribute('fontId'))];
  const fill = children(descendants(st, 'fills')[0], 'fill')[Number(xf.getAttribute('fillId'))];
  const sz = descendants(font, 'sz')[0];
  const color = descendants(font, 'color')[0];
  const fg = descendants(fill, 'fgColor')[0];
  const al = descendants(xf, 'alignment')[0];
  return {
    bold: descendants(font, 'b').length > 0,
    size: sz ? Number(sz.getAttribute('val')) : null,
    color: color ? color.getAttribute('rgb') : null,
    fill: fg ? fg.getAttribute('rgb') : null,
    h: al ? al.getAttribute('horizontal') : null,
  };
}

/** 用户的工作层改动：改一格、加一列、调列宽行高、给 B3 加样式 */
function workSheet() {
  let sheet = sheetToFortune(parseSheet(readWorkbook(ORIG), 'Sheet1'), 0);
  sheet = setCellValue(sheet, 2, 4, { v: '散热器格栅改', m: '散热器格栅改' });
  sheet = appendColumn(sheet, 1, '中文名').sheet;
  sheet = setCellValue(sheet, 2, 7, { v: '格栅', m: '格栅' });
  sheet = { ...sheet, config: { ...sheet.config,
    columnlen: { ...sheet.config.columnlen, 4: 220 },
    rowlen: { ...sheet.config.rowlen, 2: 66 } } };
  const b3 = sheet.celldata.find((c) => c.r === 2 && c.c === 1);
  b3.v = { ...b3.v, fs: 14, bl: 1, fc: '#ff0000', bg: '#ffff00', ht: 1, vt: 1 };
  return sheet;
}

/* ================= 带图版：列宽 / 行高 / 样式 ================= */
console.log('== 带图版：列宽 / 行高 / 单元格样式从工作层写出');
{
  const work = workSheet();
  const out = buildQuoteXlsx({ originalBytes: ORIG, sheetName: 'Sheet1', sheet: work });
  const parts = unzipSync(out);
  const parsed = parseSheet(readWorkbook(out), 'Sheet1');
  ok(Math.abs((parsed.columnWidthsPx[4] || 0) - 220) <= 2, 'E 列宽回读 ≈ 220px', parsed.columnWidthsPx[4]);
  ok(Math.abs((parsed.rowHeightsPx[2] || 0) - 66) <= 1, '第 3 行行高回读 ≈ 66px', parsed.rowHeightsPx[2]);
  eq(styleOf(parts, 'B3'), { bold: true, size: 14, color: 'FFFF0000', fill: 'FFFFFF00', h: 'center' },
    'B3 样式：加粗 / 14 号 / 红字 / 黄底 / 居中');
  eq(parsed.cells.find((c) => c.r === 2 && c.c === 1).value, 'JETOUR', 'B3 原值保留');
  eq(parsed.cells.find((c) => c.r === 2 && c.c === 4).value, '散热器格栅改', '改过的值仍在');
  eq(parsed.images.length, 24, '图片仍是 24 张');
}

console.log('== 带图版：没有格式改动时不动原件的样式表');
{
  const plain = sheetToFortune(parseSheet(readWorkbook(ORIG), 'Sheet1'), 0);
  const out = unzipSync(buildQuoteXlsx({ originalBytes: ORIG, sheetName: 'Sheet1', sheet: plain }));
  const orig = unzipSync(ORIG);
  eq(text(out, 'xl/styles.xml'), text(orig, 'xl/styles.xml'), 'styles.xml 与原件逐字节一致');
}

/* ================= 带图版勾选：未选行列真删（2026-10-15 改判） ================= */
console.log('== 带图版勾选：未选的行 / 列真删，选中内容重映射');
{
  const parsedCust = parseSheet(readWorkbook(ORIG), 'Sheet1');
  const inquiry = {
    docId: 'inq-test', kind: 'inquiry',
    sheet: sheetToFortune(parsedCust, 0),
    ledger: createLedger({ rowCount: parsedCust.rowCount }),
    headerRow: 1, pricing: {},
  };
  const picked = buildPicturedExportSheet({
    inquiry,
    selectedLineIds: new Set(['L3', 'L5']),
    finalPrices: new Map([['L3', 660.2], ['L5', 282.2]]),
    selectedColKeys: new Set(['c0', 'c4', 'final']),
  });
  ok(picked.exportSelection && picked.exportSelection.keepRows.size === 4,
    '保留行 = 标题 + 表头 + L3 + L5 共 4 行');
  eq([...picked.exportSelection.keepCols].sort((a, b) => a - b), [0, 4, 7],
    '保留列 = A + E + 最终报价（原 H 列）');
  const out = buildQuoteXlsx({ originalBytes: ORIG, sheetName: 'Sheet1', sheet: picked });
  const back = parseSheet(readWorkbook(out), 'Sheet1');
  eq(back.rowCount, 4, '导出行数 = 4（未选行真删，不是隐藏）');
  eq(back.colCount, 3, '导出列数 = 3（未选列真删）');
  eq(back.cells.find((c) => c.r === 2 && c.c === 2)?.value, 660.2, '已选 L3 的最终价在新列位（第 3 列）');
  eq(back.cells.find((c) => c.r === 3 && c.c === 2)?.value, 282.2, '已选 L5 的最终价跟到新行位（第 4 行）');
  eq(back.images.length, 0, '图片列没勾选 → 文件里一张图都没有（不随未选列泄漏）');

  // 勾上图片列时：选中行上的图留下并锚到新列位
  const pickedImg = buildPicturedExportSheet({
    inquiry,
    selectedLineIds: new Set(['L3']),
    finalPrices: new Map([['L3', 660.2]]),
    selectedColKeys: new Set(['c0', 'c5', 'final']),
  });
  const outImg = buildQuoteXlsx({ originalBytes: ORIG, sheetName: 'Sheet1', sheet: pickedImg });
  const backImg = parseSheet(readWorkbook(outImg), 'Sheet1');
  const expectImg = parsedCust.images.filter((i) => i.row === 2 && i.col === 5).length;
  eq(backImg.images.length, expectImg, '勾了图片列：L3 行的图留下（' + expectImg + ' 张）');
  ok(backImg.images.every((i) => i.row === 2 && i.col === 1), '留下的图锚在新列位（图片列现为第 2 列）');
}

/* ================= 普通版：样式从工作层写出 ================= */
console.log('== 普通版：样式从工作层写出');
{
  const work = workSheet();
  const parts = unzipSync(buildMinimalXlsx('Sheet1', work));
  eq(styleOf(parts, 'B3'), { bold: true, size: 14, color: 'FFFF0000', fill: 'FFFFFF00', h: 'center' },
    '普通版 B3 样式完整');
  ok(text(parts, '[Content_Types].xml').includes('/xl/styles.xml'), '内容类型登记了样式表');
  ok(text(parts, 'xl/_rels/workbook.xml.rels').includes('styles.xml'), '工作簿关系登记了样式表');
  // 只有样式、没有值的格子也要写出
  const withEmpty = { ...work, celldata: [...work.celldata, { r: 9, c: 2, v: { bg: '#00ff00' } }] };
  const parts2 = unzipSync(buildMinimalXlsx('Sheet1', withEmpty));
  eq(styleOf(parts2, 'C10').fill, 'FF00FF00', '空格子的底色也写出（C10）');
}
console.log('== 普通版：没有样式时不生成样式表');
{
  // 真·无样式：把导入带回的样式键全部剥掉的工作层（格式继承后，导入的
  // 表本来就带着原件样式，不再是"无样式"——那部分由 flow 测试覆盖）
  const imported = sheetToFortune(parseSheet(readWorkbook(ORIG), 'Sheet1'), 0);
  const plain = {
    ...imported,
    celldata: imported.celldata.map((cd) => {
      const v = { ...cd.v };
      for (const k of ['bl', 'it', 'un', 'cl', 'fs', 'fc', 'bg', 'ht', 'vt', 'tb', 'ff']) delete v[k];
      return { ...cd, v };
    }),
  };
  const parts = unzipSync(buildMinimalXlsx('Sheet1', plain));
  ok(!parts['xl/styles.xml'], '无样式 → 不生成 styles.xml');
}

/* ================= 转订单数量列：用户指定优先 ================= */
console.log('== 转订单数量列：用户指定优先，自动认作默认');
{
  const { qtyPrefillForInquiry } = await import('../src/quoteExport.js');
  const { createLedger } = await import('../src/ledger.js');
  // 哈萨克斯坦式表头：没有精确叫"数量"的列，件数藏在 F 列（索引 5）
  const rows = [
    ['序号', 'OE码', '品名', '车型', '单价', '件数（PCS）'],
    [1, 'F208401100', '散热器格栅', 'X90', 546, 3],
    [2, 'F081301110', '保险杠', 'X90', 231, ''],
    [3, 'F000000001', '灯', 'X90', 88, 0],
  ];
  const celldata = [];
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v !== '' && v !== null && v !== undefined) celldata.push({ r, c, v: { v, m: String(v) } });
  }));
  const sheet = { name: 'S', row: 4, column: 6, celldata, config: {} };
  const inquiry = { sheet, ledger: createLedger({ rowCount: 4 }), headerRow: 0 };
  eq(qtyPrefillForInquiry(inquiry).col, null, '没指定时：表头不精确（件数（PCS））→ 自动认不出，不带入');
  const pick = qtyPrefillForInquiry(inquiry, 5);
  eq(pick.col, 5, '指定 F 列 → 用指定列，不管表头叫什么');
  eq(pick.header, '件数（PCS）', '指定列的表头名原样返回');
  eq([...pick.qtys.entries()], [['L2', 3]], '只带正数：空白与 0 不带入（L3 的 0 不转，L4 留空）');
  eq(qtyPrefillForInquiry(inquiry, 2).qtys.size, 0, '指定的列全是文字时，没有任何数量');
  eq(qtyPrefillForInquiry(inquiry, 99).col, null, '指定越界的列号 → 当作没指定（回到自动认）');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
