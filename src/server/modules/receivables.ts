// 应收与挂账（8.0.7 ERP P2 3.1，docs/ERP_V807.md，迁移 101）：
//   · 协议单位：名称、联系人、电话、挂账额度（空 = 不限，V11）、启用；维护要「应收与挂账：维护」，前台挂账要岗位权限「挂账」（V12）。
//   · 结账挂账：结账收款多一种「挂账」，选协议单位、写签单人；算营业额（应收、净营业额），不算实收；超过额度拒绝（AR_LIMIT）。
//     反结账时挂账作废；已经回款核销过的不能反结账（AR_COLLECTED），要先冲销那笔回款。
//   · 回款：财务登记（日期、方式、金额、凭据），核销到这个单位没结清的挂账（没指定的从最早的开始）；不能超过没结清的金额；
//     当月可以冲销。回款在 ERP 里，不进前台交班、日结（V13）。
//   · 平台回款：团购券（结账登记的 + 补录的）应结 − 平台打款（与「平台核销」对账同一口径），按核销日先进先出看还没回来的。
//   · 账龄：协议单位与平台的未回款按 0–30、31–60、61–90、90 天以上分段；超过 N 天（V14，默认 60）的进 ERP 待办。
// 锁：结账在已有的锁之后锁协议单位一行（FOR UPDATE，额度在锁里核对）再写挂账；反结账在结账单之后锁这张结账的挂账（id 升序）；
// 回款：操作编号的咨询锁 → 协议单位一行 → 挂账（id 升序）；冲销回款：协议单位一行 → 回款一行。没有反过来的路径。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGING_BUCKETS, agingKeyOf, AR_METHODS, type AgingKey, type AgingRow, type ArAccount, type ArAccountDetail, type ArAccountOption, type ArAging, type ArCharge, type ArCollection, type ArTodo, type PlatformReceivable } from '@shared/ar';
import { COUPON_PLATFORM_LABELS, COUPON_PLATFORMS, type CouponPlatform } from '@shared/checkout';
import { formatYuan } from '@shared/money';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { daysBetween, todayIn } from '../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { dateSchema, idParam, parse } from '../lib/validate';
import { enabledErpModules, erpModuleDisabled } from './erp';
import { erpOpAbandoned } from './erp-ops';
import { loadSettings } from './settings';

// ───────────────────────── 协议单位 ─────────────────────────

const AccountInput = z.object({
  code: z.string('请填写编码').trim().regex(/^[A-Za-z0-9-]{1,16}$/, '编码只能用字母、数字、短横线，最多 16 位'),
  name: z.string('请填写名称').trim().min(1, '请填写名称').max(40, '名称最多 40 个字'),
  contact: z.string().trim().max(40, '联系人最多 40 个字').default(''),
  phone: z.string().trim().max(32, '电话最多 32 个字').default(''),
  creditLimitCents: z.number('额度要填金额').int().positive('额度要大于 0').max(10_000_000_000, '额度太大了').nullable().default(null),
  active: z.boolean().default(true),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
});
const UpdateInput = AccountInput.extend({ expectedVersion: z.number('缺少版本号，请刷新后再改').int().positive() });

/** 每笔挂账还没结清的（扣掉没冲销的回款核销） */
const OPEN_SQL = (db: Db) => db`
  c.amount_cents - coalesce((SELECT sum(a.amount_cents) FROM ar_allocations a JOIN ar_collections k ON k.id = a.collection_id
                             WHERE a.charge_id = c.id AND k.voided_at IS NULL), 0)`;

export async function listAccounts(db: Db, includeInactive = true): Promise<ArAccount[]> {
  const rows = await db<(Omit<ArAccount, 'outstandingCents'> & { outstandingCents: string })[]>`
    SELECT a.id, a.code, a.name, a.contact, a.phone, a.credit_limit_cents, a.active, a.note, a.version,
           coalesce((SELECT sum(${OPEN_SQL(db)}) FROM ar_charges c WHERE c.account_id = a.id AND c.status = 'open'), 0)::text AS outstanding_cents,
           (SELECT min(c.business_date)::text FROM ar_charges c WHERE c.account_id = a.id AND c.status = 'open' AND ${OPEN_SQL(db)} > 0) AS oldest_open_date
    FROM ar_accounts a ${includeInactive ? db`` : db`WHERE a.active`}
    ORDER BY a.active DESC, a.code`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    creditLimitCents: r.creditLimitCents === null ? null : Number(r.creditLimitCents),
    outstandingCents: Number(r.outstandingCents),
  }));
}

