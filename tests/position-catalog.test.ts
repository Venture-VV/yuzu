// 8.2.0 P04（docs/YUZU_REQ_V820.md 第 5 节）：岗位职权数据重建——部门 → 岗位 → 建议权限三张表。
//   · 初始数据与最新的岗位职权表（代码里的 positionDefaults）逐项一致；
//   · 算权限按库里的建议权限：库里改了，员工下一次请求就按新的（不再写死在代码里）；同一个岗位名在不同部门各自一份；
//   · 老账号还在用旧岗位的要先选岗位，专用账号照旧；配置日志只追加。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '../src/shared/permissions';
import { ORG_DEPARTMENTS, POSITIONS, positionDefaults } from '../src/shared/positions';
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
