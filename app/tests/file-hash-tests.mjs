/* 文件内容寻址回归（包 21）：http://公网IP 不是安全上下文，crypto.subtle
 * 缺失——旧 FNV 兜底 id 不是真 SHA-256，服务器 verifyFileId 一律拒收，
 * 图片永远传不上服务器。现在兜底是纯 JS 真 SHA-256：
 *   1) 标准向量（含 100 万字节）与教科书一致；
 *   2) 与 Node crypto 的 SHA-256 逐字节一致（随机数据 + 大文件）；
 *   3) 产出的 id 必须过服务器的校验口径（正则 + sha 前缀）。 */
import { createHash, randomBytes } from 'node:crypto';

/* 强制走无 subtle 的兜底路径（与 http://公网IP 下的浏览器一致） */
globalThis.window = {};
const { hashBytes, sha256HexSync, imageIdFor, originalIdFor } = await import('../src/filedb.js');

let n = 0;
function eq(a, b, name) {
  n += 1;
  if (a !== b) throw new Error('FAIL: ' + name + '\n  got: ' + a + '\n  exp: ' + b);
  console.log('  ✓', name);
}
function ok(cond, name) {
  n += 1;
  if (!cond) throw new Error('FAIL: ' + name);
  console.log('  ✓', name);
}
const nodeSha = (u8) => createHash('sha256').update(u8).digest('hex');
const enc = new TextEncoder();

console.log('== 纯 JS SHA-256 标准向量');
eq(sha256HexSync(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '空输入');
eq(sha256HexSync(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc');
eq(sha256HexSync(new Uint8Array(1000000).fill(0x61)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', '100 万个 a');

console.log('== 与 Node crypto 一致（无 subtle 兜底路径）');
const rnd = new Uint8Array(randomBytes(123457));
eq(await hashBytes(rnd), nodeSha(rnd), '随机 123457 字节');
const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
const t0 = Date.now();
eq(await hashBytes(big), nodeSha(big), '随机 3MB+17 字节');
console.log('  （3MB 纯 JS 哈希耗时 ' + (Date.now() - t0) + 'ms）');

console.log('== id 过服务器校验口径');
const verifyLikeServer = (id, bytes) => {
  const m = /^(img|orig)-([0-9a-f]+)$/.exec(id);
  return !!m && nodeSha(bytes).startsWith(m[2]);
};
ok(verifyLikeServer(await imageIdFor(rnd), rnd), 'imageIdFor 过校验（旧 FNV id 在这里必挂）');
ok(verifyLikeServer(await originalIdFor(big), big), 'originalIdFor 过校验');

console.log('\n汇总：PASS ' + n + ' / FAIL 0');
