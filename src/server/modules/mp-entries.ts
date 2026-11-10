// 给小程序第三期的入口（主线，v0.7.28 ①；设计见 docs/SCHEDULE_FINISH.md 第 2 节、docs/MP_PHASE3.md 第 2、3 节）。
// 小程序线在自己的事务里调用（小程序线的目录不在这里，见 AGENTS.md「两条开发线」）。
//   · createTrialInviteFromMp（3b 邀请好友）：与前台 v0.7.25 的「邀请体验」同一套规则、拒绝码（member-trials.ts 的 createTrialTx）；
//     好友还不是会员的当场建档，渠道「老带新」（店里设了这一项、启用中时）；
//   · orderFoodFromMp（3c 扫码点餐）：与点单页下单同一条路径（frontdesk/bills.ts 的 postChargesTx），只能点进厨房的菜，
//     挂在这位会员在店手牌的账单上；一单的份数、金额有上限（N1）；扫了桌上的码的，出品单写送到哪张桌；
//   · 只读：diningMenu（dining.ts，菜品、价格、今天的估清）、mpDiningTables（桌码用）、mpOpenBill（「我的账单」）。
// 同一个 claimKey 只生效一次（entry_claims，只追加），再调用返回第一次的结果；内容不同的回 MP_CLAIM_CONFLICT。
// 经办人：系统账号「小程序」。
// 加锁顺序：claimKey 的咨询锁 → 之后与前台同一套（邀请：两位会员一行，id 升序；点餐：来访 → 账单 → 估清 → 出品单）。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_DISH_NOTE } from '@shared/dining';
import { TUNABLE_LIMITS } from '@shared/tunables';
import type { TrialRow } from '@shared/trials';
import type { Db, Tx } from '../db';
import type { Deps, OpContext } from '../lib/context';
import { conflict, unprocessable } from '../lib/errors';
import { lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { parse } from '../lib/validate';
import { loadDiningRules } from './dining';
import { postChargesTx } from './frontdesk/bills';
import { createTrialTx, getTrial, PhoneField, trialToday, trialUniqueError } from './member-trials';
import { loadSettings } from './settings';
import { systemActor } from './system-staff';

// ───────────────────────── claimKey 的去重 ─────────────────────────

/** 小程序线的记录编号：正整数，或 64 字以内的字母、数字、_、-（与 v0.7.27 的 claimId 同一个格式） */
export const ClaimKey = z
  .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)], 'claimKey 不对')
  .transform(String);

export type EntryKind = 'mp_invite' | 'mp_food' | 'mp_booking' | 'mp_booking_cancel';

export interface EntryClaim {
  refId: number;
  refKey: string | null;
}

/**
 * 先取这个 claimKey 的咨询锁（同一个 claimKey 的两次调用排队），再查有没有生效过：
 * 生效过、内容相同返回那一次的结果编号；内容不同拒绝
 */
export async function lockClaim(tx: Tx, kind: EntryKind, claimKey: string, requestHash: string): Promise<EntryClaim | null> {
  const key = `${kind}:${claimKey}`;
  await lockOpKey(tx, `entry:${key}`);
  const [c] = await tx<{ requestHash: string; refId: number; refKey: string | null }[]>`
    SELECT request_hash, ref_id, ref_key FROM entry_claims WHERE claim_key = ${key}`;
  if (!c) return null;
  if (c.requestHash !== requestHash) throw conflict('MP_CLAIM_CONFLICT', `claimKey ${claimKey} 已经用于另一笔，内容不同`);
  return { refId: Number(c.refId), refKey: c.refKey };
}

export async function saveClaim(tx: Tx, kind: EntryKind, claimKey: string, requestHash: string, refId: number, refKey: string | null = null) {
  await tx`
    INSERT INTO entry_claims (claim_key, request_hash, ref_id, ref_key)
    VALUES (${`${kind}:${claimKey}`}, ${requestHash}, ${refId}, ${refKey})`;
}

/** 系统账号「小程序」当经办人的上下文 */
export async function mpContext(tx: Tx, at?: Date): Promise<OpContext> {
  return { actor: await systemActor(tx), at: at ?? new Date() };
}

