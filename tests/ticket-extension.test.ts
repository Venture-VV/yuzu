// 浴票延迟（v0.7.25 续，docs/MEMBERSHIP_P3.md 第 4 节，迁移 045）：会员的门票在「门票跳档宽限」之上多给几分钟不跳档。
//   · QY-004 导入为「浴票延迟」类、草稿、没有分钟数：不填分钟数不能发布；分钟数 1–240；不能登记使用（结账时自动算）；
//   · 起点 L1·尊（会员文档），按会员现在的档阶取一行（不相加）；体验中的临时身份取高的；非会员、档阶不够的、暂缓后都不算；
//   · 结账核对、结账、手牌详情、看板的门票估算同一算法；结账单记下延迟的分钟数与权益，结账记录显示；
//   · 结账核对之后浴票延迟变了（暂缓、档阶变了），门票金额跟着变，按 PRICE_CHANGED 请员工重新核对；
//   · 合并结账只给会员本人的手牌；自检照常全过。
// 用 ctx.at 指定接待时刻来模拟「在店 12 小时 40 分」：跳档宽限默认 15 分钟，散客已跳到 24 小时档；多给 30 分钟的会员仍是 12 小时档。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { minutesText, quantityText, ticketExtensionFor, type Benefit, type BenefitCatalog, type MemberBenefits } from '../src/shared/benefits';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { VisitDetail } from '../src/shared/frontdesk';
import { rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import type { Actor } from '../src/server/lib/context';
import { benefitChecks } from '../src/server/modules/benefits';
import { checkout } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { api, setup, type TestContext } from './helpers';

const H = 3_600_000;
const MIN = 60_000;
let ctx: TestContext;
let clerk: Actor;
let deps: { sql: TestContext['sql']; config: TestContext['config'] };

const yuan = (n: number) => Math.round(n * 100);
const catalog = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/benefits')).body as BenefitCatalog;
const byCode = async (code: string) => (await catalog()).items.find((b) => b.code === code)!;
const editRaw = async (code: string, patch: Partial<Benefit>) => {
  const b = await byCode(code);
  const { id, version, name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, discountTarget, weekdays, monthDays, content, conditions } =
    b;
  return api(ctx.app, ctx.owner, 'PUT', `/api/benefits/${id}`, {
    expectedVersion: version,
    ...{ name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, discountTarget, weekdays, monthDays, content, conditions },
    ...patch,
  });
};
const edit = async (code: string, patch: Partial<Benefit>) => {
  const r = await editRaw(code, patch);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Benefit;
};
const setStatus = async (code: string, status: 'published' | 'paused') => {
  const b = await byCode(code);
  return api(ctx.app, ctx.owner, 'POST', `/api/benefits/${b.id}/status`, { expectedVersion: b.version, status });
};
const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
let phoneNo = 0;
/** 新会员（没有余额，L0）；给了档阶就按「手动调整会员档阶」调到那一档 */
const member = async (name: string, state?: { grade: number; tier: number }) => {
  phoneNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone: `1995555${String(phoneNo).padStart(4, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  if (state) {
    const info = await gradeOf(id);
    const a = await api(ctx.app, ctx.owner, 'POST', `/api/members/${id}/grade`, {
      clientKey: randomUUID(),
      grade: state.grade,
      tier: state.tier,
      reason: '浴票延迟用例',
      expectedVersion: info.version,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
  }
  return id;
};
let tagNo = 0;
/** 在 stayMs 之前接待一位客人（可带会员），返回来访 */
const enter = async (memberId: number | null, stayMs: number) => {
  tagNo += 1;
  const tagCode = `E${String(tagNo).padStart(3, '0')}`;
  const r = await checkin(deps, { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', memberId }] }, { actor: clerk, at: new Date(Date.now() - stayMs) });
  return { visitId: r.visits[0]!.id, tagCode };
};
const preview = async (visitIds: number[]) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitIds.join(',')}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CheckoutPreview;
};
const pay = (visitIds: number[], total: number) =>
  checkout(deps, { clientKey: randomUUID(), visitIds, expectedTotal: total, payments: [{ method: 'cash', amount: total }] }, { actor: clerk });
const visitOf = async (visitId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body as VisitDetail;
const allChecksOk = async () => {
  const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[];
  for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
  for (const c of st.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  for (const c of await benefitChecks(ctx.sql)) {
    if (c.label.includes('自动发放')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

/** 在店 12 小时 40 分：宽限 15 分钟的散客已跳档，多给 30 分钟以上的会员仍是 12 小时档 */
const STAY = 12 * H + 40 * MIN;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'E', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  // 首充、续充最低放到 1,000（只为邀请人凑档方便）
  const r = await rules();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(1000) })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('浴票延迟的规则（共用）', () => {
  it('按会员现在的档阶取一行；几项取分钟数多的（不相加）；起点以下不享；分钟数的写法', () => {
    const a = { id: 1, sortOrder: 10, startGrade: 1, startTier: 2, quantity: 30, tierQuantities: [{ grade: 2 as const, tier: 0 as const, quantity: 60 }] };
    const b = { id: 2, sortOrder: 20, startGrade: 3, startTier: 0, quantity: 90, tierQuantities: [] };
    expect(ticketExtensionFor([a, b], 1, 1)).toBeNull();
    expect(ticketExtensionFor([a, b], 1, 2)).toEqual({ benefit: a, minutes: 30 });
    expect(ticketExtensionFor([a, b], 2, 1)).toEqual({ benefit: a, minutes: 60 });
    expect(ticketExtensionFor([a, b], 3, 0)).toEqual({ benefit: b, minutes: 90 });
    // 分钟数相同按清单顺序
    expect(ticketExtensionFor([{ ...b, quantity: 60 }, a], 3, 0)!.benefit.id).toBe(1);
    expect([minutesText(30), minutesText(60), minutesText(90), minutesText(125)]).toEqual(['30 分钟', '1 小时', '1 小时 30 分钟', '2 小时 5 分钟']);
    expect([quantityText('extension', 'none', null), quantityText('extension', 'none', 90)]).toEqual(['未填分钟数', '多 1 小时 30 分钟不跳档']);
  });
});

describe('QY-004 浴票延迟（后台「会员权益」）', () => {
  it('导入为浴票延迟、草稿、不预填分钟数；不填分钟数不能发布；分钟数 1–240；不能登记使用', async () => {
    const q = await byCode('QY-004');
    expect(q).toMatchObject({ category: 'extension', status: 'draft', quantity: null, startLabel: 'L1·尊', period: 'none', tierQuantities: [] });
    const no = await setStatus('QY-004', 'published');
    expect(no.status).toBe(422);
    expect(no.body.error.message).toContain('请填写起点多给几分钟不跳档');
    for (const bad of [0, 241]) expect((await editRaw('QY-004', { quantity: bad })).status, String(bad)).toBe(400);
    expect((await editRaw('QY-004', { quantity: 30, tierQuantities: [{ grade: 2, tier: 0, quantity: 241 }] })).status).toBe(400);
    // 起点 L1·尊 30 分钟、L2·初 起 60 分钟、L3·初 起 90 分钟（演示用的梯度，店主另定）
    const saved = await edit('QY-004', {
      quantity: 30,
      tierQuantities: [
        { grade: 2, tier: 0, quantity: 60 },
        { grade: 3, tier: 0, quantity: 90 },
      ],
    });
    expect(saved).toMatchObject({ category: 'extension', quantity: 30, period: 'none' });
    expect((await setStatus('QY-004', 'published')).status).toBe(200);

    const m = await member('能享延迟的会员', { grade: 1, tier: 2 });
    const use = await api(ctx.app, ctx.clerk, 'POST', `/api/members/${m}/benefit-uses`, { clientKey: randomUUID(), benefitId: q.id });
    expect(use.status).toBe(422);
    expect(use.body.error).toMatchObject({ code: 'BENEFIT_NOT_SERVICE' });
    expect(use.body.error.message).toContain('结账时自动算');
    // 会员详情「本月可享」列出浴票延迟
    const mine = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m}/benefits`)).body as MemberBenefits;
    expect(mine.items.find((i) => i.code === 'QY-004')).toMatchObject({ category: 'extension', quantity: 30, extension: { minutes: 30 } });
  });
});

