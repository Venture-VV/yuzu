#!/usr/bin/env bash
# 从备份文件恢复数据库：./scripts/restore.sh <备份文件.dump>
# 步骤：先自动备份当前数据 → 停止应用 → 重建数据库并导入 → 启动应用 → 核对余额与流水。
set -euo pipefail
cd "$(dirname "$0")/.."
file=${1:-}
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "用法：./scripts/restore.sh <备份文件.dump>" >&2
  exit 1
fi
echo "即将用 $file 覆盖当前数据库。恢复前会自动备份当前数据。"
if [[ "${YUZU_RESTORE_CONFIRM:-}" != "yes" ]]; then
  read -r -p "确认恢复请输入 RESTORE：" answer
  [[ "$answer" == "RESTORE" ]] || { echo "已取消"; exit 1; }
fi

./scripts/backup.sh before-restore
docker compose stop app backup
docker compose exec -T db psql -U yuzu -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS yuzu WITH (FORCE);" -c "CREATE DATABASE yuzu OWNER yuzu;"
docker compose exec -T db pg_restore -U yuzu -d yuzu --no-owner --exit-on-error < "$file"
docker compose start app backup

echo "等待应用启动…"
for _ in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 2
done
docker compose exec -T app node dist/server/cli.js check
echo "✓ 恢复完成"
