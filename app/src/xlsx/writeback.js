// xlsx 写路径（包 5）：把工作层的当前值「就地回写」进原文件字节，
// 生成给工厂的下载件（SPEC 第四节第 4 项：下载带原表格式与图片、
// 带上表格里改过的内容）。
//
// 做法：在 zip/XML 原始层只改目标工作表的单元格值——
//   · 已有格子：保留全部属性（尤其样式 s），只换值；
//     字符串写成内联字符串（inlineStr），不碰 sharedStrings.xml，
//     避免为加几个新字符串去改内容类型/关系等一串部件；
//   · 原表没有的格子（工作列、新增行）：按行列顺序新建；
//   · 公式格（含 WPS 的 DISPIMG 图片格）永不动——原件的公式与
//     图片锚点就靠它们活着；用户在表格里删空了的格子则清掉值；
//   · 其它部件（styles / merges 所在的工作表结构之外的一切、
//     cellimages、media、主题、其它工作表）逐字节原样带回。
// 没有原件时（示例数据）退化为按现值现生成一份最小 xlsx。
import { writeZip, partText } from './zip.js';
import { parseXml, serializeXml, createEl, children, firstChild } from './xml.js';
import { readWorkbook, parseCellRef } from './workbook.js';
import { collectPlacements, collectExportPlacements, imagifyParts, hasSheetDrawing } from './imagify.js';
import { StyleBook, specOf, ensureStylesPart } from './styles.js';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const encoder = new TextEncoder();

