import React, { useRef, useState } from 'react';
import { loadAiConfig, saveAiConfig } from './aiConfig.js';

// AI 分析页（SPEC 第四节第 11 项，只读旁挂）：把全库数据摘要
// （aiDigest.js 现算）随问题发给用户自己配置的 AI 接口，回答只展示、
// 永不回写业务数据。钥匙只存 aiConfig 的独立键——不进存档、不进备份。

const SYSTEM_PROMPT =
  '你是一名汽配外贸经营分析助手。回答只能依据下面提供的数据摘要，' +
  '不许编造摘要里没有的数字、客户、工厂或订单；摘要里没有的，就直说「数据里没有」。' +
  '金额单位是元。用中文回答，先给结论，再给依据，简洁。';

const CHIPS = [
  '哪个客户欠款最多？',
  '哪家工厂应付最多？',
  '最近订单情况怎么样？',
];
const REPORT_QUESTION =
  '请根据数据摘要给我一份经营体检报告：先说整体情况（应收应付、未收未付），' +
  '再指出最该盯的三件事（欠款最久/最多的客户、应付压力、待发货），最后给一句话建议。';

function friendlyError(err) {
  if (err && err.status) {
    if (err.status === 401 || err.status === 403) {
      return '钥匙不对或没权限（' + err.status + '）——检查一下接口钥匙，或换个有权限的';
    }
    if (err.status === 404) {
      return '接口地址或模型名对不上（404）——检查一下接口地址和模型';
    }
    if (err.status === 429) {
      return '问得太频繁，被接口限流了（429）——等一会儿再问';
    }
    return '接口返回了错误（' + err.status + '）——稍后再试，或把状态码发给开发者看';
  }
  if (err && err.name === 'AbortError') {
    return '等太久没等到回复（超时）——网络可能不稳，稍后再问一次';
  }
  // fetch 本身抛错：连不上、被浏览器跨域拦下，都落在这一类
  return '连不上接口——可能是网络问题，也可能是接口不让网页直接调用（跨域被拦）。先检查网络，还不行把这条发给开发者看';
}

