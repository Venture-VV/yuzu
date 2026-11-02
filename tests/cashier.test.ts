// 收银完善第一步（v0.7.6，见 docs/CASHIER.md）：结账时的部门营业额快照（优惠按金额比例分摊，分以下的尾差按最大余数补）、
// 改分类不影响已结的单、反结账按原快照冲回；明细转到另一张手牌（权限与作废明细相同、不能转的明细、幂等、查回、自检）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import type { Actor } from '../src/server/lib/context';
import { moveLines, postCharges } from '../src/server/modules/frontdesk/bills';
import { checkout, previewCheckout } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let clerk2: string;
let today: string;
const item: Record<string, number> = {};

const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
  const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
  for (const c of st.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};
/** 接待一位客人（默认票种），返回来访 id */
const enter = async (tagCode: string, zone: 'male' | 'female' = 'male') => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const post = async (visitId: number, lines: { itemId: number; quantity: number }[], expectedTotal: number, cookie = ctx.clerk) => {
  const r = await api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines, expectedTotal });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { lines: { id: number; name: string; status: string; amount: number }[]; bill: { amountCents: number } };
};
const visit = async (id: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body as {
    status: string;
    bill: { amountCents: number };
    lines: { id: number; name: string; status: string; amount: number; voidReason: string | null; postedByName: string }[];
  };
const preview = async (visitIds: number[]) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitIds.join(',')}`)).body as { totalAmount: number };
const items = async (checkoutId: number) =>
  ctx.sql<{ category: string; quantity: number; amount: number; discount: number }[]>`
    SELECT category, quantity, amount::int AS amount, discount::int AS discount FROM checkout_items WHERE checkout_id = ${checkoutId} ORDER BY category COLLATE "C", name COLLATE "C"`;
const departments = async () =>
  ((await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).body as {
    departments: { category: string; quantity: number; amount: number; discount: number }[];
  }).departments;
const move = (body: Record<string, unknown>, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/lines/move', { clientKey, reason: '挂错手牌', ...body });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'clerk2', displayName: '店员二', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  clerk2 = await login(ctx.app, 'clerk2');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'C', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'W', from: 1, to: 10, width: 3, zone: 'female' })).status).toBe(200);
  for (const [name, category, price, gender] of [
    ['快照搓澡', '快照洗浴', 6800, null],
    ['快照修脚', '快照足疗', 5000, null],
    ['快照私汤', '快照洗浴', 8800, 'female'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price, gender });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
});
afterAll(async () => ctx.close());

describe('部门营业额快照（结账时记下）', () => {
  let checkoutId: number;

  it('各部门金额与优惠分摊：优惠按金额比例分到分，尾差按舍去部分从大到小补 1 分；合计等于结账金额与优惠', async () => {
    const v = await enter('C001');
    await post(v, [{ itemId: item['快照搓澡']!, quantity: 1 }, { itemId: item['快照修脚']!, quantity: 1 }], 11800);
    const total = (await preview([v])).totalAmount;
    expect(total).toBe(49900 + 11800);
    const grant = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', {
      username: 'duty',
      password: PASSWORD,
      purpose: 'checkout_discount',
      scope: { visitIds: [v], amount: 1000, reason: '老客人抹零' },
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v],
      expectedTotal: total,
      payments: [{ method: 'discount', amount: 1000, grantId: grant.body.grantId }, { method: 'cash', amount: total - 1000 }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    checkoutId = paid.body.id;
    // 49900 × 1000 / 61700 = 808.75、6800 × … = 110.21、5000 × … = 81.03：先各取 808、110、81（合计 999），差的 1 分补给舍去最多的门票
    expect(await items(checkoutId)).toEqual([
      { category: '快照洗浴', quantity: 1, amount: 6800, discount: 110 },
      { category: '快照足疗', quantity: 1, amount: 5000, discount: 81 },
      { category: '门票', quantity: 1, amount: 49900, discount: 809 },
    ]);
    const dept = await departments();
    expect(dept.find((d) => d.category === '快照洗浴')).toEqual({ category: '快照洗浴', quantity: 1, amount: 6800, discount: 110, refund: 0 });
    expect(dept.find((d) => d.category === '快照足疗')).toEqual({ category: '快照足疗', quantity: 1, amount: 5000, discount: 81, refund: 0 });
    await checks();
  });

  it('三项金额相同、优惠除不尽：尾差按分类、项目名的顺序逐项补，分摊合计正好等于优惠、每项不超过它的金额', async () => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '快照果盘', category: '快照水吧', price: 49900 });
    item['快照果盘'] = r.body.items.find((i: { name: string }) => i.name === '快照果盘').id;
    const r2 = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '快照茶点', category: '快照水吧', price: 49900 });
    item['快照茶点'] = r2.body.items.find((i: { name: string }) => i.name === '快照茶点').id;
    const v = await enter('C002');
    await post(v, [{ itemId: item['快照果盘']!, quantity: 1 }, { itemId: item['快照茶点']!, quantity: 1 }], 99800);
    const total = (await preview([v])).totalAmount;
    expect(total).toBe(3 * 49900);
    const grant = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', {
      username: 'duty',
      password: PASSWORD,
      purpose: 'checkout_discount',
      scope: { visitIds: [v], amount: 200, reason: '抹零' },
    });
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v],
      expectedTotal: total,
      payments: [{ method: 'discount', amount: 200, grantId: grant.body.grantId }, { method: 'cash', amount: total - 200 }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const rows = await ctx.sql<{ category: string; name: string; discount: number }[]>`
      SELECT category, name, discount::int AS discount FROM checkout_items WHERE checkout_id = ${paid.body.id} ORDER BY category COLLATE "C", name COLLATE "C"`;
    // 200 / 3 = 66.67：各取 66（合计 198），尾差 2 分按分类、项目名顺序补给「快照水吧」的两项
    expect(rows.map((x) => [x.category, x.name, x.discount])).toEqual([
      ['快照水吧', '快照果盘', 67],
      ['快照水吧', '快照茶点', 67],
      ['门票', expect.stringContaining('门票'), 66],
    ]);
    await checks();
  });

  it('改项目分类不影响已结的单，之后结的按新分类；反结账按原快照冲回', async () => {
    const before = await departments();
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${item['快照搓澡']}`, { name: '快照搓澡', category: '快照搓澡部', price: 6800 })).status).toBe(200);
    expect(await departments()).toEqual(before);
    const v = await enter('C003');
    await post(v, [{ itemId: item['快照搓澡']!, quantity: 2 }], 13600);
    const total = (await preview([v])).totalAmount;
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [v], expectedTotal: total, payments: [{ method: 'cash', amount: total }] });
    expect(paid.status).toBe(200);
    const after = await departments();
    expect(after.find((d) => d.category === '快照洗浴')).toEqual(before.find((d) => d.category === '快照洗浴'));
    expect(after.find((d) => d.category === '快照搓澡部')).toEqual({ category: '快照搓澡部', quantity: 2, amount: 13600, discount: 0, refund: 0 });
    // 反结账第一张（有优惠的）：当天的部门营业额按它的快照冲回，优惠分摊一起冲回
    const voided = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '收款方式记错' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const back = await departments();
    expect(back.find((d) => d.category === '快照洗浴')).toBeUndefined();
    expect(back.find((d) => d.category === '快照足疗')).toBeUndefined();
    expect(back.find((d) => d.category === '快照搓澡部')).toEqual({ category: '快照搓澡部', quantity: 2, amount: 13600, discount: 0, refund: 0 });
    // 对账包的部门参考表：应收、优惠分摊合计与日结一致
    const { buildDailyRecon } = await import('../src/server/ops/recon');
    const recon = await buildDailyRecon(ctx.sql, ctx.config, today);
    const dept = recon.files.find((f) => f.name === '03-部门参考表.csv')!.content;
    expect(dept.split('\n')[0]).toContain('优惠分摊（元）');
    expect(dept).toMatch(/核对,一致/);
    await checks();
  });
});

