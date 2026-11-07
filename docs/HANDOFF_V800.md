# v8.0.0 交接说明 · 正式版

店主 2026-11-07 定：发正式版，版本号用 **8.0.0**（原定正式切换用 1.0.0）。之后门店 Mac mini 跑内网测试服，阿里云服务器跑外网正式服，独立测试与本地开发另算。发版前的检查、正式服上线前要做的与要店主定的（Z1–Z5）见 [`RELEASE_V800.md`](RELEASE_V800.md)。

## 1. 范围（相对 v0.7.33）

- **员工食堂**（PR #73，`v0.7.33` 的标签已经包含它）：
  - 开场动画念出柚子的话（K19）；
  - 局域网 http 打开也能出二维码、亮饭卡码，负责人「拍一张扫码」（K18）；
  - 新手教程第二遍完整演示；
  - K18、K19 店主 11-07 定了照默认。
- **正式服放公网之前的加固**（这一版，默认都不改现在的行为）：
  - `compose.yaml` 把 `COOKIE_SECURE`、`TRUST_PROXY` 传进容器；
  - 主应用按 `TRUST_PROXY` 信任反向代理；
  - `APP_BIND` 指定端口开在哪个地址；
  - 响应头加 `X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: same-origin`。
- **版本号** 8.0.0：`package.json`、`package-lock.json`、`Dockerfile`、`compose.yaml`、`src/server/config.ts`。
- **文档**：AGENTS.md 与 ROADMAP 的版本号规则（之后默认每次加最后一位，Z1）、环境与部署（ROADMAP 第 6 节）；两本部署手册开头写明角色互换；`RELEASE_V800.md`。
- **CI**（PR #73）：要 PostgreSQL 16 工具的两项检查固定用 `ubuntu-24.04`。

## 2. 迁移、演示数据与固定预期

没有新迁移（最后一个仍是 `092`）。演示数据与 `src/server/demo/*-expected.json` 不变。

## 3. 验收要点

1. 登录页与导航栏显示 `v8.0.0` 和提交 SHA，实例标识照旧（测试服「测试服·不作数」、演示库「演示·不作数」）。
2. 不设新环境变量时行为与 v0.7.33 一样：门店局域网照常登录，登录 Cookie 不加 Secure。
3. 响应头带 `X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: same-origin`；别的网站嵌不进页面，页面自己打印用的隐藏框照常能用（管理后台「小程序」里打印扫码点餐的桌贴）。
4. 正式服配置演练（演示库上做就行）：
   - `.env` 设 `COOKIE_SECURE=true`，前面挂 Caddy（https）；
   - `TRUST_PROXY` 填应用看到的代理地址：用 Docker 跑、Caddy 在同一台主机时是 Docker 网络的网关（`docker network inspect <项目名>_default` 里的 Gateway），不是 `127.0.0.1`；直接用 `node` 跑时才是 `127.0.0.1`；
   - 登录后 Cookie 带 Secure；
   - 审计日志的来源 IP 是浏览器的真实地址，不是 Caddy 的；
   - 不经 Caddy 直接 http 打开时登录不上（Cookie 存不下，属预期）。
5. `APP_BIND=127.0.0.1` 时，从别的机器连不上 8080，本机的 Caddy 能连。
6. 员工食堂 PR #73 的验收要点见 `docs/CANTEEN.md` 第 12 节（局域网、开场语音）。

## 4. 已执行的验证（本机，独立的合成库）

- `npm run typecheck`、`npm run build` 通过；`npm test` 全过。
- 新测试：`tests/instance.test.ts`（`TRUST_PROXY` 的读法；信任代理时登录记下真实来源 IP、Cookie 加 Secure；不信任时转发头不算），`tests/admin-v060.test.ts`（三个响应头）。
- CI 的结果以这个 PR 最后一个提交上的检查为准。

## 5. 给测试 AI 的指令（可复制）

```
请在一个新建的独立演示库上验收 v8.0.0（完整 SHA 以 PR #74 最后一个提交为准，合并后以 main 的 v8.0.0 标签为准），不要碰门店库、测试服与正式服：
1. npm ci && npm run build；新建库，demo-prepare，起应用，核对登录页的版本 8.0.0 与 SHA。
2. 不设新环境变量：登录、前台接待结账、ERP 各走一遍，check 全 ✓；响应头带 X-Frame-Options: SAMEORIGIN、Referrer-Policy: same-origin。
3. 设 COOKIE_SECURE=true，前面挂一个本机的 https 反向代理；TRUST_PROXY 填应用看到的代理地址（直接 node 跑时 127.0.0.1；用 Docker 跑时是 Docker 网络的网关，docker network inspect <项目名>_default 里的 Gateway）：登录 Cookie 带 Secure，审计日志记下真实来源 IP。
4. 员工食堂按 docs/CANTEEN.md 第 12 节走一遍局域网与开场语音（e2e-canteen 可以直接跑）。
5. 报告第一行：【主线·测试】→ 主线 · PR #74 · <完整 SHA>（合并后：→ 主线 · main v8.0.0 · <完整 SHA>）。
```
