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
import { unzipSync, zipSync } from 'fflate';

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

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const synPng = new Uint8Array(Buffer.from(PNG_B64, 'base64'));
const enc = (s) => new TextEncoder().encode(s);
const XML_DECL_TX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function makeSynParts() {
  return {
    '[Content_Types].xml': enc(XML_DECL_TX +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
      '</Types>'),
    '_rels/.rels': enc(XML_DECL_TX +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': enc(XML_DECL_TX +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc(XML_DECL_TX +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': enc(XML_DECL_TX +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:G10"/><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>' +
      '<row r="3"><c r="B3"><v>42</v></c></row>' +
      '</sheetData></worksheet>'),
    'xl/worksheets/_rels/sheet1.xml.rels': enc(XML_DECL_TX +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdDrw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'),
    'xl/drawings/drawing1.xml': enc(XML_DECL_TX +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<xdr:oneCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff>' +
      '<xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:ext cx="190500" cy="190500"/>' +
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="P1"/><xdr:cNvPicPr/></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
      '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="190500" cy="190500"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
      '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>'),
    'xl/drawings/_rels/drawing1.xml.rels': enc(XML_DECL_TX +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'),
    'xl/media/image1.png': synPng,
  };
}

const synBytes = zipSync(makeSynParts());
const readSyn = () => new Uint8Array(synBytes);

const synWb = readWorkbook(readSyn());
const synParsed1 = parseSheet(synWb, 'Sheet1');
eq(synParsed1.images.length, 1, 'H3 导入：合成原件 1 张标准浮动图被解析出');
eq([synParsed1.images[0].row, synParsed1.images[0].col], [2, 5], 'H3 导入：图锚在 F3（物理行 3、第 6 列）');
const synCanon = sheetToFortune(synParsed1, 0);

// 疑点①：发工厂下载（导出副本）→ 锚点只能有一份（不重复贴图）
const outSyn1 = buildQuoteXlsx({ originalBytes: readSyn(), sheetName: 'Sheet1', sheet: synCanon });
const unSyn1 = unzipSync(outSyn1);
const drawName1 = Object.keys(unSyn1).find((k) => /xl\/drawings\/drawing\d+\.xml$/.test(k));
const draw1 = drawName1 ? new TextDecoder().decode(unSyn1[drawName1]) : '';
eq((draw1.match(/<xdr:oneCellAnchor>/g) || []).length, 1, 'H3 导出①：锚点恰好 1 个（原件一份 + 工作层一份 = 不重复）');
eq(Object.keys(unSyn1).filter((k) => k.startsWith('xl/media/')).length, 1, 'H3 导出①：media 按内容去重 1 份');
const sxSyn1 = new TextDecoder().decode(unSyn1['xl/worksheets/sheet1.xml']);
ok(/<c r="B3"[^>]*>\s*<v>42<\/v>/.test(sxSyn1), 'H2 前置：原值 B3=42 回写保留');

// 疑点②：用户把 B3 改成公式 =A1（屏幕显示缓存值「标题」）→ 导出的是缓存值不是空格
const canonSyn2 = JSON.parse(JSON.stringify(synCanon));
const hitSyn2 = canonSyn2.celldata.find((c) => c.r === 2 && c.c === 1);
if (hitSyn2) { hitSyn2.v = { f: '=A1', v: '标题', m: '标题' }; }
else { (canonSyn2.celldata = canonSyn2.celldata || []).push({ r: 2, c: 1, v: { f: '=A1', v: '标题', m: '标题' } }); }
const outSyn2 = buildQuoteXlsx({ originalBytes: readSyn(), sheetName: 'Sheet1', sheet: canonSyn2 });
const unSyn2 = unzipSync(outSyn2);
const sxSyn2 = new TextDecoder().decode(unSyn2['xl/worksheets/sheet1.xml']);
const mSyn2 = sxSyn2.match(/<c r="B3"[^>]*>[\s\S]*?(<\/c>|\/>)/);
ok(mSyn2 && /标题/.test(mSyn2[0]), 'H2 导出②：B3 写的是公式缓存值「标题」（工厂收不到空格）', mSyn2 && mSyn2[0]);
eq((sxSyn2.match(/<f>/g) || []).length, 0, 'H2 导出②：公式本体不下传（只传它的缓存值，与屏幕显示一致）');

// 疑点③：用户把图全删光（images 清空）→ 导出件里的浮动图锚点必须清干净
const canonSyn3 = { ...synCanon, images: [] };
const outSyn3 = buildQuoteXlsx({ originalBytes: readSyn(), sheetName: 'Sheet1', sheet: canonSyn3 });
const unSyn3 = unzipSync(outSyn3);
const sxSyn3 = new TextDecoder().decode(unSyn3['xl/worksheets/sheet1.xml']);
eq((sxSyn3.match(/<drawing[\s\/>]/g) || []).length, 0, 'H3 导出③：用户删光图后，导出件里浮动图不复活（无 drawing 引用）');
eq(Object.keys(unSyn3).filter((k) => /xl\/drawings\/drawing\d+\.xml$/.test(k)).length, 0,
  'H3 导出③：清空后的 drawing 部件整件摘掉（不留空壳）');

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
