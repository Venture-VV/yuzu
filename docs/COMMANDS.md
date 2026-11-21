# 常用命令

每天用的几条在 `AGENTS.md`「常用命令」；这里是全部。命令行都是从 `AGENTS.md` 原样搬来的（工程治理一期，`docs/GOVERNANCE.md`），只分了组。新命令加在这里对应的一组。
演示数据的固定预期结果在 `src/server/demo/*-expected.json`。

## 1. 检查、构建与测试

```bash
npm run typecheck && npm run build          # 类型检查与构建
npm run lint                               # 工程治理二期（CI 跑，一秒内）：oxlint 查会出错的写法（缺 key、多余的非空断言、没用到的表达式……），配置 .oxlintrc.json；能自动改的 npx oxlint --fix；小程序线的目录不查
npm run check:bundle                       # 工程治理二期（CI 跑，要先 npm run build）：首屏主包不超过上限（scripts/governance-baseline.json 的 entryChunkMaxKb）
npm run check:code                         # 8.1.3 代码整洁检查（CI 跑）：没用到的导入与变量、事务里没等结果的查询、只用到类型的导入写成 import type；小程序线的目录不查
npm run check:docs                         # 工程治理一期（docs/GOVERNANCE.md，CI 跑）：AGENTS.md 的体积预算、指不到文件的相对链接、引用了不存在的文档、docs/README.md 的索引、开发约定小节；加了文档跑 npm run check:docs -- --fix 重新生成索引
npm run check:gov                          # 工程治理一期（CI 跑，约 5 秒）：治理基线 scripts/governance-baseline.json，只许持平或下降——分层、页面里的十六进制颜色与手写字号、超过 1,500 行的文件、没人引用的导出（knip）、重复率（jscpd）；清掉一批后 -- --update 收紧
npm run format                             # 8.1.3 排版（Prettier 固定版本，.prettierrc.json）；提交前跑一次，CI 跑 npm run format:check；小程序线的目录、迁移、静态资源不排（.prettierignore）
npm run test:unit                          # 工程治理三期：秒级一档，只跑不要数据库的用例（按导入关系自动认，-- --list 看是哪些）；不用起数据库
npm run test:plan                          # 2026-11-20：测试计划，这次改了什么、风险多高、该跑哪些、本机照着跑的命令（与 CI 同一份；--base <标签> --head <SHA> 给验收用；docs/TESTING.md 第 6 节）
npm run test:quick                         # 快测：秒级一档 + 测试计划挑出的集成测试（高风险就是全量；-- --list 先看会跑哪些）
npm run check:migrations                   # 2026-11-20：新迁移的数据风险（删数据、改账本、改类型、改名、加 NOT NULL、重建作废约束要写「-- 风险已知：」；已有迁移不许改）
npm test                                   # TEST_DATABASE_URL 指向独立测试库；按文件并行，另建 <库名>_w1…、<库名>_tpl（要建库权限；TEST_WORKERS=1 回到单库串行）
E2E_BASE_URL=http://127.0.0.1:<端口> npm run e2e   # 1440×900 / 1024×768 / 820×1180，另有 1280×720 与手机只跑视口冒烟（CI 按用时均匀分组并行，见 docs/TESTING.md 第 6 节）
```

## 2. 数据库与演示数据