export async function accountOptions(db: Db): Promise<ArAccountOption[]> {
  return (await listAccounts(db, false)).map(({ id, code, name, creditLimitCents, outstandingCents }) => ({ id, code, name, creditLimitCents, outstandingCents }));
}

async function saveAccount(deps: Deps, id: number | null, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  try {
    if (id === null) {
      const a = parse(AccountInput, raw);
      const [row] = await deps.sql<{ id: number }[]>`
        INSERT INTO ar_accounts (code, name, contact, phone, credit_limit_cents, active, note, created_by)
        VALUES (${a.code}, ${a.name}, ${a.contact}, ${a.phone}, ${a.creditLimitCents}, ${a.active}, ${a.note}, ${actor.id}) RETURNING id`;
      await writeAudit(deps.sql, { staffId: actor.id, action: 'ar_unit', targetType: 'ar_account', targetId: row!.id, detail: { op: 'create', ...a }, ip });
      return Number(row!.id);
    }
    const a = parse(UpdateInput, raw);
    await deps.sql.begin(async (tx) => {
      const [cur] = await tx<{ version: number }[]>`SELECT version FROM ar_accounts WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('协议单位不存在');
      if (cur.version !== a.expectedVersion) throw conflict('VERSION_CONFLICT', '协议单位刚被别人改过，请刷新后再改');
      await tx`
        UPDATE ar_accounts SET code = ${a.code}, name = ${a.name}, contact = ${a.contact}, phone = ${a.phone}, credit_limit_cents = ${a.creditLimitCents},
               active = ${a.active}, note = ${a.note}, version = version + 1, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'ar_unit', targetType: 'ar_account', targetId: id, detail: { op: 'update', ...a }, ip });
    });
    return id;
  } catch (error) {
    if (isUniqueViolation(error, 'ar_accounts_code_key')) throw conflict('CODE_EXISTS', '编码已经有了');
    if (isUniqueViolation(error, 'ar_accounts_name_key')) throw conflict('NAME_EXISTS', '已经有同名的协议单位');
    throw error;
  }
}

// ───────────────────────── 结账挂账（在结账的事务里） ─────────────────────────

/**
 * 记一笔挂账（结账收款里的「挂账」）：在结账已有的锁之后锁协议单位一行，核对启用与额度，写收款明细与挂账。
 * 应收与挂账模块关着时拒绝（ERP_MODULE_DISABLED）。
 */
export async function chargeOnAccount(tx: Tx, a: { checkoutId: number; accountId: number; signer: string; amount: number; date: string; staffId: number }) {
  if (!(await enabledErpModules(tx)).has('receivables')) throw erpModuleDisabled('receivables');
  const [acc] = await tx<{ name: string; active: boolean; creditLimitCents: number | null }[]>`
    SELECT name, active, credit_limit_cents FROM ar_accounts WHERE id = ${a.accountId} FOR UPDATE`;
  if (!acc) throw unprocessable('AR_ACCOUNT_INVALID', '协议单位不存在，请重新选择');
  if (!acc.active) throw unprocessable('AR_ACCOUNT_INVALID', `协议单位「${acc.name}」已停用，不能挂账`);
  if (acc.creditLimitCents !== null) {
    const [o] = await tx<{ cents: string }[]>`
      SELECT coalesce(sum(${OPEN_SQL(tx)}), 0)::text AS cents FROM ar_charges c WHERE c.account_id = ${a.accountId} AND c.status = 'open'`;
    const open = Number(o!.cents);
    const limit = Number(acc.creditLimitCents);
    if (open + a.amount > limit) {
      throw unprocessable('AR_LIMIT', `「${acc.name}」的挂账额度 ${formatYuan(limit)}，还没结清 ${formatYuan(open)}，这次最多还能挂 ${formatYuan(Math.max(0, limit - open))}`, {
        limitCents: limit,
        openCents: open,
      });
    }
  }
  const [p] = await tx<{ id: number }[]>`
    INSERT INTO checkout_payments (checkout_id, method, amount, ref, ar_account_id)
    VALUES (${a.checkoutId}, 'on_account', ${a.amount}, ${a.signer}, ${a.accountId}) RETURNING id`;
  await tx`
    INSERT INTO ar_charges (account_id, checkout_id, payment_id, amount_cents, business_date, signer, created_by)
    VALUES (${a.accountId}, ${a.checkoutId}, ${p!.id}, ${a.amount}, ${a.date}, ${a.signer}, ${a.staffId})`;
}

