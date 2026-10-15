import React, { useState } from 'react';

// 对客报价导出面板（SPEC 第四节第 7 项）：只在看询价单时打开。
// 选行：默认给"已有最终价"的行打勾（先报已确认的部分），没价的行
// 也在列，用户可以勾上——它们的价格会保持空白，绝不用 0 冒充。
// 选列：默认原表列 + 最终报价；工作列与「销售价」列默认不勾
// （要不要给客户看，由用户自己勾）。两种版式各一对按钮（下载 /
// 发送到微信…），字节由父组件按这里的选择现算——面板本身不碰
// 任何报价单数据，工厂价与工厂名从结构上就进不了导出（底线 2）。
export default function QuoteExportPanel({
  rows, cols, defaultRowIds, defaultColKeys,
  canShareFiles, onExport, onClose, variant, customerName, onCreateEditable,
}) {
  const [rowSel, setRowSel] = useState(() => new Set(defaultRowIds));
  const [colSel, setColSel] = useState(() => new Set(defaultColKeys));
  const [copied, setCopied] = useState(false);
  const isPage = variant === 'page';

  // 复制报价文本（效率项）：按当前勾选拼一段可直接粘进微信的报价，
  // 只有勾选且有最终价的行进文本，没价的勾选行标「待确认」不冒充 0。
  async function copyQuoteText() {
    const picked = rows.filter((r) => rowSel.has(r.lineId));
    if (!picked.length) {
      window.alert('一行都还没勾选——先勾选要发给客户的行，再复制报价文本');
      return;
    }
    const today = new Date();
    const ymd = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') +
      '-' + String(today.getDate()).padStart(2, '0');
    const lines = ['报价' + (customerName ? '（' + customerName + '）' : '') + ' ' + ymd];
    for (const r of picked) {
      const price = r.finalPrice !== null && r.finalPrice !== undefined
        ? r.finalPrice.toFixed(2) : '待确认';
      lines.push([r.seq || '', r.oe || '', r.product || '', price].filter(Boolean).join('  '));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const toggleIn = (setter) => (key, on) => {
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  };
  const toggleRow = toggleIn(setRowSel);
  const toggleCol = toggleIn(setColSel);

  const dlBtn = {
    border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
    borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
  };
  const shareBtn = {
    border: '1px solid #07c160', background: '#07c160', color: '#fff',
    borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
  };
  const chk = { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12, whiteSpace: 'nowrap' };

  // 点下载/分享前先自检：没行、没勾行、没勾列是三种不同的情况，
  // 各说各的话并给出下一步（包 11：此前统一一句"请至少勾选一行"，
  // 示例单上行清单为空时照着做也导不出，用户无从下手）。
  const fire = (kind, mode) => {
    if (rows.length === 0) {
      window.alert('这张询价单还没有数据行，没法导出——先导入客户原表，或先在表格里填上数据，再来导出');
      return;
    }
    if (rowSel.size === 0) {
      window.alert('一行都还没勾选——请在上面勾选要导出的行（点「全选」可以一次全选好），再点下载');
      return;
    }
    if (colSel.size === 0) {
      window.alert('一列都还没勾选——请至少勾选一列（比如「最终报价」那列），再点下载');
      return;
    }
    onExport(kind, mode, { lineIds: rowSel, colKeys: colSel });
  };

  return (
    <div className="export-panel" style={isPage ? {
      padding: '12px 14px', fontFamily: 'sans-serif', fontSize: 14,
      border: '1px solid #dbe2ec', borderLeft: '4px solid #1e9e57', borderRadius: 12, background: '#fff',
      boxShadow: '0 1px 3px rgba(23,34,62,0.05)',
    } : {
      margin: '10px 14px 0', padding: '12px 14px', fontFamily: 'sans-serif', fontSize: 14,
      border: '1px solid #dbe2ec', borderLeft: '4px solid #1e9e57', borderRadius: 12, background: '#fff',
      boxShadow: '0 1px 3px rgba(23,34,62,0.05)',
      maxHeight: '46vh', overflow: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ color: '#157347' }}>对客报价导出</b>
        <span style={{ color: '#666' }}>
          导出只含询价单与最终报价，绝不包含工厂价格和工厂名
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button className="export-close" onClick={onClose} style={{
          border: '1px solid #888', color: '#444', background: '#fff',
          borderRadius: 8, padding: '3px 10px', cursor: 'pointer',
        }}>关闭</button>
      </div>

      <div style={{ marginTop: 8 }}>
        <span style={{ color: '#444' }}>导出哪些行（已选 {rowSel.size} / {rows.length}）：</span>
        <span style={{ marginLeft: 8 }}>
          <button className="exp-rows-all" onClick={() => setRowSel(new Set(rows.map((r) => r.lineId)))} style={{ border: 'none', background: 'none', color: '#2f6bff', cursor: 'pointer', padding: 0 }}>全选</button>
          {' · '}
          <button className="exp-rows-none" onClick={() => setRowSel(new Set())} style={{ border: 'none', background: 'none', color: '#2f6bff', cursor: 'pointer', padding: 0 }}>全不选</button>
        </span>
        <div className="exp-rows" style={{
          marginTop: 4, maxHeight: isPage ? 380 : 168, overflow: 'auto',
          border: '1px solid #d5dbe3', borderRadius: 8, background: '#fff', padding: '4px 8px',
        }}>
          {rows.map((r) => (
            <label key={r.lineId} className="exp-row" style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
              <input
                type="checkbox"
                className="exp-row-check"
                data-line-id={r.lineId}
                checked={rowSel.has(r.lineId)}
                onChange={(e) => toggleRow(r.lineId, e.target.checked)}
              />
              <span style={{ minWidth: 36, color: '#888' }}>{r.seq || ''}</span>
              <span style={{ minWidth: 130 }}>{r.oe || ''}</span>
              <span style={{ flex: 1 }}>{r.product || ''}</span>
              <span className="exp-row-price" style={{ color: r.finalPrice !== null && r.finalPrice !== undefined ? '#1e9e57' : '#bbb' }}>
                {r.finalPrice !== null && r.finalPrice !== undefined
                  ? '最终价 ' + r.finalPrice.toFixed(2)
                  : '未定价（导出留空）'}
              </span>
            </label>
          ))}
          {rows.length === 0 && <div style={{ color: '#888', padding: 6 }}>询价单还没有数据行——先导入客户原表，或先在表格里填上数据，这里就会列出可导出的行</div>}
        </div>
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#444', marginRight: 8 }}>导出哪些列：</span>
        {cols.map((c) => (
          <label key={c.key} style={chk}>
            <input
              type="checkbox"
              className="exp-col-check"
              data-col-key={c.key}
              checked={colSel.has(c.key)}
              onChange={(e) => toggleCol(c.key, e.target.checked)}
            />
            {c.label}
            {c.final ? <span style={{ color: '#1e9e57' }}>（给客户的价 · 按定厂工厂价算）</span> : null}
            {c.isSales ? <span style={{ color: '#999' }}>（定价条按成本价列算）</span> : null}
            {c.isWork ? <span style={{ color: '#999' }}>（工作列）</span> : null}
          </label>
        ))}
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <b>普通版</b>
          <span style={{ color: '#888' }}>只含选中的行和列</span>
          <button className="exp-plain-download" onClick={() => fire('plain', 'download')} style={dlBtn}>下载</button>
          {canShareFiles && (
            <button className="exp-plain-share" onClick={() => fire('plain', 'share')} style={shareBtn}>发送到微信…</button>
          )}
        </span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <b>带图版</b>
          <span style={{ color: '#888' }}>客户原表回写 + 最终报价列（带原格式与图片，只含勾选的行和列，未勾选的直接不出现在文件里）</span>
          <button className="exp-pic-download" onClick={() => fire('pictured', 'download')} style={dlBtn}>下载</button>
          {canShareFiles && (
            <button className="exp-pic-share" onClick={() => fire('pictured', 'share')} style={shareBtn}>发送到微信…</button>
          )}
        </span>
        {!canShareFiles && (
          <span className="exp-share-hint" style={{ color: '#999' }}>
            此浏览器不支持直接分享，请用下载后拖进微信
          </span>
        )}
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <button className="exp-copy-text" onClick={copyQuoteText} style={{
            border: '1px solid #6a1b9a', background: '#fff', color: '#6a1b9a',
            borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
          }}>{copied ? '已复制 ✓' : '复制报价文本'}</button>
          <span style={{ color: '#888' }}>按当前勾选拼一段文字，直接粘进微信发客户</span>
        </span>
        {onCreateEditable && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <button className="exp-create-editable" onClick={() => onCreateEditable({
              lineIds: new Set(rowSel),
              colKeys: new Set(colSel),
            })} style={{
              border: '1px solid #b7791f', background: '#b7791f', color: '#fff',
              borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
            }}>生成最终报价单（可编辑）</button>
            <span style={{ color: '#888' }}>先调格式再发客户：生成一张最终报价单到表格工作区，挪列改格式不影响原询价单</span>
          </span>
        )}
      </div>
    </div>
  );
}