/** 0 起列号 → 列字母（A…Z, AA…） */
export function indexToCol(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function refOf(r, c) {
  return indexToCol(c) + String(r + 1);
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 规范格式工作表 → 待写值表：Map<'r,c', { kind, value }>。
 * 值取 v.v，其次 v.m；空值不入表（其"清空"语义由原件侧的清值逻辑处理）。
 *
 * 公式格（v.f）的两种情形分开处理（BUG H2 修复）：
 *  · 有缓存计算值 → 把缓存值当"值"写出去，与屏幕上显示的结果一致。
 *    用户在原本有值的格上输入公式时（如 B3 由 42 改成 =A1），屏幕显示
 *    计算结果是"标题"，下载件也必须是"标题"；旧实现对公式格一律跳过，
 *    于是该格既不进待写表、又被清值分支当成"工作层已删空"清掉，
 *    工厂收到的是空单元格。
 *  · 没有缓存值（如 WPS 的 DISPIMG 图片公式格）→ 不入表。原件侧另有
 *    两道守卫保证它不被破坏：原件公式格永不覆盖、清值分支对公式格豁免。
 */
export function canonicalValues(sheet) {
  const map = new Map();
  for (const cell of (sheet && sheet.celldata) || []) {
    if (!cell || !cell.v) continue;
    let val = cell.v.v !== undefined && cell.v.v !== null ? cell.v.v : cell.v.m;
    if (val === undefined || val === null || val === '') continue;
    if (!cell.v.f && typeof val === 'string' && val.startsWith('=')) {
      // 只有 m 是 "=…" 文本且没有正式值时，多半是公式的显示文本，不当值写
      continue;
    }
    const kind = typeof val === 'number' ? 'number' : (typeof val === 'boolean' ? 'boolean' : 'string');
    if (kind === 'string') val = String(val);
    map.set(cell.r + ',' + cell.c, {
      kind, value: val, r: cell.r, c: cell.c, fromFormula: !!cell.v.f,
    });
  }
  return map;
}

/** 工作层里带公式的格的 ref 集合（清值分支据此豁免——BUG H2 修复） */
function workFormulaRefs(sheet) {
  const refs = new Set();
  for (const cell of (sheet && sheet.celldata) || []) {
    if (cell && cell.v && cell.v.f) refs.add(refOf(cell.r, cell.c));
  }
  return refs;
}

/* ---------- sheet XML 就地改值 ---------- */

function clearValueChildren(cEl) {
  const kids = [];
  for (let i = 0; i < cEl.childNodes.length; i++) kids.push(cEl.childNodes[i]);
  for (const k of kids) {
    const ln = k.localName || k.nodeName;
    if (ln === 'v' || ln === 'f' || ln === 'is') cEl.removeChild(k);
  }
}

function hasChild(el, name) {
  return !!firstChild(el, name);
}

function setCellContent(doc, cEl, entry, origWasNumeric) {
  clearValueChildren(cEl);
  if (entry.kind === 'number' ||
      (entry.kind === 'string' && origWasNumeric && entry.value.trim() !== '' &&
       Number.isFinite(Number(entry.value)))) {
    // 数字：去掉 t、写 <v>。原本是数字格的字符串数字也按数字写，
    // 免得工厂那边打开全是"文本型数字"。
    cEl.removeAttribute('t');
    const v = createEl(doc, 'v');
    v.textContent = String(entry.kind === 'number' ? entry.value : Number(entry.value));
    cEl.appendChild(v);
  } else if (entry.kind === 'boolean') {
    cEl.setAttribute('t', 'b');
    const v = createEl(doc, 'v');
    v.textContent = entry.value ? '1' : '0';
    cEl.appendChild(v);
  } else {
    cEl.setAttribute('t', 'inlineStr');
    const is = createEl(doc, 'is');
    const t = createEl(doc, 't');
    if (/^\s|\s$/.test(entry.value)) t.setAttribute('xml:space', 'preserve');
    t.textContent = entry.value;
    is.appendChild(t);
    cEl.appendChild(is);
  }
}

function findOrCreateRow(doc, sheetData, r1) {
  let before = null;
  for (const rowEl of children(sheetData, 'row')) {
    const n = parseInt(rowEl.getAttribute('r') || '0', 10);
    if (n === r1) return rowEl;
    if (n > r1) { before = rowEl; break; }
  }
  const rowEl = createEl(doc, 'row');
  rowEl.setAttribute('r', String(r1));
  if (before) sheetData.insertBefore(rowEl, before);
  else sheetData.appendChild(rowEl);
  return rowEl;
}

function findOrCreateCell(doc, rowEl, r, c) {
  const ref = refOf(r, c);
  let before = null;
  for (const cEl of children(rowEl, 'c')) {
    const pos = parseCellRef(cEl.getAttribute('r'));
    if (!pos) continue;
    if (pos.r === r && pos.c === c) return cEl;
    if (pos.c > c) { before = cEl; break; }
  }
  const cEl = createEl(doc, 'c');
  cEl.setAttribute('r', ref);
  if (before) rowEl.insertBefore(cEl, before);
  else rowEl.appendChild(cEl);
  return cEl;
}

/** 把规范表的值就地写进 parts 里目标工作表的 XML（原地改 parts） */
export function applyValuesToSheet(parts, sheetPath, sheet) {
  const text = partText(parts, sheetPath);
  if (!text) throw new Error('原文件里找不到工作表部件: ' + sheetPath);
  const doc = parseXml(text);
  const root = doc.documentElement;
  let sheetData = firstChild(root, 'sheetData');
  if (!sheetData) {
    sheetData = createEl(doc, 'sheetData');
    root.appendChild(sheetData);
  }

  const values = canonicalValues(sheet);

  // 先盘点原件：哪些格有值、是不是数字格、带不带公式（公式格全保护）
  const origValued = new Map(); // ref → { numeric }
  const origFormula = new Set(); // 原件带公式的格（含 DISPIMG 图片格）：永不动
  for (const rowEl of children(sheetData, 'row')) {
    for (const cEl of children(rowEl, 'c')) {
      const ref = cEl.getAttribute('r');
      if (hasChild(cEl, 'f')) { origFormula.add(ref); continue; } // 公式格永不动
      if (!hasChild(cEl, 'v') && !hasChild(cEl, 'is')) continue; // 只有样式的空格
      const t = cEl.getAttribute('t');
      origValued.set(ref, { numeric: t === null || t === 'n' });
    }
  }

  // 写入现值（原件带公式的格跳过：公式的归宿是原件本身，写路径不覆盖它）
  for (const entry of values.values()) {
    const ref = refOf(entry.r, entry.c);
    if (origFormula.has(ref) && entry.fromFormula) continue;
    if (origFormula.has(ref)) {
      // 原件是公式格、工作层改成了普通值：保留原件公式，绝不写值进去
      continue;
    }
    const rowEl = findOrCreateRow(doc, sheetData, entry.r + 1);
    const cEl = findOrCreateCell(doc, rowEl, entry.r, entry.c);
    const orig = origValued.get(ref);
    setCellContent(doc, cEl, entry, !!(orig && orig.numeric));
  }

  // 清值：原件有值、工作层已删空（不在待写表里）的格 → 只留样式与位置。
  // 工作层带公式但算不出缓存值的格豁免：宁保留原件原值，也不静默清空
  // （BUG H2 的另一面——旧实现把它当"已删空"清掉了）。
  const wanted = new Set([...values.values()].map((e) => refOf(e.r, e.c)));
  const formulaRefs = workFormulaRefs(sheet);
  for (const rowEl of children(sheetData, 'row')) {
    for (const cEl of children(rowEl, 'c')) {
      const ref = cEl.getAttribute('r');
      if (!origValued.has(ref) || wanted.has(ref)) continue;
      if (formulaRefs.has(ref)) continue;
      clearValueChildren(cEl);
      cEl.removeAttribute('t');
    }
  }

  // 格式回写（格式继承）：样式表在原件上追加，没有改动就不动原件的 styles.xml
  const hadStyles = parts.has('xl/styles.xml');
  const book = StyleBook.load(parts);
  applyWorkStyles(doc, sheetData, sheet, book);
  applyRowLayout(doc, sheetData, sheet);
  applyColLayout(doc, root, sheet);
  if (book.save(parts) && !hadStyles) ensureStylesPart(parts);

  // 维度：覆盖（原件行列 ∪ 工作层行列）
  let maxR = (sheet && sheet.row) || 0;
  let maxC = (sheet && sheet.column) || 0;
  for (const rowEl of children(sheetData, 'row')) {
    const rn = parseInt(rowEl.getAttribute('r') || '0', 10);
    if (rn > maxR) maxR = rn;
    for (const cEl of children(rowEl, 'c')) {
      const pos = parseCellRef(cEl.getAttribute('r'));
      if (pos && pos.c + 1 > maxC) maxC = pos.c + 1;
    }
  }
  const dimEl = firstChild(root, 'dimension');
  if (dimEl && maxR > 0 && maxC > 0) {
    dimEl.setAttribute('ref', 'A1:' + refOf(maxR - 1, maxC - 1));
  }

  parts.set(sheetPath, encoder.encode(XML_DECL + serializeXml(doc)));
}

/* ---------- 工作层的格式回写：列宽 / 行高 / 隐藏行列 / 单元格样式 ---------- */

const PX_TO_PT = 0.75;
/** 与读取层互逆：列宽字符数 w ↔ 像素 px = w*7+5 */
const colCharsOfPx = (px) => Math.max(1, (px - 5) / 7);

/** 读出 <cols> 的全部区间（min/max 为 1 起的列号） */
function readColRanges(root) {
  const colsEl = firstChild(root, 'cols');
  const ranges = [];
  if (!colsEl) return ranges;
  for (const el of children(colsEl, 'col')) {
    const attrs = {};
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      attrs[a.name] = a.value;
    }
    ranges.push({ min: Number(el.getAttribute('min')), max: Number(el.getAttribute('max')), attrs });
  }
  return ranges;
}

/** 把第 c 列（0 起）的属性改成 patch；所在区间需要时切开，别的列属性不变 */
function patchColRanges(ranges, c, patch) {
  const cn = c + 1;
  const idx = ranges.findIndex((r) => r.min <= cn && cn <= r.max);
  if (idx < 0) {
    ranges.push({ min: cn, max: cn, attrs: { ...patch } });
    return;
  }
  const r = ranges[idx];
  const pieces = [];
  if (r.min < cn) pieces.push({ min: r.min, max: cn - 1, attrs: { ...r.attrs } });
  pieces.push({ min: cn, max: cn, attrs: { ...r.attrs, ...patch } });
  if (cn < r.max) pieces.push({ min: cn + 1, max: r.max, attrs: { ...r.attrs } });
  ranges.splice(idx, 1, ...pieces);
}

/** 写回 <cols>：放在 sheetData 之前（OOXML 元素顺序） */
function writeColRanges(doc, root, ranges) {
  const old = firstChild(root, 'cols');
  if (old) root.removeChild(old);
  if (!ranges.length) return;
  const colsEl = createEl(doc, 'cols');
  for (const r of ranges.slice().sort((a, b) => a.min - b.min)) {
    const el = createEl(doc, 'col');
    for (const [k, v] of Object.entries(r.attrs)) el.setAttribute(k, v);
    el.setAttribute('min', String(r.min));
    el.setAttribute('max', String(r.max));
    colsEl.appendChild(el);
  }
  const sd = firstChild(root, 'sheetData');
  if (sd) root.insertBefore(colsEl, sd);
  else root.appendChild(colsEl);
}

/** 列宽（columnlen）与隐藏列（colhidden）→ <cols>。没有改动就不碰原件的 <cols>。 */
function applyColLayout(doc, root, sheet) {
  const cfg = (sheet && sheet.config) || {};
  const targets = [];
  for (const k of Object.keys(cfg.columnlen || {})) {
    const c = Number(k);
    if (Number.isInteger(c) && c >= 0) {
      targets.push([c, { width: colCharsOfPx(cfg.columnlen[k]).toFixed(2), customWidth: '1' }]);
    }
  }
  for (const k of Object.keys(cfg.colhidden || {})) {
    const c = Number(k);
    if (Number.isInteger(c) && c >= 0) targets.push([c, { hidden: '1' }]);
  }
  if (!targets.length) return;
  const ranges = readColRanges(root);
  for (const [c, patch] of targets) patchColRanges(ranges, c, patch);
  writeColRanges(doc, root, ranges);
}

/** 行高（rowlen）与隐藏行（rowhidden）→ <row ht customHeight hidden> */
function applyRowLayout(doc, sheetData, sheet) {
  const cfg = (sheet && sheet.config) || {};
  const heights = cfg.rowlen || {};
  const hidden = cfg.rowhidden || {};
  const rows = new Set([...Object.keys(heights), ...Object.keys(hidden)].map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0));
  for (const r of rows) {
    const rowEl = findOrCreateRow(doc, sheetData, r + 1);
    if (heights[r] != null) {
      rowEl.setAttribute('ht', (heights[r] * PX_TO_PT).toFixed(2));
      rowEl.setAttribute('customHeight', '1');
    }
    if (r in hidden) rowEl.setAttribute('hidden', '1');
  }
}

