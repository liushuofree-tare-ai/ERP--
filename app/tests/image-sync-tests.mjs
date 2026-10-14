/* 包 10：图片对齐纯函数测试。
   场景取自真实复现：导入图 102×93 贴在 F 列格子里；用户插入的照片
   回声带自然尺寸 768×1024、left/top = 活动格左上角；删图只动画面
   不动回声。验：新图贴格、兜底封顶、回声不删图、画面删图生效、
   拖动/缩放后的几何经画面落盘、引用字段不丢、活动图认不出时不误删。 */
import {
  sheetGeometry, cellAtPoint, fitImageToCell,
  reconcileEchoImages, reconcileDomImages,
} from '../src/imageSync.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass += 1; }
  else { fail += 1; console.log('FAIL', name, '\n  got :', g, '\n  want:', w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

/* 一张接近真实客户单的表：A–G 列，图片列 F 宽 102，行高各异 */
const SHEET = {
  row: 39, column: 7,
  defaultColWidth: 64, defaultRowHeight: 21,
  config: {
    columnlen: { 0: 48, 1: 90, 2: 90, 3: 110, 4: 120, 5: 102, 6: 130 },
    rowlen: { 0: 30, 1: 21, 2: 93, 3: 104, 4: 77 },
  },
  celldata: [],
};
const geo = sheetGeometry(SHEET);
eq('leftOf(5) = 48+90+90+110+120', geo.leftOf(5), 458);
eq('topOf(2) = 30+21', geo.topOf(2), 51);
eq('widthOf(5) 图片列', geo.widthOf(5), 102);
eq('heightOf(2)', geo.heightOf(2), 93);
eq('heightOf(9) 默认行高', geo.heightOf(9), 21);

eq('cellAtPoint 正好是格角', cellAtPoint(geo, 458, 51, 39, 7), { r: 2, c: 5 });
eq('cellAtPoint 格内任意点', cellAtPoint(geo, 500, 100, 39, 7), { r: 2, c: 5 });
eq('cellAtPoint 原点', cellAtPoint(geo, 0, 0, 39, 7), { r: 0, c: 0 });
eq('cellAtPoint 负坐标', cellAtPoint(geo, -5, 0, 39, 7), null);

const fitted = fitImageToCell(SHEET, { id: 'x', src: 'data:..', width: 768, height: 1024 }, 2, 5);
eq('fitImageToCell 几何', [fitted.left, fitted.top, fitted.width, fitted.height], [458, 51, 102, 93]);
eq('fitImageToCell 锚点/kind', [fitted.anchorRow, fitted.anchorCol, fitted.kind], [2, 5, 'cell']);

/* ---- 回声对齐 ---- */
const IMPORTED = {
  id: 'img-0-0', src: 'data:image/png;base64,AAA', left: 458, top: 51,
  width: 102, height: 93, anchorRow: 2, anchorCol: 5, kind: 'cell',
  fileId: 'img-abc', byteSize: 12345,
};
/* 插入回声：新图自然尺寸出现在活动格（r3,c5：left 458, top 51+93=144） */
const INSERTED_ECHO = {
  id: 'img_XyZ_1799', src: 'data:image/jpeg;base64,BBB', left: 458, top: 144,
  width: 768, height: 1024, originWidth: 1536, originHeight: 2048,
};
{
  const r = reconcileEchoImages([IMPORTED], [IMPORTED, INSERTED_ECHO], SHEET, new Set());
  eq('回声：新图被登记', r.added.length, 1);
  const f = r.images.find((i) => i.id === INSERTED_ECHO.id);
  eq('回声：新图贴进活动格', [f.left, f.top, f.width, f.height], [458, 144, 102, 104]);
  eq('回声：新图锚点/kind', [f.anchorRow, f.anchorCol, f.kind], [3, 5, 'cell']);
  eq('回声：新图待存字节标记', [f.fileId, f.userInserted], [null, true]);
  eq('回声：导入图原样', r.images.find((i) => i.id === IMPORTED.id), IMPORTED);
  ok('回声：changed', r.changed);
}
{
  /* 新图 left/top 远在表格外 → 钳到最后一格贴入，绝不自然尺寸 */
  const far = { ...INSERTED_ECHO, id: 'img_far', left: 99999, top: 99999 };
  const r = reconcileEchoImages([], [far], SHEET, new Set());
  const f = r.images[0];
  eq('越界钳制：贴到最后一格', [f.anchorRow, f.anchorCol], [38, 6]);
  eq('越界钳制：几何=格尺寸', [f.width, f.height], [130, 21]);
  ok('越界钳制：不是自然尺寸', f.width !== 768 && f.height !== 1024);
}
{
  /* 新图坐标残缺（负数）→ 封顶兜底：宽 102、高按原图比例 */
  const bad = { ...INSERTED_ECHO, id: 'img_bad', left: -1, top: -1 };
  const r = reconcileEchoImages([], [bad], SHEET, new Set());
  const f = r.images[0];
  eq('兜底：宽封顶 102', f.width, 102);
  eq('兜底：高按比例 102*2048/1536', f.height, 136);
  ok('兜底：不是自然尺寸', f.width !== 768 && f.height !== 1024);
}
{
  /* 回声里图变少（删图的滞后回声）→ 规范图一张不少 */
  const r = reconcileEchoImages([IMPORTED], [], SHEET, new Set());
  eq('回声缺图不删', r.images.length, 1);
  eq('回声不是数组不动', reconcileEchoImages([IMPORTED], undefined, SHEET, new Set()).images.length, 1);
}
{
  /* 已知图被组件拖动：回声几何跟随；fileId 等引用以规范侧兜底 */
  const moved = { ...IMPORTED, left: 500, top: 60, width: 200, height: 150, fileId: undefined };
  delete moved.fileId;
  const r = reconcileEchoImages([IMPORTED], [moved], SHEET, new Set());
  const m = r.images[0];
  eq('回声合并：几何跟组件', [m.left, m.top, m.width, m.height], [500, 60, 200, 150]);
  eq('回声合并：fileId 不丢', m.fileId, 'img-abc');
  eq('回声合并：锚点不丢', [m.anchorRow, m.anchorCol, m.kind], [2, 5, 'cell']);
}
{
  /* 刚贴格的新图：组件的滞后回声（自然尺寸）不得冲掉贴格几何 */
  const prot = new Set([INSERTED_ECHO.id]);
  const fittedCanon = {
    ...INSERTED_ECHO, left: 458, top: 144, width: 102, height: 104,
    anchorRow: 3, anchorCol: 5, kind: 'cell', fileId: 'img-new', byteSize: 999,
  };
  const r = reconcileEchoImages([fittedCanon], [INSERTED_ECHO], SHEET, prot);
  const m = r.images[0];
  eq('保护期内几何以规范为准', [m.left, m.top, m.width, m.height], [458, 144, 102, 104]);
  eq('保护期内 fileId 已回填保留', m.fileId, 'img-new');
}

/* ---- 画面对齐 ---- */
const DOM_OF = (img, over = {}) => ({
  id: img.id, left: img.left, top: img.top, width: img.width, height: img.height, src: img.src, ...over,
});
{
  /* 画面里删了图 → 规范里删掉（复活 bug 的正解） */
  const r = reconcileDomImages([IMPORTED], [], SHEET);
  eq('画面删图：规范清空', r.images.length, 0);
  eq('画面删图：removedIds', r.removedIds, [IMPORTED.id]);
  ok('画面删图：changed', r.changed);
}
{
  /* 画面未挂载（null）→ 不动 */
  const r = reconcileDomImages([IMPORTED], null, SHEET);
  eq('画面未挂载不动', [r.images.length, r.changed], [1, false]);
}
{
  /* 拖动/缩放后冻结：几何经画面落盘 */
  const r = reconcileDomImages([IMPORTED], [DOM_OF(IMPORTED, { left: 10, top: 20, width: 300, height: 200 })], SHEET);
  const m = r.images[0];
  eq('画面几何落盘', [m.left, m.top, m.width, m.height], [10, 20, 300, 200]);
  eq('画面合并：fileId 保留', m.fileId, 'img-abc');
}
{
  /* 活动图认不出在场 → 缺席的图也不删 */
  const other = { ...IMPORTED, id: 'img-0-1', top: 144 };
  const r = reconcileDomImages([IMPORTED, other], [DOM_OF(IMPORTED)], SHEET,
    { protectUnidentifiedActive: true });
  eq('活动图未明：不删', r.images.length, 2);
  eq('活动图未明：removedIds 空', r.removedIds, []);
}
{
  /* 画面多出一张规范没有的图 → 登记 + 贴格（src 从画面带回） */
  const domNew = { id: 'img_dom_1', left: 458, top: 144, width: 768, height: 1024, src: 'data:image/jpeg;base64,CCC' };
  const r = reconcileDomImages([IMPORTED], [DOM_OF(IMPORTED), domNew], SHEET);
  eq('画面新图登记', r.added.length, 1);
  const f = r.images.find((i) => i.id === 'img_dom_1');
  eq('画面新图贴格', [f.left, f.top, f.width, f.height], [458, 144, 102, 104]);
  eq('画面新图 src 带回', f.src, 'data:image/jpeg;base64,CCC');
}
{
  /* 无变化时 changed=false（冻结路径不做无用功） */
  const r = reconcileDomImages([IMPORTED], [DOM_OF(IMPORTED)], SHEET);
  eq('画面无变化', [r.changed, r.added.length, r.removedIds.length], [false, 0, 0]);
}

console.log(`image-sync 汇总：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
