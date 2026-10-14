// 导出图片标准化（包 12）：把「只认 WPS」的单元格图（xl/cellimages.xml
// + DISPIMG 公式）从导出副本里换成所有看图软件都认的标准浮动图
// （xl/drawings + oneCellAnchor）。应用内的原件永远不动，这里只改
// 即将写出的那一份 parts。
//
// 几何与应用内屏幕呈现一致：单元格图贴满锚点格；浮动图按 left/top
// 反推锚点格 + 格内偏移，尺寸用图自身的像素宽高。媒体按内容去重：
// 原件里已有相同字节的 media 直接复用，不重复塞大图。
import { partText, partBytes } from './zip.js';
import { parseXml, serializeXml, createEl, children, firstChild, descendants, textOf } from './xml.js';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const EMU_PER_PX = 9525;
const encoder = new TextEncoder();

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';

/* ---------- 小工具 ---------- */

function fnvBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'k' + bytes.length + '-' + h.toString(16);
}

function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return 'image/png';
}

const EXT_OF_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp',
};

function dataUrlBytes(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,([\s\S]*)$/i.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1] || 'image/png';
  if (m[2]) {
    let bin;
    try { bin = atob(m[3]); } catch (e) { return null; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
}

function relsPathOf(partPath) {
  const i = partPath.lastIndexOf('/');
  return partPath.slice(0, i + 1) + '_rels/' + partPath.slice(i + 1) + '.rels';
}

function resolveTarget(fromPartPath, target) {
  if (target.startsWith('/')) return target.slice(1);
  const dir = fromPartPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') dir.pop();
    else if (seg !== '.' && seg !== '') dir.push(seg);
  }
  return dir.join('/');
}

function relTargetFrom(fromPartPath, toPath) {
  const dir = fromPartPath.split('/').slice(0, -1);
  const to = toPath.split('/');
  let k = 0;
  while (k < dir.length && k < to.length && dir[k] === to[k]) k++;
  return [...Array(dir.length - k).fill('..'), ...to.slice(k)].join('/');
}

function readRels(parts, path) {
  const text = partText(parts, path);
  if (!text) return null;
  const doc = parseXml(text);
  const root = doc.documentElement;
  return {
    root,
    items: children(root, 'Relationship').map((el) => ({
      id: el.getAttribute('Id'), type: el.getAttribute('Type'),
      target: el.getAttribute('Target'), el,
    })),
  };
}

