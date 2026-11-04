# 交接：小程序第二期 2a · 线上充值（小程序线）

设计见 [`MP_RECHARGE.md`](MP_RECHARGE.md)；做法店主 2026-11-04 都已定（MP17–MP22），2a 里新定的默认做法 MP23（新权限「小程序线上充值」给店主、店总）、MP24（钱付了、入账被拒时记「已付款待处理」，店主三种处理）、MP25（合并掉的会员卡请到前台换绑）、MP26（换号不重新验证），店主 2026-11-04 都按默认定了（`PENDING_DECISIONS.md`「微信小程序」）。

**合并顺序**：入账调用主线 v0.7.26 的钱包「线上收款」入口（`rechargeOnline`、`previewOnlineRecharge`，#48 的 `7c61d01`），**#48 先合并**，小程序线再把 `main` 合进来、CI 全绿后交店主。动的是真钱和储值，按资金候选版本走（CI 全绿后店主合并，独立验收在合并后补做）。对顾客开放要等 yuzu 正式切换（ROADMAP 第 3 节 M5）；在那之前只在演示库上用模拟微信支付联调，真钱等商户号。

## 1. 范围

| 部分 | 做了什么 | 在哪 |
| --- | --- | --- |
| 迁移 `046` | 线上充值单 `mp_recharge_orders`（状态只能照 `MP_RECHARGE.md` 第 2.1 节变、写上的不能改，触发器兜底；一位会员同时只有一张待支付的，唯一索引兜底）；单子的记录 `mp_recharge_events`（只追加）；`mp_op_fences` 加一类 `mp_recharge`（建单的确认作废） | `src/server/migrations/046_mp_recharge.sql` |
| 可充的项与建单 | 店主勾选的套餐与自定义金额（整元，最低取 1 元与首充 / 续充最低里大的，最多取线上单笔上限与前台单笔上限里小的），各自按这位会员此刻预估；冻结、合并的不能下单；每人每天笔数（没付关掉的不算）。建单取这个微信的咨询锁、不锁会员；事务外向微信下单（15 分钟到期），签 paySign | `src/server/modules/mp/recharge.ts` |
| 到账入账 | 到账通知（网关原样转来）验签、解密 → 找单子 → 与单子核对（金额、付款的微信、AppID、商户号）→ 会员一行 → 单子一行 → `rechargeOnline`，同一个事务。入账被拒（到账时规则变了）或对不上的另开事务记「已付款待处理」。记下了才回微信收到；验签失败不记库、回失败 | 同上 |
| 查单、补查、关单 | 顾客查单时待支付的顺带去微信查（同一张单 3 秒一次）；每分钟补查待支付超过 2 分钟的，过期的请微信关单；关单之后才付的照样入账、标出来；微信那边没有这一单的过期后关；找不到单子的真付款记下来给店主看 | 同上，`app.ts`（定时，只在小程序端口开着时） |
| 微信支付 | 凭据只在门店 yuzu 的 `.env`（`WXPAY_*`，证书给路径或 Base64）；配错不开线上充值、门店系统照常启动，后台写原因。模拟微信支付 `MP_PAY_MOCK=true` 只在 development、test：照真的协议签名、加密 | `pay.ts`、`wxpay-mock.ts`、`compose.mp.yaml` |
| 网关 | `/v1/recharge…` 带会话转发（限流）；`/v1/pay/notify` 不要会话、不解析内容，报文主体与四个签名头原样转给 yuzu，门店收下回 204、没收下或连不上回失败（微信重发） | `src/gateway/app.ts` |
| 后台 | 「微信小程序 → 线上充值」：微信支付配没配好；设置（版本号、结果待确认）；已付款待处理的单与三种处理（写原因，带操作编号，结果待确认时查回或按原内容重新提交）；最近 50 张；找不到单子的到账。权限 `mp.recharge`（店主、店总） | `recharge-admin.ts`、`src/client/features/mp/RechargeTab.tsx` |
| 小程序 | 「我的 → 充值」（线上充值开着、微信支付配好了才显示）：套餐、自定义金额、待支付的单（接着付、取消）、确认 → 微信支付（模拟时点「模拟支付」）→ 等入账（2 秒查一次、最多 1 分钟）；建单「结果待确认」 | `miniprogram/src/pages/recharge`、`utils/recharge.ts` |
| 文档 | 设计稿补全（状态、锁与事务）、部署（`DEPLOY_GATEWAY.md` 第 2.1 节）、隐私指引（`MP_PRIVACY.md`）、MP23–MP26 | `docs/` |

没做（之后的步）：2b 对账（微信支付的交易账单逐笔核对）、2c 线上领券（MP22）、2d 原路退回（接主线的储值退回）。

## 2. 迁移（只增不改）

