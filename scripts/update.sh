#!/usr/bin/env bash
# 更新到指定版本：./scripts/update.sh <版本标签或完整 SHA，如 v0.3.0>
# 只部署已合并进 main 的版本：开发分支（claude/* 等）、未合并的 PR 与缩写 SHA 一律拒绝。
# 步骤：拉取并核对版本 → 备份 → 切换代码 → 构建新镜像 → 重启（启动时自动执行数据库迁移）→ 健康检查。
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:-}
if [[ -z "$target" ]]; then
  echo "用法：./scripts/update.sh <版本标签或完整 SHA>，可用版本：" >&2
  git fetch --tags -q && git tag --sort=-creatordate | head -10 >&2
  exit 1
fi
git fetch --tags origin
if git show-ref --verify --quiet "refs/tags/${target}"; then
  commit=$(git rev-parse "refs/tags/${target}^{commit}")
elif [[ "$target" =~ ^[0-9a-f]{40}$ ]]; then
  if ! git cat-file -e "${target}^{commit}" 2>/dev/null; then
    echo "✗ 找不到提交 $target" >&2
    exit 1
  fi
  commit=$target
else
  echo "✗ $target 不是版本标签或完整 SHA（40 位）：只部署 main 上的版本标签或完整 SHA，不部署分支" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "✗ $target 不在 main 上：只部署已合并进 main 的版本，不部署开发分支或未合并的 PR" >&2
  exit 1
fi
./scripts/backup.sh before-update
git checkout -q --detach "$commit"
export YUZU_VERSION="$(git describe --tags --always)"
export YUZU_COMMIT="$commit"
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