```bash
node dist/server/cli.js migrate            # 应用启动时也会自动执行
node dist/server/cli.js seed-demo          # 会员与项目
node dist/server/cli.js seed-inventory-demo
node dist/server/cli.js seed-frontdesk-demo
node dist/server/cli.js seed-billing-demo  # 结账、反结账与交班（建在前台演示数据上）
node dist/server/cli.js seed-legacy-demo   # 8–10 月旧账的合成样例导入只读表（不进正式账）
                                           # 营业日切换后 5 个半小时内执行时，结账演示把开班到交班压进当天（v0.7.25，不再跨营业日）；两条都加 --previous-day 整体放到前一个营业日
node dist/server/cli.js demo-prepare       # 一条命令准备演示库（v0.7.18）：上面五块 + 场景块（客房、技师与钟房、餐饮与厨房、空间台账与底图、实时位置，v0.7.19 起加派对房使用单与对客导览）+ 会员体系块（v0.7.24：到期提醒、补充期、降档的演示会员与本店权益；v0.7.25：包房折扣、邀请人与体验中的会员），
                                           # 已有的跳过、不改已有记录，场景块有冲突时一条不写并列出；最后自带 check 与 demo-check
node dist/server/cli.js demo-check         # 核对演示库（只读）：check、五块都在、场景块与 src/server/demo/showcase-expected.json 一致
node dist/server/cli.js demo-reset --confirm <库名>   # 只在独立演示库（development，实例不是 prod/shadow/test）：先备份核验，再清库从零准备（先停应用；应用开着时拒绝）
node dist/server/cli.js check              # 会员（含营业口径）、库存、前台自检，全部 ✓ 才算一致
node dist/server/cli.js fingerprint        # 数据指纹（只读）；--expect <摘要> 比对，不一致退出码为 1
E2E_DEMO_SHOWCASE=1 E2E_BASE_URL=… npx playwright test e2e/demo-showcase.spec.ts --project=门店电脑   # demo-prepare 准备好的库上核对演示场景
```

## 3. 备份、回滚与对账

```bash
./scripts/backup.sh                        # 立即备份：临时库试恢复、自检并记下指纹（写 BACKUP_DIR，含 .json 说明）
./scripts/verify-backup.sh <备份文件.dump>  # 核验一份备份，不碰当前数据库
./scripts/rollback.sh                      # 回到上一次 update.sh 之前的版本（加了迁移时同时恢复升级前的备份；8.1.0 起先停应用再备份，恢复前列出升级以后写进系统的、当面确认）
./scripts/offsite-copy.sh [--check]        # 新备份用 age 公钥加密后经 Tailscale 传到云服务器 A（宿主机定时执行；--check 只测连通）
./scripts/daily-recon.sh [营业日]           # 每日对账包（只读）：日结汇总、结账单、部门参考表、异常清单、交班、技师业绩，写到 recon/<营业日>/
node dist/server/cli.js daily-recon --store <门店代码> [--date YYYY-MM-DD]   # 别的门店的对账包（8.0.22，目录名带门店代码；不给 --store 是本店，与上一行一样）
node dist/server/cli.js balance-changes --since "YYYY-MM-DD HH:MM"   # 某时刻之后有余额变动的会员（只读，回写 EBC 用）
node dist/server/cli.js changes-since --since "YYYY-MM-DD HH:MM"     # 某时刻之后写进系统的（只读，8.1.0）：每一张有时间列的表新增、改过的行数，余额有变动的会员，审计里的业务动作；rollback.sh 恢复前列给人看（清单只帮核对，恢复前一律当面确认）
node dist/server/cli.js membership-daily               # 会员到期处理与会员权益自动发放（v0.7.23 / v0.7.24；应用每分钟自己会跑，停机后要马上补跑时用）
```

## 4. 导入（真实业务数据：默认只预览，`--apply` 才写入，门店环境须店主同意）

```bash
node dist/server/cli.js import-hand-tags --store-list   # 预览导入店主 747 个真实柜号；--apply 才写入（真实业务数据，门店环境须店主同意）
node dist/server/cli.js import-price-list --tangqi      # 预览导入汤崎价目表（29 个项目、多档价格）；--apply 才写入（同上）
node dist/server/cli.js import-legacy <原始.xlsx> --operator <店主账号>   # 预览导入 8–10 月旧账（四份原始 Excel 之一）的只读对照；--apply 才写入（真实业务数据，门店环境须店主同意；不进正式账）
node dist/server/cli.js void-legacy-import <导入编号> --operator <店主账号> --reason <原因>   # 作废一次 8–10 月旧账只读导入（页面上不再显示，不删，v0.7.10）
node dist/server/cli.js import-opening <余额.csv> --operator <店主账号> --control 人数,本金,赠金,累计充值 [--exclude <排除清单.csv>]
                                          # 预览导入旧系统会员余额期初并与 EBC 控制总数比对；--apply 才写入（同上；正式环境必须给控制总数）
node dist/server/cli.js import-devices --quote          # 预览按需求文档的采购清单登记设备（12 类 81 台，编号已有的跳过）；--apply 才写入（真实门店数据，门店环境须店主同意）
node dist/server/cli.js import-benefits --quote        # 预览导入本店权益清单（v0.7.24，59 项，导入为草稿，编号已有的跳过）；--apply 才写入（门店环境须店主同意）
node dist/server/cli.js import-member-history <流水.csv> --operator <店主账号>   # 预览导入旧 EBC 逐笔流水（v0.7.28，只读、不进正式账，会员详情「旧系统流水」里看）；--apply 才写入（真实业务数据，门店环境须店主同意）
node dist/server/cli.js import-count-cards <旧次卡.csv> --operator <店主账号> [--batch 批次备注]   # 预览导入旧系统次卡（v0.7.28）；--apply 才写入（真实业务数据，门店环境须店主同意）
```

