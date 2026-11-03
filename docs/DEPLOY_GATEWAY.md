# 小程序网关部署手册（阿里云深圳；小程序线）

微信小程序只能连在小程序后台登记过的 HTTPS 域名，域名要 ICP 备案；yuzu 只在门店局域网与 Tailscale 里，不上公网（`MINIPROGRAM.md` 第 1 节）。所以在阿里云深圳放一台最低配的服务器做**小程序网关**：公网只开 443，经 Tailscale 只连 yuzu 的小程序端口。网关不存会员、余额、券、订单，只做微信登录、手机号验证、限流、展示内容缓存与转发。

谁做：店主办手续（第 1 节）；Codex 部署与日常更新（与测试服、门店一样只部署 `main` 上的版本）；小程序线维护本手册与 `src/gateway/deploy/` 里的文件。**域名备案下来之前不部署**：备案没完成，阿里云会拦截这个域名的 443。

## 0. 一览

```
开发版、体验版 ──HTTPS──▶ api-test.<域名> ┐
正式版         ──HTTPS──▶ api.<域名>      ┤ 网关服务器（公网只开 443）：Caddy 管证书
                                           ├─ gateway-test ──Tailscale──▶ 测试服 A · 演示库 yuzu-demo :8081
                                           └─ gateway-prod ──Tailscale──▶ 门店 Mac mini · 正式服 :8081（yuzu 正式切换后才开）
```

| 机器 | 跑什么 | 本手册 |
| --- | --- | --- |
| 网关服务器（阿里云 ECS 最低配，深圳） | Caddy（HTTPS，证书自动申请与续期）、测试网关；正式切换后加正式网关 | 第 3–7 节 |
| 测试服 A | 演示库 `yuzu-demo` 开小程序端口 8081（演练库 `yuzu-test` 不接小程序） | 第 2 节 |
| 门店 Mac mini | 正式服的小程序端口：正式切换时再开 | 第 8 节 |

文件都在仓库里：

| 文件 | 用途 |
| --- | --- |
| `compose.mp.yaml` | 叠加在 yuzu 的 `compose.yaml` 上：开小程序端口（只给接小程序的实例） |
| `src/gateway/deploy/compose.yaml` | 网关服务器上的 Caddy 与两个网关进程 |
| `src/gateway/deploy/Dockerfile`、`build.mjs` | 网关的小镜像：只有打包好的网关一个文件，不带 yuzu 的后端、管理后台、数据库工具和 node_modules |
| `src/gateway/deploy/caddy/Caddyfile` | 两个域名各转给自己的网关；网关没起来时回「门店系统连接中」。`caddy/` 整个目录只读挂进 Caddy 的容器（单挂文件的话，切换版本后容器里还是旧文件），旁边的 `.env`、`gateway-*.env` 不进去，这个目录里不要放别的文件 |
| `src/gateway/deploy/.env.example`、`gateway.env.example` | 配置样例（真的 `.env`、`gateway-test.env`、`gateway-prod.env` 不进 Git） |
| `src/gateway/deploy/update.sh` | 更新到 `main` 上的某个版本（回退就是用上一版的 SHA 再执行一次）。按 `COMPOSE_PROFILES` 算出应该开着的服务逐个核对：网关起来了、Caddy 加载了这一版的配置、经 Caddy 连得通，有一项不通过就返回失败 |
| `src/gateway/deploy/upload-miniprogram.sh` | 上传小程序体验版（第 7 节） |

## 1. 先要有的（店主办，`MINIPROGRAM.md` 第 7 节）

- [ ] 小程序注册、认证完成，拿到 **AppID** 与 **AppSecret**（小程序后台「开发管理 → 开发设置」）。
- [ ] **域名备案**完成，接入商是阿里云（服务器在阿里云深圳）。两条 A 记录指到网关服务器的公网 IP：`api-test.<域名>`（测试网关）、`api.<域名>`（正式网关）。
- [ ] **网关服务器**：阿里云 ECS 深圳，最低配即可（建议 2 GiB 内存：构建镜像时要装依赖），Ubuntu 22.04 / 24.04，固定公网 IP。
- [ ] 小程序后台「开发管理 → 开发设置 → 服务器域名」：request 合法域名、downloadFile 合法域名都填 `https://api-test.<域名>` 与 `https://api.<域名>`。
- [ ] 小程序后台「开发管理 → 开发设置 → 小程序代码上传」：生成**代码上传密钥**，IP 白名单填网关服务器的公网 IP（第 7 节）。
- [ ] 小程序后台填**用户隐私保护指引**（草稿见 [`MP_PRIVACY.md`](MP_PRIVACY.md)）。

