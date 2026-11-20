// 测试计划的配置（docs/TESTING.md 第 6 节）：哪些文件改了要全量、哪些只跑沾边的、哪些用例每次都跑。
// 只写规则，不写逻辑；逻辑在 scripts/test-plan.mjs。路径写法：** 跨目录，* 不跨目录。
// 拿不准的一律按高风险（全量）处理：这里漏写一条，最多是多跑，不会少跑。

/**
 * 高风险：改到就全量（集成测试、浏览器验收、演示数据、升级四样都跑）。
 * 资金与账本、加锁与幂等、权限与登录、数据结构与迁移、演示数据，以及测试与 CI 本身（改了它们，「挑哪些」的依据就变了）。
 */
export const HIGH_RISK = [
  { glob: 'src/server/migrations/**', why: '数据结构（迁移）' },
  { glob: 'src/server/migrate.ts', why: '数据结构（迁移）' },
  { glob: 'src/server/db.ts', why: '数据库连接与事务' },
  { glob: 'src/server/modules/wallet*', why: '会员钱包（唯一的储值账本）' },
  { glob: 'src/server/modules/ledger.ts', why: '账本流水' },
  { glob: 'src/server/modules/frontdesk/**', why: '前台收银核心' },
  { glob: 'src/server/modules/shifts.ts', why: '交班' },
  { glob: 'src/server/modules/settlement.ts', why: '日结' },
  { glob: 'src/server/auth/**', why: '登录与会话' },
  { glob: 'src/server/lib/idempotency.ts', why: '操作编号（幂等）' },
  { glob: 'src/server/lib/fences.ts', why: '确认作废' },
  { glob: 'src/shared/permissions.ts', why: '权限表' },
  { glob: 'src/shared/money.ts', why: '金额计算' },
  { glob: 'src/shared/deduction.ts', why: '扣款规则' },
  { glob: 'src/shared/types.ts', why: '前后端共用的类型（几乎处处在用）' },
  { glob: 'src/server/app.ts', why: '登记处：所有路由' },
  { glob: 'src/server/index.ts', why: '应用启动' },
  { glob: 'src/server/config.ts', why: '应用配置' },
  { glob: 'src/server/jobs.ts', why: '每分钟任务' },
  { glob: 'src/server/bootstrap.ts', why: '应用启动' },
  { glob: 'src/server/cli.ts', why: '运维命令（自检、演示数据、备份）' },
  { glob: 'src/server/ops/**', why: '运维（备份、对账包、自检）' },
  { glob: 'src/server/seed*.ts', why: '演示数据' },
  { glob: 'src/server/demo/**', why: '演示数据与固定预期' },
  { glob: 'src/client/App.tsx', why: '前端路由登记处' },
  { glob: 'src/client/main.tsx', why: '前端入口' },
  { glob: 'scripts/*.sh', why: '运维脚本' },
  { glob: 'scripts/lib/**', why: '运维脚本' },
  { glob: '.github/**', why: 'CI 本身' },
  { glob: 'scripts/ci/**', why: 'CI 本身' },
  { glob: 'scripts/test-plan*.mjs', why: '测试计划本身' },
  { glob: 'scripts/test-tiers.mjs', why: '测试分档本身' },
  { glob: 'tests/helpers.ts', why: '集成测试的公共准备' },
  { glob: 'tests/test-db.ts', why: '集成测试的公共准备' },
  { glob: 'tests/global-setup.ts', why: '集成测试的公共准备' },
  { glob: 'tests/setup-timeouts.ts', why: '集成测试的公共准备' },
  { glob: 'tests/app-only-env.ts', why: '集成测试的公共准备' },
  { glob: 'tests/fixtures/**', why: '集成测试的公共数据' },
  { glob: 'e2e/*.ts', why: '浏览器验收的公共部件', unless: /\.spec\.ts$/ },
  { glob: '*.config.ts', why: '构建或测试配置' },
  { glob: 'package.json', why: '依赖' },
  { glob: 'package-lock.json', why: '依赖' },
  { glob: 'tsconfig*.json', why: '编译配置' },
  { glob: 'Dockerfile', why: '镜像' },
  { glob: 'compose*.yaml', why: '部署编排' },
];

