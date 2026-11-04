// 给小程序第三期的入口（v0.7.28 ①，docs/SCHEDULE_FINISH.md 第 2 节、docs/MP_PHASE3.md 第 2、3 节）：
//   · 3b createTrialInviteFromMp：与前台「邀请体验」同一套规则；经办人系统账号「小程序」；好友还不是会员的当场建档、渠道「老带新」；
//     同一个 claimKey 再调用返回第一次那条，内容不同拒绝；拒绝时什么都不留（存档点），调用方事务还能接着用；
//   · 3c orderFoodFromMp：挂在会员在店手牌的账单上、进厨房出品单（扣估清），桌码写进出品单；只能点进厨房的菜；
//     一单份数、金额有上限；同一个 claimKey 只下一次（两个事务同时下也只一单）；没有在店手牌、桌号不对、价格变了都拒绝；
//   · 只读：桌台、「我的账单」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import type { Deps } from '../src/server/lib/context';
import {
  createTrialInviteFromMp,
  mpDiningTables,
  mpOpenBill,
  orderFoodFromMp,
  type MpFoodInput,
  type MpInviteInput,
} from '../src/server/modules/mp-entries';
import { trialChecks } from '../src/server/modules/member-trials';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;
const yuan = (n: number) => Math.round(n * 100);
const item: Record<string, number> = {};
let tableId = 0;

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error('应该拒绝');
};
const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
let phoneNo = 0;
const member = async (name: string, paidYuan: number) => {
  phoneNo += 1;
  const phone = `1995555${String(phoneNo).padStart(4, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  if (paidYuan > 0) {
    const info = await gradeOf(id);
    const paid = yuan(paidYuan);
    const bonus = rechargeOutcome(await rules(), info.state.grade, info.rollingRechargeCents, paid).bonusCents;
    const rc = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', {
      idempotencyKey: randomUUID(),
      memberId: id,
      planId: null,
      paidAmount: paid,
      bonusAmount: bonus,
      paymentMethod: 'wechat',
      paymentConfirmed: true,
      bonusMode: 'auto',
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
  }
  return { id, phone };
};
const invite = (input: MpInviteInput) => ctx.sql.begin((tx) => createTrialInviteFromMp(tx, deps, input));
const order = (input: MpFoodInput) => ctx.sql.begin((tx) => orderFoodFromMp(tx, deps, input));
let tagNo = 0;
const checkIn = async (memberId: number | null) => {
  tagNo += 1;
  const code = `P${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', {
    clientKey: randomUUID(),
    guests: [{ tagCode: code, zone: 'male', ...(memberId ? { memberId } : {}) }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, code };
};
const allChecksOk = async () => {
  for (const c of [...(await consistencyChecks(ctx.sql, ctx.config.timezone)), ...(await trialChecks(ctx.sql))]) {
    if (c.label.includes('自动任务')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  const r = await rules();
  const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(1000) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  // 餐饮：两道进厨房的菜、一样不进厨房的；一张桌台
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'P', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['宫保鸡丁', '热菜', 4800],
    ['柠檬茶', '水吧', 1500],
    ['一次性拖鞋', '洗浴用品', 500],
  ] as const) {
    const ri = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(ri.status).toBe(200);
    item[name] = ri.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id as number;
  const mapped = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', {
    items: [
      { id: item['宫保鸡丁'], stationId },
      { id: item['柠檬茶'], stationId },
    ],
  });
  expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
  const tb = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'A8', area: '餐厅', seats: 4 });
  expect(tb.status, JSON.stringify(tb.body)).toBe(200);
  tableId = tb.body.tables.find((t: { name: string }) => t.name === 'A8').id;
});
afterAll(async () => ctx?.close());