function addRel(parts, path, type, target) {
  let doc, root;
  const text = partText(parts, path);
  if (text) {
    doc = parseXml(text);
    root = doc.documentElement;
  } else {
    doc = parseXml(XML_DECL + '<Relationships xmlns="' + REL_NS + '"></Relationships>');
    root = doc.documentElement;
  }
  let max = 0;
  for (const el of children(root, 'Relationship')) {
    const m = /^rId(\d+)$/.exec(el.getAttribute('Id') || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  const id = 'rId' + (max + 1);
  const el = createEl(doc, 'Relationship');
  el.setAttribute('Id', id);
  el.setAttribute('Type', type);
  el.setAttribute('Target', target);
  root.appendChild(el);
  parts.set(path, encoder.encode(XML_DECL + serializeXml(doc)));
  return id;
}

function editContentTypes(parts, fn) {
  const text = partText(parts, '[Content_Types].xml');
  if (!text) return;
  const doc = parseXml(text);
  fn(doc, doc.documentElement);
  parts.set('[Content_Types].xml', encoder.encode(XML_DECL + serializeXml(doc)));
}

/* ---------- 摆位收集 ---------- */

function resolveImageBytes(img, imageBytes) {
  if (imageBytes && img.fileId && imageBytes[img.fileId]) {
    const b = imageBytes[img.fileId];
    const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
    return { bytes, mime: sniffMime(bytes) };
  }
  if (img.src && typeof img.src === 'string' && img.src.startsWith('data:')) {
    return dataUrlBytes(img.src);
  }
  return null;
}

/**
 * 文档规范表（FortuneSheet 形态）的图片 → 导出摆位：
 * [{ col, row, colOffPx, rowOffPx, cxPx, cyPx, bytes, mime, key }]
 * 单元格图贴锚点格（偏移 0、尺寸 = 图上已拟合好的宽高）；浮动图把
 * left/top 按文档自身行列几何反推回锚点格 + 格内偏移。
 * 拿不到字节的图片（src 不是 dataURL 又没给 imageBytes）跳过。
 */
export function collectPlacements(sheet, imageBytes) {
  const imgs = (sheet && sheet.images) || [];
  if (!imgs.length) return [];
  const columnlen = (sheet.config && sheet.config.columnlen) || {};
  const rowlen = (sheet.config && sheet.config.rowlen) || {};
  const dw = sheet.defaultColWidth || 73;
  const dh = sheet.defaultRowHeight || 19;
  const colW = (c) => (columnlen[c] != null ? columnlen[c] : dw);
  const rowH = (r) => (rowlen[r] != null ? rowlen[r] : dh);
  const CAP = 4096;
  const colPre = [0];
  for (let c = 0; c < CAP; c++) colPre.push(colPre[c] + colW(c));
  const rowPre = [0];
  for (let r = 0; r < CAP; r++) rowPre.push(rowPre[r] + rowH(r));
  const findCell = (pre, pos) => {
    let i = 0;
    while (i < CAP && pre[i + 1] <= pos) i++;
    return i;
  };
  const out = [];
  for (const img of imgs) {
    const got = resolveImageBytes(img, imageBytes);
    if (!got) continue;
    const base = { bytes: got.bytes, mime: got.mime, key: fnvBytes(got.bytes) };
    if (img.kind === 'cell' || img.left === undefined || img.left === null) {
      const c = img.anchorCol || 0;
      const r = img.anchorRow || 0;
      out.push({
        ...base, col: c, row: r, colOffPx: 0, rowOffPx: 0,
        cxPx: img.width || colW(c), cyPx: img.height || rowH(r),
      });
    } else {
      const left = img.left || 0;
      const top = img.top || 0;
      const c = findCell(colPre, left);
      const r = findCell(rowPre, top);
      out.push({
        ...base, col: c, row: r,
        colOffPx: left - colPre[c], rowOffPx: top - rowPre[r],
        cxPx: img.width || colW(c), cyPx: img.height || rowH(r),
      });
    }
  }
  return out;
}

/**
 * 生成型导出（普通版）的摆位：表上带了 exportImages（已是输出行列）
 * 就用它；否则与 collectPlacements 相同（整表原样生成的降级路径）。
 */
export function collectExportPlacements(sheet, imageBytes) {
  if (sheet && Array.isArray(sheet.exportImages) && sheet.exportImages.length) {
    const out = [];
    for (const e of sheet.exportImages) {
      const got = resolveImageBytes(e, imageBytes);
      if (!got) continue;
      out.push({
        col: e.col, row: e.row, colOffPx: 0, rowOffPx: 0,
        cxPx: e.widthPx || 100, cyPx: e.heightPx || 20,
        bytes: got.bytes, mime: got.mime, key: fnvBytes(got.bytes),
      });
    }
    return out;
  }
  return collectPlacements(sheet, imageBytes);
}

/* ---------- parts 变换 ---------- */

function anchorXml(pl, id, rid, seq) {
  const cx = Math.max(1, Math.round(pl.cxPx * EMU_PER_PX));
  const cy = Math.max(1, Math.round(pl.cyPx * EMU_PER_PX));
  return '<xdr:oneCellAnchor>' +
    '<xdr:from><xdr:col>' + pl.col + '</xdr:col>' +
    '<xdr:colOff>' + Math.round((pl.colOffPx || 0) * EMU_PER_PX) + '</xdr:colOff>' +
    '<xdr:row>' + pl.row + '</xdr:row>' +
    '<xdr:rowOff>' + Math.round((pl.rowOffPx || 0) * EMU_PER_PX) + '</xdr:rowOff></xdr:from>' +
    '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>' +
    '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + id + '" name="图片 ' + seq + '"/>' +
    '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
    '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
    '<xdr:clientData/></xdr:oneCellAnchor>';
}

/** 去掉各工作表里的 DISPIMG 公式格的公式与缓存值（图改由 drawing 承载） */
function stripDispimg(parts) {
  for (const path of [...parts.keys()]) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue;
    const text = partText(parts, path);
    if (!text || !text.includes('DISPIMG')) continue;
    const doc = parseXml(text);
    let changed = false;
    for (const cEl of descendants(doc.documentElement, 'c')) {
      const f = firstChild(cEl, 'f');
      if (!f || !textOf(f).includes('DISPIMG')) continue;
      for (const tag of ['f', 'v', 'is']) {
        const n = firstChild(cEl, tag);
        if (n) cEl.removeChild(n);
      }
      cEl.removeAttribute('t');
      changed = true;
    }
    if (changed) parts.set(path, encoder.encode(XML_DECL + serializeXml(doc)));
  }
}

/** 目标工作表是否已挂 drawing 引用（决定要不要走一次 imagify 清理） */
export function hasSheetDrawing(parts, targetSheetPath) {
  const rels = readRels(parts, relsPathOf(targetSheetPath));
  if (rels && rels.items.some((it) => (it.type || '').endsWith('/drawing'))) return true;
  const text = partText(parts, targetSheetPath);
  if (!text) return false;
  return /<drawing[\s/>]/.test(text);
}

/**
 * 清掉目标工作表原有 drawing 里的图片锚点（BUG H3 修复）。
 * 只删「含 xdr:pic 的锚点」——图表/形状等非图片锚点原样保留，避免连带
 * 丢内容。若某个 drawing 清空到没有任何锚点，就把整个 drawing 部件、
 * 它的关系、内容类型登记以及工作表上的 <drawing> 引用一并摘掉，
 * 不留空壳（Excel 对空 wsDr 能读，但留着没用还占体积）。
 * 返回一共删掉几个图片锚点。原件字节不动，这里只改即将写出的 parts。
 */
function clearSheetDrawings(parts, targetSheetPath) {
  const sheetRelsPath = relsPathOf(targetSheetPath);
  const sheetRels = readRels(parts, sheetRelsPath);
  if (!sheetRels) return 0;
  const drawingRels = sheetRels.items.filter((it) => (it.type || '').endsWith('/drawing'));
  if (!drawingRels.length) return 0;
  let removedAnchors = 0;
  const deadRids = [];
  for (const rel of drawingRels) {
    const drawingPath = resolveTarget(targetSheetPath, rel.target);
    const text = partText(parts, drawingPath);
    if (!text) continue;
    const doc = parseXml(text);
    const root = doc.documentElement;
    let changed = false;
    const kids = [];
    for (let i = 0; i < root.childNodes.length; i++) kids.push(root.childNodes[i]);
    for (const anchor of kids) {
      if (anchor.nodeType !== 1) continue;
      const ln = localNameOf(anchor);
      if (!/Anchor$/.test(ln)) continue;
      if (!descendants(anchor, 'pic').length) continue; // 非图片锚点（图表等）不动
      root.removeChild(anchor);
      removedAnchors += 1;
      changed = true;
    }
    if (!changed) continue;
    if (children(root, 'oneCellAnchor').length + children(root, 'twoCellAnchor').length +
        children(root, 'absoluteAnchor').length === 0) {
      // 清空了的 drawing：整件摘掉
      parts.delete(drawingPath);
      parts.delete(relsPathOf(drawingPath));
      editContentTypes(parts, (ctDoc, ctRoot) => {
        for (const el of children(ctRoot, 'Override')) {
          if ((el.getAttribute('PartName') || '') === '/' + drawingPath) ctRoot.removeChild(el);
        }
      });
      deadRids.push(rel.id);
      removeRel(parts, sheetRelsPath, rel.id);
    } else {
      parts.set(drawingPath, encoder.encode(XML_DECL + serializeXml(doc)));
    }
  }
  if (deadRids.length) {
    const sText = partText(parts, targetSheetPath);
    if (sText) {
      const sDoc = parseXml(sText);
      const root = sDoc.documentElement;
      let changed = false;
      for (const el of children(root, 'drawing')) {
        const rid = el.getAttribute('r:id') || el.getAttribute('id');
        if (deadRids.includes(rid)) { root.removeChild(el); changed = true; }
      }
      if (changed) parts.set(targetSheetPath, encoder.encode(XML_DECL + serializeXml(sDoc)));
    }
  }
  return removedAnchors;
}

/** 从 .rels 部件里摘掉一条关系（没有该部件就什么都不做） */
function removeRel(parts, relsPath, id) {
  const text = partText(parts, relsPath);
  if (!text) return;
  const doc = parseXml(text);
  const root = doc.documentElement;
  let changed = false;
  for (const el of children(root, 'Relationship')) {
    if (el.getAttribute('Id') === id) { root.removeChild(el); changed = true; }
  }
  if (changed) parts.set(relsPath, encoder.encode(XML_DECL + serializeXml(doc)));
}

function localNameOf(node) {
  return node.localName || (node.nodeName || '').split(':').pop();
}

/**
 * 把 parts 里的 WPS 单元格图体系换成标准 drawing（原地改 parts）：
 * 删 cellimages 部件/关系/内容类型登记，剥 DISPIMG 公式，再按
 * placements 给 targetSheetPath 挂 drawing（已有 drawing 就并入）。
 * 原表的图片锚点会被清掉再由 placements 重建（BUG H3：不清就重复）。
 * placements 为空时只做剥离与清理（图全被用户删光的单也要清干净）。
 */
export function imagifyParts(parts, targetSheetPath, placements) {
  parts.delete('xl/cellimages.xml');
  parts.delete('xl/_rels/cellimages.xml.rels');
  editContentTypes(parts, (doc, root) => {
    for (const el of children(root, 'Override')) {
      if ((el.getAttribute('PartName') || '').includes('cellimages')) root.removeChild(el);
    }
  });
  const wbRelsPath = 'xl/_rels/workbook.xml.rels';
  {
    const text = partText(parts, wbRelsPath);
    if (text) {
      const doc = parseXml(text);
      const root = doc.documentElement;
      let changed = false;
      for (const el of children(root, 'Relationship')) {
        if ((el.getAttribute('Target') || '').includes('cellimages')) {
          root.removeChild(el);
          changed = true;
        }
      }
      if (changed) parts.set(wbRelsPath, encoder.encode(XML_DECL + serializeXml(doc)));
    }
  }
  stripDispimg(parts);
  // 目标表原有的浮动图锚点一律清掉（BUG H3 修复）：导出的图完全由
  // placements 决定。旧实现保留原件锚点、再把新锚点追加进去，于是
  // Excel 标准浮动图在导出件里出现两份（原件一份 + 工作层重贴一份）；
  // 用户删掉的图也删不掉（placements 为空时旧实现直接 return，
  // 锚点原样留着）。原件字节不动，这里只改即将写出的副本。
  const removed = clearSheetDrawings(parts, targetSheetPath);
  const hasPlacements = !!(placements && placements.length);
  if (!hasPlacements && !removed) return;

  // 媒体：按内容复用原件已有的 media，新图另起不撞名的部件
  const mediaByKey = new Map();
  for (const k of parts.keys()) {
    if (/^xl\/media\//.test(k)) mediaByKey.set(fnvBytes(partBytes(parts, k)), k);
  }
  let mediaSeq = 0;
  const usedMedia = new Map();
  placements.forEach((pl, i) => {
    let path = mediaByKey.get(pl.key);
    if (!path) {
      const ext = EXT_OF_MIME[pl.mime] || 'png';
      do {
        mediaSeq += 1;
        path = 'xl/media/qimg' + mediaSeq + '.' + ext;
      } while (parts.has(path));
      parts.set(path, pl.bytes);
      mediaByKey.set(pl.key, path);
    }
    usedMedia.set(i, path);
  });
  const CT_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  };
  editContentTypes(parts, (doc, root) => {
    const have = new Set(children(root, 'Default')
      .map((el) => (el.getAttribute('Extension') || '').toLowerCase()));
    for (const p of new Set(usedMedia.values())) {
      const ext = p.split('.').pop().toLowerCase();
      if (!have.has(ext) && CT_BY_EXT[ext]) {
        const el = createEl(doc, 'Default');
        el.setAttribute('Extension', ext);
        el.setAttribute('ContentType', CT_BY_EXT[ext]);
        root.appendChild(el);
        have.add(ext);
      }
    }
  });

  // 目标表的 drawing 部件（已有就并入，没有就新建并登记关系）
  const sheetRelsPath = relsPathOf(targetSheetPath);
  const sheetRels = readRels(parts, sheetRelsPath);
  let drawingPath = null;
  let drawingRid = null;
  if (sheetRels) {
    const dr = sheetRels.items.find((it) => (it.type || '').endsWith('/drawing'));
    if (dr) {
      drawingRid = dr.id;
      drawingPath = resolveTarget(targetSheetPath, dr.target);
    }
  }
  if (!drawingPath) {
    let n = 0;
    do {
      n += 1;
      drawingPath = 'xl/drawings/drawing' + n + '.xml';
    } while (parts.has(drawingPath));
    drawingRid = addRel(parts, sheetRelsPath, REL_DRAWING,
      relTargetFrom(targetSheetPath, drawingPath));
    editContentTypes(parts, (doc, root) => {
      const el = createEl(doc, 'Override');
      el.setAttribute('PartName', '/' + drawingPath);
      el.setAttribute('ContentType',
        'application/vnd.openxmlformats-officedocument.drawing+xml');
      root.appendChild(el);
    });
  }
  const dRelsPath = relsPathOf(drawingPath);
  const dRels = readRels(parts, dRelsPath);
  const ridByMedia = new Map();
  if (dRels) {
    for (const it of dRels.items) {
      if ((it.type || '').endsWith('/image')) {
        ridByMedia.set(resolveTarget(drawingPath, it.target), it.id);
      }
    }
  }
  for (const path of new Set(usedMedia.values())) {
    if (!ridByMedia.has(path)) {
      ridByMedia.set(path, addRel(parts, dRelsPath, REL_IMAGE,
        relTargetFrom(drawingPath, path)));
    }
  }

  const existing = partText(parts, drawingPath);
  let nextId = 2;
  if (existing) {
    const re = /<xdr:cNvPr[^>]*?id="(\d+)"/g;
    let mm;
    while ((mm = re.exec(existing))) nextId = Math.max(nextId, Number(mm[1]) + 1);
  }
  let anchorsXml = '';
  placements.forEach((pl, i) => {
    anchorsXml += anchorXml(pl, nextId++, ridByMedia.get(usedMedia.get(i)), i + 1);
  });
  if (existing) {
    const idx = existing.lastIndexOf('</xdr:wsDr>');
    parts.set(drawingPath, encoder.encode(idx >= 0
      ? existing.slice(0, idx) + anchorsXml + existing.slice(idx)
      : existing + anchorsXml));
  } else {
    parts.set(drawingPath, encoder.encode(XML_DECL +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      anchorsXml + '</xdr:wsDr>'));
  }

  // 目标表里挂 <drawing r:id>（位置按工作表子元素法定顺序：
  // 在 legacyDrawing/picture/tableParts/extLst 之前，其余情形追加末尾）
  const sText = partText(parts, targetSheetPath);
  if (!sText) return;
  const sDoc = parseXml(sText);
  const root = sDoc.documentElement;
  let has = false;
  for (const el of children(root, 'drawing')) {
    if ((el.getAttribute('r:id') || el.getAttribute('id')) === drawingRid) has = true;
  }
  if (has) return;
  if (!root.getAttribute('xmlns:r')) {
    root.setAttribute('xmlns:r',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships');
  }
  const dEl = createEl(sDoc, 'drawing');
  dEl.setAttribute('r:id', drawingRid);
  const AFTER = ['legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects',
    'controls', 'webPublishItems', 'tableParts', 'extLst'];
  let before = null;
  for (let i = 0; i < root.childNodes.length; i++) {
    const n = root.childNodes[i];
    if (n.nodeType === 1 && AFTER.includes(n.localName || n.nodeName)) {
      before = n;
      break;
    }
  }
  if (before) root.insertBefore(dEl, before);
  else root.appendChild(dEl);
  parts.set(targetSheetPath, encoder.encode(XML_DECL + serializeXml(sDoc)));
}
