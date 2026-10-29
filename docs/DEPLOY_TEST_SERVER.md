# 测试服部署手册（阿里云深圳）

目标：在云服务器上跑两套互不相干的环境，只能经 Tailscale 访问。

- **演练库**（主用，端口 8080）：装真实的 747 个柜号和汤崎价目表，给店主和员工按真实业务演练、培训上岗。
- **演示库**（端口 8082）：装四套演示数据，给 Codex 冒烟、截图沟通用。

测试服**不是正式账**：不记真实业务，不导入真实会员余额。正式服在门店 Mac mini 上，见 [Mac mini 部署手册](DEPLOY_MAC_MINI.md)；整体安排见 [ROADMAP](ROADMAP.md) 第 6 节。

| 项 | 演练库 `~/yuzu-test` | 演示库 `~/yuzu-demo` |
| --- | --- | --- |
| `APP_ENV` | `production`（拒绝一切演示数据命令，行为与正式服一致） | `development` |
| `YUZU_INSTANCE` | `test`：页面显示「测试服·不作数」 | `demo`：页面显示「演示·不作数」 |
| 端口 | 8080 | 8082 |
| 数据 | 真实柜号、价目表、票种；员工测试账号 | 四套演示数据（登录页显示演示账号密码） |
| 更新 | 只在店主约定的窗口，演练中途不更新 | 随时，可跟随 `main` 的最新版本 |

**红线**：

- 演练库上不执行任何 `seed-*` 命令，也不执行 `import-opening`（真实会员余额只在正式服导入）。
- 两套都不开公网端口，只经 Tailscale 访问。演示库的登录页会显示演示账号密码，开了公网等于谁都能登录。
- 只部署 `main` 上的版本标签或完整 SHA，不部署开发分支。
- 演练库的员工密码不要和正式服相同。

## 1. 准备云服务器

1. 阿里云 ECS，地域华南 1（深圳），Ubuntu 22.04 或 24.04（x86_64），2 vCPU / 4 GB / 40 GB 以上，分配公网 IP。没有已备案的域名也没关系：不开 80 / 443、不绑域名，就不涉及 ICP 备案。
2. 初次登录用控制台的「远程连接」，或者临时只放行你自己的公网 IP 访问 22 端口；第 4 节装好 Tailscale 后删掉这条规则。
3. 建一个日常用的普通用户（下面以 `yuzu` 为例），加入 `docker` 组；之后都用这个用户操作，不用 root 跑服务。

## 2. 安装 Docker（国内源）

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker yuzu      # 重新登录后生效
```

基础镜像和 npm 包从国内源拉，写在第 5 节的 `.env` 里（`NODE_IMAGE`、`POSTGRES_IMAGE`、`NPM_REGISTRY`、`ALPINE_MIRROR`）。某个源拉不下来时换成能用的国内镜像地址；也可以在阿里云「容器镜像服务 → 镜像加速器」取得地址，写进 `/etc/docker/daemon.json` 的 `registry-mirrors` 后执行 `sudo systemctl restart docker`。

## 3. 拉取代码（私有仓库，用只读部署密钥）

仓库是私有的。在服务器上生成一把只给这台机器用的密钥，作为只读的部署密钥加到仓库：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/yuzu_deploy -N "" -C "yuzu-test-server"
cat ~/.ssh/yuzu_deploy.pub
```

GitHub 仓库 → Settings → Deploy keys → Add deploy key，粘贴上面的公钥，**不要**勾选 Allow write access。国内连 GitHub 的 22 端口常不稳定，改走 443：

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/yuzu_deploy
EOF
git clone git@github.com:Venture-VV/yuzu.git ~/yuzu-test
git clone git@github.com:Venture-VV/yuzu.git ~/yuzu-demo
```

## 4. 安装 Tailscale，收紧安全组

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=yuzu-test
```

按屏幕上的链接，用店主的 Tailscale 账号登录。之后在 Tailscale 管理后台：

1. **Machines**：给这台服务器加标签 `tag:yuzu-test`。
2. **Device management**：打开设备审批，新设备要批准才能通信。
3. **Access controls**：用下面的策略替换整个文件（登录邮箱换成店主的）。它同时包含以后门店 Mac mini 的规则，按 Mac mini 手册设置过的，也用这一份替换。

