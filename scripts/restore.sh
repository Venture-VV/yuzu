#!/usr/bin/env bash
# 从备份文件恢复数据库：./scripts/restore.sh <备份文件.dump>
# 步骤：核对文件摘要 → 先备份当前数据 → 停止应用 → 重建数据库并导入 → 核对数据指纹（与备份时记下的比对）→ 启动应用 → 自检。
# 正式环境（.env 里 APP_ENV=production）必须当面输入确认，不接受 YUZU_RESTORE_CONFIRM 跳过。
set -euo pipefail
file=${1:-}
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "用法：./scripts/restore.sh <备份文件.dump>" >&2
  exit 1
fi
# 换成绝对路径再进入项目目录：相对路径按执行命令时所在的目录理解
file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
cd "$(dirname "$0")/.."
source scripts/lib/common.sh
app_env=$(env_of APP_ENV)
instance=$(env_of YUZU_INSTANCE)

# 先核对文件摘要：文件在拷贝、上传中坏了就不动数据库
verify_backup_file "$file" || { echo "不恢复。请换一份备份。" >&2; exit 1; }
echo "即将用 $file 覆盖当前数据库（APP_ENV=${app_env:-未设置}，实例 ${instance:-未设置}）。恢复前会先备份当前数据。"
if [[ "$app_env" == "production" ]]; then
  read -r -p "这是正式环境。确认恢复请输入 RESTORE-PRODUCTION：" answer
  [[ "$answer" == "RESTORE-PRODUCTION" ]] || { echo "已取消"; exit 1; }
elif [[ "${YUZU_RESTORE_CONFIRM:-}" != "yes" ]]; then
  read -r -p "确认恢复请输入 RESTORE：" answer
  [[ "$answer" == "RESTORE" ]] || { echo "已取消"; exit 1; }
fi

begin_maintenance "恢复 $(basename "$file")"
./scripts/backup.sh before-restore
mark_dirty
restore_database "$file"
if ! expect_fingerprint "$file"; then
  echo "✗ 恢复后的数据与备份时记下的指纹不同：应用保持停止。请保留现场，联系店主与 Codex 处理。" >&2
  exit 1
fi
docker compose start app backup

echo "等待应用启动…"
wait_for_app || echo "✗ 应用 60 秒内没有通过健康检查，请查看 docker compose logs app" >&2
docker compose exec -T app node dist/server/cli.js check
echo "✓ 恢复完成"
