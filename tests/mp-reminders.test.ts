// 小程序第三期 3a：到期提醒（小程序线，docs/MP_PHASE3.md 第 1 节；MP28、MP29）：
//   · 设置（店主、店总；版本号；模板编号与字段名的格式；券没有金额；三种用三个模板）；默认关着；
//   · 设提醒：券（3 天前）、会籍（7 天前）、补充期（进补充期当天）、赠金（7 天前）；同一个编号重提、同一样东西再设都返回原来那条；
//     模板换过、绑定变过、到期日变过、券用掉或不是自己的都拒绝；
//   · 排期：到了那天、北京时间 10:00–20:00 之间才排，字段按微信的格式；那时已经不用提醒的记「不发」与原因；
//   · 网关取、回报：发出、微信拒绝、再试（第 3 次还不行记没发出）、发了没回音与过了期限没回报的记「结果不明」、不再发第二次；
//     取的时候解绑了、券用掉了的不发；凭据不对的回报不认；小程序或到期提醒关掉时取不到；
//   · 后台：统计、最近的消息、网关最近一次来取的时间；自检照常全过。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpReminderAdminData, type MpReminderLeased, type MpReminderOptions, type MpReminderRules } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import { mpToday } from '../src/server/modules/mp/public';
import { formatField, leaseReminders, planReminders, reportReminders } from '../src/server/modules/mp/reminders';
import { loadSettings } from '../src/server/modules/settings';
import { createStaff } from '../src/server/modules/staff';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const TPL = { coupon: 'tplCoupon-0123456789abcdefABCDEF', membership: 'tplMember-0123456789abcdefABCDEF', bonus: 'tplBonus_0123456789abcdefABCDEF0' };
let ctx: TestContext;
let mp: FastifyInstance;
let boss: string;
let today: string;
let templateId: number;
let planId: number;
const deps = () => ({ sql: ctx.sql, config: ctx.config });
/** 北京时间那一天的几点 */
const at = (date: string, hour: number, minute = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);

