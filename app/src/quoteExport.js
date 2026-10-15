// 最终报价与对客导出（SPEC 第四节第 7 项 + 第二节底线 2「对客不泄漏」）。
//
// 钱的口径（第五节）：每个已定厂行按它自己的定厂快照算最终销售价——
//   成本 = 快照里的工厂原值（rawPrice）；
//   税步按快照的口径：含税跳过，不含税用快照里的税点（点选那一刻
//   该家标价列的税点；老存档的快照没有税点时，回退到该家当前标记）；
//   加价 / 每件运费 / 汇率用询价单的定价条参数（包 4，整表填一次）。
// 公式只在 pricing.js 里，这里只负责组装入参，绝不另算一套。
//
// 泄漏防线（结构性的，不是靠过滤）：两个导出构造器只读「询价单文档
// 本身 + 上面算出的最终价」——报价单文档（工厂原价、工厂名）根本不
// 作为入参进来，想泄漏也没有数据源。测试里另有断言兜底。
import { computeSalesPrice, parseCostValue, round2 } from './pricing.js';
import { cellValue, setCellValue, appendColumn, findQtyColumn } from './sheetOps.js';
import { lineIdAt } from './ledger.js';
import { headerRowOf, dataRowCount } from './compare.js';

export const FINAL_QUOTE_HEADER = '最终报价';

/** 「最终报价」列在哪：按表头行文字找；没有返回 null */
export function finalQuoteColOf(sheet, headerRow) {
  if (!sheet) return null;
  const hr = typeof headerRow === 'number' ? headerRow : 0;
  for (let c = 0; c < (sheet.column || 0); c++) {
    const t = cellValue(sheet, hr, c);
    if (typeof t === 'string' && t.trim() === FINAL_QUOTE_HEADER) return c;
  }
  return null;
}

/**
 * 一个定厂快照的税点：快照自带优先；老快照（包 6 时期存的）没有，
 * 回退到该家报价单现在的标价列税点；再没有就是 ''（pricing 按 0 处理）。
 */
export function resolveChoiceTaxRatePct(choice, quotes) {
  if (!choice) return '';
  if (choice.taxRatePct !== undefined && choice.taxRatePct !== null &&
      String(choice.taxRatePct).trim() !== '') {
    return choice.taxRatePct;
  }
  const q = (quotes || []).find((d) => d.factoryName === choice.factory);
  if (q && q.priceMark && q.priceMark.taxRatePct !== undefined &&
      q.priceMark.taxRatePct !== null) {
    return q.priceMark.taxRatePct;
  }
  return '';
}

/**
 * B4 来源判定（包 12，用户拍板）：一张报价单是否具备"最终价直接取
 * 它的销售价"的资格——定价条在这张单上生成过销售价列
 * （pricing.salesCol 有记录），且生成时的成本价列
 * （pricing.costCol）正是这张单被标记的报价列。两条都对上，说明
 * 这张单的销售价就是"这家的价 + 这家的定价参数"算出来的成品，
 * 最终价没理由再拿询价单的参数重算一遍（口径还可能不一样）。
 * 返回 { salesCol, costCol, salesHeader, costHeader, pricing } 或 null。
 */
export function salesSourceForQuote(quote) {
  if (!quote || !quote.sheet || !quote.priceMark) return null;
  const p = quote.pricing || {};
  if (typeof p.salesCol !== 'number' || typeof p.costCol !== 'number') return null;
  if (quote.priceMark.col !== p.costCol) return null;
  const hr = headerRowOf(quote);
  const headerAt = (c) => {
    const v = cellValue(quote.sheet, hr, c);
    return typeof v === 'string' ? v.trim() : '';
  };
  return {
    salesCol: p.salesCol,
    costCol: p.costCol,
    salesHeader: headerAt(p.salesCol) || '销售价',
    costHeader: headerAt(p.costCol) || ('第 ' + (p.costCol + 1) + ' 列'),
    pricing: p,
  };
}

