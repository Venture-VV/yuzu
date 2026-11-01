// v0.7.3 ERP 独立工作区第一步（店主 2026-10-30 定，见 docs/ERP.md）：
//   · 模块注册表与开关：店主在 ERP「模块设置」里开关模块，依赖的模块关着时这个模块也用不了；会话里带实际能用的模块；
//   · 模块拦截：关闭模块的接口一律拒绝（ERP_MODULE_DISABLED），没登录的照常 401；
//   · 营业数据（只读）：与经营总览同一口径，另列已确认日结的营业日；默认店主与店总，库存职责不带。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERP_MODULE_KEYS, ERP_MODULES, erpModuleOfApi, erpModuleOfPage } from '../src/shared/erp';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let finance: string;
let stock: string;

const modules = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/auth/me')).body.erpModules as string[];
const switchModules = (cookie: string, body: unknown) => api(ctx.app, cookie, 'PUT', '/api/erp/modules', body);

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'fin', displayName: '对账付款', role: 'backoffice', duties: ['payable'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'stock', displayName: '物资经办', role: 'backoffice', duties: ['stock'], password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  finance = await login(ctx.app, 'fin');
  stock = await login(ctx.app, 'stock');
});
afterAll(async () => ctx.close());

describe('模块注册表', () => {
  it('接口与页面按登记的前缀归到模块（只认整段前缀）；依赖只指向排在前面的模块', () => {
    expect(erpModuleOfApi('/api/inventory/materials?q=1')).toBe('inventory');
    expect(erpModuleOfApi('/api/purchase-baseline')).toBe('purchasing');
    expect(erpModuleOfApi('/api/payables/statement?supplier=1')).toBe('payables');
    expect(erpModuleOfApi('/api/erp/revenue?from=2026-10-01')).toBe('revenue');
    for (const url of ['/api/inventory-x', '/api/erp/modules', '/api/members', '/api/settings']) expect(erpModuleOfApi(url), url).toBeNull();
    expect(erpModuleOfPage('/inventory/new/receipt')).toBe('inventory');
    expect(erpModuleOfPage('/purchasing/3/revise')).toBe('purchasing');
    expect(erpModuleOfPage('/payables/pay')).toBe('payables');
    expect(erpModuleOfPage('/todo')).toBe('approvals');
    for (const path of ['/erp', '/erp/modules', '/frontdesk']) expect(erpModuleOfPage(path), path).toBeNull();
    // 入口页面归到模块自己；按注册顺序算依赖（effectiveErpModules）要求依赖排在前面
    for (const [i, key] of ERP_MODULE_KEYS.entries()) {
      expect(erpModuleOfPage(ERP_MODULES[key].path)).toBe(key);
      for (const r of ERP_MODULES[key].requires) expect(ERP_MODULE_KEYS.indexOf(r), `${key} 依赖 ${r}`).toBeLessThan(i);
    }
  });
});

