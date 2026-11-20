# 测试与 CI（飞书需求 RQ-008，v0.7.18 定稿）

店主 2026-11-02 提出「精简开发测试与 CI 等待时间」，同日定 Q31 选 A：与 RQ-007（演示数据，见 `docs/DEMO_DATA.md`）合成一版 v0.7.18。目标是日常开发反馈更快、PR 不用长时间等，同时资金、权限、数据安全的核心验证一项不少。默认做法（待确认）见 `docs/PENDING_DECISIONS.md`「演示数据与 CI」。

## 1. 现状（实测）

测的是 PR #33 一次完整通过的 CI：head `92d2ab1`，[运行记录 41391566365](https://github.com/Venture-VV/yuzu/actions/runs/41391566365)。

| job                        | 用时                                         | 其中                                                                            |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| 类型检查 · 集成测试 · 构建 | 7 分 00 秒                                   | `npm test` 5 分 50 秒，类型检查 35 秒，`npm ci` 7 秒，构建 6 秒，起数据库 13 秒 |
| 从上一发布版本的演示库升级 | 57 秒                                        | 构建上一版本 12 秒，灌演示数据 7 秒                                             |
| 浏览器验收（合成演示库）   | 16 分 13 秒，**要等上面那个 job 结束才开始** | Playwright 15 分 12 秒，装浏览器 20 秒，灌演示数据 7 秒，构建 6 秒              |
| **整次 CI**                | **23 分 36 秒**                              | 测试 job 7 分 + 浏览器 job 16 分，串行                                          |

- 浏览器验收共 385 项：跑 211 项，按尺寸跳过 174 项。会改数据的流程只在门店电脑尺寸跑，平板与手机上按设计跳过。
- 按日志时间推算各尺寸用时：门店电脑约 10 分钟，平板横屏约 1.5 分钟，平板竖屏约 2 分钟，小屏电脑约 0.8 分钟，手机约 0.7 分钟。
- 集成测试 64 个文件共用一个测试库，按文件**串行**。
- GitHub 用量接口显示，这个仓库的 Actions 计费分钟为 0。

## 2. 改法（已做）

1. **浏览器验收不再等测试 job**：去掉 `needs: test`，各 job 同时开始。任何一个 job 失败，整次 CI 照样失败；版本标签只在整次 CI 成功后才打（`release-tag.yml` 看的是整条工作流的结论，没改）。
2. **浏览器验收拆成并行 job**，按文件名首字母分组（新加的用例文件一定落在某一组里）：门店电脑 `e2e/[a-d]`、门店电脑 `e2e/[e-l]`、门店电脑 `e2e/[m-z]`、其余四个尺寸一组（8.1.18 起四组：原来的 a–l 一组约 1100 秒，CI 机器慢的时候跑到 25 分钟上限被取消，拆成 a–d、e–l；汇总 job 的检查名照旧）。每组用自己的临时库，自己灌演示数据、起应用，互不影响；每组交回 Playwright 的结果文件，「浏览器验收汇总」job 核对各组都交回、合计跑过（通过 + 跳过 + 失败）= 不拆分时 `playwright test --list` 的总数、没有失败也没有「重试后才通过」，对不上 CI 就失败（`scripts/ci/e2e-summary.mjs`）。拆组后单独跑时暴露出 `e2e/price-list.spec.ts` 原来靠别的用例留下的班次，改成自己开班。
3. **集成测试按文件并行**（默认 4 个进程或机器核数取小）：每个进程用自己的测试库（库名加 `_w1`、`_w2`……），每个文件从开跑前迁移好的模板库整库复制（见第 4 节）；`TEST_WORKERS=1` 回到单库串行。
4. **缓存 Playwright 浏览器**（按依赖版本）。
5. **演示数据 job**（`docs/DEMO_DATA.md` 第 3 节）同时开始。

## 3. 门禁不变（每个 PR 都跑）

