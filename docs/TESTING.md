# 测试与 CI（飞书需求 RQ-008，v0.7.18）

店主 2026-11-02 提出「精简开发测试与 CI 等待时间」，同日定 Q31 选 A：与 RQ-007（演示数据，见 `docs/DEMO_DATA.md`）合成一版 v0.7.18。目标是日常开发反馈更快、PR 不用长时间等，同时资金、权限、数据安全的核心验证一项不少。默认做法（待确认）见 `docs/PENDING_DECISIONS.md`「演示数据与 CI」。

## 1. 现状（实测）

测的是 PR #33 一次完整通过的 CI：head `92d2ab1`，[运行记录 41391566365](https://github.com/Venture-VV/yuzu/actions/runs/41391566365)。

| job | 用时 | 其中 |
| --- | --- | --- |
| 类型检查 · 集成测试 · 构建 | 7 分 00 秒 | `npm test` 5 分 50 秒，类型检查 35 秒，`npm ci` 7 秒，构建 6 秒，起数据库 13 秒 |
| 从上一发布版本的演示库升级 | 57 秒 | 构建上一版本 12 秒，灌演示数据 7 秒 |
| 浏览器验收（合成演示库） | 16 分 13 秒，**要等上面那个 job 结束才开始** | Playwright 15 分 12 秒，装浏览器 20 秒，灌演示数据 7 秒，构建 6 秒 |
| **整次 CI** | **23 分 36 秒** | 测试 job 7 分 + 浏览器 job 16 分，串行 |

- 浏览器验收共 385 项：跑 211 项，按尺寸跳过 174 项。会改数据的流程只在门店电脑尺寸跑，平板与手机上按设计跳过。
- 按日志时间推算各尺寸用时：门店电脑约 10 分钟，平板横屏约 1.5 分钟，平板竖屏约 2 分钟，小屏电脑约 0.8 分钟，手机约 0.7 分钟。
- 集成测试 64 个文件共用一个测试库，按文件**串行**。
- GitHub 用量接口显示，这个仓库的 Actions 计费分钟为 0。

## 2. 改法

先按下面的方向改，每一步都在 PR 里写明前后的实测耗时。

1. **浏览器验收不再等测试 job**：去掉 `needs: test`，两边同时开始。任何一个 job 失败，整次 CI 照样失败；版本标签只在整次 CI 成功后才打（`release-tag.yml` 看的是整条工作流的结论，拆 job 不影响）。
2. **浏览器验收拆成几个并行 job**（先按 3 个）：门店电脑的用例分两半，其余四个尺寸一组。每个 job 用自己的临时库，自己灌演示数据、起应用，互不影响。拆完后，所有 job 列出的用例合起来与现在完全一样：用 `playwright test --list` 核对总数与跳过数，对不上 CI 就失败。
3. **集成测试并行**：每个并行进程用自己的测试库（库名带进程编号），按文件并行跑。做不到就把 `npm test` 拆两片。
4. **缓存 Playwright 浏览器**（按版本号）：省掉每个 job 的下载时间。
5. 演示数据的新 job（`docs/DEMO_DATA.md` 第 3 节）同时开始，约 3–4 分钟。

预计整次 CI 从 23.5 分钟降到 7–8 分钟，以实测为准。运行机分钟数会因为每个 job 重复安装、构建、灌数据而增加，PR 里写明增加了多少；按用量接口，计费仍为 0。

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

`npm test` 按文件并行（默认 4 个进程，或机器的核数，取小的）：每个进程用自己的测试库（`TEST_DATABASE_URL` 的库名加 `_w1`、`_w2`……），每个测试文件开始时从开跑前迁移好的模板库（库名加 `_tpl`）整库复制一份新的。这样不再整个删 public 模式：删一个迁移好的模式要拿约 3700 把锁，几个进程同时删会超出数据库默认的共享锁表。升级测试要从空库迁移，删模式时几个进程排队。所以测试库的账号要有建库权限；没有的话用 `TEST_WORKERS=1 npm test` 回到原来的单库串行。

```bash
npx vitest run tests/locations.test.ts                          # 一个或几个集成测试文件
E2E_BASE_URL=http://127.0.0.1:<端口> npx playwright test e2e/locations.spec.ts --project=门店电脑
npm run typecheck && npm test && npm run build                  # 交 PR 前
```

| 改了什么 | 先跑的集成测试（`tests/`） | 先跑的浏览器用例（`e2e/`） |
| --- | --- | --- |
| 会员与储值（钱包、扣款规则、赠金、上限、期初） | `wallet-*`、`deduction`、`bonus-expiry`、`concurrency`、`acceptance`、`opening-*`、`member-fields` | `flows`、`review-fixes`、`wallet-limits`、`member-fields`、`storage-failure` |
| 前台与收银（接待、挂账、结账、反结账、交班、补录、转单、打印） | `frontdesk*`、`checkout`、`cashier`、`r1-funds`、`backfill`、`refund-drawer`、`shift-boundary`、`settlement-snapshot`、`auth-settlement`、`recon`、`print` | `frontdesk*`、`cashier`、`r1-funds`、`backfill`、`line-move`、`print`、`regression/` |
| 技师与钟房 | `technicians`、`clockroom`、`catalog-tiers`、`review-v071` | `technicians`、`clockroom` |
| 餐饮与桌台 | `dining*` | `dining*` |
| 客房 | `rooms*` | `rooms` |
| 空间台账、底图、房态图、实时位置 | `spaces`、`floorplan*`、`floormap`、`locations`、`upgrade-floormap` | `spaces`、`floorplans`、`floormap`、`locations` |
| ERP（库存、采购、应付、报销、需求单、两级库存、台账、旧账） | `inventory*`、`purchasing`、`supplier-settlement`、`stock-cycles`、`warehouses`、`expenses`、`requests`、`purchase-ledger`、`erp`、`legacy` | `inventory`、`warehouses`、`supplier-settlement`、`stock-cycles`、`expenses`、`requests`、`purchase-ledger`、`erp`、`legacy` |
| 后台、岗位权限、看板 | `admin-v060`、`roles`、`instance` | `admin-v060`、`review-v060`、`viewports`、`pending-marks` |
| 演示数据 | `*-seed`、`demo-time`、`demo-prepare`（新增） | `demo-showcase`（新增） |
| 迁移 | `upgrade*`；加了迁移一定跑全量 `npm test` | — |
| 备份与运维脚本 | `backup`、`static-compression`、`import-encoding`；`shellcheck` | — |

## 5. 验证（交付时填）

- 优化前后各 job 的用时、整次 CI 用时、运行机分钟数。
- 拆分后浏览器验收的总数、跑与跳过的数目与拆分前一致的核对结果。
- 故意让一个用例失败时，整次 CI 失败、不打版本标签（在开发分支上验证，验证后撤回）。