/** lineId 在某张报价单上的物理行：询价行按位置对齐（与比价同一套）；工厂多报行查它自己的 factoryExtras */
export function quoteRowForLine(quote, inquiry, lineId) {
  for (const { lineId: lid, dataIndex } of inquiryDataRows(inquiry)) {
    if (lid === lineId) return headerRowOf(quote) + 1 + dataIndex;
  }
  const ex = (quote.factoryExtras || []).find((e) => e.lineId === lineId);
  return ex ? ex.row : null;
}

/**
 * B4 行的最终价（新鲜度规则，用户拍板）：以"现在的成本价单元格"
 * 按报价单自己的定价参数现算为准——与定价条生成销售价时同一条
 * 公式、同一组参数，所以没改过价时与销售价列分毫不差；成本价在
 * 生成销售价之后被改过，现算自动跟上新价，绝不拿陈旧的销售价
 * 冒充。
 *
 * 成本格读不出数（工厂撤价/清空）时返回 null（留空，不拿 0 冒充）。
 * BUG M4：旧实现在这里退回销售价列里现存的值——工厂把成本价撤了，
 * 客户却仍收到撤价前算出的旧卖价。撤价就是撤价，宁缺勿错；
 * 留空另有"未确认"的含义，比报一个已作废的价安全得多。
 */
export function salesSourceFinal(quote, src, quoteRow) {
  const p = src.pricing;
  return computeSalesPrice({
    cost: cellValue(quote.sheet, quoteRow, src.costCol),
    taxInclusive: !!p.taxInclusive,
    taxRatePct: p.taxRatePct,
    markupPct: p.markupPct,
    freightPerUnit: p.freight,
    fxRate: p.fxRate,
  });
}

/**
 * 全部已定厂行的最终销售价：Map<lineId, number|null>。
 * 只含 rowChoices 里有的行；价算不出来（原值不可用）时值为 null，
 * 调用方一律按"留空"处理（绝不用 0 冒充，底线/SPEC 第五节）。
 * 每行先查 B4（取定厂报价单自己的销售价，见 salesSourceForQuote），
 * 不合资格的行走标准口径：快照原值 + 快照税步 + 询价单定价参数。
 * 入参：{ inquiry: { pricing }, rowChoices, quotes }
 */
export function computeFinalPrices({ inquiry, rowChoices, quotes } = {}) {
  const out = new Map();
  const p = (inquiry && inquiry.pricing) || {};
  for (const [lineId, choice] of Object.entries(rowChoices || {})) {
    if (!choice) continue;
    const quote = (quotes || []).find((d) => d.factoryName === choice.factory);
    const src = quote && inquiry ? salesSourceForQuote(quote) : null;
    if (src) {
      const qRow = quoteRowForLine(quote, inquiry, lineId);
      if (qRow !== null) {
        out.set(lineId, salesSourceFinal(quote, src, qRow));
        continue;
      }
    }
    out.set(lineId, computeSalesPrice({
      cost: choice.rawPrice,
      taxInclusive: !!choice.taxInclusive,
      taxRatePct: resolveChoiceTaxRatePct(choice, quotes),
      markupPct: p.markupPct,
      freightPerUnit: p.freight,
      fxRate: p.fxRate,
    }));
  }
  return out;
}

/**
 * 询价单的数据行清单：[{ lineId, row（物理行）, dataIndex }]，按行序。
 * lineId 以账本为准；账本缺失时（示例单等没建账的文档）按位置兜底
 * 'L'+（行号+1)——与建账口径（物理行 r → L(r+1)）和比价行
 * （buildCompareRows）的兜底完全一致，保证"行数"在任何一处数出来
 * 都一样。包 11 修：此前无账本时 lineId 全为 null，导出面板按
 * lineId 过滤后一行不剩（示例单勾了也导不出），而最终报价条按
 * dataRowCount 数出 10 行——两处枚举就此统一。
 */
export function inquiryDataRows(inquiry) {
  const out = [];
  if (!inquiry || !inquiry.sheet) return out;
  const hr = headerRowOf(inquiry);
  const count = dataRowCount(inquiry);
  for (let i = 0; i < count; i++) {
    const row = hr + 1 + i;
    out.push({ lineId: lineIdAt(inquiry.ledger, row) || ('L' + (row + 1)), row, dataIndex: i });
  }
  return out;
}

