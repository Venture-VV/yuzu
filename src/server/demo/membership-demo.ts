// 演示数据「会员体系」块（v0.7.24，docs/BENEFITS.md 第 6 节）：demo-prepare 在场景块之后执行，单独一个标记，
// 已经准备过的演示库再执行 demo-prepare 也会补上这一块。
//   · 三位演示会员：按会员体系 v2 第一期的规则，用往前推的充值、消费记账，再跑一次每天的到期处理，
//     得到「将到期（30 天内，进到期提醒名单）」「在补充期」「刚降档」三种状态（状态变化记录完整，自检一致）；
//   · 本店权益清单：导入（编号已有的跳过）；还没人动过的（草稿、版本 1）发布 4 项——按摩/足浴项目券（每月 1 张，L3 起 2 张）、
//     首充礼、会员专属通道（每月 4 次）、跨店余额通用；然后跑一次自动发放，够格的会员收到本月的券。
// v0.7.25 起另有一步「会员折扣与邀请体验」（单独一个标记，已经准备过会员体系块的演示库也会补上）：
//   · 发布 QY-011「派对房及包房折扣」（导入时预填的客房房费 L3 7.5 折、L4 6.5 折、L5 5.5 折、L6 5 折；还没人动过的才发布）；
//   · 「演示会员·邀请人」今天充值 5 万到 L4，邀请「演示会员·体验中」（还不是会员，当场建档）体验 L3·初 7 天。
//   会员折扣的结账单不预先做（会改动场景块客房的房态）：用「演示会员·邀请人」开牌、入住客房再结账，结账对话框自动带上 6.5 折。
// 试用、正式环境拒绝（红线），没有绕过开关；已有的会员（手机号已登记）、改过的权益都不动。

import { randomUUID } from 'node:crypto';
import { businessDateOf, businessDayStart } from '@shared/business-date';
import { shiftDate } from '@shared/labels';
import { daysToExpiry, reminderBucket, rechargeOutcome, type Grade } from '@shared/membership';
import type { AppConfig } from '../config';
import type { Sql } from '../db';
import type { Actor } from '../lib/context';
import { importCatalog, runBenefitsDaily, setBenefitStatus, updateBenefit } from '../modules/benefits';
import { createTrial } from '../modules/member-trials';
import { createTemplate } from '../modules/coupons';
import { createMember } from '../modules/members';
import { loadMembershipRules, runMembershipDaily } from '../modules/membership';
import { loadSettings } from '../modules/settings';
import { consume, recharge } from '../modules/wallet';
import { withShiftOptional } from './shift-rule';

export const MEMBERSHIP_DEMO_KEY = 'demo_membership';

/** 三位演示会员：充值、消费都按「多少天以前」记 */
export const MEMBERSHIP_DEMO_MEMBERS = [
  { key: 'expiring', name: '演示会员·将到期', phone: '19900009001', rechargeDaysAgo: 340, paid: 10_000_00, spends: [{ daysAgo: 300, cents: 1_000_00 }] },
  { key: 'grace', name: '演示会员·补充期', phone: '19900009002', rechargeDaysAgo: 400, paid: 10_000_00, spends: [{ daysAgo: 340, cents: 3_500_00 }] },
  { key: 'downgraded', name: '演示会员·刚降档', phone: '19900009003', rechargeDaysAgo: 385, paid: 30_000_00, spends: [] },
] as const;

/** 演示券模板（发布权益时选的券） */
const TEMPLATES = { massage: '演示·月度足疗券', welcome: '演示·首充礼' } as const;

/** 发布的 4 项（只发布还没人动过的：草稿、版本 1） */
const PUBLISH = [
  { code: 'QY-040', patch: (t: Record<string, number>) => ({ templateId: t.massage, quantity: 1, tierQuantities: [{ grade: 3, tier: 0, quantity: 2 }] }) },
  { code: 'QY-051', patch: (t: Record<string, number>) => ({ templateId: t.welcome, quantity: 1 }) },
  { code: 'QY-001', patch: () => ({ period: 'month', quantity: 4 }) },
  { code: 'QY-056', patch: () => ({}) },
] as const;

