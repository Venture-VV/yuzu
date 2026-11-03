// 规则保存串行（v0.7.22，src/server/lib/rule-settings.ts）：两人同时只改各自的字段，两处修改都保住。
// 原来前台规则在锁外读当前规则、库存设置不取锁：后保存的一方会把先保存的一方改的字段改回去。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
}, 60_000);
afterAll(async () => ctx.close());

/** 另一个事务先拿住规则锁与那一行设置，期间发出的保存都要等；等两次保存都发出去、读过当前值后再放开 */
async function whileHeld(keys: string[], fire: () => Promise<{ status: number }>[]) {
  let sent: Promise<{ status: number }>[] = [];
  await ctx.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
    await tx`SELECT 1 FROM settings WHERE key IN ${tx(keys)} FOR UPDATE`;
    sent = fire();
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  return Promise.all(sent);
}

describe('规则保存串行（v0.7.22）', () => {
  it('前台规则：两人同时各改一个字段，两处修改都保住', async () => {
    const get = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/rules')).body as { selfVoidMinutes: number; overtimeGraceMinutes: number };
    const put = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', body);
    const initial = await get();
    expect((await put({ selfVoidMinutes: initial.selfVoidMinutes })).status).toBe(200); // 先存一次，规则那一行就有了
    const selfVoidMinutes = (initial.selfVoidMinutes + 1) % 100;
    const overtimeGraceMinutes = (initial.overtimeGraceMinutes + 1) % 100;
    const results = await whileHeld(['frontdesk_rules'], () => [put({ selfVoidMinutes }), put({ overtimeGraceMinutes })]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await get()).toMatchObject({ selfVoidMinutes, overtimeGraceMinutes });
  });

  it('库存设置：两人同时各改一项周期规则（没提交的沿用当前值），两处修改都保住', async () => {
    const get = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/settings')).body as Record<string, unknown> & { weighTolerancePct: number; stocktakeDay: number };
    const initial = await get();
    const base = {
      scopeName: initial.scopeName,
      priceBasis: initial.priceBasis,
      urgentCapCents: initial.urgentCapCents,
      approvalThresholdCents: initial.approvalThresholdCents,
      usageWindowDays: initial.usageWindowDays,
      approvalRules: initial.approvalRules,
    };
    const put = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...base, ...body });
    expect((await put({})).status).toBe(200);
    const weighTolerancePct = initial.weighTolerancePct === 15 ? 12 : 15;
    const stocktakeDay = initial.stocktakeDay === 20 ? 21 : 20;
    const results = await whileHeld(['inventory_cycle_rules'], () => [put({ weighTolerancePct }), put({ stocktakeDay })]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await get()).toMatchObject({ weighTolerancePct, stocktakeDay });
  });
});
