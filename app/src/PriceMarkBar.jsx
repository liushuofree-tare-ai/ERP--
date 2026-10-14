import React, { useState } from 'react';

// 标价列条（SPEC 第三节 + 第四节第 5 项）：只在看报价单时出现。
// 工厂回表原样上传后，系统不知道哪列是价——由用户在这里标记：
// 报价列 + 该列口径（含税/不含税）+ 税点（不含税时用）+ 周期列
// （默认自动认标题含"周期/交期"的那列，可改）。点「保存标记」才
// 落到文档上（priceMark），比价页按这份标记读价、换算口径。
// 报价列留空再保存 = 取消标记。
export default function PriceMarkBar({
  factoryName, headers, mark, defaultPeriodCol, onSave, onDelete,
}) {
  const [col, setCol] = useState(
    mark && mark.col !== null && mark.col !== undefined ? String(mark.col) : '');
  const [taxInclusive, setTaxInclusive] = useState(mark ? !!mark.taxInclusive : true);
  const [taxRatePct, setTaxRatePct] = useState(
    mark && mark.taxRatePct !== undefined && mark.taxRatePct !== null ? String(mark.taxRatePct) : '13');
  const [periodCol, setPeriodCol] = useState(() => {
    if (mark && mark.periodCol !== undefined) {
      return mark.periodCol === null ? '' : String(mark.periodCol);
    }
    return defaultPeriodCol === null || defaultPeriodCol === undefined
      ? '' : String(defaultPeriodCol);
  });

  const num = { width: 64, padding: '4px 6px', border: '1px solid #c9d2de', borderRadius: 6 };
  const lab = { color: '#444' };
  const labelOf = (c) => {
    const h = headers.find((x) => x.col === c);
    return h ? h.label : '第 ' + (c + 1) + ' 列';
  };

  function handleSave() {
    if (col === '') { onSave(null); return; }
    onSave({
      col: Number(col),
      taxInclusive,
      taxRatePct,
      periodCol: periodCol === '' ? null : Number(periodCol),
    });
  }

  return (
    <div className="price-mark-bar" style={{
      margin: '10px 14px 0', padding: '10px 14px', fontFamily: 'sans-serif', fontSize: 14,
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      border: '1px solid #dbe2ec', borderLeft: '4px solid #d97706', borderRadius: 12, background: '#fff',
      boxShadow: '0 1px 3px rgba(23,34,62,0.05)',
    }}>
      <b style={{ color: '#b45309' }}>标价列</b>
      <span style={{ color: '#666' }}>报价单 · {factoryName}</span>
      <label style={lab}>报价列
        <select
          className="pm-col"
          value={col}
          onChange={(e) => setCol(e.target.value)}
          style={{ marginLeft: 4, padding: '4px 6px' }}
        >
          <option value="">未标记</option>
          {headers.map((h) => (
            <option key={h.col} value={h.col}>{h.label}</option>
          ))}
        </select>
      </label>
      <label style={lab}>该列
        <select
          className="pm-tax-mode"
          value={taxInclusive ? 'incl' : 'excl'}
          onChange={(e) => setTaxInclusive(e.target.value === 'incl')}
          style={{ marginLeft: 4, padding: '4px 6px' }}
        >
          <option value="incl">含税</option>
          <option value="excl">不含税</option>
        </select>
      </label>
      {!taxInclusive && (
        <label style={lab}>税点 %
          <input
            className="pm-tax-rate" type="number" step="0.01" style={{ ...num, marginLeft: 4 }}
            value={taxRatePct}
            onChange={(e) => setTaxRatePct(e.target.value)}
          />
        </label>
      )}
      <label style={lab}>周期列
        <select
          className="pm-period-col"
          value={periodCol}
          onChange={(e) => setPeriodCol(e.target.value)}
          style={{ marginLeft: 4, padding: '4px 6px' }}
        >
          <option value="">（无）</option>
          {headers.map((h) => (
            <option key={h.col} value={h.col}>{h.label}</option>
          ))}
        </select>
      </label>
      <button
        className="pm-save"
        onClick={handleSave}
        style={{
          border: '1px solid #b45309', background: '#b45309', color: '#fff',
          borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
        }}
      >保存标记</button>
      <span className="pm-status" style={{ color: '#888' }}>
        {mark && mark.col !== null && mark.col !== undefined
          ? '已标记：' + labelOf(mark.col) + ' · ' +
            (mark.taxInclusive ? '含税' : '不含税（税点 ' + (mark.taxRatePct ?? '') + '%）') +
            ' · 周期列 ' + (mark.periodCol === null || mark.periodCol === undefined
              ? '无' : labelOf(mark.periodCol))
          : '尚未标记报价列——比价页读不到这家的价'}
      </span>
      <span style={{ marginLeft: 'auto' }} />
      <button
        className="pm-delete"
        onClick={onDelete}
        style={{
          border: '1px solid #d92d20', color: '#d92d20', background: '#fff',
          borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
        }}
      >删除报价单</button>
    </div>
  );
}