// ───────────────────────── 3b 邀请好友 ─────────────────────────

const MpInviteInput = z.object({
  inviterId: z.number('邀请人编号不对').int('邀请人编号不对').positive('邀请人编号不对'),
  invitee: z.object({
    phone: PhoneField,
    /** 好友还不是会员时当场建档用（好友自己填） */
    name: z.string().trim().max(32, '姓名最多 32 个字').optional(),
  }),
  claimKey: ClaimKey,
  at: z.date().optional(),
});
export type MpInviteInput = z.input<typeof MpInviteInput>;

export interface MpInviteResult {
  trial: TrialRow;
  /** 同一个 claimKey 已经生效过：返回第一次的那条 */
  replayed: boolean;
}

/** 渠道「老带新」：店里的渠道来源里有这一项、启用中时用它的编号；没有就不填 */
async function referralChannel(db: Db): Promise<string | null> {
  const { memberChannels } = await loadSettings(db);
  return memberChannels.find((c) => c.label === '老带新' && c.active)?.key ?? null;
}

/**
 * 小程序发起邀请体验（3b，v0.7.25 的「低一档邀请体验」）：邀请人在小程序分享，好友打开、验证手机号后，小程序线调用这里建临时身份。
 * 规则与拒绝码照前台：TRIAL_SELF、TRIAL_NOT_ALLOWED（邀请人不够档、本月次数用完、已停用）、TRIAL_INVITEE（好友不够条件）、
 * MEMBER_CHANGED、PHONE_EXISTS、TRIAL_ACTIVE；好友还不是会员又没给姓名时 400（field: name）。
 * 拒绝时不改任何东西（建档、开卡礼都在一个存档点里，一起撤回），调用方事务里的其他写入由调用方决定。
 */
export async function createTrialInviteFromMp(tx: Tx, deps: Deps, raw: MpInviteInput): Promise<MpInviteResult> {
  const input = parse(MpInviteInput, raw);
  const name = input.invitee.name ?? '';
  const requestHash = hashRequest({ inviterId: input.inviterId, phone: input.invitee.phone, name });
  const prior = await lockClaim(tx, 'mp_invite', input.claimKey, requestHash);
  if (prior) return { trial: await getTrial(tx, prior.refId), replayed: true };
  const ctx = await mpContext(tx, input.at);
  const date = await trialToday(tx, deps.config.timezone, ctx.at);
  const channel = await referralChannel(tx);
  let trialId: number;
  try {
    // 存档点：建档、发开卡礼、建临时身份要么都成，要么都撤回；撞上唯一约束时翻译成看得懂的提示，调用方的事务还能接着用
    trialId = await tx.savepoint((sp) =>
      createTrialTx(
        sp as unknown as Tx,
        deps,
        { inviterId: input.inviterId, kind: 'invite', phone: input.invitee.phone, name, channel, clientKey: randomUUID(), requestHash },
        ctx,
        date,
      ),
    );
  } catch (error) {
    throw trialUniqueError(error) ?? error;
  }
  await saveClaim(tx, 'mp_invite', input.claimKey, requestHash, trialId);
  return { trial: await getTrial(tx, trialId), replayed: false };
}

// ───────────────────────── 3c 扫码点餐 ─────────────────────────

