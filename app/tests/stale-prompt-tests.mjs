/* 「请拉取最新数据」弹窗判定测试（包 19，双人同用防旧数据）：
 * shouldPromptStale 是纯函数——服务器版本比本机基准新、且没被
 * 「稍后再说」压下去过才弹；压下去后同版本不再弹、新版本再弹。 */
import { shouldPromptStale } from '../src/apiClient.js';

let n = 0;
function eq(a, b, name) {
  n += 1;
  if (a !== b) throw new Error('FAIL: ' + name + '\n  got: ' + a + '\n  exp: ' + b);
  console.log('  ✓', name);
}

console.log('== 新鲜度弹窗判定');
eq(shouldPromptStale(3, 4, 0), true, '服务器更新（3→4）→ 弹');
eq(shouldPromptStale(4, 4, 0), false, '版本相同（稳态）→ 不弹');
eq(shouldPromptStale(5, 4, 0), false, '本机比服务器新 → 不弹');
eq(shouldPromptStale(0, 0, 0), false, '两边都空 → 不弹');
eq(shouldPromptStale(3, 4, 4), false, 'rev4 已被「稍后再说」压下 → 不再弹');
eq(shouldPromptStale(3, 5, 4), true, '压下 rev4 后又来 rev5 → 再弹');
eq(shouldPromptStale(3, 4, undefined), true, '从未压下（undefined）→ 照常弹');
eq(shouldPromptStale(3, 4, 2), true, '只压下过更旧的 rev2 → rev4 照常弹');

console.log('\n汇总：PASS ' + n + ' / FAIL 0');
