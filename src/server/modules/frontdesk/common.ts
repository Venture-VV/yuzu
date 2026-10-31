// 前台模块的公共能力：规则、营业日、单号、按固定顺序加锁、幂等键。
//
// 并发规则：
//   · 加锁顺序固定为「手牌（id 升序）→ 同行组（id 升序）→ 来访（id 升序）→ 账单」，任何操作都不反向加锁；
//   · 「一牌一人」「一位会员只持一张在店手牌」由部分唯一索引兜底，即使漏锁也不会出现双占；
//   · 账单合计与明细在同一事务内更新，自检核对二者一致。

import { createHash } from 'node:crypto';
import { businessDateOf } from '@shared/business-date';
import { DEFAULT_FRONTDESK_RULES, type FrontdeskRules, type TagKind, type TagZone, ZONE_LABELS } from '@shared/frontdesk';
import { can, type Permission } from '@shared/permissions';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Actor, Deps } from '../../lib/context';
import { AppError, conflict, forbidden, unprocessable } from '../../lib/errors';
import { assertNotFenced, isFenced } from '../../lib/fences';
import { nextDocNo, setTxTimeouts } from '../inventory/common';
import { loadSettings } from '../settings';

export { nextDocNo, setTxTimeouts };

export async function loadFrontdeskRules(db: Db): Promise<FrontdeskRules> {
  const [row] = await db<{ value: Partial<FrontdeskRules> }[]>`SELECT value FROM settings WHERE key = 'frontdesk_rules'`;
  return { ...DEFAULT_FRONTDESK_RULES, ...(row?.value ?? {}) };
}

/** 前台按会员业务同一套营业日（例如凌晨 6 点切换），跨夜在店的客人归入入场时的营业日 */
export async function businessDate(db: Db, deps: Deps, at: Date): Promise<string> {
  const settings = await loadSettings(db);
  return businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
}

export const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

/**
 * 前台的幂等业务类型；table_open / table_post / table_checkout 是餐饮第二步的开台、桌台点单与桌台结账；
 * room_* 是客房（S7）的入住、续住加段、收押金、退押金、退房（洗浴客人）与退房结账（只住房的客人）
 */
export const FRONTDESK_OPS = [
  'checkin',
  'bill_post',
  'tag_swap',
  'checkout',
  'table_open',
  'table_post',
  'table_checkout',
  'room_checkin',
  'room_extend',
  'room_deposit',
  'room_refund',
  'room_close',
  'room_checkout',
] as const;
export type FrontdeskOp = (typeof FRONTDESK_OPS)[number];

/**
 * 作废「结果待确认」的操作要有原业务本身的权限（全部都要，与原接口一致）：
 * 没有结账收款权限的人不能作废结账、桌台结账，没有餐饮点单权限的人不能作废开台、桌台点单。
 * 挂账（含点单、派钟挂到手牌上）按前台挂账权限。
 */
export const FRONTDESK_OP_PERMISSIONS: Record<FrontdeskOp, readonly Permission[]> = {
  checkin: ['frontdesk.operate'],
  bill_post: ['frontdesk.operate'],
  tag_swap: ['frontdesk.operate'],
  checkout: ['frontdesk.checkout'],
  table_open: ['dining.order', 'frontdesk.operate'],
  table_post: ['dining.order', 'frontdesk.operate'],
  table_checkout: ['frontdesk.checkout'],
  room_checkin: ['room.operate'],
  room_extend: ['room.operate'],
  room_deposit: ['room.operate'],
  room_refund: ['room.operate'],
  room_close: ['room.operate'],
  room_checkout: ['frontdesk.checkout'],
};

export const abandonedError = () =>
  conflict('OP_ABANDONED', '这笔操作已在「结果待确认」时由员工作废，不会再生效；如仍需要，请重新填写一笔');

interface KeyRow {
  opType: string;
  requestHash: string;
  refId: number;
}

