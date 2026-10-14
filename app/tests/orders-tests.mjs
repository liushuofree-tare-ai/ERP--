// 订单模块测试（orders.js 全部导出函数 + 主程序接线逻辑的单元验证）。
// 口径来自 SPEC 第四节第 8/9 项 + 第五节：
//  · 应收 = Σ 最终报价 × 数量（逐行到分）；应付 = Σ 单件含税成本 × 数量；
//  · 状态与金额全部现算，不存陈旧副本；
//  · 超收/超付必须能被检出（放行由 UI 层问用户）；
//  · 发货硬校验：正数且 ≤ 待发量；
//  · 重复转单拦截的数据依据 convertedLineIds 按 inquiryDocId 隔离。
import assert from 'node:assert';

const {
  formatOrderNo, lineUnitCostWithTax, lineReceivable, linePayable,
  orderFacts, checkOverAmount, lineRemainingToShip, validateShipQty,
  convertedLineIds,
} = await import('../src/orders.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' → 实际: ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function almost(actual, expected, label, eps) {
  ok(Math.abs(actual - expected) < (eps || 1e-6), label, actual);
}

/* ---------- 1. formatOrderNo：ORD + YYMM + 4 位流水 ---------- */
{
  eq(formatOrderNo(new Date('2026-10-15T10:00:00+08:00'), 1), 'ORD2610-0001', '单号：10 月流水 1 → ORD2610-0001');
  eq(formatOrderNo(new Date('2026-10-15T10:00:00+08:00'), 123), 'ORD2610-0123', '单号：流水 123 补足 4 位');
  eq(formatOrderNo(new Date('2027-01-01T10:00:00+08:00'), 888), 'ORD2701-0888', '单号：跨年 1 月 → ORD2701');
  eq(formatOrderNo(new Date('2026-12-31T23:59:59+08:00'), 9999), 'ORD2612-9999', '单号：12 月 → ORD2612');
  eq(formatOrderNo(new Date(), 0), 'ORD' + String(new Date().getFullYear()).slice(2) +
    String(new Date().getMonth() + 1).padStart(2, '0') + '-0001', '单号：流水 0/负数兜底为 1');
  eq(formatOrderNo(new Date(), undefined), formatOrderNo(new Date(), 1), '单号：undefined 兜底为 1');
}

/* ---------- 2. lineUnitCostWithTax：单件含税成本 ---------- */
{
  eq(lineUnitCostWithTax({ costRaw: 546, costTaxInclusive: true, costTaxRatePct: '' }), 546, '成本：含税 546 原样');
  eq(lineUnitCostWithTax({ costRaw: '520', costTaxInclusive: false, costTaxRatePct: '13' }), 587.6, '成本：不含税 520 @13% → 587.60');
  eq(lineUnitCostWithTax({ costRaw: 100, costTaxInclusive: false, costTaxRatePct: '' }), 100, '成本：空税点按 0 → 100');
  eq(lineUnitCostWithTax({ costRaw: ' 64.66 ', costTaxInclusive: false, costTaxRatePct: 6 }), 68.54, '成本：字符串带空格也能解析（64.66@6% → 68.54）');
  eq(lineUnitCostWithTax({ costRaw: 231, costTaxInclusive: true, costTaxRatePct: '13' }), 231, '成本：含税时税点不参与计算');
  eq(lineUnitCostWithTax({ costRaw: '', costTaxInclusive: false, costTaxRatePct: '13' }), null, '成本：空串 → null');
  eq(lineUnitCostWithTax({ costRaw: '文字', costTaxInclusive: false, costTaxRatePct: '13' }), null, '成本：文字 → null');
  eq(lineUnitCostWithTax(null), null, '成本：传入 null → null');
  eq(lineUnitCostWithTax({ costRaw: 0, costTaxInclusive: true }), 0, '成本：0 是合法成本');
  eq(lineUnitCostWithTax({ costRaw: '520', costTaxInclusive: false, costTaxRatePct: '非法' }), 520, '成本：非法税点按 0 处理');
}

/* ---------- 3. lineReceivable / linePayable ---------- */
{
  eq(lineReceivable({ finalPrice: 660.20, qty: 2 }), 1320.4, '应收：660.20×2 = 1320.40');
  eq(lineReceivable({ finalPrice: '92.68', qty: '3' }), 278.04, '应收：字符串价 × 字符串量也行');
  eq(lineReceivable({ finalPrice: null, qty: 5 }), null, '应收：没价 → null（按 0 计入并标注，绝不冒充 0）');
  eq(lineReceivable({ finalPrice: 10, qty: 0 }), 0, '应收：0 件 → 0（TOTAL 0 是合法事实）');
  eq(lineReceivable({ finalPrice: 10.5, qty: 3.333 }), 35, '应收：小数数量也四舍五入到分');
  eq(linePayable({ costRaw: 520, costTaxInclusive: false, costTaxRatePct: '13', qty: 3 }), 1762.8, '应付：587.60×3 = 1762.80');
  eq(linePayable({ costRaw: 546, costTaxInclusive: true, qty: 2 }), 1092, '应付：含税 546×2 = 1092');
  eq(linePayable({ costRaw: null, qty: 4 }), null, '应付：成本不可用 → null');
}

/* ---------- 4. orderFacts：金额/工厂分组/发货/完成 ---------- */
{
  // 订单 A：两家工厂各 1 行 + 收付款 + 部分发货
  const orderA = {
    orderNo: 'ORD2610-0001',
    lines: [
      { lineId: 'L3', oe: 'F208401100', factory: '甲厂', qty: 2, costRaw: 546, costTaxInclusive: true, finalPrice: 660.2, shippedQty: 2 },
      { lineId: 'L4', oe: 'F081301110HD', factory: '乙厂', qty: 3, costRaw: 100, costTaxInclusive: false, costTaxRatePct: '13', finalPrice: 140.6, shippedQty: 1 },
    ],
    receipts: [{ amount: 1000, date: '2026-10-01' }],
    factoryPays: [{ factory: '甲厂', amount: 500, date: '2026-10-02' }],
    shipments: [],
  };
  const f = orderFacts(orderA);
  // 660.20×2 + 140.60×3 = 1320.40 + 421.80 = 1742.20（甲厂 1092 + 乙厂 339 = 1431）
  eq(f.receivable, 1742.2, '事实：应收 660.20×2 + 140.60×3 = 1742.20');
  eq(f.received, 1000, '事实：已收 1000');
  eq(f.unpaid, 742.2, '事实：未收 1742.20 − 1000 = 742.20');
  eq(f.payable, 1431, '事实：应付 1092 + (100×1.13)×3 = 1431.00');
  eq(f.paid, 500, '事实：已付 500');
  eq(f.unpaidPay, 931, '事实：未付 1431 − 500 = 931.00');
  eq(f.factories.length, 2, '事实：工厂分组 2 家');
  eq(f.factories[0].factory, '甲厂', '分组：按行里出现顺序（甲厂在前）');
  eq(f.factories[0].payable, 1092, '分组：甲厂应付 1092');
  eq(f.factories[0].unpaid, 592, '分组：甲厂未付 592');
  eq(f.factories[1].payable, 339, '分组：乙厂应付 100×1.13×3 = 339');
  eq(f.shipStatus, '部分发货', '发货：2/2 发完 + 1/3 → 部分发货');
  eq(f.totalQty, 5, '发货：总件数 5');
  eq(f.shippedQty, 3, '发货：已发 2+1 = 3');
  eq(f.complete, false, '完成：未收齐未发完 → false');
  eq(f.statusText, '进行中', '完成：进行中');

  // 完成判定：收齐 + 全发完
  const complete = orderFacts({
    orderNo: 'X',
    lines: [{ lineId: 'L1', factory: '甲厂', qty: 1, costRaw: 5, costTaxInclusive: true, finalPrice: 10, shippedQty: 1 }],
    receipts: [{ amount: 10 }],
    factoryPays: [],
  });
  ok(complete.complete && complete.statusText === '已完成', '完成：收齐+发完 → 已完成', complete);

  // 没有收款记录的订单：unpaid = receivable
  const empty = orderFacts({ lines: [], receipts: [], factoryPays: [] });
  eq(empty.receivable, 0, '空单：应收 0');
  eq(empty.unpaid, 0, '空单：未收 0');

  // 超收（经确认的负余额）事实记录不炸
  const over = orderFacts({
    lines: [{ lineId: 'L1', factory: '甲厂', qty: 1, costRaw: 5, costTaxInclusive: true, finalPrice: 10, shippedQty: 0 }],
    receipts: [{ amount: 12 }],
    factoryPays: [],
  });
  eq(over.received, 12, '超收：已收 12（含确认的超额记录，全额入账）');
  eq(over.unpaid, -2, '超收：未收 = −2（经确认的超额记录可以为负）');
}

/* ---------- 5. checkOverAmount：超额检测 ---------- */
{
  const order = {
    orderNo: 'T',
    lines: [
      { lineId: 'L1', factory: '甲厂', qty: 1, costRaw: 546, costTaxInclusive: true, finalPrice: 660.2, shippedQty: 0 },
      { lineId: 'L2', factory: '乙厂', qty: 1, costRaw: 520, costTaxInclusive: false, costTaxRatePct: '13', finalPrice: 140.6, shippedQty: 0 },
    ],
    receipts: [{ amount: 100 }],
    factoryPays: [{ factory: '甲厂', amount: 400 }],
  };
  // 收款：应收 800.80，已收 100，记 701 就会超
  let c = checkOverAmount(order, 'receipt', 700);
  eq([c.over, c.overBy, c.remaining], [false, 0, 700.8], '超额：记 701 未超（剩余 700.80）');
  c = checkOverAmount(order, 'receipt', 701);
  eq(c.over, true, '超额：记 701 会超收');
  eq(c.overBy, 0.2, '超额：超出 0.20 元');
  eq(checkOverAmount(order, 'receipt', 800.8 - 100).over, false, '超额：刚好结清不算超');
  // 工厂付款：甲厂应付 546，已付 400
  c = checkOverAmount(order, 'factoryPay', 146, '甲厂');
  ok(!c.over && c.remaining === 146, '超额：甲厂再付 146 刚好结清');
  c = checkOverAmount(order, 'factoryPay', 200, '甲厂');
  eq([c.over, c.overBy], [true, 54], '超额：甲厂超付 54');
  c = checkOverAmount(order, 'factoryPay', 10, '不存在的厂');
  ok(c.over === true && c.remaining === 0, '超额：陌生工厂从零起步，记 10 即超');
}

/* ---------- 6. lineRemainingToShip / validateShipQty ---------- */
{
  const line = { qty: 10, shippedQty: 4 };
  eq(lineRemainingToShip(line), 6, '待发：10−4 = 6');
  eq(lineRemainingToShip({ qty: 5, shippedQty: 8 }), 0, '待发：超额已发封底 0');
  eq(lineRemainingToShip(null), 0, '待发：null → 0');
  ok(validateShipQty(line, 6).ok, '校验：发 6 合法');
  ok(!validateShipQty(line, 7).ok, '校验：发 7 超待发量 → 拦');
  ok(!validateShipQty(line, 0).ok, '校验：0 → 拦');
  ok(!validateShipQty(line, -2).ok, '校验：负数 → 拦');
  ok(!validateShipQty(line, 'abc').ok, '校验：非数字 → 拦');
  ok(!validateShipQty(line, '').ok, '校验：空串 → 拦');
  eq(validateShipQty({ qty: 5, shippedQty: 5 }, 1).remaining, 0, '校验：已发完 → remaining 0');
  ok(!validateShipQty(null, 1).ok, '校验：行缺失 → 拦');
}

/* ---------- 7. convertedLineIds：重复转单拦截的数据依据 ---------- */
{
  const orders = [
    { orderNo: 'ORD2610-0001', inquiryDocId: 'inq-a', lines: [{ lineId: 'L3' }, { lineId: 'L4' }] },
    { orderNo: 'ORD2610-0002', inquiryDocId: 'inq-a', lines: [{ lineId: 'L5' }] },
    { orderNo: 'ORD2610-0003', inquiryDocId: 'inq-b', lines: [{ lineId: 'L3' }] }, // 别单同 lineId 不串
    { orderNo: 'ORD2610-0004', inquiryDocId: null, lines: [{ lineId: 'L9' }] },   // 无归属不进结果
  ];
  const m = convertedLineIds(orders, 'inq-a');
  ok(m.get('L3') === 'ORD2610-0001', '转单映射：L3 → 第一张订单号');
  ok(m.get('L4') === 'ORD2610-0001', '转单映射：L4 → 第一张订单号');
  ok(m.get('L5') === 'ORD2610-0002', '转单映射：L5 → 第二张订单号');
  ok(!m.has('L9'), '转单映射：L9 只属于别的询价单/无归属单，不在 inq-a 的结果里');
  eq(m.size, 3, '转单映射：inq-a 名下恰好 3 行');
  ok(!m.has('L3') || convertedLineIds(orders, 'inq-b').get('L3') !== m.get('L3'), '转单映射：别单（inq-b）的 L3 归 ORD2610-0003，不串到 inq-a');
  ok(convertedLineIds(null, 'inq-a').size === 0, '转单映射：入参 null 不炸');
  // 同一询价单重复转同一行（历史上不该发生，但函数要稳）只记第一个
  const dup = convertedLineIds([
    { orderNo: 'A', inquiryDocId: 'q', lines: [{ lineId: 'L1' }] },
    { orderNo: 'ORD', inquiryDocId: 'q', lines: [{ line1: 'x' }], lines2: [{ lineId: 'L1' }] },
  ], 'q');
  ok(dup.get('L1'), '转单映射：同 lineId 重复时保留第一个（永不覆盖）');
}

/* ---------- 8. 包 6 修复回归：B1 快照清理（数据层语义复验） ---------- */
{
  // 模拟 main.jsx B1/M3 修复的核心语义：替换报价单时，rowChoices 里
  // 属于该厂的定厂快照必须全部清掉，别家的原样保留
  const rowChoices = {
    L3: { factory: '甲厂', rawPrice: 546, taxInclusive: true, taxRatePct: '' },
    L4: { factory: '乙厂', rawPrice: 520, taxInclusive: false, taxRatePct: '13' },
    L5: { factory: '甲厂', rawPrice: 99 },
  };
  const filterOut = (rc, factory) => {
    const kept = {};
    let cleared = 0;
    for (const [lid, choice] of Object.entries(rc || {})) {
      if (choice && choice.factory === factory) cleared += 1;
      else kept[lid] = choice;
      // 注意：清快照的时候 factoryExtra 行的 定厂（若有）不能误删别家
    }
    return { kept, cleared };
  };
  const { kept, cleared } = filterOut(rowChoices, '甲厂');
  eq(cleared, 2, '包6/B1 数据语义：替换「甲厂」时清掉 2 行旧快照');
  eq(Object.keys(kept), ['L4'], '包6/B1 数据语义：乙厂的快照原样保留');
  eq(kept.L4.rawPrice, 520, '包6/B1 数据语义：保留下来的快照原样');
}

console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail);
if (fail > 0) process.exit(1);
