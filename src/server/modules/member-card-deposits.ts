// 会员卡押金（8.1.15，docs/MEMBERS_V8115.md 第 3 节，默认做法待确认）。
//
// 钱怎么记（照客房押金 room_deposits 的做法）：
//   · 押金是负债：不进会员储值（钱包一分不动）、不算营业额；收、退都记到经办人当班的班次，现金计入交班的应有现金；
//   · 一位会员押一份：建档选实体卡、给名下没有押金的会员发卡时按后台设的金额收（0 = 不收）；换下在用的卡（卡坏了当场换）不另收；
//   · 挂失不退；补卡沿用原来的押金；退卡时全额退（卡丢了没卡可退的也在「退卡」里退）；这一版没有罚没；
//   · 台账只追加（member_card_deposits）：押着的押金 = 收 − 退，不能为负（都在会员一行的锁里写，自检核对）。
// 加锁顺序（docs/LOCKING.md 第 2 节）：操作编号的咨询锁 → 经办人的班次（共享锁，带押金时）→ 会员一行 → 卡 → 写台账。
// 这里只有在调用方事务里用的小件与只读的汇总；建档在 members.ts，发卡、补卡、退卡在 member-cards.ts。

import { z } from 'zod';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import { MEMBER_CARD_RE, normalizeCardNo } from '@shared/member-cards';
import { MAX_CARD_DEPOSIT, type CardDepositDayTotals, type CardDepositMethodTotal, type CardDepositRow, type MemberCardDeposits } from '@shared/member-form';
import { formatYuan } from '@shared/money';
import { MP_CODE } from '@shared/mp';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { OpContext } from '../lib/context';
import { badRequest, conflict } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { nextDocNo } from '../lib/tx';
import { cents } from '../lib/validate';
import { loadSettings } from './settings';

/** 实体卡的卡号：读到的号去掉空格、横线，转大写；小程序的会员码不是卡号 */
export const CardNo = z
  .string('请刷卡或输入卡号')
  .transform(normalizeCardNo)
  .refine((v) => MEMBER_CARD_RE.test(v), '卡号是 4–32 位数字或字母（读卡器读到的号）')
  .refine((v) => !MP_CODE.test(v), '这是小程序的会员码，不是实体卡的卡号');

/** 收押金：页面上看到的金额（与后台设的不一致时拒绝）、收款方式与备注 */
export const DepositPayInput = z.object({
  amount: cents('押金').positive('押金必须大于 0').max(MAX_CARD_DEPOSIT, '押金过大'),
  method: z.enum(PAYMENT_METHODS, '请选择押金的收款方式'),
  ref: z.string().trim().max(64, '收款备注最多 64 字').default(''),
});
export type DepositPay = z.output<typeof DepositPayInput>;

/** 「其他」方式收的押金要写明收的是什么（在取任何锁之前核对） */
export function assertDepositPay(deposit: DepositPay | null | undefined): void {
  if (deposit && deposit.method === 'other' && deposit.ref.length < 2) throw badRequest('「其他」方式收的押金请在备注里写明收的是什么', { field: 'deposit.ref' });
}

/** 一位会员押着的押金（收 − 退）。写的地方先锁住会员一行再读 */
export async function heldCardDeposit(db: Db, memberId: number): Promise<number> {
  const [row] = await db<{ held: number }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END), 0)::int AS held FROM member_card_deposits WHERE member_id = ${memberId}`;
  return row!.held;
}

/**
 * 这一次发卡该收多少押金（调用方已经锁住会员一行）：名下没有押金、又不是换下在用的卡，按后台设的金额；否则 0。
 * 页面交上来的与此不一致就整笔拒绝，不悄悄多收、少收。
 */
export async function assertCardDeposit(tx: Tx, o: { memberId: number | null; replacingActive: boolean; deposit: DepositPay | null }): Promise<number> {
  const rule = (await loadSettings(tx)).memberForm.cardDeposit;
  const held = o.memberId === null ? 0 : await heldCardDeposit(tx, o.memberId);
  const due = held > 0 || o.replacingActive ? 0 : rule;
  if (due > 0 && !o.deposit) {
    throw conflict('CARD_DEPOSIT_REQUIRED', `发实体卡要收押金 ${formatYuan(due)}，请选择收款方式后再确认`, { deposit: due });
  }
  if (o.deposit && o.deposit.amount !== due) {
    throw conflict(
      'CARD_DEPOSIT_CHANGED',
      due > 0
        ? `实体卡押金现在是 ${formatYuan(due)}（页面上是 ${formatYuan(o.deposit.amount)}），这笔没有办理，请核对后重新确认`
        : held > 0
          ? `这位会员已经押着押金 ${formatYuan(held)}，不用再收，这笔没有办理，请核对后重新确认`
          : '现在发卡不用收押金，这笔没有办理，请核对后重新确认',
      { deposit: due },
    );
  }
  return due;
}

/** 写一行押金台账并记审计（调用方的事务里；会员一行已经锁住，带班次的已经对班次加了共享锁） */
export async function insertCardDeposit(
  tx: Tx,
  o: {
    kind: 'receive' | 'refund';
    memberId: number;
    memberName: string;
    cardId: number | null;
    cardNo: string | null;
    method: PaymentMethod;
    amount: number;
    ref: string;
    reason: string | null;
    shiftId: number | null;
    date: string;
    at: Date;
    key: string;
    requestHash: string;
  },
  ctx: OpContext,
): Promise<{ id: number; docNo: string }> {
  const docNo = await nextDocNo(tx, 'card_deposit', o.kind === 'receive' ? 'KY' : 'KT', o.date);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO member_card_deposits (doc_no, member_id, card_id, kind, method, amount, ref, reason, shift_id, business_date, operator_id, created_at, client_key, request_hash)
    VALUES (${docNo}, ${o.memberId}, ${o.cardId}, ${o.kind}, ${o.method}, ${o.amount}, ${o.ref}, ${o.reason}, ${o.shiftId}, ${o.date}, ${ctx.actor.id}, ${o.at},
            ${o.key}, ${o.requestHash})
    RETURNING id`;
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'member_card_deposit',
    targetType: 'member',
    targetId: o.memberId,
    detail: {
      docNo,
      kind: o.kind,
      memberName: o.memberName,
      cardNo: o.cardNo ?? undefined,
      amount: o.amount,
      method: o.method,
      ref: o.ref || undefined,
      reason: o.reason ?? undefined,
      summary: `${o.kind === 'receive' ? '收' : '退'}会员卡押金 ${formatYuan(o.amount)}（${PAYMENT_METHOD_LABELS[o.method]}）`,
    },
    ip: ctx.ip,
    businessDate: o.date,
  });
  return { id: Number(row!.id), docNo };
}

