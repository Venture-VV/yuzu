# 文档索引

`docs/` 里的文档分三种，读之前先看它是哪一种：

- **现行规范**：随代码更新，写代码前按需读。和别的文档不一致时以它为准。
- **模块设计与专题**：某个模块、某一版的设计稿与实现说明。模块改了要跟着改；里面标着版本号的是那一版动工时的设计，后来的整改看更新的那一份。
- **快照**：交接说明、排期、更新记录分卷。写的是当时的状态，写完不再改，**不要当成现在的规则**。

入口是根目录的 [`AGENTS.md`](../AGENTS.md)（协作约定，按任务指到下面的专题文档）；项目介绍在根目录的 [`README.md`](../README.md)。

新加文档：文件第一行写「# 标题」，然后跑 `npm run check:docs -- --fix`，下面的清单会自动更新（CI 核对）。归到哪一组按文件名定（`scripts/check-docs.mjs` 的 `classifyDoc`）：`HANDOFF_` 开头的是交接说明，`SCHEDULE_` 开头的是排期，`DEPLOY_`、`RELEASE_` 开头的是部署与发版，`MP_` 开头的是小程序线，其余算模块设计。

<!-- docs-index:start（由 npm run check:docs -- --fix 生成，不要手改） -->

## 现行规范（写代码前按需读，随代码更新）

- [`LOCKING.md`](LOCKING.md)：加锁顺序（按模块）
- [`COMMANDS.md`](COMMANDS.md)：常用命令
- [`CONVENTIONS.md`](CONVENTIONS.md)：开发约定（专题）
- [`TESTING.md`](TESTING.md)：测试与 CI（飞书需求 RQ-008，v0.7.18 定稿；2026-11-20 改成按改动与风险挑选，见第 6 节）
- [`ROADMAP.md`](ROADMAP.md)：浴族 yuzu 推进路线（ROADMAP）
- [`PENDING_DECISIONS.md`](PENDING_DECISIONS.md)：待确认经营事项
- [`GOVERNANCE.md`](GOVERNANCE.md)：工程治理 · 让 AI 能长期开发 yuzu（三期）
- [`DEVICES.md`](DEVICES.md)：目标设备（店主 2026-11-18）
- [`DESIGN.md`](DESIGN.md)：浴族设计语言
- [`UI_V8016.md`](UI_V8016.md)：后台整体 UI 优化 · 动效套件（8.0.16）
- [`IA_V8017.md`](IA_V8017.md)：后台架构重新整理 · 信息架构方案（8.0.17）

## 模块设计与专题（设计稿与实现说明；模块改了要跟着改）

