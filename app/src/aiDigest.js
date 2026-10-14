// AI 数据摘要（SPEC 第四节第 11 项）：把全库业务数据汇总成一份纯文本，
// 提问时随问题一起发给用户配置的 AI 接口。摘要是 AI 能看到的一切——
// 它只读这份摘要，永不接触存档本体，更永不回写（SPEC 第二节底线 4）。
// 纯函数：输入存档形状 { docs, factories, orders} 与 now（可注入便于
// 测试），输出文本。总长封顶约 24000 字，超了在行边界截断并注明。
import { orderFacts} from './orders.js';
import { buildOverview} from './overview.js';
import { round2} from './pricing.js';

export const DIGEST_CAP = 24000;

function money(n) {
const v = round2(Number(n) || 0);
return v.toFixed(2);
}
function fmtDate(iso) {
if (!iso) return '未知日期';
const d = new Date(iso);
return Number.isNaN(d.getTime())? '未知日期': d.toLocaleDateString('zh-CN');
}
function ageDays(iso, now) {
if (!iso) return null;
const t = new Date(iso).getTime();
if (Number.isNaN(t)) return null;
return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

/**
* 生成摘要文本。state: { docs, factories, orders}；opts.now: Date。
* 内容：总览数字、客户欠款、工厂应付、订单清单（带单龄）、询价/报价
* 情况、订单行里出现最多的 OE/配件。超长时按行截断并加注。
*/
export function buildAiDigest(state, opts = {}) {
const now = opts.now instanceof Date? opts.now: new Date();
const docs = (state && state.docs) || [];
const orders = (state && state.orders) || [];
const ov = buildOverview(state);
const L = [];

L.push('汽配外贸 ERP · 生成于 ' + now.toLocaleString('zh-CN', { hour12: false}));
L.push('金额单位：元。应收=客户欠我们的，应付=我们欠工厂的；未收/未付可为负数（表示对方多付/我们多付，经提醒确认过的超额）。');
L.push('');
L.push('== 总览 ==');
L.push('询价单 ' + ov.counts.inquiries + ' 张 · 报价单 ' + ov.counts.quotes +
' 张 · 订单 ' + ov.counts.orders + ' 单');
L.push('总应收 ' + money(ov.totals.receivable) + ' · 已收 ' + money(ov.totals.received) +
' · 未收 ' + money(ov.totals.unpaid));
L.push('总应付 ' + money(ov.totals.payable) + ' · 已付 ' + money(ov.totals.paid) +
' · 未付 ' + money(ov.totals.unpaidPay));
L.push('待发货 ' + ov.totals.pendingShipLines + ' 行（还没发完订单行）');
L.push('');

L.push('== 客户欠款（未收多者在前）==');
if (ov.customers.length === 0) L.push('（暂无客户记录）');
for (const c of ov.customers) {
L.push('客户「' + c.name + '」：询价单 ' + c.inquiries + ' 张 · 订单 ' + c.orders +
' 单 · 应收 ' + money(c.receivable) + ' · 已收 ' + money(c.received) +
' · 未收 ' + money(c.unpaid));
}
L.push('');

L.push('== 工厂应付（未付多者在前）==');
if (ov.factories.length === 0) L.push('（暂无工厂记录）');
for (const f of ov.factories) {
L.push('工厂「' + f.name + '」：报价单 ' + f.quotes + ' 张 · 订单行 ' + f.orderLines +
' 行 · 应付 ' + money(f.payable) + ' · 已付 ' + money(f.paid) +
' · 未付 ' + money(f.unpaid));
}
L.push('');

L.push('== 订单清单（新者在前）==');
if (orders.length === 0) L.push('（暂无订单）');
const sorted = [...orders].sort((a, b) =>
String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
for (const o of sorted) {
const f = orderFacts(o);
const age = ageDays(o.createdAt, now);
L.push('订单 ' + o.orderNo + ' · 客户「' + (o.customerName || '未填') + '」· ' +
fmtDate(o.createdAt) + (age === null? '': '（距今 ' + age + ' 天）') +
' · ' + (o.lines || []).length + ' 行 · 应收 ' + money(f.receivable) +
' · 已收 ' + money(f.received) + ' · 未收 ' + money(f.unpaid) +
' · 应付 ' + money(f.payable) + ' · 状态 ' + f.statusText +
' · 发货 ' + f.shipStatus + '（已发 ' + f.shippedQty + '/' + f.totalQty + ' 件）');
}
L.push('');

L.push('== 询价与报价情况 ==');
const inquiries = docs.filter((d) => d && d.kind === 'inquiry');
const quotes = docs.filter((d) => d && d.kind === 'quote');
if (inquiries.length === 0 && quotes.length === 0) L.push('（暂无询价单/报价单）');
for (const d of inquiries) {
const rows = d.ledger && Array.isArray(d.ledger.rows)? d.ledger.rows.length: 0;
const chosen = d.rowChoices? Object.keys(d.rowChoices).length: 0;
L.push('询价单（客户「' + ((d.customerName || '').trim() || '未填') + '」）：来源 ' +
((d.source && d.source.fileName) || '示例/手工') + ' · ' + rows + ' 行 · 已定厂 ' + chosen + ' 行');
}
for (const d of quotes) {
L.push('报价单（工厂「' + (d.factoryName || '') + '」）：' +
(d.priceMark? '已标价列（第 ' + (d.priceMark.col + 1) + ' 列，' +
(d.priceMark.taxInclusive? '含税': '不含税') + '）': '尚未标价列'));
}
L.push('');

L.push('== 订单里出现最多的配件 ==');
const freq = new Map();
for (const o of orders) {
for (const line of o.lines || []) {
const oe = (line.oe || '').trim();
const key = oe || ('（无OE）' + (line.name || ''));
if (!freq.has(key)) {
freq.set(key, { oe, name: line.name || '', count: 0, qty: 0, factories: new Set()});
}
const e = freq.get(key);
e.count += 1;
e.qty += Number(line.qty) || 0;
if (line.factory) e.factories.add(line.factory);
}
}
if (freq.size === 0) L.push('（暂无订单行）');
const top = [...freq.values()].sort((a, b) => b.count - a.count || b.qty - a.qty).slice(0, 15);
for (const e of top) {
L.push((e.oe? 'OE ' + e.oe: '配件') + '「' + e.name + '」：出现在 ' + e.count +
' 个订单行 · 合计 ' + e.qty + ' 件 · 供货工厂 ' +
([...e.factories].join('、') || '未记'));
}

let text = L.join('\n');
if (text.length > DIGEST_CAP) {
// 在行边界截断，宁可少给也不能给半行假数字
let cut = text.slice(0, DIGEST_CAP);
const nl = cut.lastIndexOf('\n');
if (nl > 0) cut = cut.slice(0, nl);
text = cut + '\n（注：数据较多，摘要已截断，后面的内容没有发给 AI；需要细节时请缩小问题范围。）';
}
return text;
}
