// 8.1.17 前台（docs/FRONTDESK_V8117.md）：
//   · BW-12「流水」的订单详情：与结账单同一个部件——接口带上「优惠与赠送」与经办人、每一行的「赠」「券」「折」、所属部门与摊到的优惠；
//     「流水」的权限照旧（查看当日流水、历史营业日）。
// 退菜按出品口在 tests/dining-voids-v8117.test.ts，桌台提醒在 tests/tables-reminders-v8117.test.ts，本店价在 tests/store-prices-v8117.test.ts。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { CheckoutOrderDetail } from '../src/shared/orders';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
let footId = 0;
let rubId = 0;

/** 接待一位客人、挂几个项目，返回来访 id 与牌号 */
const enter = async (memberId: number | null, items: { id: number; price: number }[]) => {
  tagNo += 1;
  const code = `F${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', memberId }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  if (items.length > 0) {
    const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, {
      clientKey: randomUUID(),
      lines: items.map((i) => ({ itemId: i.id, quantity: 1 })),
      expectedTotal: items.reduce((s, i) => s + i.price, 0),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return { id, code };
};

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '流水足疗', category: '流水足疗部', price: 12800 });
  footId = a.body.items.find((i: { name: string }) => i.name === '流水足疗').id;
  const b = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '流水搓澡', category: '流水洗浴部', price: 6800 });
  rubId = b.body.items.find((i: { name: string }) => i.name === '流水搓澡').id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('BW-12「流水」的订单详情与结账单同一写法', () => {
  let checkoutId = 0;

  it('接口带「优惠与赠送」与经办人；抵到的行标「券」，每一行有所属部门与摊到的优惠，合起来等于这笔优惠', async () => {
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '流水代金券', kind: 'cash', faceValue: 3000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const m = await createMember(ctx, '流水会员甲');
    const sent = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m.id}/coupons`, { clientKey: randomUUID(), templateId: tpl.body.id, quantity: 1, reason: '投诉补偿' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const v = await enter(m.id, [
      { id: footId, price: 12800 },
      { id: rubId, price: 6800 },
    ]);
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v.id}`)).body as CheckoutPreview;
    const opt = pre.storeCoupons!.find((c) => c.templateName === '流水代金券')!;
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.id],
      expectedTotal: pre.totalAmount,
      payments: [
        { method: 'store_coupon', code: opt.code, amount: 3000 },
        { method: 'cash', amount: pre.totalAmount - 3000 },
      ],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    checkoutId = done.body.id;

    const r = await api<CheckoutOrderDetail>(ctx.app, ctx.clerk, 'GET', `/api/ledger/orders/checkouts/${checkoutId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { doc, source } = r.body;
    expect(source).toBe('lines');
    // 结账单部件要的：收银、「优惠与赠送」（名称、事由、经办人）
    expect(doc.operatorName).toBe('测试店员');
    expect(doc.perks).toEqual([expect.objectContaining({ kind: 'coupon', name: '流水代金券', amount: 3000, detail: '投诉补偿', operators: [{ role: '发券', name: '测试店主' }] })]);
    const perk = doc.perks[0]!;
    const lines = doc.bills.flatMap((b) => b.lines);
    expect(
      lines
        .filter((l) => l.category !== '门票')
        .map((l) => l.name)
        .sort(),
    ).toEqual(['流水搓澡', '流水足疗']);
    // 行上的标记：券抵到的行标「券」，别的行不标
    for (const l of lines) expect(l.perks).toEqual(perk.lineIds.includes(l.id) ? ['coupon'] : []);
    expect(lines.some((l) => l.perks.includes('coupon'))).toBe(true);
    // 所属部门、摊到这一行的优惠（与「流水」原来的逐行一致，合起来等于这笔券）
    expect(Object.fromEntries(lines.filter((l) => l.category !== '门票').map((l) => [l.name, l.category]))).toEqual({ 流水足疗: '流水足疗部', 流水搓澡: '流水洗浴部' });
    expect(lines.filter((l) => l.category === '门票')).toHaveLength(1);
    expect(lines.reduce((s, l) => s + (l.discount ?? 0), 0)).toBe(3000);
    expect(r.body.discount).toBe(3000);
  });

  it('「流水」的权限照旧：没有「查看当日流水」的岗位看不到；打印的那一份不带「流水」才有的两项', async () => {
    await createStaff(ctx.sql, { username: 'fkitchen', displayName: '后厨甲', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    const kitchen = await login(ctx.app, 'fkitchen');
    expect((await api(ctx.app, kitchen, 'GET', `/api/ledger/orders/checkouts/${checkoutId}`)).status).toBe(403);
    const p = await api(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${checkoutId}`);
    expect(p.status).toBe(200);
    for (const l of p.body.bills.flatMap((b: { lines: Record<string, unknown>[] }) => b.lines)) {
      expect(l).not.toHaveProperty('category');
      expect(l).not.toHaveProperty('discount');
    }
  });
});
