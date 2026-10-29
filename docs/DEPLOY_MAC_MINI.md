# Mac mini 部署手册

目标：办公室 Mac mini 运行浴族服务，门店电脑和平板在同一局域网内用浏览器访问；断电重启后自动恢复；每天自动备份到外置盘，并加密后上传到阿里云 OSS。管理后台只在局域网和 Tailscale 内打开，不对公网做端口转发。

## 1. 准备 Mac mini

1. **系统设置 → 通用 → 共享**：记下电脑名称；**网络** 中记下局域网 IP（如 `192.168.1.20`）。
2. 在路由器后台为 Mac mini 的网卡**绑定固定 IP**（DHCP 保留），避免重启后 IP 变化。
3. **系统设置 → 能源**：开启「停电后自动启动」，关闭「自动进入睡眠」。
4. **系统设置 → 用户与群组**：为运行服务的账户开启**自动登录**（Docker Desktop 需要登录后才启动）。
5. 安装 **Docker Desktop for Mac（Apple 芯片版）** 或 **OrbStack**，并在设置中勾选「登录时启动」。
6. 安装 Git（首次执行 `git` 时系统会提示安装命令行工具）。
7. 接上备份用的外置硬盘，例如挂载在 `/Volumes/YuzuBackup`，新建目录 `/Volumes/YuzuBackup/yuzu`。外置盘在登录后应自动挂载，不要每次都弹出密码框。
8. **路由器不要做端口转发**，不要把 8080 或其他浴族端口映射到公网。店外访问走第 10 节的 Tailscale。
9. **系统设置 → 通用 → 日期与时间**：时区设为上海。备份容器按 `.env` 里的 `APP_TIMEZONE` 在凌晨 4:00 备份，上传任务按 Mac 的系统时区在 05:10 运行，两边需要一致。

> 国内网络拉取 Docker 镜像较慢时：在 Docker Desktop → Settings → Docker Engine 配置镜像加速，或在 `.env` 中设置 `NODE_IMAGE` / `POSTGRES_IMAGE` / `NPM_REGISTRY` 使用国内镜像源（见 `.env.example`）。

## 2. 获取代码并配置

```bash
cd ~
git clone https://github.com/Venture-VV/yuzu.git
cd yuzu
git checkout v0.3.0          # 只部署 main 上的版本标签（git tag 查看最新），不部署开发分支
cp .env.example .env
open -e .env                 # 用文本编辑器修改
```

`.env` 至少修改：

| 变量 | 说明 |
| --- | --- |
| `APP_ENV` | 试用填 `trial`，正式填 `production`（试用、正式环境都禁止写入演示数据） |
| `YUZU_INSTANCE` | 页面常显的实例标识：正式服填 `prod`，影子运行填 `shadow` |
| `POSTGRES_PASSWORD` | 数据库密码，建议用 `openssl rand -hex 24` 生成（只含字母数字，避免连接串转义问题） |
| `INIT_OWNER_USERNAME` / `INIT_OWNER_PASSWORD` | 第一位店主账号，首次登录后必须改密 |
| `BACKUP_DIR` | `/Volumes/YuzuBackup/yuzu` |
| `APP_PORT` | 默认 8080 |

`.env` 含密码，不会也不应提交到 GitHub。OSS 密钥和 age 公钥在做第 9 节时再写入这个文件，启动服务本身不依赖它们。

## 3. 启动

```bash
export YUZU_VERSION=$(git describe --tags --always) YUZU_COMMIT=$(git rev-parse HEAD)   # 页面显示版本与 SHA
docker compose up -d --build
docker compose ps            # app、db 显示 (healthy)，backup 显示 Up
docker compose logs app      # 应看到「已应用迁移」「已创建初始店主账号」「浴族 yuzu 已启动」
```

在门店电脑浏览器访问 `http://192.168.1.20:8080`（换成 Mac mini 的 IP），用初始店主登录并修改密码，然后在「管理」中：