- 会员钱包与营业口径、幂等与断网恢复（结果待确认）、权限隔离：集成测试全量。
- 迁移：从上一发布版本的演示库升级后自检，加上各迁移的升级测试。
- 备份与恢复核验、运维脚本静态检查。
- 浏览器：完整收银流程、各模块真实流程、五个尺寸的视口冒烟。
- 演示数据：准备、重复执行、核对、环境保护（新增）。
- **不把跳过算通过**：CI 核对浏览器验收的总数与跳过数和拆分前一致；任何一个 job 失败或被取消，整次 CI 都不算通过。
- 不因为提速删掉任何一项上面的验证。跨尺寸的组合怎么排，在 PR 里列出覆盖变化与理由。

## 4. 本地快速反馈

日常改动先跑相关的集成测试与浏览器用例；交 PR 前跑全量的类型检查、集成测试、构建；浏览器的全量交给 CI。

**三档（工程治理三期）**——写代码途中别动不动跑全量，按档来：

| 档   | 命令                                                                                                      | 跑什么                                                                                        | 要多久           | 什么时候跑                            |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------- |
| 秒级 | `npm run lint`、`npm run test:unit`                                                                       | oxlint；不要数据库的用例（36 个文件、300 多条：共用的计算与规则、页面的请求层、各个检查脚本） | 1 秒、8 秒       | 写代码途中随时                        |
| 快测 | `npm run test:quick`                                                                                      | 秒级那一档 + 和这次改动沾边的集成测试（按改到的模块名在用例文件名里找）                       | 几十秒到两三分钟 | 写完一块                              |
| 门禁 | `npm run typecheck && npm run check:code && … && npm test && npm run build`（`AGENTS.md` 的「门禁」一行） | 全部静态检查、全量集成测试、构建                                                              | 五分钟左右       | 交 PR 前；CI 每次都跑，另加浏览器验收 |

- 哪些用例不要数据库是 `scripts/test-tiers.mjs` 顺着导入关系认出来的（引到数据库连接或用例的公共准备 `tests/helpers.ts` 就算要），不用改文件名、不用维护清单；`npm run test:unit -- --list` 看是哪些。新写纯计算、纯规则的用例时不要引 `tests/helpers.ts`，它就自动进秒级这一档。
- 快测是按文件名找的、会漏（例如改钱包会影响前台的用例），**不能代替全量**；`npm run test:quick -- --list` 先看会跑哪些，不够的照下面的对照表补。
- 用例体检（哪些用例 CI 里实际没跑、哪些靠固定等待）的结果与建议在 [`TEST_AUDIT.md`](TEST_AUDIT.md)。

`npm test` 按文件并行（默认 4 个进程，或机器的核数，取小的）：每个进程用自己的测试库（`TEST_DATABASE_URL` 的库名加 `_w1`、`_w2`……），每个测试文件开始时从开跑前迁移好的模板库（库名加 `_tpl`）整库复制一份新的。这样不再整个删 public 模式：删一个迁移好的模式要拿约 3700 把锁，几个进程同时删会超出数据库默认的共享锁表。升级测试要从空库迁移，删模式时几个进程排队。所以测试库的账号要有建库权限；没有的话用 `TEST_WORKERS=1 npm test` 回到原来的单库串行。

只给应用用的开关不带进用例（8.1.5，`vitest.config.ts`）：`INTEGRATIONS_MOCK`、正式接口的密钥（`LIVE_ENV` 里的那些）、`YUZU_AI_*`、访问网段与频率限制（`ACCESS_ALLOW_CIDRS`、`RATE_LIMIT_*`、`OVERLOAD_*`）设在终端里也不影响 `npm test`。它们只给启动应用的那一条命令带；用例要模拟、要哪样的防护，在自己的配置里写明（`tests/helpers.ts` 的 `integrations`、`tests/protection.test.ts` 的 `protection`）。

**测试数据库要给够内存**（main v8.1.1 独立回归的首轮报告）：几个进程同时复制模板库、跑用例，数据库容器限在 768 MiB 时首轮出现数据库「进入恢复状态」、随后连接被拒，用例一片 500 或连不上（多半是某个数据库进程到了内存上限被系统杀掉，数据库自己重启恢复；被杀的不是容器的主进程，所以容器不一定记 OOM）；同一份代码给到 1.5–2.25 GiB 全量都过。给测试数据库 2 GiB 以上；内存紧的机器用 `TEST_WORKERS=2`（或 1）少开几个进程。

