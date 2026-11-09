// 8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md，需求表 11 项）按需求表的验收口径逐项核对：
//   P0-02 VIP 柜归「会员权益」；P0-03 次卡停售、已售照用；P1-04 充值当日储值消费比例（充 10 万当天最多用 7 万）；
//   P1-05 标签；P1-06 批量发券（圈 100 人全部到账、短信与会员端提醒、重提不重发）；P1-07 充值记录与消费记录（合计与明细一致）；
//   P2-08 使用率（核销 ÷ 发放）；P2-09 买一赠一（抵最便宜的一份、赠品自动出库、反结账冲销）；
//   P2-10 营销成本（实核：用了几张抵多少）；P2-11 与财务隔离（有财务职责的账号看不到）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rateText, usageRate, type CouponUsage } from '../src/shared/coupon-usage';
import { evaluateCoupon, type CouponTemplate } from '../src/shared/coupons';
import type { MarketingCost } from '../src/shared/marketing-cost';
import { birthdayDueYear } from '../src/shared/membership';
import { permissionsOf } from '../src/shared/permissions';
import { spendRatio } from '../src/shared/member-records';
import { listMemberNotices, markMemberNoticeRead } from '../src/server/modules/member-notices';
import { aliyunSign, sendPendingSms } from '../src/server/modules/sms';
import { processGiftOuts } from '../src/server/modules/gift-outs';
import { runBenefitsDaily } from '../src/server/modules/benefits';
import { createStaff } from '../src/server/modules/staff';
import { api, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let am: string;
let duty: string;
let manager: string;
let finance: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};

const yuan = (n: number) => Math.round(n * 100);
const template = async (body: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), validity: 'days', validDays: 30, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CouponTemplate;
};
const issue = async (memberId: number, templateId: number, quantity = 1) => {
  const r = await api(ctx.app, am, 'POST', `/api/members/${memberId}/coupons`, { clientKey: randomUUID(), templateId, quantity, reason: '整改验收' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};
const memberCoupons = async (memberId: number) =>
  ((await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/coupons`)).body as { coupons: { code: string; templateId: number; state: string }[] }).coupons;
/** 接待一位客人（可带会员）、挂项目，返回来访 id */
const enter = async (lines: { itemId: number; quantity: number; price: number }[], memberId?: number) => {
  tagNo += 1;
  const code = `W${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', ...(memberId ? { memberId } : {}) }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, {
    clientKey: randomUUID(),
    lines: lines.map(({ itemId, quantity }) => ({ itemId, quantity })),
    expectedTotal: lines.reduce((s, l) => s + l.price * l.quantity, 0),
  });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return id;
};
const preview = async (visitId: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body as {
    totalAmount: number;
    storeCoupons: { code: string; usable: boolean; amount: number; reason: string | null; templateName: string }[];
  };
/** 用一张券结账（其余现金），返回结账单 id */
const payWithCoupon = async (visitId: number, code: string, amount: number) => {
  const pre = await preview(visitId);
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: pre.totalAmount,
    payments: [{ method: 'store_coupon', code, amount }, ...(pre.totalAmount > amount ? [{ method: 'cash', amount: pre.totalAmount - amount }] : [])],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as number;
};
const usage = async (query = `from=${today}&to=${today}`, cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', `/api/coupons/usage?${query}`)).body as CouponUsage;
const cost = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', `/api/marketing-cost?from=${today}&to=${today}`)).body as MarketingCost;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'mgr', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'fin', displayName: '财务小周', role: 'backoffice', duties: ['payable', 'cost'], password: PASSWORD, mustChangePassword: false });
  am = await login(ctx.app, 'am');
  duty = await login(ctx.app, 'duty');
  manager = await login(ctx.app, 'mgr');
  finance = await login(ctx.app, 'fin');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'W', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['整改搓澡', '整改洗浴', 6800],
    ['整改果盘', '整改水吧', 3800],
    ['整改门票', '整改洗浴', 9900],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  // 赠送比例都设 0：这里只看本金、券与比例
  const mr = (await api(ctx.app, ctx.owner, 'GET', '/api/membership/rules')).body;
  const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...mr, grades: mr.grades.map((g: object) => ({ ...g, bonusBp: 0 })) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

describe('P0-02 VIP 柜归会员权益', () => {
  it('会员规则里不再有 VIP 柜；会员权益里能看能改，别人刚改过就拒绝；前台的当场授权开关跟着走', async () => {
    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/membership/rules')).body;
    expect(rules).not.toHaveProperty('vipLockerLevels');
    const before = (await api(ctx.app, ctx.owner, 'GET', '/api/vip-lockers')).body;
    expect(before.rules.levels).toHaveLength(7);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/vip-lockers')).status).toBe(403);
    expect((await api(ctx.app, duty, 'PUT', '/api/vip-lockers', { ...before.rules })).status).toBe(403);

    const saved = await api(ctx.app, manager, 'PUT', '/api/vip-lockers', { levels: before.rules.levels, overrideEnabled: true, based: before.rules });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.rules.overrideEnabled).toBe(true);
    // 拿着旧的设置再保存：拒绝，不悄悄改回
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/vip-lockers', { levels: before.rules.levels, overrideEnabled: false, based: before.rules });
    expect(stale.body.error.code).toBe('RULES_CHANGED');
    // 高档能用的柜不能比低档少
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/vip-lockers', { levels: [2, 1, 1, 1, 2, 4, 5], overrideEnabled: true });
    expect(bad.status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body.rules.vipOverrideEnabled).toBe(true);
    await api(ctx.app, ctx.owner, 'PUT', '/api/vip-lockers', { levels: before.rules.levels, overrideEnabled: false });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body.rules.vipOverrideEnabled).toBe(false);
  });
});

describe('P0-03 次卡停售', () => {
  it('默认停售：不能新售；打开设置后照常售卡', async () => {
    const type = await api(ctx.app, ctx.owner, 'POST', '/api/admin/count-card-types', { name: '整改搓澡卡', itemIds: [item['整改搓澡']], uses: 3, price: 18000 });
    expect(type.status, JSON.stringify(type.body)).toBe(200);
    const t = (type.body as { id: number; name: string; version: number; price: number }[]).find((x) => x.name === '整改搓澡卡')!;
    const m = await createMember(ctx, '次卡会员', '13900180001');
    const sell = () => api(ctx.app, ctx.clerk, 'POST', '/api/count-cards', { clientKey: randomUUID(), memberId: m.id, typeId: t.id, expectedVersion: t.version, expectedPrice: t.price, method: 'cash' });
    expect((await sell()).body.error.code).toBe('COUNT_CARD_SALES_CLOSED');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { countCardSales: true })).status).toBe(200);
    expect((await sell()).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { countCardSales: false })).status).toBe(200);
  });
});

