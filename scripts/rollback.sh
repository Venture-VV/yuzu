#!/usr/bin/env bash
# 回到上一次 update.sh 之前的版本：./scripts/rollback.sh [--restore-data]
# 上一版的镜像由 update.sh 按完整 SHA 打了标签留着，不用重新构建。
# 新版本加了数据库迁移时，必须同时恢复升级前的备份（迁移只进不退）：升级之后录入的数据要按纸质单补录。
# 没加迁移时只切回上一版的程序，数据保留；加 --restore-data 也恢复升级前的备份。
# 步骤：核对升级记录与镜像 → 当面确认 → 停应用（入口关掉、写入停下）→ 回退前备份（这时的数据就是最后的数据）
#       → [列出升级以后写进系统的、当面确认要按纸质单补录 → 恢复升级前的备份、比对指纹] → 切回上一版代码与镜像 → 启动 → 自检。
# 8.1.0 起先停应用再备份（测试会话在 PR #113 be1de5a 报的 P1：原来应用开着做回退前的备份、恢复时才停，
# 中间新写进来的既不在回退前的备份里、也不在恢复后的库里）。确认之前取消、或备份没做成，应用照旧在新版本上启动。
# 正式环境（.env 里 APP_ENV=production）必须当面输入确认，不接受 YUZU_ROLLBACK_CONFIRM 跳过。
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/common.sh

state=.deploy/last-update
if [[ ! -f "$state" ]]; then
  echo "✗ 没有找到上一次升级的记录（$state）：用 v0.3.3 及之后的 update.sh 升级过，才能一键回退" >&2
  exit 1
fi
state_of() { grep -E "^$1=" "$state" | tail -n 1 | cut -d= -f2- || true; }
prev=$(state_of PREVIOUS_COMMIT)
prev_image=$(state_of PREVIOUS_IMAGE)
current=$(state_of CURRENT_COMMIT)
before=$(state_of BEFORE_UPDATE_BACKUP)
migrations=$(state_of MIGRATIONS_ADDED)

restore=false
[[ "${1:-}" == "--restore-data" ]] && restore=true
[[ -n "$migrations" ]] && restore=true

head=$(git rev-parse HEAD)
if [[ "$head" != "$current" ]]; then
  echo "✗ 当前代码（${head:0:12}）不是上次升级到的版本（${current:0:12}），不自动回退" >&2
  exit 1
fi
if ! docker image inspect "$prev_image" >/dev/null 2>&1; then
  echo "✗ 找不到上一版的镜像 $prev_image：可以 git checkout ${prev:0:12} 后用 update.sh 的步骤重新构建" >&2
  exit 1
fi
if $restore; then
  if [[ -z "$before" || ! -f "$before" ]]; then
    echo "✗ 找不到升级前的备份 ${before:-（升级时没有记下）}：外置盘是否已挂载？" >&2
    exit 1
  fi
  verify_backup_file "$before" || exit 1
fi

app_env=$(env_of APP_ENV)
echo "即将回退：${current:0:12} → ${prev:0:12}（APP_ENV=${app_env:-未设置}，实例 $(env_of YUZU_INSTANCE)）"
if $restore; then
  echo "· 同时恢复升级前的备份 $(basename "$before")${migrations:+（新版本加了迁移 $migrations）}。"
  echo "  升级之后录入的数据会丢失，要按纸质单补录；回退前会先备份当前数据，以便核对。"
else
  echo "· 新版本没有加数据库迁移：只切回上一版的程序，数据保留。"
fi
if [[ "$app_env" == "production" ]]; then
  read -r -p "这是正式环境。确认回退请输入 ROLLBACK-PRODUCTION：" answer
  [[ "$answer" == "ROLLBACK-PRODUCTION" ]] || { echo "已取消"; exit 1; }
elif [[ "${YUZU_ROLLBACK_CONFIRM:-}" != "yes" ]]; then
  read -r -p "确认回退请输入 ROLLBACK：" answer
  [[ "$answer" == "ROLLBACK" ]] || { echo "已取消"; exit 1; }
fi

begin_maintenance "回退到 ${prev:0:12}"
image=$(app_image)
# 没动数据之前不回退了：应用照旧在新版本上启动
resume_current() {
  echo "$1" >&2
  docker compose up -d app backup
  exit 1
}
# 先关入口、停下所有写入，再做回退前的备份：之后再没有新的写入，这份备份就是最后的数据
echo "· 停应用（前台、平板、小程序、员工端的写入都停下）……"
docker compose stop app backup
if ! out=$(./scripts/backup.sh before-rollback); then
  printf '%s\n' "$out"
  resume_current "✗ 回退前的备份没有做成：没有回退，应用照旧在新版本上启动"
fi
printf '%s\n' "$out"
rollback_dump=$(printf '%s\n' "$out" | grep -o 'yuzu-[0-9]\{8\}-[0-9]\{6\}-before-rollback\.dump' | tail -n 1 || true)
if $restore; then
  # 恢复升级前的备份会把那份备份之后写进系统的都拿掉：先列出来，当面确认要按纸质单补录
  since=$(json_str createdAt "$before.json")
  [[ -n "$since" ]] || since=$(state_of UPDATED_AT | cut -c1-16)
  mkdir -p .deploy
  report=".deploy/after-upgrade-$(date +%Y%m%d-%H%M%S).txt"
  if ! docker compose run --rm -T --no-deps backup node dist/server/cli.js changes-since --since "$since" > "$report"; then
    cat "$report"
    resume_current "✗ 列不出升级以后写进系统的数据：没有回退，应用照旧在新版本上启动"
  fi
  cat "$report"
  changes=$(grep -o '^CHANGES=[0-9]*' "$report" | tail -n 1 | cut -d= -f2 || true)
  if [[ "${changes:-1}" != "0" ]]; then
    echo "以上是升级以后写进系统的。恢复升级前的备份后，它们会从系统里消失，要按纸质单补录。"
    echo "回退前的备份里都留着：${rollback_dump:-见备份目录}；这份清单存在 $report。"
    if [[ "$app_env" == "production" ]]; then
      read -r -p "核对过、确认按纸质单补录，请输入 DISCARD-AFTER-UPGRADE（输入别的就不回退）：" answer
      [[ "$answer" == "DISCARD-AFTER-UPGRADE" ]] || resume_current "已取消回退：应用照旧在新版本上启动"
    elif [[ "${YUZU_ROLLBACK_CONFIRM:-}" != "yes" ]]; then
      read -r -p "确认按纸质单补录，请输入 DISCARD（输入别的就不回退）：" answer
      [[ "$answer" == "DISCARD" ]] || resume_current "已取消回退：应用照旧在新版本上启动"
    fi
  else
    echo "· 升级以后没有业务写入。"
  fi
fi
mark_dirty
if $restore; then
  restore_database "$before"
  # 用当前（新版本）的命令比对：只读，不执行迁移
  if ! expect_fingerprint "$before"; then
    echo "✗ 恢复后的数据与升级前备份记下的指纹不同：应用保持停止，代码仍是新版本。请保留现场，联系店主与 Codex 处理。" >&2
    exit 1
  fi
fi
git checkout -q --detach "$prev"
docker tag "$prev_image" "$image"
docker compose up -d
echo "等待应用启动…"
if ! wait_for_app; then
  echo "✗ 上一版没有正常启动，请查看 docker compose logs app" >&2
  exit 1
fi
docker compose exec -T app node dist/server/cli.js check
mv "$state" ".deploy/rolled-back-$(date +%Y%m%d-%H%M%S)"
echo "✓ 已回退到 ${prev:0:12}"