/** 工作层里被用户改过样式的格子 → 原件样式表里的 xf（只写有改动的格子） */
function applyWorkStyles(doc, sheetData, sheet, book) {
  for (const cd of (sheet && sheet.celldata) || []) {
    const spec = specOf(cd.v);
    if (!spec) continue;
    const rowEl = findOrCreateRow(doc, sheetData, cd.r + 1);
    const cEl = findOrCreateCell(doc, rowEl, cd.r, cd.c);
    cEl.setAttribute('s', String(book.xfFor(spec)));
  }
}

/** 最小生成用：'r,c' → xf 下标（只含有样式的格子） */
function styleMapOf(sheet, book) {
  const map = new Map();
  for (const cd of (sheet && sheet.celldata) || []) {
    const spec = specOf(cd.v);
    if (spec) map.set(cd.r + ',' + cd.c, book.xfFor(spec));
  }
  return map;
}

/* ---------- 无原件时的最小生成 ---------- */

function minimalSheetXml(sheet, book) {
  const styles = styleMapOf(sheet, book);
  const sAttr = (r, c) => (styles.has(r + ',' + c) ? ' s="' + styles.get(r + ',' + c) + '"' : '');
  const values = canonicalValues(sheet);
  const rows = new Map();
  for (const e of values.values()) {
    if (!rows.has(e.r)) rows.set(e.r, []);
    rows.get(e.r).push(e);
  }
  // 只有样式、没有值的格子也要写出（否则底色等格式会丢）
  for (const k of styles.keys()) {
    if (values.has(k)) continue;
    const [r, c] = k.split(',').map(Number);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push({ r, c, kind: 'empty' });
  }
  let maxR = (sheet && sheet.row) || 0;
  let maxC = (sheet && sheet.column) || 0;
  for (const e of values.values()) {
    if (e.r + 1 > maxR) maxR = e.r + 1;
    if (e.c + 1 > maxC) maxC = e.c + 1;
  }
  // 列宽/行高（包 12）：表里记着的像素几何写回去——普通版导出带图时，
  // 锚点图的落点要靠这些宽度才和应用里看到的一致
  const cfg = (sheet && sheet.config) || {};
  const columnlen = cfg.columnlen || {};
  const rowlen = cfg.rowlen || {};
  const colKeys = Object.keys(columnlen).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  let colsXml = '';
  if (colKeys.length) {
    colsXml = '<cols>' + colKeys.map((c) => {
      const chars = Math.max(1, (columnlen[c] - 5) / 7);
      return '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' +
        chars.toFixed(2) + '" customWidth="1"/>';
    }).join('') + '</cols>';
  }
  let body = '';
  const allRows = new Set([...rows.keys(), ...Object.keys(rowlen).map(Number)]);
  for (const r of [...allRows].sort((a, b) => a - b)) {
    const ht = rowlen[r];
    body += '<row r="' + (r + 1) + '"' +
      (ht != null ? ' ht="' + (ht * 0.75).toFixed(2) + '" customHeight="1"' : '') + '>';
    for (const e of (rows.get(r) || []).sort((a, b) => a.c - b.c)) {
      const ref = refOf(e.r, e.c);
      const s = sAttr(e.r, e.c);
      if (e.kind === 'empty') body += '<c r="' + ref + '"' + s + '/>';
      else if (e.kind === 'number') body += '<c r="' + ref + '"' + s + '><v>' + e.value + '</v></c>';
      else if (e.kind === 'boolean') body += '<c r="' + ref + '"' + s + ' t="b"><v>' + (e.value ? 1 : 0) + '</v></c>';
      else body += '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t' +
        (/^\s|\s$/.test(e.value) ? ' xml:space="preserve"' : '') + '>' + escXml(e.value) + '</t></is></c>';
    }
    body += '</row>';
  }
  const merges = (sheet && sheet.config && sheet.config.merge) || {};
  const mergeList = Object.values(merges);
  let mergeXml = '';
  if (mergeList.length) {
    mergeXml = '<mergeCells count="' + mergeList.length + '">' + mergeList.map((m) =>
      '<mergeCell ref="' + refOf(m.r, m.c) + ':' + refOf(m.r + m.rs - 1, m.c + m.cs - 1) + '"/>'
    ).join('') + '</mergeCells>';
  }
  const dim = maxR > 0 && maxC > 0 ? 'A1:' + refOf(maxR - 1, maxC - 1) : 'A1';
  return XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<dimension ref="' + dim + '"/>' + colsXml + '<sheetData>' + body + '</sheetData>' + mergeXml + '</worksheet>';
}

