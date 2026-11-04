// v0.7.28 ②（docs/SCHEDULE_FINISH.md 第 3 节，N2、N3）：派对房等「开单即占用」的计费——
//   · 后台按业态设计费：房费项目（价格是每小时多少）、起步时长、计费单位、开台费项目；项目要启用、不能是技师项目；
//   · 结束使用时按时长挂房费（按计费单位记数量）与开台费，挂到使用人的手牌账单上，部门按项目的分类；重提不重复挂；
//   · 撤单、撤销来访不收；没设计费的业态与 v0.7.19 一样；
//   · 使用人结账前要先结束（USAGE_UNCHARGED），结账预览里有到此刻的估算；
//   · 会员的包房房费折扣（QY-011）：派对房的房费只在营业日是周一至周四时打（M44）。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discountLines } from '../src/shared/benefits';
import type { CouponLine } from '../src/shared/coupons';
import type { FloorMapData } from '../src/shared/floormap';
import { chargedUsageMinutes, usageFee, type UsageDetail, type UsageRules } from '../src/shared/usages';
import type { Deps, OpContext } from '../src/server/lib/context';
import { couponLines } from '../src/server/modules/coupon-checkout';
import { previewCheckout } from '../src/server/modules/frontdesk/checkout';
import { frontdeskChecks } from '../src/server/modules/frontdesk/checks';
import { endUsage } from '../src/server/modules/usages';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;
let tagNo = 0;
const item: Record<string, number> = {};

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L2,合成娱乐区,Sample Fun,合成样例'].join('\r\n');
const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L2,X,X301,派对房,12,合成派对房,,合成派对房 X301,',
  'L2,X,X302,派对房,12,合成派对房二,,合成派对房 X302,',
  'L2,X,X303,娱乐室,6,合成娱乐室,,合成娱乐室 X303,',
].join('\r\n');

