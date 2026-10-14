import React, { useRef, useState } from 'react';
import {
  collectBackupBytes, readArchiveJson, parseAndValidateBackup, applyBackup,
} from './backup.js';

// 数据备份与恢复（SPEC 第四节第 12 项）：与环境自检同层的数据区。
// 完整备份 = 一份 zip（清单 + 业务存档 + 文件仓库的全部文件，逐件
// 带大小与校验值）；恢复先全量校验、全过才动当前数据。
// 轻量选项只导业务存档 JSON（不含原文件/图片，换机器恢复不出图片）。

function downloadBytes(bytes, fileName, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtTime(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function DataPanel({ onClose }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function handleExportFull() {
    if (busy) return;
    setBusy(true);
    setStatus('正在打包（原文件和图片都打进去，可能要几秒）…');
    try {
      const res = await collectBackupBytes();
      if (!res.ok) {
        setStatus('没生成备份：' + res.error);
        return;
      }
      // 验收/调试钩子（与 __lastExport 同风格）：最近一次备份的字节留一份
      window.__lastBackup = {
        fileName: res.fileName, size: res.bytes.length,
        bytes: res.bytes, manifest: res.manifest, at: new Date().toISOString(),
      };
      downloadBytes(res.bytes, res.fileName, 'application/zip');
      setStatus('完整备份已生成：' + res.fileName + '（约 ' + fmtMB(res.bytes.length) +
        '，含 ' + res.manifest.counts.files + ' 个文件、' + res.manifest.counts.orders +
        ' 个订单）。把这个文件存好，换电脑/浏览器出问题时用它恢复。');
    } catch (e) {
      setStatus('没生成备份：打包时出错（' + (e && e.message || e) + '）');
    } finally {
      setBusy(false);
    }
  }

  function handleExportJson() {
    const raw = readArchiveJson();
    if (!raw) {
      setStatus('还没有保存过工作，现在没有可导出的数据');
      return;
    }
    downloadBytes(new TextEncoder().encode(raw), '汽配ERP数据.json', 'application/json');
    setStatus('数据 JSON 已导出（只有业务数据，不含原文件和图片字节；要完整备份请用左边那个）');
  }

  async function handleRestoreFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!file || busy) return;
    setBusy(true);
    setStatus('正在校验这份备份…（只校验，先不动你现在的数据）');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const v = await parseAndValidateBackup(bytes);
      if (!v.ok) {
        setStatus('这份备份没通过校验，已拒绝恢复，你现在的数据没有动。原因：' +
          v.errors.join('；'));
        return;
      }
      const c = v.manifest.counts || {};
      if (!window.confirm(
        '这份备份是 ' + fmtTime(v.manifest.exportedAt) + ' 导出的，里面有 ' +
        (c.orders || 0) + ' 个订单、' + (c.files || 0) + ' 个文件。\n' +
        '恢复会把当前数据全部换成备份里的内容，确定恢复吗？')) {
        setStatus('已取消恢复，当前数据没有动');
        return;
      }
      setStatus('校验通过，正在恢复…');
      const applied = await applyBackup(v);
      if (!applied.ok) {
        setStatus('恢复没完成：' + applied.error);
        return;
      }
      setStatus('恢复完成，正在重新打开…');
      location.reload();
    } catch (err) {
      setStatus('恢复没完成：' + (err && err.message || err));
    } finally {
      setBusy(false);
    }
  }

  const btn = {
    border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff',
    borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
  };
  return (
    <div id="data-panel" style={{
      margin: '14px 16px', border: '1px solid #dbe2ec', borderRadius: 12,
      background: '#fff', padding: '16px 20px',
      boxShadow: '0 2px 6px rgba(23,34,62,0.05), 0 10px 24px rgba(23,34,62,0.06)',
      fontFamily: 'sans-serif', fontSize: 14, lineHeight: 1.8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b className="sec-title" style={{ fontSize: 17 }}>数据备份与恢复</b>
        <span style={{ color: '#666' }}>完整备份含原文件和图片，恢复前逐件校验</span>
        <button onClick={onClose} style={{
          border: '1px solid #c9d2de', color: '#37404a', background: '#fff',
          borderRadius: 8, padding: '4px 12px', cursor: 'pointer', marginLeft: 'auto',
        }}>关闭</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button className="backup-export-full" onClick={handleExportFull} disabled={busy} style={{
          ...btn, background: '#2f6bff', color: '#fff',
        }}>导出完整备份（.zip）</button>
        <button className="backup-export-json" onClick={handleExportJson} disabled={busy} style={btn}>
          导出数据 JSON（轻量，不含图片）
        </button>
        <label className="backup-restore" style={{ ...btn, borderColor: '#b45309', color: '#b45309' }}>
          恢复备份（.zip）…
          <input
            ref={fileRef} className="backup-restore-input" type="file" accept=".zip"
            onChange={handleRestoreFile} style={{ display: 'none' }}
          />
        </label>
      </div>
      <div style={{ color: '#666', fontSize: 13 }}>
        注意：AI 接口钥匙不在备份里（它单独存放），恢复后需要重新填一次。
      </div>
      {status && <div className="backup-status" style={{ color: '#333' }}>{status}</div>}
    </div>
  );
}