1. 添加店员账号（系统生成临时密码，当面告知）；
2. 录入实际的充值套餐与消费项目；
3. 按确认结果设置扣款顺序和营业日切换时间。

演示数据只写入独立的演示库（`APP_ENV=development`，见第 7 节末尾），试用、正式环境都会拒绝。

## 4. 上线前验证清单

- [ ] 门店电脑、平板都能打开并登录；平板横竖屏布局正常
- [ ] 用合成会员走一遍：充值 100 → 消费 30 → 余额 70 → 店主撤销 → 恢复 100；日结显示「核对一致」
- [ ] `docker compose restart` 后数据仍在；**拔电重启 Mac mini** 后服务自动恢复（等 Docker 启动约 1–2 分钟），菜单栏 Tailscale 自己回到已连接
- [ ] 断开门店外网（拔掉光猫上行），局域网内仍可正常登录、充值、消费
- [ ] 路由器没有端口转发。手机改用蜂窝网络、不连店内 Wi-Fi，访问 `http://<局域网 IP>:8080` 打不开
- [ ] 店主的手机或家里的电脑登录同一个 Tailscale 账号后，用 Tailscale IP 或 MagicDNS 打开 `:8080` 能登录。未加入该网络的设备打不开。没有开启 Tailscale Funnel，也没有公网域名指向管理后台
- [ ] `./scripts/backup.sh` 成功，备份文件出现在外置盘
- [ ] 手动跑一次第 9 节的上传脚本，私有 OSS Bucket 的 `yuzu/` 前缀下出现对应的 `.age` 文件；`git status` 不列出 `.env`
- [ ] 从 OSS 下载这份备份，用店外保管的 age 私钥解密，`pg_restore -l` 能列出内容；在独立演练目录里 `./scripts/restore.sh`，结束时会员 4 项、库存 5 项核对全部 ✓
- [ ] 再用外置盘上的备份在正式环境做一次恢复演练：`./scripts/restore.sh <备份文件>`，结束时核对全部 ✓
- [ ] 清理演示数据：试用结束转正式时，建议使用全新的数据库卷（见下文「环境隔离」）

## 5. 日常运维