describe('P1-04 充值当日储值消费比例', () => {
  it('充 10 万：当天储值最多用 7 万，超过拦下并给剩余额度；用到 7 万为止', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { rechargeSpendPct: 70 })).status).toBe(200);
    const m = await createMember(ctx, '比例会员', '13900180002');
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, yuan(100_000)));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body;
    expect(detail.spendQuota).toMatchObject({ recharged: yuan(100_000), priorBalance: 0, pct: 70, cap: yuan(70_000), remaining: yuan(70_000) });

    const over = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, yuan(70_000) + 1));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RECHARGE_SPEND_CAP');
    expect(over.body.error.details.remaining).toBe(yuan(70_000));
    expect(over.body.error.message).toContain('剩余额度 ¥70,000.00');

    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, yuan(50_000)))).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body.spendQuota.remaining).toBe(yuan(20_000));
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, yuan(20_000) + 1))).body.error.code).toBe('RECHARGE_SPEND_CAP');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, yuan(20_000)))).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 1))).body.error.details.remaining).toBe(0);

    // 不限（空）：照常用
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { rechargeSpendPct: null })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, yuan(1_000)))).status).toBe(200);
  });

  it('充值前用掉的原来的钱，充值后撤销了那笔消费：退回来的照样能用（8.0.5，8.0.4 独立验收 P2）', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { rechargeSpendPct: 70 })).status).toBe(200);
    try {
      // 期初导入：卡里原来有 ¥100
      const csv = ['姓名,手机号,旧卡号,本金,赠金,赠金到期日,累计充值,性别,生日,备注', '撤销额度会员,13900180008,,100,,,,,,'].join('\n');
      const imported = await api(ctx.app, ctx.owner, 'POST', '/api/opening-imports', { source: 'EBC', fileName: 'quota.csv', note: '额度用例', csv, clientKey: randomUUID() });
      expect(imported.status, JSON.stringify(imported.body)).toBe(200);
      const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM members WHERE phone = '13900180008'`;
      // 今天还没充值：用掉原来的 ¥100（不受比例限制）
      const spent = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m!.id, yuan(100)));
      expect(spent.status, JSON.stringify(spent.body)).toBe(200);
      // 充 ¥100：今天最多用 ¥70
      expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m!.id, yuan(100)))).status).toBe(200);
      expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m!.id}`)).body.spendQuota).toMatchObject({ priorBalance: 0, cap: yuan(70), remaining: yuan(70) });
      // 撤销充值前那笔消费：卡里 ¥200，原来的 ¥100 照样能用，今天最多 ¥170
      const back = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${spent.body.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m!.id}`)).body;
      expect(detail.principalBalance).toBe(yuan(200));
      expect(detail.spendQuota).toMatchObject({ priorBalance: yuan(100), cap: yuan(170), remaining: yuan(170) });
      expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m!.id, yuan(170)))).status).toBe(200);
      expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m!.id, 1))).body.error.code).toBe('RECHARGE_SPEND_CAP');
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { rechargeSpendPct: null });
    }
  });
});

describe('P1-05 标签', () => {
  it('店主建标签；前台建档挂标签、按标签查找；会员总览按标签导出（店员不能导出）', async () => {
    const tag = await api(ctx.app, ctx.owner, 'POST', '/api/member-tags', { groupName: '客群', name: '整改测试客' });
    expect(tag.status, JSON.stringify(tag.body)).toBe(201);
    const tagId = tag.body.id as number;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/member-tags', { groupName: '客群', name: '整改测试客' })).body.error.code).toBe('TAG_EXISTS');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/member-tags', { groupName: '客群', name: '店员建的' })).status).toBe(403);

    const created = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '挂标签的会员', phone: '13900180003', tagIds: [tagId] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${created.body.id}`)).body;
    expect(detail.tags.map((t: { name: string }) => t.name)).toEqual(['整改测试客']);
    const found = (await api(ctx.app, ctx.clerk, 'GET', `/api/members?q=&tagId=${tagId}`)).body as { id: number }[];
    expect(found.map((m) => m.id)).toEqual([created.body.id]);

    const report = await api(ctx.app, am, 'GET', `/api/member-tags/members?tagIds=${tagId}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.count).toBe(1);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/member-tags/members.csv?tagIds=${tagId}`, headers: { cookie: am } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('挂标签的会员');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/member-tags/members.csv?tagIds=${tagId}`, headers: { cookie: ctx.clerk } })).statusCode).toBe(403);
  });
});

describe('P1-06 批量发券', () => {
  it('圈 100 位会员全部到账；重提不重发；会员端到账、到期提醒；短信进待发箱、按通道发出', async () => {
    const tag = (await api(ctx.app, ctx.owner, 'POST', '/api/member-tags', { groupName: '活动', name: '百人圈选' })).body as { id: number };
    const ids: number[] = [];
    for (let i = 0; i < 100; i++) ids.push((await createMember(ctx, `圈选会员${i}`, `1370018${String(i).padStart(4, '0')}`)).id);
    await ctx.sql`INSERT INTO member_tag_links ${ctx.sql(ids.map((id) => ({ member_id: id, tag_id: tag.id, created_by: ctx.ownerId })))}`;
    const t = await template({ name: '百人代金券', kind: 'cash', faceValue: yuan(20), validDays: 10 });

    const pre = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/campaigns/preview', { templateId: t.id, audience: { tagIds: [tag.id] } });
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    expect(pre.body.count).toBe(100);

    const body = { clientKey: randomUUID(), templateId: t.id, quantity: 1, audience: { tagIds: [tag.id] }, reason: '整改验收批量发券', notifySms: true, notifyPopup: true, remindDays: 7 };
    const first = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/campaigns', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: 'done', targeted: 100, issued: 100, skipped: 0, replayed: false });
    // 原样重提：同一张发券单，不重发
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/campaigns', body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true });
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coupons WHERE template_id = ${t.id}`;
    expect(n!.n).toBe(100);
    for (const id of ids.slice(0, 3)) expect((await memberCoupons(id)).filter((c) => c.templateId === t.id)).toHaveLength(1);

    // 会员端：到账当天弹「收到 1 张券」；到期前 7 天才弹到期提醒；看过不再弹
    const notices = await listMemberNotices(ctx.sql, ids[0]!, today);
    expect(notices.map((x) => x.kind)).toEqual(['coupon_issued']);
    const remindOn = (await ctx.sql<{ d: string }[]>`SELECT show_from::text AS d FROM member_notices WHERE member_id = ${ids[0]!} AND kind = 'coupon_expiring'`)[0]!.d;
    expect((await listMemberNotices(ctx.sql, ids[0]!, remindOn)).map((x) => x.kind)).toContain('coupon_expiring');
    expect(await markMemberNoticeRead(ctx.sql, ids[0]!, notices[0]!.id)).toBe(true);
    expect(await markMemberNoticeRead(ctx.sql, ids[0]!, notices[0]!.id)).toBe(false);
    expect(await listMemberNotices(ctx.sql, ids[0]!, today)).toHaveLength(0);

    // 短信：没配通道时留在待发箱；mock 通道一次发完
    const [pending] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sms_outbox WHERE campaign_id = ${first.body.id} AND status = 'pending'`;
    expect(pending!.n).toBe(100);
    expect(await sendPendingSms({ sql: ctx.sql, config: { sms: { ...ctx.config.sms, provider: null } } })).toEqual({ sent: 0, failed: 0 });
    let sent = 0;
    for (let i = 0; i < 5 && sent < 100; i++) sent += (await sendPendingSms({ sql: ctx.sql, config: { sms: { ...ctx.config.sms, provider: 'mock' } } }, { limit: 50 })).sent;
    expect(sent).toBe(100);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/coupons/campaigns/${first.body.id}/sms.csv`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
  });

  it('阿里云短信签名与官方文档的示例一致', () => {
    const { signature } = aliyunSign(
      {
        AccessKeyId: 'testId',
        Action: 'SendSms',
        Format: 'XML',
        OutId: '123',
        PhoneNumbers: '15300000001',
        RegionId: 'cn-hangzhou',
        SignName: '阿里云短信测试专用',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: '45e25e9b-0a6f-4070-8c85-2956eda1b466',
        SignatureVersion: '1.0',
        TemplateCode: 'SMS_71390007',
        TemplateParam: '{"customer":"test"}',
        Timestamp: '2017-07-12T02:42:19Z',
        Version: '2017-05-25',
      },
      'testSecret',
    );
    expect(signature).toBe('zJDF+Lrzhj/ThnlvIToysFRq6t4=');
  });

  it('两批短信叠在一起跑（前一批还在发）：后一批认领不到，每条只发一次；租约过期没记结果的再发（Codex 自动审查 8603568）', async () => {
    const ids = (
      await ctx.sql<{ id: number }[]>`
        INSERT INTO sms_outbox (phone, purpose, params, content, dedupe_key)
        SELECT '1380018' || lpad(n::text, 4, '0'), 'coupon_issued', '{"count":1}'::jsonb, '测试短信', 'overlap-test-' || n FROM generate_series(1, 3) AS n
        RETURNING id`
    ).map((r) => Number(r.id));
    const sends: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let firstSend!: () => void;
    const started = new Promise<void>((resolve) => (firstSend = resolve));
    const slowSend = async (_cfg: unknown, phone: string) => {
      sends.push(phone);
      firstSend();
      await gate;
      return `ref-${phone}`;
    };
    const deps = { sql: ctx.sql, config: { sms: { ...ctx.config.sms, provider: 'aliyun' as const } } };
    // 第一批认领了三条、正在发第一条时，第二批开始
    const first = sendPendingSms(deps, { limit: 10, send: slowSend });
    await started;
    const second = await sendPendingSms(deps, { limit: 10, send: slowSend });
    expect(second).toEqual({ sent: 0, failed: 0 });
    open();
    expect(await first).toEqual({ sent: 3, failed: 0 });
    expect(sends).toHaveLength(3);
    expect(new Set(sends).size).toBe(3);
    const rows = await ctx.sql<{ status: string; attempts: number; claimedUntil: Date | null }[]>`
      SELECT status, attempts, claimed_until FROM sms_outbox WHERE id IN ${ctx.sql(ids)}`;
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1 && r.claimedUntil === null)).toBe(true);

    // 认领了、进程在发送中断了（还是待发、租约还在）：租约内不再认领，过了再发
    const [stuck] = await ctx.sql<{ id: number }[]>`
      INSERT INTO sms_outbox (phone, purpose, params, content, dedupe_key, attempts, claimed_until)
      VALUES ('13800189999', 'coupon_issued', '{"count":1}'::jsonb, '测试短信', 'overlap-test-stuck', 1, now() + interval '5 minutes') RETURNING id`;
    const quick = async (_cfg: unknown, phone: string) => `ref-${phone}`;
    expect(await sendPendingSms(deps, { limit: 10, send: quick })).toEqual({ sent: 0, failed: 0 });
    await ctx.sql`UPDATE sms_outbox SET claimed_until = now() - interval '1 second' WHERE id = ${stuck!.id}`;
    expect(await sendPendingSms(deps, { limit: 10, send: quick })).toEqual({ sent: 1, failed: 0 });
    expect((await ctx.sql<{ attempts: number }[]>`SELECT attempts FROM sms_outbox WHERE id = ${stuck!.id}`)[0]!.attempts).toBe(2);
  });
});