## 5. 底图、硬件模拟与构建资源

```bash
node dist/server/cli.js floorplan-convert <图纸.dwg|.dxf|.pdf> [--scale N]   # 底图转换（不碰数据库）：每层 SVG、spaces.geojson、报告写到 floorplan-<文件名>/；
                                           # 矢量 PDF 给了 --scale 按 1:N 换算，没给按图上的比例文字；floorplan-sample <文件.dxf|.pdf> 写出合成样例图纸
node dist/server/cli.js device-selftest                # 硬件连接一键自检（v0.7.21）：协议、ESC/POS 与 TSPL、模拟打印机与模拟桥，24 项，不连数据库、不要真机
node dist/server/cli.js device-printer-mock [--port 9100] [--mode normal|paper_out|cover_open|fault|silent|drop]
                                          # 模拟网口打印机：屏幕上显示打出来的中文；输入 mode <状态>、stop（拔线）、start（插回）
node dist/server/cli.js device-bridge-mock [--terminal <终端编号>] [--port 17890]
                                          # 模拟终端设备服务（桥）：输入 card / scan / nfc <号码>、unplug / plug <设备键>、fail；用法见 docs/HARDWARE.md 第 10 节
node scripts/check-ocr-assets.mjs [目录]   # 管家部本机 OCR 的第三方文件（8.0.12，docs/CONCIERGE.md「构建资源」）：按清单核对大小与 SHA-256；默认核对仓库里的，npm run build 的最后自动核对 dist 里的
npx tsx scripts/studio-mp-samples.ts      # 8.1.2 给小程序线的样例版面（docs/STUDIO_MP.md 第 7 节）：重新生成 tests/fixtures/studio/mp/*.json（格式或样例改了以后跑；tests/studio-mp-samples.test.ts 核对一致）
STUDIO_URL=… STUDIO_USER=… STUDIO_PASSWORD=… node scripts/studio-mp-shots.mjs   # 8.1.2 样例的截图（375 宽、两倍像素，用手机预览页 ?bare=1）：只在独立演示库或本地开发库跑（会传样例图、生成预览码，不发布）
npm run dev:canteen                        # 柚子饭堂（员工手机端，docs/CANTEEN.md）热更新：接口转到 CANTEEN_PORT（默认 8090）
```

## 6. 各个浏览器用例怎么跑

先起应用、灌演示数据（第 2 组），`E2E_BASE_URL` 指向它。改了什么先跑哪些的对照表在 [`TESTING.md`](TESTING.md) 第 4 节。

