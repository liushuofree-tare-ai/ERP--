// 服务入口：注册插件 → 鉴权钩子 → 路由 →（可选）托管前端 dist。
// buildApp() 返回未监听的 app（测试 può app.inject 直发请求）；
// 直接 node src/index.js 时才 start() 起服务。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { PORT, BODY_LIMIT, ACCESS_PASSWORD, AUTH_SECRET, FEISHU_WEBHOOK_URL, FEISHU_APP_ID, AI_PROXY_URL } from './config.js';
import { createAuth } from './auth.js';
import { getDb, getMeta } from './db.js';
import { registerStateRoutes, getCurrentRevision } from './routes/state.js';
import { registerFileRoutes } from './routes/files.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerFeishuRoutes } from './routes/feishu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildApp({ accessPassword, authSecret, logger = true } = {}) {
  const app = Fastify({
    logger: logger ? { level: 'warn' } : false,
    bodyLimit: BODY_LIMIT,
  });
  const auth = createAuth({
    password: accessPassword !== undefined ? accessPassword : ACCESS_PASSWORD,
    secret: authSecret !== undefined ? authSecret : AUTH_SECRET,
  });

  app.register(cookie);
  // 二进制体解析（文件上传 / 备份恢复都是 raw 字节）
  const rawBody = (_req, body, done) => done(null, Buffer.isBuffer(body) ? body : Buffer.from(body || ''));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, rawBody);
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, rawBody);
  app.addContentTypeParser('application/x-zip-compressed', { parseAs: 'buffer' }, rawBody);

  auth.registerHook(app);

  app.get('/api/health', async () => {
    let dbOk = true;
    try { getDb().prepare('SELECT 1').get(); } catch (e) { dbOk = false; }
    return {
      ok: dbOk,
      version: 'server-0.1.0',
      revision: getCurrentRevision(),
      savedAt: getMeta('saved_at'),
      dbOk,
      auth: auth.enabled,
      feishu: { webhook: FEISHU_WEBHOOK_URL !== '', app: FEISHU_APP_ID !== '' },
      now: new Date().toISOString(),
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!auth.enabled) return { ok: true, message: '本机开发模式：无需登录' };
    if (!auth.checkPassword((req.body || {}).password)) {
      reply.code(401).send({ ok: false, message: '口令不对' });
      return;
    }
    auth.setAuthCookie(reply, auth.makeAuthToken());
    return { ok: true };
  });

  registerStateRoutes(app);
  registerFileRoutes(app);
  registerBackupRoutes(app);
  registerFeishuRoutes(app);

  // AI 转发（可选）：解决浏览器直连 AI 接口的 CORS 拦截
  app.post('/api/ai/proxy', async (req, reply) => {
    const { url, apiKey, body } = req.body || {};
    if (!AI_PROXY_URL && (!url || !/^https:\/\//.test(String(url)))) {
      reply.code(400).send({ ok: false, message: '目标地址必须是 https' });
      return;
    }
    const target = AI_PROXY_URL || url;
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: 'Bearer ' + String(apiKey) } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      const data = await res.text();
      reply.code(res.status).header('content-type', res.headers.get('content-type') || 'application/json')
        .send(data);
    } catch (e) {
      reply.code(502).send({ ok: false, message: 'AI 转发失败：' + String(e && e.message || e) });
    }
  });

  // 托管前端构建产物（app/dist）。前端跑 dev 时（5173）由 vite 代理 /api 过来。
  const distDir = path.resolve(__dirname, '../../app/dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.register(fastifyStatic, { root: distDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if ((req.raw.url || '').startsWith('/api/')) {
        reply.code(404).send({ ok: false, message: '接口不存在' });
        return;
      }
      reply.sendFile('index.html'); // 前端路由兜底
    });
  }

  return app;
}

export async function start() {
  const app = buildApp();
  await app.ready();
  // 数据目录 & 库先就绪
  getDb();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.warn('ERP 后端已启动: http://localhost:' + PORT +
    (ACCESS_PASSWORD ? '（已开启访问口令）' : '（本机开发模式：未配置口令）'));
  return app;
}

// 直接运行才起服务；被测试 import 时不自动 listen
const __filename_self = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename_self;
if (isMain) start().catch((e) => { console.error(e); process.exit(1); });
