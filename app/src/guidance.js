/* ================================================================
 * guidance.js —— 包 13：流程「还差哪一步」的引导状态推导（纯函数）
 *
 * 用户上手反馈（包 12 之后）：
 *   - 没报价单时比价页只画一张没有工厂列的表，看着像坏了；
 *   - 没订单时订单页只有一句被动文字，没有下一步动作。
 * 这里把「当前询价单走到哪一步了」从存档事实（报价单 / 标价列 /
 * 定厂 / 最终报价列）确定性推导出来，比价页与订单页据此给出
 * 明确说明 + 一键直达的按钮。不存任何新状态——状态永远由
 * 存档现算，存档改了引导自然跟着变。
 * ================================================================ */

/** 一张报价单是否已标价列（priceMark 存在且标了列）。 */
export function quoteIsMarked(q) {
  return !!(q && q.priceMark && q.priceMark.col !== null && q.priceMark.col !== undefined);
}

/**
 * 比价页引导状态。
 * 入参 quotes：活动询价单名下的报价单文档数组。
 * 返回 {
 *   state: 'no-quotes'（一张报价单都没有）|
 *          'unmarked'（有报价单，但一张都没标价列）|
 *          'partial'（有的标了、有的没标）|
 *          'ready'（全标了，不需要引导）,
 *   quoteCount, unmarked: [{ factoryName, docId }…]
 * }
 */
export function compareGuidanceOf(quotes) {
  const list = (quotes || []).filter((q) => q && q.kind === 'quote');
  const unmarked = list
    .filter((q) => !quoteIsMarked(q))
    .map((q) => ({ factoryName: q.factoryName, docId: q.docId }));
  const state = list.length === 0 ? 'no-quotes'
    : unmarked.length === list.length ? 'unmarked'
    : unmarked.length > 0 ? 'partial'
    : 'ready';
  return { state, quoteCount: list.length, unmarked };
}

/**
 * 比价页「定完厂之后呢」的下一步条（包 14）。用户在真实单子上定完
 * 几行厂之后问「然后呢？比较之后怎么办？」——比价页此前只报
 * 「已定厂 N 行」，不给下一步。这里和订单引导同思路：状态全部由
 * 比价模型与存档现算，不存新状态。
 * 入参：
 *   guidanceState：compareGuidanceOf 的 state。'no-quotes' /
 *     'unmarked' 时引导块已经占了页面顶部，这里返回 null 不叠加；
 *   totalRows：比价行数（0 行时也没有下一步可言，返回 null）；
 *   chosenCount：已定厂行数；
 *   quotedCount：至少有一家报了价的行数；
 *   chosenQuotedCount：已定厂、且该行确有报价的行数（正常等于
 *     chosenCount；报价后来被删光的历史定厂不算"有报价已定厂"）；
 *   unquotedCount：一家都没报价的行数（条上的部分覆盖提示用）；
 *   finalColumnGenerated：询价单表里是否已生成「最终报价」列
 *     （与订单引导同一口径：finalQuoteColOf 非空）。
 * 返回 null | {
 *   kind: 'hint'（还没定厂，一行操作提示）|
 *         'generate'（定了厂、还没最终报价 → 去生成）|
 *         'convert'（最终报价有了 → 去转订单/对客导出）|
 *         'convert-all'（有报价的行全定完 + 最终报价已有）,
 *   chosenCount, unquotedCount }
 */
export function compareNextStepOf({
  guidanceState, totalRows = 0, chosenCount = 0, quotedCount = 0,
  chosenQuotedCount = 0, unquotedCount = 0, finalColumnGenerated = false,
} = {}) {
  if (guidanceState === 'no-quotes' || guidanceState === 'unmarked') return null;
  if (!totalRows) return null;
  if (chosenCount <= 0) return { kind: 'hint', chosenCount: 0, unquotedCount };
  if (!finalColumnGenerated) return { kind: 'generate', chosenCount, unquotedCount };
  const allQuotedChosen = quotedCount > 0 && chosenQuotedCount >= quotedCount;
  return {
    kind: allQuotedChosen ? 'convert-all' : 'convert',
    chosenCount, unquotedCount,
  };
}

/**
 * 订单页（无订单时）引导状态：活动询价单离「能转订单」还差哪一步。
 * 入参：
 *   quotes：活动询价单名下的报价单文档数组；
 *   choices：询价单的定厂（rowChoices 对象）；
 *   finalColumnGenerated：询价单表里是否已生成「最终报价」列。
 * 返回 stage：
 *   'no-inquiry'（没有活动询价单）| 'no-quotes'（还没发给工厂/没回表）|
 *   'unmarked'（有报价单但没标价列）| 'no-choices'（没定厂）|
 *   'no-finals'（定厂了但没生成最终报价列）| 'ready'（可以转订单了）
 */
export function orderGuidanceOf({ hasInquiry, quotes, choices, finalColumnGenerated } = {}) {
  if (!hasInquiry) return 'no-inquiry';
  const qs = quotes || [];
  if (qs.length === 0) return 'no-quotes';
  if (!qs.some(quoteIsMarked)) return 'unmarked';
  const choiceCount = choices ? Object.keys(choices).length : 0;
  if (choiceCount === 0) return 'no-choices';
  if (!finalColumnGenerated) return 'no-finals';
  return 'ready';
}
