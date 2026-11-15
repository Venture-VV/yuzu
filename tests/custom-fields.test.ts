// 8.0.21 数据字典与自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J；迁移 141）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DICTIONARIES, normalizeCustomValue } from '../src/shared/custom-fields';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let buyer: string;
let supplierId: number;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'cf-buyer', displayName: '采购小周', role: 'backoffice', duties: ['purchase'] as never, password: PASSWORD, mustChangePassword: false });
  buyer = await login(ctx.app, 'cf-buyer');
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'CF01', name: '鲜果供应' });
  supplierId = s.body.find((x: { code: string }) => x.code === 'CF01').id;
}, 60_000);
afterAll(async () => ctx.close());

const createDef = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', '/api/custom-fields/defs', body);

describe('数据字典', () => {
  it('没存过用默认值；只改提交的那几份；原因不能空、不能重复、有条数上限；会话里带着', async () => {
    const before = await api(ctx.app, ctx.owner, 'GET', '/api/settings');
    expect(before.body.dictionaries).toEqual(DEFAULT_DICTIONARIES);
    const put = await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { dictionaries: { refundReasons: ['菜品质量', '上错菜'] } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.dictionaries;
    expect(after.refundReasons).toEqual(['菜品质量', '上错菜']);
    expect(after.voidReasons).toEqual(DEFAULT_DICTIONARIES.voidReasons);
    // 再改另一份，前一份不被覆盖
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { dictionaries: { damageReasons: ['过期'] } });
    const again = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.dictionaries;
    expect(again.refundReasons).toEqual(['菜品质量', '上错菜']);
    expect(again.damageReasons).toEqual(['过期']);
    for (const bad of [{ refundReasons: [''] }, { refundReasons: ['重复', '重复'] }, { refundReasons: Array.from({ length: 31 }, (_, i) => `原因${i}`) }, { nope: ['x'] }]) {
      expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { dictionaries: bad })).status).toBe(400);
    }
    // 店员改不了，但登录会话里能读到（前台的快捷原因用）
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/settings', { dictionaries: { refundReasons: ['x'] } })).status).toBe(403);
    const me = await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me');
    expect(me.body.rules.dictionaries.refundReasons).toEqual(['菜品质量', '上错菜']);
  });
});

