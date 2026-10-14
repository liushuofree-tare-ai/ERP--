// 订单的钱与状态（SPEC 第四节第 8、9 项 + 第五节金额口径）。
// 纯函数、无副作用：订单上只存"事实"（行、收款记录、工厂付款记录、
// 已发数量），一切汇总与状态都由这里现算——状态永不落库存一份过时
// 的副本（brief 口径：status derived, never stored stale）。
//
// 钱的口径：
// · 应收（客户欠我们的）= Σ 最终报价（销售价）× 数量，逐行四舍五入
//   到分再合计；
// · 应付（我们欠工厂的）= Σ 含税成本 × 数量。工厂成本的口径以定厂
//   快照为准：快照说含税，成本原值就是含税额；快照说不含税，应付
//   的是补上税点的含税额——成本 ×（1 + 快照税点）。逐行先把单件
//   含税成本四舍五入到分，再 × 数量、逐行到分、再合计。
// · 已收/已付是记录求和；未收/未付 = 应收/应付 − 已收/已付。
//   正常路径下不会为负；只有用户在"超额提醒"弹窗里明确确认过的
//   超额记录才会让它变负（提醒逻辑在 UI 层，这里只算事实）。
// · 订单完成 ⇔ 已收 ≥ 应收 且 每一行已发 ≥ 数量。
import { round2, parseCostValue } from './pricing.js';

/** 订单号：前缀 ORD + YYMM + 4 位流水（如 ORD2610-0001），流水只增不减 */
export function formatOrderNo(date, seq) {
  const d = date instanceof Date ? date : new Date(date);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return 'ORD' + yy + mm + '-' + String(Math.max(1, seq || 1)).padStart(4, '0');
}

/** 一行的单件含税成本（欠工厂的口径）：含税原样；不含税补税点 */
export function lineUnitCostWithTax(line) {
  const raw = parseCostValue(line && line.costRaw);
  if (raw === null) return null;
  if (line.costTaxInclusive) return round2(raw);
  const rateText = String(line.costTaxRatePct ?? '').trim();
  const rate = rateText === '' ? 0 : Number(rateText);
  return round2(raw * (1 + (Number.isFinite(rate) ? rate : 0) / 100));
}

/** 一行应收 = 最终报价 × 数量（到分）；价/量不可用返回 null（按 0 计入并标注） */
export function lineReceivable(line) {
  const price = parseCostValue(line && line.finalPrice);
  const qty = Number(line && line.qty);
  if (price === null || !Number.isFinite(qty)) return null;
  return round2(price * qty);
}

/** 一行应付 = 单件含税成本 × 数量（到分）；成本不可用返回 null */
export function linePayable(line) {
  const unit = lineUnitCostWithTax(line);
  const qty = Number(line && line.qty);
  if (unit === null || !Number.isFinite(qty)) return null;
  return round2(unit * qty);
}

function sumAmounts(records) {
  let s = 0;
  for (const r of records || []) {
    const n = Number(r && r.amount);
    if (Number.isFinite(n)) s += n;
  }
  return round2(s);
}

/**
 * 订单的全部派生事实（列表与详情共用这一份，口径不会有第二套）：
 * {
 *   receivable, received, unpaid,
 *   payable, paid, unpaidPay,
 *   factories: [{ factory, payable, paid, unpaid }]（按行里出现的工厂顺序）,
 *   totalQty, shippedQty, shipStatus: '未发货'|'部分发货'|'已发完',
 *   complete, statusText: '已完成'|'进行中'
 * }
 */
