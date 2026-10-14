import React from 'react';

// 总览 + 客户/工厂台账（SPEC 第四节第 10 项）：数字全部由
// overview.js 从业务数据现算后传入，本组件只负责摆出来。
// 包 11 起台账行可点：点客户/工厂行直接跳进对应的管理页详情
// （增删改名在管理页做，这里仍只负责"看 + 跳"）。

function money(n) {
  const v = Number(n) || 0;
  return v.toFixed(2);
}

const th = {
  textAlign: 'right', padding: '8px 12px', borderBottom: '1px solid #dbe2ec',
  background: '#edf1f7',
  color: '#45515f', fontWeight: 600, whiteSpace: 'nowrap',
};
const thL = { ...th, textAlign: 'left' };
const td = {
  textAlign: 'right', padding: '8px 12px', borderBottom: '1px solid #eef1f4', whiteSpace: 'nowrap',
};
const tdL = { ...td, textAlign: 'left' };
const card = {
  border: '1px solid #dbe2ec', borderRadius: 12, padding: '14px 18px',
  background: '#fff', minWidth: 150,
};
const kpiNum = { fontSize: 25, fontWeight: 700, marginTop: 4, lineHeight: 1.15 };
const kpiLab = { color: '#7c8a9d', fontSize: 12.5 };

export default function OverviewView({ overview, onClose, onOpenCustomer, onOpenFactory }) {
  if (!overview) return null;
  const { counts, totals, customers, factories } = overview;
  return (
    <div className="overview-view" style={{
      flex: 1, overflow: 'auto', padding: '16px 18px',
      fontFamily: 'sans-serif', fontSize: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b className="sec-title" style={{ fontSize: 19 }}>总览</b>
        <span style={{ color: '#888' }}>全部数字由单据现算，不存副本</span>
        <button className="ov-close" onClick={onClose} style={{
          marginLeft: 'auto', border: '1px solid #c9d2de', color: '#37404a', background: '#fff',
          borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
        }}>返回表格</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>询价单 / 报价单 / 订单</div>
          <div className="ov-counts" style={{ ...kpiNum, fontSize: 22 }}>
            {counts.inquiries} / {counts.quotes} / {counts.orders}
          </div>
        </div>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>总应收（客户欠我们）</div>
          <div className="ov-total-receivable" style={kpiNum}>{money(totals.receivable)}</div>
        </div>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>已收</div>
          <div className="ov-total-received" style={{ ...kpiNum, color: '#157347' }}>{money(totals.received)}</div>
        </div>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>未收</div>
          <div className="ov-total-unpaid" style={{
            ...kpiNum, color: totals.unpaid > 0 ? '#d92d20' : '#157347',
          }}>{money(totals.unpaid)}</div>
        </div>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>总应付（我们欠工厂）</div>
          <div className="ov-total-payable" style={kpiNum}>{money(totals.payable)}</div>
        </div>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>未付</div>
          <div className="ov-total-unpaidpay" style={{
            ...kpiNum, color: totals.unpaidPay > 0 ? '#d92d20' : '#157347',
          }}>{money(totals.unpaidPay)}</div>
        </div>
        <div className="ov-card" style={card}>
          <div style={kpiLab}>待发货（行）</div>
          <div className="ov-total-pending-ship" style={kpiNum}>{totals.pendingShipLines}</div>
        </div>
      </div>

      <h3 className="sec-title" style={{ margin: '20px 0 10px', fontSize: 16 }}>
        客户台账
        {onOpenCustomer && <span style={{ color: '#999', fontSize: 12, fontWeight: 400 }}>（点一行进客户管理）</span>}
      </h3>
      {customers.length === 0 ? (
        <div className="ov-customers-empty" style={{ color: '#888' }}>
          还没有客户（在询价单上填客户名、或转出订单后，这里自动出现）
        </div>
      ) : (
        <div className="ledger-card">
        <table className="ov-customers" style={{ borderCollapse: 'collapse', background: '#fff', width: '100%' }}>
          <thead>
            <tr>
              <th style={thL}>客户</th><th style={th}>询价单</th><th style={th}>订单</th>
              <th style={th}>应收</th><th style={th}>已收</th><th style={th}>未收</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.name} className="ov-customer-row" data-customer={c.name}
                onClick={onOpenCustomer && c.name !== '（未填客户名）'
                  ? () => onOpenCustomer(c.name) : undefined}
                style={onOpenCustomer && c.name !== '（未填客户名）' ? { cursor: 'pointer' } : undefined}>
                <td style={tdL}>{c.name}</td>
                <td style={td} className="ov-c-inq">{c.inquiries}</td>
                <td style={td} className="ov-c-orders">{c.orders}</td>
                <td style={td} className="ov-c-receivable">{money(c.receivable)}</td>
                <td style={td} className="ov-c-received">{money(c.received)}</td>
                <td style={td} className="ov-c-unpaid">{money(c.unpaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h3 className="sec-title" style={{ margin: '22px 0 10px', fontSize: 16 }}>
        工厂台账
        {onOpenFactory && <span style={{ color: '#999', fontSize: 12, fontWeight: 400 }}>（点一行进工厂管理）</span>}
      </h3>
      {factories.length === 0 ? (
        <div className="ov-factories-empty" style={{ color: '#888' }}>
          还没有工厂（在文档栏新建工厂、发出报价单后，这里自动出现）
        </div>
      ) : (
        <div className="ledger-card">
        <table className="ov-factories" style={{ borderCollapse: 'collapse', background: '#fff', width: '100%' }}>
          <thead>
            <tr>
              <th style={thL}>工厂</th><th style={th}>报价单</th><th style={th}>订单行</th>
              <th style={th}>应付</th><th style={th}>已付</th><th style={th}>未付</th>
            </tr>
          </thead>
          <tbody>
            {factories.map((f) => (
              <tr key={f.name} className="ov-factory-row" data-factory={f.name}
                onClick={onOpenFactory ? () => onOpenFactory(f.name) : undefined}
                style={onOpenFactory ? { cursor: 'pointer' } : undefined}>
                <td style={tdL}>{f.name}</td>
                <td style={td} className="ov-f-quotes">{f.quotes}</td>
                <td style={td} className="ov-f-lines">{f.orderLines}</td>
                <td style={td} className="ov-f-payable">{money(f.payable)}</td>
                <td style={td} className="ov-f-paid">{money(f.paid)}</td>
                <td style={td} className="ov-f-unpaid">{money(f.unpaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