describe('ERP 模块开关', () => {
  it('升级后默认全部开启；会话带实际能用的模块；能进 ERP 的人都能看模块列表，前台岗位不能', async () => {
    expect(await modules(ctx.owner)).toEqual([...ERP_MODULE_KEYS]);
    const list = await api(ctx.app, stock, 'GET', '/api/erp/modules');
    expect(list.status).toBe(200);
    expect(list.body.modules.map((m: { key: string; enabled: boolean }) => [m.key, m.enabled])).toEqual(ERP_MODULE_KEYS.map((k) => [k, true]));
    expect(list.body.updatedBy).toBeNull();
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/modules')).status).toBe(403);
  });

  it('只有店主能改开关；不认识的模块拒绝；改动记审计', async () => {
    expect((await switchModules(boss, { modules: { revenue: false } })).status).toBe(403);
    expect((await switchModules(ctx.owner, { modules: { crm: true } })).status).toBe(400);
    const r = await switchModules(ctx.owner, { modules: { revenue: false } });
    expect(r.status).toBe(200);
    expect(r.body.modules.find((m: { key: string }) => m.key === 'revenue')).toMatchObject({ switchedOn: false, enabled: false });
    expect(r.body.updatedBy).toBe('测试店主');
    const [audit] = await ctx.sql<{ detail: { key: string; after: Record<string, boolean> } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'settings_updated' AND detail->>'key' = 'erp_modules' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.after).toEqual({ revenue: false });
    expect(await modules(boss)).not.toContain('revenue');
    expect((await switchModules(ctx.owner, { modules: { revenue: true } })).status).toBe(200);
    expect(await modules(boss)).toContain('revenue');
  });

  it('关掉库存：库存、采购、货款、审批待办都用不了（依赖库存），接口拒绝；营业数据不受影响；再开就恢复', async () => {
    expect((await switchModules(ctx.owner, { modules: { inventory: false } })).status).toBe(200);
    try {
      const info = (await api(ctx.app, ctx.owner, 'GET', '/api/erp/modules')).body.modules as { key: string; switchedOn: boolean; enabled: boolean }[];
      expect(info.map((m) => [m.key, m.switchedOn, m.enabled])).toEqual([
        ['inventory', false, false],
        ['purchasing', true, false],
        ['requests', true, false],
        ['deptStock', true, false],
        ['payables', true, false],
        ['approvals', true, false],
        ['expenses', true, false],
        ['revenue', true, true],
      ]);
      expect(await modules(ctx.owner)).toEqual(['revenue']);
      for (const url of ['/api/inventory/materials', '/api/inventory/todo-count', '/api/purchase-orders', '/api/purchase-baseline?materialId=1', '/api/payables/overview', '/api/erp/expenses', '/api/erp/petty/daily', '/api/erp/requests', '/api/erp/images/1', '/api/erp/dept-stock/meta']) {
        const r = await api(ctx.app, ctx.owner, 'GET', url);
        expect(r.status, url).toBe(403);
        expect(r.body.error.code, url).toBe('ERP_MODULE_DISABLED');
      }
      // 写接口同样拦下（还没走到权限与校验）
      const doc = await api(ctx.app, stock, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'receipt', lines: [] });
      expect(doc.body.error.code).toBe('ERP_MODULE_DISABLED');
      // 地址里的模块名做了 URL 编码，路由照样进到原接口：拦截按实际进入的接口认模块（测试会话复测 v0.7.3 的 P1）
      for (const url of ['/api/%69nventory/materials', '/api/%69nventory/todo-count', '/api/%70urchase-orders', '/api/purchase%2Dorders', '/api/%70ayables/overview']) {
        const r = await api(ctx.app, ctx.owner, 'GET', url);
        expect(r.status, url).toBe(403);
        expect(r.body.error.code, url).toBe('ERP_MODULE_DISABLED');
      }
      for (const [cookie, method, url] of [
        [stock, 'POST', '/api/%69nventory/docs'],
        [ctx.owner, 'PUT', '/api/%69nventory/materials/1'],
      ] as const) {
        const r = await api(ctx.app, cookie, method, url, { clientKey: randomUUID(), docType: 'receipt', lines: [] });
        expect(r.body.error.code, `${method} ${url}`).toBe('ERP_MODULE_DISABLED');
      }
      // 没登录的照常 401，不透露模块设置；不属于 ERP 的接口不受影响
      expect((await api(ctx.app, null, 'GET', '/api/inventory/materials')).status).toBe(401);
      expect((await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/board')).status).toBe(200);
    } finally {
      expect((await switchModules(ctx.owner, { modules: { inventory: true } })).status).toBe(200);
    }
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials')).status).toBe(200);
    expect(await modules(ctx.owner)).toEqual([...ERP_MODULE_KEYS]);
  });

  it('关掉采购只拦采购：库存、货款照常', async () => {
    expect((await switchModules(ctx.owner, { modules: { purchasing: false } })).status).toBe(200);
    try {
      expect((await api(ctx.app, ctx.owner, 'GET', '/api/purchase-orders')).body.error.code).toBe('ERP_MODULE_DISABLED');
      expect((await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials')).status).toBe(200);
      expect((await api(ctx.app, ctx.owner, 'GET', '/api/payables/overview')).status).toBe(200);
    } finally {
      expect((await switchModules(ctx.owner, { modules: { purchasing: true } })).status).toBe(200);
    }
  });
});

describe('营业数据（只读）', () => {
  it('店主、店总能看，与经营总览同一口径；前台岗位与库存职责（含对账付款）不能看', async () => {
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
    const q = `?from=${today}&to=${today}`;
    const r = await api(ctx.app, boss, 'GET', `/api/erp/revenue${q}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const exec = (await api(ctx.app, boss, 'GET', `/api/reports/executive${q}`)).body;
    expect(r.body.kpis).toEqual({
      receivable: exec.kpis.receivable,
      discount: exec.kpis.discount,
      net: exec.kpis.net,
      guests: exec.kpis.guests,
      checkouts: exec.kpis.checkouts,
      perGuest: exec.kpis.perGuest,
      rechargePaid: exec.kpis.rechargePaid,
    });
    expect(r.body.trend).toEqual(exec.trend);
    expect(r.body.settlements).toEqual([]);
    for (const cookie of [ctx.clerk, finance, stock]) expect((await api(ctx.app, cookie, 'GET', `/api/erp/revenue${q}`)).status).toBe(403);
    expect((await api(ctx.app, boss, 'GET', `/api/erp/revenue?from=${today}&to=2999-01-01`)).status).toBe(400);
  });

  it('列出已确认日结的营业日；模块关闭时拒绝', async () => {
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
    const [owner] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'owner'`;
    await ctx.sql`
      INSERT INTO daily_settlements (business_date, closed_by, closed_at, snapshot, revision)
      VALUES (${today}, ${owner!.id}, now(), '{}'::jsonb, 1)
      ON CONFLICT DO NOTHING`;
    const r = await api(ctx.app, ctx.owner, 'GET', `/api/erp/revenue?from=${today}&to=${today}`);
    expect(r.body.settlements).toEqual([expect.objectContaining({ date: today, closedByName: '测试店主' })]);
    expect((await switchModules(ctx.owner, { modules: { revenue: false } })).status).toBe(200);
    try {
      expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/revenue?from=${today}&to=${today}`)).body.error.code).toBe('ERP_MODULE_DISABLED');
      expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/%72evenue?from=${today}&to=${today}`)).body.error.code).toBe('ERP_MODULE_DISABLED');
    } finally {
      expect((await switchModules(ctx.owner, { modules: { revenue: true } })).status).toBe(200);
    }
  });
});

describe('按实际进入的接口判断（地址编码不改变结果）', () => {
  it('跨站的修改请求一律拒绝，地址把 /api 编码成 /%61pi 也一样；同站照常登录、读会话', async () => {
    for (const url of ['/api/auth/login', '/%61pi/auth/login']) {
      const r = await ctx.app.inject({ method: 'POST', url, headers: { origin: 'https://evil.example' }, payload: { username: 'owner', password: PASSWORD } });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error.code, url).toBe('BAD_ORIGIN');
      expect(r.cookies.find((c) => c.name === 'yuzu_sid'), url).toBeUndefined();
    }
    const me = await api(ctx.app, ctx.owner, 'GET', '/%61pi/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.staff.username).toBe('owner');
    // 不存在的接口照旧回 404（不回落到前端页面）
    for (const url of ['/api/nope', '/%61pi/nope']) {
      const r = await api(ctx.app, ctx.owner, 'GET', url);
      expect(r.status, url).toBe(404);
      expect(r.body.error.code, url).toBe('NOT_FOUND');
    }
  });
});
