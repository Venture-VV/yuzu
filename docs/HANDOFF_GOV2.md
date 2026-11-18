# 工程治理二期 交接说明 · 代码瘦身与代码规范

主线的工程治理线（方案 `docs/GOVERNANCE.md`，一期交接 `docs/HANDOFF_GOV1.md`）。这一期**页面与接口的行为不变、没有迁移、不动小程序线的目录**：删没人用的代码、接入 lint、合并一处重复、对齐依赖声明、给首屏主包设上限。默认做法 `docs/PENDING_DECISIONS.md` 末尾「工程治理」ZL2（改了说法）、ZL6、ZL7。

## 0. 升级后会看到的变化

- **页面、数据、接口都没有变化。** 唯一看得出的一处：五个导入页（空间台账、货款期初、库管入库台账、部门表格、集采清单）选了不支持的文件时，提示统一成一句「只能导入 Excel（.xlsx）或 CSV（.csv）文件；老版本的 .xls 请另存为 .xlsx 或 CSV」（原来两种说法）。
- **CI 多两步**：`npm run lint`（oxlint）、构建之后的 `npm run check:bundle`。
- **`npm run check:gov` 多查一样**：依赖的声明与用到的对不上。

## 1. 范围

| 做了什么 | 文件 |
| --- | --- |
| 删掉导出了却没有任何地方引用的声明 66 个，连带没用到的导入 12 处 | `src/shared/` 24 个文件、`src/server/modules/` 12 个、`src/client/` 7 个、`src/canteen-app/` 2 个（清单见提交「工程治理二期（一）」） |
| 接入 oxlint 1.91.0（固定版本），`npm run lint` | `.oxlintrc.json`、`package.json`、CI；自动修约 50 处、手工改 38 处 |
| 五个导入页的「读表格文件」合成一个 | `src/client/lib/import-file.ts` 的 `loadTableFile`；`SpaceImportCard`、`payables/ImportPage`、`DirectImportPage`、`RequestSheetImportPage`、`RequestImportPage` |
| 依赖声明对齐，进治理基线 | `package.json`（`postcss`、`lightningcss` 补声明，版本与锁文件里原来的一样）、`knip.json`、`scripts/check-governance.mjs`、`scripts/studio-mp-shots.mjs` |
| 首屏主包的体积上限 | `scripts/check-bundle.mjs`、`scripts/governance-baseline.json`（`entryChunkMaxKb`）、CI |

## 2. 逐项说明

### 2.1 删掉的 66 个声明

- 来源：`knip`（`knip.json`，`ignoreExportsUsedInFile`）报「导出了、整个仓库（含用例）没有任何地方引用、本文件里也没用」。
- 删法：脚本按语法树删整条声明与紧挨着它的注释（隔着空行的注释是上一段的标题，留着），逐条看过差异。
- 删完再跑 `check:code`：带出 12 处没用到的导入与 1 个本地函数，一并删掉；再跑 `check:gov`：带出 1 个连带没人引用的常量，也删了。
- **小程序包会直接引主线的三个文件**（`src/shared/mp.ts`、`guide.ts`、`catalog.ts`），knip 不看小程序目录。核对过：删的名字都不在这三个文件里，小程序目录里也没有用到（CI 的「小程序：类型检查」兜底）。
- 也核对了另外两条开着的分支（#127、小程序线）新加的代码没有用到这些名字。
- 留着没删的 2 个：`payments/requests.ts` 的 `payoutRequestId`、`shared/inventory.ts` 的 `TRANSFER_DOC_TYPES`——文件正被 #127 改，等它合并后再清。

删掉的里面值得知道的几类：

| 类别 | 例子 | 为什么成了死代码 |
| --- | --- | --- |
| 旧的快捷原因清单 | `VOID_REASONS`、`SWAP_REASONS`、`CANCEL_REASONS`、`LOCK_REASONS`、`REVERSAL_REASONS` | 8.0.21 起快捷原因在数据字典里维护 |
| 旧的写死的数值 | `SMS_MAX_ATTEMPTS`、`BUDGET_WARN_MIN` / `MAX`、`EMENU_MAX_SLOTS`、`MAX_DINING_GROUP` | 改成了可调的数值，或约束在数据库里 |
| 没有调用方的查询钩子与小函数 | `useActivity`、`useApprovalCount`、`useInvoiceTodo`、`reviewOrder`、`unknownPlaceholders` | 页面改版后不再用 |
| 没用到的标签表与类型 | `MEMBER_STATUS_LABELS`、`TECH_STATE_LABELS`、`BookingCreateInput` 等 | 声明了没有地方读 |
| 一整个没人用的部件 | 管家部的 `SystemMemberResults`（42 行）、饭堂的 `Squiggle` | 页面改版后留下的 |