/**
 * 转订单的数量带入（包 12，用户实测）：每行数量按 lineId 从某一列读出，
 * 给转订单面板预填。列的来源（2026-10-15 拍板）：
 *   · 用户指定了数量列（colOverride，为列号）→ 就用那一列，不管表头叫什么；
 *   · 没指定 → 按表头精确名自动认（需求数/数量/订购数/订货数/件数），认不到就空。
 * 值只认正数：空白/文字/0/负数一律不带入（留空 = 这行先不转，不拿 0 冒充）。
 * 返回 { col, header, qtys: Map<lineId, number> }。
 */
export function qtyPrefillForInquiry(inquiry, colOverride) {
  const empty = { col: null, header: null, qtys: new Map() };
  if (!inquiry || !inquiry.sheet) return empty;
  const hr = headerRowOf(inquiry);
  let found = null;
  if (typeof colOverride === 'number' && colOverride >= 0 && colOverride < (inquiry.sheet.column || 0)) {
    const raw = cellValue(inquiry.sheet, hr, colOverride);
    const header = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '第 ' + (colOverride + 1) + ' 列';
    found = { col: colOverride, header };
  } else {
    found = findQtyColumn(inquiry.sheet, hr);
  }
  if (!found) return empty;
  const qtys = new Map();
  for (const { lineId, row } of inquiryDataRows(inquiry)) {
    const n = parseCostValue(cellValue(inquiry.sheet, row, found.col));
    if (n !== null && n > 0) qtys.set(lineId, n);
  }
  return { col: found.col, header: found.header, qtys };
}

/**
 * 最终价的"算式透明化"（包 12，用户实测）：数字本来是对的，但界面
 * 只给结果不给来路，用户无从判断对错。这里把 computeFinalPrices
 * 用的同一条链拆成一行人话：
 *   不含税：工厂价 64.66（不含税 · 税点 13%）→ 含税 73.07 → 加价后
 *           87.68 → +运费 5.00 = 92.68
 *   含税：  工厂价 546.00（含税）→ 加价后 655.20 → +运费 5.00
 *           = 660.20（含税跳过税步——含税价不得再加税，SPEC 第五节）
 *   有汇率时尾巴是 → ÷汇率 7.2 = 91.69。
 * 阶段值只做显示舍入（round2），链路本身不舍入，最后的 "=" 后数字
 * 直接取 computeSalesPrice 的结果，保证与最终价列分毫不差。
 * 传了 factory + colHeader 时，算式前面点名基数来自哪家哪一列
 * （「按 EE『价格』列 工厂价 64.66 …」）——用户就是因为分不清
 * 最终价是按工厂的『价格』列还是按定价条的『销售价』列算的，才
 * 会把销售价误标成报价列（包 12 守卫同源问题）。
 * 入参：{ rawPrice, taxInclusive, taxRatePct（已解析的快照税点）,
 *        pricing（询价单定价条参数）, factory?, colHeader? }；
 * 成本不可用返回 null。
 */
export function priceBreakdown({ rawPrice, taxInclusive, taxRatePct, pricing, factory, colHeader } = {}) {
  const cost = parseCostValue(rawPrice);
  if (cost === null) return null;
  const p = pricing || {};
  const num = (x, fb) => {
    if (x === null || x === undefined || x === '') return fb;
    const n = Number(String(x).trim());
    return Number.isFinite(n) ? n : fb;
  };
  const rate = num(taxRatePct, 0);
  const markup = num(p.markupPct, 0);
  const freight = num(p.freight, 0);
  const fx = num(p.fxRate, null);
  const money = (n) => round2(n).toFixed(2);
  const final = computeSalesPrice({
    cost, taxInclusive: !!taxInclusive, taxRatePct: rate,
    markupPct: markup, freightPerUnit: freight, fxRate: fx,
  });
  if (final === null) return null;
  const parts = [];
  let cur = cost;
  if (taxInclusive) {
    parts.push('工厂价 ' + money(cost) + '（含税）');
  } else {
    cur = cost * (1 + rate / 100);
    parts.push('工厂价 ' + money(cost) + '（不含税 · 税点 ' + rate + '%）→ 含税 ' + money(cur));
  }
  cur = cur * (1 + markup / 100);
  parts.push('加价后 ' + money(cur));
  if (fx !== null && fx > 0) {
    parts.push('+运费 ' + money(freight) + ' → ÷汇率 ' + fx + ' = ' + money(final));
  } else {
    parts.push('+运费 ' + money(freight) + ' = ' + money(final));
  }
  const body = parts.join(' → ');
  return factory && colHeader
    ? '按 ' + factory + '『' + colHeader + '』列 ' + body
    : body;
}

