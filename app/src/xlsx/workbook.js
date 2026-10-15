// xlsx 读取层（新写）：在 zip/XML 原始层解析工作簿，不经过任何第三方
// 表格模型，保证行列、合并、空行与原文件逐格一致（SPEC 第四节第 1 项）。
//
// 图片有两条路：
//  1) 浮动图：工作表 rels → drawing 部件 → 锚点(xdr:from) + blip → media
//  2) WPS 单元格图（全网无组件支持，必须自研）：单元格公式
//     _xlfn.DISPIMG("ID_…",1) 里的 ID 对应 xl/cellimages.xml 中
//     <etc:cellImage> 的 cNvPr name，再经 cellimages 的 rels 找到 media。
import { openZip, partText, partBytes, mimeOf, bytesToDataUrl } from './zip.js';
import { parseXml, children, firstChild, descendants, attr, textOf, concatT } from './xml.js';

const EMU_PER_PX = 9525; // 914400 EMU/英寸 ÷ 96 px/英寸

/* ---------- 通用小工具 ---------- */

/** 关系文件解析：Id → Target */
function parseRels(parts, relsPath) {
  const map = new Map();
  const text = partText(parts, relsPath);
  if (!text) return map;
  const doc = parseXml(text);
  for (const rel of descendants(doc, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map.set(id, { target, type: rel.getAttribute('Type') || '' });
  }
  return map;
}

function dirOf(partPath) {
  const i = partPath.lastIndexOf('/');
  return i >= 0 ? partPath.slice(0, i + 1) : '';
}

function relsPathOf(partPath) {
  return dirOf(partPath) + '_rels/' + partPath.slice(partPath.lastIndexOf('/') + 1) + '.rels';
}

/** 把 rels 里的相对 Target 按来源部件目录解析成 zip 内绝对路径 */
function resolveTarget(fromPartPath, target) {
  if (/^https?:/i.test(target)) return target;
  let p;
  if (target.startsWith('/')) p = target.slice(1);
  else p = dirOf(fromPartPath) + target;
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** 列字母 → 0 起列号（A→0） */
export function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 单元格引用 "F3" → { r: 2, c: 5 }（均 0 起） */
export function parseCellRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: colToIndex(m[1]) };
}

/** 区域引用 "A1:G1" → { r, c, rs, cs }（左上角 0 起 + 跨度） */
export function parseRangeRef(ref) {
  const [a, b] = String(ref || '').split(':');
  const start = parseCellRef(a);
  if (!start) return null;
  const end = b ? parseCellRef(b) : start;
  if (!end) return null;
  return { r: start.r, c: start.c, rs: end.r - start.r + 1, cs: end.c - start.c + 1 };
}

/** Excel 列宽（字符数）→ 像素（MDW=7，Calibri 11 的标准近似） */
export function charsToPx(w) {
  return Math.max(0, Math.round(w * 7 + 5));
}

/** 行高（磅）→ 像素 */
export function ptToPx(pt) {
  return Math.max(0, Math.round(pt * 96 / 72));
}

/* ---------- 工作簿 ---------- */

/**
 * 打开 xlsx 字节 → 工作簿对象：
 * { parts, sheets: [{name, path}], sharedStrings: string[], cellImages: Map }
 * cellImages: Map<ID字符串, { mediaPath, mime, naturalWidthPx, naturalHeightPx }>
 */