- [`AI_V8022.md`](AI_V8022.md)：8.0.22 设计 · AI 辅助（MD-D）
- [`APPROVALS.md`](APPROVALS.md)：审批中心（v0.7.30）
- [`BENEFITS.md`](BENEFITS.md)：会员体系 v2 第二期：本店权益自动发放（v0.7.24 设计稿）
- [`BUDGET_INVOICES.md`](BUDGET_INVOICES.md)：费用预算与进项发票台账（8.0.3）· 设计稿
- [`CANTEEN.md`](CANTEEN.md)：员工食堂 · 柚子饭堂
- [`CASHIER.md`](CASHIER.md)：收银完善（v0.7.6 起）
- [`CONCIERGE.md`](CONCIERGE.md)：管家部 · 8.0.12
- [`CONCIERGE_LINKS.md`](CONCIERGE_LINKS.md)：管家部与会员、资源系统联动
- [`CONTRACTS.md`](CONTRACTS.md)：合同与法务审查（v0.7.31）
- [`COUPONS.md`](COUPONS.md)：券与会员权益（v0.7.20，飞书需求 RQ-006 后半；定稿）
- [`DESKS_V8115.md`](DESKS_V8115.md)：8.1.15 · 前台拆成发卡台与收银台
- [`DINING_V8115.md`](DINING_V8115.md)：8.1.15 餐饮：桌台动作、台账合并退菜、出品口下单权限与房号备注（《浴族系统需求汇总》块 B）
- [`DINING_V817.md`](DINING_V817.md)：8.1.7 餐饮分区与点菜单（店主 2026-11-18）
- [`DISHES_V8115.md`](DISHES_V8115.md)：8.1.15 菜品管理（《浴族系统需求汇总》餐饮第 4 条）
- [`DISHES_V8117.md`](DISHES_V8117.md)：8.1.17 菜品补完：做法分组与加价、选规格、退主菜带加料、平板选做法、排序与删除、套餐出品与换菜
- [`EMENU.md`](EMENU.md)：点餐系统 · 平板电子菜单（8.0.10）
- [`ERP.md`](ERP.md)：ERP 独立工作区（含 SCM）
- [`ERP_PURCHASING.md`](ERP_PURCHASING.md)：ERP 采购五项（v0.7.29）· 设计稿
- [`ERP_ROUND2.md`](ERP_ROUND2.md)：供应链二次整改：草稿箱、部门表格导入、集采模板最终版
- [`ERP_V8020.md`](ERP_V8020.md)：8.0.20 设计 · 进销存做深 + 客房点餐、会员联动房价
- [`ERP_V807.md`](ERP_V807.md)：8.0.7 · 剩下的开发一版做完（A1–A4）
- [`ERP_V8110.md`](ERP_V8110.md)：8.1.10 ERP 采购：核库转领用、急采后补合同
- [`ERP_V8120.md`](ERP_V8120.md)：8.1.20 出入库台账（库存页面导入台账调整）
- [`ERP_V819.md`](ERP_V819.md)：8.1.9 · ERP 供应链：零采备用金面板与库管入库
- [`EXPENSES.md`](EXPENSES.md)：费用报销与备用金（v0.7.7 起，飞书需求 RQ-005）
- [`FINANCE_V8021.md`](FINANCE_V8021.md)：8.0.21 设计 · 财务与合同做深
- [`FLOORPLAN.md`](FLOORPLAN.md)：底图转换（RQ-004 第二段，v0.7.15）
- [`FLOORPLAN_FINISH.md`](FLOORPLAN_FINISH.md)：平面图收尾（v0.7.19，定稿）：开单即占用、对客导览、PDF 底图、图纸治理
- [`FLOW_V8017.md`](FLOW_V8017.md)：ERP 流程图 · 采购从提需求到付款（8.0.17）
- [`FRONTDESK_RISK_V8115.md`](FRONTDESK_RISK_V8115.md)：8.1.15 追加 · 前台：NFC 发牌、发牌前风控、发牌后异常处置（块 A）
- [`FRONTDESK_V808.md`](FRONTDESK_V808.md)：8.0.8 前台整改（钟房、收银、派对房、预约、餐饮、客房）
- [`FRONTDESK_V8117.md`](FRONTDESK_V8117.md)：8.1.17 · 前台、桌台、退菜、本店价、流水（BW-1、BW-2、BW-3 发卡台、BW-4、BW-11、BW-12）
- [`GIFTS_V819.md`](GIFTS_V819.md)：8.1.9 · 全局签赠（签赠券、授权人、签赠台账）
- [`HARDWARE.md`](HARDWARE.md)：硬件连接（飞书需求 RQ-001，v0.7.21，迁移 `038`）
- [`INTEGRATIONS_V8021.md`](INTEGRATIONS_V8021.md)：8.0.21 设计 · 对外接口（支付直连、平台验券、OTA、开票与银企直连的适配器）
- [`LEDGER.md`](LEDGER.md)：采购台账、四个视图与 12 条账目自检（v0.7.9，飞书需求 RQ-005 第三步）
- [`LEGACY_LEDGER.md`](LEGACY_LEDGER.md)：8–10 月旧账只读对照（v0.7.10，飞书需求 RQ-005 收尾）
- [`MASCOT.md`](MASCOT.md)：看板娘「柚子」（第二版：手绘动画，待店主确认）
- [`MEMBERSHIP.md`](MEMBERSHIP.md)：会员体系 v2（设计稿；店主 2026-11-03 两次答复后修订；第一期 v0.7.23 已按本稿实现，见第 14 节）
- [`MEMBERSHIP_FINISH.md`](MEMBERSHIP_FINISH.md)：会员体系收尾（v0.7.26）
- [`MEMBERSHIP_P3.md`](MEMBERSHIP_P3.md)：会员体系 v2 第三期：会员折扣、邀请体验与赠送会籍（v0.7.25）
- [`MEMBERSHIP_V804.md`](MEMBERSHIP_V804.md)：会员体系整改（8.0.4 设计稿）
- [`MEMBERS_V8115.md`](MEMBERS_V8115.md)：8.1.16 会员中心：建档先选卡类型、表单字段补全
- [`MULTISTORE_V8022.md`](MULTISTORE_V8022.md)：8.0.22 设计 · 多门店、多店多仓、多公司主体（MD-A、MD-B、MD-C）
- [`ORDERS_V8015.md`](ORDERS_V8015.md)：订单查询与部门项目明细（8.0.15）
- [`PATROL_V809.md`](PATROL_V809.md)：安保巡场与员工工作台（8.0.9）
- [`PAYMENTS.md`](PAYMENTS.md)：付款流（v0.7.32）
- [`POSITIONS_V8118.md`](POSITIONS_V8118.md)：组织架构与岗位（8.1.18）
- [`PURCHASING_V801.md`](PURCHASING_V801.md)：采购组整改需求（8.0.1）
- [`REQUISITIONS.md`](REQUISITIONS.md)：部门采购需求单、采购单的图片与规格（v0.7.8，飞书需求 RQ-005 第二步）
- [`RESILIENCE_V813.md`](RESILIENCE_V813.md)：8.1.3 · 代码整洁与网络波动防护
- [`ROOMMAP.md`](ROOMMAP.md)：房态图（RQ-004 第三段，v0.7.16）与第一级实时位置（v0.7.17）
- [`ROOMS.md`](ROOMS.md)：S7 客房（v0.7.4）
- [`ROOM_CENTER_V8115.md`](ROOM_CENTER_V8115.md)：8.1.15 / 8.1.16 · 房态中心（《浴族系统需求汇总》房态中心 1–4）
- [`SPACES.md`](SPACES.md)：空间台账（RQ-004 第一段，v0.7.14）
- [`STOCK_CYCLES.md`](STOCK_CYCLES.md)：台面日耗品、称重与盘点 / 对账提醒（v0.7.13，Batch 4 收尾）
- [`STUDIO_MP.md`](STUDIO_MP.md)：工作台 · 小程序的版面格式（8.1.2，给小程序线）
- [`SUPPLIER_SETTLEMENT.md`](SUPPLIER_SETTLEMENT.md)：供应商结算与库存采购收尾（v0.7.12，RQ-002 第二步）
- [`TECHNICIANS_V8115.md`](TECHNICIANS_V8115.md)：8.1.16 技师：钟房搜索与筛选、排位播报、技师管理
- [`TEST_AUDIT.md`](TEST_AUDIT.md)：用例体检（2026-11-18，工程治理三期）
- [`WAREHOUSES.md`](WAREHOUSES.md)：两级库存：总仓 + 部门小仓（v0.7.11，RQ-002 第一步）
- [`WORKBENCH_V811.md`](WORKBENCH_V811.md)：UI 工作台（8.1.1–8.1.2）：设计师在系统里直接改版面
- [`YUZU_REQ_V8115.md`](YUZU_REQ_V8115.md)：8.1.15 追加 ·《浴族系统需求汇总》：对照现状与做法
- [`YUZU_REQ_V8117.md`](YUZU_REQ_V8117.md)：8.1.17 ·《浴族系统需求汇总》整体样式与没做完的部分
- [`YUZU_REQ_V820.md`](YUZU_REQ_V820.md)：8.2.0 回测整改（《浴族系统 8.1.15–8.1.18 回测问题汇总与 PR 拆分》）

