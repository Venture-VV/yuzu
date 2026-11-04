// 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）：本店权益自动发放。
//   · 权益清单：一键导入（编号已有的跳过、导入为草稿、文档写明暂缓的为暂缓）、权限、改（版本号）、发布的条件（折扣类要适用明细与折扣，v0.7.25）；
//   · 券类：升档当场补发本期差额（按档阶取数量、不相加），每天的自动任务发下一期的、有效到期末；降档不收回；清单改了同一天再跑；
//   · 事件礼：首充礼一次、升档 / 升阶的升级礼、保级礼、生日礼、节日关怀；
//   · 服务类：登记使用数次数、到上限拒绝、作废后可以再登记、同一编号重提、确认作废后原请求晚到不生效；
//   · 会员详情「本月可享」、看板汇总、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BENEFIT_CATALOG,
  benefitEligible,
  benefitQuantity,
  periodEnd,
  TICKET_EXTENSION_DEFAULT_ROWS,
  type Benefit,
  type BenefitCatalog,
  type MemberBenefits,
} from '../src/shared/benefits';
import { businessDateOf } from '../src/shared/business-date';
import type { CouponTemplate, MemberCoupons } from '../src/shared/coupons';
import { shiftDate } from '../src/shared/labels';
import { rechargeOutcome, tierTargets, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import { benefitChecks, memberBenefits, registerBenefitUse, runBenefitsDaily } from '../src/server/modules/benefits';
import { issueBirthdayCoupons } from '../src/server/modules/coupons';
import { membershipChecks, runMembershipDaily } from '../src/server/modules/membership';
import { createStaff } from '../src/server/modules/staff';
import { api, consumeBody, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: string;
let duty: string;
let today: string;

const yuan = (n: number) => Math.round(n * 100);
const noonOf = (date: string) => new Date(`${date}T12:00:00+08:00`);
const nextMonthFirst = (date: string) => shiftDate(periodEnd('month', date), 1);

const catalog = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', '/api/benefits')).body as BenefitCatalog;
const byCode = async (code: string) => (await catalog()).items.find((b) => b.code === code)!;
const edit = async (code: string, patch: Partial<Benefit>, cookie = ctx.owner) => {
  const b = await byCode(code);
  const { id, version, name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, content, conditions } = b;
  return api(ctx.app, cookie, 'PUT', `/api/benefits/${id}`, {
    expectedVersion: version,
    ...{ name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, content, conditions },
    ...patch,
  });
};
const setStatus = async (code: string, status: 'published' | 'paused', cookie = ctx.owner) => {
  const b = await byCode(code);
  return api(ctx.app, cookie, 'POST', `/api/benefits/${b.id}/status`, { expectedVersion: b.version, status });
};
const publish = async (code: string, patch: Partial<Benefit>) => {
  const e = await edit(code, patch);
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  const p = await setStatus(code, 'published');
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return p.body as Benefit;
};
const template = async (name: string) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name, kind: 'cash', faceValue: 5000, validity: 'days', validDays: 30 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CouponTemplate;
};
const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
const recharge = async (memberId: number, paid: number) => {
  const info = await gradeOf(memberId);
  const bonus = rechargeOutcome(await rules(), info.state.grade, info.rollingRechargeCents, paid).bonusCents;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', {
    idempotencyKey: randomUUID(),
    memberId,
    planId: null,
    paidAmount: paid,
    bonusAmount: bonus,
    paymentMethod: 'wechat',
    paymentConfirmed: true,
    bonusMode: 'auto',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const spend = async (memberId: number, amount: number) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(memberId, amount));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
let phoneNo = 0;
const newMember = async (name: string, birthday: string | null = null) => {
  phoneNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone: `1992222${String(phoneNo).padStart(4, '0')}`, ...(birthday ? { birthday } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as number;
};
const benefitsOf = async (memberId: number, cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', `/api/members/${memberId}/benefits`)).body as MemberBenefits;
const itemOf = async (memberId: number, code: string) => (await benefitsOf(memberId)).items.find((i) => i.code === code);
const couponsOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/coupons`)).body as MemberCoupons;
const grantsOf = (memberId: number) =>
  ctx.sql<{ code: string; reason: string; periodKey: string | null; eventKey: string | null; quantity: number; target: number | null }[]>`
    SELECT b.code, g.reason, g.period_key, g.event_key, g.quantity, g.target FROM benefit_grants g JOIN benefits b ON b.id = g.benefit_id
    WHERE g.member_id = ${memberId} ORDER BY g.id`;
const use = (memberId: number, benefitId: number, opts: { cookie?: string; key?: string; quantity?: number; note?: string } = {}) =>
  api(ctx.app, opts.cookie ?? ctx.clerk, 'POST', `/api/members/${memberId}/benefit-uses`, {
    clientKey: opts.key ?? randomUUID(),
    benefitId,
    quantity: opts.quantity ?? 1,
    note: opts.note ?? '',
  });
/** 会员权益与会员档阶的自检（这里把每天的自动任务推到未来跑过，「会员到期处理」一项按那天看会报之后建档的会员，不在这里核对） */
const allChecksOk = async () => {
  const membership = (await membershipChecks(ctx.sql)).filter((c) => !c.label.includes('会员到期处理'));
  for (const c of [...(await benefitChecks(ctx.sql)), ...membership]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};

let massage: CouponTemplate;
let gift: CouponTemplate;

beforeAll(async () => {
  ctx = await setup();
  for (const [username, role] of [['manager', 'store_manager'], ['duty', 'duty_manager']] as const) {
    await createStaff(ctx.sql, { username, displayName: username, role, password: PASSWORD, mustChangePassword: false });
  }
  manager = await login(ctx.app, 'manager');
  duty = await login(ctx.app, 'duty');
  today = businessDateOf(new Date(), 'Asia/Shanghai', 6);
  // 首充、续充最低放到 1,000（只为凑档方便）
  const r = await rules();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(1000) })).status).toBe(200);
  massage = await template('按摩足浴券');
  gift = await template('礼遇券');
});
afterAll(async () => {
  await ctx?.close();
});

describe('权益清单', () => {
  it('一键导入：店主、店总；59 项全是草稿，暂缓 4 项；再导入编号已有的跳过', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/benefits/import')).status).toBe(403);
    expect((await api(ctx.app, duty, 'GET', '/api/benefits')).status).toBe(403);
    const first = await api(ctx.app, manager, 'POST', '/api/benefits/import');
    expect(first.body).toEqual({ created: 59, skipped: 0 });
    expect(BENEFIT_CATALOG).toHaveLength(59);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import');
    expect(again.body).toEqual({ created: 0, skipped: 59 });
    const c = await catalog();
    expect(c.importable).toBe(0);
    expect(c.items.filter((b) => b.status === 'paused').map((b) => b.code).sort()).toEqual(['QY-035', 'QY-048', 'QY-050', 'QY-057']);
    expect(c.items.filter((b) => b.status === 'published')).toHaveLength(0);
    const count = (cat: string) => c.items.filter((b) => b.category === cat).length;
    // QY-004 浴票延迟（v0.7.25 续，迁移 045）归「浴票延迟」类，不再是服务与资格；
    // v0.7.28：QY-057 会员挑战是事件礼「每月到店满几次」，QY-016 停车优惠是服务类（标了停车优惠）
    expect({ coupon: count('coupon'), event: count('event'), discount: count('discount'), extension: count('extension'), info: count('info'), service: count('service') }).toEqual({
      coupon: 11,
      event: 6,
      discount: 3,
      extension: 1,
      info: 1,
      service: 37,
    });
    expect(c.items.find((b) => b.code === 'QY-005')).toMatchObject({ category: 'coupon', period: 'year', quantity: 1, startLabel: 'L1·初' });
    expect(c.items.find((b) => b.code === 'QY-052')).toMatchObject({ category: 'event', events: ['grade_up', 'tier_up'], startLabel: 'L0·会员' });
    expect(c.items.find((b) => b.code === 'P021')).toMatchObject({ startGrade: null, startLabel: '未配置' });
    // QY-004 浴票延迟（v0.7.26，M50 店主 11-04 定按默认）：从 L1·初 起 30 分钟，每一档初阶 30、享阶 60、尊阶 90 分钟；内容按原文，仍是草稿
    const qy004 = c.items.find((b) => b.code === 'QY-004')!;
    expect(qy004).toMatchObject({
      category: 'extension',
      status: 'draft',
      version: 1,
      quantity: 30,
      startGrade: 1,
      startTier: 0,
      startLabel: 'L1·初',
      content: '浴票延迟：初阶30分钟、享阶1小时、尊阶1.5—2小时。',
    });
    expect(qy004.tierQuantities).toEqual([...TICKET_EXTENSION_DEFAULT_ROWS]);
    expect(qy004.tierQuantities).toHaveLength(17);
    // 按会员现在的档阶取一行（不相加）：L0 不享；L1–L6 每一档 初 30、享 60、尊 90
    expect(benefitEligible(qy004, 0, null)).toBe(false);
    for (let grade = 1; grade <= 6; grade += 1) {
      for (const [tier, minutes] of [30, 60, 90].entries()) {
        expect(benefitEligible(qy004, grade, tier), `L${grade}·${tier}`).toBe(true);
        expect(benefitQuantity(qy004, grade, tier), `L${grade}·${tier}`).toBe(minutes);
      }
    }
  });

  it('发布要条件齐全：券类要券模板；折扣类要适用明细与折扣（QY-011 按会员文档预填）；没配置起点的不能发布；版本号对不上拒绝', async () => {
    const noTemplate = await setStatus('QY-040', 'published');
    expect(noTemplate.status).toBe(422);
    expect(noTemplate.body.error.code).toBe('BENEFIT_NOT_PUBLISHABLE');
    expect(noTemplate.body.error.message).toContain('请选择发哪张券');
    // 折扣类（v0.7.25）：会员日没填适用明细与折扣不能发布；QY-011 导入时按会员文档预填了客房房费 7.5 / 6.5 / 5.5 / 5 折
    const memberDay = (await setStatus('QY-054', 'published')).body.error.message;
    expect(memberDay).toContain('请选择打哪些明细');
    expect(memberDay).toContain('请填写起点的折扣');
    const qy011 = await byCode('QY-011');
    expect([qy011.discountTarget, qy011.quantity, qy011.tierQuantities, qy011.status]).toEqual([
      'room',
      75,
      [
        { grade: 4, tier: 0, quantity: 65 },
        { grade: 5, tier: 0, quantity: 55 },
        { grade: 6, tier: 0, quantity: 50 },
      ],
      'draft',
    ]);
    expect((await edit('QY-011', { quantity: 5 })).body.error.message).toContain('付几成');
    expect((await setStatus('P021', 'published')).body.error.message).toContain('请先设配置起点');
    const b = await byCode('QY-040');
    const stale = await api(ctx.app, ctx.owner, 'PUT', `/api/benefits/${b.id}`, { ...b, expectedVersion: b.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('BENEFIT_CHANGED');
    // 各档阶数量要高于起点、券每期最多 10 张；服务类设了每月就要填次数
    expect((await edit('QY-040', { tierQuantities: [{ grade: 1, tier: 0, quantity: 2 }] })).body.error.message).toContain('要高于配置起点');
    expect((await edit('QY-040', { quantity: 11 })).body.error.message).toContain('最多 10 张');
    expect((await edit('QY-001', { period: 'month', quantity: null })).body.error.message).toContain('就要填几次');
    // 没改什么不加版本号
    const same = await edit('QY-040', {});
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(b.version);
  });
});

describe('券类：当场补发、每期发放', () => {
  let m: number;

  it('发布「按摩/足浴项目券」（L2·初 起每月 1 张，L3·初 起 2 张）；升到 L2 当场发 1 张、升到 L3 再补 1 张，有效到月底', async () => {
    await publish('QY-040', { templateId: massage.id, quantity: 1, tierQuantities: [{ grade: 3, tier: 0, quantity: 2 }] });
    m = await newMember('券类会员');
    await recharge(m, yuan(5000));
    expect(await grantsOf(m)).toEqual([]);
    await recharge(m, yuan(5000));
    expect((await gradeOf(m)).state.grade).toBe(2);
    expect(await grantsOf(m)).toEqual([{ code: 'QY-040', reason: 'top_up', periodKey: today.slice(0, 7), eventKey: null, quantity: 1, target: 1 }]);
    await recharge(m, yuan(20000));
    expect((await gradeOf(m)).state.grade).toBe(3);
    const grants = await grantsOf(m);
    expect(grants.map((g) => [g.quantity, g.target])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    const coupons = (await couponsOf(m)).coupons.filter((c) => c.templateId === massage.id);
    expect(coupons).toHaveLength(2);
    for (const c of coupons) expect(c).toMatchObject({ issueKind: 'benefit', validFrom: today, validTo: periodEnd('month', today) });
    expect(await itemOf(m, 'QY-040')).toMatchObject({ category: 'coupon', quantity: 2, granted: 2, available: 2, periodKey: today.slice(0, 7) });
    await allChecksOk();
  });

  it('每天的自动任务：本月已发够不再发；下个月第一天按档阶发 2 张，有效到下月底；当天再跑什么都不做', async () => {
    const run = await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today));
    expect(run).toMatchObject({ processed: 0, coupons: 0, error: null });
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today))).toBeNull();
    const next = nextMonthFirst(today);
    const nextRun = await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(next));
    expect(nextRun).toMatchObject({ businessDate: next, processed: 1, coupons: 2, error: null });
    const g = (await grantsOf(m)).at(-1)!;
    expect(g).toMatchObject({ reason: 'monthly', periodKey: next.slice(0, 7), quantity: 2, target: 2 });
    const later = (await couponsOf(m)).coupons.filter((c) => c.validFrom === next);
    expect(later.map((c) => c.validTo)).toEqual([periodEnd('month', next), periodEnd('month', next)]);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(next))).toBeNull();
    await allChecksOk();
  });

  it('权益清单改了（数量加到 3），同一天再跑一次只补差额；暂缓以后不再发，已发的照常可用', async () => {
    const next = nextMonthFirst(today);
    expect((await edit('QY-040', { tierQuantities: [{ grade: 3, tier: 0, quantity: 3 }] })).status).toBe(200);
    // 运行记录一个营业日一条，同一天再跑累加：上一次 1 位 2 张，这次 1 位 1 张
    const run = await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(next));
    expect(run).toMatchObject({ processed: 2, coupons: 3 });
    expect((await grantsOf(m)).at(-1)).toMatchObject({ periodKey: next.slice(0, 7), quantity: 1, target: 3 });
    expect((await setStatus('QY-040', 'paused')).status).toBe(200);
    const after = nextMonthFirst(next);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(after))).toMatchObject({ coupons: 0 });
    expect((await couponsOf(m)).coupons.filter((c) => c.templateId === massage.id && c.state === 'available')).toHaveLength(2);
    expect(await itemOf(m, 'QY-040')).toBeUndefined();
    await allChecksOk();
  });
});

describe('事件礼', () => {
  it('首充礼只在第一笔充值发；升级礼在充值升档、消费升阶时各发一次；同一档再充值不发', async () => {
    await publish('QY-051', { templateId: gift.id, quantity: 1 });
    await publish('QY-052', { templateId: gift.id, quantity: 1, tierQuantities: [{ grade: 3, tier: 0, quantity: 2 }] });
    const m = await newMember('事件礼会员');
    await recharge(m, yuan(5000));
    expect((await grantsOf(m)).map((g) => [g.code, g.eventKey?.replace(/e\d+$/, 'e#'), g.quantity])).toEqual([
      ['QY-052', 'grade_up:e#', 1],
      ['QY-051', 'first', 1],
    ]);
    await recharge(m, yuan(1000));
    expect(await grantsOf(m)).toHaveLength(2);
    // 消费升阶：L1 的享阶要消费 5,000 × 30% = 1,500
    await spend(m, yuan(1500));
    expect((await gradeOf(m)).state).toMatchObject({ grade: 1, tier: 1 });
    expect((await grantsOf(m)).at(-1)).toMatchObject({ code: 'QY-052', eventKey: expect.stringMatching(/^tier_up:e\d+$/), quantity: 1 });
    // 升到 L3：按 L3 的数量发 2 张
    await recharge(m, yuan(25000));
    expect((await gradeOf(m)).state.grade).toBe(3);
    expect((await grantsOf(m)).at(-1)).toMatchObject({ code: 'QY-052', eventKey: expect.stringMatching(/^grade_up:e\d+$/), quantity: 2 });
    const item = await itemOf(m, 'QY-052');
    expect(item).toMatchObject({ category: 'event', granted: 3, quantity: 2 });
    await allChecksOk();
  });

  it('保级礼：周期到期时消费达到尊阶门槛保级，发一次', async () => {
    await publish('QY-053', { templateId: gift.id, quantity: 1 });
    const m = await newMember('保级会员');
    await recharge(m, yuan(5000));
    await spend(m, yuan(3000));
    const end = (await gradeOf(m)).state.cycleEnd!;
    // 同一天建档、升档的会员周期都在这天到期，一并处理；这位保级
    const run = await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(shiftDate(end, 1)));
    expect(run).toMatchObject({ error: null });
    expect(run!.retained).toBeGreaterThanOrEqual(1);
    expect((await gradeOf(m)).state).toMatchObject({ grade: 1, tier: 2, cycleStart: shiftDate(end, 1) });
    const retain = (await grantsOf(m)).filter((g) => g.code === 'QY-053');
    expect(retain).toEqual([expect.objectContaining({ reason: 'event', eventKey: expect.stringMatching(/^retain:e\d+$/), quantity: 1 })]);
    await allChecksOk();
  });

  it('生日礼：L1·初 起；建档时还是 L0 不发，生日月里升到 L1 当场发，每年一次', async () => {
    await publish('QY-020', { templateId: gift.id, quantity: 1 });
    const m = await newMember('生日会员', `1990-${today.slice(5, 7)}-15`);
    expect((await grantsOf(m)).filter((g) => g.code === 'QY-020')).toHaveLength(0);
    await recharge(m, yuan(5000));
    expect((await grantsOf(m)).filter((g) => g.code === 'QY-020')).toEqual([expect.objectContaining({ eventKey: `birthday:${today.slice(0, 4)}` })]);
    await recharge(m, yuan(5000));
    expect((await grantsOf(m)).filter((g) => g.code === 'QY-020')).toHaveLength(1);
    // 每天的自动任务也不重发
    await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today));
    expect((await grantsOf(m)).filter((g) => g.code === 'QY-020')).toHaveLength(1);
  });

  it('节日关怀：设置的日期当天起 7 天内由每天的自动任务发给够格的会员，每个日期一次；不够格的不发', async () => {
    const festival = shiftDate(today, 2);
    await publish('QY-055', { templateId: gift.id, quantity: 1, festivalDates: [festival] });
    const l0 = await newMember('节日 L0');
    const l1 = await newMember('节日 L1');
    await recharge(l1, yuan(5000));
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(shiftDate(festival, 3)))).toMatchObject({ error: null });
    expect((await grantsOf(l1)).filter((g) => g.code === 'QY-055')).toEqual([expect.objectContaining({ eventKey: `festival:${festival}` })]);
    expect((await grantsOf(l0)).filter((g) => g.code === 'QY-055')).toHaveLength(0);
    // 过了 7 天新够格的不补
    const late = await newMember('节日晚到');
    await recharge(late, yuan(5000));
    await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(shiftDate(festival, 8)));
    expect((await grantsOf(late)).filter((g) => g.code === 'QY-055')).toHaveLength(0);
    await allChecksOk();
  });

  it('看板汇总与后台清单的本月数字；发券规则里还有启用的升级礼时提示会各发一份', async () => {
    const s = await api(ctx.app, manager, 'GET', '/api/benefits/summary');
    expect(s.status).toBe(200);
    expect(s.body.coupons).toBeGreaterThan(0);
    expect(s.body.byReason.event).toBeGreaterThan(0);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/benefits/summary')).status).toBe(403);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/rules', { clientKey: randomUUID(), kind: 'level_up', level: 2, templateId: gift.id, quantity: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await catalog()).warnings.join('')).toContain('启用的升级礼');
  });
});

describe('服务类：登记使用', () => {
  let m: number;
  let channel: Benefit;

  it('「会员专属通道」L2·初 起每月 2 次：够格才能登记，到上限拒绝；作废后可以再登记', async () => {
    channel = await publish('QY-001', { period: 'month', quantity: 2 });
    const l0 = await newMember('服务 L0');
    const no = await use(l0, channel.id);
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe('BENEFIT_NOT_ELIGIBLE');
    m = await newMember('服务会员');
    await recharge(m, yuan(10000));
    const first = await use(m, channel.id, { note: '入场' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.use).toMatchObject({ quantity: 1, periodKey: today.slice(0, 7), limitAt: 2, note: '入场', status: 'active' });
    expect((await use(m, channel.id, { cookie: duty })).status).toBe(201);
    const over = await use(m, channel.id);
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'BENEFIT_LIMIT', details: { used: 2, limit: 2 } });
    expect(await itemOf(m, 'QY-001')).toMatchObject({ used: 2, quantity: 2 });
    // 店员只能作废自己今天登记的；店总可以作废别人的
    const dutyUse = (await benefitsOf(m)).uses.find((u) => u.staffName === 'duty')!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/benefit-uses/${dutyUse.id}/void`, { reason: '登记错了' })).status).toBe(403);
    const voided = await api(ctx.app, manager, 'POST', `/api/benefit-uses/${dutyUse.id}/void`, { reason: '登记错了' });
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: '登记错了' });
    expect((await use(m, channel.id)).status).toBe(201);
    await allChecksOk();
  });

  it('同一编号重提返回原来那条；内容不同拒绝；确认作废后原请求晚到也不登记', async () => {
    const key = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/benefit-uses/${(await benefitsOf(m)).uses[0]!.id}/void`, { reason: '腾出次数' })).status).toBe(200);
    const a = await use(m, channel.id, { key });
    expect(a.status).toBe(201);
    const again = await use(m, channel.id, { key });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, use: { id: a.body.use.id } });
    expect((await use(m, channel.id, { key, quantity: 2 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 已登记的：查回找到、不能作废
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key}?type=benefit_use`);
    expect(found.body).toMatchObject({ found: true, refId: a.body.use.id });
    // 没登记的：确认作废后原请求晚到拒绝
    const lost = randomUUID();
    const abandon = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'benefit_use', summary: '会员专属通道' });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(200);
    const late = await use(m, channel.id, { key: lost });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
  });

  it('券类、没发布的、暂缓的不能登记；不计次的服务可以登记留痕；他店查询岗位不能登记', async () => {
    const coupon = await byCode('QY-019');
    expect((await use(m, coupon.id)).body.error.code).toBe('BENEFIT_UNAVAILABLE');
    const gift52 = await byCode('QY-052');
    expect((await use(m, gift52.id)).body.error.code).toBe('BENEFIT_NOT_SERVICE');
    const free = await publish('QY-010', {});
    const r = await use(m, free.id, { quantity: 3 });
    expect(r.status).toBe(201);
    expect(r.body.use).toMatchObject({ periodKey: null, limitAt: null, quantity: 3 });
    expect(await itemOf(m, 'QY-010')).toMatchObject({ quantity: null, used: 3 });
    expect((await setStatus('QY-010', 'paused')).status).toBe(200);
    expect((await use(m, free.id)).body.error.code).toBe('BENEFIT_UNAVAILABLE');
  });

  it('会员详情「本月可享」：按会员现在的档阶列出能用的，还没够格的列在「升档以后」', async () => {
    const mine = await benefitsOf(m);
    expect(mine.state.grade).toBe(2);
    const codes = mine.items.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['QY-001', 'QY-051', 'QY-052', 'QY-053', 'QY-020', 'QY-055']));
    expect(codes).not.toContain('QY-040');
    const fresh = await newMember('只有 L0');
    const l0 = await benefitsOf(fresh);
    expect(l0.items.map((i) => i.code)).toEqual(expect.arrayContaining(['QY-051', 'QY-052', 'QY-053']));
    expect(l0.upcoming.map((u) => u.code)).toContain('QY-001');
    await allChecksOk();
  });
});