/** 会员详情「会员卡」里的押金：押着多少、台账（最近的在前） */
export async function memberCardDeposits(db: Db, memberId: number): Promise<MemberCardDeposits> {
  const rows = await db<CardDepositRow[]>`
    SELECT d.id, d.doc_no, d.kind, d.method, d.amount, d.ref, d.reason, c.card_no, st.display_name AS operator_name,
           d.business_date::text AS business_date, d.created_at
    FROM member_card_deposits d JOIN staff st ON st.id = d.operator_id LEFT JOIN member_cards c ON c.id = d.card_id
    WHERE d.member_id = ${memberId} ORDER BY d.id DESC LIMIT 100`;
  return { held: await heldCardDeposit(db, memberId), rows: rows.map((r) => ({ ...r, id: Number(r.id), createdAt: new Date(r.createdAt).toISOString() })) };
}

/** 日结：当天收、退的会员卡押金（按方式）与当天结束时押着的余额；按门店 */
export async function cardDepositDayTotals(db: Db, date: string): Promise<CardDepositDayTotals> {
  const rows = await db<(CardDepositMethodTotal & { kind: string })[]>`
    SELECT kind, method, count(*)::int AS count, sum(amount)::int AS amount FROM member_card_deposits
    WHERE business_date = ${date} AND store_id = ${currentStoreId()} GROUP BY kind, method ORDER BY kind, method`;
  const [held] = await db<{ amount: number }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END), 0)::int AS amount
    FROM member_card_deposits WHERE business_date <= ${date} AND store_id = ${currentStoreId()}`;
  const pick = (kind: string) => rows.filter((r) => r.kind === kind).map(({ method, count, amount }) => ({ method, count, amount }));
  return { received: pick('receive'), refunded: pick('refund'), held: held!.amount };
}

/**
 * 自检：每位会员押着的押金不为负；每一笔收的押金都有对应的卡、而且是这位会员的卡；退卡记录与押金台账一致；
 * 押金没有进会员储值（押金台账的单号不出现在储值流水里）
 */
export async function cardDepositChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const negative = await db<{ memberNo: string }[]>`
    SELECT m.member_no FROM member_card_deposits d JOIN members m ON m.id = d.member_id
    GROUP BY m.id, m.member_no HAVING sum(CASE WHEN d.kind = 'receive' THEN d.amount ELSE -d.amount END) < 0 LIMIT 5`;
  const strayCard = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM member_card_deposits d LEFT JOIN member_cards c ON c.id = d.card_id
    WHERE (d.kind = 'receive' AND c.id IS NULL) OR (c.id IS NOT NULL AND c.member_id <> d.member_id) LIMIT 5`;
  const returns = await db<{ ref: string }[]>`
    SELECT 'TK#' || r.id AS ref FROM member_card_returns r LEFT JOIN member_card_deposits d ON d.id = r.deposit_id
    WHERE (r.amount > 0 AND (d.id IS NULL OR d.kind <> 'refund' OR d.amount <> r.amount OR d.member_id <> r.member_id))
       OR (r.amount = 0 AND r.deposit_id IS NOT NULL)
    UNION ALL
    SELECT d.doc_no FROM member_card_deposits d WHERE d.kind = 'refund' AND NOT EXISTS (SELECT 1 FROM member_card_returns r WHERE r.deposit_id = d.id)
    LIMIT 5`;
  const inWallet = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM member_card_deposits d WHERE EXISTS (SELECT 1 FROM ledger_entries le WHERE le.doc_no = d.doc_no) LIMIT 5`;
  const [sum] = await db<{ held: number; members: number }[]>`
    SELECT coalesce(sum(h), 0)::int AS held, count(*) FILTER (WHERE h > 0)::int AS members
    FROM (SELECT sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END) AS h FROM member_card_deposits GROUP BY member_id) x`;
  const bad = [...negative.map((r) => r.memberNo), ...strayCard.map((r) => r.docNo), ...returns.map((r) => r.ref), ...inWallet.map((r) => r.docNo)];
  return [
    {
      key: 'member_card_deposits',
      label: '会员卡押金：押着的余额不为负，退卡与台账一致，押金不进储值',
      ok: bad.length === 0,
      detail: bad.length ? `对不上：${bad.join('、')}` : `押着的押金 ${formatYuan(sum!.held)}（${sum!.members} 位会员）；每笔收的押金都有对应的卡，退的都有退卡记录`,
    },
  ];
}
