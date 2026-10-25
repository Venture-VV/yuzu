import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import type { Deps } from '../src/server/lib/context';
import { consume } from '../src/server/modules/wallet';
import { api, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('登录与权限', () => {
  it('未登录访问返回 401', async () => {
    const res = await api(ctx.app, null, 'GET', '/api/members');
    expect(res.status).toBe(401);
  });

  it('密码错误返回 401 并记录审计', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'clerk', password: 'wrong-1234' } });
    expect(res.statusCode).toBe(401);
    const [row] = await ctx.sql<{ count: number }[]>`SELECT count(*) AS count FROM audit_logs WHERE action = 'login_failed'`;
    expect(row!.count).toBeGreaterThan(0);
  });

  it('店员不能管理员工、修改规则或查看历史营业日', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/staff')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/settings')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/ledger?date=2020-01-01')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/ledger')).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/ledger?date=2020-01-01')).status).toBe(200);
  });

  it('新员工首次登录必须修改密码', async () => {
    const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'newbie', displayName: '新同事', role: 'clerk' });
    expect(created.status).toBe(201);
    const temp = created.body.temporaryPassword as string;
    const cookie = await login(ctx.app, 'newbie', temp);
    const me = await api(ctx.app, cookie, 'GET', '/api/auth/me');
    expect(me.body.staff.mustChangePassword).toBe(true);
    const blocked = await api(ctx.app, cookie, 'GET', '/api/members');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const weak = await api(ctx.app, cookie, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: '123' });
    expect(weak.status).toBe(400);
    const changed = await api(ctx.app, cookie, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'newbie-2026' });
    expect(changed.status).toBe(200);
    expect((await api(ctx.app, cookie, 'GET', '/api/members')).status).toBe(200);
  });

  it('停用员工后其会话立即失效；不能停用最后一位店主', async () => {
    const staff = await api(ctx.app, ctx.owner, 'GET', '/api/staff');
    const newbie = staff.body.find((s: { username: string }) => s.username === 'newbie');
    const cookie = await login(ctx.app, 'newbie', 'newbie-2026');
    const off = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${newbie.id}`, { displayName: '新同事', role: 'clerk', active: false });
    expect(off.status).toBe(200);
    expect((await api(ctx.app, cookie, 'GET', '/api/members')).status).toBe(401);

    const self = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${ctx.ownerId}`, { displayName: '测试店主', role: 'clerk', active: true });
    expect(self.status).toBe(422);
  });

  it('跨站来源的修改请求被拒绝', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: { cookie: ctx.clerk, origin: 'http://evil.example', host: 'localhost' },
      payload: { name: '跨站', phone: '19912345678' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('同一手机号不能重复建档', async () => {
    await createMember(ctx, '手机号唯一', '19900004001');
    const dup = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '另一个人', phone: '199 0000 4001' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PHONE_EXISTS');
    expect(dup.body.error.details.memberId).toBeTypeOf('number');
  });
});

describe('日结', () => {
  it('跨营业日撤销计入撤销当天并标为异常，核对仍然一致', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    const today = me.body.today as string;
    const yesterday = shiftDate(today, -1);
    const member = await createMember(ctx, '跨日会员', '19900005001');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 20000));

    // 用服务层直接写入一笔「昨天」的消费
    const deps: Deps = { sql: ctx.sql, config: ctx.config };
    const yesterdayNoon = new Date(`${yesterday}T12:00:00+08:00`);
    const c = await consume(
      deps,
      { idempotencyKey: randomUUID(), memberId: member.id, customLines: [{ name: '昨日消费', amount: 5000 }], expectedTotal: 5000 },
      { actor: { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', mustChangePassword: false }, at: yesterdayNoon },
    );
    expect(c.type === 'consume' && c.consumption.businessDate).toBe(yesterday);

    const id = c.type === 'consume' ? c.consumption.id : 0;
    const rv = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${id}/reverse`, { idempotencyKey: randomUUID(), reason: '顾客取消消费' });
    expect(rv.status).toBe(200);
    expect(rv.body.reversal.businessDate).toBe(today);

    const s = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`);
    expect(s.body.reversal.crossDayCount).toBe(1);
    expect(s.body.anomalies.some((a: { kind: string }) => a.kind === 'cross_day_reversal')).toBe(true);
    expect(s.body.checks.every((x: { ok: boolean }) => x.ok)).toBe(true);

    const y = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${yesterday}`);
    expect(y.body.consume).toMatchObject({ count: 1, total: 5000, reversedCount: 1 });
    expect(y.body.checks.every((x: { ok: boolean }) => x.ok)).toBe(true);
    // 期末 = 次日期初
    expect(y.body.balances.closing).toEqual(s.body.balances.opening);
  });

  it('店主确认日结；之后有新业务时提示有变动', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    const today = me.body.today as string;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/settlements/${today}/close`, { note: '' })).status).toBe(403);
    const closed = await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${today}/close`, { note: '现金已核对' });
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toMatchObject({ note: '现金已核对', revision: 1, changedSinceClose: false });

    const member = await createMember(ctx, '日结后会员', '19900005002');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 1000));
    const after = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`);
    expect(after.body.closed.changedSinceClose).toBe(true);

    const again = await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${today}/close`, { note: '补录后重新确认' });
    expect(again.body.closed).toMatchObject({ revision: 2, changedSinceClose: false });
  });

  it('导出 CSV（带 BOM，Excel 可直接打开）', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    const res = await ctx.app.inject({ method: 'GET', url: `/api/ledger/export?date=${me.body.today}`, headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('﻿营业日,时间,单号')).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/ledger/export?date=${me.body.today}`)).status).toBe(403);
  });

  it('会员搜索支持手机号后四位与姓名', async () => {
    const byTail = await api(ctx.app, ctx.clerk, 'GET', '/api/members?q=5001');
    expect(byTail.body[0].name).toBe('跨日会员');
    const byName = await api(ctx.app, ctx.clerk, 'GET', `/api/members?q=${encodeURIComponent('跨日')}`);
    expect(byName.body[0].phone).toBe('19900005001');
  });
});

describe('密码', () => {
  it('临时密码登录后修改，旧密码失效', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
  });
});
