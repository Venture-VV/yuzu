#!/usr/bin/env bash
# 演练：把一份备份恢复到临时库，核对文件摘要、数据指纹与自检，然后删掉临时库；不碰当前数据库。
# 用法（在项目目录执行）：./scripts/verify-backup.sh <备份文件.dump>
# 备份旁同名的 .json 说明一起读取；文件可以在外置盘，也可以在从 OSS 取回并解密的目录。
set -euo pipefail
file=${1:-}
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "用法：./scripts/verify-backup.sh <备份文件.dump>" >&2
  exit 1
fi
dir=$(cd "$(dirname "$file")" && pwd)
name=$(basename "$file")
cd "$(dirname "$0")/.."
docker compose run --rm -T --no-deps -v "$dir:/verify:ro" backup node dist/server/cli.js verify-backup "/verify/$name"
