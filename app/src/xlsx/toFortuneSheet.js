// 解析结果 → FortuneSheet 数据模型。
// 图片锚定方式（已核对 FortuneSheet 源码里 insertImage 的算法）：
// Image = { id, src, left, top, width, height }，left/top 是相对单元格
// 区域原点（A1 左上角）的像素偏移——即锚点格之前所有列宽/行高之和。
// WPS 单元格图按 WPS 的呈现方式贴满锚点格；浮动图按原锚点与尺寸摆。

export function sheetToFortune(parsed, sheetIndex = 0) {
  const widthOf = (c) =>
    parsed.columnWidthsPx[c] != null ? parsed.columnWidthsPx[c] : parsed.defaultColWidthPx;
  const heightOf = (r) =>
    parsed.rowHeightsPx[r] != null ? parsed.rowHeightsPx[r] : parsed.defaultRowHeightPx;

  // 前缀和：leftOf(c) = 第 c 列左边缘的 x；topOf(r) = 第 r 行上边缘的 y
  const maxC = Math.max(parsed.colCount, ...parsed.images.map((i) => (i.endCol ?? i.col) + 1), 0);
  const maxR = Math.max(parsed.rowCount, ...parsed.images.map((i) => (i.endRow ?? i.row) + 1), 0);
  const colPrefix = [0];
  for (let c = 0; c < maxC; c++) colPrefix.push(colPrefix[c] + widthOf(c));
  const rowPrefix = [0];
  for (let r = 0; r < maxR; r++) rowPrefix.push(rowPrefix[r] + heightOf(r));
  const leftOf = (c) => colPrefix[c] ?? colPrefix[colPrefix.length - 1];
  const topOf = (r) => rowPrefix[r] ?? rowPrefix[rowPrefix.length - 1];

  const celldata = [];
  for (const cell of parsed.cells) {
    const v = {};
    if (cell.value !== null && cell.value !== undefined) {
      v.v = cell.value;
      v.m = String(cell.value);
    }
    if (cell.formula) v.f = '=' + cell.formula;
    celldata.push({ r: cell.r, c: cell.c, v });
  }

  const merge = {};
  for (const m of parsed.merges) {
    merge[m.r + '_' + m.c] = { r: m.r, c: m.c, rs: m.rs, cs: m.cs };
  }
  const columnlen = {};
  for (const [c, px] of Object.entries(parsed.columnWidthsPx)) columnlen[c] = px;
  const rowlen = {};
  for (const [r, px] of Object.entries(parsed.rowHeightsPx)) rowlen[r] = px;

  const images = parsed.images.map((img, i) => {
    const base = {
      id: 'img-' + sheetIndex + '-' + i,
      src: img.dataUrl,
      anchorRow: img.row,
      anchorCol: img.col,
      kind: img.kind,
      // 文件仓库引用（导入流程在解析后按字节内容算出并回填到 parsed 图片上）：
      // 恢复时按 fileId 去 IndexedDB 取字节重新点亮 src；byteSize 是字节数。
      fileId: img.fileId || null,
      byteSize: img.byteSize || 0,
    };
    if (img.kind === 'cell') {
      // 单元格图：贴满锚点格（与 WPS 呈现一致）
      return {
        ...base,
        left: leftOf(img.col),
        top: topOf(img.row),
        width: Math.max(1, widthOf(img.col)),
        height: Math.max(1, heightOf(img.row)),
      };
    }
    // 浮动图：原锚点 + 偏移；有终点锚点则按起讫几何算尺寸，否则用自然尺寸
    const left = leftOf(img.col) + (img.offsetXPx || 0);
    const top = topOf(img.row) + (img.offsetYPx || 0);
    let width = img.naturalWidthPx || 0;
    let height = img.naturalHeightPx || 0;
    if (img.endCol != null) width = leftOf(img.endCol) + (img.endOffsetXPx || 0) - left;
    if (img.endRow != null) height = topOf(img.endRow) + (img.endOffsetYPx || 0) - top;
    return {
      ...base,
      left,
      top,
      width: Math.max(1, width || widthOf(img.col)),
      height: Math.max(1, height || heightOf(img.row)),
    };
  });

  return {
    name: parsed.name,
    id: 'sheet-' + sheetIndex,
    row: Math.max(parsed.rowCount, 1),
    column: Math.max(parsed.colCount, 1),
    celldata,
    config: { merge, columnlen, rowlen },
    images,
    defaultColWidth: parsed.defaultColWidthPx,
    defaultRowHeight: parsed.defaultRowHeightPx,
  };
}
