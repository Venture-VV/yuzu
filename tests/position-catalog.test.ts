// 8.2.0 P04（docs/YUZU_REQ_V820.md 第 5 节）：岗位职权数据重建——部门 → 岗位 → 建议权限三张表。
//   · 初始数据与最新的岗位职权表（代码里的 positionDefaults）逐项一致；
//   · 算权限按库里的建议权限：库里改了，员工下一次请求就按新的（不再写死在代码里）；同一个岗位名在不同部门各自一份；
//   · 老账号还在用旧岗位的要先选岗位，专用账号照旧；配置日志只追加。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '../src/shared/permissions';
import { ORG_DEPARTMENTS, POSITIONS, positionDefaults } from '../src/shared/positions';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const me = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/auth/me')).body as { permissions: string[] };

describe('岗位职权数据（P04）', () => {
  it('初始数据：部门、岗位、每个岗位的建议权限与 8.1.18 的岗位职权表逐项一致；总裁固定全部权限', async () => {
    const depts = await ctx.sql<{ key: string; name: string }[]>`SELECT key, name FROM org_departments ORDER BY sort`;
    expect(depts).toEqual(ORG_DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })));
    const cat = await ctx.sql<{ key: string; department: string; title: string; level: string; allPermissions: boolean }[]>`
      SELECT key, department, title, level, all_permissions FROM position_catalog ORDER BY sort`;
    expect(cat.map((c) => c.key)).toEqual(POSITIONS.map((p) => p.key));
    for (const p of POSITIONS) expect(cat.find((c) => c.key === p.key)).toMatchObject({ department: p.department, title: p.title, level: p.level, allPermissions: p.key === 'president' });
    const rows = await ctx.sql<{ positionKey: string; permission: string }[]>`SELECT position_key, permission FROM position_suggestions`;
    for (const p of POSITIONS) {
      if (p.key === 'president') continue;
      const mine = rows
        .filter((r) => r.positionKey === p.key)
        .map((r) => r.permission)
        .sort();
      expect(mine, p.key).toEqual([...positionDefaults(p.key, ALL_PERMISSIONS)].sort());
    }
    expect(rows.some((r) => r.positionKey === 'president')).toBe(false);
    const log = await ctx.sql<{ action: string }[]>`SELECT action FROM position_config_log ORDER BY id`;
    expect(log.map((l) => l.action)).toEqual(['init', 'legacy_migrate']);
    await expect(ctx.sql`DELETE FROM position_config_log`).rejects.toThrow();
  });

  it('算权限按库里的建议权限：前厅部员工的建议里去掉一项、加一项，下一次请求就生效；别的部门的员工不受影响', async () => {
    const hire = async (username: string, position: string) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
      return login(ctx.app, username);
    };
    const front = await hire('cat_front', 'front.staff');
    const male = await hire('cat_male', 'male.staff');
    expect((await me(front)).permissions).toContain('recharge.create');
    const maleBefore = (await me(male)).permissions.sort();
    await ctx.sql`DELETE FROM position_suggestions WHERE position_key = 'front.staff' AND permission = 'recharge.create'`;
    await ctx.sql`INSERT INTO position_suggestions (position_key, permission) VALUES ('front.staff', 'ledger.readHistory')`;
    const after = (await me(front)).permissions;
    expect(after).not.toContain('recharge.create');
    expect(after).toContain('ledger.readHistory');
    expect((await me(male)).permissions.sort()).toEqual(maleBefore);
    // 后台的权限矩阵：建议权限（defaults）就是库里的
    const matrix = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/permissions')).body as { positions: { defaults: Record<string, string[]> } };
    expect(matrix.positions.defaults['front.staff']).toContain('ledger.readHistory');
    expect(matrix.positions.defaults['front.staff']).not.toContain('recharge.create');
    // 一项都没有：就是没有（不回落到代码里的模板）
    await ctx.sql`DELETE FROM position_suggestions WHERE position_key = 'front.staff'`;
    expect((await me(front)).permissions).toEqual([]);
    // 恢复
    await ctx.sql`INSERT INTO position_suggestions (position_key, permission) SELECT 'front.staff', unnest(${positionDefaults('front.staff', ALL_PERMISSIONS)}::text[])`;
    expect((await me(front)).permissions).toContain('recharge.create');
  });
});

