import React, { useRef, useState, useEffect } from 'react';
import {
  collectBackupBytes, readArchiveJson, parseAndValidateBackup, applyBackup,
} from './backup.js';
import {
  isServerAvailable, exportServerBackup, restoreServerBackup,
  fetchServerState, loginPassword, detectServer, getServerInfo,
} from './apiClient.js';
import { adoptRemoteState, onSyncChange, lastSyncInfo, hasLocalBackupStash, restoreLocalBackupStash } from './store.js';

// 数据备份与恢复（SPEC 第四节第 12 项）：与环境自检同层的数据区。
// 完整备份 = 一份 zip（清单 + 业务存档 + 文件仓库的全部文件，逐件
// 带大小与校验值）；恢复先全量校验、全过才动当前数据。
// 轻量选项只导业务存档 JSON（不含原文件/图片，换机器恢复不出图片）。
//
// 云端模式（服务器在线）：新增服务器侧备份/恢复/拉取——
// · 服务器完整备份与本地备份是同一格式，两种来源互相可恢复；
// · 保存冲突（409）后本页出现「拉取服务器数据」按钮：把浏览器本地
//   镜像换成服务器最新事实源后刷新，本窗口未推上去的本地改动仍在
//   「我的导出」路径里由用户自行决定去留（绝不静默覆盖别人）。
// · 口令登录：服务端开了 ERP_ACCESS_PASSWORD 时在此登录（aiConfig
//   式独立凭据不进业务数据；Cookie 本身由服务端 HttpOnly 下发）。

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
  const [serverOn, setServerOn] = useState(isServerAvailable());
  const [serverInfoTxt, setServerInfoTxt] = useState('');
  const [authed, setAuthed] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [conflict, setConflict] = useState(
    lastSyncInfo().status === 'conflict' ? lastSyncInfo() : null);
  const [hasStash, setHasStash] = useState(hasLocalBackupStash());
  const serverRestoreRef = useRef(null);

  useEffect(() => {
    const off = onSyncChange((s) => {
      if (s.status === 'conflict') setConflict(s);
    });
    if (isServerAvailable()) {
      const info = getServerInfo();
      if (info) {
        setServerInfoTxt('rev ' + (info.revision || 0) +
          ' · ' + fmtTime(info.savedAt) + (info.auth ? ' · 需口令' : ''));
        setAuthed(!info.auth || true); // health 无法判断登录态；尝试一次拉取再说
      }
      fetchServerState().then((d) => setAuthed(true)).catch((e) => {
        setAuthed(e && e.code === 'NEED_AUTH' ? false : true);
      });
    }
    return off;
  }, []);

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

  /** 云端导出：直接拿服务器生成的同一格式 zip */
  async function handleExportServer() {
    if (busy || !serverOn) return;
    setBusy(true);
    setStatus('正在向服务器要完整备份…');
    try {
      const res = await exportServerBackup();
      window.__lastBackup = { fileName: res.fileName, size: res.bytes.length, at: new Date().toISOString() };
      downloadBytes(res.bytes, res.fileName, 'application/zip');
      setStatus('服务器完整备份已下载：' + res.fileName + '（含服务器仓库的全部原文件与图片）。');
    } catch (e) {
      setStatus('服务器备份没拿到：' + (e && e.message || e));
    } finally {
      setBusy(false);
    }
  }

  /** 冲突修复：本地镜像换服务器事实源后刷新（本窗口未推送的改动以本地为准） */
  async function handlePullServer() {
    if (busy) return;
    setBusy(true);
    setStatus('正在拉取服务器最新数据…');
    try {
      const d = await fetchServerState();
      if (!d.ok || !d.state) {
        setStatus('服务器还没有数据（可能是新库）。刷新后再试，或先在本机导出备份。');
        return;
      }
      if (!window.confirm('拉取会把本窗口的表数据换成服务器上的最新版本（rev ' + d.revision +
        '），本窗口没推上去的改动不会丢失（已留在页面里，刷新前会提示）。服务器数据以 rev ' + d.revision + ' 为准，确定吗？')) {
        setStatus('已取消拉取，当前数据没有动');
        return;
      }
      // 简单起见直接采纳为镜像并刷新（本窗口未推送改动随刷新丢失——
      // 我们先存在 sessionStorage 一份以防万一）
      if (adoptRemoteState(d.state)) {
        location.reload();
      } else {
        setStatus('本地存储写不下服务器的数据（空间不足？），没有做任何修改');
      }
    } catch (e) {
      if (e && e.code === 'NEED_AUTH') {
        setStatus('服务器要求登录——先在下面输入访问口令登录，再拉取');
      } else {
        setStatus('拉取失败：' + (e && e.message || e));
      }
    } finally {
      setBusy(false);
    }
  }

  /** 恢复本地 zip（校验通过后落盘；与旧版一致，M5 先写后清） */
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

  /** 云端恢复：服务器事务级替换（失败回滚，本地数据不动） */
  async function handleRestoreServerFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || busy || !serverOn) return;
    setBusy(true);
    setStatus('正在把这份备份交给服务器恢复…（服务端先全量校验）');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!window.confirm('恢复会把服务器上的数据全部换成这份备份的内容（服务器当前数据在事务里保留原样直到全部成功）。确定恢复吗？')) {
        setStatus('已取消恢复');
        return;
      }
      await restoreServerBackup(bytes);
      setStatus('服务器恢复完成，正在重新打开…');
      location.reload();
    } catch (err) {
      setStatus('服务器恢复没完成：' + (err && err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    if (!passwordInput || busy) return;
    setBusy(true);
    try {
      await loginPassword(passwordInput);
      setPasswordInput('');
      setAuthed(true);
      setStatus('登录成功。回到顶部再试一次同步/拉取即可');
      const det = await detectServer();
      if (det.available) setServerOn(true);
    } catch (err) {
      setStatus('登录失败：' + (err && err.message || err));
    } finally {
      setBusy(false);
    }
  }

  /** 恢复采纳服务器前自动留底的本机数据 */
  function handleRestoreStash() {
    if (busy || !hasStash) return;
    if (!window.confirm('把本机数据恢复成「采纳服务器数据之前」自动留底的那一份？\n当前数据会被这份留底替换（当前数据自己不会另留底）。确定吗？')) return;
    if (restoreLocalBackupStash()) {
      location.reload();
    } else {
      setStatus('留底读不出来（可能是存储被清了）');
    }
  }

  const btn = {
    border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff',
    borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
  };
  const btnFill = { ...btn, background: '#2f6bff', color: '#fff' };
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

      {conflict && (
        <div className="sync-conflict" style={{
          marginTop: 10, border: '1px solid #f0b264', background: '#fdf3e0',
          borderRadius: 10, padding: '10px 14px', color: '#8a5300',
        }}>
          <b>云端已有其他窗口的更新（rev {conflict.currentRevision}）。</b>
          本窗口的保存没有推上去，也没有覆盖它们。确认本窗口的改动不再需要后，
          点下面的按钮拉取服务器数据。
        </div>
      )}

      {serverOn && (
        <div className="server-box" style={{
          marginTop: 10, border: '1px solid #b9d0ff', background: '#f3f7ff',
          borderRadius: 10, padding: '10px 14px',
        }}>
          <b style={{ color: '#1f56d6' }}>服务器在线{serverInfoTxt ? ' · ' + serverInfoTxt : ''}</b>
          {!authed && (
            <div style={{ color: '#8a5300' }}>
              这台浏览器还没有登录——下面输入访问口令登录后，云端功能才可用。
            </div>
          )}
          {!authed && (
            <form onSubmit={handleLogin} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0' }}>
              <input className="server-pass-input" type="password" placeholder="访问口令"
                value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)}
                style={{ padding: '4px 8px', border: '1px solid #c9d2de', borderRadius: 6, width: 180 }} />
              <button type="submit" className="server-login" style={btn}>登录</button>
            </form>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button className="backup-export-server" onClick={handleExportServer} disabled={busy} style={btnFill}>
              从服务器导出完整备份（.zip）
            </button>
            <label className="backup-restore-server" style={{ ...btn, borderColor: '#b45309', color: '#b45309' }}>
              用 zip 恢复服务器数据…
              <input ref={serverRestoreRef} className="backup-restore-server-input" type="file" accept=".zip"
                onChange={handleRestoreServerFile} style={{ display: 'none' }} />
            </label>
            <button className="server-pull" onClick={handlePullServer} disabled={busy} style={btn}>
              拉取服务器最新数据{conflict ? '（清掉冲突提示）' : ''}
            </button>
            {hasStash && (
              <button className="server-stash-restore" onClick={handleRestoreStash} disabled={busy}
                style={{ ...btn, borderColor: '#b45309', color: '#b45309' }}>
                恢复采纳前的本机数据
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button className="backup-export-full" onClick={handleExportFull} disabled={busy} style={btnFill}>
          导出本机完整备份（.zip）
        </button>
        <button className="backup-export-json" onClick={() => {
          const raw = readArchiveJson();
          if (!raw) { setStatus('还没有保存过工作，现在没有可导出的数据'); return; }
          downloadBytes(new TextEncoder().encode(raw), '汽配ERP数据.json', 'application/json');
          setStatus('数据 JSON 已导出（只有业务数据，不含原文件和图片字节；要完整备份请用左边那个）');
        }} disabled={busy} style={btn}>
          导出数据 JSON（轻量，不含图片）
        </button>
        <label className="backup-restore" style={{ ...btn, borderColor: '#b45309', color: '#b45309' }}>
          恢复本机备份（.zip）…
          <input
            ref={fileRef} className="backup-restore-input" type="file" accept=".zip"
            onChange={handleRestoreFile} style={{ display: 'none' }}
          />
        </label>
      </div>
      <div style={{ color: '#666', fontSize: 13 }}>
        注意：AI 接口钥匙不在备份里（它单独存放），恢复后需要重新填一次。
        {serverOn ? '服务器在线时，本机的自动保存会同步推送到服务器；本机备份与服务器备份同一格式，可互相恢复。' : '当前是单机模式（没有检测到服务器），数据只存本机浏览器。'}
      </div>
      {status && <div className="backup-status" style={{ color: '#333' }}>{status}</div>}
    </div>
  );
}
