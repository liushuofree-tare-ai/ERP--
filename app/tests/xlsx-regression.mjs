// 文件层回归测试（SPEC 第七节真实文件回归集）：
// 用与浏览器完全相同的 src/xlsx 模块，读真实客户单与工厂回表的副本，
// 逐项断言已知地面真值。原文件只读，测试先复制到临时目录再读副本。
//
// 运行：npm test（Node 环境的 DOMParser 由 @xmldom/xmldom 提供，
// 必须在 import 业务模块之前注入全局，所以下面用动态 import。）
import { DOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readWorkbook, parseSheet } = await import('../src/xlsx/workbook.js');
const { sheetToFortune } = await import('../src/xlsx/toFortuneSheet.js');

const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SRC_CUST = path.join(FIXTURES, '___2_0dib.xlsx');
const SRC_FACT = path.join(FIXTURES, '_________________3_gmdr.xlsx');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function cellVal(parsed, r, c) {
  const cell = parsed.cells.find((x) => x.r === r && x.c === c);
  return cell ? cell.value : undefined;
}
function loadCopy(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qipei-pkg1-'));
  const copy = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, copy);
  const buf = fs.readFileSync(copy);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/* ================= 客户单 ================= */
console.log('== 客户单 ___2_0dib.xlsx（副本）');
const wb1 = readWorkbook(loadCopy(SRC_CUST));
eq(wb1.sheets.length, 3, '工作表数量 = 3');
eq(wb1.sheets.map((s) => s.name), ['Sheet1', 'Sheet2', 'Sheet3'], '工作表名 Sheet1/Sheet2/Sheet3');

const s1 = parseSheet(wb1, 'Sheet1');
eq(s1.rowCount, 39, 'Sheet1 物理行数 = 39');
eq(s1.colCount, 7, 'Sheet1 列数 = 7');
eq([0, 1, 2, 3, 4, 5, 6].map((c) => cellVal(s1, 1, c)),
  ['序号', '品牌', '品牌', '车型', '产品', '图片', 'OE码'],
  '表头在物理第 2 行且逐格一致');
eq(cellVal(s1, 0, 0), '欧冠嘉配件采购需求', '标题行 A1');
eq(cellVal(s1, 2, 6), 'F208401100', '第 3 行 OE 码 = F208401100');
eq(cellVal(s1, 2, 4), '散热器格栅', '第 3 行产品名');
ok(s1.merges.some((m) => m.r === 0 && m.c === 0 && m.rs === 1 && m.cs === 7),
  '合并 A1:G1 存在', s1.merges);
ok(!s1.cells.some((c) => typeof c.value === 'string' && c.value.includes('DISPIMG')),
  '没有任何格子把 DISPIMG 公式当值显示');

eq(s1.images.length, 24, '带锚点的图片恰好 24 张');
ok(s1.images.every((i) => i.kind === 'cell'), '24 张全部是 WPS 单元格图');
ok(s1.images.every((i) => typeof i.dataUrl === 'string' && i.dataUrl.startsWith('data:image/')),
  '24 张全部转成了 data URL');
const f3 = s1.images.find((i) => i.row === 2 && i.col === 5);
ok(!!f3, 'F3 有锚点图片');
eq(f3 && f3.cellImageId, 'ID_ED9DDB16E53747CDBFB2469E7A0A0EE7', 'F3 图片 ID 对得上');
ok(f3 && f3.dataUrl.startsWith('data:image/png'), 'F3 图片是 png', f3 && f3.dataUrl.slice(0, 30));
eq(new Set(s1.images.map((i) => i.row + ',' + i.col)).size, 24, '24 个锚点互不重叠');

// FortuneSheet 映射（含几何：列宽 9/16/11.876/43.522/16.912 字符 → 68/117/88/310/123 px；
// 行高 20.25/15.75 磅 → 27/21 px；F 列宽 13.876 → 102 px；第 3 行高 69.4 磅 → 93 px）
const fs1 = sheetToFortune(s1, 0);
eq(fs1.images.length, 24, '映射后图片 24 张');
const fimg = fs1.images.find((i) => i.anchorRow === 2 && i.anchorCol === 5);
eq(fimg && { left: fimg.left, top: fimg.top, width: fimg.width, height: fimg.height },
  { left: 706, top: 48, width: 102, height: 93 },
  'F3 图片几何 = 锚点格左上(706,48) 尺寸 102×93');
const oeCell = fs1.celldata.find((c) => c.r === 2 && c.c === 6);
eq(oeCell && oeCell.v && oeCell.v.v, 'F208401100', '映射后 OE 格值正确');
eq(fs1.config.merge['0_0'], { r: 0, c: 0, rs: 1, cs: 7 }, '映射后合并配置正确');

/* ================= 工厂回表 ================= */
console.log('== 工厂回表 _________________3_gmdr.xlsx（副本）');
const wb2 = readWorkbook(loadCopy(SRC_FACT));
eq(wb2.sheets.length, 1, '工作表数量 = 1');
eq(wb2.sheets[0].name, 'TIGGO', '表名 TIGGO');

const t = parseSheet(wb2, 'TIGGO');
eq(t.rowCount, 39, 'TIGGO 物理行数 = 39');
eq(t.colCount, 12, 'TIGGO 列数 = 12（A–L）');
eq(cellVal(t, 2, 8), 520, 'I3 不含税价 = 520');
eq(cellVal(t, 2, 9), 546, 'J3 含税价 = 546');
eq(cellVal(t, 3, 9), 231, 'J4 含税价 = 231');
eq(cellVal(t, 1, 7), '数量（件）', 'H 列表头');
eq(cellVal(t, 1, 9), '单价（元，含税）', 'J 列表头');
eq(t.images.length, 24, 'TIGGO 图片 24 张');

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
