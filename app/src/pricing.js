// 定价计算（SPEC 第五节，纯函数、无副作用，金额一律由这里算）：
//
//   销售价 = 成本价 ×（1 + 税点）×（1 + 加价比例）+ 每件国内运费
//   · 成本列口径为「含税」时跳过税点一步（已含税的价格不得再加税）；
//   · 税点 / 加价比例以百分数传入（13 表示 13%，20 表示 20%）；
//   · 运费是每件一个数（整批运费按总件数均摊后的结果，由用户填入）；
//   · 汇率可选：填了就除以汇率换成外币价（本项目口径：人民币价 ÷ 汇率）；
//   · 结果一律四舍五入到分（2 位小数）。
//   · 成本格为空或不是数字 → 返回 null（销售价留空，绝不用 0 冒充未定价）。

/** 把任意单元格现值解析成成本数：数字原样、数字字符串解析，其余（空/文字）返回 null */
export function parseCostValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 参数解析：空/非法 → fallback（税点/加价/运费用 0，汇率用 null） */
function paramNum(x, fallback) {
  if (x === null || x === undefined || x === '') return fallback;
  const n = typeof x === 'number' ? x : Number(String(x).trim());
  return Number.isFinite(n) ? n : fallback;
}

/** 四舍五入到 2 位小数（金额口径） */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 算一行销售价。
 * 入参：{ cost, taxInclusive, taxRatePct, markupPct, freightPerUnit, fxRate }
 * 返回数字（2 位小数）或 null（成本不可用 → 该行留空）。
 */
export function computeSalesPrice({ cost, taxInclusive, taxRatePct, markupPct, freightPerUnit, fxRate } = {}) {
  const c = parseCostValue(cost);
  if (c === null) return null;
  let p = c;
  if (!taxInclusive) p *= 1 + paramNum(taxRatePct, 0) / 100;
  p *= 1 + paramNum(markupPct, 0) / 100;
  p += paramNum(freightPerUnit, 0);
  const fx = paramNum(fxRate, null);
  if (fx !== null && fx > 0) p /= fx;
  return round2(p);
}
