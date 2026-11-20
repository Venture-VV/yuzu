// 8.1.18 组织架构与岗位（docs/POSITIONS_V8118.md GW1–GW9）：按岗位建账号、负责人管本部门员工、超级管理员按岗位开关权限、
// 老账号第一次登录自己选新岗位（选完不再提示，不能选比原来高的级别）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '../src/shared/permissions';
import { positionDefaults } from '../src/shared/positions';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const me = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/auth/me')).body as { staff: { position: string | null; needsPosition: boolean; role: string }; permissions: string[] };

/** 店主建账号，登录时把临时密码换掉（库里直接清掉首次改密的标记） */
async function hire(username: string, body: Record<string, unknown>) {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, ...body, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: r.body.id as number, cookie: await login(ctx.app, username) };
}

describe('按岗位建账号（GW1、GW2）', () => {
  it('前厅部员工：旧岗位自动是前台店员，权限按岗位模板', async () => {
    const { cookie } = await hire('fd_staff', { position: 'front.staff' });
    const info = await me(cookie);
    expect(info.staff.position).toBe('front.staff');
    expect(info.staff.role).toBe('clerk');
    expect(info.permissions.sort()).toEqual(positionDefaults('front.staff', ALL_PERMISSIONS).sort());
  });

  it('总裁 = 店主（全部权限）；外联部员工同时有库存与采购（不受分岗不兼任限制）', async () => {
    const boss = await hire('pres2', { position: 'president' });
    expect((await me(boss.cookie)).staff.role).toBe('owner');
    expect((await me(boss.cookie)).permissions).toContain('staff.manage');
    const out = await hire('out_staff', { position: 'outreach.staff' });
    const p = (await me(out.cookie)).permissions;
    expect(p).toContain('inventory.operate');
    expect(p).toContain('purchase.manage');
    expect(p).not.toContain('inventory.approve');
  });

  it('个人微调只有总裁能给；店主专属的权限给不了', async () => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'bad_adj', displayName: 'x', position: 'front.staff', permissionAdjust: { add: ['staff.manage'], remove: [] } });
    expect(r.status).toBe(400);
    const { cookie } = await hire('fd_adj', { position: 'front.staff', permissionAdjust: { add: ['ledger.readHistory'], remove: ['recharge.create'] } });
    const p = (await me(cookie)).permissions;
    expect(p).toContain('ledger.readHistory');
    expect(p).not.toContain('recharge.create');
  });
});

