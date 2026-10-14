// 行账本（ARCHITECTURE 记账层）：稳定 lineId ↔ 物理行映射。
// 账本独立于 FortuneSheet 的表格数据保存——组件只是账本的一个视图，
// 账本才是事实源。lineId 自导入起分配，永不重用、永不随编辑改变；
// 行与原文件的对应只按物理位置（工作表 + 物理行）记，不靠 OE/名称猜。
//
// 本包范围：建账（导入时按物理行逐行分配）、随工作状态一起持久化、
// 恢复时原样带回。行状态与编辑日志在后续包里往账本上长。

/** 导入一张表时建账：物理行 0..rowCount-1 逐行分配 lineId（L1、L2、…） */
export function createLedger({ fileName = '', sheetName = '', sheetIndex = 0, rowCount = 0 } = {}) {
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push({ lineId: 'L' + (r + 1), row: r });
  }
  return {
    version: 1,
    fileName,
    sheetName,
    sheetIndex,
    // 下一个可分配序号：只增不减，保证 lineId 永不重用
    nextSeq: rowCount + 1,
    rows,
    // 工作列清单：用户在原表右侧手工加的列（不是原文件的列），
    // [{ col, name, addedAt }]；原列与工作列的区分只记在这里。
    workColumns: [],
  };
}

/**
 * 在账本上记一笔工作列（用户手工加的列）。返回新账本（不原地改）；
 * 账本缺失或旧存档没有 workColumns 字段时都能安全调用。
 */
export function noteWorkColumn(ledger, col, name) {
  if (!ledger) return ledger;
  const entry = { col, name, addedAt: new Date().toISOString() };
  return { ...ledger, workColumns: [...(ledger.workColumns || []), entry] };
}

/**
 * 发给工厂时克隆账本（包 5）：报价单与询价单共用同一套 lineId——
 * 报价单第 r 行就是询价单第 r 行（克隆那一刻按物理行对齐记下映射，
 * 之后两边各自编辑也不改这个出身）。rows/workColumns 深拷贝，
 * 两份账本从此互不影响；nextSeq 一并带过去，编号永不重用的规矩不断。
 */
export function cloneLedgerForQuote(ledger, factoryName) {
  if (!ledger) return ledger;
  return {
    ...ledger,
    rows: (ledger.rows || []).map((x) => ({ ...x })),
    workColumns: (ledger.workColumns || []).map((x) => ({ ...x })),
    clonedFrom: {
      fileName: ledger.fileName || '',
      sheetName: ledger.sheetName || '',
      factoryName: factoryName || '',
      clonedAt: new Date().toISOString(),
    },
  };
}

/** 物理行 → lineId（账本里没有这一行时返回 null） */
export function lineIdAt(ledger, row) {
  if (!ledger || !Array.isArray(ledger.rows)) return null;
  const hit = ledger.rows.find((x) => x.row === row);
  return hit ? hit.lineId : null;
}

/** lineId → 物理行（找不到返回 -1） */
export function rowOfLineId(ledger, lineId) {
  if (!ledger || !Array.isArray(ledger.rows)) return -1;
  const hit = ledger.rows.find((x) => x.lineId === lineId);
  return hit ? hit.row : -1;
}
