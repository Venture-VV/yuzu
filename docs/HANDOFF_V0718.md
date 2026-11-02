# v0.7.18 交接说明 · 飞书需求 RQ-007 演示数据可重复准备 + RQ-008 精简测试与 CI 等待

店主 2026-11-02 合并 v0.7.17 后，定 Q31 选 A：两条合成一版，**没有迁移**。设计（定稿）见 `docs/DEMO_DATA.md`、`docs/TESTING.md`；默认做法（待确认）见 `docs/PENDING_DECISIONS.md`「演示数据与 CI」。派对房等「开单即占用」（D39）在 v0.7.19（迁移 `036`）。

- **阻断项**：
  - 任何演示数据命令在试用、正式环境（`APP_ENV=trial` / `production`，含云上演练库）写入了数据，或有绕过开关。
  - `demo-reset` 在实例标识 `prod` / `shadow` / `test` 或库名不对时执行了，或备份没核验通过就清了库。
  - 已有演示库再执行 `demo-prepare` 改了、删了已有记录（第二次执行数据指纹变了）；场景块有冲突时写了一部分。
  - 新库 `demo-prepare` 之后 `check` 或 `demo-check` 不全 ✓；场景块出现账错（押金、挂账、钟单金额与账单不一致）。
  - CI 拆分后少跑了用例（汇总核对的总数对不上却没失败），或把跳过算成通过；任何 job 失败时整次 CI 仍显示成功、仍打版本标签。
  - 破坏原有功能或原有五条 `seed-*` 命令。

## 1. 范围

| 项 | 内容 |
| --- | --- |
| `demo-prepare [--previous-day]` | 迁移 → 会员 → 库存 → 前台 → 结账 → 旧账 → 场景块 → `check` → `demo-check`；已有的块跳过、缺的补上，不改已有记录；最后一张表列出每块「已写入 / 已存在」、场景块逐条写了什么、核对结果；核对不通过退出码 1 |
| 场景块 | 空间台账与样例底图、客房、技师与钟房、餐饮与厨房、实时位置、3 位在店客人（内容见 `docs/DEMO_DATA.md` 2.2）；走正式接口（本进程起不监听端口的应用，演示店主 `linlan`、前台 `xiaozhou` 的临时会话，用完删掉）；先只读核对冲突，有冲突什么都不写、逐条列出；中途出错再执行原样重发、接着补 |
| `demo-check` | 只读：`check`、五块都在、场景块 10 项关键状态与 `src/server/demo/showcase-expected.json` 一致；不一致写明期望与实际、退出码 1；过了准备的营业日不核对技师在岗与估清 |
| `demo-reset --confirm <库名>` | 只在 `APP_ENV=development`、实例标识不是 prod / shadow / test；先备份（`BACKUP_PATH`），三项都满足才清库：`pg_dump` 写出文件（大小与摘要记在 `.json`）、在临时库完整恢复并算出指纹、这个指纹与备份前现在的库相同；之后清空这个库、从零 `demo-prepare`；请先停应用（清库等锁 10 秒拿不到就放弃，库不变） |
| 开班规则 | 五条 `seed-*` 灌数据时临时关掉「收款前必须先开班」，结束后连同修改时间、修改人原样恢复（原来改了修改时间，重复执行指纹会变） |
| CI 提速（RQ-008） | 各 job 同时开始；浏览器验收按文件名拆三组并行 + 汇总核对（三组都交回、合计 = 不拆分时 `--list` 总数、没有失败或重试后才通过）；集成测试按文件并行（每进程一个测试库，每文件从迁移好的模板库整库复制）；缓存 Playwright 浏览器 |
| CI 演示数据 job | 新库 `demo-prepare` → `check` → `demo-check` → 再执行跳过且指纹不变 → 试用 / 正式下 8 条命令拒绝且不写 → `demo-reset` 拒绝场景 → 起应用、浏览器只读核对（`e2e/demo-showcase.spec.ts`）→ 再核对 → 停应用、`demo-reset` 先备份再重建 → 核对 |

## 2. 演示数据与固定预期

- 新库执行 `demo-prepare`：前五块与以前的五条命令完全相同（各自的固定预期不变：`frontdesk-expected.json`、`billing-expected.json`、`legacy-expected.json`、`inventory-demo.json`），之后加场景块。
- 场景块的固定预期在 `src/server/demo/showcase-expected.json`：在店客人「演示客人甲 / 乙 / 丙」；`W301` 在住、`W302` 待打扫、`W303` 维修；钟单乙 `D01` 服务中（`T301`）、丙 `D02` 待上钟（`T302`）、甲 `D03` 已下钟（`T302`）；`D01`–`D03` 在岗、`D04` 不在；厨房：演示1号桌简餐 2 份已上、果汁 1 杯待出，丙的果汁 1 杯待出；演示果汁估清；演示1号桌 2 人；在用底图配上轮廓的样例房间 `T301`、`T302`、`V312`、`W301`、`W302`、`X201`；位置：甲 `W301`、乙 `T301`、丙 `V312`、`D01` `T301`、`D02` 样例接待区、`D03` 样例技师休息区、`D04` 没有位置；刷卡点 `DEMO-R1`、`DEMO-R2`。
- `check` 在新准备的演示库上 49 项全 ✓（与 v0.7.17 相同，这一版没加自检项）。
- 平时的浏览器验收（`npm run e2e`）照旧只需要五块演示数据；`e2e/demo-showcase.spec.ts` 要在 `demo-prepare` 准备好的库上、设 `E2E_DEMO_SHOWCASE=1` 才跑。

## 3. 验收要点

