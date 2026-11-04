// 会员停用 / 启用、换手机号、合并（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 3、4 节；PENDING_DECISIONS M76–M79）：
//   · 停用 / 启用：店主、店总，写原因；有在店手牌不能停用；停用后不能充值、VIP 柜按散客；同一编号重提返回原来那条；确认作废后原请求不生效；
//   · 换手机号：要写原因；店主、店总、值班经理直接改，店员要当场授权（授权绑定会员与新号码），每次一条换号记录；
//   · 合并：来源会员并进目标会员——余额、赠金批次转过去，目标取两位里高的档阶，来源停用并记「合并到」；
//     前提不满足的拒绝（在店手牌、能用的券、今天有储值消费、已停用 / 已合并）；页面核对后余额变了拒绝；
//     合并以后来源会员不能再记账（撤销合并前的消费、接待），储值退回把转入的本金当作「合并转入」一笔；自检照常全过。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberRefundPlan } from '../src/shared/member-refunds';
import type { MemberAccountHistory, MergeCheck } from '../src/shared/member-admin';
import type { MembershipRules } from '../src/shared/membership';
import type { Deps } from '../src/server/lib/context';
import { memberGradeBadges } from '../src/server/modules/membership';
import { memberMergeChecks } from '../src/server/modules/member-admin';
import { consume } from '../src/server/modules/wallet';
import { rechargeOnline } from '../src/server/modules/wallet-online';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, balanceOf, consumeBody, createMember, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;
let today: string;
const yuan = (n: number) => n * 100;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
  const r = (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(100) })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 1, to: 9, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

const recharge = async (memberId: number, paid: number, method = 'cash') => {
  const info = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body;
  void info;
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(memberId, paid, 0, { paymentMethod: method, bonusMode: 'custom' }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.recharge as { id: number; docNo: string };
};
const setStatus = (memberId: number, status: 'active' | 'frozen', cookie = ctx.owner, clientKey = randomUUID(), reason = '会员本人要求') =>
  api(ctx.app, cookie, 'POST', `/api/members/${memberId}/status`, { clientKey, status, reason });
const memberBody = (m: { name: string; phone: string }, extra: Record<string, unknown> = {}) => ({ name: m.name, phone: m.phone, gender: null, birthday: null, note: '', ...extra });
const historyOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/account-history`)).body as MemberAccountHistory;
const checkMerge = async (source: number, target: number) => {
  const r = await api(ctx.app, ctx.owner, 'GET', `/api/members/${source}/merge-check?targetId=${target}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MergeCheck;
};
const merge = (source: number, c: MergeCheck, extra: Record<string, unknown> = {}, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', `/api/members/${source}/merge`, {
    clientKey: randomUUID(),
    targetId: c.target.id,
    reason: '同一个人换了手机号又建了一份',
    expectedPrincipal: c.principal,
    expectedBonus: c.bonus,
    ...extra,
  });

