// 8.0.17 需求单的部门主管确认（店主 2026-11-13，docs/FLOW_V8017.md 第 8 节，LC1、LC11–LC13；迁移 125）：
//   · 部门档案设主管；采购规则定哪些需求单要主管先确认（不要 / 估价达到询价门槛的 / 全部）；
//   · 要确认的：主管（或店主）确认以前采购不能通过；主管可以退回；修改后重新提交要重新确认；
//   · 不拦的：部门没设主管、主管停用、提单人就是主管、店主提的；
//   · 主管看得到自己部门的需求单；流程图多一环「部门确认」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PURCHASE_RULES } from '../src/shared/purchasing';
import type { PurchaseFlow } from '../src/shared/purchase-flow';
import { requestStatusLabel } from '../src/shared/requests';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let buyer: string;
let reqA: string; // 浴区的申购员
let headA: string; // 浴区的主管（自己在别的部门）
let headAId: number;
let head2: string; // 后来换上的主管
let head2Id: number;
let reqB: string; // 水吧的申购员（水吧没设主管）
let deptA: number;
let deptB: number;
let mat: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);

/** 浴区提一张：boxes 箱 × ¥450（2 箱 ¥900 不到门槛，4 箱 ¥1,800 到了） */
const submit = (cookie: string, boxes: number, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(boxes), unit: '箱', refPriceCents: 45_000 }], ...body });
const act = (cookie: string, id: number, action: string, body: Record<string, unknown> = {}) => api(ctx.app, cookie, 'POST', `/api/erp/requests/${id}/${action}`, body);
const get = async (cookie: string, id: number) => (await api(ctx.app, cookie, 'GET', `/api/erp/requests/${id}`)).body;
const setRules = (body: Record<string, unknown>) => api(ctx.app, boss, 'PUT', '/api/inventory/purchase-rules', body);
const setHead = async (deptId: number, headId: number | null) => {
  const d = ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string; active: boolean; sortOrder: number }[]).find((x) => x.id === deptId)!;
  return api(ctx.app, boss, 'PUT', `/api/inventory/departments/${deptId}`, { name: d.name, active: d.active, sortOrder: d.sortOrder, headId });
};
const flow = async (cookie: string, id: number) => (await api(ctx.app, cookie, 'GET', `/api/purchase-flow/one?kind=request&id=${id}`)).body as PurchaseFlow;

beforeAll(async () => {
  ctx = await setup();
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  deptA = await mk('浴区');
  deptB = await mk('水吧');
  const staff = (username: string, displayName: string, departmentId: number | null) =>
    createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties: ['request'], departmentId: departmentId ?? undefined, password: PASSWORD, mustChangePassword: false });
  await staff('req_a', '浴区申购', deptA);
  headAId = await staff('head_a', '王主管', deptB);
  head2Id = await staff('head_2', '李主管', null);
  await staff('req_b', '水吧申购', deptB);
  reqA = await login(ctx.app, 'req_a');
  headA = await login(ctx.app, 'head_a');
  head2 = await login(ctx.app, 'head_2');
  reqB = await login(ctx.app, 'req_b');
  mat = ((await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string; name: string }[]).find((m) => m.code === 'M016')!;
}, 120_000);
afterAll(async () => ctx.close());

