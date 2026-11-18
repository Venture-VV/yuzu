# 工程治理一期 交接说明 · 文档收拢与护栏

主线 [PR #128](https://github.com/Venture-VV/yuzu/pull/128)。店主 2026-11-18 转来视频《如何用 AI 长期开发一个复杂项目》，让开发会话学完后给 yuzu 出一套改进方案并分三期做完。学习记录 `docs/GOVERNANCE_NOTES.md`，方案 `docs/GOVERNANCE.md`，默认做法 `docs/PENDING_DECISIONS.md` 末尾「工程治理」ZL1–ZL5（都待确认）。

这一期**不改业务行为、没有迁移、不动小程序线的目录**：只动文档、检查脚本、CI 的静态检查、版本号的读法。

## 0. 升级后会看到的变化

- **页面、数据、接口都没有变化。** 登录页与导航栏显示的「版本 + SHA」照旧（见第 3 节怎么核对）。
- **`AGENTS.md` 变短了**（88 KB → 18 KB）。它现在是入口：红线、核心规则、「按任务去哪看」。原来写在里面的三大块搬到了专题文档，文字没有改：
  - 加锁顺序 → `docs/LOCKING.md`（按模块分了八节，写哪个模块读哪一节）；
  - 全部命令 → `docs/COMMANDS.md`（每天用的几条留在 `AGENTS.md`）；
  - 功能开关、多门店、公共小工具、页面部件、登记处 → `docs/CONVENTIONS.md`。
- **`docs/README.md` 是文档索引**（163 份），分现行规范 / 模块设计 / 部署 / 小程序线 / 排期 / 交接说明（快照）/ 更新记录分卷。
- **`README.md` 按现状重写了**。原文停在 0.x（「S2 等待 G2 验收、暂不收款」「后续清单：多门店、次卡」），原样留在 `docs/changelog/README-0.x.md`。
- **`CHANGELOG.md` 只留 8.1.x**（494 KB → 41 KB），8.0.x 与 0.x 原样分到 `docs/changelog/`。
- **CI 多两步静态检查**：`npm run check:docs`、`npm run check:gov`。
- **发版只改 `package.json` 与 `package-lock.json`**：`Dockerfile`、`compose.yaml`、`src/server/config.ts` 不再各写一遍版本号。

## 1. 范围

| 文件 | 改了什么 |
| --- | --- |
| `AGENTS.md` | 收成入口。开头、「阶段与门禁」「环境隔离（红线）」「提交、PR 与评论」原样保留（只改了发版改哪几个文件那一句）；新加「按任务去哪看」「快测、门禁与高风险目录（oil-dev）」；「常用命令」只留七条；「开发约定」留七条核心规则，加锁顺序换成一句指路 |
| `docs/LOCKING.md`、`docs/COMMANDS.md`、`docs/CONVENTIONS.md` | 从 `AGENTS.md` 搬来的原文，只分了节、长句按分号拆成子项 |
| `docs/README.md` | 文档索引；两个标记之间的清单由 `npm run check:docs -- --fix` 生成 |
| `README.md`、`docs/changelog/README-0.x.md` | 重写；原文留档 |
| `CHANGELOG.md`、`docs/changelog/CHANGELOG-8.0.md`、`CHANGELOG-0.x.md` | 分卷，内容原样 |
| `scripts/check-docs.mjs` | 文档检查：`AGENTS.md` 的体积预算（24 KB）、相对链接、引用了不存在的文档、索引是否最新、开发约定小节与路径 |
| `scripts/check-governance.mjs`、`scripts/governance-baseline.json`、`knip.json` | 治理基线：分层、页面里的颜色与字号、大文件、没人引用的导出、重复率，只许持平或下降（`docs/GOVERNANCE.md` 第 8 节） |
| `package.json`、`package-lock.json` | 加 `check:docs`、`check:gov` 两条命令；开发依赖加 `knip` 6.44.1、`jscpd` 5.4.2（固定版本，都发布两周以上；锁文件只多不改） |
| `.github/workflows/ci.yml` | 「类型检查 · 集成测试 · 构建」里加两步 |
| `src/server/config.ts`、`Dockerfile`、`compose.yaml` | 版本号从 `package.json` 读；`APP_VERSION` 传了照旧优先 |
| `GEMINI.md`、`docs/TESTING.md`、`docs/ROADMAP.md`（第 13 节）、`docs/PENDING_DECISIONS.md`（末尾） | 指到新文档；登记立项与默认做法 |
| `tests/check-docs.test.ts`、`tests/check-governance.test.ts`、`tests/version-source.test.ts` | 新用例 17 条，都不要数据库 |

## 2. 「原文一个字不丢」是怎么核对的

`AGENTS.md` 的拆分是脚本做的，不是手抄：

- 加锁顺序那一行（46,783 字节）先按句号切成 67 句，第一句再按括号外的分号切成 22 段，一共 87 条；拿掉的只有那一行自己的开头「写操作带操作编号……按固定顺序加锁（」和对应的右括号（开头这一句留在 `AGENTS.md` 与 `LOCKING.md` 的总则里）。
- 脚本核对两件事，对不上就不写文件：87 条按原顺序拼回去 = 原来那一行；`LOCKING.md` 各节的列表项拼起来 = 这 87 条按新顺序拼起来。每一条必须且只能归到一节。
- 「其余约定」8 条、命令 74 条（带续行）同样核对。
- 原样保留的三节（开头、阶段与门禁、环境隔离）与原文逐行相同。

所以审查时不用逐字对照 `LOCKING.md`，看**分节合不合理**就行：某个模块的条目是不是放在了该读它的人会去找的那一节。

## 3. 已执行的验证

- `npm run typecheck`、`npm run check:code`、`npm run format:check`、`npm run check:docs`、`npm run check:gov`：通过。
- `npm test`（全量集成测试，本机 PostgreSQL 16 的独立测试库）：结果见 PR 说明。
- `npm run build`：通过；构建产物里的版本号见下。
- 版本号的读法：`tests/version-source.test.ts`（没传 `APP_VERSION` 时显示 `package.json` 的版本号；传了照旧优先、去掉开头的 v；`Dockerfile`、各 `compose*.yaml`、`config.ts`、`.env.example` 里没有当前版本号的字样；锁文件两处与 `package.json` 一致）与原有的 `tests/instance.test.ts`。
- 与 PR #127 的分支试合并：只有 `AGENTS.md` 的加锁顺序那一行冲突（它在那一行里加了一句、这边把那一行搬走了），其余自动合并。

没有做、也不需要做的：浏览器验收（页面没有改动，交给 CI 的三组）、真机。

## 4. 验收要点

1. **版本显示**（阻断项）：部署后登录页与导航栏的「版本 + SHA」与 `update.sh` 传入的一致；不经 `update.sh` 直接 `docker compose up -d --build`（没设 `YUZU_VERSION`）时显示 `package.json` 的版本号，不是空的。
2. **`AGENTS.md` 的三节原样**：`git diff <上一版>..<这一版> -- AGENTS.md` 里，「环境隔离（红线）」没有改动，「提交、PR 与评论」只有发版那一句。
3. **专题文档找得到**：`AGENTS.md`「按任务去哪看」里的每个链接点得开；`docs/LOCKING.md` 里能找到自己模块的那一节。
4. **检查拦得住**：
   - 在 `src/shared/money.ts` 里加一行 `import '../server/db';` → `npm run check:gov` 报「分层被打破」；
   - 在任意页面加 `className="text-[13.25px]"` → 报「新字号」；加 `style={{ color: '#123456' }}` → 报「颜色变多了」；
   - 在 `docs/` 下新建一份带标题的文档、不跑 `--fix` → `npm run check:docs` 报「索引不是最新的」；
   - 在任意文档里写一个指不到的相对链接 → 报「指不到文件的相对链接」。
5. **别的线正常开发不受影响**：不加新颜色、新字号、新的大文件、没人引用的导出，`check:gov` 一直通过；基线文件不用碰。

## 5. 给测试 AI 的指令

```
【主线·测试】→ 主线 · PR #128 · <完整 SHA>
1. npm ci && npm run typecheck && npm run check:code && npm run check:docs && npm run check:gov && npm run format:check
2. TEST_DATABASE_URL=<独立测试库> npm test
3. npm run build；不设 APP_VERSION 起应用（独立演示库），登录页的版本号 = package.json 的 version；设 APP_VERSION=v9.9.9 再起，显示 9.9.9
4. 照「验收要点」第 4 条逐项试一遍，每一项都应该不通过并写明原因；试完把改动撤掉
5. 核对 docs/LOCKING.md 的分节：抽 5 个自己熟悉的模块，条目在不在该在的那一节
```

## 6. 没做的、留给后面的

- 二期：删没人引用的导出、收回多余的 `export`、接入 oxlint、合并重复实现、字号与颜色进令牌、首屏主包。
- 三期：测试分三档、用例体检、覆盖率基线、CI 提速（现在整次约 19 分钟）、界面规范与共享组件约束。
- 交接说明没有搬家（ZL1）；`ROADMAP.md`、`PENDING_DECISIONS.md` 没有分卷（ZL3）。
- 设计文档、代码注释里「写进 `AGENTS.md`」的说法没有逐处改：`AGENTS.md` 的「开发约定」指到 `docs/LOCKING.md`，多一跳能找到。
