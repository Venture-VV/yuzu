import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { loadConfig, type AppConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { createStaff } from '../src/server/modules/staff';
import { demoSeedWindow } from '../src/server/ops/demo-time';

import { dropPublicSchema, recreateFromTemplate, testDbUrl } from './test-db';

/** 测试库：并行跑时每个进程一个库（见 tests/test-db.ts、vitest.config.ts） */
export const TEST_DB = testDbUrl();
export const PASSWORD = 'test-pass-2026';

export interface TestContext {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  owner: string;
  clerk: string;
  ownerId: number;
  clerkId: number;
  close: () => Promise<void>;
}

/**
 * 把 8.0.20 起默认开的功能开关都关上（技师、餐饮与桌台、客房、平板点餐、实时位置、员工食堂与安保巡场、企业微信周推）：
 * 之前的用例从「都关着」开始、用到哪样自己打开。新加的功能开关（8.0.20 的扣库存等）不在这里，新用例按默认开写——
 * 只有自动补货例外（到点自己建单，结果随钟点变）。
 */
export async function legacySwitchesOff(sql: Sql): Promise<void> {
  const off = { enabled: false };
  await sql`INSERT INTO settings (key, value) VALUES
    ('technician_rules', ${sql.json(off)}), ('room_rules', ${sql.json(off)}), ('emenu_rules', ${sql.json(off)}), ('location_rules', ${sql.json(off)}),
    -- 8.1.15 块 B1：结账以后先待清台（默认开）；之前的用例按结账后桌台直接可用编写，这里关上，新行为由 tests/dining-v8115*.test.ts 打开了验证
    ('dining_rules', ${sql.json({ enabled: false, tablesEnabled: false, clearAfterCheckout: false })}),
    ('erp_modules', ${sql.json({ canteen: false, patrol: false })}),
    ('wecom_weekly_push', 'false'::jsonb),
    -- 自动补货（8.0.20 新加的）到点会自己建采购单草稿，结果随钟点变；别的用例里关着，它自己的用例里打开
    ('auto_replenish', ${sql.json({ enabled: false })}),
    -- 提需核库（8.1.10，CK12）：开着时选了物料、总仓有货的需求单先进「待核库」、核完才能审核；之前的用例按提交即待审核编写，
    -- 这里关上，核库的行为由 tests/stock-check.test.ts 打开了验证
    ('purchase_rules', ${sql.json({ stockCheckEnabled: false })}),
    -- 发牌前风控（8.1.15，docs/FRONTDESK_RISK_V8115.md）：开着时发牌会把会员当天待到店的预约顺带标成「已到店」，
    -- 之前的预约用例是发牌以后再点到店；这里关上，风控的行为由 tests/frontdesk-risk.test.ts 打开了验证
    ('frontdesk_risk_rules', ${sql.json(off)})
    ON CONFLICT (key) DO NOTHING`;
}

/** 清空测试库、执行迁移、建好店主与店员，返回已登录的 cookie。 */
export async function setup(options: { keepDefaultSwitches?: boolean } = {}): Promise<TestContext> {
  process.env.APP_ENV = 'test';
  // 对外接口用模拟的（8.0.21，docs/INTEGRATIONS_V8021.md）：开票服务商、支付、平台验券都不连真的
  const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent', integrations: { mock: true, liveConfigured: [] } });
  // 并行时从迁移好的模板库整库复制一份新的；不并行时照旧清空、迁移（见 tests/test-db.ts）
  const fresh = await recreateFromTemplate();
  const sql = createSql(TEST_DB, { max: 20 });
  if (!fresh) await dropPublicSchema(sql);
  await migrate(sql);
  // 「收款前必须先开班」（R1.2）默认开启；之前的用例按开班可选的口径编写，这里关闭，
  // 开启时的行为由 tests/r1-funds.test.ts 单独验证（openShiftRequired(ctx) 重新开启）
  await sql`INSERT INTO settings (key, value) VALUES ('require_open_shift', 'false'::jsonb)`;
  // 会员体系 v2（v0.7.23）的首充 / 续充最低默认 5,000 元；之前的用例按小额充值编写，这里设成不限，
  // 最低充值的行为由 tests/membership.test.ts 单独验证（那里按需改回）
  await sql`INSERT INTO settings (key, value) VALUES ('membership_rules', ${sql.json({ firstRechargeMinCents: 0, topUpMinCents: 0 })})`;
  // 8.0.4 的充值当日储值消费比例默认 70%（HY01）：之前的用例常在同一天先充值再消费，这里设成不限，
  // 比例的行为由 tests/membership-v804.test.ts 单独验证（那里按需改回 70）
  await sql`INSERT INTO settings (key, value) VALUES ('recharge_spend_pct', 'null'::jsonb)`;
  // 8.1.15 的实体卡押金默认 20 元：之前的用例发卡不收押金（也不开班），这里设成不收，
  // 押金的行为由 tests/member-card-types.test.ts 单独验证（那里改回 20 元）
  await sql`INSERT INTO settings (key, value) VALUES ('member_form_rules', ${sql.json({ cardDeposit: 0 })})`;
  // 8.0.20 起功能开关都默认开（店主 2026-11-14，迁移 126）；之前的用例按「默认关、用到时自己打开」的口径编写，这里都关上，
  // 默认开与迁移 126 的行为由 tests/switches-default.test.ts 单独验证（那里不经这一段）
  if (!options.keepDefaultSwitches) await legacySwitchesOff(sql);
  const ownerId = await createStaff(sql, { username: 'owner', displayName: '测试店主', role: 'owner', password: PASSWORD, mustChangePassword: false });
  const clerkId = await createStaff(sql, { username: 'clerk', displayName: '测试店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  const app = await buildApp(sql, config);
  const owner = await login(app, 'owner');
  const clerk = await login(app, 'clerk');
  return {
    app,
    sql,
    config,
    owner,
    clerk,
    ownerId,
    clerkId,
    close: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
    },
  };
}

export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`登录失败 ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'yuzu_sid');
  return `yuzu_sid=${cookie!.value}`;
}

export async function api<T = any>(app: FastifyInstance, cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}

/**
 * 没给手机号时自动取一个：166 号段、按顺序往下排，不会与用例里写死的号码（都是 199、13x 等）相撞，同一个文件里几次调用之间也不会撞。
 * 原来是「1990000 + 随机四位」（19900001000–19900009999），正好盖住用例里写死的 1990000xxxx。
 * 2026-11-14 main（68391d6）第一次 CI 里 concierge-rectify 的一条用例第一行建会员报 PHONE_EXISTS、整轮集成测试失败：
 * 那次日志里接口报错写的占用者是「整改企业会员二」（同一文件上一条用例用 19900003002 建的），同一时刻数据库的唯一约束报错
 * 写的是 Key (phone)=(19900003002)——自动取的号撞上了写死的号。同一提交重跑通过，但第一次失败的记录仍在。
 * 这里改的是测试夹具（自动取的号不再落在写死的号段里），不涉及业务代码。
 */
let autoPhoneSeq = 0;
const nextAutoPhone = () => `1660${String(1_000_000 + autoPhoneSeq++)}`;

export async function createMember(ctx: TestContext, name = '测试会员', phone?: string) {
  const res = await api(ctx.app, ctx.clerk, 'POST', '/api/members', {
    name,
    phone: phone ?? nextAutoPhone(),
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: number; principalBalance: number; bonusBalance: number };
}

export function rechargeBody(memberId: number, paid: number, bonus = 0, extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    memberId,
    planId: null,
    paidAmount: paid,
    bonusAmount: bonus,
    paymentMethod: 'wechat',
    paymentConfirmed: true,
    ...extra,
  };
}

/** 默认假设会员只有本金（扣款构成 = 全部扣本金）；有赠金的场景通过 extra.expectedSplit 指定 */
export function consumeBody(memberId: number, amount: number, extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    memberId,
    customLines: [{ name: '测试消费', amount }],
    expectedTotal: amount,
    expectedSplit: { principal: amount, bonus: 0 },
    ...extra,
  };
}

export async function balanceOf(ctx: TestContext, memberId: number) {
  const res = await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}`);
  return { principal: res.body.principalBalance as number, bonus: res.body.bonusBalance as number };
}