describe('部门档案：主管', () => {
  it('设主管、换主管、不设；没带这一项的保存不动主管；停用的员工不能设；有档案权限的才能改', async () => {
    expect(DEFAULT_PURCHASE_RULES.deptConfirm).toBe('threshold');
    expect((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body.find((d: { id: number }) => d.id === deptA).head).toBeNull();
    const options = (await api(ctx.app, boss, 'GET', '/api/inventory/department-head-options')).body as { id: number; name: string }[];
    expect(options.map((o) => o.name)).toEqual(expect.arrayContaining(['王主管', '李主管']));
    expect((await api(ctx.app, reqA, 'GET', '/api/inventory/department-head-options')).status).toBe(403);
    const saved = await setHead(deptA, headAId);
    expect(saved.status).toBe(200);
    expect(saved.body.find((d: { id: number }) => d.id === deptA).head).toEqual({ id: headAId, name: '王主管', active: true });
    // 旧页面不带 headId：主管不动
    await api(ctx.app, boss, 'PUT', `/api/inventory/departments/${deptA}`, { name: '浴区', active: true, sortOrder: 3 });
    expect((await api(ctx.app, boss, 'GET', '/api/inventory/departments')).body.find((d: { id: number }) => d.id === deptA)).toMatchObject({ sortOrder: 3, head: { id: headAId } });
    expect((await setHead(deptA, 999_999)).body.error.code).toBe('HEAD_INVALID');
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${head2Id}`;
    expect((await setHead(deptA, head2Id)).body.error.code).toBe('HEAD_INVALID');
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${head2Id}`;
    expect((await api(ctx.app, reqA, 'PUT', `/api/inventory/departments/${deptA}`, { name: '浴区', active: true, sortOrder: 3, headId: null })).status).toBe(403);
  });
});

describe('哪些需求单要主管确认（LC11、LC12）', () => {
  it('默认「估价达到询价门槛的」：¥900 不用，¥1,800 要；没填参考价的行不算；部门没设主管的不拦；主管自己提、店主提的算已确认', async () => {
    const small = (await submit(reqA, 2)).body.request;
    expect(small.deptConfirm).toEqual({ state: 'none', head: null, confirmedByName: null, confirmedAt: null });
    expect(requestStatusLabel(small)).toBe('待审核');
    const big = (await submit(reqA, 4)).body.request;
    expect(big.deptConfirm).toMatchObject({ state: 'pending', head: { id: headAId, name: '王主管' }, confirmedAt: null });
    expect(requestStatusLabel(big)).toBe('待主管确认');
    expect(big.canDeptConfirm).toBe(false);
    // 没填参考价：估不出来，不算进去
    const unpriced = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(40), unit: '箱' }] });
    expect(unpriced.body.request.deptConfirm.state).toBe('none');
    // 水吧没设主管
    expect((await submit(reqB, 10)).body.request.deptConfirm.state).toBe('none');
    // 店主替浴区提、主管自己提（主管是店主或采购以外的人时只能给自己的部门提，这里由店主替他所在的水吧设成主管再提）
    const byBoss = (await submit(boss, 4, { departmentId: deptA })).body.request;
    expect(byBoss.deptConfirm).toMatchObject({ state: 'confirmed', confirmedByName: expect.any(String) });
    expect(byBoss.deptConfirm.confirmedAt).not.toBeNull();
    await setHead(deptB, headAId);
    expect((await submit(headA, 4)).body.request.deptConfirm).toMatchObject({ state: 'confirmed', confirmedByName: '王主管' });
    await setHead(deptB, null);
  });

  it('规则「全部」：小额的也要；「不要」：都不用；门槛设成 0 时「达到门槛的」都不用；主管停用了不拦', async () => {
    expect((await setRules({ deptConfirm: 'everything' })).status).toBe(400);
    expect((await setRules({ deptConfirm: 'all' })).body.deptConfirm).toBe('all');
    expect((await submit(reqA, 1)).body.request.deptConfirm.state).toBe('pending');
    await setRules({ deptConfirm: 'off' });
    expect((await submit(reqA, 40)).body.request.deptConfirm.state).toBe('none');
    await setRules({ deptConfirm: 'threshold', quoteThresholdCents: 0 });
    expect((await submit(reqA, 40)).body.request.deptConfirm.state).toBe('none');
    await setRules({ quoteThresholdCents: DEFAULT_PURCHASE_RULES.quoteThresholdCents });
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${headAId}`;
    expect((await submit(reqA, 4)).body.request.deptConfirm.state).toBe('none');
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${headAId}`;
  });
});

