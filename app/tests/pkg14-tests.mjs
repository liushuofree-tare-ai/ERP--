/* 包 14 单元测试：比价「下一步条」的状态推导（guidance.js 的
 * compareNextStepOf）。浏览器里的完整链路（条出现 → 点去生成 →
 * 条变去转订单 → 建单成功提示 → 查看这张订单）由
 * probe/cdp-pkg14-nextstep.mjs 验。
 * 断言风格与既有套件一致：失败即抛错（非零退出）。 */
import { compareNextStepOf } from '../src/guidance.js';

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) throw new Error('FAIL: ' + name);
  console.log('  ✓', name);
}
function eq(a, b, name) {
  n += 1;
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + name + '\n  got: ' + x + '\n  exp: ' + y);
  console.log('  ✓', name);
}

/* ================= 比价下一步（compareNextStepOf） ================= */
console.log('== 比价下一步条状态');
const base = {
  guidanceState: 'ready', totalRows: 5, chosenCount: 0,
  quotedCount: 2, chosenQuotedCount: 0, unquotedCount: 3,
  finalColumnGenerated: false,
};
{
  // 引导块在场时不叠加（没报价单 / 没标价列由包 13 的块负责）
  eq(compareNextStepOf({ ...base, guidanceState: 'no-quotes', chosenCount: 2 }),
    null, 'no-quotes 引导在场 → 不出下一步条');
  eq(compareNextStepOf({ ...base, guidanceState: 'unmarked', chosenCount: 2 }),
    null, 'unmarked 引导在场 → 不出下一步条');
  // 没有数据行：连表都是空的，没有下一步
  eq(compareNextStepOf({ ...base, totalRows: 0, chosenCount: 2 }),
    null, '0 行 → 不出下一步条');
  eq(compareNextStepOf(), null, '无入参 → null（不炸）');
  // 还没定厂：一行操作提示（partial 引导在场也照出，管的是另一件事）
  eq(compareNextStepOf(base), { kind: 'hint', chosenCount: 0, unquotedCount: 3 },
    '没定厂 → hint');
  eq(compareNextStepOf({ ...base, guidanceState: 'partial' }).kind, 'hint',
    'partial 引导 + 没定厂 → hint');
  // 定了厂、最终报价没生成 → 去生成（无价行数带出给部分覆盖提示）
  eq(compareNextStepOf({ ...base, chosenCount: 2, chosenQuotedCount: 2 }),
    { kind: 'generate', chosenCount: 2, unquotedCount: 3 },
    '定厂 2 行、无最终报价列 → generate，带 unquotedCount=3');
  eq(compareNextStepOf({ ...base, guidanceState: 'partial', chosenCount: 1, chosenQuotedCount: 1 }).kind,
    'generate', 'partial 引导 + 定了厂 → 仍出 generate 条');
  // 最终报价有了、还有有价行没定 → 去转订单
  eq(compareNextStepOf({
    ...base, chosenCount: 2, chosenQuotedCount: 2, quotedCount: 4,
    unquotedCount: 1, finalColumnGenerated: true,
  }), { kind: 'convert', chosenCount: 2, unquotedCount: 1 },
    '有最终报价、只定了一部分有价行 → convert');
  // 有报价的行全定完 + 最终报价已有 → convert-all
  eq(compareNextStepOf({
    ...base, chosenCount: 2, chosenQuotedCount: 2, quotedCount: 2,
    unquotedCount: 3, finalColumnGenerated: true,
  }).kind, 'convert-all', '有价行全定完 + 有最终报价 → convert-all');
  // 全部行都有价且全定完、无无价行
  eq(compareNextStepOf({
    guidanceState: 'ready', totalRows: 5, chosenCount: 5, quotedCount: 5,
    chosenQuotedCount: 5, unquotedCount: 0, finalColumnGenerated: true,
  }), { kind: 'convert-all', chosenCount: 5, unquotedCount: 0 },
    '全行有价全定完 → convert-all，unquotedCount=0');
  // 定厂数比有价行多（历史定厂的报价被删）不误报 convert-all
  eq(compareNextStepOf({
    ...base, chosenCount: 4, chosenQuotedCount: 1, quotedCount: 2,
    finalColumnGenerated: true,
  }).kind, 'convert', 'chosenQuotedCount < quotedCount → 仍是 convert');
  // 有定厂但一行有价都没有（极端历史数据）：不算 convert-all
  eq(compareNextStepOf({
    ...base, chosenCount: 1, chosenQuotedCount: 0, quotedCount: 0,
    unquotedCount: 5, finalColumnGenerated: true,
  }).kind, 'convert', 'quotedCount=0 → convert（不误报全定完）');
  ok(compareNextStepOf({ ...base, chosenCount: 1, chosenQuotedCount: 1 }).chosenCount === 1,
    'generate 带 chosenCount');
}

console.log(`\n包 14 单元测试：PASS ${n} / FAIL 0`);