/**
 * 一行的最终价解说（转订单面板与最终报价条共用，包 12）：先按 B4
 * 判来源——取自定厂报价单销售价的，解说点名那张单、那一列和它的
 * 生成参数（「取自 EE 报价单『销售价』列（由『价格』列按
 * 税13%/加价20%/运费5 生成）= 64.66」）；其余行走 priceBreakdown
 * 的标准算式（按定厂价 + 询价单定价条参数）。两种来源在同一张
 * 订单里可以逐行混着来，解说逐行标明，不让用户再猜数字的来路。
 */
export function finalBreakdownFor(lineId, choice, { inquiry, quotes } = {}) {
  if (!choice) return null;
  const quote = (quotes || []).find((d) => d.factoryName === choice.factory) || null;
  const src = quote && inquiry ? salesSourceForQuote(quote) : null;
  if (src) {
    const qRow = quoteRowForLine(quote, inquiry, lineId);
    if (qRow !== null) {
      const fin = salesSourceFinal(quote, src, qRow);
      if (fin === null) return null; // 与最终价一致：没价就没解说
      const p = src.pricing;
      const parts = [
        p.taxInclusive ? '含税' : '税' + String(p.taxRatePct ?? '0') + '%',
        '加价' + String(p.markupPct ?? '0') + '%',
        '运费' + String(p.freight ?? '0'),
      ];
      const fx = parseCostValue(p.fxRate);
      if (fx !== null && fx > 0) parts.push('汇率' + p.fxRate);
      return '取自 ' + choice.factory + ' 报价单『' + src.salesHeader + '』列（由『' +
        src.costHeader + '』列按 ' + parts.join('/') + ' 生成）= ' + fin.toFixed(2);
    }
  }
  let colHeader = null;
  if (quote && quote.priceMark && quote.priceMark.col !== null &&
      quote.priceMark.col !== undefined) {
    const v = cellValue(quote.sheet, headerRowOf(quote), quote.priceMark.col);
    if (typeof v === 'string' && v.trim()) colHeader = v.trim();
  }
  return priceBreakdown({
    rawPrice: choice.rawPrice,
    taxInclusive: choice.taxInclusive,
    taxRatePct: resolveChoiceTaxRatePct(choice, quotes),
    pricing: (inquiry && inquiry.pricing) || {},
    factory: choice.factory,
    colHeader,
  });
}

/**
 * 把最终价写进询价单的「最终报价」列（没有就先在最右侧加一列）：
 * 有价写价，没定厂/算不出价的行一律清空——重跑就是刷新，不留旧价。
 * 纯函数（setCellValue/appendColumn 都不原地改），返回 { sheet, col }。
 */
export function applyFinalQuoteColumn(sheet, headerRow, finalPrices, ledger) {
  let col = finalQuoteColOf(sheet, headerRow);
  let next = sheet;
  if (col === null) {
    const res = appendColumn(next, headerRow, FINAL_QUOTE_HEADER);
    next = res.sheet;
    col = res.col;
  }
  for (let r = headerRow + 1; r < (next.row || 0); r++) {
    const lineId = lineIdAt(ledger, r);
    const price = lineId ? finalPrices.get(lineId) : undefined;
    next = setCellValue(next, r, col,
      price === null || price === undefined
        ? null
        : { v: price, m: price.toFixed(2) });
  }
  return { sheet: next, col };
}

