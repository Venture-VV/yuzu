# 开发约定（专题）

资金、幂等、迁移这几条**核心规则**在 `AGENTS.md`「开发约定」，加锁顺序在 [`LOCKING.md`](LOCKING.md)。这里是其余的约定：功能开关、多门店、公共小工具、页面部件、登记处。
每一条都是从 `AGENTS.md` 原样搬来的（工程治理一期，`docs/GOVERNANCE.md`），只分了节、长句按分号拆成子项，文字没有改。新的约定加在这里对应的一节，`AGENTS.md` 只在「按任务去哪看」里指路。

## 1. 功能开关

- **功能开关默认开（店主 2026-11-14，8.0.20 起）**：打开 / 关上一整块功能的开关，代码里的默认值是开；新加的功能开关也默认开（没配置好之前什么都不做，页面上写「还没配置」）。用例从「以往的开关都关着」开始（`tests/helpers.ts` 的 `legacySwitchesOff`，默认值由 `tests/switches-default.test.ts` 核对）；会随钟点自己动的开关（如自动补货）在用例基线里关着、在自己的用例里打开，演示数据写入时把当天记成「已跑过」。规矩松紧与安全相关的选项不算功能开关，默认值照各自的决定（`docs/PENDING_DECISIONS.md` KG1–KG4）。

## 2. 多门店

- 多门店（8.0.22，`docs/MULTISTORE_V8022.md`）：请求的当前门店在上下文里（`lib/store-context` 的 `currentStoreId`），本店（编号 1）不设任何上下文——只有一家店时与以往完全一样。新加的业务表要按店分的，加 `store_id bigint NOT NULL DEFAULT yuzu_store()`（新写的行自动记上当前门店），读的地方显式按 `store_id = ${currentStoreId()}` 过滤，报表用 `storeIn(db, '列')`（「合并看」时是几家店）；
  - 要记公司主体的财务单据加 `entity_id DEFAULT yuzu_entity()`，有上级单据的跟着上级走。每分钟的任务、小程序入口在单据所在的门店里处理（`runInStore` / `inRowStore` / `forEachStore`）。会员、钱包、券、价目、ERP 的物料与供应商全公司一套，不按店分。

## 3. 公共小工具

- 公共小工具（v0.7.22 整理）：服务端的原请求摘要 `hashRequest`（`lib/idempotency`）、经办人与 IP `ctxOf`（`lib/context`）、下载响应 `csvReply` / `attachment`（`lib/csv`）、事务时限与单号 `setTxTimeouts` / `nextDocNo`（`lib/tx`）、营业日与查询区间 `todayIn` / `dateIn` / `checkDateRange`（`lib/dates`）、规则类设置的保存 `saveRuleSetting`（`lib/rule-settings`：先取规则锁、在锁里读当前值再合并写回，只改部分字段的保存不会互相覆盖）；
  - 前端的页面按需加载 `lazyPage`、ERP 类单据的「结果待确认」`sendErpOp` + `ErpPendingPanel`、导入文件的 CSV 读法 `@shared/csv-read`、选导入文件时的编码识别 `lib/import-file`（`readImportFile` 读文本、`readTablePayload` 读 CSV 或 Excel，UTF-8 / GBK 自动识别，8.0.21）、动效套件（8.0.16，`docs/UI_V8016.md`：`lib/motion` 的 `useExitGhost` / `Stagger` / `useSlidingIndicator` / `usePageEnter`，样式表里的 `--dur-*` / `--ease-*` 变量与 `animate-dialog-in`、`mo-lift` 等类；只动透明度、位移、缩放、颜色，不引入动画库，关掉就卸掉的浮层用影子播退场、不把它多留在页面上）、流程轨（8.0.17，`docs/FLOW_V8017.md`：`components/FlowTrack` 的 `FlowTrack` / `FlowDot` / `FlowAlert`，一排环节——做完绿勾、正在等橙点、没到灰、超期红条；采购流程的环节由 `@shared/purchase-flow` 的 `buildPurchaseFlow` 从单据算，只读、不另存状态；审批链的时间线用 `features/approvals/ApprovalTimeline`）、二级页签（8.0.17，`docs/IA_V8017.md`：`components/SubNav` 的 `SubTabPage` / `SubPane` / `useActiveSubTab` / `useGoSubTab`，后台分区直接给 `AdminPage` 传 `tabs`；页签写进地址 `<分区>/:tab?`、顺序「规则 → 清单 → 导入与工具」，页面里不再用分段开关当页签）、快捷原因（8.0.21：`lib/session` 的 `useReasons`、`components/ReasonChips`、`ReasonDialog` 的 `reasons`；新的要填原因的地方用它，清单加进 `@shared/custom-fields` 的 `DICTIONARY_KEYS`、默认值写在 `DEFAULT_DICTIONARIES`）。新代码直接用，不在模块里另写一份。 8.1.3（`docs/RESILIENCE_V813.md`）：连接状态 `lib/connection`（`useConnection`、`onReconnect` / `useReconnectTick`——网络恢复时重跑，判断断网按它、不看 `navigator.onLine`）；
  - 定时取数 `lib/livePoll` 的 `useLivePoll`（后台不取、断网不取、回到页面与网络恢复时马上取，新的轮询一律用它）；
  - 判断「服务端明确没处理」用 `lib/api` 的 `isRejected`（不手写 `status < 500`），第一次提交被「连不上、没发出去」挡下用 `notSentAsRejection`（**重提不能用**：之前那次可能已经生效），页面数据的重试用 `shouldRetryQuery` / `queryRetryDelay`；
  - 系统忙、请求太频繁、系统正忙（`BUSY` / `RATE_LIMITED` / `OVERLOADED`）`request` 已经原样自动重发，调用方不要再叠一层；
  - 错误边界 `components/ErrorBoundary`；
  - 存文件 `lib/utils` 的 `downloadBlob` / `downloadCsvRows`；
  - 服务端的过载保护、频率限制、访问网段在 `lib/protect`（新的「问连没连上」类接口加进它的 `PROBE_PATHS`，对外不用登录的接口放在 `/api/public/` 下）。

