#!/usr/bin/env bash
# 网关服务器更新到指定版本：src/gateway/deploy/update.sh <版本标签或完整 SHA>（docs/DEPLOY_GATEWAY.md 第 6 节）
# 与 scripts/update.sh 一样只部署已合并进 main 的版本：开发分支（claude/* 等）、未合并的 PR 与缩写 SHA 一律拒绝。
# 网关不存业务数据：不备份、不迁移。回到上一版就是用上一版的 SHA 再执行一次（最后会打出来；镜像还在就不用重新构建）。
# 步骤：核对版本 → 切换代码 → 构建网关镜像（按完整 SHA 打标签）→ 换上 → 应该开着的网关逐个起来 → Caddy 加载这一版的配置 → 经 Caddy 核对；
# 有一项不通过就返回失败。
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

# 核对：按 .env 的 COMPOSE_PROFILES 算出应该开着的服务（caddy、gateway-test，正式切换后还有 gateway-prod），
# 一个一个核对，缺了、退出了、连不通都算失败（小程序线测试预检 3ab3ab5 的 P2：原来只看开着的网关，退出的被跳过）
ok=true
expected=$(docker compose config --services)
env_of() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }
has_service() {
  local s
  for s in $expected; do [[ "$s" == "$1" ]] && return 0; done
  return 1
}

# 网关进程：/v1/live 不问门店（门店断外网时也算起来了）；容器退出、起不来时 exec 一直失败，等 60 秒判失败
for svc in $expected; do
  [[ "$svc" == gateway-* ]] || continue
  up=false
  for _ in $(seq 1 30); do
    if docker compose exec -T "$svc" node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8300)+'/v1/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      up=true
      break
    fi
    sleep 2
  done
  if $up; then echo "✓ $svc 已起来"; else echo "✗ $svc 没有起来：docker compose logs $svc" >&2; ok=false; fi
done

# Caddy：每次都重新加载这一版的 Caddyfile（caddy/ 整个目录挂进容器，切换版本后看得到新文件）；
# 加载失败时 Caddy 照旧用原来的配置，这里判失败
if out=$(docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
  echo "✓ Caddy 已加载这一版的配置"
else
  echo "✗ Caddy 没有加载这一版的配置（原来的配置照旧在用）：${out%%$'\n'*}；docker compose logs caddy" >&2
  ok=false
fi

# 经 Caddy 核对每个开着的网关（连本机 443、按域名验证书）：第一次部署时证书要申请一会儿，最多等 60 秒
check_https() {
  local domain=$1 health="" reached=false
  for _ in $(seq 1 12); do
    if health=$(curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/v1/health" 2>&1); then
      reached=true
      break
    fi
    sleep 5
  done
  if $reached; then
    echo "✓ https://$domain/v1/health：$health"
  else
    local why="第一次部署时证书可能还在申请：过几分钟用同一个版本再执行一次"
    # Caddy 回了 503：证书没问题，是后面的网关没有回应（Caddy 回的是「门店系统连接中」）
    [[ "$health" == *"returned error"* ]] && why="Caddy 连得上，后面的网关没有回应"
    echo "✗ 经 Caddy 连不通 https://$domain：${health%%$'\n'*}（$why）" >&2
    ok=false
  fi
}
domains=""
if has_service gateway-test; then domains="$(env_of GATEWAY_TEST_DOMAIN)"; fi
if has_service gateway-prod; then domains="$domains $(env_of GATEWAY_PROD_DOMAIN)"; fi
if ! command -v curl >/dev/null 2>&1; then
  echo "✗ 这台机器没有 curl，经 Caddy 核对不了：sudo apt-get install -y curl" >&2
  ok=false
else
  for domain in $domains; do check_https "$domain"; done
fi

if $ok; then
  [[ "$prev" != "$commit" ]] && echo "上一版：${prev}（要回去：src/gateway/deploy/update.sh $prev）"
  echo "✓ 网关已更新到 $target（$commit）"
  exit 0
fi
if [[ "$prev" != "$commit" ]]; then
  echo "✗ 没有全部核对通过（见上面的 ✗）；要回到上一版：src/gateway/deploy/update.sh $prev" >&2
else
  echo "✗ 没有全部核对通过（见上面的 ✗）" >&2
fi
exit 1
