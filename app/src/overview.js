// 总览与台账的汇总（SPEC 第四节第 10 项）：全部数字由业务数据现算，
// 不落任何冗余汇总字段——询价单/报价单/订单的事实变了，这里自动跟着对。
// 纯函数、无副作用，输入存档形状 { docs, factories, orders }：
// · 客户维度：询价单上的客户名（customerName）与订单上的客户名同名合并；
//   询价单数按文档数计，订单数/应收/已收/未收按订单现算（orders.js）。
// · 工厂维度：工厂名单 + 报价单（按 factoryName 数）+ 订单行（按行里的
//   工厂聚合应付/已付/未付）；只在名单里、还没单据的工厂也列出来（全 0）。
// · 总览头：单据计数、全库应收/已收/未收、应付/已付/未付、待发货行数
//   （所有订单里 shippedQty < qty 的行数）。
import { orderFacts } from './orders.js';
import { round2 } from './pricing.js';

const UNNAMED = '（未填客户名）';

function emptyCustomer(name) {
  return { name, inquiries: 0, orders: 0, receivable: 0, received: 0, unpaid: 0 };
}
function emptyFactory(name) {
  return { name, quotes: 0, orderLines: 0, payable: 0, paid: 0, unpaid: 0 };
}

/**
 * 汇总一份总览模型：
 * {
 *   counts: { inquiries, quotes, orders },
 *   totals: { receivable, received, unpaid, payable, paid, unpaidPay, pendingShipLines },
 *   customers: [{ name, inquiries, orders, receivable, received, unpaid }]（未收多者在前）,
 *   factories: [{ name, quotes, orderLines, payable, paid, unpaid }]（未付多者在前）
 * }
 */
export function buildOverview(state) {
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const registry = (state && state.factories) || [];

  const inquiries = docs.filter((d) => d && d.kind === 'inquiry');
  const quotes = docs.filter((d) => d && d.kind === 'quote');

  /* ---- 客户 ---- */
  const custMap = new Map();
  const cust = (name) => {
    if (!custMap.has(name)) custMap.set(name, emptyCustomer(name));
    return custMap.get(name);
  };
  for (const d of inquiries) {
    const name = (d.customerName || '').trim();
    if (name) cust(name).inquiries += 1;
  }

  /* ---- 工厂 ---- */
  const facMap = new Map();
  const fac = (name) => {
    if (!facMap.has(name)) facMap.set(name, emptyFactory(name));
    return facMap.get(name);
  };
  for (const name of registry) {
    const n = (name || '').trim();
    if (n) fac(n);
  }
  for (const q of quotes) {
    const n = (q.factoryName || '').trim();
    if (n) fac(n).quotes += 1;
  }

  /* ---- 订单（钱与待发货都从订单现算） ---- */
  const totals = {
    receivable: 0, received: 0, unpaid: 0,
    payable: 0, paid: 0, unpaidPay: 0,
    pendingShipLines: 0,
  };
  for (const order of orders) {
    const f = orderFacts(order);
    totals.receivable = round2(totals.receivable + f.receivable);
    totals.received = round2(totals.received + f.received);
    totals.payable = round2(totals.payable + f.payable);
    totals.paid = round2(totals.paid + f.paid);
    for (const line of order.lines || []) {
      if ((Number(line.shippedQty) || 0) < (Number(line.qty) || 0)) {
        totals.pendingShipLines += 1;
      }
      const fname = (line.factory || '').trim();
      if (fname) fac(fname).orderLines += 1;
    }
    const cname = ((order.customerName || '').trim()) || UNNAMED;
    const c = cust(cname);
    c.orders += 1;
    c.receivable = round2(c.receivable + f.receivable);
    c.received = round2(c.received + f.received);
    for (const g of f.factories) {
      const fname = (g.factory || '').trim();
      if (!fname) continue;
      const row = fac(fname);
      row.payable = round2(row.payable + g.payable);
      row.paid = round2(row.paid + g.paid);
    }
  }
  totals.unpaid = round2(totals.receivable - totals.received);
  totals.unpaidPay = round2(totals.payable - totals.paid);

  const customers = [...custMap.values()].map((c) => ({
    ...c, unpaid: round2(c.receivable - c.received),
  }));
  customers.sort((a, b) => (b.unpaid - a.unpaid) || a.name.localeCompare(b.name, 'zh-CN'));
  const factories = [...facMap.values()].map((g) => ({
    ...g, unpaid: round2(g.payable - g.paid),
  }));
  factories.sort((a, b) => (b.unpaid - a.unpaid) || a.name.localeCompare(b.name, 'zh-CN'));

  return {
    counts: { inquiries: inquiries.length, quotes: quotes.length, orders: orders.length },
    totals,
    customers,
    factories,
  };
}