## 4. 页面部件、目标设备与屏幕高度

- 列表与数量的两个小部件（店主 2026-11-14 的七条需求）：数量一律用 `components/QtyInput`（加减按钮中间可以直接输，1–99、超过上限按上限算并提示）；列表、时段、菜单取不回来用 `components/LoadFailed`（写明加载失败 + 重试），不要把「没取回来」显示成「还没有」——判断写成 `isPending → 骨架`、`isError && !data → LoadFailed`、`空 → 空态`。日期条 `DateNav` 默认只到今天，只有预约页传 `max` 放开到能约的最后一天。
- 整体样式的公共部件（8.1.17，《浴族系统需求汇总》系统整体，`docs/YUZU_REQ_V8117.md` YS-1–YS-5）：表格用 `components/DataTable`（给列与数据；表头、对齐、金额右对齐等宽、整行可点、空态、加载失败、窄屏横向滚动都在里面），弹窗用 `components/Overlay` 的 `Dialog` / `Sheet`，空态用 `EmptyState`；屏幕上的字不小于 12 像素，关键金额（应收、实收、合计、找零、会员余额、交班与日结的合计）用 `<Money size="key">`（不小于 16 像素）；公共的 `Button`、`IconButton`、`Segmented` 自带点按热区 44 × 44（样式表的 `.tap`：看不见的外扩，样子不变），自己写的小按钮加 `tap relative`；删除、作废、撤销、退款、清空这类危险操作写上字，状态不只靠颜色。`npm run check:gov` 记小字、手写表格、手写弹窗的数，只降不升。
- **目标设备（店主 2026-11-18，`docs/DEVICES.md`）**：以后所有更新都要适配三台设备——商米 D3 Pro（台式收银机，15.6 英寸 1920 × 1080 横屏，网页按 1920 × 1080，系统缩放 1.5 倍时 1280 × 720）、商米 V3（手持点单机，6.75 英寸 720 × 1600 竖屏，网页约 360 × 800）、小米平板 6S Pro 12.4（网页 1355 × 903 横屏、2.25 倍）。新做的、改过的页面都在这三个尺寸上看过（不横向滚动、按钮点得到、字不被挤成一列），`e2e/target-devices.spec.ts` 核对主要页面，交接说明写明看过哪几个尺寸；真机上的网页大小以「网络与同步」页的「本机屏幕」为准。
- 屏幕高度（8.1.4）：整屏版面、弹窗的最大高度照常用 `h-dvh`、`min-h-dvh`、`max-h-[88dvh]` 这类写法，打包时 `scripts/dvh-fallback.ts` 自动给不认识 dvh 的老浏览器（Chrome 108、Safari 15.4 以前）补一块 vh（店主 2026-11-16 报的「侧边栏划不动，右边滑着左边超了」就是缺了它：整屏版面没了高度、整页跟着内容滚）；行内样式（`style={{ … }}`）里不要写 dvh，打包管不到，改用类名。`e2e/viewports.spec.ts` 的「不认识 dvh 的老浏览器」核对这一条。

