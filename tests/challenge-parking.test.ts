// v0.7.28 ⑧（docs/SCHEDULE_FINISH.md 第 9 节，N9、N10）：会员挑战（QY-057）与停车优惠（QY-016）。全部是合成数据。
//   · 导入本店权益清单：QY-016 是服务类的停车优惠（草稿）、QY-057 是事件礼「每月到店满几次」（暂缓）；
//   · 会员挑战：没填满几次不能发布；到店按有结账的营业日算、一天算一次，满了每月每人送一次，同一个月不再送；
//   · 停车优惠：没填免费几小时不能发布；登记要车牌与几小时，超过这位会员能免的拒绝；每个营业日一次，作废后可以再登记；
//     停车登记按营业日列出、导出给停车场对账；不是停车优惠的项不能填车牌。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Benefit, BenefitCatalog, MemberBenefits, ParkingUseRow } from '../src/shared/benefits';
import type { CouponTemplate } from '../src/shared/coupons';
import { businessDateOf } from '../src/shared/business-date';
import type { Actor } from '../src/server/lib/context';
import { monthVisitDays, runVisitChallenges } from '../src/server/modules/benefits';
import { checkout, previewCheckout } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { api, createMember, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;

const catalog = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/benefits')).body as BenefitCatalog;
const byCode = async (code: string) => (await catalog()).items.find((b) => b.code === code)!;
const edit = async (code: string, patch: Partial<Benefit>) => {
  const b = await byCode(code);
  const { version, name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, visitTarget, parking, parkingHours, parkingHoursByTier, content, conditions } = b;
  return api(ctx.app, ctx.owner, 'PUT', `/api/benefits/${b.id}`, {
    expectedVersion: version,
    ...{ name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, visitTarget, parking, parkingHours, parkingHoursByTier, content, conditions },
    ...patch,
  });
};
const setStatus = async (code: string, status: 'published' | 'paused') => {
  const b = await byCode(code);
  return api(ctx.app, ctx.owner, 'POST', `/api/benefits/${b.id}/status`, { expectedVersion: b.version, status });
};
const benefitsOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/benefits`)).body as MemberBenefits;
const park = (memberId: number, benefitId: number, body: Record<string, unknown>, key = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/members/${memberId}/benefit-uses`, { clientKey: key, benefitId, quantity: 1, note: '', ...body });

const H = 3_600_000;
const clerkActor = (): Actor => ({ id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false });
const deps = () => ({ sql: ctx.sql, config: ctx.config });
const dateOf = (at: Date) => businessDateOf(at, ctx.config.timezone, 6);

