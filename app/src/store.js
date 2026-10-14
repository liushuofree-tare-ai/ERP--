// 工作状态持久化：localStorage 版本化键 qipei_v2_db_v1。
//
// 存档形状（v2，包 5 起）：一组文档 + 工厂名单——
//   {
//     version: 2, savedAt, imagesPersisted, imageStore,
//     factories: [工厂名…],                // 工厂名单（最小注册表）
//     factoryInfo: { [工厂名]: { contact, note } }（包 13：工厂的
//                联系人/备注；老存档缺失时按空对象读，改名/删除由
//                registry.js 的同步函数保持一致）,
//     customers: [{ name, contact, note }]（包 11：客户注册表，
//                身份就是名字本身；旧存档缺这个字段时，启动迁移
//                （registry.js migrateState）从单据播种补齐）,
//     orders: [{ orderNo, createdAt, customerName, inquiryDocId,
//                note（包 13：订单备注，可空）,
//                lines, receipts, factoryPays, shipments }]（包 8），
//     orderSeq,                             // 订单流水（只增不减）
//     activeDocId,                          // 当前打开的文档
//     docs: [{ docId, kind: 'inquiry'|'quote', factoryName,
//              inquiryId（包 11：报价单属于哪张询价单；询价单为
//                null。旧存档缺失时启动迁移按"唯一询价单"补齐）,
//              createdAt（包 11：询价单创建时间，历史单据选择器用）,
//              note（包 13：询价单备注，可空字符串）,
//              sheet（规范格式单表）, ledger, pricing,
//              source: { fileName, sheetName, sheetIndex },
//              sourceFileId（原件在 IndexedDB 里的 id）,
//              importInfo,
//              headerRow（表头行，包 6 对齐基准）,
//              priceMark: { col, taxInclusive, taxRatePct, periodCol }
//                （报价单的标价列，包 6；询价单为 null）,
//              factoryExtras: [{ row, lineId, factoryExtra }]
//                （报价单多报的行，包 6）,
//              rowChoices: { [lineId]: { factory, rawPrice,
//                taxInclusive, taxRatePct, period } }（定厂结果快照，
//                仅询价单，包 6 建、包 7 补税点快照供最终报价算税步）}]
//   }
// 询价单是客户原表变的那张可编辑表；报价单是发给某家工厂时由询价单
// 克隆出来的，每家一张。文档里的 sheet 只放"工作现场"，原文件与图片
// 的字节不进这里——存 IndexedDB 文件仓库（filedb.js），这里只留图片
// 引用（fileId + 锚点 + 几何 + 大小）。
//
// v1 存档（包 1–4 的单文档形状 { sheetsData, ledger, source, … }）在
// 读取时迁移成 v2 的单询价单文档，用户的旧工作不丢。
//
// 两种图片存法（由调用方按文件仓库可用性决定）：
//  A. 仓库模式（imageStore='idb'，包 3 起的正常路径）：图片只留引用，
//     字节在 IndexedDB 里，关页重开也在。
//  B. 本地模式（imageStore='local'，仓库不可用时的包 2 降级路径）：
//     先试完整存；配额失败就剥掉字节、标 imagesPersisted=false。

export const DB_KEY = 'qipei_v2_db_v1';
const DB_VERSION = 2;

/** v1 单文档存档 → v2 文档组（旧工作无损迁移） */
function migrateV1(obj) {
  const sheet = Array.isArray(obj.sheetsData) ? obj.sheetsData[0] : null;
  if (!sheet) return null;
  return {
    version: DB_VERSION,
    savedAt: obj.savedAt || null,
    imagesPersisted: obj.imagesPersisted !== false,
    imageStore: obj.imageStore || null,
    factories: [],
    activeDocId: 'doc-inquiry',
    docs: [{
      docId: 'doc-inquiry',
      kind: 'inquiry',
      factoryName: null,
      sheet,
      ledger: obj.ledger || null,
      pricing: obj.pricing || null,
      source: obj.source || null,
      sourceFileId: null, // v1 没记原件 id；恢复时按文件名去仓库认领
      importInfo: obj.importInfo || '',
    }],
  };
}

/** 读回已保存的工作状态；没有/损坏/版本不符时返回 null */
export function loadSaved() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj) return null;
    if (obj.version === DB_VERSION && Array.isArray(obj.docs) && obj.docs.length > 0) return obj;
    if (obj.version === 1 && Array.isArray(obj.sheetsData)) return migrateV1(obj);
    return null;
  } catch (e) {
    return null;
  }
}

/** 已保存记录的概要（自检页用） */
export function savedInfo() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return { exists: false, bytes: 0, savedAt: null, imagesPersisted: null, imageStore: null, docCount: 0 };
    let savedAt = null;
    let imagesPersisted = null;
    let imageStore = null;
    let docCount = 0;
    try {
      const obj = JSON.parse(raw);
      savedAt = obj.savedAt || null;
      imagesPersisted = obj.imagesPersisted !== false;
      imageStore = obj.imageStore || null;
      docCount = Array.isArray(obj.docs) ? obj.docs.length
        : (Array.isArray(obj.sheetsData) ? obj.sheetsData.length : 0);
    } catch (e) { /* 概要读不到细节也无妨 */ }
    return { exists: true, bytes: raw.length, savedAt, imagesPersisted, imageStore, docCount };
  } catch (e) {
    return { exists: false, bytes: 0, savedAt: null, imagesPersisted: null, imageStore: null, docCount: 0 };
  }
}

/** 把一份文档表里的图片字节（data URL）剥掉，只留几何与锚点元数据 */
function stripSheetImageBytes(sheet) {
  if (!sheet) return sheet;
  return {
    ...sheet,
    images: (sheet.images || []).map((img) => ({ ...img, src: '' })),
  };
}

function stripDocsImageBytes(docs) {
  return (docs || []).map((d) => ({ ...d, sheet: stripSheetImageBytes(d.sheet) }));
}

/**
 * 保存工作状态。payload: { savedAt, factories, activeDocId, docs }。
 * opts.imagesInIdb=true 时走仓库模式（图片只存引用）。
 * 返回 { ok, imagesPersisted, imageStore }；ok=false 表示存档没存下
 * （配额实在不够），调用方据此提示，但页面内的工作数据不受影响。
 */
export function saveWork(payload, opts = {}) {
  if (opts.imagesInIdb) {
    const refd = {
      version: DB_VERSION,
      imagesPersisted: true,
      imageStore: 'idb',
      ...payload,
      docs: stripDocsImageBytes(payload.docs),
    };
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(refd));
      return { ok: true, imagesPersisted: true, imageStore: 'idb' };
    } catch (e) {
      return { ok: false, imagesPersisted: false, imageStore: 'idb' };
    }
  }
  const full = { version: DB_VERSION, imagesPersisted: true, imageStore: 'local', ...payload };
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(full));
    return { ok: true, imagesPersisted: true, imageStore: 'local' };
  } catch (e) {
    const stripped = { ...full, imagesPersisted: false, docs: stripDocsImageBytes(payload.docs) };
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(stripped));
      return { ok: true, imagesPersisted: false, imageStore: 'local' };
    } catch (e2) {
      return { ok: false, imagesPersisted: false, imageStore: 'local' };
    }
  }
}

/** 清空已保存的工作状态（清空重开用） */
export function clearSaved() {
  try { localStorage.removeItem(DB_KEY); } catch (e) { /* 忽略 */ }
}
