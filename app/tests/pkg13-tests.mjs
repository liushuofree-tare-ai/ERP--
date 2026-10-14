/* 包 13 单元测试：引导状态推导 + 四种备注的纯函数部分
 * （guidance.js 的比价/订单引导、registry 的 factoryInfo 改名/删除
 * 同步与管理页读模型）。浏览器里的完整链路（引导按钮跳转、四种
 * 备注设置后刷新还在）由 probe/cdp-pkg13-guidance.mjs 验。
 * 断言风格与既有套件一致：失败即抛错（非零退出）。 */
import {
  compareGuidanceOf, orderGuidanceOf, quoteIsMarked,
} from '../src/guidance.js';
import {
  syncFactoryInfoOnRename, syncFactoryInfoOnDelete,
  buildFactoryModel, buildCustomerModel,
} from '../src/registry.js';

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

/* ================= A. 比价引导（compareGuidanceOf） ================= */
console.log('== A. 比价引导状态');
const q = (factoryName, mark) => ({
  kind: 'quote', docId: 'doc-' + factoryName, factoryName,
  priceMark: mark === undefined ? null : mark,
});
const MARKED = { col: 5, taxInclusive: false, taxRatePct: '13', periodCol: null };
{
  eq(compareGuidanceOf([]), { state: 'no-quotes', quoteCount: 0, unmarked: [] },
    '没有报价单 → no-quotes');
  eq(compareGuidanceOf(null).state, 'no-quotes', '入参为空也按 no-quotes');
  const g = compareGuidanceOf([q('EE'), q('FF')]);
  eq(g.state, 'unmarked', '两张都没标价列 → unmarked');
  eq(g.quoteCount, 2, 'unmarked 时报价单数对');
  eq(g.unmarked.map((u) => u.factoryName), ['EE', 'FF'], 'unmarked 列出两家');
  eq(g.unmarked[0].docId, 'doc-EE', 'unmarked 带 docId（按钮要跳到那张单）');
  const p = compareGuidanceOf([q('EE', MARKED), q('FF')]);
  eq(p.state, 'partial', '一家标了、一家没标 → partial');
  eq(p.unmarked.map((u) => u.factoryName), ['FF'], 'partial 只列没标的那家');
  eq(compareGuidanceOf([q('EE', MARKED)]).state, 'ready', '全标了 → ready（不显示引导）');
  eq(compareGuidanceOf([q('EE', { col: null })]).state, 'unmarked',
    'priceMark 存在但 col 为 null 算没标');
  ok(!quoteIsMarked(q('EE')), 'quoteIsMarked：无标记为 false');
  ok(quoteIsMarked(q('EE', MARKED)), 'quoteIsMarked：有列为 true');
  // 非报价单文档混进来不计数
  eq(compareGuidanceOf([{ kind: 'inquiry', docId: 'i1' }]).state, 'no-quotes',
    '询价单不算报价单');
}

/* ================= B. 订单引导（orderGuidanceOf 五步） ================= */
console.log('== B. 订单引导五步');
const base = { hasInquiry: true, quotes: [], choices: {}, finalColumnGenerated: false };
eq(orderGuidanceOf({ ...base, hasInquiry: false }), 'no-inquiry', '没有询价单 → no-inquiry');
eq(orderGuidanceOf(base), 'no-quotes', '有单没报价 → no-quotes（去发给工厂）');
eq(orderGuidanceOf({ ...base, quotes: [q('EE')] }), 'unmarked',
  '有报价单没标价 → unmarked（去比价定厂）');
eq(orderGuidanceOf({ ...base, quotes: [q('EE', MARKED)] }), 'no-choices',
  '标了价没定厂 → no-choices');
