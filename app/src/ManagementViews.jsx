import React, { useState } from 'react';
import { orderSummary } from './registry.js';

// 客户管理 / 工厂管理（包 11）：注册表维护 + 数据联动的"看得见"——
// 点一个客户/工厂，立刻看到它名下的询价单、报价单、订单，点任意
// 一条就跳过去。数字由 registry.js 现算传入，本组件只负责呈现与
// 收集输入；改名/删除的规则判断（同步范围、能不能删）在主程序 +
// registry.js 里，这里只管把结果（弹窗原因）递给用户看。

const money = (n) => (Number(n) || 0).toFixed(2);
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
const input = { padding: '5px 8px', border: '1px solid #c9d2de', borderRadius: 6 };
const btn = {
  border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
  borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
};
const btnGhost = { ...btn, background: '#fff', color: '#2f6bff' };
const btnDanger = { ...btn, background: '#fff', color: '#d92d20', border: '1px solid #d92d20' };
const wrap = {
  flex: 1, overflow: 'auto', padding: '16px 18px',
  fontFamily: 'sans-serif', fontSize: 14,
};
const linkRow = {
  cursor: 'pointer', color: '#2f6bff', padding: '3px 0',
  borderBottom: '1px dashed #e3e8ee',
};
const fmtDate = (iso) => {
  if (!iso) return '历史单据';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '历史单据' : d.toLocaleDateString('zh-CN');
};

/* ---------------- 客户管理 ---------------- */

function CustomerDetail({ item, onRename, onUpdateInfo, onDelete, onJumpInquiry, onJumpOrder }) {
  const { entry, inquiries, orders } = item;
  const [contact, setContact] = useState(entry.contact || '');
  const [note, setNote] = useState(entry.note || '');
  const [newName, setNewName] = useState(entry.name);
  return (
    <div className="cust-detail" style={{
      marginTop: 12, border: '1px solid #dbe2ec', borderRadius: 12,
      background: '#fff', padding: '14px 18px', maxWidth: 1120,
    }}>
      <b className="cust-detail-name" style={{ fontSize: 16 }}>{entry.name}</b>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
        <div style={{ flex: '1 1 300px' }}>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>基本信息（联系人与备注）</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ color: '#666' }}>联系人
              <input className="cust-contact-input" placeholder="联系人"
                value={contact} onChange={(e) => setContact(e.target.value)}
                style={{ ...input, width: 130, marginLeft: 4 }} />
            </label>
            <label style={{ color: '#666' }}>备注
              <input className="cust-note-input" placeholder="备注（账期、习惯等）"
                value={note} onChange={(e) => setNote(e.target.value)}
                style={{ ...input, width: 190, marginLeft: 4 }} />
            </label>
            <button className="cust-info-save" style={btn}
              onClick={() => onUpdateInfo(entry.name, { contact: contact.trim(), note: note.trim() })}>
              保存信息
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
            <input className="cust-rename-input" placeholder="新客户名"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              style={{ ...input, width: 160 }} />
            <button className="cust-rename-btn" style={btnGhost}
              onClick={() => onRename(entry.name, newName)}>
              改名（询价单与订单一起改）
            </button>
            <button className="cust-delete-btn" style={btnDanger}
              onClick={() => onDelete(entry.name)}>
              删除客户
            </button>
          </div>
          <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>
            删除规则：名下有询价单或订单的客户删不掉（历史要留着查账）。
          </div>
        </div>
        <div style={{ flex: '1 1 300px' }}>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>
            他的询价单（{inquiries.length}）— 点一条跳到那张单
          </div>
          {inquiries.map((q) => (
            <div key={q.docId} className="cust-inq-row" data-doc-id={q.docId}
              style={linkRow} onClick={() => onJumpInquiry(q.docId)}>
              {fmtDate(q.createdAt)} · {q.status}
              {q.sourceFileName ? ' · ' + q.sourceFileName : ''}
              {q.note ? (
                <span className="cust-inq-note" style={{ color: '#888' }}> · 备注：{q.note}</span>
              ) : null}
            </div>
          ))}
          {inquiries.length === 0 && <div style={{ color: '#bbb' }}>还没有询价单</div>}
          <div style={{ color: '#888', fontSize: 12, margin: '10px 0 4px' }}>
            他的订单（{orders.length}）— 点一条跳到订单详情
          </div>
          {orders.map((o) => {
            const s = orderSummary(o);
            return (
              <div key={s.orderNo} className="cust-ord-row" data-no={s.orderNo}
                style={linkRow} onClick={() => onJumpOrder(s.orderNo)}>
                {s.orderNo} · 应收 {money(s.receivable)} · {s.statusText}
              </div>
            );
          })}
          {orders.length === 0 && <div style={{ color: '#bbb' }}>还没有订单</div>}
        </div>
      </div>
    </div>
  );
}