```bash
E2E_BASE_URL=… npx playwright test e2e/dictionaries.spec.ts --project=门店电脑   # 8.0.21 数据字典与自定义字段（docs/FINANCE_V8021.md 第 1 节）：后台加快捷原因 → 前台锁牌弹窗里有；建会员字段 → 详情填、列表看得到、按字段查；用完恢复原因、停用字段
E2E_BASE_URL=… npx playwright test e2e/invoice-scan.spec.ts --project=门店电脑   # 8.0.21 发票识别：合成一张左上角带二维码的发票图，登记发票时识别带出、核对后保存，台账标「二维码识别」
E2E_BASE_URL=… npx playwright test e2e/sales-invoices.spec.ts --project=门店电脑   # 8.0.21 开票申请：结账记录里申请 → ERP「开票」登记已开 → 前台看得到号码（「交给服务商开」要应用带 INTEGRATIONS_MOCK=true 启动，只在开发、测试）
E2E_BASE_URL=… npx playwright test e2e/bank.spec.ts --project=门店电脑   # 8.0.21 银行流水：新增账户、导入工商格式的 CSV（自动认列）、结息标「不用对」、同一份文件再导被拦
E2E_BASE_URL=… npx playwright test e2e/payment-batches.spec.ts --project=门店电脑   # 8.0.21 批量付款：供应商收款账户只显示后四位、付款页「批量付款」页签（整条链在 tests/payments.test.ts）
E2E_BASE_URL=… npx playwright test e2e/contract-templates.spec.ts --project=门店电脑   # 8.0.21 合同模板：「合同模板」里新建一份 → 用它起草（接口）→ 编辑页看得到模板与字段 → 打印页按模板排版、导出 Word（下载的是 zip）
E2E_BASE_URL=… npx playwright test e2e/supplier-portal.spec.ts --project=门店电脑   # 8.0.21 供应商门户：询价单生成报价链接 → 另一个没登录的浏览器在链接里报价 → 比价里标「供应商链接」；采购单发订单确认、发货预告链接 → 供应商确认、报一批 → 采购单上看得到
E2E_BASE_URL=… npx playwright test e2e/pay-terminal.spec.ts --project=门店电脑   # 8.0.21 扫码收款：结账「扫码收款」→ 到账锁定 → 结清；没入账的一笔在前台顶上原路退回（应用要带 INTEGRATIONS_MOCK=true 启动，只在开发、测试；没带时跳过）
E2E_BASE_URL=… npx playwright test e2e/platform-verify.spec.ts --project=门店电脑   # 8.0.21 平台验券：结账团购券「验券」→ 核销 → 锁定、结清；验过没结账的撤销核销；「验券对账」手动对一天（应用要带 INTEGRATIONS_MOCK=true 启动；没带时跳过）
E2E_BASE_URL=… npx playwright test e2e/ota.spec.ts --project=门店电脑   # 8.0.21 OTA：后台「客房 → 渠道」建渠道与房型对照 → 前台「预约 → 渠道订单」导入 CSV → 建好预约、没对照的没建成 → 渠道对账（房型、渠道、订单号都现造）
E2E_BASE_URL=… npx playwright test e2e/resilience.spec.ts --project=门店电脑   # 8.1.3 网络波动防护（docs/RESILIENCE_V813.md）：断网提示与恢复、断网时入账没发出去、系统忙自动重发只入账一次、页面代码重试与只重新加载一次、出错不白屏并报给服务器、系统更新提示（会写数据，只在门店电脑这一组）
E2E_BASE_URL=… npx playwright test e2e/studio.spec.ts --project=门店电脑   # 8.1.1 UI 工作台（docs/HANDOFF_V811.md）：店主建（或重置）设计师 e2esheji，第一次登录改密码 → 改起始页、拖字标、撤销重做、换主题色、发布 → 平板菜单带上这一版、预览码看得到 → 用完照默认版面再发一版、停用 e2esheji（只要 seed-demo 的店主，可重复执行）
E2E_BASE_URL=… npx playwright test e2e/v8022.spec.ts --project=门店电脑   # 8.0.22（docs/HANDOFF_V8022.md）：后台新建一家店（用完停用）、左侧导航换店、库存「调拨」页签；AI 辅助的昨日小结、问数、合同条款提示、后台开关（应用带 INTEGRATIONS_MOCK=true 时问一次；没带时核对「还没配置」）
E2E_BASE_URL=… npx playwright test e2e/v8020.spec.ts --project=门店电脑   # 8.0.20（docs/ERP_V8020.md）：用料与扣料、成本、自动补货、布草洗涤、房型会员价；物料、项目、品类都是现造的，可重复执行
E2E_BASE_URL=… npx playwright test e2e/store-entries.spec.ts --project=门店电脑   # 门店的日常入口（8.0.19，docs/IA_V8017.md 第 3.4 节）：会员工作台的「发券」「停车登记」、会员详情的「微信小程序」一行（解绑的接口在用例里是拦下来模拟的）、头像菜单的「本机终端」
E2E_BASE_URL=… npx playwright test e2e/erp-ia.spec.ts --project=门店电脑   # ERP 的信息架构（8.0.18，docs/IA_V8017.md 第 3.3 节）：导航分组、「ERP 设置」的页签与规则的旧地址、采购 / 报销的页签、员工食堂与安保巡场在后台、营业数据在数据看板、规则总表直达
E2E_BASE_URL=… npx playwright test e2e/admin-ia.spec.ts   # 后台的信息架构（8.0.17，docs/IA_V8017.md）：一级分组、设备进侧栏、二级页签写进地址、换页签不丢填的内容、旧地址跳转（门店电脑三条，平板竖屏一条）
E2E_BASE_URL=… npx playwright test e2e/purchase-flow.spec.ts --project=门店电脑   # ERP 采购流程图（8.0.17，docs/FLOW_V8017.md）：用接口造流程 A 到货超期、流程 B 询价缺报价，核对「采购 → 流程进度」与各详情里嵌的流程
E2E_BASE_URL=… npx playwright test e2e/motion.spec.ts --project=门店电脑   # 动效套件（8.0.16，docs/UI_V8016.md）：弹窗关掉马上卸掉、影子认不到、减少动态效果时不留影子、滑块跟着当前项
E2E_BASE_URL=… npx playwright test e2e/positions.spec.ts --project=门店电脑   # 组织架构与岗位（8.1.18，docs/POSITIONS_V8118.md）：添加员工先选部门再选岗位、新账号按岗位的权限、岗位权限按八列显示
E2E_BASE_URL=… npx playwright test e2e/emenu.spec.ts   # 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：整套流程只在门店电脑这一组跑（平板那一段另开 1024×768 的窗口）；地址 /emenu，用「点餐平板」岗位的账号登录；8.0.13 起含中英切换、键盘适配与动效的只读用例；8.0.15 起含「放大、不要点单密码」的只读用例（整套流程与设计稿位置核对走的是「要密码、设计稿原样」）
E2E_BASE_URL=… npx playwright test e2e/emenu-v816.spec.ts --project=门店电脑   # 8.1.6 二次整改（docs/HANDOFF_V816.md）：小米平板 6S Pro 12.4 大小（1355 × 903）上底色、压暗层、大图铺到屏幕边与右上角四样、服务员那一步的英文、装饰压不到大图上、工作台改顶栏（会写工作台的草稿、用完放回默认，不发布）
E2E_BASE_URL=… npx playwright test e2e/erp-819.spec.ts --project=门店电脑   # 8.1.9 ERP 供应链（docs/HANDOFF_V819.md）：店主填零采备用金总额 → 采购申用、提交报销（未补单）→ 按申用登记报销、确认后面板回补；库管入库手填一张（会登记单据，每次用新的说明与金额）
E2E_BASE_URL=… npx playwright test e2e/erp-8120.spec.ts --project=门店电脑  # 8.1.20 出入库台账（docs/HANDOFF_V8120.md）：库管入库页右上角三个入口；下载模板、导入一份合成的台账生成库管入库与部门领料、导出台账（会登记单据）
E2E_BASE_URL=… npx playwright test e2e/gifts.spec.ts --project=门店电脑   # 8.1.9 签赠（docs/GIFTS_V819.md）：后台建签赠券类型 → 管家部发放（授权人张经理）→ 前台结账选这张签赠券 → 客户部签赠台账里是已使用、按授权人有张经理（要 seed-demo、seed-frontdesk-demo；会登记单据，每次用新的名称）
E2E_BASE_URL=… npx playwright test e2e/erp-8110.spec.ts --project=门店电脑   # 8.1.13 ERP 采购（原排 8.1.10，docs/HANDOFF_V8110.md）：采购规则的四项新设置、急采「待补合同」；核库转领用——店主提需求单（两样新建、有期初的物料）→ 待核库里核库（第 1 行只领一部分、第 2 行提议替代）→ 同意替代 → 通过 → 待转采购单只买剩下的（会登记单据，物料编号带时间）
E2E_BASE_URL=… npx playwright test e2e/desks.spec.ts --project=门店电脑   # 8.1.15 发卡台与收银台（docs/DESKS_V8115.md）：导航里两个台；发卡台认会员档阶、加项目、换牌，没有结账；收银台只读、「权益与优惠」写着签赠的发放人与授权人；用签赠结账，结账单与小票的「优惠与赠送」写明经办人；预结账分列（合成的返回）与四种屏幕、两个台的入口按权限显示（临时改前台店员的岗位权限，用完改回；8.1.15 前台 1 细化）
E2E_BASE_URL=… npx playwright test e2e/exit.spec.ts --project=门店电脑   # 8.1.15 平板电子菜单与工作台的退出（docs/EMENU.md 第 18 节）：左下角的退出键、退出界面、按住才离开；工作台带字的「退出」、草稿没存上时先存
E2E_BASE_URL=… npx playwright test e2e/frontdesk-risk.spec.ts --project=门店电脑   # 8.1.15 前台风控（docs/FRONTDESK_RISK_V8115.md）：刷卡发牌、断网后自动重提、黑名单、未结离店授权、异常处置与待办、超时分级与后台绑卡，四种屏幕放得下；读卡器是模拟的键盘式读卡器。集成：tests/frontdesk-risk.test.ts、upgrade-frontdesk-risk、op-fences-constraint
E2E_BASE_URL=… npx playwright test e2e/frontdesk-v8117.spec.ts --project=门店电脑   # 8.1.17 前台、桌台、退菜、本店价、流水（docs/FRONTDESK_V8117.md）：「流水」的订单详情用结账单部件（四个尺寸量放得下）、超时加收按小时先填好与「超时提醒」（每分钟的任务记，最多等两分钟）、按出品口的加项目与退菜（临时改店员的岗位权限，用完改回）、桌台维修过了预计恢复时间的提醒（等 70 秒）、第二家店改本店价写原因与改价记录按门店筛（新建一家店，用完停用）；demo-prepare 的库上跑，专用的项目、会员、桌台以「E2E8117」「E8117」开头。集成：tests/frontdesk-v8117、dining-voids-v8117、tables-reminders-v8117、store-prices-v8117、upgrade-frontdesk-v8117
E2E_BASE_URL=… npx playwright test e2e/dining-v8115.spec.ts --project=门店电脑   # 8.1.15 餐饮（docs/DINING_V8115.md）：桌台动作（待清台、维修、并台 / 拆台、历史）、台账里的退菜与责任岗位、康美部按出品口下单与加料限制、按房号下单与整单备注；CI 的 seed 库或 demo-prepare 的库上都能跑，客房自己备（E8115），专用的菜、档口、桌台以「E2E 8115」开头。集成：tests/dining-v8115.test.ts、dining-v8115-orders、upgrade-dining-v8115
E2E_BASE_URL=… npx playwright test e2e/dishes.spec.ts --project=门店电脑   # 8.1.15 菜品管理（docs/DISHES_V8115.md）：菜品表、新增 / 编辑、上下架、改价与改价记录、导出与导入；四种屏幕在 e2e/target-devices.spec.ts 的 dining-dishes、dining-dish-options。集成：tests/dishes.test.ts、dishes-import、upgrade-dishes
E2E_BASE_URL=… npx playwright test e2e/room-center.spec.ts --project=门店电脑   # 8.1.16 房态中心（docs/ROOM_CENTER_V8115.md）：按房型的页签与状态数量、登记（挂账 + 派钟 + 占房）、续钟、换房、退房、维修、清洁完成、历史、断网时的结果待确认；数据自己备（空间台账三层的 Q391–Q394、专用项目「E2E 房态足疗」、技师 R98），可以重复跑；只读的那条在五个尺寸组都跑。集成：tests/room-center.test.ts、upgrade-room-center、tag-scan（不要数据库）
E2E_BASE_URL=… npx playwright test e2e/technician-admin.spec.ts --project=门店电脑   # 8.1.16 技师（docs/TECHNICIANS_V8115.md）：钟房搜索与叠加筛选、按状态排、排位播报（语音换成假的，不出声）、技师管理四个页签；会临时打开技师功能，结束时恢复。集成：tests/technician-admin.test.ts、pinyin-initials（不要数据库）
E2E_BASE_URL=… npx playwright test e2e/member-card-types.spec.ts --project=门店电脑   # 8.1.16 会员（docs/MEMBERS_V8115.md）：先选卡类型的两步建档、实体卡押金与退卡、匿名卡、后台建档表单。集成：tests/member-card-types.test.ts
E2E_BASE_URL=… npx playwright test e2e/emenu-818.spec.ts --project=门店电脑   # 8.1.8 品牌部的五条（docs/HANDOFF_V818.md）：小米平板大小上用预览码打开「主文字改过、照片加了圆角」的版面，逐页核对顶栏字完整、封面标题小圆圈、照片直角、字色 #4b392a、选中没有光晕；工作台主文字锁定、照片没有圆角（只读，预览码不发布）
E2E_BASE_URL=… npx playwright test e2e/emenu-8114.spec.ts --project=门店电脑   # 8.1.14 品牌部《工作台需求汇总 1.2》的三条（docs/HANDOFF_V8114.md）：小米平板大小上 11 种版式逐页核对顶栏分类与菜品的英文是衬线展示体（Playfair Display）、加号离菜名 2 / 3.5 个加号宽（放大一档、原样两种大小）、封面标题右下角的手绘圆环（中文位置不变、英文不压字）；合成菜单，只读
E2E_BASE_URL=… npx playwright test e2e/dining-817.spec.ts --project=门店电脑   # 8.1.7 餐饮分区与点菜单（docs/HANDOFF_V817.md）：后台选点单分类与分区 → 桌台分区详情 → 先选餐厅 / 水吧 / 果吧再点 → 点菜单五种状态 → 沽清、台账、退菜记录按果吧筛；手牌客人的点菜单（菜品、档口、桌台以 E2E 817 开头，留着下次沿用；结束时退菜撤台、关闭餐饮）
E2E_BASE_URL=… npx playwright test e2e/target-devices.spec.ts --project=门店电脑   # 三台目标设备（docs/DEVICES.md）：另开 1920×1080、1280×720、360×800、1355×903 的窗口核对主要页面不横向滚动、按钮在屏幕里（菜单里的菜、桌台与点菜单用合成数据，只读；临时打开餐饮，结束时恢复）
E2E_BASE_URL=… npx playwright test e2e/ys-v8117.spec.ts --project=门店电脑   # 8.1.17 整体样式（docs/YUZU_REQ_V8117.md YS-1–YS-5）：在 1920×1080、1280×720、360×800、1355×903 四个尺寸上核对统一过的页面——没有小于 12 像素的字、关键金额不小于 16 像素、触屏上的热区补到 44 × 44（用鼠标不外扩）、不横向滚动；只读，统一过的页面加进 PAGES
E2E_BASE_URL=… E2E_CANTEEN_URL=… npx playwright test -c playwright.canteen.config.ts   # 员工食堂的手机端流程（应用要开着员工端口、带 CANTEEN_PUSH_LOCAL_ENDPOINTS=true，库里有 seed-demo 的店主）；8.1.2 起含 studio.spec：工作台发布的员工食堂版面在员工手机上看得到、用完发回默认版面
E2E_BASE_URL=… npx playwright test e2e/concierge.spec.ts --project=门店电脑   # 管家部（8.0.12）：建档与余额、管家账号落地、拍一张合成小票在浏览器本机识别（要在构建产物上跑，开发模式测不出识别资源缺不缺）
E2E_BASE_URL=… npx playwright test e2e/customer.spec.ts --project=门店电脑   # 客户部（PR #107 整合）：总览与小时下钻、手牌筛选、低余额、目标与原单明细、页签地址、权限受限时的提示；只读前台与会员数据，不做收款
E2E_BASE_URL=… npx playwright test e2e/requests-1114.spec.ts --project=门店电脑   # 店主 2026-11-14 的七条需求里登记消费（数量直接输、项目取不回来有重试）与预约（选明天、弹窗里的日期、时段取不回来有重试、项目搜索）；点单换人确认在 dining.spec，平板下单后回起始页在 emenu.spec
E2E_MP_PORT=… E2E_MP_GATEWAY_KEY=… E2E_BASE_URL=… npx playwright test e2e/member-refund-online.spec.ts --project=门店电脑
                                           # 退储值「门店系统原路退回」（v0.7.29）：应用要用 MP_PORT、MP_GATEWAY_KEY、MP_PAY_MOCK=true 启动（只在 development、test）
```