`046_mp_recharge.sql`：只建小程序线自己的表，只用外键引用 045 以前就有的表（会员、绑定记录、充值套餐、充值单、员工）；给 `mp_op_fences` 的两条约束加上 `mp_recharge`。主线的 `047` 先跑过的库之后再补 `046` 也照样能升（迁移按文件名补跑）。升级后线上充值默认关，原有功能不变。

## 3. 环境与配置

- 演示库（`APP_ENV=development`）：`.env` 加 `MP_PAY_MOCK=true`，后台「微信小程序 → 线上充值」打开开关、勾套餐。`DEPLOY_GATEWAY.md` 第 2.1 节。
- 真的商户号：`WXPAY_APPID`、`WXPAY_MCHID`、`WXPAY_SERIAL_NO`、`WXPAY_APIV3_KEY`、`WXPAY_PUBLIC_KEY_ID`、`WXPAY_NOTIFY_URL`（网关的 `https://<域名>/v1/pay/notify`），证书 `WXPAY_PRIVATE_KEY_FILE` / `_BASE64`、`WXPAY_PUBLIC_KEY_FILE` / `_BASE64`。只放门店 yuzu 的 `.env`，网关上一样都不放，不进 GitHub、不发给云端会话。
- 没有新的演示数据（`seed*` 没改）。

## 4. 已执行的验证（云端开发会话）

在本机临时合入 #48（`008b2b1`）的代码上跑（#48 合并前 2a 在 `main` 上编译不过，所以还没推到 PR）：

- `npm run typecheck`、`npm run build` 通过。
- 全量 `npm test`（4 个进程并行）：95 个文件、954 项全过；其中 `tests/mp-recharge.test.ts` 20 项、`tests/gateway.test.ts` 新加 3 项。
- `miniprogram/` 下 `npm run check`：类型检查 + 70 项单元测试通过（新加 `tests/recharge.test.ts` 8 项）。
- 受阻未测：真的微信支付（要商户号与凭据）、微信开发者工具与真手机（要 AppID 与本地 AI 的电脑）、浏览器用例（后台「线上充值」这一页还没写 e2e）。

## 5. 验收要点

1. **只入账一次**：同一笔的到账通知重复到、同时到，通知与查单两条路同时到，店主重新入账，都只有一张充值单（按微信交易单号）；余额、流水、赠金、套餐券与前台充值一样。
2. **冒充不了**：改过的通知、别人的公钥签的、过期的时间戳、探测通知、没带网关密钥的都不认、不入账、不记库；网关上没有任何支付凭据。
3. **钱付了不会丢**：入账被拒（套餐停用、改价、不够最低、超上限）与对不上的都记「已付款待处理」，顾客看到门店电话，店主处理时写原因；找不到单子的真付款记下来。
4. **不会多付**：一人同时只有一张待支付的单；建单结果不确定时同一个编号重提返回同一张单，确认作废之后晚到的原请求不建单。
5. **关单**：取消、过期都先请微信关单；关单前一刻付了的照样入账并标出来。
6. **配置**：一样没配不开；配错了不开、门店系统照常启动、后台写原因；模拟微信支付只在 development、test。
7. **账目**：线上的充值单渠道「小程序」、不记班次，日结与看板单列「线上（小程序）」（主线 #48）；`check` 全过。

## 6. 可复制给测试会话的指令

> 小程序线·测试：等主线 #48 合并、小程序线 PR 合进 `main` 并推上来以后，测小程序线 PR 的完整 SHA。新建独立测试库，`npm ci`、`npm run typecheck`、`npm run build`；`TEST_DATABASE_URL=<独立测试库> npm test`（重点 `tests/mp-recharge.test.ts`、`tests/gateway.test.ts`）；`cd miniprogram && npm ci && npm run check`。另在新建的演示库（`APP_ENV=development`、`YUZU_INSTANCE=demo`、`MP_PORT`、`MP_GATEWAY_KEY`、`MP_PAY_MOCK=true`）上起 yuzu 与本机网关（`MP_MOCK_WECHAT=true`），用 curl 走一遍：登录 → 模拟绑定 → `GET /v1/recharge` → `POST /v1/recharge/orders` → `POST /v1/recharge/orders/<单号>/mock-pay`，再在后台核对充值单、日结的「线上（小程序）」与 `node dist/server/cli.js check`。按 AGENTS.md 的格式发在小程序线的 PR 上，第一行 `【小程序线·测试】→ 小程序线 · PR #<号> · <完整 SHA>`。

## 7. 店主要做的

- 商户号办好、拿到凭据以后告诉我们（凭据不要发给云端会话：Codex 按 `DEPLOY_GATEWAY.md` 第 2.1 节直接填在演示库那台的 `.env`）；先在演示库用 1 元真钱试（线上最少 1 元，MP18；演示库的首充 / 续充最低先调到 1 元），测完在商户平台原路退回。
- 线上卖储值的备案、资金存管要求（`MINIPROGRAM.md` 第 7 节），对顾客开放之前问清楚。