交 PR 前另跑 `npm run check:code`（没用到的导入与变量、事务里没等结果的查询、类型导入写法）与 `npm run format:check`（8.1.3 起 CI 都查；改了就 `npm run format`）。工程治理一期起 CI 还查 `npm run check:docs`（`AGENTS.md` 的体积预算、死链、文档索引；加了文档跑 `npm run check:docs -- --fix`）与 `npm run check:gov`（治理基线：分层、依赖声明、页面里的颜色与字号、大文件、没人引用的导出、重复率，只许持平或下降，见 `docs/GOVERNANCE.md` 第 8 节）；二期起还有 `npm run lint`（oxlint，一秒内，写代码途中随时跑）与构建之后的 `npm run check:bundle`（首屏主包上限）。三期起 CI 不再单独跑 `npm run typecheck`，类型检查由 `check:code` 带着做（同一次编译，多开「没用到的」两个开关）；编译器没跑完——内存不够被系统杀掉、退出码不是 0 却没有诊断——`check:code` 算不过并写出信号或退出码，不当成没查出问题（编译器的堆上限是 4 GB，机器或容器给的内存不够时先看这里）。单条用例的时限默认 30 秒；**升级用例（`tests/upgrade-*.test.ts`）是 2 分钟**：它们在一条用例里把迁移从某一份一路跑到最新一份，迁移每加一份就慢一点，CI 的机器快慢又差一倍多（同一份代码 `npm test` 快的 4 分半、慢的 10 分钟），30 秒在慢的那种上不够。按文件名自动放宽（`tests/setup-timeouts.ts`，两份 vitest 配置的 `setupFiles`），新写的升级用例文件名照 `upgrade-…` 起就行，不用自己写时限。服务端的频率限制、过载保护在用例里照默认值开着（每个会话每分钟 600 次、同时 256 个请求）；测试环境不看事件循环卡顿（`OVERLOAD_MAX_LAG_MS` 默认 0，跑用例的机器忙起来会误判），要测它在用例里自己设。

```bash
npx vitest run tests/locations.test.ts                          # 一个或几个集成测试文件
E2E_BASE_URL=http://127.0.0.1:<端口> npx playwright test e2e/locations.spec.ts --project=门店电脑
npm run typecheck && npm test && npm run build                  # 交 PR 前
```