| # | 操作 | 预期 |
| --- | --- | --- |
| D1 | 新建空库，`APP_ENV=development` 执行 `demo-prepare` | 六块都「已写入」；`check` 49 项、`demo-check` 全 ✓；退出码 0 |
| D2 | 记下 `fingerprint`，再执行一次 `demo-prepare` | 六块都「已存在，跳过」；指纹不变 |
| D3 | 用店主 `linlan` / `yuzu2026` 登录看：前台、客房（看板与平面图）、钟房、餐饮（厨房、估清）、ERP「旧账对照」 | 与第 2 节的预期一致：平面图 `T301` 服务中且 2 人、`W301` 在住 1 人、`V312` 1 人；「人员」名单有三位演示客人（手牌号）与 `D01`–`D03` |
| D4 | 在 D1 的库上把一间演示房改成「已打扫」后执行 `demo-check` | 只有「客房房态」✗，写明期望与实际；退出码 1 |
| D5 | 新库先执行五条 `seed-*`，再在后台把实时位置关掉（或建一位工号 `D01`、不是演示的技师）后执行 `demo-prepare` | 前五块跳过；场景块一条不写（执行前后数据指纹相同），逐条列出冲突与处理办法；退出码 1 |
| D6 | `APP_ENV=trial`、`APP_ENV=production` 分别执行 `demo-prepare`、`demo-check`、`demo-reset --confirm <库名>` 与五条 `seed-*` | 全部拒绝（提示含「禁止」），数据指纹不变 |
| D7 | `demo-reset` 不带 `--confirm`、库名写错、`YUZU_INSTANCE=test` / `shadow` 时执行 | 拒绝，指纹不变 |
| D8 | 停掉应用，`BACKUP_PATH=<目录> demo-reset --confirm <库名>` | 先打出「已备份（N KB），在临时库恢复核验，数据指纹与现在的库一致」与备份文件；之后从零准备，`demo-check` 全 ✓；`BACKUP_PATH` 里有 `*-demo-reset.dump` 与 `.json`，用 `verify-backup` 核验通过 |
| D9 | 应用开着时执行 D8 | 等锁约 10 秒后拒绝清库（「数据库正被别的连接使用」），库不变，备份已做好 |
| D10 | 营业日切换后 5 个半小时内（默认 06:00–11:30）在新库执行 `demo-prepare --previous-day` | 前台、结账两块放到前一个营业日（提示写明）；场景块按执行当时写，并提示不随 `--previous-day` 前移 |
| C1 | 看 PR #34 的 CI | 6 个 job 同时开始（汇总等三组浏览器验收结束）；汇总写明三组合计 385 项（通过 211、跳过 174、失败 0）；演示数据 job 摘要写明 `demo-prepare` 与 `demo-reset` 的用时 |
| C2 | 本机 `npm test` | 默认 4 个进程并行，约 1.5–2 分钟全过；`TEST_WORKERS=1 npm test` 单库串行也全过 |

## 4. 已执行的验证

- `npm run typecheck`、`npm run build` 通过；`npm test` 本机 65 个文件、668 项全过（约 97 秒）；新增 `tests/demo-prepare.test.ts` 8 项（含中途出错接着补、冲突整块不写、指纹不变、`demo-reset` 的拒绝与重建）。
- 本机命令行：新库 `demo-prepare` 全过；再执行全部跳过、指纹不变；试用 / 正式下 8 条命令 × 2 个环境全部拒绝、指纹不变；`demo-reset` 三种拒绝；真实备份的 `demo-reset` 连做两次（备份约 630 KB、临时库恢复核验通过且指纹与现在的库一致、从零重建、`demo-check` 全过，每次约 14 秒）。集成测试另验：备份没核验通过、恢复出来的指纹与现在的库不同时都不清库。
- 本机浏览器：在准备好的演示库上 `e2e/demo-showcase.spec.ts`（门店电脑）通过，跑完 `demo-check` 全 ✓；平时的用例总数仍是 385。
- CI：`c7f5a5d`（只改 CI 与测试）整次 6 分 56 秒（原 23 分 36 秒），各 job 用时与运行机分钟数见 `docs/TESTING.md` 第 5 节；之后的提交加上演示数据 job，见 PR #34。

## 5. 给测试 AI 的指令（可复制）

```text
在独立的新演示库上验收 yuzu v0.7.18（PR #34，测试完整 SHA 写在报告里），只用合成数据，不连任何门店环境：
1. 新建空库，APP_ENV=development 执行 node dist/server/cli.js demo-prepare：六块都「已写入」，check 49 项与 demo-check 全 ✓（D1）。
2. 记下 fingerprint，再执行一次 demo-prepare：全部跳过、指纹不变（D2）。
3. 起应用，用 linlan / yuzu2026 看前台、客房（看板与平面图「人员」）、钟房、餐饮厨房与估清、ERP 旧账对照，与 docs/HANDOFF_V0718.md 第 2 节一致（D3）；
   或 E2E_DEMO_SHOWCASE=1 E2E_BASE_URL=… npx playwright test e2e/demo-showcase.spec.ts --project=门店电脑。
4. 按 D4–D10 逐项做：demo-check 写明不一致、冲突整块不写、试用 / 正式全部拒绝、demo-reset 的拒绝与先备份再重建、应用开着时不清库、--previous-day。
5. 跑一次完整的 npm test（默认并行）与 TEST_WORKERS=1 npm test；看 PR 上 CI 的浏览器验收汇总（385 = 211 + 174）。
报告写明测试 SHA、环境、未测项（受阻未测不记通过）、问题清单（P1 / P2 附复现步骤）。
```
