// v0.7.30 审批中心（docs/APPROVALS.md，A1–A10 待确认）：
//   · 没建规则时与 v0.7.29 一样（默认规则：一级负责人，免确认门槛以内提交即生效）；
//   · 规则命中按审批链逐级同意，级别对不上拒绝（APPROVAL_MOVED），同一人重复同意不重复记；任何一级可退回，改了再提交从第一级重新走；
//   · 提交人不能审自己的单（新建的规则默认）；会签要指定的人都同意；代理期间代理人替被代理人审（记「代 某某」），收回后不能；
//   · 批量同意：同一种单据、每张不超过 ¥5,000；规则带版本号、操作编号重提返回原来那条；
//   · 盘点大差异要写原因、走审批；急采生效后超过 3 天没补单的进负责人待办；部门账号看不到别的部门的图片与需求单自检；
//   · 自检：待确认的单据各有一张在审的审批单。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalChecks } from '../src/server/modules/approvals/engine';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 店主
let keeper: string; // 物资经办
let buyer: string; // 采购经办
let payer: string; // 对账付款（财务）
let mgrA: string; // 负责人 A
let mgrB: string; // 负责人 B
let shopBoss: string; // 店总（有审批中心的权限，不是负责人）
let coster: string; // 成本核算（财务）
let reqA: string; // 客房部申购
let reqB: string; // 水吧申购
const ids: Record<string, number> = {};
let s1: { id: number };
let mat: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);