export default function AiView({ digest, onClose }) {
  const [cfg, setCfg] = useState(loadAiConfig);
  const [cfgTip, setCfgTip] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  function handleSaveCfg() {
    const clean = saveAiConfig(cfg);
    setCfg(clean);
    setCfgTip('已保存（只存在这台浏览器里，不进业务数据、不进备份）');
  }

  async function ask(rawQuestion) {
    const q = (rawQuestion || '').trim();
    if (!q || busyRef.current) return;
    const conf = loadAiConfig();
    const history = messages.slice(-8);
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setInput('');
    if (!conf.apiKey) {
      setMessages((m) => [...m, {
        role: 'assistant',
        text: '⚠ 这次没问成：还没填 API 钥匙——在上面填好钥匙、点「保存设置」再问。',
      }]);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const url = conf.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: conf.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + '\n\n' + digest },
        ...history.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
        { role: 'user', content: q },
      ],
      temperature: 0.3,
    };
    // 验收/调试钩子（与 __lastExport 同风格）：最近一次实际发出的请求
    window.__aiLastRequest = { url, body, at: new Date().toISOString() };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + conf.apiKey,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw { status: res.status };
      const data = await res.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      const answer = (msg && (msg.content || msg.reasoning_content) || '').trim();
      if (!answer) throw new Error('no-answer');
      setMessages((m) => [...m, { role: 'assistant', text: answer }]);
    } catch (err) {
      const reason = err && err.message === 'no-answer'
        ? '接口回了个空答案——换个问法，或者稍后再试'
        : friendlyError(err);
      setMessages((m) => [...m, { role: 'assistant', text: '⚠ 这次没问成：' + reason }]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const inputStyle = {
    padding: '5px 8px', border: '1px solid #c9d2de', borderRadius: 8, fontSize: 14,
  };
  const chipStyle = {
    border: '1px solid #2f6bff', color: '#2f6bff', background: '#fff',
    borderRadius: 999, padding: '5px 14px', cursor: 'pointer', fontSize: 13.5,
  };

  return (
    <div className="ai-view" style={{
      flex: 1, overflow: 'auto', padding: '16px 18px',
      fontFamily: 'sans-serif', fontSize: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 19 }}>✦ AI 分析</b>
        <span style={{ color: '#888' }}>AI 只看数据摘要做分析，永不改账；回答仅供参考</span>
        <button className="ai-close" onClick={onClose} style={{
          marginLeft: 'auto', border: '1px solid #c9d2de', color: '#37404a', background: '#fff',
          borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
        }}>返回表格</button>
      </div>

      <div className="ai-config" style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        margin: '12px 0', padding: '12px 14px', background: '#fff',
        border: '1px solid #dbe2ec', borderRadius: 12,
      }}>
        <label>接口地址{' '}
          <input
            className="ai-base" style={{ ...inputStyle, width: 240 }}
            value={cfg.baseUrl}
            onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
          />
        </label>
        <label>钥匙{' '}
          <input
            className="ai-key" type="password" style={{ ...inputStyle, width: 180 }}
            value={cfg.apiKey} placeholder="粘贴你的 API 钥匙"
            onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
          />
        </label>
        <label>模型{' '}
          <input
            className="ai-model" style={{ ...inputStyle, width: 150 }}
            value={cfg.model}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
          />
        </label>
        <button className="ai-save" onClick={handleSaveCfg} style={{
          border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
          borderRadius: 8, padding: '5px 16px', cursor: 'pointer',
        }}>保存设置</button>
        {cfgTip && <span className="ai-cfg-tip" style={{ color: '#1e9e57' }}>{cfgTip}</span>}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
        {CHIPS.map((c) => (
          <button key={c} className="ai-chip" data-chip={c} style={chipStyle}
            onClick={() => ask(c)} disabled={busy}>{c}</button>
        ))}
        <button className="ai-chip ai-report" data-chip="report" style={{
          ...chipStyle, borderColor: '#1e9e57', color: '#1e9e57',
        }} onClick={() => ask(REPORT_QUESTION)} disabled={busy}>一键生成经营体检报告</button>
      </div>

      <div className="ai-msgs" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ color: '#888' }}>点上面的现成问题，或者在下面直接打字问。</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={'ai-msg ai-msg-' + m.role} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '82%', whiteSpace: 'pre-wrap', lineHeight: 1.6,
            background: m.role === 'user' ? '#e8effe' : '#fff',
            border: '1px solid ' + (m.role === 'user' ? '#c9dbff' : '#dbe2ec'),
            borderRadius: 10, padding: '10px 14px',
          }}>{m.text}</div>
        ))}
        {busy && <div className="ai-busy" style={{ color: '#888' }}>正在看数据思考…</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
        <textarea
          className="ai-q" rows={2} value={input}
          placeholder="想问什么？比如：哪个客户欠款最多？（Ctrl+Enter 发送）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') ask(input);
          }}
          style={{ ...inputStyle, flex: 1, resize: 'vertical' }}
        />
        <button className="ai-ask" onClick={() => ask(input)} disabled={busy} style={{
          border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff',
          borderRadius: 8, padding: '8px 18px', cursor: 'pointer',
        }}>{busy ? '思考中…' : '提问'}</button>
      </div>

      <details className="ai-digest-preview" style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', color: '#555' }}>
          看一眼：提问时实际会发给 AI 的数据摘要（就是下面这些，不多发任何东西）
        </summary>
        <pre style={{
          whiteSpace: 'pre-wrap', background: '#f6f8fa', border: '1px solid #e1e4e8',
          borderRadius: 8, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.6,
          maxHeight: 320, overflow: 'auto',
        }}>{digest}</pre>
      </details>
    </div>
  );
}
