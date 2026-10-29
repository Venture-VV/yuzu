#!/usr/bin/env bash
# 看门狗：在宿主机上每 5 分钟运行一次（Mac mini 用 launchd，Linux 用 cron，见部署手册），在项目目录里检查：
#   1. Docker 是否在运行（Mac 上没运行时尝试打开 Docker Desktop）；
#   2. 应用健康检查：连续 3 次失败时重启 app 并告警（Docker 不会自动重启 unhealthy 的容器）；
#      升级、恢复、回退期间（.deploy/maintenance）不重启，维护标记留了 30 分钟以上时告警；
#   3. 备份服务在运行（没在运行就启动它）、最新的定时备份不过期（不超过两个备份间隔）、核验通过、自检一致；要求哨兵时外置盘已挂载；
#   4. 备份目录与项目目录所在磁盘剩余空间不少于 10% 且不少于 5 GB；
#   5. 配置了异地副本（OFFSITE_TARGET，见 scripts/offsite-copy.sh）时，已传到云服务器的最新一份备份不早于两个备份间隔加 1 小时。
# 告警推到 .env 的 WECOM_WEBHOOK_URL（企业微信群机器人）；没配置时只写日志。同一项告警每小时最多推一次，恢复时推一次「已恢复」。
# 每天 9 点后推一条「每日巡检」，收不到就说明看门狗或这台机器本身出了问题。
# 日志在 .watchdog/watchdog.log；--test 只推一条测试消息。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
source scripts/lib/common.sh
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:$PATH"

state=.watchdog
mkdir -p "$state"
log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$state/watchdog.log"
  [[ -t 1 ]] && printf '%s\n' "$*"
  return 0
}
# 日志超过 1 MB 时轮转一次
if [[ -f "$state/watchdog.log" && $(wc -c < "$state/watchdog.log") -gt 1048576 ]]; then mv -f "$state/watchdog.log" "$state/watchdog.log.1"; fi

# 同一时刻只跑一个（上一次卡住超过 10 分钟就当作已结束）
if ! mkdir "$state/lock" 2>/dev/null; then
  [[ $(( $(date +%s) - $(mtime_of "$state/lock") )) -lt 600 ]] && exit 0
  rm -rf "$state/lock" && mkdir "$state/lock"
fi
trap 'rm -rf "$state/lock"' EXIT

webhook=$(env_of WECOM_WEBHOOK_URL)
instance=$(env_of YUZU_INSTANCE)
case "$instance" in
  prod) label=正式服 ;; shadow) label=影子运行 ;; test) label=测试服 ;; demo) label=演示库 ;; *) label=${instance:-未设置实例} ;;
esac
label="$label@$(hostname -s 2>/dev/null || hostname)"
now=$(date +%s)

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
send() {
  local text="【浴族·$label】$1" resp
  log "$text"
  [[ -n "$webhook" ]] || return 0
  if ! resp=$(curl -sS -m 10 -H 'Content-Type: application/json' -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$(json_escape "$text")\"}}" "$webhook" 2>&1); then
    log "✗ 企业微信推送失败：$resp"
    return 1
  fi
  case "$resp" in *'"errcode":0'*) return 0 ;; esac
  log "✗ 企业微信推送失败：$resp"
  return 1
}
# 有问题：同一项每小时最多推一次；推送失败下次再推
alert() {
  local key=$1 last
  last=$(cat "$state/$key.alert" 2>/dev/null || echo 0)
  [[ $((now - last)) -lt 3600 ]] && return 0
  send "✗ $2" && echo "$now" > "$state/$key.alert"
}
# 恢复正常：之前告过警的推一次「已恢复」
resolve() {
  [[ -f "$state/$1.alert" ]] || return 0
  send "✓ 已恢复：$2" && rm -f "$state/$1.alert"
}

if [[ "${1:-}" == "--test" ]]; then
  send "测试消息：看门狗能推送到这个群" && echo "✓ 已推送" || echo "✗ 推送失败，见 $state/watchdog.log"
  exit 0
fi

