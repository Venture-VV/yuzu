// 8.0.21 平台验券（docs/INTEGRATIONS_V8021.md 第 3 节，CW-H / CW8；迁移 149）。用的是模拟实现：
// 券码尾号 0000 不存在、2222 两份 ¥398、9999 撤销不了、7777 平台对账单上没有；其余美团 ¥99（应结 ¥92）、抖音 ¥88。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockPlatformBillAdd } from '../src/server/integrations/platform-voucher';
import { runVoucherReconcile } from '../src/server/modules/platform-verify';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let tagNo = 0;
const stamp = String(Date.now()).slice(-8);
const code = (tail: string) => `MT${stamp}${tail}`;

const enter = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `V${String(tagNo).padStart(3, '0')}`, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const total = async (ids: number[]) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${ids.join(',')}`)).body.totalAmount as number;
const checkout = (ids: number[], expectedTotal: number, payments: unknown[]) => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: ids, expectedTotal, payments });
const verify = async (platform: string, c: string) => {
  const p = await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify/prepare', { platform, code: c });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify', { clientKey: randomUUID(), platform, code: c, expectedFaceCents: p.body.faceCents });
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'vduty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'vduty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'V', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
}, 60_000);
afterAll(async () => ctx.close());

describe('平台验券', () => {
  it('先问平台（只读）→ 核销 → 结账带验券编号（金额 = 面值、项目跟平台）→ 同一张不能再验、不能手输、不能补录', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/platform/verify/status')).body).toEqual({ mode: 'mock', enabled: true });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify/prepare', { platform: 'meituan', code: code('0000') })).body.error.code).toBe('VOUCHER_INVALID');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify/prepare', { platform: 'dianping', code: code('1234') })).status).toBe(400);
    const c1 = code('1001');
    const prep = (await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify/prepare', { platform: 'meituan', code: c1 })).body;
    expect(prep).toMatchObject({ dealName: '单人浴资（模拟）', faceCents: 9_900, settleCents: 9_200, quantity: 1 });
    // 面值和看到的不一样：拒绝
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify', { clientKey: randomUUID(), platform: 'meituan', code: c1, expectedFaceCents: 100 })).body.error.code).toBe('VOUCHER_CHANGED');
    const v = await verify('meituan', c1);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body).toMatchObject({ status: 'verified', faceCents: 9_900, checkout: null });
    expect(v.body.verifyNo).toMatch(/^MOCKV/);
    // 同一张再验：拒绝
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify', { clientKey: randomUUID(), platform: 'meituan', code: c1, expectedFaceCents: 9_900 })).body.error.code).toBe('COUPON_VERIFIED');

    const vid = await enter();
    const t = await total([vid]);
    // 金额不等于面值：拒绝；手输同一张：拒绝
    expect((await checkout([vid], t, [{ method: 'coupon', platform: 'meituan', code: c1, amount: 5_000, verificationId: v.body.id }, { method: 'cash', amount: t - 5_000 }])).body.error.code).toBe('VERIFICATION_MISMATCH');
    expect((await checkout([vid], t, [{ method: 'coupon', platform: 'meituan', code: c1, amount: 9_900 }, { method: 'cash', amount: t - 9_900 }])).body.error.code).toBe('COUPON_VERIFIED');
    const done = await checkout([vid], t, [{ method: 'coupon', platform: 'meituan', code: c1, dealName: '随便写的', amount: 9_900, verificationId: v.body.id }, { method: 'cash', amount: t - 9_900 }]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.payments.find((p: { method: string }) => p.method === 'coupon')).toMatchObject({ ref: '单人浴资（模拟）', coupon: { code: c1 } });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/platform/verifications/open')).body.some((x: { id: number }) => x.id === v.body.id)).toBe(false);
    // 补录：拒绝（结账里登记过）
    const redeem = await api(ctx.app, ctx.owner, 'POST', '/api/platform/redemptions', { clientKey: randomUUID(), platform: 'meituan', code: c1, dealName: 'x', faceValue: 9_900, redeemedAt: new Date().toISOString() });
    expect(redeem.body.error.code).toBe('PLATFORM_CODE_USED');

    // 反结账：验券回到没用，挂到重新结账
    const voided = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${done.body.id}/void`, { clientKey: randomUUID(), reason: '结错了', expectedTotal: t });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/platform/verifications/open')).body.find((x: { id: number }) => x.id === v.body.id)).toMatchObject({ status: 'verified', checkout: null });
    const again = await checkout([vid], t, [{ method: 'coupon', platform: 'meituan', code: c1, amount: 9_900, verificationId: v.body.id }, { method: 'cash', amount: t - 9_900 }]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('核了没结账：撤销核销；平台不让撤的转补录（不算营业额）；补录里不能再登记验过的券', async () => {
    const a = (await verify('douyin', code('2001'))).body;
    expect(a.faceCents).toBe(8_800);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/platform/verifications/${a.id}/cancel`, { reason: '客人不用了' })).status).toBe(403);
    const redeem = await api(ctx.app, ctx.owner, 'POST', '/api/platform/redemptions', { clientKey: randomUUID(), platform: 'douyin', code: code('2001'), dealName: 'x', faceValue: 8_800, redeemedAt: new Date().toISOString() });
    expect(redeem.body.error.code).toBe('PLATFORM_CODE_USED');
    const cancelled = await api(ctx.app, duty, 'POST', `/api/platform/verifications/${a.id}/cancel`, { reason: '客人不用了' });
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });
    // 撤销以后可以重新验
    expect((await verify('douyin', code('2001'))).status).toBe(201);

    const b = (await verify('meituan', code('9999'))).body;
    const fail = await api(ctx.app, duty, 'POST', `/api/platform/verifications/${b.id}/cancel`, { reason: '客人走了' });
    expect(fail.body.error.code).toBe('CANCEL_FAILED');
    const rec = await api(ctx.app, duty, 'POST', `/api/platform/verifications/${b.id}/record`, {});
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body).toMatchObject({ status: 'recorded' });
    expect(rec.body.redemptionNo).toMatch(/^PT/);
    const [r] = await ctx.sql<{ faceValue: number; settleAmount: number }[]>`SELECT face_value, settle_amount FROM platform_redemptions WHERE redemption_no = ${rec.body.redemptionNo}`;
    expect(r).toMatchObject({ faceValue: 9_900, settleAmount: 9_200 });
    await expect(ctx.sql`UPDATE platform_verifications SET status = 'verified' WHERE id = ${b.id}`).rejects.toThrow(/不能这样改/);
  });

  it('确认作废：请求没到时作废，原请求晚到也不核销', async () => {
    const key = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/platform/verifications/by-key/${key}`)).status).toBe(404);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/platform/verifications/by-key/${key}/abandon`, {})).body).toEqual({ abandoned: true, verification: null });
    const late = await api(ctx.app, ctx.clerk, 'POST', '/api/platform/verify', { clientKey: key, platform: 'meituan', code: code('3001'), expectedFaceCents: 9_900 });
    expect(late.body.error.code).toBe('OP_ABANDONED');
  });

  it('每天对账：平台有系统没有、系统有平台没有、金额不同；标已处理；自动对账每天只跑一次', async () => {
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
    // 系统有、平台没有：验券（尾号 7777 不进模拟的对账单）后结账
    const v = (await verify('meituan', code('7777'))).body;
    const vid = await enter();
    const t = await total([vid]);
    expect((await checkout([vid], t, [{ method: 'coupon', platform: 'meituan', code: code('7777'), amount: 9_900, verificationId: v.id }, { method: 'cash', amount: t - 9_900 }])).status).toBe(200);
    // 平台有、系统没有
    mockPlatformBillAdd({ platform: 'meituan', businessDate: today, code: code('8001'), verifyNo: 'X1', dealName: '平台那边的', faceCents: 9_900, settleCents: 9_200 });
    const run = await api(ctx.app, ctx.owner, 'POST', '/api/platform/recon/run', { platform: 'meituan', date: today });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body).toMatchObject({ ok: true });
    const recon = (await api(ctx.app, ctx.owner, 'GET', `/api/platform/recon?from=${today}&to=${today}`)).body;
    const kinds = (recon.issues as { kind: string; code: string }[]).map((i) => `${i.kind}:${i.code}`).sort();
    expect(kinds).toContain(`platform_only:${code('8001')}`);
    expect(kinds).toContain(`system_only:${code('7777')}`);
    expect(kinds).not.toContain(`system_only:${code('1001')}`);
    const issue = (recon.issues as { id: number; kind: string }[]).find((i) => i.kind === 'platform_only')!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/platform/recon/issues/${issue.id}/resolve`, { note: '看过了' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/platform/recon/issues/${issue.id}/resolve`, { note: '平台那边退款了' })).status).toBe(200);
    const after = (await api(ctx.app, ctx.owner, 'GET', `/api/platform/recon?from=${today}&to=${today}`)).body.issues.find((i: { id: number }) => i.id === issue.id);
    expect(after).toMatchObject({ resolveNote: '平台那边退款了' });

    // 自动对账：过了 06:10 才跑，前一个营业日每个平台只跑一次
    const deps = { sql: ctx.sql, config: ctx.config };
    const late = new Date();
    const n1 = await runVoucherReconcile(deps, late);
    const n2 = await runVoucherReconcile(deps, late);
    expect(n2).toBe(0);
    expect([0, 2]).toContain(n1);
  });
});