```json
{
  "tagOwners": {
    "tag:yuzu-test": ["autogroup:admin"],
    "tag:yuzu-mini": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["owner@example.com"], "dst": ["tag:yuzu-test"], "ip": ["tcp:8080", "tcp:8082", "tcp:22"] },
    { "src": ["owner@example.com"], "dst": ["tag:yuzu-mini"], "ip": ["tcp:8080"] }
  ]
}
```

要接入测试服的设备：店主的手机和电脑、Codex 所在的 Mac、门店那 1 台前台电脑和 1 台 iPad。它们都装 Tailscale，并用店主的账号登录。

最后改阿里云**安全组入方向**：

- 删掉 22、80、443、3389、8080、8082 等全部放行规则；
- 只留一条 UDP 41641（来源 `0.0.0.0/0`），让设备与服务器尽量直连，直连不上时 Tailscale 会走海外中继，速度会慢；
- 出方向保持默认。

之后 SSH 改用 Tailscale 地址：`ssh yuzu@yuzu-test`。

Docker 发布的端口会绕过主机上的 ufw 防火墙，所以挡住公网要靠云安全组，不能只靠 ufw。

## 5. 配置两套环境

两个目录各有自己的 `.env`（含密码，不进 Git）。数据库密码用 `openssl rand -hex 24` 生成，两套不同。

`~/yuzu-test/.env`（演练库）：

```bash
COMPOSE_PROJECT_NAME=yuzu-test
APP_ENV=production
YUZU_INSTANCE=test
APP_PORT=8080
POSTGRES_PASSWORD=<随机值>
INIT_OWNER_USERNAME=<店主账号>
INIT_OWNER_PASSWORD=<临时密码，至少 8 位，含字母和数字；首次登录后要改>
INIT_OWNER_NAME=店主
APP_TIMEZONE=Asia/Shanghai
BACKUP_DIR=/home/yuzu/yuzu-backups/test
NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
POSTGRES_IMAGE=docker.m.daocloud.io/library/postgres:16-alpine
NPM_REGISTRY=https://registry.npmmirror.com
ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
WECOM_WEBHOOK_URL=<测试服告警群的机器人地址，不要和正式服用同一个群>
```

备份写在本机硬盘（`BACKUP_DIR`），不需要外置盘的哨兵文件。v0.3.3 起备份服务每小时备份一次，每份都在临时库里试恢复、自检并记下数据指纹；hourly 保留 48 小时，daily 等保留 30 天。

`~/yuzu-demo/.env`（演示库）：在上面的基础上改 `COMPOSE_PROJECT_NAME=yuzu-demo`、`APP_ENV=development`、`YUZU_INSTANCE=demo`、`APP_PORT=8082`、`POSTGRES_PASSWORD` 换一个，`BACKUP_DIR=/home/yuzu/yuzu-backups/demo`。`INIT_OWNER_*` 可以不填，演示数据会建好演示账号。

## 6. 首次启动

用 `main` 上最新的版本标签，至少 `v0.3.3`（从这一版起页面显示实例标识与 SHA、每小时备份并核验、可以打印、有看门狗）。`git tag --sort=-creatordate | head -3` 查看。

```bash
cd ~/yuzu-test
git checkout v0.3.3          # 换成 main 上最新的版本标签
export YUZU_VERSION=$(git describe --tags --always) YUZU_COMMIT=$(git rev-parse HEAD)
docker compose up -d --build
docker compose ps            # app、db 显示 (healthy)，backup 显示 Up
```

第一次构建要下载基础镜像和依赖，几分钟到十几分钟不等。演示库同样执行一遍（目录换成 `~/yuzu-demo`）。

**演练库装真实主数据**（先预览，确认无误再加 `--apply`）：

```bash
cd ~/yuzu-test
docker compose exec app node dist/server/cli.js import-hand-tags --store-list
docker compose exec app node dist/server/cli.js import-hand-tags --store-list --apply
docker compose exec app node dist/server/cli.js import-price-list --tangqi
docker compose exec app node dist/server/cli.js import-price-list --tangqi --apply
docker compose exec app node dist/server/cli.js check
```

