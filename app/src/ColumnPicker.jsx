import React, { useState } from 'react';

// 表头「显示列」选择器（比价定厂 / 转订单共用）：点开是一列复选框，
// 勾哪些列、表格就显示哪些列。选择由调用方持有并自行持久化，
// 这里只管展开/收起与勾选回调。固定列（转勾选框、数量这类离了
// 就没法干活的）不进 options，永远显示。
export default function ColumnPicker({ options, value, onToggle }) {
  const [open, setOpen] = useState(false);
  const btn = {
    border: '1px solid #37404a', color: '#37404a', background: '#fff',
    borderRadius: 8, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
  };
  return (
    <span className="col-picker" style={{ position: 'relative', display: 'inline-block' }}>
      <button className="col-picker-btn" onClick={() => setOpen(!open)} style={btn}>
        显示列 {open ? '▴' : '▾'}
      </button>
      {open && (
        <>
          <span
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40, display: 'block' }}
          />
          <span className="col-picker-panel" style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 41,
            background: '#fff', border: '1px solid #c9d2de', borderRadius: 10,
            padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
            boxShadow: '0 8px 24px rgba(23,34,62,0.14)', minWidth: 150,
            maxHeight: 320, overflowY: 'auto',
          }}>
            {options.map((o) => (
              <label key={o.key} style={{
                display: 'inline-flex', gap: 6, alignItems: 'center',
                cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 13, color: '#333',
              }}>
                <input
                  type="checkbox" className="col-picker-check" data-col={o.key}
                  checked={!!value[o.key]}
                  onChange={() => onToggle(o.key)}
                />{o.label}
              </label>
            ))}
          </span>
        </>
      )}
    </span>
  );
}