export async function setRule(ctx: TestContext, deductionRule: string) {
  const current = await api(ctx.app, ctx.owner, 'GET', '/api/settings');
  const res = await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { ...current.body, deductionRule });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
}

/**
 * 灌演示数据（前台、结账）用的时刻：演示里收银员的班次在灌数据前 5 小时开班，结账在 1 小时之内。
 * 在营业日切换（06:00，上海时间）之后 5 个半小时内灌数据时，班次会落在结账单的前一个营业日，按营业日核对的用例对不上；
 * 这段时间把灌数据的时刻挪到 05:30，演示数据整体落在前一个营业日、彼此一致。
 */
/**
 * 把询价门槛设回 ¥5,000（8.0.17 以前的默认；8.0.17 起默认 ¥1,000，店主 2026-11-13，LC2）。
 * 这些用例造的采购单多在 ¥1,000–¥5,000 之间，测的是审批、收货、付款等别的事，不是询价门槛：
 * 开头把门槛放回写用例时的数，采购单才能照原来的写法直接提交。门槛本身的用例在 erp-purchasing、purchase-flow 里按新默认测。
 */
export async function useLegacyQuoteThreshold(ctx: TestContext) {
  await ctx.sql`
    INSERT INTO settings (key, value) VALUES ('purchase_rules', ${ctx.sql.json({ quoteThresholdCents: 500_000 })})
    ON CONFLICT (key) DO UPDATE SET value = settings.value || excluded.value`;
}