describe('负责人管本部门员工（GW6）', () => {
  it('前厅部负责人只看得到、只建得了前厅部员工；不能建负责人、别的部门，不能个人微调', async () => {
    const lead = await hire('fd_lead', { position: 'front.lead' });
    const list = (await api(ctx.app, lead.cookie, 'GET', '/api/staff')).body as { username: string; position: string | null }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => s.position === 'front.staff')).toBe(true);
    expect((await api(ctx.app, lead.cookie, 'POST', '/api/staff', { username: 'fd_new', displayName: '新员工', position: 'front.staff' })).status).toBe(201);
    expect((await api(ctx.app, lead.cookie, 'POST', '/api/staff', { username: 'fd_new2', displayName: 'x', position: 'front.lead' })).status).toBe(403);
    expect((await api(ctx.app, lead.cookie, 'POST', '/api/staff', { username: 'fd_new3', displayName: 'x', position: 'male.staff' })).status).toBe(403);
    expect((await api(ctx.app, lead.cookie, 'POST', '/api/staff', { username: 'fd_new4', displayName: 'x', role: 'clerk' })).status).toBe(403);
    const target = list.find((s) => s.username === 'fd_staff')!;
    const id = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = ${target.username}`)[0]!.id;
    expect((await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${id}`, { displayName: '改名', active: true, permissionAdjust: { add: ['ledger.export'], remove: [] } })).status).toBe(403);
    const edited = await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${id}`, { displayName: '改名', active: true });
    expect(edited.status).toBe(200);
    // 改完返回的名单也只有本部门员工（Codex 审查 766d557 P2）
    expect((edited.body as { position: string | null }[]).every((s) => s.position === 'front.staff')).toBe(true);
    expect((await api(ctx.app, lead.cookie, 'POST', `/api/staff/${id}/reset-password`)).status).toBe(200);
    // 店主的账号碰不到
    expect((await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${ctx.ownerId}`, { displayName: '改名', active: false })).status).toBe(403);
    // 不能改岗位权限
    expect((await api(ctx.app, lead.cookie, 'PUT', '/api/admin/position-permissions', { positions: { 'front.staff': [] } })).status).toBe(403);
  });

  it('多门店：负责人只管挂的门店都在自己能进的门店里的员工（Codex 安全审查 49a64d0）', async () => {
    const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '二店公司', taxNo: '91440300MA5POS0001' });
    const store = await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'p2', name: '二店', entityId: entity.body.id });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const second = store.body.id as number;
    const lead = await hire('m_lead', { position: 'male.lead' });
    const here = await hire('m_here', { position: 'male.staff' });
    const there = await hire('m_there', { position: 'male.staff' });
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${there.id}/stores`, { storeIds: [second] })).status).toBe(200);
    const list = (await api(ctx.app, lead.cookie, 'GET', '/api/staff')).body as { id: number }[];
    expect(list.some((x) => Number(x.id) === here.id)).toBe(true);
    expect(list.some((x) => Number(x.id) === there.id)).toBe(false);
    expect((await api(ctx.app, lead.cookie, 'POST', `/api/staff/${there.id}/reset-password`)).status).toBe(403);
    expect((await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${there.id}`, { displayName: '改名', active: false })).status).toBe(403);
    expect((await api(ctx.app, lead.cookie, 'POST', `/api/staff/${here.id}/reset-password`)).status).toBe(200);
  });

  it('负责人只能给员工配自己的领料小仓（Codex 安全审查 4e118c1）', async () => {
    const [a] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('出品小仓') RETURNING id`;
    const [b] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('别家小仓') RETURNING id`;
    const lead = await hire('k_lead', { position: 'kitchen.lead', departmentId: a!.id });
    expect((await api(ctx.app, lead.cookie, 'POST', '/api/staff', { username: 'k_bad', displayName: 'x', position: 'kitchen.staff', departmentId: b!.id })).status).toBe(403);
    const ok = await api(ctx.app, lead.cookie, 'POST', '/api/staff', { username: 'k_ok', displayName: 'x', position: 'kitchen.staff', departmentId: a!.id });
    expect(ok.status).toBe(201);
    expect((await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${ok.body.id}`, { displayName: 'x', active: true, departmentId: b!.id })).status).toBe(403);
    expect((await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${ok.body.id}`, { displayName: 'y', active: true, departmentId: null })).status).toBe(200);
  });

  it('总裁单独加过权限或配了别的小仓的员工，负责人看不到、改不了、重置不了（Codex 安全审查 6dfff92）', async () => {
    const lead = await hire('w_lead', { position: 'wellness.lead' });
    const plain = await hire('w_plain', { position: 'wellness.staff' });
    const extra = await hire('w_extra', { position: 'wellness.staff', permissionAdjust: { add: ['ar.manage'], remove: [] } });
    const [other] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('保健外小仓') RETURNING id`;
    const stock = await hire('w_stock', { position: 'wellness.staff', departmentId: other!.id });
    const ids = ((await api(ctx.app, lead.cookie, 'GET', '/api/staff')).body as { id: number }[]).map((x) => Number(x.id));
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(extra.id);
    expect(ids).not.toContain(stock.id);
    for (const t of [extra, stock]) {
      expect((await api(ctx.app, lead.cookie, 'POST', `/api/staff/${t.id}/reset-password`)).status).toBe(403);
      expect((await api(ctx.app, lead.cookie, 'PUT', `/api/staff/${t.id}`, { displayName: '改名', active: false })).status).toBe(403);
    }
  });

  it('财务部负责人没有账号与权限配置（表上 ✘）', async () => {
    const fin = await hire('fin_lead', { position: 'finance.lead' });
    expect((await api(ctx.app, fin.cookie, 'GET', '/api/staff')).status).toBe(403);
  });
});

describe('超级管理员按岗位开关权限（GW8）', () => {
  it('去掉前厅部员工的「确认充值入账」→ 立即生效；恢复建议值后回来', async () => {
    const { cookie } = await hire('fd_toggle', { position: 'front.staff' });
    const before = (await me(cookie)).permissions;
    expect(before).toContain('recharge.create');
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-permissions', { positions: { 'front.staff': before.filter((p) => p !== 'recharge.create') } });
    expect(r.status).toBe(200);
    expect(r.body.positions.overrides['front.staff']).toEqual({ add: [], remove: ['recharge.create'] });
    expect((await me(cookie)).permissions).not.toContain('recharge.create');
    // 总裁专属的给不了
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-permissions', { positions: { 'front.staff': [...before, 'settings.manage'] } })).status).toBe(400);
    await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-permissions', { positions: { 'front.staff': positionDefaults('front.staff', ALL_PERMISSIONS) } });
    expect((await me(cookie)).permissions).toContain('recharge.create');
    const m = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/permissions')).body;
    expect(m.positions.overrides).toEqual({});
  });
});

describe('老账号第一次登录选新岗位（GW7）', () => {
  it('只要求登录的业务接口（开票申请、自定义字段、会员规则）没选岗之前也拒绝（Codex 审查 766d557 P2）', async () => {
    await createStaff(ctx.sql, { username: 'old_inv', displayName: '老店员二', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET needs_position = true WHERE username = 'old_inv'`;
    const cookie = await login(ctx.app, 'old_inv');
    for (const url of ['/api/membership/rules', '/api/custom-fields/defs', '/api/invoice-requests/source?visitId=1']) {
      const r = await api(ctx.app, cookie, 'GET', url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code, url).toBe('POSITION_REQUIRED');
    }
    expect((await api(ctx.app, cookie, 'POST', '/api/invoice-requests', {})).body.error.code).toBe('POSITION_REQUIRED');
    expect((await api(ctx.app, cookie, 'PUT', '/api/custom-fields/member/1', {})).body.error.code).toBe('POSITION_REQUIRED');
  });

  it('负责人重置密码时目标已被调出本部门：不生效（Codex 审查 766d557 P1）', async () => {
    const lead = await hire('fd_lead2', { position: 'front.lead' });
    const target = await hire('fd_moved', { position: 'front.staff' });
    // 总裁把人调成负责人以后负责人再重置：拒绝、密码不变（核对与写入之间的竞态由 UPDATE 里带的范围兜底，用例不好造时序）
    await ctx.sql`UPDATE staff SET position = 'front.lead' WHERE id = ${target.id}`;
    const r = await api(ctx.app, lead.cookie, 'POST', `/api/staff/${target.id}/reset-password`);
    expect(r.status).toBe(403);
    expect((await ctx.sql<{ mustChangePassword: boolean }[]>`SELECT must_change_password FROM staff WHERE id = ${target.id}`)[0]!.mustChangePassword).toBe(false);
  });

  it('没选之前除了会话接口都拒绝；只能选同级或更低的岗位；选完不再提示；后台标「自选岗位」', async () => {
    await createStaff(ctx.sql, { username: 'old_clerk', displayName: '老店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET needs_position = true WHERE username = 'old_clerk'`;
    const cookie = await login(ctx.app, 'old_clerk');
    expect((await me(cookie)).staff.needsPosition).toBe(true);
    const blocked = await api(ctx.app, cookie, 'GET', '/api/members?q=1');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('POSITION_REQUIRED');
    const options = (await api(ctx.app, cookie, 'GET', '/api/auth/position-options')).body.options as { key: string; level: string }[];
    expect(options.every((o) => o.level === 'admin')).toBe(true);
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'front.lead' })).status).toBe(400);
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'president' })).status).toBe(400);
    // 同级也不行：前台店员选不了财务部员工（Codex 安全审查 02d66df，店主定方案 B）
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'finance.staff' })).status).toBe(400);
    expect(options.some((o) => o.key === 'finance.staff' || o.key === 'outreach.staff')).toBe(false);
    const ok = await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'male.staff' });
    expect(ok.status).toBe(200);
    expect(ok.body.staff).toMatchObject({ position: 'male.staff', needsPosition: false });
    expect(ok.body.permissions.sort()).toEqual(positionDefaults('male.staff', ALL_PERMISSIONS).sort());
    // 选完不再提示，也不能自己再改
    expect((await me(cookie)).staff.needsPosition).toBe(false);
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'front.staff' })).status).toBe(422);
    // 男宾部员工没有查会员，有看在店手牌
    expect((await api(ctx.app, cookie, 'GET', '/api/members?q=1')).status).toBe(403);
    expect((await api(ctx.app, cookie, 'GET', '/api/frontdesk/board')).status).toBe(200);
    const row = ((await api(ctx.app, ctx.owner, 'GET', '/api/staff')).body as { username: string; positionChosenAt: string | null; position: string }[]).find((s) => s.username === 'old_clerk')!;
    expect(row.position).toBe('male.staff');
    expect(row.positionChosenAt).not.toBeNull();
    const [audit] = await ctx.sql<{ detail: { position: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'position_chosen' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.position).toBe('male.staff');
    // 总裁在后台改了岗位：不再标「自选岗位」
    const id = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'old_clerk'`)[0]!.id;
    await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${id}`, { displayName: '老店员', position: 'front.staff', active: true });
    const after = ((await api(ctx.app, ctx.owner, 'GET', '/api/staff')).body as { username: string; positionChosenAt: string | null }[]).find((s) => s.username === 'old_clerk')!;
    expect(after.positionChosenAt).toBeNull();
  });

  it('总裁把还没选岗的老账号改成专用账号：不用再选岗（Codex 审查 4e118c1）', async () => {
    const id = await createStaff(ctx.sql, { username: 'old_pad', displayName: '老平板', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET needs_position = true WHERE id = ${id}`;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${id}`, { displayName: '老平板', role: 'tablet', duties: [], active: true })).status).toBe(200);
    expect((await ctx.sql<{ needsPosition: boolean }[]>`SELECT needs_position FROM staff WHERE id = ${id}`)[0]!.needsPosition).toBe(false);
  });

  it('原来是值班经理的可以选负责人，不能选总经办', async () => {
    await createStaff(ctx.sql, { username: 'old_duty', displayName: '老值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET needs_position = true WHERE username = 'old_duty'`;
    const cookie = await login(ctx.app, 'old_duty');
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'gmo' })).status).toBe(400);
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/position', { position: 'front.lead' })).status).toBe(200);
    expect((await me(cookie)).permissions).toContain('staff.dept');
  });
});
