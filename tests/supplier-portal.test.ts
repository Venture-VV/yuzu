// 8.0.21 供应商门户（docs/FINANCE_V8021.md 第 7 节，CW-F / CW6；迁移 147）：报价、订单确认、发货预告三种链接。
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { shiftDate } from '../src/shared/labels';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let buyer: string;
let keeper: string;
const q = (n: number) => Math.round(n * 1000);

const supplier = async (code: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body.find((s: { code: string }) => s.code === code);
const material = async (code: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1')).body.find((m: { code: string }) => m.code === code);
const pub = (token: string) => ctx.app.inject({ method: 'GET', url: `/api/public/supplier/${token}` });
const reply = (token: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/api/public/supplier/${token}/reply`, payload: body, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
}, 120_000);
afterAll(async () => ctx.close());

describe('报价链接', () => {
  it('发给一家 → 供应商打开看询价单、填报价 → 替他登记一份报价（来源记链接）；再报一次撤下旧的；原样重提只记一次；定标以后不能再报', async () => {
    const [s1, s2] = [await supplier('S002'), await supplier('S004')];
    const mat = await material('M016');
    const ev = (await api(ctx.app, buyer, 'POST', '/api/purchase-sourcing', { clientKey: randomUUID(), title: '门户报价 10 箱', needBy: today, lines: [{ materialId: mat.id, purchaseQtyMilli: q(10) }] })).body.event;
    // 只有能编制采购单的能发；物资经办只能看
    expect((await api(ctx.app, keeper, 'POST', `/api/purchase-sourcing/${ev.id}/supplier-links`, { supplierId: s1.id })).status).toBe(403);
    const made = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/supplier-links`, { supplierId: s1.id });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const token = made.body.token as string;
    expect(made.body.link).toMatchObject({ kind: 'quote', supplierId: s1.id, replies: 0, voidedAt: null });
    // 库里只存摘要
    expect((await ctx.sql`SELECT 1 FROM supplier_links WHERE token_hash = ${token}`).length).toBe(0);

    const view = await pub(token);
    expect(view.statusCode).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.json()).toMatchObject({ kind: 'quote', open: true, quote: null, snapshot: { docNo: ev.docNo, supplierName: s1.name, lines: [{ materialName: mat.name, purchaseQtyMilli: q(10) }] } });
    const lineId = view.json().snapshot.lines[0].lineId;

    const body = { clientKey: randomUUID(), name: '王经理', prices: [{ lineId, priceCents: 42_000 }], freightCents: 2_000, payTerms: '月结 30 天', creditDays: 30, deliveryDays: 3, validUntil: shiftDate(today, 10), note: '含税' };
    expect((await reply(token, { ...body, name: '' })).statusCode).toBe(400);
    expect((await reply(token, { ...body, prices: [] })).statusCode).toBe(400);
    const r1 = await reply(token, body);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().quote).toMatchObject({ goodsCents: 420_000, freightCents: 2_000, viaLink: true });
    // 没收到结果再点一次：只记一次；同一个编号内容不同拒绝
    expect((await reply(token, body)).statusCode).toBe(200);
    expect((await reply(token, { ...body, freightCents: 0 })).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    let detail = (await api(ctx.app, buyer, 'GET', `/api/purchase-sourcing/${ev.id}`)).body;
    expect(detail.quotes.filter((x: { status: string }) => x.status === 'active')).toHaveLength(1);
    expect(detail.quotes[0]).toMatchObject({ supplier: { id: s1.id }, viaLink: true, createdByName: '周一（采购）' });

    // 再报一次（降价）：旧的撤下、登记新的
    const r2 = await reply(token, { ...body, clientKey: randomUUID(), prices: [{ lineId, priceCents: 40_000 }] });
    expect(r2.json().quote).toMatchObject({ goodsCents: 400_000 });
    detail = (await api(ctx.app, buyer, 'GET', `/api/purchase-sourcing/${ev.id}`)).body;
    expect(detail.quotes.map((x: { status: string; goodsCents: number; withdrawReason: string | null }) => [x.status, x.goodsCents, x.withdrawReason])).toEqual([
      ['withdrawn', 420_000, '供应商通过报价链接重新报价'],
      ['active', 400_000, null],
    ]);
    const links = (await api(ctx.app, keeper, 'GET', `/api/purchase-sourcing/${ev.id}/supplier-links`)).body;
    expect(links[0]).toMatchObject({ replies: 2, lastReplyName: '王经理' });

    // 重发：旧链接作废、打不开
    const again = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/supplier-links`, { supplierId: s1.id });
    expect((await pub(token)).statusCode).toBe(404);
    const token2 = again.body.token as string;
    expect((await pub(token2)).json().quote).toMatchObject({ goodsCents: 400_000 });

    // 第二家员工登记、定标以后链接显示已结束，不能再报
    await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/quotes`, { clientKey: randomUUID(), supplierId: s2.id, payTerms: '现付', prices: [{ lineId, priceCents: 45_000 }] });
    const quoteId = detail.quotes.find((x: { status: string }) => x.status === 'active').id;
    const awarded = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/award`, { quoteId, reason: '链接报价最低' });
    expect(awarded.status, JSON.stringify(awarded.body)).toBe(200);
    expect((await pub(token2)).json()).toMatchObject({ open: false, closedReason: expect.stringContaining('询价已经结束') });
    expect((await reply(token2, { ...body, clientKey: randomUUID() })).json().error.code).toBe('LINK_CLOSED');
    // 定标以后不能再发
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/supplier-links`, { supplierId: s1.id })).body.error.code).toBe('INVALID_STATE');
    // 回复只追加
    await expect(ctx.sql`UPDATE supplier_link_replies SET reply_name = 'x'`).rejects.toThrow(/只追加/);
  });
});