export function readWorkbook(input) {
  const parts = openZip(input);

  // 工作表清单
  const wbText = partText(parts, 'xl/workbook.xml');
  if (!wbText) throw new Error('不是有效的 xlsx：缺少 xl/workbook.xml');
  const wbDoc = parseXml(wbText);
  const wbRels = parseRels(parts, 'xl/_rels/workbook.xml.rels');
  const sheets = [];
  const sheetsEl = descendants(wbDoc, 'sheets')[0];
  for (const sh of children(sheetsEl, 'sheet')) {
    const name = sh.getAttribute('name');
    const rid = attr(sh, 'r:id', 'id');
    const rel = rid ? wbRels.get(rid) : null;
    if (name && rel) sheets.push({ name, path: resolveTarget('xl/workbook.xml', rel.target) });
  }
  if (sheets.length === 0) throw new Error('xlsx 里没有找到工作表');

  // 共享字符串
  const sharedStrings = [];
  const ssText = partText(parts, 'xl/sharedStrings.xml');
  if (ssText) {
    const ssDoc = parseXml(ssText);
    for (const si of descendants(ssDoc, 'si')) sharedStrings.push(concatT(si));
  }

  // WPS 单元格图目录（工作簿级，与具体工作表无关）
  const cellImages = parseCellImageCatalog(parts);

  const wb = { parts, sheets, sharedStrings, cellImages };
  // 单元格样式表（格式继承）：原件的字体/填充/对齐按 xf 下标解析好，
  // parseSheet 读格时按 s 属性带出——此前样式完全不进工作层，编辑器
  // 里看不到原格式，普通版导出更是把格式全丢了（用户实测 2026-10-15）。
  wb.styles = parseStyleTable(parts);
  return wb;
}

/* ---------- 样式表：xl/styles.xml → 每格的 FortuneSheet 样式键 ---------- */

/** ARGB（FFRRGGBB）→ '#rrggbb'；theme/indexed 等无法确值的返回 null */
function argbToHex(rgb) {
  if (typeof rgb !== 'string') return null;
  const m = /^FF([0-9a-fA-F]{6})$/.exec(rgb.trim());
  return m ? '#' + m[1].toLowerCase() : null;
}

/**
 * 解析 styles.xml → { byIndex: [fortuneStyle|null, …] }（下标 = 单元格 s 属性）。
 * 只翻译工作层能表达的子集：加粗/斜体/下划线/删除线/字号/字色/底色/
 * 水平与垂直对齐/换行。边框与数字格式不进工作层——带图版靠回写时
 * 与原件 xf 合并来保全（见 styles.js 的 xfForWithBase），普通版不带。
 */
function parseStyleTable(parts) {
  const empty = { byIndex: [] };
  const text = partText(parts, 'xl/styles.xml');
  if (!text) return empty;
  let doc;
  try { doc = parseXml(text); } catch (e) { return empty; }
  const root = doc.documentElement;
  const fontsEl = descendants(root, 'fonts')[0];
  const fillsEl = descendants(root, 'fills')[0];
  const xfsEl = descendants(root, 'cellXfs')[0];
  if (!fontsEl || !fillsEl || !xfsEl) return empty;
  const fonts = children(fontsEl, 'font').map((f) => {
    const sz = descendants(f, 'sz')[0];
    const color = descendants(f, 'color')[0];
    const u = descendants(f, 'u')[0];
    return {
      bold: descendants(f, 'b').length > 0,
      italic: descendants(f, 'i').length > 0,
      strike: descendants(f, 'strike').length > 0,
      underline: !!u && u.getAttribute('val') !== 'none',
      size: sz ? parseFloat(sz.getAttribute('val')) : null,
      color: color ? argbToHex(color.getAttribute('rgb')) : null,
    };
  });
  const fills = children(fillsEl, 'fill').map((fl) => {
    const pf = descendants(fl, 'patternFill')[0];
    if (!pf || pf.getAttribute('patternType') !== 'solid') return null;
    const fg = descendants(pf, 'fgColor')[0];
    return fg ? argbToHex(fg.getAttribute('rgb')) : null;
  });
  const byIndex = children(xfsEl, 'xf').map((xf) => {
    const font = fonts[Number(xf.getAttribute('fontId'))] || {};
    const fill = fills[Number(xf.getAttribute('fillId'))];
    const al = descendants(xf, 'alignment')[0];
    const st = {};
    if (font.bold) st.bl = 1;
    if (font.italic) st.it = 1;
    if (font.underline) st.un = 1;
    if (font.strike) st.cl = 1;
    if (font.size && Number.isFinite(font.size)) st.fs = font.size;
    if (font.color) st.fc = font.color;
    if (fill) st.bg = fill;
    if (al) {
      const h = al.getAttribute('horizontal');
      if (h === 'center') st.ht = 1; else if (h === 'right') st.ht = 2;
      const v = al.getAttribute('vertical');
      if (v === 'center') st.vt = 1; else if (v === 'bottom') st.vt = 2;
      if (al.getAttribute('wrapText') === '1' || al.getAttribute('wrapText') === 'true') st.tb = 2;
    }
    return Object.keys(st).length ? st : null;
  });
  return { byIndex };
}

