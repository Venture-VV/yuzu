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
env_of() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
app_env=$(env_of APP_ENV)
instance=$(env_of YUZU_INSTANCE)
json_of() { grep -o "\"$1\": \"[0-9a-f]\{64\}\"" "$file.json" 2>/dev/null | head -n 1 | grep -o '[0-9a-f]\{64\}' || true; }
expected=""
if [[ -f "$file.json" ]]; then
  # 先核对文件摘要：文件在拷贝、上传中坏了就不动数据库
  sha=$(json_of sha256)
  if [[ -n "$sha" ]]; then
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file" | cut -d' ' -f1); else actual=$(shasum -a 256 "$file" | cut -d' ' -f1); fi
    if [[ "$actual" != "$sha" ]]; then
      echo "✗ 备份文件与备份时的摘要不同（文件在拷贝或保存中被改动），不恢复。请换一份备份。" >&2
      exit 1
    fi
    echo "✓ 备份文件摘要与备份时一致"
  fi
  expected=$(json_of fingerprintDigest)
fi
echo "即将用 $file 覆盖当前数据库（APP_ENV=${app_env:-未设置}，实例 ${instance:-未设置}）。恢复前会先备份当前数据。"
if [[ "$app_env" == "production" ]]; then
  read -r -p "这是正式环境。确认恢复请输入 RESTORE-PRODUCTION：" answer
  [[ "$answer" == "RESTORE-PRODUCTION" ]] || { echo "已取消"; exit 1; }
elif [[ "${YUZU_RESTORE_CONFIRM:-}" != "yes" ]]; then
  read -r -p "确认恢复请输入 RESTORE：" answer
  [[ "$answer" == "RESTORE" ]] || { echo "已取消"; exit 1; }
fi

./scripts/backup.sh before-restore
docker compose stop app backup
docker compose exec -T db psql -U yuzu -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS yuzu WITH (FORCE);" -c "CREATE DATABASE yuzu OWNER yuzu;"
docker compose exec -T db pg_restore -U yuzu -d yuzu --no-owner --exit-on-error < "$file"

# 应用启动前核对指纹：启动后会执行迁移、写入登录会话，数据就不再与备份完全相同
if [[ -n "$expected" ]]; then
  if ! docker compose run --rm -T --no-deps backup node dist/server/cli.js fingerprint --expect "$expected"; then
    echo "✗ 恢复后的数据与备份时记下的指纹不同：应用保持停止。请保留现场，联系店主与 Codex 处理。" >&2
    exit 1
  fi
else
  echo "· 备份旁没有 .json 说明（旧版备份），跳过指纹比对"
fi
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