describe('停用 / 启用（M76）', () => {
  it('店员不能停用；店主停用写原因，停用后不能充值、VIP 柜按散客；同一编号重提返回原来那条，内容不同拒绝', async () => {
    const m = (await createMember(ctx, '停用会员', '19933330001')).id;
    await recharge(m, yuan(10000));
    expect((await setStatus(m, 'frozen', ctx.clerk)).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/status`, { clientKey: randomUUID(), status: 'frozen', reason: '' })).status).toBe(400);
    const key = randomUUID();
    const done = await setStatus(m, 'frozen', ctx.owner, key);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ memberId: m, replayed: false, event: { fromStatus: 'active', toStatus: 'frozen', reason: '会员本人要求', staffName: '测试店主' } });
    expect((await setStatus(m, 'frozen', ctx.owner, key)).body).toMatchObject({ replayed: true, event: { id: done.body.event.id } });
    expect((await setStatus(m, 'active', ctx.owner, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 已经停用的再停用：拒绝
    expect((await setStatus(m, 'frozen')).body.error.code).toBe('STATUS_UNCHANGED');
    const frozenRecharge = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m, yuan(100), 0, { paymentMethod: 'cash', bonusMode: 'custom' }));
    expect(frozenRecharge.body.error.code).toBe('MEMBER_FROZEN');
    const badge = (await memberGradeBadges(ctx.sql, [m], today)).get(m)!;
    expect(badge).toMatchObject({ grade: 2, lockerLevel: 0 });
    // 启用以后照常
    expect((await setStatus(m, 'active')).body.event).toMatchObject({ fromStatus: 'frozen', toStatus: 'active' });
    expect((await memberGradeBadges(ctx.sql, [m], today)).get(m)!.lockerLevel).toBeGreaterThan(0);
    expect((await historyOf(m)).statusEvents.map((e) => e.toStatus)).toEqual(['active', 'frozen']);
  });

  it('有在店手牌不能停用；确认作废以后原请求再到也不生效', async () => {
    const m = (await createMember(ctx, '在店会员', '19933330002')).id;
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'A001', zone: 'male', memberId: m }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect((await setStatus(m, 'frozen')).body.error.code).toBe('MEMBER_IN_STORE');
    const key = randomUUID();
    const abandon = await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'member_status', summary: '启用会员' });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(200);
    expect((await setStatus(m, 'frozen', ctx.owner, key)).body.error.code).toBe('OP_ABANDONED');
  });
});

describe('换手机号（M77）', () => {
  it('要写原因；店主直接改，店员要当场授权（授权绑定会员与新号码）；每次一条换号记录', async () => {
    const m = await createMember(ctx, '换号会员', '19933330010');
    const base = { name: '换号会员', phone: '19933330011' };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/members/${m.id}`, memberBody(base))).body.error).toMatchObject({ details: { field: 'phoneReason' } });
    const own = await api(ctx.app, ctx.owner, 'PUT', `/api/members/${m.id}`, memberBody(base, { phoneReason: '会员换了新号' }));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.phone).toBe('19933330011');
    // 店员：没有授权拒绝；授权的号码不一致拒绝；对上了改成功，记下授权人
    const next = { name: '换号会员', phone: '19933330012' };
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.id}`, memberBody(next, { phoneReason: '又换了' }))).body.error.code).toBe('PHONE_AUTH_REQUIRED');
    const wrong = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'owner', password: PASSWORD, purpose: 'member_phone', scope: { memberId: m.id, phone: '19933330099' } });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.id}`, memberBody(next, { phoneReason: '又换了', phoneGrantId: wrong.body.grantId }))).body.error.code).toBe('GRANT_SCOPE');
    const g = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'owner', password: PASSWORD, purpose: 'member_phone', scope: { memberId: m.id, phone: '19933330012' } });
    const byClerk = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.id}`, memberBody(next, { phoneReason: '又换了', phoneGrantId: g.body.grantId }));
    expect(byClerk.status, JSON.stringify(byClerk.body)).toBe(200);
    // 不改手机号只改别的：不用原因、不用授权
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.id}`, memberBody({ ...next, name: '换号会员（改名）' }))).status).toBe(200);
    const h = await historyOf(m.id);
    expect(h.phoneChanges.map((c) => [c.oldPhone, c.newPhone, c.staffName, c.approverName])).toEqual([
      ['19933330011', '19933330012', '测试店员', '测试店主'],
      ['19933330010', '19933330011', '测试店主', null],
    ]);
  });
});

