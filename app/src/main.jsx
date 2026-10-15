import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbook } from '@fortune-sheet/react';
import '@fortune-sheet/react/dist/index.css';
import './theme.css';
import { readWorkbook, parseSheet } from './xlsx/workbook.js';
import { sheetToFortune, applyMergeMarks } from './xlsx/toFortuneSheet.js';
import { buildQuoteXlsx, buildMinimalXlsx } from './xlsx/writeback.js';
import {
  computeFinalPrices, inquiryDataRows, applyFinalQuoteColumn,
  buildPlainExportSheet, buildPicturedExportSheet, finalQuoteColOf,
  resolveChoiceTaxRatePct, qtyPrefillForInquiry, finalBreakdownFor,
  FINAL_QUOTE_HEADER,
} from './quoteExport.js';
import QuoteExportPanel from './QuoteExportPanel.jsx';
import ExportView from './ExportView.jsx';
import { zipSync } from 'fflate';
import ConvertPanel from './ConvertPanel.jsx';
import OrdersView from './OrdersView.jsx';
import { formatOrderNo, convertedLineIds } from './orders.js';
import { createLedger, noteWorkColumn, cloneLedgerForQuote, rowOfLineId } from './ledger.js';
import { loadSaved, saveWork, clearSaved, saveWorkAndSync, buildServerPayload, adoptRemoteState, stashLocalBeforeAdopt, onSyncChange, lastSyncInfo } from './store.js';
import { detectServer, fetchServerState, pushState, isServerAvailable, openTempDownload, feishuNotify } from './apiClient.js';
import { computeSalesPrice } from './pricing.js';
import { cellValue, detectHeaderRow, columnHeaders, setCellValue, appendColumn } from './sheetOps.js';
import PricingBar from './PricingBar.jsx';
import PriceMarkBar from './PriceMarkBar.jsx';
import CompareView from './CompareView.jsx';
import {
  headerRowOf, detectPeriodColumn, computeFactoryExtras,
  buildCompareRows, choiceFromCell, pickDisplayColumns,
  generatedSalesCols, salesMarkGuardInfo,
} from './compare.js';
import {
  isFileDbAvailable, putFile, getFile, clearFiles, listOriginals,
  imageIdFor, originalIdFor, dataUrlToBytes, fileBytesToDataUrl,
} from './filedb.js';
import SelfCheck from './SelfCheck.jsx';
import OverviewView from './OverviewView.jsx';
import AiView from './AiView.jsx';
import DataPanel from './DataPanel.jsx';
import { CustomersView, FactoriesView } from './ManagementViews.jsx';
import {
  migrateState, quotesForInquiry, inquiryOfDoc, inquiryStatusOf,
  renameCustomer, renameFactory, customerDeleteBlock, factoryDeleteBlock,
  inquiryDeleteBlock, buildCustomerModel, buildFactoryModel,
  syncFactoryInfoOnRename, syncFactoryInfoOnDelete,
} from './registry.js';
import { compareGuidanceOf, compareNextStepOf, orderGuidanceOf } from './guidance.js';
import { buildOverview } from './overview.js';
import { buildAiDigest } from './aiDigest.js';
import { reconcileEchoImages, reconcileDomImages } from './imageSync.js';
import { APP_VERSION } from './version.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 表格区浮层（定价 / 最终报价详情 / 转订单 / 对客导出）：绝对定位盖在表格上方，
 *  面板自身高度有上限（超出在面板内滚动），不占用表格的布局高度。 */
const OVERLAY_STYLE = {
  position: 'absolute', top: 0, left: 0, right: 0, zIndex: 40,
  maxHeight: '78%', overflowY: 'auto',
};

// 转订单独立模块（2026-10-15 拍板）：全区视图，不再盖在询价单表格上。
// 行数据与数量列由父组件现算后传入；本组件只负责布局与交互转交。
function ConvertView({
  inquiry, rows, customerName, qtyColOptions, qtyCol, onQtyColChange,
  sheetQtys, qtyColumnName, onCreate, onViewOrder, onBack, onExportCustomer,
  sheetCols,
}) {
  const inqName = (inquiry && inquiry.source && inquiry.source.fileName) || '';
  return (
    <div className="convert-view" style={{
      flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px',
      fontFamily: 'sans-serif', fontSize: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <b className="sec-title" style={{ fontSize: 18 }}>转订单</b>
        <span style={{ color: '#666' }}>
          来源询价单{inqName ? '：' + inqName : ''} · 客户：{customerName || '（未填）'}
        </span>
        <span style={{ marginLeft: 'auto' }} />
      </div>
      {!inquiry ? (
        <div style={{ color: '#888', padding: 20 }}>
          还没有询价单——先导入客户原表，发给工厂、比价定厂之后再来转订单。
        </div>
      ) : (
        <ConvertPanel
          key={'conv-' + (inquiry.docId || '') + '-' + (qtyCol === null || qtyCol === undefined ? 'auto' : qtyCol)}
          rows={rows}
          customerName={customerName}
          sheetQtys={sheetQtys}
          qtyColumnName={qtyColumnName}
          qtyColOptions={qtyColOptions}
          qtyCol={qtyCol}
          onQtyColChange={onQtyColChange}
          onCreate={onCreate}
          onViewOrder={onViewOrder}
          onExportCustomer={onExportCustomer}
          sheetCols={sheetCols || []}
          onClose={onBack}
        />
      )}
    </div>
  );
}

// 飞书环境（内置 WebView）：它对 blob: 链接的 <a download> 常拦不住或不弹
// 保存对话框——服务器在线时改走「临时下载直链」（后端 5 分钟有效的标准
// 附件流）。拿到不到直链就退回普通 blob 下载，两条路都留。
const IS_FEISHU_UA = typeof navigator !== 'undefined' && /feishu|lark/i.test(navigator.userAgent);

/** 云端播报（Webhook 未配置时服务端 501，这里静默吞掉，绝不打扰业务流） */
function feishuAnnounce(text, card) {
  if (!isServerAvailable()) return;
  feishuNotify(text, card).catch(() => { /* 静默：通知不挡业务 */ });
}

// 初始示例数据（未导入前展示）：结构接近真实客户单，仅作占位演示。
const initialData = [
  {
    name: 'Sheet1',
    id: 'sheet-1',
    row: 12,
    column: 7,
    celldata: [
      { r: 0, c: 0, v: { v: '欧冠嘉配件采购需求', m: '欧冠嘉配件采购需求' } },
      { r: 1, c: 0, v: { v: '序号' } }, { r: 1, c: 1, v: { v: '品牌' } },
      { r: 1, c: 2, v: { v: '品牌' } }, { r: 1, c: 3, v: { v: '车型' } },
      { r: 1, c: 4, v: { v: '产品' } }, { r: 1, c: 5, v: { v: '图片' } },
      { r: 1, c: 6, v: { v: 'OE码' } },
      { r: 2, c: 0, v: { v: 1 } }, { r: 2, c: 1, v: { v: 'JETOUR' } },
      { r: 2, c: 2, v: { v: '奇瑞捷途' } }, { r: 2, c: 3, v: { v: 'jetour x90 plus' } },
      { r: 2, c: 4, v: { v: '散热器格栅' } }, { r: 2, c: 6, v: { v: 'F208401100' } },
      { r: 3, c: 0, v: { v: 2 } }, { r: 3, c: 1, v: { v: 'JETOUR' } },
      { r: 3, c: 2, v: { v: '奇瑞捷途' } }, { r: 3, c: 3, v: { v: 'jetour x90 plus' } },
      { r: 3, c: 4, v: { v: '前保险杠' } }, { r: 3, c: 6, v: { v: 'F208403101' } }
    ],
    config: { merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 7 } } }
  }
];

// 示例表的合并标题同样要带渲染标记（mc），否则只显示在首列边界（见 applyMergeMarks）
initialData[0].celldata = applyMergeMarks(initialData[0].celldata,
  Object.values(initialData[0].config.merge));

/* 定价条参数（每份文档一份，随工作存档持久化）：
   costCol/salesCol 是列序号；口径与百分比/运费/汇率按用户输入原文存，
   计算时由 pricing.js 解析。加价 20 / 运费 5 / 税点 13 是 SPEC 验算口径的默认值。 */
const DEFAULT_PRICING = {
  costCol: null, taxInclusive: false,
  taxRatePct: '13', markupPct: '20', freight: '5', fxRate: '',
  salesCol: null,
};

/* ---------- 启动恢复：模块加载时读一次存档 ---------- */
const RAW_RESTORED = loadSaved();
/* 包 11 迁移：给旧存档补报价单的 inquiryId（属于哪张询价单）并播种
   客户注册表。幂等纯函数（registry.js）；迁移过就立即落盘一次，
   让历史单从此带齐新字段——落不下也不挡启动，下次保存会带上。 */
const MIGRATED = RAW_RESTORED
  ? migrateState(RAW_RESTORED)
  : { state: null, changed: false };
const RESTORED = MIGRATED.state;
if (RAW_RESTORED && MIGRATED.changed && RESTORED) {
  try {
    saveWork(
      { ...RESTORED, savedAt: RESTORED.savedAt || new Date().toISOString() },
      { imagesInIdb: RESTORED.imageStore === 'idb' });
  } catch (e) { /* 启动落盘失败不致命 */ }
}

/** 恢复用的文档：没存进去的图片（src 为空）先不渲染，恢复流程会点亮。
 *  合并标记（mc）在这里按 config.merge 补齐：旧存档只存了 config.merge，
 *  不补的话已保存的合并标题会在编辑器里继续被截断。 */
function restorableDoc(doc) {
  if (!doc || !doc.sheet) return doc;
  const merges = Object.values((doc.sheet.config && doc.sheet.config.merge) || {});
  return {
    ...doc,
    pricing: { ...DEFAULT_PRICING, ...(doc.pricing || {}) },
    sheet: {
      ...doc.sheet,
      celldata: applyMergeMarks(doc.sheet.celldata || [], merges),
      images: (doc.sheet.images || []).filter((img) => img && img.src),
    },
  };
}

function sampleDoc() {
  return {
    docId: 'doc-inquiry', kind: 'inquiry', factoryName: null, inquiryId: null,
    sheet: initialData[0],
    // 包 11：示例单也建账——行身份有据可依，导出/比价/转订单在示例
    // 数据上与真实单走同一条路（此前 ledger=null 时导出行枚举为 0）。
    ledger: createLedger({
      fileName: '示例数据', sheetName: initialData[0].name,
      sheetIndex: 0, rowCount: initialData[0].row,
    }),
    pricing: { ...DEFAULT_PRICING },
    source: null, sourceFileId: null, importInfo: '',
    customerName: '', note: '', createdAt: null,
  };
}

/** 内置示例单（占位演示，从未导入过原件）：导入第一张真单时让位 */
function isSamplePlaceholder(d) {
  return !!d && d.docId === 'doc-inquiry' && !d.source;
}

const INIT_DOCS = RESTORED ? RESTORED.docs.map(restorableDoc) : [sampleDoc()];
const INIT_ACTIVE = RESTORED && INIT_DOCS.some((d) => d.docId === RESTORED.activeDocId)
  ? RESTORED.activeDocId
  : INIT_DOCS[0].docId;
const INIT_FACTORIES = RESTORED && Array.isArray(RESTORED.factories) ? RESTORED.factories : [];
// 工厂附加信息（包 13）：{ [工厂名]: { contact, note } }；老存档没有
// 就空对象，改名/删除由 registry.js 的 sync 函数保持同步
const INIT_FACTORY_INFO = RESTORED && RESTORED.factoryInfo &&
  typeof RESTORED.factoryInfo === 'object' ? RESTORED.factoryInfo : {};
// 客户注册表（包 11）：[{ name, contact, note }]，迁移时已从单据播种
const INIT_CUSTOMERS = RESTORED && Array.isArray(RESTORED.customers) ? RESTORED.customers : [];
// 订单与订单流水（包 8）：订单是独立于文档组的事实清单，随存档持久化；
// 状态/金额一律由 orders.js 现算，存档里只有行、收付记录、已发数量。
const INIT_ORDERS = RESTORED && Array.isArray(RESTORED.orders) ? RESTORED.orders : [];
const INIT_ORDER_SEQ = RESTORED && typeof RESTORED.orderSeq === 'number' ? RESTORED.orderSeq : 0;
const INIT_ACTIVE_DOC = INIT_DOCS.find((d) => d.docId === INIT_ACTIVE) || INIT_DOCS[0];
// 当前询价单 = 当前文档所属的那张（当前是报价单时按 inquiryId 回溯）
const INIT_INQUIRY_DOC = INIT_ACTIVE_DOC.kind === 'inquiry'
  ? INIT_ACTIVE_DOC
  : (INIT_DOCS.find((d) => d.docId === INIT_ACTIVE_DOC.inquiryId) ||
     INIT_DOCS.find((d) => d.kind === 'inquiry') || INIT_DOCS[0]);
// 定厂结果（行 → 选定工厂的原值快照）挂在询价单文档上（rowChoices）
const INIT_ROW_CHOICES = (INIT_INQUIRY_DOC && INIT_INQUIRY_DOC.rowChoices) || {};

/**
 * 工作状态的语义指纹：只取真正代表"用户工作"的部分——每份文档每格的
 * 值/公式、图片清单、账本、定价参数、来源、工厂名单与当前文档——
 * 不含组件往返时会增删的装饰字段。指纹没变 = 没发生真实编辑，doSave
 * 直接跳过：不重写存档、不把状态行从"已恢复上次的工作"误翻成"已自动保存"。
 */
