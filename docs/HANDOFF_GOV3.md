# 工程治理三期 交接说明 · 测试分层与界面规范

主线的工程治理线（方案 `docs/GOVERNANCE.md`；一期 `docs/HANDOFF_GOV1.md`，二期 `docs/HANDOFF_GOV2.md`）。这一期**不改业务代码、没有迁移、不动小程序线的目录**：加的是脚本、检查、文档和一处 CI 调整。默认做法 `docs/PENDING_DECISIONS.md` 末尾「工程治理」ZL2（字号）、ZL8（CI 的测试步骤）。

三期做完，工程治理这条线收口；以后照 `docs/GOVERNANCE.md` 第 5 节的长期规则维护。

## 0. 升级后会看到的变化

- **页面、数据、接口都没有变化**（`src/` 下一个文件都没改）。
- 多两条命令：`npm run test:unit`（不要数据库，8 秒）、`npm run test:quick`（秒级 + 和改动沾边的集成测试）。
- `npm run check:gov` 多查四条约定与「用例里不许留 `.only`」。
- CI「类型检查 · 集成测试 · 构建」少一步单独的类型检查（`check:code` 带着跑），快 50 秒。
- 多三份文档：`docs/TEST_AUDIT.md`（用例体检）、`docs/DESIGN.md` 多了三节、`.claude/skills/yuzu-govern/SKILL.md`（巡检步骤）。

## 1. 范围

| 做了什么 | 文件 |
| --- | --- |
| 测试分三档 | `scripts/test-tiers.mjs`、`vitest.unit.config.ts`、`tests/app-only-env.ts`（两份配置共用的环境变量清理）、`package.json`（两条命令） |
| 约定写成检查 | `scripts/check-governance.mjs`、`scripts/governance-baseline.json`（多一项 `conventions`） |
| 用例体检 | `docs/TEST_AUDIT.md` |
| 界面规范 | `docs/DESIGN.md`（补字号、公共部件清单、写成检查的约定三节，原有内容没动） |
| CI | `.github/workflows/ci.yml`：去掉主线 job 里单独的 `npm run typecheck`（小程序 job 的没动） |
| 巡检 | `.claude/skills/yuzu-govern/SKILL.md` |
| 文档 | `AGENTS.md`（开发约定小节与常用命令各一行）、`docs/COMMANDS.md`、`docs/TESTING.md` 第 4 节、`docs/GOVERNANCE.md` |
| 用例 | `tests/test-tiers.test.ts`（7 条）、`tests/check-governance.test.ts`（多 6 条） |

## 2. 逐项说明

### 2.1 秒级一档是怎么认出来的

`scripts/test-tiers.mjs` 对每个 `tests/*.test.ts` 顺着导入关系往下找（相对路径与 `@shared` 别名），碰到下面任何一个就算「要数据库」：

- `tests/helpers.ts`、`tests/test-db.ts`（用例的公共准备：建库、迁移、起应用）；
- `src/server/db.ts`，或者直接 `import ... from 'postgres'`。

只引类型的不算（`import type`、花括号里全是 `type` 的）；动态 `import()` 算，按语法树找、不看字符串里的字样。剩下的 36 个文件用 `vitest.unit.config.ts` 跑——它与 `vitest.config.ts` 的差别只是没有 `globalSetup`（建测试库那一步）。

不用改文件名、不用维护清单：以后写纯计算的用例，只要不引 `tests/helpers.ts`，它自己就进这一档。

### 2.2 快测是怎么挑的

改到的文件（相对 `origin/main` 改过的 + 还没提交的）→ 模块名（`src/server/modules/coupons.ts` → `coupons`，`src/client/features/frontdesk/…` → `frontdesk`）→ 用例文件名里带这个词或它的单数的（`coupons` 对上 `coupon-campaigns`）。先跑秒级那一档，再跑挑出来的。

它是按文件名猜的：改钱包会影响前台的用例，这种它找不到。所以输出里写着「不能代替全量」，`AGENTS.md` 的门禁照旧是全量。

### 2.3 进检查的四条约定

都是 `docs/CONVENTIONS.md` 里已经有的（8.1.3 网络波动防护、8.1.4 屏幕高度），原来只写在文档里：

| 约定 | 查什么 | 现在几处 | 放过的 |
| --- | --- | --- | --- |
| 判断断网按 `lib/connection` | 页面代码里的 `navigator.onLine` | 1（员工手机端自己的断网提示） | `lib/connection.ts` 自己 |
| 判断「服务端明确没处理」用 `isRejected` | 页面代码里的 `status < 500`、`status >= 500` | 2（供应商公开页、员工手机端各自的请求层） | `lib/api.ts` 自己 |
| 新的定时取数用 `useLivePoll` | `src/client/features/`、`components/` 里的 `refetchInterval`（react-query 的定时取数） | 64 | `lib/` 里的公共小工具；`setInterval` 不查（见第 2.5 节） |
| 行内样式里不写 dvh | 字符串里的 `100dvh` 这类（带方括号的类名写法不算） | 1（员工手机端的开场动画） | — |

存量记数、不许变多；注释里提到这些写法不算。64 处定时取数是 `useLivePoll` 出来之前写的，不要求现在改。