### 2.2 oxlint

- 规则：`correctness` 一类全开（会出错的写法），插件 `typescript`、`unicorn`、`react`、`oxc`。1,150 个文件不到一秒。
- 关着的：React 编译器那一组与 hooks 依赖数组（共 205 处，ZL6）；`no-control-regex`（代码里有意处理控制字符）；浏览器用例里的空解构（Playwright 的写法）。
- 改动都是不改行为的写法调整：
  - `{ ...DEFAULT, ...(row?.value ?? {}) }` → `{ ...DEFAULT, ...row?.value }`（展开 `undefined` / `null` 本来就什么都不加）；
  - `[...new Set(x)]` 只用来遍历的去掉外面那层；正则判断开头结尾改成 `startsWith` / `endsWith`；
  - 逗号表达式当语句的 20 处改成块：`if (k) (setKind(k), filled.push('kind'));` → `if (k) { setKind(k); filled.push('kind'); }`（发票识别带出那几段，求值顺序不变）；
  - 客户部「一行两格」的元组数组里的金额部件加 `key` 14 处；
  - 管家部小票识别里 `a?.[k]!` 去掉多余的非空断言 4 处（类型上本来就允许没有）。

### 2.3 `loadTableFile`

原来五个页面各有同样的七行：`.xlsx` 转 base64、`.csv` 识别 UTF-8 / GBK、别的格式提示。现在都调 `loadTableFile(file)`，不支持的格式抛错、由页面原来的 `catch` 显示。换文件期间晚回来的读取结果照旧丢掉（各页的 `selection` 计数没动）。

### 2.4 评估后没做的

见 `docs/GOVERNANCE.md` 第 3 节「评估后不做的」：收回多余的 `export`、字号换令牌、颜色换变量、结账弹窗的公共段、读规则设置的两行、首屏主包拆分。每一项都写了原因。

## 3. 已执行的验证

- `npm run lint`、`npm run typecheck`、`npm run check:code`、`npm run check:docs`、`npm run check:gov`、`npm run format:check`：通过。
- `npm test`（全量集成测试）与 `npm run build`、`npm run check:bundle`：结果见 PR 说明。
- 浏览器用例（本机，门店电脑尺寸，独立演示库）：改到的页面对应的几组，结果见 PR 说明。
- 反例：去掉 `postcss` 的声明，`check:gov` 报「用到了没声明」；用例里有超过上限时 `check:bundle` 报错的一条。

## 4. 验收要点

1. **导入照常**：五个导入页各导一份 `.xlsx` 与一份 GBK 的 `.csv`，预览与结果与上一版一致；选一份 `.xls` 或图片，看到统一的那句提示。
2. **发票识别带出**：登记发票（ERP「发票台账」）、付款里的登记发票、报销单里的发票三处，用带二维码的发票图识别，带出的号码、日期、类型、金额、税率与上一版一致（这三处改了写法）。
3. **客户部**：业绩、详情、表单里金额照常显示，浏览器控制台没有「缺 key」的警告。
4. **检查拦得住**：
   - 任意文件里加一个没人用的 `export const X = 1;` → `npm run check:gov` 报「导出了却没有任何地方引用」；
   - 页面里写 `[<b>a</b>, <b>b</b>]` 这样的数组不加 `key` → `npm run lint` 报错；
   - 在 `src/client/App.tsx` 里直接 `import 'pdfjs-dist'` 再构建 → `npm run check:bundle` 报首屏主包超上限。

## 5. 给测试 AI 的指令

```
【主线·测试】→ 主线 · PR #<号> · <完整 SHA>
1. npm ci && npm run lint && npm run typecheck && npm run check:code && npm run check:docs && npm run check:gov && npm run format:check
2. TEST_DATABASE_URL=<独立测试库> npm test
3. npm run build && npm run check:bundle
4. 独立演示库上跑：e2e/erp-819、request-sheet、purchasing-v801、spaces、supplier-settlement、invoice-scan、budget-invoices、payments、expenses、customer（--project=门店电脑）
5. 照「验收要点」第 4 条逐项试一遍，试完撤掉
```

## 6. 没做的、留给后面的

- 三期：测试分三档、用例体检、覆盖率基线、CI 提速、界面规范与共享组件约束、字号收并的对照。
- ZL6（React 编译器规则 205 处）、ZL7（找不到调用方的接口）。