/** 这位会员在 from 接待、to 结账（现金，与 tests/backfill.test.ts 一样按实际时刻），返回结账单编号 */
async function pastVisit(memberId: number, tagCode: string, from: Date, to: Date): Promise<number> {
  const r = await checkin(deps(), { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', memberId }] }, { actor: clerkActor(), at: from });
  const id = r.visits[0]!.id;
  // 按结账那一刻的价（模块里算，不受前台补录 48 小时的限制）
  const total = (await previewCheckout(deps(), [id], to)).totalAmount;
  const c = await checkout(deps(), { clientKey: randomUUID(), visitIds: [id], expectedTotal: total, payments: [{ method: 'cash', amount: total }] }, { actor: clerkActor(), at: to });
  expect(c.status).toBe('completed');
  return c.id;
}

beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'H', from: 1, to: 9, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('导入的两项', () => {
  it('QY-016 是服务类的停车优惠（草稿，每天一次）；QY-057 是事件礼「每月到店满几次」（暂缓）', async () => {
    expect(await byCode('QY-016')).toMatchObject({ category: 'service', parking: true, period: 'day', quantity: 1, parkingHours: null, status: 'draft' });
    expect(await byCode('QY-057')).toMatchObject({ category: 'event', events: ['monthly_visits'], visitTarget: null, status: 'paused' });
  });
});

describe('会员挑战（QY-057）', () => {
  it('没填满几次、没选券不能发布；满了每月每人送一次，同一天来几次算一天', async () => {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '挑战礼 50 元', kind: 'cash', faceValue: 5000, validity: 'days', validDays: 30 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const tpl = t.body as CouponTemplate;
    expect((await edit('QY-057', { startGrade: 0, startTier: null, templateId: tpl.id })).status).toBe(200);
    const blocked = await setStatus('QY-057', 'published');
    expect(blocked.body.error.code).toBe('BENEFIT_NOT_PUBLISHABLE');
    expect(blocked.body.error.message).toContain('每月到店满几次');
    expect((await edit('QY-057', { visitTarget: 1 })).status).toBe(400);
    expect((await edit('QY-057', { visitTarget: 2 })).status).toBe(200);
    expect((await setStatus('QY-057', 'published')).status).toBe(200);

    // 两位会员：甲在上个月 20 日、21 日各结一次账，乙只来过 20 日（同一天来两次也只算一天）
    const [y, m] = today.split('-').map(Number) as [number, number];
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const day1 = new Date(`${prev}-20T12:00:00+08:00`);
    const day2 = new Date(`${prev}-21T12:00:00+08:00`);
    const a = await createMember(ctx, '挑战甲', '19911110001');
    const b = await createMember(ctx, '挑战乙', '19911110002');
    await pastVisit(a.id, 'H001', day1, new Date(day1.getTime() + H));
    await pastVisit(a.id, 'H002', day2, new Date(day2.getTime() + H));
    await pastVisit(b.id, 'H003', day1, new Date(day1.getTime() + H));
    await pastVisit(b.id, 'H004', new Date(day1.getTime() + 2 * H), new Date(day1.getTime() + 3 * H));
    const at = new Date(day2.getTime() + 2 * H);
    const date = dateOf(at);
    expect(await monthVisitDays(ctx.sql, a.id, date)).toBe(2);
    expect(await monthVisitDays(ctx.sql, b.id, date)).toBe(1);
    expect(await runVisitChallenges(ctx, at)).toEqual({ members: 1, coupons: 1 });
    // 同一个月不再送
    expect(await runVisitChallenges(ctx, at)).toEqual({ members: 0, coupons: 0 });
    const grants = await ctx.sql<{ memberId: number; eventKey: string }[]>`
      SELECT g.member_id, g.event_key FROM benefit_grants g JOIN benefits bb ON bb.id = g.benefit_id WHERE bb.code = 'QY-057'`;
    expect(grants.map((g) => [Number(g.memberId), g.eventKey])).toEqual([[a.id, `visits:${date.slice(0, 7)}`]]);
    // 本月可享里看得到满几天送
    expect((await benefitsOf(a.id)).items.find((i) => i.code === 'QY-057')?.visits).toMatchObject({ target: 2 });
  });
});

describe('停车优惠（QY-016）', () => {
  it('没填免费几小时不能发布；登记要车牌，不超过能免的；每个营业日一次，作废后可以再登记；停车登记与导出', async () => {
    expect((await setStatus('QY-016', 'published')).body.error.code).toBe('BENEFIT_NOT_PUBLISHABLE');
    expect((await edit('QY-016', { startGrade: 0, startTier: null, parkingHours: 25 })).status).toBe(400);
    expect((await edit('QY-016', { startGrade: 0, startTier: null, parkingHours: 2, parkingHoursByTier: [{ grade: 3, tier: 0, quantity: 4 }] })).status).toBe(200);
    expect((await setStatus('QY-016', 'published')).status).toBe(200);
    const parking = await byCode('QY-016');
    expect(parking).toMatchObject({ parkingHours: 2, parkingHoursByTier: [{ grade: 3, tier: 0, quantity: 4 }], quantity: 1, period: 'day' });

    const m = await createMember(ctx, '停车会员', '19911110003');
    const item = (await benefitsOf(m.id)).items.find((i) => i.code === 'QY-016')!;
    expect(item).toMatchObject({ category: 'service', parking: { hours: 2, usedToday: false } });
    // 车牌、几小时
    expect((await park(m.id, parking.id, {})).status).toBe(400);
    expect((await park(m.id, parking.id, { plate: '粤B 12345', hours: 3 })).body.error.code).toBe('PARKING_HOURS');
    expect((await park(m.id, parking.id, { plate: '!', hours: 1 })).status).toBe(400);
    const ok = await park(m.id, parking.id, { plate: '粤b 12345', hours: 2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.use).toMatchObject({ plate: '粤B12345', hours: 2, quantity: 1 });
    // 每个营业日一次
    expect((await park(m.id, parking.id, { plate: '粤B12345', hours: 1 })).body.error.code).toBe('BENEFIT_LIMIT');
    expect((await benefitsOf(m.id)).items.find((i) => i.code === 'QY-016')?.parking).toMatchObject({ usedToday: true });
    // 作废后可以再登记
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/benefit-uses/${ok.body.use.id}/void`, { reason: '车牌登错了' })).body.status).toBe('voided');
    expect((await park(m.id, parking.id, { plate: '粤B54321', hours: 1 })).status).toBe(201);
    // 停车登记：按营业日列出（作废的也列，标作废）、导出
    const rows = (await api(ctx.app, ctx.clerk, 'GET', `/api/benefits/parking?from=${today}&to=${today}`)).body as ParkingUseRow[];
    expect(rows.map((r) => [r.plate, r.hours, r.status])).toEqual([
      ['粤B12345', 2, 'voided'],
      ['粤B54321', 1, 'active'],
    ]);
    const csv = await api(ctx.app, ctx.owner, 'GET', `/api/benefits/parking/export?from=${today}&to=${today}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('粤B54321');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/benefits/parking?from=${today}&to=2099-01-01`)).status).toBe(400);
    // 不是停车优惠的项不能填车牌
    const other = (await catalog()).items.find((b) => b.category === 'service' && !b.parking)!;
    expect((await edit(other.code, { startGrade: 0, startTier: null, period: 'none', quantity: null })).status).toBe(200);
    expect((await setStatus(other.code, 'published')).status).toBe(200);
    expect((await park(m.id, other.id, { plate: '粤B11111', hours: 1 })).status).toBe(400);
  });
});