describe('3b 邀请好友 createTrialInviteFromMp', () => {
  it('与前台同一套规则：给对方低一档的体验；经办人「小程序」；同一个 claimKey 再调用返回第一次那条，内容不同拒绝', async () => {
    const inviter = await member('小程序邀请人', 30000);
    const friend = await member('已有会员好友', 0);
    const first = await invite({ inviterId: inviter.id, invitee: { phone: friend.phone }, claimKey: 'inv-1' });
    expect(first.replayed).toBe(false);
    expect(first.trial).toMatchObject({ memberId: friend.id, inviterId: inviter.id, kind: 'invite', status: 'active', grade: 2, tier: 0 });
    const [row] = await ctx.sql<{ staff: string; system: boolean }[]>`
      SELECT s.display_name AS staff, s.system FROM member_trials t JOIN staff s ON s.id = t.staff_id WHERE t.id = ${first.trial.id}`;
    expect(row).toEqual({ staff: '小程序', system: true });
    const again = await invite({ inviterId: inviter.id, invitee: { phone: friend.phone }, claimKey: 'inv-1' });
    expect(again).toMatchObject({ replayed: true, trial: { id: first.trial.id } });
    expect((await errorOf(invite({ inviterId: inviter.id, invitee: { phone: '19955559999', name: '别人' }, claimKey: 'inv-1' }))).code).toBe('MP_CLAIM_CONFLICT');
    // 本月次数用完（每月 1 次），拒绝码与前台相同
    const other = await member('另一位好友', 0);
    const used = await errorOf(invite({ inviterId: inviter.id, invitee: { phone: other.phone }, claimKey: 'inv-2' }));
    expect(used).toMatchObject({ code: 'TRIAL_NOT_ALLOWED' });
    expect(used.message).toContain('本月已邀请');
    await allChecksOk();
  });

  it('好友还不是会员：当场建档、渠道「老带新」、发开卡礼；没给姓名 400；拒绝时调用方事务还能接着用、什么都不留', async () => {
    const inviter = await member('建档邀请人', 10000);
    const phone = '19955558001';
    const noName = await errorOf(invite({ inviterId: inviter.id, invitee: { phone }, claimKey: 'inv-new' }));
    expect(noName.status).toBe(400);
    const made = await invite({ inviterId: inviter.id, invitee: { phone, name: '新朋友' }, claimKey: 'inv-new-2' });
    expect(made.trial).toMatchObject({ grade: 1, tier: 0 });
    const [m] = await ctx.sql<{ name: string; channel: string | null }[]>`SELECT name, channel FROM members WHERE phone = ${phone}`;
    expect(m!.name).toBe('新朋友');
    expect(m!.channel).toBe('c5');

    // 存档点：在调用方的事务里先写一行，入口拒绝后调用方照样提交，那一行在、入口什么都没留
    const before = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM members`;
    const low = await member('L0 邀请人', 0);
    const marker = `mp-entry-marker-${randomUUID()}`;
    await ctx.sql.begin(async (tx) => {
      await tx`INSERT INTO settings (key, value) VALUES (${marker}, '{"ok": true}'::jsonb)`;
      const e = await errorOf(createTrialInviteFromMp(tx, deps, { inviterId: low.id, invitee: { phone: '19955558002', name: '不会建' }, claimKey: 'inv-low' }));
      expect(e.code).toBe('TRIAL_NOT_ALLOWED');
    });
    expect((await ctx.sql`SELECT 1 FROM settings WHERE key = ${marker}`).length).toBe(1);
    expect((await ctx.sql`SELECT 1 FROM members WHERE phone = '19955558002'`).length).toBe(0);
    expect((await ctx.sql`SELECT 1 FROM entry_claims WHERE claim_key = 'mp_invite:inv-low'`).length).toBe(0);
    const after = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM members`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
    await ctx.sql`DELETE FROM settings WHERE key = ${marker}`;
    await allChecksOk();
  });
});

