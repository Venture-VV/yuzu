// R1.9 按实际时间补录纸质单（店主 2026-10-29 决定要做，细则见 docs/PENDING_DECISIONS.md「按实际时间补录纸质单」），以及 R1.2-b：
//   · 值班经理及以上带纸质单号与实际时间补录接待、挂账、结账：单据时间与营业日按实际时间，门票按实际在店时长；
//   · 实际时间在 48 小时以内、不晚于现在；挂账、结账不能早于接待，结账不能早于已挂的明细；补录的结账不能用储值；
//   · 实际时间那一刻手牌或会员已被占用时拒绝；手牌之后又发给了别人，补录接待的客人要按纸质单补录结账时间；
//   · 每一步留补录记录（只追加），单据带补录标记，日结与对账的异常清单列出「补录」，前台自检核对补录记录与单据一致；
//   · 优惠 / 免单不能由收银的本人授权（店主除外），降档 / 免票不受影响。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import type { Actor } from '../src/server/lib/context';
import { checkout } from '../src/server/modules/frontdesk/checkout';
import { checkin, swapTag } from '../src/server/modules/frontdesk/visits';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

const H = 3_600_000;
let ctx: TestContext;
let duty: string;
let dutyId: number;

const clerkActor = (): Actor => ({ id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false });
const dutyActor = (): Actor => ({ id: dutyId, username: 'duty', displayName: '值班经理', role: 'duty_manager', duties: [], mustChangePassword: false });
const periodsCheck = async () =>
  ((await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[]).find((c) => c.key === 'visit_periods')!;
const deps = () => ({ sql: ctx.sql, config: ctx.config });
const ago = (hours: number) => new Date(Date.now() - hours * H);
const slip = (at: Date, slipNo = 'P0001') => ({ slipNo, at: at.toISOString() });
const dateOf = (at: Date) => businessDateOf(at, ctx.config.timezone, 6);
/** 数据库读回的时间（字符串）→ 毫秒 */
const ms = (d: string | Date) => new Date(d).getTime();

const enter = (cookie: string, tagCode: string, body: Record<string, unknown> = {}, guest: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...guest }], ...body });
const charge = (cookie: string, visitId: number, amount: number, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/charges`, {
    clientKey: randomUUID(),
    customLines: [{ name: '茶水', amount }],
    expectedTotal: amount,
    ...body,
  });
const pay = (cookie: string, visitIds: number[], expectedTotal: number, payments: unknown[], body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds, expectedTotal, payments, ...body });
const preview = (cookie: string, ids: number[], at?: Date) =>
  api(ctx.app, cookie, 'GET', `/api/frontdesk/checkout-preview?ids=${ids.join(',')}${at ? `&at=${encodeURIComponent(at.toISOString())}` : ''}`);
/** 店员在 from 接待、to 结账（现金）：制造一段已离店的来访 */
async function pastVisit(tagCode: string, from: Date, to: Date, memberId: number | null = null) {
  const r = await checkin(deps(), { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', memberId }] }, { actor: clerkActor(), at: from });
  const id = r.visits[0]!.id;
  const p = await checkout(
    deps(),
    { clientKey: randomUUID(), visitIds: [id], expectedTotal: await totalAt(id, to), payments: [{ method: 'cash', amount: await totalAt(id, to) }] },
    { actor: clerkActor(), at: to },
  );
  expect(p.status).toBe('completed');
  return id;
}
async function totalAt(visitId: number, at: Date) {
  const r = await preview(ctx.owner, [visitId], at);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.totalAmount as number;
}

beforeAll(async () => {
  ctx = await setup();
  dutyId = await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty2', displayName: '另一位值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'B', from: 1, to: 80, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('补录纸质单：接待、挂账、结账按实际时间', () => {
  it('值班经理补录一整张纸质单：单据时间与营业日按实际时间，门票按实际在店时长，收款记到补录人当前的班次', async () => {
    const shift = (await api(ctx.app, duty, 'POST', '/api/shifts', { openingCash: 0 })).body as { id: number };
    // 同一个基准时刻推算，在店时长正好 13 小时
    const base = Date.now();
    const inAt = new Date(base - 30 * H);
    const r = await enter(duty, 'B001', { backfill: slip(inAt, 'P-0001') });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.visits[0].id as number;
    const [v] = await ctx.sql<{ checkedInAt: string; businessDate: string }[]>`SELECT checked_in_at, business_date FROM visits WHERE id = ${id}`;
    expect(ms(v!.checkedInAt)).toBe(inAt.getTime());
    expect(v!.businessDate).toBe(dateOf(inAt));

    // 挂账：实际时间早于接待拒绝；按实际时间登记
    expect((await charge(duty, id, 3000, { backfill: slip(ago(31), 'P-0001') })).body.error.code).toBe('BACKFILL_ORDER');
    const lineAt = new Date(base - 25 * H);
    const c = await charge(duty, id, 3000, { backfill: slip(lineAt, 'P-0001') });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const line = c.body.lines.at(-1);
    expect(new Date(line.postedAt).getTime()).toBe(lineAt.getTime());
    expect(line.businessDate).toBe(dateOf(lineAt));
    expect(line.backfill).toMatchObject({ slipNo: 'P-0001', actualAt: lineAt.toISOString(), enteredByName: '值班经理' });

    // 结账前核对按实际离店时间计价：在店 13 小时是 24 小时档（59900），按现在算是 30 小时（109800）
    const outAt = new Date(base - 17 * H);
    expect((await preview(duty, [id])).body.totalAmount).toBe(109800 + 3000);
    expect((await preview(duty, [id], outAt)).body.totalAmount).toBe(59900 + 3000);
    expect((await preview(ctx.clerk, [id], outAt)).status).toBe(403);
    // 结账时间早于最后一项挂账拒绝；储值不能用
    expect((await pay(duty, [id], 59900 + 3000, [{ method: 'cash', amount: 62900 }], { backfill: slip(ago(26), 'P-0001') })).body.error.code).toBe('BACKFILL_ORDER');
    const m = await createMember(ctx, '补录储值', '19900009001');
    const wallet = await pay(duty, [id], 62900, [{ method: 'wallet', memberId: m.id, amount: 62900, expectedSplit: { principal: 62900, bonus: 0 } }], {
      backfill: slip(outAt, 'P-0001'),
    });
    expect(wallet.status).toBe(422);
    expect(wallet.body.error.code).toBe('BACKFILL_NO_WALLET');

    const done = await pay(duty, [id], 62900, [{ method: 'cash', amount: 62900 }], { backfill: slip(outAt, 'P-0001') });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.backfill).toMatchObject({ slipNo: 'P-0001', actualAt: outAt.toISOString(), enteredByName: '值班经理' });
    expect(done.body.bills[0]).toMatchObject({ stayMinutes: 13 * 60, ticketSegments: 2, ticketAmount: 59900 });
    const [k] = await ctx.sql<{ createdAt: string; businessDate: string; shiftId: number }[]>`
      SELECT created_at, business_date, shift_id FROM checkouts WHERE id = ${done.body.id}`;
    expect(ms(k!.createdAt)).toBe(outAt.getTime());
    expect(k!.businessDate).toBe(dateOf(outAt));
    expect(k!.shiftId).toBe(shift.id);
    const [closed] = await ctx.sql<{ closedAt: string; status: string }[]>`SELECT closed_at, status FROM visits WHERE id = ${id}`;
    expect(closed).toMatchObject({ status: 'settled' });
    expect(ms(closed!.closedAt)).toBe(outAt.getTime());
    // 结账记录列出纸质单号；交班表把这笔现金算进补录人的班次
    const list = (await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts?date=${dateOf(outAt)}`)).body as { id: number; backfillSlipNo: string | null }[];
    expect(list.find((x) => x.id === done.body.id)!.backfillSlipNo).toBe('P-0001');
    const cur = (await api(ctx.app, duty, 'GET', '/api/shifts/current')).body.shift;
    expect(cur.summary.cash.expected).toBe(62900);

    // 来访详情：接待带补录标记，历史写明补录
    const detail = (await api(ctx.app, duty, 'GET', `/api/frontdesk/visits/${id}`)).body;
    expect(detail.backfill).toMatchObject({ slipNo: 'P-0001', actualAt: inAt.toISOString(), enteredByName: '值班经理' });
    expect(detail.history[0].text).toContain('补录 · 纸质单 P-0001');
    // 补录记录：三步各一条，只追加
    const rows = await ctx.sql<{ kind: string; slipNo: string; enteredBy: number }[]>`
      SELECT kind, slip_no, entered_by FROM backfill_entries WHERE slip_no = 'P-0001' ORDER BY id`;
    expect(rows.map((x) => x.kind)).toEqual(['checkin', 'charges', 'checkout']);
    expect(rows.every((x) => x.enteredBy === dutyId)).toBe(true);
    await expect(ctx.sql`UPDATE backfill_entries SET slip_no = 'X' WHERE slip_no = 'P-0001'`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM backfill_entries WHERE slip_no = 'P-0001'`).rejects.toThrow();
  });

  it('店员不能补录；实际时间不能晚于现在、不能早于 48 小时；纸质单号格式不对拒绝', async () => {
    const r = await enter(ctx.clerk, 'B010', { backfill: slip(ago(2)) });
    expect(r.status).toBe(403);
    expect((await enter(duty, 'B010', { backfill: slip(new Date(Date.now() + 10 * 60_000)) })).body.error.code).toBe('BACKFILL_FUTURE');
    expect((await enter(duty, 'B010', { backfill: slip(ago(49)) })).body.error.code).toBe('BACKFILL_WINDOW');
    expect((await enter(duty, 'B010', { backfill: { slipNo: '纸质 1', at: ago(2).toISOString() } })).status).toBe(400);
    expect((await enter(duty, 'B010', { backfill: { slipNo: 'P1', at: '昨天下午' } })).status).toBe(400);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = 'B010'`;
    expect(n!.n).toBe(0);
    // 不带补录信息照常按此刻办理（null 与不带一样）
    expect((await enter(ctx.clerk, 'B010', { backfill: null })).status).toBe(201);
  });

  it('同一操作编号重提：内容相同只办理一次；补录信息不同按不同请求拒绝', async () => {
    const body = { clientKey: randomUUID(), guests: [{ tagCode: 'B011', zone: 'male' }], backfill: slip(ago(3), 'P-0011') };
    const first = await api(ctx.app, duty, 'POST', '/api/frontdesk/checkins', body);
    expect(first.status).toBe(201);
    const again = await api(ctx.app, duty, 'POST', '/api/frontdesk/checkins', body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const other = await api(ctx.app, duty, 'POST', '/api/frontdesk/checkins', { ...body, backfill: slip(ago(3), 'P-0012') });
    expect(other.status).toBe(409);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM backfill_entries WHERE slip_no IN ('P-0011', 'P-0012')`;
    expect(n!.n).toBe(1);
  });

  it('实际时间那一刻手牌或会员已被别的来访占用：拒绝；那位客人离店之后的时间可以补录', async () => {
    await pastVisit('B020', ago(10), ago(8));
    const busy = await enter(duty, 'B020', { backfill: slip(ago(9), 'P-0020') });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('BACKFILL_TAG_BUSY');
    expect(busy.body.error.message).toContain('B020');
    expect((await enter(duty, 'B020', { backfill: slip(ago(7), 'P-0020') })).status).toBe(201);

    const m = await createMember(ctx, '补录会员', '19900009002');
    await pastVisit('B021', ago(10), ago(8), m.id);
    const member = await enter(duty, 'B022', { backfill: slip(ago(9), 'P-0021') }, { memberId: m.id });
    expect(member.body.error.code).toBe('BACKFILL_MEMBER_BUSY');
    expect((await enter(duty, 'B022', { backfill: slip(ago(7.5), 'P-0021') }, { memberId: m.id })).status).toBe(201);
  });

  it('手牌在补录之前已发给别人又还回：补录接待可以，但结账要按纸质单补录到那之前', async () => {
    await pastVisit('B030', ago(3), ago(2));
    const r = await enter(duty, 'B030', { backfill: slip(ago(6), 'P-0030') });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.visits[0].id as number;
    // 按现在结账（平时的结账、结账前核对）都拒绝：这位客人应在 3 小时前之前离店
    const pv = await preview(duty, [id]);
    expect(pv.status).toBe(409);
    expect(pv.body.error.code).toBe('BACKFILL_TAG_REUSED');
    expect((await pay(duty, [id], 49900, [{ method: 'cash', amount: 49900 }])).body.error.code).toBe('BACKFILL_TAG_REUSED');
    expect((await pay(duty, [id], 49900, [{ method: 'cash', amount: 49900 }], { backfill: slip(ago(2.5), 'P-0030') })).body.error.code).toBe('BACKFILL_TAG_REUSED');
    const ok = await pay(duty, [id], 49900, [{ method: 'cash', amount: 49900 }], { backfill: slip(ago(4), 'P-0030') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('补录的客人换牌不能绕过手牌重发：换牌拒绝；绕过换牌留下的旧牌时段，结账逐段核对、自检查得出（Codex 复测 P1）', async () => {
    // B070 在 3 小时前到 2 小时前给甲用过；补录乙 6 小时前用 B070
    await pastVisit('B070', ago(3), ago(2));
    const r = await enter(duty, 'B070', { backfill: slip(ago(6), 'P-0070') });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.visits[0].id as number;
    expect((await preview(duty, [id])).body.error.code).toBe('BACKFILL_TAG_REUSED');
    // 换牌：拒绝，要先按纸质单补录结账时间
    const swap = await api(ctx.app, duty, 'POST', `/api/frontdesk/visits/${id}/swap`, { clientKey: randomUUID(), toTagCode: 'B071', reason: '测试换牌' });
    expect(swap.status).toBe(409);
    expect(swap.body.error.code).toBe('BACKFILL_TAG_REUSED');
    expect((await periodsCheck()).ok).toBe(true);

    // 不经换牌接口（直接改库）留下一条换牌记录：乙在 B070 上的时段是 6 小时前到现在，与甲重叠
    const [b070, b071] = await ctx.sql<{ id: number }[]>`SELECT id FROM hand_tags WHERE code IN ('B070', 'B071') ORDER BY code`;
    await ctx.sql`UPDATE visits SET tag_id = ${b071!.id} WHERE id = ${id}`;
    await ctx.sql`
      INSERT INTO visit_tag_changes (visit_id, from_tag_id, to_tag_id, reason, old_tag_locked, operator_id)
      VALUES (${id}, ${b070!.id}, ${b071!.id}, '测试绕过', false, ${dutyId})`;
    const bad = await periodsCheck();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('手牌 B070');
    // 平时结账、结账前核对：核对换走的 B070 那一段，拒绝
    expect((await preview(duty, [id])).body.error.code).toBe('BACKFILL_TAG_REUSED');
    expect((await pay(duty, [id], 49900, [{ method: 'cash', amount: 49900 }])).body.error.code).toBe('BACKFILL_TAG_REUSED');
    // 按纸质单补录到甲之前离店：B070 那一段截到 4 小时前，换牌之后的 B071 不算；自检恢复一致
    const ok = await pay(duty, [id], 49900, [{ method: 'cash', amount: 49900 }], { backfill: slip(ago(4), 'P-0070') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await periodsCheck()).ok).toBe(true);
  });

  it('补录的客人在手牌重发之前就换了牌：每段都不重叠，平时结账照常', async () => {
    const r = await enter(duty, 'B072', { backfill: slip(ago(6), 'P-0072') });
    const id = r.body.visits[0].id as number;
    // 5 小时前换到 B073（按当时的时间办理），之后 B072 在 3 小时前到 2 小时前给别人用过
    await swapTag(deps(), id, { clientKey: randomUUID(), toTagCode: 'B073', reason: '柜锁坏了' }, { actor: dutyActor(), at: ago(5) });
    await pastVisit('B072', ago(3), ago(2));
    const pv = await preview(duty, [id]);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect((await pay(duty, [id], pv.body.totalAmount, [{ method: 'cash', amount: pv.body.totalAmount }])).status).toBe(200);
    expect((await periodsCheck()).ok).toBe(true);
  });

  it('补录进已确认的营业日：只补录接待与挂账也提示「有变动」，重新确认后修订号 +1（Codex 复测 P2）', async () => {
    const at = ago(30);
    const date = dateOf(at);
    const closed = await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${date}/close`, { note: '测试确认' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.closed).toMatchObject({ changedSinceClose: false });
    const revision = closed.body.closed.revision as number;
    const r = await enter(duty, 'B074', { backfill: slip(at, 'P-0074') });
    expect(r.status).toBe(201);
    const id = r.body.visits[0].id as number;
    expect((await charge(duty, id, 1200, { backfill: slip(new Date(at.getTime() + 600_000), 'P-0074') })).status).toBe(200);
    const s = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect(s.backfill.count).toBeGreaterThanOrEqual(2);
    expect(s.closed).toMatchObject({ changedSinceClose: true, revision });
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${date}/close`, { note: '补录后重新确认' });
    expect(again.body.closed).toMatchObject({ changedSinceClose: false, revision: revision + 1 });
  });

  it('日结异常清单列出「补录」；前台自检核对补录记录与单据一致', async () => {
    const at = ago(1);
    const r = await enter(duty, 'B040', { backfill: slip(at, 'P-0040') });
    expect(r.status).toBe(201);
    const s = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${dateOf(at)}`)).body;
    const a = s.anomalies.find((x: { kind: string; description: string }) => x.kind === 'backfill' && x.description.includes('P-0040'));
    expect(a).toMatchObject({ kind: 'backfill', docNo: r.body.visits[0].visitNo, at: at.toISOString() });
    expect(a.description).toContain('补录接待（手牌 B040）');
    expect(a.description).toContain('值班经理在实际时间后');
    const csv = await api<string>(ctx.app, ctx.owner, 'GET', `/api/settlements/${dateOf(at)}/export`);
    expect(csv.status).toBe(200);
    expect(csv.body).toContain('补录');

    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[];
    const bf = checks.find((c) => c.key === 'backfill_entries')!;
    expect(bf.ok, bf.detail).toBe(true);
    // 改坏一条（绕过只追加保护）：自检报不一致，指出纸质单号；改回后恢复一致
    await ctx.sql`ALTER TABLE backfill_entries DISABLE TRIGGER backfill_entries_append_only`;
    try {
      await ctx.sql`UPDATE backfill_entries SET actual_at = actual_at - interval '1 hour' WHERE slip_no = 'P-0040'`;
      const bad = ((await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[]).find(
        (c) => c.key === 'backfill_entries',
      )!;
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain('P-0040');
      await ctx.sql`UPDATE backfill_entries SET actual_at = actual_at + interval '1 hour' WHERE slip_no = 'P-0040'`;
    } finally {
      await ctx.sql`ALTER TABLE backfill_entries ENABLE TRIGGER backfill_entries_append_only`;
    }
  });
});