/** 查找操作编号；同一编号用于不同的请求时拒绝，避免把两笔业务混成一笔；已作废（同一类型）时拒绝 */
export async function findKey(db: Db, key: string, opType: FrontdeskOp, requestHash: string): Promise<number | null> {
  const [row] = await db<KeyRow[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${key}`;
  if (!row) {
    if (await isFenced(db, key, [opType])) throw abandonedError();
    return null;
  }
  // 005 版本的作废登记直接占用了编号，仍按已作废处理
  if (row.opType === 'abandoned') throw abandonedError();
  if (row.opType !== opType || row.requestHash !== requestHash) {
    throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的业务，请刷新页面后重新发起');
  }
  return row.refId;
}

/** 写下操作编号（事务最后一步）：先与「确认作废」串行检查，处理期间被作废（同一类型）则整笔回滚 */
export async function saveKey(tx: Tx, key: string, opType: FrontdeskOp, requestHash: string, refId: number, staffId: number) {
  await assertNotFenced(tx, key, opType, abandonedError);
  await tx`
    INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
    VALUES (${key}, ${opType}, ${requestHash}, ${refId}, ${staffId})`;
}

/**
 * 执行一笔幂等写操作：同一编号重复提交时返回第一次的结果编号。
 *
 * 同一编号的两次提交并发时（网络重试），后到的那次开头查编号时第一次还没提交，接着排在第一次的锁后面；
 * 等它拿到锁，看到的是第一次的结果（手牌已发出、桌台已开、客人已结账……），或在写编号时撞上主键。
 * 这两种失败都先按编号查回：是同一笔就返回第一次的结果，不提示「被其他终端」占用（店主 2026-10-30）；
 * 查不到，或编号属于另一笔，照原样拒绝。
 */
export async function runIdempotent(
  deps: Deps,
  opts: { key: string; opType: FrontdeskOp; requestHash: string },
  body: (tx: Tx) => Promise<number>,
): Promise<{ refId: number; replayed: boolean }> {
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findKey(tx, opts.key, opts.opType, opts.requestHash);
      if (existing !== null) return { refId: existing, replayed: true };
      return { refId: await body(tx), replayed: false };
    });
  } catch (error) {
    const mapped = mapUniqueViolation(error);
    if (mapped instanceof AppError || isUniqueViolation(error, 'idempotency_keys_pkey')) {
      const existing = await findKey(deps.sql, opts.key, opts.opType, opts.requestHash);
      if (existing !== null) return { refId: existing, replayed: true };
    }
    throw mapped;
  }
}

/** 部分唯一索引兜底时，翻译成店员看得懂的提示 */
export function mapUniqueViolation(error: unknown): unknown {
  if (isUniqueViolation(error, 'visits_tag_open_uq')) {
    return conflict('TAG_OCCUPIED', '这张手牌刚刚被其他终端发出，请换一张空闲手牌');
  }
  if (isUniqueViolation(error, 'table_sessions_table_open_uq')) {
    return conflict('TABLE_TAKEN', '这张桌台刚刚被其他终端开台，请换一张空桌');
  }
  if (isUniqueViolation(error, 'visits_member_open_uq')) {
    return conflict('MEMBER_IN_STORE', '这位会员已持有一张在店手牌，请先在状态板上找到原手牌');
  }
  if (isUniqueViolation(error, 'room_stays_room_open_uq')) {
    return conflict('ROOM_TAKEN', '这间房刚刚被其他终端入住，请换一间空房');
  }
  if (isUniqueViolation(error, 'group_buy_coupons_code_uq')) {
    return conflict('COUPON_USED', '这张团购券刚刚已在其他终端登记，同一张券不能重复使用');
  }
  return error;
}

export interface LockedTag {
  id: number;
  code: string;
  zone: TagZone;
  kind: TagKind;
  vipLevel: number | null;
  locked: boolean;
  lockReason: string | null;
  active: boolean;
}

/** 按 id 升序锁定手牌；牌号不存在时提示具体牌号 */
export async function lockTagsByCode(tx: Tx, codes: string[]): Promise<Map<string, LockedTag>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await tx<LockedTag[]>`
    SELECT id, code, zone, kind, vip_level, locked, lock_reason, active FROM hand_tags
    WHERE code IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const missing = unique.filter((c) => !byCode.has(c));
  if (missing.length) throw unprocessable('TAG_NOT_FOUND', `手牌池里没有牌号 ${missing.join('、')}，请核对牌号`, { codes: missing });
  return byCode;
}

/** 手牌可以发给这位宾客吗：启用、未锁定、分区一致 */
/** zone 为宾客分区；旧的儿童区来访（迁移 008 之前）换牌时仍按原分区核对 */
export function assertTagIssuable(tag: LockedTag, zone: TagZone) {
  if (!tag.active) throw unprocessable('TAG_INACTIVE', `手牌 ${tag.code} 已停用，请换一张`);
  if (tag.locked) throw unprocessable('TAG_LOCKED', `手牌 ${tag.code} 已锁定（${tag.lockReason}），请换一张`);
  if (tag.zone !== zone) {
    throw unprocessable(
      'ZONE_MISMATCH',
      `手牌 ${tag.code} 是${ZONE_LABELS[tag.zone].title}牌，不能发给${ZONE_LABELS[zone].title}，请换一张${ZONE_LABELS[zone].title}牌`,
      { tagZone: tag.zone, guestZone: zone },
    );
  }
}

/** 已锁定手牌上的在店来访（用来提示「已在店」） */
export async function openVisitsOnTags(tx: Tx, tagIds: number[]) {
  if (tagIds.length === 0) return [];
  return tx<{ tagId: number; visitNo: string; checkedInAt: string }[]>`
    SELECT tag_id, visit_no, checked_in_at FROM visits WHERE status = 'open' AND tag_id IN ${tx(tagIds)}`;
}

export interface LockedVisit {
  id: number;
  visitNo: string;
  billId: number;
  tagId: number;
  zone: TagZone;
  memberId: number | null;
  groupId: number | null;
  status: 'open' | 'settled' | 'cancelled';
  checkedInAt: string;
  checkedInBy: number;
}

export async function lockVisits(tx: Tx, ids: number[]): Promise<Map<number, LockedVisit>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  const rows = await tx<LockedVisit[]>`
    SELECT id, visit_no, bill_id, tag_id, zone, member_id, group_id, status, checked_in_at, checked_in_by
    FROM visits WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw unprocessable('VISIT_NOT_FOUND', '来访记录不存在，请刷新后重试');
  return new Map(rows.map((r) => [r.id, r]));
}

export function assertOpen(v: LockedVisit) {
  if (v.status !== 'open') {
    throw conflict('VISIT_CLOSED', `来访 ${v.visitNo} 已${v.status === 'settled' ? '结账离店' : '撤销'}，不能再操作`);
  }
}

export async function lockGroups(tx: Tx, ids: (number | null)[]) {
  const unique = [...new Set(ids.filter((x): x is number => x !== null))].sort((a, b) => a - b);
  if (unique.length === 0) return;
  await tx`SELECT id FROM visit_groups WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
}

/** 同行组没有在店客人时关闭 */
export async function closeGroupIfEmpty(tx: Tx, groupId: number | null, at: Date) {
  if (!groupId) return;
  const [row] = await tx<{ open: number }[]>`SELECT count(*) AS open FROM visits WHERE group_id = ${groupId} AND status = 'open'`;
  if (row!.open === 0) {
    await tx`UPDATE visit_groups SET status = 'closed', closed_at = ${at} WHERE id = ${groupId} AND status = 'open'`;
  }
}

/**
 * 更正权限：有「作废与撤销」权限的岗位随时可以；
 * 其他人只能处理自己在规定分钟内登记的内容。
 */
export function assertCanFix(actor: Actor, ownerId: number, createdAt: string, rules: FrontdeskRules, now: Date, what: string) {
  if (can(actor, 'frontdesk.correct')) return;
  const minutes = (now.getTime() - new Date(createdAt).getTime()) / 60_000;
  if (ownerId === actor.id && minutes <= rules.selfVoidMinutes) return;
  throw forbidden(
    ownerId === actor.id
      ? `${what}已超过 ${rules.selfVoidMinutes} 分钟，请由店主处理`
      : `${what}不是你登记的，请由店主或登记人处理`,
  );
}