describe('合并（M78、M79）', () => {
  let source: number;
  let target: number;
  let mergeNo: string;

  it('核对：两位的余额、档阶与合并以后的档阶；前提不满足的列出原因', async () => {
    source = (await createMember(ctx, '旧档案', '19933330020')).id;
    target = (await createMember(ctx, '新档案', '19933330021')).id;
    await recharge(source, yuan(12000), 'wechat');
    await recharge(target, yuan(5000));
    // 旧档案今天有储值消费：不能合并（可能还要撤销）
    const t = await createMember(ctx, '今天消费过', '19933330022');
    await recharge(t.id, yuan(2000));
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(t.id, yuan(100)))).status).toBe(200);
    expect((await checkMerge(t.id, target)).problems).toEqual([expect.stringContaining('今天有储值消费')]);
    // 旧档案有一笔昨天的储值消费（合并以后不能再撤销到这份档案上）
    const [owner] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'owner'`;
    await consume(deps, consumeBody(source, yuan(1000)), {
      actor: { id: owner!.id, username: 'owner', displayName: '测试店主', role: 'owner', duties: [], mustChangePassword: false },
      at: new Date(Date.now() - 26 * 3_600_000),
    });
    const c = await checkMerge(source, target);
    expect(c).toMatchObject({
      principal: yuan(11000),
      bonus: 0,
      gradeChanged: true,
      problems: [],
      source: { name: '旧档案', grade: expect.stringContaining('L2') },
      target: { name: '新档案', grade: expect.stringContaining('L1') },
    });
    expect(c.gradeAfter).toContain('L2');
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${source}/merge-check?targetId=${source}`)).body.error.code).toBe('MERGE_SELF');
    // 店员不能合并
    expect((await merge(source, c, {}, ctx.clerk)).status).toBe(403);
    // 页面核对之后余额变了：拒绝
    expect((await merge(source, { ...c, principal: yuan(1) })).body.error.code).toBe('MERGE_CHANGED');
  });

  it('合并：余额与赠金批次转过去，目标取高的档阶，来源停用并记「合并到」；同一编号重提返回原来那张；自检全过', async () => {
    const c = await checkMerge(source, target);
    const key = randomUUID();
    const done = await merge(source, c, { clientKey: key });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    mergeNo = done.body.merge.mergeNo;
    expect(done.body.merge).toMatchObject({
      principal: yuan(11000),
      bonus: 0,
      source: { id: source, name: '旧档案' },
      target: { id: target, name: '新档案' },
      grade: { from: expect.stringContaining('L1'), to: expect.stringContaining('L2') },
    });
    expect((await merge(source, c, { clientKey: key })).body).toMatchObject({ replayed: true, merge: { mergeNo } });
    expect(await balanceOf(ctx, source)).toEqual({ principal: 0, bonus: 0 });
    expect(await balanceOf(ctx, target)).toEqual({ principal: yuan(16000), bonus: 0 });
    const src = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${source}`)).body;
    expect(src).toMatchObject({ status: 'frozen', mergedIntoId: target, mergedInto: { id: target, name: '新档案' } });
    const grade = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${target}/grade`)).body;
    expect(grade.state).toMatchObject({ grade: 2, tier: 0 });
    expect(grade.events[0]).toMatchObject({ kind: 'merge' });
    const h = await historyOf(target);
    expect(h.mergedFrom.map((g) => g.mergeNo)).toEqual([mergeNo]);
    expect((await historyOf(source)).mergedInto).toMatchObject({ mergeNo });
    expect((await historyOf(source)).statusEvents[0]).toMatchObject({ toStatus: 'frozen', mergeNo });
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    expect(checks.filter((x) => !x.ok)).toEqual([]);
    expect(checks.filter((x) => x.label.startsWith('会员合并'))).toHaveLength(2);
  });

  it('合并以后：来源会员不能再撤销合并前的消费、不能接待、不能改资料、不能再合并；线上到账记到目标会员', async () => {
    const [cons] = await ctx.sql<{ id: number }[]>`SELECT id FROM consumptions WHERE member_id = ${source}`;
    const rev = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${cons!.id}/reverse`, { idempotencyKey: randomUUID(), reason: '合并后撤销' });
    expect(rev.body.error.code).toBe('MEMBER_MERGED');
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'A002', zone: 'male', memberId: source }] });
    expect(v.body.error.code).toBe('MEMBER_MERGED');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/members/${source}`, memberBody({ name: '旧档案', phone: '19933330020' }))).body.error.code).toBe('MEMBER_MERGED');
    expect((await checkMerge(source, target)).problems).toEqual([expect.stringContaining('已经合并过了')]);
    expect((await checkMerge(target, source)).problems).toEqual([expect.stringContaining('已合并到别的会员')]);
    expect((await setStatus(source, 'active')).body.error.code).toBe('MEMBER_MERGED');
    const online = await ctx.sql.begin((tx) => rechargeOnline(tx, deps, { memberId: source, paidAmount: yuan(500), planId: null, paymentRef: 'WX-AFTER-MERGE', orderNo: 'MP-M1' }));
    expect(online).toMatchObject({ memberId: target, mergedFrom: source });
  });

  it('储值退回：并进来的本金算作「合并转入」一笔（没有原收款方式，员工选）；最近的先退', async () => {
    const plan = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${target}/refund-plan`)).body as MemberRefundPlan;
    expect(plan.sources.map((s) => [s.source, s.docNo, s.method, s.remaining])).toEqual([
      ['recharge', expect.any(String), 'wechat', yuan(500)],
      ['merge', mergeNo, null, yuan(11000)],
      ['recharge', expect.any(String), 'cash', yuan(5000)],
    ]);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${source}/refund-plan`)).body.blocked).toBeTruthy();
  });

  it('前提：有能用的券、在店手牌、已停用的都不能合并；确认作废以后原请求不生效', async () => {
    const a = (await createMember(ctx, '有券的', '19933330030')).id;
    const b = (await createMember(ctx, '目标', '19933330031')).id;
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '合并前的券', kind: 'cash', faceValue: 1000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${a}/coupons`, { clientKey: randomUUID(), templateId: tpl.body.id, quantity: 1, reason: '回馈' })).status).toBe(201);
    expect((await checkMerge(a, b)).problems).toEqual([expect.stringContaining('1 张能用的券')]);
    const c = (await createMember(ctx, '停用的', '19933330032')).id;
    expect((await setStatus(c, 'frozen')).status).toBe(200);
    expect((await checkMerge(c, b)).problems).toEqual([expect.stringContaining('已停用')]);
    const d = (await createMember(ctx, '可以合并的', '19933330033')).id;
    const check = await checkMerge(d, b);
    expect(check.problems).toEqual([]);
    const key = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'member_merge', summary: '合并会员' })).status).toBe(200);
    expect((await merge(d, check, { clientKey: key })).body.error.code).toBe('OP_ABANDONED');
    // 没有余额的也能合并：没有余额流水
    const ok = await merge(d, check);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.merge).toMatchObject({ principal: 0, bonus: 0, grade: null });
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((x) => !x.ok)).toEqual([]);
  });
});

/** 在单独连接里开一个事务持锁，返回释放函数（回滚） */
async function hold(statement: string) {
  const conn = await ctx.sql.reserve();
  await conn.unsafe('BEGIN');
  await conn.unsafe(statement);
  return async () => {
    await conn.unsafe('ROLLBACK');
    conn.release();
  };
}

/** 等到有 n 个会话在等锁，证明请求确实卡在预期的位置 */
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row!.n >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待 ${n} 个锁等待者超时`);
}