describe('R1.2-b 优惠 / 免单不能由收银的本人授权', () => {
  const authorize = (cookie: string, approver: string, purpose: string, scope: unknown) =>
    api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: approver, password: PASSWORD, purpose, scope });

  it('值班经理自己收银：不能用自己的账号授权优惠，另一位值班经理可以；店主本人可以；降档 / 免票仍可自己授权', async () => {
    const v = (await enter(duty, 'B050')).body.visits[0].id as number;
    const self = await authorize(duty, 'duty', 'checkout_discount', { visitIds: [v], amount: 2100, reason: '抹零' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('AUTH_SELF_NOT_ALLOWED');
    const other = await authorize(duty, 'duty2', 'checkout_discount', { visitIds: [v], amount: 2100, reason: '抹零' });
    expect(other.status).toBe(200);
    expect((await pay(duty, [v], 49900, [{ method: 'discount', amount: 2100, grantId: other.body.grantId }, { method: 'cash', amount: 47800 }])).status).toBe(200);

    const v2 = (await enter(ctx.owner, 'B051')).body.visits[0].id as number;
    const owner = await authorize(ctx.owner, 'owner', 'checkout_discount', { visitIds: [v2], amount: 49900, reason: '店主请客' });
    expect(owner.status).toBe(200);

    const types = (await api(ctx.app, duty, 'GET', '/api/frontdesk/ticket-types')).body as { id: number; name: string }[];
    const child = types.find((t) => t.name.startsWith('儿童免票'))!;
    const ticket = await authorize(duty, 'duty', 'ticket_discount', { items: [{ tagCode: 'B052', ticketTypeId: child.id }], reason: '1 米以下儿童' });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
  });

  it('升级前签发的本人授权（数据库里已有）核销时同样拒绝', async () => {
    const v = (await enter(duty, 'B053')).body.visits[0].id as number;
    const [g] = await ctx.sql<{ id: string }[]>`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, expires_at)
      VALUES ('checkout_discount', ${dutyId}, ${dutyId}, ${ctx.sql.json({ visitIds: [v], amount: 2100, reason: '抹零' })}, now() + interval '5 minutes')
      RETURNING id`;
    const r = await pay(duty, [v], 49900, [{ method: 'discount', amount: 2100, grantId: g!.id }, { method: 'cash', amount: 47800 }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GRANT_INVALID');
  });
});