## 2. 测试服 A：给演示库开小程序端口

只给演示库（`~/yuzu-demo`，`APP_ENV=development`、`YUZU_INSTANCE=demo`）开；演练库不接小程序（`MINIPROGRAM.md` 第 6 节）。在 `~/yuzu-demo/.env` 末尾加：

```bash
# 微信小程序：叠加 compose.mp.yaml 开小程序端口（docs/DEPLOY_GATEWAY.md 第 2 节）
COMPOSE_FILE=compose.yaml:compose.mp.yaml
MP_PORT=8081
MP_GATEWAY_KEY=<openssl rand -hex 32 生成；网关的 gateway-test.env 填同一个>
MP_CODE_SECRET=<openssl rand -hex 32 生成；只在这里，网关不存>
```

`COMPOSE_FILE` 写在 `.env` 里，之后 `update.sh`、`rollback.sh`、看门狗照常用，`docker compose` 自己把两个文件合起来。然后照常更新到含本功能的版本（已经是这个版本时执行 `docker compose up -d`）：

```bash
cd ~/yuzu-demo && ./scripts/update.sh <版本标签>
```

核对：

```bash
docker compose ps    # app 的端口里有 0.0.0.0:8081->8081
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/api/mp/health    # 401：端口开了，不带网关密钥被拒
```

然后用店主账号登录演示库后台「微信小程序」，打开开关、填门店信息（演示库的内容不作数）。安全组不用改：公网照旧全关。Docker 发布的端口会绕过 ufw，挡公网靠的是云安全组（`DEPLOY_TEST_SERVER.md` 第 4 节）。

## 3. Tailscale：网关只连得到 8081

网关服务器安装 Tailscale、用店主的账号登录（同 `DEPLOY_TEST_SERVER.md` 第 4 节）：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=yuzu-gateway
```

在 Tailscale 管理后台：

1. **Machines**：给这台加标签 `tag:yuzu-gateway`，并确认它的 Key expiry 已关闭（Disable key expiry），免得过期断线。
2. **Access controls**：用下面的策略替换整个文件（登录邮箱换成店主的）。前三条就是测试服手册第 4 节那一份；后两条是新加的：店主能 SSH 到网关服务器；网关只能连测试服 A 的 TCP 8081。

```json
{
  "tagOwners": {
    "tag:yuzu-test": ["autogroup:admin"],
    "tag:yuzu-mini": ["autogroup:admin"],
    "tag:yuzu-gateway": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["owner@example.com"], "dst": ["tag:yuzu-test"], "ip": ["tcp:8080", "tcp:8082", "tcp:22"] },
    { "src": ["owner@example.com"], "dst": ["tag:yuzu-mini"], "ip": ["tcp:8080"] },
    { "src": ["tag:yuzu-mini"], "dst": ["tag:yuzu-test"], "ip": ["tcp:22"] },
    { "src": ["owner@example.com"], "dst": ["tag:yuzu-gateway"], "ip": ["tcp:22"] },
    { "src": ["tag:yuzu-gateway"], "dst": ["tag:yuzu-test"], "ip": ["tcp:8081"] }
  ]
}
```

网关服务器在公网上：被攻破也只碰得到演示库的小程序端口（还要网关密钥），碰不到管理后台、数据库和门店。核对（在网关服务器上，地址换成测试服 A 的 `tailscale ip -4`）：

```bash
nc -vz -w 3 100.x.y.z 8081    # 成功
nc -vz -w 3 100.x.y.z 8082    # 失败（演示库的管理后台不放行）
nc -vz -w 3 100.x.y.z 22      # 失败
```

## 4. 网关服务器：安装与配置

1. **安全组入方向**只留两条：TCP 443（来源 `0.0.0.0/0`）、UDP 41641（Tailscale 直连）。22、80、8300 都不放行；之后 SSH 走 Tailscale：`ssh yuzu@yuzu-gateway`。
2. **Docker**：同 `DEPLOY_TEST_SERVER.md` 第 2 节（国内源）。
3. **拉代码**：同 `DEPLOY_TEST_SERVER.md` 第 3 节，用只读部署密钥，克隆到 `~/yuzu-gateway`。
4. **配置**（`.env` 与两个网关的配置都不进 Git，权限 600）：

```bash
cd ~/yuzu-gateway/src/gateway/deploy
cp .env.example .env                       # 两个域名、证书提醒邮箱、上传密钥的位置、国内镜像源
cp gateway.env.example gateway-test.env    # 测试网关：MP_UPSTREAM_URL、MP_GATEWAY_KEY、MP_SESSION_SECRET、WX_APPID、WX_APPSECRET
chmod 600 .env gateway-test.env
openssl rand -hex 32                       # 生成 MP_SESSION_SECRET（只在网关）
```

- `MP_UPSTREAM_URL` 写测试服 A 的 Tailscale 地址：`http://100.x.y.z:8081`。不用 MagicDNS 名字：容器里不一定解析得了。
- `MP_GATEWAY_KEY` 与演示库 `.env` 里的同一个（第 2 节）。
- 测试网关用**真的微信**（`WX_APPID`、`WX_APPSECRET`）：体验版在真手机上要测微信登录、手机号验证。还没有 AppID 时可以先写 `MP_MOCK_WECHAT=true`（假登录、假手机号，演示库接受）。
- 体验版绑定会员：演示库里要有同事自己手机号的会员，在演示库前台给自己开一张卡（演示库不记真实业务，卡不作数）。

