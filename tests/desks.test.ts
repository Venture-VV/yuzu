// 8.1.14 发卡台与收银台（docs/DESKS_V8114.md，PENDING_DECISIONS「8.1.14」FS1–FS14）：
//   · 手牌板带在店会员的档阶与手上此刻能用的券数（发卡台的会员等级识别、收银台清单上的「赠」「券」）；
//   · 结账预览里签赠券写发放人（8.1.9 只写授权人）；
//   · 结账单的「优惠与赠送」：签赠（发放人、授权人、渠道、事由）、手动发的券（发券人、事由）、优惠 / 免单（原因、当场授权的人）各一条，
//     记着抵到哪几行；合计与收款对得上；反结账以后原单照样读得出（券和优惠 / 免单照旧二选一，分两张单验）；
//   · 打印数据的明细行带权益标记；小票上有「优惠与赠送」一栏、「共优惠」「优惠后应付」，「收款」只列真收的钱。
// 两个台是页面上的划分（FS3–FS5）：接口、权限、账务都没改，原来的用例照旧管着；页面上的边界在 e2e/desks.spec.ts。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perkOperatorsText, perksTotal, perkTitle, type CheckoutDetail, type CheckoutPreview } from '../src/shared/checkout';
import type { FrontdeskBoard } from '../src/shared/frontdesk';
import type { GiftIssueResult, GiftType } from '../src/shared/gifts';
import type { CheckoutPrint } from '../src/shared/print';
import { decodePrintedText } from '../src/server/devices/escpos';
import { buildCheckoutSlip } from '../src/server/devices/slips';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string; // 值班经理：签赠授权人、优惠 / 免单当场授权、反结账
let butler: string; // 管家（职责）：发放签赠
let dutyId = 0;
let rubId = 0; // 价目：搓澡 68
let footId = 0; // 价目：足疗 128
let tagNo = 0;
let gift: GiftType;

const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body as FrontdeskBoard;
const visitOn = async (code: string) => (await board()).tags.find((t) => t.code === code)!.visit!;
/** 接待一位客人（会员或散客）、挂几个项目，返回来访 id 与牌号 */
const enter = async (memberId: number | null, itemIds: number[]) => {
  tagNo += 1;
  const code = `K${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', memberId }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  if (itemIds.length > 0) {
    const price = itemIds.reduce((s, i) => s + (i === rubId ? 6800 : 12800), 0);
    const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, {
      clientKey: randomUUID(),
      lines: itemIds.map((itemId) => ({ itemId, quantity: 1 })),
      expectedTotal: price,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return { id, code };
};
const preview = async (visitId: number) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CheckoutPreview;
};
const pay = (visitId: number, total: number, payments: Record<string, unknown>[]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: total, payments });
const detail = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/${id}`)).body as CheckoutDetail;
const print = async (id: number) => {
  const r = await api<CheckoutPrint>(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const slipText = (d: CheckoutPrint) =>
  decodePrintedText(buildCheckoutSlip(d, { storeName: '测试门店', instanceLabel: '演示', production: false, timeZone: 'Asia/Shanghai', issuedAt: new Date(), issuedBy: '测试店员' }));
const issueGift = async (memberId: number, reason: string) => {
  const r = await api(ctx.app, butler, 'POST', '/api/gifts/issues', { clientKey: randomUUID(), memberId, templateId: gift.id, quantity: 1, channel: '管家部', reason, authorizedBy: dutyId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as GiftIssueResult;
};

beforeAll(async () => {
  ctx = await setup();
  dutyId = await createStaff(ctx.sql, { username: 'kduty', displayName: '值班甲', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'kbutler', displayName: '管家丙', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'kduty');
  butler = await login(ctx.app, 'kbutler');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 20, width: 3, zone: 'male' })).status).toBe(200);
  const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '发卡搓澡', category: '发卡洗浴', price: 6800 });
  rubId = a.body.items.find((i: { name: string }) => i.name === '发卡搓澡').id;
  const b = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '发卡足疗', category: '发卡足疗', price: 12800 });
  footId = b.body.items.find((i: { name: string }) => i.name === '发卡足疗').id;
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/gifts/types', {
    clientKey: randomUUID(),
    name: '发卡搓澡券',
    kind: 'exchange',
    exchangeItemId: rubId,
    segment: '浴区',
    content: '送搓澡一次',
    rules: '',
    validity: 'days',
    validDays: 30,
  });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  gift = t.body as GiftType;
});
afterAll(async () => {
  await ctx?.close();
});

