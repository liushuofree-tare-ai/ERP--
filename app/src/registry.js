// 客户/工厂注册表与多询价单的联动规则（包 11）。
//
// 背景：包 10 以前系统只有"一张询价单 + 若干报价单"，客户只活在
// 询价单的 customerName 里、工厂只活在一串名字里，看不到联动、没有
// 管理页，导入新单还会把旧单连同报价单一起销毁。包 11 起：
// · 询价单可以有很多张（历史单留着查）；每张报价单用 inquiryId 记
//   它属于哪张询价单（克隆/回表时定死），订单早有 inquiryDocId；
// · 客户有了注册表 customers: [{ name, contact, note }]，随存档走；
//   身份就是名字字符串本身（与 overview 的同名合并口径一致），
//   改名 = 注册表 + 全部询价单 + 全部订单一起改，一次到位；
// · 工厂仍是名字清单（factories），改名同样全域同步：报价单、
//   定厂快照（rowChoices）、订单行、订单付款记录一起改；
// · 删除有硬规则：客户名下有询价单或订单、工厂名下有报价单/订单
//   引用、询价单已转出订单——一律拦下并给一句人话原因，历史不许删。
// 本文件全部纯函数：入参是存档形状 { docs, orders, customers,
// factories }（缺字段按空处理），改名/迁移返回新对象、不原地改入参。
import { orderFacts } from './orders.js';
import { buildOverview } from './overview.js';

const trim = (s) => (s === null || s === undefined ? '' : String(s).trim());

/** 属于某张询价单的报价单（按文档顺序） */
export function quotesForInquiry(docs, inquiryId) {
  return (docs || []).filter((d) => d && d.kind === 'quote' && d.inquiryId === inquiryId);
}

/** 一张单据所属的询价单（询价单返回自己；报价单按 inquiryId 找） */
export function inquiryOfDoc(docs, doc) {
  if (!doc) return null;
  if (doc.kind === 'inquiry') return doc;
  return (docs || []).find((d) => d && d.docId === doc.inquiryId) || null;
}

/** 询价单状态（派生，不存）：转出过订单就是「已转订单」，否则「进行中」 */
export function inquiryStatusOf(doc, orders) {
  if (!doc) return '';
  return (orders || []).some((o) => o && o.inquiryDocId === doc.docId)
    ? '已转订单'
    : '进行中';
}

/** 从现有单据里收集客户名（询价单在前、订单在后，按首次出现排序，去空去重） */
export function seedCustomerNames(docs, orders) {
  const seen = new Set();
  const out = [];
  const push = (name) => {
    const n = trim(name);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  };
  for (const d of docs || []) {
    if (d && d.kind === 'inquiry') push(d.customerName);
  }
  for (const o of orders || []) push(o && o.customerName);
  return out;
}

/**
 * 包 11 迁移（幂等，纯函数）：给一份旧存档补齐——
 * · 报价单缺 inquiryId → 补成（唯一的）那张询价单的 docId
 *   （包 10 以前全库只有一张询价单，不会认错）；
 * · customers 注册表缺失/不全 → 用 seedCustomerNames 从单据播种，
 *   已登记的条目（联系人/备注）原样保留。
 * 返回 { state, changed }；没动过就原样返回入参引用。
 */
export function migrateState(state) {
  if (!state || !Array.isArray(state.docs)) return { state, changed: false };
  let changed = false;
  const firstInquiry = state.docs.find((d) => d && d.kind === 'inquiry');
  let docs = state.docs;
  if (firstInquiry) {
    let touched = false;
    const next = state.docs.map((d) => {
      if (d && d.kind === 'quote' && !d.inquiryId) {
        touched = true;
        return { ...d, inquiryId: firstInquiry.docId };
      }
      return d;
    });
    if (touched) { docs = next; changed = true; }
  }
  const existing = Array.isArray(state.customers) ? state.customers : null;
  const known = new Set((existing || []).map((c) => trim(c && c.name)));
  const missing = seedCustomerNames(docs, state.orders)
    .filter((n) => !known.has(n))
    .map((name) => ({ name, contact: '', note: '' }));
  let customers = existing;
  if (!existing) {
    customers = missing;
    changed = true;
  } else if (missing.length) {
    customers = [...existing, ...missing];
    changed = true;
  }
  if (!changed) return { state, changed: false };
  return { state: { ...state, docs, customers }, changed: true };
}