export function orderFacts(order) {
  const lines = (order && order.lines) || [];
  let receivable = 0;
  const factoryOrder = [];
  const byFactory = new Map();
  let totalQty = 0;
  let shippedQty = 0;
  let allShipped = true;
  for (const line of lines) {
    const rec = lineReceivable(line);
    if (rec !== null) receivable += rec;
    const factory = line.factory || '';
    if (!byFactory.has(factory)) {
      byFactory.set(factory, { factory, payable: 0, paid: 0, unpaid: 0 });
      factoryOrder.push(factory);
    }
    const pay = linePayable(line);
    if (pay !== null) byFactory.get(factory).payable = round2(byFactory.get(factory).payable + pay);
    const qty = Number(line.qty) || 0;
    const shipped = Number(line.shippedQty) || 0;
    totalQty += qty;
    shippedQty += shipped;
    if (shipped < qty) allShipped = false;
  }
  receivable = round2(receivable);
  const received = sumAmounts(order && order.receipts);
  let payable = 0;
  let paid = 0;
  for (const f of factoryOrder) {
    const g = byFactory.get(f);
    g.payable = round2(g.payable);
    g.paid = sumAmounts(((order && order.factoryPays) || []).filter((p) => (p.factory || '') === f));
    g.unpaid = round2(g.payable - g.paid);
    payable = round2(payable + g.payable);
    paid = round2(paid + g.paid);
  }
  const shipStatus = shippedQty <= 0 ? '未发货' : (allShipped ? '已发完' : '部分发货');
  const complete = received >= receivable && allShipped;
  return {
    receivable,
    received,
    unpaid: round2(receivable - received),
    payable,
    paid,
    unpaidPay: round2(payable - paid),
    factories: factoryOrder.map((f) => byFactory.get(f)),
    totalQty,
    shippedQty,
    shipStatus,
    complete,
    statusText: complete ? '已完成' : '进行中',
  };
}

/**
 * 超额检测（SPEC 第四节第 9 项"超了必须提醒"）：
 * kind='receipt' 时看整单应收；kind='factoryPay' 时看该厂应付。
 * 返回 { over, overBy, remaining }：remaining 是记这笔之前的余额；
 * over=true 表示记完会超出，overBy 是会超出的金额。是否放行由
 * UI 层弹窗问用户，这里只给事实。
 */
export function checkOverAmount(order, kind, amount, factory) {
  const facts = orderFacts(order);
  const n = Number(amount);
  const amt = Number.isFinite(n) ? n : 0;
  if (kind === 'receipt') {
    const after = round2(facts.received + amt);
    return {
      over: after > facts.receivable,
      overBy: round2(Math.max(0, after - facts.receivable)),
      remaining: facts.unpaid,
    };
  }
  const g = facts.factories.find((x) => x.factory === (factory || '')) ||
    { payable: 0, paid: 0, unpaid: 0 };
  const after = round2(g.paid + amt);
  return {
    over: after > g.payable,
    overBy: round2(Math.max(0, after - g.payable)),
    remaining: g.unpaid,
  };
}

/** 一行还能发多少（发货硬校验用）：数量 − 已发，下限 0 */
export function lineRemainingToShip(line) {
  const qty = Number(line && line.qty) || 0;
  const shipped = Number(line && line.shippedQty) || 0;
  return Math.max(0, qty - shipped);
}

/** 发货数量是否合法：正数且不超过待发量。返回 { ok, remaining } */
export function validateShipQty(line, qty) {
  const remaining = lineRemainingToShip(line);
  const n = Number(qty);
  return { ok: Number.isFinite(n) && n > 0 && n <= remaining, remaining };
}

/**
 * 某张询价单已转订单的行：Map<lineId, orderNo>。
 * 转订单面板据此把已转的行标出来并禁选（重复转单拦截的数据依据）；
 * 只认 inquiryDocId 匹配的订单，别单的行不互相干扰。
 */
export function convertedLineIds(orders, inquiryDocId) {
  const out = new Map();
  for (const o of orders || []) {
    if (!o || o.inquiryDocId !== inquiryDocId) continue;
    for (const line of o.lines || []) {
      if (line && line.lineId && !out.has(line.lineId)) out.set(line.lineId, o.orderNo);
    }
  }
  return out;
}