describe('手牌板：会员档阶与手上能用的券', () => {
  it('在店会员带档阶、券数、签赠数；L0 不写档阶；散客都是空的；作废的不数', async () => {
    const l4 = await createMember(ctx, '望岳会员');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(l4.id, 5_000_000))).status).toBe(200);
    const l0 = await createMember(ctx, '青溪会员');
    const a = await enter(l4.id, []);
    const b = await enter(l0.id, []);
    const c = await enter(null, []);
    expect(await visitOn(a.code)).toMatchObject({ memberGradeLabel: 'L4 望岳 · 初', coupons: 0, gifts: 0 });
    expect(await visitOn(b.code)).toMatchObject({ memberGradeLabel: null, coupons: 0, gifts: 0 });
    expect(await visitOn(c.code)).toMatchObject({ memberGradeLabel: null, coupons: 0, gifts: 0 });

    // 一张签赠、一张手动发的代金券 → 券 2 张，其中签赠 1 张
    const issued = await issueGift(l4.id, '老客户生日');
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '发卡代金券', kind: 'cash', faceValue: 2000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const manual = await api(ctx.app, ctx.owner, 'POST', `/api/members/${l4.id}/coupons`, { clientKey: randomUUID(), templateId: tpl.body.id, quantity: 1, reason: '回馈' });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    expect(await visitOn(a.code)).toMatchObject({ coupons: 2, gifts: 1 });
    expect(await visitOn(b.code)).toMatchObject({ coupons: 0, gifts: 0 });

    // 作废的不数（只数此刻能用的）
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/gifts/coupons/${issued.coupons[0]!.id}/void`, { reason: '客人不要了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await visitOn(a.code)).toMatchObject({ coupons: 1, gifts: 0 });
    for (const v of [a, b, c]) expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/cancel`, { reason: '开错手牌' })).status).toBe(200);
  });
});