/* ---------- 普通版：只含选中行列的干净新表 ---------- */

function copyCellInto(celldata, sheet, r, c, nr, nc) {
  const val = cellValue(sheet, r, c);
  if (val === null || val === undefined || val === '') return;
  celldata.push({ r: nr, c: nc, v: { v: val, m: String(val) } });
}

/**
 * 普通版导出的规范表：标题行（表头之上的行，如合并大标题）→ 表头行
 * → 选中的数据行（原顺序）；列只含选中的（selectedColKeys 里的
 * 'c<列号>' 是原表列，'final' 是最终报价列，恒列在最后）。
 * 最终报价列的表头与值都由 finalPrices 现给，不依赖表里有没有那列。
 */
export function buildPlainExportSheet({ inquiry, selectedLineIds, selectedColKeys, finalPrices } = {}) {
  const sheet = inquiry && inquiry.sheet;
  const hr = headerRowOf(inquiry || {});
  const sel = selectedColKeys || new Set();
  const sheetCols = [...sel]
    .filter((k) => typeof k === 'string' && k.startsWith('c'))
    .map((k) => Number(k.slice(1)))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  const finalSelected = sel.has('final');
  const outCols = sheetCols.length + (finalSelected ? 1 : 0);
  const finalOutCol = finalSelected ? sheetCols.length : null;

  const celldata = [];
  const rows = inquiryDataRows(inquiry || {});
  const picked = rows.filter((x) => x.lineId && selectedLineIds && selectedLineIds.has(x.lineId));
  let nr = 0;
  // 表头之上的行（标题等）原样带（只取选中列）
  for (let r = 0; r < hr; r++, nr++) {
    sheetCols.forEach((c, nc) => copyCellInto(celldata, sheet, r, c, nr, nc));
  }
  // 表头行
  sheetCols.forEach((c, nc) => copyCellInto(celldata, sheet, hr, c, nr, nc));
  if (finalSelected) {
    celldata.push({ r: nr, c: finalOutCol, v: { v: FINAL_QUOTE_HEADER, m: FINAL_QUOTE_HEADER } });
  }
  nr++;
  // 选中的数据行
  for (const { lineId, row } of picked) {
    sheetCols.forEach((c, nc) => copyCellInto(celldata, sheet, row, c, nr, nc));
    if (finalSelected) {
      const price = finalPrices ? finalPrices.get(lineId) : undefined;
      if (price !== null && price !== undefined) {
        celldata.push({ r: nr, c: finalOutCol, v: { v: price, m: price.toFixed(2) } });
      }
    }
    nr++;
  }

  // 标题合并：原表里落在表头之上的合并区，按选中列重映射跨度
  const merge = {};
  const merges = (sheet && sheet.config && sheet.config.merge) || {};
  for (const m of Object.values(merges)) {
    if (!m || m.r + m.rs - 1 >= hr) continue;
    const startIdx = sheetCols.indexOf(m.c);
    if (startIdx < 0) continue;
    let span = sheetCols.filter((c) => c >= m.c && c < m.c + m.cs).length;
    if (finalSelected && m.c + m.cs >= (sheet.column || 0)) span += 1; // 原合并顶到最右列：把最终价列也罩住
    if (span > 1) {
      merge[m.r + '_' + startIdx] = { r: m.r, c: startIdx, rs: m.rs, cs: span };
    }
  }

  // 几何 + 图片（包 12）：选中列的像素宽、每一输出行的像素高照原表
  // 带出（生成文件的锚点图靠它们落位）；图片列在选中列里时，把每
  // 个选中行的照片按输出行列记成 exportImages，写文件时嵌成标准
  // 锚点图。图片列没被选中 → exportImages 为空，文件里一张图没有。
  const srcCfg = (sheet && sheet.config) || {};
  const columnlen = {};
  sheetCols.forEach((c, nc) => {
    const w = srcCfg.columnlen ? srcCfg.columnlen[c] : undefined;
    if (w != null) columnlen[nc] = w;
  });
  const rowlen = {};
  const srcRowH = (r) => (srcCfg.rowlen ? srcCfg.rowlen[r] : undefined);
  for (let r = 0; r <= hr; r++) {
    const h = srcRowH(r);
    if (h != null) rowlen[r] = h;
  }
  const imgByCell = new Map();
  for (const im of (sheet && sheet.images) || []) {
    if (im.anchorRow === undefined || im.anchorCol === undefined) continue;
    const k = im.anchorRow + ',' + im.anchorCol;
    if (!imgByCell.has(k)) imgByCell.set(k, im);
  }
  const exportImages = [];
  let outRow = hr;
  for (const { row } of picked) {
    outRow++;
    const h = srcRowH(row);
    if (h != null) rowlen[outRow] = h;
    sheetCols.forEach((c, nc) => {
      const im = imgByCell.get(row + ',' + c);
      if (im) {
        exportImages.push({
          row: outRow, col: nc,
          widthPx: im.width || columnlen[nc] || 100,
          heightPx: im.height || h || 20,
          src: im.src, fileId: im.fileId || null,
        });
      }
    });
  }

  return {
    name: (sheet && sheet.name) || 'Sheet1',
    row: nr,
    column: outCols,
    celldata,
    config: { merge, columnlen, rowlen },
    images: [],
    exportImages,
    defaultColWidth: sheet ? sheet.defaultColWidth : undefined,
    defaultRowHeight: sheet ? sheet.defaultRowHeight : undefined,
  };
}