然后用店主账号登录 `http://yuzu-test:8080`，修改初始密码，并在「管理」里：

- 核对门票票种与票价（「套餐与项目 → 门票」）；
- 把跳档宽限改成 15 分钟（「手牌 → 前台规则」；R1.2 发布后会自动改）；
- 给员工建测试账号（「员工」）。

**演示库写入演示数据**：

```bash
cd ~/yuzu-demo
for c in seed-demo seed-inventory-demo seed-frontdesk-demo seed-billing-demo; do
  docker compose exec app node dist/server/cli.js "$c"
done
docker compose exec app node dist/server/cli.js check
```

**看门狗**（v0.3.3 起，只给演练库装）：每 5 分钟检查应用健康（连续 3 次失败自动重启）、备份新鲜度与核验结果、磁盘空间，异常推到 `WECOM_WEBHOOK_URL` 的企业微信群，说明见 [Mac mini 部署手册](DEPLOY_MAC_MINI.md) 第 3.2 节。先 `./scripts/watchdog.sh --test` 确认群里收到测试消息，再加定时任务（`crontab -e`）：

```bash
*/5 * * * * cd /home/yuzu/yuzu-test && ./scripts/watchdog.sh >/dev/null 2>&1
```

## 7. 验证清单

- [ ] 在加入 tailnet 的设备上，`http://yuzu-test:8080`（演练库）和 `http://yuzu-test:8082`（演示库）都能登录。MagicDNS 短名不行时，用 `100.` 开头的 Tailscale 地址。
- [ ] 导航栏底部分别显示「测试服 / 不作数」和「演示 / 不作数」，下面是版本号与 7 位 SHA；登录页也显示同样的标识和版本。
- [ ] 演练库登录页不显示演示账号；演示库登录页显示。
- [ ] 演练库：`check` 全部 ✓；前台状态板有 747 个柜号，价目表 29 个项目。
- [ ] 演示库：`check` 全部 ✓。
- [ ] 演练库（v0.3.3 起）：`docker compose logs backup` 里有「✓ yuzu-…-daily.dump（…自检 N/N）」；`./scripts/verify-backup.sh <最新的备份文件>` 最后一行是「✓ 备份可以恢复，内容与备份时一致」。
- [ ] 线下演练前（v0.3.3 起）：前台电脑按 [Mac mini 部署手册](DEPLOY_MAC_MINI.md) 第 3.1 节设好 80mm 热敏机，在演示库打一张结账单和一张交班表，小票顶部印着「演示·不作数」。
- [ ] 手机断开 Tailscale、只用蜂窝网络时，`http://<公网 IP>:8080`、`:8082` 都打不开，`ssh` 到公网 IP 也连不上。

## 8. 日常更新

| 场景 | 命令 |
| --- | --- |
| 更新演示库（随时） | `cd ~/yuzu-demo && ./scripts/update.sh <版本标签>` |
| 更新演练库（只在店主约定的窗口） | `cd ~/yuzu-test && ./scripts/update.sh <版本标签>` |
| 查看状态 / 日志 | `docker compose ps`、`docker compose logs -f app` |
| 自检 | `docker compose exec app node dist/server/cli.js check` |
| 每日对账包（v0.3.3 起，只读） | `./scripts/daily-recon.sh [营业日]`，写到 `recon/<营业日>/` |
| 新版本有问题，回到上一版 | `./scripts/rollback.sh`（v0.3.3 起；加了迁移时同时恢复升级前的备份，见 Mac mini 手册第 5 节「回退」） |
| 立即备份 / 核验最新备份 | `./scripts/backup.sh`；`./scripts/verify-backup.sh "$(ls -t ~/yuzu-backups/test/yuzu-*.dump \| head -n 1)"` |
| 重置某个员工的密码 | `docker compose exec app node dist/server/cli.js reset-password <账号>` |

`update.sh` 只接受 `main` 上的版本标签或完整 SHA，会先备份、再切换版本，并把版本号与 SHA 写进镜像，启动后自动跑 `check`。发布后，Codex 在对应 PR 留发布记录（SHA、迁移、check 结果）。

**不要**执行 `docker compose down -v`：`-v` 会删除数据库卷。演练库需要清空重来时，经店主同意再操作。