eq(orderGuidanceOf({
  ...base, quotes: [q('EE', MARKED)], choices: { L2: { factory: 'EE' } },
}), 'no-finals', '定厂了没生成最终报价列 → no-finals');
eq(orderGuidanceOf({
  ...base, quotes: [q('EE', MARKED)], choices: { L2: { factory: 'EE' } },
  finalColumnGenerated: true,
}), 'ready', '最终报价列也生成了 → ready（去转订单）');
eq(orderGuidanceOf({
  ...base, quotes: [q('EE', MARKED), q('FF')],
  choices: { L2: { factory: 'EE' } }, finalColumnGenerated: true,
}), 'ready', '有一家标了价即可往下走（另一家没标不挡转订单）');

/* ================= C. 工厂备注同步（改名/删除） ================= */
console.log('== C. factoryInfo 改名/删除同步');
{
  const info = { EE: { contact: '李四', note: '账期月结' }, FF: { contact: '', note: '现款' } };
  const renamed = syncFactoryInfoOnRename(info, 'EE', 'GG');
  eq(renamed, { FF: { contact: '', note: '现款' }, GG: { contact: '李四', note: '账期月结' } },
    '改名：条目搬到新名，旧名消失，别家不动');
  eq(info, { EE: { contact: '李四', note: '账期月结' }, FF: { contact: '', note: '现款' } },
    '改名同步不改入参（纯函数）');
  eq(syncFactoryInfoOnRename(info, '不存在', 'XX'), info, '旧名没条目：原样返回');
  eq(syncFactoryInfoOnRename(info, 'EE', 'EE'), info, '同名改名：原样返回');
  eq(syncFactoryInfoOnRename(null, 'EE', 'GG'), {}, 'factoryInfo 缺失按空对象');
  const deleted = syncFactoryInfoOnDelete(info, 'EE');
  eq(deleted, { FF: { contact: '', note: '现款' } }, '删除：条目去掉，别家不动');
  eq(syncFactoryInfoOnDelete(info, '不存在'), info, '删不存在的：原样返回');
  eq(syncFactoryInfoOnDelete(undefined, 'EE'), {}, 'factoryInfo 缺失按空对象（删除）');
}

/* ================= D. 管理页读模型带备注 ================= */
console.log('== D. 管理页读模型（工厂 info / 客户询价单备注）');
{
  const state = {
    docs: [
      { docId: 'inq1', kind: 'inquiry', customerName: '福田客户', createdAt: '2026-10-12T00:00:00.000Z', note: '福田十月单，急', source: { fileName: '福田.xlsx' } },
      { docId: 'q1', kind: 'quote', factoryName: 'EE', inquiryId: 'inq1' },
    ],
    orders: [],
    factories: ['EE'],
    factoryInfo: { EE: { contact: '李四', note: '账期月结' } },
    customers: [{ name: '福田客户', contact: '张三', note: '月结30天' }],
  };
  const fm = buildFactoryModel(state);
  const ee = fm.find((f) => f.name === 'EE');
  eq(ee.info, { contact: '李四', note: '账期月结' }, '工厂模型带出 factoryInfo 的联系人/备注');
  const noInfo = buildFactoryModel({ ...state, factoryInfo: undefined })
    .find((f) => f.name === 'EE');
  eq(noInfo.info, { contact: '', note: '' }, '老存档没 factoryInfo → 空信息兜底');
  const cm = buildCustomerModel(state);
  const cust = cm.find((c) => c.entry.name === '福田客户');
  eq(cust.entry.note, '月结30天', '客户模型条目带备注（注册表原有能力）');
  eq(cust.inquiries.length, 1, '客户名下询价单 1 张');
  eq(cust.inquiries[0].note, '福田十月单，急', '客户详情的询价单行带出询价单备注');
  const noNote = buildCustomerModel({
    ...state,
    docs: [{ docId: 'inq2', kind: 'inquiry', customerName: '福田客户' }],
  }).find((c) => c.entry.name === '福田客户');
  eq(noNote.inquiries[0].note, '', '询价单没备注字段 → 空字符串兜底');
}

console.log('\n包 13 单元测试全部通过（' + n + ' 条断言）');