describe('确认、退回、再提交（LC13）', () => {
  it('主管确认以前采购不能通过（可以退回、不采购）；不是主管的不能确认；确认以后照旧审核；重复确认不重复记', async () => {
    const r = (await submit(reqA, 4)).body.request;
    // 采购：通过被拦，写明在等谁
    const blocked = await act(buyer, r.id, 'approve');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'DEPT_CONFIRM_REQUIRED', message: expect.stringContaining('王主管') });
    // 提单人、别的部门的人不能确认；主管看得到并能确认
    expect((await act(reqA, r.id, 'dept-confirm')).status).toBe(403);
    expect((await act(reqB, r.id, 'dept-confirm')).status).toBe(403);
    expect((await act(ctx.clerk, r.id, 'dept-confirm')).status).toBe(403);
    const seen = await get(headA, r.id);
    expect(seen).toMatchObject({ id: r.id, canDeptConfirm: true });
    expect((await get(reqA, r.id)).canDeptConfirm).toBe(false);
    // 流程图：停在「部门确认」，需求审核灰着
    let f = await flow(reqA, r.id);
    expect(f.stage).toBe('confirm');
    expect(f.nodes.slice(0, 3).map((n) => `${n.key}:${n.state}:${n.text}`)).toEqual(['request:done:已提交', 'confirm:current:待主管确认', 'review:pending:待主管确认后']);
    expect(f.nodes[1]!.role).toBe('部门主管 · 王主管');
    // 主管在自己的列表里看得到浴区的需求单，headOf 带着浴区
    const mine = (await api(ctx.app, headA, 'GET', '/api/erp/requests')).body;
    expect(mine.me.headOf).toEqual([deptA]);
    expect(mine.requests.map((x: { id: number }) => x.id)).toContain(r.id);
    expect((await api(ctx.app, reqB, 'GET', '/api/erp/requests')).body.requests.map((x: { id: number }) => x.id)).not.toContain(r.id);

    const ok = await act(headA, r.id, 'dept-confirm');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'submitted', canDeptConfirm: false, deptConfirm: { state: 'confirmed', confirmedByName: '王主管' } });
    expect(requestStatusLabel(ok.body)).toBe('待审核');
    expect((await act(headA, r.id, 'dept-confirm')).status).toBe(200);
    expect(ok.body.approvals.filter((a: { reason: string }) => a.reason === '部门主管确认')).toHaveLength(1);
    expect((await get(headA, r.id)).approvals.filter((a: { reason: string }) => a.reason === '部门主管确认')).toHaveLength(1);
    f = await flow(reqA, r.id);
    expect(f.stage).toBe('review');
    expect(f.nodes[1]).toMatchObject({ key: 'confirm', state: 'done', text: '已确认', role: '王主管' });
    // 采购通过
    expect((await act(buyer, r.id, 'approve')).body.status).toBe('approved');
    // 已经通过的不能再做主管退回
    expect((await act(headA, r.id, 'dept-return', { reason: '晚了' })).status).toBe(409);
  });

  it('主管退回要写原因，回到提单人；改了重新提交要重新确认；店主可以替主管确认；采购在等主管时可以定为不采购', async () => {
    const r = (await submit(reqA, 4)).body.request;
    expect((await act(headA, r.id, 'dept-return', {})).status).toBe(400);
    expect((await act(reqA, r.id, 'dept-return', { reason: '数量太多' })).status).toBe(403);
    const back = await act(headA, r.id, 'dept-return', { reason: '数量太多' });
    expect(back.body).toMatchObject({ status: 'returned', reason: '主管退回：数量太多', canDeptConfirm: false });
    expect((await flow(reqA, r.id)).nodes[1]).toMatchObject({ key: 'confirm', state: 'current', alert: '已退回：主管退回：数量太多' });
    // 退回的不能确认
    expect((await act(headA, r.id, 'dept-confirm')).status).toBe(409);
    // 改成 3 箱（¥1,350，还是到门槛）重新提交：重新等主管确认
    const line = { materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(3), unit: '箱', refPriceCents: 45_000 };
    const again = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${r.id}`, { lines: [line] });
    expect(again.body).toMatchObject({ status: 'submitted', deptConfirm: { state: 'pending', head: { id: headAId } } });
    // 店主替主管确认
    expect((await act(boss, r.id, 'dept-confirm')).body.deptConfirm).toMatchObject({ state: 'confirmed' });
    // 确认以后提单人又改了：要重新确认；改到门槛以下就不用了
    expect((await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${r.id}`, { lines: [line] })).body.deptConfirm.state).toBe('pending');
    expect((await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${r.id}`, { lines: [{ ...line, qtyMilli: q(2) }] })).body.deptConfirm).toMatchObject({ state: 'none', head: null });
    expect((await act(buyer, r.id, 'approve')).body.status).toBe('approved');

    // 等主管确认的时候采购定为不采购
    const r2 = (await submit(reqA, 4)).body.request;
    expect((await act(buyer, r2.id, 'reject', { reason: '库里还有' })).body.status).toBe('rejected');
    expect((await flow(buyer, r2.id)).end).toBe('rejected');
    expect((await act(headA, r2.id, 'dept-confirm')).status).toBe(409);
  });

  it('部门换了主管：新主管、提交时记着的原主管都能确认；兜底约束拦住「等主管确认却已通过」', async () => {
    const r = (await submit(reqA, 4)).body.request;
    await setHead(deptA, head2Id);
    expect((await get(head2, r.id)).canDeptConfirm).toBe(true);
    expect((await get(headA, r.id)).canDeptConfirm).toBe(true);
    await expect(ctx.sql`UPDATE purchase_requests SET status = 'approved', reviewed_by = ${head2Id}, reviewed_at = now() WHERE id = ${r.id}`).rejects.toThrow(/purchase_requests_dept_before_approve/);
    expect((await act(head2, r.id, 'dept-confirm')).body.deptConfirm).toMatchObject({ state: 'confirmed', confirmedByName: '李主管', head: { id: headAId } });
    // 之后新提的记新主管
    expect((await submit(reqA, 4)).body.request.deptConfirm.head).toEqual({ id: head2Id, name: '李主管' });
    await setHead(deptA, headAId);
  });
});