## 5. 首次启动与验证

```bash
cd ~/yuzu-gateway
src/gateway/deploy/update.sh <版本标签>    # 核对版本、构建网关镜像、起 Caddy 与测试网关、经 Caddy 核对
```

第一次启动时 Caddy 申请证书要一两分钟（经 443 验证，不用开 80）。脚本经 Caddy 核对最多等 60 秒；证书还没下来时脚本返回失败，过几分钟用同一个版本再执行一次（镜像已经有了，不会重新构建）。

验证清单：

- [ ] `cd src/gateway/deploy && docker compose ps`：`caddy` 是 Up，`gateway-test` 是 Up (healthy)。
- [ ] 手机断开 Tailscale、只用蜂窝网络打开 `https://api-test.<域名>/v1/health`：`{"ok":true,"mockWechat":false,"store":"online"}`。`store` 是 `offline` 时，查 `MP_UPSTREAM_URL`、Tailscale 规则（第 3 节）、两边的 `MP_GATEWAY_KEY` 是否一样。
- [ ] `https://api.<域名>/v1/health`：回「门店系统连接中」（正式网关还没开）。
- [ ] 浏览器看证书：Let's Encrypt 签发，域名对。`http://api-test.<域名>`（80）、公网 IP 的 22 与 8300 都连不上。
- [ ] 网关连得到演示库的小程序端口：`docker compose exec gateway-test node -e "fetch(process.env.MP_UPSTREAM_URL + '/api/mp/health').then(r => console.log(r.status))"` 打出 `401`（不带密钥被拒，说明网络通）。连不通时（容器经宿主机出不了 Tailscale），先查 `sudo tailscale status`。
- [ ] 小程序后台配好服务器域名后，开发者工具里切到「体验版」的地址能打开首页。

## 6. 日常更新与回退

| 场景 | 命令（在 `~/yuzu-gateway`） |
| --- | --- |
| 更新到某个版本 | `src/gateway/deploy/update.sh <版本标签或完整 SHA>`：只接受 `main` 上的版本；最后打出上一版的 SHA |
| 回退 | `src/gateway/deploy/update.sh <上一版的 SHA>`：网关不存数据，不用恢复备份；镜像还在就不重新构建 |
| 查看状态、日志 | `cd src/gateway/deploy && docker compose ps`、`docker compose logs -f gateway-test`、`docker compose logs caddy` |
| 改了 `gateway-test.env` | `docker compose up -d gateway-test`（换 `MP_GATEWAY_KEY` 时，演示库那边同时换） |