const supplier = async (code: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body.find((s: { code: string }) => s.code === code);
const material = async (code: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1')).body.find((m: { code: string }) => m.code === code);
/** 采购单：qty 箱 × 单价（元） */
const po = async (qty: number, yuan: number, cookie = buyer) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    supplierId: s1.id,
    orderDate: today,
    action: 'submit',
    lines: [{ materialId: mat.id, purchaseQtyMilli: q(qty), priceCents: yuan * 100 }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.po as { id: number; status: string; docNo: string; approval: Brief | null };
};
interface Brief {
  requestId: number;
  status: string;
  ruleId: number | null;
  currentLevel: number;
  levels: number;
  stepLabels: string[];
  approvedIds: number[];
  actions: { action: string; actorName: string; onBehalfOfName: string | null; comment: string; batch: boolean; level: number }[];
}
const getPo = async (id: number) => (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${id}`)).body as { status: string; approval: Brief };
const payment = async (yuan: number, cookie = payer) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/payables/payments', {
    clientKey: randomUUID(),
    supplierId: s1.id,
    payDate: today,
    amountCents: yuan * 100,
    method: 'bank_transfer',
    evidence: '转账流水 0001',
    note: '预付货款（测试）',
    prepay: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.payment as { id: number; status: string; docNo: string; approval: Brief | null };
};
const damage = async (qty = 1) => {
  const r = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
    clientKey: randomUUID(),
    docType: 'damage',
    docDate: today,
    note: '搬运摔坏',
    action: 'submit',
    lines: [{ materialId: mat.id, qtyMilli: q(qty) }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.doc as { id: number; status: string; approval: Brief | null };
};
const rule = async (body: Record<string, unknown>, cookie = boss) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rules.find((x: { id: number }) => x.id === r.body.id) as { id: number; version: number };
};
const deactivate = async (r: { id: number; version: number }) => {
  const res = await api(ctx.app, boss, 'POST', `/api/approvals/rules/${r.id}/active`, { version: r.version, active: false });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
const mine = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/approvals?tab=mine')).body as { id: number; docNo: string; canAct: boolean; actingFor: string[]; currentLevel: number }[];
const approve = (cookie: string, requestId: number, level: number, comment = '') => api(ctx.app, cookie, 'POST', `/api/approvals/${requestId}/approve`, { level, comment });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  // 演示数据把免确认门槛设成 0（都要确认）；这里按默认的 ¥2,000
  await ctx.sql`UPDATE settings SET value = '200000' WHERE key = 'inventory_approval_threshold_cents'`;
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  const staff = async (username: string, displayName: string, role: 'backoffice' | 'store_manager', duties: ('approve' | 'cost' | 'request')[], departmentId: number | null = null) => {
    ids[username] = await createStaff(ctx.sql, { username, displayName, role, duties, departmentId, password: PASSWORD, mustChangePassword: false });
    return login(ctx.app, username);
  };
  mgrA = await staff('mgr_a', '负责人甲', 'backoffice', ['approve']);
  mgrB = await staff('mgr_b', '负责人乙', 'backoffice', ['approve']);
  shopBoss = await staff('shop_boss', '店总丙', 'store_manager', []);
  coster = await staff('fin_cost', '成本丁', 'backoffice', ['cost']);
  const dept = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  ids.rooms = await dept('客房部');
  ids.bar = await dept('水吧');
  reqA = await staff('req_rooms', '客房申购', 'backoffice', ['request'], ids.rooms);
  reqB = await staff('req_bar', '水吧申购', 'backoffice', ['request'], ids.bar);
  s1 = await supplier('S001');
  mat = await material('M001');
  expect(s1 && mat).toBeTruthy();
}, 120_000);
afterAll(async () => ctx.close());

describe('迁移 073：已经在「待确认」的单据各补一张审批单', () => {
  it('补的审批单是默认规则（一级负责人，提交人可以一并确认），单据状态不动；补完自检一致（整段在事务里跑完回滚）', async () => {
    const sqlText = await readFile(new URL('../src/server/migrations/073_approval_center.sql', import.meta.url), 'utf8');
    const backfill = sqlText.slice(sqlText.indexOf('-- ───────────── 迁移时已在「待确认」的单据'));
    const rollback = new Error('rollback');
    await expect(
      ctx.sql.begin(async (tx) => {
        const before = await tx<{ kind: string; n: number }[]>`
          SELECT 'purchase_order' AS kind, count(*)::int AS n FROM purchase_orders WHERE status = 'submitted'
          UNION ALL SELECT 'inv_doc', count(*)::int FROM inv_docs WHERE status = 'submitted' AND NOT urgent AND doc_type IN ('damage', 'supplier_return', 'opening', 'count')
          UNION ALL SELECT 'payment', count(*)::int FROM payments WHERE status = 'submitted'
          UNION ALL SELECT 'opening_payable', count(*)::int FROM opening_payables WHERE status = 'submitted'`;
        expect(before.reduce((t, r) => t + r.n, 0)).toBeGreaterThan(0);
        // 演示数据是按审批中心生成的：先去掉在审的审批单，模拟升级前的库
        await tx`DELETE FROM approval_requests WHERE status = 'pending'`;
        await tx.unsafe(backfill);
        const after = await tx<{ kind: string; n: number; defaults: number }[]>`
          SELECT doc_kind AS kind, count(*)::int AS n,
                 count(*) FILTER (WHERE steps = '[{"group":"manager","mode":"any"}]'::jsonb AND allow_self AND rule_id IS NULL AND current_level = 1)::int AS defaults
          FROM approval_requests WHERE status = 'pending' GROUP BY doc_kind`;
        for (const b of before.filter((x) => x.n > 0)) expect(after.find((a) => a.kind === b.kind)).toEqual({ kind: b.kind, n: b.n, defaults: b.n });
        const check = await approvalChecks(tx);
        expect(check, check.detail).toMatchObject({ ok: true });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

describe('默认规则：没建规则时与 v0.7.29 一样', () => {
  it('超过免确认门槛的采购单进待确认、生成一级「负责人」审批单；负责人在原来的按钮上确认一次就生效；门槛以内提交即确认、没有审批单', async () => {
    const big = await po(10, 300); // ¥3,000 > ¥2,000
    expect(big.status).toBe('submitted');
    expect(big.approval).toMatchObject({ status: 'pending', ruleId: null, levels: 1, currentLevel: 1, stepLabels: ['负责人'] });
    // 待我审批：负责人看得到、能审；物资经办没有审批中心的权限
    expect((await mine(mgrA)).find((c) => c.docNo === big.docNo)).toMatchObject({ canAct: true, currentLevel: 1 });
    expect((await api(ctx.app, keeper, 'GET', '/api/approvals?tab=mine')).status).toBe(403);
    // 采购经办看不到「全部在审」，店主看得到
    expect((await api(ctx.app, payer, 'GET', '/api/approvals?tab=all')).status).toBe(403);
    expect(((await api(ctx.app, boss, 'GET', '/api/approvals?tab=all')).body as { docNo: string }[]).some((c) => c.docNo === big.docNo)).toBe(true);
    const ok = await api(ctx.app, mgrA, 'POST', `/api/purchase-orders/${big.id}/approve`, {});
    expect(ok.body.status).toBe('approved');
    expect(ok.body.approval).toMatchObject({ status: 'approved' });
    expect(ok.body.approval.actions).toMatchObject([{ action: 'approve', actorName: '负责人甲', level: 1 }]);
    // 重复确认（结果待确认后原样重提）：照旧幂等
    expect((await api(ctx.app, mgrA, 'POST', `/api/purchase-orders/${big.id}/approve`, {})).body.status).toBe('approved');

    const small = await po(5, 300); // ¥1,500
    expect(small.status).toBe('approved');
    expect(small.approval).toBeNull();
  });
});

describe('审批规则与审批链', () => {
  it('两级（负责人 → 店主）：逐级同意，级别对不上拒绝、重复同意不重复记、不是这一级的人不能审；最后一级同意后才生效', async () => {
    const r = await rule({ docType: 'purchase_order', minCents: 100_000, steps: [{ group: 'manager' }, { group: 'owner' }], note: '一千以上两级' });
    try {
      const p = await po(5, 300); // ¥1,500：门槛以内，但命中规则
      expect(p.status).toBe('submitted');
      expect(p.approval).toMatchObject({ ruleId: r.id, levels: 2, currentLevel: 1, stepLabels: ['负责人', '店主'] });
      const rid = p.approval!.requestId;
      const first = await approve(mgrA, rid, 1, '数量合理');
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ status: 'pending', currentLevel: 2, canAct: false, currentStepLabel: '店主' });
      expect((await getPo(p.id)).status).toBe('submitted');
      // 同一人对同一级重复同意：按已同意处理，不重复记
      expect((await approve(mgrA, rid, 1)).status).toBe(200);
      expect((await getPo(p.id)).approval.actions).toHaveLength(1);
      // 别人看到的还是第 1 级：拒绝
      const moved = await approve(mgrB, rid, 1);
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe('APPROVAL_MOVED');
      // 第 2 级是店主：负责人不能审
      const notMine = await approve(mgrA, rid, 2);
      expect(notMine.status).toBe(403);
      expect(notMine.body.error.code).toBe('APPROVAL_NOT_ELIGIBLE');
      // 原来的确认按钮：同意的是当前这一级（负责人不在第 2 级，拒绝）
      expect((await api(ctx.app, mgrB, 'POST', `/api/purchase-orders/${p.id}/approve`, {})).body.error.code).toBe('APPROVAL_NOT_ELIGIBLE');
      const last = await approve(boss, rid, 2, '可以');
      expect(last.body).toMatchObject({ status: 'approved' });
      expect(last.body.levelsDetail.map((l: { state: string }) => l.state)).toEqual(['done', 'done']);
      const done = await getPo(p.id);
      expect(done.status).toBe('approved');
      expect(done.approval.actions.map((a) => [a.level, a.actorName, a.comment])).toEqual([
        [1, '负责人甲', '数量合理'],
        [2, '林岚', '可以'],
      ]);
    } finally {
      await deactivate(r);
    }
  });

  it('任何一级可退回（原因至少 2 个字），单据回到「已退回」；改了再提交按当时的规则从第一级重新走；撤回时审批单一起关掉', async () => {
    const r = await rule({ docType: 'purchase_order', minCents: 100_000, steps: [{ group: 'manager' }, { group: 'store_manager' }] });
    try {
      const p = await po(4, 300); // ¥1,200
      const rid = p.approval!.requestId;
      await approve(mgrA, rid, 1);
      expect((await api(ctx.app, shopBoss, 'POST', `/api/approvals/${rid}/return`, { level: 2, reason: '退' })).status).toBe(400);
      const back = await api(ctx.app, shopBoss, 'POST', `/api/approvals/${rid}/return`, { level: 2, reason: '单价偏高，再比一家' });
      expect(back.body).toMatchObject({ status: 'returned' });
      const returned = await getPo(p.id);
      expect(returned.status).toBe('returned');
      expect(returned.approval.actions.at(-1)).toMatchObject({ action: 'return', actorName: '店总丙', comment: '单价偏高，再比一家', level: 2 });
      // 改了再提交：新的审批单，从第一级重新走
      const re = await api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${p.id}`, {
        supplierId: s1.id,
        orderDate: today,
        action: 'submit',
        lines: [{ materialId: mat.id, purchaseQtyMilli: q(4), priceCents: 28_000 }],
      });
      expect(re.body.status).toBe('submitted');
      expect(re.body.approval.requestId).not.toBe(rid);
      expect(re.body.approval).toMatchObject({ currentLevel: 1, status: 'pending' });
      // 旧的审批单（已退回）上再同意：拒绝
      expect((await approve(mgrA, rid, 1)).body.error.code).toBe('APPROVAL_MOVED');
      // 撤回：审批单一起关掉
      await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${p.id}/cancel`, { reason: '不买了' });
      expect((await getPo(p.id)).approval.status).toBe('cancelled');
      expect((await mine(mgrA)).some((c) => c.docNo === p.docNo)).toBe(false);
    } finally {
      await deactivate(r);
    }
  });

  it('新建的规则默认提交人不能审自己的单（哪一级都不行、也不能借代理）；默认规则照旧可以「提交并确认」', async () => {
    const r = await rule({ docType: 'payment', minCents: 0, steps: [{ group: 'finance' }] });
    try {
      const p = await payment(1_000);
      expect(p.status).toBe('submitted');
      const rid = p.approval!.requestId;
      // 对账付款自己登记的：不能审
      const self = await approve(payer, rid, 1);
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('APPROVAL_SELF_FORBIDDEN');
      // 待我审批里也没有
      expect((await mine(payer)).some((c) => c.id === rid)).toBe(false);
      // 成本核算（财务）可以
      expect((await approve(coster, rid, 1)).body.status).toBe('approved');
      expect((await api(ctx.app, payer, 'GET', `/api/payables/payments/${p.id}`)).body.status).toBe('confirmed');
    } finally {
      await deactivate(r);
    }
    // 默认规则：提交并确认（负责人一并同意第一级），与以前一样
    const p2 = await api(ctx.app, boss, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId: s1.id,
      orderDate: today,
      action: 'submit',
      approveNow: true,
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(10), priceCents: 30_000 }],
    });
    expect(p2.body.po).toMatchObject({ status: 'approved', approval: { status: 'approved', ruleId: null } });
  });

  it('会签：指定的人都同意这一级才通过；代理期间代理人替被代理人审（记「代 某某」），收回后不能', async () => {
    const r = await rule({ docType: 'damage', minCents: 0, steps: [{ staffIds: [ids.mgr_a!, ids.mgr_b!], mode: 'all' }] });
    try {
      const d1 = await damage();
      expect(d1.status).toBe('submitted');
      const rid1 = d1.approval!.requestId;
      expect((await approve(mgrA, rid1, 1)).body).toMatchObject({ status: 'pending', currentLevel: 1 });
      const detail = (await api(ctx.app, boss, 'GET', `/api/approvals/${rid1}`)).body;
      expect(detail.levelsDetail[0]).toMatchObject({ state: 'current', waitingFor: ['负责人乙'] });
      // 店总不在指定的人里
      expect((await approve(shopBoss, rid1, 1)).body.error.code).toBe('APPROVAL_NOT_ELIGIBLE');
      expect((await approve(mgrB, rid1, 1)).body).toMatchObject({ status: 'approved' });
      expect((await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${d1.id}`)).body.status).toBe('confirmed');

      // 负责人乙请假：设店总为代理人（本人给自己设）
      const bad = await api(ctx.app, mgrB, 'POST', '/api/approvals/delegations', { clientKey: randomUUID(), staffId: ids.mgr_b, delegateId: ids.mgr_b, startsOn: today, endsOn: today });
      expect(bad.status).toBe(400);
      expect((await api(ctx.app, mgrA, 'POST', '/api/approvals/delegations', { clientKey: randomUUID(), staffId: ids.mgr_b, delegateId: ids.shop_boss, startsOn: today, endsOn: today })).status).toBe(403);
      const tooLong = await api(ctx.app, mgrB, 'POST', '/api/approvals/delegations', { clientKey: randomUUID(), staffId: ids.mgr_b, delegateId: ids.shop_boss, startsOn: today, endsOn: shiftDate(today, 31) });
      expect(tooLong.status).toBe(400);
      const key = randomUUID();
      const set = await api(ctx.app, mgrB, 'POST', '/api/approvals/delegations', { clientKey: key, staffId: ids.mgr_b, delegateId: ids.shop_boss, startsOn: today, endsOn: shiftDate(today, 2), reason: '请假' });
      expect(set.status).toBe(201);
      expect((await api(ctx.app, mgrB, 'POST', '/api/approvals/delegations', { clientKey: key, staffId: ids.mgr_b, delegateId: ids.shop_boss, startsOn: today, endsOn: shiftDate(today, 2), reason: '请假' })).body).toMatchObject({ id: set.body.id, replayed: true });

      const d2 = await damage();
      const rid2 = d2.approval!.requestId;
      await approve(mgrA, rid2, 1);
      expect((await mine(shopBoss)).find((c) => c.id === rid2)).toMatchObject({ canAct: true, actingFor: ['负责人乙'] });
      const byDelegate = await approve(shopBoss, rid2, 1, '代审');
      expect(byDelegate.body).toMatchObject({ status: 'approved' });
      expect(byDelegate.body.levelsDetail[0].actions.at(-1)).toMatchObject({ actorName: '店总丙', onBehalfOfName: '负责人乙', comment: '代审' });

      // 收回后不能再代审
      expect((await api(ctx.app, mgrB, 'POST', `/api/approvals/delegations/${set.body.id}/revoke`, {})).status).toBe(200);
      const d3 = await damage();
      await approve(mgrA, d3.approval!.requestId, 1);
      expect((await mine(shopBoss)).some((c) => c.id === d3.approval!.requestId)).toBe(false);
      expect((await approve(shopBoss, d3.approval!.requestId, 1)).body.error.code).toBe('APPROVAL_NOT_ELIGIBLE');
      // 店主在每一级都能审：会签时店主同意即这一级通过（指定的人停用时不会卡住）
      expect((await approve(boss, d3.approval!.requestId, 1)).body).toMatchObject({ status: 'approved' });
    } finally {
      await deactivate(r);
    }
  });
});