| 场景 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f app`、`docker compose logs backup` |
| 重启服务 | `docker compose restart app` |
| 立即备份 | `./scripts/backup.sh` |
| 立即加密并上传到 OSS | `bash "$HOME/Library/Application Support/yuzu/oss-upload.sh"` |
| 查看 OSS 上传日志 | `tail -n 50 "$HOME/Library/Logs/yuzu-oss-upload.log"` |
| 查看 Tailscale 地址 | `tailscale ip -4`（未装命令行入口时见第 10 节） |
| 核对余额与流水、库存结存与库存流水 | `docker compose exec app node dist/server/cli.js check` |
| 店主忘记密码 | `docker compose exec app node dist/server/cli.js reset-password <账号>` |
| 更新版本 | `./scripts/update.sh <版本标签>`（例如 `v0.3.1`；`git fetch --tags && git tag` 查看） |
| 恢复备份 | `./scripts/restore.sh <备份文件>` |

## 6. 环境隔离

- 开发：MacBook Air 上 `compose.dev.yaml` 只跑数据库，应用用 `npm run dev`，数据库为 `yuzu-dev_dev-pgdata` 卷。
- 试用 / 正式：Mac mini 上用 `compose.yaml`，数据保存在 Docker 卷 `yuzu_pgdata` 中。
- 同一台机器同时保留试用和正式环境：

  ```bash
  cp .env .env.trial            # 修改 APP_ENV=trial、APP_PORT=8081、BACKUP_DIR 等
  docker compose --env-file .env.trial -p yuzu-trial up -d --build
  ```

  不同项目名（`-p`）对应不同的数据卷，互不影响。

- **不要**执行 `docker compose down -v`，`-v` 会删除数据库卷。

## 7. 升级到库存与采购版本

库存与采购随应用一起发布，**不需要单独部署**：

1. `./scripts/update.sh <新版本标签>`：先自动备份，启动时增量执行迁移 `002_inventory.sql`、`003_purchasing.sql`（只新增表和列，不改动会员数据）。
2. 升级后原有员工的岗位不变、库存职责为空：前台店员看不到库存；店主拥有全部权限。在「管理 → 员工」为后勤同事新建「后勤人员」账号并勾选职责。
3. 在「管理 → 经营规则 → 库存与采购」确认库存范围、价格口径、哪些单据需要负责人确认。
4. 在「库存 → 档案」建立首批物料与供应商，再由物资经办录入期初盘点、负责人确认。
5. 运行 `check`，会员与库存核对全部 ✓。

**演示数据只放独立的演示库。** 试用 / 正式环境执行 `seed-inventory-demo` 会被拒绝；库里已有任何非演示的物料、供应商或单据时也会拒绝。需要给员工培训时，另起一个演示项目：

```bash
cp .env .env.demo                # 修改 APP_ENV=development、APP_PORT=8082、BACKUP_DIR 指向另一个目录
docker compose --env-file .env.demo -p yuzu-demo up -d
docker compose -p yuzu-demo exec app node dist/server/cli.js seed-demo
docker compose -p yuzu-demo exec app node dist/server/cli.js seed-inventory-demo
```

## 8. 备份策略

- 店内：`backup` 容器每天 4:00 之后把数据库备份到外置盘（`BACKUP_HOUR` 默认 4，每 5 分钟检查一次，一般在 4:00–4:05 开始），保留 30 天。外置盘是最快的恢复来源，继续用。
- 店外：同一批 `yuzu-*.dump` 加密后自动上传到阿里云 OSS 私有 Bucket，代替每周手工拷到网盘。步骤见第 9 节。
- 每月：按第 9 节从 OSS 取回一份，解密后在独立环境做恢复演练。
- 更新版本前：`update.sh` 会先在外置盘写一份备份；下一次上传任务会把它一并加密上传。

## 9. 异地备份：加密后上传阿里云 OSS

「本节由 Grok Bot 补充」

`backup` 容器用的是 `postgres:16-alpine`，只负责 `pg_dump`，备份写到宿主机的 `BACKUP_DIR`。这个容器里没有上传工具，也不放入云账号密钥。上传放在 Mac mini 已登录用户的定时任务里：凌晨备份落盘之后，用 [age](https://github.com/FiloSottile/age) 加密，再用阿里云官方的 [ossutil 2.0](https://help.aliyun.com/zh/oss/developer-reference/ossutil-overview) 传到私有 Bucket。登录用户和 Docker Desktop 是同一套（第 1 节已开自动登录），外置盘也在这个会话里挂载。

age 把公钥留在店里、私钥留在店外。Mac mini 只能加密，不能解密。定时任务无法交互输入口令，所以不用 gpg 对称加密。

### 9.1 在店外生成密钥

在店主自己的电脑上安装 age（与下面 Mac mini 的安装相同），生成密钥对。**不要在 Mac mini 上执行 `age-keygen`**，避免私钥留在店里。

```bash
age-keygen -o ~/yuzu-backup-age.txt
chmod 600 ~/yuzu-backup-age.txt
```

终端会打印一行 `Public key: age1...`。只把这行公钥抄到 Mac mini。私钥文件做两份保管：密码管理器一份，离线副本一份（店外的 U 盘，或打印后收好）。生成用的那台电脑若不是长期保管处，抄走私钥后删掉本地文件。

### 9.2 开通只用于备份的 Bucket 和子账号

用阿里云主账号（或单独的管理员）完成下面几步。上传用的子账号没有创建 Bucket、改权限、删除文件的能力。

1. **OSS 控制台 → 创建 Bucket**。名字全局唯一，只能用小写字母、数字和短横线，例如 `yuzu-backup-example`（换成自己的）。地域选离门店近的，下文示例用华东 1（杭州）`cn-hangzhou`。存储类型用**标准存储**。读写权限保持 **private**。新建 Bucket 默认开启「阻止公共访问」，到 **权限控制 → 阻止公共访问** 确认仍然开着。
2. **数据管理 → 生命周期 → 创建规则**（不要打开「访问跟踪」）。状态选启动；策略选按前缀匹配，前缀填 `yuzu/`（不要写成 `/yuzu`）。文件时间策略选指定天数，**180 天**后数据删除。碎片过期策略选指定天数，**7 天**后删除未完成的分片。规则创建后约 24 小时内加载，之后每天北京时间 8:00 起执行，删除不可恢复。本地外置盘仍只留 30 天；OSS 留得更久，是为了覆盖「一个月后才发现数据坏了」的情况。天数可以按门店需要改。
3. **RAM 控制台 → 创建用户**。这个用户只给 Mac mini 上传备份：访问方式只选「使用永久 AccessKey 访问」，不要开控制台登录。创建 AccessKey 后只显示一次，立刻写入 Mac mini 的 `.env`，不要发到长期保留的聊天记录里。
4. **权限策略 → 创建自定义策略**，把下面的 `yuzu-backup-example` 换成实际 Bucket 名，授给这个 RAM 用户。策略只允许向 `yuzu/` 前缀上传、下载和列举，不允许删文件、删 Bucket、改 ACL。过期删除由生命周期规则执行，不交给这把密钥。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:AbortMultipartUpload"
      ],
      "Resource": [
        "acs:oss:*:*:yuzu-backup-example/yuzu/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:*:yuzu-backup-example"
      ],
      "Condition": {
        "StringLike": {
          "oss:Prefix": [
            "yuzu/",
            "yuzu/*"
          ]
        }
      }
    }
  ]
}
```