export interface MembershipDemoResult {
  skipped: boolean;
  done: string[];
  notes: string[];
}

export async function seedMembershipDemo(sql: Sql, config: AppConfig, opts: { now?: Date } = {}): Promise<MembershipDemoResult> {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入会员体系演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [marker] = await sql`SELECT 1 FROM settings WHERE key = ${MEMBERSHIP_DEMO_KEY}`;
  if (marker) return { skipped: true, done: [], notes: [] };
  const staff = await sql<{ id: number; username: string; displayName: string; active: boolean }[]>`
    SELECT id, username, display_name, active FROM staff WHERE username IN ('linlan', 'xiaozhou')`;
  const ownerRow = staff.find((s) => s.username === 'linlan' && s.active);
  const clerkRow = staff.find((s) => s.username === 'xiaozhou' && s.active);
  if (!ownerRow || !clerkRow) throw new Error('会员体系演示要用演示账号 linlan（店主）与 xiaozhou（前台），请先执行 seed-demo 与 seed-frontdesk-demo');
  const actor = (r: typeof ownerRow, role: 'owner' | 'clerk'): Actor => ({ id: Number(r.id), username: r.username, displayName: r.displayName, role, duties: [], mustChangePassword: false });
  const owner = actor(ownerRow, 'owner');
  const clerk = actor(clerkRow, 'clerk');
  const deps = { sql, config };
  const now = opts.now ?? new Date();
  const { businessDayStartHour } = await loadSettings(sql);
  const today = businessDateOf(now, config.timezone, businessDayStartHour);
  // 某个营业日的下午两点（营业日开始后 8 小时）
  const at = (daysAgo: number) => new Date(businessDayStart(shiftDate(today, -daysAgo), config.timezone, businessDayStartHour).getTime() + 8 * 3_600_000);
  const done: string[] = [];
  const notes: string[] = [];

  // ── 三位演示会员：往前推的充值与消费 ──
  const rules = await loadMembershipRules(sql);
  await withShiftOptional(sql, config, async () => {
    for (const m of MEMBERSHIP_DEMO_MEMBERS) {
      const [existing] = await sql<{ id: number }[]>`SELECT id FROM members WHERE phone = ${m.phone}`;
      if (existing) {
        notes.push(`手机号 ${m.phone} 已经有会员，没有建「${m.name}」`);
        continue;
      }
      const created = await createMember(sql, { name: m.name, phone: m.phone }, { actor: clerk }, { enforceRequired: false });
      await sql`UPDATE members SET is_synthetic = true, created_at = ${at(m.rechargeDaysAgo)} WHERE id = ${created.id}`;
      const outcome = rechargeOutcome(rules, 0 as Grade, 0, m.paid);
      await recharge(
        deps,
        { idempotencyKey: randomUUID(), memberId: created.id, planId: null, paidAmount: m.paid, bonusAmount: outcome.bonusCents, paymentMethod: 'wechat', paymentRef: '演示', note: '会员体系演示：往前推的充值', paymentConfirmed: true },
        { actor: clerk, at: at(m.rechargeDaysAgo) },
        { history: true },
      );
      for (const s of m.spends) {
        await consume(
          deps,
          { idempotencyKey: randomUUID(), memberId: created.id, lines: [], customLines: [{ name: '会员体系演示消费', amount: s.cents }], expectedTotal: s.cents, note: '会员体系演示' },
          { actor: owner, at: at(s.daysAgo) },
        );
      }
      done.push(`${m.name}：${m.rechargeDaysAgo} 天前充值 ${m.paid / 100} 元${m.spends.length ? `、${m.spends.map((s) => `${s.daysAgo} 天前消费 ${s.cents / 100} 元`).join('、')}` : ''}`);
    }
  });
  // 到期的按规则处理（进补充期、降档），与应用每分钟跑的是同一个
  const run = await runMembershipDaily(deps, now);
  if (run?.processed) done.push(`到期处理：${run.processed} 位（保级 ${run.retained}、进补充期 ${run.grace}、降档 ${run.downgraded}）`);

  // ── 本店权益清单：导入、发布 4 项 ──
  const imported = await importCatalog(sql, owner.id);
  if (imported.created) done.push(`导入本店权益清单 ${imported.created} 项（草稿）`);
  const templateIds: Record<string, number> = {};
  for (const [key, name] of Object.entries(TEMPLATES)) {
    const [t] = await sql<{ id: number }[]>`SELECT id FROM coupon_templates WHERE name = ${name} AND active ORDER BY id LIMIT 1`;
    if (t) templateIds[key] = Number(t.id);
    else {
      const createdTemplate = await createTemplate(
        deps,
        { clientKey: randomUUID(), name, kind: 'cash', faceValue: key === 'massage' ? 6800 : 5000, validity: 'days', validDays: 30, note: '会员体系演示' },
        { actor: owner },
      );
      templateIds[key] = createdTemplate.id;
      done.push(`券模板「${name}」`);
    }
  }
  for (const p of PUBLISH) {
    const [b] = await sql<{ id: number; name: string; status: string; version: number }[]>`SELECT id, name, status, version FROM benefits WHERE code = ${p.code}`;
    if (!b) continue;
    if (b.status !== 'draft' || b.version !== 1) {
      notes.push(`${p.code} ${b.name} 已经有人改过或发布过，没有动`);
      continue;
    }
    const [cur] = await sql<Record<string, unknown>[]>`
      SELECT name, category, start_grade, start_tier, period, quantity, tier_quantities, template_id, events, festival_dates::text[] AS festival_dates,
             content, conditions
      FROM benefits WHERE id = ${b.id}`;
    const saved = await updateBenefit(deps, Number(b.id), { expectedVersion: b.version, ...cur, ...p.patch(templateIds) }, { actor: owner, at: now });
    await setBenefitStatus(deps, Number(b.id), { expectedVersion: saved.version, status: 'published' }, { actor: owner, at: now });
    done.push(`发布 ${p.code} ${b.name}`);
  }
  const granted = await runBenefitsDaily(deps, now);
  if (granted?.coupons) done.push(`自动发放：${granted.processed} 位会员收到本月的券 ${granted.coupons} 张`);

  await sql`
    INSERT INTO settings (key, value) VALUES (${MEMBERSHIP_DEMO_KEY}, ${sql.json({ version: 1, preparedAt: now.toISOString(), businessDate: today })})
    ON CONFLICT (key) DO NOTHING`;
  return { skipped: false, done, notes };
}