describe('批量同意（A5）与规则维护', () => {
  it('同一种单据、每张不超过 ¥5,000 的可以一起同意，每张单独成功或失败；不同种单据拒绝', async () => {
    const a = await payment(2_500);
    const b = await payment(3_000);
    const c = await payment(6_000);
    for (const p of [a, b, c]) expect(p.status).toBe('submitted');
    const res = await api(ctx.app, mgrA, 'POST', '/api/approvals/batch-approve', {
      items: [a, b, c].map((p) => ({ id: p.approval!.requestId, level: 1 })),
      comment: '月底统一付款',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results.map((x: { ok: boolean; code?: string }) => [x.ok, x.code ?? null])).toEqual([
      [true, null],
      [true, null],
      [false, 'BATCH_OVER_LIMIT'],
    ]);
    expect((await api(ctx.app, payer, 'GET', `/api/payables/payments/${a.id}`)).body.approval.actions[0]).toMatchObject({ batch: true, comment: '月底统一付款' });
    expect((await api(ctx.app, payer, 'GET', `/api/payables/payments/${c.id}`)).body.status).toBe('submitted');
    const mixed = await api(ctx.app, mgrA, 'POST', '/api/approvals/batch-approve', {
      items: [{ id: c.approval!.requestId, level: 1 }, { id: (await po(10, 300)).approval!.requestId, level: 1 }],
    });
    expect(mixed.status).toBe(400);
  });

  it('规则：只有店主能建；操作编号重提返回原来那条；修改带版本号；指定的人要有审批中心的权限；停用后不再命中', async () => {
    const body = { docType: 'purchase_order', minCents: 0, maxCents: 50_000, steps: [{ group: 'owner' }], note: '五百以内店主审' };
    expect((await api(ctx.app, mgrA, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), ...body })).status).toBe(403);
    const key = randomUUID();
    const created = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: key, ...body });
    expect(created.status).toBe(201);
    const replay = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: key, ...body });
    expect(replay.body).toMatchObject({ id: created.body.id, replayed: true });
    const conflictKey = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: key, ...body, note: '改了' });
    expect(conflictKey.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 金额上限要大于下限；指定的人要能用审批中心（物资经办不行）
    expect((await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), ...body, minCents: 50_000 })).status).toBe(400);
    const keeperId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'lixiao'`)[0]!.id;
    const noAccess = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), ...body, steps: [{ staffIds: [keeperId] }] });
    expect(noAccess.body.error.code).toBe('APPROVER_INVALID');
    // 命中：¥300 的采购单（门槛以内）也要店主审
    const p = await po(1, 300);
    expect(p).toMatchObject({ status: 'submitted', approval: { ruleId: created.body.id, stepLabels: ['店主'] } });
    // 修改：版本对不上拒绝
    const stale = await api(ctx.app, boss, 'PUT', `/api/approvals/rules/${created.body.id}`, { ...body, version: 9 });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const updated = await api(ctx.app, boss, 'PUT', `/api/approvals/rules/${created.body.id}`, { ...body, steps: [{ group: 'store_manager' }], version: 1 });
    expect(updated.body.find((x: { id: number }) => x.id === created.body.id)).toMatchObject({ version: 2, stepLabels: ['店总'] });
    // 改规则只影响之后提交的单据：已在审批中的照提交时的审批链走完
    expect((await getPo(p.id)).approval.stepLabels).toEqual(['店主']);
    await deactivate({ id: created.body.id, version: 2 });
    expect((await po(1, 300)).status).toBe('approved');
    expect((await approve(boss, p.approval!.requestId, 1)).body.status).toBe('approved');
  });
});

describe('Codex 自动审查 2cfd28b：新建规则与设代理人的「结果待确认」、模块开关', () => {
  it('新建规则、设代理人：按操作编号查回；已建好的不能作废；先作废的原请求晚到也不登记（OP_ABANDONED）；作废按原业务的权限', async () => {
    const body = { docType: 'damage', minCents: 900_000, maxCents: 900_001, steps: [{ group: 'owner' }], note: '结果待确认' };
    const key = randomUUID();
    const created = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: key, ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api(ctx.app, boss, 'GET', `/api/erp/ops/${key}?type=approval_rule`)).body).toMatchObject({ found: true, abandoned: false, refId: created.body.id });
    // 已经建好的编号：作废只返回查回结果，规则照旧在
    expect((await api(ctx.app, boss, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'approval_rule' })).body).toMatchObject({ found: true, abandoned: false });
    // 没收到结果、在服务端确认作废之后，原请求才到：整笔拒绝，不多建一条
    const lost = randomUUID();
    expect((await api(ctx.app, boss, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'approval_rule' })).body).toMatchObject({ found: false, abandoned: true });
    const late = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: lost, ...body });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect((await ctx.sql`SELECT 1 FROM approval_rules WHERE client_key = ${lost}`).length).toBe(0);
    // 作废要有原业务的权限：负责人不能作废「新建审批规则」
    expect((await api(ctx.app, mgrA, 'POST', `/api/erp/ops/${randomUUID()}/abandon`, { type: 'approval_rule' })).status).toBe(403);
    // 设代理人同一套：作废后原请求晚到也不会悄悄生效
    const dKey = randomUUID();
    expect((await api(ctx.app, mgrA, 'POST', `/api/erp/ops/${dKey}/abandon`, { type: 'approval_delegation' })).body).toMatchObject({ found: false, abandoned: true });
    const lateDelegation = await api(ctx.app, mgrA, 'POST', '/api/approvals/delegations', { clientKey: dKey, staffId: ids.mgr_a, delegateId: ids.mgr_b, startsOn: today, endsOn: today, reason: '' });
    expect(lateDelegation.body.error.code).toBe('OP_ABANDONED');
    expect((await ctx.sql`SELECT 1 FROM approval_delegations WHERE client_key = ${dKey}`).length).toBe(0);
    const okKey = randomUUID();
    const delegation = await api(ctx.app, mgrA, 'POST', '/api/approvals/delegations', { clientKey: okKey, staffId: ids.mgr_a, delegateId: ids.mgr_b, startsOn: today, endsOn: today, reason: '' });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);
    expect((await api(ctx.app, mgrA, 'GET', `/api/erp/ops/${okKey}?type=approval_delegation`)).body).toMatchObject({ found: true, refId: delegation.body.id });
    expect((await api(ctx.app, mgrA, 'POST', `/api/approvals/delegations/${delegation.body.id}/revoke`, {})).status).toBe(200);
    await deactivate({ id: created.body.id, version: 1 });
  });

  it('单据所属的 ERP 模块关着时，审批中心不列、不给看、不能审（单张与批量都拒绝 ERP_MODULE_DISABLED）；开回来照常', async () => {
    const p = await payment(2_600);
    expect(p.status).toBe('submitted');
    const rid = p.approval!.requestId;
    const switchPayables = async (on: boolean) => expect((await api(ctx.app, boss, 'PUT', '/api/erp/modules', { modules: { payables: on } })).status).toBe(200);
    await switchPayables(false);
    try {
      // 原来的接口拒绝
      expect((await api(ctx.app, payer, 'GET', `/api/payables/payments/${p.id}`)).body.error.code).toBe('ERP_MODULE_DISABLED');
      // 审批中心：不列、不给看、不能审
      for (const tab of ['mine', 'all']) {
        const cards = (await api(ctx.app, boss, 'GET', `/api/approvals?tab=${tab}`)).body as { id: number }[];
        expect(cards.some((c) => c.id === rid), tab).toBe(false);
      }
      expect((await api(ctx.app, boss, 'GET', `/api/approvals/${rid}`)).body.error.code).toBe('ERP_MODULE_DISABLED');
      const one = await approve(mgrA, rid, 1);
      expect(one.status).toBe(403);
      expect(one.body.error.code).toBe('ERP_MODULE_DISABLED');
      expect((await api(ctx.app, mgrA, 'POST', `/api/approvals/${rid}/return`, { level: 1, reason: '模块关着' })).body.error.code).toBe('ERP_MODULE_DISABLED');
      const batch = await api(ctx.app, mgrA, 'POST', '/api/approvals/batch-approve', { items: [{ id: rid, level: 1 }] });
      expect(batch.body.results[0]).toMatchObject({ ok: false, code: 'ERP_MODULE_DISABLED' });
      expect((await ctx.sql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${p.id}`)[0]?.status).toBe('submitted');
    } finally {
      await switchPayables(true);
    }
    expect((await approve(mgrA, rid, 1)).body.status).toBe('approved');
  });
});

