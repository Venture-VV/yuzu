#!/usr/bin/env bash
# 生成每日对账包（只读，不改任何数据）：./scripts/daily-recon.sh [营业日 YYYY-MM-DD，默认当前营业日]
# 写到项目目录的 recon/<营业日>/（不进 Git）：说明、日结汇总、结账单、部门参考表、异常清单、交班。
# 影子运行期间每晚营业结束后跑一次，与旧系统对账；营业日没结束时跑出的是截至此刻的数。
set -euo pipefail
cd "$(dirname "$0")/.."
date=${1:-}
if [[ -n "$date" && ! "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "用法：./scripts/daily-recon.sh [营业日 YYYY-MM-DD]" >&2
  exit 1
fi
mkdir -p recon
docker compose run --rm -T --no-deps -v "$PWD/recon:/recon" backup node dist/server/cli.js daily-recon --out /recon ${date:+--date "$date"}