export function CustomersView({
  model, selectedName, onSelect, onAdd, onRename, onUpdateInfo, onDelete,
  onJumpInquiry, onJumpOrder, onClose,
}) {
  const [addName, setAddName] = useState('');
  const sel = (model || []).find((m) => m.entry.name === selectedName) || null;
  return (
    <div className="customers-view" style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b className="sec-title" style={{ fontSize: 19 }}>客户管理</b>
        <span style={{ color: '#888' }}>点客户看它名下的询价单与订单；改名会同步到所有单据</span>
        <button className="cust-close" onClick={onClose} style={{
          marginLeft: 'auto', border: '1px solid #c9d2de', color: '#37404a', background: '#fff',
          borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
        }}>返回表格</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12, alignItems: 'center' }}>
        <input className="cust-add-input" placeholder="新客户名"
          value={addName} onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && addName.trim()) { onAdd(addName); setAddName(''); } }}
          style={{ ...input, width: 180 }} />
        <button className="cust-add-btn" style={btn}
          onClick={() => { if (addName.trim()) { onAdd(addName); setAddName(''); } }}>
          新增客户
        </button>
      </div>
      {(model || []).length === 0 ? (
        <div className="cust-empty" style={{ color: '#888', marginTop: 12 }}>
          还没有客户——在上面新增，或在询价单上给客户起名，这里会自动出现。
        </div>
      ) : (
        <div className="ledger-card" style={{ marginTop: 10 }}>
        <table className="cust-table" style={{ borderCollapse: 'collapse', background: '#fff', width: '100%' }}>
          <thead>
            <tr>
              <th style={thL}>客户</th><th style={thL}>备注</th><th style={th}>询价单</th><th style={th}>订单</th>
              <th style={th}>应收</th><th style={th}>已收</th><th style={th}>未收</th>
            </tr>
          </thead>
          <tbody>
            {(model || []).map((m) => (
              <tr key={m.entry.name} className="cust-row" data-customer={m.entry.name}
                onClick={() => onSelect(m.entry.name)}
                style={{
                  cursor: 'pointer',
                  background: sel && sel.entry.name === m.entry.name ? '#e8effe' : 'transparent',
                }}>
                <td style={tdL}>{m.entry.name}</td>
                <td style={{ ...tdL, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  className="cust-note" title={m.entry.note || ''}>
                  {m.entry.note || '—'}
                </td>
                <td style={td} className="cust-inq-count">{m.stats.inquiries}</td>
                <td style={td} className="cust-ord-count">{m.stats.orders}</td>
                <td style={td} className="cust-receivable">{money(m.stats.receivable)}</td>
                <td style={td}>{money(m.stats.received)}</td>
                <td style={td} className="cust-unpaid">{money(m.stats.unpaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {sel && (
        <CustomerDetail
          key={sel.entry.name}
          item={sel}
          onRename={onRename}
          onUpdateInfo={onUpdateInfo}
          onDelete={onDelete}
          onJumpInquiry={onJumpInquiry}
          onJumpOrder={onJumpOrder}
        />
      )}
    </div>
  );
}

/* ---------------- 工厂管理 ---------------- */

function FactoryDetail({ item, onRename, onUpdateInfo, onDelete, onJumpDoc, onJumpOrder }) {
  const [newName, setNewName] = useState(item.name);
  const [contact, setContact] = useState((item.info && item.info.contact) || '');
  const [note, setNote] = useState((item.info && item.info.note) || '');
  return (
    <div className="fac-detail" style={{
      marginTop: 12, border: '1px solid #dbe2ec', borderRadius: 12,
      background: '#fff', padding: '14px 18px', maxWidth: 1120,
    }}>
      <b className="fac-detail-name" style={{ fontSize: 16 }}>{item.name}</b>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
        <div style={{ flex: '1 1 300px' }}>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>基本信息（联系人与备注）</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ color: '#666' }}>联系人
              <input className="fac-contact-input" placeholder="联系人"
                value={contact} onChange={(e) => setContact(e.target.value)}
                style={{ ...input, width: 130, marginLeft: 4 }} />
            </label>
            <label style={{ color: '#666' }}>备注
              <input className="fac-note-input" placeholder="备注（账期、习惯等）"
                value={note} onChange={(e) => setNote(e.target.value)}
                style={{ ...input, width: 190, marginLeft: 4 }} />
            </label>
            <button className="fac-info-save" style={btn}
              onClick={() => onUpdateInfo(item.name, { contact: contact.trim(), note: note.trim() })}>
              保存信息
            </button>
          </div>
          <div style={{ color: '#888', fontSize: 12, margin: '12px 0 4px' }}>改名 / 删除</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="fac-rename-input" placeholder="新工厂名"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              style={{ ...input, width: 160 }} />
            <button className="fac-rename-btn" style={btnGhost}
              onClick={() => onRename(item.name, newName)}>
              改名（报价单、定厂与订单一起改）
            </button>
            <button className="fac-delete-btn" style={btnDanger}
              onClick={() => onDelete(item.name)}>
              删除工厂
            </button>
          </div>
          <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>
            删除规则：名下有报价单、定厂记录或订单引用的工厂删不掉。
          </div>
        </div>
        <div style={{ flex: '1 1 300px' }}>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>
            它的报价单（{item.quoteDocs.length}）— 点一条跳到那张单
          </div>
          {item.quoteDocs.map((q) => (
            <div key={q.docId} className="fac-quote-row" data-doc-id={q.docId}
              style={linkRow} onClick={() => onJumpDoc(q.docId)}>
              报价单 · {item.name}
            </div>
          ))}
          {item.quoteDocs.length === 0 && <div style={{ color: '#bbb' }}>还没有报价单</div>}
          <div style={{ color: '#888', fontSize: 12, margin: '10px 0 4px' }}>
            与它有关的订单（{item.orders.length}）— 点一条跳到订单详情
          </div>
          {item.orders.map((o) => {
            const s = orderSummary(o);
            return (
              <div key={s.orderNo} className="fac-ord-row" data-no={s.orderNo}
                style={linkRow} onClick={() => onJumpOrder(s.orderNo)}>
                {s.orderNo} · 客户 {s.customerName || '（未填）'} · 应收 {money(s.receivable)} · {s.statusText}
              </div>
            );
          })}
          {item.orders.length === 0 && <div style={{ color: '#bbb' }}>还没有订单</div>}
        </div>
      </div>
    </div>
  );
}

export function FactoriesView({
  model, selectedName, onSelect, onAdd, onRename, onUpdateInfo, onDelete,
  onJumpDoc, onJumpOrder, onClose,
}) {
  const [addName, setAddName] = useState('');
  const sel = (model || []).find((m) => m.name === selectedName) || null;
  return (
    <div className="factories-view" style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b className="sec-title" style={{ fontSize: 19 }}>工厂管理</b>
        <span style={{ color: '#888' }}>点工厂看它的报价单与订单；改名会同步到所有单据</span>
        <button className="fac-close" onClick={onClose} style={{
          marginLeft: 'auto', border: '1px solid #c9d2de', color: '#37404a', background: '#fff',
          borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
        }}>返回表格</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12, alignItems: 'center' }}>
        <input className="fac-add-input" placeholder="新工厂名"
          value={addName} onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && addName.trim()) { onAdd(addName); setAddName(''); } }}
          style={{ ...input, width: 180 }} />
        <button className="fac-add-btn" style={btn}
          onClick={() => { if (addName.trim()) { onAdd(addName); setAddName(''); } }}>
          新增工厂
        </button>
        <span style={{ color: '#999', fontSize: 12 }}>（在表格工作区「发给工厂」时新建的工厂也会出现在这里）</span>
      </div>
      {(model || []).length === 0 ? (
        <div className="fac-empty" style={{ color: '#888', marginTop: 12 }}>
          还没有工厂——在上面新增，或在表格工作区新建工厂，这里会自动出现。
        </div>
      ) : (
        <div className="ledger-card" style={{ marginTop: 10 }}>
        <table className="fac-table" style={{ borderCollapse: 'collapse', background: '#fff', width: '100%' }}>
          <thead>
            <tr>
              <th style={thL}>工厂</th><th style={thL}>备注</th><th style={th}>报价单</th><th style={th}>订单行</th>
              <th style={th}>应付</th><th style={th}>已付</th><th style={th}>未付</th>
            </tr>
          </thead>
          <tbody>
            {(model || []).map((m) => (
              <tr key={m.name} className="fac-row" data-factory={m.name}
                onClick={() => onSelect(m.name)}
                style={{
                  cursor: 'pointer',
                  background: sel && sel.name === m.name ? '#e8effe' : 'transparent',
                }}>
                <td style={tdL}>{m.name}</td>
                <td style={{ ...tdL, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  className="fac-note" title={(m.info && m.info.note) || ''}>
                  {(m.info && m.info.note) || '—'}
                </td>
                <td style={td} className="fac-quotes-count">{m.stats.quotes}</td>
                <td style={td} className="fac-lines-count">{m.stats.orderLines}</td>
                <td style={td} className="fac-payable">{money(m.stats.payable)}</td>
                <td style={td}>{money(m.stats.paid)}</td>
                <td style={td} className="fac-unpaid">{money(m.stats.unpaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {sel && (
        <FactoryDetail
          key={sel.name}
          item={sel}
          onRename={onRename}
          onUpdateInfo={onUpdateInfo}
          onDelete={onDelete}
          onJumpDoc={onJumpDoc}
          onJumpOrder={onJumpOrder}
        />
      )}
    </div>
  );
}
