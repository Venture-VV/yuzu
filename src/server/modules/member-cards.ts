// 会员实体卡（v0.7.28 ⑦，docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）：发卡、刷卡找会员、挂失、补卡。
//
// · 卡只是认人：钱照旧在会员钱包里，发卡、补卡不收工本费；8.1.15 起发卡按后台设的金额收押金（负债，不进储值，
//   见 member-card-deposits.ts 与 docs/MEMBERS_V8115.md）：名下没有押金的收一份，换下在用的卡不另收，补卡沿用原来的押金；
// · 退卡（8.1.15）：客人把卡退回来（或卡丢了不补了），在用的卡记「已退卡」、押着的押金全额退掉；
// · 一位会员同时只有一张在用的卡；同一个卡号同时只能是一张在用或挂失的卡（挂失的卡号不能再发给别人）；
// · 挂失：原卡从此不能用（找回也不解挂），补一张新卡；损坏换卡（补卡时这位会员还有在用的卡）：原卡记「已换下」，卡号可以再发；
// · 刷卡找会员：会员查找框按在用的卡号找（合并过的找到合并到的那位）；挂失的卡号查不到人，单独的查卡接口给出卡主，页面提醒扣下卡；
// · 锁：发卡、补卡、退卡先取操作编号的咨询锁（与「确认作废」串行）→ 经办人的班次（共享锁，收、退押金时，与别的收款同一协议）
//   → 会员一行 → 卡（在用、挂失的同号卡与这位会员在用的卡）→ 写押金台账；
//   挂失：会员一行 → 那张卡。数据库的唯一索引兜底（一位会员一张在用的、一个卡号一张在用或挂失的）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '@shared/labels';
import { MEMBER_CARD_RE, normalizeCardNo, type MemberCard, type MemberCardLookup, type MemberCardStatus } from '@shared/member-cards';
import { formatYuan } from '@shared/money';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { cents, idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { assertCardDeposit, assertDepositPay, CardNo, DepositPayInput, heldCardDeposit, insertCardDeposit, memberCardDeposits, type DepositPay } from './member-card-deposits';
import { activeCardMemberId, getMember } from './members';
import { loadSettings } from './settings';
import { lockPaymentShift, openShiftOf } from './shifts';

const cardColumns = (db: Db) => db`
  c.id, c.card_no, c.member_id, c.status, c.issued_at, si.display_name AS issued_by_name, c.replaces_id, c.note,
  c.ended_at, se.display_name AS ended_by_name, c.end_reason`;
const cardFrom = (db: Db) => db`member_cards c JOIN staff si ON si.id = c.issued_by LEFT JOIN staff se ON se.id = c.ended_by`;

export async function listMemberCards(db: Db, memberId: number): Promise<MemberCard[]> {
  return db<MemberCard[]>`SELECT ${cardColumns(db)} FROM ${cardFrom(db)} WHERE c.member_id = ${memberId} ORDER BY c.id DESC`;
}

export async function getMemberCard(db: Db, id: number): Promise<MemberCard> {
  const [row] = await db<MemberCard[]>`SELECT ${cardColumns(db)} FROM ${cardFrom(db)} WHERE c.id = ${id}`;
  if (!row) throw notFound('会员卡不存在');
  return row;
}

const tail = (cardNo: string) => cardNo.slice(-4);

const IssueInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  cardNo: CardNo,
  /** 补卡：这位会员还有在用的卡（损坏、丢了还没挂失）时换下它，要写原因；原卡已挂失时补卡不用填原因 */
  replace: z.boolean().default(false),
  replaceReason: z.string().trim().max(100, '原因最多 100 字').default(''),
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
  /** 押金（8.1.15）：名下没有押金、又不是换下在用的卡时按后台设的金额收；页面上看到不用收的不带 */
  deposit: DepositPayInput.nullish().transform((v) => v ?? null),
});
export type IssueCardInput = z.input<typeof IssueInput>;

async function businessDay(db: Db, deps: Pick<Deps, 'config'>, at: Date): Promise<string> {
  return businessDateOf(at, deps.config.timezone, (await loadSettings(db)).businessDayStartHour);
}