describe('自定义字段', () => {
  it('值的规范化：数字、日期、选项、文字', () => {
    const num = { type: 'number' as const, options: [], label: '面积' };
    expect(normalizeCustomValue(num, ' 12.50 ')).toBe('12.5');
    expect(normalizeCustomValue(num, '1.234')).toMatchObject({ error: expect.any(String) });
    const date = { type: 'date' as const, options: [], label: '到期' };
    expect(normalizeCustomValue(date, '2026-02-30')).toMatchObject({ error: expect.any(String) });
    expect(normalizeCustomValue(date, '2026-02-28')).toBe('2026-02-28');
    const sel = { type: 'select' as const, options: ['甲', '乙'], label: '等级' };
    expect(normalizeCustomValue(sel, '丙')).toMatchObject({ error: expect.any(String) });
    expect(normalizeCustomValue(sel, '')).toBeNull();
  });

  it('定义：只有修改经营规则的能建；编号按先后取；启用的不重名、每类最多 10 个；选项类要有选项；类别与类型建了不改', async () => {
    expect((await createDef({ entity: 'member', label: '车牌', type: 'text' }, ctx.clerk)).status).toBe(403);
    const plate = await createDef({ entity: 'member', label: '车牌', type: 'text', inList: true });
    expect(plate.status, JSON.stringify(plate.body)).toBe(201);
    expect(plate.body).toMatchObject({ key: 'f1', entity: 'member', type: 'text', inList: true, active: true, version: 1 });
    expect((await createDef({ entity: 'member', label: '车牌', type: 'text' })).body.error.code).toBe('FIELD_EXISTS');
    // 不同类别可以重名
    expect((await createDef({ entity: 'supplier', label: '车牌', type: 'text' })).status).toBe(201);
    expect((await createDef({ entity: 'member', label: '偏好', type: 'select' })).status).toBe(400);
    const pref = await createDef({ entity: 'member', label: '偏好', type: 'select', options: ['安静', '热闹'] });
    expect(pref.body.key).toBe('f2');
    for (let i = 3; i <= 10; i += 1) expect((await createDef({ entity: 'member', label: `备用${i}`, type: 'text' })).status).toBe(201);
    const eleventh = await createDef({ entity: 'member', label: '第十一个', type: 'text' });
    expect(eleventh.body.error.code).toBe('TOO_MANY_FIELDS');
    // 停用一个就能再建；停用的名称可以被新的用
    const defs = (await api(ctx.app, ctx.owner, 'GET', '/api/custom-fields/defs?entity=member')).body;
    const spare = defs.find((d: { label: string }) => d.label === '备用10');
    const off = await api(ctx.app, ctx.owner, 'PUT', `/api/custom-fields/defs/${spare.id}`, { expectedVersion: 1, active: false });
    expect(off.body).toMatchObject({ active: false, version: 2 });
    const reused = await createDef({ entity: 'member', label: '备用10', type: 'number' });
    expect(reused.body).toMatchObject({ key: 'f11', type: 'number' });
    // 满了不能再启用停用的
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/custom-fields/defs/${spare.id}`, { expectedVersion: 2, active: true })).body.error.code).toBe('TOO_MANY_FIELDS');
    // 版本号对不上拒绝
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/custom-fields/defs/${plate.body.id}`, { expectedVersion: 9, label: '车牌号' })).body.error.code).toBe('FIELD_CHANGED');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/custom-fields/defs/${plate.body.id}`, { expectedVersion: 1, label: '车牌号' })).body.label).toBe('车牌号');
    // 数据库兜底：类别、类型不能改，不能删
    await expect(ctx.sql`UPDATE custom_field_defs SET type = 'number' WHERE id = ${plate.body.id}`).rejects.toThrow(/不能改/);
    await expect(ctx.sql`DELETE FROM custom_field_defs WHERE id = ${plate.body.id}`).rejects.toThrow(/不能删除/);
    // 店员读得到会员类启用的（不含停用的），读不到供应商类
    const clerkDefs = await api(ctx.app, ctx.clerk, 'GET', '/api/custom-fields/defs?entity=member');
    expect(clerkDefs.body.every((d: { active: boolean }) => d.active)).toBe(true);
    expect(clerkDefs.body).toHaveLength(10);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/custom-fields/defs?entity=supplier')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/custom-fields/defs')).status).toBe(403);
  });

  it('值：按类别的维护权限保存；带摘要、对不上拒绝；清空即删；没改的老选项不报错；不改业务行的版本号', async () => {
    const m = await createMember(ctx, '自定义会员');
    const [before] = await ctx.sql<{ updatedAt: Date }[]>`SELECT updated_at FROM members WHERE id = ${m.id}`;
    const sheet = (await api(ctx.app, ctx.clerk, 'GET', `/api/custom-fields/member/${m.id}`)).body;
    expect(sheet.values).toEqual({});
    const save = await api(ctx.app, ctx.clerk, 'PUT', `/api/custom-fields/member/${m.id}`, { expectedHash: sheet.hash, values: { f1: '粤A12345', f2: '安静' } });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.values).toEqual({ f1: '粤A12345', f2: '安静' });
    // 旧摘要再存被拒
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/custom-fields/member/${m.id}`, { expectedHash: sheet.hash, values: { f1: 'x' } })).body.error.code).toBe('FIELDS_CHANGED');
    // 不合格的值、停用的字段
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/custom-fields/member/${m.id}`, { expectedHash: save.body.hash, values: { f2: '吵' } })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/custom-fields/member/${m.id}`, { expectedHash: save.body.hash, values: { f10: 'x' } })).status).toBe(400);
    // 选项删了以后，老值原样留着；别的格照常保存
    const pref = (await api(ctx.app, ctx.owner, 'GET', '/api/custom-fields/defs?entity=member')).body.find((d: { key: string }) => d.key === 'f2');
    await api(ctx.app, ctx.owner, 'PUT', `/api/custom-fields/defs/${pref.id}`, { expectedVersion: pref.version, options: ['热闹'] });
    const kept = await api(ctx.app, ctx.clerk, 'PUT', `/api/custom-fields/member/${m.id}`, { expectedHash: save.body.hash, values: { f1: '粤B00001', f2: '安静' } });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.values).toEqual({ f1: '粤B00001', f2: '安静' });
    // 清空
    const cleared = await api(ctx.app, ctx.clerk, 'PUT', `/api/custom-fields/member/${m.id}`, { expectedHash: kept.body.hash, values: { f2: '' } });
    expect(cleared.body.values).toEqual({ f1: '粤B00001' });
    const [after] = await ctx.sql<{ updatedAt: Date }[]>`SELECT updated_at FROM members WHERE id = ${m.id}`;
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    // 审计
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'custom_field_value' AND target_type = 'member' AND target_id = ${String(m.id)}`;
    expect(audit!.n).toBe(3);
    // 不存在的对象
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/custom-fields/member/999999')).status).toBe(404);
  });

  it('供应商：采购能存，店员看不了；列表上显示的列；按字段查与导出只给能维护字段又能看那一类的', async () => {
    const def = (await api(ctx.app, ctx.owner, 'GET', '/api/custom-fields/defs?entity=supplier')).body[0];
    await api(ctx.app, ctx.owner, 'PUT', `/api/custom-fields/defs/${def.id}`, { expectedVersion: def.version, inList: true });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/custom-fields/supplier/${supplierId}`)).status).toBe(403);
    const sheet = (await api(ctx.app, buyer, 'GET', `/api/custom-fields/supplier/${supplierId}`)).body;
    const saved = await api(ctx.app, buyer, 'PUT', `/api/custom-fields/supplier/${supplierId}`, { expectedHash: sheet.hash, values: { f1: '沪C88888' } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const list = await api(ctx.app, buyer, 'GET', `/api/custom-fields/supplier/values?ids=${supplierId},999`);
    expect(list.body.defs.map((d: { key: string }) => d.key)).toEqual(['f1']);
    expect(list.body.values).toEqual({ [supplierId]: { f1: '沪C88888' } });
    // 按字段查：文字类按包含
    const hit = await api(ctx.app, ctx.owner, 'GET', `/api/custom-fields/supplier/search?fieldId=${def.id}&q=C88`);
    expect(hit.body.rows).toEqual([expect.objectContaining({ entityId: supplierId, code: 'CF01', name: '鲜果供应', value: '沪C88888', inactive: false })]);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/custom-fields/supplier/search?fieldId=${def.id}&q=%25`)).body.rows).toEqual([]);
    expect((await api(ctx.app, buyer, 'GET', `/api/custom-fields/supplier/search?fieldId=${def.id}`)).status).toBe(403);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/custom-fields/supplier/search.csv?fieldId=${def.id}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('沪C88888');
    // 字段不是这一类的
    const memberDef = (await api(ctx.app, ctx.owner, 'GET', '/api/custom-fields/defs?entity=member')).body[0];
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/custom-fields/supplier/search?fieldId=${memberDef.id}`)).status).toBe(400);
  });
});
