// 比价定厂的纯逻辑（SPEC 第三节核心模型 + 第四节第 5、6 项）：
//
// · 行对齐只按位置：询价单与每张报价单各自先定位表头行，表头之下的
//   第 i 条数据行互相对应（i 从 0 数），继承询价单账本里那一行的
//   lineId；绝不靠 OE/名称猜行（底线 3）。
// · 报价单比询价单多出的数据行是"工厂多报的行"：分配新 lineId 并
//   打 factoryExtra 标记，记在报价单文档上（factoryExtras）。
// · 价格归一：各家口径不同，比价统一换算成含税价——标记者说含税
//   就原样，不含税就 ×（1+该家税点）。归一价只用于并排比较与
//   "最低"提示；用户点选时存的是原值快照（rawPrice + 口径 + 周期），
//   定厂是用户点出来的，系统永不自动选定（底线 5）。
import { cellValue, detectHeaderRow } from './sheetOps.js';
import { parseCostValue, round2 } from './pricing.js';
import { lineIdAt } from './ledger.js';

/** 文档的表头行：存过的用存的（导入/上传时定的），没存过现判 */
export function headerRowOf(doc) {
  if (doc && typeof doc.headerRow === 'number') return doc.headerRow;
  return detectHeaderRow(doc && doc.sheet);
}

/** 数据行总数（表头行以下、表格物理行数以内） */
export function dataRowCount(doc) {
  const sheet = doc && doc.sheet;
  if (!sheet) return 0;
  return Math.max(0, (sheet.row || 0) - (headerRowOf(doc) + 1));
}

/**
 * 「定价条生成的销售价列」识别（包 12，用户实测翻车点）：用户在
 * 报价单上跑定价条生成了「销售价」列，又在标价列里把这一列标成
 * 工厂报价列——最终价就在卖价上再加一次税和加价（重复加价），
 * 界面当时毫无提醒。识别只认两类硬证据，不靠猜：
 * · 文档 pricing 里记着的 salesCol（定价条亲手写的那一列）；
 * · 表头文字就是「销售价」/「销售价（外币）」的列（老存档没记录
 *   时的兜底——卖价列叫这个名字，标它当成本价八成是误会，值得
 *   拦一下问清楚；用户坚持可以照常标记）。
 */
export function generatedSalesCols(doc) {
  const set = new Set();
  if (!doc || !doc.sheet) return set;
  const pricing = doc.pricing || {};
  if (typeof pricing.salesCol === 'number') set.add(pricing.salesCol);
  const hr = headerRowOf(doc);
  for (let c = 0; c < (doc.sheet.column || 0); c++) {
    const v = cellValue(doc.sheet, hr, c);
    if (typeof v === 'string') {
      const t = v.trim();
      if (t === '销售价' || t === '销售价（外币）') set.add(c);
    }
  }
  return set;
}

/**
 * 保存标价列标记前的重复加价守卫：要标的列是定价条生成的销售价列
 * 时返回 { salesHeader, costCol, costHeader, recorded }（costCol 是
 * 定价条当时用的成本价列——pricing 里记着才有，可供"改标成本价"
 * 一键切换；没记着为 null），否则返回 null（正常标记，不打扰）。
 */
export function salesMarkGuardInfo(doc, col) {
  if (!doc || col === null || col === undefined) return null;
  if (!generatedSalesCols(doc).has(col)) return null;
  const hr = headerRowOf(doc);
  const headerAt = (c) => {
    const v = cellValue(doc.sheet, hr, c);
    return typeof v === 'string' ? v.trim() : '';
  };
  const pricing = doc.pricing || {};
  const costCol = typeof pricing.costCol === 'number' ? pricing.costCol : null;
  return {
    salesHeader: headerAt(col) || '销售价',
    costCol,
    costHeader: costCol !== null ? (headerAt(costCol) || null) : null,
    recorded: pricing.salesCol === col,
  };
}