describe('P1-07 充值记录与消费记录', () => {
  it('分别查询；合计与明细一致；收支比例 = 消费 ÷ 充值；导出', async () => {
    const m = await createMember(ctx, '记录会员', '13900180004');
    for (const paid of [yuan(1_000), yuan(500)]) expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, paid))).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, yuan(300)))).status).toBe(200);
    const recharge = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}/records?section=recharge&types=recharge,opening,merge_in,refund,opening_void`)).body;
    const consume = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}/records?section=consume&types=consume,reversal,expire,merge_out`)).body;
    expect(recharge.totals).toMatchObject({ count: 2, total: yuan(1_500) });
    expect(consume.totals).toMatchObject({ count: 1, total: yuan(300) });
    expect(recharge.rows).toHaveLength(2);
    expect(consume.rows).toHaveLength(1);
    expect(spendRatio(recharge.totals.total, consume.totals.total)).toBe(20);
    // 只看某一天：今天以前的查不到
    const none = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}/records?section=recharge&types=recharge&to=2020-01-01`)).body;
    expect(none.totals.count).toBe(0);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/members/${m.id}/records.csv?section=consume&types=consume,reversal,expire,merge_out`, headers: { cookie: ctx.clerk } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('测试消费');
  });
});

describe('P2-09 买一赠一与生日礼', () => {
  it('买一赠一：有买的项目又有赠的项目（同一项目 2 份）才能用，抵最便宜的一份，可设最多抵', () => {
    const terms = { kind: 'bogo' as const, faceValue: null, ratePercent: null, maxOff: null, threshold: 0, scope: 'all' as const, scopeCategories: [], scopeItems: [], exchangeItemId: 1, exchangeTicketTypeId: null, buyItemId: 1 };
    const line = (id: number, itemId: number, unitPrice: number, quantity: number) => ({ id, itemId, ticketTypeId: null, name: `项目${itemId}`, category: '洗浴', unitPrice, quantity, amount: unitPrice * quantity });
    expect(evaluateCoupon(terms, [line(1, 1, 6800, 1)]).usable).toBe(false);
    expect(evaluateCoupon(terms, [line(1, 1, 6800, 2)])).toMatchObject({ usable: true, amount: 6800 });
    expect(evaluateCoupon({ ...terms, maxOff: 5000 }, [line(1, 1, 6800, 2)])).toMatchObject({ usable: true, amount: 5000 });
    // 买门票送果盘：抵果盘
    const gift = { ...terms, buyItemId: 3, exchangeItemId: 2 };
    expect(evaluateCoupon(gift, [line(1, 2, 3800, 1)]).usable).toBe(false);
    expect(evaluateCoupon(gift, [line(1, 3, 9900, 1), line(2, 2, 3800, 1)])).toMatchObject({ usable: true, amount: 3800 });
  });

  it('生日礼：生日前 3 天到账，到生日当月底都补；2 月 29 日平年按 2 月 28 日', () => {
    expect(birthdayDueYear('1990-11-12', '2026-11-09', 3)).toBe('2026');
    expect(birthdayDueYear('1990-11-13', '2026-11-09', 3)).toBeNull();
    expect(birthdayDueYear('1990-11-01', '2026-11-30', 3)).toBe('2026');
    expect(birthdayDueYear('1990-10-31', '2026-11-01', 3)).toBeNull();
    // 1 月 2 日生日：前一年 12 月 30 日就到账（算下一年的）
    expect(birthdayDueYear('1990-01-02', '2026-12-30', 3)).toBe('2027');
    expect(birthdayDueYear('1992-02-29', '2027-02-25', 3)).toBe('2027');
    expect(birthdayDueYear('1992-02-29', '2027-02-24', 3)).toBeNull();
  });

  it('改了「生日礼提前几天」，今天已经跑完的会员权益任务同一天再跑一次（Codex 自动审查 8603568）', async () => {
    const deps = { sql: ctx.sql, config: ctx.config };
    await runBenefitsDaily(deps);
    // 什么都没改：今天不再跑
    expect(await runBenefitsDaily(deps)).toBeNull();
    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/membership/rules')).body;
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...rules, birthdayLeadDays: rules.birthdayLeadDays === 3 ? 5 : 3 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await runBenefitsDaily(deps)).not.toBeNull();
    expect(await runBenefitsDaily(deps)).toBeNull();
    // 改回去：再跑一次
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...rules, birthdayLeadDays: rules.birthdayLeadDays })).status).toBe(200);
    expect(await runBenefitsDaily(deps)).not.toBeNull();
  });

  it('结账用了买一赠一券：赠品自动出库记账；库存不够记失败、补库存后重试；反结账冲销', async () => {
    const material = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
      code: 'ZG-FRUIT',
      name: '赠品果盘',
      specification: '一份',
      inventoryUnit: '份',
      purchaseUnit: '份',
      purchaseFactorMilli: 1000,
    });
    expect(material.status, JSON.stringify(material.body)).toBe(201);
    const materialId = material.body.id as number;
    const meta = (await api(ctx.app, ctx.owner, 'GET', '/api/coupons/meta')).body as { materials: { id: number }[]; warehouses: { id: number; name: string }[] };
    expect(meta.materials.map((x) => x.id)).toContain(materialId);
    const warehouseId = meta.warehouses[0]!.id;
    const t = await template({
      name: '买一赠一搓澡',
      kind: 'bogo',
      buyItemId: item['整改搓澡'],
      giftMaterialId: materialId,
      giftQtyMilli: 1000,
      giftWarehouseId: warehouseId,
    });
    expect(t.summary).toContain('买一赠一');
    expect(t.summary).toContain('买 整改搓澡 送 整改搓澡');
    expect(t.giftOutText).toContain('赠品果盘');
    const stock = async () => (await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${materialId}`)).body.stockMilli as number;

    // ① 没有库存：结账照常，出库记失败
    const m = await createMember(ctx, '买一赠一会员', '13900180005');
    await issue(m.id, t.id, 2);
    const [c1, c2] = (await memberCoupons(m.id)).filter((c) => c.templateId === t.id);
    // 已发的券（会员详情、小程序读的同一份）：说明里写明买什么、送什么（8.0.5，8.0.4 独立验收 P2：原来写「买 指定项目」）
    const issued = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m.id}/coupons`)).body.coupons.find((c: { templateId: number }) => c.templateId === t.id);
    expect(issued.summary).toContain('买 整改搓澡 送 整改搓澡');
    const v1 = await enter([{ itemId: item['整改搓澡']!, quantity: 2, price: 6800 }], m.id);
    const pre = await preview(v1);
    expect(pre.storeCoupons.find((c) => c.code === c1!.code)).toMatchObject({ usable: true, amount: 6800 });
    const k1 = await payWithCoupon(v1, c1!.code, 6800);
    expect(await processGiftOuts({ sql: ctx.sql, config: ctx.config })).toMatchObject({ failed: 1 });
    const [failed] = await ctx.sql<{ id: number; status: string; lastError: string }[]>`SELECT id, status, last_error FROM coupon_gift_outs WHERE checkout_id = ${k1}`;
    expect(failed!.status).toBe('failed');
    expect(failed!.lastError).toBeTruthy();

    // ② 补库存，营销成本页重试：出库
    const opening = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, docType: 'opening', approveNow: true, lines: [{ materialId, qtyMilli: 10_000 }] });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/gift-outs/${failed!.id}/retry`, {})).status).toBe(403);
    const retried = await api(ctx.app, ctx.owner, 'POST', `/api/gift-outs/${failed!.id}/retry`, {});
    expect(retried.body.status, JSON.stringify(retried.body)).toBe('done');
    expect(await stock()).toBe(9_000);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/gift-outs/${failed!.id}/retry`, {})).body.error.code).toBe('GIFT_OUT_NOT_FAILED');

    // ③ 再用一张：每分钟的任务出库；反结账后冲销、库存回来
    const v2 = await enter([{ itemId: item['整改搓澡']!, quantity: 2, price: 6800 }], m.id);
    const k2 = await payWithCoupon(v2, c2!.code, 6800);
    expect(await processGiftOuts({ sql: ctx.sql, config: ctx.config })).toMatchObject({ done: 1 });
    expect(await stock()).toBe(8_000);
    const back = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${k2}/void`, { reason: '收错了' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await ctx.sql<{ status: string }[]>`SELECT status FROM coupon_gift_outs WHERE checkout_id = ${k2}`)[0]!.status).toBe('void_pending');
    expect(await processGiftOuts({ sql: ctx.sql, config: ctx.config })).toMatchObject({ voided: 1 });
    expect(await stock()).toBe(9_000);
    // 营销成本页看得到赠品出库
    const c = await cost();
    expect(c.giftOuts.counts).toMatchObject({ done: 1, voided: 1 });
  });

  it('开单的事务提交了、还没记下单号进程就断了，之后反结账：按操作编号找到那张单、照样冲销，库存回来（Codex 自动审查 8603568）', async () => {
    const material = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
      code: 'ZG-RECON',
      name: '对账赠品',
      specification: '一份',
      inventoryUnit: '份',
      purchaseUnit: '份',
      purchaseFactorMilli: 1000,
    });
    expect(material.status, JSON.stringify(material.body)).toBe(201);
    const materialId = material.body.id as number;
    const warehouseId = ((await api(ctx.app, ctx.owner, 'GET', '/api/coupons/meta')).body as { warehouses: { id: number }[] }).warehouses[0]!.id;
    const opening = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, docType: 'opening', approveNow: true, lines: [{ materialId, qtyMilli: 5_000 }] });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
    const stock = async () => (await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${materialId}`)).body.stockMilli as number;
    const t = await template({ name: '对账买一赠一', kind: 'bogo', buyItemId: item['整改果盘'], giftMaterialId: materialId, giftQtyMilli: 1000, giftWarehouseId: warehouseId });
    const m = await createMember(ctx, '对账会员', '13900180006');
    await issue(m.id, t.id);
    const code = (await memberCoupons(m.id)).find((c) => c.templateId === t.id)!.code;
    const k = await payWithCoupon(await enter([{ itemId: item['整改果盘']!, quantity: 2, price: 3800 }], m.id), code, 3800);
    const [job] = await ctx.sql<{ id: number; clientKey: string; status: string }[]>`SELECT id, client_key, status FROM coupon_gift_outs WHERE checkout_id = ${k}`;
    expect(job!.status).toBe('pending');
    // 模拟：出库的单用这一条的操作编号开好、提交了，进程在记下单号之前断了（这一条还是「待出库」）
    const doc = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', {
      clientKey: job!.clientKey,
      docDate: today,
      docType: 'direct_use',
      warehouseId,
      note: '买一赠一的赠品（模拟断在记单号之前）',
      lines: [{ materialId, qtyMilli: 1000 }],
    });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    expect(await stock()).toBe(4_000);
    // 下一分钟的任务之前就反结账了：原来这一条记成「已取消」，库存永远少一份
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${k}/void`, { reason: '收错了' })).status).toBe(200);
    expect((await ctx.sql<{ status: string }[]>`SELECT status FROM coupon_gift_outs WHERE id = ${job!.id}`)[0]!.status).toBe('cancelled');
    // 对账：按操作编号找到那张单，改成待冲销，冲销后库存回来
    expect(await processGiftOuts({ sql: ctx.sql, config: ctx.config })).toMatchObject({ voided: 1 });
    const [after] = await ctx.sql<{ status: string; invDocId: number }[]>`SELECT status, inv_doc_id FROM coupon_gift_outs WHERE id = ${job!.id}`;
    expect(after).toMatchObject({ status: 'voided', invDocId: doc.body.doc.id });
    expect(await stock()).toBe(5_000);

    // 8.0.4 先记单号、再另一条语句把「已取消」改成待冲销：两步之间断了，留下「已取消 + 有单号」（8.0.5，8.0.4 独立验收 P1）。
    // 再来一单出了库、反结账前的那一刻断在这里：对账照样认出来、冲销，库存回来
    // 反结账以后上一位会员又在店了：换一位会员结这一单
    const m2 = await createMember(ctx, '对账会员乙', '13900180009');
    await issue(m2.id, t.id);
    const code2 = (await memberCoupons(m2.id)).find((c) => c.templateId === t.id)!.code;
    const k2 = await payWithCoupon(await enter([{ itemId: item['整改果盘']!, quantity: 2, price: 3800 }], m2.id), code2, 3800);
    expect(await processGiftOuts({ sql: ctx.sql, config: ctx.config })).toMatchObject({ done: 1 });
    expect(await stock()).toBe(4_000);
    const [done2] = await ctx.sql<{ id: number; invDocId: number }[]>`SELECT id, inv_doc_id FROM coupon_gift_outs WHERE checkout_id = ${k2}`;
    expect(done2!.invDocId).not.toBeNull();
    await ctx.sql`UPDATE coupon_gift_outs SET status = 'cancelled', updated_at = now() WHERE id = ${done2!.id}`;
    expect(await processGiftOuts({ sql: ctx.sql, config: ctx.config })).toMatchObject({ voided: 1 });
    expect((await ctx.sql<{ status: string }[]>`SELECT status FROM coupon_gift_outs WHERE id = ${done2!.id}`)[0]!.status).toBe('voided');
    expect(await stock()).toBe(5_000);
  });
});

describe('P2-08 使用率与 P2-10、11 营销成本', () => {
  it('使用率：发放 5、领取 4、核销 2 → 核销率 40%；按 1000 / 600 / 420 算核销率 42%', async () => {
    expect(usageRate(420, 1000)).toBe(42);
    expect(rateText(420, 1000)).toBe('42%');
    expect(rateText(1, 0)).toBe('—');
    const t = await template({ name: '使用率代金券', kind: 'cash', faceValue: yuan(10) });
    const members = [];
    for (let i = 0; i < 3; i++) {
      const m = await createMember(ctx, `使用率会员${i}`, `1390018010${i}`);
      await issue(m.id, t.id);
      members.push(m);
    }
    const batch = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/batches', { clientKey: randomUUID(), templateId: t.id, quantity: 2, note: '使用率无记名' });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    const codesCsv = await ctx.app.inject({ method: 'GET', url: `/api/coupons/batches/${batch.body.id}/codes.csv`, headers: { cookie: ctx.owner } });
    const bearer = [...codesCsv.body.matchAll(/([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/g)].map((x) => x[1]!.replaceAll('-', ''));
    expect(bearer).toHaveLength(2);
    // 一张会员的、一张无记名的用掉
    const memberCode = (await memberCoupons(members[0]!.id)).find((c) => c.templateId === t.id)!.code;
    await payWithCoupon(await enter([{ itemId: item['整改果盘']!, quantity: 1, price: 3800 }], members[0]!.id), memberCode, yuan(10));
    await payWithCoupon(await enter([{ itemId: item['整改果盘']!, quantity: 1, price: 3800 }]), bearer[0]!, yuan(10));

    const u = await usage();
    const row = u.groups.template.find((r) => r.key === `template:${t.id}`)!;
    expect(row).toMatchObject({ issued: 5, claimed: 4, used: 2, usedAmount: yuan(20), voided: 0 });
    expect(rateText(row.used, row.issued)).toBe('40%');
    expect(rateText(row.claimed, row.issued)).toBe('80%');
    // 按发放方式：手动发 3 张、无记名 2 张
    expect(u.groups.source.find((r) => r.key === 'source:manual')!.issued).toBeGreaterThanOrEqual(3);
    // 按档级圈：无记名券不算
    const l0 = await usage(`from=${today}&to=${today}&grade=0`);
    expect(l0.groups.template.find((r) => r.key === `template:${t.id}`)).toMatchObject({ issued: 3, claimed: 3, used: 1 });
    // 店员看不到；客户经理（会员总览）看得到；导出记审计
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/coupons/usage?from=${today}&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, am, 'GET', `/api/coupons/usage?from=${today}&to=${today}`)).status).toBe(200);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/coupons/usage.csv?from=${today}&to=${today}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('使用率代金券');
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'coupon_usage_exported'`;
    expect(audit!.n).toBe(1);
  });

  it('营销成本（实核）：5 张 50 元券用了 2 张 → 券成本 100 元；反结账冲回；服务类按次数 × 测算单价', async () => {
    const t = await template({ name: '成本代金券', kind: 'cash', faceValue: yuan(50) });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await createMember(ctx, `成本会员${i}`, `1390018020${i}`);
      await issue(m.id, t.id);
      ids.push(m.id);
    }
    const checkoutIds: number[] = [];
    for (const id of ids.slice(0, 2)) {
      const code = (await memberCoupons(id)).find((c) => c.templateId === t.id)!.code;
      checkoutIds.push(await payWithCoupon(await enter([{ itemId: item['整改门票']!, quantity: 1, price: 9900 }], id), code, yuan(50)));
    }
    const c = await cost();
    expect(c.coupons.groups.template.find((r) => r.key === `template:${t.id}`)).toMatchObject({ used: 2, amount: yuan(100) });
    expect(c.coupons.issuedFace).toBeGreaterThanOrEqual(yuan(250));
    expect(c.total).toBe(c.coupons.amount + c.bonus.consumed + c.discounts.amount + c.services.amount);
    // 反结账一张：只剩 1 张、50 元
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutIds[1]}/void`, { reason: '收错了' })).status).toBe(200);
    expect((await cost()).coupons.groups.template.find((r) => r.key === `template:${t.id}`)).toMatchObject({ used: 1, amount: yuan(50) });

    // 服务类权益：登记 3 次 × 测算单价 20 元 = 60 元（单价只在这一页改，留审计；不填只列次数）
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
    const params = (await api(ctx.app, ctx.owner, 'GET', '/api/marketing-cost/params')).body as { benefitId: number; code: string; unitCost: number | null }[];
    const lane = params.find((p) => p.code === 'QY-001')!;
    expect(lane.unitCost).toBeNull();
    await ctx.sql`
      INSERT INTO benefit_uses (benefit_id, member_id, business_date, quantity, staff_id, client_key)
      VALUES (${lane.benefitId}, ${ids[0]!}, ${today}, 2, ${ctx.ownerId}, ${randomUUID()}), (${lane.benefitId}, ${ids[1]!}, ${today}, 1, ${ctx.ownerId}, ${randomUUID()})`;
    expect((await cost()).services.rows.find((r) => r.code === 'QY-001')).toMatchObject({ uses: 3, members: 2, unitCost: null, amount: null });
    const saved = await api(ctx.app, manager, 'PUT', `/api/marketing-cost/params/${lane.benefitId}`, { unitCost: yuan(20) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.unitCost).toBe(yuan(20));
    const after = await cost();
    expect(after.services.rows.find((r) => r.code === 'QY-001')).toMatchObject({ uses: 3, unitCost: yuan(20), amount: yuan(60) });
    expect(after.services.amount).toBe(yuan(60));
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/marketing-cost/params/${params.find((p) => p.code !== 'QY-001')!.benefitId}`, { unitCost: -1 })).status).toBe(400);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/marketing-cost.csv?from=${today}&to=${today}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('成本代金券');
    const audits = await ctx.sql<{ action: string }[]>`SELECT action FROM audit_logs WHERE action IN ('marketing_cost_param_saved', 'marketing_cost_exported') ORDER BY id`;
    expect(audits.map((a) => a.action)).toEqual(['marketing_cost_param_saved', 'marketing_cost_exported']);
  });

  it('与财务隔离：有财务职责的账号看不到营销成本（后台岗位权限加了也不生效），店主、店总看得到；测算的数不进日结', async () => {
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/marketing-cost?from=${today}&to=${today}`)).status).toBe(200);
    expect((await api(ctx.app, manager, 'GET', `/api/marketing-cost?from=${today}&to=${today}`)).status).toBe(200);
    expect((await api(ctx.app, finance, 'GET', `/api/marketing-cost?from=${today}&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, finance, 'GET', '/api/marketing-cost/params')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/marketing-cost?from=${today}&to=${today}`)).status).toBe(403);
    expect(permissionsOf({ role: 'store_manager', duties: ['cost'] })).not.toContain('marketing.cost');
    expect(permissionsOf({ role: 'store_manager', duties: [] })).toContain('marketing.cost');
    expect(permissionsOf({ role: 'owner', duties: ['payable'] })).toContain('marketing.cost');
    // 后台把「营销成本测算」加给后勤岗位：没有财务职责的有，有财务职责的仍然没有
    expect(permissionsOf({ role: 'backoffice', duties: ['payable'] }, { backoffice: { add: ['marketing.cost'], remove: [] } })).not.toContain('marketing.cost');
    expect(permissionsOf({ role: 'backoffice', duties: ['stock'] }, { backoffice: { add: ['marketing.cost'], remove: [] } })).toContain('marketing.cost');
    // 日结里没有「营销成本」：测算不写任何账
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(JSON.stringify(st)).not.toContain('营销成本');
  });
});