若上传或列举返回 `AccessDenied`，错误信息里会写出缺少的 Action。只把该 Action 加进这条策略，资源仍限制在这个 Bucket。不要改成 `oss:*`。

**费用**（不标价，以控制台当前价格为准）：单店数据库的每日备份通常不大。账单主要来自标准存储的容量、上传请求次数，以及演练或故障时下载产生的外网流出流量。保留 180 天时，容量大约是单份备份的 180 倍（加密后体积与原文件接近）。生命周期会删掉过期对象，避免旧文件一直计费。不用归档或冷归档：当天要恢复时，那两类需要先解冻，要多等一段时间，并另有取回费用。标准存储可以马上把文件下载下来。

### 9.3 把配置写进 `.env`

在 Mac mini 的项目目录编辑 `.env`，追加下面几行。值不要加引号，不要有空格。`AGE_RECIPIENT` 只放公钥（`age1` 开头），不要放 `AGE-SECRET-KEY-` 开头的私钥。

```bash
OSS_BUCKET=yuzu-backup-example
OSS_REGION=cn-hangzhou
OSS_ACCESS_KEY_ID=子账号的AccessKeyId
OSS_ACCESS_KEY_SECRET=子账号的AccessKeySecret
AGE_RECIPIENT=age1此处换成店外生成的公钥
```

```bash
chmod 600 .env
git check-ignore -v .env    # 应打印 .gitignore 规则；git status 里不能出现 .env
```

密钥只放在 `.env`。不要执行 `ossutil config` 再存一份到 `~/.ossutilconfig`，也不要把密钥写进定时任务的 plist 或命令行参数（会进进程列表）。ossutil 2.0 读取环境变量 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_REGION`，优先级高于配置文件。店里的 Mac mini 不在阿里云内网，填写地域后走公网地址即可，不要用带 `-internal` 的内网 Endpoint。

### 9.4 在 Mac mini 上安装 ossutil 和 age

安装包版本以官方页面为准。下面 ossutil 的链接和校验和是撰写时文档中的 **2.4.1 / Apple 芯片**。若链接失效，打开 [ossutil 2.0 概述](https://help.aliyun.com/zh/oss/developer-reference/ossutil-overview) 换成表格里的当前版本。不要用已经停止更新的 ossutil 1.0 安装脚本。Intel Mac 把文件名中的 `mac-arm64` 换成 `mac-amd64`，并改用该页对应的校验和。

```bash
cd /tmp
curl -fL -o ossutil-2.4.1-mac-arm64.zip \
  https://gosspublic.alicdn.com/ossutil/v2/2.4.1/ossutil-2.4.1-mac-arm64.zip
