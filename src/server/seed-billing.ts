// 结账与交班（S3 / Batch 3）合成演示数据，建在前台演示数据（seed-frontdesk-demo）之上：
//   ① 散客现金结账（12 小时档）；② 会员与朋友同行合并结账（24 小时档）：会员储值 + 美团券 + 微信；
//   ③ 亲子：成人 + 1 米以下儿童免票，支付宝；④ 过夜 26 小时（24 小时档 + 12 小时档），银行卡；
//   ⑤ 现金结账后发现收款方式记错：值班经理反结账，改为微信重新结账；
//   ⑥ 收银员陈茵开班（备用金 500 元）并交班（实点短款 10 元）；值班经理张经理当班中。
// 固定预期结果见 demo/billing-expected.json。
//
// 只用于独立的演示 / 开发库：试用与正式环境一律拒绝；需要先执行 seed-frontdesk-demo；已经灌过则跳过。
// 所有业务都走正式的接待、挂账、结账、反结账、开班交班流程，账单、收款与会员钱包天然一致。
// 时间相对执行时刻生成：请在营业日切换时刻（默认 06:00）之后 1 小时以上执行，演示单据才都落在同一个营业日。

import { randomUUID } from 'node:crypto';
import { splitDeduction } from '@shared/deduction';
import type { Zone } from '@shared/frontdesk';
import type { AppConfig } from './config';
import type { Sql } from './db';
import type { Actor, Deps, OpContext } from './lib/context';
import { postCharges } from './modules/frontdesk/bills';
import { checkout, previewCheckout, voidCheckout, type CheckoutInputData } from './modules/frontdesk/checkout';
import { checkin } from './modules/frontdesk/visits';
import { createMember } from './modules/members';
import { loadSettings } from './modules/settings';
import { closeShift, shiftSummary, startShift } from './modules/shifts';
import { createStaff } from './modules/staff';
import { recharge } from './modules/wallet';
import { DEMO_ITEMS, DEMO_PASSWORD } from './seed';

const NOTE = '结账演示';
const MEMBER = { name: '沈先生（演示）', phone: '19900008811', paid: 200000, bonus: 30000 };
/** 迁移 014 内置的票价（店主 #31）；演示库里被改过时停止，避免预期结果对不上 */
const TICKETS: Record<string, [number, number]> = {
  不含餐: [49900, 59900],
  含餐门票: [69900, 89900],
  全日自助餐: [99900, 119900],
  '儿童免票（1 米以下）': [0, 0],
};

