import React from 'react';

// 比价定厂视图（SPEC 第四节第 6 项）：询价单的数据行逐行铺开，
// 每家工厂一列，格子是按该家标价列口径换算后的含税价（归一价），
// 下面小字是备货周期。每行最低的那家只挂一个「最低」提示——
// 提示而已，永远不替用户选（底线 5）；点格子才算定厂，再点一次
// 已定的格子取消。「整单都定 X」「按最低价预选」是用户明确点击
// 的批量动作，点完仍可逐行改。
//
// 包 13 引导：没报价单 / 没标价列时页面顶部给出明确说明 + 一键
// 直达按钮（guidance 由主程序按 guidance.js 推导传入），不再让
// 用户面对一张"没有工厂列、没价格"的空表猜哪里坏了。
//
// 包 14 下一步条：定完厂之后的路也要领——nextStep 由主程序按
// guidance.js 的 compareNextStepOf 推导传入：没定厂时一行操作
// 提示；定了厂按"最终报价生成了没"给出主按钮（生成最终报价 /
// 去转订单 + 去对客导出）；还有行一家都没报价时挂一句部分覆盖
// 说明。引导块（no-quotes/unmarked）在场时 nextStep 为 null，不叠加。
//
// 包 17：「生成最终报价」改为原地生成（onGenerateFinals）——不再
// 把人送回工作区。条文讲清对客价写回询价单（导给客户用）；生成
// 成功后条按存档事实自动翻到 convert 态。去转订单/去对客导出
// 仍是落位到工作区面板（面板本来就长在询价单上）。
export default function CompareView({
  model, marks, choices, onChoose, onBulkAll, onBulkLowest,
  guidance, onGoSendFactory, onGoUploadReturn, onGoMarkQuote,
  nextStep, onGenerateFinals, onGoConvert, onGoExport,
}) {
  const { factories, rows } = model;
  const chosenCount = rows.filter((r) => choices[r.lineId]).length;

  const th = {
    border: '1px solid #dbe2ec', background: '#e9eff8', padding: '8px 12px',
    textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap', color: '#33445c',
  };
  const td = { border: '1px solid #e2e8f1', padding: '8px 12px', verticalAlign: 'top' };
  const guideBtn = {
    border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
    borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
  };
  const guideBtnGhost = { ...guideBtn, background: '#fff', color: '#2f6bff' };
  const guideBox = {
    border: '1px solid #eed9ac', background: '#fdf3e0', borderRadius: 12,
    padding: '12px 16px', marginBottom: 12,
  };
  const nextBox = {
    border: '1px solid #bfe3cd', background: '#e5f5ec', borderRadius: 12,
    padding: '12px 16px', marginBottom: 12,
  };
  const nextBtn = {
    border: '1px solid #1e9e57', background: '#1e9e57', color: '#fff',
    borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
  };
  const nextBtnGhost = { ...nextBtn, background: '#fff', color: '#1e9e57' };

  return (
    <div className="compare-view" style={{
      flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      fontFamily: 'sans-serif', fontSize: 14,
      margin: '14px 16px 16px', padding: '16px 18px', background: '#fff',
      border: '1px solid #dbe2ec', borderRadius: 14,
      boxShadow: '0 2px 6px rgba(23,34,62,0.05), 0 10px 24px rgba(23,34,62,0.06)',
    }}>
      {guidance && guidance.state === 'no-quotes' && (
        <div className="cmp-guide cmp-guide-no-quotes" style={guideBox}>
          <div style={{ fontSize: 14 }}><b>还没有工厂报价单，所以没东西可比。</b></div>
          <div className="cmp-guide-steps" style={{ color: '#555', margin: '6px 0 8px' }}>
            流程：① 发给工厂（或上传工厂回表） → ② 在报价单上标价列 → ③ 回来这里点格子定厂
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="cmp-guide-send" onClick={onGoSendFactory} style={guideBtn}>
              发给工厂
            </button>
            <button className="cmp-guide-upload" onClick={onGoUploadReturn} style={guideBtnGhost}>
              上传工厂回表
            </button>
          </div>
        </div>
      )}
      {guidance && guidance.state === 'unmarked' && (
        <div className="cmp-guide cmp-guide-unmarked" style={guideBox}>
          <div style={{ fontSize: 14 }}>
            <b>已有 {guidance.quoteCount} 张报价单，还没标价列，比价读不到价格。</b>
          </div>
          <div style={{ color: '#555', margin: '6px 0 8px' }}>
            标价列就是告诉系统「这家的价格在报价单的哪一列、含不含税」——标好之后，这里就能比价定厂。
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {guidance.unmarked.map((u) => (
              <button
                key={u.docId}
                className="cmp-guide-mark"
                data-factory={u.factoryName}
                onClick={() => onGoMarkQuote(u.docId)}
                style={guideBtn}
              >去给『{u.factoryName}』标价</button>
            ))}
          </div>
        </div>
      )}
      {guidance && guidance.state === 'partial' && (
        <div className="cmp-guide cmp-guide-partial" style={{
          ...guideBox, padding: '6px 12px', display: 'flex', gap: 8,
          alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span>
            {guidance.unmarked.map((u) => '『' + u.factoryName + '』').join('、')}
            还没标价列，这 {guidance.unmarked.length} 家的价格暂时比不了：
          </span>
          {guidance.unmarked.map((u) => (
            <button
              key={u.docId}
              className="cmp-guide-mark"
              data-factory={u.factoryName}
              onClick={() => onGoMarkQuote(u.docId)}
              style={{ ...guideBtnGhost, padding: '4px 12px' }}
            >去给『{u.factoryName}』标价</button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <b className="sec-title" style={{ fontSize: 17 }}>比价定厂</b>
        {factories.map((f) => (
          <button
            key={f}
            className="cmp-bulk-all"
            data-factory={f}
            disabled={!marks[f]}
            onClick={() => onBulkAll(f)}
            title={marks[f] ? '' : '这家还没标记报价列，定不了'}
            style={{
              border: '1px solid #1e9e57', color: marks[f] ? '#1e9e57' : '#aaa',
              background: '#fff', borderRadius: 8, padding: '5px 12px',
              cursor: marks[f] ? 'pointer' : 'not-allowed',
            }}
          >整单都定 {f}</button>
        ))}
        <button
          className="cmp-bulk-lowest"
          onClick={onBulkLowest}
          style={{
            border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff',
            borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
          }}
        >按最低价预选</button>
        <span className="cmp-summary" style={{ color: '#444' }}>
          已定厂 {chosenCount} / 共 {rows.length} 行
        </span>
        <span style={{ color: '#999' }}>
          价格已按各家口径统一换算成含税价再比；点格子定厂，再点一次取消
        </span>
      </div>
      {nextStep && nextStep.kind === 'hint' && (
        <div className="cmp-next-hint" style={{ color: '#666', marginBottom: 8 }}>
          点任意价格格子定厂；整单都给一家就点上方『整单都定 X』。
        </div>
      )}
      {nextStep && nextStep.kind !== 'hint' && (
        <div className={'cmp-next cmp-next-' + nextStep.kind} style={nextBox}>
          <div className="cmp-next-text" style={{ fontSize: 14 }}>
            {nextStep.kind === 'generate' && (
              <>已定厂 <b>{nextStep.chosenCount}</b> 行。点『<b>生成最终报价</b>』把对客价写回询价单（导给客户用），生成完就能转订单或对客导出。</>
            )}
            {nextStep.kind === 'convert' && (
              <>最终报价已经生成，已定厂 <b>{nextStep.chosenCount}</b> 行。下一步：<b>转订单</b>；也可以先对客导出，发给客户确认。</>
            )}
            {nextStep.kind === 'convert-all' && (
              <>有报价的行都定好厂了，最终报价也生成好了。下一步：<b>转订单</b>。</>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {nextStep.kind === 'generate' && (
              <button className="cmp-next-go-generate" onClick={onGenerateFinals} style={nextBtn}>
                生成最终报价
              </button>
            )}
            {nextStep.kind !== 'generate' && (
              <>
                <button className="cmp-next-go-convert" onClick={onGoConvert} style={nextBtn}>
                  去转订单
                </button>
                <button className="cmp-next-go-export" onClick={onGoExport} style={nextBtnGhost}>
                  去对客导出
                </button>
              </>
            )}
          </div>
          {nextStep.unquotedCount > 0 && (
            <div className="cmp-next-unquoted" style={{ color: '#666', marginTop: 8 }}>
              其余 {nextStep.unquotedCount} 行还没有任何工厂报价，先留空、不影响已定厂的行往下走；后面有报价再回来补定。
            </div>
          )}
        </div>
      )}
      <div className="cmp-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <table className="compare-table" style={{ borderCollapse: 'collapse', minWidth: 720, width: '100%' }}>
        <thead>
          <tr>
            <th style={th}>序号</th>
            <th style={th}>OE码</th>
            <th style={th}>产品</th>
            {factories.map((f) => (
              <th key={f} style={th}>
                {f}
                {!marks[f] && (
                  <span style={{ color: '#d92d20', fontWeight: 400 }}>（未标记报价列）</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const chosen = choices[row.lineId];
            return (
              <tr key={row.lineId} className="cmp-row" data-line-id={row.lineId}>
                <td style={td}>{row.seq}</td>
                <td style={td}>{row.oe}</td>
                <td style={td}>{row.product}</td>
                {factories.map((f) => {
                  const cell = row.cells[f];
                  const isChosen = !!(chosen && chosen.factory === f);
                  const isLowest = cell.priced && row.lowestFactories.includes(f);
                  return (
                    <td
                      key={f}
                      className="cmp-cell"
                      data-factory={f}
                      data-priced={cell.priced ? '1' : '0'}
                      data-chosen={isChosen ? '1' : '0'}
                      onClick={() => onChoose(row, cell)}
                      title={cell.priced ? '点这里定这家（再点一次取消）' : '这家这一行没报价'}
                      style={{
                        ...td,
                        cursor: cell.priced ? 'pointer' : 'default',
                        background: isChosen ? '#dcf2e3' : undefined,
                        boxShadow: isChosen ? 'inset 0 0 0 2px #1e9e57' : undefined,
                      }}
                    >
                      {cell.priced ? (
                        <>
                          <span className="cmp-price" style={{ fontWeight: isChosen ? 700 : 400 }}>
                            {cell.normalized.toFixed(2)}
                          </span>
                          {isLowest && (
                            <span className="cmp-lowest" style={{
                              marginLeft: 6, background: '#fdeed0', color: '#96660a',
                              borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 600,
                            }}>最低</span>
                          )}
                          {cell.period !== '' && (
                            <div className="cmp-period" style={{ color: '#888', fontSize: 12 }}>
                              周期：{cell.period}
                            </div>
                          )}
                          {!cell.taxInclusive && (
                            <div style={{ color: '#aaa', fontSize: 11 }}>
                              原价（不含税）{cell.raw}
                            </div>
                          )}
                        </>
                      ) : (
                        <span style={{ color: '#bbb' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div style={{ color: '#888', padding: 12 }}>
          询价单还没有数据行——先导入客户原表，再上传各家回表、标好价列，这里就能比价定厂。
        </div>
      )}
      </div>
    </div>
  );
}
