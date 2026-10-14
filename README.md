# 汽配 ERP（新版）

给汽配外贸业务用的 ERP：客户询价单导入后在原格式表格里直接改，分别发给多家工厂报价，
回表原样上传、标价列后比价定厂，生成对客最终报价并导出（不泄漏工厂价），再转订单管收款、付款、发货。

## 两种使用形态

### 1. 单机模式（原来一直的用法，继续可用）

成品是一个单独的网页文件 **`汽配ERP-新版-正式版.html`**（`npm run build` 的默认产物，在 `app/dist/index.html`）：

1. 把文件放到固定位置（浏览器按文件位置存数据，别频繁换文件夹）；
2. 双击用 Edge / Chrome 打开即可使用，不用装任何东西、不用联网；
3. 数据存本机浏览器（localStorage + IndexedDB），定期在「数据备份」导出完整备份。

### 2. 云端模式（新：后端 + SQLite + 飞书）

需要一个能跑 Docker 服务器（或一台装了 Node 20+ 的机器）。架构：

- `app/` 前端（React + FortuneSheet，云端模式 = 本地镜像 + 服务器事实源）
- `server/` 后端（Fastify + Node 内置 `node:sqlite`，零原生依赖）
- 数据：`server/data/erp.sqlite`（WAL）+ `server/data/files/`（原件与图片，内容寻址）

#### Docker 一键部署（推荐）

```bash
# 1. 在 .env 里配置（上线必配口令！）
cat > .env <<'EOF'
PORT=3100
ERP_ACCESS_PASSWORD=换成你的访问口令
ERP_AUTH_SECRET=换一个长随机串
# 飞书群机器人播报（可选）
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
EOF

# 2. 构建并启动
docker compose up -d --build

# 3. 打开 http://<服务器IP>:3100，首次会提示输入访问口令
```

#### 本机开发 / 手动部署

```bash
# 后端（终端 1）
cd server && npm install && npm run dev     # http://localhost:3100

# 前端（终端 2）
cd app && npm install && npm run dev        # http://localhost:5173（/api 自动代理到 3100）

# 服务器模式构建（nginx + 后端托管）
cd app && SINGLE_FILE=0 npm run build       # 产物 app/dist（代码分割版）
```

### 云端模式行为约定

- 保存：先同步写本机（离线兜底），再异步推服务器；顶栏显示「已同步服务器 · 时间 · rev」。
- 冲突：多窗口并发修改不会被静默覆盖——后到的保存被 409 拒绝并提示去「数据备份」拉取服务器数据。
- 备份：服务器备份与本机备份是同一格式（`qipei-erp-v2-backup` zip），互相可恢复。
- 原件与图片：SHA-256 内容寻址（`orig-…/img-…`），本地与云端天然去重。

### 飞书接入

| 能力 | 配置 | 说明 |
| --- | --- | --- |
| 在飞书里打开使用 | 无需配置 | 浏览器打开 `http://<服务器>`，把链接挂到飞书常用/群置顶即可（需要登录时输口令） |
| 飞书内下载询价/报价/备份 | 无需配置 | 检测到飞书内置浏览器时自动改走服务器「临时下载直链」，不再依赖 blob: 下载 |
| 群播报（订单/收款/付款/发货） | `FEISHU_WEBHOOK_URL`（+ 可选 `FEISHU_WEBHOOK_SECRET`） | 群里添加机器人（自定义 Webhook），把地址填入 `.env` 后 `docker compose up -d` 生效 |
| 自建应用免登 / 发文件 | `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | 需在飞书开放平台创建企业自建应用；能力接口已就绪（`/api/feishu/*`） |

### 生产安全（重要）

- 系统里存的是客户台账、工厂底价、税点、加价率与应收应付——**公网部署必须设置 `ERP_ACCESS_PASSWORD`**。
- 未配置口令 = 本机开发模式（任何能访问端口的人都能读写数据）。
- AI 分析的接口钥匙只存使用者的浏览器（不进数据库、不进备份）。

## 直接使用（单机模式，推荐给不需要多机的场景）

见上文「单机模式」。本仓库里是**源代码**，下载下来不能直接双击运行。

## 自行构建（懂开发的再看）

需要 Node.js 20+（内置 `node:sqlite`）：

```bash
cd app
npm install
npm run build   # 单机单文件：产物在 app/dist/index.html，双击打开即是成品
cd ../server
npm install
npm test        # 后端 61 条 API 测试
npm start       # 启动后端并托管 app/dist（云端模式）
```

## 测试与回归

- 前端 12 套件（xlsx 文件层回归用真实 39 行/24 图客户单 + 工厂回表样本）：

```bash
cd app && npm test         # 494+ 断言
```

- 后端：`cd server && npm test`（状态整存整取/乐观锁/文件互验/备份往返/鉴权）。

## 文档

- `SPEC.md`：需求规格（业务规则的权威来源）
- `ARCHITECTURE.md`：技术架构
- `nginx.conf.example` / `Dockerfile` / `docker-compose.yml`：服务器部署

当前版本：v2-pkg17 + 云端/飞书。
