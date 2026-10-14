import React from 'react';

// 定价条（SPEC 第四节第 3 项）：整表填一次的参数，一键算出每行销售价。
// 组成：成本价列（下拉，选项是当前表的实时列头）/ 该列口径（含税/不含税）/
// 税点 %（仅不含税时显示）/ 加价比例 % / 每件国内运费 / 汇率（选填，
// 填了销售价换成外币、列名变「销售价（外币）」）。参数状态由父组件持有
// 并随工作存档持久化；本组件只负责长相与取值回传。
export default function PricingBar({ headers, pricing, onPricingChange, onCalculate }) {
  const num = {
    width: 64, padding: '4px 6px', border: '1px solid #c9d2de', borderRadius: 8,
  };
  const lab = { color: '#444' };
  return (
    <div className="pricing-bar" style={{
      margin: '10px 14px 0', padding: '10px 14px', fontFamily: 'sans-serif', fontSize: 14,
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      border: '1px solid #dbe2ec', borderLeft: '4px solid #2f6bff', borderRadius: 12, background: '#fff',
      boxShadow: '0 1px 3px rgba(23,34,62,0.05)',
    }}>
      <b style={{ color: '#1f56d6' }}>定价</b>
      <label style={lab}>成本价列
        <select
          className="pb-cost-col"
          value={pricing.costCol === null || pricing.costCol === undefined ? '' : String(pricing.costCol)}
          onChange={(e) => onPricingChange({ costCol: e.target.value === '' ? null : Number(e.target.value) })}
          style={{ marginLeft: 4, padding: '4px 6px' }}
        >
          <option value="">请选择</option>
          {headers.map((h) => (
            <option key={h.col} value={h.col}>{h.label}</option>
          ))}
        </select>
      </label>
      <label style={lab}>该列
        <select
          className="pb-tax-mode"
          value={pricing.taxInclusive ? 'incl' : 'excl'}
          onChange={(e) => onPricingChange({ taxInclusive: e.target.value === 'incl' })}
          style={{ marginLeft: 4, padding: '4px 6px' }}
        >
          <option value="excl">不含税</option>
          <option value="incl">含税</option>
        </select>
      </label>
      {!pricing.taxInclusive && (
        <label style={lab}>税点 %
          <input
            className="pb-tax-rate" type="number" step="0.01" style={{ ...num, marginLeft: 4 }}
            value={pricing.taxRatePct}
            onChange={(e) => onPricingChange({ taxRatePct: e.target.value })}
          />
        </label>
      )}
      <label style={lab}>加价比例 %
        <input
          className="pb-markup" type="number" step="0.01" style={{ ...num, marginLeft: 4 }}
          value={pricing.markupPct}
          onChange={(e) => onPricingChange({ markupPct: e.target.value })}
        />
      </label>
      <label style={lab}>每件国内运费
        <input
          className="pb-freight" type="number" step="0.01" style={{ ...num, marginLeft: 4 }}
          value={pricing.freight}
          onChange={(e) => onPricingChange({ freight: e.target.value })}
        />
      </label>
      <label style={lab}>汇率（选填）
        <input
          className="pb-fx" type="number" step="0.0001" placeholder="空 = 不换算" style={{ ...num, width: 92, marginLeft: 4 }}
          value={pricing.fxRate}
          onChange={(e) => onPricingChange({ fxRate: e.target.value })}
        />
      </label>
      <button
        className="pb-calc"
        onClick={onCalculate}
        style={{
          border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
          borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
        }}
      >计算销售价</button>
      <span style={{ color: '#75808d' }}>结果写入「销售价」列（按成本价列算的卖价，不是工厂价）；成本为空的行留空</span>
    </div>
  );
}
