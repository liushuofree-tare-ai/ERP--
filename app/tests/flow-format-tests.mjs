// 流程顺畅化回归（2026-10-15，用户实测三问题）：
//  1) 对客导出勾选必须真生效——已由 quote-export / export-format 覆盖删除语义；
//  2) 格式继承：原件样式进工作层 → 导出（普通版经面板构造器、带图版经
//     原件回写）都带得回来；只改一项样式不得冲掉原件的其它格式；
//  3) 转订单是独立模块：main.jsx 的导航与状态守卫不得再把它打回表格区。
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
const { createLedger } = await import('../src/ledger.js');
const { buildPlainExportSheet } = await import('../src/quoteExport.js');
const { parseXml, children, descendants } = await import('../src/xlsx/xml.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}

const FIXTURES = process.env.QIPEI_FIXTURES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ORIG = new Uint8Array(fs.readFileSync(path.join(FIXTURES, '___2_0dib.xlsx')));
const text = (parts, name) => new TextDecoder().decode(parts[name]);

console.log('== 格式继承 1：原件样式进工作层');
{
  const parsed = parseSheet(readWorkbook(ORIG), 'Sheet1');
  const styled = parsed.cells.filter((c) => c.style);
  ok(styled.length > 0, '解析带出样式的格子数 > 0', styled.length);
  const a1 = parsed.cells.find((c) => c.r === 0 && c.c === 0);
  eq(a1.style && a1.style.bl, 1, '标题格 A1 原件加粗被读出');
  eq(a1.style && a1.style.fs, 14, '标题格 A1 原件字号 14 被读出');
  const fortune = sheetToFortune(parsed, 0);
  const fa1 = fortune.celldata.find((c) => c.r === 0 && c.c === 0);
  eq(fa1.v.bl, 1, '工作层 A1 带加粗（编辑器能看到原格式）');
  eq(fa1.v.fs, 14, '工作层 A1 带字号 14');
}

console.log('== 格式继承 2：带图版无改动时 styles.xml 逐字节不变（带样式的工作层也不许弄脏）');
{
  const sheet = sheetToFortune(parseSheet(readWorkbook(ORIG), 'Sheet1'), 0);
  const out = unzipSync(buildQuoteXlsx({ originalBytes: ORIG, sheetName: 'Sheet1', sheet }));
  const origParts = unzipSync(ORIG);
  eq(text(out, 'xl/styles.xml'), text(origParts, 'xl/styles.xml'), 'styles.xml 与原件逐字节一致');
}

console.log('== 格式继承 3：带图版只改一项样式，其余原件格式保全');
{
  const sheet = sheetToFortune(parseSheet(readWorkbook(ORIG), 'Sheet1'), 0);
  const a1 = sheet.celldata.find((c) => c.r === 0 && c.c === 0);
  a1.v = { ...a1.v, fs: 20 }; // 只改字号：加粗/居中/垂直居中都应保留
  const out = buildQuoteXlsx({ originalBytes: ORIG, sheetName: 'Sheet1', sheet });
  const back = parseSheet(readWorkbook(out), 'Sheet1');
  const ba1 = back.cells.find((c) => c.r === 0 && c.c === 0);
  eq(ba1.style.fs, 20, '改过的字号 = 20');
  eq(ba1.style.bl, 1, '没动过的加粗仍在');
  eq(ba1.style.ht, 1, '没动过的水平居中仍在');
  eq(ba1.style.vt, 1, '没动过的垂直居中仍在');
}

console.log('== 格式继承 4：普通版（面板构造器路径）带工作层样式');
{
  const parsed = parseSheet(readWorkbook(ORIG), 'Sheet1');
  const sheet = sheetToFortune(parsed, 0);
  // 给数据格 B3（r=2,c=1）上一个醒目样式，模拟用户在表格里改格式
  const b3 = sheet.celldata.find((c) => c.r === 2 && c.c === 1);
  b3.v = { ...b3.v, bl: 1, fs: 14, fc: '#ff0000', bg: '#ffff00', ht: 1 };
  const inquiry = {
    sheet, headerRow: 1, pricing: {},
    ledger: createLedger({ rowCount: parsed.rowCount }),
  };
  const plain = buildPlainExportSheet({
    inquiry,
    selectedLineIds: new Set(['L3']),
    selectedColKeys: new Set(['c0', 'c1', 'final']),
    finalPrices: new Map([['L3', 660.2]]),
  });
  const b3out = plain.celldata.find((c) => c.r === 2 && c.c === 1);
  ok(!!b3out, '普通版里有 B3 这格');
  eq(b3out && b3out.v.bg, '#ffff00', '普通版构造器把底色带出来了（旧实现直接丢弃）');
  eq(b3out && b3out.v.fc, '#ff0000', '普通版构造器把字色带出来了');
  eq(b3out && b3out.v.fs, 14, '普通版构造器把字号带出来了');
  const parts = unzipSync(buildMinimalXlsx('Sheet1', plain));
  const st = parseXml(text(parts, 'xl/styles.xml')).documentElement;
  const sheetXml = parseXml(text(parts, 'xl/worksheets/sheet1.xml')).documentElement;
  const cellB3 = descendants(sheetXml, 'c').find((c) => c.getAttribute('r') === 'B3');
  ok(!!cellB3 && cellB3.getAttribute('s') !== null, '普通版文件里 B3 挂了样式下标');
  const xf = children(descendants(st, 'cellXfs')[0], 'xf')[Number(cellB3.getAttribute('s'))];
  const fill = children(descendants(st, 'fills')[0], 'fill')[Number(xf.getAttribute('fillId'))];
  eq(descendants(fill, 'fgColor')[0].getAttribute('rgb'), 'FFFFFF00', '普通版文件里 B3 底色是黄色');
}

console.log('== 转订单独立模块：导航守卫回归（源码级）');
{
  const mainSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main.jsx'), 'utf8');
  const effectStart = mainSrc.indexOf('useEffect(() => {');
  const effectEnd = mainSrc.indexOf('}, [activeDocId]);');
  ok(effectStart >= 0 && effectEnd > effectStart, '找到 activeDocId effect');
  const effectBody = mainSrc.slice(effectStart, effectEnd);
  ok(!effectBody.includes('setShowConvert(false)'),
    '切单据的 effect 不再关转订单（比价→转订单的竞态已除）');
  ok(mainSrc.includes("navBtn('convert', 'convert', '转订单'"), '左侧导航有独立的「转订单」模块入口');
  ok(mainSrc.includes("if (name === 'convert') { goView('convert'); return; }"),
    '工具栏转订单走 goView 进独立模块，不是表格浮层');
  const convertPanelSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/ConvertPanel.jsx'), 'utf8');
  ok(convertPanelSrc.includes('conv-go-export') && convertPanelSrc.includes('onExportCustomer'),
    '转完订单有「导出给客户」下一步（流程末步衔接）');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