/** 反结账（在结账单的锁之后）：这张结账单的挂账作废；已经回款核销过的拒绝（AR_COLLECTED） */
export async function voidChargesOfCheckout(tx: Tx, checkoutId: number, checkoutNo: string, staffId: number, at: Date) {
  const charges = await tx<{ id: number; accountName: string }[]>`
    SELECT c.id, a.name AS account_name FROM ar_charges c JOIN ar_accounts a ON a.id = c.account_id
    WHERE c.checkout_id = ${checkoutId} AND c.status = 'open' ORDER BY c.id FOR UPDATE OF c`;
  for (const c of charges) {
    const [used] = await tx<{ docNo: string }[]>`
      SELECT k.doc_no FROM ar_allocations a JOIN ar_collections k ON k.id = a.collection_id
      WHERE a.charge_id = ${c.id} AND k.voided_at IS NULL ORDER BY k.id LIMIT 1`;
    if (used) {
      throw conflict('AR_COLLECTED', `结账单 ${checkoutNo} 挂到「${c.accountName}」的账已经回款核销（回款 ${used.docNo}），不能反结账；请先在 ERP「应收与挂账」冲销那笔回款`);
    }
    await tx`UPDATE ar_charges SET status = 'voided', voided_by = ${staffId}, voided_at = ${at} WHERE id = ${c.id}`;
  }
}

// ───────────────────────── 回款与核销 ─────────────────────────

const CollectionInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  accountId: z.number('请选择协议单位').int().positive('请选择协议单位'),
  collectedOn: dateSchema('回款日期'),
  method: z.enum(AR_METHODS, '请选择回款方式'),
  amountCents: z.number('请填写回款金额').int().positive('回款金额要大于 0').max(10_000_000_000),
  evidence: z.string().trim().max(64, '凭据最多 64 个字').default(''),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
  /** 核销到哪几笔挂账；不填从最早的开始 */
  allocations: z.array(z.object({ chargeId: z.number().int().positive(), amountCents: z.number().int().positive() })).max(500).default([]),
});

