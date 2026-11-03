#!/usr/bin/env bash
# 在网关服务器上传小程序体验版：src/gateway/deploy/upload-miniprogram.sh [--dry-run]（docs/DEPLOY_GATEWAY.md 第 7 节）
# 传的是这台机器现在的代码（update.sh 部署的那个 main 上的版本），所以体验版与测试网关是同一个版本。
# 在一次性的 Node 容器里跑 miniprogram/tools/upload/upload.mjs：宿主机不用装 Node；代码上传密钥只读挂进去，用完容器就删。
# 要用的配置：.env 的 MP_UPLOAD_KEY_FILE（密钥文件）、MP_ROBOT（可选），gateway-test.env 的 WX_APPID。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
cd "$repo"

dry=""
[[ "${1:-}" == "--dry-run" ]] && dry="--dry-run"
env_of() { grep -E "^$1=" "$2" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }

# 只传 main 上的版本，不传改过的代码
git fetch -q origin main
commit=$(git rev-parse HEAD)
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "✗ 现在的代码（${commit:0:12}）不在 main 上：先用 update.sh 部署 main 上的版本再上传" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ 仓库里有改过的文件（git status）：不上传改过的代码" >&2
  exit 1
fi

appid=$(env_of WX_APPID "$here/gateway-test.env")
key=$(env_of MP_UPLOAD_KEY_FILE "$here/.env")
robot=$(env_of MP_ROBOT "$here/.env")
image=$(env_of NODE_IMAGE "$here/.env")
registry=$(env_of NPM_REGISTRY "$here/.env")
if [[ -z "$dry" ]]; then
  [[ -n "$appid" ]] || { echo "✗ gateway-test.env 里没有 WX_APPID" >&2; exit 1; }
  [[ -n "$key" && -f "$key" ]] || { echo "✗ 找不到代码上传密钥：.env 的 MP_UPLOAD_KEY_FILE（${key:-没写}）" >&2; exit 1; }
  # 密钥只给自己读
  chmod 600 "$key"
fi

args=(--rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e MP_COMMIT="$commit" -e MP_SUBJECT="$(git log -1 --format=%s)"
  -e MP_APPID="$appid" -e MP_ROBOT="${robot:-1}" -v "$repo/miniprogram:/mp" -w /mp/tools/upload)
[[ -z "$dry" ]] && args+=(-e MP_UPLOAD_KEY=/run/mp-upload.key -v "$key:/run/mp-upload.key:ro")
# 依赖装在 miniprogram/tools/upload/node_modules（不进 Git）；锁文件没变就不重装
docker run "${args[@]}" "${image:-node:22-alpine}" sh -c "
  if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci --no-audit --no-fund --registry=${registry:-https://registry.npmjs.org} >/dev/null
  fi
  node upload.mjs $dry"