shasum -a 256 ossutil-2.4.1-mac-arm64.zip
# 撰写时 arm64 包为 8ef710374d051817fe4483a34bf9fcdc26c1decb62dd69573f5e40d1485b45c1
unzip ossutil-2.4.1-mac-arm64.zip
chmod 755 ossutil-2.4.1-mac-arm64/ossutil
sudo mkdir -p /usr/local/bin
sudo mv ossutil-2.4.1-mac-arm64/ossutil /usr/local/bin/ossutil
ossutil
```

官方步骤里还有 `sudo ln -s /usr/local/bin/ossutil /usr/bin/ossutil`。当前 macOS 的系统完整性保护不允许写入 `/usr/bin`，这条会失败。`/usr/local/bin` 已在终端的 PATH 里，定时任务里写绝对路径，不需要那条软链接。

age 使用官方预编译包（撰写时为 v1.3.2；说明见 [age 的 README](https://github.com/FiloSottile/age)）。Intel Mac 把 `darwin/arm64` 换成 `darwin/amd64`。

```bash
cd /tmp
curl -fL -o age.tar.gz "https://dl.filippo.io/age/v1.3.2?for=darwin/arm64"
tar -xzf age.tar.gz
sudo cp age/age age/age-keygen /usr/local/bin/
sudo chmod 755 /usr/local/bin/age /usr/local/bin/age-keygen
age --version
```

已安装 Homebrew 时，`brew install age` 也可以。Apple 芯片上它通常在 `/opt/homebrew/bin/age`。下一节脚本开头的路径要改成 `which age` 的结果。

### 9.5 上传脚本

脚本放在仓库外面，避免和业务代码混在一起，也避免被人误提交。它只处理外置盘上已经写完的 `yuzu-*.dump`（容器先写临时文件再改名，看到 `.dump` 就是完整备份），加密到临时目录，上传成功后记下标记，下次跳过。上传失败不会写标记，下次会重试。

```bash
mkdir -p "$HOME/Library/Application Support/yuzu"
cat > "$HOME/Library/Application Support/yuzu/oss-upload.sh" <<'SCRIPT'
#!/bin/bash
# 加密外置盘上的新备份并上传到 OSS。由登录用户的 launchd 在每天 05:10 和每次登录时调用。
set -euo pipefail
umask 077

YUZU_DIR="${YUZU_DIR:-$HOME/yuzu}"
ENV_FILE="$YUZU_DIR/.env"
OSSUTIL="${OSSUTIL:-/usr/local/bin/ossutil}"
AGE="${AGE:-/usr/local/bin/age}"
STATE_DIR="$HOME/Library/Application Support/yuzu/oss-state"
LOG_PREFIX="[oss-backup]"

get_env() {
  key="$1"
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
  if [ -z "$line" ]; then
    echo "$LOG_PREFIX 缺少 $key（写在 $ENV_FILE，不要提交到 Git）" >&2
    exit 1
  fi
  printf '%s' "${line#*=}"
}

if [ ! -f "$ENV_FILE" ]; then
  echo "$LOG_PREFIX 找不到 $ENV_FILE" >&2
  exit 1
fi
if [ ! -x "$AGE" ] || [ ! -x "$OSSUTIL" ]; then
  echo "$LOG_PREFIX 找不到 $AGE 或 $OSSUTIL" >&2
  exit 1
fi

BACKUP_DIR=$(get_env BACKUP_DIR)
OSS_BUCKET=$(get_env OSS_BUCKET)
OSS_REGION=$(get_env OSS_REGION)
OSS_ACCESS_KEY_ID=$(get_env OSS_ACCESS_KEY_ID)
OSS_ACCESS_KEY_SECRET=$(get_env OSS_ACCESS_KEY_SECRET)
AGE_RECIPIENT=$(get_env AGE_RECIPIENT)
export OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_REGION

