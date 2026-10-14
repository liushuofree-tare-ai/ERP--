// 图片对齐（包 10）：组件（FortuneSheet）与规范数据之间的图片和解。
//
// 实测事实（包 10 复现，真实文件 + 宽屏 2560）：
//  1. 用户用工具栏插入图片时，组件发出的回声里新图带自然尺寸
//     （如 768×1024），left/top 是当时活动格的左上角——图是"浮"在
//     表格上的，不在格子里。必须由我们按活动格把它贴进格子（fit）。
//  2. 用户在组件里删图（点选 + Delete），删除是否反映到回声里取决
//     于当时的键盘焦点路径，不可靠；而在规范数据完成对齐保存之前，
//     任何一次重挂（算价/加列/切文档）都会把删掉的图按规范数据画
//     回来（复活）——用户的原始反馈正是这一幕。唯一始终可信的是
//     画面本身（DOM 里的图框清单）。所以：
//       - 回声路径（onChange）：只增不删——新图贴格登记，老图合并
//         几何（拖动/缩放靠它落盘）；回声缺席永不解读为删除。
//       - 画面路径（冻结打印前：保存/切文档/切视图/程序化改表）：
//         以画面图框为准做增删——画面里没有的图，规范数据里删掉。
//  3. 组件回声会保留我们给导入图附加的字段（fileId/kind/锚点），
//     但合并时仍以规范侧为准兜底，防组件把引用弄丢。
//
// 本文件全部是纯函数（画面清单由调用方从 DOM 读好传入），可单测。

const FALLBACK_COL_W = 73;   // 与 FortuneSheet 默认列宽一致（无几何信息时兜底）
const FALLBACK_ROW_H = 19;   // 与 FortuneSheet 默认行高一致
const NO_CELL_FIT_W = 102;   // 定位不到活动格时的封顶宽度（约等于真实表的图片列宽）

/** 表格几何：列宽/行高与前缀和（与 xlsx/toFortuneSheet.js 同一算法） */
export function sheetGeometry(sheet) {
  const cfg = (sheet && sheet.config) || {};
  const columnlen = cfg.columnlen || {};
  const rowlen = cfg.rowlen || {};
  const defW = sheet && sheet.defaultColWidth != null ? sheet.defaultColWidth : FALLBACK_COL_W;
  const defH = sheet && sheet.defaultRowHeight != null ? sheet.defaultRowHeight : FALLBACK_ROW_H;
  const widthOf = (c) => {
    const v = columnlen[c] != null ? columnlen[c] : columnlen[String(c)];
    return v != null ? v : defW;
  };
  const heightOf = (r) => {
    const v = rowlen[r] != null ? rowlen[r] : rowlen[String(r)];
    return v != null ? v : defH;
  };
  const leftOf = (c) => {
    let x = 0;
    for (let i = 0; i < c; i++) x += widthOf(i);
    return x;
  };
  const topOf = (r) => {
    let y = 0;
    for (let i = 0; i < r; i++) y += heightOf(i);
    return y;
  };
  return { widthOf, heightOf, leftOf, topOf };
}

/**
 * 由像素点反推所在格：取左上角不超过该点的最靠后一行/一列
 * （插入回声的 left/top 正好是活动格左上角，容差 1px）。
 * rowCount/colCount 决定上限；给不出（坐标为负等）返回 null。
 */
export function cellAtPoint(geo, left, top, rowCount, colCount) {
  if (!geo || !Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0) return null;
  let c = 0;
  const maxC = Math.max(1, colCount || 1);
  while (c + 1 < maxC && geo.leftOf(c + 1) <= left + 1) c += 1;
  if (geo.leftOf(c) > left + 1) return null;
  let r = 0;
  const maxR = Math.max(1, rowCount || 1);
  while (r + 1 < maxR && geo.topOf(r + 1) <= top + 1) r += 1;
  if (geo.topOf(r) > top + 1) return null;
  return { r, c };
}

/** 把一张图贴进指定格：几何 = 格的矩形，kind=cell，锚点 = 该格 */
export function fitImageToCell(sheet, img, r, c) {
  const geo = sheetGeometry(sheet);
  return {
    ...img,
    left: geo.leftOf(c),
    top: geo.topOf(r),
    width: Math.max(1, geo.widthOf(c)),
    height: Math.max(1, geo.heightOf(r)),
    anchorRow: r,
    anchorCol: c,
    kind: 'cell',
  };
}

/**
 * 定位不到格子时的兜底贴法：宽封顶 NO_CELL_FIT_W、高按原比例，
 * 锚到第一格——永远不许以自然尺寸出现。
 */
export function capImageSize(sheet, img) {
  const ow = img.originWidth || img.width || 0;
  const oh = img.originHeight || img.height || 0;
  const width = NO_CELL_FIT_W;
  const height = ow > 0 && oh > 0
    ? Math.max(1, Math.round((width * oh) / ow))
    : NO_CELL_FIT_W;
  return {
    ...img,
    left: 0, top: 0, width, height,
    anchorRow: 0, anchorCol: 0, kind: 'cell',
  };
}

/** 新图登记：贴进它出现位置所在的格；定位不到就封顶兜底 */
function adoptNewImage(sheet, img) {
  const geo = sheetGeometry(sheet);
  const cell = cellAtPoint(geo, img.left, img.top, sheet && sheet.row, sheet && sheet.column);
  const fitted = cell
    ? fitImageToCell(sheet, img, cell.r, cell.c)
    : capImageSize(sheet, img);
  return { ...fitted, fileId: img.fileId || null, byteSize: img.byteSize || 0, userInserted: true };
}

