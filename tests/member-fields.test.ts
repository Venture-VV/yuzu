// Batch 2.4b：会员自定义字段（店主 2026-10-27 #12）。
//   · 店主在经营规则里配置字段（文字、数字、日期、单选，可设必填）；字段编号由服务端分配；
//   · 保存后不能删除、不能改类型，只能停用；停用字段的值保留、不再要求填写；
//   · 新建与编辑会员按字段定义核对；编辑时不带自定义字段则保持原值。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCustomValues, normalizeFieldValue, type MemberFieldDef } from '../src/shared/member-fields';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const saveFields = (fields: unknown[], cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/settings', { memberFields: fields });
const currentFields = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.memberFields as MemberFieldDef[];
const createMember = (body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'POST', '/api/members', body);

describe('字段定义', () => {
  it('店主新增四种字段，编号由服务端按顺序分配；前台从会话里拿到字段定义；店员不能改', async () => {
    const r = await saveFields([
      { label: '车牌号', type: 'text' },
      { label: '了解渠道', type: 'select', options: ['朋友推荐', '大众点评', '朋友推荐'], required: true },
      { label: '身高（cm）', type: 'number' },
      { label: '入会日期', type: 'date' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.memberFields).toEqual([
      { key: 'f1', label: '车牌号', type: 'text', options: [], required: false, active: true },
      { key: 'f2', label: '了解渠道', type: 'select', options: ['朋友推荐', '大众点评'], required: true, active: true },
      { key: 'f3', label: '身高（cm）', type: 'number', options: [], required: false, active: true },
      { key: 'f4', label: '入会日期', type: 'date', options: [], required: false, active: true },
    ]);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.rules.memberFields).toHaveLength(4);
    expect((await saveFields([], ctx.clerk)).status).toBe(403);
  });

  it('名称不能重复、不能与固定字段重名；单选至少一个可选值；最多 20 个字段', async () => {
    const fields = await currentFields();
    expect((await saveFields([...fields, { label: '车牌号', type: 'text' }])).body.error.message).toContain('重复');
    expect((await saveFields([...fields, { label: '手机号', type: 'text' }])).body.error.message).toContain('固定字段');
    expect((await saveFields([...fields, { label: '偏好', type: 'select', options: [] }])).body.error.message).toContain('至少要有一个可选值');
    const many = Array.from({ length: 17 }, (_, i) => ({ label: `字段${i}`, type: 'text' }));
    expect((await saveFields([...fields, ...many])).status).toBe(400);
    expect(await currentFields()).toEqual(fields);
  });

  it('保存后不能删除、不能改类型；可以改名称、可选值、必填与停用', async () => {
    const fields = await currentFields();
    const del = await saveFields(fields.slice(1));
    expect(del.status).toBe(400);
    expect(del.body.error.message).toContain('「车牌号」不能删除');
    const retype = await saveFields(fields.map((f) => (f.key === 'f3' ? { ...f, type: 'text' } : f)));
    expect(retype.body.error.message).toContain('不能改类型');
    const renamed = await saveFields(fields.map((f) => (f.key === 'f1' ? { ...f, label: '车牌' } : f)));
    expect(renamed.status).toBe(200);
    expect(renamed.body.memberFields[0]).toMatchObject({ key: 'f1', label: '车牌' });
  });

  it('两人同时各加一个字段：后保存的一方被拒绝（不会互相覆盖），编号不重复', async () => {
    const fields = await currentFields();
    const [a, b] = await Promise.all([
      saveFields([...fields, { label: '同时A', type: 'text' }]),
      saveFields([...fields, { label: '同时B', type: 'text' }]),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const after = await currentFields();
    expect(after).toHaveLength(fields.length + 1);
    expect(after.at(-1)!.key).toBe('f5');
    // 恢复：停用这个测试字段
    expect((await saveFields(after.map((f) => (f.key === 'f5' ? { ...f, active: false } : f)))).status).toBe(200);
  });
});

describe('会员档案按字段核对', () => {
  it('必填字段没填、选项不在可选值内、数字或日期格式不对时拒绝，并指出字段', async () => {
    const base = { name: '字段会员', phone: '19900006001' };
    const missing = await createMember(base);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ message: '请填写「了解渠道」', details: { field: 'customFields.f2' } });
    expect((await createMember({ ...base, customFields: { f2: '抖音' } })).body.error.message).toContain('请从可选值中选择');
    expect((await createMember({ ...base, customFields: { f2: '大众点评', f3: '1.234' } })).body.error.message).toContain('最多两位小数');
    expect((await createMember({ ...base, customFields: { f2: '大众点评', f4: '2026-02-30' } })).body.error.message).toContain('日期格式');
    expect((await createMember({ ...base, customFields: { f2: '大众点评', f9: 'x' } })).body.error.message).toContain('未知的会员字段');
  });

  it('建档保存规范化后的值（数字存数字、去掉空值）；编辑不带自定义字段时保持原值，带上时按新值', async () => {
    const created = await createMember({
      name: '字段会员',
      phone: '19900006002',
      customFields: { f1: ' 沪A12345 ', f2: '大众点评', f3: '172.5', f4: '' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.customFields).toEqual({ f1: '沪A12345', f2: '大众点评', f3: 172.5 });
    const id = created.body.id as number;

    const plain = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${id}`, { name: '字段会员改名', phone: '19900006002' });
    expect(plain.status).toBe(200);
    expect(plain.body.customFields).toEqual({ f1: '沪A12345', f2: '大众点评', f3: 172.5 });

    const edited = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${id}`, {
      name: '字段会员改名',
      phone: '19900006002',
      customFields: { f1: '', f2: '朋友推荐', f3: 180, f4: '2026-10-28' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.customFields).toEqual({ f2: '朋友推荐', f3: 180, f4: '2026-10-28' });
    const [audit] = await ctx.sql<{ detail: { before: Record<string, unknown>; after: Record<string, unknown> } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'member_updated' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.before.customFields).toEqual({ f1: '沪A12345', f2: '大众点评', f3: 172.5 });
    expect(audit!.detail.after.customFields).toEqual({ f2: '朋友推荐', f3: 180, f4: '2026-10-28' });
  });

  it('停用字段：不再要求填写，已填的值保留；不能再修改停用字段的值；重新启用后值还在', async () => {
    const created = await createMember({ name: '停用字段', phone: '19900006003', customFields: { f1: '粤B88888', f2: '朋友推荐' } });
    const id = created.body.id as number;
    const fields = await currentFields();
    expect((await saveFields(fields.map((f) => (f.key === 'f1' || f.key === 'f2' ? { ...f, active: false } : f)))).status).toBe(200);
    try {
      // 必填的 f2 已停用：新建会员不再要求
      expect((await createMember({ name: '停用后建档', phone: '19900006004' })).status).toBe(201);
      // 页面不再提交停用字段：值保留
      const kept = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${id}`, { name: '停用字段', phone: '19900006003', customFields: { f3: 165 } });
      expect(kept.body.customFields).toEqual({ f1: '粤B88888', f2: '朋友推荐', f3: 165 });
      const change = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${id}`, { name: '停用字段', phone: '19900006003', customFields: { f1: '粤B00000' } });
      expect(change.body.error.message).toContain('已停用');
    } finally {
      expect((await saveFields(fields)).status).toBe(200);
    }
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${id}`)).body.customFields).toMatchObject({ f1: '粤B88888', f2: '朋友推荐' });
  });

  it('一人只能登记一个手机号：同一手机号不能建第二个档案', async () => {
    const r = await createMember({ name: '重复手机', phone: '19900006002', customFields: { f2: '路过'.length ? '朋友推荐' : '' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PHONE_EXISTS');
  });

  it('值的规范化（共用于页面与服务端）', () => {
    const num: MemberFieldDef = { key: 'f1', label: '数', type: 'number', options: [], required: false, active: true };
    expect(normalizeFieldValue(num, '1.1')).toEqual({ value: 1.1 });
    expect(normalizeFieldValue(num, 1.25)).toEqual({ value: 1.25 });
    expect(normalizeFieldValue(num, 'abc').error).toBeTruthy();
    expect(normalizeFieldValue(num, '  ')).toEqual({});
    const text: MemberFieldDef = { ...num, type: 'text', label: '文' };
    expect(normalizeFieldValue(text, 'x'.repeat(101)).error).toContain('100');
    const defs: MemberFieldDef[] = [num, { ...text, key: 'f2', required: true }];
    expect(checkCustomValues(defs, { f1: '2' }, {})).toMatchObject({ ok: false, field: 'f2' });
    expect(checkCustomValues(defs, { f1: '2' }, {}, { enforceRequired: false })).toEqual({ ok: true, values: { f1: 2 } });
  });
});