/** 只改这些不跑集成测试与浏览器验收（静态检查照跑：文档检查、排版、治理基线都在里面） */
export const DOCS_ONLY = ['docs/**', 'brand/**', '*.md', 'CHANGELOG*', '.env.example', 'LICENSE'];

/** 小程序线自己的包：只跑「小程序」那个 job（它每次都跑），主线的用例不受影响 */
export const MP_PACKAGE = ['miniprogram/**'];

/** 员工端（员工食堂、安保巡场、设计台）另有一套浏览器验收（e2e-canteen/ 的 canteen、patrol、studio）：改到这些才跑那个 job（全量时照跑） */
export const CANTEEN = [
  'src/server/modules/canteen/**',
  'src/client/features/canteen/**',
  'src/server/modules/patrol/**',
  'src/client/features/patrol/**',
  'src/shared/patrol.ts',
  'src/server/modules/studio/**',
  'src/client/features/studio/**',
  'src/client/studio-render/**',
  'src/shared/studio/**',
  'src/shared/qr-svg.ts',
  'src/canteen-app/**',
  'src/shared/canteen*.ts',
  'e2e-canteen/**',
  'vite.canteen.config.ts',
  'playwright.canteen.config.ts',
];

/**
 * 顺着导入关系找「谁受影响」时不往上走的文件：它们引了几乎所有模块（登记处、入口、用例的公共准备），
 * 经过它们就等于全量；改到它们本身在 HIGH_RISK 里，直接全量。
 */
export const HUBS = [
  'src/server/app.ts',
  'src/server/index.ts',
  'src/server/cli.ts',
  'src/server/jobs.ts',
  'src/server/seed*.ts',
  'src/server/ops/consistency.ts',
  'src/server/modules/mp/app.ts',
  'src/client/App.tsx',
  'src/client/main.tsx',
  'tests/helpers.ts',
];

/** 顺着「谁引了我」往上找几层（用例 → 模块 → 模块 → 改到的文件） */
export const AFFECT_DEPTH = 3;

/** 改到的文件与直接引它们的文件涉及的模块超过这么多，就当影响面太广，全量 */
export const BROAD_KEYWORDS = 25;
/** 挑出来的用例超过全部的这个比例，直接全量 */
export const BROAD_SHARE = 0.6;

/**
 * 每次都跑的核心回归（按改动挑选时也跑）：资金、并发、幂等与作废、迁移清单。
 * 只在「按改动挑选」时有意义；全量本来就包含。
 */
export const ALWAYS = {
  integration: [
    'tests/acceptance.test.ts',
    'tests/concurrency.test.ts',
    'tests/checkout.test.ts',
    'tests/op-fences-constraint.test.ts',
    'tests/wallet-abandon.test.ts',
    'tests/migrations-list.test.ts',
  ],
  // 完整收银流程（门店电脑）：前台开牌 → 消费 → 结账 → 交班
  e2e: ['e2e/flows.spec.ts'],
};

/**
 * 改动的内容里有写数据的语句（下面任一条），就算「数据写入」：
 * 另加 DATA_WRITE_TESTS，计划里单列出来，测试 AI 按 docs/TESTING.md 第 6 节核对数据一致性。
 */