/* ---------- 改名（全域同步；冲突/无变化返回 null） ---------- */

/**
 * 客户改名：注册表条目、每张询价单的 customerName、每张订单的
 * customerName 一起改。新名已被另一个客户占用（注册表或任一单据
 * 上出现过）→ 返回 null，什么都不改。
 */
export function renameCustomer(state, oldName, newName) {
  const from = trim(oldName);
  const to = trim(newName);
  if (!from || !to || from === to) return null;
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const customers = (state && state.customers) || [];
  const taken = customers.some((c) => trim(c && c.name) === to) ||
    docs.some((d) => d && d.kind === 'inquiry' && trim(d.customerName) === to) ||
    orders.some((o) => o && trim(o.customerName) === to);
  if (taken) return null;
  return {
    docs: docs.map((d) => (d && d.kind === 'inquiry' && trim(d.customerName) === from
      ? { ...d, customerName: to }
      : d)),
    orders: orders.map((o) => (o && trim(o.customerName) === from
      ? { ...o, customerName: to }
      : o)),
    customers: customers.map((c) => (c && trim(c.name) === from
      ? { ...c, name: to }
      : c)),
  };
}

/**
 * 工厂改名：工厂名单、报价单 factoryName、询价单定厂快照
 * rowChoices[*].factory、订单行 factory、订单付款 factoryPays[*].factory
 * 一起改。新名已被另一家工厂占用 → 返回 null。
 */
export function renameFactory(state, oldName, newName) {
  const from = trim(oldName);
  const to = trim(newName);
  if (!from || !to || from === to) return null;
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const factories = (state && state.factories) || [];
  const taken = factories.some((f) => trim(f) === to) ||
    docs.some((d) => d && d.kind === 'quote' && trim(d.factoryName) === to) ||
    docs.some((d) => d && d.rowChoices &&
      Object.values(d.rowChoices).some((c) => c && trim(c.factory) === to)) ||
    orders.some((o) => o && (
      (o.lines || []).some((l) => l && trim(l.factory) === to) ||
      (o.factoryPays || []).some((p) => p && trim(p.factory) === to)));
  if (taken) return null;
  return {
    docs: docs.map((d) => {
      if (!d) return d;
      let next = d;
      if (d.kind === 'quote' && trim(d.factoryName) === from) {
        next = { ...next, factoryName: to };
      }
      if (d.rowChoices) {
        let touched = false;
        const rc = {};
        for (const [lid, c] of Object.entries(d.rowChoices)) {
          if (c && trim(c.factory) === from) {
            rc[lid] = { ...c, factory: to };
            touched = true;
          } else {
            rc[lid] = c;
          }
        }
        if (touched) next = { ...next, rowChoices: rc };
      }
      return next;
    }),
    orders: orders.map((o) => {
      if (!o) return o;
      const lines = (o.lines || []).map((l) => (l && trim(l.factory) === from
        ? { ...l, factory: to }
        : l));
      const factoryPays = (o.factoryPays || []).map((p) => (p && trim(p.factory) === from
        ? { ...p, factory: to }
        : p));
      return { ...o, lines, factoryPays };
    }),
    factories: factories.map((f) => (trim(f) === from ? to : f)),
  };
}

/* ---------- 删除规则（返回 null = 可删；返回字符串 = 拦下的原因） ---------- */