### 2.4 用例体检的结论

`docs/TEST_AUDIT.md`。一句话：没有被悄悄跳过的、没有只靠 mock 的；有 9 条浏览器用例 CI 里从没执行过（8 条要模拟接口、1 条要小程序端口）；CI 从 7 分钟涨到 19 分钟，卡在浏览器验收「门店电脑 a–l」那一组。

要改 CI 测试步骤的四条（带模拟接口起应用、接上原路退回那一条、重新分组、「看数据」的跳过在 CI 里改成断言）写成了给测试会话与 Codex 的建议，开发会话没有动（ZL8）。

### 2.5 Codex 审查（`ca1f116`）后的两处修改

1. **「定时取数」原来把所有 `setInterval` 都算了进去**，钟房的倒计时、导览的轮播这类纯界面的计时器也被记数；以后新写一个合法的界面计时器会被拦下，还被提示换成语义不同的 `useLivePoll`。改成只认 `refetchInterval`（它一定是在取数）；`setInterval` 的回调里取没取数静态分不清，不查。基线 76 → 64，加了界面计时器不报的用例。
2. **秒级一档的配置漏了「清掉只给应用用的环境变量」**（`INTEGRATIONS_MOCK`、访问网段、频率限制等，全量配置里 8.1.5 加的）：终端里带着 `INTEGRATIONS_MOCK=true`、`YUZU_INSTANCE=test` 起过应用再跑 `npm run test:unit`，`version-source` 的用例会被「正式环境不许用模拟」拦下，同一条用例在两档里结果不一样。清单与清理搬到 `tests/app-only-env.ts`，两份配置加载时都调用；加了用例核对两份配置都调了。带着这两个变量实跑过：修之前失败 2 条，修之后全过。

## 3. 已执行的验证

- `npm run lint`、`npm run check:code`（含类型检查）、`npm run check:docs`、`npm run check:gov`、`npm run format:check`：通过。
- `npm run test:unit`：36 个文件、310 条，8 秒，不起数据库。
- `npm test`（全量，本机 PostgreSQL 16 的独立测试库）：233 个文件、2,130 条全过（Codex 审查后的两处修改之后重跑的）。`npm run build`、`npm run check:bundle`：通过。
- 去掉 `TEST_DATABASE_URL`、`DATABASE_URL` 两个环境变量跑 `npm run test:unit`：全过（确认这一档真的不要数据库）。
- 反例（用例里都有）：页面里加一处 `navigator.onLine`、多一处 `refetchInterval`、用例里留 `.only`，`check:gov` 各自报出来并写明该怎么写。

## 4. 验收要点

1. `npm run test:unit` 在**没有数据库**的机器上能跑完、全过（把 `TEST_DATABASE_URL` 去掉试）。
2. `npm run test:unit -- --list` 列出来的文件里，没有会连数据库的。
3. 改一个模块（例如 `src/server/modules/coupons.ts` 加一个空行）后 `npm run test:quick -- --list`：挑出来的有 `coupons`、`coupon-campaigns` 等。
4. CI 的「类型检查 · 集成测试 · 构建」里，故意写一个类型错误：`类型检查与代码整洁` 那一步失败并打出错误位置（确认去掉单独的类型检查以后类型错照样拦得住）。
5. `docs/DESIGN.md` 的公共部件清单：抽几个部件核对「用在哪」的说法与代码一致。

## 5. 给测试 AI 的指令

```
【主线·测试】→ 主线 · PR #<号> · <完整 SHA>
1. npm ci && npm run lint && npm run check:code && npm run check:docs && npm run check:gov && npm run format:check
2. 不设 TEST_DATABASE_URL：npm run test:unit（应当全过）
3. TEST_DATABASE_URL=<独立测试库> npm test && npm run build && npm run check:bundle
4. 照「验收要点」第 3、4 条各试一遍，试完撤掉
5. 读 docs/TEST_AUDIT.md 第 7 节的四条建议：同意的排进你们的计划，不同意的在 PR 上说明
```

## 6. 三期合起来

| | 立项时（v8.1.9） | 三期做完 |
| --- | --- | --- |
| `AGENTS.md` | 88 KB | 19 KB，有预算（24 KB） |
| 文档 | 158 份、没有索引；`README.md` 停在 0.x | 有索引（脚本生成、CI 核对）；`README.md` 按现状重写 |
| 没人引用的导出 | 68 个 | 2 个，新的进不来 |
| 代码规范 | 排版 + 三条自定义检查 | 另加 oxlint（存量清零）、分层、依赖声明、四条约定 |
| 硬编码 | 版本号写在 5 处；颜色、字号没人管 | 版本号 1 处；颜色、字号不许再多（字号收并等店主定） |
| 测试 | 全量一档（要数据库） | 秒级 8 秒 / 快测 / 全量三档；体检过 |
| 体积 | 没有上限 | 首屏主包上限 900 KB |
| CI 的静态检查 | 类型、代码整洁、排版 | 另加 lint、文档、治理基线、打包体积 |

没做完、留着的：ZL2（字号收并）、ZL6（React 编译器规则 205 处）、ZL7（找不到调用方的接口）、ZL8（CI 测试步骤的四条建议）。
