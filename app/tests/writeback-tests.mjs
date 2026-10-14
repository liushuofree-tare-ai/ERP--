// 写路径回归测试（包 5）：在真实客户单上就地回写——改一个原件格、
// 追加一列工作列——再用读取层解析下载件，断言：改动在、新增列在、
// 24 张图片在、合并 A1:G1 在、维度长大、被删空的格真的清掉、公式格
// （DISPIMG 图片格）分毫未动；另测无原件时的最小生成回读。
// 原文件只读，测试先复制到临时目录再读副本。
//
// 运行：npm test（Node 的 DOMParser/XMLSerializer 由 @xmldom/xmldom
// 提供，必须在 import 业务模块之前注入全局，所以用动态 import。）
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readWorkbook, parseSheet } = await import('../src/xlsx/workbook.js');
const { sheetToFortune } = await import('../src/xlsx/toFortuneSheet.js');
const { buildQuoteXlsx, buildMinimalXlsx } = await import('../src/xlsx/writeback.js');
const { setCellValue, appendColumn } = await import('../src/sheetOps.js');

const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SRC_CUST = path.join(FIXTURES, '___2_0dib.xlsx');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function loadCopy(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qipei-pkg5-'));
  const copy = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, copy);
  const buf = fs.readFileSync(copy);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function cellVal(parsed, r, c) {
  const cell = parsed.cells.find((x) => x.r === r && x.c === c);
  return cell ? cell.value : undefined;
}

/* ================= 就地回写：改值 + 加列 + 清值 ================= */
console.log('== 回写客户单（副本）');
const origBytes = loadCopy(SRC_CUST);
const wb = readWorkbook(origBytes);
const parsed = parseSheet(wb, 'Sheet1');
let fortune = sheetToFortune(parsed, 0);

// 模拟用户编辑：第 3 行产品格改成「散热器格栅改」；第 3 行 OE 格删空；
// 右侧追加工作列「中文名」，第 3 行填「格栅」
fortune = setCellValue(fortune, 2, 4, { v: '散热器格栅改', m: '散热器格栅改' });
fortune = setCellValue(fortune, 2, 6, null);
const added = appendColumn(fortune, 1, '中文名');
fortune = added.sheet;
eq(added.col, 7, '工作列追加在第 8 列（序号 7）');
fortune = setCellValue(fortune, 2, 7, { v: '格栅', m: '格栅' });
// 再改一个数字格：第 3 行序号 1 → 99（验数字回写）
fortune = setCellValue(fortune, 2, 0, { v: 99, m: '99' });

const outBytes = buildQuoteXlsx({ originalBytes: origBytes, sheetName: 'Sheet1', sheet: fortune });
ok(outBytes.length > 0, '生成了下载件字节', outBytes.length);

const wb2 = readWorkbook(outBytes);
const out = parseSheet(wb2, 'Sheet1');
eq(cellVal(out, 2, 4), '散热器格栅改', '改过的产品格 = 散热器格栅改');
eq(cellVal(out, 1, 7), '中文名', '新增列表头 = 中文名');
eq(cellVal(out, 2, 7), '格栅', '新增列第 3 行值 = 格栅');
eq(cellVal(out, 2, 0), 99, '数字格回写 = 99（且是数字不是文本）');
eq(cellVal(out, 2, 6), undefined, '删空的 OE 格真的空了');
eq(out.images.length, 24, '下载件图片仍是 24 张');
ok(out.merges.some((m) => m.r === 0 && m.c === 0 && m.rs === 1 && m.cs === 7),
  '合并 A1:G1 还在', out.merges);
eq(out.colCount, 8, '下载件列数 = 8（维度随工作列长大）');
eq(out.rowCount, 39, '下载件行数 = 39');
eq(cellVal(out, 0, 0), '欧冠嘉配件采购需求', '没动过的标题格原样');
eq(cellVal(out, 2, 1), 'JETOUR', '没动过的品牌格原样');
ok(!out.cells.some((c) => typeof c.value === 'string' && c.value.includes('DISPIMG')),
  'DISPIMG 公式仍未被当值显示（图片锚点格保护生效）');

/* ================= 无原件：最小生成回读 ================= */
console.log('== 最小生成（无原件降级）');
const minBytes = buildMinimalXlsx('Sheet1', fortune);
const wb3 = readWorkbook(minBytes);
const minOut = parseSheet(wb3, 'Sheet1');
eq(cellVal(minOut, 2, 4), '散热器格栅改', '最小生成：改过的值在');
eq(cellVal(minOut, 1, 7), '中文名', '最小生成：新增列表头在');
eq(cellVal(minOut, 2, 0), 99, '最小生成：数字在');
ok(minOut.merges.some((m) => m.r === 0 && m.c === 0 && m.rs === 1 && m.cs === 7),
  '最小生成：合并 A1:G1 在', minOut.merges);

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