export async function createCollection(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(CollectionInput, raw);
  const today = todayIn(deps.config.timezone);
  if (input.collectedOn > today) throw badRequest('回款日期不能晚于今天');
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM ar_collections WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔回款，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      await assertNotFenced(tx, input.clientKey, 'ar_collection', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const [acc] = await tx<{ name: string }[]>`SELECT name FROM ar_accounts WHERE id = ${input.accountId} FOR UPDATE`;
      if (!acc) throw notFound('协议单位不存在');
      const open = await tx<{ id: number; open: string; businessDate: string }[]>`
        SELECT c.id, (${OPEN_SQL(tx)})::text AS open, c.business_date::text AS business_date
        FROM ar_charges c WHERE c.account_id = ${input.accountId} AND c.status = 'open'
        ORDER BY c.business_date, c.id FOR UPDATE OF c`;
      const openMap = new Map(open.map((c) => [Number(c.id), Number(c.open)]));
      const totalOpen = [...openMap.values()].reduce((s, x) => s + x, 0);
      if (input.amountCents > totalOpen) {
        throw unprocessable('OVER_OUTSTANDING', `「${acc.name}」没结清的挂账一共 ${formatYuan(totalOpen)}，回款不能超过它`, { outstandingCents: totalOpen });
      }
      let allocations: { chargeId: number; amountCents: number }[];
      if (input.allocations.length) {
        if (new Set(input.allocations.map((x) => x.chargeId)).size !== input.allocations.length) throw badRequest('同一笔挂账请合并成一行核销');
        for (const x of input.allocations) {
          const left = openMap.get(x.chargeId);
          if (left === undefined) throw unprocessable('ALLOCATION_INVALID', '核销的挂账不是这个单位的、或已作废，请刷新后重选');
          if (x.amountCents > left) throw unprocessable('ALLOCATION_INVALID', `有一笔挂账只剩 ${formatYuan(left)} 没结清，核销不能超过它`);
        }
        if (input.allocations.reduce((s, x) => s + x.amountCents, 0) !== input.amountCents) throw badRequest('核销合计要等于回款金额');
        allocations = input.allocations;
      } else {
        // 从最早的开始核销
        allocations = [];
        let rest = input.amountCents;
        for (const c of open) {
          if (rest === 0) break;
          const left = Number(c.open);
          if (left <= 0) continue;
          const take = Math.min(left, rest);
          allocations.push({ chargeId: Number(c.id), amountCents: take });
          rest -= take;
        }
      }
      const docNo = await nextDocNo(tx, 'ar_collection', 'HK', input.collectedOn);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO ar_collections (doc_no, account_id, collected_on, method, amount_cents, evidence, note, client_key, request_hash, created_by)
        VALUES (${docNo}, ${input.accountId}, ${input.collectedOn}, ${input.method}, ${input.amountCents}, ${input.evidence}, ${input.note},
                ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      for (const x of allocations) {
        await tx`INSERT INTO ar_allocations (collection_id, charge_id, amount_cents) VALUES (${row!.id}, ${x.chargeId}, ${x.amountCents})`;
      }
      await writeAudit(tx, { staffId: actor.id, action: 'ar_collection', targetType: 'ar_collection', targetId: row!.id, detail: { op: 'create', docNo, account: acc.name, amountCents: input.amountCents, charges: allocations.length }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'ar_collections_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

/** 冲销回款（登错了）：只限当月（按回款日期），写原因；冲销后核销的挂账回到没结清 */
export async function voidCollection(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(z.object({ reason: z.string('请写冲销原因').trim().min(2, '请写冲销原因（至少 2 个字）').max(200, '原因最多 200 个字') }), raw);
  const today = todayIn(deps.config.timezone);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [head] = await tx<{ accountId: number }[]>`SELECT account_id FROM ar_collections WHERE id = ${id}`;
    if (!head) throw notFound('回款登记不存在');
    await tx`SELECT id FROM ar_accounts WHERE id = ${head.accountId} FOR UPDATE`;
    const [k] = await tx<{ docNo: string; collectedOn: string; voidedAt: string | null }[]>`
      SELECT doc_no, collected_on::text AS collected_on, voided_at FROM ar_collections WHERE id = ${id} FOR UPDATE`;
    if (k!.voidedAt) return;
    if (k!.collectedOn.slice(0, 7) !== today.slice(0, 7)) throw unprocessable('VOID_MONTH', `回款 ${k!.docNo} 不是本月的，不能冲销（只限当月）`);
    await tx`UPDATE ar_collections SET voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'ar_collection', targetType: 'ar_collection', targetId: id, detail: { op: 'void', docNo: k!.docNo, reason }, ip });
  });
}

async function collectionsOf(db: Db, accountId: number | null, id: number | null = null): Promise<ArCollection[]> {
  const rows = await db<(Omit<ArCollection, 'allocations' | 'voided'> & { voidedAt: string | null; voidedByName: string | null; voidReason: string | null })[]>`
    SELECT k.id, k.doc_no, k.account_id, a.name AS account_name, k.collected_on::text AS collected_on, k.method, k.amount_cents, k.evidence, k.note,
           cb.display_name AS created_by_name, k.created_at, k.voided_at, vb.display_name AS voided_by_name, k.void_reason
    FROM ar_collections k JOIN ar_accounts a ON a.id = k.account_id JOIN staff cb ON cb.id = k.created_by LEFT JOIN staff vb ON vb.id = k.voided_by
    WHERE true ${accountId ? db`AND k.account_id = ${accountId}` : db``} ${id ? db`AND k.id = ${id}` : db``}
    ORDER BY k.collected_on DESC, k.id DESC LIMIT 500`;
  if (rows.length === 0) return [];
  const allocs = await db<{ collectionId: number; chargeId: number; checkoutNo: string; businessDate: string; amountCents: number }[]>`
    SELECT x.collection_id, x.charge_id, co.checkout_no, c.business_date::text AS business_date, x.amount_cents
    FROM ar_allocations x JOIN ar_charges c ON c.id = x.charge_id JOIN checkouts co ON co.id = c.checkout_id
    WHERE x.collection_id IN ${db(rows.map((r) => r.id))} ORDER BY c.business_date, c.id`;
  return rows.map(({ voidedAt, voidedByName, voidReason, ...r }) => ({
    ...r,
    id: Number(r.id),
    accountId: Number(r.accountId),
    amountCents: Number(r.amountCents),
    allocations: allocs
      .filter((x) => Number(x.collectionId) === Number(r.id))
      .map((x) => ({ chargeId: Number(x.chargeId), checkoutNo: x.checkoutNo, businessDate: x.businessDate, amountCents: Number(x.amountCents) })),
    voided: voidedAt ? { byName: voidedByName ?? '', at: voidedAt, reason: voidReason ?? '' } : null,
  }));
}

export async function accountDetail(db: Db, accountId: number, today: string): Promise<ArAccountDetail> {
  const account = (await listAccounts(db, true)).find((a) => a.id === accountId);
  if (!account) throw notFound('协议单位不存在');
  const charges = await db<(Omit<ArCharge, 'collectedCents' | 'ageDays'> & { open: string })[]>`
    SELECT c.id, c.account_id, c.checkout_id, co.checkout_no, c.business_date::text AS business_date, c.signer, c.amount_cents, c.status,
           (${OPEN_SQL(db)})::text AS open
    FROM ar_charges c JOIN checkouts co ON co.id = c.checkout_id
    WHERE c.account_id = ${accountId}
    ORDER BY c.business_date DESC, c.id DESC LIMIT 1000`;
  return {
    account,
    charges: charges.map(({ open, ...c }) => ({
      ...c,
      id: Number(c.id),
      accountId: Number(c.accountId),
      checkoutId: Number(c.checkoutId),
      amountCents: Number(c.amountCents),
      collectedCents: c.status === 'open' ? Number(c.amountCents) - Number(open) : 0,
      ageDays: daysBetween(c.businessDate, today),
    })),
    collections: await collectionsOf(db, accountId),
  };
}

// ───────────────────────── 平台回款与账龄 ─────────────────────────

/** 平台回款：应结（补录的结算金额 + 结账登记的团购券）− 平台打款；按核销日先进先出，剩下没回的按日期列出 */
async function platformOpenItems(db: Db): Promise<Map<CouponPlatform, { date: string; cents: number }[]>> {
  const days = await db<{ platform: CouponPlatform; date: string; cents: string }[]>`
    SELECT platform, business_date::text AS date, sum(cents)::text AS cents FROM (
      SELECT platform, business_date, settle_amount AS cents FROM platform_redemptions WHERE status = 'active'
      UNION ALL
      SELECT platform, business_date, amount FROM group_buy_coupons WHERE status = 'active'
    ) x GROUP BY platform, business_date ORDER BY platform, business_date`;
  const paid = await db<{ platform: CouponPlatform; cents: string }[]>`
    SELECT platform, sum(amount)::text AS cents FROM platform_settlements WHERE status = 'active' GROUP BY platform`;
  const out = new Map<CouponPlatform, { date: string; cents: number }[]>();
  for (const platform of COUPON_PLATFORMS) {
    let rest = Number(paid.find((p) => p.platform === platform)?.cents ?? 0);
    const items: { date: string; cents: number }[] = [];
    for (const d of days.filter((x) => x.platform === platform)) {
      let cents = Number(d.cents);
      const take = Math.min(rest, cents);
      rest -= take;
      cents -= take;
      if (cents > 0) items.push({ date: d.date, cents });
    }
    out.set(platform, items);
  }
  return out;
}

export async function platformReceivables(db: Db): Promise<PlatformReceivable[]> {
  const open = await platformOpenItems(db);
  const sums = await db<{ platform: CouponPlatform; redeemed: string }[]>`
    SELECT platform, sum(cents)::text AS redeemed FROM (
      SELECT platform, settle_amount AS cents FROM platform_redemptions WHERE status = 'active'
      UNION ALL SELECT platform, amount FROM group_buy_coupons WHERE status = 'active'
    ) x GROUP BY platform`;
  const paid = await db<{ platform: CouponPlatform; cents: string }[]>`
    SELECT platform, sum(amount)::text AS cents FROM platform_settlements WHERE status = 'active' GROUP BY platform`;
  return COUPON_PLATFORMS.map((platform) => {
    const items = open.get(platform) ?? [];
    return {
      platform,
      platformLabel: COUPON_PLATFORM_LABELS[platform],
      redeemedCents: Number(sums.find((s) => s.platform === platform)?.redeemed ?? 0),
      settledCents: Number(paid.find((s) => s.platform === platform)?.cents ?? 0),
      outstandingCents: items.reduce((s, x) => s + x.cents, 0),
      oldestDate: items[0]?.date ?? null,
    };
  }).filter((r) => r.redeemedCents || r.settledCents);
}

const emptyBuckets = (): Record<AgingKey, number> => Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])) as Record<AgingKey, number>;

export async function arAging(db: Db, today: string): Promise<ArAging> {
  const { arOverdueDays } = await loadSettings(db);
  const rows: AgingRow[] = [];
  const charges = await db<{ accountId: number; name: string; date: string; open: string }[]>`
    SELECT c.account_id, a.name, c.business_date::text AS date, (${OPEN_SQL(db)})::text AS open
    FROM ar_charges c JOIN ar_accounts a ON a.id = c.account_id WHERE c.status = 'open'`;
  const byAccount = new Map<number, AgingRow>();
  for (const c of charges) {
    const open = Number(c.open);
    if (open <= 0) continue;
    const id = Number(c.accountId);
    const row = byAccount.get(id) ?? { kind: 'account' as const, id: `a${id}`, name: c.name, buckets: emptyBuckets(), totalCents: 0, overdueCents: 0 };
    const age = daysBetween(c.date, today);
    row.buckets[agingKeyOf(age)] += open;
    row.totalCents += open;
    if (age > arOverdueDays) row.overdueCents += open;
    byAccount.set(id, row);
  }
  rows.push(...[...byAccount.values()].sort((a, b) => b.totalCents - a.totalCents));
  for (const [platform, items] of await platformOpenItems(db)) {
    if (items.length === 0) continue;
    const row: AgingRow = { kind: 'platform', id: `p${platform}`, name: `团购 · ${COUPON_PLATFORM_LABELS[platform]}`, buckets: emptyBuckets(), totalCents: 0, overdueCents: 0 };
    for (const it of items) {
      const age = daysBetween(it.date, today);
      row.buckets[agingKeyOf(age)] += it.cents;
      row.totalCents += it.cents;
      if (age > arOverdueDays) row.overdueCents += it.cents;
    }
    rows.push(row);
  }
  const totals = { ...emptyBuckets(), total: 0, overdue: 0 };
  for (const r of rows) {
    for (const b of AGING_BUCKETS) totals[b.key] += r.buckets[b.key];
    totals.total += r.totalCents;
    totals.overdue += r.overdueCents;
  }
  return { overdueDays: arOverdueDays, rows, totals };
}

export async function arTodo(db: Db, today: string): Promise<ArTodo> {
  const { arOverdueDays } = await loadSettings(db);
  const [c] = await db<{ n: number; cents: string }[]>`
    SELECT count(*)::int AS n, coalesce(sum(open), 0)::text AS cents FROM (
      SELECT (${OPEN_SQL(db)}) AS open FROM ar_charges c
      WHERE c.status = 'open' AND c.business_date < ${today}::date - ${arOverdueDays}::int
    ) x WHERE open > 0`;
  let platformOverdue = 0;
  for (const items of (await platformOpenItems(db)).values()) {
    for (const it of items) if (daysBetween(it.date, today) > arOverdueDays) platformOverdue += it.cents;
  }
  return { overdueCharges: c!.n, overdueCents: Number(c!.cents), platformOverdueCents: platformOverdue };
}

// ───────────────────────── 自检 ─────────────────────────

/** 应收与挂账的自检：挂账与结账的挂账收款一一对应、作废的只有反结账的、核销不超过挂账、回款与核销对得上 */
export async function receivableChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const [a] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM checkout_payments p
    WHERE p.method = 'on_account' AND NOT EXISTS (SELECT 1 FROM ar_charges c WHERE c.payment_id = p.id AND c.amount_cents = p.amount AND c.account_id = p.ar_account_id)`;
  const [b] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ar_charges c JOIN checkouts co ON co.id = c.checkout_id
    WHERE (c.status = 'voided') <> (co.status = 'voided')`;
  const [c] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ar_charges c WHERE (${OPEN_SQL(db)}) < 0 OR (c.status = 'voided' AND (${OPEN_SQL(db)}) <> c.amount_cents)`;
  const [d] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ar_collections k
    WHERE k.amount_cents <> coalesce((SELECT sum(x.amount_cents) FROM ar_allocations x WHERE x.collection_id = k.id), 0)
       OR EXISTS (SELECT 1 FROM ar_allocations x JOIN ar_charges c ON c.id = x.charge_id WHERE x.collection_id = k.id AND c.account_id <> k.account_id)`;
  return [
    { key: 'ar_charge_payment', label: '挂账与结账的挂账收款一一对应', ok: a!.n === 0, detail: a!.n ? `${a!.n} 笔挂账收款没有对应的挂账` : '' },
    { key: 'ar_charge_void', label: '作废的挂账只有反结账的', ok: b!.n === 0, detail: b!.n ? `${b!.n} 笔挂账的状态与结账单不一致` : '' },
    { key: 'ar_charge_open', label: '核销不超过挂账，作废的没有核销', ok: c!.n === 0, detail: c!.n ? `${c!.n} 笔挂账核销超了或作废后还有核销` : '' },
    { key: 'ar_collection_alloc', label: '回款与核销对得上', ok: d!.n === 0, detail: d!.n ? `${d!.n} 笔回款的核销合计不对或核销到了别的单位` : '' },
  ];
}

// ───────────────────────── 接口 ─────────────────────────

export function registerReceivableRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const today = () => todayIn(config.timezone);
  const READ = guard('ar.read');
  const MANAGE = guard('ar.manage');
  // 前台结账选协议单位（要「挂账」权限；只给名称、额度与没结清的合计）
  app.get('/api/ar-accounts/options', { preHandler: guard('frontdesk.onAccount') }, async () => {
    if (!(await enabledErpModules(sql)).has('receivables')) return [];
    return accountOptions(sql);
  });
  app.get('/api/erp/receivables/accounts', { preHandler: READ }, async () => listAccounts(sql, true));
  app.post('/api/erp/receivables/accounts', { preHandler: MANAGE }, async (req, reply) => {
    await saveAccount(deps, null, req.body, req.actor, req.ip);
    reply.code(201);
    return listAccounts(sql, true);
  });
  app.put('/api/erp/receivables/accounts/:id', { preHandler: MANAGE }, async (req) => {
    await saveAccount(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    return listAccounts(sql, true);
  });
  app.get('/api/erp/receivables/accounts/:id', { preHandler: READ }, async (req) => accountDetail(sql, parse(idParam, req.params).id, today()));
  app.post('/api/erp/receivables/collections', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createCollection(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return { collection: (await collectionsOf(sql, null, r.id))[0], replayed: r.replayed };
  });
  app.post('/api/erp/receivables/collections/:id/void', { preHandler: MANAGE }, async (req) => {
    const id = parse(idParam, req.params).id;
    await voidCollection(deps, id, req.body, req.actor, req.ip);
    return { collection: (await collectionsOf(sql, null, id))[0] };
  });
  app.get('/api/erp/receivables/aging', { preHandler: READ }, async () => arAging(sql, today()));
  app.get('/api/erp/receivables/platforms', { preHandler: READ }, async () => platformReceivables(sql));
  app.get('/api/erp/receivables/todo', { preHandler: READ }, async () => arTodo(sql, today()));
  app.get('/api/erp/receivables/aging/export', { preHandler: READ }, async (req, reply) => {
    const r = await arAging(sql, today());
    const y = (c: number) => (c / 100).toFixed(2);
    const csv = toCsv([
      ['类别', '单位 / 平台', ...AGING_BUCKETS.map((b) => b.label), '合计', `超过 ${r.overdueDays} 天`],
      ...r.rows.map((x) => [x.kind === 'account' ? '协议单位' : '平台', x.name, ...AGING_BUCKETS.map((b) => y(x.buckets[b.key])), y(x.totalCents), y(x.overdueCents)]),
      ['合计', '', ...AGING_BUCKETS.map((b) => y(r.totals[b.key])), y(r.totals.total), y(r.totals.overdue)],
    ]);
    return csvReply(reply, `应收账龄_${today()}.csv`, csv);
  });
}