case "$AGE_RECIPIENT" in
  AGE-SECRET-KEY-*)
    echo "$LOG_PREFIX AGE_RECIPIENT 必须是公钥（age1 开头），不能是私钥" >&2
    exit 1
    ;;
esac

if [ ! -d "$BACKUP_DIR" ]; then
  echo "$LOG_PREFIX 备份目录不存在（外置盘是否已挂载）：$BACKUP_DIR" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

uploaded=0
shopt -s nullglob
for dump in "$BACKUP_DIR"/yuzu-*.dump; do
  base=$(basename "$dump")
  if [ -f "$STATE_DIR/$base.ok" ]; then
    continue
  fi
  "$AGE" -r "$AGE_RECIPIENT" -o "$workdir/$base.age" "$dump"
  "$OSSUTIL" cp "$workdir/$base.age" "oss://${OSS_BUCKET}/yuzu/${base}.age" --region "$OSS_REGION"
  date '+%Y-%m-%d %H:%M:%S' > "$STATE_DIR/$base.ok"
  echo "$LOG_PREFIX 已上传 yuzu/${base}.age"
  uploaded=$((uploaded + 1))
done

echo "$LOG_PREFIX 完成，本次新上传 ${uploaded} 个文件"
SCRIPT
chmod 700 "$HOME/Library/Application Support/yuzu/oss-upload.sh"
```

代码若不在 `~/yuzu`，打开这个脚本，把 `YUZU_DIR` 的默认目录改成实际路径。外置盘目录仍以 `.env` 里的 `BACKUP_DIR` 为准。

先手工跑一次。脚本打印「已上传」后，用主账号打开 OSS 控制台，进入该 Bucket 的 `yuzu/` 目录，应看到 `.age` 文件。也可以在项目目录用命令行核对（只把这四行读进环境变量，用完清掉密钥）：

```bash
cd ~/yuzu
bash "$HOME/Library/Application Support/yuzu/oss-upload.sh"
set -a
source <(grep -E '^(OSS_BUCKET|OSS_REGION|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET)=' .env)
set +a
ossutil ls "oss://${OSS_BUCKET}/yuzu/" --region "$OSS_REGION"
unset OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
```

`.env` 里这四行不要有空格或引号。列举结果里应有 `yuzu-日期时间.dump.age`。

### 9.6 每天 05:10 自动上传

备份在 4:00 之后几分钟内落盘。上传定在 **05:10**（系统时区）。Mac 若当时关机，这次不会补跑；下次登录时会再跑一遍（脚本会补传还没上传的文件），所以第 1 节的自动登录要保持开启。

```bash
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$HOME/Library/LaunchAgents/com.yuzu.oss-backup.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yuzu.oss-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${HOME}/Library/Application Support/yuzu/oss-upload.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>5</integer>
    <key>Minute</key>
    <integer>10</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/yuzu-oss-upload.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/yuzu-oss-upload.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.yuzu.oss-backup" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.yuzu.oss-backup.plist"
