#!/bin/sh
# 在 backup 容器内运行：每天 BACKUP_HOUR 点（门店时区）做一次 pg_dump，保留 BACKUP_KEEP_DAYS 天。
# 备份写到宿主机 BACKUP_DIR，建议指向外置硬盘等独立位置。
set -u
HOUR="${BACKUP_HOUR:-4}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p /backups

run_backup() {
  ts=$(date +%Y%m%d-%H%M%S)
  tmp="/backups/.yuzu-$ts.dump.partial"
  if pg_dump -Fc -f "$tmp" && pg_restore -l "$tmp" > /dev/null; then
    mv "$tmp" "/backups/yuzu-$ts.dump"
    echo "[backup] $(date '+%F %T') 完成 yuzu-$ts.dump（$(du -h "/backups/yuzu-$ts.dump" | cut -f1)）"
    find /backups -maxdepth 1 -name 'yuzu-*.dump' -mtime +"$KEEP" -print -delete | sed 's/^/[backup] 已清理过期备份 /'
  else
    rm -f "$tmp"
    echo "[backup] $(date '+%F %T') 备份失败，5 分钟后重试" >&2
    return 1
  fi
}

echo "[backup] 已启动：每天 ${HOUR}:00 后备份，保留 ${KEEP} 天，目录 /backups"
last=""
while true; do
  today=$(date +%Y%m%d)
  hour=$(date +%H | sed 's/^0//')
  [ -z "$hour" ] && hour=0
  if ls /backups/yuzu-"$today"-*.dump > /dev/null 2>&1; then
    last="$today"
  fi
  if [ "$last" != "$today" ] && [ "$hour" -ge "$HOUR" ]; then
    run_backup && last="$today"
  fi
  sleep 300
done