// ───────────────────────── 核对（demo-check，只读） ─────────────────────────

export interface MembershipDemoState {
  /** 演示会员：档阶、阶位与状态（到期提醒几天内 / 补充期 / 刚降档 / 正常） */
  members: Record<string, { grade: number; tier: number | null; state: string }>;
  /** 已发布的演示权益（只看准备时发布的 4 项） */
  published: string[];
  /** 演示会员本月收到「按摩/足浴项目券」几张 */
  monthCoupons: Record<string, number>;
}

export async function membershipDemoState(sql: Sql, timeZone: string): Promise<MembershipDemoState> {
  const { businessDayStartHour } = await loadSettings(sql);
  const today = businessDateOf(new Date(), timeZone, businessDayStartHour);
  const rules = await loadMembershipRules(sql);
  const members: MembershipDemoState['members'] = {};
  const monthCoupons: Record<string, number> = {};
  for (const m of MEMBERSHIP_DEMO_MEMBERS) {
    const [r] = await sql<{ id: number; grade: number; tier: number | null; cycleStart: string | null; cycleEnd: string | null; graceUntil: string | null; lastKind: string | null }[]>`
      SELECT m.id, m.grade, m.tier, m.cycle_start, m.cycle_end, m.grace_until,
             (SELECT e.kind FROM member_grade_events e WHERE e.member_id = m.id ORDER BY e.id DESC LIMIT 1) AS last_kind
      FROM members m WHERE m.phone = ${m.phone}`;
    if (!r) {
      members[m.name] = { grade: -1, tier: null, state: '没有这位会员' };
      continue;
    }
    const days = daysToExpiry({ grade: r.grade as Grade, tier: null, cycleStart: r.cycleStart, cycleEnd: r.cycleEnd, graceUntil: r.graceUntil }, today);
    const reminder = r.graceUntil === null ? reminderBucket(rules, days) : null;
    members[m.name] = {
      grade: r.grade,
      tier: r.tier,
      state: r.graceUntil !== null ? 'grace' : r.lastKind === 'downgrade' ? 'downgraded' : reminder !== null ? `reminder${reminder}` : 'normal',
    };
    const [c] = await sql<{ n: number }[]>`
      SELECT coalesce(sum(g.quantity), 0)::int AS n FROM benefit_grants g JOIN benefits b ON b.id = g.benefit_id
      WHERE g.member_id = ${r.id} AND b.code = 'QY-040' AND g.period_key = ${today.slice(0, 7)}`;
    monthCoupons[m.name] = c!.n;
  }
  const published = (await sql<{ code: string }[]>`SELECT code FROM benefits WHERE status = 'published' AND code IN ${sql(PUBLISH.map((p) => p.code))} ORDER BY code`).map((r) => r.code);
  return { members, published, monthCoupons };
}

