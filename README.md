# 浴族 yuzu · 门店经营系统

面向自有汤泉门店的经营系统：一个代码库、一套数据库，门店各岗位在浏览器里用（台式收银机、手持点单机、平板，见 [目标设备](docs/DEVICES.md)）。

![前台 · 在店手牌](docs/screenshots/fd-desktop-board.png)

## 有哪些模块

| 工作区 | 模块 |
| --- | --- |
| 门店 | 前台手牌与收银（接待、挂账、结账、反结账、退款、交班）、钟房与技师、餐饮与桌台、客房、预约、会员工作台（充值、消费、撤销、发券、次卡）、流水与日结、客户部、管家部、对客导览、设备 |
| ERP | 库存、采购与采购需求单、部门小仓、应付货款、资产与易耗、布草洗涤、审批中心、合同、付款、费用与备用金、零采备用金、发票台账、开票、银行流水、应收与挂账、营业数据 |
| 后台 | 规则总表与门店基本规则、数据字典与字段、会员体系、券、签赠、价目与套餐、技师、餐饮、电子菜单、UI 工作台、客房、预约、空间台账、设备、对外接口、微信小程序、门店与主体、员工账号、岗位权限、员工食堂、安保巡场、期初与旧账、操作审计、数据看板 |
| 单独的入口 | 平板电子菜单（`/emenu`）、员工手机端「柚子饭堂」（单独的端口）、微信小程序（小程序线，`miniprogram/` 与网关） |

每个模块的设计在 [`docs/`](docs/README.md)（文档索引）；每一版改了什么在 [`CHANGELOG.md`](CHANGELOG.md)。所有没定的经营规则都用模拟的默认值并在界面上标「待确认」，见 [待确认经营事项](docs/PENDING_DECISIONS.md)；演示数据全部是合成的。

## 文档从哪看起

| 你是 | 先看 |
| --- | --- |
| 开发、测试、验收的 AI | [`AGENTS.md`](AGENTS.md)（协作约定的入口，按任务指到各专题文档） |
| 想知道项目走到哪了 | [推进路线](docs/ROADMAP.md) · [变更记录](CHANGELOG.md) |
| 要部署、发版、回滚 | [Mac mini 部署手册](docs/DEPLOY_MAC_MINI.md) · [测试服部署手册](docs/DEPLOY_TEST_SERVER.md) · [正式版的环境安排](docs/RELEASE_V800.md) |
| 要在测试服上评测 | [上线评测说明](docs/EVALUATION.md) |
| 找某个模块的设计、某一版的交接说明 | [文档索引](docs/README.md) |

## 技术选择

| 部分 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript（前后端统一） | 金额计算、扣款规则、权限矩阵在前后端共用同一份代码（`src/shared/`），界面预览与实际入账算法一致 |
| 后端 | Node.js 22 + Fastify 5 | 成熟、轻量、启动快；单进程即可满足单店并发 |
| 数据库 | PostgreSQL 16 | 事务、行锁、约束和触发器可靠，适合「单据、余额、流水一起成功或一起失败」 |
| 数据访问 | postgres.js + 手写 SQL 迁移 | 账务 SQL 清晰可审阅，不隐藏锁与事务细节；迁移只增不改 |
| 前端 | React 19 + Vite + Tailwind CSS 4 + TanStack Query | 构建产物为静态文件，由后端统一托管；字体与图标随应用打包，局域网内不访问外网 |
| 运行 | Docker Compose | Mac mini（Apple Silicon）与 Linux 一致；重启自动恢复；数据卷持久保存 |

## 本地开发

需要：Node.js 22+、Docker（只用来跑数据库）。

```bash
npm install
docker compose -f compose.dev.yaml up -d      # 启动开发数据库（同时创建测试库 yuzu_test）
cp .env.example .env                          # 然后把 .env 改成下面这几行
```