export async function seedBillingDemo(sql: Sql, config: AppConfig, options: { now?: Date } = {}) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入结账演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [demo] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags WHERE is_synthetic`;
  if (!demo!.n) throw new Error('请先执行 seed-frontdesk-demo（结账演示建在前台演示数据上）');
  const [done] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM checkouts WHERE note = ${NOTE}`;
  if (done!.n > 0) return { skipped: true as const };
  const types = await sql<{ id: number; name: string; price12h: number; price24h: number }[]>`SELECT id, name, price_12h, price_24h FROM ticket_types`;
  const ticket = new Map(types.map((t) => [t.name, t.id]));
  for (const [name, [p12, p24]] of Object.entries(TICKETS)) {
    const t = types.find((x) => x.name === name);
    if (!t || t.price12h !== p12 || t.price24h !== p24) throw new Error(`票种「${name}」的票价与演示设定不同，请使用新的独立演示库`);
  }
  const settings = await loadSettings(sql);
  if (settings.deductionRule !== 'principal_first') throw new Error('演示预期按「先本金，后赠金」的扣款规则计算，请使用新的独立演示库');

  const deps: Deps = { sql, config };
  const actor = async (username: string): Promise<Actor> => {
    const [row] = await sql<{ id: number; displayName: string; role: Actor['role'] }[]>`SELECT id, display_name, role FROM staff WHERE username = ${username}`;
    if (!row) throw new Error(`缺少演示账号 ${username}，请先执行 seed-frontdesk-demo`);
    return { id: row.id, username, displayName: row.displayName, role: row.role, duties: [], mustChangePassword: false };
  };
  const owner = await actor('linlan');
  const clerk = await actor('xiaozhou');
  const duty = await actor('zhangjl');
  // 收银员：专门用于结账演示，交班表只含她经办的单据，预期结果固定
  const [c] = await sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'chenyin'`;
  const cashierId = c?.id ?? (await createStaff(sql, { username: 'chenyin', displayName: '陈茵', role: 'clerk', password: DEMO_PASSWORD, mustChangePassword: false }));
  const cashier: Actor = { id: cashierId, username: 'chenyin', displayName: '陈茵', role: 'clerk', duties: [], mustChangePassword: false };

  // 演示会员：正式充值（店主自定赠金）
  const [found] = await sql<{ id: number; isSynthetic: boolean }[]>`SELECT id, is_synthetic FROM members WHERE phone = ${MEMBER.phone}`;
  if (found && !found.isSynthetic) throw new Error(`手机号 ${MEMBER.phone} 属于真实会员，已停止`);
  let memberId = found?.id;
  if (!memberId) {
    memberId = (await createMember(sql, { name: MEMBER.name, phone: MEMBER.phone, gender: 'male', birthday: null, note: '结账演示会员' }, { actor: owner }, { enforceRequired: false })).id;
    await sql`UPDATE members SET is_synthetic = true WHERE id = ${memberId}`;
    await recharge(deps, { idempotencyKey: randomUUID(), memberId, planId: null, paidAmount: MEMBER.paid, bonusAmount: MEMBER.bonus, paymentMethod: 'wechat', paymentConfirmed: true }, { actor: owner });
  }

  const now = options.now ?? new Date();
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const as = (a: Actor, minAgo: number): OpContext => ({ actor: a, at: ago(minAgo) });
  const items = new Map((await sql<{ id: number; name: string }[]>`SELECT id, name FROM service_items`).map((r) => [r.name, r.id]));
  const price = (name: string) => DEMO_ITEMS.find((i) => i.name === name)!.price;
  const charge = (visitId: number, lines: [string, number][], ctx: OpContext) =>
    postCharges(deps, visitId, { clientKey: randomUUID(), lines: lines.map(([n, q]) => ({ itemId: items.get(n)!, quantity: q })), expectedTotal: lines.reduce((s, [n, q]) => s + price(n) * q, 0) }, ctx);
  const open = async (guests: { tagCode: string; zone: Zone; ticket: string; guestLabel?: string; memberId?: number }[], ctx: OpContext) =>
    (await checkin(deps, { clientKey: randomUUID(), guests: guests.map(({ ticket: t, ...g }) => ({ memberId: null, guestLabel: '', ticketTypeId: ticket.get(t)!, ...g })) }, ctx)).visits.map((v) => v.id);
  /** 按结账那一刻的门票核对应收，再结账 */
  const pay = async (visitIds: number[], payments: CheckoutInputData['payments'], ctx: OpContext) => {
    const preview = await previewCheckout(deps, visitIds, ctx.at);
    const total = preview.totalAmount;
    const filled = payments!.map((p) => (p.amount === 0 ? { ...p, amount: total - payments!.reduce((s, x) => s + x.amount, 0) } : p));
    return checkout(deps, { clientKey: randomUUID(), visitIds, expectedTotal: total, payments: filled, note: NOTE }, ctx);
  };

  // 交班：陈茵 5 小时前开班（备用金 500 元）；张经理 1 小时前开班
  const cashierShift = await startShift(deps, { openingCash: 50000 }, as(cashier, 300));
  await startShift(deps, { openingCash: 0 }, as(duty, 60));

  // ① 散客现金：在店 2 小时 40 分，不含餐 12 小时档 499 + 气泡水 22 = 521
  const [s1] = await open([{ tagCode: 'A8065', zone: 'male', ticket: '不含餐', guestLabel: '散客甲' }], as(clerk, 180));
  await charge(s1!, [['柚子气泡水', 1]], as(clerk, 170));
  await pay([s1!], [{ method: 'cash', amount: 0 }], as(cashier, 20));

  // ② 会员沈先生与朋友同行，在店 12 小时 45 分（24 小时档）：全日自助餐 1199 + 精油按摩 298 + 含餐门票 899 = 2396；
  //    会员储值 1200（先本金）+ 美团券 899 + 微信 297
  const group = await open(
    [
      { tagCode: 'A8066', zone: 'male', ticket: '全日自助餐', memberId },
      { tagCode: 'A8067', zone: 'male', ticket: '含餐门票', guestLabel: '朋友' },
    ],
    as(clerk, 780),
  );
  await charge(group[0]!, [['精油按摩 60 分钟', 1]], as(clerk, 600));
  const split = splitDeduction(120000, { principal: MEMBER.paid, bonus: MEMBER.bonus }, 'principal_first');
  if (!split.ok) throw new Error('演示会员余额不足');
  await pay(
    group,
    [
      { method: 'wallet', memberId, amount: 120000, expectedSplit: { principal: split.principal, bonus: split.bonus } },
      { method: 'coupon', platform: 'meituan', code: 'MT2026102900001', dealName: '含餐门票 24 小时', amount: 89900 },
      { method: 'wechat', amount: 0, ref: '尾号 6618' },
    ],
    as(cashier, 15),
  );

  // ③ 亲子：爸爸不含餐 499 + 孩子（1 米以下）免票，支付宝
  const family = await open(
    [
      { tagCode: 'A8068', zone: 'male', ticket: '不含餐', guestLabel: '爸爸' },
      { tagCode: 'A8069', zone: 'male', ticket: '儿童免票（1 米以下）', guestLabel: '孩子' },
    ],
    as(clerk, 150),
  );
  await pay(family, [{ method: 'alipay', amount: 0 }], as(cashier, 10));

  // ④ 过夜客：在店 25 小时 52 分（24 小时档 + 12 小时档 = 599 + 499）+ 山野简餐 ×2 = 1194，银行卡
  const [s4] = await open([{ tagCode: 'A8070', zone: 'male', ticket: '不含餐', guestLabel: '过夜客' }], as(clerk, 1560));
  await charge(s4!, [['山野简餐', 2]], as(clerk, 900));
  await pay([s4!], [{ method: 'bank_card', amount: 0 }], as(cashier, 8));

  // ⑤ 现金结账后发现客人实际用微信付的：值班经理反结账，改为微信重新结账（不含餐 499 + 搓背 58 = 557）
  const [s5] = await open([{ tagCode: 'A8071', zone: 'male', ticket: '不含餐', guestLabel: '散客乙' }], as(clerk, 100));
  await charge(s5!, [['搓背', 1]], as(clerk, 90));
  const wrong = await pay([s5!], [{ method: 'cash', amount: 0 }], as(cashier, 30));
  await voidCheckout(deps, wrong.id, { reason: '收款方式记错，客人实际用微信支付' }, as(duty, 25));
  await pay([s5!], [{ method: 'wechat', amount: 0 }], as(cashier, 24));

  // ⑥ 陈茵交班：应有现金 = 备用金 500 + 现金结账 521 = 1021；实点 1011（短款 10 元）
  const summary = await shiftSummary(sql, cashier.id, cashierShift.startedAt, ago(2), cashierShift.openingCash);
  await closeShift(deps, cashierShift.id, { countedCash: summary.cash.expected - 1000, expectedCash: summary.cash.expected, note: '演示：短款 10 元，找零时多找' }, as(cashier, 2));

  const [stats] = await sql<{ checkouts: number; voided: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'completed') AS checkouts, count(*) FILTER (WHERE status = 'voided') AS voided FROM checkouts WHERE note = ${NOTE}`;
  return { skipped: false as const, checkouts: stats!.checkouts, voided: stats!.voided };
}