/** 解析 xl/cellimages.xml：ID → media 信息 */
function parseCellImageCatalog(parts) {
  const map = new Map();
  const text = partText(parts, 'xl/cellimages.xml');
  if (!text) return map;
  const rels = parseRels(parts, 'xl/_rels/cellimages.xml.rels');
  const doc = parseXml(text);
  for (const item of descendants(doc, 'cellImage')) {
    const pic = descendants(item, 'pic')[0];
    if (!pic) continue;
    const cNvPr = descendants(pic, 'cNvPr')[0];
    const idName = cNvPr ? cNvPr.getAttribute('name') : null;
    if (!idName) continue;
    const blip = descendants(pic, 'blip')[0];
    const rid = blip ? attr(blip, 'r:embed', 'embed') : null;
    const rel = rid ? rels.get(rid) : null;
    if (!rel) continue;
    const mediaPath = resolveTarget('xl/cellimages.xml', rel.target);
    // 自然尺寸（EMU）在 spPr/xfrm/ext 里
    let naturalWidthPx = 0, naturalHeightPx = 0;
    const ext = descendants(pic, 'ext')[0];
    if (ext) {
      naturalWidthPx = Math.round(parseInt(ext.getAttribute('cx') || '0', 10) / EMU_PER_PX);
      naturalHeightPx = Math.round(parseInt(ext.getAttribute('cy') || '0', 10) / EMU_PER_PX);
    }
    map.set(idName, { mediaPath, mime: mimeOf(mediaPath), naturalWidthPx, naturalHeightPx });
  }
  return map;
}

/* ---------- 工作表 ---------- */

const DISPIMG_RE = /DISPIMG\(\s*"([^"]+)"/i;

/**
 * 解析一张工作表（sheetRef = 下标或表名）→
 * {
 *   name, rowCount, colCount,
 *   cells: [{ r, c, value, formula? }],        // 0 起；只含非空/有公式的格
 *   merges: [{ r, c, rs, cs }],
 *   columnWidthsPx: { [c]: px }, rowHeightsPx: { [r]: px },
 *   defaultColWidthPx, defaultRowHeightPx,
 *   images: [{ kind: 'cell'|'floating', row, col, dataUrl, mime,
 *              naturalWidthPx, naturalHeightPx,
 *              offsetXPx?, offsetYPx?, endRow?, endCol?, endOffsetXPx?, endOffsetYPx?,
 *              cellImageId? }]
 * }
 */
