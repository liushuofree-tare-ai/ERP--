// 服务端配置：全部来自环境变量，缺省值即"开箱可用"。
// 生产部署（docker-compose / nginx）里按需覆盖：
//   PORT                  监听端口（默认 3100）
//   DATA_DIR              数据目录：SQLite 库 + 文件仓库 + 备份（默认 ./data）
//   ERP_ACCESS_PASSWORD   访问口令（不设 = 本机开发模式，无鉴权）
//   ERP_AUTH_SECRET       登录态 Cookie 签名密钥（默认随机，重启后已登录用户要重登）
//   FEISHU_WEBHOOK_URL    飞书群机器人 Webhook（可选：配了才推送）
//   FEISHU_APP_ID/SECRET  飞书自建应用（可选：免登 + 发文件用）
//   AI_PROXY_URL          AI 转发地址（可选，浏览器直连被 CORS 拦时用）
import path from 'node:path';

const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fb; };

export const PORT = num(process.env.PORT, 3100);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const DB_PATH = path.join(DATA_DIR, 'erp.sqlite');
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

export const ACCESS_PASSWORD = (process.env.ERP_ACCESS_PASSWORD || '').trim();
// 口令没配：本机开发模式不鉴权；配了：密钥也该配（随机则每次重启失效）
export const AUTH_SECRET = (process.env.ERP_AUTH_SECRET || '').trim() || '';
export const AUTH_COOKIE = 'erp_auth';
export const AUTH_TTL_DAYS = 30;

export const FEISHU_WEBHOOK_URL = (process.env.FEISHU_WEBHOOK_URL || '').trim();
export const FEISHU_APP_ID = (process.env.FEISHU_APP_ID || '').trim();
export const FEISHU_APP_SECRET = (process.env.FEISHU_APP_SECRET || '').trim();
export const AI_PROXY_URL = (process.env.AI_PROXY_URL || '').trim();

export const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000; // 临时下载直链 5 分钟有效
export const BODY_LIMIT = 60 * 1024 * 1024;        // 大单回表 + 备份恢复上限 60MB