describe('订单确认与发货预告', () => {
  it('已确认的采购单发确认链接 → 供应商确认、承诺到货日（流程图用承诺日）→ 发货预告可以分批 → 不能超过下单数量；作废以后打不开', async () => {
    const s = await supplier('S005');
    const mat = await material('M016');
    const created = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      orderDate: today,
      action: 'submit',
      supplierId: s.id,
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // 合计到了免确认门槛以上时要负责人确认：用店主确认
    const po = created.body.po.status === 'approved' ? created.body.po : (await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${created.body.po.id}/approve`, {})).body;
    expect(po.status, JSON.stringify(po)).toBe('approved');
    // 没确认先发发货预告：拦下
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'delivery' })).body.error.code).toBe('NOT_CONFIRMED');
    const made = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'po_confirm' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const token = made.body.token as string;
    const view = (await pub(token)).json();
    expect(view).toMatchObject({ kind: 'po_confirm', open: true, confirmation: null, snapshot: { docNo: po.docNo, totalCents: 90_000, lines: [{ priceCents: 45_000, amountCents: 90_000 }] } });
    const lineId = view.snapshot.lines[0].lineId;

    expect((await reply(token, { clientKey: randomUUID(), name: '李', promisedDate: shiftDate(today, -1) })).json().error.code).toBe('DATE_PASSED');
    const promised = shiftDate(today, 4);
    const ok = await reply(token, { clientKey: randomUUID(), name: '李', promisedDate: promised, note: '周四送' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ open: false, confirmation: { promisedDate: promised, replyName: '李', note: '周四送' } });
    // 只认第一次
    expect((await reply(token, { clientKey: randomUUID(), name: '李', promisedDate: shiftDate(today, 5) })).json().error.code).toBe('LINK_CLOSED');
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'po_confirm' })).body.error.code).toBe('ALREADY_CONFIRMED');
    // 流程图的到货环节按承诺日
    const flow = (await api(ctx.app, buyer, 'GET', `/api/purchase-flow/po/${po.id}`)).body;
    expect(JSON.stringify(flow)).not.toContain('到货超期');

    // 发货预告：可以分批；不能超过下单数量；不能写别的行
    const dl = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'delivery' });
    const dt = dl.body.token as string;
    expect((await reply(dt, { clientKey: randomUUID(), name: '李', shipDate: today, lines: [{ lineId, qtyMilli: q(3) }] })).json().error.code).toBe('QTY_OVER');
    expect((await reply(dt, { clientKey: randomUUID(), name: '李', shipDate: today, lines: [{ lineId: lineId + 9999, qtyMilli: q(1) }] })).statusCode).toBe(400);
    expect((await reply(dt, { clientKey: randomUUID(), name: '李', shipDate: today, eta: shiftDate(today, -1), lines: [{ lineId, qtyMilli: q(1) }] })).json().error.code).toBe('DATE_ORDER');
    expect((await reply(dt, { clientKey: randomUUID(), name: '李', shipDate: today, eta: shiftDate(today, 1), trackingNo: 'SF123', lines: [{ lineId, qtyMilli: q(1) }] })).statusCode).toBe(200);
    const second = await reply(dt, { clientKey: randomUUID(), name: '李', shipDate: shiftDate(today, 1), lines: [{ lineId, qtyMilli: q(1) }] });
    expect(second.json().notices.map((x: { trackingNo: string; lines: { qtyMilli: number }[] }) => [x.trackingNo, x.lines[0]!.qtyMilli])).toEqual([
      ['SF123', q(1)],
      ['', q(1)],
    ]);

    const portal = (await api(ctx.app, keeper, 'GET', `/api/purchase-orders/${po.id}/supplier-portal`)).body;
    expect(portal.confirmation).toMatchObject({ promisedDate: promised });
    expect(portal.notices).toHaveLength(2);
    expect(portal.links.map((l: { kind: string; replies: number }) => [l.kind, l.replies])).toEqual([
      ['delivery', 2],
      ['po_confirm', 1],
    ]);

    // 作废
    const voided = await api(ctx.app, buyer, 'POST', `/api/purchase-supplier-links/${dl.body.link.id}/void`, {});
    expect(voided.status).toBe(200);
    expect((await pub(dt)).statusCode).toBe(404);
    // 乱写的链接、试太多次限次
    expect((await pub('x'.repeat(30))).statusCode).toBe(404);
  });

  it('采购单改版（换了供应商）：发出去的链接都作废、改版前的确认不算；新供应商重新确认，以新的承诺日为准；版次对不上的链接不能回复', async () => {
    const a = await supplier('S005');
    const b = await supplier('S006');
    const mat = await material('M016');
    const created = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), orderDate: today, action: 'submit', supplierId: a.id, lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let po = created.body.po.status === 'approved' ? created.body.po : (await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${created.body.po.id}/approve`, {})).body;
    expect(po.status).toBe('approved');
    // 甲确认、再发一条发货预告
    const tA = (await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'po_confirm' })).body.token as string;
    expect((await reply(tA, { clientKey: randomUUID(), name: '甲', promisedDate: shiftDate(today, 3) })).statusCode).toBe(200);
    const dA = (await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'delivery' })).body.token as string;
    expect((await pub(dA)).statusCode).toBe(200);
    // 改版换成乙：发给甲的链接都作废
    const rev = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/revise`, { supplierId: b.id, orderDate: today, lines: [{ id: po.lines[0].id, materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }] });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect((await pub(tA)).statusCode).toBe(404);
    expect((await pub(dA)).statusCode).toBe(404);
    po = rev.body.status === 'approved' ? rev.body : (await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${po.id}/approve`, {})).body;
    expect(po).toMatchObject({ status: 'approved', revision: 2 });
    // 改版前的确认不算：可以给乙发确认链接，乙确认以后以乙的承诺日为准
    expect((await api(ctx.app, keeper, 'GET', `/api/purchase-orders/${po.id}/supplier-portal`)).body.confirmation).toBeNull();
    const tB = (await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'po_confirm' })).body.token as string;
    expect((await pub(tB)).json()).toMatchObject({ open: true, confirmation: null, snapshot: { supplierName: b.name, revision: 2 } });
    const promisedB = shiftDate(today, 6);
    const okB = await reply(tB, { clientKey: randomUUID(), name: '乙', promisedDate: promisedB });
    expect(okB.statusCode, okB.body).toBe(200);
    expect((await api(ctx.app, keeper, 'GET', `/api/purchase-orders/${po.id}/supplier-portal`)).body.confirmation).toMatchObject({ promisedDate: promisedB, replyName: '乙' });
    const [cnt] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM po_supplier_confirmations WHERE purchase_order_id = ${po.id}`;
    expect(cnt!.n).toBe(2);
    // 兜底：链接没作废、快照里的版次却对不上（库里直接写一条旧版次的链接）也不能回复
    const dB = 'StaleRevisionLink_' + String(Date.now()).slice(-8);
    const [fresh] = await ctx.sql<{ snapshot: Record<string, unknown>; createdBy: number }[]>`
      SELECT snapshot, created_by FROM supplier_links WHERE purchase_order_id = ${po.id} AND kind = 'po_confirm' ORDER BY id DESC LIMIT 1`;
    await ctx.sql`
      INSERT INTO supplier_links (kind, purchase_order_id, supplier_id, token_hash, snapshot, expires_at, created_by)
      VALUES ('delivery', ${po.id}, ${b.id}, ${createHash('sha256').update(dB).digest('hex')}, ${ctx.sql.json({ ...fresh!.snapshot, revision: 1 } as never)}, now() + interval '1 day', ${fresh!.createdBy})`;
    const stale = (await pub(dB)).json();
    expect(stale).toMatchObject({ open: false });
    expect(stale.closedReason).toContain('改过了');
    const lineId = stale.snapshot.lines[0].lineId;
    expect((await reply(dB, { clientKey: randomUUID(), name: '乙', shipDate: today, lines: [{ lineId, qtyMilli: q(1) }] })).json().error.code).toBe('LINK_CLOSED');
  });

  it('采购模块关着：链接打不开（PORTAL_PAUSED，与作废、过期分开）', async () => {
    const s = await supplier('S005');
    const mat = await material('M016');
    let po = (await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), orderDate: today, action: 'submit', supplierId: s.id, lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 45_000 }] })).body.po;
    if (po.status !== 'approved') po = (await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${po.id}/approve`, {})).body;
    const token = (await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'po_confirm' })).body.token as string;
    const off = await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: { purchasing: false } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    try {
      const closed = await pub(token);
      expect(closed.statusCode).toBe(404);
      expect(closed.json().error.code).toBe('PORTAL_PAUSED');
      expect((await reply(token, { clientKey: randomUUID(), name: '李', promisedDate: today })).json().error.code).toBe('PORTAL_PAUSED');
    } finally {
      expect((await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: { purchasing: true } })).status).toBe(200);
    }
    expect((await pub(token)).statusCode).toBe(200);
  });

  it('原样重提先认原编号：采购模块关着、链接作废以后，登记过的那一份照样返回，不报「没有」（Codex 审查 970c95c 后补）', async () => {
    const s = await supplier('S005');
    const mat = await material('M016');
    let po = (await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), orderDate: today, action: 'submit', supplierId: s.id, lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }] })).body.po;
    if (po.status !== 'approved') po = (await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${po.id}/approve`, {})).body;
    const ct = (await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'po_confirm' })).body.token as string;
    expect((await reply(ct, { clientKey: randomUUID(), name: '李', promisedDate: today })).statusCode).toBe(200);
    const dl = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/supplier-links`, { kind: 'delivery' });
    const dt = dl.body.token as string;
    const lineId = (await pub(dt)).json().snapshot.lines[0].lineId as number;
    const body = { clientKey: randomUUID(), name: '李', shipDate: today, lines: [{ lineId, qtyMilli: q(1) }] };
    // 登记上了（假装回复丢了）
    expect((await reply(dt, body)).statusCode).toBe(200);
    const notices = async () => (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}/supplier-portal`)).body.notices as unknown[];
    expect(await notices()).toHaveLength(1);

    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: { purchasing: false } })).status).toBe(200);
    try {
      // 旧代码：模块关着先报 404「链接不存在」，页面据此清掉本机记着的那一份，再开以后重新填写就记两批
      const again = await reply(dt, body);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().notices).toHaveLength(1);
      // 同一个编号、内容不同：照样拒绝
      expect((await reply(dt, { ...body, shipDate: shiftDate(today, 1) })).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
      // 新的一份：关着，不记
      expect((await reply(dt, { ...body, clientKey: randomUUID() })).json().error.code).toBe('PORTAL_PAUSED');
    } finally {
      expect((await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: { purchasing: true } })).status).toBe(200);
    }
    // 链接作废以后：原样重提照样返回登记过的那一份；新的打不开
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-supplier-links/${dl.body.link.id}/void`, {})).status).toBe(200);
    const afterVoid = await reply(dt, body);
    expect(afterVoid.statusCode, afterVoid.body).toBe(200);
    expect(afterVoid.json().notices).toHaveLength(1);
    expect((await reply(dt, { ...body, clientKey: randomUUID() })).json().error.code).toBe('NOT_FOUND');
    // 别的链接拿这个编号来：不当成它登记过的，照常处理——编号已经用在别的链接上，拒绝
    expect((await reply(ct, { clientKey: body.clientKey, name: '李', promisedDate: today })).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await notices()).toHaveLength(1);
  });
});
