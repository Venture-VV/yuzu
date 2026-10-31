#!/usr/bin/env bash
# 更新到指定版本：./scripts/update.sh <版本标签或完整 SHA，如 v0.3.0>
# 只部署已合并进 main 的版本：开发分支（claude/* 等）、未合并的 PR 与缩写 SHA 一律拒绝。
# 步骤：拉取并核对版本 → 备份 → 当前镜像按完整 SHA 另打标签保留 → 切换代码 → 构建新镜像 → 记下回退信息 → 重启（启动时自动执行数据库迁移）→ 健康检查。
# 新版本有问题时用 ./scripts/rollback.sh 回到这次升级之前的版本。
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/common.sh
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
begin_maintenance "升级到 $target"
prev=$(git rev-parse HEAD)
image=$(app_image)
out=$(./scripts/backup.sh before-update)
printf '%s\n' "$out"
before=$(printf '%s\n' "$out" | grep -o 'yuzu-[0-9]\{8\}-[0-9]\{6\}-before-update\.dump' | tail -n 1 || true)
# 正在运行的镜像按完整 SHA 另打一个标签：回退时直接切回，不用重新构建
running=$(docker compose ps -q app 2>/dev/null | head -n 1)
if [[ -n "$running" && -n "$image" ]]; then
  docker tag "$(docker inspect --format '{{.Image}}' "$running")" "$image-$prev"
fi
mark_dirty
git checkout -q --detach "$commit"
# 版本号按这个提交的 package.json（发版 PR 里改好、与之后 CI 打的标签一致）。不用 git describe：
# 合并后、main 上 CI 打标签之前就部署时，describe 会显示成上一个版本（例如 v0.7.3 显示成 0.7.2-15-g13e9d3d）
YUZU_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' package.json | head -n 1)"
[[ -n "$YUZU_VERSION" ]] || YUZU_VERSION="$(git describe --tags --always)"
export YUZU_VERSION YUZU_COMMIT="$commit"
docker compose build app
docker tag "$image" "$image-$commit"
# 回退要用的信息：上一版的提交与镜像、升级前的备份、这次新加的迁移
mkdir -p .deploy
{
  echo "PREVIOUS_COMMIT=$prev"
  echo "PREVIOUS_IMAGE=$image-$prev"
  echo "CURRENT_COMMIT=$commit"
  echo "BEFORE_UPDATE_BACKUP=${before:+$(backup_dir)/$before}"
  echo "MIGRATIONS_ADDED=$(git diff --name-only --diff-filter=A "$prev" "$commit" -- src/server/migrations/ | sed 's#.*/##' | tr '\n' ' ' | sed 's/ *$//')"
  echo "UPDATED_AT=$(date '+%Y-%m-%d %H:%M:%S')"
} > .deploy/last-update
prune_sha_tags "$image" "$prev" "$commit"
docker compose up -d
if wait_for_app; then
  docker compose exec -T app node dist/server/cli.js check
  echo "✓ 已更新到 $target"
  exit 0
fi
echo "✗ 新版本没有正常启动，请查看 docker compose logs app；可用 ./scripts/rollback.sh 回到上一版。" >&2
exit 1