## 部署、发版与环境

- [`DEMO_DATA.md`](DEMO_DATA.md)：演示数据（飞书需求 RQ-007，v0.7.18 定稿）
- [`DEPLOY_MAC_MINI.md`](DEPLOY_MAC_MINI.md)：Mac mini 部署手册
- [`DEPLOY_TEST_SERVER.md`](DEPLOY_TEST_SERVER.md)：测试服部署手册（阿里云深圳）
- [`EVALUATION.md`](EVALUATION.md)：上线评测说明（v0.7.21 · 初期开发收口）
- [`RELEASE_V800.md`](RELEASE_V800.md)：正式版 8.0.0：发版前的检查与环境安排
- [`RELEASE_V810.md`](RELEASE_V810.md)：8.1.0：切到 8.1 的准备
- [`TRIAL_RUN.md`](TRIAL_RUN.md)：上线前全流程试跑清单（8.0.7）

## 小程序线（Gemini 维护）

- [`DEPLOY_GATEWAY.md`](DEPLOY_GATEWAY.md)：小程序网关部署手册（阿里云深圳；小程序线）
- [`MINIPROGRAM.md`](MINIPROGRAM.md)：微信小程序（设计稿；店主 2026-11-03 立项并确认）
- [`MP_COUPONS.md`](MP_COUPONS.md)：小程序第二期 2c：线上领券（设计稿与实现；小程序线，2026-11-04）
- [`MP_PHASE3.md`](MP_PHASE3.md)：小程序第三期：到期提醒、邀请好友、扫码点餐、预约（设计稿；小程序线，2026-11-04）
- [`MP_PRIVACY.md`](MP_PRIVACY.md)：小程序「用户隐私保护指引」草稿（店主在小程序后台照填；小程序线）
- [`MP_RECHARGE.md`](MP_RECHARGE.md)：小程序第二期：线上充值（设计稿；小程序线，2026-11-04）