| 改了什么                                                                                                                                | 先跑的集成测试（`tests/`）                                                                                                                                                                            | 先跑的浏览器用例（`e2e/`）                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 会员与储值（钱包、扣款规则、赠金、上限、期初）                                                                                          | `wallet-*`、`deduction`、`bonus-expiry`、`concurrency`、`acceptance`、`opening-*`、`member-fields`                                                                                                    | `flows`、`review-fixes`、`wallet-limits`、`member-fields`、`storage-failure`                                                                   |
| 会员建档与会员卡押金（8.1.16：卡类型、押金进交班与日结、匿名卡、建档表单）                                                              | `member-card-types`、`member-cards`、`recon`、`upgrade-shift`、`op-fences-constraint`                                                                                                                 | `member-card-types`、`member-cards`、`dialog-input`、`admin-v060`、`target-devices`                                                            |
| 前台与收银（接待、挂账、结账、反结账、交班、补录、转单、打印）                                                                          | `frontdesk*`、`checkout`、`cashier`、`r1-funds`、`backfill`、`refund-drawer`、`shift-boundary`、`settlement-snapshot`、`auth-settlement`、`recon`、`print`                                            | `frontdesk*`、`cashier`、`r1-funds`、`backfill`、`line-move`、`print`、`regression/`                                                           |
| 发卡台与收银台、前台风控（芯片号、黑名单、异常处置、结账预览分列；8.1.15）                                                              | `desks`、`desks-columns`（不要数据库）、`frontdesk-risk`、`upgrade-frontdesk-risk`、`upgrade-shift`、`op-fences-constraint`                                                                           | `desks`、`frontdesk-risk`、`frontdesk`、`cashier`、`admin-ia`                                                                                  |
| 技师与钟房                                                                                                                              | `technicians`、`clockroom`、`catalog-tiers`、`review-v071`、`technician-admin`、`pinyin-initials`（不要数据库）                                                                                       | `technicians`、`clockroom`、`technician-admin`、`target-devices`                                                                               |
| 餐饮与桌台（8.1.15 起含桌台动作、台账并退菜、按出品口下单、菜品管理；出品单与平板下单经过同一处；菜品维护的结果待确认在 `dishes`）      | `dining*`、`dishes*`、`upgrade-dining-v8115`、`upgrade-dishes`                                                                                                                                        | `dining*`、`dishes`、`emenu`                                                                                                                   |
| 客房与房态中心（8.1.16：房型、房态、登记与房间动作、结果待确认、客房页并进来）                                                          | `rooms*`、`room-center`、`upgrade-room-center`、`op-fences-constraint`、`tag-scan`（不要数据库）、`store-nav`（不要数据库）、`dining-v8115-orders`                                                    | `rooms`、`room-center`、`frontdesk-808`、`floormap`、`locations`、`target-devices`、`viewports`                                                |
| 客户部（经营总览、手牌跟进、成交归属、月目标、低余额、同步指纹；只读前台与会员数据）                                                    | `customer-*`                                                                                                                                                                                          | `customer`                                                                                                                                     |
| 登记消费的项目与数量、预约页的日期与新建弹窗（店主 2026-11-14 的七条需求；点单换人在 `dining`，平板下单后回起始页在 `emenu`）           | `bookings`                                                                                                                                                                                            | `requests-1114`、`bookings`、`dining`、`emenu`                                                                                                 |
| 加了带操作编号的业务类型、动了「确认作废」的类型约束（任何迁移）                                                                        | `op-fences-constraint`（代码里登记的类型约束都认）、`wallet-abandon`                                                                                                                                  | —                                                                                                                                              |
| 空间台账、底图、房态图、实时位置                                                                                                        | `spaces`、`floorplan*`、`floormap`、`locations`、`upgrade-floormap`                                                                                                                                   | `spaces`、`floorplans`、`floormap`、`locations`                                                                                                |
| ERP（库存、采购、应付、报销、需求单、两级库存、台账、旧账；采购途径、转报销、部门备用金台账、补货建议、询价比价）                       | `inventory*`、`purchasing`、`supplier-settlement`、`stock-cycles`、`warehouses`、`expenses`、`requests`、`purchase-ledger`、`erp`、`erp-purchasing`、`replenish-mode`（补货方式，迁移 161）、`legacy` | `inventory`、`warehouses`、`supplier-settlement`、`stock-cycles`、`expenses`、`requests`、`purchase-ledger`、`erp`、`erp-purchasing`、`legacy` |
| 后台、岗位权限、看板                                                                                                                    | `admin-v060`、`roles`、`instance`                                                                                                                                                                     | `admin-v060`、`review-v060`、`viewports`、`pending-marks`                                                                                      |
| 演示数据                                                                                                                                | `*-seed`、`demo-time`、`demo-prepare`（新增）                                                                                                                                                         | `demo-showcase`（新增）                                                                                                                        |
| 退储值的「门店系统原路退回」（要小程序端口与模拟微信支付）                                                                              | `member-refunds-online`、`mp-refund`                                                                                                                                                                  | `member-refund-online`（设了 `E2E_MP_PORT`、`E2E_MP_GATEWAY_KEY` 才收，见下）                                                                  |
| 请求层、连接状态、页面不白屏、服务端防护（`lib/api`、`lib/connection`、`lib/livePoll`、`lib/lazyPage`、错误边界、`lib/protect`；8.1.3） | `client-api`、`protection`、`check-code`                                                                                                                                                              | `resilience`、`flows`、`frontdesk-recovery`、`storage-failure`、`concierge`、`customer`                                                        |
| 迁移                                                                                                                                    | `upgrade*`；加了迁移一定跑全量 `npm test`                                                                                                                                                             | —                                                                                                                                              |
| 备份与运维脚本                                                                                                                          | `backup`、`static-compression`、`import-encoding`；`shellcheck`                                                                                                                                       | —                                                                                                                                              |
| 文档、检查脚本、版本号的读法（工程治理一期，`docs/GOVERNANCE.md`）                                                                      | `check-docs`、`check-governance`、`check-code`、`version-source`、`instance`（这几个除 `instance` 外不要数据库）                                                                                      | —                                                                                                                                              |