launchctl enable "gui/$(id -u)/com.yuzu.oss-backup"
launchctl kickstart -k "gui/$(id -u)/com.yuzu.oss-backup"
tail -n 20 "$HOME/Library/Logs/yuzu-oss-upload.log"
```

改过脚本或 plist 之后，重新执行上面的 `bootout`、`bootstrap`、`enable`。日志里应看到「完成」；没有新备份时，新上传个数为 0。

### 9.7 从 OSS 做恢复演练

每月做一次。解密只能用店外保管的私钥。下载的文件放在仓库目录外面。完整恢复不要在正式环境的 `~/yuzu` 里做：`restore.sh` 会清空它当前连着的数据库。

1. 在演练电脑上安装与第 9.4 节相同的 ossutil、age。私钥副本放到 `~/yuzu-restore/age.txt`，`chmod 600`。四行 OSS 变量写到 `~/yuzu-restore/oss.env`（`KEY=value`，不要引号），这个目录不要放进任何 Git 仓库。
2. 下载并解密。对象名换成列举结果里的文件名：

```bash
mkdir -p "$HOME/yuzu-restore"
cd "$HOME/yuzu-restore"
set -a
source ./oss.env
set +a
ossutil ls "oss://${OSS_BUCKET}/yuzu/" --region "$OSS_REGION"
ossutil cp "oss://${OSS_BUCKET}/yuzu/yuzu-20261026-040512.dump.age" ./restore.age --region "$OSS_REGION"
age -d -i ./age.txt -o ./restore.dump ./restore.age
unset OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
```

3. 完整恢复用另一个检出目录，让数据卷和正式环境分开。同一台 Mac 上时端口和备份目录也要错开。先确认备份可读（只列出内容，不改数据库），再执行恢复：

```bash
git clone https://github.com/Venture-VV/yuzu.git ~/yuzu-drill
cd ~/yuzu-drill
git checkout v0.3.0          # 与备份来源环境相同的版本标签
cp .env.example .env
# 编辑 .env：另一组 POSTGRES_PASSWORD，APP_PORT=8082，BACKUP_DIR 指向演练专用目录
docker compose up -d --build
docker compose exec -T db pg_restore -l < "$HOME/yuzu-restore/restore.dump" | head
./scripts/restore.sh "$HOME/yuzu-restore/restore.dump"
```

按提示输入 `RESTORE`。结束时应看到会员与库存核对全部 ✓。`docker compose ps` 的项目名应是 `yuzu-drill`。

4. 演练结束，删掉这台电脑上的明文、密文和私钥副本。离线保管的那份私钥留下。

```bash
rm -f "$HOME/yuzu-restore/restore.dump" "$HOME/yuzu-restore/restore.age" "$HOME/yuzu-restore/age.txt"
```

外置盘还在时，日常恢复仍优先用盘上的未加密 `.dump` 和 `./scripts/restore.sh`。OSS 这一路用于外置盘和 Mac mini 一起不可用的时候（失窃、火灾、磁盘损坏）。

## 10. 远程访问（Tailscale）

「本节由 Grok Bot 补充」

店外打开管理后台时，走 Tailscale，不走路由器端口转发。Mac mini 和店主的手机、家里的电脑加入同一个 tailnet 之后，用 Tailscale 分配的地址访问原来的 **8080** 端口。隧道本身是加密的，页面仍用 `http://`，不必为远程访问另配证书。

管理后台仍然没有公网入口：不要在路由器上转发 8080，不要给浴族绑公网域名，不要开启 [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)（Funnel 会把端口公布到公网上）。

### 10.1 安装并在重启后自动连上

