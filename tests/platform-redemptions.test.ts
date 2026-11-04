// v0.7.28 ⑤（docs/SCHEDULE_FINISH.md 第 6 节，N6）：第三方平台核销补录。全部是合成数据。
//   · 补登记：已在平台 App 核销、没有结账的券；同一张券只能一笔、不能和结账里的团购券重复（两边都拦）；时间范围；重提；
//   · 作废：值班经理以上、写原因；作废后可以重新补登记；
//   · 平台打款与对账：店主、店总；补登记的应结 + 结账团购券 与 到账比对；日结单列、不算营业额；自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformReconcile } from '../src/shared/platform';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let today: string;

// 核销时刻固定一个（同一编号原样重提时请求要一模一样）
const at = new Date(Date.now() - 60_000).toISOString();
const redeem = (body: Record<string, unknown>, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/platform/redemptions', { clientKey, platform: 'meituan', dealName: '双人洗浴', faceValue: 19800, redeemedAt: at, ...body });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'P', from: 1, to: 10, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('补登记', () => {
  it('登记一笔；同一编号重提返回原来那笔；同一张券不能再登；时间、应结不对拒绝', async () => {
    const key = randomUUID();
    const r = await redeem({ code: 'mt-1234 5678', settleAmount: 16800 }, ctx.clerk, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.redemption).toMatchObject({ platform: 'meituan', code: 'MT12345678', faceValue: 19800, settleAmount: 16800, status: 'active', businessDate: today });
    expect((await redeem({ code: 'mt-1234 5678', settleAmount: 16800 }, ctx.clerk, key)).body).toMatchObject({ replayed: true, redemption: { id: r.body.redemption.id } });
    // 同一个编号、内容不同：拒绝
    expect((await redeem({ code: 'mt-1234 5678', settleAmount: 15000 }, ctx.clerk, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await redeem({ code: 'MT12345678' })).body.error.code).toBe('PLATFORM_CODE_USED');
    // 别的平台同一个号可以
    expect((await redeem({ code: 'MT12345678', platform: 'douyin' })).status).toBe(200);
    expect((await redeem({ code: 'MT00000001', redeemedAt: new Date(Date.now() + 3_600_000).toISOString() })).body.error.code).toBe('PLATFORM_TIME');
    expect((await redeem({ code: 'MT00000002', redeemedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() })).body.error.code).toBe('PLATFORM_TIME');
    expect((await redeem({ code: 'MT00000003', settleAmount: 20000 })).status).toBe(400);
  });

  it('和前台结账里的团购券互相拦：补登记过的券结账时不能再用；结账用过的券不能补登记', async () => {
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'P001', zone: 'male' }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const id = v.body.visits[0].id as number;
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body;
    const total = pre.totalAmount as number;
    const pay = (code: string) =>
      api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
        clientKey: randomUUID(),
        visitIds: [id],
        expectedTotal: total,
        payments: [{ method: 'coupon', platform: 'meituan', code, dealName: '洗浴', amount: total }],
      });
    expect((await pay('MT12345678')).body.error.code).toBe('COUPON_USED');
    const ok = await pay('MT87654321');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await redeem({ code: 'MT87654321' });
    expect(again.body.error.code).toBe('PLATFORM_CODE_USED');
    expect(again.body.error.message).toContain(ok.body.checkoutNo);
  });

  it('作废：店员不能；值班经理写原因作废；作废后同一张券可以重新补登记', async () => {
    const r = await redeem({ code: 'DY99990000', platform: 'douyin', faceValue: 8800 });
    expect(r.status).toBe(200);
    const id = r.body.redemption.id as number;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/platform/redemptions/${id}/void`, { reason: '登错了' })).status).toBe(403);
    const v = await api(ctx.app, duty, 'POST', `/api/platform/redemptions/${id}/void`, { reason: '登错了' });
    expect(v.body).toMatchObject({ status: 'voided', voidReason: '登错了' });
    expect((await api(ctx.app, duty, 'POST', `/api/platform/redemptions/${id}/void`, { reason: '再作废' })).body.error.code).toBe('ALREADY_VOIDED');
    expect((await redeem({ code: 'DY99990000', platform: 'douyin', faceValue: 8800 })).status).toBe(200);
  });
});

describe('打款与对账', () => {
  it('店员不能登记打款；店主登记；对账：补登记的应结 + 结账团购券 与 到账；日结单列不算营业额；自检', async () => {
    const body = { clientKey: randomUUID(), platform: 'meituan', periodFrom: today, periodTo: today, amount: 30000, receivedOn: today, ref: 'MT-PAY-1' };
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/platform/settlements', body)).status).toBe(403);
    const s = await api(ctx.app, ctx.owner, 'POST', '/api/platform/settlements', body);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.settlement).toMatchObject({ platform: 'meituan', amount: 30000, status: 'active' });
    const rec = (await api(ctx.app, ctx.owner, 'GET', `/api/platform/reconcile?from=${today}&to=${today}`)).body as PlatformReconcile;
    const mt = rec.rows.find((r) => r.platform === 'meituan')!;
    // 补登记 MT12345678 应结 168；结账团购券 MT87654321 抵扣 = 那张结账单的应收
    expect(mt.redemptions).toMatchObject({ count: 1, settle: 16800 });
    expect(mt.checkoutCoupons.count).toBe(1);
    expect(mt.expected).toBe(16800 + mt.checkoutCoupons.amount);
    expect(mt.settlements).toMatchObject({ count: 1, amount: 30000 });
    expect(mt.diff).toBe(30000 - mt.expected);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/platform/reconcile?from=${today}&to=${today}`)).status).toBe(403);
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(st.platformRedemptions).toMatchObject({ count: 3, voidCount: 1 });
    // 营业口径不含补登记：应收只有那张结账单
    expect(st.business.checkouts.count).toBe(1);
    for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
      expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    }
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/platform/settlements/${s.body.settlement.id}/void`, { reason: '金额登错' });
    expect(voided.body.status).toBe('voided');
    const after = (await api(ctx.app, ctx.owner, 'GET', `/api/platform/reconcile?from=${today}&to=${today}`)).body as PlatformReconcile;
    expect(after.rows.find((r) => r.platform === 'meituan')!.settlements.count).toBe(0);
  });
});