export function parseSheet(wb, sheetRef) {
  const idx = typeof sheetRef === 'number'
    ? sheetRef
    : wb.sheets.findIndex((s) => s.name === sheetRef);
  if (idx < 0 || idx >= wb.sheets.length) throw new Error('工作表不存在: ' + sheetRef);
  const meta = wb.sheets[idx];
  const text = partText(wb.parts, meta.path);
  if (!text) throw new Error('工作表部件缺失: ' + meta.path);
  const doc = parseXml(text);
  const root = doc.documentElement;

  // 维度与默认尺寸
  let maxRow = 0, maxCol = 0;
  const dimEl = firstChild(root, 'dimension');
  const dim = dimEl ? parseRangeRef(dimEl.getAttribute('ref')) : null;
  if (dim) { maxRow = dim.r + dim.rs; maxCol = dim.c + dim.cs; }
  const fmtEl = firstChild(root, 'sheetFormatPr');
  const defaultColWidthPx = charsToPx(fmtEl && fmtEl.getAttribute('defaultColWidth')
    ? parseFloat(fmtEl.getAttribute('defaultColWidth')) : 8.43);
  const defaultRowHeightPx = ptToPx(fmtEl && fmtEl.getAttribute('defaultRowHeight')
    ? parseFloat(fmtEl.getAttribute('defaultRowHeight')) : 15);

  // 列宽
  const columnWidthsPx = {};
  const colsEl = firstChild(root, 'cols');
  if (colsEl) {
    for (const col of children(colsEl, 'col')) {
      const w = col.getAttribute('width');
      if (w == null) continue;
      const min = parseInt(col.getAttribute('min') || '1', 10);
      const max = parseInt(col.getAttribute('max') || String(min), 10);
      for (let c = min; c <= max; c++) columnWidthsPx[c - 1] = charsToPx(parseFloat(w));
    }
  }

  // 单元格与行高
  const cells = [];
  const rowHeightsPx = {};
  const cellImageAnchors = []; // { r, c, idName }
  const sheetData = firstChild(root, 'sheetData');
  if (sheetData) {
    let autoRow = 0;
    for (const rowEl of children(sheetData, 'row')) {
      const rAttr = rowEl.getAttribute('r');
      const r = rAttr ? parseInt(rAttr, 10) - 1 : autoRow;
      autoRow = r + 1;
      const ht = rowEl.getAttribute('ht');
      if (ht != null) rowHeightsPx[r] = ptToPx(parseFloat(ht));
      if (r + 1 > maxRow) maxRow = r + 1;
      let autoCol = 0;
      for (const cEl of children(rowEl, 'c')) {
        const ref = cEl.getAttribute('r');
        const pos = ref ? parseCellRef(ref) : { r, c: autoCol };
        if (!pos) continue;
        autoCol = pos.c + 1;
        if (pos.c + 1 > maxCol) maxCol = pos.c + 1;
        const cell = readCell(wb, cEl, pos);
        if (cell.imageId) cellImageAnchors.push({ r: pos.r, c: pos.c, idName: cell.imageId });
        if (cell.keep) cells.push(cell.out);
      }
    }
  }

  // 合并
  const merges = [];
  const mergesEl = firstChild(root, 'mergeCells');
  if (mergesEl) {
    for (const mc of children(mergesEl, 'mergeCell')) {
      const m = parseRangeRef(mc.getAttribute('ref'));
      if (m) merges.push(m);
    }
  }
  for (const m of merges) {
    if (m.r + m.rs > maxRow) maxRow = m.r + m.rs;
    if (m.c + m.cs > maxCol) maxCol = m.c + m.cs;
  }

  // 图片：WPS 单元格图（按锚点格）+ 浮动图（drawing）
  const images = [];
  for (const a of cellImageAnchors) {
    const entry = wb.cellImages.get(a.idName);
    if (!entry) continue;
    const bytes = partBytes(wb.parts, entry.mediaPath);
    if (!bytes) continue;
    images.push({
      kind: 'cell',
      row: a.r,
      col: a.c,
      cellImageId: a.idName,
      mime: entry.mime,
      dataUrl: bytesToDataUrl(bytes, entry.mime),
      naturalWidthPx: entry.naturalWidthPx,
      naturalHeightPx: entry.naturalHeightPx,
    });
    if (a.r + 1 > maxRow) maxRow = a.r + 1;
    if (a.c + 1 > maxCol) maxCol = a.c + 1;
  }
  images.push(...parseDrawingImages(wb, meta.path));

  return {
    name: meta.name,
    rowCount: maxRow,
    colCount: maxCol,
    cells,
    merges,
    columnWidthsPx,
    rowHeightsPx,
    defaultColWidthPx,
    defaultRowHeightPx,
    images,
  };
}