export function demoSeedTime(now = new Date()): Date {
  // 与命令行 --previous-day 同一规则（src/server/ops/demo-time.ts）
  return demoSeedWindow(now, 'Asia/Shanghai', 6)?.anchor ?? now;
}

/**
 * 全部迁移（按号排好；v0.7.25 起只维护这一处）：两条开发线各加迁移时只在这里加一行，升级用例用 migrationsFrom 取
 * 「从某个迁移起应该应用哪些」，不再各写一份。tests/migrations-list.test.ts 核对这份清单与 src/server/migrations 一致、编号不撞。
 */
export const ALL_MIGRATIONS: readonly string[] = [
  '001_init.sql',
  '002_inventory.sql',
  '003_purchasing.sql',
  '004_frontdesk.sql',
  '005_frontdesk_g2.sql',
  '006_op_fences.sql',
  '007_manager_roles.sql',
  '008_locker_pool.sql',
  '009_price_tiers.sql',
  '010_wallet_limits.sql',
  '011_member_fields.sql',
  '012_bonus_expiry.sql',
  '013_opening_balances.sql',
  '014_checkout.sql',
  '015_shifts.sql',
  '016_shift_boundary.sql',
  '017_r1_funds.sql',
  '018_backfill.sql',
  '019_admin_members.sql',
  '020_technicians.sql',
  '021_clockroom.sql',
  '022_dining.sql',
  '023_dining_tables.sql',
  '024_rooms.sql',
  '025_cashier.sql',
  '026_expenses.sql',
  '027_requisitions.sql',
  '028_legacy_ledger.sql',
  '029_warehouses.sql',
  '030_supplier_settlement.sql',
  '031_stock_cycles.sql',
  '032_spaces.sql',
  '033_floorplans.sql',
  '034_floormap.sql',
  '035_locations.sql',
  '036_floorplan_finish.sql',
  '037_refunds_coupons.sql',
  '038_devices.sql',
  '039_payment_fences.sql',
  '040_membership_v2.sql',
  '041_benefits.sql',
  '042_member_discounts_trials.sql',
  '043_miniprogram.sql',
  '044_miniprogram_fences.sql',
  '045_ticket_extension.sql',
  '046_mp_recharge.sql',
  '047_membership_finish.sql',
  '048_mp_coupons_refunds.sql',
  '049_mp_claim_refund_route.sql',
  '050_mp_reminders_retention.sql',
  '051_mp_entries.sql',
  '052_usage_charges.sql',
  '053_bookings.sql',
  '054_count_cards.sql',
  '055_platform_redemptions.sql',
  '056_print_documents.sql',
  '057_member_cards.sql',
  '058_challenge_parking.sql',
  '059_shift_drawers.sql',
  '060_member_history.sql',
  '061_mp_invites.sql',
  '062_mp_food.sql',
  '063_mp_bookings.sql',
  '070_purchase_channels.sql',
  '071_petty_accounts.sql',
  '072_sourcing.sql',
  '073_approval_center.sql',
  '074_sourcing_requests.sql',
  '075_stocktake_variance.sql',
  '076_approval_op_fences.sql',
  '077_contracts.sql',
  '078_po_contracts.sql',
  '079_contract_scan_scope.sql',
  '080_payment_requests.sql',
  '081_three_way_match.sql',
  '082_purchasing_flow.sql',
  '083_suppliers_contracts.sql',
  '084_receipt_attachments.sql',
  '085_gift_receipts.sql',
  '086_expense_budgets.sql',
  '087_input_invoices.sql',
  '088_member_tags_vip.sql',
  '089_coupon_campaigns.sql',
  '090_canteen.sql',
  '091_canteen_join.sql',
  '092_canteen_reply_ops.sql',
  '093_purchasing_ops.sql',
  '094_coupon_campaign_ops.sql',
  '095_sms_outbox_lease.sql',
  '096_canteen_mailbox_mobile.sql',
  '097_supplier_admission.sql',
  '098_consumption_purpose.sql',
  '099_acceptance_templates.sql',
  '100_recon_links.sql',
  '101_receivables.sql',
  '102_assets.sql',
  '103_expiry.sql',
  '104_wecom_pushes.sql',
  '105_stocktake_result_limits.sql',
  '106_stocktake_client_key.sql',
  '107_clockroom_v808.sql',
  '108_rooms_v808.sql',
  '109_dining_v808.sql',
  '110_technician_state_ops.sql',
  '111_patrol.sql',
  '112_patrol_repeats.sql',
  '120_canteen_push.sql',
  '121_emenu.sql',
  '122_patrol_rounds.sql',
  '123_emenu_english.sql',
  '124_quote_threshold_default.sql',
  '125_dept_head_confirm.sql',
  '126_switches_on.sql',
  '127_stock_cost.sql',
  '128_stock_usage.sql',
  '129_replenish_runs.sql',
  '130_request_drafts_imports.sql',
  '135_concierge.sql',
  '136_concierge_native_resources.sql',
  '137_concierge_praise.sql',
  '138_linen.sql',
  '139_room_member_prices.sql',
  '140_linen_ops.sql',
  '141_custom_fields.sql',
  '142_invoice_entry_method.sql',
  '143_invoice_requests.sql',
  '144_bank_statements.sql',
  '145_payment_batches.sql',
  '146_contract_templates.sql',
  '147_supplier_links.sql',
  '148_pay_terminal.sql',
  '149_platform_verify.sql',
  '150_ota.sql',
  '151_supplier_bank_verify.sql',
  '152_po_confirm_revision.sql',
  '153_stores.sql',
  '154_store_columns.sql',
  '155_warehouses_transfers.sql',
  '156_entity_columns.sql',
  '157_store_prices.sql',
  '158_ai.sql',
  '161_replenish_mode.sql',
  '162_customer_workbench.sql',
  '163_customer_credit_canonical.sql',
  '164_studio.sql',
  '165_studio_surfaces.sql',
  '166_studio_schedule_comments.sql',
  '180_emenu_periods.sql',
  '181_dining_slots.sql',
  '182_petty_pool.sql',
  '183_direct_receipts.sql',
  '184_gifts.sql',
  '185_stock_check.sql',
  '186_urgent_contract.sql',
  '187_frontdesk_risk.sql',
  '188_dining_tables_v8115.sql',
  '189_dishes.sql',
  '190_room_center.sql',
  '191_technician_admin.sql',
  '192_member_cards_v8115.sql',
  '193_room_center_ops.sql',
  '194_positions.sql',
  '196_dishes_v8117.sql',
  '197_combo_parts_v8117.sql',
  '198_store_price_changes.sql',
  '199_dining_voids_v8117.sql',
  '200_ledger_imports.sql',
  '201_position_catalog.sql',
];

/** 从 first（含）起到最后一个迁移：升级用例从某个版本的库升级时应该应用的迁移 */
export function migrationsFrom(first: string): string[] {
  const i = ALL_MIGRATIONS.indexOf(first);
  if (i < 0) throw new Error(`迁移清单里没有 ${first}`);
  return ALL_MIGRATIONS.slice(i);
}

/**
 * 8.1.18（迁移 194，docs/POSITIONS_V8118.md GW7）起，升级前就有的员工账号第一次登录要先自己选新岗位，没选之前接口都回 POSITION_REQUIRED。
 * 验别的迁移的升级用例不管选岗，升级完把这一步当作已经选过（照旧按旧岗位的权限）；选岗本身由 tests/upgrade-positions.test.ts 验。
 */
export async function skipPositionPrompt(sql: Sql) {
  await sql`UPDATE staff SET needs_position = false`;
}