// FortuneSheet 把样式**内联在单元格对象上**（不是引用样式表）：
// 字号 fs、字色 fc、加粗 bl、斜体 it、下划线 un、删除线 cl、字型 ff、
// 水平/垂直对齐 ht/vt、换行 tb、旋转 rt、背景 bg、格式 ct、边框等。
// 指纹只需覆盖这些"改了就该落盘"的字段，逐格摘成定长数组比整对象
// JSON 稳（避免组件往返塞进来的装饰字段造成假变更）。
const CELL_STYLE_KEYS = ['bl', 'it', 'ff', 'fs', 'fc', 'ht', 'vt', 'tb', 'cl', 'un', 'tr', 'bg', 'lo', 'rt'];
function cellStyleOf(cell) {
  if (!cell) return null;
  const out = [];
  let any = false;
  for (const k of CELL_STYLE_KEYS) {
    const v = cell[k];
    if (v === undefined || v === null) { out.push(null); continue; }
    any = true;
    out.push(typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  }
  if (cell.ct && (cell.ct.fa || cell.ct.t)) { any = true; out.push(cell.ct.fa || '', cell.ct.t || ''); }
  else out.push(null, null);
  return any ? out : null;
}

function sheetKeyOf(sh) {
  if (!sh) return null;
  const cfg = sh.config || {};
  // 合并单元格：按位置排序后取几何（对象键顺序不稳，必须先排再比）
  const merge = Object.values(cfg.merge || {})
    .map((m) => [m.r, m.c, m.rs, m.cs])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  // 列宽/行高：像素几何，改了就得落盘（BUG M1：旧指纹不含格式，
  // 纯格式编辑（合并/拉宽列/加高行）永远不触发保存，关页即丢）
  const columnlen = Object.entries(cfg.columnlen || {})
    .map(([k, v]) => [Number(k), Math.round(v)]).sort((a, b) => a[0] - b[0]);
  const rowlen = Object.entries(cfg.rowlen || {})
    .map(([k, v]) => [Number(k), Math.round(v)]).sort((a, b) => a[0] - b[0]);
  const rowhidden = Object.keys(cfg.rowhidden || {}).map(Number).sort((a, b) => a - b);
  const colhidden = Object.keys(cfg.colhidden || {}).map(Number).sort((a, b) => a - b);
  return {
    name: sh.name, row: sh.row, column: sh.column,
    cells: (sh.celldata || []).map((cd) => [
      cd.r, cd.c,
      cd.v ? (cd.v.v ?? null) : null,
      cd.v ? (cd.v.m ?? null) : null,
      cd.v ? (cd.v.f ?? null) : null,
      // 内联样式也进指纹：改字号/颜色/边框同属真实编辑
      cellStyleOf(cd.v),
    ]),
    merge, columnlen, rowlen, rowhidden, colhidden,
    // 边框改动（工具栏画框）也要落盘：按数量+摘要，避免整对象抖动
    borderInfo: (cfg.borderInfo || []).length,
    // 包 10：图片几何也进指纹——只拖动/缩放一张图（无改格）也是真实编辑，得落盘
    images: (sh.images || []).map((img) => [
      img.id, img.fileId || '',
      Math.round(img.left || 0), Math.round(img.top || 0),
      Math.round(img.width || 0), Math.round(img.height || 0),
    ]),
  };
}
function workKeyOf(w) {
  try {
    return JSON.stringify({
      factories: w.factories || [],
      // 包 13：工厂联系人/备注也是用户工作——改了就得落盘
      factoryInfo: w.factoryInfo || {},
      // 包 11：客户注册表也是用户工作——改名/维护联系人都要落盘
      customers: w.customers || [],
      activeDocId: w.activeDocId || null,
      // 包 8：订单与流水也算"用户工作"——变了就得落盘
      orders: w.orders || [],
      orderSeq: w.orderSeq || 0,
      docs: (w.docs || []).map((d) => ({
        docId: d.docId, kind: d.kind, factoryName: d.factoryName || null,
        // 包 11：报价单属于哪张询价单 + 询价单的创建时间
        inquiryId: d.inquiryId || null,
        createdAt: d.createdAt || null,
        // 包 8：询价单上的客户名（下单与台账用）
        customerName: d.customerName || null,
        // 包 13：询价单备注（订单备注走 orders 整包，工厂备注走 factoryInfo）
        note: d.note || null,
        source: d.source || null, sourceFileId: d.sourceFileId || null,
        importInfo: d.importInfo || '',
        ledger: d.ledger || null, pricing: d.pricing || null,
        // 包 6：表头行（对齐基准）、标价列、工厂多报行、定厂结果
        headerRow: typeof d.headerRow === 'number' ? d.headerRow : null,
        priceMark: d.priceMark || null,
        factoryExtras: d.factoryExtras || null,
        rowChoices: d.rowChoices || null,
        // 转订单数量列：改了也是真实编辑，得落盘（否则换列不保存、关页就丢）
        qtyCol: typeof d.qtyCol === 'number' ? d.qtyCol : null,
        // 对客导出记住的列勾选：变了也算真实编辑（否则 doSave 指纹不变会跳过落盘）
        exportColKeys: Array.isArray(d.exportColKeys) ? d.exportColKeys : null,
        sheet: sheetKeyOf(d.sheet),
      })),
    });
  } catch (e) {
    return null;
  }
}

/**
 * 「最近一次编辑」的人话描述：比对上/下两份工作现场，报出实际动了哪一格
 * （或图片/合并/行列几何变化）。纯展示用途，不参与任何业务判断。
 * 每轮回声都跑，但只在真的找出差异时才更新，避免无谓重渲染。
 */
export function describeEdit(prevSheet, nextSheet) {
  if (!prevSheet || !nextSheet) return '';
  const prevCells = new Map();
  for (const cd of prevSheet.celldata || []) prevCells.set(cd.r + ',' + cd.c, cd.v);
  for (const cd of nextSheet.celldata || []) {
    const before = prevCells.get(cd.r + ',' + cd.c);
    const a = before ? (before.v ?? before.m ?? null) : null;
    const b = cd.v ? (cd.v.v ?? cd.v.m ?? null) : null;
    if (String(a ?? '') !== String(b ?? '')) {
      const shown = b === null || b === undefined ? '（清空）' : String(b);
      const short = shown.length > 24 ? shown.slice(0, 24) + '…' : shown;
      return '第 ' + (cd.r + 1) + ' 行第 ' + (cd.c + 1) + ' 列 = ' + short;
    }
    prevCells.delete(cd.r + ',' + cd.c);
  }
  for (const [key] of prevCells) {
    const [r, c] = key.split(',').map(Number);
    return '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列 = （清空）';
  }
  const pn = (prevSheet.images || []).length;
  const nn = (nextSheet.images || []).length;
  if (pn !== nn) return nn > pn ? '插入了一张图片' : '删除了一张图片';
  const pm = Object.keys((prevSheet.config || {}).merge || {}).length;
  const nm = Object.keys((nextSheet.config || {}).merge || {}).length;
  if (pm !== nm) return nm > pm ? '增加了合并单元格' : '取消了合并单元格';
  return '';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
}
function fmtClock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 云端同步小字：按推送状态生成一句话（单机/空闲/稳态返回空不渲染） */
function serverSyncText(s) {
  switch (s && s.status) {
    case 'pushing': return '云端同步中…';
    case 'ok': return '已同步服务器 · ' + fmtClock(s.at) + '（rev ' + s.revision + '）';
    case 'migrated': return '本地工作已上服务器 · ' + fmtClock(s.at);
    case 'conflict': return '⚠ 服务器上已有其他窗口的更新，本窗口未覆盖——请到「数据备份」拉取';
    case 'need-auth': return '⚠ 服务器要求登录——请到「数据备份」输入访问口令';
    case 'error': return '⚠ 云端同步失败：' + (s.message || '未知原因');
    default: return ''; // local-only / in-sync 稳态不渲染
  }
}

/** 深克隆一份规范表（克隆报价单用）：格子/配置拷贝，图片对象只换壳不换字节引用 */
function cloneSheetData(sheet) {
  if (!sheet) return sheet;
  return {
    ...sheet,
    celldata: (sheet.celldata || []).map((cd) => ({ ...cd, v: cd.v ? { ...cd.v } : cd.v })),
    config: sheet.config ? {
      ...sheet.config,
      merge: { ...(sheet.config.merge || {}) },
      columnlen: { ...(sheet.config.columnlen || {}) },
      rowlen: { ...(sheet.config.rowlen || {}) },
      // BUG B3：边框/隐藏行列也要拷走——浅引用的话，改克隆件（报价单）
      // 的边框或隐藏行会顺着引用改到询价单原件上
      rowhidden: { ...(sheet.config.rowhidden || {}) },
      colhidden: { ...(sheet.config.colhidden || {}) },
      borderInfo: Array.isArray(sheet.config.borderInfo)
        ? sheet.config.borderInfo.map((b) => ({ ...b, range: b.range ? { ...b.range } : b.range }))
        : (sheet.config.borderInfo || undefined),
    } : sheet.config,
    images: (sheet.images || []).map((img) => ({ ...img })),
  };
}

/**
 * 导入落盘（包 3）：把原文件字节（原件留底）与全部工作表的图片字节
 * 存进 IndexedDB 文件仓库，并把仓库引用（fileId/byteSize）回填到
 * parsed 图片上——之后 sheetToFortune 会把引用带进工作数据，
 * localStorage 存档只存引用、恢复时按引用取字节重新点亮。
 * 图片按内容哈希寻址：相同字节只存一份，多个锚点共用一个 fileId。
 * 返回 { stored, originalFileId }；任一步失败 stored=false，调用方
 * 降级回包 2 行为（图片走 localStorage），页面照常可用。
 */
async function persistImportAssets(fileName, buf, parsedList) {
  const fail = { stored: false, originalFileId: null };
  try {
    if (!(await isFileDbAvailable())) return fail;
    const origBytes = new Uint8Array(buf);
    const origId = await originalIdFor(origBytes);
    const orig = await putFile({
      id: origId,
      kind: 'original',
      name: fileName,
      mime: XLSX_MIME,
      bytes: origBytes,
    });
    if (!orig) return fail;
    const seen = new Set();
    for (const parsed of parsedList) {
      for (const img of parsed.images || []) {
        const dec = dataUrlToBytes(img.dataUrl);
        if (!dec) return fail;
        const fid = await imageIdFor(dec.bytes);
        img.fileId = fid;
        img.byteSize = dec.bytes.length;
        if (seen.has(fid)) continue;
        seen.add(fid);
        const rec = await putFile({ id: fid, kind: 'image', bytes: dec.bytes, mime: dec.mime || img.mime });
        if (!rec) return fail;
      }
    }
    return { stored: true, originalFileId: origId };
  } catch (e) {
    return fail;
  }
}

/** 默认选表：行数最多；并列时图片多者优先；再并列取第一张 */
function pickDefaultSheet(parsedList) {
  let best = 0;
  for (let i = 1; i < parsedList.length; i++) {
    const a = parsedList[i], b = parsedList[best];
    if (a.rowCount > b.rowCount ||
        (a.rowCount === b.rowCount && a.images.length > b.images.length)) {
      best = i;
    }
  }
  return best;
}

/**
 * 把 FortuneSheet onChange 回来的"回声格式"转回可存档/可再加载的规范格式。
 * 实测（包 2）：回声里没有 celldata，现值只在 data 二维矩阵里；而组件加载时
 * 只认 celldata、忽略 data 矩阵——直接存回声，恢复出来会是空表。所以存档
 * 边界上必须做这次转换：由 data 矩阵重建 celldata，只保留输入侧字段；
 * images 一律以规范数据为准交回（回声里的图片由 onChange 里的图片对齐
 * 决定去留——包 10：回声只增不删，删图只认画面，见 imageSync.js）。
 */
/** 取某个物理格的显示文本（有格式串用格式串，否则原值）；没有就空串 */
function sheetCellText(sheet, r, c) {
  const cd = ((sheet && sheet.celldata) || []).find((x) => x.r === r && x.c === c);
  if (!cd || !cd.v) return '';
  const t = cd.v.m !== undefined && cd.v.m !== null ? cd.v.m : cd.v.v;
  return t === null || t === undefined ? '' : String(t);
}

function canonicalize(echo, prev) {
  if (!Array.isArray(echo)) return prev;
  return echo.map((sh, i) => {
    const p = prev && prev[i];
    let celldata;
    if (Array.isArray(sh.data)) {
      celldata = [];
      sh.data.forEach((rowArr, r) => {
        if (!Array.isArray(rowArr)) return;
        rowArr.forEach((cell, c) => {
          // 带 mc 的格子（合并区的主格与被覆盖格）即使没有值也要留着，合并结构才不丢
          if (cell && typeof cell === 'object' &&
              ((cell.v !== undefined && cell.v !== null && cell.v !== '') || cell.f || cell.mc)) {
            celldata.push({ r, c, v: cell });
          }
        });
      });
    } else if (Array.isArray(sh.celldata)) {
      celldata = sh.celldata;
    } else {
      celldata = (p && p.celldata) || [];
    }
    return {
      name: sh.name,
      id: sh.id,
      row: sh.row,
      column: sh.column,
      celldata,
      config: sh.config || {},
      images: (p && p.images) || sh.images || [],
      defaultColWidth: sh.defaultColWidth,
      defaultRowHeight: sh.defaultRowHeight,
      // 筛选/冻结等编辑器状态必须原样带过（2026-10-15 修「筛选不可用」）：
      // FortuneSheet 把筛选条件放在 sheet.filter / filter_select、
      // 隐藏行放在 config.rowhidden——旧实现只留 config、把 filter
      // 两个字段吞了，用户一点筛选，回声一回来筛选状态就被清掉，
      // 表现为筛选点了没反应/行藏起来又找不回来。其余几个字段
      // （冻结窗格、条件格式、超链接、数据验证）是同一类问题，一并带过。
      filter: sh.filter !== undefined ? sh.filter : (p && p.filter),
      filter_select: sh.filter_select !== undefined ? sh.filter_select : (p && p.filter_select),
      frozen: sh.frozen !== undefined ? sh.frozen : (p && p.frozen),
      calcChain: sh.calcChain !== undefined ? sh.calcChain : (p && p.calcChain),
      hyperlink: sh.hyperlink !== undefined ? sh.hyperlink : (p && p.hyperlink),
      dataVerification: sh.dataVerification !== undefined ? sh.dataVerification : (p && p.dataVerification),
      luckysheet_conditionformat_save: sh.luckysheet_conditionformat_save !== undefined
        ? sh.luckysheet_conditionformat_save : (p && p.luckysheet_conditionformat_save),
      luckysheet_alternateformat_save: sh.luckysheet_alternateformat_save !== undefined
        ? sh.luckysheet_alternateformat_save : (p && p.luckysheet_alternateformat_save),
      showGridLines: sh.showGridLines !== undefined ? sh.showGridLines : (p && p.showGridLines),
      zoomRatio: sh.zoomRatio !== undefined ? sh.zoomRatio : (p && p.zoomRatio),
    };
  });
}

/* 侧栏导航图标（包 16）：一组极简的线条 SVG，stroke 跟随文字色。
   只做装饰，不承载任何信息——拿掉图标，导航文字与顺序完全不变。 */
const icoProps = {
  width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true,
};
const NavIcon = {
  sheet: (
    <svg {...icoProps}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" />
    </svg>
  ),
  compare: (
    <svg {...icoProps}>
      <path d="M12 3.5v17M5 20.5h14" />
      <path d="M12 6.2L5.2 6.2M12 6.2l6.8 0" />
      <path d="M5.2 6.2L2.8 11a3.4 3.4 0 0 0 4.8 0L5.2 6.2zM18.8 6.2L16.4 11a3.4 3.4 0 0 0 4.8 0L18.8 6.2z" />
    </svg>
  ),
  convert: (
    <svg {...icoProps}>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 3.5v5h5" />
      <path d="M9 13.5h6M12 10.8v5.4" />
    </svg>
  ),
  export: (
    <svg {...icoProps}>
      <path d="M12 15V4.5M7.2 8.4L12 3.8l4.8 4.6" />
      <path d="M5 13.5v6h14v-6" />
    </svg>
  ),
  orders: (
    <svg {...icoProps}>
      <path d="M8.5 6.2h12M8.5 12h12M8.5 17.8h12" />
      <path d="M4 6.2h.01M4 12h.01M4 17.8h.01" strokeWidth="2.6" />
    </svg>
  ),
  customers: (
    <svg {...icoProps}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.2 19.5c.7-3 2.9-4.5 5.8-4.5s5.1 1.5 5.8 4.5" />
      <path d="M15.5 5.1a3.4 3.4 0 0 1 0 5.9M17.8 15.4c1.6.7 2.6 2 3 4.1" />
    </svg>
  ),
  factories: (
    <svg {...icoProps}>
      <path d="M3.5 20.5v-9.2l5.5 3.4v-3.4l5.5 3.4V7.2h6v13.3z" />
      <path d="M3.5 20.5h17" />
    </svg>
  ),
  overview: (
    <svg {...icoProps}>
      <path d="M4 4v15.5h16.5" />
      <path d="M8.2 16.5v-4.5M12.6 16.5V8M17 16.5V5.8" strokeWidth="2.2" />
    </svg>
  ),
  ai: (
    <svg {...icoProps}>
      <path d="M12 3.8l1.7 4.7 4.7 1.7-4.7 1.7L12 16.6l-1.7-4.7L5.6 10.2l4.7-1.7z" />
      <path d="M18.6 15.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
    </svg>
  ),
  data: (
    <svg {...icoProps}>
      <ellipse cx="12" cy="5.6" rx="7.5" ry="2.8" />
      <path d="M4.5 5.6v12.8c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.6" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </svg>
  ),
  check: (
    <svg {...icoProps}>
      <path d="M12 3.6l6.8 2.7v5.4c0 4.4-2.9 7.3-6.8 8.7-3.9-1.4-6.8-4.3-6.8-8.7V6.3z" />
      <path d="M9.2 11.8l2 2 3.6-3.8" />
    </svg>
  ),
};

function App() {
  const wbRef = useRef(null);
  const [sheetsData, setSheetsData] = useState(() => [INIT_ACTIVE_DOC.sheet]);
  const [wbKey, setWbKey] = useState(0);
  const [parsedList, setParsedList] = useState(null); // 本次导入会话解析的全部表
  const [sheetIdx, setSheetIdx] = useState(
    INIT_ACTIVE_DOC.source ? INIT_ACTIVE_DOC.source.sheetIndex || 0 : 0
  );
  const [importInfo, setImportInfo] = useState(
    RESTORED
      ? (INIT_ACTIVE_DOC.importInfo || '已恢复上次导入的表格')
      : '尚未导入（当前为示例数据）'
  );
  const [saveStatus, setSaveStatus] = useState(() => {
    if (!RESTORED) return '尚未保存';
    return '已恢复上次的工作 · ' + fmtTime(RESTORED.savedAt) +
      (RESTORED.imagesPersisted === false
        ? ' · 上次保存时空间不足，图片没存进来（重新导入原文件即可恢复图片）'
        : RESTORED.imageStore === 'idb'
          ? ' · 正在从文件仓库恢复图片…'
          : '');
  });
  // 云端同步小字（服务器在线时的推送状态；单机模式恒为 null 不渲染）
  const [serverSync, setServerSync] = useState(null);
  const [showCheck, setShowCheck] = useState(false);
  const [lastEdit, setLastEdit] = useState('（还没有编辑）');
  const [pricing, setPricingState] = useState(() => ({ ...DEFAULT_PRICING, ...(INIT_ACTIVE_DOC.pricing || {}) }));
  const [addingCol, setAddingCol] = useState(false);
  const [newColName, setNewColName] = useState('');
  // 文档组与工厂（包 5）
  const [activeDocId, setActiveDocIdState] = useState(INIT_ACTIVE);
  const [docList, setDocList] = useState(() =>
    INIT_DOCS.map((d) => ({
      docId: d.docId, kind: d.kind, factoryName: d.factoryName,
      inquiryId: d.inquiryId || null,
      customerName: d.customerName || '',
      createdAt: d.createdAt || null,
      note: d.note || '',
    })));
  const [factories, setFactoriesState] = useState(INIT_FACTORIES);
  // 工厂附加信息（包 13）：事实源在 factoryInfoRef，state 只供渲染
  const [factoryInfo, setFactoryInfoState] = useState(INIT_FACTORY_INFO);
  // 客户注册表（包 11）：事实源在 customersRef，state 只供渲染
  const [customers, setCustomersState] = useState(INIT_CUSTOMERS);
  const [selectedFactory, setSelectedFactory] = useState('');
  const [addingFactory, setAddingFactory] = useState(false);
  const [factoryInput, setFactoryInput] = useState('');
  // 比价定厂（包 6）：视图开关 + 定厂结果（事实源在询价单文档的
  // rowChoices 里，state/ref 只是渲染镜像，写入时两边一起更新）
  const [showCompare, setShowCompare] = useState(false);
  const [rowChoices, setRowChoicesState] = useState(INIT_ROW_CHOICES);
  const rowChoicesRef = useRef(INIT_ROW_CHOICES);
  const [markTick, setMarkTick] = useState(0); // 标价列保存后让标价条重挂对齐
  // 重复加价守卫（包 12）：要标的列是定价条生成的销售价列时，先
  // 把待保存的标记扣在这里弹确认，用户选了改标/照标才真正落盘
  const [markGuard, setMarkGuard] = useState(null); // { mark, info }
  // 最终报价 / 对客导出（包 7）：面板开关 + 每次打开时让默认勾选重算
  const [showExportPage, setShowExportPage] = useState(false);
  const [multiSendOpen, setMultiSendOpen] = useState(false);
  // 侧栏可收起（用户反馈侧栏太大占地方）：收起后只剩图标栏，表格区变宽；
  // 选择记在浏览器里，下次打开还是收起的样子
  // 大表格模式（用户反馈表格上下范围太小）：一键藏掉全部顶栏，
  // 只留表格本体 + 一条退出细条，纵向多出约 150px
  const [sheetFocus, setSheetFocus] = useState(false);
  // 切换大表格时让编辑器重挂一次：FortuneSheet 的画布不会随容器
  // 高度变化自动拉伸，不重挂就会出现"栏藏了、表格没变高"
  function toggleSheetFocus(next) {
    setSheetFocus(next);
    setWbKey((k) => k + 1);
  }
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return window.localStorage.getItem('erp-nav-collapsed') === '1'; } catch (e) { return false; }
  });
  const [multiSel, setMultiSel] = useState({});
  const [exportTick, setExportTick] = useState(0);
  // 转订单 / 订单履约（包 8）：客户名镜像、订单镜像与视图开关。
  // 事实源是 ordersRef（随存档持久化），state 只供渲染。
  const [customerName, setCustomerNameState] = useState(INIT_ACTIVE_DOC.customerName || '');
  // 询价单备注镜像（包 13）：事实在询价单文档的 note 里，写入走
  // setInquiryNote（docRef + 文档条目 + docList 一起更新，与客户名同路）
  const [inquiryNote, setInquiryNoteState] = useState(
    INIT_ACTIVE_DOC.kind === 'inquiry' ? (INIT_ACTIVE_DOC.note || '') : '');
  const [orders, setOrdersState] = useState(INIT_ORDERS);
  const [showConvert, setShowConvert] = useState(false);
  // 转订单数量列（当前询价单上指定的那一列；null = 没指定，走自动认）
  const [convQtyCol, setConvQtyCol] = useState(
    INIT_INQUIRY_DOC && typeof INIT_INQUIRY_DOC.qtyCol === 'number' ? INIT_INQUIRY_DOC.qtyCol : null);
  // 表格区浮层的开关（定价设置 / 最终报价详情）：与转订单、对客导出一起互斥
  const [pricingOpen, setPricingOpen] = useState(false);
  const [fqOpen, setFqOpen] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  // 总览台账 / AI 分析 / 数据备份（包 9）：与订单/比价一样是整区视图开关
  const [showOverview, setShowOverview] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [showData, setShowData] = useState(false);
  // 客户管理 / 工厂管理（包 11）：整区视图 + 各自的选中项
  const [showCustomers, setShowCustomers] = useState(false);
  const [showFactories, setShowFactories] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [selectedMgmtFactory, setSelectedMgmtFactory] = useState(null);
  // 询价单客户名「新建客户」输入态（选了"＋新建客户…"时出现）
  const [custNewMode, setCustNewMode] = useState(false);
  const [custNewName, setCustNewName] = useState('');
  const [selectedOrderNo, setSelectedOrderNo] = useState(
    INIT_ORDERS.length ? INIT_ORDERS[INIT_ORDERS.length - 1].orderNo : null);
  const ordersRef = useRef(INIT_ORDERS);
  const orderSeqRef = useRef(INIT_ORDER_SEQ);

  // 文档组的事实源：docsRef 是全部文档；docRef 是"当前文档"的元信息
  // （来源/状态/账本/定价/原件 id），其 sheet 本体在 liveRef 里。
  // 保存前 flushDocRef() 把 docRef + liveRef 写回 docsRef 对应条目。
  const docsRef = useRef(INIT_DOCS);
  const factoriesRef = useRef(INIT_FACTORIES);
  const factoryInfoRef = useRef(INIT_FACTORY_INFO);
  const customersRef = useRef(INIT_CUSTOMERS);
  const activeDocIdRef = useRef(INIT_ACTIVE);
  const docRef = useRef({
    docId: INIT_ACTIVE_DOC.docId,
    source: INIT_ACTIVE_DOC.source || null,
    importInfo: RESTORED ? (INIT_ACTIVE_DOC.importInfo || '') : '',
    ledger: INIT_ACTIVE_DOC.ledger || null,
    pricing: { ...DEFAULT_PRICING, ...(INIT_ACTIVE_DOC.pricing || {}) },
    sourceFileId: INIT_ACTIVE_DOC.sourceFileId || null,
    // 包 6：表头行（与报价单对齐的基准行）与标价列（仅报价单有意义）
    headerRow: typeof INIT_ACTIVE_DOC.headerRow === 'number' ? INIT_ACTIVE_DOC.headerRow : undefined,
    priceMark: INIT_ACTIVE_DOC.priceMark || null,
    // 包 8：客户名（只对询价单有意义，挂在询价单文档上持久化）
    customerName: INIT_ACTIVE_DOC.customerName || '',
    // 包 13：询价单备注（只对询价单有意义，随文档持久化）
    note: INIT_ACTIVE_DOC.note || '',
  });
  // 本次导入会话属于哪份文档（选表下拉只对它显示）
  const importSessionRef = useRef(RESTORED && INIT_ACTIVE_DOC.source
    ? { docId: INIT_ACTIVE_DOC.docId, fileName: INIT_ACTIVE_DOC.source.fileName || '' }
    : null);
  const workEpochRef = useRef(0); // 导入/换工作时 +1，挂载恢复流程据此放弃过期恢复
  // 当前文档的图片字节是否在 IndexedDB 文件仓库里（见包 3 说明）
  const imageStoreRef = useRef(!!(RESTORED && RESTORED.imageStore === 'idb'));
  const liveRef = useRef([INIT_ACTIVE_DOC.sheet]); // 当前文档的工作数据（规范格式）
  const saveTimerRef = useRef(null);
  const mountKeyRef = useRef(-1); // 已完成"挂载基线"的 wbKey：挂载回声不算编辑
  // 包 10 图片对齐：刚贴进格子的新图 id（重挂落地前几何以规范侧为准，
  // 防组件的滞后回声把贴格冲回自然尺寸）；以及"重挂已请求但挂载回声
  // 还没到"的标志——这段时间画面是旧的，画面对齐必须跳过，免得把
  // 刚恢复/刚切换的数据按旧画面删掉（包 9 恢复流程的同类陷阱）。
  const fittedIdsRef = useRef(new Set());
  const pendingRemountRef = useRef(false);
  function bumpWbKey() {
    pendingRemountRef.current = true;
    setWbKey((prev) => prev + 1);
  }
  const savedKeyRef = useRef(RESTORED ? workKeyOf({
    factories: INIT_FACTORIES, factoryInfo: INIT_FACTORY_INFO,
    customers: INIT_CUSTOMERS,
    activeDocId: INIT_ACTIVE, docs: INIT_DOCS,
    orders: INIT_ORDERS, orderSeq: INIT_ORDER_SEQ,
  }) : null);

  function setPricing(next) {
    docRef.current.pricing = next;
    setPricingState(next);
  }
  function setFactories(next) {
    factoriesRef.current = next;
    setFactoriesState(next);
  }
  function setFactoryInfo(next) {
    factoryInfoRef.current = next;
    setFactoryInfoState(next);
  }
  function setCustomers(next) {
    customersRef.current = next;
    setCustomersState(next);
  }
  function syncDocList() {
    setDocList(docsRef.current.map((d) => ({
      docId: d.docId, kind: d.kind, factoryName: d.factoryName,
      inquiryId: d.inquiryId || null,
      customerName: d.customerName || '',
      createdAt: d.createdAt || null,
      note: d.note || '',
    })));
  }

  /**
   * 当前询价单（包 11 的核心定位）：当前文档是询价单就是它自己；
   * 是报价单就按 inquiryId 回溯到它的询价单。比价/最终报价/转订单/
   * 对客导出/发给工厂/上传回表一律只作用于"当前询价单 + 它的报价单"，
   * 其他历史询价单的单据互不干扰。
   */
  function activeInquiryEntry() {
    const docs = docsRef.current;
    const act = docs.find((d) => d.docId === activeDocIdRef.current);
    if (act) {
      const inq = inquiryOfDoc(docs, act);
      if (inq) return inq;
    }
    return docs.find((d) => d.kind === 'inquiry') || null;
  }

  /* ---------- 图片对齐（包 10）：组件画面与规范数据互相同步 ---------- */

  /**
   * 新登记图片的字节落盘：data URL → 内容哈希 id → 文件仓库，回填
   * fileId/byteSize 到所有含这张图的文档表（克隆出的报价单共用同一
   * id，各自都要有引用才能在恢复时点亮）。落不下就保持 fileId=null：
   * 本地模式下 src 还在存档里，仓库模式下这张图恢复时会被剥掉
   * （与导入图的既有降级口径一致），不挡其他工作。
   */
  function persistInsertedImage(img) {
    if (!img || !img.src || !img.src.startsWith('data:')) return;
    const dec = dataUrlToBytes(img.src);
    if (!dec) return;
    (async () => {
      const fid = await imageIdFor(dec.bytes);
      const rec = await putFile({ id: fid, kind: 'image', bytes: dec.bytes, mime: dec.mime });
      if (!rec) return;
      imageStoreRef.current = true;
      let touched = false;
      const patch = (sh) => {
        if (!sh || !(sh.images || []).some((i) => i.id === img.id && !i.fileId)) return sh;
        touched = true;
        return {
          ...sh,
          images: sh.images.map((i) => (i.id === img.id && !i.fileId
            ? { ...i, fileId: fid, byteSize: dec.bytes.length }
            : i)),
        };
      };
      if (liveRef.current && liveRef.current[0]) {
        const next0 = patch(liveRef.current[0]);
        if (next0 !== liveRef.current[0]) {
          liveRef.current = [next0, ...liveRef.current.slice(1)];
        }
      }
      flushDocRef();
      docsRef.current = docsRef.current.map((d) => ({ ...d, sheet: patch(d.sheet) }));
      if (touched) {
        window.__wbData = liveRef.current;
        scheduleSave();
      }
    })();
  }

  /**
   * 读画面上真实存在的图片（删图只动画面、组件数据不更新——画面是
   * 唯一可信源，见 imageSync.js 文件头）。普通图框是 .img-list 的子
   * 元素（id 即图片 id）；被点选的那张不在清单里，单独挂在
   * #luckysheet-modal-dialog-activeImage，按内容 src + 几何认领。
   * 图框样式是"数据坐标 × 缩放比"，用规范里已知图的宽比反推缩放
   * 再除回去。表格没挂载（在看订单/总览等视图）返回 null。
   */
  function scrapeDomImages() {
    const listEl = document.querySelector('.img-list');
    const activeEl = document.querySelector('#luckysheet-modal-dialog-activeImage');
    if (!listEl && !activeEl) return null;
    const canon = (liveRef.current && liveRef.current[0] && liveRef.current[0].images) || [];
    const byId = new Map(canon.map((i) => [i.id, i]));
    const raw = [];
    if (listEl) {
      listEl.querySelectorAll(':scope > div.luckysheet-modal-dialog-image').forEach((el) => {
        const imgEl = el.querySelector('img');
        raw.push({
          id: el.id,
          left: parseFloat(el.style.left) || 0,
          top: parseFloat(el.style.top) || 0,
          width: parseFloat(el.style.width) || 0,
          height: parseFloat(el.style.height) || 0,
          src: imgEl ? imgEl.src : '',
        });
      });
    }
    let zoom = 1;
    const ratios = [];
    for (const d of raw) {
      const c = byId.get(d.id);
      if (c && c.width > 0 && d.width > 0) ratios.push(d.width / c.width);
    }
    if (ratios.length) {
      ratios.sort((a, b) => a - b);
      zoom = ratios[Math.floor(ratios.length / 2)] || 1;
    }
    if (!(zoom > 0) || Math.abs(zoom - 1) < 0.005) zoom = 1;
    const un = (v) => Math.round((v / zoom) * 100) / 100;
    const images = raw.map((d) => ({
      id: d.id, left: un(d.left), top: un(d.top),
      width: un(d.width), height: un(d.height), src: d.src,
    }));
    let unidentifiedActive = false;
    if (activeEl) {
      const geo = {
        left: un(parseFloat(activeEl.style.left) || 0),
        top: un(parseFloat(activeEl.style.top) || 0),
        width: un(parseFloat(activeEl.style.width) || 0),
        height: un(parseFloat(activeEl.style.height) || 0),
      };
      const content = activeEl.querySelector('.luckysheet-modal-dialog-content');
      const bg = content ? content.style.backgroundImage : '';
      const m = /^url\("?([\s\S]*?)"?\)$/.exec(bg || '');
      const src = m ? m[1] : '';
      const present = new Set(images.map((d) => d.id));
      const cands = canon.filter((c) => !present.has(c.id) && src && c.src === src);
      let pick = null;
      if (cands.length === 1) pick = cands[0];
      else if (cands.length > 1) {
        pick = cands.reduce((best, c) => (
          Math.abs(c.left - geo.left) + Math.abs(c.top - geo.top) <
          Math.abs(best.left - geo.left) + Math.abs(best.top - geo.top) ? c : best
        ), cands[0]);
      }
      if (pick) images.push({ id: pick.id, ...geo, src });
      else if (canon.some((c) => !present.has(c.id))) unidentifiedActive = true;
    }
    return { images, unidentifiedActive };
  }

  /**
   * 画面 → 规范的冻结对齐：保存/切文档/程序化改表之前调用（经由
   * flushDocRef 统一进）。画面里没有的图从规范数据里删掉——这样
   * 删过的图不会再被任何重挂/恢复画回来；拖动/缩放的几何也在这
   * 里落盘。重挂待落地（pendingRemount）时画面还是旧的，跳过。
   */
  function syncImagesFromDom() {
    if (pendingRemountRef.current) return;
    const sheet = liveRef.current && liveRef.current[0];
    if (!sheet) return;
    const scraped = scrapeDomImages();
    if (!scraped) return;
    const res = reconcileDomImages(sheet.images || [], scraped.images, sheet, {
      protectedIds: fittedIdsRef.current,
      protectUnidentifiedActive: scraped.unidentifiedActive,
    });
    if (res.changed) {
      liveRef.current = [{ ...sheet, images: res.images }, ...liveRef.current.slice(1)];
      window.__wbData = liveRef.current;
    }
    for (const img of res.added) persistInsertedImage(img);
  }

  /** 把当前文档的元信息 + 工作表从 docRef/liveRef 写回 docsRef 条目 */
  function flushDocRef() {
    syncImagesFromDom(); // 先把画面上的删图/移图对齐回规范，再写回存档事实源
    const entry = docsRef.current.find((d) => d.docId === docRef.current.docId);
    if (!entry) return;
    entry.source = docRef.current.source;
    entry.importInfo = docRef.current.importInfo;
    entry.ledger = docRef.current.ledger;
    entry.pricing = docRef.current.pricing;
    entry.sourceFileId = docRef.current.sourceFileId;
    entry.headerRow = docRef.current.headerRow;
    entry.priceMark = docRef.current.priceMark;
    entry.customerName = docRef.current.customerName || '';
    entry.note = docRef.current.note || '';
    if (liveRef.current && liveRef.current[0]) entry.sheet = liveRef.current[0];
  }

  /** 定厂结果写入：镜像（state/ref）与事实源（当前询价单文档）一起更新 */
  function setRowChoices(next) {
    rowChoicesRef.current = next;
    setRowChoicesState(next);
    const inq = activeInquiryEntry();
    if (inq) inq.rowChoices = next;
    scheduleSave();
  }

  /** 转订单数量列：选定后写到询价单文档上（随单保存，下次打开还认） */
  function handleConvertQtyColChange(col) {
    const next = typeof col === 'number' ? col : null;
    setConvQtyCol(next);
    const inq = activeInquiryEntry();
    if (inq) inq.qtyCol = next;
    scheduleSave();
  }

  function currentPayload() {
    flushDocRef();
    return {
      savedAt: new Date().toISOString(),
      factories: factoriesRef.current,
      factoryInfo: factoryInfoRef.current,
      customers: customersRef.current,
      activeDocId: activeDocIdRef.current,
      docs: docsRef.current,
      orders: ordersRef.current,
      orderSeq: orderSeqRef.current,
    };
  }

  /** 订单写入：事实源（ref）与渲染镜像（state）一起更新 */
  function setOrders(next) {
    ordersRef.current = next;
    setOrdersState(next);
  }

  /** 客户名写入（询价单文档上）：docRef + 镜像一起更新并排保存。
   *  包 11：文档条目也立即写通并刷新文档清单——询价单选择器与页签
   *  上的客户名标签读的是 docList，只等 flush 写回会迟迟不更新。 */
  function setCustomerName(name) {
    docRef.current.customerName = name;
    setCustomerNameState(name);
    const entry = docsRef.current.find((d) => d.docId === docRef.current.docId);
    if (entry) entry.customerName = name;
    syncDocList();
    scheduleSave();
  }

  /** 询价单备注写入（包 13）：与客户名同路——docRef + 文档条目 +
   *  docList 一起更新（询价单选择器要立刻带出备注后缀），排保存。 */
  function setInquiryNote(text) {
    docRef.current.note = text;
    setInquiryNoteState(text);
    const entry = docsRef.current.find((d) => d.docId === docRef.current.docId);
    if (entry) entry.note = text;
    syncDocList();
    scheduleSave();
  }

  const doSave = useCallback(() => {
    const payload = currentPayload();
    const key = workKeyOf(payload);
    if (key !== null && key === savedKeyRef.current) return; // 没变化：不重写、不改状态行
    // 云端同步走 saveWorkAndSync：本地先落袋（同步），服务器在线时异步推送
    const res = saveWorkAndSync(payload, { imagesInIdb: imageStoreRef.current });
    if (res.ok) savedKeyRef.current = key;
    if (res.ok) {
      setSaveStatus(
        '已自动保存 · ' + fmtClock(payload.savedAt) +
        (res.imageStore === 'idb'
          ? ' · 原文件与图片已存入文件仓库，关页重开也在'
          : res.imagesPersisted
            ? ''
            : ' · 图片仅本次会话可见（浏览器空间不足，图片未能保存；表格数据已存好）')
      );
    } else {
      setSaveStatus('保存失败：浏览器存储空间实在不够，本次修改只在当前页面里有效');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; doSave(); }, 900);
  }, [doSave]);

  /** 把上/下两份现场比对出的编辑，写进顶栏「最近一次编辑」提示 */
  const reportLastEdit = useCallback((prevSheet, nextSheet) => {
    const text = describeEdit(prevSheet, nextSheet);
    if (text) setLastEdit(text);
  }, []);

  // 页面切到后台/关闭前，把挂起的保存立即落盘
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        doSave();
      }
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', flush);
    window.__wbData = liveRef.current;
    window.__wbRef = wbRef;
    window.__ledger = docRef.current.ledger;
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', flush);
    };
  }, [doSave]);

  // 调试/验收钩子（与 __wbData/__ledger 一致的风格）：文档组快照
  useEffect(() => {
    flushDocRef();
    window.__docs = docsRef.current.map((d) => ({
      docId: d.docId, kind: d.kind, factoryName: d.factoryName || null,
      // 包 11：报价单属于哪张询价单、询价单的客户名
      inquiryId: d.inquiryId || null,
      customerName: d.customerName || null,
      sourceFileId: d.sourceFileId || null,
      active: d.docId === activeDocIdRef.current,
      ledgerRows: d.ledger ? d.ledger.rows : null,
      // 包 6：对齐基准行、标价列、工厂多报行数、已定厂行数
      headerRow: typeof d.headerRow === 'number' ? d.headerRow : null,
      priceMark: d.priceMark || null,
      factoryExtras: (d.factoryExtras || []).length,
      rowChoices: d.rowChoices ? Object.keys(d.rowChoices).length : 0,
    }));
    // 包 8：订单快照（验收/调试用，与 __docs 同风格）
    window.__orders = ordersRef.current;
  });

  // 包 3/5：挂载恢复——(1) v1 迁移来的文档没记 sourceFileId，按原文件名
  // 去文件仓库认领原件（认领到才能做"原样回写"的下载）；(2) 按存档里的
  // 引用（fileId）把全部文档的图片字节取回点亮。只在挂载时跑一次；
  // 期间用户若已导入新文件（epoch 变了），放弃本次恢复，绝不覆盖新工作。
  useEffect(() => {
    if (!RESTORED) return;
    const epoch = workEpochRef.current;
    let alive = true;
    (async () => {
      const available = await isFileDbAvailable();
      if (!available) {
        if (!alive || workEpochRef.current !== epoch) return;
        imageStoreRef.current = false;
        setSaveStatus('已恢复上次的工作 · ' + fmtTime(RESTORED.savedAt) +
          ' · 但图片仓库打不开，图片未能恢复（重新导入原文件即可）');
        return;
      }
      // (1) 原件认领
      let adopted = false;
      const needAdopt = docsRef.current.filter(
        (d) => !d.sourceFileId && d.source && d.source.fileName);
      if (needAdopt.length) {
        const originals = await listOriginals();
        for (const d of needAdopt) {
          const hits = originals.filter((o) => o.name === d.source.fileName);
          if (hits.length === 1) {
            d.sourceFileId = hits[0].id;
            if (docRef.current.docId === d.docId) docRef.current.sourceFileId = hits[0].id;
            adopted = true;
          }
        }
      }
      // (2) 图片点亮
      // 注意：docsRef 里的文档启动时被 restorableDoc 剥掉了无 src 的图片
      // （首屏不渲染空图），图片引用（fileId）只在原始存档里还完整——
      // 点亮必须按 docId 回原始存档取图片清单，不能从 docsRef 里找，
      // 否则引用全丢、图片永远恢复不回来（包 9 备份恢复实测抓到）。
      const rawImages = new Map();
      for (const d of RESTORED.docs || []) {
        if (d && d.sheet) rawImages.set(d.docId, d.sheet.images || []);
      }
      const fids = new Set();
      for (const imgs of rawImages.values()) {
        for (const img of imgs) {
          if (img && img.fileId) fids.add(img.fileId);
        }
      }
      if (fids.size === 0) {
        if (adopted) doSave();
        return;
      }
      const byId = new Map();
      for (const fid of fids) {
        const rec = await getFile(fid);
        if (rec && rec.bytes) byId.set(fid, fileBytesToDataUrl(rec.bytes, rec.mime));
      }
      if (!alive || workEpochRef.current !== epoch) return; // 已换新工作
      let total = 0, found = 0;
      docsRef.current = docsRef.current.map((d) => ({
        ...d,
        sheet: {
          ...d.sheet,
          images: (rawImages.get(d.docId) || (d.sheet && d.sheet.images) || []).map((img) => {
            if (!img || !img.fileId) return img;
            total += 1;
            const src = byId.get(img.fileId);
            if (src) { found += 1; return { ...img, src }; }
            return img;
          }).filter((img) => img && img.src),
        },
      }));
      const act = docsRef.current.find((d) => d.docId === activeDocIdRef.current) || docsRef.current[0];
      if (act) {
        liveRef.current = [act.sheet];
        window.__wbData = liveRef.current;
        setSheetsData([act.sheet]);
        bumpWbKey();
      }
      // 以恢复完成的样子重立指纹基线：恢复本身不是编辑
      savedKeyRef.current = workKeyOf({
        factories: factoriesRef.current,
        factoryInfo: factoryInfoRef.current,
        customers: customersRef.current,
        activeDocId: activeDocIdRef.current,
        docs: docsRef.current,
        orders: ordersRef.current,
        orderSeq: orderSeqRef.current,
      });
      if (found > 0) {
        setSaveStatus('已恢复上次的工作 · ' + fmtTime(RESTORED.savedAt) +
          ' · 图片已从文件仓库恢复（' + found + ' 张）' +
          (found < total ? ' · 另有 ' + (total - found) + ' 张没找到（重新导入原文件即可恢复）' : ''));
      } else {
        setSaveStatus('已恢复上次的工作 · ' + fmtTime(RESTORED.savedAt) +
          ' · 图片未能恢复：文件仓库里找不到图片字节（重新导入原文件即可）');
      }
      if (adopted) doSave();
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 启动对账（云端模式）：本地镜像 ↔ 服务器事实源 ---------- */
  // 规则（启动时跑一次，绝不打断用户已开始的新工作）：
  //  · 服务器不通 → 维持单机模式（saveWorkAndSync 自然走本地）；
  //  · 服务器空 + 本地有工作 → 把本地推上去（首次迁移）；
  //  · 本地空白 + 服务器有数据 → 采纳服务器（写镜像后刷新）；
  //  · 两边都有且严格一方更新 → 新者赢（相等 = 稳态，什么都不做）。
  // 采纳是覆盖性动作，规矩：
  //  · 弹确认（面板明说会先在本机留一份自动备份）；
  //  · 15 秒采纳防抖：刚采纳刷新回来落在确认窗里时不再连环采纳
  //    （防时钟偏差造成"永远比服务器旧"的接力刷新）。
  useEffect(() => {
    let alive = true;
    (async () => {
      const det = await detectServer();
      if (!alive) return;
      if (!det.available) { setServerSync({ status: 'local-only' }); return; }
      try {
        const remote = await fetchServerState();
        if (!alive || workEpochRef.current > 0) return; // 用户已导入新工作，不打扰
        const localState = RAW_RESTORED;
        const localTs = localState && localState.savedAt ? String(localState.savedAt) : null;
        if (!remote.state) {
          if (localState && Array.isArray(localState.docs) && localState.docs.length) {
            try {
              flushDocRef();
              const payload = currentPayload();
              // savedAt 沿用本地时间：推上去后两边相等，就是稳态
              if (localTs) payload.savedAt = localTs;
              await pushState(remote.revision, buildServerPayload(payload));
              setServerSync({ status: 'migrated', at: new Date().toISOString() });
            } catch (e) {
              setServerSync({ status: 'error', message: '本地工作迁移到服务器失败：' + (e && e.message || e) });
            }
          } else {
            setServerSync({ status: 'in-sync', at: null });
          }
          return;
        }
        const remoteTs = remote.state.savedAt ? String(remote.state.savedAt) : null;
        if (!localState) {
          // 本机空白：直接采纳（无需确认——本地没有可覆盖的东西）
          if (adoptRemoteState(remote.state)) location.reload();
          return;
        }
        if (!localTs || !remoteTs || remoteTs === localTs) {
          setServerSync({ status: 'in-sync', at: null });
          return;
        }
        if (remoteTs > localTs) {
          const GUARD = 'qipei_v2_adopt_guard_ms';
          const last = Number(sessionStorage.getItem(GUARD) || '0');
          if (Date.now() - last < 15000) {
            setServerSync({ status: 'in-sync', at: null }); // 刚采纳刷新回来：稳态，别连环
            return;
          }
          if (!window.confirm(
            '服务器上有更新的数据（保存于 ' + fmtTime(remoteTs) + '，rev ' + remote.revision + '）。\n' +
            '本机当前数据较旧（保存于 ' + fmtTime(localTs) + '）。\n' +
            '点「确定」采纳服务器数据（本机旧数据会先自动留一份备份，之后可在数据备份页恢复）；点「取消」保留本机数据不动。')) {
            setServerSync({ status: 'in-sync', at: null });
            return;
          }
          try {
            sessionStorage.setItem(GUARD, String(Date.now()));
            stashLocalBeforeAdopt();
          } catch (e) { /* 留不了底也不拦采纳 */ }
          if (adoptRemoteState(remote.state)) location.reload();
          return;
        }
        // 本地比服务器新：把本地推上去（savedAt 用本地原值，推完即相等）
        try {
          flushDocRef();
          const payload = currentPayload();
          payload.savedAt = localTs;
          await pushState(remote.revision, buildServerPayload(payload));
          setServerSync({ status: 'migrated', at: new Date().toISOString() });
        } catch (e) {
          setServerSync({ status: 'error', message: '本地数据推到服务器失败：' + (e && e.code === 'REVISION_CONFLICT' ? '云端已有别的修改，请到数据备份拉取' : (e && e.message || e)) });
        }
      } catch (e) {
        setServerSync({ status: 'error', message: '服务器已连通但读取失败：' + (e && e.message || e) });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 云端同步状态订阅：saveWorkAndSync 的推送结果 → 顶栏小字
  useEffect(() => {
    const last = lastSyncInfo();
    if (last && last.status !== 'idle') setServerSync(last);
    const off = onSyncChange((s) => setServerSync({ ...s }));
    return off;
  }, []);


  /**
   * 一张客户原表落位成询价单文档（包 11 起是"新增"，不再替换全部）：
   * · 新导入（docId 是新生成）→ 追加一张新询价单并切过去，原有的
   *   询价单/报价单/订单原样保留（历史单留着查）；
   * · 同 docId 重新落位（同一次导入里换工作表）→ 只替换这一张，
   *   连同它名下的报价单一起清掉重来（换表前有确认）；
   * · 内置示例单只是占位：导入第一张真单时它让位，不算历史。
   */
  function applySheet(parsed, idx, fileName, infoText, sourceFileId, docId) {
    const fortune = sheetToFortune(parsed, idx);
    const ledger = createLedger({
      fileName, sheetName: parsed.name, sheetIndex: idx, rowCount: parsed.rowCount,
    });
    // 换了表：税点/加价/运费/汇率等整表习惯保留，但成本列与销售价列
    // 是按列序号记的，新表的列对不上，一律重置待选。
    const pricing = { ...docRef.current.pricing, costCol: null, salesCol: null };
    const doc = {
      docId, kind: 'inquiry', factoryName: null, inquiryId: null,
      sheet: fortune, ledger, pricing,
      source: { fileName, sheetName: parsed.name, sheetIndex: idx },
      sourceFileId: sourceFileId || null,
      importInfo: infoText,
      // 表头行在导入时定死并存档：之后与各报价单按位置对齐就靠它，
      // 不随用户后来改表头文字而漂移。
      headerRow: detectHeaderRow(fortune),
      priceMark: null,
      rowChoices: {},
      customerName: '',
      note: '',
      createdAt: new Date().toISOString(),
    };
    workEpochRef.current += 1;
    docsRef.current = [
      ...docsRef.current.filter((d) =>
        d.docId !== docId && d.inquiryId !== docId && !isSamplePlaceholder(d)),
      doc,
    ];
    activeDocIdRef.current = doc.docId;
    setActiveDocIdState(doc.docId);
    rowChoicesRef.current = {};
    setRowChoicesState({});
    docRef.current = {
      docId: doc.docId, source: doc.source, importInfo: infoText,
      ledger, pricing, sourceFileId: doc.sourceFileId,
      headerRow: doc.headerRow, priceMark: null,
      customerName: '',
      note: '',
    };
    setCustomerNameState('');
    setInquiryNoteState('');
    setConvQtyCol(null); // 新导入的单还没指定数量列
    setCustNewMode(false);
    setPricingState(pricing);
    liveRef.current = [fortune];
    window.__ledger = ledger;
    setSheetsData([fortune]);
    bumpWbKey();
    setImportInfo(infoText);
    syncDocList();
    doSave(); // 导入是明确动作，立即落盘一次（不等防抖）
  }

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!file) return;
    try {
      setImportInfo('正在读取 ' + file.name + ' …');
      const buf = await file.arrayBuffer();
      const wb = readWorkbook(buf);
      const parsed = wb.sheets.map((s, i) => parseSheet(wb, i));
      // 原文件与图片字节先落 IndexedDB；落不下就降级（imageStoreRef=false）
      const stored = await persistImportAssets(file.name, buf, parsed);
      imageStoreRef.current = stored.stored;
      const def = pickDefaultSheet(parsed);
      // 包 11：每次导入都是一张新询价单（新 docId），旧单原样保留
      const newDocId = 'doc-inq-' + Date.now().toString(36);
      importSessionRef.current = { docId: newDocId, fileName: file.name };
      setParsedList(parsed);
      setSheetIdx(def);
      const p = parsed[def];
      applySheet(p, def, file.name,
        '已导入 ' + file.name + ' · ' + p.name + '：' +
        p.rowCount + ' 行 × ' + p.colCount + ' 列 · 图片 ' + p.images.length + ' 张' +
        (stored.stored ? '' : ' · 图片仓库不可用，图片按旧方式保存'),
        stored.originalFileId, newDocId);
    } catch (err) {
      setImportInfo('导入失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  function handleSheetChoice(e) {
    const idx = Number(e.target.value);
    if (!parsedList || !parsedList[idx]) return;
    const sessionDocId = importSessionRef.current
      ? importSessionRef.current.docId : null;
    const sessionEntry = sessionDocId
      ? docsRef.current.find((d) => d.docId === sessionDocId) : null;
    if (sessionDocId && quotesForInquiry(docsRef.current, sessionDocId).length > 0 &&
        !window.confirm('切换工作表会重新生成这张询价单，它名下的报价单会被清掉（其他询价单不受影响）。确定吗？')) {
      e.target.value = String(sheetIdx);
      return;
    }
    setSheetIdx(idx);
    const p = parsedList[idx];
    applySheet(p, idx,
      importSessionRef.current ? importSessionRef.current.fileName : '',
      '当前表 ' + p.name + '：' + p.rowCount + ' 行 × ' + p.colCount +
      ' 列 · 图片 ' + p.images.length + ' 张',
      sessionEntry ? sessionEntry.sourceFileId : null,
      sessionDocId || ('doc-inq-' + Date.now().toString(36)));
  }

  /** 切换文档：先把当前文档写回，再把目标文档装进工作区 */
  function switchDoc(docId) {
    if (docId === activeDocIdRef.current) return;
    const target = docsRef.current.find((d) => d.docId === docId);
    if (!target) return;
    flushDocRef();
    activeDocIdRef.current = docId;
    setActiveDocIdState(docId);
    docRef.current = {
      docId,
      source: target.source || null,
      importInfo: target.importInfo || '',
      ledger: target.ledger || null,
      pricing: { ...DEFAULT_PRICING, ...(target.pricing || {}) },
      sourceFileId: target.sourceFileId || null,
      headerRow: typeof target.headerRow === 'number' ? target.headerRow : undefined,
      priceMark: target.priceMark || null,
      customerName: target.customerName || '',
      note: target.note || '',
    };
    setCustomerNameState(docRef.current.customerName);
    setInquiryNoteState(target.kind === 'inquiry' ? (target.note || '') : '');
    // 转订单数量列跟着"当前询价单"走（报价单视图下仍显示所属询价单的选择）
    {
      const inqNow = activeInquiryEntry();
      setConvQtyCol(inqNow && typeof inqNow.qtyCol === 'number' ? inqNow.qtyCol : null);
    }
    setCustNewMode(false);
    setPricingState(docRef.current.pricing);
    // 定厂镜像跟随"当前询价单"：切到的文档属于另一张询价单时，
    // 比价/最终报价读的是那张单自己的定厂结果，互不串扰（包 11）
    {
      const inqNow = activeInquiryEntry();
      const rc = (inqNow && inqNow.rowChoices) || {};
      rowChoicesRef.current = rc;
      setRowChoicesState(rc);
    }
    liveRef.current = [target.sheet];
    window.__wbData = liveRef.current;
    window.__ledger = target.ledger || null;
    setSheetsData([target.sheet]);
    bumpWbKey();
    setImportInfo(target.importInfo || (target.kind === 'quote'
      ? '报价单 · ' + target.factoryName
      : '询价单'));
    doSave(); // 当前文档变了，指纹里有它，落盘记住
  }

  /** 由询价单克隆一张给某厂的报价单文档（行账本共用 lineId）；不落位、不切换 */
  function makeQuoteDoc(inq, name, existing) {
    return {
      docId: existing ? existing.docId : 'doc-quote-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      kind: 'quote',
      factoryName: name,
      // 包 11：报价单定死它属于哪张询价单，切单/比价/历史都靠这个归属
      inquiryId: inq.docId,
      sheet: cloneSheetData(inq.sheet),
      ledger: cloneLedgerForQuote(inq.ledger, name),
      pricing: { ...(inq.pricing || DEFAULT_PRICING) },
      source: inq.source || null,
      sourceFileId: inq.sourceFileId || null,
      importInfo: '报价单 · ' + name + '（由询价单克隆生成）',
      // 克隆件与询价单同版式：表头行相同；价列要等回表后另行标记，
      // 旧标记（替换重克隆时）不带过来，免得列对不上读错价。
      headerRow: headerRowOf(inq),
      priceMark: null,
      factoryExtras: [],
    };
  }

  /** 把克隆好的报价单落进文档集（替换同厂旧单时连带清掉它的定厂快照） */
  function installQuoteDoc(inq, doc, existing) {
    docsRef.current = existing
      ? docsRef.current.map((d) => (d.docId === doc.docId ? doc : d))
      : [...docsRef.current, doc];
    // BUG B1：替换重克隆与"回表重传替换"（BUG M3）同源——新报价单上
    // 没有任何标记，但定厂快照里留的还是替换前的旧价（rawPrice），
    // 最终报价会拿作废的价算钱还无从察觉。把这张询价单上"定的是这家"
    // 的快照一并清掉，并把当前询价单的镜像一起同步。
    let clearedChoices = 0;
    if (existing && inq.rowChoices) {
      const kept = {};
      for (const [lineId, choice] of Object.entries(inq.rowChoices)) {
        if (choice && choice.factory === doc.factoryName) clearedChoices += 1;
        else kept[lineId] = choice;
      }
      if (clearedChoices > 0) {
        const target = docsRef.current.find((d) => d.docId === inq.docId);
        if (target) target.rowChoices = kept;
        if (activeDocIdRef.current === inq.docId) {
          rowChoicesRef.current = kept;
          setRowChoicesState(kept);
        }
      }
    }
    if (!factoriesRef.current.includes(doc.factoryName)) {
      setFactories([...factoriesRef.current, doc.factoryName]);
    }
  }

  /** 发给工厂：由当前询价单克隆一张报价单（行账本共用 lineId），并切过去 */
  function createQuoteForFactory(name) {
    flushDocRef();
    const inq = activeInquiryEntry();
    if (!inq) return;
    const existing = docsRef.current.find(
      (d) => d.kind === 'quote' && d.factoryName === name && d.inquiryId === inq.docId);
    if (existing &&
        !window.confirm('这张询价单已经有一张给「' + name + '」的报价单了，重新生成会替换它（按询价单现在的样子重新克隆）。确定吗？')) {
      return;
    }
    const doc = makeQuoteDoc(inq, name, existing);
    installQuoteDoc(inq, doc, existing);
    syncDocList();
    switchDoc(doc.docId);
  }

  /**
   * 发给多家工厂（效率项）：一次勾多家，各克隆一张报价单，所有下载件
   * 打成一个 zip 一次拿走，人留在询价单上不被逐家切换带走。替换已有
   * 报价单的只在开头统一确认一次。
   */
  async function handleSendToManyFactories() {
    const names = factoriesRef.current.filter((f) => multiSel[f]);
    if (!names.length) { window.alert('先勾选至少一家工厂'); return; }
    flushDocRef();
    const inq = activeInquiryEntry();
    if (!inq) return;
    const replacing = names.filter((n) => docsRef.current.find(
      (d) => d.kind === 'quote' && d.factoryName === n && d.inquiryId === inq.docId));
    if (replacing.length &&
        !window.confirm('以下工厂已有这张询价单的报价单，重新生成会替换它们：' +
          replacing.join('、') + '。确定吗？')) {
      return;
    }
    const made = [];
    for (const name of names) {
      const existing = docsRef.current.find(
        (d) => d.kind === 'quote' && d.factoryName === name && d.inquiryId === inq.docId);
      const doc = makeQuoteDoc(inq, name, existing);
      installQuoteDoc(inq, doc, existing);
      made.push(doc);
    }
    syncDocList();
    doSave();
    let origBytes = null;
    if (inq.sourceFileId) {
      try {
        const rec = await getFile(inq.sourceFileId);
        if (rec && rec.bytes) origBytes = rec.bytes;
      } catch (e) { /* 取不到原件就走现生成降级（buildQuoteXlsx 内部处理） */ }
    }
    const entries = {};
    for (const doc of made) {
      entries['报价单-' + doc.factoryName + '.xlsx'] = buildQuoteXlsx({
        originalBytes: origBytes,
        sheetName: (doc.source && doc.source.sheetName) || doc.sheet.name,
        sheet: doc.sheet,
        imageBytes: await resolveExportImageBytes(doc.sheet),
      });
    }
    const now = new Date();
    const ymd = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    await downloadViaFeishuOrBlob(zipSync(entries),
      '询价单-发给工厂-' + ymd + '.zip', 'application/zip');
    setMultiSendOpen(false);
    window.alert('已给 ' + made.length + ' 家工厂生成报价单并打包下载：' +
      names.join('、') + '。这些报价单也已出现在上方单据列表里；工厂回表后，用「上传回表」挂到对应工厂名下即可。');
  }

  function confirmAddFactory() {
    const name = factoryInput.trim();
    setAddingFactory(false);
    setFactoryInput('');
    if (!name) return;
    if (!factoriesRef.current.includes(name)) {
      setFactories([...factoriesRef.current, name]);
    }
    setSelectedFactory(name);
    scheduleSave(); // 名单也是工作状态的一部分（指纹含它）
  }

  function handleSendToFactory() {
    if (addingFactory) {
      const name = factoryInput.trim();
      if (!name) return;
      setAddingFactory(false);
      setFactoryInput('');
      setSelectedFactory(name);
      createQuoteForFactory(name);
      return;
    }
    const name = selectedFactory || factoriesRef.current[0] || '';
    if (!name) { setAddingFactory(true); return; }
    createQuoteForFactory(name);
  }

  /* ---------- 上传回表（包 6）：原样成为该厂的报价单 ---------- */

  /** 解析好的回表落位成报价单文档：自己的版式、自己的账本、自己的原件。
   *  包 11：回表挂到"当前询价单"名下（inquiryId），多报行也只对它对齐。
   *  BUG M2：目标询价单由调用方在 await 之前定下（pinnedInquiry），不再
   *  在这里重新 activeInquiryEntry()——读文件期间用户切了单的话，旧实现
   *  会把回表挂到切换后的那张单上，行对齐全错位。 */
  function applyUploadedQuote(name, fileName, parsedList, stored, pinnedInquiry) {
    const idx = pickDefaultSheet(parsedList);
    const parsed = parsedList[idx];
    const fortune = sheetToFortune(parsed, idx);
    let ledger = createLedger({
      fileName, sheetName: parsed.name, sheetIndex: idx, rowCount: parsed.rowCount,
    });
    const headerRow = detectHeaderRow(fortune);
    const inq = pinnedInquiry !== undefined ? pinnedInquiry : activeInquiryEntry();
    // 工厂比询价单多报的行：按对齐位置多出来的，分配新 lineId 并标记
    let factoryExtras = [];
    if (inq) {
      const res = computeFactoryExtras(
        { sheet: inq.sheet, headerRow: inq.headerRow }, fortune, ledger);
      factoryExtras = res.extras;
      if (res.extras.length > 0) ledger = { ...ledger, nextSeq: res.nextSeq };
    }
    const existing = docsRef.current.find(
      (d) => d.kind === 'quote' && d.factoryName === name &&
        (!inq || d.inquiryId === inq.docId));
    const doc = {
      docId: existing ? existing.docId : 'doc-quote-' + Date.now().toString(36),
      kind: 'quote',
      factoryName: name,
      inquiryId: inq ? inq.docId : null,
      sheet: fortune,
      ledger,
      pricing: { ...DEFAULT_PRICING },
      source: { fileName, sheetName: parsed.name, sheetIndex: idx },
      sourceFileId: stored.stored ? stored.originalFileId : null,
      importInfo: '报价单 · ' + name + '（回表原样上传：' + parsed.rowCount +
        ' 行 × ' + parsed.colCount + ' 列 · 图片 ' + parsed.images.length + ' 张）',
      headerRow,
      priceMark: null,
      factoryExtras,
    };
    docsRef.current = existing
      ? docsRef.current.map((d) => (d.docId === doc.docId ? doc : d))
      : [...docsRef.current, doc];
    // BUG M3：替换重传时，这张询价单上"定的是这家"的旧定厂快照必须一并清掉。
    // 快照里存的是替换前的旧价（rawPrice），留着会让最终报价按已作废的价算钱。
    let clearedChoices = 0;
    if (existing && inq && inq.rowChoices) {
      const kept = {};
      for (const [lineId, choice] of Object.entries(inq.rowChoices)) {
        if (choice && choice.factory === name) clearedChoices += 1;
        else kept[lineId] = choice;
      }
      if (clearedChoices > 0) {
        const target = docsRef.current.find((d) => d.docId === inq.docId);
        if (target) target.rowChoices = kept;
        if (activeDocIdRef.current === inq.docId) {
          rowChoicesRef.current = kept;
          setRowChoicesState(kept);
        }
      }
    }
    if (!factoriesRef.current.includes(name)) {
      setFactories([...factoriesRef.current, name]);
    }
    syncDocList();
    if (activeDocIdRef.current === doc.docId) {
      // 正在看的正是这家（替换重传）：switchDoc 不会动，手动把新文档装进工作区
      docRef.current = {
        docId: doc.docId, source: doc.source, importInfo: doc.importInfo,
        ledger: doc.ledger, pricing: doc.pricing, sourceFileId: doc.sourceFileId,
        headerRow: doc.headerRow, priceMark: null,
      };
      setPricingState(doc.pricing);
      liveRef.current = [doc.sheet];
      window.__wbData = liveRef.current;
      window.__ledger = doc.ledger;
      setSheetsData([doc.sheet]);
      bumpWbKey();
      setImportInfo(clearedChoices > 0
        ? doc.importInfo + ' · 原「' + name + '」的 ' + clearedChoices +
          ' 行定厂结果已清空（用的是旧价），请重新比价定厂'
        : doc.importInfo);
      doSave();
    } else {
      switchDoc(doc.docId);
      if (clearedChoices > 0) {
        setImportInfo('「' + name + '」回表已替换：' + clearedChoices +
          ' 行的定厂结果已清空（用的是旧价），请重新比价定厂');
      }
    }
  }

  async function handleUploadReturn(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!file) return;
    let name = '';
    if (addingFactory && factoryInput.trim()) {
      name = factoryInput.trim();
      setAddingFactory(false);
      setFactoryInput('');
    } else {
      name = selectedFactory || factoriesRef.current[0] || '';
    }
    if (!name) {
      setImportInfo('请先选择或新建工厂，再上传回表');
      setAddingFactory(true);
      return;
    }
    setSelectedFactory(name);
    // BUG M2：目标询价单在这一刻定死（await 之前）。读文件、写仓库都要等，
    // 期间用户可能切到别的询价单；等回来再 activeInquiryEntry() 就会挂错单。
    const inqNow = activeInquiryEntry();
    const existing = docsRef.current.find(
      (d) => d.kind === 'quote' && d.factoryName === name &&
        (!inqNow || d.inquiryId === inqNow.docId));
    if (existing &&
        !window.confirm('「' + name + '」在这张询价单下已有一张报价单，用这份新回表替换它吗？（原来的标记会被清掉，需要重新标价列；这一家的定厂结果也会清空，需重新比价）')) {
      return;
    }
    try {
      setImportInfo('正在读取回表 ' + file.name + ' …');
      const buf = await file.arrayBuffer();
      const wb = readWorkbook(buf);
      const parsed = wb.sheets.map((s, i) => parseSheet(wb, i));
      // 原件与图片字节落文件仓库（与询价单导入同一条路）；落不下走降级
      const stored = await persistImportAssets(file.name, buf, parsed);
      imageStoreRef.current = stored.stored;
      applyUploadedQuote(name, file.name, parsed, stored, inqNow);
    } catch (err) {
      setImportInfo('回表上传失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  /* ---------- 标价列 / 删除报价单（包 6） ---------- */

  function applyPriceMark(mark) {
    docRef.current.priceMark = mark;
    flushDocRef();
    setMarkTick((t) => t + 1); // 让标价条按已保存的标记重挂（状态文案对齐）
    scheduleSave();
  }

  /**
   * 保存标价列标记（包 6），包 12 起先过重复加价守卫：要标的列是
   * 定价条在这张单上生成的「销售价」列（卖价已含税+加价）时不直接
   * 落盘——用户把卖价当工厂价标过一次，最终价被重复加价还无从
   * 察觉。守卫弹窗里默认走安全路（改标成本价）；用户明确点"仍要
   * 这样标记"才照原样保存。
   */
  function handleSavePriceMark(mark) {
    if (mark && mark.col !== null && mark.col !== undefined) {
      flushDocRef();
      const doc = docsRef.current.find((d) => d.docId === activeDocIdRef.current);
      const info = doc ? salesMarkGuardInfo(doc, mark.col) : null;
      if (info) { setMarkGuard({ mark, info }); return; }
    }
    applyPriceMark(mark);
  }

  function handleDeleteQuote() {
    const doc = docsRef.current.find((d) => d.docId === activeDocIdRef.current);
    if (!doc || doc.kind !== 'quote') return;
    if (!window.confirm('确定删除「' + doc.factoryName + '」的报价单吗？已定给这家的行会一并取消定厂。')) return;
    // 这张报价单的东家询价单：定厂快照记在它身上，清理也要清它那份
    const owner = docsRef.current.find((d) => d.docId === doc.inquiryId) || null;
    docsRef.current = docsRef.current.filter((d) => d.docId !== doc.docId);
    if (owner) {
      const nextChoices = { ...(owner.rowChoices || {}) };
      let dropped = false;
      for (const lid of Object.keys(nextChoices)) {
        if (nextChoices[lid] && nextChoices[lid].factory === doc.factoryName) {
          delete nextChoices[lid];
          dropped = true;
        }
      }
      if (dropped) owner.rowChoices = nextChoices;
      // 定厂镜像由下面的 switchDoc 按新当前询价单统一同步
    }
    syncDocList();
    const target = owner || docsRef.current.find((d) => d.kind === 'inquiry') || docsRef.current[0];
    if (target) switchDoc(target.docId);
    doSave();
  }

  /* ---------- 比价定厂（包 6） ---------- */

  /** 总览/AI/管理页的输入：先把当前文档写回事实源，再取全量现算 */
  function currentStateForReports() {
    flushDocRef();
    return {
      docs: docsRef.current,
      factories: factoriesRef.current,
      factoryInfo: factoryInfoRef.current,
      customers: customersRef.current,
      orders: ordersRef.current,
    };
  }

  /** 比价模型：只比"当前询价单 + 它名下的报价单"（包 11 多询价单隔离） */
  function buildModel() {
    flushDocRef();
    const inq = activeInquiryEntry();
    if (!inq) return { factories: [], rows: [], sheetCols: [] };
    const quotes = quotesForInquiry(docsRef.current, inq.docId);
    const model = buildCompareRows({ inquiry: inq, quotes });
    // 显示列（用户口径）：比价/转订单里能选着显示的信息列，是询价单
    // 原表的全部列；每行带上这些列在原表里的原值，视图按勾选渲染
    model.sheetCols = columnHeaders(inq.sheet);
    for (const row of model.rows) {
      const r = rowOfLineId(inq.ledger, row.lineId);
      const values = {};
      if (r >= 0) {
        for (const { col } of model.sheetCols) values[col] = sheetCellText(inq.sheet, r, col);
      }
      row.values = values;
    }
    return model;
  }

  function handleChooseCell(row, cell) {
    if (!cell) return;
    const cur = rowChoicesRef.current[row.lineId];
    if (cur && cur.factory === cell.factory) {
      // 再点一次已定的那家 = 取消这一行的定厂
      const next = { ...rowChoicesRef.current };
      delete next[row.lineId];
      setRowChoices(next);
      return;
    }
    const choice = choiceFromCell(cell); // 没报价的格子返回 null，点了没反应
    if (choice) setRowChoices({ ...rowChoicesRef.current, [row.lineId]: choice });
  }

  function handleBulkAll(factory) {
    const model = buildModel();
    const next = { ...rowChoicesRef.current };
    for (const row of model.rows) {
      const choice = choiceFromCell(row.cells[factory]);
      if (choice) next[row.lineId] = choice;
    }
    setRowChoices(next);
  }

  function handleBulkLowest() {
    const model = buildModel();
    const next = { ...rowChoicesRef.current };
    for (const row of model.rows) {
      const f = row.lowestFactories && row.lowestFactories[0];
      if (!f) continue;
      const choice = choiceFromCell(row.cells[f]);
      if (choice) next[row.lineId] = choice;
    }
    setRowChoices(next);
  }

  /* ---------- 下载 / 微信分享 ---------- */

  /**
   * 导出前补图字节（包 12）：表上的图若只剩仓库引用（fileId）而没有
   * 现成的 dataURL（刚从存档恢复、还没点亮的那批），先去文件仓库把
   * 字节取回，免得导出嵌图时漏掉。用在 images 与 exportImages 两处。
   */
  async function resolveExportImageBytes(sheet) {
    const need = new Set();
    for (const list of [(sheet && sheet.images) || [], (sheet && sheet.exportImages) || []]) {
      for (const img of list) {
        if (img && img.fileId && !(img.src && String(img.src).startsWith('data:'))) {
          need.add(img.fileId);
        }
      }
    }
    if (!need.size) return undefined;
    const map = {};
    for (const fid of need) {
      try {
        const rec = await getFile(fid);
        if (rec && rec.bytes) map[fid] = rec.bytes;
      } catch (e) { /* 取不到就跳过这张，不挡导出 */ }
    }
    return Object.keys(map).length ? map : undefined;
  }

  /** 生成当前文档的下载件：有原件就在原件上原样回写现值，否则现生成 */
  async function buildActiveFile() {
    flushDocRef();
    const doc = docsRef.current.find((d) => d.docId === activeDocIdRef.current);
    if (!doc || !doc.sheet) return null;
    let origBytes = null;
    if (doc.sourceFileId) {
      try {
        const rec = await getFile(doc.sourceFileId);
        if (rec && rec.bytes) origBytes = rec.bytes;
      } catch (e) { /* 取不到原件就走现生成降级 */ }
    }
    const bytes = buildQuoteXlsx({
      originalBytes: origBytes,
      sheetName: (doc.source && doc.source.sheetName) || doc.sheet.name,
      sheet: doc.sheet,
      imageBytes: await resolveExportImageBytes(doc.sheet),
    });
    let fileName = '询价单.xlsx';
    if (doc.kind === 'quote') {
      fileName = '报价单-' + doc.factoryName + '.xlsx';
    } else if (doc.kind === 'custquote') {
      const inqDoc = docsRef.current.find((d) => d.docId === doc.inquiryId);
      const cust = inqDoc && inqDoc.customerName
        ? String(inqDoc.customerName).replace(/[\\/:*?"<>|]/g, '').trim() : '';
      const now = new Date();
      const ymd = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0');
      fileName = '报价-' + (cust || '客户') + '-' + ymd + '.xlsx';
    }
    return { bytes, fileName };
  }

  async function handleDownload() {
    const f = await buildActiveFile();
    if (!f) return;
    // 飞书内置浏览器：blob 下载常被拦——服务器在线时走临时直链
    if (IS_FEISHU_UA && isServerAvailable()) {
      try { await openTempDownload(f.bytes, f.fileName, XLSX_MIME); return; } catch (e) { /* 掉回普通下载 */ }
    }
    const blob = new Blob([f.bytes], { type: XLSX_MIME });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    window.__lastQuoteDownload = {
      fileName: f.fileName, size: f.bytes.length, at: new Date().toISOString(),
    };
  }

  /** 发送到微信…：走 Web Share 的文件分享（主要在手机浏览器上可用）；
   *  用户取消/失败一律静默，不弹错误。 */
  async function handleShare() {
    try {
      const f = await buildActiveFile();
      if (!f) return;
      const file = new File([f.bytes], f.fileName, { type: XLSX_MIME });
      await navigator.share({ files: [file] });
    } catch (e) { /* 取消分享是正常操作，静默 */ }
  }

  // 当前浏览器支不支持"把文件直接分享出去"（渲染期探一次即可）
  let canShareFiles = false;
  try {
    canShareFiles = !!(navigator.canShare && navigator.canShare({
      files: [new File([new Blob(['x'])], 'probe.xlsx', { type: XLSX_MIME })],
    }));
  } catch (e) { canShareFiles = false; }

  /** 定价条改参数：同步状态与存档事实源，并排一次保存（指纹含参数） */
  const onPricingChange = useCallback((patch) => {
    const next = { ...docRef.current.pricing, ...patch };
    docRef.current.pricing = next;
    setPricingState(next);
    scheduleSave();
  }, [scheduleSave]);

  /** 程序化改表（加列/写价共用）：替换工作数据、重挂组件、立即落盘 */
  function commitSheets(nextSheets) {
    // 先把画面对齐回规范（用户刚删的图可能还没等到防抖保存），再把
    // 对齐后的图片清单并进待提交的表——否则这次重挂会把刚删的图画回来
    syncImagesFromDom();
    if (nextSheets[0] && liveRef.current && liveRef.current[0]) {
      nextSheets = [{ ...nextSheets[0], images: liveRef.current[0].images },
        ...nextSheets.slice(1)];
    }
    liveRef.current = nextSheets;
    window.__wbData = nextSheets;
    setSheetsData(nextSheets);
    bumpWbKey();
    doSave();
  }

  /** ＋加一列：在最右侧追加工作列，账本记一笔（与原列区分） */
  function confirmAddColumn() {
    const name = newColName.trim();
    setAddingCol(false);
    setNewColName('');
    if (!name) return;
    const sheet = liveRef.current && liveRef.current[0];
    if (!sheet) return;
    const res = appendColumn(sheet, detectHeaderRow(sheet), name);
    if (docRef.current.ledger) {
      docRef.current.ledger = noteWorkColumn(docRef.current.ledger, res.col, name);
      window.__ledger = docRef.current.ledger;
    }
    commitSheets([res.sheet, ...liveRef.current.slice(1)]);
  }

  /** 计算销售价：逐行套 SPEC 第五节公式，写入专属「销售价」列 */
  function handleCalculate() {
    const sheet = liveRef.current && liveRef.current[0];
    if (!sheet) return;
    const p = docRef.current.pricing;
    if (p.costCol === null || p.costCol === undefined || p.costCol >= (sheet.column || 0)) {
      window.alert('请先在定价条里选择成本价列');
      return;
    }
    const fxText = String(p.fxRate ?? '').trim();
    const fx = fxText === '' ? null : Number(fxText);
    const hasFx = fx !== null && Number.isFinite(fx) && fx > 0;
    const label = hasFx ? '销售价（外币）' : '销售价';
    const headerRow = detectHeaderRow(sheet);
    const headerIs = (s, c, texts) => {
      const t = cellValue(s, headerRow, c);
      return typeof t === 'string' && texts.includes(t.trim());
    };
    let salesCol = null;
    if (p.salesCol !== null && p.salesCol !== undefined &&
        p.salesCol < (sheet.column || 0) &&
        headerIs(sheet, p.salesCol, ['销售价', '销售价（外币）'])) {
      salesCol = p.salesCol;
    } else {
      for (let c = 0; c < (sheet.column || 0); c++) {
        if (headerIs(sheet, c, ['销售价', '销售价（外币）'])) { salesCol = c; break; }
      }
    }
    if (salesCol !== null) {
      const hasValues = (sheet.celldata || []).some((cell) => {
        if (cell.c !== salesCol || cell.r === headerRow) return false;
        const v = cellValue(sheet, cell.r, cell.c);
        return v !== null && v !== '';
      });
      if (hasValues &&
          !window.confirm('销售价列已有数据，重新计算将覆盖这些数据。确定吗？')) {
        return;
      }
    }
    let next = sheet;
    if (salesCol === null) {
      const res = appendColumn(next, headerRow, label);
      next = res.sheet;
      salesCol = res.col;
    } else {
      next = setCellValue(next, headerRow, salesCol, { v: label, m: label });
    }
    for (let r = 0; r < (next.row || 0); r++) {
      if (r === headerRow) continue;
      const price = computeSalesPrice({
        cost: cellValue(next, r, p.costCol),
        taxInclusive: p.taxInclusive,
        taxRatePct: p.taxRatePct,
        markupPct: p.markupPct,
        freightPerUnit: p.freight,
        fxRate: hasFx ? fx : null,
      });
      next = setCellValue(next, r, salesCol,
        price === null ? null : { v: price, m: price.toFixed(2) });
    }
    docRef.current.pricing = { ...p, salesCol };
    setPricingState(docRef.current.pricing);
    commitSheets([next, ...liveRef.current.slice(1)]);
  }

  /* ---------- 最终报价列 / 对客导出（包 7） ---------- */

  /** 当前询价单文档 + 它的最终价现算（税步/加价口径见 quoteExport.js） */
  function finalPriceContext() {
    flushDocRef();
    const inq = activeInquiryEntry();
    const quotes = inq ? quotesForInquiry(docsRef.current, inq.docId) : [];
    if (!inq) return { inq: null, quotes, finalPrices: new Map() };
    const finalPrices = computeFinalPrices({
      inquiry: inq, rowChoices: rowChoicesRef.current, quotes,
    });
    return { inq, quotes, finalPrices };
  }

  /** 一个定厂行的最终价解说（来源感知的统一实现在 quoteExport.js） */
  function breakdownFor(lineId, choice, quotes, inq) {
    return finalBreakdownFor(lineId, choice, { inquiry: inq, quotes });
  }

  /** 生成最终报价列：把每个已定厂行的最终销售价写进询价单专属列 */
  function handleGenerateFinalQuote() {
    const sheet = liveRef.current && liveRef.current[0];
    if (!sheet) return;
    const { inq, finalPrices } = finalPriceContext();
    if (!inq) return;
    if (finalPrices.size === 0) {
      window.alert('还没有定厂的行——先到「比价定厂」里选好每行用哪家工厂，再来生成最终报价');
      return;
    }
    const headerRow = headerRowOf(inq);
    const existingCol = finalQuoteColOf(sheet, headerRow);
    if (existingCol !== null) {
      const hasValues = (sheet.celldata || []).some((cell) => {
        if (cell.c !== existingCol || cell.r === headerRow) return false;
        const v = cellValue(sheet, cell.r, cell.c);
        return v !== null && v !== '';
      });
      if (hasValues &&
          !window.confirm('最终报价列已有数据，重新生成将按最新定厂结果覆盖这些数据。确定吗？')) {
        return;
      }
    }
    const res = applyFinalQuoteColumn(sheet, headerRow, finalPrices, inq.ledger);
    commitSheets([res.sheet, ...liveRef.current.slice(1)]);
  }

  /* ---------- 转订单（包 8） ---------- */

  /**
   * 转订单面板的行：所有已定厂的行（比价行 + 定厂快照 + 最终价现算）。
   * convertedTo 来自订单现算（convertedLineIds），不另存"已转"标记——
   * 订单删了/改了，这里的状态自动跟着对（派生，不存陈旧状态）。
   */
  function buildConvertRows() {
    const { inq, quotes, finalPrices } = finalPriceContext();
    if (!inq) return [];
    const model = buildModel();
    const converted = convertedLineIds(ordersRef.current, inq.docId);
    const out = [];
    for (const r of model.rows) {
      const choice = rowChoicesRef.current[r.lineId];
      if (!choice) continue; // 没定厂的行不进面板
      const fp = finalPrices.has(r.lineId) ? finalPrices.get(r.lineId) : null;
      const convertedTo = converted.get(r.lineId) || null;
      out.push({
        lineId: r.lineId,
        oe: r.oe,
        product: r.product,
        values: r.values || {},
        choice,
        finalPrice: fp,
        breakdown: breakdownFor(r.lineId, choice, quotes, inq),
        convertedTo,
        convertible: !convertedTo && fp !== null && fp !== undefined,
      });
    }
    return out;
  }

  /** 最终报价条下的算式清单：每个已定厂行一行（与转订单面板同一份） */
  function buildFinalBreakdowns() {
    const { inq, quotes, finalPrices } = finalPriceContext();
    if (!inq) return [];
    const model = buildModel();
    const out = [];
    for (const r of model.rows) {
      const choice = rowChoicesRef.current[r.lineId];
      if (!choice) continue;
      const text = breakdownFor(r.lineId, choice, quotes, inq);
      if (text) {
        out.push({
          lineId: r.lineId, oe: r.oe || '', text,
          final: finalPrices.has(r.lineId) ? finalPrices.get(r.lineId) : null,
        });
      }
    }
    return out;
  }

  /**
   * 生成订单：行数据在生成那一刻快照进订单，之后改表不影响已下单。
   * 返回新单号（包 14）：面板据此出成功提示，用户点「查看这张订单」
   * 才跳订单页（jumpToOrder），不再生成完立刻把人甩走。
   */
  function handleCreateOrder(picked) {
    if (!picked || picked.length === 0) return null;
    flushDocRef();
    const inq = activeInquiryEntry();
    if (!inq) return null;
    orderSeqRef.current += 1;
    const orderNo = formatOrderNo(new Date(), orderSeqRef.current);
    const order = {
      orderNo,
      createdAt: new Date().toISOString(),
      customerName: inq.customerName || '',
      inquiryDocId: inq.docId,
      note: '',
      lines: picked.map(({ row, qty }) => ({
        lineId: row.lineId,
        oe: row.oe || '',
        name: row.product || '',
        factory: row.choice.factory,
        qty,
        costRaw: row.choice.rawPrice,
        costTaxInclusive: !!row.choice.taxInclusive,
        costTaxRatePct: row.choice.taxRatePct ?? '',
        finalPrice: row.finalPrice,
        shippedQty: 0,
      })),
      receipts: [],
      factoryPays: [],
      shipments: [],
    };
    setOrders([...ordersRef.current, order]);
    setSelectedOrderNo(orderNo);
    doSave(); // 生成订单是明确动作，立即落盘
    // 飞书播报（Webhook 已配置才生效）：新订单的要点一次说完
    {
      const receivable = picked.reduce((s, p) =>
        s + Math.round((p.row.finalPrice || 0) * p.qty * 100) / 100, 0);
      const factorySet = [...new Set(picked.map((p) => p.row.choice.factory))];
      feishuAnnounce('🧾 新订单 ' + orderNo + '：客户「' + (inq.customerName || '未填') +
        '」成交 ' + order.lines.length + ' 行 · 共 ' +
        order.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0) +
        ' 件 · 应收 ' + receivable.toFixed(2) + ' 元 · 供货工厂：' +
        (factorySet.join('、') || '未记'));
    }
    return orderNo;
  }

  /** 导出面板要的数据：行（带最终价）+ 列（原列/工作列/最终报价）与默认勾选 */
  function buildExportModel() {
    const { inq, finalPrices } = finalPriceContext();
    if (!inq || !inq.sheet) return null;
    const sheet = inq.sheet;
    const hr = headerRowOf(inq);
    const display = pickDisplayColumns(sheet, hr);
    const asText = (v) => (v === null || v === undefined ? '' : String(v));
    const rows = inquiryDataRows(inq)
      .filter((x) => x.lineId)
      .map((x) => ({
        lineId: x.lineId,
        row: x.row,
        seq: asText(cellValue(sheet, x.row, display.seqCol)),
        oe: asText(cellValue(sheet, x.row, display.oeCol)),
        product: asText(cellValue(sheet, x.row, display.productCol)),
        finalPrice: finalPrices.has(x.lineId) ? finalPrices.get(x.lineId) : null,
      }));
    const workCols = new Set(((inq.ledger && inq.ledger.workColumns) || []).map((w) => w.col));
    const finCol = finalQuoteColOf(sheet, hr);
    const cols = columnHeaders(sheet)
      .filter((h) => h.col !== finCol)
      .map((h) => ({
        key: 'c' + h.col,
        col: h.col,
        label: h.label,
        isWork: workCols.has(h.col),
        isSales: (inq.pricing && inq.pricing.salesCol === h.col) ||
          h.text === '销售价' || h.text === '销售价（外币）',
        final: false,
      }));
    cols.push({ key: 'final', label: FINAL_QUOTE_HEADER, final: true, isWork: false, isSales: false });
    // 记住上次的列勾选（效率项）：每张询价单的列结构基本不变，上次导
    // 出勾了哪些列，这次默认还是哪些，省得每次重勾；存档里记的是 key
    // 清单，与当前列对不上的（列已增删）自动忽略，全对不上才回默认。
    const savedKeys = Array.isArray(inq.exportColKeys) ? inq.exportColKeys : null;
    const validSaved = savedKeys
      ? savedKeys.filter((k) => cols.some((c) => c.key === k))
      : [];
    return {
      rows,
      cols,
      defaultRowIds: rows
        .filter((r) => r.finalPrice !== null && r.finalPrice !== undefined)
        .map((r) => r.lineId),
      defaultColKeys: validSaved.length ? validSaved : cols
        .filter((c) => c.final || (!c.isWork && !c.isSales))
        .map((c) => c.key),
    };
  }

  /** 按面板的选择生成对客导出字节并下载/分享（两种版式都不碰报价单数据） */
  /** 导出勾选校验（直接下载与生成可编辑副本共用） */
  function validateExportSelection(selection) {
    if (!selection || selection.lineIds.size === 0) {
      window.alert('还没有勾选任何一行——请在导出面板里勾选要导出的行（点「全选」可以一次全选好），再点下载');
      return false;
    }
    if (!selection.colKeys || selection.colKeys.size === 0) {
      window.alert('还没有勾选任何一列——请在导出面板里至少勾选一列（比如「最终报价」），再点下载');
      return false;
    }
    return true;
  }

  /** 这次勾的列记到这张询价单上，下次进导出模块就是现成的默认勾选 */
  function rememberExportCols(inq, selection) {
    const entry = docsRef.current.find((d) => d.docId === inq.docId);
    if (entry) {
      entry.exportColKeys = [...selection.colKeys];
      doSave();
    }
  }

  /**
   * 按勾选生成对客文件的字节（带图版=原件回写真删；普通版=现生成）。
   * 直接下载与「生成可编辑对客报价单」共用同一条产线，保证副本里的
   * 内容与直接导出的文件一字不差。无原件又要带图版时返回 null。
   */
  async function buildCustomerExportBytes(kind, selection, opts) {
    const { inq, finalPrices } = finalPriceContext();
    if (!inq) return null;
    const sheetName = (inq.source && inq.source.sheetName) || inq.sheet.name;
    // 文件名带客户与日期（效率项）：下载夹里一眼认出是哪家的哪天的报价，
    // 不再是一堆同名的「报价单-客户版.xlsx」互相覆盖
    const cleanName = (x) => String(x || '').replace(/[\\/:*?"<>|]/g, '').trim();
    const now = new Date();
    const ymd = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    const baseName = '报价-' + (cleanName(inq.customerName) || '客户') + '-' + ymd;
    let bytes = null;
    let fileName = '';
    if (kind === 'plain') {
      const sheet = buildPlainExportSheet({
        inquiry: inq,
        selectedLineIds: selection.lineIds,
        selectedColKeys: selection.colKeys,
        finalPrices,
      });
      bytes = buildMinimalXlsx(sheetName, sheet, await resolveExportImageBytes(sheet));
      fileName = baseName + '-普通版.xlsx';
    } else {
      let origBytes = null;
      if (inq.sourceFileId) {
        try {
          const rec = await getFile(inq.sourceFileId);
          if (rec && rec.bytes) origBytes = rec.bytes;
        } catch (e) { /* 取不到原件就不生成带图版 */ }
      }
      if (!origBytes) {
        if (!(opts && opts.noAlert)) {
          window.alert('带图版需要客户原件——这份询价单没有存下原件（可能不是导入原表来的），请改用普通版');
        }
        return null;
      }
      const sheet = buildPicturedExportSheet({
        selectedColKeys: selection.colKeys,
        inquiry: inq,
        selectedLineIds: selection.lineIds,
        finalPrices,
      });
      bytes = buildQuoteXlsx({
        originalBytes: origBytes, sheetName, sheet,
        imageBytes: await resolveExportImageBytes(sheet),
      });
      fileName = baseName + '-带图版.xlsx';
    }
    return { bytes, fileName, inq };
  }

  async function handleExport(kind, mode, selection) {
    const { inq } = finalPriceContext();
    if (!inq) return;
    if (!validateExportSelection(selection)) return;
    rememberExportCols(inq, selection);
    const made = await buildCustomerExportBytes(kind, selection);
    if (!made) return;
    const { bytes, fileName } = made;
    window.__lastExport = {
      kind, fileName, size: bytes.length, at: new Date().toISOString(),
    };
    if (mode === 'share') {
      try {
        await navigator.share({
          files: [new File([bytes], fileName, { type: XLSX_MIME })],
        });
      } catch (e) { /* 取消分享是正常操作，静默 */ }
      return;
    }
    await downloadViaFeishuOrBlob(bytes, fileName);
  }

  /**
   * 生成可编辑的对客报价单（用户 2026-10-15 反馈）：报价发客户之前要
   * 调格式、挪价格列的位置，在询价单上直接改既不方便、又会动到原始
   * 询价单。所以导出先落成一份【独立副本单据】：内容与直接导出的文件
   * 一字不差（同一条产线），但它是一张能进编辑器随便改的表——挪列、
   * 改字号、删行都不碰原询价单；改完在副本页点下载即可。
   */
  async function handleCreateEditableQuote(selection) {
    const { inq } = finalPriceContext();
    if (!inq) return;
    if (!validateExportSelection(selection)) return;
    const existing = docsRef.current.find(
      (d) => d.kind === 'custquote' && d.inquiryId === inq.docId);
    if (existing &&
        !window.confirm('这张询价单已经有一份最终报价单了，重新生成会覆盖你在里面改过的格式与内容。确定重新生成吗？')) {
      return;
    }
    rememberExportCols(inq, selection);
    let made = await buildCustomerExportBytes('pictured', selection, { noAlert: true });
    if (!made) made = await buildCustomerExportBytes('plain', selection);
    if (!made) return;
    const fileName = made.fileName.replace(/\.xlsx$/, '') + '-最终报价单.xlsx';
    const wb = readWorkbook(made.bytes);
    const parsedList = wb.sheets.map((sh, i) => parseSheet(wb, i));
    const stored = await persistImportAssets(fileName, made.bytes, parsedList);
    imageStoreRef.current = stored.stored;
    const idx = pickDefaultSheet(parsedList);
    const parsed = parsedList[idx];
    const fortune = sheetToFortune(parsed, idx);
    const doc = {
      docId: existing ? existing.docId : 'doc-cust-' + Date.now().toString(36),
      kind: 'custquote',
      factoryName: null,
      inquiryId: inq.docId,
      sheet: fortune,
      ledger: createLedger({
        fileName, sheetName: parsed.name, sheetIndex: idx, rowCount: parsed.rowCount,
      }),
      pricing: { ...DEFAULT_PRICING },
      source: { fileName, sheetName: parsed.name, sheetIndex: idx },
      sourceFileId: stored.stored ? stored.originalFileId : null,
      importInfo: '最终报价单（由导出勾选生成，可任意编辑，不影响原询价单）',
      headerRow: detectHeaderRow(fortune),
      priceMark: null,
      factoryExtras: [],
    };
    docsRef.current = existing
      ? docsRef.current.map((d) => (d.docId === doc.docId ? doc : d))
      : [...docsRef.current, doc];
    syncDocList();
    doSave();
    goView('sheet');
    switchDoc(doc.docId);
  }

  /**
   * 页签行一键生成最终报价单：用默认勾选（有最终价的行 + 默认列），
   * 省去先进导出模块的步骤；要挑行挑列再去「对客导出」里生成。
   */
  function handleCreateFinalQuoteDefault() {
    const model = buildExportModel();
    if (!model || !model.defaultRowIds.length) {
      window.alert('还没有带最终价的行——先比价定厂、点「生成最终报价列」，再来生成最终报价单。');
      return;
    }
    handleCreateEditableQuote({
      lineIds: new Set(model.defaultRowIds),
      colKeys: new Set(model.defaultColKeys),
    });
  }

/** 删除最终报价单（原询价单不受任何影响） */
  function handleDeleteCustQuote() {
    const doc = docsRef.current.find((d) => d.docId === activeDocIdRef.current);
    if (!doc || doc.kind !== 'custquote') return;
    if (!window.confirm('删除这份最终报价单？原询价单和报价数据都不受影响，之后可以随时重新生成。')) return;
    docsRef.current = docsRef.current.filter((d) => d.docId !== doc.docId);
    syncDocList();
    if (doc.inquiryId) switchDoc(doc.inquiryId);
    doSave();
  }

  /** 飞书 UI 环境下、云端在线时用临时直链替代 blob 下载（其余走普通下载） */
  async function downloadViaFeishuOrBlob(bytes, fileName, mime) {
    const type = mime || XLSX_MIME;
    if (IS_FEISHU_UA && isServerAvailable()) {
      try { await openTempDownload(bytes, fileName, type); return; } catch (e) { /* 掉回普通下载 */ }
    }
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function handleClear() {
    if (!window.confirm('确定要清空已保存的工作、回到示例数据吗？')) return;
    // BUG L1：先掐掉挂起的保存定时器——不清的话，点"清空"前 900ms 内的
    // 编辑会被这个 timer 在清空之后重新写回，"清空"变成"恢复"。
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    clearSaved();
    try { await clearFiles(); } catch (e) { /* 仓库清不掉也不挡重开 */ }
    location.reload();
  }

  /* ---------- 询价单管理（包 11）：删除历史询价单 ---------- */

  /**
   * 删除当前询价单（连同它名下的报价单）：已转出订单的询价单是
   * 订单的来源凭证，永远删不掉（registry 的硬规则，先拦再问）。
   * 删完切到剩下的一张询价单；一张不剩时回到示例单占位。
   */
  function handleDeleteInquiry() {
    flushDocRef();
    const inq = activeInquiryEntry();
    if (!inq) return;
    const block = inquiryDeleteBlock(ordersRef.current, inq.docId);
    if (block) { window.alert(block); return; }
    const qs = quotesForInquiry(docsRef.current, inq.docId);
    if (!window.confirm(
      '确定删除这张询价单吗？' +
      (qs.length ? '它名下的 ' + qs.length + ' 张报价单会一起删掉。' : '') +
      '删了不能恢复。')) return;
    docsRef.current = docsRef.current.filter(
      (d) => d.docId !== inq.docId && d.inquiryId !== inq.docId);
    if (importSessionRef.current && importSessionRef.current.docId === inq.docId) {
      importSessionRef.current = null;
      setParsedList(null);
    }
    let next = docsRef.current.find((d) => d.kind === 'inquiry');
    if (!next) {
      next = sampleDoc();
      docsRef.current = [next];
    }
    syncDocList();
    activeDocIdRef.current = null; // 强制 switchDoc 走完整切换（当前文档已被删）
    switchDoc(next.docId);
    doSave();
  }

  /* ---------- 客户/工厂管理（包 11） ---------- */

  /** 管理动作的统一入参：先把当前文档写回事实源再取全量 */
  function mgmtState() {
    return currentStateForReports();
  }

  /** 在注册表里登记一个客户（已存在则不重复）；返回是否新登记 */
  function registerCustomer(name) {
    const n = (name || '').trim();
    if (!n) return false;
    if (customersRef.current.some((c) => c.name === n)) return false;
    setCustomers([...customersRef.current, { name: n, contact: '', note: '' }]);
    return true;
  }

  /** 询价单客户名「新建客户」提交：登记进注册表 + 设为本单客户 */
  function commitNewCustomer() {
    const n = custNewName.trim();
    if (!n) { setCustNewMode(false); return; }
    registerCustomer(n);
    setCustomerName(n);
    setCustNewMode(false);
    setCustNewName('');
    scheduleSave();
  }

  function handleAddCustomer(name) {
    const n = (name || '').trim();
    if (!n) { window.alert('客户名不能为空'); return; }
    if (customersRef.current.some((c) => c.name === n)) {
      window.alert('已经有叫「' + n + '」的客户了，不用重复新增');
      setSelectedCustomer(n);
      return;
    }
    setCustomers([...customersRef.current, { name: n, contact: '', note: '' }]);
    setSelectedCustomer(n);
    scheduleSave();
  }

  function handleUpdateCustomerInfo(name, patch) {
    setCustomers(customersRef.current.map(
      (c) => (c.name === name ? { ...c, ...patch } : c)));
    scheduleSave();
  }

  /** 工厂联系人/备注（包 13）：写进 factoryInfo，随存档持久化 */
  function handleUpdateFactoryInfo(name, patch) {
    setFactoryInfo({
      ...factoryInfoRef.current,
      [name]: {
        contact: '', note: '',
        ...(factoryInfoRef.current[name] || {}), ...patch,
      },
    });
    scheduleSave();
  }

  function handleRenameCustomer(oldName, newName) {
    const res = renameCustomer(mgmtState(), oldName, newName);
    if (!res) {
      window.alert('改不了：新名字「' + (newName || '').trim() +
        '」已经被别的客户用了（或者和现在的名字一样）。换一个名字再试。');
      return;
    }
    docsRef.current = res.docs;
    setOrders(res.orders);
    setCustomers(res.customers);
    // 当前询价单正是这个客户的：客户名镜像与 docRef 一起对齐，
    // 免得下一次写回又把旧名盖回去
    const inqNow = activeInquiryEntry();
    if (inqNow && inqNow.customerName === (newName || '').trim()) {
      if (docRef.current.docId === inqNow.docId) {
        docRef.current.customerName = inqNow.customerName;
      }
      setCustomerNameState(inqNow.customerName);
    }
    setSelectedCustomer((newName || '').trim());
    syncDocList();
    doSave();
    window.alert('已改名：这位客户的询价单和订单上的客户名都一起更新了');
  }

  function handleDeleteCustomer(name) {
    const block = customerDeleteBlock(mgmtState(), name);
    if (block) { window.alert(block); return; }
    if (!window.confirm('确定删除客户「' + name + '」吗？它名下没有询价单和订单，删掉只影响客户名单本身。')) return;
    setCustomers(customersRef.current.filter((c) => c.name !== name));
    setSelectedCustomer(null);
    scheduleSave();
  }

  function handleAddMgmtFactory(name) {
    const n = (name || '').trim();
    if (!n) { window.alert('工厂名不能为空'); return; }
    if (factoriesRef.current.includes(n)) {
      window.alert('已经有叫「' + n + '」的工厂了，不用重复新增');
      setSelectedMgmtFactory(n);
      return;
    }
    setFactories([...factoriesRef.current, n]);
    setSelectedMgmtFactory(n);
    scheduleSave();
  }

  function handleRenameFactory(oldName, newName) {
    const res = renameFactory(mgmtState(), oldName, newName);
    if (!res) {
      window.alert('改不了：新名字「' + (newName || '').trim() +
        '」已经被别的工厂用了（或者和现在的名字一样）。换一个名字再试。');
      return;
    }
    docsRef.current = res.docs;
    setOrders(res.orders);
    setFactories(res.factories);
    // 包 13：备注条目跟着工厂名搬家，不然改完名备注就丢了
    setFactoryInfo(syncFactoryInfoOnRename(factoryInfoRef.current, oldName, (newName || '').trim()));
    if (selectedFactory === oldName) setSelectedFactory((newName || '').trim());
    setSelectedMgmtFactory((newName || '').trim());
    // 定厂镜像跟随当前询价单的新快照（rowChoices 里的工厂名换了）
    const inqNow = activeInquiryEntry();
    if (inqNow) {
      const rc = inqNow.rowChoices || {};
      rowChoicesRef.current = rc;
      setRowChoicesState(rc);
    }
    syncDocList();
    doSave();
    window.alert('已改名：这家工厂的报价单、定厂记录和订单上的工厂名都一起更新了');
  }

  function handleDeleteFactory(name) {
    const block = factoryDeleteBlock(mgmtState(), name);
    if (block) { window.alert(block); return; }
    if (!window.confirm('确定删除工厂「' + name + '」吗？它名下没有报价单和订单引用，删掉只影响工厂名单本身。')) return;
    setFactories(factoriesRef.current.filter((f) => f !== name));
    // 包 13：备注条目一起删掉，别留在存档里串给将来同名的新厂
    setFactoryInfo(syncFactoryInfoOnDelete(factoryInfoRef.current, name));
    if (selectedFactory === name) setSelectedFactory('');
    setSelectedMgmtFactory(null);
    scheduleSave();
  }

  /* ---------- 跨模块跳转（管理页/订单 → 单据或订单） ---------- */

  function jumpToDoc(docId) {
    goView('sheet');
    switchDoc(docId);
  }
  function jumpToOrder(orderNo) {
    setSelectedOrderNo(orderNo);
    goView('orders');
  }

  /* ---------- 模块导航（包 10/11）：左侧栏模块，任一时刻只开一个 ---------- */
  const view = showOrders ? 'orders'
    : showCustomers ? 'customers'
    : showFactories ? 'factories'
    : showOverview ? 'overview'
    : showAi ? 'ai'
    : showCompare ? 'compare'
    : showConvert ? 'convert'
    : showExportPage ? 'export'
    : showData ? 'data'
    : showCheck ? 'check'
    : 'sheet';
  function goView(v) {
    // 离开表格前先把画面上的删图/移图对齐回规范（flushDocRef 里也会
    // 做，但切视图后表格卸载、画面就读不到了，必须趁还在时对齐）
    if (v !== 'sheet') {
      syncImagesFromDom();
      // BUG B2：防抖保存没到点的编辑，在切去"数据备份/自检"前必须立即
      // 落盘——collectBackupBytes 读的是 localStorage，只对齐图片不落
      // 存档，90 秒防抖窗口内改的字就去不进备份包
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      doSave();
    }
    setShowCompare(v === 'compare');
    setShowOrders(v === 'orders');
    setShowCustomers(v === 'customers');
    setShowFactories(v === 'factories');
    setShowOverview(v === 'overview');
    setShowAi(v === 'ai');
    setShowData(v === 'data');
    setShowCheck(v === 'check');
    // 转订单是独立模块（2026-10-15 拍板）：不再是询价单表格上方的面板
    setShowConvert(v === 'convert');
    // 对客导出同样是独立模块（2026-10-15 用户反馈：在询价单里以浮层
    // 出现不合理）——进模块时 bump tick，让导出面板按当前事实重挂
    setShowExportPage(v === 'export');
    if (v === 'export') setExportTick((t) => t + 1);
  }

  /**
   * 表格区浮层互斥开关：name 为 'pricing' | 'fq' | 'convert' | 'export' | null。
   * 同一时间只开一个，全部以浮层形式盖在表格上方，表格本身永远占满剩余高度。
   */
  function openOverlay(name) {
    setPricingOpen(name === 'pricing');
    setFqOpen(name === 'fq');
    // 转订单、对客导出都不是浮层：它们是独立模块（见 goView）
    if (name === 'convert') { goView('convert'); return; }
    if (name === 'export') { goView('export'); return; }
  }

  // 切换单据时只收挂在表格上的「最终报价详情」浮层；「定价设置」跨
  // 单据保留（两种单据都用得到）。转订单 / 对客导出【不】在这里收：
  // 它们是独立模块（goView 管辖），从比价页跳过去时要先 switchDoc
  // 到询价单再 goView，若这里按 activeDocId 变化把模块关掉，导航刚
  // 点完就被 effect 打回表格工作区——用户实测的"点转订单还在询价单
  // 表格里"正是这条竞态（2026-10-15 修）。
  useEffect(() => {
    setFqOpen(false);
  }, [activeDocId]);

  /* ---------- 包 13 引导动作：从说明块一键直达缺的那一步 ---------- */

  /** 比价页「发给工厂」：回工作区并让当前询价单成为活动文档 */
  function goCompareSendFactory() {
    goView('sheet');
    if (activeInquiryId && activeInquiryId !== activeDocIdRef.current) {
      switchDoc(activeInquiryId);
    }
  }

  /** 比价页「上传工厂回表」：回工作区 + 唤起回表文件选择 */
  function goCompareUploadReturn() {
    goCompareSendFactory();
    setTimeout(() => {
      const el = document.querySelector('.upload-return-input');
      if (el) el.click();
    }, 400);
  }

  /** 比价/订单页「去给『X』标价」：跳到那张报价单（标价条就在表上方） */
  function goCompareMarkQuote(docId) {
    goView('sheet');
    switchDoc(docId);
  }

  /** 订单页引导按钮：按缺的那一步直达 */
  function goOrdersGuidance(stage) {
    if (stage === 'unmarked' || stage === 'no-choices') { goView('compare'); return; }
    goView('sheet');
    if (activeInquiryId && activeInquiryId !== activeDocIdRef.current) {
      switchDoc(activeInquiryId);
    }
    if (stage === 'no-finals') {
      // BUG B4：不再 setTimeout 拖 400ms 等视图切换——原地生成走的是
      // 包 17 的存档路径（对存档里询价单条目套 applyFinalQuoteColumn），
      // 不依赖编辑器里正装着谁，切视图与生成就没有时序竞态。
      handleGenerateFinalQuoteInPlace();
    }
    if (stage === 'ready') goView('convert');
  }

  /* ---------- 包 14 比价下一步条动作：与订单引导同一套落位 ---------- */

  /** 回工作区并让当前询价单成为活动文档（比价下一步三键共用） */
  function goCompareToInquirySheet() {
    goView('sheet');
    if (activeInquiryId && activeInquiryId !== activeDocIdRef.current) {
      switchDoc(activeInquiryId);
    }
  }

  /**
   * 包 17：比价下一步「生成最终报价」改为原地生成，不切视图。用户问
   * 「为什么生成最终报价的按钮会在询价单模块」——道理讲清后（对客价
   * 写回客户的询价单、导出从询价单出），他拍板比价页点完不切页。
   * 实现不走工作台的 handleGenerateFinalQuote + commitSheets：那条路
   * 要求编辑器里装的正是询价单（flush 会把 liveRef[0] 写回 docRef 的
   * 条目），而比价页下编辑器装的可能是报价单，混用会把最终报价列写
   * 串。这里直接对存档里的询价单条目套用同一个 applyFinalQuoteColumn
   * （与工作台同一函数、同一批现算最终价，定价规则完全一致）。
   * 这一步出现的前提是最终报价列还没生成（条的状态由存档现算），
   * applyFinalQuoteColumn 追加新列，不存在覆盖已有数据的确认问题；
   * 现算不出任何最终价时和工作台一样弹提示、不写列，条不会假装成功。
   */
  function handleGenerateFinalQuoteInPlace() {
    const { inq, finalPrices } = finalPriceContext();
    if (!inq) return;
    if (finalPrices.size === 0) {
      window.alert('已定厂的行暂时算不出最终报价——定厂的工厂在这些行上还没有可用报价，补齐后再来生成');
      return;
    }
    const res = applyFinalQuoteColumn(inq.sheet, headerRowOf(inq), finalPrices, inq.ledger);
    inq.sheet = res.sheet;
    // 编辑器里正装着这张询价单时同步 live 数据：回工作区看到的就是
    // 生成后的表，下一次 flush 也不会拿旧表把新列盖回去
    if (docRef.current.docId === inq.docId && liveRef.current && liveRef.current[0]) {
      const next = [res.sheet, ...liveRef.current.slice(1)];
      liveRef.current = next;
      window.__wbData = next;
      setSheetsData(next);
      bumpWbKey();
    }
    doSave(); // 落盘；保存状态行刷新触发重渲染，比价条按新事实翻到 convert 态
  }

  /** 比价下一步「去转订单」：直接打开转订单模块（它读的是询价单存档，不依赖表格） */
  function goCompareConvert() {
    // 比价页的当前询价单就是转订单的来源：先把它设为活动文档，模块据此取数
    if (activeInquiryId && activeInquiryId !== activeDocIdRef.current) {
      switchDoc(activeInquiryId);
    }
    goView('convert');
  }

  /** 比价下一步「去对客导出」：落位后进对客导出独立模块 */
  function goCompareExport() {
    goCompareToInquirySheet();
    goView('export');
  }

  const activeDocMeta = docList.find((d) => d.docId === activeDocId);
  const activeIsQuote = !!(activeDocMeta && activeDocMeta.kind === 'quote');
  const activeIsCustQuote = !!(activeDocMeta && activeDocMeta.kind === 'custquote');
  // 当前询价单（渲染期口径，与 activeInquiryEntry 同规则，用 docList 算）
  const activeInquiryMeta = activeDocMeta
    ? (activeDocMeta.kind === 'inquiry'
      ? activeDocMeta
      : docList.find((d) => d.docId === activeDocMeta.inquiryId) || null)
    : null;
  const activeInquiryId = activeInquiryMeta ? activeInquiryMeta.docId : null;
  // 比价模型只在比价视图打开时现算（buildModel 会先把当前文档写回）
  const compareModel = showCompare ? buildModel() : null;
  const compareMarks = {};
  if (showCompare) {
    for (const d of docsRef.current) {
      if (d.kind === 'quote' && d.inquiryId === activeInquiryId) {
        compareMarks[d.factoryName] = d.priceMark || null;
      }
    }
  }
  // 包 13 引导状态：比价页按当前询价单的报价单/标价列推导；
  // 订单页（还没有订单时）按"离转订单还差哪一步"推导（guidance.js）
  const compareGuidance = showCompare
    ? compareGuidanceOf(quotesForInquiry(docsRef.current, activeInquiryId))
    : null;
  let ordersGuidance = null;
  if (showOrders && orders.length === 0) {
    const gInq = activeInquiryEntry();
    const gStage = orderGuidanceOf({
      hasInquiry: !!gInq,
      quotes: gInq ? quotesForInquiry(docsRef.current, gInq.docId) : [],
      choices: gInq ? (gInq.rowChoices || {}) : {},
      finalColumnGenerated: gInq
        ? finalQuoteColOf(gInq.sheet, headerRowOf(gInq)) !== null
        : false,
    });
    const G_TEXT = {
      'no-inquiry': {
        text: '还没有订单——先导入一张客户询价单，再发给工厂询价，之后才能转订单。',
        buttonText: '去表格工作区',
      },
      'no-quotes': {
        text: '还没有订单——当前这张询价单还没发给任何工厂。先发给工厂（或上传工厂回表），标好价、定好厂、生成最终报价，就能转成订单。',
        buttonText: '去发给工厂',
      },
      'unmarked': {
        text: '还没有订单——报价单已经有了，但还没在报价单上标价列，比价定厂读不到价格，自然还转不了订单。',
        buttonText: '去比价定厂',
      },
      'no-choices': {
        text: '还没有订单——价格已经能比了，但还没定厂：先给要下单的行选好用哪家工厂。',
        buttonText: '去比价定厂',
      },
      'no-finals': {
        text: '还没有订单——厂已经定好了，还差一步：生成最终报价（对客价），生成完就能转订单。',
        buttonText: '去生成最终报价',
      },
      'ready': {
        text: '还没有订单——这张询价单已经定好厂、也有了最终报价，现在就能转成订单。',
        buttonText: '去转订单',
      },
    };
    ordersGuidance = { stage: gStage, ...(G_TEXT[gStage] || G_TEXT['no-inquiry']) };
  }
  // 包 14 比价下一步：由比价模型（有价行/无价行/定厂）+ 最终报价列
  // 是否已生成现算（guidance.js 的 compareNextStepOf）；"已生成"口径
  // 与订单引导一致（finalQuoteColOf 非空）。
  let compareNextStep = null;
  if (showCompare && compareModel && compareGuidance) {
    const cmpInq = activeInquiryEntry();
    let quotedCount = 0, chosenQuotedCount = 0, unquotedCount = 0;
    for (const r of compareModel.rows) {
      const priced = Object.values(r.cells || {}).some((c) => c && c.priced);
      if (priced) {
        quotedCount += 1;
        if (rowChoices[r.lineId]) chosenQuotedCount += 1;
      } else {
        unquotedCount += 1;
      }
    }
    compareNextStep = compareNextStepOf({
      guidanceState: compareGuidance.state,
      totalRows: compareModel.rows.length,
      chosenCount: compareModel.rows.filter((r) => rowChoices[r.lineId]).length,
      quotedCount, chosenQuotedCount, unquotedCount,
      finalColumnGenerated: cmpInq
        ? finalQuoteColOf(cmpInq.sheet, headerRowOf(cmpInq)) !== null
        : false,
    });
  }
  // 最终报价条/导出面板的数据（只在看询价单时算；与 buildModel 一样先写回再读）
  // 转订单是独立模块：它在场时也要算（它读的是当前询价单，与当前活动
  // 文档是不是报价单无关——从报价单跳进转订单不能因为 activeIsQuote 就没数据）
  const fqCtx = (showConvert || showExportPage || (!showCompare && !showOrders && !showOverview && !showAi &&
    !showCustomers && !showFactories && !activeIsQuote)) ? finalPriceContext() : null;
  // 总览/AI 的数据：打开时按当前事实源现算（与 buildModel 一样先写回再读）
  const overviewModel = showOverview ? buildOverview(currentStateForReports()) : null;
  const aiDigest = showAi ? buildAiDigest(currentStateForReports()) : '';
  // 客户/工厂管理模型：打开时现算（含各自名下的单据清单，点哪跳哪）
  const customerModel = showCustomers ? buildCustomerModel(currentStateForReports()) : null;
  const factoryModel = showFactories ? buildFactoryModel(currentStateForReports()) : null;
  const exportModel = (showExportPage && fqCtx) ? buildExportModel() : null;
  // 转订单模块的行（打开时现算：定厂/最终价/已转状态都是派生的；
  // 独立模块口径：不因当前活动文档是报价单就落空，来源恒为当前询价单）
  const convertRows = (showConvert && !showCompare && !showOrders && !showOverview && !showAi &&
    !showCustomers && !showFactories)
    ? buildConvertRows() : null;
  // 最终报价的算式清单（包 12 透明化）：有定厂行且在表格区时才算
  const fqBreakdowns = (fqCtx && fqCtx.inq && fqCtx.finalPrices.size > 0)
    ? buildFinalBreakdowns() : [];
  // 转订单数量列（2026-10-15 拍板）：由用户从询价单已有列中指定，指定后随单保存；
  // 没指定过时才按表头精确名（需求数/数量/…）自动认作默认
  const convQtyInfo = convertRows && fqCtx && fqCtx.inq
    ? qtyPrefillForInquiry(fqCtx.inq, convQtyCol) : null;
  const convQtyColOptions = convertRows && fqCtx && fqCtx.inq
    ? columnHeaders(fqCtx.inq.sheet).map((h) => ({ col: h.col, label: h.label }))
    : [];
  // 标价列下拉的选项（包 12 B3）：定价条生成的销售价列挂上后缀，
  // 让它的性质在标记之前就看得见（守卫是第二道，这里是第一道）
  const pmSheet = (liveRef.current && liveRef.current[0]) ||
    (typeof sheetsData !== 'undefined' && sheetsData ? sheetsData[0] : null);
  const pmDocForLabels = (activeIsQuote && docRef.current.docId === activeDocId && pmSheet)
    ? { sheet: pmSheet, headerRow: docRef.current.headerRow, pricing: docRef.current.pricing }
    : null;
  const pmSalesCols = pmDocForLabels ? generatedSalesCols(pmDocForLabels) : new Set();
  const pmHeaders = pmSheet
    ? columnHeaders(pmSheet).map((h) => (pmSalesCols.has(h.col)
      ? { ...h, label: h.label + '（定价条生成的销售价）' }
      : h))
    : [];
  const fqChosen = fqCtx ? fqCtx.finalPrices.size : 0;
  const fqPriced = fqCtx
    ? [...fqCtx.finalPrices.values()].filter((v) => v !== null && v !== undefined).length
    : 0;
  const fqTotal = fqCtx && fqCtx.inq ? inquiryDataRows(fqCtx.inq).length : 0;
  const showSheetChooser = !!(parsedList && parsedList.length > 1 && !activeIsQuote &&
    importSessionRef.current && importSessionRef.current.docId === activeDocId);

  const barBtn = {
    border: '1px solid #c9d2de', color: '#37404a', background: '#fff', borderRadius: 8,
    padding: '6px 13px', cursor: 'pointer', boxShadow: '0 1px 2px rgba(23,34,62,0.04)',
  };
  /** 操作条按钮：不换行、不被挤扁；开着的那个高亮 */
  const actBtn = (on) => ({
    border: '1px solid ' + (on ? '#2f6bff' : '#c9d2de'),
    background: on ? '#e8effe' : '#fff',
    color: on ? '#1f56d6' : '#37404a',
    borderRadius: 8, padding: '3px 10px', cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  });

  // 左侧模块导航按钮（包 10；包 16 改深色侧栏）：图标 + 文字，
  // 当前模块是主色填充药丸；订单数另挂小徽章（徽章前后的全角括
  // 号用 sr-only 藏起来，只为让按钮的纯文本仍是「订单（N）」，
  // 与包 11 起的验收口径保持一致）。
  const navBtn = (v, cls, label, icon, badge) => (
    <button
      key={v}
      className={'nav-item nav-' + cls + (view === v ? ' nav-active' : '')}
      onClick={() => goView(v)}
      title={navCollapsed ? label : undefined}
      style={{
        textAlign: navCollapsed ? 'center' : 'left', fontSize: 13.5, borderRadius: 9,
        padding: navCollapsed ? '8px 0' : '7px 10px',
        cursor: 'pointer', fontFamily: 'sans-serif', width: '100%',
        border: '1px solid transparent',
        background: view === v ? '#2f6bff' : 'transparent',
        color: view === v ? '#ffffff' : '#a9b7cf',
        fontWeight: view === v ? 600 : 400,
        boxShadow: view === v ? '0 4px 12px rgba(47,107,255,0.38)' : 'none',
      }}
    >
      <span className="nav-ico">{icon}</span>
      {!navCollapsed && <span>{label}</span>}
      {!navCollapsed && badge !== undefined && badge !== null && (
        <>
          <span className="sr-only">（</span>
          <span className="nav-badge">{badge}</span>
          <span className="sr-only">）</span>
        </>
      )}
    </button>
  );

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div className="sidebar" style={{
        width: navCollapsed ? 56 : 168, flexShrink: 0,
        padding: navCollapsed ? '12px 7px' : '12px 10px',
        transition: 'width 0.15s ease',
        display: 'flex', flexDirection: 'column', gap: 4,
        fontFamily: 'sans-serif', boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 8px 16px' }}>
          <div style={{
            width: 34, height: 34, borderRadius: 9, flexShrink: 0,
            background: 'linear-gradient(135deg, #2f6bff, #7a5cff)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 800, fontSize: 16,
            boxShadow: '0 4px 10px rgba(47,107,255,0.4)',
          }}>汽</div>
          {!navCollapsed && (
            <div>
              <div style={{
                fontWeight: 700, fontSize: 16, color: '#fff',
                letterSpacing: '0.02em', lineHeight: 1.25,
              }}>汽配 ERP</div>
              <div style={{ color: '#71809c', fontSize: 11.5, marginTop: 1 }}>版本 {APP_VERSION}</div>
            </div>
          )}
        </div>
        {navBtn('sheet', 'sheet', '表格工作区', NavIcon.sheet)}
        {!navCollapsed && (
          <div style={{ color: '#5f7089', fontSize: 11, padding: '0 10px 4px', marginTop: -2 }}>
            询价单 / 各厂报价单
          </div>
        )}
        {navBtn('compare', 'compare', '比价定厂', NavIcon.compare)}
        {navBtn('convert', 'convert', '转订单', NavIcon.convert)}
        {navBtn('export', 'export', '对客导出', NavIcon.export)}
        {navBtn('orders', 'orders', '订单', NavIcon.orders, orders.length)}
        {navBtn('customers', 'customers', '客户管理', NavIcon.customers)}
        {navBtn('factories', 'factories', '工厂管理', NavIcon.factories)}
        {navBtn('overview', 'overview', '总览 · 台账', NavIcon.overview)}
        {navBtn('ai', 'ai', '✦ AI 分析', NavIcon.ai)}
        <div style={{ height: 10 }} />
        {navBtn('data', 'data', '数据备份', NavIcon.data)}
        {navBtn('check', 'check', '环境自检', NavIcon.check)}
        <div style={{ marginTop: 'auto' }} />
        <button
          className="nav-collapse-toggle"
          title={navCollapsed ? '展开侧边栏' : '收起侧边栏（表格更宽）'}
          onClick={() => {
            const next = !navCollapsed;
            setNavCollapsed(next);
            try { window.localStorage.setItem('erp-nav-collapsed', next ? '1' : '0'); } catch (e) { /* 记不住也不挡使用 */ }
          }}
          style={{
            textAlign: navCollapsed ? 'center' : 'left', fontSize: 12.5, borderRadius: 9,
            padding: navCollapsed ? '8px 0' : '7px 10px', cursor: 'pointer',
            fontFamily: 'sans-serif', width: '100%',
            border: '1px solid #33415e',
            background: 'transparent', color: '#71809c',
          }}
        >{navCollapsed ? '»' : '« 收起'}</button>
      </div>
      <div className="app-main" style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
        height: '100vh', overflowY: 'auto',
      }}>
      <div className="topbar" style={{
        padding: '4px 12px', fontFamily: 'sans-serif', fontSize: 13.5,
        display: sheetFocus && view === 'sheet' ? 'none' : 'flex',
        alignItems: 'center', gap: 12, flexWrap: 'nowrap'
      }}>
        <label style={{
          border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff', borderRadius: 8,
          padding: '6px 16px', cursor: 'pointer', fontWeight: 600, flexShrink: 0,
          boxShadow: '0 1px 3px rgba(47,107,255,0.35)'
        }}>
          导入客户原表（.xlsx）
          <input type="file" accept=".xlsx" onChange={handleFile} style={{ display: 'none' }} />
        </label>
        {view === 'sheet' && showSheetChooser && (
          <select value={sheetIdx} onChange={handleSheetChoice}>
            {parsedList.map((p, i) => (
              <option key={i} value={i}>
                {p.name}（{p.rowCount} 行 · 图片 {p.images.length}）
              </option>
            ))}
          </select>
        )}
        {view === 'sheet' && (!addingCol ? (
          <button className="add-col-btn" onClick={() => setAddingCol(true)} style={barBtn}>＋加一列</button>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input
              className="add-col-input" autoFocus placeholder="新列名，如：中文名"
              value={newColName}
              onChange={(e) => setNewColName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmAddColumn();
                if (e.key === 'Escape') { setAddingCol(false); setNewColName(''); }
              }}
              style={{ padding: '3px 6px', border: '1px solid #bbb', borderRadius: 4 }}
            />
            <button className="add-col-ok" onClick={confirmAddColumn} style={{
              border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff', borderRadius: 8,
              padding: '5px 12px', cursor: 'pointer'
            }}>确定</button>
            <button onClick={() => { setAddingCol(false); setNewColName(''); }} style={barBtn}>取消</button>
          </span>
        ))}
        <span className="import-info topbar-text" title={importInfo} style={{ color: '#444' }}>{importInfo}</span>
        <span className="save-status topbar-text" title={saveStatus} style={{ color: '#1e9e57' }}>{saveStatus}</span>
        {serverSync && serverSyncText(serverSync) && (
          <span className="sync-status" style={{
            color: serverSync.status === 'conflict' || serverSync.status === 'error' || serverSync.status === 'need-auth'
              ? '#d92d20' : '#1f56d6', fontWeight: serverSync.status === 'conflict' ? 600 : 400,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            minWidth: 0, flex: '0 1 auto', flexShrink: 1,
          }}>{serverSyncText(serverSync)}</span>
        )}
        <span className="last-edit topbar-text" title={'最近一次编辑：' + lastEdit} style={{ color: '#888' }}>最近一次编辑：{lastEdit}</span>
        <button onClick={handleClear} style={{
          border: '1px solid #d92d20', color: '#d92d20', background: '#fff', borderRadius: 8,
          padding: '5px 12px', cursor: 'pointer', marginLeft: 'auto', flexShrink: 0,
          whiteSpace: 'nowrap',
        }}>清空重开</button>
      </div>
      {view === 'sheet' && (<>
      <div className="doc-bar" style={{
        margin: '6px 10px 0', padding: '4px 10px', fontFamily: 'sans-serif', fontSize: 13.5,
        display: sheetFocus ? 'none' : 'flex', alignItems: 'stretch', gap: 8, flexWrap: 'wrap',
        background: '#fff', border: '1px solid #dbe2ec', borderRadius: 12,
        boxShadow: '0 1px 3px rgba(23,34,62,0.05)',
      }}>
        <div className="ws-cluster">
        <span className="ws-cluster-label">单据</span>
        <select
          className="inquiry-select"
          value={activeInquiryId || ''}
          onChange={(e) => { if (e.target.value) switchDoc(e.target.value); }}
          style={{ padding: '4px 6px', maxWidth: 300 }}
          title="切换询价单（历史单都在这里）"
        >
          {docList.filter((d) => d.kind === 'inquiry').map((d) => (
            <option key={d.docId} value={d.docId} title={d.note || undefined}>
              {(d.customerName || '（未填客户名）') + ' · ' +
                (d.createdAt ? d.createdAt.slice(5, 10) : '历史') + ' · ' +
                (orders.some((o) => o.inquiryDocId === d.docId) ? '已转订单' : '进行中') +
                (d.note ? ' · 备注：' + (d.note.length > 12 ? d.note.slice(0, 12) + '…' : d.note) : '')}
            </option>
          ))}
        </select>
        <button
          className="inquiry-delete-btn"
          onClick={handleDeleteInquiry}
          title="删除当前这张询价单（连同它名下的报价单）；已转出订单的删不掉"
          style={{
            border: '1px solid #d92d20', color: '#d92d20', background: '#fff',
            borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
          }}
        >删除此询价单</button>
        {docList
          .filter((d) => (d.kind === 'inquiry'
            ? d.docId === activeInquiryId
            : d.inquiryId === activeInquiryId))
          .map((d) => (
          <button
            key={d.docId}
            className={'doc-tab' + (d.docId === activeDocId ? ' doc-tab-active' : '')}
            data-doc-id={d.docId}
            onClick={() => switchDoc(d.docId)}
            style={{
              border: '1px solid ' + (d.docId === activeDocId ? '#2f6bff' : '#c9d2de'),
              background: d.docId === activeDocId ? '#e8effe' : '#fff',
              color: d.docId === activeDocId ? '#1f56d6' : '#37404a',
              borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
              fontWeight: d.docId === activeDocId ? 600 : 400,
            }}
          >{d.kind === 'inquiry'
            ? '询价单' + (d.customerName ? ' · ' + d.customerName : '')
            : d.kind === 'custquote'
              ? '最终报价单'
              : '报价单 · ' + d.factoryName}</button>
        ))}
        {activeInquiryMeta && !docList.some(
          (d) => d.kind === 'custquote' && d.inquiryId === activeInquiryMeta.docId) && (
          <button
            className="final-quote-create"
            onClick={handleCreateFinalQuoteDefault}
            title="按已定价的行生成一张最终报价单到这里：在表格里调格式、挪价格列，不动原询价单。要挑行挑列，去左侧「对客导出」里生成"
            style={{
              border: '1px dashed #1e9e57', color: '#157347', background: '#f2faf5',
              borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
            }}
          >＋ 最终报价单</button>
        )}
        </div>
        <div className="ws-cluster-sep" />
        <div className="ws-cluster">
        <span className="ws-cluster-label">发给工厂 · 回表</span>
        {!addingFactory ? (
          <>
            <select
              className="factory-select"
              value={selectedFactory}
              onChange={(e) => setSelectedFactory(e.target.value)}
              style={{ padding: '4px 6px' }}
            >
              <option value="">选择工厂</option>
              {factories.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button className="factory-add-btn" onClick={() => setAddingFactory(true)} style={barBtn}>＋新工厂</button>
          </>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input
              className="factory-name-input" autoFocus placeholder="工厂名"
              value={factoryInput}
              onChange={(e) => setFactoryInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmAddFactory();
                if (e.key === 'Escape') { setAddingFactory(false); setFactoryInput(''); }
              }}
              style={{ padding: '3px 6px', border: '1px solid #bbb', borderRadius: 4 }}
            />
            <button className="factory-add-ok" onClick={confirmAddFactory} style={{
              border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff', borderRadius: 8,
              padding: '5px 12px', cursor: 'pointer'
            }}>确定</button>
            <button onClick={() => { setAddingFactory(false); setFactoryInput(''); }} style={barBtn}>取消</button>
          </span>
        )}
        <button
          className="send-to-factory"
          onClick={handleSendToFactory}
          style={{
            border: '1px solid #1e9e57', background: '#1e9e57', color: '#fff',
            borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
          }}
        >发给工厂</button>
        <button
          className="send-to-many"
          onClick={() => {
            if (!multiSendOpen && Object.keys(multiSel).length === 0) {
              const all = {};
              for (const f of factoriesRef.current) all[f] = true;
              setMultiSel(all);
            }
            setMultiSendOpen(!multiSendOpen);
          }}
          style={barBtn}
          title="一次勾多家工厂，各生成一张报价单并打包成 zip 下载"
        >发给多家…</button>
        <label className="upload-return" style={{
          border: '1px solid #6a1b9a', color: '#6a1b9a', background: '#fff',
          borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
        }}>
          上传回表（.xlsx）
          <input
            className="upload-return-input" type="file" accept=".xlsx"
            onChange={handleUploadReturn} style={{ display: 'none' }}
          />
        </label>
        </div>
        <span style={{ marginLeft: 'auto' }} />
        <div className="ws-cluster">
        <span className="ws-cluster-label">导出 · 分享</span>
        <button className="download-quote" onClick={handleDownload} style={{
          border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
          borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
        }}>{activeIsQuote ? '下载报价单' : activeIsCustQuote ? '下载最终报价单' : '下载询价单'}</button>
        {canShareFiles ? (
          <button className="share-wechat" onClick={handleShare} style={{
            border: '1px solid #07c160', background: '#07c160', color: '#fff',
            borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
          }}>发送到微信…</button>
        ) : (
          <span className="share-hint" style={{ color: '#98a2ae' }}>
            此浏览器不支持直接分享，请用下载后拖进微信
          </span>
        )}
        <button className="sheet-focus-toggle" onClick={() => toggleSheetFocus(true)}
          title="藏掉所有顶栏，只留表格：上下能多看好几行"
          style={{
            border: '1px solid #37404a', color: '#37404a', background: '#fff',
            borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
          }}>⛶ 大表格</button>
        </div>
      </div>
      {multiSendOpen && !activeIsQuote && !sheetFocus && (
        <div className="multi-send-panel" style={{
          margin: '6px 10px 0', padding: '8px 12px', fontFamily: 'sans-serif', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: '1px solid #bcd7c5', borderRadius: 9, background: '#f2faf5',
        }}>
          <b style={{ color: '#157347' }}>发给多家工厂</b>
          {factories.length === 0 ? (
            <span style={{ color: '#888' }}>还没有工厂名单——先用左边「＋新工厂」加一家。</span>
          ) : (
            <>
              {factories.map((f) => (
                <label key={f} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox" className="multi-factory-check"
                    checked={!!multiSel[f]}
                    onChange={(e) => setMultiSel({ ...multiSel, [f]: e.target.checked })}
                  />{f}
                </label>
              ))}
              <button onClick={() => {
                const all = {}; for (const f of factoriesRef.current) all[f] = true; setMultiSel(all);
              }} style={barBtn}>全选</button>
              <button className="multi-send-go" onClick={handleSendToManyFactories} style={{
                border: '1px solid #1e9e57', background: '#1e9e57', color: '#fff',
                borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
              }}>生成并打包下载（zip）</button>
              <span style={{ color: '#666' }}>每家一张报价单，放进同一个 zip；已发过的会被替换（会先问一次）</span>
            </>
          )}
          <button onClick={() => setMultiSendOpen(false)} style={barBtn}>关闭</button>
        </div>
      )}
      {/* 操作条（默认一行）：定价设置 / 最终报价详情 / 生成 / 导出 / 转订单。
          定价与详情、转订单与导出都是「浮在表格上方」的面板，打开不推挤表格。 */}
      {!sheetFocus && !showCompare && !showOrders && !showOverview && !showAi && !activeIsQuote && !activeIsCustQuote && (
        <div className="action-row" style={{
          margin: '6px 10px 0', padding: '4px 10px', fontFamily: 'sans-serif', fontSize: 13.5,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap',
          border: '1px solid #dbe2ec', borderLeft: '4px solid #1e9e57', borderRadius: 12, background: '#fff',
          boxShadow: '0 1px 3px rgba(23,34,62,0.05)', minWidth: 0,
        }}>
          <b style={{ color: '#157347', flexShrink: 0, whiteSpace: 'nowrap' }}>最终报价</b>
          <span className="fq-status" title={
            '已定厂 ' + fqChosen + ' / 共 ' + fqTotal + ' 行 · 有最终价 ' + fqPriced + ' 行' +
            (fqChosen === 0 ? '（先到「比价定厂」选好每行用哪家）' : '')
          } style={{
            color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            minWidth: 0, flex: '0 1 auto',
          }}>
            已定厂 {fqChosen}/{fqTotal} 行 · 有最终价 {fqPriced} 行
            {fqChosen === 0 ? ' · 先到比价定厂选厂' : ''}
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button className="pricing-toggle" onClick={() => openOverlay(pricingOpen ? null : 'pricing')}
            style={actBtn(pricingOpen)}>定价设置 {pricingOpen ? '▴' : '▾'}</button>
          <button className="fq-toggle" onClick={() => openOverlay(fqOpen ? null : 'fq')}
            style={actBtn(fqOpen)}>最终报价详情 {fqOpen ? '▴' : '▾'}</button>
          <button className="fq-generate" onClick={handleGenerateFinalQuote} style={{
            ...actBtn(false), border: '1px solid #1e9e57', background: '#1e9e57', color: '#fff',
          }}>生成最终报价列</button>
          <button className="export-toggle" onClick={() => goView('export')}
            style={actBtn(showExportPage)}>对客报价导出</button>
          <button className="convert-toggle" onClick={() => openOverlay(showConvert ? null : 'convert')}
            style={actBtn(showConvert)}>转订单</button>
        </div>
      )}
      {activeIsQuote && !sheetFocus && !showCompare && !showOrders && !showOverview && !showAi && (
        <PriceMarkBar
          key={'pm-' + activeDocId + '-' + markTick}
          factoryName={activeDocMeta.factoryName}
          headers={pmHeaders}
          mark={docRef.current.docId === activeDocId ? docRef.current.priceMark : null}
          defaultPeriodCol={detectPeriodColumn(
            liveRef.current[0] || sheetsData[0],
            headerRowOf({ sheet: liveRef.current[0] || sheetsData[0], headerRow: docRef.current.headerRow }))}
          onSave={handleSavePriceMark}
          onDelete={handleDeleteQuote}
          extra={(
            <button className="pricing-toggle" onClick={() => openOverlay(pricingOpen ? null : 'pricing')}
              style={{ ...actBtn(pricingOpen), padding: '4px 10px' }}>定价设置 {pricingOpen ? '▴' : '▾'}</button>
          )}
        />
      )}
      {markGuard && (
        <div className="mark-guard" style={{
          position: 'fixed', inset: 0, background: 'rgba(20,26,34,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
        }}>
          <div style={{
            background: '#fff', borderRadius: 10, padding: '18px 20px', maxWidth: 520,
            fontFamily: 'sans-serif', fontSize: 14, lineHeight: 1.7,
            boxShadow: '0 10px 34px rgba(0,0,0,0.28)',
          }}>
            <b style={{ fontSize: 15 }}>等一下，这列是卖价，不是工厂价</b>
            <div className="mark-guard-text" style={{ marginTop: 8, color: '#333' }}>
              『{markGuard.info.salesHeader}』这列是定价条算出来的卖价（已经加过税和加价）。
              把它当工厂价标记，最终报价会在它上面再加一次税和加价（等于重复加价）。
              {markGuard.info.costHeader
                ? '建议改标它旁边的成本价列『' + markGuard.info.costHeader + '』。'
                : '但系统里没记着它是从哪一列成本价算出来的，没法自动改标——请取消后手动选成本价列。'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {markGuard.info.costCol !== null && (
                <button
                  className="mark-guard-cost"
                  onClick={() => {
                    const g = markGuard;
                    setMarkGuard(null);
                    applyPriceMark({ ...g.mark, col: g.info.costCol });
                  }}
                  style={{
                    border: '1px solid #1e9e57', background: '#1e9e57', color: '#fff',
                    borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
                  }}
                >改标成本价{markGuard.info.costHeader ? '『' + markGuard.info.costHeader + '』' : ''}</button>
              )}
              <button
                className="mark-guard-anyway"
                onClick={() => {
                  const g = markGuard;
                  setMarkGuard(null);
                  applyPriceMark(g.mark);
                }}
                style={{
                  border: '1px solid #b45309', background: '#fff', color: '#b45309',
                  borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
                }}
              >仍要这样标记</button>
              <button
                className="mark-guard-cancel"
                onClick={() => setMarkGuard(null)}
                style={{
                  border: '1px solid #888', background: '#fff', color: '#444',
                  borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
                }}
              >取消</button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
      {showCheck ? (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <SelfCheck onClose={() => goView('sheet')} />
        </div>
      ) : showConvert ? (
        <ConvertView
          inquiry={fqCtx && fqCtx.inq ? fqCtx.inq : null}
          rows={convertRows || []}
          customerName={customerName}
          qtyColOptions={convQtyColOptions}
          qtyCol={convQtyCol}
          onQtyColChange={handleConvertQtyColChange}
          sheetQtys={convQtyInfo ? convQtyInfo.qtys : null}
          qtyColumnName={convQtyInfo ? convQtyInfo.header : null}
          onCreate={handleCreateOrder}
          onViewOrder={(orderNo) => jumpToOrder(orderNo)}
          onExportCustomer={goCompareExport}
          sheetCols={convertRows && fqCtx && fqCtx.inq ? columnHeaders(fqCtx.inq.sheet) : []}
          onBack={() => goView('sheet')}
        />
      ) : showExportPage ? (
        <ExportView
          inquiry={fqCtx && fqCtx.inq ? fqCtx.inq : null}
          customerName={customerName}
          pricedCount={fqPriced}
          totalCount={fqTotal}
          rows={exportModel ? exportModel.rows : []}
          cols={exportModel ? exportModel.cols : []}
          defaultRowIds={exportModel ? exportModel.defaultRowIds : []}
          defaultColKeys={exportModel ? exportModel.defaultColKeys : []}
          panelKey={'exp-' + activeDocId + '-' + exportTick}
          canShareFiles={canShareFiles}
          onExport={handleExport}
          onCreateEditable={handleCreateEditableQuote}
          hasEditableQuote={!!(fqCtx && fqCtx.inq && docsRef.current.some(
            (d) => d.kind === 'custquote' && d.inquiryId === fqCtx.inq.docId))}
          onBack={() => goView('sheet')}
        />
      ) : showData ? (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <DataPanel onClose={() => goView('sheet')} />
        </div>
      ) : showOverview ? (
        <OverviewView
          overview={overviewModel}
          onOpenCustomer={(name) => { setSelectedCustomer(name); goView('customers'); }}
          onOpenFactory={(name) => { setSelectedMgmtFactory(name); goView('factories'); }}
          onClose={() => goView('sheet')}
        />
      ) : showAi ? (
        <AiView
          digest={aiDigest}
          onClose={() => goView('sheet')}
        />
      ) : showOrders ? (
        <OrdersView
          orders={orders}
          selectedNo={selectedOrderNo}
          onSelect={setSelectedOrderNo}
          onUpdateOrder={(next) => {
            setOrders(ordersRef.current.map(
              (o) => (o.orderNo === next.orderNo ? next : o)));
            doSave(); // 记账是明确动作，立即落盘
          }}
          onJumpInquiry={(docId) => jumpToDoc(docId)}
          onClose={() => goView('sheet')}
          guidance={ordersGuidance}
          onGuidance={ordersGuidance ? () => goOrdersGuidance(ordersGuidance.stage) : undefined}
        />
      ) : showCustomers ? (
        <CustomersView
          model={customerModel}
          selectedName={selectedCustomer}
          onSelect={setSelectedCustomer}
          onAdd={handleAddCustomer}
          onRename={handleRenameCustomer}
          onUpdateInfo={handleUpdateCustomerInfo}
          onDelete={handleDeleteCustomer}
          onJumpInquiry={(docId) => jumpToDoc(docId)}
          onJumpOrder={(orderNo) => jumpToOrder(orderNo)}
          onClose={() => goView('sheet')}
        />
      ) : showFactories ? (
        <FactoriesView
          model={factoryModel}
          selectedName={selectedMgmtFactory}
          onSelect={setSelectedMgmtFactory}
          onAdd={handleAddMgmtFactory}
          onRename={handleRenameFactory}
          onUpdateInfo={handleUpdateFactoryInfo}
          onDelete={handleDeleteFactory}
          onJumpDoc={(docId) => jumpToDoc(docId)}
          onJumpOrder={(orderNo) => jumpToOrder(orderNo)}
          onClose={() => goView('sheet')}
        />
      ) : showCompare ? (
        <CompareView
          model={compareModel}
          marks={compareMarks}
          choices={rowChoices}
          onChoose={handleChooseCell}
          onBulkAll={handleBulkAll}
          onBulkLowest={handleBulkLowest}
          guidance={compareGuidance}
          onGoSendFactory={goCompareSendFactory}
          onGoUploadReturn={goCompareUploadReturn}
          onGoMarkQuote={goCompareMarkQuote}
          nextStep={compareNextStep}
          onGenerateFinals={handleGenerateFinalQuoteInPlace}
          onGoConvert={goCompareConvert}
          onGoExport={goCompareExport}
        />
      ) : (
      <div className="sheet-area" style={{
        flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column',
      }}>
        {pricingOpen && (
          <div className="overlay-panel" style={OVERLAY_STYLE}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 14px 0' }}>
              <button className="pricing-close" onClick={() => openOverlay(null)} style={barBtn}>收起定价设置 ▴</button>
            </div>
            <PricingBar
              headers={columnHeaders(liveRef.current[0] || sheetsData[0])}
              pricing={pricing}
              onPricingChange={onPricingChange}
              onCalculate={handleCalculate}
            />
          </div>
        )}
        {fqOpen && !activeIsQuote && (
          <div className="overlay-panel" style={OVERLAY_STYLE}>
            <div className="final-quote-panel" style={{
              margin: '10px 14px 0', padding: '10px 14px', fontFamily: 'sans-serif', fontSize: 14,
              border: '1px solid #dbe2ec', borderLeft: '4px solid #1e9e57', borderRadius: 12, background: '#fff',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ color: '#157347' }}>最终报价 · 详情</b>
                <span style={{ color: '#888', fontSize: 12 }} title="按定厂工厂价算，与定价条按成本价列算的「销售价」不是一列">（按定厂工厂价算，不是定价条的「销售价」）</span>
                <span style={{ color: '#555' }}>客户：</span>
                <select
                  className="inq-customer-select"
                  value={custNewMode ? '__new__' : (customerName || '')}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__new__') { setCustNewMode(true); setCustNewName(''); }
                    else { setCustNewMode(false); setCustomerName(v); }
                  }}
                  style={{ padding: '3px 4px', maxWidth: 220 }}
                  title="从客户名单里选；没有就选「＋新建客户…」当场登记"
                >
                  <option value="">（未填客户名）</option>
                  {customers.map((c) => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                  {customerName && !customers.some((c) => c.name === customerName) && (
                    <option value={customerName}>{customerName}（未登记）</option>
                  )}
                  <option value="__new__">＋新建客户…</option>
                </select>
                {custNewMode && (
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <input
                      className="inq-customer-input" autoFocus placeholder="新客户名（如 欧冠嘉）"
                      value={custNewName}
                      onChange={(e) => setCustNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitNewCustomer();
                        if (e.key === 'Escape') { setCustNewMode(false); setCustNewName(''); }
                      }}
                      style={{ padding: '3px 6px', border: '1px solid #bbb', borderRadius: 4, width: 150 }}
                    />
                    <button className="inq-customer-new-ok" onClick={commitNewCustomer} style={{
                      border: '1px solid #1e9e57', color: '#1e9e57', background: '#fff', borderRadius: 8,
                      padding: '5px 12px', cursor: 'pointer',
                    }}>确定</button>
                    <button onClick={() => { setCustNewMode(false); setCustNewName(''); }} style={barBtn}>取消</button>
                  </span>
                )}
                <span style={{ color: '#555' }}>备注：</span>
                <input
                  className="inq-note-input"
                  placeholder="这张单的备注（可空）"
                  value={inquiryNote}
                  onChange={(e) => setInquiryNote(e.target.value)}
                  style={{ padding: '3px 6px', border: '1px solid #bbb', borderRadius: 4, width: 180 }}
                  title="这张询价单的备注：随单保存，在上面的询价单选择器和客户管理里都能看到"
                />
                <span style={{ marginLeft: 'auto' }} />
                <button className="fq-close" onClick={() => openOverlay(null)} style={barBtn}>收起 ▴</button>
              </div>
              <div className="fq-status" style={{ color: '#666', marginTop: 6 }}>
                已定厂 {fqChosen} / 共 {fqTotal} 行 · 有最终价 {fqPriced} 行
                {fqChosen === 0
                  ? '——先到「比价定厂」选好每行用哪家，这里才能生成'
                  : '——按各行定厂的工厂价 + 定价条的加价/运费算出；定厂变了重新生成一次'}
              </div>
              {fqBreakdowns.length > 0 && (
                <div className="fq-breakdowns" style={{
                  marginTop: 8, paddingTop: 6, borderTop: '1px dashed #d8e6d8',
                  color: '#555', fontSize: 12.5, lineHeight: 1.6, maxHeight: 180, overflowY: 'auto',
                }}>
                  <span style={{ color: '#888' }}>最终价是这样算出来的（基数 = 每行定厂那家的报价列）：</span>
                  {fqBreakdowns.map((b) => (
                    <div key={b.lineId} className="fq-breakdown-row" data-line={b.lineId}>
                      {b.oe ? b.oe + ' · ' : ''}{b.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      {activeIsCustQuote && !sheetFocus && (
        <div className="custquote-banner" style={{
          margin: '6px 10px 0', padding: '6px 12px', fontFamily: 'sans-serif', fontSize: 13.5,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: '1px solid #bcd7c5', borderLeft: '4px solid #1e9e57', borderRadius: 9,
          background: '#f2faf5',
        }}>
          <b style={{ color: '#157347' }}>最终报价单</b>
          <span style={{ color: '#44584c' }}>
            这份随便改：挪价格列、调格式、删行都<b>不会动到原始询价单</b>。改好后点上方「下载对客报价单」发客户。
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button onClick={() => { if (activeDocMeta && activeDocMeta.inquiryId) switchDoc(activeDocMeta.inquiryId); }} style={{
            border: '1px solid #888', color: '#444', background: '#fff', borderRadius: 8,
            padding: '4px 12px', cursor: 'pointer',
          }}>回原询价单</button>
          <button className="custquote-delete" onClick={handleDeleteCustQuote} style={{
            border: '1px solid #d92d20', color: '#d92d20', background: '#fff', borderRadius: 8,
            padding: '4px 12px', cursor: 'pointer',
          }}>删除此单</button>
        </div>
      )}
      {sheetFocus && (
        <div className="sheet-focus-bar" style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px',
          fontFamily: 'sans-serif', fontSize: 12.5, color: '#5b6b82',
        }}>
          <span>{activeDocMeta && activeDocMeta.kind === 'inquiry'
            ? '询价单' + (activeDocMeta.customerName ? ' · ' + activeDocMeta.customerName : '')
            : activeIsCustQuote ? '最终报价单'
            : activeIsQuote ? '报价单 · ' + (activeDocMeta ? activeDocMeta.factoryName : '') : ''}</span>
          <span style={{ marginLeft: 'auto' }} />
          <button className="sheet-focus-exit" onClick={() => toggleSheetFocus(false)} style={{
            border: '1px solid #37404a', color: '#37404a', background: '#fff',
            borderRadius: 8, padding: '3px 12px', cursor: 'pointer',
          }}>退出大表格</button>
        </div>
      )}
      <div className="sheet-wrap" style={{
        flex: 1, minHeight: sheetFocus ? 0 : 320,
        margin: sheetFocus ? '0 4px 4px' : '8px 10px 10px', border: '1px solid #dbe2ec',
        // 自成层叠上下文：表内浮动图（商品照片）的层级被关在表格内部，
        // 不会穿到上方的浮层面板上面去
        position: 'relative', zIndex: 0,
        borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 2px 6px rgba(23,34,62,0.05), 0 10px 24px rgba(23,34,62,0.06)',
      }}>
        <Workbook
          key={wbKey}
          ref={wbRef}
          data={sheetsData}
          // 本系统每次只装一张表（选表在顶栏做），底部页签栏是多余的纯占高，关掉
          showSheetTabs={false}
          // 公式栏关掉（省一整行高度给表格）：本系统不写公式，格子内容
          // 双击单元格即可编辑，A1 地址框对日常询价编辑用不上
          showFormulaBar={false}
          // 工具栏精简（2026-10-15 用户反馈表格区太拥挤）：只留编辑报价表
          // 真用得上的——撤销/数字格式/字体字号/粗斜下划线/颜色底色/边框/
          // 合并/对齐换行/插图/查找；条件格式、数据验证、截图、拆列这类
          // 用不上的全部拿掉，工具栏一行放得下，表格多出一截高度
          toolbarItems={[
            'undo', 'redo', 'format-painter', '|',
            'currency-format', 'percentage-format', 'format', '|',
            'font', 'font-size', '|',
            'bold', 'italic', 'underline', 'strike-through', '|',
            'font-color', 'background', 'border', 'merge-cell', '|',
            'horizontal-align', 'vertical-align', 'text-wrap', '|',
            'filter', 'image', 'search',
          ]}
          onChange={(data) => {
            window.__wbData = data;
            const canon = canonicalize(data, liveRef.current);
            // 图片对齐（包 10）：回声只增不删——用户新插入的图在回声里
            // 是自然尺寸，登记时按它出现位置的格子贴进表格（fit），
            // 字节异步落文件仓库；已知图合并几何；删图是否进回声取
            // 决于焦点路径、不可靠，一律靠冻结点的画面对齐兜底
            // （flushDocRef / commitSheets）。
            let fittedNew = [];
            if (canon[0] && data && data[0]) {
              const rec = reconcileEchoImages(
                liveRef.current[0] ? liveRef.current[0].images : [],
                data[0].images, canon[0], fittedIdsRef.current);
              canon[0] = { ...canon[0], images: rec.images };
              fittedNew = rec.added;
              for (const img of fittedNew) {
                fittedIdsRef.current.add(img.id);
                persistInsertedImage(img);
              }
            }
            // 「最近一次编辑」提示：拿这轮回声与上一份现场比对，报出实际
            // 改动的格子（旧实现只认死字符串 '测试输入ABC' 的调试代码，已删）。
            reportLastEdit(liveRef.current[0], canon[0]);
            liveRef.current = canon;
            // 每次挂载后的第一下回声只是组件回放初始数据，不是用户编辑：
            // 只更新基线，不触发保存。从未存过档时，第一下回声同时立为
            // 指纹基线，保证"打开后什么都没改"永远不会生成存档。
            if (mountKeyRef.current !== wbKey) {
              mountKeyRef.current = wbKey;
              pendingRemountRef.current = false; // 重挂已落地，画面重新可信
              fittedIdsRef.current.clear(); // 贴格图已按规范几何画出，保护解除
              if (savedKeyRef.current === null) {
                savedKeyRef.current = workKeyOf({
                  factories: factoriesRef.current,
                  factoryInfo: factoryInfoRef.current,
                  customers: customersRef.current,
                  activeDocId: activeDocIdRef.current,
                  docs: docsRef.current,
                  orders: ordersRef.current,
                  orderSeq: orderSeqRef.current,
                });
              }
              return;
            }
            if (fittedNew.length > 0) {
              // 贴格只改了规范数据，画面上还是浮着的自然尺寸大图：
              // 等这轮回声落定后重挂一次，让新图按贴格几何进表格
              setTimeout(() => {
                setSheetsData(liveRef.current);
                bumpWbKey();
              }, 0);
            }
            scheduleSave();
          }}
        />
      </div>
      </div>
      )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);