// ───────────────────────── 会员折扣与邀请体验（v0.7.25） ─────────────────────────

export const MEMBERSHIP_P3_DEMO_KEY = 'demo_membership_p3';

/** 邀请人（今天充值到 L4）与受邀人（还不是会员，邀请时当场建档） */
export const TRIAL_DEMO = {
  inviter: { name: '演示会员·邀请人', phone: '19900009004', paid: 50_000_00 },
  invitee: { name: '演示会员·体验中', phone: '19900009005' },
} as const;

export async function seedMembershipTrialDemo(sql: Sql, config: AppConfig, opts: { now?: Date } = {}): Promise<MembershipDemoResult> {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入会员体系演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [marker] = await sql`SELECT 1 FROM settings WHERE key = ${MEMBERSHIP_P3_DEMO_KEY}`;
  if (marker) return { skipped: true, done: [], notes: [] };
  const staff = await sql<{ id: number; username: string; displayName: string; active: boolean }[]>`
    SELECT id, username, display_name, active FROM staff WHERE username IN ('linlan', 'xiaozhou')`;
  const ownerRow = staff.find((s) => s.username === 'linlan' && s.active);
  const clerkRow = staff.find((s) => s.username === 'xiaozhou' && s.active);
  if (!ownerRow || !clerkRow) throw new Error('会员体系演示要用演示账号 linlan（店主）与 xiaozhou（前台），请先执行 seed-demo 与 seed-frontdesk-demo');
  const actor = (r: typeof ownerRow, role: 'owner' | 'clerk'): Actor => ({ id: Number(r.id), username: r.username, displayName: r.displayName, role, duties: [], mustChangePassword: false });
  const owner = actor(ownerRow, 'owner');
  const clerk = actor(clerkRow, 'clerk');
  const deps = { sql, config };
  const now = opts.now ?? new Date();
  const { businessDayStartHour } = await loadSettings(sql);
  const today = businessDateOf(now, config.timezone, businessDayStartHour);
  const done: string[] = [];
  const notes: string[] = [];

  // ── QY-011 包房折扣：还没人动过的（草稿、版本 1）按导入时预填的折扣发布 ──
  await importCatalog(sql, owner.id);
  const [qy011] = await sql<{ id: number; name: string; status: string; version: number }[]>`SELECT id, name, status, version FROM benefits WHERE code = 'QY-011'`;
  if (qy011 && qy011.status === 'draft' && qy011.version === 1) {
    await setBenefitStatus(deps, Number(qy011.id), { expectedVersion: qy011.version, status: 'published' }, { actor: owner, at: now });
    done.push(`发布 QY-011 ${qy011.name}（客房房费 L3 7.5 折、L4 6.5 折、L5 5.5 折、L6 5 折）`);
  } else if (qy011) {
    notes.push(`QY-011 ${qy011.name} 已经有人改过或发布过，没有动`);
  }

  // ── 邀请人：今天充值 5 万到 L4 ──
  const rules = await loadMembershipRules(sql);
  let inviterId: number | null = null;
  const [existingInviter] = await sql<{ id: number }[]>`SELECT id FROM members WHERE phone = ${TRIAL_DEMO.inviter.phone}`;
  if (existingInviter) notes.push(`手机号 ${TRIAL_DEMO.inviter.phone} 已经有会员，没有建「${TRIAL_DEMO.inviter.name}」`);
  else {
    await withShiftOptional(sql, config, async () => {
      const created = await createMember(sql, { name: TRIAL_DEMO.inviter.name, phone: TRIAL_DEMO.inviter.phone }, { actor: clerk }, { enforceRequired: false });
      await sql`UPDATE members SET is_synthetic = true WHERE id = ${created.id}`;
      const outcome = rechargeOutcome(rules, 0 as Grade, 0, TRIAL_DEMO.inviter.paid);
      await recharge(
        deps,
        {
          idempotencyKey: randomUUID(),
          memberId: created.id,
          planId: null,
          paidAmount: TRIAL_DEMO.inviter.paid,
          bonusAmount: outcome.bonusCents,
          paymentMethod: 'wechat',
          paymentRef: '演示',
          note: '会员体系演示：邀请人充值',
          paymentConfirmed: true,
        },
        { actor: clerk, at: now },
      );
      inviterId = created.id;
    });
    done.push(`${TRIAL_DEMO.inviter.name}：今天充值 ${TRIAL_DEMO.inviter.paid / 100} 元（L4）`);
  }

  // ── 邀请体验：受邀人还不是会员，当场建档 ──
  const [existingInvitee] = await sql<{ id: number }[]>`SELECT id FROM members WHERE phone = ${TRIAL_DEMO.invitee.phone}`;
  if (existingInvitee) notes.push(`手机号 ${TRIAL_DEMO.invitee.phone} 已经有会员，没有邀请「${TRIAL_DEMO.invitee.name}」`);
  else if (inviterId !== null) {
    const { memberChannels } = await loadSettings(sql);
    const channel = memberChannels.find((c) => c.active && c.label === '老带新')?.key ?? null;
    const { trial } = await createTrial(
      deps,
      inviterId,
      { clientKey: randomUUID(), kind: 'invite', phone: TRIAL_DEMO.invitee.phone, name: TRIAL_DEMO.invitee.name, channel },
      { actor: clerk, at: now },
    );
    await sql`UPDATE members SET is_synthetic = true WHERE id = ${trial.memberId}`;
    done.push(`${TRIAL_DEMO.inviter.name}邀请${TRIAL_DEMO.invitee.name}体验 ${trial.label}（${trial.startsOn} 至 ${trial.endsOn}）`);
  }

  await sql`
    INSERT INTO settings (key, value) VALUES (${MEMBERSHIP_P3_DEMO_KEY}, ${sql.json({ version: 1, preparedAt: now.toISOString(), businessDate: today })})
    ON CONFLICT (key) DO NOTHING`;
  return { skipped: false, done, notes };
}