describe('Codex 自动审查 c0acccf：没收到结果时按原级别重新提交、店主的代理人会签', () => {
  it('按原审批单与级别原样再发：上次已经生效的不重复记（单张、批量、退回都一样），不会多同意一级；不是自己审过的这一级拒绝（APPROVAL_MOVED）', async () => {
    const r = await rule({ docType: 'payment', minCents: 432_100, maxCents: 432_101, steps: [{ group: 'manager' }, { group: 'owner' }] });
    try {
      const p = await payment(4_321);
      const rid = p.approval!.requestId;
      const actions = async () => (await ctx.sql<{ level: number; action: string }[]>`SELECT level, action FROM approval_actions WHERE request_id = ${rid} ORDER BY id`).map((a) => `${a.level}:${a.action}`);
      const state = async () => (await ctx.sql<{ status: string; currentLevel: number }[]>`SELECT status, current_level FROM approval_requests WHERE id = ${rid}`)[0];
      // 店主同意第 1 级（店主每一级都能审）：进第 2 级；页面没收到结果
      expect((await approve(boss, rid, 1)).body).toMatchObject({ status: 'pending', currentLevel: 2 });
      // 按原内容（第 1 级）重新提交：单张、批量都按成功返回，不重复记、不会同意第 2 级
      expect((await approve(boss, rid, 1)).status).toBe(200);
      const batch = await api(ctx.app, boss, 'POST', '/api/approvals/batch-approve', { items: [{ id: rid, level: 1 }], comment: '' });
      expect(batch.body.results[0]).toMatchObject({ ok: true });
      expect(await state()).toMatchObject({ status: 'pending', currentLevel: 2 });
      expect(await actions()).toEqual(['1:approve']);
      expect((await ctx.sql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${p.id}`)[0]?.status).toBe('submitted');
      // 别人拿着第 1 级来：这一级不是他审的，拒绝
      const moved = await approve(mgrA, rid, 1);
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe('APPROVAL_MOVED');
      // 退回同样：上次的退回已经生效，原样再发按成功返回、不重复记
      const back = { level: 2, reason: '金额再核对' };
      expect((await api(ctx.app, boss, 'POST', `/api/approvals/${rid}/return`, back)).status).toBe(200);
      expect((await api(ctx.app, boss, 'POST', `/api/approvals/${rid}/return`, back)).status).toBe(200);
      expect(await state()).toMatchObject({ status: 'returned' });
      expect(await actions()).toEqual(['1:approve', '2:return']);
      // 退回以后再拿第 2 级来同意：单据不在待确认，拒绝（上次那次到得再晚也一样）
      expect((await approve(boss, rid, 2)).status).toBe(409);
    } finally {
      await deactivate(r);
    }
  });

  it('店主请假设了代理人：会签这一级代理人能替店主同意（店主同意即这一级通过，记「代 店主」），待我审批里也有；收回后不能', async () => {
    const [owner] = await ctx.sql<{ id: number; displayName: string }[]>`SELECT id, display_name FROM staff WHERE username = 'linlan'`;
    const set = await api(ctx.app, boss, 'POST', '/api/approvals/delegations', { clientKey: randomUUID(), staffId: owner!.id, delegateId: ids.shop_boss, startsOn: today, endsOn: today, reason: '店主请假' });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    let revoked = false;
    const r = await rule({ docType: 'damage', minCents: 0, steps: [{ staffIds: [ids.mgr_a!, ids.mgr_b!], mode: 'all' }] });
    try {
      // 指定的两人都还没同意
      const d1 = await damage();
      const rid1 = d1.approval!.requestId;
      expect((await mine(shopBoss)).find((c) => c.id === rid1)).toMatchObject({ canAct: true, actingFor: [owner!.displayName] });
      const res = await approve(shopBoss, rid1, 1, '替店主审');
      expect(res.body).toMatchObject({ status: 'approved' });
      expect(res.body.levelsDetail[0].actions.at(-1)).toMatchObject({ actorName: '店总丙', onBehalfOfName: owner!.displayName, comment: '替店主审' });
      expect((await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${d1.id}`)).body.status).toBe('confirmed');
      // 已经有一人同意、还差一人：同样替店主同意即通过；再点一次不重复记
      const d2 = await damage();
      const rid2 = d2.approval!.requestId;
      expect((await approve(mgrA, rid2, 1)).body).toMatchObject({ status: 'pending' });
      expect((await approve(shopBoss, rid2, 1)).body).toMatchObject({ status: 'approved' });
      expect((await approve(shopBoss, rid2, 1)).status).toBe(200);
      expect((await ctx.sql`SELECT 1 FROM approval_actions WHERE request_id = ${rid2} AND action = 'approve'`).length).toBe(2);
      // 收回后不能
      expect((await api(ctx.app, boss, 'POST', `/api/approvals/delegations/${set.body.id}/revoke`, {})).status).toBe(200);
      revoked = true;
      const d3 = await damage();
      expect((await mine(shopBoss)).some((c) => c.id === d3.approval!.requestId)).toBe(false);
      expect((await approve(shopBoss, d3.approval!.requestId, 1)).body.error.code).toBe('APPROVAL_NOT_ELIGIBLE');
      expect((await approve(boss, d3.approval!.requestId, 1)).body).toMatchObject({ status: 'approved' });
    } finally {
      await deactivate(r);
      if (!revoked) await api(ctx.app, boss, 'POST', `/api/approvals/delegations/${set.body.id}/revoke`, {});
    }
  });
});