const groupCheckin = (memberId: number, codes: [string, string]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', {
    clientKey: randomUUID(),
    guests: [
      { tagCode: codes[0], zone: 'male', memberId },
      { tagCode: codes[1], zone: 'male', memberId: null },
    ],
  });
const openVisitsOf = async (memberId: number) =>
  (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visits WHERE member_id = ${memberId} AND status = 'open'`)[0]!.n;

describe('接待与合并、停用并发（测试会话 dcbf252 的 P2：接待在会员一行的共享锁里再核对一次）', () => {
  it('接待已经核对过「没合并」、还没写来访时合并提交：接待被拒 MEMBER_MERGED，原档案不会在店', async () => {
    const source = (await createMember(ctx, '并发旧档案', '19933330040')).id;
    const target = (await createMember(ctx, '并发新档案', '19933330041')).id;
    await recharge(source, yuan(1000));
    const check = await checkMerge(source, target);
    expect(check.problems).toEqual([]);
    // 两位客人一起接待要建同行组：持住同行组表，接待卡在建组上（已经过了开头的只读核对）
    const release = await hold('LOCK TABLE visit_groups IN SHARE MODE');
    const pending = groupCheckin(source, ['A003', 'A004']);
    try {
      await waitForLockWaiters(1);
      const merged = await merge(source, check);
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    } finally {
      await release();
    }
    const r = await pending;
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('MEMBER_MERGED');
    expect(await openVisitsOf(source)).toBe(0);
    expect(await balanceOf(ctx, source)).toEqual({ principal: 0, bonus: 0 });
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((x) => !x.ok)).toEqual([]);
  });

  it('接待先拿到会员一行的共享锁：合并等它写完来访，再核对时看到在店手牌，拒绝合并', async () => {
    const source = (await createMember(ctx, '先接待的旧档案', '19933330042')).id;
    const target = (await createMember(ctx, '先接待的新档案', '19933330043')).id;
    const check = await checkMerge(source, target);
    expect(check.problems).toEqual([]);
    // 持住来访表：接待锁住会员一行以后卡在写来访上；合并锁会员一行时排在它后面
    const release = await hold('LOCK TABLE visits IN SHARE MODE');
    const pending = groupCheckin(source, ['A005', 'A006']);
    let merging: ReturnType<typeof merge> | null = null;
    try {
      await waitForLockWaiters(1);
      merging = merge(source, check);
      await waitForLockWaiters(2);
    } finally {
      await release();
    }
    const r = await pending;
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const m = await merging!;
    expect(m.status, JSON.stringify(m.body)).toBe(422);
    expect(m.body.error.code).toBe('MERGE_BLOCKED');
    expect(await openVisitsOf(source)).toBe(1);
    const [row] = await ctx.sql<{ mergedIntoId: number | null }[]>`SELECT merged_into_id FROM members WHERE id = ${source}`;
    expect(row!.mergedIntoId).toBeNull();
    // 自检也看这个交叉不变量：手工造出「被并走的会员仍在店」（只在事务里，回滚）时报错
    await ctx.sql
      .begin(async (tx) => {
        await tx`UPDATE members SET status = 'frozen', merged_into_id = ${target} WHERE id = ${source}`;
        const c = (await memberMergeChecks(tx)).find((x) => x.label.includes('不在店'))!;
        expect(c).toMatchObject({ ok: false, detail: expect.stringContaining('1 位被并走的会员还有在店手牌') });
        throw new Error('rollback');
      })
      .catch((e: Error) => {
        if (e.message !== 'rollback') throw e;
      });
    expect((await memberMergeChecks(ctx.sql)).every((x) => x.ok)).toBe(true);
  });

  it('接待核对之后会员被停用：接待被拒 MEMBER_CHANGED（VIP 柜按停用前算的不作数），重新核对后按散客接待', async () => {
    const m = (await createMember(ctx, '并发停用', '19933330044')).id;
    const release = await hold('LOCK TABLE visit_groups IN SHARE MODE');
    const pending = groupCheckin(m, ['A007', 'A008']);
    try {
      await waitForLockWaiters(1);
      const frozen = await setStatus(m, 'frozen');
      expect(frozen.status, JSON.stringify(frozen.body)).toBe(200);
    } finally {
      await release();
    }
    const r = await pending;
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe('MEMBER_CHANGED');
    expect(await openVisitsOf(m)).toBe(0);
    // 重新提交：停用的会员照样能接待（VIP 柜按散客）
    const again = await groupCheckin(m, ['A007', 'A008']);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});