export const DATA_WRITE_PATTERNS = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+[a-z_."]+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bON\s+CONFLICT\b/i,
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i,
  /\bFOR\s+(?:KEY\s+)?SHARE\b/i,
  /\.begin\(/,
  /\bTRUNCATE\b/i,
];
export const DATA_WRITE_TESTS = ['tests/concurrency.test.ts', 'tests/acceptance.test.ts', 'tests/op-fences-constraint.test.ts', 'tests/recon.test.ts'];

/**
 * docs/TESTING.md 第 4 节「改了什么先跑哪些」那张对照表的每一行都在这里（Codex 审查 a88acd1：表里的行要一条不落地搬过来）。
 * 模块名对不上用例文件名的，在这里补（按改到的路径 → 额外要跑的集成测试与浏览器用例）。
 * 按文件名能对上的（例如 src/server/modules/dishes.ts → tests/dishes*.test.ts、e2e/dishes*.spec.ts）不用写。
 */
export const AREAS = [
  {
    name: '会员与储值',
    paths: [
      'src/server/modules/member*',
      'src/server/modules/membership*',
      'src/server/modules/bonus.ts',
      'src/server/modules/opening.ts',
      'src/client/features/membership/**',
      'src/client/features/workbench/**',
      'src/shared/member*.ts',
      'src/shared/membership.ts',
    ],
    tests: ['tests/wallet-*.test.ts', 'tests/deduction.test.ts', 'tests/bonus-expiry.test.ts', 'tests/opening-*.test.ts', 'tests/member-*.test.ts', 'tests/membership*.test.ts'],
    e2e: ['e2e/review-fixes.spec.ts', 'e2e/wallet-limits.spec.ts', 'e2e/member-*.spec.ts', 'e2e/membership*.spec.ts', 'e2e/storage-failure.spec.ts'],
  },
  {
    name: '登录与改密码',
    paths: ['src/client/features/auth/**'],
    tests: ['tests/login-throttle.test.ts', 'tests/auth-settlement.test.ts'],
    e2e: ['e2e/flows.spec.ts', 'e2e/resilience.spec.ts', 'e2e/review-v060.spec.ts'],
  },
  {
    name: '会员建档与会员卡押金',
    paths: ['src/server/modules/member-card*', 'src/shared/member-cards.ts', 'src/shared/member-form.ts'],
    tests: ['tests/member-card*.test.ts', 'tests/recon.test.ts', 'tests/upgrade-shift.test.ts'],
    e2e: ['e2e/member-card*.spec.ts', 'e2e/dialog-input.spec.ts', 'e2e/admin-v060.spec.ts', 'e2e/target-devices.spec.ts'],
  },
  {
    name: '退储值原路退回',
    paths: ['src/server/modules/member-refunds.ts', 'src/shared/member-refunds.ts'],
    tests: ['tests/member-refunds*.test.ts', 'tests/mp-refund.test.ts'],
    e2e: ['e2e/member-*.spec.ts'],
  },
  {
    name: '预约与登记消费',
    paths: ['src/server/modules/booking*', 'src/server/modules/usages*', 'src/client/features/bookings/**', 'src/shared/bookings.ts', 'src/shared/usages.ts'],
    tests: ['tests/bookings.test.ts', 'tests/usages.test.ts', 'tests/usage-charges.test.ts'],
    e2e: ['e2e/requests-1114.spec.ts', 'e2e/bookings.spec.ts', 'e2e/dining.spec.ts', 'e2e/emenu.spec.ts'],
  },
  {
    name: '技师与钟房',
    paths: [
      'src/server/modules/technician*',
      'src/server/modules/clock*',
      'src/server/modules/commission.ts',
      'src/client/features/technicians/**',
      'src/client/features/clockroom/**',
      'src/shared/technician*.ts',
      'src/shared/clockroom.ts',
      'src/shared/pinyin-initials.ts',
    ],
    tests: ['tests/technician*.test.ts', 'tests/clockroom*.test.ts', 'tests/catalog-tiers.test.ts', 'tests/review-v071.test.ts', 'tests/pinyin-initials.test.ts'],
    e2e: ['e2e/technician*.spec.ts', 'e2e/clockroom.spec.ts', 'e2e/target-devices.spec.ts'],
  },
  {
    name: '客户部',
    paths: ['src/server/modules/customer/**', 'src/client/features/customer/**', 'src/shared/customer*.ts'],
    tests: ['tests/customer-*.test.ts'],
    e2e: ['e2e/customer.spec.ts'],
  },
  {
    name: '前台与收银',
    paths: [
      'src/client/features/frontdesk/**',
      'src/client/features/settlement/**',
      'src/client/features/shift/**',
      'src/shared/frontdesk*.ts',
      'src/shared/checkout.ts',
      'src/shared/backfill.ts',
      'src/server/modules/refund*',
      'src/server/modules/print.ts',
      'src/server/modules/payments/**',
    ],
    tests: [
      'tests/frontdesk*.test.ts',
      'tests/checkout.test.ts',
      'tests/cashier.test.ts',
      'tests/r1-funds.test.ts',
      'tests/backfill.test.ts',
      'tests/refund-drawer.test.ts',
      'tests/shift-*.test.ts',
      'tests/settlement-snapshot.test.ts',
      'tests/auth-settlement.test.ts',
      'tests/recon.test.ts',
      'tests/print*.test.ts',
    ],
    e2e: [
      'e2e/frontdesk*.spec.ts',
      'e2e/cashier.spec.ts',
      'e2e/r1-funds.spec.ts',
      'e2e/backfill.spec.ts',
      'e2e/line-move.spec.ts',
      'e2e/print.spec.ts',
      'e2e/regression/**',
      'e2e/shift-drawers.spec.ts',
    ],
  },
  {
    name: '发卡台与收银台',
    paths: ['src/client/features/frontdesk/desks*', 'src/shared/frontdesk-risk.ts'],
    tests: ['tests/desks*.test.ts', 'tests/frontdesk-risk.test.ts'],
    e2e: ['e2e/desks.spec.ts', 'e2e/frontdesk-risk.spec.ts', 'e2e/cashier.spec.ts', 'e2e/admin-ia.spec.ts'],
  },
  {
    name: '餐饮与桌台',
    paths: [
      'src/server/modules/dining*',
      'src/server/modules/dish*',
      'src/server/modules/emenu/**',
      'src/client/features/dining/**',
      'src/client/features/emenu/**',
      'src/shared/dining*.ts',
      'src/shared/dishes.ts',
      'src/shared/emenu.ts',
    ],
    tests: ['tests/dining*.test.ts', 'tests/dish*.test.ts', 'tests/emenu*.test.ts', 'tests/tables-*.test.ts', 'tests/upgrade-dining-*.test.ts', 'tests/upgrade-dishes.test.ts'],
    e2e: ['e2e/dining*.spec.ts', 'e2e/dishes*.spec.ts', 'e2e/emenu*.spec.ts'],
  },
  {
    name: '客房与房态中心',
    paths: ['src/server/modules/room*', 'src/client/features/rooms/**', 'src/client/features/room-center/**', 'src/shared/room*.ts'],
    tests: ['tests/rooms*.test.ts', 'tests/room-center.test.ts', 'tests/upgrade-room-center.test.ts', 'tests/tag-scan.test.ts', 'tests/store-nav.test.ts'],
    e2e: ['e2e/rooms.spec.ts', 'e2e/room-center.spec.ts', 'e2e/frontdesk-808.spec.ts', 'e2e/floormap.spec.ts', 'e2e/locations.spec.ts'],
  },
  {
    name: '空间、底图、房态图、实时位置',
    paths: [
      'src/server/floorplan/**',
      'src/server/modules/floor*',
      'src/server/modules/locations.ts',
      'src/server/modules/spaces*',
      'src/client/features/spaces/**',
      'src/shared/floor*.ts',
      'src/shared/spaces.ts',
      'src/shared/locations.ts',
    ],
    tests: ['tests/spaces.test.ts', 'tests/floorplan*.test.ts', 'tests/floormap.test.ts', 'tests/locations.test.ts', 'tests/upgrade-floor*.test.ts'],
    e2e: ['e2e/spaces.spec.ts', 'e2e/floorplans.spec.ts', 'e2e/floormap.spec.ts', 'e2e/locations.spec.ts'],
  },
  {
    name: 'ERP（库存、采购、应付、报销）',
    paths: [
      'src/server/modules/inventory/**',
      'src/server/modules/purchas*',
      'src/server/modules/request*',
      'src/server/modules/expenses.ts',
      'src/server/modules/erp*',
      'src/server/modules/petty*',
      'src/server/modules/receivables.ts',
      'src/server/modules/invoices.ts',
      'src/server/modules/budgets.ts',
      'src/server/modules/legacy/**',
      'src/client/features/inventory/**',
      'src/client/features/purchasing/**',
      'src/client/features/erp/**',
      'src/client/features/requests/**',
      'src/client/features/expenses/**',
      'src/client/features/dept-stock/**',
      'src/client/features/payables/**',
      'src/client/features/legacy/**',
      'src/shared/inventory.ts',
      'src/shared/purchasing.ts',
      'src/shared/erp.ts',
      'src/shared/requests.ts',
      'src/shared/supply.ts',
    ],
    tests: [
      'tests/inventory*.test.ts',
      'tests/purchas*.test.ts',
      'tests/supplier-*.test.ts',
      'tests/stock-*.test.ts',
      'tests/warehouses.test.ts',
      'tests/expenses.test.ts',
      'tests/request*.test.ts',
      'tests/erp*.test.ts',
      'tests/replenish-mode.test.ts',
      'tests/auto-replenish.test.ts',
      'tests/legacy.test.ts',
      'tests/petty-pool.test.ts',
    ],
    e2e: [
      'e2e/inventory.spec.ts',
      'e2e/warehouses.spec.ts',
      'e2e/supplier-*.spec.ts',
      'e2e/stock-cycles.spec.ts',
      'e2e/expenses.spec.ts',
      'e2e/request*.spec.ts',
      'e2e/purchase-*.spec.ts',
      'e2e/erp*.spec.ts',
      'e2e/legacy.spec.ts',
    ],
  },
  {
    name: '后台、岗位权限、看板',
    paths: [
      'src/server/modules/admin.ts',
      'src/server/modules/staff*',
      'src/server/modules/roles*',
      'src/server/modules/dashboard.ts',
      'src/client/features/admin/**',
      'src/client/features/dashboard/**',
      'src/shared/admin.ts',
      'src/shared/instance.ts',
    ],
    tests: ['tests/admin-*.test.ts', 'tests/roles.test.ts', 'tests/instance.test.ts', 'tests/regression/**'],
    e2e: ['e2e/admin-*.spec.ts', 'e2e/review-v060.spec.ts', 'e2e/viewports.spec.ts', 'e2e/pending-marks.spec.ts', 'e2e/regression/**'],
  },
  {
    name: '请求层、连接状态、页面不白屏、服务端防护',
    paths: ['src/client/lib/**', 'src/client/components/**', 'src/server/lib/protect*', 'src/shared/resilience.ts'],
    tests: ['tests/client-*.test.ts', 'tests/protection.test.ts', 'tests/check-code.test.ts'],
    e2e: ['e2e/resilience.spec.ts', 'e2e/flows.spec.ts', 'e2e/frontdesk-recovery.spec.ts', 'e2e/storage-failure.spec.ts', 'e2e/viewports.spec.ts', 'e2e/target-devices.spec.ts'],
  },
  {
    name: '页面样式与视口',
    paths: ['src/client/styles.css', 'src/client/index.html', 'src/client/public/**'],
    tests: ['tests/theme-contrast.test.ts', 'tests/dvh-fallback.test.ts'],
    e2e: ['e2e/viewports.spec.ts', 'e2e/target-devices.spec.ts', 'e2e/ys-v8117.spec.ts', 'e2e/motion.spec.ts'],
  },
  {
    name: '文档与治理检查脚本',
    paths: ['scripts/check-*.mjs', 'scripts/governance-baseline.json', 'AGENTS.md', 'GEMINI.md'],
    tests: ['tests/check-*.test.ts', 'tests/version-source.test.ts', 'tests/line-scope.test.ts', 'tests/test-tiers.test.ts', 'tests/test-plan.test.ts'],
    e2e: [],
  },
];