## 排期、规划与调研（当时的计划，写完不再更新）

- [`ERP_FINANCE_LEGAL_PLAN.md`](ERP_FINANCE_LEGAL_PLAN.md)：ERP 财务与法务审批 · 开发规划与排期
- [`GOVERNANCE_NOTES.md`](GOVERNANCE_NOTES.md)：学习记录 ·《如何用 AI 长期开发一个复杂项目》与配套开源工具
- [`SCHEDULE_FINISH.md`](SCHEDULE_FINISH.md)：排期收尾（v0.7.28 设计稿）
- [`SCHEDULE_V8020.md`](SCHEDULE_V8020.md)：8.0.20–8.0.22 排期 · 原来「店主说要才做」的那一批
- [`SCHEDULE_V811.md`](SCHEDULE_V811.md)：8.1.1–8.1.2 排期（店主 2026-11-15）

## 交接说明（发版当时的快照，不随代码更新；与专题文档不一致时以专题文档为准）

- [`HANDOFF_CONCIERGE_LINKS.md`](HANDOFF_CONCIERGE_LINKS.md)：管家服务同源联动交接（PR #99）
- [`HANDOFF_CONCIERGE_MEMBER_CARE.md`](HANDOFF_CONCIERGE_MEMBER_CARE.md)：管家部会员情况与好评中心交接
- [`HANDOFF_CUSTOMER_LOCAL.md`](HANDOFF_CUSTOMER_LOCAL.md)：客户部接入 Yuzu · 独立 PR 交接
- [`HANDOFF_G2.md`](HANDOFF_G2.md)：G2 提测交接 · S2 到店与未结手牌
- [`HANDOFF_G2_BATCH2.md`](HANDOFF_G2_BATCH2.md)：G2 · Batch 2 收口提测交接（2.1 – 2.4d）
- [`HANDOFF_G3.md`](HANDOFF_G3.md)：G3 提测交接 · S3 收银结账、门票跳档、团购防重、交班与双口径日结（G3A / G3B）
- [`HANDOFF_GOV1.md`](HANDOFF_GOV1.md)：工程治理一期 交接说明 · 文档收拢与护栏
- [`HANDOFF_GOV2.md`](HANDOFF_GOV2.md)：工程治理二期 交接说明 · 代码瘦身与代码规范
- [`HANDOFF_GOV3.md`](HANDOFF_GOV3.md)：工程治理三期 交接说明 · 测试分层与界面规范
- [`HANDOFF_GR1.md`](HANDOFF_GR1.md)：G-R1 提测交接 · R1.2 资金轨：先开班、优惠 / 免单与降档授权、反结账口径与时限（v0.4.0）
- [`HANDOFF_MP1.md`](HANDOFF_MP1.md)：小程序第一期交接 · MP1：yuzu 小程序端口与接口、后台「微信小程序」、小程序网关、小程序页面
- [`HANDOFF_MP2A.md`](HANDOFF_MP2A.md)：交接：小程序第二期 2a 线上充值、2b 对账（小程序线）
- [`HANDOFF_MP2C.md`](HANDOFF_MP2C.md)：交接：小程序第二期 2c 线上领券、2d 原路退回（小程序线）
- [`HANDOFF_MP3A.md`](HANDOFF_MP3A.md)：交接：小程序第三期 3a 到期提醒、解绑满 3 年清除（小程序线）
- [`HANDOFF_MP3BCD.md`](HANDOFF_MP3BCD.md)：交接：小程序第三期 3b 邀请好友、3c 扫码点餐、3d 预约技师与派对房（小程序线）
- [`HANDOFF_MP_GEMINI.md`](HANDOFF_MP_GEMINI.md)：小程序线交给 Gemini（店主 2026-11-15）
- [`HANDOFF_MP_RQ014.md`](HANDOFF_MP_RQ014.md)：小程序线 RQ-014 交接说明 · 接主线 8.0.4 会员整改
- [`HANDOFF_MP_STUDIO.md`](HANDOFF_MP_STUDIO.md)：小程序线交接说明 · UI 工作台版面渲染组件与定时发布刷新（8.1.2）
- [`HANDOFF_V060.md`](HANDOFF_V060.md)：v0.6.0 交接说明 · 管理后台、岗位权限可调整、会员渠道与等级、按岗位的数据看板
- [`HANDOFF_V070.md`](HANDOFF_V070.md)：v0.7.0 交接说明 · S6 技师第一步：技师名册、挂项目时选技师、技师业绩
- [`HANDOFF_V071.md`](HANDOFF_V071.md)：v0.7.1 交接说明 · S6 技师第二步：钟房看板、轮钟排队、上下钟计时、提成
- [`HANDOFF_V0710.md`](HANDOFF_V0710.md)：v0.7.10 交接说明 · 飞书需求 RQ-005 收尾：8–10 月旧账只读对照；班次跨营业日提醒
- [`HANDOFF_V0711.md`](HANDOFF_V0711.md)：v0.7.11 交接说明 · 飞书需求 RQ-002 第一步：总仓 + 部门小仓两级库存、收货必须有采购单与急采、当月冲销与分工
- [`HANDOFF_V0712.md`](HANDOFF_V0712.md)：v0.7.12 交接说明 · 飞书需求 RQ-002 第二步：退货待供应商确认、预付款与供应商退款、运费、可用天数、批量导入、分岗不兼任、免确认门槛
- [`HANDOFF_V0713.md`](HANDOFF_V0713.md)：v0.7.13 交接说明 · Batch 4 收尾：台面日耗品与称重、每月盘点与供应商对账提醒
- [`HANDOFF_V0714.md`](HANDOFF_V0714.md)：v0.7.14 交接说明 · 飞书需求 RQ-004 第一段：空间台账，客房房间挂接空间
- [`HANDOFF_V0715.md`](HANDOFF_V0715.md)：v0.7.15 交接说明 · 飞书需求 RQ-004 第二段：底图转换
- [`HANDOFF_V0716.md`](HANDOFF_V0716.md)：v0.7.16 交接说明 · 飞书需求 RQ-004 第三段（上）：房态图
- [`HANDOFF_V0717.md`](HANDOFF_V0717.md)：v0.7.17 交接说明 · 飞书需求 RQ-004 第三段（下）：第一级实时位置
- [`HANDOFF_V0718.md`](HANDOFF_V0718.md)：v0.7.18 交接说明 · 飞书需求 RQ-007 演示数据可重复准备 + RQ-008 精简测试与 CI 等待
- [`HANDOFF_V0719.md`](HANDOFF_V0719.md)：v0.7.19 交接说明 · 平面图收尾：派对房等开单即占用（D39）、对客导览、PDF 底图、图纸治理、例外补画轮廓
- [`HANDOFF_V072.md`](HANDOFF_V072.md)：v0.7.2 交接说明 · S5 餐饮：出品档口、点单、厨房出品屏、估清；桌台与不洗浴客人单独结账
- [`HANDOFF_V0720.md`](HANDOFF_V0720.md)：v0.7.20 交接说明 · 收银完善：退款单与券、会员权益（飞书 RQ-006）
- [`HANDOFF_V0721.md`](HANDOFF_V0721.md)：v0.7.21 交接说明 · 初期开发收口：RQ-001 硬件连接接口 v0.1、测试缺口、上线评测说明
- [`HANDOFF_V0722.md`](HANDOFF_V0722.md)：v0.7.22 交接说明 · 代码整理（让项目更轻便）与会员体系 v2 设计稿
- [`HANDOFF_V0723.md`](HANDOFF_V0723.md)：v0.7.23 交接说明 · 会员体系 v2 第一期：等级与会籍全自动
- [`HANDOFF_V0724.md`](HANDOFF_V0724.md)：v0.7.24 交接说明 · 会员体系 v2 第二期：本店权益自动发放
- [`HANDOFF_V0725.md`](HANDOFF_V0725.md)：v0.7.25 交接说明 · 会员体系 v2 第三期：会员折扣、邀请体验与赠送会籍
- [`HANDOFF_V0726.md`](HANDOFF_V0726.md)：v0.7.26 交接说明 · 会员体系收尾：储值退回、线上收款入口、停用 / 换号 / 合并、同行优惠
- [`HANDOFF_V0727.md`](HANDOFF_V0727.md)：v0.7.27 交接说明 · 给小程序线的两处：发券入口「小程序领取」、线上充值的原路退回
- [`HANDOFF_V0728.md`](HANDOFF_V0728.md)：v0.7.28 交接说明 · 排期收尾：把还没完成的开发在这一版做完
- [`HANDOFF_V0729.md`](HANDOFF_V0729.md)：v0.7.29 交接说明 · ERP 采购五项与财务法务审批排期
- [`HANDOFF_V073.md`](HANDOFF_V073.md)：v0.7.3 交接说明 · ERP 独立工作区第一步
- [`HANDOFF_V0730.md`](HANDOFF_V0730.md)：v0.7.30 交接说明 · 审批中心、盘点差异审批、部门数据隔离、急采待补单升级，询价接上需求单与补货建议
- [`HANDOFF_V0731.md`](HANDOFF_V0731.md)：v0.7.31 交接说明 · 合同与法务审查
- [`HANDOFF_V0732.md`](HANDOFF_V0732.md)：v0.7.32 交接说明 · 付款流
- [`HANDOFF_V0733.md`](HANDOFF_V0733.md)：v0.7.33 交接说明 · 员工食堂（柚子饭堂）
- [`HANDOFF_V074.md`](HANDOFF_V074.md)：v0.7.4 交接说明 · S7 客房（G7，资金候选版本）
- [`HANDOFF_V075.md`](HANDOFF_V075.md)：v0.7.5 交接说明 · 客房：v0.7.4 代码审查的修正（资金候选版本）
- [`HANDOFF_V076.md`](HANDOFF_V076.md)：v0.7.6 交接说明 · 收银完善第一步：部门营业额快照、明细转到另一张手牌（资金候选版本）
- [`HANDOFF_V077.md`](HANDOFF_V077.md)：v0.7.7 交接说明 · 飞书需求 RQ-005 第一步：费用报销与备用金每日平账（资金候选版本）
- [`HANDOFF_V078.md`](HANDOFF_V078.md)：v0.7.8 交接说明 · 飞书需求 RQ-005 第二步：部门采购需求单、采购单的图片与规格；v0.7.7 审查修正（资金候选版本）
- [`HANDOFF_V079.md`](HANDOFF_V079.md)：v0.7.9 交接说明 · 飞书需求 RQ-005 第三步：采购台账与四个视图、导出、12 条账目自检
- [`HANDOFF_V800.md`](HANDOFF_V800.md)：v8.0.0 交接说明 · 正式版
- [`HANDOFF_V801.md`](HANDOFF_V801.md)：v8.0.1 交接说明 · 登录按来源 IP 限次与采购组整改
- [`HANDOFF_V8010.md`](HANDOFF_V8010.md)：v8.0.10 交接说明 · 点餐系统（平板电子菜单）
- [`HANDOFF_V8011.md`](HANDOFF_V8011.md)：v8.0.11 交接说明 · 巡场轮次
- [`HANDOFF_V8012.md`](HANDOFF_V8012.md)：8.0.12 · 管家部原生集成交接
- [`HANDOFF_V8013.md`](HANDOFF_V8013.md)：v8.0.13 交接说明 · 电子菜单整改（中英切换、搜索适配键盘、动效）
- [`HANDOFF_V8014.md`](HANDOFF_V8014.md)：v8.0.14 交接说明 · 英文对照表：手填的单引号照字面保存
- [`HANDOFF_V8015.md`](HANDOFF_V8015.md)：v8.0.15 交接说明 · 订单查询、部门项目明细、平板放大与点单密码开关、管家部内网修复
- [`HANDOFF_V8016.md`](HANDOFF_V8016.md)：v8.0.16 交接说明 · 后台整体 UI 优化：动效套件
- [`HANDOFF_V8017.md`](HANDOFF_V8017.md)：v8.0.17 交接说明 · 后台架构重新整理（第一步：后台的一级分组与二级页签）· ERP 采购流程图
- [`HANDOFF_V8018.md`](HANDOFF_V8018.md)：v8.0.18 交接说明 · 整合管家部同源联动（PR #99）· 后台架构重新整理第二步（ERP）
- [`HANDOFF_V8019.md`](HANDOFF_V8019.md)：v8.0.19 交接说明 · 后台架构重新整理第三步：门店的日常入口 · 收尾
- [`HANDOFF_V802.md`](HANDOFF_V802.md)：v8.0.2 交接说明 · 采购单撤回与登记发票串行
- [`HANDOFF_V8020.md`](HANDOFF_V8020.md)：v8.0.20 交接说明 · 进销存做深 + 客房点餐、会员联动房价 · 功能开关都默认开
- [`HANDOFF_V8021.md`](HANDOFF_V8021.md)：v8.0.21 交接说明 · 财务与合同做深 · 对外接口（模拟实现）
- [`HANDOFF_V8022.md`](HANDOFF_V8022.md)：v8.0.22 交接说明 · 多门店、多店多仓、多公司主体、AI 辅助（这一批的收尾版）
- [`HANDOFF_V803.md`](HANDOFF_V803.md)：v8.0.3 交接说明 · 费用预算与进项发票台账
- [`HANDOFF_V804.md`](HANDOFF_V804.md)：v8.0.4 交接说明 · 会员体系整改
- [`HANDOFF_V805.md`](HANDOFF_V805.md)：v8.0.5 交接说明 · 8.0.4 独立验收的四处问题
- [`HANDOFF_V806.md`](HANDOFF_V806.md)：v8.0.6 交接说明 · 付款规则可配
- [`HANDOFF_V807.md`](HANDOFF_V807.md)：v8.0.7 交接说明 · 剩下的开发一版做完（可调的数值、供应链收尾、ERP P2、小项）
- [`HANDOFF_V808.md`](HANDOFF_V808.md)：v8.0.8 交接说明 · 前台整改（钟房、收银、派对房、预约、餐饮、客房）
- [`HANDOFF_V809.md`](HANDOFF_V809.md)：v8.0.9 交接说明 · 安保巡场与员工工作台
- [`HANDOFF_V811.md`](HANDOFF_V811.md)：v8.1.1 交接说明 · AI 辅助换 DeepSeek、UI 工作台第一步（平板电子菜单）
- [`HANDOFF_V8110.md`](HANDOFF_V8110.md)：v8.1.13 交接说明 · 核库转领用、急采后补合同
- [`HANDOFF_V8114.md`](HANDOFF_V8114.md)：v8.1.14 交接说明 · 品牌部的三条（电子菜单）
- [`HANDOFF_V8115.md`](HANDOFF_V8115.md)：v8.1.15 交接说明 · 发卡台与收银台、前台风控、餐饮桌台与菜品管理、深浅主题、退出键
- [`HANDOFF_V8116.md`](HANDOFF_V8116.md)：v8.1.16 交接说明 · 房态中心、技师、会员与主导航分组
- [`HANDOFF_V8117.md`](HANDOFF_V8117.md)：8.1.17 交接说明 ·《浴族系统需求汇总》整体样式与没做完的部分
- [`HANDOFF_V8119.md`](HANDOFF_V8119.md)：v8.1.19 交接说明 · 菜品与顶栏的英文换成品牌部的示例字体（电子菜单）
- [`HANDOFF_V812.md`](HANDOFF_V812.md)：v8.1.2 交接说明 · UI 工作台第二步（卡片模板、组件与变体、员工食堂、给小程序线的格式、定时发布与批注）
- [`HANDOFF_V8120.md`](HANDOFF_V8120.md)：v8.1.20 交接说明 · 库存：出入库台账（导入、导出、下载模板）
- [`HANDOFF_V8121.md`](HANDOFF_V8121.md)：v8.1.21 交接说明 · 管家端去掉「拍消费单」
- [`HANDOFF_V813.md`](HANDOFF_V813.md)：v8.1.3 交接说明 · 代码整洁与网络波动防护
- [`HANDOFF_V814.md`](HANDOFF_V814.md)：v8.1.4 交接说明 · 老浏览器上侧栏划不动、工作台开在哪一档
- [`HANDOFF_V815.md`](HANDOFF_V815.md)：v8.1.5 交接说明 · 平板电子菜单的品牌调整
- [`HANDOFF_V816.md`](HANDOFF_V816.md)：v8.1.6 交接说明 · 平板电子菜单与工作台的二次整改
- [`HANDOFF_V817.md`](HANDOFF_V817.md)：v8.1.7 交接说明 · 餐饮分区与点菜单、三台目标设备
- [`HANDOFF_V818.md`](HANDOFF_V818.md)：v8.1.8 交接说明 · 品牌部的五条（电子菜单）
- [`HANDOFF_V819.md`](HANDOFF_V819.md)：v8.1.9 交接说明 · 零采备用金、库管入库、全局签赠

## 更新记录分卷

- [`changelog/CHANGELOG-0.x.md`](changelog/CHANGELOG-0.x.md)：变更记录 · v0.x（v0.1.0 – v0.7.33 与首版之前）
- [`changelog/CHANGELOG-8.0.md`](changelog/CHANGELOG-8.0.md)：变更记录 · v8.0.x（v8.0.0 – v8.0.22）
- [`changelog/README-0.x.md`](changelog/README-0.x.md)：首版时期的 README（v0.x，2026-10 – 2026-11 初）

<!-- docs-index:end -->
