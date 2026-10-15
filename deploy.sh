#!/usr/bin/env bash
# 汽配 ERP 服务器部署/更新脚本（在仓库根目录运行：./deploy.sh）
# 做的事：拉最新代码 → 重新构建并启动 → 等健康检查通过。
# 数据在 ./data 目录（compose 挂卷），更新代码不会动数据。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ 还没装 Docker。先装：curl -fsSL https://get.docker.com | sh && sudo systemctl enable --now docker"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "✗ 没有 docker compose 插件（Docker 较老）。升级 Docker 后再跑。"
  exit 1
fi
if [ ! -f .env ]; then
  echo "✗ 还没有 .env。先执行：cp .env.example .env，然后改里面的访问口令和密钥。"
  exit 1
fi
if grep -q "改成" .env; then
  echo "⚠ .env 里还有没改的占位值（口令/密钥），先改掉再部署。"
  exit 1
fi

if [ -d .git ]; then
  echo "→ 拉取最新代码…"
  git pull --ff-only
fi

echo "→ 构建并启动…"
docker compose up -d --build

PORT="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3100}"
echo "→ 等服务起来（健康检查 http://localhost:${PORT}/api/health）…"
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "✓ 已启动：http://<服务器公网IP>:${PORT}（浏览器打开输口令登录）"
    exit 0
  fi
  sleep 2
done
echo "✗ 60 秒内没起来，看日志：docker compose logs -f"
exit 1
