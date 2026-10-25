#!/usr/bin/env bash
# 立即备份一次（在 Mac mini 的项目目录执行）：./scripts/backup.sh [备注]
# 备份文件写到 .env 中 BACKUP_DIR 指定的目录。
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR=$(grep -E '^BACKUP_DIR=' .env 2>/dev/null | cut -d= -f2- || true)
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
label=${1:-manual}
file="$BACKUP_DIR/yuzu-$(date +%Y%m%d-%H%M%S)-$label.dump"
docker compose exec -T db pg_dump -U yuzu -d yuzu -Fc > "$file.partial"
# 校验备份文件可以被读取
docker compose exec -T db pg_restore -l < "$file.partial" > /dev/null
mv "$file.partial" "$file"
echo "✓ 已备份：$file（$(du -h "$file" | cut -f1)）"