退储值「门店系统原路退回」的浏览器用例（`e2e/member-refund-online.spec.ts`，v0.7.29）要应用开着小程序端口与模拟微信支付：应用用 `MP_PORT`、`MP_GATEWAY_KEY`（至少 32 个字符）、`MP_PAY_MOCK=true` 启动（只在 development、test，实例标识不是 prod / shadow / test），Playwright 设同一个端口与密钥的 `E2E_MP_PORT`、`E2E_MP_GATEWAY_KEY` 才收这个文件；平时的浏览器验收不收、用例总数不变。它会临时打开小程序与线上充值、开着原路退回，结束时（含失败）照原样改回。CI 里还没有跑它的步骤（CI 的测试步骤归测试会话与 Codex）。

```bash
E2E_MP_PORT=<小程序端口> E2E_MP_GATEWAY_KEY=<网关密钥> E2E_BASE_URL=http://127.0.0.1:<端口> npx playwright test e2e/member-refund-online.spec.ts --project=门店电脑
```

## 5. 验证（实测）

优化前：PR #33 `92d2ab1`（[运行记录 41391566365](https://github.com/Venture-VV/yuzu/actions/runs/41391566365)）；优化后：PR #34 `c7f5a5d`（[运行记录 41406793109](https://github.com/Venture-VV/yuzu/actions/runs/41406793109)，只改了 CI 与测试，还没有演示数据 job）。

| job                             | 优化前                              | 优化后                                                                                            |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| 类型检查 · 集成测试 · 构建      | 7 分 00 秒（`npm test` 5 分 50 秒） | 4 分 03 秒（`npm test` 2 分 53 秒）                                                               |
| 浏览器验收                      | 16 分 13 秒，等上面结束才开始       | 三组同时：6 分 09 秒 / 6 分 20 秒 / 6 分 33 秒（Playwright 4 分 58 秒 / 5 分 12 秒 / 5 分 21 秒） |
| 浏览器验收汇总                  | —                                   | 约 20 秒（三组结束后）                                                                            |
| 从上一发布版本的演示库升级      | 57 秒                               | 57 秒                                                                                             |
| **整次 CI**                     | **23 分 36 秒**                     | **6 分 56 秒**                                                                                    |
| 运行机分钟数（各 job 用时相加） | 24 分 10 秒                         | 24 分 21 秒                                                                                       |
| 计费分钟（GitHub 用量接口）     | 0                                   | 0                                                                                                 |

- 运行机分钟数基本没变：测试 job 快了 3 分钟，抵掉了浏览器验收多出来的两份安装、构建、灌数据。演示数据 job 另加的用时见 PR #34。
- 浏览器验收：三组合计跑过 385 项（通过 211、按尺寸跳过 174、失败 0、重试后才通过 0），与不拆分时 `--list` 的 385 项一致——与拆分前 PR #33 的 211 + 174 相同。
- 本机：`npm test` 344 秒 → 约 97 秒（65 个文件、668 项，连续多次全过）。
- 失败一定拦得住：汇总脚本在本机用构造的结果文件试过——少交一组、用例数少一项、有一项失败、有一项重试后才通过，都退出码 1 并写明原因；全对时退出码 0。整条工作流的结论由 GitHub 按各 job 的结果给出，`release-tag.yml` 只在结论为 success 时打标签。原定在开发分支上推一个故意失败的提交再撤回，考虑到这个 PR 店主随时可能合并，改成上面的本机验证。
