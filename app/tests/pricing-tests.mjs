// 定价模块测试（SPEC 第五节验算用例）：纯 Node，不依赖浏览器。
// 运行：npm test（与文件层回归一起跑）。
import { computeSalesPrice, parseCostValue } from '../src/pricing.js';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual);
}

console.log('== 定价模块（SPEC 第五节）');
// SPEC 验算：100 不含税 ×（1+13%）×（1+20%）+ 5 = 140.60
eq(computeSalesPrice({ cost: 100, taxInclusive: false, taxRatePct: 13, markupPct: 20, freightPerUnit: 5 }),
  140.6, '不含税 100 · 税点13 · 加价20 · 运费5 = 140.60');
// 含税跳过税点：100 ×（1+20%）+ 5 = 125.00（传了税点也不得再加）
eq(computeSalesPrice({ cost: 100, taxInclusive: true, taxRatePct: 13, markupPct: 20, freightPerUnit: 5 }),
  125, '含税 100 · 加价20 · 运费5 = 125.00（税点被跳过）');
// 成本为空/非数字 → null（留空，绝不冒充 0）
eq(computeSalesPrice({ cost: '', taxInclusive: false, taxRatePct: 13, markupPct: 20, freightPerUnit: 5 }),
  null, '成本为空 → null');
eq(computeSalesPrice({ cost: '待确认', taxInclusive: false, taxRatePct: 13, markupPct: 20, freightPerUnit: 5 }),
  null, '成本是文字 → null');
eq(computeSalesPrice({ cost: undefined, taxInclusive: true, markupPct: 20, freightPerUnit: 5 }),
  null, '成本缺失 → null');
// 汇率：140.60 ÷ 7.2 = 19.5277… → 19.53
eq(computeSalesPrice({ cost: 100, taxInclusive: false, taxRatePct: 13, markupPct: 20, freightPerUnit: 5, fxRate: 7.2 }),
  19.53, '带汇率 7.2：140.60 ÷ 7.2 = 19.53');
// 工厂回表实测口径（包 4 浏览器实测同款参数）
eq(computeSalesPrice({ cost: 520, taxInclusive: false, taxRatePct: 0, markupPct: 20, freightPerUnit: 5 }),
  629, '不含税 520 · 税点0 · 加价20 · 运费5 = 629.00');
eq(computeSalesPrice({ cost: 546, taxInclusive: true, markupPct: 20, freightPerUnit: 5 }),
  660.2, '含税 546 · 加价20 · 运费5 = 660.20');
eq(computeSalesPrice({ cost: 231, taxInclusive: true, markupPct: 20, freightPerUnit: 5 }),
  282.2, '含税 231 · 加价20 · 运费5 = 282.20');
// 数字字符串成本也能算
eq(computeSalesPrice({ cost: '520', taxInclusive: false, taxRatePct: 0, markupPct: 20, freightPerUnit: 5 }),
  629, '成本是数字字符串 "520" 也能算 = 629.00');
// parseCostValue 基本面
eq(parseCostValue(0), 0, '成本 0 是合法数字（解析层不吞）');
eq(parseCostValue(' 220 '), 220, '带空格的数字字符串可解析');
eq(parseCostValue(null), null, 'null → null');

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