/** 周期列自动识别：表头文字含"周期"或"交期"的第一列；没有返回 null */
export function detectPeriodColumn(sheet, headerRow) {
  if (!sheet) return null;
  const hr = typeof headerRow === 'number' ? headerRow : detectHeaderRow(sheet);
  for (let c = 0; c < (sheet.column || 0); c++) {
    const t = cellValue(sheet, hr, c);
    if (typeof t === 'string' && (t.includes('周期') || t.includes('交期'))) return c;
  }
  return null;
}

/**
 * 一格报价归一成含税价（比价口径）：
 * raw 是格子现值（数字或数字字符串）；mark = { taxInclusive, taxRatePct }。
 * 空/非数字/没标记 → null（该行该厂"没报价"，显示为空，绝不冒充 0）。
 */
export function normalizePrice(raw, mark) {
  if (!mark || mark.col === null || mark.col === undefined) return null;
  const n = parseCostValue(raw);
  if (n === null) return null;
  if (mark.taxInclusive) return round2(n);
  const rateText = String(mark.taxRatePct ?? '').trim();
  const rate = rateText === '' ? 0 : Number(rateText);
  return round2(n * (1 + (Number.isFinite(rate) ? rate : 0) / 100));
}

/**
 * 报价单多出的数据行 → factoryExtras。
 * 入参：询价单文档、报价单的规范表、报价单账本（新建的，nextSeq 接着用）。
 * 返回 { extras: [{ row, lineId, factoryExtra: true }], nextSeq }：
 * extras 为空时 nextSeq 是账本原来的 nextSeq（调用方据此决定要不要改账本）。
 */
export function computeFactoryExtras(inquiry, quoteSheet, quoteLedger) {
  const inqCount = dataRowCount(inquiry);
  const qHr = detectHeaderRow(quoteSheet);
  const qCount = Math.max(0, (quoteSheet.row || 0) - (qHr + 1));
  const extras = [];
  let seq = quoteLedger && typeof quoteLedger.nextSeq === 'number'
    ? quoteLedger.nextSeq
    : (quoteSheet.row || 0) + 1;
  for (let i = inqCount; i < qCount; i++) {
    extras.push({ row: qHr + 1 + i, lineId: 'L' + seq, factoryExtra: true });
    seq += 1;
  }
  return { extras, nextSeq: seq };
}

/** 比价表左边的展示列（序号/OE/产品）：按表头文字找，找不到用位置兜底 */
export function pickDisplayColumns(sheet, headerRow) {
  const hr = typeof headerRow === 'number' ? headerRow : detectHeaderRow(sheet);
  const cols = (sheet && sheet.column) || 0;
  const texts = [];
  for (let c = 0; c < cols; c++) {
    const t = cellValue(sheet, hr, c);
    texts.push(typeof t === 'string' ? t.trim() : '');
  }
  const find = (re) => {
    const i = texts.findIndex((t) => re.test(t));
    return i >= 0 ? i : null;
  };
  const seqCol = find(/序号/) ?? 0;
  let oeCol = find(/OE/i) ?? find(/料号|编码|货号/);
  if (oeCol === null) oeCol = cols >= 7 ? 6 : Math.max(0, cols - 1);
  let productCol = find(/产品|品名|名称|零件/);
  if (productCol === null || productCol === oeCol || productCol === seqCol) {
    productCol = cols >= 5 ? 4 : 0;
    if (productCol === oeCol) productCol = seqCol;
  }
  return { seqCol, oeCol, productCol };
}

