// 文件层两条疑点的实证验证（合成原件 + 真实模块路径）：
// ① 原件带标准浮动图 → 导出是否重复贴图
// ② 用户在原值格上输公式 → 导出件里该格是否被清空
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

import { unzipSync, zipSync, strToU8 } from 'fflate';
const { readWorkbook, parseSheet } = await import('../src/xlsx/workbook.js');
const { sheetToFortune } = await import('../src/xlsx/toFortuneSheet.js');
const { buildQuoteXlsx } = await import('../src/xlsx/writeback.js');

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = new Uint8Array(Buffer.from(PNG_B64, 'base64'));
const enc = (s) => strToU8(s);

// ---- 合成原件：A1 文本、B3=42、F3 一张标准浮动图 ----
const parts = {
  '[Content_Types].xml': enc(XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
    '</Types>'),
  '_rels/.rels': enc(XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  'xl/workbook.xml': enc(XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': enc(XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': enc(XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<dimension ref="A1:G10"/><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>' +
    '<row r="3"><c r="B3"><v>42</v></c></row>' +
    '</sheetData></worksheet>'),
  'xl/worksheets/_rels/sheet1.xml.rels': enc(XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdDrw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'),
  'xl/drawings/drawing1.xml': enc(XML_DECL +
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
  'xl/drawings/_rels/drawing1.xml.rels': enc(XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'),
  'xl/media/image1.png': png,
};
const origBytes = zipSync(parts);

// ---- 导入（与浏览器同路径）----
const wb = readWorkbook(origBytes);
const s1 = parseSheet(wb, 'Sheet1');
console.log('[导入] 解析出图片:', s1.images.length,
  s1.images[0] ? JSON.stringify({ row: s1.images[0].row, col: s1.images[0].col, kind: s1.images[0].kind, hasDataUrl: typeof s1.images[0].dataUrl === 'string' }) : '(无)');
const canon = sheetToFortune(s1, 0);
console.log('[工作层] images:', (canon.images || []).length,
  canon.images && canon.images[0] ? Object.keys(canon.images[0]).join(',') : '(无)');

// ---- 疑点①：发工厂下载（导出副本）----
const out = buildQuoteXlsx({ originalBytes: origBytes, sheetName: 'Sheet1', sheet: canon });
const un = unzipSync(out);
const drawName = Object.keys(un).find((k) => /^xl\/drawings\/drawing\d+\.xml$/.test(k));
const draw = drawName ? new TextDecoder().decode(un[drawName]) : '';
const anchors = (draw.match(/<xdr:oneCellAnchor>/g) || []).length;
console.log('[导出①] drawing 部件:', drawName || '(无)', ' 锚点数:', anchors,
  ' media 数:', Object.keys(un).filter((k) => k.startsWith('xl/media/')).length);
const sx1 = new TextDecoder().decode(un['xl/worksheets/sheet1.xml']);
console.log('[导出①] B3 原值 42 保留:', /<c r="B3"[^>]*>\s*<v>42<\/v>/.test(sx1));

// ---- 疑点②：用户把 B3（原值格）改成公式 =A1 ----
const canon2 = JSON.parse(JSON.stringify(canon));
const cell = (canon2.celldata || []).find((c) => c.r === 2 && c.c === 1);
if (cell) cell.v = { f: '=A1', v: '标题', m: '标题' };
else (canon2.celldata = canon2.celldata || []).push({ r: 2, c: 1, v: { f: '=A1', v: '标题', m: '标题' } });
const out2 = buildQuoteXlsx({ originalBytes: origBytes, sheetName: 'Sheet1', sheet: canon2 });
const un2 = unzipSync(out2);
const sx2 = new TextDecoder().decode(un2['xl/worksheets/sheet1.xml']);
const m2 = sx2.match(/<c r="B3"[^>]*>[\s\S]*?(<\/c>|\/>)/);
console.log('[导出②] B3 单元格输出:', m2 ? m2[0] : '(B3 不存在)');
