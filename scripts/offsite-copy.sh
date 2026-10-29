#!/usr/bin/env bash
# 备份的异地副本（R1.4）：把外置盘上新的备份用 age 公钥加密，经 Tailscale 用 SFTP 传到云服务器 A，服务器上只有密文。
# 在宿主机上每 15 分钟运行一次（Mac mini 用 launchd，Linux 用 cron），见 Mac mini 部署手册第 9.8 节：
#   · 只传最近 OFFSITE_KEEP_DAYS 天（默认 7）里还没传过的 yuzu-*.dump（连同旁边的 .json），新的先传；
#   · 先传成 .part 再改名，服务器上看到的 .age 都是传完整的；传成功的在 .offsite/sent/ 记一笔，失败的下次重试；
#   · 服务器上已经有的（本机记录丢了，例如重新检出）不再重传；
#   · 这把钥匙在服务器上只能往备份目录里写、不能删，过期清理由服务器自己的定时任务做。
# .env：OFFSITE_TARGET（如 yuzubackup@yuzu-test，走 Tailscale）、AGE_RECIPIENT（age 公钥，与 OSS 上传共用）；
# 可选 OFFSITE_SSH_KEY（默认 ~/.ssh/yuzu_offsite）、OFFSITE_PORT（默认 22）、OFFSITE_KEEP_DAYS（默认 7）。
# 记录在 .offsite/offsite.log；已传到服务器的最新一份备份（时刻与文件名）写在 .offsite/last-sent，看门狗据此告警。
# --check：只检查配置，并往服务器上传一个小的测试文件。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
source scripts/lib/common.sh
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

state=.offsite
mkdir -p "$state/sent"
log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$state/offsite.log"
  [[ -t 1 ]] && printf '%s\n' "$*"
  return 0
}
die() {
  log "✗ $*"
  exit 1
}
if [[ -f "$state/offsite.log" && $(wc -c < "$state/offsite.log") -gt 1048576 ]]; then mv -f "$state/offsite.log" "$state/offsite.log.1"; fi

target=$(env_of OFFSITE_TARGET)
if [[ -z "$target" ]]; then
  [[ -t 1 ]] && echo "· .env 里没有 OFFSITE_TARGET，不做异地副本"
  exit 0
fi

# 同一时刻只跑一个（传得慢时下一次定时任务直接退出；上一次卡住超过 1 小时就当作已结束）
if ! mkdir "$state/lock" 2>/dev/null; then
  [[ $(( $(date +%s) - $(mtime_of "$state/lock") )) -lt 3600 ]] && exit 0
  rm -rf "$state/lock" && mkdir "$state/lock"
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/yuzu-offsite.XXXXXX")
trap 'rm -rf "$tmp" "$state/lock"' EXIT

recipient=$(env_of AGE_RECIPIENT)
case "$recipient" in
  age1*) ;;
  *) die "AGE_RECIPIENT 应是 age 公钥（age1 开头），写在 .env；私钥不能放在店里" ;;