describe('结账单的「优惠与赠送」与经办人', () => {
  let memberId = 0;
  let checkoutId = 0;
  let rubLine = 0;

  it('签赠券：写发放人、授权人、渠道、事由；记着抵到哪一行；小票分「优惠与赠送」和「收款」', async () => {
    memberId = (await createMember(ctx, '收银会员甲')).id;
    const issued = await issueGift(memberId, '老客户生日');
    const v = await enter(memberId, [rubId, footId]);
    const pre = await preview(v.id);
    // 预览：签赠券上写发放人与授权人
    const opt = pre.storeCoupons!.find((c) => c.code === issued.coupons[0]!.code)!;
    expect(opt).toMatchObject({ usable: true, amount: 6800, gift: { issuerName: '管家丙', authorizerName: '值班甲', channel: '管家部', reason: '老客户生日' } });

    const cash = pre.totalAmount - 6800;
    const done = await pay(v.id, pre.totalAmount, [
      { method: 'store_coupon', code: opt.code, amount: 6800 },
      { method: 'cash', amount: cash },
    ]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    checkoutId = done.body.id;

    const d = await detail(checkoutId);
    const p = await print(checkoutId);
    const lines = p.bills[0]!.lines;
    rubLine = lines.find((l) => l.name === '发卡搓澡')!.id;
    const giftPmt = d.payments.find((p) => p.method === 'store_coupon')!;
    expect(d.perks).toEqual([
      {
        paymentId: giftPmt.id,
        kind: 'gift',
        name: '发卡搓澡券',
        amount: 6800,
        detail: '老客户生日',
        channel: '管家部',
        operators: [
          { role: '发放', name: '管家丙' },
          { role: '授权', name: '值班甲' },
        ],
        lineIds: [rubLine],
      },
    ]);
    expect(perkTitle(d.perks[0]!)).toBe('签赠 · 发卡搓澡券');
    expect(perkOperatorsText(d.perks[0]!)).toBe('管家部 · 发放 管家丙 · 授权 值班甲');
    // 优惠与赠送 + 真收的钱 = 应收
    expect(perksTotal(d.perks) + cash).toBe(d.totalAmount);

    // 打印数据：被签赠抵到的那一行带标记，别的行没有
    expect(lines.find((l) => l.id === rubLine)!.perks).toEqual(['gift']);
    expect(lines.filter((l) => l.id !== rubLine).every((l) => l.perks.length === 0)).toBe(true);
    expect(p.perks).toEqual(d.perks);

    // 小票：明细行标「[赠]」；「优惠与赠送」一栏写经办人；「收款」里只有现金
    const text = slipText(p);
    expect(text).toContain('发卡搓澡 [赠]');
    expect(text).not.toContain('发卡足疗 [');
    const perksAt = text.indexOf('优惠与赠送');
    const paidAt = text.indexOf('收款', perksAt);
    expect(perksAt).toBeGreaterThan(text.indexOf('应收合计'));
    expect(paidAt).toBeGreaterThan(perksAt);
    const perksPart = text.slice(perksAt, paidAt);
    expect(perksPart).toContain('签赠 · 发卡搓澡券');
    expect(perksPart).toContain('管家部 · 发放 管家丙 · 授权 值班甲');
    expect(perksPart).toContain('老客户生日');
    // 打印机用的编码里人民币符号是全角的「￥」
    expect(perksPart).toMatch(/签赠 · 发卡搓澡券\s+-[¥￥]68\.00/);
    expect(perksPart).toMatch(/共优惠\s+[¥￥]68\.00/);
    expect(perksPart).toMatch(/优惠后应付\s+[¥￥]/);
    const paidPart = text.slice(paidAt);
    expect(paidPart).toContain('现金');
    expect(paidPart).not.toContain('券抵扣');
  });

  it('反结账以后：原单的优惠与赠送照样读得出（结账时记下的，不随券退回而变）', async () => {
    const back = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '收错了' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const d = await detail(checkoutId);
    expect(d.status).toBe('voided');
    expect(d.perks.map((p) => [p.kind, p.amount, p.operators.map((o) => `${o.role} ${o.name}`).join('、')])).toEqual([['gift', 6800, '发放 管家丙、授权 值班甲']]);
    expect((await print(checkoutId)).bills[0]!.lines.find((l) => l.id === rubLine)!.perks).toEqual(['gift']);
  });

  it('优惠 / 免单：写原因与当场授权的人（不抵到某一行）', async () => {
    const v = await enter(null, [rubId, footId]);
    const pre = await preview(v.id);
    const grant = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', {
      username: 'kduty',
      password: PASSWORD,
      purpose: 'checkout_discount',
      scope: { visitIds: [v.id], amount: 800, reason: '老客人抹零' },
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    const done = await pay(v.id, pre.totalAmount, [
      { method: 'discount', amount: 800, grantId: grant.body.grantId },
      { method: 'cash', amount: pre.totalAmount - 800 },
    ]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const d = await detail(done.body.id);
    const pmt = d.payments.find((p) => p.method === 'discount')!;
    expect(d.perks).toEqual([{ paymentId: pmt.id, kind: 'discount', name: '', amount: 800, detail: '老客人抹零', channel: '', operators: [{ role: '授权', name: '值班甲' }], lineIds: [] }]);
    expect(perkTitle(d.perks[0]!)).toBe('优惠 / 免单');
    const p = await print(done.body.id);
    expect(p.bills[0]!.lines.every((l) => l.perks.length === 0)).toBe(true);
    const text = slipText(p);
    const perksPart = text.slice(text.indexOf('优惠与赠送'), text.indexOf('收款', text.indexOf('优惠与赠送')));
    expect(perksPart).toContain('优惠 / 免单');
    expect(perksPart).toContain('授权 值班甲');
    expect(perksPart).toContain('老客人抹零');
    expect(perksPart).toMatch(/优惠 \/ 免单\s+-[¥￥]8\.00/);
    expect(perksPart).toMatch(/共优惠\s+[¥￥]8\.00/);
    expect(perksPart).toMatch(new RegExp(`优惠后应付\\s+[¥￥]${((pre.totalAmount - 800) / 100).toFixed(2)}`));
    expect(text.slice(text.indexOf('收款', text.indexOf('优惠与赠送')))).not.toContain('优惠 / 免单');
  });

  it('手动发的券写发券人与事由；没用优惠的单没有这一栏，小票照旧', async () => {
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '收银代金券', kind: 'cash', faceValue: 2000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const m = await createMember(ctx, '收银会员乙');
    const sent = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m.id}/coupons`, { clientKey: randomUUID(), templateId: tpl.body.id, quantity: 1, reason: '投诉补偿' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const v = await enter(m.id, [footId]);
    const pre = await preview(v.id);
    const opt = pre.storeCoupons!.find((c) => c.templateName === '收银代金券')!;
    expect(opt).toMatchObject({ usable: true, amount: 2000, gift: null });
    const done = await pay(v.id, pre.totalAmount, [
      { method: 'store_coupon', code: opt.code, amount: 2000 },
      { method: 'cash', amount: pre.totalAmount - 2000 },
    ]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const d = await detail(done.body.id);
    expect(d.perks).toEqual([expect.objectContaining({ kind: 'coupon', name: '收银代金券', amount: 2000, detail: '投诉补偿', channel: '', operators: [{ role: '发券', name: '测试店主' }] })]);
    const text = slipText(await print(done.body.id));
    expect(text).toContain('券抵扣 · 收银代金券');
    expect(text).toContain('发券 测试店主');

    // 散客现金结清：没有「优惠与赠送」
    const plain = await enter(null, [rubId]);
    const pre2 = await preview(plain.id);
    const paid = await pay(plain.id, pre2.totalAmount, [{ method: 'cash', amount: pre2.totalAmount }]);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await detail(paid.body.id)).perks).toEqual([]);
    const plainText = slipText(await print(paid.body.id));
    expect(plainText).not.toContain('优惠与赠送');
    expect(plainText).not.toContain('共优惠');
    expect(plainText).toContain('收款');
  });

  it('前台自检全部通过（只读的新字段没有动账）', async () => {
    for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
      expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    }
  });
});
