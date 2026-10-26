// S2 到店与未结手牌：手牌状态机、男女分区防呆、同行绑牌、共同账单挂账与更正、换牌、
// 并发抢牌 / 并发改账单、幂等，以及「挂账不碰会员钱包」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let items: { bath: number; scrub: number; tea: number; old: number };

beforeAll(async () => {
  ctx = await setup();
  for (const [zone, prefix] of [['male', 'A'], ['female', 'B'], ['child', 'C']] as const) {
    const res = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix, from: 1, to: 30, width: 3, zone });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  }
  const mk = async (name: string, price: number, active = true) => {
    const res = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '洗浴', price, active });
    return res.body.items.find((i: { name: string }) => i.name === name).id as number;
  };
  items = { bath: await mk('汤泉门票', 12800), scrub: await mk('搓澡', 6800), tea: await mk('菊花茶', 1800), old: await mk('停用项目', 1000, false) };
});
afterAll(async () => ctx.close());

const checkin = (cookie: string, guests: unknown[], extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests, ...extra });
const post = (cookie: string, visitId: number, lines: { itemId: number; quantity: number }[], expectedTotal: number, extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines, expectedTotal, ...extra });
const visit = async (id: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/visits/${id}`)).body;
const openOnTag = async (code: string) => {
  const [row] = await ctx.sql<{ n: number }[]>`
    SELECT count(*) AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${code} AND v.status = 'open'`;
  return row!.n;
};
const walletFingerprint = async () => {
  const [row] = await ctx.sql<{ p: number; b: number; le: number; c: number; r: number }[]>`
    SELECT (SELECT coalesce(sum(principal_balance), 0) FROM members) AS p, (SELECT coalesce(sum(bonus_balance), 0) FROM members) AS b,
           (SELECT count(*) FROM ledger_entries) AS le, (SELECT count(*) FROM consumptions) AS c, (SELECT count(*) FROM reversals) AS r`;
  return row!;
};

describe('手牌池与男女分区防呆', () => {
  it('批量建牌：重复牌号跳过；店员不能建牌', async () => {
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 29, to: 31, width: 3, zone: 'male' });
    expect(again.body).toMatchObject({ created: 1, skipped: ['A029', 'A030'] });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Z', from: 1, to: 2, width: 1, zone: 'male' })).status).toBe(403);
  });

  it('男宾牌不能发给女宾；儿童牌只发儿童', async () => {
    const r1 = await checkin(ctx.clerk, [{ tagCode: 'A001', zone: 'female' }]);
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe('ZONE_MISMATCH');
    expect(r1.body.error.message).toContain('男宾牌');
    const r2 = await checkin(ctx.clerk, [{ tagCode: 'C001', zone: 'male' }]);
    expect(r2.body.error.code).toBe('ZONE_MISMATCH');
    expect(await openOnTag('A001')).toBe(0);
  });

  it('牌号不存在、已锁定、已停用都不能发出；牌号大小写与空格自动规范', async () => {
    expect((await checkin(ctx.clerk, [{ tagCode: 'A999', zone: 'male' }])).body.error.code).toBe('TAG_NOT_FOUND');
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    const a028 = board.tags.find((t: { code: string }) => t.code === 'A028');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${a028.id}/lock`, { reason: '柜锁故障' })).status).toBe(200);
    const locked = await checkin(ctx.clerk, [{ tagCode: 'a028', zone: 'male' }]);
    expect(locked.body.error.code).toBe('TAG_LOCKED');
    // 店员能锁，不能解锁
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${a028.id}/unlock`)).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a028.id}/unlock`)).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${a028.id}`, { zone: 'male', active: false })).status).toBe(200);
    expect((await checkin(ctx.clerk, [{ tagCode: 'A028', zone: 'male' }])).body.error.code).toBe('TAG_INACTIVE');
    const ok = await checkin(ctx.clerk, [{ tagCode: ' a027 ', zone: 'male' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.visits[0].tagCode).toBe('A027');
  });

  it('后勤岗位看不到前台', async () => {
    await createStaff(ctx.sql, { username: 'store', displayName: '库管', role: 'backoffice', duties: ['stock'], password: PASSWORD, mustChangePassword: false });
    const store = await login(ctx.app, 'store');
    expect((await api(ctx.app, store, 'GET', '/api/frontdesk/board')).status).toBe(403);
  });
});

describe('接待发牌：一牌一人与幂等', () => {
  it('同一操作编号重复提交只开一张牌；同编号换内容拒绝', async () => {
    const body = { clientKey: randomUUID(), guests: [{ tagCode: 'A002', zone: 'male', guestLabel: '王先生' }] };
    const first = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body);
    const second = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.visits[0].visitNo).toBe(first.body.visits[0].visitNo);
    expect(await openOnTag('A002')).toBe(1);
    const other = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { ...body, guests: [{ tagCode: 'A003', zone: 'male' }] });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 超时后按操作编号查回
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${body.clientKey}`);
    expect(found.body).toMatchObject({ found: true, type: 'checkin' });
    expect(found.body.checkin.visits[0].tagCode).toBe('A002');
  });

  it('在店手牌不能再发给第二位客人', async () => {
    const r = await checkin(ctx.clerk, [{ tagCode: 'A002', zone: 'male' }]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TAG_OCCUPIED');
    expect(r.body.error.message).toContain('A002');
  });

  it('两台终端同时抢同一张手牌（不同操作编号 × 8）：只有一位客人拿到', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => checkin(i % 2 ? ctx.clerk : ctx.owner, [{ tagCode: 'A004', zone: 'male' }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'TAG_OCCUPIED')).toBe(true);
    expect(results.filter((r) => r.status !== 201)).toHaveLength(7);
    expect(await openOnTag('A004')).toBe(1);
  });

  it('同一请求里两位客人用同一张牌、或同一会员两张牌，直接拒绝', async () => {
    expect((await checkin(ctx.clerk, [{ tagCode: 'A005', zone: 'male' }, { tagCode: 'A005', zone: 'male' }])).status).toBe(400);
    const m = await createMember(ctx, '双牌会员', '19900005001');
    expect((await checkin(ctx.clerk, [{ tagCode: 'A005', zone: 'male', memberId: m.id }, { tagCode: 'A006', zone: 'male', memberId: m.id }])).status).toBe(400);
  });

  it('会员同时只能持一张在店手牌', async () => {
    const m = await createMember(ctx, '在店会员', '19900005002');
    expect((await checkin(ctx.clerk, [{ tagCode: 'B001', zone: 'female', memberId: m.id }])).status).toBe(201);
    const again = await checkin(ctx.clerk, [{ tagCode: 'B002', zone: 'female', memberId: m.id }]);
    expect(again.body.error.code).toBe('MEMBER_IN_STORE');
    expect(again.body.error.message).toContain('B001');
  });
});