export interface MembershipTrialDemoState {
  /** 发布的折扣类（只看 QY-011） */
  discounts: string[];
  /** 邀请人的档级 */
  inviterGrade: number;
  /** 体验中的会员：方式、体验的档级、邀请人、状态 */
  trials: Record<string, { kind: string; grade: number; inviter: string; status: string }>;
}

export async function membershipTrialDemoState(sql: Sql): Promise<MembershipTrialDemoState> {
  const discounts = (await sql<{ code: string }[]>`SELECT code FROM benefits WHERE status = 'published' AND code = 'QY-011'`).map((r) => r.code);
  const [inviter] = await sql<{ grade: number }[]>`SELECT grade FROM members WHERE phone = ${TRIAL_DEMO.inviter.phone}`;
  const rows = await sql<{ name: string; kind: string; grade: number; inviter: string; status: string }[]>`
    SELECT m.name, t.kind, t.grade, i.name AS inviter, t.status
    FROM member_trials t JOIN members m ON m.id = t.member_id JOIN members i ON i.id = t.inviter_id
    WHERE m.phone = ${TRIAL_DEMO.invitee.phone} ORDER BY t.id`;
  return {
    discounts,
    inviterGrade: inviter?.grade ?? -1,
    trials: Object.fromEntries(rows.map((r) => [r.name, { kind: r.kind, grade: r.grade, inviter: r.inviter, status: r.status }])),
  };
}
