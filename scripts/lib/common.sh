# 运维脚本共用的函数（由 restore.sh、rollback.sh、update.sh、watchdog.sh 用 source 引入，在项目目录里执行）。
# 兼容 macOS 自带的 bash 3.2：不用关联数组、mapfile 等新语法。

# 读 .env 里的一项（最后一次出现的为准，不展开变量）
env_of() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }

# 备份旁 .json 说明里的 64 位十六进制值（sha256、fingerprintDigest）
json_hex() { grep -o "\"$1\": \"[0-9a-f]\{64\}\"" "$2" 2>/dev/null | head -n 1 | grep -o '[0-9a-f]\{64\}' || true; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# 文件修改时间（秒）：Linux 用 stat -c，macOS 用 stat -f
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# 备份目录在宿主机上的路径（.env 的 BACKUP_DIR，相对路径按项目目录算）
backup_dir() {
  local dir
  dir=$(env_of BACKUP_DIR)
  dir=${dir:-./backups}
  case "$dir" in /*) ;; *) dir="$PWD/${dir#./}" ;; esac
  printf '%s\n' "$dir"
}

# 应用镜像名（如 yuzu-app:yuzu-prod），与 compose.yaml 的 APP_IMAGE 规则一致
app_image() {
  docker compose config 2>/dev/null | awk '/^  app:/{f=1;next} f&&/^  [a-z]/{f=0} f&&/^    image:/{print $2; exit}'
}

# 文件摘要与 .json 说明里记下的一致；没有说明（旧版本的备份）时跳过
verify_backup_file() {
  local file=$1 sha actual
  [[ -f "$file.json" ]] || return 0
  sha=$(json_hex sha256 "$file.json")
  [[ -n "$sha" ]] || return 0
  actual=$(sha256_of "$file")
  if [[ "$actual" != "$sha" ]]; then
    echo "✗ 备份文件与备份时的摘要不同（文件在拷贝或保存中被改动）：$file" >&2
    return 1
  fi
  echo "✓ 备份文件摘要与备份时一致"
}

# 停止应用与备份服务，重建数据库并导入备份（不启动应用）
restore_database() {
  local file=$1
  docker compose stop app backup
  docker compose exec -T db psql -U yuzu -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS yuzu WITH (FORCE);" -c "CREATE DATABASE yuzu OWNER yuzu;"
  docker compose exec -T db pg_restore -U yuzu -d yuzu --no-owner --exit-on-error < "$file"
}

# 导入后、启动应用前比对数据指纹（应用启动后会执行迁移、写入登录会话，数据就不再与备份完全相同）
expect_fingerprint() {
  local file=$1 expected
  expected=""
  [[ -f "$file.json" ]] && expected=$(json_hex fingerprintDigest "$file.json")
  if [[ -z "$expected" ]]; then
    echo "· 备份旁没有 .json 说明（旧版备份），跳过指纹比对"
    return 0
  fi
  docker compose run --rm -T --no-deps backup node dist/server/cli.js fingerprint --expect "$expected"
}

# 等应用健康检查通过（最多约 60 秒）
wait_for_app() {
  for _ in $(seq 1 30); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# 维护中（升级、恢复、回退）：看门狗看到 .deploy/maintenance 就不自动重启应用。
# 正常结束时清掉；动过数据库或代码之后中途出错，就留着标记，避免看门狗把应用拉起来接着写半截的库。
begin_maintenance() {
  mkdir -p .deploy
  printf '%s %s\n' "$(date +%s)" "$1" > .deploy/maintenance
  MAINT_DIRTY=false
  trap 'end_maintenance $?' EXIT
}
mark_dirty() { MAINT_DIRTY=true; }
end_maintenance() {
  if [[ "$1" -eq 0 || "${MAINT_DIRTY:-false}" == false ]]; then
    rm -f .deploy/maintenance
    return
  fi
  echo "· 中途出错：维护标记留在 .deploy/maintenance，看门狗不会自动重启应用。处理完（或回退）后删掉这个文件。" >&2
}

# 按 SHA 打的镜像标签只留最近 3 个（当前与上一版一定保留），其余删掉标签释放磁盘；仍被容器使用的删不掉，跳过
prune_sha_tags() {
  local image=$1 keep_a=$2 keep_b=$3 tag sha n=0
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | while read -r tag; do
    case "$tag" in "$image"-*) ;; *) continue ;; esac
    sha=${tag#"$image"-}
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
    n=$((n + 1))
    [[ "$sha" == "$keep_a" || "$sha" == "$keep_b" || $n -le 3 ]] && continue
    docker image rm "$tag" >/dev/null 2>&1 || true
  done
}
