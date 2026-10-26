// seed-frontdesk-demo：固定预期结果（demo/frontdesk-expected.json）、试用环境拒绝、重复执行跳过、会员钱包不被挂账改变。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';
import expected from '../src/server/demo/frontdesk-expected.json' with { type: 'json' };
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('前台演示数据', () => {
  it('试用环境拒绝写入', async () => {
    const trial = loadConfig({ databaseUrl: ctx.config.databaseUrl, env: 'trial', logLevel: 'silent' });
    await expect(seedFrontdeskDemo(ctx.sql, trial)).rejects.toThrow(/试用/);
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags`)[0]!;
    expect(n).toBe(0);
  });

  it('结果与预期 JSON 逐项一致', async () => {
    const r = await seedFrontdeskDemo(ctx.sql, ctx.config);
    expect(r).toMatchObject({ skipped: false, tags: 92, inStore: expected.inStore.count });
    const owner = await login(ctx.app, 'linlan', 'yuzu2026');
    const board = (await api(ctx.app, owner, 'GET', '/api/frontdesk/board')).body;
    expect(board.stats).toMatchObject({
      inStore: expected.inStore.count,
      inStoreByZone: expected.inStore.byZone,
      unsettledCents: expected.inStore.unsettledCents,
      groups: expected.inStore.groups,
      locked: Object.keys(expected.tags.locked).length,
    });
    for (const [zone, z] of Object.entries({ male: expected.tags.male, female: expected.tags.female, child: expected.tags.child })) {
      expect(board.tags.filter((t: { zone: string }) => t.zone === zone)).toHaveLength(z.total);
    }
    for (const [code, reason] of Object.entries(expected.tags.locked)) {
      expect(board.tags.find((t: { code: string }) => t.code === code)).toMatchObject({ locked: true, lockReason: reason, visit: null });
    }
    for (const e of expected.visits) {
      const card = board.tags.find((t: { code: string }) => t.code === e.tag);
      expect(card?.visit, e.tag).toBeTruthy();
      expect(card.visit).toMatchObject({ amountCents: e.amountCents, guestLabel: e.guest, memberName: e.member });
      const v = (await api(ctx.app, owner, 'GET', `/api/frontdesk/visits/${card.visit.id}`)).body;
      expect(v.lines.filter((l: { status: string }) => l.status === 'active').map((l: { name: string; quantity: number }) => `${l.name} ×${l.quantity}`).sort()).toEqual([...e.lines].sort());
      if (e.voided) expect(v.lines.filter((l: { status: string }) => l.status === 'voided').map((l: { name: string; quantity: number; voidReason: string }) => `${l.name} ×${l.quantity}（${l.voidReason}）`)).toEqual(e.voided);
    }
    for (const g of Object.values(expected.groups)) {
      const first = board.tags.find((t: { code: string }) => t.code === g.tags[0]);
      const v = (await api(ctx.app, owner, 'GET', `/api/frontdesk/visits/${first.visit.id}`)).body;
      expect(v.group.mates.map((m: { tagCode: string }) => m.tagCode).sort()).toEqual([...g.tags].sort());
      expect(v.group.openAmountCents).toBe(g.openAmountCents);
    }
    const a022 = board.tags.find((t: { code: string }) => t.code === 'A022');
    const swapped = (await api(ctx.app, owner, 'GET', `/api/frontdesk/visits/${a022.visit.id}`)).body;
    expect(swapped.history.some((h: { text: string }) => h.text.includes('A021 → A022'))).toBe(true);
    const a025 = board.tags.find((t: { code: string }) => t.code === 'A025');
    expect(a025.visit).toBeNull();
    const { n } = (await ctx.sql<{ n: number }[]>`
      SELECT count(*) AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = 'A025' AND v.status = 'cancelled' AND v.close_reason = '开错手牌'`)[0]!;
    expect(n).toBe(1);
  });

  it('会员余额只来自充值，前台挂账没有产生任何消费或撤销', async () => {
    for (const [name, m] of Object.entries(expected.members)) {
      const [row] = await ctx.sql<{ principalBalance: number; bonusBalance: number }[]>`SELECT principal_balance, bonus_balance FROM members WHERE phone = ${m.phone}`;
      expect(row, name).toMatchObject({ principalBalance: m.principalBalance, bonusBalance: m.bonusBalance });
    }
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT (SELECT count(*) FROM consumptions) + (SELECT count(*) FROM reversals) AS n`)[0]!;
    expect(n).toBe(0);
  });

  it('自检全部通过；重复执行跳过', async () => {
    const owner = await login(ctx.app, 'linlan', 'yuzu2026');
    const checks = (await api(ctx.app, owner, 'GET', '/api/frontdesk/checks')).body;
    expect(checks.map((c: { key: string }) => c.key)).toEqual(expected.checks);
    for (const c of checks) expect(c, c.label).toMatchObject({ ok: true });
    expect(await seedFrontdeskDemo(ctx.sql, ctx.config)).toEqual({ skipped: true });
    const me = (await api(ctx.app, owner, 'GET', '/api/auth/me')).body;
    expect(me.hasSyntheticData).toBe(true);
  });
});
