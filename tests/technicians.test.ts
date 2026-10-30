// v0.7.0 S6 技师第一步：技师名册、技师规则、需要技师的项目、挂账时选技师（点钟 / 轮钟、按等级取价）、
// 明细保护、幂等、技师业绩（与部门构成同一口径）、结账单与对账包。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { buildDailyRecon } from '../src/server/ops/recon';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let duty: string;
let today: string;
/** 项目：足疗（三档，需要技师）、刮痧（一档，需要技师，分类「理疗」）、搓澡（不需要技师） */
let foot: number;
let gua: number;
let scrub: number;
let tagNo = 0;

const tech = (techNo: string, extra: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo, name: `技师${techNo}`, gender: 'female', grade: 'standard', ...extra });
const techId = async (techNo: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/technicians')).body.technicians.find((t: { techNo: string }) => t.techNo === techNo).id as number;
const setRules = (rules: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/admin/technicians/rules', rules);
const enter = async () => {
  tagNo += 1;
  const code = `T${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'female' }] });
  expect(r.status).toBe(201);
  return r.body.visits[0].id as number;
};
const post = (visitId: number, lines: Record<string, unknown>[], expectedTotal: number, key = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: key, lines, expectedTotal });
const report = (cookie = ctx.owner) => api(ctx.app, cookie, 'GET', `/api/reports/technicians?from=${today}&to=${today}`);

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'T', from: 1, to: 40, width: 3, zone: 'female' })).status).toBe(200);
  const add = async (body: Record<string, unknown>) => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', body);
    expect(r.status).toBe(200);
    return r.body.items.find((i: { name: string }) => i.name === body.name).id as number;
  };
  foot = await add({ name: '足疗', category: '足疗', prices: { standard: 19800, professional: 23800, premium: 29800 } });
  gua = await add({ name: '刮痧', category: '理疗', price: 12800 });
  scrub = await add({ name: '搓澡', category: '洗浴', price: 6800 });
});
afterAll(async () => ctx.close());

describe('技师名册', () => {
  it('店主、店总可以新建与编辑；店员、值班经理不能；工号唯一且保存后不变；改动记审计', async () => {
    const r = await tech('08', { name: '小李', grade: 'professional', skills: ['足疗', '足疗'] });
    expect(r.status).toBe(200);
    const li = r.body.technicians.find((t: { techNo: string }) => t.techNo === '08');
    expect(li).toMatchObject({ name: '小李', gender: 'female', grade: 'professional', skills: ['足疗'], active: true, lineCount: 0 });
    expect((await api(ctx.app, boss, 'POST', '/api/admin/technicians', { techNo: '12', name: '小王', gender: 'male', grade: 'premium' })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/technicians', { techNo: '13', name: 'x', gender: 'male', grade: 'standard' })).status).toBe(403);
    expect((await api(ctx.app, duty, 'POST', '/api/admin/technicians', { techNo: '13', name: 'x', gender: 'male', grade: 'standard' })).status).toBe(403);

    const dup = await tech('08', { name: '另一个' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TECH_NO_TAKEN');
    expect((await tech('0-8')).status).toBe(400);
    expect((await tech('1234567')).status).toBe(400);

    // 编辑：工号不在可改字段里，带了也不改
    const id = li.id as number;
    const u = await api(ctx.app, boss, 'PUT', `/api/admin/technicians/${id}`, { techNo: '99', name: '李娜', gender: 'female', grade: 'professional', skills: ['足疗'], note: '擅长足疗' });
    expect(u.status).toBe(200);
    expect(u.body.technicians.find((t: { id: number }) => t.id === id)).toMatchObject({ techNo: '08', name: '李娜', note: '擅长足疗' });
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/admin/technicians/${id}`, { name: 'x', gender: 'female', grade: 'standard' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/999999', { name: 'x', gender: 'female', grade: 'standard' })).status).toBe(404);

    const audit = await ctx.sql<{ detail: { summary: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'technician_saved' ORDER BY id`;
    expect(audit.map((a) => a.detail.summary)).toEqual(['新建技师 08 号 小李（专业技师）', '新建技师 12 号 小王（优选技师）', '修改技师 08 号 李娜（专业技师）']);
    // 后台「技师」分区：有任一相关权限可看（值班经理没有）
    expect((await api(ctx.app, duty, 'GET', '/api/admin/technicians')).status).toBe(403);
    // 分类按价目表顺序
    expect((await api(ctx.app, boss, 'GET', '/api/admin/technicians')).body.categories).toEqual(['足疗', '理疗', '洗浴']);
  });

  it('技师规则：默认关闭；只有店主能改，只改提交的字段；规则总表与后台首页列出', async () => {
    const fd = await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/technicians');
    expect(fd.status).toBe(200);
    expect(fd.body.rules).toEqual({ enabled: false, requireTechnician: true, tierByGrade: true, defaultCallType: 'rotation' });
    expect(fd.body.technicians.map((t: { techNo: string; todayClocks: number }) => [t.techNo, t.todayClocks])).toEqual([
      ['08', 0],
      ['12', 0],
    ]);
    expect((await setRules({ enabled: true }, boss)).status).toBe(403);
    expect((await setRules({ defaultCallType: 'sometimes' })).status).toBe(400);
    const r = await setRules({ enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.rules).toEqual({ enabled: true, requireTechnician: true, tierByGrade: true, defaultCallType: 'rotation' });
    expect(r.body.rulesUpdatedBy).toBe('测试店主');

    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; group: string; isDefault: boolean; section: string }[];
    const techRules = rules.filter((x) => x.group === 'technicians');
    expect(techRules.filter((x) => x.key.startsWith('technician_rules.')).map((x) => x.key)).toEqual([
      'technician_rules.enabled',
      'technician_rules.requireTechnician',
      'technician_rules.tierByGrade',
      'technician_rules.defaultCallType',
    ]);
    // v0.7.1 起同一组还有钟房与轮钟规则、技师提成
    expect(techRules.some((x) => x.key === 'clockroom_rules.afterRotation')).toBe(true);
    expect(techRules.some((x) => x.key === 'commission_rules')).toBe(true);
    expect(techRules.find((x) => x.key === 'technician_rules.enabled')).toMatchObject({ isDefault: false, section: 'technicians' });
    const home = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/overview')).body;
    expect(home.counts.technicians).toEqual({ active: 2, enabled: true });
    expect(home.recentChanges.some((c: { summary: string }) => c.summary === '修改了技师规则')).toBe(true);
  });

  it('需要技师的项目：能管理价目的岗位按项目勾选；编辑项目时不带这一项保持原值', async () => {
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/technicians/items', { items: [{ id: foot, required: true }] })).status).toBe(403);
    const r = await api(ctx.app, boss, 'PUT', '/api/admin/technicians/items', { items: [{ id: foot, required: true }, { id: gua, required: true }] });
    expect(r.status).toBe(200);
    const items = (await api(ctx.app, ctx.clerk, 'GET', '/api/catalog')).body.items as { id: number; technicianRequired: boolean }[];
    expect(items.filter((i) => i.technicianRequired).map((i) => i.id).sort()).toEqual([foot, gua].sort());
    // 旧页面编辑项目（不带 technicianRequired）不会清掉
    const edit = await api(ctx.app, ctx.owner, 'PUT', `/api/items/${gua}`, { name: '刮痧', category: '理疗', price: 12800 });
    expect(edit.body.items.find((i: { id: number }) => i.id === gua).technicianRequired).toBe(true);
    const audit = await ctx.sql<{ detail: { required: string[] } }[]>`SELECT detail FROM audit_logs WHERE action = 'items_technician_updated'`;
    expect(audit[0]!.detail.required.sort()).toEqual(['刮痧', '足疗'].sort());
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/items', { items: [{ id: 999999, required: true }] })).status).toBe(404);
  });
});

describe('挂账选技师', () => {
  it('需要技师的项目必须选技师；记下技师与点钟 / 轮钟，分在「技师服务」；价格按技师等级', async () => {
    const v = await enter();
    const li = await techId('08');
    const missing = await post(v, [{ itemId: foot, quantity: 1 }], 19800);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('TECHNICIAN_REQUIRED');
    // 只带技师不带点钟 / 轮钟
    expect((await post(v, [{ itemId: foot, quantity: 1, technicianId: li }], 23800)).status).toBe(400);
    // 专业技师做足疗：按专业档 238
    const ok = await post(v, [{ itemId: foot, quantity: 1, technicianId: li, callType: 'designated' }, { itemId: scrub, quantity: 1 }], 30600);
    expect(ok.status).toBe(200);
    const footLine = ok.body.lines.find((l: { itemId: number }) => l.itemId === foot);
    expect(footLine).toMatchObject({ name: '足疗（专业）', tier: 'professional', unitPrice: 23800, source: 'therapist', technician: { id: li, techNo: '08', name: '李娜', callType: 'designated' } });
    expect(ok.body.lines.find((l: { itemId: number }) => l.itemId === scrub)).toMatchObject({ source: 'bath', technician: null });
    expect(ok.body.history.some((h: { text: string }) => h.text.includes('08 号 李娜 · 点钟'))).toBe(true);
    // 前台看到今日已上的钟数
    const fd = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/technicians')).body;
    expect(fd.technicians.find((t: { id: number }) => t.id === li).todayClocks).toBe(1);
  });

  it('选了技师时价格档不对、技师不能做、停用、项目不需要技师：都拒绝并写明原因', async () => {
    const v = await enter();
    const li = await techId('08');
    const wang = await techId('12');
    // 页面按标准档提交，但李娜是专业技师
    const tier = await post(v, [{ itemId: foot, quantity: 1, tier: 'standard', technicianId: li, callType: 'rotation' }], 19800);
    expect(tier.status).toBe(409);
    expect(tier.body.error.code).toBe('TECHNICIAN_TIER');
    expect(tier.body.error.message).toContain('专业档');
    // 合计按旧价格确认的：PRICE_CHANGED
    expect((await post(v, [{ itemId: foot, quantity: 1, technicianId: li, callType: 'rotation' }], 19800)).body.error.code).toBe('PRICE_CHANGED');
    // 李娜只做足疗
    const skill = await post(v, [{ itemId: gua, quantity: 1, technicianId: li, callType: 'rotation' }], 12800);
    expect(skill.status).toBe(422);
    expect(skill.body.error).toMatchObject({ code: 'TECHNICIAN_UNAVAILABLE', message: '08 号 李娜：不做「理疗」，请换一位技师' });
    // 刮痧只有一档价格：优选技师也按这一档
    const one = await post(v, [{ itemId: gua, quantity: 2, technicianId: wang, callType: 'rotation' }], 25600);
    expect(one.status).toBe(200);
    expect(one.body.lines.find((l: { itemId: number }) => l.itemId === gua)).toMatchObject({ name: '刮痧', tier: 'standard', quantity: 2, amount: 25600 });
    // 不需要技师的项目不能带技师
    expect((await post(v, [{ itemId: scrub, quantity: 1, technicianId: wang, callType: 'rotation' }], 6800)).body.error.code).toBe('TECHNICIAN_NOT_NEEDED');
    // 没有这一档价格：项目只有标准、专业两档时，优选技师做不了
    const two = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '推拿', category: '足疗', prices: { standard: 15800, professional: 18800 }, technicianRequired: true });
    const tuina = two.body.items.find((i: { name: string }) => i.name === '推拿').id;
    const noTier = await post(v, [{ itemId: tuina, quantity: 1, technicianId: wang, callType: 'rotation' }], 18800);
    expect(noTier.body.error).toMatchObject({ code: 'TECHNICIAN_UNAVAILABLE', message: '12 号 小王：这个项目没有优选档价格，请换一位技师' });
    // 停用的技师不能再选
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${wang}`, { name: '小王', gender: 'male', grade: 'premium', active: false });
    expect((await post(v, [{ itemId: gua, quantity: 1, technicianId: wang, callType: 'rotation' }], 12800)).body.error.code).toBe('TECHNICIAN_UNAVAILABLE');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/technicians')).body.technicians.map((t: { techNo: string }) => t.techNo)).toEqual(['08']);
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${wang}`, { name: '小王', gender: 'male', grade: 'premium', active: true });
    expect((await post(v, [{ itemId: gua, quantity: 1, technicianId: 999999, callType: 'rotation' }], 12800)).status).toBe(404);
  });

  it('价格不跟等级时按所选档；不要求必须选技师时可以暂不指定；关闭功能后与升级前一样', async () => {
    const li = await techId('08');
    await setRules({ tierByGrade: false, requireTechnician: false });
    const v = await enter();
    const r = await post(v, [{ itemId: foot, quantity: 1, tier: 'premium', technicianId: li, callType: 'rotation' }, { itemId: foot, quantity: 1, tier: 'standard' }], 49600);
    expect(r.status).toBe(200);
    const lines = r.body.lines as { tier: string; amount: number; source: string; technician: unknown }[];
    expect(lines.map((l) => [l.tier, l.amount, l.source, !!l.technician])).toEqual([
      ['premium', 29800, 'therapist', true],
      ['standard', 19800, 'therapist', false],
    ]);
    await setRules({ enabled: false, tierByGrade: true, requireTechnician: true });
    const off = await post(v, [{ itemId: foot, quantity: 1 }], 19800);
    expect(off.status).toBe(200);
    expect(off.body.lines.at(-1)).toMatchObject({ source: 'bath', technician: null, tier: 'standard' });
    expect((await post(v, [{ itemId: foot, quantity: 1, technicianId: li, callType: 'rotation' }], 23800)).body.error.code).toBe('TECHNICIAN_DISABLED');
    await setRules({ enabled: true });
  });

  it('同一操作编号重提返回同一结果；换了技师拒绝；不带技师的旧请求与带 null 的请求是同一笔', async () => {
    const v = await enter();
    const li = await techId('08');
    const key = randomUUID();
    const body = [{ itemId: foot, quantity: 1, technicianId: li, callType: 'rotation' }];
    const a = await post(v, body, 23800, key);
    const b = await post(v, body, 23800, key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.lines.length).toBe(a.body.lines.length);
    const c = await post(v, [{ ...body[0], callType: 'designated' }], 23800, key);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 升级前的页面不带这两项；新页面不选技师时带 null：同一编号视为同一笔
    const key2 = randomUUID();
    expect((await post(v, [{ itemId: scrub, quantity: 1 }], 6800, key2)).status).toBe(200);
    const again = await post(v, [{ itemId: scrub, quantity: 1, technicianId: null, callType: null }], 6800, key2);
    expect(again.status).toBe(200);
    expect(again.body.lines.filter((l: { itemId: number }) => l.itemId === scrub).length).toBe(1);
  });

  it('明细只能作废：技师、点钟 / 轮钟、价格档等都不能改；作废后照样显示是谁做的', async () => {
    const v = await enter();
    const li = await techId('08');
    const wang = await techId('12');
    const r = await post(v, [{ itemId: foot, quantity: 1, technicianId: li, callType: 'designated' }], 23800);
    const line = r.body.lines[0] as { id: number };
    await expect(ctx.sql`UPDATE bill_lines SET technician_id = ${wang} WHERE id = ${line.id}`).rejects.toThrow('账单明细只能作废，不能修改');
    await expect(ctx.sql`UPDATE bill_lines SET call_type = 'rotation' WHERE id = ${line.id}`).rejects.toThrow('账单明细只能作废，不能修改');
    await expect(ctx.sql`UPDATE bill_lines SET tier = 'premium' WHERE id = ${line.id}`).rejects.toThrow('账单明细只能作废，不能修改');
    // 作废时一起改技师也不行
    await expect(ctx.sql`UPDATE bill_lines SET status = 'voided', technician_id = NULL, call_type = NULL WHERE id = ${line.id}`).rejects.toThrow();
    // 技师与上钟方式同空同非空
    await expect(ctx.sql`INSERT INTO bill_lines (bill_id, source, name, unit_price, quantity, amount, post_key, business_date, posted_by, technician_id)
                         SELECT bill_id, 'therapist', 'x', 1, 1, 1, ${randomUUID()}, ${today}, ${ctx.ownerId}, ${li} FROM bill_lines WHERE id = ${line.id}`).rejects.toThrow('bill_lines_technician_check');
    const voided = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '挂错技师' });
    expect(voided.status).toBe(200);
    expect(voided.body.lines.find((l: { id: number }) => l.id === line.id)).toMatchObject({ status: 'voided', technician: { techNo: '08', callType: 'designated' } });
  });
});

describe('技师业绩', () => {
  it('按结账计：结账那一刻的技师明细计入，反结账冲回；在职技师没有钟也列出；店员看不到', async () => {
    const base = (await report()).body;
    const li = await techId('08');
    const wang = await techId('12');
    const v = await enter();
    await post(v, [{ itemId: foot, quantity: 1, technicianId: li, callType: 'designated' }, { itemId: gua, quantity: 2, technicianId: wang, callType: 'rotation' }], 23800 + 25600);
    // 还没结账：不算
    expect((await report()).body.totals).toEqual(base.totals);
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body;
    const pay = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(pay.status).toBe(200);
    const after = (await report()).body;
    const row = (b: typeof after, no: string) => b.rows.find((r: { techNo: string }) => r.techNo === no);
    const before08 = row(base, '08') ?? { clocks: 0, designated: 0, rotation: 0, amount: 0 };
    const before12 = row(base, '12') ?? { clocks: 0, designated: 0, rotation: 0, amount: 0 };
    expect(row(after, '08')).toMatchObject({ clocks: before08.clocks + 1, designated: before08.designated + 1, amount: before08.amount + 23800 });
    expect(row(after, '12')).toMatchObject({ clocks: before12.clocks + 2, rotation: before12.rotation + 2, amount: before12.amount + 25600 });
    expect(after.totals.clocks).toBe(base.totals.clocks + 3);
    // 业绩合计 = 各行之和；未指定技师单列
    expect(after.totals.amount).toBe(after.rows.reduce((s: number, r: { amount: number }) => s + r.amount, 0));

    // 结账单（打印）带技师
    const printed = (await api(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${pay.body.id}`)).body;
    const lines = printed.bills[0].lines as { name: string; technician: string | null }[];
    expect(lines.find((l) => l.name === '足疗（专业）')!.technician).toBe('08 号 李娜 · 点钟');
    expect(lines.find((l) => l.name === '刮痧')!.technician).toBe('12 号 小王 · 轮钟');
    expect(lines.find((l) => l.name.startsWith('门票'))!.technician).toBeNull();

    // 反结账：冲回
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${pay.body.id}/void`, { reason: '收款方式记错' })).status).toBe(200);
    expect((await report()).body.totals).toEqual(base.totals);

    // 停用的技师没有业绩时不列，在职的都列
    const extra = await tech('20', { name: '新人' });
    expect(extra.status).toBe(200);
    expect((await report()).body.rows.find((r: { techNo: string }) => r.techNo === '20')).toMatchObject({ clocks: 0, amount: 0, active: true });

    expect((await report(ctx.clerk)).status).toBe(403);
    expect((await report(duty)).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/reports/technicians?from=2026-13-01&to=2026-13-02')).status).toBe(400);
  });

  it('暂不指定技师的技师项目单列为「未指定」；对账包有技师业绩表', async () => {
    await setRules({ requireTechnician: false });
    const v = await enter();
    await post(v, [{ itemId: gua, quantity: 1 }], 12800);
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body;
    const pay = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'wechat', amount: preview.totalAmount }],
    });
    expect(pay.status).toBe(200);
    const r = (await report()).body;
    expect(r.unassigned).toEqual({ clocks: 1, amount: 12800 });
    await setRules({ requireTechnician: true });

    const recon = await buildDailyRecon(ctx.sql, ctx.config, today);
    const csv = recon.files.find((f) => f.name === '06-技师业绩.csv')!.content;
    expect(csv).toContain('工号,技师,等级,状态,钟数,点钟,轮钟,金额（元）');
    expect(csv).toContain('未指定技师的技师项目,,,,1,,,128.00');
    expect(recon.files.find((f) => f.name === '00-说明.txt')!.content).toContain('未指定技师 1 个钟');
    // 对账包的异常清单里，作废的技师明细写上技师
    expect(recon.files.find((f) => f.name === '04-异常清单.csv')!.content).toContain('08 号 李娜 · 点钟');
  });
});