/**
 * 在调用方的事务里发一张卡（建档选实体卡、发卡、补卡共用）。调用方已经：取了操作编号的咨询锁、带押金时对班次加了共享锁、
 * 锁住（或刚写好）会员一行。这里锁卡（同号的在用、挂失卡与这位会员在用的卡）、核对押金、写卡与押金台账、记审计。
 * 会员是电子卡的，发了卡以后记成实体卡（匿名卡照旧是匿名卡）。
 */
export async function issueCardInTx(
  tx: Tx,
  deps: Pick<Deps, 'config'>,
  o: {
    memberId: number;
    memberName: string;
    cardNo: string;
    replace: boolean;
    replaceReason: string;
    note: string;
    deposit: DepositPay | null;
    shiftId: number | null;
    key: string;
    requestHash: string;
    at: Date;
  },
  ctx: OpContext,
): Promise<{ cardId: number; depositAmount: number }> {
  // 同一个卡号：在用、挂失的不能再发
  const [other] = await tx<{ id: number; status: MemberCardStatus; memberId: number; name: string }[]>`
    SELECT c.id, c.status, c.member_id, mm.name FROM member_cards c JOIN members mm ON mm.id = c.member_id
    WHERE c.card_no = ${o.cardNo} AND c.status IN ('active', 'lost') FOR UPDATE OF c`;
  if (other?.status === 'lost') throw conflict('CARD_LOST', `这张卡（尾号 ${tail(o.cardNo)}）已挂失（卡主 ${other.name}），不能再发，请扣下这张卡、换一张新卡`);
  if (other) {
    throw conflict('CARD_TAKEN', Number(other.memberId) === o.memberId ? '这张卡已经发给这位会员了' : `这张卡（尾号 ${tail(o.cardNo)}）已发给会员「${other.name}」，请换一张卡`);
  }
  const [current] = await tx<{ id: number; cardNo: string }[]>`SELECT id, card_no FROM member_cards WHERE member_id = ${o.memberId} AND status = 'active' FOR UPDATE`;
  if (current && !o.replace) throw conflict('CARD_EXISTS', `这位会员已有一张在用的卡（尾号 ${tail(current.cardNo)}），换卡请用「补卡」`);
  if (current && o.replaceReason.length < 2) throw badRequest('换下在用的卡要写明原因（如：卡坏了、丢了还没挂失）', { field: 'replaceReason' });
  // 押金：名下没有押金、又不是换下在用的卡，按后台设的金额收；页面交上来的对不上就整笔拒绝
  const due = await assertCardDeposit(tx, { memberId: o.memberId, replacingActive: !!current, deposit: o.deposit });
  let replacesId: number | null = null;
  if (current) {
    await tx`
      UPDATE member_cards SET status = 'canceled', ended_by = ${ctx.actor.id}, ended_at = ${o.at}, end_reason = ${o.replaceReason}
      WHERE id = ${current.id}`;
    replacesId = Number(current.id);
  } else if (o.replace) {
    // 原卡已挂失：记下换的是最近挂失的那张
    const [lost] = await tx<{ id: number }[]>`SELECT id FROM member_cards WHERE member_id = ${o.memberId} AND status = 'lost' ORDER BY id DESC LIMIT 1`;
    replacesId = lost ? Number(lost.id) : null;
  }
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO member_cards (card_no, member_id, issued_by, issued_at, replaces_id, note, client_key, request_hash)
    VALUES (${o.cardNo}, ${o.memberId}, ${ctx.actor.id}, ${o.at}, ${replacesId}, ${o.note}, ${o.key}, ${o.requestHash})
    RETURNING id`;
  const cardId = Number(row!.id);
  // 电子卡发了实体卡以后是实体卡；匿名卡照旧
  await tx`UPDATE members SET card_type = 'physical', updated_at = now() WHERE id = ${o.memberId} AND card_type = 'ecard'`;
  const date = await businessDay(tx, deps, o.at);
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'member_card_issued',
    targetType: 'member',
    targetId: o.memberId,
    detail: { memberName: o.memberName, cardNo: o.cardNo, replacesId, replaceReason: replacesId && current ? o.replaceReason : undefined, deposit: due || undefined },
    ip: ctx.ip,
    businessDate: date,
  });
  if (due > 0 && o.deposit) {
    await insertCardDeposit(
      tx,
      {
        kind: 'receive',
        memberId: o.memberId,
        memberName: o.memberName,
        cardId,
        cardNo: o.cardNo,
        method: o.deposit.method,
        amount: due,
        ref: o.deposit.ref,
        reason: null,
        shiftId: o.shiftId,
        date,
        at: o.at,
        key: o.key,
        requestHash: o.requestHash,
      },
      ctx,
    );
  }
  return { cardId, depositAmount: due };
}

/** 发卡、补卡（同一编号重提返回原来那张；结果待确认时可以「确认作废」，之后原请求晚到也不生效） */
export async function issueMemberCard(deps: Deps, memberId: number, raw: IssueCardInput, ctx: OpContext): Promise<{ card: MemberCard; replayed: boolean }> {
  const input = parse(IssueInput, raw);
  assertDepositPay(input.deposit);
  const { clientKey: key, ...payload } = input;
  // 不带押金的请求摘要与 8.1.15 之前一样（本机还留着的旧「结果待确认」原样重提照样认）
  const { deposit, ...rest } = payload;
  const requestHash = hashRequest({ memberId, ...rest, ...(deposit ? { deposit } : {}) });
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM member_cards WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次发卡，请刷新页面后重新办理');
    return Number(p.id);
  };
  // 收押金是收款：开始处理时记下经办人所在的班次，入账事务里在锁业务行之前对它加共享锁（交班了就整笔拒绝）
  const seenShift = input.deposit ? await openShiftOf(deps.sql, ctx.actor.id) : null;
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'member_card', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const shiftId = input.deposit ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : null;
      const at = ctx.at ?? new Date();
      // 会员一行（与合并、停用串行）
      const [m] = await tx<{ name: string; status: string; mergedIntoId: number | null }[]>`SELECT name, status, merged_into_id FROM members WHERE id = ${memberId} FOR UPDATE`;
      if (!m) throw notFound('会员不存在');
      if (m.mergedIntoId) throw unprocessable('MEMBER_MERGED', '这份会员档案已合并到另一位会员，请在合并到的会员上发卡');
      if (m.status !== 'active') throw unprocessable('MEMBER_INACTIVE', `会员「${m.name}」已停用，不能发卡`);
      const issued = await issueCardInTx(
        tx,
        deps,
        { memberId, memberName: m.name, cardNo: input.cardNo, replace: input.replace, replaceReason: input.replaceReason, note: input.note, deposit: input.deposit, shiftId, key, requestHash, at },
        ctx,
      );
      return { id: issued.cardId, replayed: false };
    });
    return { card: await getMemberCard(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'member_cards_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { card: await getMemberCard(deps.sql, id), replayed: true };
    }
    // 两个人同时发同一张卡、或同时给同一位会员发卡：数据库唯一索引兜底
    if (isUniqueViolation(error, 'member_cards_no_uq')) throw conflict('CARD_TAKEN', '这张卡刚刚发给了别人，请换一张卡');
    if (isUniqueViolation(error, 'member_cards_active_member_uq')) throw conflict('CARD_EXISTS', '这位会员刚刚发了一张卡，请刷新后再看');
    throw error;
  }
}

const LostInput = z.object({ reason: z.string('请写明挂失原因').trim().min(2, '请写明挂失原因（至少 2 个字）').max(100, '原因最多 100 字') });

/** 挂失：原卡从此不能用（找回也不解挂）；之后「补卡」发一张新卡。锁：会员一行 → 那张卡 */
export async function reportCardLost(deps: Deps, cardId: number, raw: unknown, ctx: OpContext): Promise<MemberCard> {
  const { reason } = parse(LostInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [ref] = await tx<{ memberId: number }[]>`SELECT member_id FROM member_cards WHERE id = ${cardId}`;
    if (!ref) throw notFound('会员卡不存在');
    const [m] = await tx<{ name: string }[]>`SELECT name FROM members WHERE id = ${ref.memberId} FOR UPDATE`;
    const [c] = await tx<{ status: MemberCardStatus; cardNo: string }[]>`SELECT status, card_no FROM member_cards WHERE id = ${cardId} FOR UPDATE`;
    if (c!.status !== 'active') throw conflict('CARD_NOT_ACTIVE', c!.status === 'lost' ? '这张卡已经挂失了' : '这张卡已经换下，不用挂失');
    await tx`
      UPDATE member_cards SET status = 'lost', ended_by = ${ctx.actor.id}, ended_at = ${ctx.at ?? new Date()}, end_reason = ${reason}
      WHERE id = ${cardId}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'member_card_lost',
      targetType: 'member',
      targetId: Number(ref.memberId),
      detail: { memberName: m?.name, cardNo: c!.cardNo, reason },
      ip: ctx.ip,
    });
  });
  return getMemberCard(deps.sql, cardId);
}

const ReturnInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  reason: z.string('请写明退卡原因').trim().min(2, '请写明退卡原因（至少 2 个字）').max(200, '原因最多 200 字'),
  /** 页面上看到的押着的押金（全额退）；刚有变化的拒绝 */
  expectedDeposit: cents('押金'),
  /** 退押金的方式；没有押金可退时不带 */
  method: z.enum(PAYMENT_METHODS, '请选择退押金的方式').nullish(),
  ref: z.string().trim().max(64, '退款单号最多 64 字').default(''),
});
export type ReturnCardInput = z.input<typeof ReturnInput>;

/**
 * 退卡（8.1.15）：在用的卡记「已退卡」（卡号可以再发），押着的押金全额退掉——现金从经办人当班的钱箱退，扫码、银行卡登记退款单号。
 * 卡已经挂失、没卡可退的，也在这里把押金退掉。会员是实体卡的退完记回电子卡（匿名卡照旧）。
 * 同一编号重提返回原来那次；结果待确认时可以「确认作废」。锁：操作编号 → 班次（退押金时）→ 会员一行 → 卡。
 */
export async function returnMemberCard(deps: Deps, memberId: number, raw: unknown, ctx: OpContext): Promise<{ memberId: number; refunded: number; replayed: boolean }> {
  const input = parse(ReturnInput, raw);
  const { clientKey: key, ...payload } = input;
  const method = input.method ?? null;
  if (input.expectedDeposit > 0) {
    if (!method) throw badRequest('请选择退押金的方式', { field: 'method' });
    if (method !== 'cash' && input.ref.length < 2) {
      throw badRequest(method === 'other' ? '「其他」方式退的请写明是怎么退的' : `${PAYMENT_METHOD_LABELS[method]}退的请登记商户后台的退款单号`, { field: 'ref' });
    }
  }
  const requestHash = hashRequest({ memberId, ...payload, method });
  const replay = async (db: Db) => {
    const [p] = await db<{ amount: number; requestHash: string }[]>`SELECT amount, request_hash FROM member_card_returns WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次退卡，请刷新页面后重新办理');
    return p.amount;
  };
  const refunding = input.expectedDeposit > 0;
  const seenShift = refunding ? await openShiftOf(deps.sql, ctx.actor.id) : null;
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'member_card_return', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { memberId, refunded: prior, replayed: true };
      const shiftId = refunding ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : null;
      const at = ctx.at ?? new Date();
      // 会员一行（与发卡、合并串行）；停用、合并过的会员也能退卡退押金——押金是欠客人的钱
      const [m] = await tx<{ name: string; cardType: string }[]>`SELECT name, card_type FROM members WHERE id = ${memberId} FOR UPDATE`;
      if (!m) throw notFound('会员不存在');
      const [current] = await tx<{ id: number; cardNo: string }[]>`SELECT id, card_no FROM member_cards WHERE member_id = ${memberId} AND status = 'active' FOR UPDATE`;
      const held = await heldCardDeposit(tx, memberId);
      if (!current && held === 0) throw unprocessable('CARD_NOTHING_TO_RETURN', '这位会员没有在用的卡，也没有押着的押金，不用退卡');
      if (held !== input.expectedDeposit) {
        throw conflict('CARD_DEPOSIT_CHANGED', `这位会员押着的押金现在是 ${formatYuan(held)}（页面上是 ${formatYuan(input.expectedDeposit)}），这笔没有办理，请核对后重新确认`, { deposit: held });
      }
      const date = await businessDay(tx, deps, at);
      if (current) {
        await tx`
          UPDATE member_cards SET status = 'returned', ended_by = ${ctx.actor.id}, ended_at = ${at}, end_reason = ${input.reason.slice(0, 100)}
          WHERE id = ${current.id}`;
      }
      let depositId: number | null = null;
      if (held > 0) {
        const d = await insertCardDeposit(
          tx,
          {
            kind: 'refund',
            memberId,
            memberName: m.name,
            cardId: current ? Number(current.id) : null,
            cardNo: current?.cardNo ?? null,
            method: method!,
            amount: held,
            ref: input.ref,
            reason: input.reason,
            shiftId,
            date,
            at,
            key,
            requestHash,
          },
          ctx,
        );
        depositId = d.id;
      }
      await tx`
        INSERT INTO member_card_returns (member_id, card_id, deposit_id, amount, reason, operator_id, business_date, created_at, client_key, request_hash)
        VALUES (${memberId}, ${current?.id ?? null}, ${depositId}, ${held}, ${input.reason}, ${ctx.actor.id}, ${date}, ${at}, ${key}, ${requestHash})`;
      // 实体卡退完、名下也没有挂失着的卡了，记回电子卡（匿名卡照旧）
      await tx`
        UPDATE members SET card_type = 'ecard', updated_at = now()
        WHERE id = ${memberId} AND card_type = 'physical' AND phone IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM member_cards c WHERE c.member_id = ${memberId} AND c.status = 'active')`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_card_returned',
        targetType: 'member',
        targetId: memberId,
        detail: { memberName: m.name, cardNo: current?.cardNo, refunded: held || undefined, method: held > 0 ? method : undefined, reason: input.reason },
        ip: ctx.ip,
        businessDate: date,
      });
      return { memberId, refunded: held, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'member_card_returns_client_key_key')) {
      const amount = await replay(deps.sql);
      if (amount !== null) return { memberId, refunded: amount, replayed: true };
    }
    throw error;
  }
}

/** 刷卡找会员：在用的给出会员（合并过的找到合并到的那位）；挂失、换下的给出卡主；没发过的 unknown */
export async function lookupMemberCard(db: Db, raw: string): Promise<MemberCardLookup> {
  const cardNo = normalizeCardNo(raw);
  if (!MEMBER_CARD_RE.test(cardNo)) throw badRequest('卡号是 4–32 位数字或字母');
  const [c] = await db<{ memberId: number; status: MemberCardStatus }[]>`
    SELECT member_id, status FROM member_cards WHERE card_no = ${cardNo}
    ORDER BY (status = 'active') DESC, (status = 'lost') DESC, id DESC LIMIT 1`;
  if (!c) return { cardNo, status: 'unknown', member: null };
  const memberId = c.status === 'active' ? ((await activeCardMemberId(db, cardNo)) ?? Number(c.memberId)) : Number(c.memberId);
  return { cardNo, status: c.status, member: await getMember(db, memberId) };
}

const LookupQuery = z.object({ cardNo: z.string('请刷卡或输入卡号').trim().min(1, '请刷卡或输入卡号').max(64) });

export function registerMemberCardRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/members/:id/cards', { preHandler: guard('member.read') }, async (req) => listMemberCards(sql, parse(idParam, req.params).id));
  app.post('/api/members/:id/cards', { preHandler: guard('member.card') }, async (req) => issueMemberCard(deps, parse(idParam, req.params).id, req.body as IssueCardInput, ctxOf(req)));
  app.post('/api/member-cards/:id/lost', { preHandler: guard('member.card') }, async (req) => reportCardLost(deps, parse(idParam, req.params).id, req.body ?? {}, ctxOf(req)));
  app.get('/api/member-cards/lookup', { preHandler: guard('member.read') }, async (req) => lookupMemberCard(sql, parse(LookupQuery, req.query ?? {}).cardNo));
  // 8.1.15：押金台账（押着多少、收退记录）与退卡退押金
  app.get('/api/members/:id/card-deposits', { preHandler: guard('member.read') }, async (req) => memberCardDeposits(sql, parse(idParam, req.params).id));
  app.post('/api/members/:id/cards/return', { preHandler: guard('member.card') }, async (req) => returnMemberCard(deps, parse(idParam, req.params).id, req.body ?? {}, ctxOf(req)));
}