// Codex 自动审查 98806a3、32d3f31：每天的自动发放当天跑完以后不再翻会员——补填的生日、当周才够格的节日关怀要当场看；
// 停机后补跑到期、一次连走几步时，本期券类与生日礼按走完以后的状态发，中间早已过去的档阶不发；到期还没处理的会员不按旧档阶发
describe('当天改了生日、节日当周才够格、补跑多步到期', () => {
  const profileOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}`)).body as { name: string; phone: string };
  const setBirthday = async (memberId: number, birthday: string | null) => {
    const { name, phone } = await profileOf(memberId);
    const r = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${memberId}`, { name, phone, birthday });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const birthdayGrants = async (memberId: number) => (await grantsOf(memberId)).filter((g) => g.code === 'QY-020');

  it('自动发放今天已经跑完，再补填生日月的生日：当场发生日礼，再改同月的日期、改到别的月都不再发', async () => {
    const m = await newMember('补填生日');
    await recharge(m, yuan(5000));
    expect(await birthdayGrants(m)).toEqual([]);
    await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today));
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today))).toBeNull();
    await setBirthday(m, `1991-${today.slice(5, 7)}-20`);
    expect(await birthdayGrants(m)).toEqual([expect.objectContaining({ reason: 'event', eventKey: `birthday:${today.slice(0, 4)}`, quantity: 1 })]);
    await setBirthday(m, `1991-${today.slice(5, 7)}-01`);
    const otherMonth = String((Number(today.slice(5, 7)) % 12) + 1).padStart(2, '0');
    await setBirthday(m, `1991-${otherMonth}-01`);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today))).toBeNull();
    expect(await birthdayGrants(m)).toHaveLength(1);
    await allChecksOk();
  });

  it('节日关怀的那一周里升档才够格：当场发，不等第二天（自动发放当天已跑完，节日只剩当天也不错过）', async () => {
    const b = await byCode('QY-055');
    expect((await edit('QY-055', { festivalDates: [...b.festivalDates, today] })).status).toBe(200);
    await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today));
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today))).toBeNull();
    const festivalGrants = async (memberId: number) => (await grantsOf(memberId)).filter((g) => g.code === 'QY-055');
    const m = await newMember('节日当周升档');
    expect(await festivalGrants(m)).toEqual([]);
    await recharge(m, yuan(5000));
    expect(await festivalGrants(m)).toEqual([expect.objectContaining({ reason: 'event', eventKey: `festival:${today}`, quantity: 1 })]);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(today))).toBeNull();
    await recharge(m, yuan(5000));
    expect(await festivalGrants(m)).toHaveLength(1);
    await allChecksOk();
  });

  it('L2 会员周期与补充期都过了才处理（先进补充期、再降到 L1）：处理之前的自动发放与生日礼都跳过这位；本月券与生日礼按 L1 发，不按中间的 L2', async () => {
    // L2·初 起的月度券、生日礼改成 L2·初 起；L1·尊 起的月度券作对照（L1·尊 够格，处理完当场补发）
    await publish('QY-038', { templateId: massage.id, startGrade: 2, startTier: 0, period: 'month', quantity: 1 });
    await publish('QY-036', { templateId: massage.id, startGrade: 1, startTier: 2, period: 'month', quantity: 1 });
    expect((await edit('QY-020', { startGrade: 2, startTier: 0 })).status).toBe(200);
    const r = await rules();
    const m = await newMember('停机补跑');
    await recharge(m, yuan(5000));
    await recharge(m, yuan(5000));
    const before = (await gradeOf(m)).state;
    expect(before.grade).toBe(2);
    // 周期内只消费到享阶（不到尊阶）：到期进补充期，补充期结束仍不够 → 降档
    await spend(m, tierTargets(r, 2).enjoy);
    const graceEnd = shiftDate(before.cycleEnd!, r.graceDays);
    const day = shiftDate(graceEnd, 1);
    // 生日在处理的那个月
    await setBirthday(m, `1990-${day.slice(5, 7)}-10`);
    // 那天到期处理还没轮到这一位（或这一位出错、锁等超时）：会员权益的自动发放、发券规则的 L2 生日礼都先跳过，不按过期的 L2 发
    const rule = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/rules', { clientKey: randomUUID(), kind: 'birthday', level: 2, templateId: gift.id, quantity: 1 });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day));
    await issueBirthdayCoupons({ sql: ctx.sql, config: ctx.config }, noonOf(day));
    expect((await grantsOf(m)).filter((g) => g.periodKey === day.slice(0, 7) || g.eventKey === `birthday:${day.slice(0, 4)}`)).toEqual([]);
    expect(await ctx.sql`SELECT id FROM coupon_issues WHERE member_id = ${m} AND kind = 'birthday'`).toHaveLength(0);
    const run = await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day));
    expect(run).toMatchObject({ error: null });
    const events = await ctx.sql<{ kind: string; toGrade: number; toTier: number | null }[]>`
      SELECT kind, to_grade, to_tier FROM member_grade_events WHERE member_id = ${m} AND business_date = ${day} ORDER BY id`;
    expect(events).toEqual([
      { kind: 'grace_start', toGrade: 2, toTier: 1 },
      { kind: 'downgrade', toGrade: 1, toTier: 2 },
    ]);
    const month = (await grantsOf(m)).filter((g) => g.periodKey === day.slice(0, 7));
    expect(month).toEqual([expect.objectContaining({ code: 'QY-036', reason: 'top_up', quantity: 1, target: 1 })]);
    expect((await birthdayGrants(m)).filter((g) => g.eventKey === `birthday:${day.slice(0, 4)}`)).toEqual([]);
    // 当天的自动发放也不按 L2 补
    await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day));
    expect((await grantsOf(m)).filter((g) => g.periodKey === day.slice(0, 7)).map((g) => g.code)).toEqual(['QY-036']);
    await allChecksOk();
  });

  it('到期还没处理的会员：「本月可享」按推算到当天的档阶列；登记服务类先处理到期，不按应该已经降掉的 L2 判断够格', async () => {
    const m = await newMember('到期未处理登记');
    await recharge(m, yuan(5000));
    await recharge(m, yuan(5000));
    const st = (await gradeOf(m)).state;
    expect(st.grade).toBe(2);
    // 周期内没有消费：周期结束的下一天应该降到 L1·尊；那天到期处理还没处理这一位（出错、锁等超时）
    const day = shiftDate(st.cycleEnd!, 1);
    const card = await memberBenefits(ctx.sql, m, day);
    expect(card.state).toMatchObject({ grade: 1, tier: 2 });
    expect(card.items.map((i) => i.code)).not.toContain('QY-001');
    expect(card.upcoming.map((u) => u.code)).toContain('QY-001');
    // 会员专属通道 L2·初 起（服务类那一组发布的，每月 2 次）
    const channel = await byCode('QY-001');
    const actor = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk' as const, duties: [], mustChangePassword: false };
    await expect(
      registerBenefitUse({ sql: ctx.sql, config: ctx.config }, m, { clientKey: randomUUID(), benefitId: channel.id, quantity: 1, note: '' }, { actor, at: noonOf(day) }),
    ).rejects.toMatchObject({ code: 'BENEFIT_NOT_ELIGIBLE', message: expect.stringContaining('L1') });
    expect(await ctx.sql`SELECT id FROM benefit_uses WHERE member_id = ${m}`).toHaveLength(0);
  });

  it('自动发放跑的时候券模板停着、发不出；同一天又启用了，再跑一次补上（用到的券模板也算清单版本）', async () => {
    const tpl = await template('停用验证券');
    await publish('QY-039', { templateId: tpl.id, startGrade: 0, startTier: null, period: 'month', quantity: 1 });
    const m = await newMember('模板停用验证');
    const setActive = async (active: boolean) => {
      const [cur] = await ctx.sql<{ version: number }[]>`SELECT version FROM coupon_templates WHERE id = ${tpl.id}`;
      const r = await api(ctx.app, ctx.owner, 'PUT', `/api/coupons/templates/${tpl.id}`, {
        name: tpl.name,
        kind: 'cash',
        faceValue: 5000,
        validity: 'days',
        validDays: 30,
        active,
        expectedVersion: cur!.version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    // 以后某个营业日（这一天还没跑过）
    const day = shiftDate(today, 800);
    const monthGrants = async () => (await grantsOf(m)).filter((g) => g.code === 'QY-039' && g.periodKey === day.slice(0, 7));
    await setActive(false);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day))).toMatchObject({ error: null });
    expect(await monthGrants()).toEqual([]);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day))).toBeNull();
    await setActive(true);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day))).not.toBeNull();
    expect(await monthGrants()).toEqual([expect.objectContaining({ reason: 'monthly', quantity: 1, target: 1 })]);
    expect(await runBenefitsDaily({ sql: ctx.sql, config: ctx.config }, noonOf(day))).toBeNull();
    await allChecksOk();
  });
});
