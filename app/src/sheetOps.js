// 对规范格式工作表（{ celldata, row, column, ... }，即存档/加载边界上的
// 形状）的纯操作：读格、判表头行、追加列、写格。全部返回新对象，
// 不原地改入参——调用方用新对象替换 liveRef 后整体重挂组件。
// 表头行不靠猜列名：取前若干行里"文字格最多"的一行为表头行
//（标题行通常只有一格合并文字，表头行整行都是列名）。

/** 列序号 → 列字母（0→A、26→AA） */
export function colLetter(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 读一格现值（v.v 优先，其次 v.m）；没有这格返回 null */
export function cellValue(sheet, r, c) {
  if (!sheet || !Array.isArray(sheet.celldata)) return null;
  const cell = sheet.celldata.find((x) => x.r === r && x.c === c);
  if (!cell || !cell.v) return null;
  return cell.v.v !== undefined && cell.v.v !== null ? cell.v.v : (cell.v.m ?? null);
}

/** 判定表头行：前 10 行里非空文字格最多的一行（并列取靠前者）；全空返回 0 */
export function detectHeaderRow(sheet) {
  const limit = Math.min(10, (sheet && sheet.row) || 0);
  const counts = new Map();
  for (const cell of (sheet && sheet.celldata) || []) {
    if (cell.r >= limit || !cell.v) continue;
    const val = cell.v.v !== undefined && cell.v.v !== null ? cell.v.v : cell.v.m;
    if (typeof val === 'string' && val.trim() !== '') {
      counts.set(cell.r, (counts.get(cell.r) || 0) + 1);
    }
  }
  let best = 0, bestN = 0;
  for (const [r, n] of counts) {
    if (n > bestN || (n === bestN && r < best)) { best = r; bestN = n; }
  }
  return best;
}

/**
 * 当前列头清单（定价条选成本列用）：[{ col, text, label }]。
 * label 是给人看的：有表头文字用文字；同名列并存时加列字母区分；
 * 无表头的列显示为（X列）。
 */
export function columnHeaders(sheet) {
  const headerRow = detectHeaderRow(sheet);
  const n = (sheet && sheet.column) || 0;
  const seen = new Map();
  const out = [];
  for (let c = 0; c < n; c++) {
    const raw = cellValue(sheet, headerRow, c);
    const text = typeof raw === 'string' ? raw.trim() : (raw === null || raw === undefined ? '' : String(raw));
    const dup = text !== '' && seen.has(text);
    out.push({
      col: c,
      text,
      label: text === '' ? '（' + colLetter(c) + '列）' : (dup ? text + '（' + colLetter(c) + '列）' : text),
    });
    if (text !== '') seen.set(text, c);
  }
  return out;
}

/** 数量列表头名（转订单带入数量用）：客户表里写数量的那一列就这几个叫法 */
export const QTY_HEADER_NAMES = ['需求数', '数量', '订购数', '订货数', '件数'];

/**
 * 在表头行里找数量列：表头文字（去空白后）与 QTY_HEADER_NAMES 精确
 * 相等才算——行身份/列身份不靠猜（底线 3），"需求数量"这类近似名
 * 不认。返回 { col, header }，没有返回 null。
 */
export function findQtyColumn(sheet, headerRow) {
  if (!sheet) return null;
  const hr = typeof headerRow === 'number' ? headerRow : detectHeaderRow(sheet);
  for (let c = 0; c < (sheet.column || 0); c++) {
    const raw = cellValue(sheet, hr, c);
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (QTY_HEADER_NAMES.includes(t)) return { col: c, header: t };
  }
  return null;
}

/**
 * 写一格：cellV = { v, m } 写值；cellV = null 清空（删掉该格条目）。
 * 返回新 sheet（celldata 数组与被改的条目都是新对象）。
 */
export function setCellValue(sheet, r, c, cellV) {
  const celldata = [];
  let found = false;
  for (const cell of sheet.celldata || []) {
    if (cell.r === r && cell.c === c) {
      found = true;
      if (cellV !== null) celldata.push({ r, c, v: { ...(cell.v || {}), v: cellV.v, m: cellV.m } });
      // cellV === null → 不推入 = 清空
    } else {
      celldata.push(cell);
    }
  }
  if (!found && cellV !== null) celldata.push({ r, c, v: { v: cellV.v, m: cellV.m } });
  return { ...sheet, celldata };
}

/** 在最右侧追加一列并在表头行写上列名；返回 { sheet, col } */
export function appendColumn(sheet, headerRow, name) {
  const col = sheet.column || 0;
  const next = { ...sheet, column: col + 1 };
  return { sheet: setCellValue(next, headerRow, col, { v: name, m: name }), col };
}
