// 工作状态读写：整份状态原子替换 + 整库 revision 乐观锁。
// 状态形状与前端 store.js 的存档完全同构（docs/orders/customers/
// factoryInfo/factories/orderSeq/activeDocId...），前端零转换成本。
// 数据库侧是关系表 + JSON 明细列；这里负责两边互转（assemble/replace）。
//
// 乐观锁语义（多人/多标签页并发防覆盖）：
//   PUT /api/state { baseRevision, state }
//   baseRevision 为 null（首次存档）→ 直接接受；
//   baseRevision < 当前 revision → 409（别的窗口已更新，前端提示刷新拉取）；
//   baseRevision === 当前 revision → 替换成功，revision+1。
import { getDb, getMeta, setMeta, inTransaction } from '../db.js';

const j = (v, fb) => (v ? JSON.parse(v) : fb);
const nowIso = () => new Date().toISOString();

export function getCurrentRevision() {
  return Number(getMeta('revision') || '0');
}

/* ---------- 数据库 → 前端状态 ---------- */
export function assembleState() {
  const d = getDb();
  const customers = d.prepare(
    'SELECT name, contact, note FROM customers ORDER BY sort_order, name').all();
  const factoryRows = d.prepare(
    'SELECT name, contact, note FROM factories ORDER BY sort_order, name').all();
  const factoryInfo = {};
  for (const f of factoryRows) factoryInfo[f.name] = { contact: f.contact, note: f.note };
  const docRows = d.prepare(
    'SELECT * FROM documents ORDER BY sort_order, doc_id').all();
  const docs = docRows.map((r) => ({
    docId: r.doc_id,
    kind: r.kind,
    factoryName: r.factory_name,
    // 客户关联就靠这个字段（按名匹配）：曾漏读，导致 A 关联客户、B 拉取后
    // 关联消失、再关联再消失的死循环——写读必须成对，别再删。
    customerName: r.customer_name ? r.customer_name : null,
    inquiryId: r.inquiry_id,
    createdAt: r.created_at,
    note: r.note,
    sheet: j(r.sheet_json, null),
    ledger: j(r.ledger_json, null),
    pricing: j(r.pricing_json, null),
    source: j(r.source_json, null),
    sourceFileId: r.source_file_id,
    importInfo: r.import_info,
    headerRow: r.header_row === null ? undefined : r.header_row,
    priceMark: j(r.price_mark_json, null),
    factoryExtras: j(r.factory_extras_json, []),
    rowChoices: j(r.row_choices_json, null),
    qtyCol: r.qty_col === null || r.qty_col === undefined ? undefined : r.qty_col,
    exportColKeys: j(r.export_col_keys_json, null),
  }));
  const orderRows = d.prepare(
    'SELECT * FROM orders ORDER BY sort_order, order_no').all();
  const orders = orderRows.map((r) => ({
    orderNo: r.order_no,
    createdAt: r.created_at,
    customerName: r.customer_name,
    inquiryDocId: r.inquiry_doc_id,
    note: r.note,
    lines: j(r.lines_json, []),
    receipts: j(r.receipts_json, []),
    factoryPays: j(r.factory_pays_json, []),
    shipments: j(r.shipments_json, []),
  }));
  const orderSeq = Number(getMeta('order_seq') || '0');
  const activeDocId = getMeta('active_doc_id') || 'doc-inquiry';
  const savedAt = getMeta('saved_at') || null;
  return {
    version: 2,
    savedAt,
    imagesPersisted: true,
    imageStore: 'idb',
    factories: factoryRows.map((f) => f.name),
    factoryInfo,
    customers,
    orders,
    orderSeq,
    activeDocId,
    docs,
  };
}

/* ---------- 前端状态 → 数据库（整份替换） ----------
 * replaceStateInTx：不自己开事务（恢复备份要"文件写入 + 状态替换"同笔原子
 * 提交，届时由调用方开事务）；
 * replaceState：自带事务，日常保存走这里。
 */