const MpFoodInput = z.object({
  memberId: z.number('会员编号不对').int('会员编号不对').positive('会员编号不对'),
  items: z
    .array(
      z.object({
        itemId: z.number('菜品编号不对').int('菜品编号不对').positive('菜品编号不对'),
        // 一单的份数与金额上限（N1，8.0.7 起在「经营规则 → 可调的数值」里改）在下单时按设置核对（MP_ORDER_LIMIT），这里只挡住离谱的请求
        quantity: z.number('份数不对').int('份数不对').min(1, '份数至少为 1').max(TUNABLE_LIMITS.mpFoodMaxQuantity.max, `一单最多 ${TUNABLE_LIMITS.mpFoodMaxQuantity.max} 份`),
        note: z.string().trim().max(MAX_DISH_NOTE, `口味备注最多 ${MAX_DISH_NOTE} 字`).optional(),
      }),
      '请选择菜品',
    )
    .min(1, '请至少选一道菜')
    .max(TUNABLE_LIMITS.mpFoodMaxQuantity.max, `一单最多 ${TUNABLE_LIMITS.mpFoodMaxQuantity.max} 份`),
  /** 扫了桌上的码：桌台名称（后台「餐饮 → 桌台」里的名字）；出品单写送到这张桌 */
  tableCode: z.string().trim().min(1, '桌号不对').max(12, '桌号不对').optional(),
  /** 小程序上看到的合计；带了就核对（价格刚改过时拒绝，PRICE_CHANGED） */
  expectedTotal: z.number().int().nonnegative().optional(),
  claimKey: ClaimKey,
  at: z.date().optional(),
});
export type MpFoodInput = z.input<typeof MpFoodInput>;

export interface MpFoodLine {
  lineId: number;
  itemId: number | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
  note: string;
}

export interface MpFoodResult {
  visitId: number;
  tagCode: string;
  orderNo: string | null;
  deliverTo: string;
  total: number;
  lines: MpFoodLine[];
  /** 同一个 claimKey 已经下过：返回第一次的那一单 */
  replayed: boolean;
}

/** 按挂账编号取回那一单（重提时返回第一次的结果） */
async function foodOrderOf(db: Db, visitId: number, postKey: string): Promise<Omit<MpFoodResult, 'replayed'>> {
  const [v] = await db<{ tagCode: string }[]>`SELECT h.code AS tag_code FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.id = ${visitId}`;
  const rows = await db<(MpFoodLine & { orderNo: string | null; deliverTo: string | null })[]>`
    SELECT bl.id AS line_id, bl.item_id, bl.name, bl.unit_price, bl.quantity, bl.amount, coalesce(k.note, '') AS note, k.order_no, k.deliver_to
    FROM bill_lines bl LEFT JOIN kitchen_items k ON k.bill_line_id = bl.id
    WHERE bl.post_key = ${postKey} ORDER BY bl.id`;
  return {
    visitId,
    tagCode: v?.tagCode ?? '',
    orderNo: rows[0]?.orderNo ?? null,
    deliverTo: rows[0]?.deliverTo ?? '',
    total: rows.reduce((s, r) => s + Number(r.amount), 0),
    lines: rows.map((l) => ({
      lineId: Number(l.lineId),
      itemId: l.itemId === null ? null : Number(l.itemId),
      name: l.name,
      unitPrice: Number(l.unitPrice),
      quantity: l.quantity,
      amount: Number(l.amount),
      note: l.note,
    })),
  };
}

/**
 * 小程序扫码点餐（3c）：挂在这位会员在店手牌的账单上、进厨房出品单，与服务员在点单页下单一样（扣估清、出品单号、实时位置）。
 * 拒绝码：NO_OPEN_VISIT（没有在店手牌）、DINING_DISABLED（餐饮功能没开）、DISH_NOT_KITCHEN（不是进厨房的菜）、
 * DISH_SOLD_OUT（估清不够）、ITEM_GENDER、PRICE_CHANGED（带了预期合计、对不上）、MP_ORDER_LIMIT（超过一单的上限）、
 * TABLE_NOT_FOUND（桌号对不上启用的桌台）、VISIT_CHANGED。
 * 结账照旧在前台；顾客自己不能退菜（退菜请服务员，照现有的作废明细）。
 */