/* ---------- 带图版：在客户原件上回写的表 ---------- */

/**
 * 带图版导出的规范表 = 询价单当前表本体（回写时由 writeback 贴回客户
 * 原件，格式/合并/图片全保留），只动「最终报价」列：把 finalPrices
 * 过滤成"只剩选中行"，其余行在 applyFinalQuoteColumn 里一律清空——
 * 没被选中的行，最终价格保持空白（SPEC 第四节第 7 项）。
 */
export function buildPicturedExportSheet({ inquiry, selectedLineIds, finalPrices, selectedColKeys } = {}) {
  const sheet = inquiry && inquiry.sheet;
  const hr = headerRowOf(inquiry || {});
  const pickedPrices = new Map();
  for (const [lineId, price] of (finalPrices || new Map())) {
    if (selectedLineIds && selectedLineIds.has(lineId)) {
      pickedPrices.set(lineId, price);
    }
  }
  const withFinal = applyFinalQuoteColumn(sheet, hr, pickedPrices, inquiry && inquiry.ledger).sheet;
  return applySelectionHiding(withFinal, { headerRow: hr, inquiry, selectedLineIds, selectedColKeys });
}

/**
 * 带图版的勾选（用户拍板，2026-10-15）：未勾选的数据行、未勾选的列在导出件里
 * 隐藏而不删除——删行删列会让图片锚点与原件错位，隐藏则结构、图片、公式全部保留，
 * 客户取消隐藏即可看到完整原表。最终报价列由 'final' 这一项决定显示与否。
 * 不传勾选（undefined）的维度保持原样不隐藏。
 */
function applySelectionHiding(sheet, { headerRow, inquiry, selectedLineIds, selectedColKeys }) {
  const cfg = (sheet && sheet.config) || {};
  const rowhidden = { ...(cfg.rowhidden || {}) };
  const colhidden = { ...(cfg.colhidden || {}) };
  if (selectedLineIds && inquiry) {
    for (const { lineId, row } of inquiryDataRows(inquiry)) {
      if (!lineId || !selectedLineIds.has(lineId)) rowhidden[row] = true;
    }
  }
  if (selectedColKeys && sheet) {
    const finCol = finalQuoteColOf(sheet, headerRow);
    for (let c = 0; c < (sheet.column || 0); c++) {
      const shown = c === finCol ? selectedColKeys.has('final') : selectedColKeys.has('c' + c);
      if (!shown) colhidden[c] = true;
    }
  }
  return { ...sheet, config: { ...cfg, rowhidden, colhidden } };
}