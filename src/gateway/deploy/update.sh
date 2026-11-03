#!/usr/bin/env bash
# 网关服务器更新到指定版本：src/gateway/deploy/update.sh <版本标签或完整 SHA>（docs/DEPLOY_GATEWAY.md 第 6 节）
# 与 scripts/update.sh 一样只部署已合并进 main 的版本：开发分支（claude/* 等）、未合并的 PR 与缩写 SHA 一律拒绝。
# 网关不存业务数据：不备份、不迁移。回到上一版就是用上一版的 SHA 再执行一次（最后会打出来；镜像还在就不用重新构建）。
# 步骤：核对版本 → 切换代码 → 构建网关镜像（按完整 SHA 打标签）→ 换上 → 等网关起来、经 Caddy 核对 → 重新加载 Caddy 的配置。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
cd "$repo"

target=${1:-}
if [[ -z "$target" ]]; then
  echo "用法：src/gateway/deploy/update.sh <版本标签或完整 SHA>，可用版本：" >&2
  git fetch --tags -q origin && git tag --sort=-creatordate | head -10 >&2
  exit 1
fi
if [[ ! -f "$here/.env" || ! -f "$here/gateway-test.env" ]]; then
  echo "✗ 先照 .env.example、gateway.env.example 写好 $here/.env 与 gateway-test.env（docs/DEPLOY_GATEWAY.md 第 4 节）" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ 仓库里有改过的文件（git status）：网关服务器上不改代码，先还原再更新" >&2
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

prev=$(git rev-parse HEAD)
git checkout -q --detach "$commit"
# 后面用的是这个版本里的 compose.yaml、Caddyfile 与本脚本之外的文件
cd "$here"

image="yuzu-gateway:$commit"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  GATEWAY_TAG="$commit" GATEWAY_COMMIT="$commit" docker compose build gateway-test
fi
docker tag "$image" yuzu-gateway:current
docker compose up -d --remove-orphans

# 每个开着的网关进程都要起来（/v1/live 不问门店：门店断外网时也算起来了）
ok=true
for svc in $(docker compose ps --services --status running | grep '^gateway-' || true); do
  up=false
  for _ in $(seq 1 30); do
    if docker compose exec -T "$svc" node -e "fetch('http://127.0.0.1:8300/v1/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      up=true
      break
    fi
    sleep 2
  done
  if $up; then echo "✓ $svc 已起来"; else echo "✗ $svc 没有起来：docker compose logs $svc" >&2; ok=false; fi
done
running=$(docker compose ps --services --status running | grep -c '^gateway-' || true)
if [[ "$running" -eq 0 ]]; then
  echo "✗ 一个网关进程都没有开着：docker compose ps" >&2
  ok=false
fi

# Caddyfile 在这一版里改过时要重新加载（没改过也没关系）
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || echo "· Caddy 的配置没有重新加载：docker compose logs caddy" >&2

# 经 Caddy 核对测试网关（连本机 443，按域名验证书）：证书第一次申请要等一会儿，失败时稍后再试一次
domain=$(grep -E '^GATEWAY_TEST_DOMAIN=' .env | tail -n 1 | cut -d= -f2-)
if [[ -n "$domain" ]] && command -v curl >/dev/null 2>&1; then
  if health=$(curl -fsS --max-time 15 --resolve "$domain:443:127.0.0.1" "https://$domain/v1/health" 2>&1); then
    echo "✓ https://$domain/v1/health：$health"
  else
    echo "· 经 Caddy 还没有连通 https://$domain（第一次要等证书，过几分钟再打开看看）：${health%%$'\n'*}" >&2
  fi
fi

if [[ "$prev" != "$commit" ]]; then
  echo "上一版：${prev}（要回去：src/gateway/deploy/update.sh $prev）"
fi
if $ok; then
  echo "✓ 网关已更新到 $target（$commit）"
  exit 0
fi
echo "✗ 网关没有全部起来；可以用上一行的命令回到上一版" >&2
exit 1