/**
 * 按现值从零拼一份最小 xlsx（值/合并/行列几何；带图时把照片嵌成
 * 标准锚点图——包 12 起普通版导出的图片就走这条路）。
 * imageBytes：{ [fileId]: Uint8Array }，给只有仓库引用的图补字节。
 */
export function buildMinimalXlsx(sheetName, sheet, imageBytes) {
  const name = sheetName || (sheet && sheet.name) || 'Sheet1';
  const parts = new Map();
  parts.set('[Content_Types].xml', encoder.encode(XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>'));
  parts.set('_rels/.rels', encoder.encode(XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'));
  parts.set('xl/workbook.xml', encoder.encode(XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + escXml(name) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  parts.set('xl/_rels/workbook.xml.rels', encoder.encode(XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>'));
  // 样式表：有样式格子才生成（先建 book、写 sheet、再落样式部件与关系）
  const book = StyleBook.load(parts);
  parts.set('xl/worksheets/sheet1.xml', encoder.encode(minimalSheetXml(sheet, book)));
  if (book.save(parts)) ensureStylesPart(parts);
  const placements = collectExportPlacements(sheet, imageBytes);
  if (placements.length) imagifyParts(parts, 'xl/worksheets/sheet1.xml', placements);
  return writeZip(parts);
}

/**
 * 生成下载件字节：
 *   有原件 → 在原件上就地回写当前值（格式/合并/其它表全保留），
 *     图片在导出副本上标准化（包 12）：原件的 WPS 单元格图换成
 *     标准浮动图，Excel/谷歌表格/LibreOffice 都能看；应用里存着的
 *     原件不动一个字节；
 *   没原件 → 按现值生成最小 xlsx。
 * 入参：{ originalBytes: Uint8Array|null, sheetName, sheet（规范格式）,
 *        imageBytes?: { [fileId]: Uint8Array } }
 */
export function buildQuoteXlsx({ originalBytes, sheetName, sheet, imageBytes } = {}) {
  if (originalBytes && originalBytes.length) {
    const wb = readWorkbook(originalBytes);
    const meta = wb.sheets.find((s) => s.name === sheetName) || wb.sheets[0];
    applyValuesToSheet(wb.parts, meta.path, sheet);
    const placements = collectPlacements(sheet, imageBytes);
    // 只要原表挂过 drawing（标准浮动图）或存在 WPS 单元格图体系，就要走一次
    // imagify——哪怕 placements 为空：用户把图全删了，导出件里的旧锚点必须
    // 一并清掉，否则删掉的图会"复活"（BUG H3）。
    if (placements.length || wb.parts.has('xl/cellimages.xml') ||
        hasSheetDrawing(wb.parts, meta.path)) {
      imagifyParts(wb.parts, meta.path, placements);
    }
    return writeZip(wb.parts);
  }
  return buildMinimalXlsx(sheetName, sheet, imageBytes);
}