esac
command -v age >/dev/null 2>&1 || die "找不到 age（安装见 Mac mini 部署手册 9.4）"
command -v sftp >/dev/null 2>&1 || die "找不到 sftp"
key=$(env_of OFFSITE_SSH_KEY)
key=${key:-$HOME/.ssh/yuzu_offsite}
case "$key" in \~/*) key="$HOME/${key#\~/}" ;; esac
[[ -f "$key" ]] || die "找不到 SSH 私钥 $key（生成见 Mac mini 部署手册 9.8）"
port=$(env_of OFFSITE_PORT)
port=${port:-22}
keep=$(env_of OFFSITE_KEEP_DAYS)
keep=${keep:-7}
[[ "$keep" =~ ^[0-9]+$ && "$keep" -ge 1 ]] || die "OFFSITE_KEEP_DAYS 应为天数（默认 7）"

# 批处理命令从标准输入读；第一次连接时记下服务器的主机密钥，之后密钥变了就拒绝连接
sftp_batch() {
  sftp -b - -i "$key" -P "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new "$target"
}
# sftp 的出错信息（去掉回显的批处理命令），例如「ssh: connect to host … Connection refused | Connection closed」
last_error() { tr -d '\r' < "$tmp/sftp.err" 2>/dev/null | grep -v '^sftp>' | awk 'NF' | tail -n 3 | awk '{ printf "%s%s", (NR > 1 ? " | " : ""), $0 }'; }

if [[ "${1:-}" == "--check" ]]; then
  probe="yuzu-offsite-check-$(date +%Y%m%d-%H%M%S).txt"
  echo "浴族异地副本连通测试 $(date '+%Y-%m-%d %H:%M:%S')" > "$tmp/$probe"
  if printf 'put "%s" "%s"\nls -l "%s"\n' "$tmp/$probe" "$probe" "$probe" | sftp_batch > /dev/null 2> "$tmp/sftp.err"; then
    log "✓ 能连上 $target，备份目录可写（测试文件 $probe 由服务器的定时清理删掉）"
    exit 0
  fi
  die "连不上 $target 或目录不可写：$(last_error)"
fi

dir=$(backup_dir)
if [[ "$(env_of BACKUP_REQUIRE_SENTINEL)" == true && ! -f "$dir/.yuzu-backup-target" ]]; then
  die "备份目录 $dir 里没有哨兵文件（外置盘没挂载？），这次不传"
fi
[[ -d "$dir" ]] || die "备份目录不存在：$dir"

# 服务器上已有的副本
if ! printf 'ls -1\n' | sftp_batch > "$tmp/remote" 2> "$tmp/sftp.err"; then
  die "连不上 $target：$(last_error)"
fi

now=$(date +%s)
cutoff=$((now - keep * 86400))
# 已传到服务器的最新一份备份：只往后推，不往回改
mark_sent() {
  local base=$1 mt=$2 last
  date +%s > "$state/sent/$base"
  last=$(cut -d' ' -f1 "$state/last-sent" 2>/dev/null || true)
  [[ "$mt" -gt "${last:-0}" ]] && printf '%s %s\n' "$mt" "$base" > "$state/last-sent"
  return 0
}

sent=0
failed=0
# 备份文件名以备份时刻开头（yuzu-日期-时刻-类别.dump），按名字倒着传，新的在前
shopt -s nullglob
dumps=("$dir"/yuzu-*.dump)
for ((i = ${#dumps[@]} - 1; i >= 0; i--)); do
  dump=${dumps[$i]}
  base=$(basename "$dump")
  [[ -f "$state/sent/$base" ]] && continue
  mt=$(mtime_of "$dump")
  [[ "$mt" -lt "$cutoff" ]] && continue
  if grep -qx "$base.age" "$tmp/remote"; then
    mark_sent "$base" "$mt"
    continue
  fi
  if ! age -r "$recipient" -o "$tmp/$base.age" "$dump"; then
    log "✗ 加密失败：$base"
    failed=$((failed + 1))
    continue
  fi
  if [[ -f "$dump.json" ]] && ! age -r "$recipient" -o "$tmp/$base.json.age" "$dump.json"; then
    log "✗ 加密失败：$base.json"
    failed=$((failed + 1))
    continue
  fi
  # .json（文件摘要与数据指纹）先传，看到 .dump.age 时说明两份都齐了
  if {
    [[ -f "$tmp/$base.json.age" ]] && printf 'put "%s" "%s"\nrename "%s" "%s"\n' "$tmp/$base.json.age" "$base.json.age.part" "$base.json.age.part" "$base.json.age"
    printf 'put "%s" "%s"\nrename "%s" "%s"\n' "$tmp/$base.age" "$base.age.part" "$base.age.part" "$base.age"
  } | sftp_batch > /dev/null 2> "$tmp/sftp.err"; then
    mark_sent "$base" "$mt"
    sent=$((sent + 1))
    log "已传 $base（加密后 $(wc -c < "$tmp/$base.age" | tr -d ' ') 字节）"
  else
    log "✗ 传 $base 失败：$(last_error)"
    failed=$((failed + 1))
  fi
  rm -f "$tmp/$base.age" "$tmp/$base.json.age"
done

# 本机的记录只留到服务器上的副本过期之后
find "$state/sent" -type f -mtime +$((keep + 2)) -exec rm -f {} + 2>/dev/null
if [[ $sent -gt 0 || $failed -gt 0 ]]; then
  log "完成：新传 $sent 份，失败 $failed 份"
elif [[ -t 1 ]]; then
  echo "· 没有要传的新备份（最新已传：$(cut -d' ' -f2 "$state/last-sent" 2>/dev/null || echo 无)）"
fi
[[ $failed -eq 0 ]]