/** 已知图的合并：几何/ src 听组件的；引用与口径字段以规范侧兜底不丢 */
function mergeKnownImage(prev, echo, protectedIds) {
  const merged = { ...prev, ...echo };
  // 组件侧没有的字段不许把规范侧冲掉
  if (echo.fileId == null) merged.fileId = prev.fileId || null;
  if (echo.byteSize == null) merged.byteSize = prev.byteSize || 0;
  if (echo.kind == null) merged.kind = prev.kind;
  if (echo.anchorRow == null) merged.anchorRow = prev.anchorRow;
  if (echo.anchorCol == null) merged.anchorCol = prev.anchorCol;
  if (!echo.src && prev.src) merged.src = prev.src;
  // 刚贴格的新图在重挂落地前，几何以规范侧为准（防组件的滞后回声把贴格冲掉）
  if (protectedIds && protectedIds.has(prev.id)) {
    merged.left = prev.left;
    merged.top = prev.top;
    merged.width = prev.width;
    merged.height = prev.height;
  }
  return merged;
}

function sameImage(a, b) {
  return a === b || (a && b &&
    a.id === b.id && a.src === b.src &&
    a.left === b.left && a.top === b.top &&
    a.width === b.width && a.height === b.height &&
    (a.fileId || null) === (b.fileId || null) &&
    (a.kind || null) === (b.kind || null) &&
    (a.anchorRow ?? null) === (b.anchorRow ?? null) &&
    (a.anchorCol ?? null) === (b.anchorCol ?? null));
}

/**
 * 回声对齐（只增不删）：componentImages 是回声里的图片清单。
 * 返回 { images, added, changed }；added 是新登记的图（调用方负责
 * 把字节存进文件仓库并回填 fileId）。回声不是数组 → 原样返回。
 */
export function reconcileEchoImages(canonicalImages, echoImages, sheet, protectedIds) {
  const canonical = canonicalImages || [];
  if (!Array.isArray(echoImages)) return { images: canonical, added: [], changed: false };
  const byId = new Map(canonical.map((img) => [img.id, img]));
  const seen = new Set();
  const added = [];
  const out = [];
  for (const eimg of echoImages) {
    if (!eimg || eimg.id == null) continue;
    seen.add(eimg.id);
    const prev = byId.get(eimg.id);
    if (prev) {
      out.push(mergeKnownImage(prev, eimg, protectedIds));
    } else {
      const fitted = adoptNewImage(sheet, eimg);
      added.push(fitted);
      out.push(fitted);
    }
  }
  // 回声里没出现的规范图一律保留（删除不靠回声判定，见文件头）
  for (const img of canonical) {
    if (!seen.has(img.id)) out.push(img);
  }
  const changed = added.length > 0 ||
    out.length !== canonical.length ||
    out.some((img, i) => !sameImage(img, canonical[i])) ||
    canonical.some((img, i) => !sameImage(img, out[i]));
  return { images: out, added, changed };
}

/**
 * 画面对齐（增删都算数）：domImages 是画面上真实存在的图框清单
 * [{ id, left, top, width, height, src? }]（几何已换算回数据坐标）。
 * domImages === null 表示表格没挂载（在看别的视图）——不动规范数据。
 * opts.protectUnidentifiedActive：画面上有"活动图"框但认不出是哪张时，
 * 传 true 表示这次只更新几何、不删任何图（宁可留着，不可误删）。
 * 返回 { images, added, removedIds, changed }。
 */
export function reconcileDomImages(canonicalImages, domImages, sheet, opts = {}) {
  const canonical = canonicalImages || [];
  if (!Array.isArray(domImages)) return { images: canonical, added: [], removedIds: [], changed: false };
  const byId = new Map(canonical.map((img) => [img.id, img]));
  const seen = new Set();
  const added = [];
  const out = [];
  for (const dimg of domImages) {
    if (!dimg || dimg.id == null) continue;
    seen.add(dimg.id);
    const prev = byId.get(dimg.id);
    if (prev) {
      const protect = opts.protectedIds && opts.protectedIds.has(prev.id);
      out.push(protect ? prev : {
        ...prev,
        left: dimg.left, top: dimg.top, width: dimg.width, height: dimg.height,
        src: prev.src || dimg.src || '',
      });
    } else {
      // 画面上有、规范里没有（极少：回声漏掉的插入）——照画面登记并贴格
      const fitted = adoptNewImage(sheet, { ...dimg, src: dimg.src || '' });
      added.push(fitted);
      out.push(fitted);
    }
  }
  const removedIds = [];
  for (const img of canonical) {
    if (!seen.has(img.id)) {
      if (opts.protectUnidentifiedActive) {
        out.push(img); // 认不出的活动图在场：这次不删任何"缺席"的图
      } else {
        removedIds.push(img.id);
      }
    }
  }
  const changed = added.length > 0 || removedIds.length > 0 ||
    out.length !== canonical.length ||
    out.some((img, i) => !sameImage(img, canonical[i])) ||
    canonical.some((img, i) => !sameImage(img, out[i]));
  return { images: out, added, removedIds, changed };
}