describe('同行绑牌', () => {
  it('一家三口一次接待：自动建同行组，可查同组全部手牌', async () => {
    const r = await checkin(ctx.clerk, [
      { tagCode: 'A010', zone: 'male', guestLabel: '爸爸' },
      { tagCode: 'B010', zone: 'female', guestLabel: '妈妈' },
      { tagCode: 'C010', zone: 'child', guestLabel: '孩子' },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.groupNo).toMatch(/^TX\d{8}-\d{4}$/);
    const v = await visit(r.body.visits[1].id);
    expect(v.group.mates.map((m: { tagCode: string }) => m.tagCode)).toEqual(['A010', 'B010', 'C010']);
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    const card = board.tags.find((t: { code: string }) => t.code === 'C010');
    expect(card.visit).toMatchObject({ groupNo: r.body.groupNo, groupOpenCount: 3, guestLabel: '孩子' });
  });

  it('后到的朋友加入已在店客人的同行；退出后两人组自动解散', async () => {
    const a = (await checkin(ctx.clerk, [{ tagCode: 'A011', zone: 'male' }])).body.visits[0].id;
    const b = (await checkin(ctx.clerk, [{ tagCode: 'A012', zone: 'male' }], {})).body.visits[0].id;
    const joined = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b}/group`, { action: 'join', targetVisitId: a });
    expect(joined.status).toBe(200);
    expect(joined.body.group.mates).toHaveLength(2);
    // 重复点击加入不重复记录
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b}/group`, { action: 'join', targetVisitId: a });
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM visit_group_events WHERE visit_id = ${b}`)[0]!;
    expect(n).toBe(1);
    const left = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b}/group`, { action: 'leave' });
    expect(left.body.group).toBeNull();
    expect((await visit(a)).group).toBeNull();
    // 接待时直接加入在店客人的同行
    const c = await checkin(ctx.clerk, [{ tagCode: 'A013', zone: 'male' }], { joinVisitId: a });
    expect(c.body.groupNo).toBeTruthy();
    expect((await visit(a)).group.groupNo).toBe(c.body.groupNo);
  });
});