# 1. Docker
if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname)" == Darwin ]]; then open -a Docker >/dev/null 2>&1 || true; fi
  alert docker "Docker 没有在运行，浴族服务停了。Mac 上已尝试打开 Docker Desktop；几分钟后仍未恢复请到现场查看。"
  exit 0
fi
resolve docker "Docker 已在运行"

# 2. 应用健康检查
port=$(env_of APP_PORT)
health=$(curl -fsS -m 10 "http://127.0.0.1:${port:-8080}/api/health" 2>/dev/null || true)
maintenance=""
[[ -f .deploy/maintenance ]] && maintenance=$(cat .deploy/maintenance)
if [[ "$health" == *'"ok":true'* ]]; then
  rm -f "$state/health.fails"
  resolve app "应用健康检查恢复正常"
elif [[ -n "$maintenance" ]]; then
  since=${maintenance%% *}
  if [[ $((now - since)) -gt 1800 ]]; then
    alert maintenance "维护（${maintenance#* }）已超过 30 分钟，应用没有通过健康检查，看门狗不会自动重启。请人工确认后删掉 .deploy/maintenance。"
  fi
else
  fails=$(( $(cat "$state/health.fails" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$state/health.fails"
  log "应用健康检查失败（连续 $fails 次）"
  if [[ $fails -ge 3 ]]; then
    rm -f "$state/health.fails"
    if docker compose restart app >/dev/null 2>&1 || docker compose up -d app >/dev/null 2>&1; then
      send "✗ 应用连续 3 次（约 15 分钟）健康检查失败，已自动重启。请留意前台是否恢复；反复出现时联系 Codex。"
    else
      send "✗ 应用连续 3 次健康检查失败，自动重启也失败了。请立即到现场查看，必要时启用纸质单。"
    fi
    echo "$now" > "$state/app.alert"
  fi
fi
[[ -z "$maintenance" ]] && rm -f "$state/maintenance.alert"

# 3. 备份
dir=$(backup_dir)
interval=$(env_of BACKUP_INTERVAL_MINUTES)
interval=${interval:-60}
if ! docker compose ps --status running --services 2>/dev/null | grep -qx backup; then
  if [[ -z "$maintenance" ]]; then
    if docker compose up -d backup >/dev/null 2>&1; then
      alert backup-service "备份服务没有在运行，已自动启动。"
    else
      alert backup-service "备份服务没有在运行，自动启动也失败了：请查看 docker compose logs backup。"
    fi
  fi
else
  resolve backup-service "备份服务已在运行"
fi
if [[ "$(env_of BACKUP_REQUIRE_SENTINEL)" == true && ! -f "$dir/.yuzu-backup-target" ]]; then
  alert sentinel "备份目录 $dir 里没有哨兵文件：外置盘可能没挂载，现在不备份。接好外置盘后执行 docker compose restart backup。"
else
  resolve sentinel "外置盘已挂载"
  # 只看定时备份（hourly、daily）：手动、升级前的备份不能说明定时备份还在正常做
  latest=$(ls -t "$dir"/yuzu-*-hourly.dump "$dir"/yuzu-*-daily.dump 2>/dev/null | head -n 1 || true)
  if [[ -z "$latest" ]]; then
    # 全新安装：备份服务刚启动，还没来得及做第一份；持续两个备份间隔还没有才告警
    [[ -f "$state/nobackup.since" ]] || echo "$now" > "$state/nobackup.since"
    if [[ $((now - $(cat "$state/nobackup.since"))) -gt $(( (interval * 2 + 10) * 60 )) ]]; then
      alert backup-stale "备份目录 $dir 里还没有定时备份。请查看 docker compose logs backup。"
    fi
  else
    rm -f "$state/nobackup.since"
    age=$(( (now - $(mtime_of "$latest")) / 60 ))
    if [[ $age -gt $((interval * 2 + 10)) ]]; then
      alert backup-stale "最新的备份是 $age 分钟前的 $(basename "$latest")（应每 $interval 分钟一份）。请查看 docker compose logs backup。"
    else
      resolve backup-stale "备份恢复正常（最新 $(basename "$latest")）"
    fi
    if [[ -f "$latest.json" ]]; then
      if grep -q '"verified": false' "$latest.json"; then
        alert backup-verify "最新的备份 $(basename "$latest") 在临时库恢复失败，原因见旁边的 .json。请联系 Codex。"
      else
        resolve backup-verify "最新的备份能在临时库恢复"
      fi
      if grep -q '"checks"' "$latest.json" && ! grep -q '"failed": \[\]' "$latest.json"; then
        alert backup-checks "最新的备份 $(basename "$latest") 自检有不一致项（见旁边的 .json），请告知店主与 Codex。"
      else
        resolve backup-checks "备份自检一致"
      fi
    fi
  fi
fi

# 4. 磁盘空间
low=""
for path in "$dir" "$PWD"; do
  [[ -d "$path" ]] || continue
  read -r avail_kb used_pct <<< "$(df -Pk "$path" | awk 'NR==2 {gsub("%", "", $5); print $4, $5}')"
  if [[ -n "$avail_kb" && ( $avail_kb -lt 5242880 || $used_pct -ge 90 ) ]]; then
    low="$low $path（剩 $((avail_kb / 1048576)) GB，已用 $used_pct%）"
  fi
done
if [[ -n "$low" ]]; then
  alert disk "磁盘空间不足：$low。请清理或更换外置盘。"
else
  resolve disk "磁盘空间恢复正常"
fi

# 5. 异地副本：.offsite/last-sent 是已传到服务器的最新一份备份（备份时刻与文件名）
offsite=""
if [[ -n "$(env_of OFFSITE_TARGET)" ]]; then
  sent=$(cat .offsite/last-sent 2>/dev/null || true)
  [[ "${sent%% *}" =~ ^[0-9]+$ ]] || sent=""
  limit=$((interval * 2 + 60))
  if [[ -z "$sent" ]]; then
    # 刚配置：等一个期限再告警
    [[ -f "$state/nooffsite.since" ]] || echo "$now" > "$state/nooffsite.since"
    if [[ $((now - $(cat "$state/nooffsite.since"))) -gt $((limit * 60)) ]]; then
      alert offsite "已配置异地副本，但 $((limit / 60)) 小时内一份备份也没传到 $(env_of OFFSITE_TARGET)，原因见 .offsite/offsite.log。"
    fi
  else
    rm -f "$state/nooffsite.since"
    offsite_age=$(( (now - ${sent%% *}) / 60 ))
    offsite="异地副本 $offsite_age 分钟前"
    if [[ $offsite_age -gt $limit ]]; then
      alert offsite "云服务器上最新的备份副本是 $((offsite_age / 60)) 小时前的 ${sent#* }，异地副本可能传不上去，原因见 .offsite/offsite.log。"
    else
      resolve offsite "异地副本恢复正常（最新 ${sent#* }）"
    fi
  fi
else
  rm -f "$state/nooffsite.since" "$state/offsite.alert"
fi

# 每日巡检：9 点后推一条（每天一次）
today=$(date +%Y-%m-%d)
hour=$(date +%H)
if [[ ${hour#0} -ge 9 && "$(cat "$state/daily" 2>/dev/null)" != "$today" ]]; then
  version=$(printf '%s' "$health" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  commit=$(printf '%s' "$health" | grep -o '"commit":"[0-9a-f]*"' | cut -d'"' -f4)
  [[ -n "$version" ]] && version="v$version${commit:+ · ${commit:0:7}}"
  status="应用$([[ "$health" == *'"ok":true'* ]] && echo 正常 || echo 异常)"
  [[ -n "${latest:-}" ]] && status="$status · 最新备份 $(( (now - $(mtime_of "$latest")) / 60 )) 分钟前"
  free_gb=$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {printf "%d", $4 / 1048576}')
  send "每日巡检：$status${offsite:+ · $offsite} · 备份盘剩 ${free_gb:-?} GB · 版本 ${version:-未知}" && echo "$today" > "$state/daily"
fi
exit 0