export function replaceStateInTx(state, { actor = 'local', action = 'save_state' } = {}) {
  const d = getDb();
  const docs = Array.isArray(state.docs) ? state.docs : [];
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const customers = Array.isArray(state.customers) ? state.customers : [];
  const factories = Array.isArray(state.factories) ? state.factories : [];
  const factoryInfo = state.factoryInfo && typeof state.factoryInfo === 'object' ? state.factoryInfo : {};
  d.prepare('DELETE FROM documents').run();
  d.prepare('DELETE FROM orders').run();
  d.prepare('DELETE FROM customers').run();
  d.prepare('DELETE FROM factories').run();

    const insDoc = d.prepare(`
      INSERT INTO documents (
        doc_id, kind, inquiry_id, factory_name, customer_name, note, header_row,
        source_file_id, source_json, import_info, pricing_json, price_mark_json,
        ledger_json, row_choices_json, factory_extras_json, sheet_json,
        qty_col, export_col_keys_json,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    docs.forEach((doc, i) => {
      insDoc.run(
        String(doc.docId || ''), String(doc.kind || 'inquiry'),
        doc.inquiryId || null, doc.factoryName || null,
        doc.customerName || '', doc.note || '',
        typeof doc.headerRow === 'number' ? doc.headerRow : null,
        doc.sourceFileId || null,
        JSON.stringify(doc.source || null),
        doc.importInfo || '',
        JSON.stringify(doc.pricing || null),
        JSON.stringify(doc.priceMark || null),
        JSON.stringify(doc.ledger || null),
        JSON.stringify(doc.rowChoices || null),
        JSON.stringify(Array.isArray(doc.factoryExtras) ? doc.factoryExtras : []),
        JSON.stringify(doc.sheet || null),
        typeof doc.qtyCol === 'number' ? doc.qtyCol : null,
        JSON.stringify(Array.isArray(doc.exportColKeys) ? doc.exportColKeys : null),
        i, doc.createdAt || null, nowIso());
    });

    const insOrder = d.prepare(`
      INSERT INTO orders (
        order_no, inquiry_doc_id, customer_name, note, lines_json,
        receipts_json, factory_pays_json, shipments_json,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    orders.forEach((o, i) => {
      insOrder.run(
        String(o.orderNo || ''), String(o.inquiryDocId || ''), o.customerName || '',
        o.note || '', JSON.stringify(o.lines || []),
        JSON.stringify(o.receipts || []), JSON.stringify(o.factoryPays || []),
        JSON.stringify(o.shipments || []),
        i, o.createdAt || null, nowIso());
    });

    const insCust = d.prepare(`
      INSERT INTO customers (name, contact, note, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?)`);
    customers.forEach((c, i) => {
      const n = String(c && c.name || '').trim();
      if (!n) return;
      insCust.run(n, c.contact || '', c.note || '', i, nowIso());
    });

    const insFac = d.prepare(`
      INSERT INTO factories (name, contact, note, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?)`);
    factories.forEach((f, i) => {
      const n = String(f || '').trim();
      if (!n) return;
      const info = factoryInfo[n] || {};
      insFac.run(n, info.contact || '', info.note || '', i, nowIso());
    });

    setMeta('order_seq', String(Number(state.orderSeq) || 0));
    setMeta('active_doc_id', String(state.activeDocId || 'doc-inquiry'));
    setMeta('saved_at', state.savedAt || new Date().toISOString());
    const nextRev = getCurrentRevision() + 1;
    setMeta('revision', String(nextRev));
    d.prepare('INSERT INTO audit_logs (actor, action, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(actor, action, JSON.stringify({
        docs: docs.length, orders: orders.length, revision: nextRev,
      }), nowIso());
    return nextRev;
}

/** 自带事务的整份替换（日常保存走这里） */
export function replaceState(state, opts = {}) {
  return inTransaction(() => replaceStateInTx(state, opts));
}

export function registerStateRoutes(app) {
  app.get('/api/state', async () => {
    const revision = getCurrentRevision();
    if (revision === 0) return { ok: true, revision, state: null };
    return { ok: true, revision, state: assembleState() };
  });

  app.put('/api/state', async (req, reply) => {
    const body = req.body || {};
    const state = body.state;
    if (!state || typeof state !== 'object' || !Array.isArray(state.docs)) {
      reply.code(400).send({ ok: false, message: 'state 形状不对（需要 docs 数组）' });
      return;
    }
    const current = getCurrentRevision();
    const base = body.baseRevision === null || body.baseRevision === undefined
      ? current : Number(body.baseRevision);
    if (Number.isFinite(base) && base < current) {
      reply.code(409).send({
        ok: false, code: 'REVISION_CONFLICT',
        currentRevision: current,
        message: '数据已在其他窗口更新，请刷新拉取最新数据后再改',
      });
      return;
    }
    const revision = replaceState(state, { actor: body.actor || 'local' });
    return { ok: true, revision, savedAt: getMeta('saved_at') };
  });
}