describe('分部门岗位职权配置（P05）', () => {
  type View = {
    departments: { key: string; name: string; positions: { key: string; title: string; suggested: string[]; version: string; staff: number; adjusted: boolean }[] }[];
    log: { action: string; positionKey: string | null; added: string[]; removed: string[]; staffName: string | null }[];
    legacy: { waiting: number; special: number };
  };
  const view = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', '/api/admin/position-catalog')).body as View;
  const pos = (v: View, key: string) => v.departments.flatMap((d) => d.positions).find((p) => p.key === key)!;

  it('按部门列出岗位（不含总裁）：岗位名、建议权限项数、在职人数；同一个岗位名在不同部门是两行', async () => {
    const v = await view();
    expect(v.departments.map((d) => d.key)).toEqual(ORG_DEPARTMENTS.map((d) => d.key).filter((k) => k !== 'company'));
    const all = v.departments.flatMap((d) => d.positions);
    expect(all).toHaveLength(POSITIONS.length - 1);
    expect(pos(v, 'male.staff').title).toBe('男宾部员工');
    expect(pos(v, 'female.staff').title).toBe('女宾部员工');
    expect(pos(v, 'front.staff').suggested.sort()).toEqual([...positionDefaults('front.staff', ALL_PERMISSIONS)].sort());
    expect(v.log.map((l) => l.action)).toEqual(['legacy_migrate', 'init']);
  });

  it('改一个岗位的建议权限：整批换、记日志与审计；版本对不上拒绝；总裁专属的不能建议；只有总裁能改', async () => {
    const before = pos(await view(), 'kangmei.staff');
    const want = [...before.suggested.filter((p) => p !== 'dining.orderFruit'), 'ledger.readHistory'];
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-catalog/kangmei.staff', { permissions: want, version: before.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = pos(r.body as View, 'kangmei.staff');
    expect(after.suggested).toContain('ledger.readHistory');
    expect(after.suggested).not.toContain('dining.orderFruit');
    expect(after.version).not.toBe(before.version);
    expect((r.body as View).log[0]).toMatchObject({ action: 'suggestions', positionKey: 'kangmei.staff', added: ['ledger.readHistory'], removed: ['dining.orderFruit'] });
    // 康美部员工以外的岗位不受影响
    expect(pos(r.body as View, 'kangmei.lead').suggested).toEqual(pos(await view(), 'kangmei.lead').suggested);
    // 旧版本再提交：拒绝
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-catalog/kangmei.staff', { permissions: before.suggested, version: before.version });
    expect(stale.body.error.code).toBe('POSITION_STALE');
    // 总裁专属
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-catalog/kangmei.staff', { permissions: ['staff.manage'], version: after.version })).status).toBe(400);
    // 没有「修改经营规则」的改不了
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/position-catalog/kangmei.staff', { permissions: [], version: after.version })).status).toBe(403);
    // 总裁没有这一行
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-catalog/president', { permissions: [], version: 'x' })).status).toBe(404);
    const audit = await ctx.sql<{ detail: { position: string } }[]>`SELECT detail FROM audit_logs WHERE target_type = 'position_suggestions' ORDER BY id DESC LIMIT 1`;
    expect(audit[0]!.detail.position).toBe('kangmei.staff');
    // 改回去
    const back = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/position-catalog/kangmei.staff', { permissions: before.suggested, version: after.version });
    expect(pos(back.body as View, 'kangmei.staff').suggested.sort()).toEqual([...before.suggested].sort());
  });

  it('导出 Excel：职权表（权限 × 岗位打 ✔）、岗位汇总、变更记录', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/position-catalog/export', headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(200);
    expect(decodeURIComponent(res.headers['content-disposition'] as string)).toContain('分部门岗位职权配置-');
    const book = readXlsx(res.rawPayload);
    expect(book.sheets.map((s) => s.name)).toEqual(['职权表', '岗位汇总', '变更记录']);
    const m = book.sheets[0]!;
    const line = (r: number) => [...(m.rows.get(r)?.values() ?? [])].map((c) => c.value ?? '');
    expect(line(1).slice(0, 3)).toEqual(['分组', '权限', '权限编号']);
    const recharge = [...m.rows.keys()].map(line).find((l) => l[2] === 'recharge.create')!;
    const col = line(2).findIndex((v, i) => i > 2 && line(1)[i] === '前厅部' && v === '员工');
    expect(col).toBeGreaterThan(2);
    expect(recharge[col]).toBe('✔');
  });
});