describe('共同账单：挂账、价格快照与更正', () => {
  let vid: number;
  beforeAll(async () => {
    vid = (await checkin(ctx.clerk, [{ tagCode: 'A015', zone: 'male' }])).body.visits[0].id;
  });

  it('挂账只写手牌账单：价格随明细留存，后续改价不影响', async () => {
    const r = await post(ctx.clerk, vid, [{ itemId: items.bath, quantity: 1 }, { itemId: items.tea, quantity: 2 }], 12800 + 3600);
    expect(r.status).toBe(200);
    expect(r.body.bill).toMatchObject({ amountCents: 16400, lineCount: 2, status: 'open' });
    await api(ctx.app, ctx.owner, 'PUT', `/api/items/${items.tea}`, { name: '菊花茶', category: '洗浴', price: 2200, active: true });
    const v = await visit(vid);
    expect(v.lines.find((l: { name: string }) => l.name === '菊花茶')).toMatchObject({ unitPrice: 1800, quantity: 2, amount: 3600, source: 'bath' });
  });

  it('按旧价格确认的挂账被拒绝（改价后需重新确认）', async () => {
    const r = await post(ctx.clerk, vid, [{ itemId: items.tea, quantity: 1 }], 1800);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PRICE_CHANGED');
    expect(r.body.error.details.total).toBe(2200);
  });

  it('停用项目不能挂；手动金额需要权限', async () => {
    expect((await post(ctx.clerk, vid, [{ itemId: items.old, quantity: 1 }], 1000)).body.error.code).toBe('ITEM_UNAVAILABLE');
    const custom = await post(ctx.clerk, vid, [], 500, { customLines: [{ name: '毛巾加购', amount: 500 }] });
    expect(custom.status).toBe(200);
    expect(custom.body.bill.amountCents).toBe(16900);
  });

  it('同一挂账编号重复或并发提交，只形成一组明细', async () => {
    const body = { clientKey: randomUUID(), lines: [{ itemId: items.scrub, quantity: 1 }], expectedTotal: 6800 };
    const results = await Promise.all(Array.from({ length: 6 }, () => api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${vid}/charges`, body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const v = await visit(vid);
    expect(v.lines.filter((l: { name: string }) => l.name === '搓澡')).toHaveLength(1);
    expect(v.bill.amountCents).toBe(16900 + 6800);
  });

  it('两台终端同时往同一张账单挂不同项目：合计与明细一致', async () => {
    const before = (await visit(vid)).bill.amountCents;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post(i % 2 ? ctx.clerk : ctx.owner, vid, [{ itemId: items.bath, quantity: 1 }], 12800)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const v = await visit(vid);
    expect(v.bill.amountCents).toBe(before + 6 * 12800);
    const active = v.lines.filter((l: { status: string }) => l.status === 'active');
    expect(active.reduce((s: number, l: { amount: number }) => s + l.amount, 0)).toBe(v.bill.amountCents);
  });

  it('作废必须填原因；店员可作废本人刚登记的明细，不能作废他人的', async () => {
    const v = await visit(vid);
    const mine = v.lines.find((l: { name: string; status: string }) => l.name === '毛巾加购');
    const owners = v.lines.find((l: { postedByName: string }) => l.postedByName === '测试店主');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${mine.id}/void`, { reason: '' })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${owners.id}/void`, { reason: '项目选错' })).status).toBe(403);
    const ok = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${mine.id}/void`, { reason: '顾客取消' });
    expect(ok.status).toBe(200);
    expect(ok.body.bill.amountCents).toBe(v.bill.amountCents - 500);
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${mine.id}/void`, { reason: '重复登记' });
    expect(again.body.error.code).toBe('ALREADY_VOIDED');
    const after = await visit(vid);
    expect(after.lines.find((l: { id: number }) => l.id === mine.id)).toMatchObject({ status: 'voided', voidReason: '顾客取消', voidedByName: '测试店员' });
    expect(after.history.some((h: { kind: string }) => h.kind === 'void')).toBe(true);
  });

  it('超过自行更正时限后，店员要找店主', async () => {
    const r = await post(ctx.clerk, vid, [{ itemId: items.scrub, quantity: 1 }], 6800);
    const line = r.body.lines.at(-1);
    await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 0 });
    const denied = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '项目选错' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('0 分钟');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '项目选错' })).status).toBe(200);
    await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 10 });
  });

  it('数据库层：明细不能改金额、不能删除', async () => {
    const [line] = await ctx.sql<{ id: number }[]>`SELECT id FROM bill_lines WHERE status = 'active' LIMIT 1`;
    await expect(ctx.sql`UPDATE bill_lines SET unit_price = 1, amount = quantity WHERE id = ${line!.id}`).rejects.toThrow(/只能作废/);
    await expect(ctx.sql`DELETE FROM bill_lines WHERE id = ${line!.id}`).rejects.toThrow(/禁止删除/);
  });
});

describe('换牌与释放', () => {
  it('换牌：账单跟着客人走，原牌可锁定；新牌也要分区一致、空闲', async () => {
    const v = (await checkin(ctx.clerk, [{ tagCode: 'B015', zone: 'female' }])).body.visits[0].id;
    await post(ctx.clerk, v, [{ itemId: items.scrub, quantity: 1 }], 6800);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, { clientKey: randomUUID(), toTagCode: 'A016', reason: '手牌丢失' })).body.error.code).toBe('ZONE_MISMATCH');
    await checkin(ctx.clerk, [{ tagCode: 'B016', zone: 'female' }]);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, { clientKey: randomUUID(), toTagCode: 'B016', reason: '手牌丢失' })).body.error.code).toBe('TAG_OCCUPIED');
    const body = { clientKey: randomUUID(), toTagCode: 'B017', reason: '手牌丢失', lockOld: true };
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, body);
    expect(r.status).toBe(200);
    expect(r.body.tag.code).toBe('B017');
    expect(r.body.bill.amountCents).toBe(6800);
    expect(r.body.history.some((h: { text: string }) => h.text.includes('B015 → B017'))).toBe(true);
    // 重复提交不重复换牌
    const again = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, body);
    expect(again.status).toBe(200);
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM visit_tag_changes WHERE visit_id = ${v}`)[0]!;
    expect(n).toBe(1);
    // 丢失的原牌已锁定，不能再发出
    expect((await checkin(ctx.clerk, [{ tagCode: 'B015', zone: 'female' }])).body.error.code).toBe('TAG_LOCKED');
  });

  it('两位客人同时换到同一张空闲牌：只有一位成功', async () => {
    const v1 = (await checkin(ctx.clerk, [{ tagCode: 'A020', zone: 'male' }])).body.visits[0].id;
    const v2 = (await checkin(ctx.clerk, [{ tagCode: 'A021', zone: 'male' }])).body.visits[0].id;
    const [r1, r2] = await Promise.all([
      api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v1}/swap`, { clientKey: randomUUID(), toTagCode: 'A022', reason: '手牌损坏' }),
      api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/visits/${v2}/swap`, { clientKey: randomUUID(), toTagCode: 'A022', reason: '手牌损坏' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await openOnTag('A022')).toBe(1);
  });

  it('在店手牌不能锁定、停用（先换牌）', async () => {
    await checkin(ctx.clerk, [{ tagCode: 'A014', zone: 'male' }]);
    const board = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/board')).body;
    const tag = board.tags.find((t: { code: string }) => t.code === 'A014');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${tag.id}/lock`, { reason: '暂停使用' })).body.error.code).toBe('TAG_IN_USE');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${tag.id}`, { zone: 'male', active: false })).body.error.code).toBe('TAG_IN_USE');
  });

  it('有未结消费时禁止直接释放手牌；明细作废后可撤销误开的牌', async () => {
    const v = (await checkin(ctx.clerk, [{ tagCode: 'A024', zone: 'male' }])).body.visits[0].id;
    const r = await post(ctx.clerk, v, [{ itemId: items.bath, quantity: 1 }], 12800);
    const blocked = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/cancel`, { reason: '开错手牌' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BILL_UNSETTLED');
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${r.body.lines[0].id}/void`, { reason: '挂错手牌' });
    const ok = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/cancel`, { reason: '开错手牌' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'cancelled', closeReason: '开错手牌', bill: { status: 'cancelled' } });
    expect(await openOnTag('A024')).toBe(0);
    // 已撤销的来访不能再挂账、换牌
    expect((await post(ctx.clerk, v, [{ itemId: items.tea, quantity: 1 }], 2200)).body.error.code).toBe('VISIT_CLOSED');
    // 牌已释放，可以发给下一位
    expect((await checkin(ctx.clerk, [{ tagCode: 'A024', zone: 'male' }])).status).toBe(201);
    // 数据库层：已撤销账单不能再挂明细
    const [bill] = await ctx.sql<{ billId: number }[]>`SELECT bill_id FROM visits WHERE id = ${v}`;
    await expect(ctx.sql`
      INSERT INTO bill_lines (bill_id, source, name, unit_price, quantity, amount, post_key, business_date, posted_by)
      VALUES (${bill!.billId}, 'bath', '绕过', 100, 1, 100, ${randomUUID()}, CURRENT_DATE, ${ctx.ownerId})`).rejects.toThrow(/账单已结束/);
  });

  it('同时「挂账」与「撤销」：不会出现挂在已撤销账单上的消费', async () => {
    for (let i = 0; i < 5; i++) {
      const v = (await checkin(ctx.clerk, [{ tagCode: 'A025', zone: 'male' }])).body.visits[0].id;
      const [p, c] = await Promise.all([
        post(ctx.owner, v, [{ itemId: items.bath, quantity: 1 }], 12800),
        api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/cancel`, { reason: '开错手牌' }),
      ]);
      const after = await visit(v);
      if (c.status === 200) {
        expect(p.status).toBe(409);
        expect(after.lines).toHaveLength(0);
      } else {
        expect(p.status).toBe(200);
        expect(after.status).toBe('open');
        await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${after.lines[0].id}/void`, { reason: '测试清理' });
        await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/visits/${v}/cancel`, { reason: '测试清理' });
      }
    }
  });

  it('店员超时后不能撤销他人开的牌', async () => {
    const v = (await checkin(ctx.owner, [{ tagCode: 'A026', zone: 'male' }])).body.visits[0].id;
    const denied = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/cancel`, { reason: '开错手牌' });
    expect(denied.status).toBe(403);
  });
});

describe('预结账、自检与会员钱包边界', () => {
  it('同行组预结账：按手牌和来源汇总，S2 不收款', async () => {
    const r = await checkin(ctx.clerk, [{ tagCode: 'A030', zone: 'male' }, { tagCode: 'B030', zone: 'female' }]);
    const [a, b] = r.body.visits.map((v: { id: number }) => v.id);
    await post(ctx.clerk, a, [{ itemId: items.bath, quantity: 1 }, { itemId: items.scrub, quantity: 1 }], 12800 + 6800);
    await post(ctx.clerk, b, [{ itemId: items.bath, quantity: 1 }], 12800);
    const p = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/preview?ids=${a},${b}`);
    expect(p.status).toBe(200);
    expect(p.body.totalCents).toBe(12800 * 2 + 6800);
    expect(p.body.visits.map((v: { tagCode: string; amountCents: number }) => [v.tagCode, v.amountCents])).toEqual([['A030', 19600], ['B030', 12800]]);
    expect(p.body.bySource).toEqual([{ source: 'bath', amountCents: 32400 }]);
    expect((await visit(a)).group.openAmountCents).toBe(32400);
  });

  it('会员接待、挂账、换牌、同行、作废全程：会员余额与流水一条都不变', async () => {
    const m = await createMember(ctx, '钱包边界', '19900005099');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 10000))).status).toBe(200);
    const before = await walletFingerprint();
    const r = await checkin(ctx.clerk, [{ tagCode: 'A018', zone: 'male', memberId: m.id }, { tagCode: 'A019', zone: 'male' }]);
    const [mine, friend] = r.body.visits.map((v: { id: number }) => v.id);
    const p = await post(ctx.clerk, mine, [{ itemId: items.bath, quantity: 2 }], 25600);
    await post(ctx.clerk, friend, [{ itemId: items.scrub, quantity: 1 }], 6800);
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${p.body.lines[0].id}/void`, { reason: '数量录错' });
    await post(ctx.clerk, mine, [{ itemId: items.bath, quantity: 1 }], 12800);
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${mine}/swap`, { clientKey: randomUUID(), toTagCode: 'A023', reason: '柜锁故障' });
    const detail = await visit(mine);
    expect(detail.member).toMatchObject({ name: '钱包边界', principalBalance: 100000, bonusBalance: 10000 });
    expect(detail.bill.amountCents).toBe(12800);
    expect(await walletFingerprint()).toEqual(before);
  });

  it('自检全部通过；人为篡改账单合计会被发现', async () => {
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body;
    for (const c of checks) expect(c, c.label).toMatchObject({ ok: true });
    const [b] = await ctx.sql<{ id: number }[]>`SELECT id FROM bills WHERE status = 'open' AND amount_cents > 0 LIMIT 1`;
    await ctx.sql`UPDATE bills SET amount_cents = amount_cents + 1 WHERE id = ${b!.id}`;
    const broken = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body;
    expect(broken.find((c: { key: string }) => c.key === 'bill_amount_vs_lines').ok).toBe(false);
    await ctx.sql`UPDATE bills SET amount_cents = amount_cents - 1 WHERE id = ${b!.id}`;
    // 会员日结自检同样全绿
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
    const st = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`);
    for (const c of st.body.checks) expect(c, c.label).toMatchObject({ ok: true });
  });

  it('状态板统计与在店手牌一致', async () => {
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    const inStore = board.tags.filter((t: { visit: unknown }) => t.visit);
    expect(board.stats.inStore).toBe(inStore.length);
    expect(board.stats.unsettledCents).toBe(inStore.reduce((s: number, t: { visit: { amountCents: number } }) => s + t.visit.amountCents, 0));
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM visits WHERE status = 'open'`)[0]!;
    expect(inStore).toHaveLength(n);
  });
});