describe('明细转到另一张手牌（转单）', () => {
  let from: number;
  let to: number;
  let scrubLine: number;
  let footLine: number;

  it('把挂错手牌的明细转过去：原明细作废并写明转到哪张手牌，目标账单新增同样的明细；同一编号重提只转一次', async () => {
    from = await enter('C010');
    to = await enter('C011');
    const posted = await post(from, [{ itemId: item['快照搓澡']!, quantity: 2 }, { itemId: item['快照修脚']!, quantity: 1 }], 18600);
    scrubLine = posted.lines.find((l) => l.name === '快照搓澡')!.id;
    footLine = posted.lines.find((l) => l.name === '快照修脚')!.id;
    const key = randomUUID();
    const r = await move({ lineIds: [scrubLine], toTagCode: 'c011' }, ctx.clerk, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = await visit(from);
    const b = await visit(to);
    expect(a.bill.amountCents).toBe(5000);
    expect(a.lines.find((l) => l.id === scrubLine)).toMatchObject({ status: 'voided', voidReason: '转到手牌 C011：挂错手牌' });
    expect(b.bill.amountCents).toBe(13600);
    expect(b.lines.filter((l) => l.status === 'active').map((l) => [l.name, l.amount, l.postedByName])).toEqual([['快照搓澡', 13600, '测试店员']]);
    // 同一编号原样重提：返回原结果，不重复转
    const again = await move({ lineIds: [scrubLine], toTagCode: 'c011' }, ctx.clerk, key);
    expect(again.status).toBe(200);
    expect((await visit(to)).bill.amountCents).toBe(13600);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_line_moves WHERE from_line_id = ${scrubLine}`;
    expect(n!.n).toBe(1);
    // 结果待确认的查回：按编号查到原客人
    const lookup = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}`);
    expect(lookup.body).toMatchObject({ found: true, type: 'line_move', visit: { id: from } });
    await checks();
  });

  it('不能转：已作废的、目标手牌不在店或就是这位客人、限女宾的项目转给男宾；别人挂的明细店员不能转，值班经理可以', async () => {
    expect((await move({ lineIds: [scrubLine], toTagCode: 'C011' })).body.error.code).toBe('ALREADY_VOIDED');
    expect((await move({ lineIds: [footLine], toTagCode: 'C039' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    expect((await move({ lineIds: [footLine], toTagCode: 'C010' })).status).toBe(400);
    expect((await move({ lineIds: [footLine], toTagCode: 'C011', reason: '错' })).status).toBe(400);
    expect((await move({ lineIds: [], toTagCode: 'C011' })).status).toBe(400);
    const w = await enter('W001', 'female');
    const spa = await post(w, [{ itemId: item['快照私汤']!, quantity: 1 }], 8800);
    expect((await move({ lineIds: [spa.lines[0]!.id], toTagCode: 'C011' })).body.error.code).toBe('ITEM_GENDER');
    // 店员二不能转店员一挂的；值班经理（有「前台更正」）可以
    expect((await move({ lineIds: [footLine], toTagCode: 'C011' }, clerk2)).status).toBe(403);
    const ok = await move({ lineIds: [footLine], toTagCode: 'C011' }, duty);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await visit(from)).bill.amountCents).toBe(0);
    expect((await visit(to)).bill.amountCents).toBe(18600);
    await checks();
  });

  it('转过来的明细随目标手牌结账，进部门快照；原客人照常结门票', async () => {
    const total = (await preview([to])).totalAmount;
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [to], expectedTotal: total, payments: [{ method: 'cash', amount: total }] });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await items(paid.body.id)).map((x) => [x.category, x.amount])).toEqual([
      ['快照搓澡部', 13600],
      ['快照足疗', 5000],
      ['门票', 49900],
    ]);
    const total2 = (await preview([from])).totalAmount;
    expect(total2).toBe(49900);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [from], expectedTotal: total2, payments: [{ method: 'cash', amount: total2 }] })).status).toBe(200);
    // 已结账的客人：不能再转
    const v = await enter('C012');
    const posted = await post(v, [{ itemId: item['快照修脚']!, quantity: 1 }], 5000);
    expect((await move({ lineIds: [posted.lines[0]!.id], toTagCode: 'C011' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    await checks();
  });
});

