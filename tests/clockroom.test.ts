// v0.7.1 S6 技师第二步：钟房（上牌与轮钟队列、派钟、上钟 / 下钟、加钟、退钟与取消、钟房日志）与技师提成（规则版本、按结账时刻）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let duty: string;
let foot: number; // 足疗：三档价格、90 分钟
let gua: number; // 刮痧：一档 128、没写时长
let tagNo = 0;
const tech: Record<string, number> = {};

const board = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/clockroom')).body;
const queue = async () =>
  ((await board()).technicians as { techNo: string; position: number | null }[])
    .filter((t) => t.position !== null)
    .sort((a, b) => a.position! - b.position!)
    .map((t) => t.techNo);
const state = (techNo: string, action: string, reason?: string, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', `/api/clockroom/technicians/${tech[techNo]}/state`, { action, ...(reason ? { reason } : {}) });
const enter = async () => {
  tagNo += 1;
  const code = `C${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'female' }] });
  expect(r.status).toBe(201);
  return r.body.visits[0].id as number;
};
const dispatch = (body: Record<string, unknown>, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), quantity: 1, startNow: true, ...body });
const sessionOf = async (visitId: number) => ((await board()).sessions as { id: number; visitId: number; status: string; clocks: number; minutes: number; techNo: string }[]).find((s) => s.visitId === visitId)!;
const act = (id: number, what: 'start' | 'finish', cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', `/api/clockroom/sessions/${id}/${what}`);
const pay = async (visitId: number) => {
  const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: [{ method: 'cash', amount: preview.totalAmount }],
  });
  expect(r.status).toBe(200);
  return r.body as { id: number; createdAt: string };
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'C', from: 1, to: 60, width: 3, zone: 'female' })).status).toBe(200);
  const add = async (body: Record<string, unknown>) => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { technicianRequired: true, ...body });
    expect(r.status).toBe(200);
    return r.body.items.find((i: { name: string }) => i.name === body.name).id as number;
  };
  foot = await add({ name: '足疗', category: '足疗', durationMinutes: 90, prices: { standard: 19800, professional: 23800, premium: 29800 } });
  gua = await add({ name: '刮痧', category: '理疗', price: 12800 });
  for (const [no, grade, gender] of [
    ['01', 'standard', 'female'],
    ['02', 'professional', 'female'],
    ['03', 'premium', 'male'],
    ['04', 'standard', 'male'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender, grade });
    expect(r.status).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('上牌与轮钟队列', () => {
  it('按上牌先后排队；休息、回牌排到队尾；排到队尾要写原因；店员可以操作，没有钟房权限的不行', async () => {
    expect(await queue()).toEqual([]);
    for (const no of ['02', '01', '03']) expect((await state(no, 'sign_in')).status).toBe(200);
    expect(await queue()).toEqual(['02', '01', '03']);
    await state('02', 'rest');
    expect(await queue()).toEqual(['01', '03']);
    await state('02', 'back');
    expect(await queue()).toEqual(['01', '03', '02']);
    expect((await state('01', 'to_end')).status).toBe(422);
    expect((await state('01', 'to_end', '叫了不在岗')).status).toBe(200);
    expect(await queue()).toEqual(['03', '02', '01']);
    // 全部上牌：04 号按名册顺序进来
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).status).toBe(200);
    expect(await queue()).toEqual(['03', '02', '01', '04']);
    // 后勤人员没有钟房权限
    await createStaff(ctx.sql, { username: 'back', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    const back = await login(ctx.app, 'back');
    expect((await api(ctx.app, back, 'GET', '/api/clockroom')).status).toBe(403);
    const log = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; techNo: string; text: string }[];
    expect(log.find((e) => e.kind === 'to_end')).toMatchObject({ techNo: '01', text: '叫了不在岗' });
  });
});

describe('派钟、上钟、加钟、下钟', () => {
  it('轮钟派给队首；不派给队首要写原因（记日志），被跳过的不动牌；派了轮钟的排到队尾', async () => {
    // 队列：03 02 01 04
    const v = await enter();
    const skip = await dispatch({ visitId: v, itemId: foot, technicianId: tech['01'], callType: 'rotation', expectedTotal: 19800 });
    expect(skip.status).toBe(422);
    expect(skip.body.error).toMatchObject({ code: 'SKIP_REASON_REQUIRED', message: '轮钟应派给排在前面的 03 号 技师03；要跳过请写原因' });
    // 客人要女技师：跳过 03（男），派给 02（专业，按专业档 238）
    const r = await dispatch({ visitId: v, itemId: foot, technicianId: tech['02'], callType: 'rotation', skipReason: '客人要女技师', expectedTotal: 23800 });
    expect(r.status).toBe(200);
    expect(await queue()).toEqual(['03', '01', '04', '02']);
    const s = await sessionOf(v);
    expect(s).toMatchObject({ techNo: '02', status: 'serving', clocks: 1, minutes: 90 });
    const log = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; techNo: string; text: string }[];
    expect(log.find((e) => e.kind === 'skip')).toMatchObject({ techNo: '03', text: '轮到时跳过，派给 02 号 技师02：客人要女技师' });
    // 账单上记了这条技师明细，挂在这张钟单上
    const visit = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body;
    expect(visit.lines[0]).toMatchObject({ name: '足疗（专业）', amount: 23800, technician: { techNo: '02', callType: 'rotation' } });
    // 在钟上的技师不能再派轮钟
    const v2 = await enter();
    expect((await dispatch({ visitId: v2, itemId: gua, technicianId: tech['02'], callType: 'rotation', skipReason: 'x', expectedTotal: 12800 })).body.error.code).toBe('TECHNICIAN_BUSY');

    // 加钟：记为点钟，钟数、时长累加；下钟
    const ext = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/extend`, { clientKey: randomUUID(), quantity: 1, expectedTotal: 23800 });
    expect(ext.status).toBe(200);
    expect(await sessionOf(v)).toMatchObject({ clocks: 2, minutes: 180 });
    const lines = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.lines as { technician: { callType: string } }[];
    expect(lines.map((l) => l.technician.callType)).toEqual(['rotation', 'designated']);
    expect((await act(s.id, 'finish')).status).toBe(200);
    expect(await sessionOf(v)).toBeUndefined();
    // 派轮钟时已经排到队尾，下钟不再动
    expect(await queue()).toEqual(['03', '01', '04', '02']);
  });

  it('点钟不动牌；在钟上的技师可以被点钟（等钟），下钟后再上钟', async () => {
    const v = await enter();
    // 点 01：不动牌
    expect((await dispatch({ visitId: v, itemId: gua, technicianId: tech['01'], callType: 'designated', expectedTotal: 12800 })).status).toBe(200);
    expect(await queue()).toEqual(['03', '01', '04', '02']);
    const s1 = await sessionOf(v);
    expect(s1).toMatchObject({ status: 'serving', minutes: 60 }); // 没写时长按 60 分钟
    // 另一位客人也点 01：等钟
    const v2 = await enter();
    expect((await dispatch({ visitId: v2, itemId: gua, technicianId: tech['01'], callType: 'designated', expectedTotal: 12800 })).status).toBe(200);
    const s2 = await sessionOf(v2);
    expect(s2.status).toBe('waiting');
    expect((await act(s2.id, 'start')).body.error.code).toBe('TECHNICIAN_BUSY');
    expect((await act(s1.id, 'finish')).status).toBe(200);
    expect((await act(s2.id, 'start')).status).toBe(200);
    expect((await act(s2.id, 'finish')).status).toBe(200);
    // 前台加项目时选的技师也建钟单（待上钟）
    const v3 = await enter();
    const post = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v3}/charges`, {
      clientKey: randomUUID(),
      lines: [{ itemId: gua, quantity: 1, technicianId: tech['04'], callType: 'rotation' }],
      expectedTotal: 12800,
    });
    expect(post.status).toBe(200);
    expect(await sessionOf(v3)).toMatchObject({ techNo: '04', status: 'waiting' });
    expect(await queue()).toEqual(['03', '01', '02', '04']);
    expect((await act((await sessionOf(v3)).id, 'start')).status).toBe(200);
    expect((await act((await sessionOf(v3)).id, 'finish')).status).toBe(200);
  });

  it('退钟：作废这张钟单的明细，技师回到原位；连续被退 3 次排到队尾；取消派钟同样回原位', async () => {
    // 队列：03 01 02 04；03 连续被退 3 次
    for (let i = 1; i <= 3; i++) {
      const v = await enter();
      expect((await dispatch({ visitId: v, itemId: gua, technicianId: tech['03'], callType: 'rotation', expectedTotal: 12800 })).status).toBe(200);
      expect((await queue())[0]).not.toBe('03');
      const s = await sessionOf(v);
      const r = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/void`, { reason: '客人要换技师' });
      expect(r.status).toBe(200);
      const visit = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body;
      expect(visit.lines[0]).toMatchObject({ status: 'voided', voidReason: '退钟：客人要换技师' });
      expect(visit.bill.amountCents).toBe(0);
      expect((await queue())[0]).toBe(i < 3 ? '03' : '01');
    }
    expect(await queue()).toEqual(['01', '02', '04', '03']);
    const log = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; text: string }[];
    expect(log.some((e) => e.kind === 'queue' && e.text === '连续被退钟 3 次，排到队尾')).toBe(true);
    // 取消派钟（还没上钟）：回原位，不算被退
    const v = await enter();
    expect((await dispatch({ visitId: v, itemId: gua, technicianId: tech['01'], callType: 'rotation', startNow: false, expectedTotal: 12800 })).status).toBe(200);
    expect(await queue()).toEqual(['02', '04', '03', '01']);
    const s = await sessionOf(v);
    expect(s.status).toBe('waiting');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/void`, { reason: '客人不做了' })).status).toBe(200);
    expect(await queue()).toEqual(['01', '02', '04', '03']);
    // 前台作废技师明细：钟单跟着作废
    const v2 = await enter();
    await dispatch({ visitId: v2, itemId: gua, technicianId: tech['01'], callType: 'rotation', expectedTotal: 12800 });
    const line = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v2}`)).body.lines[0];
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '挂错了' })).status).toBe(200);
    expect(await sessionOf(v2)).toBeUndefined();
    expect(await queue()).toEqual(['01', '02', '04', '03']);
  });

  it('钟单明细只能作废，钟单编号不能改；结账时还没结束的钟单一起收尾，反结账重开也不再冒出来', async () => {
    const v = await enter();
    expect((await dispatch({ visitId: v, itemId: gua, technicianId: tech['01'], callType: 'designated', expectedTotal: 12800 })).status).toBe(200);
    // 同一位客人又点了 04 号，技师还没到（待上钟）
    expect((await dispatch({ visitId: v, itemId: gua, technicianId: tech['04'], callType: 'designated', startNow: false, expectedTotal: 12800 })).status).toBe(200);
    const line = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.lines[0];
    await expect(ctx.sql`UPDATE bill_lines SET session_id = NULL WHERE id = ${line.id}`).rejects.toThrow('账单明细只能作废，不能修改');
    await expect(ctx.sql`UPDATE technician_events SET kind = 'finish'`).rejects.toThrow();
    // 结账核对列出还没结束的钟
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body;
    expect(preview.sessions.map((s: { techNo: string; status: string }) => [s.techNo, s.status])).toEqual([
      ['01', 'serving'],
      ['04', 'waiting'],
    ]);
    // 结账：在钟上的按结账时刻下钟，还没上钟的按已做完记（实际 0 分钟）；两位技师都空出来
    const paid = await pay(v);
    const rows = await ctx.sql<{ techNo: string; status: string; startedAt: string; endedAt: string }[]>`
      SELECT t.tech_no, s.status, s.started_at, s.ended_at FROM technician_sessions s JOIN technicians t ON t.id = s.technician_id
      WHERE s.visit_id = ${v} ORDER BY s.id`;
    expect(rows.map((r) => [r.techNo, r.status])).toEqual([
      ['01', 'done'],
      ['04', 'done'],
    ]);
    for (const r of rows) expect(new Date(r.endedAt).getTime()).toBe(new Date(paid.createdAt).getTime());
    expect(rows[1]!.startedAt).toBe(rows[1]!.endedAt);
    const events = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; techNo: string | null; text: string }[];
    expect(events.filter((e) => e.kind === 'finish' && e.text.startsWith('自动下钟')).map((e) => e.techNo).sort()).toEqual(['01', '04']);
    let b = await board();
    for (const no of ['01', '04']) expect(b.technicians.find((t: { techNo: string }) => t.techNo === no).busy).toBeNull();
    // 反结账重开账单：钟单已经结束，不会再冒出来占着技师；重结时没有要收尾的钟
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${paid.id}/void`, { reason: '收款方式记错' })).status).toBe(200);
    b = await board();
    expect(b.sessions.filter((s: { visitId: number }) => s.visitId === v)).toEqual([]);
    for (const no of ['01', '04']) expect(b.technicians.find((t: { techNo: string }) => t.techNo === no).busy).toBeNull();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body.sessions).toEqual([]);
    await pay(v);
  });
});

describe('钟房与轮钟规则', () => {
  it('只有店主能改；下钟后排尾、点钟算一轮按规则执行', async () => {
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/technicians/clockroom-rules', { afterRotation: 'finish' })).status).toBe(403);
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/clockroom-rules', { afterRotation: 'finish', afterDesignated: 'end' });
    expect(r.status).toBe(200);
    expect(r.body.clockroomRules).toMatchObject({ afterRotation: 'finish', afterDesignated: 'end', rejectEndAfter: 3 });
    const q0 = await queue();
    const first = q0[0]!;
    const v = await enter();
    await dispatch({ visitId: v, itemId: gua, technicianId: tech[first], callType: 'rotation', expectedTotal: 12800 });
    // 下钟后才排尾：派钟时位置不动
    expect(await queue()).toEqual(q0);
    await act((await sessionOf(v)).id, 'finish');
    expect(await queue()).toEqual([...q0.slice(1), first]);
    // 点钟也算一轮：派点钟时就排到队尾
    const q1 = await queue();
    const v2 = await enter();
    await dispatch({ visitId: v2, itemId: gua, technicianId: tech[q1[0]!], callType: 'designated', expectedTotal: 12800 });
    expect(await queue()).toEqual([...q1.slice(1), q1[0]]);
    await act((await sessionOf(v2)).id, 'finish');
    await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/clockroom-rules', { afterRotation: 'dispatch', afterDesignated: 'keep' });
    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; isDefault: boolean }[];
    expect(rules.find((x) => x.key === 'clockroom_rules.afterRotation')!.isDefault).toBe(true);
  });
});

describe('提成', () => {
  it('默认按售价 40%、点钟每钟另加 ¥10；按结账时刻的规则版本；反结账按原规则冲回；没有权限看不到', async () => {
    const before = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/technicians?from=${(await board()).businessDate}&to=${(await board()).businessDate}`)).body;
    const v = await enter();
    // 02（专业）点钟足疗 238 × 1：提成 95.20 + 10
    expect((await dispatch({ visitId: v, itemId: foot, technicianId: tech['02'], callType: 'designated', expectedTotal: 23800 })).status).toBe(200);
    const first = await pay(v);
    const date = (await board()).businessDate as string;
    const report = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', `/api/reports/technicians?from=${date}&to=${date}`)).body;
    const row = (r: { rows: { techNo: string; commission?: { base: number; bonus: number; total: number } }[] }, no: string) => r.rows.find((x) => x.techNo === no)!;
    const r1 = await report();
    const b02 = row(before, '02').commission!;
    expect(row(r1, '02').commission).toEqual({ base: b02.base + 9520, bonus: b02.bonus + 1000, total: b02.total + 10520 });
    // 值班经理能看业绩、看不到提成
    const asDuty = await report(duty);
    expect(row(asDuty, '02').commission).toBeUndefined();
    expect(asDuty.totals.commission).toBeUndefined();

    // 店主改规则：足疗每钟固定（标准 60 / 专业 70 / 优选 85），点钟奖励 ¥15
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/technicians/commission', { rules: { base: { kind: 'percent', rateBp: 4500 }, designatedBonus: 1500, items: {} } })).status).toBe(403);
    const put = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/commission', {
      rules: { base: { kind: 'percent', rateBp: 4500 }, designatedBonus: 1500, items: { [foot]: { kind: 'fixed', perClock: { standard: 6000, professional: 7000, premium: 8500 } } } },
      note: '按项目定额',
    });
    expect(put.status).toBe(200);
    expect(put.body.current).toMatchObject({ note: '按项目定额', createdByName: '测试店主' });
    expect(put.body.history.length).toBe(1);
    // 已结的那一钟仍按旧规则
    expect(row(await report(), '02').commission).toEqual(row(r1, '02').commission);
    // 新结账的按新规则：02 点钟足疗（专业档）70 + 15；01 轮钟刮痧 128 × 45% = 57.60
    const v2 = await enter();
    // 上一位客人结账离店时 02 还记着在钟上：这次派钟立即上钟，旧钟单自动下钟
    expect((await dispatch({ visitId: v2, itemId: foot, technicianId: tech['02'], callType: 'designated', expectedTotal: 23800 })).status).toBe(200);
    expect((await dispatch({ visitId: v2, itemId: gua, technicianId: tech['01'], callType: 'rotation', skipReason: '指定女技师', expectedTotal: 12800 })).status).toBe(200);
    await pay(v2);
    const r2 = await report();
    expect(row(r2, '02').commission!.total).toBe(row(r1, '02').commission!.total + 8500);
    expect(row(r2, '01').commission!.total - row(r1, '01').commission!.total).toBe(5760);

    // 反结账第一张：按它结账时的规则冲回
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${first.id}/void`, { reason: '测试冲回' })).status).toBe(200);
    const r3 = await report();
    expect(row(r3, '02').commission!.total).toBe(row(r2, '02').commission!.total - 10520);

    // 提成明细导出：店主能导出，值班经理不能
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/reports/technicians/commission.csv?from=${date}&to=${date}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('营业日,结账单号,计入,手牌,工号,技师,项目,钟数,上钟方式,金额（元）,基本提成（元）,点钟奖励（元）,提成合计（元）,提成规则');
    expect(csv.body).toContain('反结账冲回');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/reports/technicians/commission.csv?from=${date}&to=${date}`, headers: { cookie: duty } })).statusCode).toBe(403);
  });
});
