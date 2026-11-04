// 会员实体卡（v0.7.28 ⑦，docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）：发卡、刷卡找会员、挂失、补卡。
//
// · 卡只是认人：钱照旧在会员钱包里，发卡、补卡不收工本费；
// · 一位会员同时只有一张在用的卡；同一个卡号同时只能是一张在用或挂失的卡（挂失的卡号不能再发给别人）；
// · 挂失：原卡从此不能用（找回也不解挂），补一张新卡；损坏换卡（补卡时这位会员还有在用的卡）：原卡记「已换下」，卡号可以再发；
// · 刷卡找会员：会员查找框按在用的卡号找（合并过的找到合并到的那位）；挂失的卡号查不到人，单独的查卡接口给出卡主，页面提醒扣下卡；
// · 锁：发卡、补卡先取操作编号的咨询锁（与「确认作废」串行）→ 会员一行 → 卡（在用、挂失的同号卡与这位会员在用的卡）；
//   挂失：会员一行 → 那张卡。数据库的唯一索引兜底（一位会员一张在用的、一个卡号一张在用或挂失的）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMBER_CARD_RE, normalizeCardNo, type MemberCard, type MemberCardLookup, type MemberCardStatus } from '@shared/member-cards';
import { MP_CODE } from '@shared/mp';
import { isUniqueViolation, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { activeCardMemberId, getMember } from './members';

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

const CardNo = z
  .string('请刷卡或输入卡号')
  .transform(normalizeCardNo)
  .refine((v) => MEMBER_CARD_RE.test(v), '卡号是 4–32 位数字或字母（读卡器读到的号）')
  .refine((v) => !MP_CODE.test(v), '这是小程序的会员码，不是实体卡的卡号');

const IssueInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  cardNo: CardNo,
  /** 补卡：这位会员还有在用的卡（损坏、丢了还没挂失）时换下它，要写原因；原卡已挂失时补卡不用填原因 */
  replace: z.boolean().default(false),
  replaceReason: z.string().trim().max(100, '原因最多 100 字').default(''),
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
});
export type IssueCardInput = z.input<typeof IssueInput>;

/** 发卡、补卡（同一编号重提返回原来那张；结果待确认时可以「确认作废」，之后原请求晚到也不生效） */
export async function issueMemberCard(deps: Deps, memberId: number, raw: IssueCardInput, ctx: OpContext): Promise<{ card: MemberCard; replayed: boolean }> {
  const input = parse(IssueInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ memberId, ...payload });
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM member_cards WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次发卡，请刷新页面后重新办理');
    return Number(p.id);
  };
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'member_card', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const at = ctx.at ?? new Date();
      // 会员一行（与合并、停用串行）
      const [m] = await tx<{ name: string; status: string; mergedIntoId: number | null }[]>`SELECT name, status, merged_into_id FROM members WHERE id = ${memberId} FOR UPDATE`;
      if (!m) throw notFound('会员不存在');
      if (m.mergedIntoId) throw unprocessable('MEMBER_MERGED', '这份会员档案已合并到另一位会员，请在合并到的会员上发卡');
      if (m.status !== 'active') throw unprocessable('MEMBER_INACTIVE', `会员「${m.name}」已停用，不能发卡`);
      // 同一个卡号：在用、挂失的不能再发
      const [other] = await tx<{ id: number; status: MemberCardStatus; memberId: number; name: string }[]>`
        SELECT c.id, c.status, c.member_id, mm.name FROM member_cards c JOIN members mm ON mm.id = c.member_id
        WHERE c.card_no = ${input.cardNo} AND c.status IN ('active', 'lost') FOR UPDATE OF c`;
      if (other?.status === 'lost') throw conflict('CARD_LOST', `这张卡（尾号 ${tail(input.cardNo)}）已挂失（卡主 ${other.name}），不能再发，请扣下这张卡、换一张新卡`);
      if (other) {
        throw conflict('CARD_TAKEN', Number(other.memberId) === memberId ? '这张卡已经发给这位会员了' : `这张卡（尾号 ${tail(input.cardNo)}）已发给会员「${other.name}」，请换一张卡`);
      }
      const [current] = await tx<{ id: number; cardNo: string }[]>`SELECT id, card_no FROM member_cards WHERE member_id = ${memberId} AND status = 'active' FOR UPDATE`;
      let replacesId: number | null = null;
      if (current) {
        if (!input.replace) throw conflict('CARD_EXISTS', `这位会员已有一张在用的卡（尾号 ${tail(current.cardNo)}），换卡请用「补卡」`);
        if (input.replaceReason.length < 2) throw badRequest('换下在用的卡要写明原因（如：卡坏了、丢了还没挂失）', { field: 'replaceReason' });
        await tx`
          UPDATE member_cards SET status = 'canceled', ended_by = ${ctx.actor.id}, ended_at = ${at}, end_reason = ${input.replaceReason}
          WHERE id = ${current.id}`;
        replacesId = Number(current.id);
      } else if (input.replace) {
        // 原卡已挂失：记下换的是最近挂失的那张
        const [lost] = await tx<{ id: number }[]>`SELECT id FROM member_cards WHERE member_id = ${memberId} AND status = 'lost' ORDER BY id DESC LIMIT 1`;
        replacesId = lost ? Number(lost.id) : null;
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO member_cards (card_no, member_id, issued_by, issued_at, replaces_id, note, client_key, request_hash)
        VALUES (${input.cardNo}, ${memberId}, ${ctx.actor.id}, ${at}, ${replacesId}, ${input.note}, ${key}, ${requestHash})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_card_issued',
        targetType: 'member',
        targetId: memberId,
        detail: { memberName: m.name, cardNo: input.cardNo, replacesId, replaceReason: replacesId && current ? input.replaceReason : undefined },
        ip: ctx.ip,
      });
      return { id: Number(row!.id), replayed: false };
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
  app.post('/api/members/:id/cards', { preHandler: guard('member.card') }, async (req) =>
    issueMemberCard(deps, parse(idParam, req.params).id, req.body as IssueCardInput, ctxOf(req)),
  );
  app.post('/api/member-cards/:id/lost', { preHandler: guard('member.card') }, async (req) => reportCardLost(deps, parse(idParam, req.params).id, req.body ?? {}, ctxOf(req)));
  app.get('/api/member-cards/lookup', { preHandler: guard('member.read') }, async (req) => lookupMemberCard(sql, parse(LookupQuery, req.query ?? {}).cardNo));
}