describe('代码审查的修正（v0.7.6）', () => {
  const deps = () => ({ sql: ctx.sql, config: ctx.config });
  const owner = (): Actor => ({ id: ctx.ownerId, username: 'owner', displayName: '测试店主', role: 'owner', duties: [], mustChangePassword: false });
  const M = 60_000;
  /** 等到有会话卡在匹配的语句上等锁 */
  const waitForLockWait = async (pattern: string) => {
    for (let i = 0; i < 100; i++) {
      const rows = await ctx.sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`等待锁超时：${pattern}`);
  };

  it('补录到更早时刻的结账：之后才转走的明细不算进它的部门快照（按这一刻要结的有效明细记），转过去的那位结账时只算一次', async () => {
    const now = Date.now();
    const enterAt = async (tagCode: string) =>
      (await checkin(deps(), { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] }, { actor: owner(), at: new Date(now - 50 * M) })).visits[0]!.id;
    const a = await enterAt('C025');
    const b = await enterAt('C026');
    // 40 分钟前挂一项，20 分钟前转给 C026；A 的结账补录在 30 分钟前（早于转单）
    const posted = await postCharges(deps(), a, { clientKey: randomUUID(), lines: [{ itemId: item['快照修脚']!, quantity: 1 }], expectedTotal: 5000 }, { actor: owner(), at: new Date(now - 40 * M) });
    const lineId = posted.lines.find((l) => l.status === 'active')!.id;
    await moveLines(deps(), { clientKey: randomUUID(), lineIds: [lineId], toTagCode: 'C026', reason: '挂错手牌' }, { actor: owner(), at: new Date(now - 20 * M) });
    const at = new Date(now - 30 * M);
    const pre = await previewCheckout(deps(), [a], at);
    expect(pre.totalAmount).toBe(49900);
    const paid = await checkout(deps(), { clientKey: randomUUID(), visitIds: [a], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] }, { actor: owner(), at });
    expect((await items(paid.id)).map((x) => [x.category, x.amount])).toEqual([['门票', 49900]]);
    const total = (await preview([b])).totalAmount;
    const paidB = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [b], expectedTotal: total, payments: [{ method: 'cash', amount: total }] });
    expect(paidB.status, JSON.stringify(paidB.body)).toBe(200);
    expect((await items(paidB.body.id)).map((x) => [x.category, x.amount])).toEqual([
      ['快照足疗', 5000],
      ['门票', 49900],
    ]);
    await checks();
  });

  it('转单时目标客人刚在别的终端换了牌：锁好来访后核对牌号，对不上就拒绝（TAG_CHANGED），明细不动', async () => {
    const a = await enter('C030');
    const b = await enter('C031');
    const posted = await post(a, [{ itemId: item['快照修脚']!, quantity: 1 }], 5000);
    // 转单读到 C031 的客人之后卡在这位客人的来访锁上；这时这位客人换到 C032（模拟另一台终端的换牌）并提交
    const conn = await ctx.sql.reserve();
    await conn.unsafe('BEGIN');
    await conn`SELECT id FROM visits WHERE id = ${b} FOR UPDATE`;
    const moving = moveLines(deps(), { clientKey: randomUUID(), lineIds: [posted.lines[0]!.id], toTagCode: 'C031', reason: '挂错手牌' }, { actor: owner() }).then(
      () => null,
      (e: unknown) => e,
    );
    try {
      await waitForLockWait('%FROM visits WHERE id IN%');
      await conn`UPDATE visits SET tag_id = (SELECT id FROM hand_tags WHERE code = 'C032') WHERE id = ${b}`;
      await conn.unsafe('COMMIT');
    } finally {
      conn.release();
    }
    expect(await moving).toMatchObject({ status: 409, code: 'TAG_CHANGED' });
    expect((await visit(a)).bill.amountCents).toBe(5000);
    expect((await visit(b)).bill.amountCents).toBe(0);
  });

  it('前一天带优惠的结账今天反结账、按同样的项目换了优惠重结：只差优惠的部门照样列出，优惠的变动不丢', async () => {
    // 直接写两张结账单与快照（只核对报表的口径；放在最后，之后不再跑自检）
    const yesterday = shiftDate(today, -1);
    const [old] = await ctx.sql<{ id: number }[]>`
      INSERT INTO checkouts (checkout_no, client_key, status, total_amount, paid_amount, business_date, operator_id, created_at,
                             voided_at, voided_by, void_reason, void_business_date)
      VALUES ('JZ-TEST-OLD', ${randomUUID()}, 'voided', 10000, 10000, ${yesterday}, ${ctx.ownerId}, now() - interval '1 day',
              now(), ${ctx.ownerId}, '测试：换了优惠重结', ${today})
      RETURNING id`;
    const [fresh] = await ctx.sql<{ id: number }[]>`
      INSERT INTO checkouts (checkout_no, client_key, total_amount, paid_amount, business_date, operator_id, created_at)
      VALUES ('JZ-TEST-NEW', ${randomUUID()}, 10000, 10000, ${today}, ${ctx.ownerId}, now())
      RETURNING id`;
    await ctx.sql`
      INSERT INTO checkout_items (checkout_id, category, name, quantity, amount, discount)
      VALUES (${old!.id}, '换优惠测试', '项目甲', 1, 10000, 500), (${fresh!.id}, '换优惠测试', '项目甲', 1, 10000, 800)`;
    expect((await departments()).find((d) => d.category === '换优惠测试')).toEqual({ category: '换优惠测试', quantity: 0, amount: 0, discount: 300, refund: 0 });
  });
});