```ini
APP_ENV=development
DATABASE_URL=postgres://yuzu:yuzu_dev_only@127.0.0.1:5432/yuzu_dev
PORT=8080
```

```bash
npm run cli -- demo-prepare   # 一条命令准备完整的演示库（只在独立的开发 / 演示库；说明见 docs/DEMO_DATA.md）
npm run dev                   # 后端 :8080 + 前端 :5173（热更新），浏览器打开 http://localhost:5173
```

演示账号：店主 `linlan`、店员 `xiaozhou`，密码 `yuzu2026`（只在有演示数据时登录页会提示）；各岗位的演示账号见 [演示数据](docs/DEMO_DATA.md)。

写完代码先过检查，再跑和改动相关的用例，交 PR 前跑全量：

```bash
npm run typecheck && npm run check:code && npm run format:check   # 类型、代码整洁、排版
npm run check:docs && npm run check:gov                           # 文档检查、治理基线
npx vitest run tests/<相关的>.test.ts                              # 用 yuzu_test 库（会清空该库）
npm test && npm run build                                         # 全量集成测试与构建
```

全部命令在 [`docs/COMMANDS.md`](docs/COMMANDS.md)，改了什么先跑哪些用例在 [`docs/TESTING.md`](docs/TESTING.md)。

## 部署

详细步骤见 **[Mac mini 部署手册](docs/DEPLOY_MAC_MINI.md)**（云服务器见 [测试服部署手册](docs/DEPLOY_TEST_SERVER.md)），简要流程：

```bash
git clone https://github.com/Venture-VV/yuzu.git && cd yuzu
git checkout <版本标签>             # main 上最新的版本标签（git tag --sort=-creatordate | head -3），不部署开发分支
cp .env.example .env                # 修改数据库密码、初始店主、备份目录、实例标识 YUZU_INSTANCE
export YUZU_VERSION=$(git describe --tags --always) YUZU_COMMIT=$(git rev-parse HEAD)   # 页面显示版本与 SHA
docker compose up -d --build
docker compose ps                   # app / db 显示 healthy，backup 显示 Up
```

**开发、演示、测试服、正式服互相隔离**：各自使用独立的 `.env`、数据库卷与备份目录，每个实例设置 `YUZU_INSTANCE`，登录页与导航栏常显实例标识与「版本 + SHA」。演示数据的命令在试用、正式环境一律拒绝执行（红线见 [`AGENTS.md`](AGENTS.md)）。

## 设置管理员

二选一：

1. **首次启动自动创建**：在 `.env` 设置 `INIT_OWNER_USERNAME` / `INIT_OWNER_PASSWORD`（至少 8 位，含字母和数字）。仅在数据库里还没有任何员工时生效，该店主首次登录必须修改密码。
2. **命令行创建**：
   ```bash
   docker compose exec app node dist/server/cli.js create-owner boss --name 林岚
   ```
   会输出一个临时密码。

之后添加员工、重置密码、停用账号都在管理后台「员工账号」中完成。店主忘记密码时：

```bash
docker compose exec app node dist/server/cli.js reset-password boss
```

## 更新、备份与恢复

```bash
./scripts/update.sh <版本标签>          # 更新（先自动备份）；只接受已合并进 main 的版本标签或完整 SHA
./scripts/rollback.sh                   # 回到上一次更新之前的版本
./scripts/backup.sh                     # 手动备份：导出后在临时库恢复一遍、跑自检并记下数据指纹
./scripts/verify-backup.sh <备份文件>    # 核验一份备份，不碰当前数据库
./scripts/restore.sh <备份文件>          # 恢复：先核对摘要、备份当前数据，启动前比对数据指纹
```

- 应用启动时自动执行数据库迁移。
- `backup` 服务按 `BACKUP_INTERVAL_MINUTES`（默认 60 分钟）自动备份到 `BACKUP_DIR`，每份都试恢复并核验。
- `./scripts/watchdog.sh` 由宿主机每 5 分钟运行：应用健康、备份新鲜度与核验结果、磁盘空间、异地副本，异常推到企业微信群。
- 版本标签由 CI 自动打：合并到 `main`、CI 通过后按 `package.json` 的版本号创建 `vX.Y.Z`。