const enter = async () => {
  tagNo += 1;
  const code = `V${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const visitId = r.body.visits[0].id as number;
  const [v] = await ctx.sql<{ billId: number }[]>`SELECT bill_id FROM visits WHERE id = ${visitId}`;
  return { visitId, tagCode: code, billId: Number(v!.billId) };
};
const sid: Record<string, number> = {};
const open = async (space: string, tagCode: string) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sid[space], tagCode, guests: 4 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as UsageDetail;
};
const end = (id: number, clientKey = randomUUID()) => api(ctx.app, ctx.clerk, 'POST', `/api/usages/${id}/end`, { clientKey });
const rules = (body: Partial<UsageRules>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', '宠物轰趴房', '娱乐室'], ...body });
const preview = async (visitId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
const pay = async (visitId: number) => {
  const p = await preview(visitId);
  return api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: p.totalAmount,
    payments: p.totalAmount > 0 ? [{ method: 'cash', amount: p.totalAmount }] : [],
  });
};
const actor = () => ({ id: ctx.clerkId, username: 'clerk', displayName: '店员', role: 'clerk' as const, duties: [], mustChangePassword: false });
/** 开单之后过了 minutes 分钟结束（用操作时刻合成「用了多久」；前台页面按此刻） */
const endAfter = (u: UsageDetail, minutes: number, clientKey = randomUUID()) =>
  endUsage(deps, u.id, { clientKey }, { actor: actor(), at: new Date(new Date(u.openedAt).getTime() + minutes * 60_000) } satisfies OpContext);
const linesOf = (billId: number) =>
  ctx.sql<{ name: string; quantity: number; unitPrice: number; amount: number; source: string; category: string }[]>`
    SELECT l.name, l.quantity, l.unit_price, l.amount, l.source, si.category FROM bill_lines l LEFT JOIN service_items si ON si.id = l.item_id
    WHERE l.bill_id = ${billId} AND l.status = 'active' ORDER BY l.id`;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  for (const s of (await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]) sid[s.code] = s.id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'V', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['派对房房费', '派对房', 30000],
    ['派对房开台费', '派对房', 5000],
    ['停用的房费', '派对房', 10000],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
});
afterAll(async () => ctx?.close());

describe('计费的算法（共用的纯函数）', () => {
  it('起步以内按起步；之后按计费单位向上取整；房费按单位记数量', () => {
    const p = { minMinutes: 60, stepMinutes: 30 };
    expect([0, 59, 60, 61, 90, 91, 150].map((m) => chargedUsageMinutes(m, p))).toEqual([60, 60, 60, 90, 90, 120, 150]);
    expect(usageFee(91, p, 30000)).toEqual({ chargedMinutes: 120, steps: 4, unitPrice: 15000, amount: 60000 });
    // 起步不是单位的整数倍：起步按向上取整的单位数
    expect(usageFee(10, { minMinutes: 45, stepMinutes: 30 }, 30000)).toEqual({ chargedMinutes: 60, steps: 2, unitPrice: 15000, amount: 30000 });
    // 包房房费折扣：客房房费 + 周一至周四的派对房房费
    const lines = [
      { id: 1, category: '客房', amount: 100, usageCharge: null },
      { id: 2, category: '派对房', amount: 200, partyRoomDay: true },
      { id: 3, category: '派对房', amount: 300, partyRoomDay: false },
      { id: 4, category: '门票', amount: 400, usageCharge: null },
      // 使用单的费用只看「房费、周一至周四」，与价目分类无关：分类选了「客房」的周五房费、开台费都不打（测试会话 18d4344 的 P2）
      { id: 5, category: '客房', amount: 500, usageCharge: 'fee', partyRoomDay: false },
      { id: 6, category: '客房', amount: 600, usageCharge: 'open_fee', partyRoomDay: false },
      { id: 7, category: '派对房', amount: 700, usageCharge: 'fee', partyRoomDay: true },
    ] as unknown as CouponLine[];
    expect(discountLines('room', lines).map((l) => l.id)).toEqual([1, 2, 7]);
    expect(discountLines('ticket', lines).map((l) => l.id)).toEqual([4]);
  });
});

describe('后台设计费', () => {
  it('房费项目要启用、不能是技师项目；只能给开单即占用的业态设；只改业态时保留计费；去掉业态时计费一起去掉', async () => {
    expect((await rules({ pricing: { 派对房: { feeItemId: 999999, minMinutes: 60, stepMinutes: 30, openFeeItemId: null } } })).body.error.code).toBe('USAGE_PRICE_ITEM');
    expect((await rules({ pricing: { 客房: { feeItemId: item['派对房房费']!, minMinutes: 60, stepMinutes: 30, openFeeItemId: null } } })).status).toBe(400);
    expect((await rules({ pricing: { 派对房: { feeItemId: item['派对房房费']!, minMinutes: 60, stepMinutes: 25, openFeeItemId: null } } })).status).toBe(400);
    const ok = await rules({ pricing: { 派对房: { feeItemId: item['派对房房费']!, minMinutes: 60, stepMinutes: 30, openFeeItemId: item['派对房开台费']! } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.pricing['派对房']).toEqual({ feeItemId: item['派对房房费'], minMinutes: 60, stepMinutes: 30, openFeeItemId: item['派对房开台费'] });
    // 只改业态（旧页面）：计费保留
    const kept = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', '娱乐室'] });
    expect(kept.body.pricing['派对房']).toBeTruthy();
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房'] })).status).toBe(403);
    // 平面图带上计费（页面估算用）
    const m = (await api(ctx.app, ctx.clerk, 'GET', '/api/floormap')).body as FloorMapData;
    expect(m.usageTypes).toEqual(['派对房', '娱乐室']);
  });
});

describe('结束使用时挂房费', () => {
  it('按时长挂房费（数量 = 计费单位个数）与开台费；部门是项目的分类；重提不重复挂；使用单记下房费', async () => {
    const g = await enter();
    const u = await open('X301', g.tagCode);
    expect(u).toMatchObject({ priced: true, fee: null, pricing: { itemName: '派对房房费', hourPrice: 30000, minMinutes: 60, stepMinutes: 30, openFee: 5000 } });
    // 用了 95 分钟：起步 60 + 2 个 30 分钟 = 120 分钟
    const key = randomUUID();
    const r = await endAfter(u, 95, key);
    expect(r).toMatchObject({ status: 'closed', priced: true, fee: { amount: 60000, chargedMinutes: 120, openFee: 5000 } });
    expect(await linesOf(g.billId)).toEqual([
      { name: '派对房房费（每 30 分钟）', quantity: 4, unitPrice: 15000, amount: 60000, source: 'other', category: '派对房' },
      { name: '派对房开台费', quantity: 1, unitPrice: 5000, amount: 5000, source: 'other', category: '派对房' },
    ]);
    // 同一个操作编号重提：返回原来那张，不重复挂；结束过的再结束拒绝
    expect((await endAfter(u, 95, key)).fee).toMatchObject({ amount: 60000 });
    expect((await linesOf(g.billId)).length).toBe(2);
    expect((await end(u.id)).body.error.code).toBe('USAGE_CLOSED');
    // 结账：部门营业额按项目的分类
    expect((await pay(g.visitId)).status).toBe(200);
    const [dept] = await ctx.sql<{ category: string; amount: number }[]>`
      SELECT ci.category, sum(ci.amount)::int AS amount FROM checkout_items ci JOIN checkout_bills cb ON cb.checkout_id = ci.checkout_id
      WHERE cb.bill_id = ${g.billId} GROUP BY ci.category`;
    expect(dept).toEqual({ category: '派对房', amount: 65000 });
    expect((await frontdeskChecks(ctx.sql)).every((c) => c.ok)).toBe(true);
  });

  it('使用人结账前要先结束：预览里有到此刻的估算；没结束直接结账拒绝（USAGE_UNCHARGED），什么都不改', async () => {
    const g = await enter();
    const u = await open('X302', g.tagCode);
    const p = await previewCheckout(deps, [g.visitId], new Date(new Date(u.openedAt).getTime() + 75 * 60_000));
    expect(p.usages).toEqual([expect.objectContaining({ usageId: u.id, spaceCode: 'X302', priced: true, minutes: 75, estimate: 45000 + 5000 })]);
    const r = await pay(g.visitId);
    expect(r.body.error.code).toBe('USAGE_UNCHARGED');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${u.id}`)).body.status).toBe('open');
    expect((await end(u.id)).body.fee).toMatchObject({ amount: 30000, chargedMinutes: 60, openFee: 5000 });
    expect((await pay(g.visitId)).status).toBe(200);
  });

  it('撤单、撤销来访不收；没设计费的业态照旧（结账时自动结束、不挂房费）', async () => {
    const a = await enter();
    const ua = await open('X301', a.tagCode);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/usages/${ua.id}/cancel`, { clientKey: randomUUID(), reason: '开错了房间' })).body).toMatchObject({ status: 'cancelled', fee: null });
    expect(await linesOf(a.billId)).toEqual([]);
    const b = await enter();
    const ub = await open('X303', b.tagCode);
    expect(ub.priced).toBe(false);
    expect((await pay(b.visitId)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${ub.id}`)).body).toMatchObject({ status: 'closed', closeKind: 'checkout', fee: null });
    // 撤销来访：使用单直接结束、不收
    const c = await enter();
    const uc = await open('X301', c.tagCode);
    const cancelled = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/visits/${c.visitId}/cancel`, { clientKey: randomUUID(), reason: '合成：客人没进店' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${uc.id}`)).body).toMatchObject({ status: 'closed', closeKind: 'visit_cancel', fee: null });
  });

  it('房费项目停用了：结束时拒绝（USAGE_PRICE_ITEM），使用单还开着；改回来能结束', async () => {
    expect((await rules({ businessTypes: ['派对房', '娱乐室'], pricing: { 派对房: { feeItemId: item['停用的房费']!, minMinutes: 60, stepMinutes: 30, openFeeItemId: null } } })).status).toBe(200);
    const off = await api(ctx.app, ctx.owner, 'PUT', `/api/items/${item['停用的房费']}`, { name: '停用的房费', category: '派对房', price: 10000, active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const g = await enter();
    const u = await open('X301', g.tagCode);
    expect((await end(u.id)).body.error.code).toBe('USAGE_PRICE_ITEM');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${u.id}`)).body.status).toBe('open');
    expect((await rules({ businessTypes: ['派对房', '娱乐室'], pricing: { 派对房: { feeItemId: item['派对房房费']!, minMinutes: 60, stepMinutes: 30, openFeeItemId: null } } })).status).toBe(200);
    expect((await end(u.id)).body.fee).toMatchObject({ amount: 30000, openFee: 0 });
  });
});

describe('包房房费折扣：派对房只在周一至周四（M44）', () => {
  it('房费明细按它的营业日：周一的标出来、周五的不标；开台费都不标', async () => {
    const endAt = async (when: string) => {
      const g = await enter();
      const u = await open('X302', g.tagCode);
      await endUsage(deps, u.id, { clientKey: randomUUID() }, { actor: actor(), at: new Date(when) });
      return couponLines(ctx.sql, [g.billId]);
    };
    // 营业日按北京时间 06:00 切换：2026-11-02 中午是周一、2026-11-06 中午是周五
    const monday = await endAt('2026-11-02T04:00:00Z');
    expect(monday.map((l) => [l.name, l.partyRoomDay])).toEqual([['派对房房费（每 30 分钟）', true]]);
    const friday = await endAt('2026-11-06T04:00:00Z');
    expect(friday.map((l) => [l.name, l.partyRoomDay])).toEqual([['派对房房费（每 30 分钟）', false]]);
  });

  it('房费、开台费的项目在价目里分类选了「客房」：照样只在周一至周四打房费，开台费不打（测试会话 18d4344 的 P2）', async () => {
    for (const [name, price] of [
      ['包房房费（客房分类）', 30000],
      ['包房开台费（客房分类）', 5000],
    ] as const) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '客房', price });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    }
    const saved = await rules({
      pricing: {
        派对房: { feeItemId: item['派对房房费']!, minMinutes: 60, stepMinutes: 30, openFeeItemId: null },
        娱乐室: { feeItemId: item['包房房费（客房分类）']!, minMinutes: 60, stepMinutes: 30, openFeeItemId: item['包房开台费（客房分类）']! },
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const endAt = async (when: string) => {
      const g = await enter();
      const u = await open('X303', g.tagCode);
      await endUsage(deps, u.id, { clientKey: randomUUID() }, { actor: actor(), at: new Date(when) });
      return couponLines(ctx.sql, [g.billId]);
    };
    // 2026-11-04 中午是周三、2026-11-06 中午是周五
    const wednesday = await endAt('2026-11-04T04:00:00Z');
    expect(wednesday.map((l) => [l.category, l.usageCharge, l.partyRoomDay])).toEqual([
      ['客房', 'fee', true],
      ['客房', 'open_fee', false],
    ]);
    expect(discountLines('room', wednesday).map((l) => l.usageCharge)).toEqual(['fee']);
    const friday = await endAt('2026-11-06T04:00:00Z');
    expect(friday.map((l) => l.usageCharge)).toEqual(['fee', 'open_fee']);
    expect(discountLines('room', friday)).toEqual([]);
  });
});