const asText = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * 构建比价行模型。
 * 入参：{ inquiry, quotes }——inquiry/quotes 都是文档对象
 * （至少含 sheet；inquiry 还用 ledger；quotes 用 factoryName/priceMark）。
 * 返回 {
 *   factories: [工厂名…（按文档顺序）],
 *   display: { seqCol, oeCol, productCol },
 *   rows: [{
 *     lineId, inquiryRow, dataIndex, seq, oe, product,
 *     cells: { [工厂名]: { factory, quoteRow（无对应行=null）,
 *                          raw（解析后的原值数字|null）, normalized,
 *                          taxInclusive, period, priced } },
 *     lowest（最低归一价|null）, lowestFactories: [工厂名…]
 *   }]
 * }
 * rows 只含询价单的数据行（标题/表头行不算）；报价单缺行 → priced=false。
 */
export function buildCompareRows({ inquiry, quotes } = {}) {
  const inqSheet = inquiry && inquiry.sheet;
  const factories = (quotes || []).map((q) => q.factoryName);
  if (!inqSheet) return { factories, display: { seqCol: 0, oeCol: 0, productCol: 0 }, rows: [] };
  const ih = headerRowOf(inquiry);
  const display = pickDisplayColumns(inqSheet, ih);
  const qMeta = (quotes || []).map((q) => ({
    doc: q,
    hr: headerRowOf(q),
    mark: q.priceMark || null,
  }));
  const count = dataRowCount(inquiry);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const inqRow = ih + 1 + i;
    const lineId = lineIdAt(inquiry.ledger, inqRow) || ('L' + (inqRow + 1));
    const cells = {};
    let lowest = null;
    const lowestFactories = [];
    for (const { doc: q, hr: qh, mark } of qMeta) {
      const factory = q.factoryName;
      const qRow = qh + 1 + i;
      const hasRow = qRow < ((q.sheet && q.sheet.row) || 0);
      let raw = null, normalized = null, period = '';
      if (hasRow && mark && mark.col !== null && mark.col !== undefined) {
        const rawCell = cellValue(q.sheet, qRow, mark.col);
        raw = parseCostValue(rawCell);
        normalized = normalizePrice(rawCell, mark);
        if (mark.periodCol !== null && mark.periodCol !== undefined) {
          period = asText(cellValue(q.sheet, qRow, mark.periodCol));
        }
      }
      const priced = normalized !== null;
      cells[factory] = {
        factory,
        quoteRow: hasRow ? qRow : null,
        raw,
        normalized,
        taxInclusive: mark ? !!mark.taxInclusive : null,
        // 该家标价列的税点（不含税口径算最终报价时要用）：随快照带走，
        // 免得之后标记被改/被删，最终报价的税步失去依据。
        taxRatePct: mark ? (mark.taxRatePct ?? '') : null,
        period,
        priced,
      };
      if (priced) {
        if (lowest === null || normalized < lowest) {
          lowest = normalized;
          lowestFactories.length = 0;
          lowestFactories.push(factory);
        } else if (normalized === lowest) {
          lowestFactories.push(factory);
        }
      }
    }
    rows.push({
      lineId,
      inquiryRow: inqRow,
      dataIndex: i,
      seq: asText(cellValue(inqSheet, inqRow, display.seqCol)),
      oe: asText(cellValue(inqSheet, inqRow, display.oeCol)),
      product: asText(cellValue(inqSheet, inqRow, display.productCol)),
      cells,
      lowest,
      lowestFactories,
    });
  }
  return { factories, display, rows };
}

/**
 * 用户点选一家 → rowChoices 的一条记录（原值快照）：
 * { factory, rawPrice, taxInclusive, taxRatePct, period }。
 * taxRatePct 是点选那一刻该家标价列的税点：最终报价（包 7）的税步
 * 按快照算，不含税价才用得上；含税价不用，但一并存下备查。
 * cell 是 buildCompareRows 给出的 cells[工厂名]。
 */
export function choiceFromCell(cell) {
  if (!cell || !cell.priced) return null;
  return {
    factory: cell.factory,
    rawPrice: cell.raw,
    taxInclusive: cell.taxInclusive,
    taxRatePct: cell.taxRatePct ?? '',
    period: cell.period || '',
  };
}
