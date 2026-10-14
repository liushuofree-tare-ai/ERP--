// 鉴权工厂：访问口令 → HMAC 签名 Cookie（HttpOnly，默认 30 天）。
// · password 为空：本机开发模式，所有请求放行（与单机版习惯一致）
// · 配了：除 /api/health、/api/auth/login 外都要带有效登录态
// · 飞书免登（routes/feishu.js）成功后也签发同一 Cookie，后续无区别
// 工厂式设计：index.js 用环境变量建一份；测试可用不同口令再建一份。
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export function createAuth({
  password = '', secret = '', cookieName = 'erp_auth', ttlDays = 30,
} = {}) {
  const enabled = password !== '';
  const usedSecret = secret || (enabled ? randomBytes(32).toString('hex') : 'dev-insecure-secret');
  const sign = (payload) => createHmac('sha256', usedSecret).update(payload).digest('hex');

  const auth = {
    enabled,
    cookieName,
    makeAuthToken() {
      const exp = Date.now() + ttlDays * 86400000;
      const payload = String(exp);
      return payload + '.' + sign(payload);
    },
    verifyAuthToken(token) {
      if (!token || typeof token !== 'string') return false;
      const dot = token.lastIndexOf('.');
      if (dot < 0) return false;
      const payload = token.slice(0, dot);
      const mac = token.slice(dot + 1);
      const want = sign(payload);
      if (mac.length !== want.length) return false;
      try { if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false; } catch (e) { return false; }
      const exp = Number(payload);
      return Number.isFinite(exp) && exp > Date.now();
    },
    checkPassword(input) {
      const a = Buffer.from(String(input || ''));
      const b = Buffer.from(password);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    isAuthed(req) {
      if (!enabled) return true;
      const token = req.cookies ? req.cookies[cookieName] : null;
      return auth.verifyAuthToken(token);
    },
    setAuthCookie(reply, token) {
      reply.setCookie(cookieName, token, {
        path: '/', httpOnly: true, sameSite: 'lax',
        maxAge: ttlDays * 86400,
      });
    },
    registerHook(app) {
      if (!enabled) return;
      app.addHook('onRequest', async (req, reply) => {
        const url = req.raw.url || '';
        if (url.startsWith('/api/health') || url.startsWith('/api/auth/login')) return;
        if (auth.isAuthed(req)) return;
        reply.code(401).send({ ok: false, code: 'NEED_AUTH', message: '需要登录：请输入访问口令' });
      });
    },
  };
  return auth;
}
