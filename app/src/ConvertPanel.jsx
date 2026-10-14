import React, { useMemo, useState } from 'react';
// 转订单面板（SPEC 第四节第 8 项）：列出已定厂的行，逐行填数量转成
// 正式订单。规矩：
// · 只有「已定厂 + 有最终价」的行可转；已在别的订单里转过的行标
//   「已转订单（单号）」并禁选——重复转单在界面上就拦住，数据依据
//   是 orders.js 的 convertedLineIds（由订单现算，不另存状态）。
// · 纳入条件 = 勾选 且 数量 > 0；数量留空的行不转（客户只成交
//   一部分是常态，余量下次还能转）。
// · 「全部填」是用户明确点击的批量动作：给所有可转行填同一个数量，
//   填完仍可逐行改（底线 5）。
export default function ConvertPanel({ rows, customerName, onCreate, onClose, sheetQtys, qtyColumnName, onViewOrder }) {
  // 包 14：生成成功后不再自动跳走——面板里出成功提示，用户点
  // 「查看这张订单」再跳到订单页看那一张（onCreate 返回新单号）。
  const [createdNo, setCreatedNo] = useState(null);
  // 数量预填（包 12）：询价单自带数量列时，父组件按 lineId 把表内
  // 数量传进来（sheetQtys），面板一打开就带入——带入值仍可逐行改。
  const [qtys, setQtys] = useState(() => {
    const init = {};
    if (sheetQtys) {
      for (const r of rows) {
        const q = sheetQtys.get(r.lineId);
        if (q !== undefined && q !== null) init[r.lineId] = String(q);
      }
    }
    return init;
  });
  const [checks, setChecks] = useState({});
  const [bulkQty, setBulkQty] = useState('');

  const checkedOf = (r) => checks[r.lineId] !== false;
  const qtyOf = (r) => {
    const n = Number(qtys[r.lineId]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const included = useMemo(
    () => rows.filter((r) => r.convertible && checkedOf(r) && qtyOf(r) > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, qtys, checks]);
  const totalQty = included.reduce((s, r) => s + qtyOf(r), 0);
  const totalAmount = included.reduce((s, r) => s + Math.round(r.finalPrice * qtyOf(r) * 100) / 100, 0);

  function handleCreate() {
    const no = onCreate(included.map((r) => ({ row: r, qty: qtyOf(r) })));
    if (no) setCreatedNo(no);
  }

  function applyBulk() {
    const n = Number(bulkQty);
    if (!Number.isFinite(n) || n <= 0) return;
    const next = { ...qtys };
    for (const r of rows) if (r.convertible) next[r.lineId] = String(bulkQty);
    setQtys(next);
  }

  const th = { textAlign: 'left', padding: '7px 10px', borderBottom: '1px solid #d5dae1', color: '#45515f', fontWeight: 600 };
  const td = { padding: '7px 10px', borderBottom: '1px solid #eef1f4', verticalAlign: 'middle' };
  const input = { width: 70, padding: '4px 6px', border: '1px solid #c9d2de', borderRadius: 6 };

  return (
    <div className="convert-panel" style={{
      fontFamily: 'sans-serif', fontSize: 14, padding: '12px 14px',
      margin: '10px 14px 0', border: '1px solid #dbe2ec', borderLeft: '4px solid #d97706', borderRadius: 12,
      background: '#fff', boxShadow: '0 1px 3px rgba(23,34,62,0.05)',
      maxHeight: '46vh', overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ color: '#b45309' }}>转订单</b>
        <span style={{ color: '#666' }}>
          客户：{customerName || '（还没填客户名，先在上面填）'} ·
          只列已定厂的行；数量留空 = 这行先不转，之后还能再转
        </span>
        {qtyColumnName && (
          <span className="conv-qty-note" style={{ color: '#1e9e57' }}>
            数量已按「{qtyColumnName}」列带入，不对的直接改
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} />
        <span style={{ color: '#555' }}>全部填：</span>
        <input
          className="conv-bulk-qty" type="number" min="1" placeholder="数量"
          value={bulkQty}
          onChange={(e) => setBulkQty(e.target.value)}
          style={{ width: 70, padding: '4px 6px', border: '1px solid #c9d2de', borderRadius: 6 }}
        />
        <button className="conv-bulk-apply" onClick={applyBulk} style={{
          border: '1px solid #888', color: '#444', background: '#fff', borderRadius: 8,
          padding: '3px 10px', cursor: 'pointer',
        }}>填到所有可转行</button>
        <button onClick={onClose} style={{
          border: '1px solid #888', color: '#444', background: '#fff', borderRadius: 8,
          padding: '3px 10px', cursor: 'pointer',
        }}>收起</button>
      </div>
      {createdNo && (
        <div className="conv-success" style={{
          border: '1px solid #9ec49a', background: '#e5f5ec', borderRadius: 10,
          padding: '8px 12px', marginTop: 8, display: 'flex', gap: 10,
          alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span className="conv-success-text">订单 <b>{createdNo}</b> 已生成。</span>
          <button
            className="conv-view-order"
            onClick={() => onViewOrder && onViewOrder(createdNo)}
            style={{
              border: '1px solid #1e9e57', background: '#1e9e57', color: '#fff',
              borderRadius: 8, padding: '4px 14px', cursor: 'pointer',
            }}
          >查看这张订单</button>
          <button
            className="conv-success-more"
            onClick={() => setCreatedNo(null)}
            style={{
              border: '1px solid #1e9e57', background: '#fff', color: '#1e9e57',
              borderRadius: 8, padding: '4px 14px', cursor: 'pointer',
            }}
          >继续转其他行</button>
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 34 }}>转</th>
            <th style={th}>OE 码</th>
            <th style={th}>产品</th>
            <th style={th}>定厂</th>
            <th style={{ ...th, textAlign: 'right' }}>工厂价</th>
            <th style={{ ...th, textAlign: 'right' }}>
              最终报价
              <div style={{ fontWeight: 400, fontSize: 11, color: '#999' }}>（按定厂工厂价算）</div>
            </th>
            <th style={{ ...th, width: 110 }}>数量</th>
            <th style={th}>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const qty = qtyOf(r);
            return (
              <tr key={r.lineId} className="conv-row" data-line={r.lineId}>
                <td style={td}>
                  <input
                    type="checkbox" className="conv-check"
                    checked={r.convertible && checkedOf(r)}
                    disabled={!r.convertible}
                    onChange={(e) => setChecks({ ...checks, [r.lineId]: e.target.checked })}
                  />
                </td>
                <td style={td}>{r.oe || '—'}</td>
                <td style={td}>{r.product || '—'}</td>
                <td style={td}>{r.choice ? r.choice.factory : '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {r.choice ? r.choice.rawPrice : '—'}
                  {r.choice ? (r.choice.taxInclusive ? '（含税）' : '（不含税）') : ''}
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {r.finalPrice !== null && r.finalPrice !== undefined ? r.finalPrice.toFixed(2) : '—'}
                  {r.breakdown && (
                    <div className="conv-breakdown" style={{
                      textAlign: 'left', fontSize: 11, color: '#888',
                      maxWidth: 360, whiteSpace: 'normal', lineHeight: 1.5,
                    }}>{r.breakdown}</div>
                  )}
                </td>
                <td style={td}>
                  <input
                    type="number" min="1" className="conv-qty" data-line={r.lineId}
                    placeholder="不转就留空"
                    value={qtys[r.lineId] ?? ''}
                    disabled={!r.convertible}
                    onChange={(e) => setQtys({ ...qtys, [r.lineId]: e.target.value })}
                    style={input}
                  />
                </td>
                <td style={td}>
                  {r.convertedTo
                    ? <span className="conv-converted" style={{ color: '#1e9e57' }}>已转订单 {r.convertedTo}</span>
                    : r.convertible
                      ? (checkedOf(r) && qty > 0
                        ? <span style={{ color: '#1e9e57' }}>本次转 {qty} 件</span>
                        : <span style={{ color: '#999' }}>待填数量</span>)
                      : <span style={{ color: '#d92d20' }}>暂无最终价，先生成最终报价列</span>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td style={td} colSpan={8}>
              <span style={{ color: '#999' }}>还没有定厂的行——先到「比价定厂」选好每行用哪家工厂。</span>
            </td></tr>
          )}
        </tbody>
      </table>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <span className="conv-summary" style={{ color: '#444' }}>
          本次转 {included.length} 行 · 共 {totalQty} 件 · 应收合计 {totalAmount.toFixed(2)}
        </span>
        <button
          className="conv-create"
          disabled={included.length === 0}
          onClick={handleCreate}
          style={{
            border: '1px solid #1e9e57',
            background: included.length ? '#1e9e57' : '#bbb',
            color: '#fff', borderRadius: 8, padding: '5px 16px',
            cursor: included.length ? 'pointer' : 'not-allowed',
          }}
        >生成订单</button>
        {included.length === 0 && (
          <span style={{ color: '#999' }}>给至少一行填上数量才能生成</span>
        )}
      </div>
    </div>
  );
}
