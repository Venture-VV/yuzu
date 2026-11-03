// 会员体系 v2 第一期（v0.7.23，docs/MEMBERSHIP.md）：
//   · 会员规则：谁能读、谁能改、门槛与比例的校验；
//   · 充值：首充 / 续充最低、按充值后所在档的比例自动算赠金（与页面预览不一致拒绝）、自定义赠金要权限、滚动累计升档（可以连跳）；
//   · 储值消费：周期净储值消费到 30% / 60% 升享阶 / 尊阶，撤销不降阶；
//   · 每天的自动任务（按营业日推到未来）：保级、进补充期、降一档、L1 降到 L0；补充期内消费达标当场保级；补充期满不够降档；
//   · 手动调整（版本号、原因、同一编号重提）、他店查询（遮姓名、不含余额、记审计）、看板与提醒名单、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_MEMBERSHIP_RULES, rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import { consume } from '../src/server/modules/wallet';
import { membershipChecks, retentionList, runMembershipDaily } from '../src/server/modules/membership';
import { createStaff } from '../src/server/modules/staff';
import type { Actor } from '../src/server/lib/context';
import { api, consumeBody, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: string;
let am: string;
let other: string;
let today: string;
let owner: Actor;

const yuan = (n: number) => Math.round(n * 100);
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
const setRules = async (patch: Partial<MembershipRules>) => {
  const r = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...(await rules()), ...patch });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** 按页面同一算法预览这笔充完的赠金，带上 bonusMode: auto 提交 */
const recharge = async (memberId: number, paid: number, opts: { cookie?: string; bonus?: number; mode?: 'auto' | 'custom' } = {}) => {
  const info = await gradeOf(memberId);
  const auto = rechargeOutcome(await rules(), info.state.grade, info.rollingRechargeCents, paid).bonusCents;
  return api(ctx.app, opts.cookie ?? ctx.clerk, 'POST', '/api/recharges', {
    idempotencyKey: randomUUID(),
    memberId,
    planId: null,
    paidAmount: paid,
    bonusAmount: opts.bonus ?? auto,
    paymentMethod: 'wechat',
    paymentConfirmed: true,
    bonusMode: opts.mode ?? 'auto',
  });
};
const spend = async (memberId: number, amount: number) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(memberId, amount));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.consumption.id as number;
};
/** 某个营业日的中午（上海时间） */
const noonOf = (date: string) => new Date(`${date}T12:00:00+08:00`);
const allChecksOk = async () => {
  for (const c of await membershipChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};

beforeAll(async () => {
  ctx = await setup();
  for (const [username, role] of [['manager', 'store_manager'], ['am', 'account_manager'], ['other', 'other_store']] as const) {
    await createStaff(ctx.sql, { username, displayName: username, role, password: PASSWORD, mustChangePassword: false });
  }
  manager = await login(ctx.app, 'manager');
  am = await login(ctx.app, 'am');
  other = await login(ctx.app, 'other');
  today = businessDateOf(new Date(), 'Asia/Shanghai', 6);
  owner = { id: ctx.ownerId, username: 'owner', displayName: '测试店主', role: 'owner', duties: [], mustChangePassword: false };
});
afterAll(async () => {
  await ctx?.close();
});

describe('会员规则', () => {
  it('登录即可读；改要「修改会员规则」（店主、店总），门槛逐档递增、享阶低于尊阶', async () => {
    const r = await rules();
    expect(r.grades.map((g) => g.name)).toEqual(DEFAULT_MEMBERSHIP_RULES.grades.map((g) => g.name));
    expect(r.vipLockerLevels).toEqual([1, 1, 1, 1, 2, 4, 5]);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/membership/rules', r)).status).toBe(403);
    expect((await api(ctx.app, am, 'PUT', '/api/membership/rules', r)).status).toBe(403);
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, grades: r.grades.map((g, i) => (i === 3 ? { ...g, thresholdCents: yuan(8000) } : g)) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('L3 的门槛要高于 L2');
    const tier = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, enjoyPct: 60 });
    expect(tier.body.error.message).toContain('享阶比例要低于尊阶比例');
    const ok = await api(ctx.app, manager, 'PUT', '/api/membership/rules', { ...r, reminderDays: [7, 90, 30] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.reminderDays).toEqual([90, 30, 7]);
  });

  it('整页保存带上打开时的规则：这期间别人保存过就拒绝（RULES_CHANGED），不悄悄改回别人的修改', async () => {
    const opened = await rules();
    // 店总先保存（改续充最低）
    const first = await api(ctx.app, manager, 'PUT', '/api/membership/rules', { ...opened, topUpMinCents: yuan(2000), based: opened });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // 店主按打开时的规则改补充期：被拒，续充最低还是店总改的
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...opened, graceDays: 60, based: opened });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('RULES_CHANGED');
    expect(await rules()).toMatchObject({ topUpMinCents: yuan(2000), graceDays: opened.graceDays });
    // 换成最新的再改：jsonb 里键的先后不同也认作同一份
    const latest = await rules();
    const reordered = Object.fromEntries(Object.entries(latest).reverse());
    const again = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...latest, graceDays: 60, based: reordered });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ topUpMinCents: yuan(2000), graceDays: 60 });
    await setRules({ topUpMinCents: opened.topUpMinCents, graceDays: opened.graceDays });
  });
});