细节与演练步骤在部署手册。

## 账务设计要点

- **金额一律为整数「分」**，前后端都不使用浮点数计算金额。
- **本金与赠金分账**：会员表分别保存本金、赠金余额；充值的实收金额等额计入本金，赠送部分计入赠金；数据库约束保证两者都不会小于 0。
- **一笔操作 = 一个事务**：单据、流水、余额在同一事务内写入，要么全部成功，要么全部不生效。
- **唯一的记账来源是余额流水表**（`ledger_entries`）：每笔余额变化一行，记录变动前后余额、关联单据和经办人。日结时逐项核对：单据合计 = 流水合计、期初 + 变动 = 期末、每笔流水余额连续、会员余额 = 全部流水之和。
- **只追加、不修改**：已生效的单据、流水、审计记录由数据库触发器禁止修改和删除；纠错只能通过撤销、作废、冲销并留原因与经办人。
- **防重复与防透支**：每次提交带一个操作编号（幂等键）；服务端先加锁，再检查该编号是否已处理，重复提交直接返回第一次的结果；并发扣款在锁内串行执行，余额不足即拒绝。加锁顺序见 [`docs/LOCKING.md`](docs/LOCKING.md)。
- **以确认内容为准**：提交时带上员工确认时看到的应扣金额、会员余额和本金 / 赠金扣款构成；期间价格、余额或规则变了，服务端拒绝并要求按最新数字重新确认。
- **超时可查，关闭也不丢**：提交前先把操作编号和原请求保存在本机浏览器并读回核对；页面超时、断网或服务器异常时显示「结果待确认」，只读查回查不到不能断定没生效，只能原样重提或经服务端确认作废后再重新填写。
- **日结读同一时刻的数据**：日结查看、导出和确认都在同一个数据库快照里汇总。

## 测试

推送到 GitHub 后，`.github/workflows/ci.yml` 自动执行：类型检查、代码整洁与排版检查、文档检查与治理基线、全部集成测试（每个进程一个独立测试库）、构建、从上一发布版本的演示库升级后自检、演示数据准备与核对，并在合成演示库上跑真实浏览器验收（五种视口）。只使用合成数据与一次性的 CI 数据库，不连接任何门店环境。分层、对照表与实测用时见 [`docs/TESTING.md`](docs/TESTING.md)。

## 目录结构

```
src/
  shared/          前后端共用：金额、扣款规则、权限表、营业日、各模块的类型与登记处（后台分区 admin.ts、ERP 模块 erp.ts）
  server/
    migrations/    SQL 迁移（按文件名顺序执行，只增不改）
    auth/          密码、会话、权限守卫
    lib/           公共小工具：幂等、事务、日期、规则设置、多门店上下文、过载保护
    modules/       各业务模块（会员钱包、前台、库存采购、合同付款、餐饮、客房……）
    ops/           自检、数据指纹、备份与核验、每日对账包
    demo/          演示数据与固定预期结果
    cli.ts         运维命令（docs/COMMANDS.md）
  client/
    components/    公共部件（docs/CONVENTIONS.md）
    features/      各模块的页面
    lib/           请求层、连接状态、定时取数、动效
  canteen-app/     员工手机端「柚子饭堂」
  gateway/         微信小程序网关（小程序线）
miniprogram/       微信小程序（小程序线）
tests/             集成测试（Vitest，真实 PostgreSQL）
e2e/               浏览器验收（Playwright）
scripts/           运维脚本（备份、更新、回滚、看门狗）与检查脚本（check-code、check-docs、check-governance）
docs/              文档（索引在 docs/README.md）
brand/             品牌资料（不进镜像）
```