describe('3c 扫码点餐 orderFoodFromMp', () => {
  let guest: { id: number; phone: string };
  let visit: { visitId: number; code: string };

  it('餐饮没开：DINING_DISABLED；没有在店手牌：NO_OPEN_VISIT', async () => {
    guest = await member('扫码点餐会员', 0);
    expect((await errorOf(order({ memberId: guest.id, items: [{ itemId: item['宫保鸡丁']!, quantity: 1 }], claimKey: 'f-0' }))).code).toBe('DINING_DISABLED');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
    expect((await errorOf(order({ memberId: guest.id, items: [{ itemId: item['宫保鸡丁']!, quantity: 1 }], claimKey: 'f-0' }))).code).toBe('NO_OPEN_VISIT');
  });

  it('挂在会员在店手牌的账单上、进厨房出品单、写送到哪张桌；经办人「小程序」；同一个 claimKey 再调用返回那一单', async () => {
    visit = await checkIn(guest.id);
    const r = await order({
      memberId: guest.id,
      items: [
        { itemId: item['宫保鸡丁']!, quantity: 2, note: '少辣' },
        { itemId: item['柠檬茶']!, quantity: 1 },
      ],
      tableCode: 'a8',
      expectedTotal: 4800 * 2 + 1500,
      claimKey: 'f-1',
    });
    expect(r).toMatchObject({ replayed: false, visitId: visit.visitId, tagCode: visit.code, total: 11100, deliverTo: 'A8' });
    expect(r.orderNo).toMatch(/^CD/);
    expect(r.lines.map((l) => [l.name, l.quantity, l.amount, l.note])).toEqual([
      ['宫保鸡丁', 2, 9600, '少辣'],
      ['柠檬茶', 1, 1500, ''],
    ]);
    const kitchen = (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body.items as { orderNo: string; deliverTo: string; postedByName: string; status: string }[];
    const mine = kitchen.filter((k) => k.orderNo === r.orderNo);
    expect(mine).toHaveLength(2);
    expect(mine.every((k) => k.deliverTo === 'A8' && k.postedByName === '小程序' && k.status === 'queued')).toBe(true);
    const again = await order({
      memberId: guest.id,
      items: [
        { itemId: item['宫保鸡丁']!, quantity: 2, note: '少辣' },
        { itemId: item['柠檬茶']!, quantity: 1 },
      ],
      tableCode: 'a8',
      expectedTotal: 4800 * 2 + 1500,
      claimKey: 'f-1',
    });
    expect(again).toMatchObject({ replayed: true, orderNo: r.orderNo, total: 11100 });
    expect(again.lines.map((l) => l.lineId)).toEqual(r.lines.map((l) => l.lineId));
    const bill = (await mpOpenBill(ctx.sql, guest.id))!;
    expect(bill).toMatchObject({ visitId: visit.visitId, tagCode: visit.code, total: 11100 });
    expect(bill.lines.map((l) => [l.name, l.dishStatus])).toEqual([
      ['宫保鸡丁', 'queued'],
      ['柠檬茶', 'queued'],
    ]);
    expect((await errorOf(order({ memberId: guest.id, items: [{ itemId: item['柠檬茶']!, quantity: 3 }], claimKey: 'f-1' }))).code).toBe('MP_CLAIM_CONFLICT');
    expect(await mpDiningTables(ctx.sql)).toEqual([{ id: tableId, name: 'A8', area: '餐厅' }]);
    await allChecksOk();
  });

  it('两个事务同时用同一个 claimKey 下单：只下一单', async () => {
    const input: MpFoodInput = { memberId: guest.id, items: [{ itemId: item['柠檬茶']!, quantity: 1 }], claimKey: 'f-race' };
    const [a, b] = await Promise.all([order(input), order(input)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.orderNo).toBe(b.orderNo);
    const [n] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bill_lines WHERE post_key = (SELECT ref_key FROM entry_claims WHERE claim_key = 'mp_food:f-race')`;
    expect(n!.n).toBe(1);
  });

  it('只能点进厨房的菜；份数、金额有上限；估清不够、桌号不对、价格变了都拒绝，账单不变', async () => {
    const bill = async () => (await mpOpenBill(ctx.sql, guest.id))!.total;
    const before = await bill();
    const reject = async (input: Omit<MpFoodInput, 'memberId'>) => (await errorOf(order({ memberId: guest.id, ...input }))).code;
    expect(await reject({ items: [{ itemId: item['一次性拖鞋']!, quantity: 1 }], claimKey: 'f-x1' })).toBe('DISH_NOT_KITCHEN');
    expect(await reject({ items: [{ itemId: item['柠檬茶']!, quantity: 21 }], claimKey: 'f-x2' })).toBe('BAD_REQUEST');
    expect(await reject({ items: [{ itemId: item['宫保鸡丁']!, quantity: 11 }], claimKey: 'f-x3' })).toBe('MP_ORDER_LIMIT');
    expect(await reject({ items: [{ itemId: item['柠檬茶']!, quantity: 1 }], tableCode: 'Z9', claimKey: 'f-x4' })).toBe('TABLE_NOT_FOUND');
    expect(await reject({ items: [{ itemId: item['柠檬茶']!, quantity: 1 }], expectedTotal: 1400, claimKey: 'f-x5' })).toBe('PRICE_CHANGED');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['宫保鸡丁']}`, { remaining: 1 })).status).toBe(200);
    expect(await reject({ items: [{ itemId: item['宫保鸡丁']!, quantity: 2 }], claimKey: 'f-x6' })).toBe('DISH_SOLD_OUT');
    expect(await bill()).toBe(before);
    expect((await ctx.sql`SELECT 1 FROM entry_claims WHERE claim_key LIKE 'mp_food:f-x%'`).length).toBe(0);
    // 估清剩 1 份：点 1 份可以，扣成 0
    const ok = await order({ memberId: guest.id, items: [{ itemId: item['宫保鸡丁']!, quantity: 1 }], claimKey: 'f-x7' });
    expect(ok.total).toBe(4800);
    const menu = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body.dishes as { id: number; remaining: number | null }[];
    expect(menu.find((d) => d.id === item['宫保鸡丁'])?.remaining).toBe(0);
    await allChecksOk();
  });

  it('结账离店以后：NO_OPEN_VISIT，「我的账单」为空', async () => {
    const lonely = await member('没开手牌的会员', 0);
    expect(await mpOpenBill(ctx.sql, lonely.id)).toBeNull();
    expect((await errorOf(order({ memberId: lonely.id, items: [{ itemId: item['柠檬茶']!, quantity: 1 }], claimKey: 'f-none' }))).code).toBe('NO_OPEN_VISIT');
  });
});