describe('充值：最低、赠金、升档', () => {
  let a: number;

  it('首充最低：没有充值的会员一笔不到 5,000 拒绝；按充值后所在档的比例赠送，连跳几档，周期从今天起', async () => {
    await setRules({ firstRechargeMinCents: yuan(5000), topUpMinCents: yuan(1000) });
    a = (await createMember(ctx, '甲会员', '19911110001')).id;
    const fresh = await gradeOf(a);
    expect(fresh).toMatchObject({ state: { grade: 0, tier: null }, firstRecharge: true, next: { grade: 1, needCents: yuan(5000) }, lockerLevel: 1 });
    const low = await recharge(a, yuan(1000));
    expect(low.status).toBe(422);
    expect(low.body.error).toMatchObject({ code: 'RECHARGE_BELOW_MIN', details: { minimum: yuan(5000), first: true } });

    const big = await recharge(a, yuan(50000));
    expect(big.status, JSON.stringify(big.body)).toBe(200);
    expect(big.body.recharge.bonusAmount).toBe(yuan(5000));
    expect(big.body.member).toMatchObject({ grade: 4, tier: 0, cycleEnd: shiftDate(today, 364), graceUntil: null });
    const info = await gradeOf(a);
    expect(info).toMatchObject({
      state: { grade: 4, tier: 0, cycleStart: today, cycleEnd: shiftDate(today, 364), graceUntil: null },
      label: 'L4 望岳 · 初',
      targets: { enjoy: yuan(15000), honor: yuan(30000) },
      rollingRechargeCents: yuan(50000),
      firstRecharge: false,
      next: { grade: 5, needCents: yuan(50000), bonusBp: 1500 },
      lockerLevel: 2,
    });
    expect(info.events.map((e) => [e.kind, e.fromGrade, e.toGrade, e.rollingRecharge, e.rechargeDocNo])).toEqual([
      ['recharge_up', 0, 4, yuan(50000), big.body.recharge.docNo],
    ]);
  });

  it('续充最低；赠金与预览不一致拒绝（BONUS_CHANGED）；没有权限不能自定义赠金；有权限的可以', async () => {
    expect((await recharge(a, yuan(500))).body.error.code).toBe('RECHARGE_BELOW_MIN');
    const wrong = await recharge(a, yuan(1000), { bonus: 0 });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatchObject({ code: 'BONUS_CHANGED', details: { bonusCents: yuan(100), gradeAfter: 4 } });
    expect((await recharge(a, yuan(1000), { bonus: 0, mode: 'custom' })).status).toBe(403);
    const custom = await recharge(a, yuan(1000), { bonus: 0, mode: 'custom', cookie: ctx.owner });
    expect(custom.status, JSON.stringify(custom.body)).toBe(200);
    expect(custom.body.recharge.bonusAmount).toBe(0);
    // 不带 bonusMode（升级前的请求）：等于按档的赠金就照常入账
    const legacy = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', {
      idempotencyKey: randomUUID(), memberId: a, planId: null, paidAmount: yuan(1000), bonusAmount: yuan(100), paymentMethod: 'cash', paymentConfirmed: true,
    });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect((await gradeOf(a)).state.grade).toBe(4);
  });

  it('储值消费到本档门槛 30% 升享阶、60% 升尊阶；撤销一笔不降阶', async () => {
    await spend(a, yuan(15000));
    expect((await gradeOf(a)).state.tier).toBe(1);
    await spend(a, yuan(15000));
    const small = await spend(a, yuan(100));
    const info = await gradeOf(a);
    expect(info).toMatchObject({ state: { tier: 2 }, cycleSpendCents: yuan(30100), label: 'L4 望岳 · 尊' });
    expect(info.events.slice(0, 2).map((e) => [e.kind, e.fromTier, e.toTier, e.cycleSpend])).toEqual([
      ['spend_up', 1, 2, yuan(30000)],
      ['spend_up', 0, 1, yuan(15000)],
    ]);
    const rev = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${small}/reverse`, { idempotencyKey: randomUUID(), reason: '测试撤销' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(await gradeOf(a)).toMatchObject({ state: { tier: 2 }, cycleSpendCents: yuan(30000) });
    await allChecksOk();
  });
});

describe('每天的自动任务（按营业日推到周期结束之后）', () => {
  const ids: Record<string, number> = {};
  const end = () => shiftDate(today, 364);

  it('保级保持尊阶、30%–60% 进补充期、不够降一档进尊阶、L1 降到 L0；同一天再跑什么都不做', async () => {
    await setRules({ firstRechargeMinCents: 0, topUpMinCents: 0 });
    ids.a = (await api(ctx.app, ctx.owner, 'GET', '/api/members?q=19911110001')).body[0].id;
    for (const [key, phone, paid] of [['b', '19911110002', 10000], ['c', '19911110003', 10000], ['d', '19911110004', 5000], ['e', '19911110005', 10000]] as const) {
      ids[key] = (await createMember(ctx, `会员${key}`, phone)).id;
      expect((await recharge(ids[key]!, yuan(paid))).status).toBe(200);
    }
    await spend(ids.b!, yuan(3000));
    await spend(ids.e!, yuan(3000));
    expect((await gradeOf(ids.b!)).state).toMatchObject({ grade: 2, tier: 1 });

    // 周期最后一天还不处理
    expect(await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(end()))).toMatchObject({ processed: 0 });
    const run = await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(shiftDate(end(), 1)));
    expect(run).toMatchObject({ businessDate: shiftDate(end(), 1), processed: 5, retained: 1, grace: 2, downgraded: 2, error: null });
    expect(await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(shiftDate(end(), 1)))).toBeNull();

    const next = { cycleStart: shiftDate(end(), 1), cycleEnd: shiftDate(end(), 365) };
    expect((await gradeOf(ids.a!)).state).toEqual({ grade: 4, tier: 2, ...next, graceUntil: null });
    expect((await gradeOf(ids.b!)).state).toEqual({ grade: 2, tier: 1, cycleStart: today, cycleEnd: end(), graceUntil: shiftDate(end(), 90) });
    expect((await gradeOf(ids.c!)).state).toEqual({ grade: 1, tier: 2, ...next, graceUntil: null });
    expect((await gradeOf(ids.d!)).state).toEqual({ grade: 0, tier: null, cycleStart: null, cycleEnd: null, graceUntil: null });
    const events = (await gradeOf(ids.c!)).events;
    expect(events[0]).toMatchObject({ kind: 'downgrade', fromGrade: 2, toGrade: 1, toTier: 2, cycleSpend: 0, staffName: null, businessDate: shiftDate(end(), 1) });
    await allChecksOk();
  });

  it('补充期内储值消费到 60% 当场保级，新周期从原到期日的下一天起算；补充期满还不够降一档', async () => {
    // 补充期第 10 天的一笔消费（直接调用记账，指定业务时间）
    await consume({ sql: ctx.sql, config: ctx.config }, consumeBody(ids.b!, yuan(3000)), { actor: owner, at: noonOf(shiftDate(end(), 10)) });
    const b = await gradeOf(ids.b!);
    expect(b.state).toEqual({ grade: 2, tier: 2, cycleStart: shiftDate(end(), 1), cycleEnd: shiftDate(end(), 365), graceUntil: null });
    expect(b.events[0]).toMatchObject({ kind: 'grace_retain', cycleSpend: yuan(6000), consumptionDocNo: expect.any(String) });

    const graceEnd = shiftDate(end(), 90);
    expect(await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(graceEnd))).toMatchObject({ processed: 0 });
    const run = await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, noonOf(shiftDate(graceEnd, 1)));
    expect(run).toMatchObject({ processed: 1, downgraded: 1 });
    expect((await gradeOf(ids.e!)).state).toEqual({ grade: 1, tier: 2, cycleStart: shiftDate(graceEnd, 1), cycleEnd: shiftDate(graceEnd, 365), graceUntil: null });
    await allChecksOk();
  });

  it('提醒名单与补充期名单；看板要「看会员体系看板」（客户经理有、店员没有）', async () => {
    const at = shiftDate(end(), 300);
    const list = await retentionList(ctx.sql, at, { kind: 'expiring', within: 90 });
    const a = list.find((r) => r.memberId === ids.a);
    expect(a).toMatchObject({ grade: 4, tier: 2, daysLeft: 65, reminder: 90, honorCents: yuan(30000), needCents: yuan(30000) });
    expect(list.every((r) => r.daysLeft <= 90)).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/membership/overview')).status).toBe(403);
    const ov = await api(ctx.app, am, 'GET', '/api/membership/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.states).toHaveLength(19);
    expect(ov.body.states.reduce((n: number, s: { count: number }) => n + s.count, 0)).toBe(5);
    expect(ov.body.jobs[0]).toMatchObject({ processed: 1, downgraded: 1 });
    expect((await api(ctx.app, am, 'GET', '/api/membership/retention?kind=grace')).status).toBe(200);
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/membership/retention.csv?within=90', headers: { cookie: am } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('保级要消费');
    // 上面按营业日推到了未来；清掉这几条运行记录，后面在今天建的会籍（周期到明年）才不会被当成「最近一次任务之前到期」
    await ctx.sql`DELETE FROM membership_job_runs WHERE business_date > ${today}`;
  });
});

describe('手动调整与他店查询', () => {
  it('手动调整：只有店主；版本号对不上拒绝；写原因；同一编号重提不重复记', async () => {
    const m = (await createMember(ctx, '调整会员', '19911110009')).id;
    const info = await gradeOf(m);
    const body = { clientKey: randomUUID(), grade: 3, tier: 1, reason: '老卡核对后补定档', expectedVersion: info.version };
    expect((await api(ctx.app, manager, 'POST', `/api/members/${m}/grade`, body)).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, { ...body, expectedVersion: info.version + 1 })).body.error.code).toBe('GRADE_CHANGED');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, { ...body, tier: null })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, { ...body, reason: '补' })).status).toBe(400);
    const ok = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ state: { grade: 3, tier: 1, cycleStart: today, cycleEnd: shiftDate(today, 364) }, label: 'L3 观澜 · 享' });
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, body);
    expect(again.status).toBe(200);
    const manual = (await gradeOf(m)).events.filter((e) => e.kind === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ staffName: '测试店主', reason: '老卡核对后补定档', fromGrade: 0, toGrade: 3 });
    await allChecksOk();
  });

  it('他店查询：只有「他店查询」与店主；遮姓名与手机号、不含余额；每次查询记审计', async () => {
    expect((await api(ctx.app, other, 'GET', '/api/members?q=19911110001')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/membership/lookup?q=19911110001')).status).toBe(403);
    const r = await api(ctx.app, other, 'GET', '/api/membership/lookup?q=199-1111-0001');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      found: true,
      member: expect.objectContaining({ maskedName: '甲*员', maskedPhone: '199****0001', grade: 4, tier: 2, label: 'L4 望岳 · 尊', inGrace: false, status: 'active' }),
    });
    expect(JSON.stringify(r.body)).not.toMatch(/balance|Balance|principal/);
    const no = (await api(ctx.app, other, 'GET', `/api/members/${(await api(ctx.app, ctx.owner, 'GET', '/api/members?q=19911110001')).body[0].id}`));
    expect(no.status).toBe(403);
    const memberNo = r.body.member.memberNo as string;
    expect((await api(ctx.app, other, 'GET', `/api/membership/lookup?q=${memberNo.toLowerCase()}`)).body.found).toBe(true);
    expect((await api(ctx.app, other, 'GET', '/api/membership/lookup?q=19900000000')).body).toEqual({ found: false, member: null });
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/membership/lookup?q=19911110001')).status).toBe(200);
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'member_lookup'`;
    expect(audit!.n).toBe(4);
  });

  it('自检：会员一行被改得与状态变化记录不一致时报出', async () => {
    const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM members WHERE grade = 4 ORDER BY id LIMIT 1`;
    await ctx.sql`UPDATE members SET tier = 0 WHERE id = ${m!.id}`;
    const bad = (await membershipChecks(ctx.sql)).find((c) => c.label.includes('档阶与状态变化记录一致'))!;
    expect(bad).toMatchObject({ ok: false, detail: '1 位会员的档阶与最后一条状态变化不符' });
    await ctx.sql`UPDATE members SET tier = 2 WHERE id = ${m!.id}`;
    await allChecksOk();
  });
});

describe('Codex 自动审查 43d53e9', () => {
  it('手动调整的结果待确认：按编号查回；确认作废后原请求晚到也不调整；已调整的不能作废；查回、作废只有店主', async () => {
    const m = (await createMember(ctx, '调整待确认', '19911110010')).id;
    const body = async (key: string) => ({ clientKey: key, grade: 2, tier: 0, reason: '回复丢了再核对', expectedVersion: (await gradeOf(m)).version });
    // 已经调整的：查回得到这位会员；不能作废
    const applied = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, await body(applied))).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${applied}?type=grade_adjust`)).body).toMatchObject({ found: true, refId: m });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${applied}/abandon`, { type: 'grade_adjust' })).body).toMatchObject({ found: true, abandoned: false });
    // 没有到达的：查不到；店总、店员不能查回、作废
    const lost = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${lost}?type=grade_adjust`)).body).toMatchObject({ found: false, abandoned: false });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${lost}?type=grade_adjust`)).status).toBe(403);
    expect((await api(ctx.app, manager, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'grade_adjust' })).status).toBe(403);
    // 店主确认作废：原请求（同一编号、版本号也对）晚到整笔拒绝，不记状态变化
    const fenced = await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'grade_adjust', summary: '调整待确认：调到 L2' });
    expect(fenced.body).toMatchObject({ found: false, abandoned: true });
    const late = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, await body(lost));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect((await gradeOf(m)).events.filter((e) => e.kind === 'manual')).toHaveLength(1);
    await allChecksOk();
  });

  it('下一档按现在的档阶算：滚动累计已经够更高档时（如手动调低），下一笔充值即升到够得上的那一档、还差 0，不显示「已是最高档」', async () => {
    const m = (await createMember(ctx, '下一档会员', '19911110011')).id;
    expect((await recharge(m, yuan(300000))).status).toBe(200);
    expect((await gradeOf(m)).state).toMatchObject({ grade: 6 });
    const adjust = async (grade: number) => {
      const r = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, {
        clientKey: randomUUID(),
        grade,
        tier: 0,
        reason: '核对后调低',
        expectedVersion: (await gradeOf(m)).version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as MemberGradeInfo;
    };
    // 原来：按「充 0 元」推演先升到 L6，再取 L6 的下一档 → null，等级卡显示「已是最高档」
    expect((await adjust(5)).next).toMatchObject({ grade: 6, needCents: 0, thresholdCents: yuan(300000) });
    // 调到 L2：滚动累计已够 L6，下一笔充值直接升到 L6（不是 L3）
    expect((await adjust(2)).next).toMatchObject({ grade: 6, needCents: 0 });
    await allChecksOk();
  });

  it('今天的运行记录没跑完（进程中途停了）或出过错、又已经没有到期的会员：下一次照样补完记录，自检恢复', async () => {
    const now = new Date();
    const date = businessDateOf(now, 'Asia/Shanghai', 6);
    await ctx.sql`DELETE FROM membership_job_runs WHERE job = 'daily' AND business_date >= ${date}`;
    await ctx.sql`INSERT INTO membership_job_runs (job, business_date) VALUES ('daily', ${date})`;
    const jobCheck = async () => (await membershipChecks(ctx.sql)).find((c) => c.label.includes('会员到期处理'))!;
    expect((await jobCheck()).ok).toBe(false);
    const run = await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, now);
    expect(run).toMatchObject({ businessDate: date, processed: 0, error: null });
    expect(run!.finishedAt).not.toBeNull();
    expect((await jobCheck()).ok).toBe(true);
    // 出过错的那位后来在充值、消费时被处理了：下一次清掉出错，不一直报
    await ctx.sql`UPDATE membership_job_runs SET error = '会员 #1：模拟出错' WHERE job = 'daily' AND business_date = ${date}`;
    expect((await jobCheck()).ok).toBe(false);
    expect(await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, now)).toMatchObject({ error: null });
    expect((await jobCheck()).ok).toBe(true);
    // 已经跑完、没出错、没有到期的：什么都不做
    expect(await runMembershipDaily({ sql: ctx.sql, config: ctx.config }, now)).toBeNull();
    await allChecksOk();
  });
});