## 5. 登记处：管理后台的分区与 ERP 的模块

- 管理后台的分区在 `src/shared/admin.ts` 登记：`ADMIN_SECTIONS`（路径、名称、权限）与 `ADMIN_GROUPS`（一级分组，8.0.17）；
  - 每个分区必须在且只在一个分组里（`tests/admin-ia.test.ts` 核对），侧栏、窄屏横排、后台首页都按它排。新分区两处都要加。 8.0.18：员工食堂、安保巡场是后台「人员与行政」里的分区，但开没开仍按 ERP 的模块开关（`ADMIN_SECTION_MODULES`；页面用 `AdminModuleGate` 包住，关着时提示去哪开），接口也仍是 `/api/erp/canteen`、`/api/erp/patrol`；
  - 不进后台首页也看得到的分区登记在 `ADMIN_STANDALONE_SECTIONS`（数据看板、员工食堂、安保巡场；8.1.1 起还有工作台，设计师只进这一个分区）。 8.0.19（IA4）：当班会做的事不放后台——批量发券、无记名券在门店「会员工作台 → 发券」（`features/coupons/CouponIssuePage`），停车登记在「会员工作台 → 停车登记」，会员详情有「微信小程序」一行（`features/workbench/MemberWechatCard`：只引用小程序线的接口与 `sendUnbind` / `useMpPending`，不改它的文件）；
  - 后台只留规则、清单的维护与统计。 8.0.19 收尾：会员规则、会员权益、渠道与标签是「会员体系」一个分区里的三个页签（`features/membership/MembershipSection.tsx` 的 `MEMBERSHIP_TABS`，各自原权限；新的会员类规则加成那里的页签或放进已有的页签），规则总表的条目用 `tab` 指到页签；
  - 会话里有 `miniProgram`（小程序开没开），主线的页面要按它显示隐藏时读这一项，不改小程序线的文件。
- 门店主导航（8.1.15，《浴族系统需求汇总》系统整体）按业务域分七组——前台、餐饮、房态、技师、会员、财务、设置，在 `src/client/components/storeNav.ts` 的 `STORE_NAV` 登记：新页面加在对应组 `items` 的末尾，不另开组（`tests/store-nav.test.ts` 核对七组的顺序与每页在哪一组）；展开的侧栏、收起时的一列图标与弹出的二级入口在 `StoreRail.tsx`。
  - 浏览器用例点主导航用 `e2e/nav.ts` 的 `clickNav` / `navLink`（入口所在的组折着、或收起时在弹出层里，先打开那一组），查有没有某个入口用 `navItem`（折着也算）；不直接写 `getByRole('navigation', { name: '主导航' }).getByRole('link', …)`。
- ERP（库存、采购、应付货款、审批待办、营业数据……）是单独的工作区（v0.7.3）：模块在 `src/shared/erp.ts` 的注册表里登记（页面、接口前缀、权限、默认开关、依赖），导航、页面拦截与接口拦截都按它来；
  - 新模块按注册表加，不在门店主导航里加入口，见 `docs/ERP.md`。 8.0.18（`docs/IA_V8017.md` 第 3.3 节）：导航的分组与顺序在 `ERP_NAV_GROUPS`（每个模块在且只在一个分组里，`tests/erp-ia.test.ts` 核对；注册表里的先后是按依赖排的，不是导航的顺序）；
  - ERP 的规则都收在「ERP 设置」（`/erp/settings/<页签>`，页签与谁看得到在 `features/erp/settingsTabs.ts`）——新的 ERP 规则卡片加成那里的一个页签或放进已有的页签，不再在各模块页里另开「规则」页；
  - 模块下有几个子页的（采购、费用与备用金）用同一排页签（`PurchasingTabs`、`ExpenseTabs`：`SubNav` 的页签自带地址）。

## 6. 名词

- **沽清**（8.1.15，店主 2026-11-19《浴族系统需求汇总》餐饮第 1 条）：一道菜今天卖完、不再接单；也指给一道菜定「今天还剩几份」。页面、提示、导出、权限名、审计动作的中文名、用例、注释都写「沽清」，不写「估清」——两个写法是同一个意思，以前的交接说明、变更记录、决定记录里的「估清」不回头改。数据库里的表名、键与接口地址不动（`dish_limits`、`/dining/limits`、`DISH_SOLD_OUT`）。`npm run check:code` 第 4 条查主线的源码与用例；小程序线的目录由小程序线自己改。