describe('结账时自动多给（宽限 15 分钟、在店 12 小时 40 分）', () => {
  it('散客、档阶不够的跳到 24 小时档；L1·尊 多 30 分钟、L2·享 按 L2·初 那一行多 60 分钟，仍是 12 小时档；手牌详情、核对、结账同一算法', async () => {
    const guest = await enter(null, STAY);
    const low = await enter(await member('L1 享阶会员', { grade: 1, tier: 1 }), STAY);
    const l1 = await enter(await member('L1 尊阶会员', { grade: 1, tier: 2 }), STAY);
    const l2 = await enter(await member('L2 享阶会员', { grade: 2, tier: 1 }), STAY);
    const p = await preview([guest.visitId, low.visitId, l1.visitId, l2.visitId]);
    const by = (tag: string) => p.visits.find((v) => v.tagCode === tag)!;
    expect(p.graceMinutes).toBe(15);
    expect(by(guest.tagCode)).toMatchObject({ graceMinutes: 15, extension: null, ticket: { segments: 2, amount: 59900 } });
    expect(by(low.tagCode)).toMatchObject({ graceMinutes: 15, extension: null, ticket: { segments: 2, amount: 59900 } });
    expect(by(l1.tagCode)).toMatchObject({ graceMinutes: 45, extension: { minutes: 30, code: 'QY-004' }, ticket: { segments: 1, amount: 49900 } });
    expect(by(l2.tagCode)).toMatchObject({ graceMinutes: 75, extension: { minutes: 60, code: 'QY-004' }, ticket: { segments: 1, amount: 49900 } });
    // 下一次跳档的时刻按多给的分钟数推后
    const jump = (v: CheckoutPreview['visits'][number]) => new Date(v.ticket!.nextJumpAt).getTime() - new Date(v.checkedInAt).getTime();
    expect(jump(by(l1.tagCode))).toBe(12 * H + 45 * MIN);
    expect(jump(by(l2.tagCode))).toBe(12 * H + 75 * MIN);

    // 手牌详情的门票与核对一致
    expect((await visitOf(l1.visitId)).ticket).toMatchObject({ segments: 1, amount: 49900, extension: { minutes: 30 } });
    expect((await visitOf(guest.visitId)).ticket).toMatchObject({ segments: 2, amount: 59900, extension: null });

    // 看板的门票估算按同一算法（含浴票延迟）
    const open = await ctx.sql<{ id: number }[]>`SELECT id FROM visits WHERE status = 'open'`;
    const all = await preview(open.map((v) => Number(v.id)));
    const dash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    expect(dash.inStore.ticketEstimate).toBe(all.visits.reduce((s, v) => s + (v.ticket?.amount ?? 0), 0));

    // 结账：会员的门票按延迟后的段数入账，结账单记下分钟数与权益
    const done = await pay([l1.visitId], by(l1.tagCode).amount);
    expect(done.bills[0]).toMatchObject({ ticketSegments: 1, ticketAmount: 49900, ticketExtensionMinutes: 30 });
    const qy004 = await byCode('QY-004');
    const [row] = await ctx.sql<{ minutes: number; benefitId: number }[]>`
      SELECT ticket_extension_minutes AS minutes, ticket_extension_benefit_id AS benefit_id FROM checkout_bills WHERE checkout_id = ${done.id}`;
    expect({ minutes: row!.minutes, benefitId: Number(row!.benefitId) }).toEqual({ minutes: 30, benefitId: qy004.id });
    const guestDone = await pay([guest.visitId], by(guest.tagCode).amount);
    expect(guestDone.bills[0]).toMatchObject({ ticketSegments: 2, ticketAmount: 59900, ticketExtensionMinutes: 0 });
    const [audit] = await ctx.sql<{ detail: { tickets: { extension?: { minutes: number; benefitId: number; version: number } }[] } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'frontdesk_checkout' AND target_id = ${done.id}`;
    expect(audit!.detail.tickets[0]!.extension).toEqual({ minutes: 30, benefitId: qy004.id, version: qy004.version });
    await allChecksOk();
  });

  it('合并结账只给会员本人的手牌：同行的散客照样跳档', async () => {
    const m = await enter(await member('带朋友的会员', { grade: 1, tier: 2 }), STAY);
    const friend = await enter(null, STAY);
    const p = await preview([m.visitId, friend.visitId]);
    expect(p.visits.map((v) => [v.tagCode, v.ticket!.segments, v.extension?.minutes ?? 0])).toEqual([
      [m.tagCode, 1, 30],
      [friend.tagCode, 2, 0],
    ]);
    const done = await pay([m.visitId, friend.visitId], p.totalAmount);
    expect(done.bills.map((b) => [b.tagCode, b.ticketSegments, b.ticketExtensionMinutes])).toEqual([
      [m.tagCode, 1, 30],
      [friend.tagCode, 2, 0],
    ]);
  });

  it('体验中的临时身份取高的：L0 客人被 L3 会员邀请体验 L2·初，多 60 分钟', async () => {
    const inviter = await member('邀请人（L3）', { grade: 3, tier: 0 });
    const invitee = await member('体验中的客人');
    const t = await api(ctx.app, ctx.clerk, 'POST', `/api/members/${inviter}/trials`, { clientKey: randomUUID(), kind: 'invite', phone: `1995555${String(phoneNo).padStart(4, '0')}` });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.trial).toMatchObject({ memberId: invitee, grade: 2, tier: 0 });
    const v = await enter(invitee, STAY);
    const p = await preview([v.visitId]);
    expect(p.visits[0]).toMatchObject({ extension: { minutes: 60 }, ticket: { segments: 1 } });
  });

  it('核对之后浴票延迟没了（暂缓）：门票跟着跳档，按原合计结账被拒 PRICE_CHANGED；重新核对后照常结', async () => {
    const v = await enter(await member('核对后暂缓的会员', { grade: 1, tier: 2 }), STAY);
    const before = await preview([v.visitId]);
    expect(before.visits[0]).toMatchObject({ extension: { minutes: 30 }, ticket: { segments: 1, amount: 49900 } });
    expect((await setStatus('QY-004', 'paused')).status).toBe(200);
    await expect(pay([v.visitId], before.totalAmount)).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
    const after = await preview([v.visitId]);
    expect(after.visits[0]).toMatchObject({ graceMinutes: 15, extension: null, ticket: { segments: 2, amount: 59900 } });
    const done = await pay([v.visitId], after.totalAmount);
    expect(done.bills[0]).toMatchObject({ ticketSegments: 2, ticketExtensionMinutes: 0 });
    // 暂缓后会员详情不再列出
    const m = (await ctx.sql<{ memberId: number }[]>`SELECT member_id FROM visits WHERE id = ${v.visitId}`)[0]!.memberId;
    const mine = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m}/benefits`)).body as MemberBenefits;
    expect(mine.items.find((i) => i.code === 'QY-004')).toBeUndefined();
    await allChecksOk();
  });
});