/** 客户删除：名下有询价单或订单就不能删（历史要留着查账） */
export function customerDeleteBlock(state, name) {
  const n = trim(name);
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const inq = docs.filter((d) => d && d.kind === 'inquiry' && trim(d.customerName) === n).length;
  if (inq > 0) {
    return '客户「' + n + '」名下还有 ' + inq +
      ' 张询价单，不能删除——要删请先把那些询价单删掉（没转订单的才删得掉），或把客户名改到别的单据上。';
  }
  const ord = orders.filter((o) => o && trim(o.customerName) === n).length;
  if (ord > 0) {
    return '客户「' + n + '」名下还有 ' + ord +
      ' 张订单，不能删除——订单是历史账目，要一直留着查。';
  }
  return null;
}

/** 工厂删除：名下有报价单、定厂记录或订单引用就不能删 */
export function factoryDeleteBlock(state, name) {
  const n = trim(name);
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const quotes = docs.filter((d) => d && d.kind === 'quote' && trim(d.factoryName) === n).length;
  if (quotes > 0) {
    return '工厂「' + n + '」名下还有 ' + quotes +
      ' 张报价单，不能删除——先在表格工作区把那些报价单删掉再说。';
  }
  const chosen = docs.reduce((acc, d) => acc + (d && d.rowChoices
    ? Object.values(d.rowChoices).filter((c) => c && trim(c.factory) === n).length
    : 0), 0);
  if (chosen > 0) {
    return '工厂「' + n + '」还有 ' + chosen +
      ' 行定厂记录指着它，不能删除——先在比价定厂里改掉那些行的定厂。';
  }
  const ordRefs = orders.filter((o) => o && (
    (o.lines || []).some((l) => l && trim(l.factory) === n) ||
    (o.factoryPays || []).some((p) => p && trim(p.factory) === n))).length;
  if (ordRefs > 0) {
    return '工厂「' + n + '」在 ' + ordRefs +
      ' 张订单里出现过，不能删除——订单是历史账目，要一直留着查。';
  }
  return null;
}

/** 询价单删除：已转出订单的不能删（订单的来源单据必须一直在） */
export function inquiryDeleteBlock(orders, inquiryId) {
  const refs = (orders || []).filter((o) => o && o.inquiryDocId === inquiryId);
  if (refs.length > 0) {
    return '这张询价单已经转出订单 ' + refs.map((o) => o.orderNo).join('、') +
      '，是历史记录，不能删除（订单还要靠它查来源）。没有转过订单的询价单才可以删。';
  }
  return null;
}

/* ---------- 工厂附加信息（包 13：联系人/备注） ----------
 * 工厂主体仍是名字字符串；联系人/备注单独存在存档的 factoryInfo 里：
 *   factoryInfo: { [工厂名]: { contact, note } }
 * 改名要把条目搬过去、删除要把条目去掉，否则备注会串给同名新厂或
 * 永远留在存档里。纯函数：不改入参，返回新对象。
 */

/** 改名同步：把旧名条目搬到新名；旧名没有条目时原样（浅拷贝）返回 */
export function syncFactoryInfoOnRename(factoryInfo, oldName, newName) {
  const info = factoryInfo || {};
  const from = trim(oldName);
  const to = trim(newName);
  if (!from || !to || from === to || !(from in info)) return { ...info };
  const next = { ...info };
  next[to] = next[from];
  delete next[from];
  return next;
}

/** 删除同步：去掉该工厂的条目（没有就原样浅拷贝） */
export function syncFactoryInfoOnDelete(factoryInfo, name) {
  const info = factoryInfo || {};
  const n = trim(name);
  if (!n || !(n in info)) return { ...info };
  const next = { ...info };
  delete next[n];
  return next;
}

/* ---------- 管理页读模型（数字全部现算，不存副本） ---------- */

