import React, { useState } from 'react';
import { orderFacts, checkOverAmount, validateShipQty, lineUnitCostWithTax } from './orders.js';
import { isServerAvailable, feishuNotify } from './apiClient.js';
// 订单视图（SPEC 第四节第 9 项）：订单列表 + 详情履约。
// 订单上只存事实（行/收款/付款/已发），应收、应付、未收、未付、
// 发货状态、是否完成全部由 orders.js 现算，这里只负责录入与呈现。
// 录入纪律：
// · 收款超过应收、给某厂付款超过该厂应付 → 先弹提醒，用户明确
//   确认才入账（超额不是禁止，是"必须提醒"，SPEC 原文）；
// · 发货数量硬校验：必须 > 0 且 ≤ 该行待发量，不合法直接给一句
//   白话说明，不入账。
// 飞书播报：登记收款/付款/发货后向群机器人发一句进度（服务器
// 在线且 Webhook 已配置才生效；失败静默，通知绝不挡业务）。
const announce = (text) => {
  if (!isServerAvailable()) return;
  feishuNotify(text).catch(() => { /* 静默 */ });
};
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—');

const th = { textAlign: 'left', padding: '7px 10px', borderBottom: '1px solid #d5dae1', color: '#45515f', fontWeight: 600 };
const td = { padding: '7px 10px', borderBottom: '1px solid #eef1f4', verticalAlign: 'middle' };
const input = { padding: '4px 8px', border: '1px solid #c9d2de', borderRadius: 6 };
const addBtn = {
  border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
  borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
};