- yuzu 改了小程序接口时，网关与小程序要一起更新：先更新演示库，再更新网关，最后上传体验版（第 7 节）。
- 证书由 Caddy 自动续期，存在数据卷 `caddy_data` 里。**不要**执行 `docker compose down -v`：会删掉证书卷，重新申请有次数限制。
- 网关日志只有请求的路径与 IP，没有手机号、余额；Docker 日志每个服务最多 5 × 10 MB。

## 7. 上传小程序体验版

体验版用测试网关，所以传的是网关服务器上**现在部署的那个版本**（与测试网关同一个 `main` 上的 SHA）：PR 合并、`update.sh` 部署之后再传。

1. 前提：`miniprogram/src/config/env.ts` 里体验版、正式版的网关地址已改成备案域名（小程序线改，随 PR 合并）；地址还是占位的 `domain.invalid` 时脚本拒绝上传。
2. 代码上传密钥放到 `.env` 的 `MP_UPLOAD_KEY_FILE` 写的位置（默认 `/home/yuzu/secrets/miniprogram-upload.key`，放在仓库外，权限 600）；IP 白名单填这台的公网 IP。
3. 上传：

```bash
cd ~/yuzu-gateway
src/gateway/deploy/upload-miniprogram.sh --dry-run    # 先在本机编译一遍：不要密钥、不上传，看能不能编过、包多大
src/gateway/deploy/upload-miniprogram.sh              # 上传为「ci 机器人 1」的开发版本（版本号是 miniprogram/package.json 的 version）
```

脚本在一次性的 Node 容器里跑 `miniprogram/tools/upload/upload.mjs`（微信官方的 miniprogram-ci，依赖装在 `miniprogram/tools/upload/node_modules`，不进 Git）；宿主机不用装 Node，密钥只读挂进容器、用完即删。

4. 第一次：店主在小程序后台「管理 → 版本管理 → 开发版本」把 ci 机器人 1 的这一版「选为体验版」，在「成员管理 → 体验成员」加上要试用的同事。之后同一个机器人再上传，就换掉这一版（体验版跟着更新）。
5. 小程序线在 PR 里写明这次的版本号与改了什么；提交审核、发布由店主在小程序后台操作。

## 8. yuzu 正式切换时（之后做，现在先不动）

正式版要连门店的正式服，等 yuzu 成为正式账本（ROADMAP 第 3 节 M5）再做：

1. 门店 Mac mini 正式服的 `.env`：同第 2 节加 `COMPOSE_FILE`、`MP_PORT`，`MP_GATEWAY_KEY`、`MP_CODE_SECRET` 另生成一套（不与演示库共用）。
   Mac mini 上 `0.0.0.0:8081` 店内局域网也连得到（有网关密钥挡着）；要只给 Tailscale，可以设 `MP_BIND=127.0.0.1` 再用 `tailscale serve` 把 8081 只发布到 Tailscale——到时候在 Mac mini 上验证后再定。
2. Tailscale 策略加一条：`{ "src": ["tag:yuzu-gateway"], "dst": ["tag:yuzu-mini"], "ip": ["tcp:8081"] }`。
3. 网关服务器：`cp gateway.env.example gateway-prod.env`（`MP_UPSTREAM_URL` 写 Mac mini 的 Tailscale 地址、新的 `MP_GATEWAY_KEY` 与 `MP_SESSION_SECRET`；**不开**模拟微信），`chmod 600`；`.env` 里去掉 `COMPOSE_PROFILES=prod` 前面的 `#`；`docker compose up -d`。
4. 核对 `https://api.<域名>/v1/health` 是 `"store":"online"`、`"mockWechat":false`；店主在后台打开正式服的小程序开关，再提交正式版审核。

## 9. 红线

- 网关服务器只放网关：不放 yuzu 的后端、数据库与备份，不跑 seed 等任何命令；网关不存会员、余额、券、订单。
- 测试网关只连演示库，不连门店试用库、演练库、正式服；正式网关不开模拟微信（正式、演练的 yuzu 也会拒绝模拟绑定）。
- 密钥（`MP_GATEWAY_KEY`、`MP_SESSION_SECRET`、`WX_APPSECRET`、代码上传密钥）只放服务器上的 `.env`、`gateway-*.env` 与 `secrets` 目录，权限 600，不进 GitHub，不发给云端会话。
- 只部署、只上传 `main` 上的版本标签或完整 SHA；网关服务器上不改代码。
- 公网只开 443；SSH 只走 Tailscale。
