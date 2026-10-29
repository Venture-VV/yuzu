#!/usr/bin/env bash
# 立即备份一次（在项目目录执行）：./scripts/backup.sh [备注]
# 在 backup 服务的容器里导出、在临时库试恢复、跑自检并记下数据指纹；
# 备份文件与旁边的 .json 说明写到 .env 中 BACKUP_DIR 指定的目录。备注只能用小写字母、数字和短横线。
set -euo pipefail
cd "$(dirname "$0")/.."
label=${1:-manual}
docker compose run --rm -T --no-deps backup node dist/server/cli.js backup --label "$label"