function OrderDetail({ order, onUpdateOrder, onJumpInquiry }) {
  const facts = orderFacts(order);
  const [note, setNote] = useState(order.note || '');
  const [recAmount, setRecAmount] = useState('');
  const [recDate, setRecDate] = useState(today());
  const [recNote, setRecNote] = useState('');
  const [payAmounts, setPayAmounts] = useState({});
  const [shipLine, setShipLine] = useState(order.lines[0] ? order.lines[0].lineId : '');
  const [shipQty, setShipQty] = useState('');
  const [msg, setMsg] = useState('');

  function addReceipt() {
    const amt = Number(recAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setMsg('收款金额要填一个正数'); return; }
    const chk = checkOverAmount(order, 'receipt', amt);
    if (chk.over && !window.confirm(
      '这笔收款会超收 ' + chk.overBy.toFixed(2) + ' 元（应收 ' + fmt(facts.receivable) +
      '，已收 ' + fmt(facts.received) + '）。确定要记吗？')) return;
    setMsg('');
    onUpdateOrder({
      ...order,
      receipts: [...(order.receipts || []),
        { amount: amt, date: recDate || today(), note: recNote.trim() }],
    });
    announce('💰 订单 ' + order.orderNo + ' 收款 ' + amt.toFixed(2) +
      ' 元（客户「' + (order.customerName || '未填') + '」，已收 ' +
      fmt(facts.received + amt) + ' / 应收 ' + fmt(facts.receivable) + '）');
    setRecAmount(''); setRecNote('');
  }

  function addPay(factory) {
    const amt = Number(payAmounts[factory]);
    if (!Number.isFinite(amt) || amt <= 0) { setMsg('付款金额要填一个正数'); return; }
    const chk = checkOverAmount(order, 'factoryPay', amt, factory);
    const fac = facts.factories.find((f) => f.factory === factory) || { payable: 0, paid: 0 };
    if (chk.over && !window.confirm(
      '这笔付款会超付 ' + chk.overBy.toFixed(2) + ' 元（「' + factory + '」应付 ' +
      fmt(fac.payable) + '，已付 ' + fmt(fac.paid) + '）。确定要记吗？')) return;
    setMsg('');
    onUpdateOrder({
      ...order,
      factoryPays: [...(order.factoryPays || []),
        { factory, amount: amt, date: today(), note: '' }],
    });
    announce('🧱 订单 ' + order.orderNo + ' 向「' + factory + '」付款 ' + amt.toFixed(2) +
      ' 元（已付 ' + fmt((facts.factories.find((f) => f.factory === factory) || { paid: 0 }).paid + amt) +
      ' / 应付 ' + fmt(fac.payable) + '）');
    setPayAmounts({ ...payAmounts, [factory]: '' });
  }

  function addShip() {
    const line = order.lines.find((l) => l.lineId === shipLine);
    if (!line) { setMsg('先选一行再发货'); return; }
    const v = validateShipQty(line, shipQty);
    if (!v.ok) {
      setMsg('发货数量不对：这行（' + (line.oe || line.lineId) + '）还剩 ' +
        v.remaining + ' 件没发，不能发 ' + (shipQty || '空') + ' 件');
      return;
    }
    const qty = Number(shipQty);
    setMsg('');
    onUpdateOrder({
      ...order,
      lines: order.lines.map((l) => (l.lineId === line.lineId
        ? { ...l, shippedQty: (Number(l.shippedQty) || 0) + qty }
        : l)),
      shipments: [...(order.shipments || []),
        { lineId: line.lineId, oe: line.oe || '', qty, date: today(), note: '' }],
    });
    announce('📦 订单 ' + order.orderNo + ' 发货 ' + qty + ' 件（' +
      (line.oe || line.lineId) + (line.name ? ' · ' + line.name : '') +
      '，已发 ' + (facts.shippedQty + qty) + ' / ' + facts.totalQty + ' 件）');
    setShipQty('');
  }

  return (
    <div className="ord-detail" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <b className="ord-detail-no" style={{ fontSize: 16 }}>{order.orderNo}</b>
        <span>客户：{order.customerName || '（未填）'}</span>
        <span style={{ color: '#666' }}>建单：{(order.createdAt || '').slice(0, 10)}</span>
        <span className="ord-status" style={{
          background: facts.complete ? '#e5f5ec' : '#fdf3e0',
          color: facts.complete ? '#157347' : '#b45309',
          borderRadius: 999, padding: '2px 12px', fontWeight: 600, fontSize: 13,
        }}>{facts.statusText}</span>
        <span className="ord-ship-status" style={{ color: '#666' }}>
          发货：{facts.shipStatus}（{facts.shippedQty}/{facts.totalQty} 件）
        </span>
        {order.inquiryDocId && onJumpInquiry && (
          <button
            className="ord-source-inquiry"
            data-inquiry={order.inquiryDocId}
            onClick={() => onJumpInquiry(order.inquiryDocId)}
            style={{
              border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff',
              borderRadius: 8, padding: '4px 12px', cursor: 'pointer', marginLeft: 'auto',
            }}
          >查看来源询价单</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ color: '#666' }}>订单备注：</span>
        <input
          className="ord-note-input"
          placeholder="这张订单有什么要记的（可空）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ ...input, width: 260 }}
        />
        <button
          className="ord-note-save"
          onClick={() => onUpdateOrder({ ...order, note: note.trim() })}
          style={{
            border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
            borderRadius: 8, padding: '4px 14px', cursor: 'pointer',
          }}
        >保存备注</button>
      </div>

      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={th}>OE 码</th><th style={th}>品名</th><th style={th}>工厂</th>
            <th style={{ ...th, textAlign: 'right' }}>数量</th>
            <th style={{ ...th, textAlign: 'right' }}>成本（含税）</th>
            <th style={{ ...th, textAlign: 'right' }}>售价</th>
            <th style={{ ...th, textAlign: 'right' }}>已发</th>
            <th style={{ ...th, textAlign: 'right' }}>待发</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.lineId} className="ord-line-row" data-line={l.lineId}>
              <td style={td}>{l.oe || '—'}</td>
              <td style={td}>{l.name || '—'}</td>
              <td style={td}>{l.factory || '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}>{l.qty}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                {fmt(lineUnitCostWithTax(l))}
                <span style={{ color: '#999' }}>（原 {l.costRaw}{l.costTaxInclusive ? ' 含税' : ' 不含税'}）</span>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{fmt(l.finalPrice)}</td>
              <td className="ord-line-shipped" style={{ ...td, textAlign: 'right' }}>{l.shippedQty || 0}</td>
              <td style={{ ...td, textAlign: 'right' }}>{Math.max(0, (Number(l.qty) || 0) - (Number(l.shippedQty) || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
        <div className="ord-receipts" style={{ minWidth: 320, flex: '1 1 320px' }}>
          <b>客户收款</b>
          <div style={{ color: '#444', margin: '4px 0' }}>
            应收 <span className="ord-fact-receivable" style={{ fontWeight: 700, fontSize: 15 }}>{fmt(facts.receivable)}</span> ·
            已收 <span className="ord-fact-received">{fmt(facts.received)}</span> ·
            未收 <span className="ord-fact-unpaid" style={{
              fontWeight: 600, color: facts.unpaid > 0 ? '#d92d20' : '#1e9e57',
            }}>{fmt(facts.unpaid)}</span>
          </div>
          {(order.receipts || []).map((r, i) => (
            <div key={i} style={{ color: '#666' }}>
              {r.date} · 收 {fmt(r.amount)}{r.note ? ' · ' + r.note : ''}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <input className="ord-receipt-amount" type="number" min="0" placeholder="金额"
              value={recAmount} onChange={(e) => setRecAmount(e.target.value)}
              style={{ ...input, width: 110 }} />
            <input className="ord-receipt-date" type="date"
              value={recDate} onChange={(e) => setRecDate(e.target.value)} style={input} />
            <input className="ord-receipt-note" placeholder="备注（可空）"
              value={recNote} onChange={(e) => setRecNote(e.target.value)}
              style={{ ...input, width: 120 }} />
            <button className="ord-receipt-add" onClick={addReceipt} style={addBtn}>记一笔收款</button>
          </div>
        </div>

        <div className="ord-pays" style={{ minWidth: 320, flex: '1 1 320px' }}>
          <b>给工厂的付款（按工厂分开记）</b>
          <div style={{ color: '#444', margin: '4px 0' }}>
            应付合计 <span className="ord-fact-payable">{fmt(facts.payable)}</span> ·
            已付 <span className="ord-fact-paid">{fmt(facts.paid)}</span> ·
            未付 <span className="ord-fact-unpaidpay">{fmt(facts.unpaidPay)}</span>
          </div>
          {facts.factories.map((f) => (
            <div key={f.factory} className="ord-factory-pay" data-factory={f.factory}
              style={{ borderTop: '1px dashed #e0e4e9', padding: '6px 0' }}>
              <div>
                {f.factory}：应付 <span className="ord-fac-payable">{fmt(f.payable)}</span> ·
                已付 <span className="ord-fac-paid">{fmt(f.paid)}</span> ·
                未付 <span className="ord-fac-unpaid">{fmt(f.unpaid)}</span>
              </div>
              {(order.factoryPays || []).filter((p) => p.factory === f.factory).map((p, i) => (
                <div key={i} style={{ color: '#666' }}>{p.date} · 付 {fmt(p.amount)}{p.note ? ' · ' + p.note : ''}</div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input className="ord-pay-amount" type="number" min="0" placeholder="金额"
                  value={payAmounts[f.factory] ?? ''}
                  onChange={(e) => setPayAmounts({ ...payAmounts, [f.factory]: e.target.value })}
                  style={{ ...input, width: 110 }} />
                <button className="ord-pay-add" onClick={() => addPay(f.factory)} style={addBtn}>
                  记一笔付款
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="ord-shipping" style={{ minWidth: 300, flex: '1 1 300px' }}>
          <b>发货（可分批）</b>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <select className="ord-ship-line" value={shipLine}
              onChange={(e) => setShipLine(e.target.value)} style={input}>
              {order.lines.map((l) => (
                <option key={l.lineId} value={l.lineId}>
                  {(l.oe || l.lineId) + '（剩 ' + Math.max(0, (Number(l.qty) || 0) - (Number(l.shippedQty) || 0)) + '）'}
                </option>
              ))}
            </select>
            <input className="ord-ship-qty" type="number" min="1" placeholder="件数"
              value={shipQty} onChange={(e) => setShipQty(e.target.value)}
              style={{ ...input, width: 80 }} />
            <button className="ord-ship-add" onClick={addShip} style={addBtn}>记发货</button>
          </div>
          {(order.shipments || []).map((s, i) => (
            <div key={i} style={{ color: '#666', marginTop: 4 }}>
              {s.date} · {s.oe || s.lineId} 发 {s.qty} 件
            </div>
          ))}
        </div>
      </div>
      {msg && <div className="ord-msg" style={{ color: '#d92d20', marginTop: 10 }}>{msg}</div>}
    </div>
  );
}

export default function OrdersView({
  orders, selectedNo, onSelect, onUpdateOrder, onClose, onJumpInquiry,
  guidance, onGuidance,
}) {
  // 按客户过滤（包 11）：历史单多了之后先按客户收窄再找单
  const [custFilter, setCustFilter] = useState('');
  const custNames = [...new Set((orders || []).map((o) => o.customerName || '（未填）'))];
  const filtered = (orders || []).filter(
    (o) => !custFilter || (o.customerName || '（未填）') === custFilter);
  const selected = filtered.find((o) => o.orderNo === selectedNo) || filtered[0] || null;
  return (
    <div className="orders-view" style={{
      fontFamily: 'sans-serif', fontSize: 14, padding: '16px 18px',
      overflow: 'hidden', flex: 1, background: '#fff',
      margin: '14px 16px 16px', border: '1px solid #dbe2ec', borderRadius: 14,
      boxShadow: '0 2px 6px rgba(23,34,62,0.05), 0 10px 24px rgba(23,34,62,0.06)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div className="ord-toolbar" style={{
        display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 12,
        borderBottom: '1px solid #e6ebf2',
      }}>
        <b className="sec-title" style={{ fontSize: 17 }}>订单</b>
        <span style={{ color: '#666' }}>共 {(orders || []).length} 张 · 状态都是按收款/发货事实现算的</span>
        <select
          className="ord-customer-filter"
          value={custFilter}
          onChange={(e) => setCustFilter(e.target.value)}
          style={{ padding: '3px 4px' }}
          title="按客户过滤订单"
        >
          <option value="">全部客户</option>
          {custNames.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto' }} />
        <button onClick={onClose} style={{
          border: '1px solid #c9d2de', color: '#37404a', background: '#fff', borderRadius: 8,
          padding: '5px 12px', cursor: 'pointer',
        }}>返回表格</button>
      </div>
      <div className="ord-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {(orders || []).length === 0 && guidance && (
        <div className="ord-guide" style={{
          border: '1px solid #eed9ac', background: '#fdf3e0', borderRadius: 12,
          padding: '12px 14px', marginTop: 10, maxWidth: 760,
        }}>
          <div className="ord-guide-text" style={{ fontSize: 13.5 }}>{guidance.text}</div>
          <button
            className="ord-guide-btn"
            onClick={onGuidance}
            style={{
              border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
              borderRadius: 8, padding: '6px 18px', cursor: 'pointer', marginTop: 10,
            }}
          >{guidance.buttonText}</button>
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={th}>订单号</th><th style={th}>客户</th>
            <th style={{ ...th, textAlign: 'right' }}>应收</th>
            <th style={{ ...th, textAlign: 'right' }}>已收</th>
            <th style={{ ...th, textAlign: 'right' }}>未收</th>
            <th style={th}>发货</th><th style={th}>状态</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((o) => {
            const f = orderFacts(o);
            const active = selected && o.orderNo === selected.orderNo;
            return (
              <tr key={o.orderNo} className="ord-row" data-no={o.orderNo}
                onClick={() => onSelect(o.orderNo)}
                style={{ cursor: 'pointer', background: active ? '#e8effe' : undefined }}>
                <td className="ord-no" style={td}>
                  {o.orderNo}
                  {o.note ? (
                    <div className="ord-note" title={o.note} style={{
                      color: '#888', fontSize: 12, fontWeight: 400,
                      maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>备注：{o.note}</div>
                  ) : null}
                </td>
                <td className="ord-customer" style={td}>{o.customerName || '（未填）'}</td>
                <td className="ord-list-receivable" style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(f.receivable)}</td>
                <td className="ord-list-received" style={{ ...td, textAlign: 'right' }}>{fmt(f.received)}</td>
                <td className="ord-list-unpaid" style={{
                  ...td, textAlign: 'right',
                  color: f.unpaid > 0 ? '#d92d20' : '#1e9e57',
                  fontWeight: f.unpaid !== 0 ? 600 : 400,
                }}>{fmt(f.unpaid)}</td>
                <td className="ord-list-ship" style={td}>
                  <span className={'pill ' + (
                    f.shipStatus === '已发完' ? 'pill-green'
                    : f.shipStatus === '部分发货' ? 'pill-amber' : 'pill-gray'
                  )}>{f.shipStatus}</span>
                </td>
                <td className="ord-list-status" style={td}>
                  <span className={'pill ' + (f.complete ? 'pill-green' : 'pill-blue')}>
                    {f.statusText}
                  </span>
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (orders || []).length > 0 && (
            <tr><td style={td} colSpan={7}>
              <span style={{ color: '#999' }}>
                这个客户名下还没有订单——换个客户或选「全部客户」看看。
              </span>
            </td></tr>
          )}
        </tbody>
      </table>
      {selected && (
        <OrderDetail
          key={selected.orderNo}
          order={selected}
          onUpdateOrder={onUpdateOrder}
          onJumpInquiry={onJumpInquiry}
        />
      )}
      </div>
    </div>
  );
}