describe('盘点差异审批（A8）、急采待补单（A10）、数据隔离（A9）', () => {
  it('总仓盘点的大差异要写原因类别与说明才能提交；提交后在审批中心看到账面、实盘、差异、比例与原因', async () => {
    const stock = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${mat.id}`)).body.stockMilli as number;
    const counted = stock - q(100);
    const line = { materialId: mat.id, countedMilli: counted, expectedBookMilli: stock };
    const no = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'count', docDate: today, action: 'submit', lines: [line] });
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe('COUNT_REASON_REQUIRED');
    const short = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'count',
      docDate: today,
      action: 'submit',
      lines: [{ ...line, diffReason: 'damaged', diffNote: '坏' }],
    });
    expect(short.body.error.code).toBe('COUNT_REASON_REQUIRED');
    const ok = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'count',
      docDate: today,
      action: 'submit',
      lines: [{ ...line, diffReason: 'damaged', diffNote: '仓库漏雨泡坏' }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.doc).toMatchObject({ status: 'submitted', approval: { status: 'pending' } });
    const detail = (await api(ctx.app, mgrA, 'GET', `/api/approvals/${ok.body.doc.approval.requestId}`)).body;
    expect(detail).toMatchObject({ docType: 'stocktake', doc: { title: '盘点差异' } });
    expect(detail.doc.lines[0].count).toMatchObject({ bookMilli: stock, countedMilli: counted, diffMilli: -q(100), big: true, reason: '损坏', reasonNote: '仓库漏雨泡坏' });
    // 确认时照旧可以改原因类别
    const line0 = detail.doc.lines[0].id;
    const done = await api(ctx.app, mgrA, 'POST', `/api/approvals/${detail.id}/approve`, { level: 1, countReasons: { [line0]: 'unknown' } });
    expect(done.body.status).toBe('approved');
    expect((await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${ok.body.doc.id}`)).body.lines[0]).toMatchObject({ diffReason: 'unknown', diffNote: '仓库漏雨泡坏' });
  });

  it('急采收货生效后超过 3 天没补采购单的进负责人待办；补单后消失', async () => {
    const roomsWh = (await ctx.sql<{ id: number }[]>`SELECT id FROM warehouses WHERE department_id = ${ids.rooms!}`)[0]!.id;
    const rc = await api(ctx.app, reqA, 'POST', '/api/erp/dept-stock/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      urgent: true,
      departmentId: ids.rooms,
      supplierId: s1.id,
      lines: [{ materialId: mat.id, deliveredMilli: q(2), acceptedMilli: q(2), priceCents: 3_000 }],
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    expect(roomsWh).toBeGreaterThan(0);
    const verified = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.body.doc.id}/verify-urgent`, {});
    expect(verified.body.status).toBe('confirmed');
    const listed = async () => ((await api(ctx.app, mgrA, 'GET', '/api/approvals/backfills')).body as { receiptId: number; daysOver: number }[]).find((x) => x.receiptId === rc.body.doc.id);
    expect(await listed()).toBeUndefined();
    // 已生效的单据有触发器拦改，测试库里临时关掉、把生效时间往前挪 5 天
    await ctx.sql.begin(async (tx) => {
      await tx`ALTER TABLE inv_docs DISABLE TRIGGER inv_docs_guard`;
      await tx`UPDATE inv_docs SET confirmed_at = now() - interval '5 days' WHERE id = ${rc.body.doc.id}`;
      await tx`ALTER TABLE inv_docs ENABLE TRIGGER inv_docs_guard`;
    });
    expect(await listed()).toMatchObject({ daysOver: 2 });
    expect((await api(ctx.app, mgrA, 'GET', '/api/approvals/count')).body.backfill).toBeGreaterThanOrEqual(1);
    // 不是负责人看不到这一栏
    expect((await api(ctx.app, payer, 'GET', '/api/approvals/backfills')).status).toBe(403);
    const bf = await api(ctx.app, buyer, 'POST', '/api/purchase-orders/backfill', { clientKey: randomUUID(), receiptDocId: rc.body.doc.id });
    expect(bf.status, JSON.stringify(bf.body)).toBe(201);
    expect(await listed()).toBeUndefined();
  });

  it('部门账号只能看自己上传的、本部门与自己提的需求单里的图片；需求单自检只给审核的人', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`yuzu-approvals-${randomUUID()}`)]).toString('base64');
    const img = (await api(ctx.app, reqA, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: jpeg })).body as { id: number };
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/images/${img.id}`)).status).toBe(200);
    expect((await api(ctx.app, reqB, 'GET', `/api/erp/images/${img.id}`)).status).toBe(404);
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/images/${img.id}`)).status).toBe(200);
    // 提进需求单后，同部门的同事也能看；别的部门仍然不行
    const created = await api(ctx.app, reqA, 'POST', '/api/erp/requests', {
      clientKey: randomUUID(),
      lines: [{ materialId: null, name: '新款拖鞋', purpose: '客用消耗', qtyMilli: q(1), unit: '箱', link: 'https://example.com/slipper', details: '', imageIds: [img.id] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await createStaff(ctx.sql, { username: 'req_rooms2', displayName: '客房申购二', role: 'backoffice', duties: ['request'], departmentId: ids.rooms, password: PASSWORD, mustChangePassword: false });
    const reqA2 = await login(ctx.app, 'req_rooms2');
    expect((await api(ctx.app, reqA2, 'GET', `/api/erp/images/${img.id}`)).status).toBe(200);
    expect((await api(ctx.app, reqB, 'GET', `/api/erp/images/${img.id}`)).status).toBe(404);
    expect((await api(ctx.app, reqB, 'GET', `/api/erp/requests/${created.body.request.id}`)).status).toBe(404);
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/requests/checks')).status).toBe(403);
    expect((await api(ctx.app, buyer, 'GET', '/api/erp/requests/checks')).status).toBe(200);
    // 部门账号用不了审批中心、报销、库存、采购、货款
    for (const url of ['/api/approvals', '/api/erp/expenses', '/api/inventory/materials', '/api/purchase-orders', '/api/payables/overview']) {
      expect((await api(ctx.app, reqA, 'GET', url)).status, url).toBe(403);
    }
  });

  it('自检：待确认的单据各有一张在审的审批单；缺了的报出来', async () => {
    const checks = async () => ((await api(ctx.app, boss, 'GET', '/api/inventory/checks')).body as { key: string; ok: boolean; detail: string }[]).find((c) => c.key === 'approval_requests')!;
    expect(await checks()).toMatchObject({ ok: true });
    const p = await po(10, 300);
    await ctx.sql`UPDATE approval_requests SET status = 'cancelled', finished_at = now(), finished_by = ${ids.mgr_a!} WHERE id = ${p.approval!.requestId}`;
    const bad = await checks();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain(p.docNo);
    // 旧数据兜底：没有在审批单的待确认单据，原来的确认按钮按默认规则补一张再审
    expect((await api(ctx.app, mgrA, 'POST', `/api/purchase-orders/${p.id}/approve`, {})).body.status).toBe('approved');
    expect(await checks()).toMatchObject({ ok: true });
  });
});