客户端需要 macOS Monterey 12 或更新系统。Mac mini 安装 [独立版安装包](https://tailscale.com/download/macos)（Standalone，`.pkg`），不要装 Mac App Store 版。官方说明见 [在 macOS 上安装 Tailscale](https://tailscale.com/docs/install/mac)。两种图形版不要装在同一台机器上。

1. 打开安装包，按向导允许安装 VPN 配置。
2. **macOS Sequoia 15 及更新**：**系统设置 → 通用 → 登录项与扩展**，滑到「网络扩展」，打开 Tailscale 的开关，用 Touch ID 或管理员密码确认。若再问是否安装 VPN 配置，选允许。
3. **macOS Sonoma 14 及更早**：**系统设置 → 隐私与安全性**，在「已阻止系统软件 Tailscale.app」旁点允许，再允许 VPN 配置。
4. 用菜单栏的 Tailscale 图标登录。店主使用自己的 Apple、Google 或微软账号，并在该账号上打开两步验证。Tailscale 直接使用身份提供商的验证，没有另一套密码。说明见 [多因素认证](https://tailscale.com/docs/multifactor-auth)。
5. 菜单栏图标里确认 **Start on Login**（登录时启动）已勾选。首次打开时 Tailscale 会安装登录辅助程序，之后每次这个用户登录都会自己连上。独立版不能在出现登录窗口之前运行，因此第 1 节的自动登录要保持开启。拔电重启后，等自动登录完成，菜单栏应回到已连接，无需人在店里再点一次。
6. 店主的手机用官方应用商店安装 Tailscale，家里的电脑同样安装独立版或对应系统的客户端，登录**同一个账号**。不要把登录二维码转给无关的人。店员平板继续用店内局域网，不必安装 Tailscale。

建议在管理后台的 **Device management** 页面打开设备审批（Device approval，说明见 [设备审批](https://tailscale.com/kb/1099/device-approval/)）。打开之后，新设备要在 **Machines** 页面批准才能通信；已经在网上的设备一般不用重新批准。

查看地址。Ventura 13 及更新系统可以在 Tailscale 的 Settings → CLI integration 里安装命令行入口，之后直接执行 `tailscale ip -4`。任何版本都可以用应用自带的命令：

```bash
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

第一行是 `100.` 开头的地址。`status` 里能看到本机的 MagicDNS 名字。

### 10.2 只用 Tailscale 地址访问 8080

2022-10-20 之后创建的 tailnet 默认开启 MagicDNS（管理后台 **DNS** 页可以核对）。店主的浏览器访问：

- `http://<100 开头的 IP>:8080`
- 或 `http://<MagicDNS 短名>:8080`（`status` 里的机器名；不行时用完整的 `名字.tailnet.ts.net`）

这和店内 `http://192.168.1.20:8080` 是同一个服务。`compose.yaml` 把 8080 发布在宿主机上，Tailscale 网卡上的地址也能进到同一端口。macOS 防火墙若询问 Docker 或 Tailscale 的入站连接，选择允许。

### 10.3 收紧访问权限

新建 tailnet 的默认策略通常是成员之间所有端口互通。grant 是叠加放行的：在默认规则旁边再加一条更窄的规则，并不会收紧权限。打开管理后台 **Access controls**，用下面的策略替换整个文件（登录邮箱换成店主的；若文件里有允许 `funnel` 的 `nodeAttrs`，不要保留）。

```json
{
  "tagOwners": {
    "tag:yuzu-mini": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["owner@example.com"],
      "dst": ["tag:yuzu-mini"],
      "ip": ["tcp:8080"]
    }
  ]
}
```

保存后，到 **Machines** 页面给 Mac mini 加上标签 `tag:yuzu-mini`。策略刚保存、标签还没打上的那一小段时间，Tailscale 上会暂时谁都连不上这台 Mac mini；店内局域网不受影响。加上标签之后，只允许上面这个账号的设备访问 TCP 8080。其他端口、其他人的设备都不通。语法说明见 [Grants](https://tailscale.com/docs/reference/syntax/grants)。

改完后用店主的手机（连上 Tailscale、不连店内 Wi-Fi）打开 `http://<Tailscale IP>:8080` 应能登录。同一台手机断开 Tailscale、只用蜂窝网络时，局域网 IP 和 Tailscale IP 都应打不开。店内 Wi-Fi 上的电脑仍然用局域网 IP 访问。

## 11. 未来扩展（二期）

「本节由 Grok Bot 补充」

美团、抖音、企业微信的回调需要一个公网 HTTPS 地址。到那一步时，再增加一台小型阿里云服务器，只做回调的接收和转发；浴族仍跑在店里的 Mac mini 上。

- 服务器在中国内地时，域名要先完成 **ICP 备案**。备案完成前，不要把域名解析到这台服务器对外提供网页或接口。
- 这台服务器加入第 10 节的同一个 Tailscale 网络。它收到回调后，通过 Tailscale 转发给 Mac mini。不要把 Mac mini 的 8080 映射到公网，也不要在云服务器上开放管理后台。
- 安全组对公网只放行 HTTPS 443。登录这台服务器走 Tailscale，不要把 22 端口对所有地址开放。
- 管理后台的访问方式保持不变：店内走局域网，店外走 Tailscale，都不经过这台公网服务器。

