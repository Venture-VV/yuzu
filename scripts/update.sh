#!/usr/bin/env bash
# 更新到指定版本：./scripts/update.sh <版本标签或分支，如 v0.1.0>
# 步骤：备份 → 拉取代码 → 构建新镜像 → 重启（启动时自动执行数据库迁移）→ 健康检查。
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:-}
if [[ -z "$target" ]]; then
  echo "用法：./scripts/update.sh <版本标签>，可用版本：" >&2
  git fetch --tags -q && git tag --sort=-creatordate | head -10 >&2
  exit 1
fi
./scripts/backup.sh before-update
git fetch --tags origin
git checkout "$target"
export YUZU_VERSION="$(git describe --tags --always)"
docker compose build app
docker compose up -d
for _ in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    docker compose exec -T app node dist/server/cli.js check
    echo "✓ 已更新到 $target"
    exit 0
  fi
  sleep 2
done
echo "✗ 新版本没有正常启动，请查看 docker compose logs app；可用 git checkout <上个版本> 后重新执行本脚本回退。" >&2
exit 1
