// Batch 2.1：内置岗位「值班经理」「店总」（店主 2026-10-27 #29），默认权限待确认；前台店员权限保持不变。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let dutyManager: string;
let storeManager: string;
let today: string;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  dutyManager = await login(ctx.app, 'duty');
  storeManager = await login(ctx.app, 'boss');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
});
afterAll(async () => ctx.close());

const permissionsOf = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/auth/me')).body.permissions as string[];

describe('店主可以建两个新岗位', () => {
  it('员工接口接受「值班经理」「店总」，并能改回店员', async () => {
    for (const role of ['duty_manager', 'store_manager']) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: `new_${role}`, displayName: role, role, duties: [] });
      expect(r.status).toBe(201);
    }
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/staff')).body as { id: number; username: string; role: string }[];
    const created = list.find((s) => s.username === 'new_duty_manager')!;
    expect(created.role).toBe('duty_manager');
    const back = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${created.id}`, { displayName: '改回店员', role: 'clerk', duties: [], active: true });
    expect(back.status).toBe(200);
  });
});

describe('值班经理', () => {
  it('可以撤销消费、看历史营业日、导出、确认日结、当场授权 VIP 柜；不能授权超限、自定赠金、管理员工与规则', async () => {
    const perms = await permissionsOf(dutyManager);
    expect(perms).toEqual(expect.arrayContaining(['consume.reverse', 'ledger.readHistory', 'ledger.export', 'settlement.close', 'frontdesk.correct', 'frontdesk.tags', 'auth.vipOverride']));
    for (const p of ['auth.overLimit', 'recharge.customBonus', 'staff.manage', 'settings.manage', 'catalog.manage', 'audit.read', 'inventory.read']) {
      expect(perms).not.toContain(p);
    }

    const m = await createMember(ctx, '经理撤销', '19900009301');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 10000));
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 3000));
    // 店员不能撤销，值班经理可以
    const reverse = (cookie: string) =>
      api(ctx.app, cookie, 'POST', `/api/consumptions/${c.body.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
    expect((await reverse(ctx.clerk)).status).toBe(403);
    expect((await reverse(dutyManager)).status).toBe(200);

    expect((await api(ctx.app, dutyManager, 'GET', '/api/settlements/2026-01-01')).status).toBe(200);
    expect((await api(ctx.app, dutyManager, 'GET', `/api/settlements/${today}/export`)).status).toBe(200);
    expect((await api(ctx.app, dutyManager, 'POST', `/api/settlements/${today}/close`, { note: '值班经理日结' })).status).toBe(200);

    expect((await api(ctx.app, dutyManager, 'POST', '/api/recharges', rechargeBody(m.id, 10000, 500))).status).toBe(403);
    expect((await api(ctx.app, dutyManager, 'POST', '/api/staff', { username: 'nope', displayName: 'x', role: 'clerk', duties: [] })).status).toBe(403);
  });

  it('可以作废店员超时或他人的前台明细（店员自己只能作废本人时限内的）', async () => {
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 2, width: 3, zone: 'male' });
    const visit = (await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'R001', zone: 'male' }] })).body.visits[0];
    // 店主挂的明细：店员不能作废，值班经理可以
    const posted = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/visits/${visit.id}/charges`, {
      clientKey: randomUUID(),
      lines: [],
      customLines: [{ name: '经理更正', amount: 1000 }],
      expectedTotal: 1000,
    });
    const lineId = posted.body.lines.find((l: { name: string }) => l.name === '经理更正').id as number;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${lineId}/void`, { reason: '录错' })).status).toBe(403);
    expect((await api(ctx.app, dutyManager, 'POST', `/api/frontdesk/lines/${lineId}/void`, { reason: '录错' })).status).toBe(200);
  });
});

describe('店总', () => {
  it('在值班经理之上还可以自定赠金、管理项目、查看审计、授权超过单笔上限；不能管理员工与经营规则', async () => {
    const perms = await permissionsOf(storeManager);
    expect(perms).toEqual(expect.arrayContaining(['recharge.customBonus', 'catalog.manage', 'audit.read', 'auth.overLimit', 'auth.vipOverride', 'consume.reverse']));
    expect(perms).not.toContain('staff.manage');
    expect(perms).not.toContain('settings.manage');

    const m = await createMember(ctx, '店总赠金', '19900009302');
    expect((await api(ctx.app, storeManager, 'POST', '/api/recharges', rechargeBody(m.id, 10000, 500))).status).toBe(200);
    expect((await api(ctx.app, storeManager, 'POST', '/api/items', { name: '店总新项目', category: '护理', price: 9900 })).status).toBe(200);
    expect((await api(ctx.app, storeManager, 'GET', `/api/audit?date=${today}`)).status).toBe(200);
    const settings = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    expect((await api(ctx.app, storeManager, 'PUT', '/api/settings', settings)).status).toBe(403);
  });
});

describe('前台店员权限不变', () => {
  it('仍然不能撤销、看历史、导出、日结或当场授权', async () => {
    const perms = await permissionsOf(ctx.clerk);
    for (const p of ['consume.reverse', 'ledger.readHistory', 'ledger.export', 'settlement.close', 'frontdesk.correct', 'frontdesk.tags', 'auth.overLimit', 'auth.vipOverride']) {
      expect(perms).not.toContain(p);
    }
  });
});
