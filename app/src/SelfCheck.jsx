import React, { useEffect, useState } from 'react';
import { APP_VERSION } from './version.js';
import { DB_KEY, savedInfo } from './store.js';
import { FILE_DB_NAME, idbSelfTest, fileStats } from './filedb.js';

// 环境自检（SPEC 第四节第 13 项）：在用户自己的浏览器里现场验证——
// 版本对不对、数据存不存得住、图片仓库通不通、空间还剩多少、
// 已保存的工作在不在、浏览器肯不肯长期保留数据（无痕模式关窗即清）。
// 每项给出 ✅/❌ 与人话说明，并能一键复制成纯文本发给开发者定位。

const LS_PROBE_KEY = '__qipei_selfcheck__';

function fmtMB(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '未知';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtKB(bytes) {
  if (bytes == null) return '未知';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function fmtTime(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

async function runChecks() {
  const rows = [];
  // 1. 版本
  rows.push({ ok: true, label: '应用版本', detail: APP_VERSION });
  // 2. localStorage 读写往返（表格数据就存这里）
  try {
    localStorage.setItem(LS_PROBE_KEY, 'ok123');
    const v = localStorage.getItem(LS_PROBE_KEY);
    localStorage.removeItem(LS_PROBE_KEY);
    rows.push(v === 'ok123'
      ? { ok: true, label: '本地存储（存表格数据）', detail: '读写正常' }
      : { ok: false, label: '本地存储（存表格数据）', detail: '读回的内容对不上，数据可能存不住' });
  } catch (e) {
    rows.push({ ok: false, label: '本地存储（存表格数据）', detail: '读写失败：' + (e && e.message || e) + '（无痕或隐私设置可能禁用了存储）' });
  }
  // 3. IndexedDB 文件仓库往返（走 filedb 的真实仓库，不是另开的测试库）
  const idb = await idbSelfTest();
  rows.push({ ok: idb.ok, label: '图片仓库（IndexedDB）', detail: idb.detail });
  // 3b. 仓库里实际存着的文件（原文件 + 图片）
  try {
    const st = await fileStats();
    rows.push(st.totalCount > 0
      ? {
          ok: true, label: '文件仓库里的文件',
          detail: '原文件 ' + st.originalCount + ' 个（' + fmtKB(st.originalBytes) + '）· 图片 ' +
            st.imageCount + ' 张（' + fmtKB(st.imageBytes) + '），都在仓库 ' + FILE_DB_NAME + ' 里，关页重开也在',
        }
      : {
          ok: false, label: '文件仓库里的文件',
          detail: '暂无（导入表格后，原文件和图片会存进仓库 ' + FILE_DB_NAME + '，关页重开也在）',
        });
  } catch (e) {
    rows.push({ ok: false, label: '文件仓库里的文件', detail: '统计失败：' + (e && e.message || e) });
  }
  // 4. 存储用量/配额估算
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      rows.push({
        ok: true, label: '存储空间',
        detail: '已用约 ' + fmtMB(est.usage) + '，浏览器给本页面的上限约 ' + fmtMB(est.quota),
      });
    } catch (e) {
      rows.push({ ok: false, label: '存储空间', detail: '估算失败：' + (e && e.message || e) });
    }
  } else {
    rows.push({ ok: false, label: '存储空间', detail: '浏览器未提供用量估算' });
  }
  // 5. 已保存的工作
  const info = savedInfo();
  rows.push(info.exists
    ? {
        ok: true, label: '已保存的工作',
        detail: '有一份（' + DB_KEY + '，约 ' + fmtKB(info.bytes) + '，保存于 ' + fmtTime(info.savedAt) + '）' +
          (info.imagesPersisted === false ? '；注意：那次空间不足，图片没存进去' : ''),
      }
    : { ok: false, label: '已保存的工作', detail: '暂无保存记录（导入表格并编辑后会自动保存）' });
  // 6. 持久存储（无痕模式的关键坑）
  if (navigator.storage && navigator.storage.persisted) {
    try {
      const p = await navigator.storage.persisted();
      rows.push(p
        ? { ok: true, label: '数据长期保留', detail: '浏览器已承诺长期保留本页面数据' }
        : {
            ok: false, label: '数据长期保留',
            detail: '浏览器未承诺长期保留——如果你开的是无痕模式，关掉窗口数据就会清零，请改用普通窗口干活',
          });
    } catch (e) {
      rows.push({ ok: false, label: '数据长期保留', detail: '查询失败：' + (e && e.message || e) });
    }
  } else {
    rows.push({ ok: false, label: '数据长期保留', detail: '浏览器未提供此查询' });
  }
  return rows;
}

export default function SelfCheck({ onClose }) {
  const [rows, setRows] = useState(null);
  const [copyTip, setCopyTip] = useState('');

  useEffect(() => {
    let alive = true;
    runChecks().then((r) => { if (alive) setRows(r); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  function copyReport() {
    if (!rows) return;
    const text =
      '汽配 ERP 环境自检 · 版本 ' + APP_VERSION + ' · ' +
      new Date().toLocaleString('zh-CN', { hour12: false }) + '\n' +
      rows.map((r) => (r.ok ? '✅ ' : '❌ ') + r.label + '：' + r.detail).join('\n');
    const done = () => setCopyTip('已复制，把结果粘贴发给开发者就行');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else { fallback(); }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
      document.body.removeChild(ta);
      done();
    }
  }

  return (
    <div id="self-check-panel" style={{
      margin: '14px 16px', border: '1px solid #dbe2ec', borderRadius: 12,
      background: '#fff', padding: '16px 20px',
      boxShadow: '0 2px 6px rgba(23,34,62,0.05), 0 10px 24px rgba(23,34,62,0.06)',
      fontFamily: 'sans-serif', fontSize: 14, lineHeight: 1.9
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b className="sec-title" style={{ fontSize: 17 }}>环境自检</b>
        <span style={{ color: '#666' }}>在你这台电脑、这个浏览器里，系统能不能存住数据、存住图片</span>
        <button onClick={copyReport} style={{
          border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff',
          borderRadius: 8, padding: '4px 12px', cursor: 'pointer'
        }}>复制自检结果</button>
        {copyTip && <span style={{ color: '#1e9e57' }}>{copyTip}</span>}
        <button onClick={onClose} style={{
          border: '1px solid #c9d2de', color: '#37404a', background: '#fff',
          borderRadius: 8, padding: '4px 12px', cursor: 'pointer', marginLeft: 'auto'
        }}>关闭</button>
      </div>
      {rows === null && <div style={{ color: '#888' }}>正在检查…</div>}
      {rows !== null && rows.map((r, i) => (
        <div key={i}>{r.ok ? '✅' : '❌'} {r.label}：{r.detail}</div>
      ))}
    </div>
  );
}
