import React, { useMemo, useState } from 'react';
import { distinctValuesInRows, rowsWithValues } from './sheetOps.js';

/**
 * 表格筛选面板（自研，2026-10-15）：FortuneSheet 自带筛选在我们的
 * 受控回声架构下点了不生效，弃用；这里按「选一列 → 勾要保留的值」
 * 的方式算出要隐藏的行，父组件把它们写进 config.rowhidden。
 * 勾选语义：打勾的值显示，取消勾选的值对应的行被隐藏；表头行与
 * 标题行永远不在候选行里，不会被藏。
 */
export default function FilterPanel({
  sheet, headers, dataRows, hiddenCount, onApply, onClear, onClose,
}) {
  const [col, setCol] = useState(headers && headers.length ? headers[0].col : 0);
  const [unchecked, setUnchecked] = useState(() => new Set());
  const [search, setSearch] = useState('');

  const values = useMemo(
    () => distinctValuesInRows(sheet, dataRows, col),
    [sheet, dataRows, col]);
  const shown = search
    ? values.filter((v) => v.value.toLowerCase().includes(search.toLowerCase()))
    : values;
  const hideRows = useMemo(
    () => rowsWithValues(sheet, dataRows, col, unchecked),
    [sheet, dataRows, col, unchecked]);
  const colLabel = (headers.find((h) => h.col === col) || {}).label || '';

  const toggle = (value, on) => {
    const next = new Set(unchecked);
    if (on) next.delete(value); else next.add(value);
    setUnchecked(next);
  };

  const btn = {
    border: '1px solid #c9d2de', background: '#fff', color: '#37404a',
    borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
  };

  return (
    <div className="sheet-filter-panel" style={{
      margin: '6px 10px 0', padding: '10px 12px', fontFamily: 'sans-serif', fontSize: 13,
      border: '1px solid #c3d4f5', borderRadius: 9, background: '#f4f8ff',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ color: '#1f56d6' }}>筛选</b>
        <span style={{ color: '#555' }}>按列</span>
        <select className="filter-col-select" value={col}
          onChange={(e) => { setCol(Number(e.target.value)); setUnchecked(new Set()); setSearch(''); }}
          style={{ padding: '4px 6px' }}>
          {headers.map((h) => (
            <option key={h.col} value={h.col}>{h.label}</option>
          ))}
        </select>
        <input className="filter-search" placeholder="在值里搜…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '4px 8px', border: '1px solid #bbb', borderRadius: 6, width: 130 }} />
        <button style={btn} onClick={() => setUnchecked(new Set())}>全选（全部显示）</button>
        <button style={btn} onClick={() => setUnchecked(new Set(values.map((v) => v.value)))}>
          全不选
        </button>
        <span style={{ marginLeft: 'auto' }} />
        <button className="filter-apply" onClick={() => onApply(hideRows, colLabel)}
          style={{
            border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
            borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
          }}>
          应用筛选{hideRows.length ? '（隐藏 ' + hideRows.length + ' 行）' : ''}
        </button>
        {hiddenCount > 0 && (
          <button className="filter-clear" onClick={onClear} style={{
            ...btn, borderColor: '#d92d20', color: '#d92d20',
          }}>清除筛选（当前隐藏 {hiddenCount} 行）</button>
        )}
        <button style={btn} onClick={onClose}>关闭</button>
      </div>
      <div style={{
        display: 'flex', gap: '4px 16px', flexWrap: 'wrap', marginTop: 8,
        maxHeight: 132, overflowY: 'auto',
      }}>
        {shown.map((v) => (
          <label key={v.value} style={{
            display: 'inline-flex', gap: 4, alignItems: 'center', cursor: 'pointer',
            minWidth: 110,
          }}>
            <input type="checkbox" className="filter-value-check"
              checked={!unchecked.has(v.value)}
              onChange={(e) => toggle(v.value, e.target.checked)} />
            <span>{v.value === '' ? '（空白）' : v.value}</span>
            <span style={{ color: '#98a2ae' }}>×{v.count}</span>
          </label>
        ))}
        {shown.length === 0 && <span style={{ color: '#888' }}>这一列没有可选的值。</span>}
      </div>
      <div style={{ color: '#666', marginTop: 6 }}>
        取消勾选的值会被隐藏；筛选只影响表格里看不看得见，不影响导出内容。
      </div>
    </div>
  );
}
