// 飞书集成（可选能力，未配置凭证时降级为 501 + 明说缺什么）：
// · Webhook 模式：群机器人 Webhook → 文本/交互卡片推送（最轻，用户只贴 URL）
// · 自建应用模式：APP_ID + SECRET → 网页免登（Code 换用户身份）+ 发文件到会话
import { createHmac } from 'node:crypto';
import { FEISHU_WEBHOOK_URL, FEISHU_APP_ID, FEISHU_APP_SECRET } from '../config.js';
import { getDb } from '../db.js';

const webhookConfigured = () => FEISHU_WEBHOOK_URL !== '';
const appConfigured = () => FEISHU_APP_ID !== '' && FEISHU_APP_SECRET !== '';

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/* ---------- tenant_access_token（应用模式，内存缓存 2 小时减新鲜减半） ---------- */
let tenantToken = { value: null, expiresAt: 0 };

async function getTenantToken() {
  if (!appConfigured()) return null;
  if (tenantToken.value && tenantToken.value.expiresAt > Date.now()) return tenantToken.value.token;
  const r = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET,
  });
  const tok = r.data && r.data.tenant_access_token;
  const expire = r.data ? (r.data.expire || 7200) : 0;
  if (!tok) throw new Error('飞书 tenant_access_token 获取失败：' + JSON.stringify(r.data && r.data.msg || r.data));
  tenantToken = { value: { token: tok, expiresAt: Date.now() + Math.max(300, (expire - 600)) * 1000 }, expiresAt: Date.now() };
  return tok;
}

/* ---------- Webhook 签名（机器人开了"签名校验"时需要） ---------- */
function webhookSign(timestamp, secret) {
  // 飞书约定：timestamp + "\n" + secret 作为 HMAC-SHA256 的 key，空串为内容
  const hmac = createHmac('sha256', timestamp + '\n' + secret);
  return hmac.update('').digest('base64');
}

export async function sendWebhook(payload, secret = '') {
  if (!webhookConfigured()) return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };
  const body = { ...payload };
  if (secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    body.timestamp = ts;
    body.sign = webhookSign(ts, secret);
  }
  const r = await postJson(FEISHU_WEBHOOK_URL, body);
  if (r.status !== 200 || (r.data && r.data.code && r.data.code !== 0)) {
    return { ok: false, code: 'WEBHOOK_ERROR', detail: r.data };
  }
  return { ok: true, data: r.data };
}

export function registerFeishuRoutes(app) {
  app.get('/api/feishu/config', async () => ({
    ok: true,
    webhook: webhookConfigured(),
    app: appConfigured(),
  }));

  // 群机器人推送：文本或交互卡片（card 传完整卡片 JSON）
  // secret 走环境变量 FEISHU_WEBHOOK_SECRET（可选）
  app.post('/api/feishu/notify', async (req, reply) => {
    if (!webhookConfigured()) {
      reply.code(501).send({
        ok: false, code: 'WEBHOOK_NOT_CONFIGURED',
        message: '服务端没有配置 FEISHU_WEBHOOK_URL（群机器人 Webhook），无法推送',
      });
      return;
    }
    const { text, card } = req.body || {};
    let payload;
    if (card && typeof card === 'object') payload = { msg_type: 'interactive', card };
    else payload = { msg_type: 'text', content: { text: String(text || '') } };
    const secret = (process.env.FEISHU_WEBHOOK_SECRET || '').trim();
    const res = await sendWebhook(payload, secret);
    if (!res.ok) { reply.code(502).send({ ok: false, detail: res.detail || res.code }); return; }
    return { ok: true };
  });

  // 自建应用：网页免登（code → 用户信息）→ 签发登录态 Cookie
  app.post('/api/feishu/login', async (req, reply) => {
    if (!appConfigured()) {
      reply.code(501).send({
        ok: false, code: 'APP_NOT_CONFIGURED',
        message: '服务端没有配置 FEISHU_APP_ID/FEISHU_APP_SECRET，无法飞书免登',
      });
      return;
    }
    const code = String((req.body || {}).code || '');
    if (!code) { reply.code(400).send({ ok: false, message: '缺少免登 code' }); return; }
    try {
      const token = await getTenantToken();
      const ur = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_id?' +
        new URLSearchParams({ grant_type: 'authorization_code', code }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ grant_type: 'authorization_code', code }),
      });
      const ud = await ur.json().catch(() => null);
      const openId = ud && ud.data && ud.data.user_id || (ud && ud.data && ud.data.open_id);
      if (!openId) {
        reply.code(401).send({ ok: false, message: '飞书免登失败：' + JSON.stringify(ud && ud.msg || ud) });
        return;
      }
      // 用户信息（姓名/头像，允许失败——身份已够用）
      const pr = await fetch('https://open.feishu.cn/open-apis/contact/v3/users/' +
        encodeURIComponent(String(openId)) + '?' + new URLSearchParams({
          user_id_type: 'user_id',
        }), { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
      const pd = pr ? await pr.json().catch(() => null) : null;
      const userInfo = (pd && pd.data && pd.data.user && pd.data.user.name) || '飞书用户';
      // 审计：谁登录了
      getDb().prepare('INSERT INTO audit_logs (actor, action, detail, created_at) VALUES (?, ?, ?, ?)')
        .run('feishu:' + String(openId), 'feishu_login',
          JSON.stringify({ name: userInfo }), new Date().toISOString());
      return { ok: true, user: { name: userInfo, openId: String(openId) } };
    } catch (e) {
      reply.code(502).send({ ok: false, message: '飞书接口出错：' + String(e && e.message || e) });
    }
  });

  // 自建应用：把生成的报价单发到指定会话（当前用户 im 或群 chatId）
  app.post('/api/feishu/send-file', async (req, reply) => {
    if (!appConfigured()) {
      reply.code(501).send({ ok: false, code: 'APP_NOT_CONFIGURED', message: '未配置飞书应用凭证' });
      return;
    }
    const { fileBase64, name, receiveId, receiveIdType } = req.body || {};
    if (!fileBase64 || !receiveId) {
      reply.code(400).send({ ok: false, message: '需要 fileBase64 与 receiveId' });
      return;
    }
    try {
      const token = await getTenantToken();
      // 1) 上传文件（im/v1/files 是 multipart/form-data）
      const form = new FormData();
      form.append('file_type', 'xlsx');
      form.append('file_name', String(name || '报价单.xlsx'));
      form.append('file', new Blob([Buffer.from(fileBase64, 'base64')]), String(name || '报价单.xlsx'));
      const up = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form,
      });
      const upd = await up.json().catch(() => null);
      const fileId = upd && upd.data && upd.data.file_id;
      if (!fileId) { reply.code(502).send({ ok: false, message: '飞书文件上传失败：' + JSON.stringify(upd && upd.msg || upd) }); return; }
      // 2) 发送文件消息
      const idType = String(receiveIdType || 'chat_id');
      const send = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?' +
        new URLSearchParams({ receive_id_type: idType }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          receive_id: String(receiveId),
          msg_type: 'file',
          content: JSON.stringify({ file_id: fileId }),
        }),
      });
      const sd = await send.json().catch(() => null);
      if (!sd || (sd.code && sd.code !== 0)) {
        reply.code(502).send({ ok: false, message: '飞书发送失败：' + JSON.stringify(sd && (sd.msg || sd)) });
        return;
      }
      return { ok: true, fileId, messageId: sd.data && sd.data.message_id };
    } catch (e) {
      reply.code(502).send({ ok: false, message: '飞书接口出错：' + String(e && e.message || e) });
    }
  });
}