/**
 * 客户管理模型：[{ entry: { name, contact, note },
 *   stats: { inquiries, orders, receivable, received, unpaid },
 *   inquiries: [{ docId, createdAt, sourceFileName, status,
 *                 note（包 13：询价单备注） }],
 *   orders: [订单原文…] }]
 * 名单 = 注册表 ∪ 单据上出现过的客户名（注册表没有的给空条目兜底）。
 */
export function buildCustomerModel(state) {
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const registry = (state && state.customers) || [];
  const ov = buildOverview(state || {});
  const statsByName = new Map(ov.customers.map((c) => [c.name, c]));
  const entryByName = new Map();
  for (const c of registry) {
    const n = trim(c && c.name);
    if (n && !entryByName.has(n)) {
      entryByName.set(n, { name: n, contact: (c && c.contact) || '', note: (c && c.note) || '' });
    }
  }
  for (const n of seedCustomerNames(docs, orders)) {
    if (!entryByName.has(n)) entryByName.set(n, { name: n, contact: '', note: '' });
  }
  return [...entryByName.values()].map((entry) => {
    const s = statsByName.get(entry.name);
    return {
      entry,
      stats: s
        ? { inquiries: s.inquiries, orders: s.orders, receivable: s.receivable, received: s.received, unpaid: s.unpaid }
        : { inquiries: 0, orders: 0, receivable: 0, received: 0, unpaid: 0 },
      inquiries: docs
        .filter((d) => d && d.kind === 'inquiry' && trim(d.customerName) === entry.name)
        .map((d) => ({
          docId: d.docId,
          createdAt: d.createdAt || null,
          sourceFileName: (d.source && d.source.fileName) || '',
          status: inquiryStatusOf(d, orders),
          note: d.note || '',
        })),
      orders: orders.filter((o) => o && trim(o.customerName) === entry.name),
    };
  });
}

/**
 * 工厂管理模型：[{ name,
 *   stats: { quotes, orderLines, payable, paid, unpaid },
 *   quoteDocs: [{ docId, inquiryId }],
 *   orders: [与这家有关的订单原文…] }]
 * 名单 = 工厂注册表 ∪ 报价单/订单里出现过的工厂名。
 */
export function buildFactoryModel(state) {
  const docs = (state && state.docs) || [];
  const orders = (state && state.orders) || [];
  const factoryInfo = (state && state.factoryInfo) || {};
  const ov = buildOverview(state || {});
  const statsByName = new Map(ov.factories.map((f) => [f.name, f]));
  const names = [];
  const seen = new Set();
  const push = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
  for (const f of (state && state.factories) || []) push(trim(f));
  for (const name of statsByName.keys()) push(name);
  for (const o of orders) {
    for (const l of (o && o.lines) || []) push(trim(l && l.factory));
    for (const p of (o && o.factoryPays) || []) push(trim(p && p.factory));
  }
  return names.map((name) => {
    const s = statsByName.get(name);
    const info = factoryInfo[name] || {};
    return {
      name,
      info: { contact: info.contact || '', note: info.note || '' },
      stats: s
        ? { quotes: s.quotes, orderLines: s.orderLines, payable: s.payable, paid: s.paid, unpaid: s.unpaid }
        : { quotes: 0, orderLines: 0, payable: 0, paid: 0, unpaid: 0 },
      quoteDocs: docs
        .filter((d) => d && d.kind === 'quote' && trim(d.factoryName) === name)
        .map((d) => ({ docId: d.docId, inquiryId: d.inquiryId || null })),
      orders: orders.filter((o) => o && (
        (o.lines || []).some((l) => l && trim(l.factory) === name) ||
        (o.factoryPays || []).some((p) => p && trim(p.factory) === name))),
    };
  });
}

/** 订单一行摘要（管理页详情里列订单用）：单号 + 客户 + 应收 + 状态 */
export function orderSummary(order) {
  const f = orderFacts(order);
  return {
    orderNo: order.orderNo,
    customerName: order.customerName || '',
    receivable: f.receivable,
    statusText: f.statusText,
  };
}
