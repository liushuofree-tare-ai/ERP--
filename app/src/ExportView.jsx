import React from 'react';
import QuoteExportPanel from './QuoteExportPanel.jsx';

// 对客报价导出独立模块（2026-10-15 用户反馈）：此前它是询价单表格上方
// 的浮层，挤在表格模块里不合理——流程上它是独立一步（转订单之后、
// 发给客户之前），就该和转订单一样是全区模块：从左侧导航、比价页、
// 转订单完成提示都能直达，进来只做这一件事（选范围 → 下载/分享/
// 复制文本）。面板本体仍是 QuoteExportPanel（variant="page" 时铺满）。
export default function ExportView({
  inquiry, customerName, pricedCount, totalCount,
  rows, cols, defaultRowIds, defaultColKeys,
  canShareFiles, onExport, onCreateEditable, hasEditableQuote, onBack, panelKey,
}) {
  const inqName = (inquiry && inquiry.source && inquiry.source.fileName) || '';
  return (
    <div className="export-view" style={{
      flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px',
      fontFamily: 'sans-serif', fontSize: 14,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <b className="sec-title" style={{ fontSize: 18 }}>对客报价导出</b>
        <span style={{ color: '#666' }}>
          来源询价单{inqName ? '：' + inqName : ''} · 客户：{customerName || '（未填）'}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button onClick={onBack} style={{
          border: '1px solid #888', color: '#444', background: '#fff', borderRadius: 8,
          padding: '4px 12px', cursor: 'pointer',
        }}>返回表格</button>
      </div>
      {!inquiry ? (
        <div style={{ color: '#888', padding: 20 }}>
          还没有询价单——先导入客户原表，发给工厂、比价定厂、生成最终报价之后再来导出。
        </div>
      ) : (
        <>
          {pricedCount === 0 && (
            <div className="export-no-price-hint" style={{
              border: '1px solid #eed9ac', background: '#fdf3e0', borderRadius: 10,
              padding: '8px 12px', marginBottom: 10, color: '#6b5410',
            }}>
              这张询价单还没有任何一行的最终价——导出的价格会全是空白。
              先去「比价定厂」定厂，再回表格点「生成最终报价列」，然后回来导出。
            </div>
          )}
          {pricedCount > 0 && pricedCount < totalCount && (
            <div style={{ color: '#666', marginBottom: 8 }}>
              已有最终价 {pricedCount} / 共 {totalCount} 行：默认只勾有价的行，没价的行勾上也会留空导出（不拿 0 冒充）。
            </div>
          )}
          <div style={{
            border: '1px solid #dbe2ec', borderRadius: 10, background: '#f7fafc',
            padding: '8px 12px', marginBottom: 10, color: '#445',
          }}>
            发客户前要调格式、挪价格列的位置？别在原询价单上改——用下方
            <b>「生成可编辑报价单（副本）」</b>：按当前勾选生成一份独立副本，进表格里
            慢慢改，改好再下载，<b>原始询价单一点都不动</b>。
            {hasEditableQuote ? '这张询价单已经有一份副本了，重新生成会覆盖副本里改过的内容（会先确认）。' : ''}
          </div>
          <QuoteExportPanel
            key={panelKey}
            variant="page"
            rows={rows || []}
            cols={cols || []}
            defaultRowIds={defaultRowIds || []}
            defaultColKeys={defaultColKeys || []}
            customerName={customerName}
            canShareFiles={canShareFiles}
            onExport={onExport}
            onCreateEditable={onCreateEditable}
            onClose={onBack}
          />
        </>
      )}
    </div>
  );
}
