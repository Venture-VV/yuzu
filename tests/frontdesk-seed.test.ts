// seed-frontdesk-demo：固定预期结果（demo/frontdesk-expected.json）、试用环境拒绝、重复执行跳过、会员钱包不被挂账改变；
// 内置的真实柜号清单与 docs/data 下的 CSV 逐字一致。

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHandTagCsv } from '../src/shared/hand-tag-import';
import { loadConfig } from '../src/server/config';
import expected from '../src/server/demo/frontdesk-expected.json' with { type: 'json' };
import { STORE_HAND_TAGS_CSV } from '../src/server/demo/hand-tags-2026-10-27';
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

type Tag = { code: string; zone: string; kind: string; vipLevel: number | null; visit: { id: number; memberName: string | null } | null };
const area = (code: string) => code.replace(/[0-9]/g, '');

describe('内置的真实柜号清单', () => {
  it('与 docs/data/hand-tags-2026-10-27.csv 逐字一致，747 个、无错误', async () => {
    const file = await readFile(new URL('../docs/data/hand-tags-2026-10-27.csv', import.meta.url), 'utf8');
    expect(STORE_HAND_TAGS_CSV.trim()).toBe(file.trim());
    const parsed = parseHandTagCsv(file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(expected.tags.total);
    // 全部牌号的数字部分互不重复（输入数字即可唯一定位）
    const digits = parsed.rows.map((r) => r.code.replace(/[^0-9]/g, ''));
    expect(new Set(digits).size).toBe(digits.length);
  });
});

describe('前台演示数据', () => {
  it('试用环境拒绝写入', async () => {
    const trial = loadConfig({ databaseUrl: ctx.config.databaseUrl, env: 'trial', logLevel: 'silent' });
    await expect(seedFrontdeskDemo(ctx.sql, trial)).rejects.toThrow(/试用/);
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags`)[0]!;
    expect(n).toBe(0);
  });

  it('结果与预期 JSON 逐项一致', async () => {
    const r = await seedFrontdeskDemo(ctx.sql, ctx.config);
    expect(r).toMatchObject({ skipped: false, tags: expected.tags.total, inStore: expected.inStore.count });
    const owner = await login(ctx.app, 'linlan', 'yuzu2026');
    const board = (await api(ctx.app, owner, 'GET', '/api/frontdesk/board')).body;
    expect(board.stats).toMatchObject({
      inStore: expected.inStore.count,
      inStoreByZone: expected.inStore.byZone,
      unsettledCents: expected.inStore.unsettledCents,
      groups: expected.inStore.groups,
      locked: Object.keys(expected.tags.locked).length,
    });
    const tags = board.tags as Tag[];
    expect(tags).toHaveLength(expected.tags.total);
    for (const [zone, z] of Object.entries({ male: expected.tags.male, female: expected.tags.female })) {
      const list = tags.filter((t) => t.zone === zone);
      expect(list).toHaveLength(z.total);
      for (const [a, n] of Object.entries(z.normal)) expect(list.filter((t) => t.kind === 'normal' && area(t.code) === a), `${zone} ${a}`).toHaveLength(n);
      for (const [lv, n] of Object.entries(z.vip)) expect(list.filter((t) => t.kind === 'vip' && t.vipLevel === Number(lv)), `${zone} VIP ${lv}`).toHaveLength(n);
    }
    expect(tags.some((t) => t.zone === 'child')).toBe(false);
    expect(board.rules).toEqual(expected.rules);
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
    const to = tags.find((t) => t.code === expected.swap.to)!;
    const swapped = (await api(ctx.app, owner, 'GET', `/api/frontdesk/visits/${to.visit!.id}`)).body;
    expect(swapped.history.some((h: { text: string }) => h.text.includes(`${expected.swap.from} → ${expected.swap.to}`))).toBe(true);
    expect(swapped.lines.find((l: { source: string }) => l.source === 'other')).toMatchObject({ amount: expected.swap.lostFeeCents, status: 'active' });
    const cancelled = expected.cancelled[0]!;
    expect(tags.find((t) => t.code === cancelled.tag)!.visit).toBeNull();
    const { n } = (await ctx.sql<{ n: number }[]>`
      SELECT count(*) AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id
      WHERE t.code = ${cancelled.tag} AND v.status = 'cancelled' AND v.close_reason = ${cancelled.reason}`)[0]!;
    expect(n).toBe(1);
    // VIP 柜：柜子等级与会员等级
    for (const v of expected.vip) {
      const t = tags.find((x) => x.code === v.tag)!;
      expect(t, v.tag).toMatchObject({ zone: v.zone, kind: 'vip', vipLevel: v.tagLevel });
      expect(t.visit?.memberName).toBe(v.member);
      const detail = (await api(ctx.app, owner, 'GET', `/api/frontdesk/visits/${t.visit!.id}`)).body;
      expect(detail.memberGrade.lockerLevel).toBe(v.memberLockerLevel);
      expect(detail.vipOverrideByName).toBeNull();
    }
  });

  it('会员余额只来自充值，前台挂账没有产生任何消费或撤销', async () => {
    const owner = await login(ctx.app, 'linlan', 'yuzu2026');
    for (const [name, m] of Object.entries(expected.members)) {
      const [row] = await ctx.sql<{ id: number; principalBalance: number; bonusBalance: number }[]>`SELECT id, principal_balance, bonus_balance FROM members WHERE phone = ${m.phone}`;
      expect(row, name).toMatchObject({ principalBalance: m.principalBalance, bonusBalance: m.bonusBalance });
      // 会员体系 v2（v0.7.23）：演示充值按滚动累计升档，VIP 柜按档级对应
      const grade = (await api(ctx.app, owner, 'GET', `/api/frontdesk/members/${row!.id}/grade`)).body;
      expect(grade, name).toMatchObject({ memberId: row!.id, grade: m.grade, tier: m.tier, label: m.label, lockerLevel: m.lockerLevel });
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