export async function orderFoodFromMp(tx: Tx, deps: Deps, raw: MpFoodInput): Promise<MpFoodResult> {
  const input = parse(MpFoodInput, raw);
  const items = input.items.map((i) => ({ itemId: i.itemId, quantity: i.quantity, note: i.note ?? '' }));
  const requestHash = hashRequest({ memberId: input.memberId, items, tableCode: input.tableCode ?? null, expectedTotal: input.expectedTotal ?? null });
  const prior = await lockClaim(tx, 'mp_food', input.claimKey, requestHash);
  if (prior) return { ...(await foodOrderOf(tx, prior.refId, prior.refKey!)), replayed: true };
  if (!(await loadDiningRules(tx)).enabled) throw unprocessable('DINING_DISABLED', '餐饮功能没有开启，请服务员点单');
  const limits = await loadSettings(tx);
  // 会员同时只有一张在店手牌（visits_member_open_uq）
  const [open] = await tx<{ id: number }[]>`SELECT id FROM visits WHERE member_id = ${input.memberId} AND status = 'open'`;
  if (!open) throw unprocessable('NO_OPEN_VISIT', '这位会员现在没有在店手牌：请先到前台开手牌，或请服务员点单');
  let deliverTo = '';
  if (input.tableCode) {
    const [t] = await tx<{ name: string }[]>`
      SELECT name FROM dining_tables WHERE active AND lower(btrim(name)) = lower(${input.tableCode})`;
    if (!t) throw unprocessable('TABLE_NOT_FOUND', `没有叫「${input.tableCode}」的桌台，请扫桌上的码重试，或请服务员点单`);
    deliverTo = t.name;
  }
  const ctx = await mpContext(tx, input.at);
  const postKey = randomUUID();
  await postChargesTx(
    tx,
    deps,
    Number(open.id),
    {
      clientKey: postKey,
      lines: items.map((i) => ({ itemId: i.itemId, quantity: i.quantity, note: i.note || undefined, tier: undefined, technicianId: undefined, callType: undefined })),
      customLines: [],
      expectedTotal: 0,
      backfill: undefined,
    },
    {
      key: postKey,
      requestHash,
      backfill: null,
      channel: {
        expectedTotal: input.expectedTotal ?? null,
        maxQuantity: limits.mpFoodMaxQuantity,
        maxTotal: limits.mpFoodMaxTotalCents,
        deliverTo,
        memberId: input.memberId,
      },
    },
    ctx,
    { dining: { onlyKitchen: true } },
  );
  await saveClaim(tx, 'mp_food', input.claimKey, requestHash, Number(open.id), postKey);
  return { ...(await foodOrderOf(tx, Number(open.id), postKey)), replayed: false };
}

// ───────────────────────── 只读 ─────────────────────────

/** 启用的桌台（小程序线生成桌码用；码里放桌台名称） */
export async function mpDiningTables(db: Db) {
  return db<{ id: number; name: string; area: string }[]>`
    SELECT id, name, area FROM dining_tables WHERE active ORDER BY sort_order, id`;
}

export interface MpOpenBill {
  visitId: number;
  tagCode: string;
  checkedInAt: string;
  /** 还有效的明细（作废的不列）；dishStatus：进厨房的菜现在的出品状态 */
  lines: { lineId: number; name: string; quantity: number; amount: number; postedAt: string; dishStatus: string | null }[];
  total: number;
}

/** 「我的账单」：这位会员在店手牌的账单（没有在店手牌为空）；只给名称、份数、金额，不含经办人等门店信息 */
export async function mpOpenBill(db: Db, memberId: number): Promise<MpOpenBill | null> {
  const [v] = await db<{ id: number; tagCode: string; checkedInAt: string; billId: number }[]>`
    SELECT v.id, h.code AS tag_code, v.checked_in_at, v.bill_id FROM visits v JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.member_id = ${memberId} AND v.status = 'open'`;
  if (!v) return null;
  const lines = await db<{ lineId: number; name: string; quantity: number; amount: number; postedAt: string; dishStatus: string | null }[]>`
    SELECT bl.id AS line_id, bl.name, bl.quantity, bl.amount, bl.posted_at, k.status AS dish_status
    FROM bill_lines bl LEFT JOIN kitchen_items k ON k.bill_line_id = bl.id
    WHERE bl.bill_id = ${v.billId} AND bl.status = 'active' ORDER BY bl.id`;
  const out = lines.map((l) => ({ ...l, lineId: Number(l.lineId), amount: Number(l.amount), postedAt: new Date(l.postedAt).toISOString() }));
  return {
    visitId: Number(v.id),
    tagCode: v.tagCode,
    checkedInAt: new Date(v.checkedInAt).toISOString(),
    lines: out,
    total: out.reduce((s, l) => s + l.amount, 0),
  };
}