/** 读一个单元格：返回值、公式，并识别 DISPIMG 图片格 */
function readCell(wb, cEl, pos) {
  const t = cEl.getAttribute('t');
  const fEl = firstChild(cEl, 'f');
  const vEl = firstChild(cEl, 'v');
  const formula = fEl ? textOf(fEl) : null;
  const vText = vEl ? textOf(vEl) : null;

  // WPS 单元格图：公式（或缓存值）里带 DISPIMG("ID_…")。
  // 这类格的缓存 <v> 是 "=DISPIMG(...)" 字面文本，绝不能当值显示。
  const dispSrc = formula || vText || '';
  const dm = DISPIMG_RE.exec(dispSrc);
  if (dm) {
    return { keep: false, imageId: dm[1], out: null };
  }

  let value = null;
  if (t === 's') {
    const i = vText == null ? NaN : parseInt(vText, 10);
    value = Number.isInteger(i) && wb.sharedStrings[i] !== undefined ? wb.sharedStrings[i] : null;
  } else if (t === 'inlineStr') {
    const isEl = firstChild(cEl, 'is');
    value = isEl ? concatT(isEl) : null;
  } else if (t === 'b') {
    value = vText === '1';
  } else if (t === 'e') {
    value = vText;
  } else if (t === 'str') {
    value = vText;
  } else if (vText != null && vText !== '') {
    const n = Number(vText);
    value = Number.isNaN(n) ? vText : n;
  }

  const has = value !== null && value !== undefined && value !== '';
  if (!has && !formula) return { keep: false, imageId: null, out: null };
  const out = { r: pos.r, c: pos.c, value: has ? value : null };
  if (formula) out.formula = formula;
  // 样式（s 属性 → xf 下标 → 工作层样式键）：有值的格才带，纯样式空格
  // 仍不进解析结果（与此前"只含非空/有公式的格"的口径一致，不惊动行列统计）
  const sAttr = cEl.getAttribute('s');
  if (sAttr !== null && sAttr !== '' && wb.styles && wb.styles.byIndex) {
    const st = wb.styles.byIndex[Number(sAttr)];
    if (st) out.style = st;
  }
  return { keep: true, imageId: null, out };
}

/** 浮动图：工作表 rels → drawing → 锚点 + blip → drawing rels → media */
function parseDrawingImages(wb, sheetPath) {
  const out = [];
  const rels = parseRels(wb.parts, relsPathOf(sheetPath));
  let drawingPath = null;
  for (const rel of rels.values()) {
    if (rel.type.endsWith('/drawing')) {
      drawingPath = resolveTarget(sheetPath, rel.target);
      break;
    }
  }
  if (!drawingPath) return out;
  const dText = partText(wb.parts, drawingPath);
  if (!dText) return out;
  const dRels = parseRels(wb.parts, relsPathOf(drawingPath));
  const doc = parseXml(dText);

  const anchors = [
    ...descendants(doc, 'twoCellAnchor').map((el) => ({ el, two: true })),
    ...descendants(doc, 'oneCellAnchor').map((el) => ({ el, two: false })),
  ];
  for (const { el, two } of anchors) {
    const pic = descendants(el, 'pic')[0];
    if (!pic) continue;
    const blip = descendants(pic, 'blip')[0];
    const rid = blip ? attr(blip, 'r:embed', 'embed') : null;
    const rel = rid ? dRels.get(rid) : null;
    if (!rel) continue;
    const mediaPath = resolveTarget(drawingPath, rel.target);
    const bytes = partBytes(wb.parts, mediaPath);
    if (!bytes) continue;
    const from = readAnchorPoint(firstChild(el, 'from'));
    if (!from) continue;
    const img = {
      kind: 'floating',
      row: from.row,
      col: from.col,
      offsetXPx: Math.round(from.colOff / EMU_PER_PX),
      offsetYPx: Math.round(from.rowOff / EMU_PER_PX),
      mime: mimeOf(mediaPath),
      dataUrl: bytesToDataUrl(bytes, mimeOf(mediaPath)),
      naturalWidthPx: 0,
      naturalHeightPx: 0,
    };
    if (two) {
      const to = readAnchorPoint(firstChild(el, 'to'));
      if (to) {
        img.endRow = to.row;
        img.endCol = to.col;
        img.endOffsetXPx = Math.round(to.colOff / EMU_PER_PX);
        img.endOffsetYPx = Math.round(to.rowOff / EMU_PER_PX);
      }
    } else {
      const ext = firstChild(el, 'ext');
      if (ext) {
        img.naturalWidthPx = Math.round(parseInt(ext.getAttribute('cx') || '0', 10) / EMU_PER_PX);
        img.naturalHeightPx = Math.round(parseInt(ext.getAttribute('cy') || '0', 10) / EMU_PER_PX);
      }
    }
    out.push(img);
  }
  return out;
}

function readAnchorPoint(el) {
  if (!el) return null;
  const get = (name) => {
    const n = firstChild(el, name);
    return n ? parseInt(textOf(n), 10) || 0 : 0;
  };
  return { col: get('col'), row: get('row'), colOff: get('colOff'), rowOff: get('rowOff') };
}