const RULES = (patch: Partial<MpReminderRules> = {}) => ({
  enabled: true,
  coupon: { templateId: TPL.coupon, fields: [{ key: 'thing1', source: 'name' }, { key: 'date2', source: 'date' }, { key: 'thing3', source: 'tip' }] },
  membership: {
    templateId: TPL.membership,
    fields: [{ key: 'thing1', source: 'name' }, { key: 'time2', source: 'date' }, { key: 'amount3', source: 'amount' }, { key: 'thing4', source: 'tip' }],
  },
  bonus: { templateId: TPL.bonus, fields: [{ key: 'amount1', source: 'amount' }, { key: 'date2', source: 'date' }, { key: 'thing3', source: 'store' }] },
  ...patch,
});

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay: null, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  today = await mpToday(ctx.sql, ctx.config.timezone);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '浴资抵用券（三十元）满五十元可用·限周一至周五', kind: 'cash', faceValue: 3000, threshold: 5000, validity: 'days', validDays: 2 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  templateId = t.body.id;
  const p = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name: '五天赠金', payAmount: 50000, bonusAmount: 5000, bonusValidDays: 5 });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  planId = p.body.plans.find((x: { name: string }) => x.name === '五天赠金').id;
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string | null, payload?: unknown) =>
  Promise.resolve(
    mp.inject({
      method,
      url,
      headers: { [MP_GATEWAY_HEADER]: KEY, ...(openid ? { [MP_OPENID_HEADER]: openid } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
  );
let n = 0;
async function bound(name: string): Promise<{ memberId: number; openid: string }> {
  n += 1;
  const phone = `1366600${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-remind-${n}-${randomUUID().slice(0, 8)}`;
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true });
  expect(b.statusCode, b.body).toBe(200);
  return { memberId: m.id, openid };
}
const unbind = async (openid: string) => {
  const [b] = await ctx.sql<{ id: number }[]>`SELECT id FROM mp_bindings WHERE openid = ${openid} AND unbound_at IS NULL`;
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${b!.id}/unbind`, { clientKey: randomUUID(), reason: '换微信' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const adminData = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/reminders')).body as MpReminderAdminData;
async function saveRules(patch: Partial<MpReminderRules> = {}) {
  const { version } = (await adminData()).rules;
  const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/reminders/rules', { ...RULES(patch), version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MpReminderRules;
}
const options = async (openid: string) => {
  const r = await call('GET', '/api/mp/reminders', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpReminderOptions;
};
/** 发一张券给这位会员：返回券码与有效期到哪天 */
async function couponFor(memberId: number): Promise<{ id: number; code: string; validTo: string }> {
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/members/${memberId}/coupons`, { clientKey: randomUUID(), templateId, quantity: 1, reason: '测试发券' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const [c] = await ctx.sql<{ id: number; code: string; validTo: string }[]>`
    SELECT id, code, valid_to::text AS valid_to FROM coupons WHERE member_id = ${memberId} ORDER BY id DESC LIMIT 1`;
  return { ...c!, id: Number(c!.id) };
}
/** 设一条提醒：默认带这个微信现在的绑定版本号与配好的模板 */
async function consent(openid: string, body: Record<string, unknown>) {
  const o = await options(openid);
  const kind = body.kind as 'coupon' | 'membership' | 'grace' | 'bonus';
  const tpl = kind === 'grace' ? 'membership' : kind;
  return call('POST', '/api/mp/reminders', openid, { clientKey: randomUUID(), templateId: o.templates[tpl] ?? TPL[tpl], bindVersion: o.bindVersion, ...body });
}
/** 网关在某个时间来取（路由按此刻的时间；要指定时间的直接调） */
const leaseAt = async (when: Date, limit = 20, batchId?: string) => (await leaseReminders(deps(), { limit, ...(batchId ? { batchId } : {}) }, when)).messages;
/** 网关的回报接口（按此刻的时间） */
const report = (results: unknown[]) => call('POST', '/api/mp/gateway/reminders/report', null, { results });
/** 在某个时间回报（要再试的按这个时间算隔多久再给） */
const reportAt = async (when: Date, results: unknown[]) => (await reportReminders(deps(), { results }, when)).accepted;
const messageOf = async (consentId: number) => {
  const [m] = await ctx.sql<{ id: number; status: string; reason: string | null; page: string | null; data: Record<string, { value: string }> | null; attempts: number; errcode: number | null }[]>`
    SELECT id, status, reason, page, data, attempts, errcode FROM mp_reminder_messages WHERE consent_id = ${consentId}`;
  return m ? { ...m, id: Number(m.id) } : null;
};
/** 让这位会员在 L1、周期最后一天是 cycleEnd（周期 365 天）；给了 graceUntil 的进了补充期、到那天。与「手动调整」一样记一条状态变化 */
async function setGrade(memberId: number, cycleEnd: string, graceUntil: string | null = null) {
  const [m] = await ctx.sql<{ grade: number; tier: number | null }[]>`SELECT grade, tier FROM members WHERE id = ${memberId}`;
  const cycleStart = shiftDate(cycleEnd, -364);
  await ctx.sql`
    UPDATE members SET grade = 1, tier = 0, cycle_start = ${cycleStart}, cycle_end = ${cycleEnd}, grace_until = ${graceUntil}, grade_version = grade_version + 1
    WHERE id = ${memberId}`;
  await ctx.sql`
    INSERT INTO member_grade_events (member_id, kind, business_date, from_grade, from_tier, to_grade, to_tier, cycle_start, cycle_end, grace_until, staff_id, reason)
    VALUES (${memberId}, 'manual', ${today}, ${m!.grade}, ${m!.tier}, 1, 0, ${cycleStart}, ${cycleEnd}, ${graceUntil}, ${ctx.ownerId}, '测试设定档阶')`;
}

describe('到期提醒的设置', () => {
  it('默认关着：小程序看不到、设不了；没有权限的岗位看不了、改不了；店总可以', async () => {
    const a = await bound('演示·提醒关着');
    const o = await options(a.openid);
    expect(o).toMatchObject({ open: false, templates: { coupon: null, membership: null, bonus: null }, set: [], membership: null, bonus: null });
    const c = await couponFor(a.memberId);
    const r = await call('POST', '/api/mp/reminders', a.openid, { clientKey: randomUUID(), kind: 'coupon', couponCode: c.code, templateId: TPL.coupon, bindVersion: o.bindVersion });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MP_REMINDER_DISABLED');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp/reminders')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/mp/reminders/rules', RULES())).status).toBe(403);
    expect((await api(ctx.app, boss, 'GET', '/api/admin/mp/reminders')).status).toBe(200);
    // 没绑定的微信：版本号照给，其余都关着
    expect(await options('openid-remind-nobody-01')).toMatchObject({ open: false, bindVersion: 0 });
  });

  it('保存：模板编号与字段名照微信的格式，券没有金额，三种用三个模板，带打开时的版本号', async () => {
    const { version } = (await adminData()).rules;
    const put = (body: unknown) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/reminders/rules', body);
    const bad = async (patch: Record<string, unknown>, message: RegExp) => {
      const r = await put({ ...RULES(), version, ...patch });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error.message).toMatch(message);
    };
    await bad({ coupon: { templateId: 'short', fields: [{ key: 'thing1', source: 'name' }] } }, /模板编号不对/);
    await bad({ coupon: { templateId: TPL.coupon, fields: [{ key: 'foo1', source: 'name' }] } }, /字段名不对/);
    await bad({ coupon: { templateId: TPL.coupon, fields: [{ key: 'amount1', source: 'amount' }] } }, /不能填「金额」/);
    await bad({ coupon: { templateId: TPL.coupon, fields: [{ key: 'thing1', source: 'name' }, { key: 'thing1', source: 'tip' }] } }, /同一个字段名/);
    await bad({ bonus: { templateId: TPL.coupon, fields: [{ key: 'thing1', source: 'name' }] } }, /三个不同的模板/);
    const stale = await put({ ...RULES(), version: version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const saved = await saveRules();
    expect(saved).toMatchObject({ enabled: true, version: version + 1, coupon: { templateId: TPL.coupon } });
    // 只配了一种的：另外两种不出现「提醒我」
    const one = await saveRules({ membership: null, bonus: null });
    expect(one.membership).toBeNull();
    const a = await bound('演示·只配了券');
    expect((await options(a.openid)).templates).toEqual({ coupon: TPL.coupon, membership: null, bonus: null });
    const r = await consent(a.openid, { kind: 'bonus', targetDate: shiftDate(today, 4) });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('REMINDER_UNAVAILABLE');
    await saveRules();
  });
});

describe('设提醒', () => {
  it('券快到期：到期前 3 天发（已经不到 3 天的当天发）；同一个编号重提、同一张券再设都返回原来那条；小程序看得到「已设提醒」', async () => {
    const a = await bound('演示·券提醒');
    const c = await couponFor(a.memberId);
    const key = randomUUID();
    const o = await options(a.openid);
    expect(o).toMatchObject({ open: true, templates: { coupon: TPL.coupon, membership: TPL.membership, bonus: TPL.bonus }, leadDays: { coupon: 3, membership: 7, bonus: 7 }, sendHours: { from: 10, to: 20 } });
    const first = await call('POST', '/api/mp/reminders', a.openid, { clientKey: key, kind: 'coupon', couponCode: c.code, templateId: TPL.coupon, bindVersion: o.bindVersion });
    expect(first.statusCode, first.body).toBe(201);
    const due = shiftDate(c.validTo, -3) > today ? shiftDate(c.validTo, -3) : today;
    expect(first.json()).toMatchObject({ kind: 'coupon', targetDate: c.validTo, dueDate: due, replayed: false });
    const again = await call('POST', '/api/mp/reminders', a.openid, { clientKey: key, kind: 'coupon', couponCode: c.code, templateId: TPL.coupon, bindVersion: o.bindVersion });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ consentId: first.json().consentId, replayed: true });
    const other = await consent(a.openid, { kind: 'coupon', couponCode: c.code });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ consentId: first.json().consentId, replayed: true });
    // 同一张券同时点两次（不同的编号）：只记一条
    const c2 = await couponFor(a.memberId);
    const both = await Promise.all([consent(a.openid, { kind: 'coupon', couponCode: c2.code }), consent(a.openid, { kind: 'coupon', couponCode: c2.code })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(both[0]!.json().consentId).toBe(both[1]!.json().consentId);
    expect((await options(a.openid)).set.filter((s) => s.couponCode === c.code)).toEqual([{ kind: 'coupon', couponCode: c.code, targetDate: c.validTo, dueDate: due, state: 'waiting' }]);
    const [row] = await ctx.sql<{ count: number }[]>`SELECT count(*)::int FROM mp_reminder_consents WHERE member_id = ${a.memberId}`;
    expect(row!.count).toBe(2);
  });

  it('拒绝：模板刚换过、绑定刚变过、编号用在别的提醒上、不是自己的券、用掉或作废的券、合并掉的会员卡', async () => {
    const a = await bound('演示·提醒拒绝');
    const b = await bound('演示·别人的券');
    const c = await couponFor(a.memberId);
    const o = await options(a.openid);
    const body = { kind: 'coupon', couponCode: c.code, templateId: TPL.coupon, bindVersion: o.bindVersion };
    const tplChanged = await call('POST', '/api/mp/reminders', a.openid, { clientKey: randomUUID(), ...body, templateId: 'tplOld-0123456789abcdef' });
    expect(tplChanged.statusCode).toBe(409);
    expect(tplChanged.json().error.code).toBe('TEMPLATE_CHANGED');
    const stale = await call('POST', '/api/mp/reminders', a.openid, { clientKey: randomUUID(), ...body, bindVersion: o.bindVersion - 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('BIND_STALE');
    const others = await consent(b.openid, { kind: 'coupon', couponCode: c.code });
    expect(others.statusCode).toBe(404);
    const key = randomUUID();
    expect((await call('POST', '/api/mp/reminders', a.openid, { clientKey: key, ...body })).statusCode).toBe(201);
    await setGrade(a.memberId, shiftDate(today, 20));
    const reused = await call('POST', '/api/mp/reminders', a.openid, { clientKey: key, kind: 'membership', targetDate: shiftDate(today, 20), templateId: TPL.membership, bindVersion: o.bindVersion });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('CLIENT_KEY_REUSED');
    const v = await couponFor(a.memberId);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${v.id}/void`, { reason: '测试作废' })).status).toBe(200);
    const voided = await consent(a.openid, { kind: 'coupon', couponCode: v.code });
    expect(voided.statusCode).toBe(422);
    expect(voided.json().error).toMatchObject({ code: 'REMINDER_TARGET_GONE', message: '这张券已经作废了，不用提醒' });
    // 换绑到别的会员以后，之前那条绑定下的编号不认
    await unbind(a.openid);
    const version = (await call('GET', '/api/mp/me', a.openid)).json().bindVersion as number;
    const phone = (await ctx.sql<{ phone: string }[]>`SELECT phone FROM members WHERE id = ${b.memberId}`)[0]!.phone;
    await unbind(b.openid);
    expect((await call('POST', '/api/mp/bind', a.openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true })).statusCode).toBe(200);
    const after = await call('POST', '/api/mp/reminders', a.openid, { clientKey: key, ...body, bindVersion: (await options(a.openid)).bindVersion });
    expect(after.statusCode).toBe(409);
    expect(after.json().error.code).toBe('CLIENT_KEY_REUSED');
  });

  it('会籍：到期前 7 天；补充期：进补充期当天；页面上的到期日对不上的请顾客刷新；L0 与已经在补充期里的不能设', async () => {
    const a = await bound('演示·会籍提醒');
    const l0 = await consent(a.openid, { kind: 'membership', targetDate: today });
    expect(l0.statusCode).toBe(422);
    expect(l0.json().error.code).toBe('REMINDER_TARGET_GONE');
    const end = shiftDate(today, 30);
    await setGrade(a.memberId, end);
    const o = await options(a.openid);
    expect(o.membership).toMatchObject({ cycleEnd: end, inGrace: false });
    const wrong = await consent(a.openid, { kind: 'membership', targetDate: shiftDate(end, 1) });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('REMINDER_TARGET_CHANGED');
    const m = await consent(a.openid, { kind: 'membership', targetDate: end });
    expect(m.statusCode, m.body).toBe(201);
    expect(m.json()).toMatchObject({ targetDate: end, dueDate: shiftDate(end, -7) });
    const g = await consent(a.openid, { kind: 'grace', targetDate: end });
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json()).toMatchObject({ targetDate: end, dueDate: shiftDate(end, 1) });
    // 已经在补充期里了
    await setGrade(a.memberId, shiftDate(today, -1), shiftDate(today, 80));
    const inGrace = await consent(a.openid, { kind: 'grace', targetDate: shiftDate(today, -1) });
    expect(inGrace.statusCode).toBe(422);
    expect(inGrace.json().error.message).toBe('已经在补充期里了');
  });

  it('赠金：最早到期的那一天（最后能用的营业日），到期前 7 天（不到 7 天的当天发）；没有会到期的赠金不能设', async () => {
    const a = await bound('演示·赠金提醒');
    expect((await options(a.openid)).bonus).toBeNull();
    const none = await consent(a.openid, { kind: 'bonus', targetDate: shiftDate(today, 4) });
    expect(none.statusCode).toBe(422);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', {
      idempotencyKey: randomUUID(),
      memberId: a.memberId,
      planId,
      paidAmount: 50000,
      bonusAmount: 5000,
      paymentMethod: 'cash',
      paymentConfirmed: true,
      bonusMode: 'custom',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = await options(a.openid);
    // 有效 5 天：第 6 个营业日开始时作废，最后能用的是第 5 个营业日（今天算第 1 个）
    expect(o.bonus).toEqual({ amount: 5000, lastDay: shiftDate(today, 4) });
    // 页面上的那一天对不上（比如拿作废的那一天来设）：请顾客刷新
    const wrong = await consent(a.openid, { kind: 'bonus', targetDate: shiftDate(today, 5) });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('REMINDER_TARGET_CHANGED');
    const b = await consent(a.openid, { kind: 'bonus', targetDate: shiftDate(today, 4) });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json()).toMatchObject({ targetDate: shiftDate(today, 4), dueDate: today });
  });
});

describe('排期与发送', () => {
  it('字段按微信的格式写：thing 最多 20 个字、date 写成中文日期、amount 带 ¥、phrase 只要 5 个以内的汉字、name 不加省略号', () => {
    expect(formatField('thing1', { text: '一二三四五六七八九十一二三四五六七八九十一' })).toBe('一二三四五六七八九十一二三四五六七八九…');
    expect(formatField('date2', { text: '', date: '2026-11-08' })).toBe('2026年11月8日');
    expect(formatField('time3', { text: '', date: '2026-11-08' })).toBe('2026年11月8日 23:59');
    expect(formatField('amount4', { text: '', cents: 123456 })).toBe('¥1234.56');
    expect(formatField('number5', { text: '', cents: 300000 })).toBe('3000.00');
    expect(formatField('phrase6', { text: '快到期了哦' })).toBe('快到期了哦');
    expect(formatField('phrase7', { text: '马上就要到期了' })).toBe('马上就要到');
    expect(formatField('phrase8', { text: 'L3 观澜 · 享' })).toBe('观澜享');
    expect(formatField('name9', { text: 'L3 观澜 · 享' })).toBe('观澜享');
    expect(formatField('character_string10', { text: 'AB 12-中文' })).toBe('AB12-');
    expect(formatField('letter11', { text: 'AB 12' })).toBe('AB');
    expect(formatField('symbol12', { text: 'A·B-C%D' })).toBe('·-%');
  });

  it('到了那天、10:00–20:00 之间才排；网关取走、回报发出；再回报不认；小程序看得到已发', async () => {
    const a = await bound('演示·券发出');
    const c = await couponFor(a.memberId);
    const r = await consent(a.openid, { kind: 'coupon', couponCode: c.code });
    expect(r.statusCode).toBe(201);
    const { consentId, dueDate } = r.json();
    expect(dueDate).toBe(today);
    expect(await planReminders(deps(), at(today, 9, 59))).toMatchObject({ queued: 0 });
    expect(await planReminders(deps(), at(today, 20, 0))).toMatchObject({ queued: 0 });
    expect(await messageOf(consentId)).toBeNull();
    // 前一天到点的还不排
    await planReminders(deps(), at(shiftDate(today, -1), 12));
    expect(await messageOf(consentId)).toBeNull();
    await planReminders(deps(), at(today, 10, 0));
    const queued = await messageOf(consentId);
    expect(queued).toMatchObject({
      status: 'queued',
      page: 'pages/coupons/index',
      data: { thing1: { value: '浴资抵用券（三十元）满五十元可用·限周…' }, date2: { value: `${Number(c.validTo.slice(0, 4))}年${Number(c.validTo.slice(5, 7))}月${Number(c.validTo.slice(8))}日` }, thing3: { value: '到前台结账时出示会员码就能用' } },
    });
    // 每分钟再排一次：同一条同意不会排第二条
    await planReminders(deps(), at(today, 10, 1));
    const [row] = await ctx.sql<{ count: number }[]>`SELECT count(*)::int FROM mp_reminder_messages WHERE consent_id = ${consentId}`;
    expect(row!.count).toBe(1);
    expect(await leaseAt(at(today, 21))).toEqual([]);
    const got = (await leaseAt(at(today, 12))).filter((m) => m.id === queued!.id);
    expect(got).toEqual([{ id: queued!.id, leaseToken: expect.any(String), openid: a.openid, templateId: TPL.coupon, page: 'pages/coupons/index', data: queued!.data }]);
    // 取走的不会再给第二次
    expect((await leaseAt(at(today, 12, 1))).some((m) => m.id === queued!.id)).toBe(false);
    const wrong = await report([{ id: queued!.id, leaseToken: randomUUID(), outcome: 'sent' }]);
    expect(wrong.json()).toEqual({ accepted: 0 });
    const ok = await report([{ id: queued!.id, leaseToken: got[0]!.leaseToken, outcome: 'sent' }]);
    expect(ok.json()).toEqual({ accepted: 1 });
    expect(await messageOf(consentId)).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await report([{ id: queued!.id, leaseToken: got[0]!.leaseToken, outcome: 'failed', errcode: 43101 }])).json()).toEqual({ accepted: 0 });
    expect((await options(a.openid)).set.find((s) => s.couponCode === c.code)?.state).toBe('sent');
    await expect(ctx.sql`UPDATE mp_reminder_messages SET status = 'queued' WHERE id = ${queued!.id}`).rejects.toThrow(/不能/);
    await expect(ctx.sql`DELETE FROM mp_reminder_messages WHERE id = ${queued!.id}`).rejects.toThrow(/不能删除/);
    await expect(ctx.sql`UPDATE mp_reminder_consents SET due_date = due_date + 1 WHERE id = ${consentId}`).rejects.toThrow();
  });

  it('微信拒绝的记没发出（再设一次记新的一条）；要再试的隔一会儿再给、第 3 次还不行记没发出；发了没回音、过了期限没回报的记结果不明，不再发第二次', async () => {
    const a = await bound('演示·发送结果');
    const ids: number[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await couponFor(a.memberId);
      codes.push(c.code);
      ids.push((await consent(a.openid, { kind: 'coupon', couponCode: c.code })).json().consentId);
    }
    await planReminders(deps(), at(today, 12));
    const msgs = await Promise.all(ids.map(messageOf));
    const leased = new Map((await leaseAt(at(today, 12, 5), 50)).map((m) => [m.id, m]));
    const [refused, retried, silent, lost] = msgs.map((m) => leased.get(m!.id)!);
    expect((await report([{ id: refused!.id, leaseToken: refused!.leaseToken, outcome: 'failed', errcode: 43101, errmsg: 'user refuse to accept the msg' }])).json()).toEqual({ accepted: 1 });
    expect(await messageOf(ids[0]!)).toMatchObject({ status: 'failed', errcode: 43101, reason: '微信没发出：43101 user refuse to accept the msg' });
    // 没发出的：小程序里可以再设，再同意一次记新的一条（不返回那条没发出的）
    expect((await options(a.openid)).set.find((x) => x.couponCode === codes[0])?.state).toBe('done');
    const again = await consent(a.openid, { kind: 'coupon', couponCode: codes[0] });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toMatchObject({ replayed: false });
    expect(again.json().consentId).not.toBe(ids[0]);
    expect((await options(a.openid)).set.filter((x) => x.couponCode === codes[0]).map((x) => x.state).sort()).toEqual(['done', 'waiting']);
    // 再试：第 1 次以后隔 5 分钟、第 2 次以后隔 10 分钟再给；第 3 次还不行记没发出
    expect(await reportAt(at(today, 12, 6), [{ id: retried!.id, leaseToken: retried!.leaseToken, outcome: 'retry', errcode: -1, errmsg: 'system error' }])).toBe(1);
    expect(await messageOf(ids[1]!)).toMatchObject({ status: 'queued', attempts: 1, errcode: -1 });
    expect((await leaseAt(at(today, 12, 10), 50)).some((x) => x.id === retried!.id)).toBe(false);
    const second = (await leaseAt(at(today, 12, 11), 50)).find((x) => x.id === retried!.id)!;
    expect(await reportAt(at(today, 12, 12), [{ id: retried!.id, leaseToken: second.leaseToken, outcome: 'retry', errcode: -1, errmsg: 'system error' }])).toBe(1);
    expect(await messageOf(ids[1]!)).toMatchObject({ status: 'queued', attempts: 2 });
    expect((await leaseAt(at(today, 12, 21), 50)).some((x) => x.id === retried!.id)).toBe(false);
    const third = (await leaseAt(at(today, 12, 22), 50)).find((x) => x.id === retried!.id)!;
    expect(await reportAt(at(today, 12, 23), [{ id: retried!.id, leaseToken: third.leaseToken, outcome: 'retry', errcode: -1, errmsg: 'system error' }])).toBe(1);
    expect(await messageOf(ids[1]!)).toMatchObject({ status: 'failed', attempts: 3, reason: '试了 3 次没发出：-1 system error' });
    expect((await report([{ id: silent!.id, leaseToken: silent!.leaseToken, outcome: 'unknown', errmsg: 'timeout' }])).json()).toEqual({ accepted: 1 });
    expect(await messageOf(ids[2]!)).toMatchObject({ status: 'unknown', reason: '发了没收到微信的回音，不再发（timeout）' });
    // 取走以后 5 分钟没回报：还没到期限时不动，过了期限的下一次排期记结果不明，之后回报也不认
    await planReminders(deps(), at(today, 12, 9));
    expect(await messageOf(ids[3]!)).toMatchObject({ status: 'leased' });
    const r = await planReminders(deps(), at(today, 12, 30));
    expect(r.unknown).toBeGreaterThanOrEqual(1);
    expect(await messageOf(ids[3]!)).toMatchObject({ status: 'unknown', reason: '网关取走以后没回报：可能已经发出，不再发第二次' });
    expect((await report([{ id: lost!.id, leaseToken: lost!.leaseToken, outcome: 'sent' }])).json()).toEqual({ accepted: 0 });
    // 这四条（按消息的号）都不会再给网关；再设的那一条是新的消息
    const mids = msgs.map((m) => m!.id);
    expect((await leaseAt(at(today, 13), 50)).some((m) => mids.includes(m.id))).toBe(false);
  });

  it('同一个批次号再要一次（网关没收到回答）：还在期限里的原样再给，不另取；换了批次号的拿不到', async () => {
    const a = await bound('演示·批次号');
    const c = await couponFor(a.memberId);
    const id = (await consent(a.openid, { kind: 'coupon', couponCode: c.code })).json().consentId;
    await planReminders(deps(), at(today, 14));
    const batch = randomUUID();
    const first = (await leaseReminders(deps(), { limit: 50, batchId: batch }, at(today, 14, 1)));
    const mine = first.messages.find((m) => m.openid === a.openid)!;
    expect(mine).toBeTruthy();
    expect(first.leasedUntil).toBe(at(today, 14, 6).toISOString());
    const again = await leaseReminders(deps(), { limit: 50, batchId: batch }, at(today, 14, 2));
    expect(again.messages.find((m) => m.openid === a.openid)).toEqual(mine);
    expect(again.leasedUntil).toBe(first.leasedUntil);
    expect((await leaseAt(at(today, 14, 2), 50, randomUUID())).some((m) => m.openid === a.openid)).toBe(false);
    expect(await reportAt(at(today, 14, 3), [{ id: mine.id, leaseToken: mine.leaseToken, outcome: 'sent' }])).toBe(1);
    expect(await messageOf(id)).toMatchObject({ status: 'sent' });
  });

  it('网关来取时再看一次：过了到期日的不发（排好以后网关隔了一天才来）', async () => {
    const a = await bound('演示·取的时候过期');
    const c = await couponFor(a.memberId);
    const id = (await consent(a.openid, { kind: 'coupon', couponCode: c.code })).json().consentId;
    await planReminders(deps(), at(today, 15));
    expect(await messageOf(id)).toMatchObject({ status: 'queued' });
    // 券用到明天；后天中午网关才来（排好以后 45 个小时，还没到两天）
    expect((await leaseAt(at(shiftDate(c.validTo, 1), 12), 50)).some((m) => m.openid === a.openid)).toBe(false);
    expect(await messageOf(id)).toMatchObject({ status: 'skipped', reason: '已经过了到期日' });
  });

  it('到点时不用提醒的记不发：券用掉作废、解绑、会籍续上；排进来以后、取走以前解绑或作废的也不发', async () => {
    const a = await bound('演示·不用提醒');
    const used = await couponFor(a.memberId);
    const later = await couponFor(a.memberId);
    const end = shiftDate(today, 5);
    await setGrade(a.memberId, end);
    const c1 = (await consent(a.openid, { kind: 'coupon', couponCode: used.code })).json().consentId;
    const c2 = (await consent(a.openid, { kind: 'coupon', couponCode: later.code })).json().consentId;
    const c3 = (await consent(a.openid, { kind: 'membership', targetDate: end })).json().consentId;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${used.id}/void`, { reason: '测试作废' })).status).toBe(200);
    // 会籍续上了：周期最后一天变了
    await setGrade(a.memberId, shiftDate(today, 300));
    await planReminders(deps(), at(today, 12));
    expect(await messageOf(c1)).toMatchObject({ status: 'skipped', reason: '券已经作废', data: null });
    expect(await messageOf(c3)).toMatchObject({ status: 'skipped', reason: '会籍已经续上或变过' });
    expect(await messageOf(c2)).toMatchObject({ status: 'queued' });
    // 排进来以后、网关取走以前解绑了：取的时候不给、记不发
    await unbind(a.openid);
    expect((await leaseAt(at(today, 12, 1), 50)).some((m) => m.openid === a.openid)).toBe(false);
    expect(await messageOf(c2)).toMatchObject({ status: 'skipped', reason: '微信已经解绑' });
    // 解绑以后才到点的：排期时记不发
    const b = await bound('演示·解绑以后到点');
    const c = await couponFor(b.memberId);
    const c4 = (await consent(b.openid, { kind: 'coupon', couponCode: c.code })).json().consentId;
    await unbind(b.openid);
    await planReminders(deps(), at(today, 12, 2));
    expect(await messageOf(c4)).toMatchObject({ status: 'skipped', reason: '微信已经解绑' });
  });

  it('会籍：写现在的档阶、到期日与保级还差多少；补充期：进了补充期才发，写补充期到哪天；没进的不发', async () => {
    const a = await bound('演示·会籍发出');
    const end = shiftDate(today, 3);
    await setGrade(a.memberId, end);
    const m = (await consent(a.openid, { kind: 'membership', targetDate: end })).json().consentId;
    const g = (await consent(a.openid, { kind: 'grace', targetDate: end })).json().consentId;
    await planReminders(deps(), at(today, 12));
    const msg = await messageOf(m);
    expect(msg).toMatchObject({ status: 'queued', page: 'pages/me/index' });
    expect(msg!.data!.thing1!.value).toMatch(/^L1 /);
    expect(msg!.data!.time2!.value).toBe(`${Number(end.slice(0, 4))}年${Number(end.slice(5, 7))}月${Number(end.slice(8))}日 23:59`);
    // L1 门槛 5000 元，保级要周期内储值消费到 60%：3000 元
    expect(msg!.data!.amount3!.value).toBe('¥3000.00');
    expect(msg!.data!.thing4!.value).toBe('再消费¥3000.00可保级');
    // 补充期的还没到那天
    expect(await messageOf(g)).toBeNull();
    // 到了周期最后一天的下一天、进了补充期（每天的到期处理已经记好）
    const grace = shiftDate(end, 90);
    await setGrade(a.memberId, end, grace);
    await planReminders(deps(), at(shiftDate(end, 1), 12));
    const gm = await messageOf(g);
    expect(gm).toMatchObject({ status: 'queued', page: 'pages/me/index' });
    expect(gm!.data!.time2!.value).toBe(`${Number(grace.slice(0, 4))}年${Number(grace.slice(5, 7))}月${Number(grace.slice(8))}日 23:59`);
    expect(gm!.data!.thing4!.value).toBe('补充期内再消费¥3000.00可保级');
    // 没进补充期（保级了）的不发
    const b = await bound('演示·保级了');
    await setGrade(b.memberId, end);
    const g2 = (await consent(b.openid, { kind: 'grace', targetDate: end })).json().consentId;
    await setGrade(b.memberId, shiftDate(end, 365));
    await planReminders(deps(), at(shiftDate(end, 1), 12, 1));
    expect(await messageOf(g2)).toMatchObject({ status: 'skipped', reason: '没有进补充期（已保级或已调整）' });
  });

  it('赠金：写那一天作废的赠金还剩多少与门店名；用完了的不发', async () => {
    const a = await bound('演示·赠金发出');
    const recharge = () =>
      api(ctx.app, ctx.owner, 'POST', '/api/recharges', {
        idempotencyKey: randomUUID(),
        memberId: a.memberId,
        planId,
        paidAmount: 50000,
        bonusAmount: 5000,
        paymentMethod: 'cash',
        paymentConfirmed: true,
        bonusMode: 'custom',
      });
    expect((await recharge()).status).toBe(200);
    expect((await recharge()).status).toBe(200);
    const day = shiftDate(today, 4);
    const c = (await consent(a.openid, { kind: 'bonus', targetDate: day })).json().consentId;
    await planReminders(deps(), at(today, 12));
    const msg = await messageOf(c);
    const { storeName } = await loadSettings(ctx.sql);
    expect(msg).toMatchObject({ status: 'queued', page: 'pages/ledger/index', data: { amount1: { value: '¥100.00' }, date2: { value: `${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月${Number(day.slice(8))}日` } } });
    expect(msg!.data!.thing3!.value).toBe(storeName);
    // 用完了的不发
    const b = await bound('演示·赠金用完');
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', {
      idempotencyKey: randomUUID(),
      memberId: b.memberId,
      planId,
      paidAmount: 50000,
      bonusAmount: 5000,
      paymentMethod: 'cash',
      paymentConfirmed: true,
      bonusMode: 'custom',
    });
    expect(r.status).toBe(200);
    const c2 = (await consent(b.openid, { kind: 'bonus', targetDate: day })).json().consentId;
    await ctx.sql`UPDATE bonus_lots SET remaining = 0 WHERE member_id = ${b.memberId}`;
    await planReminders(deps(), at(today, 12, 1));
    expect(await messageOf(c2)).toMatchObject({ status: 'skipped', reason: '那一天到期的赠金已经用完' });
    await ctx.sql`UPDATE bonus_lots SET remaining = amount WHERE member_id = ${b.memberId}`;
  });

  it('小程序关掉、到期提醒关掉：网关取不到消息，也不排；打开以后照常', async () => {
    const a = await bound('演示·关掉以后');
    const c = await couponFor(a.memberId);
    const id = (await consent(a.openid, { kind: 'coupon', couponCode: c.code })).json().consentId;
    await saveRules({ enabled: false });
    await planReminders(deps(), at(today, 12, 30));
    expect(await messageOf(id)).toBeNull();
    await saveRules();
    await planReminders(deps(), at(today, 12, 31));
    expect(await messageOf(id)).toMatchObject({ status: 'queued' });
    await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: false })} WHERE key = 'mp_rules'`;
    expect(await leaseAt(at(today, 12, 32))).toEqual([]);
    await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: true })} WHERE key = 'mp_rules'`;
    expect((await leaseAt(at(today, 12, 33), 50)).some((m) => m.openid === a.openid)).toBe(true);
    // 排好以后两天没发出去的（网关一直没来、提醒关着）：取的时候不再发
    const b = await bound('演示·排好太久');
    // 会籍 5 天后到期（到期日还没过，只是排好太久）
    await setGrade(b.memberId, shiftDate(today, 5));
    const oldId = (await consent(b.openid, { kind: 'membership', targetDate: shiftDate(today, 5) })).json().consentId;
    await planReminders(deps(), at(today, 12, 34));
    expect(await messageOf(oldId)).toMatchObject({ status: 'queued' });
    expect((await leaseAt(new Date(at(today, 12, 34).getTime() + 49 * 3_600_000), 50)).some((m) => m.openid === b.openid)).toBe(false);
    expect(await messageOf(oldId)).toMatchObject({ status: 'skipped', reason: '排好以后两天没发出去（网关没来取或提醒关着），不再发' });
    // 网关的接口只认网关密钥：不带的拒绝
    const noKey = await mp.inject({ method: 'POST', url: '/api/mp/gateway/reminders/lease', payload: {} });
    expect(noKey.statusCode).toBe(401);
    // 网关的路由：按此刻的时间取，给的是 messages
    const route = await call('POST', '/api/mp/gateway/reminders/lease', null, { limit: 1 });
    expect(route.statusCode).toBe(200);
    expect(Array.isArray(route.json().messages)).toBe(true);
  });

  it('店主换了模板：按旧模板同意的算「不用发了」，可以按新的模板再设一条；排期时旧的不发、新的照发', async () => {
    const a = await bound('演示·换模板');
    const c = await couponFor(a.memberId);
    const first = await consent(a.openid, { kind: 'coupon', couponCode: c.code });
    expect(first.statusCode).toBe(201);
    const NEW = 'tplCoupon2-0123456789abcdefABCD';
    await saveRules({ coupon: { templateId: NEW, fields: [{ key: 'thing1', source: 'name' }] } });
    const o = await options(a.openid);
    expect(o.templates.coupon).toBe(NEW);
    expect(o.set.find((x) => x.couponCode === c.code)?.state).toBe('done');
    const second = await consent(a.openid, { kind: 'coupon', couponCode: c.code });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().consentId).not.toBe(first.json().consentId);
    // 再点一次：返回新的那条
    const third = await consent(a.openid, { kind: 'coupon', couponCode: c.code });
    expect(third.json()).toMatchObject({ consentId: second.json().consentId, replayed: true });
    await planReminders(deps(), at(today, 16));
    expect(await messageOf(first.json().consentId)).toMatchObject({ status: 'skipped', reason: '顾客同意时的模板已经换掉了' });
    expect(await messageOf(second.json().consentId)).toMatchObject({ status: 'queued', data: { thing1: { value: expect.any(String) } } });
    await saveRules();
  });

  it('后台：最近 30 天同意了多少、各状态多少、还没排的有多少、网关最近一次来取的时间；自检照常全过', async () => {
    const d = await adminData();
    expect(d.stats.consents).toBeGreaterThan(5);
    expect(d.stats.byStatus.sent).toBeGreaterThanOrEqual(1);
    expect(d.stats.byStatus.skipped).toBeGreaterThanOrEqual(1);
    expect(d.stats.byStatus.unknown).toBeGreaterThanOrEqual(2);
    expect(d.stats.waiting).toBeGreaterThanOrEqual(1);
    expect(d.stats.overdue).toBeGreaterThanOrEqual(0);
    expect(d.lastLeaseAt).not.toBeNull();
    expect(d.recent.length).toBeGreaterThan(5);
    expect(d.recent[0]).toMatchObject({ kind: expect.any(String), memberName: expect.any(String), status: expect.any(String) });
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });
});
