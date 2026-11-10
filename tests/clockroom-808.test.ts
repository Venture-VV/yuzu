// 8.0.8 前台整改 · 钟房（docs/FRONTDESK_V808.md 第 1 节）：护理项目默认需要技师、待派钟补派（不另挂一笔）、休假与停牌、按状态筛选、转钟。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { techFilterOf } from '../src/shared/clockroom';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let care: number; // 精油按摩（护理）：标准 198 / 专业 238
let foot: number; // 足疗：一档 128
let tagNo = 0;
const tech: Record<string, number> = {};

type BoardTech = { id: number; techNo: string; state: 'on' | 'rest' | 'off' | 'leave'; position: number | null; suspendedAt: string | null; busy: { status: 'waiting' | 'serving' } | null; rejectStreak: number };
type BoardSession = { id: number; visitId: number; status: string; techNo: string; clocks: number; space: { id: number } | null };
type Pending = { lineId: number; visitId: number; itemName: string; tier: string; quantity: number; amount: number };

const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body as { technicians: BoardTech[]; sessions: BoardSession[]; pending: Pending[]; today: { clocks: number } };
const techOf = async (no: string) => (await board()).technicians.find((t) => t.techNo === no)!;
const state = (no: string, action: string, reason?: string) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action, ...(reason ? { reason } : {}) });
const setRules = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', body);
const enter = async () => {
  tagNo += 1;
  const code = `K${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'female' }] });
  expect(r.status).toBe(201);
  return r.body.visits[0].id as number;
};
const post = (visitId: number, lines: Record<string, unknown>[], expectedTotal: number) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines, expectedTotal });
const visitLines = async (visitId: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body.lines as {
    id: number;
    name: string;
    amount: number;
    status: string;
    source: string;
    voidReason: string | null;
    technician: { techNo: string; callType: string } | null;
  }[];
const assign = (lineId: number, body: Record<string, unknown>, key = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/lines/${lineId}/assign`, { clientKey: key, startNow: true, ...body });
const dispatch = (body: Record<string, unknown>) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), quantity: 1, startNow: true, ...body });
const transfer = (sessionId: number, body: Record<string, unknown>, key = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sessionId}/transfer`, { clientKey: key, reason: '客人要换技师', ...body });
const events = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; techNo: string; text: string }[];

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 60, width: 3, zone: 'female' })).status).toBe(200);
  const add = async (body: Record<string, unknown>) => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', body);
    expect(r.status).toBe(200);
    return r.body.items.find((i: { name: string }) => i.name === body.name) as { id: number; technicianRequired: boolean };
  };
  // 类别含「护理」的新项目默认需要技师（F1），没勾的普通项目照旧不需要
  const c = await add({ name: '精油按摩', category: '身体护理', durationMinutes: 60, prices: { standard: 19800, professional: 23800 } });
  expect(c.technicianRequired).toBe(true);
  care = c.id;
  const f = await add({ name: '足疗', category: '足疗', price: 12800, technicianRequired: true });
  foot = f.id;
  expect((await add({ name: '搓澡巾', category: '小商品', price: 500 })).technicianRequired).toBe(false);
  for (const [no, grade] of [
    ['11', 'standard'],
    ['12', 'standard'],
    ['13', 'professional'],
    ['14', 'standard'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade });
    expect(r.status).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await setRules({ enabled: true, requireTechnician: false })).status).toBe(200);
  for (const no of ['11', '12', '13']) expect((await state(no, 'sign_in')).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('待派钟：前台点的护理项目交给钟房派钟（A01）', () => {
  it('前台不选技师挂护理项目 → 钟房待派钟 → 补派技师：不另挂一笔、金额不变、建钟单、计今日钟数；重点不重复，派给别人拒绝', async () => {
    const v = await enter();
    const r = await post(v, [{ itemId: care, quantity: 1, tier: 'standard' }], 19800);
    expect(r.status).toBe(200);
    const [line] = await visitLines(v);
    expect(line).toMatchObject({ source: 'therapist', technician: null, amount: 19800 });
    const before = await board();
    expect(before.pending).toEqual([expect.objectContaining({ lineId: line!.id, visitId: v, itemName: '精油按摩（标准）', tier: 'standard', quantity: 1, amount: 19800 })]);

    // 专业技师按等级是专业档，与这条标准档不一样：不能派（要换档请前台作废重点）
    const wrong = await assign(line!.id, { technicianId: tech['13'], callType: 'designated' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('TECHNICIAN_TIER');

    // 编号作废了的原请求不会生效（「结果待确认」时确认作废，Codex 审查 fb67dca）
    const fenced = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${fenced}/abandon`, { type: 'bill_post' })).body).toEqual({ found: false, abandoned: true });
    expect((await assign(line!.id, { technicianId: tech['11'], callType: 'rotation' }, fenced)).body.error.code).toBe('OP_ABANDONED');
    expect((await board()).pending.map((p) => p.lineId)).toContain(line!.id);
    // 没带操作编号的拒绝
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/lines/${line!.id}/assign`, { technicianId: tech['11'], callType: 'rotation' })).status).toBe(400);

    const key = randomUUID();
    const ok = await assign(line!.id, { technicianId: tech['11'], callType: 'rotation' }, key);
    expect(ok.status).toBe(200);
    expect(ok.body.pending).toEqual([]);
    const s = (ok.body.sessions as BoardSession[]).find((x) => x.visitId === v)!;
    expect(s).toMatchObject({ techNo: '11', status: 'serving', clocks: 1 });
    expect(ok.body.today.clocks).toBe(before.today.clocks + 1);
    const lines = await visitLines(v);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 19800, status: 'active', technician: { techNo: '11', callType: 'rotation' } });
    const [b] = await ctx.sql<{ amountCents: number; lineCount: number }[]>`
      SELECT b.amount_cents, b.line_count FROM bills b JOIN visits v ON v.bill_id = b.id WHERE v.id = ${v}`;
    expect(b).toEqual({ amountCents: 19800, lineCount: 1 });

    // 超时后按原编号原样重提：返回原结果，不再建钟单；按编号查回得到这位客人
    const again = await assign(line!.id, { technicianId: tech['11'], callType: 'rotation' }, key);
    expect(again.status).toBe(200);
    expect((again.body.sessions as BoardSession[]).filter((x) => x.visitId === v)).toHaveLength(1);
    const found = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=bill_post`)).body;
    expect(found).toMatchObject({ found: true, type: 'bill_post', visit: { id: v } });
    // 同一个编号换了内容：拒绝
    expect((await assign(line!.id, { technicianId: tech['11'], callType: 'designated' }, key)).status).toBe(409);
    // 换了编号再派给同一位：照常返回，也不再建钟单
    const repeat = await assign(line!.id, { technicianId: tech['11'], callType: 'rotation' });
    expect(repeat.status).toBe(200);
    expect((repeat.body.sessions as BoardSession[]).filter((x) => x.visitId === v)).toHaveLength(1);
    // 已经派给 11 了，再派给 12 拒绝
    const other = await assign(line!.id, { technicianId: tech['12'], callType: 'designated' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('LINE_ASSIGNED');
    expect((await events()).find((e) => e.kind === 'dispatch' && e.techNo === '11')!.text).toContain('前台已点、钟房补派');

    // 明细保护：补记过技师的明细不能再改技师
    await expect(ctx.sql`UPDATE bill_lines SET technician_id = ${tech['12']!} WHERE id = ${line!.id}`).rejects.toThrow('账单明细只能作废，不能修改');
    // 不是技师明细的不能补记
    const plain = await post(v, [{ itemId: foot, quantity: 1 }], 12800);
    expect(plain.status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/finish`)).status).toBe(200);
  });

  it('作废了的、客人离店的不在待派钟里；作废的不能再派', async () => {
    const v = await enter();
    expect((await post(v, [{ itemId: care, quantity: 2, tier: 'standard' }], 39600)).status).toBe(200);
    const [line] = await visitLines(v);
    expect((await board()).pending.map((p) => p.lineId)).toContain(line!.id);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line!.id}/void`, { reason: '客人不做了' })).status).toBe(200);
    expect((await board()).pending.map((p) => p.lineId)).not.toContain(line!.id);
    const r = await assign(line!.id, { technicianId: tech['12'], callType: 'designated' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('LINE_VOIDED');
  });
});

describe('休假、停牌与按状态筛选（B01）', () => {
  it('休假：不能派钟、全部上牌跳过、上牌即取消；停牌：要写原因、跨天到复牌、不能上牌和派钟、在钟上的不能停', async () => {
    expect((await state('14', 'leave', '调休')).status).toBe(200);
    expect(techFilterOf(await techOf('14'))).toBe('leave');
    const v = await enter();
    const r1 = await dispatch({ visitId: v, itemId: foot, technicianId: tech['14'], callType: 'designated', expectedTotal: 12800 });
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe('TECHNICIAN_ON_LEAVE');
    // 前台挂账选休假的技师也不行
    expect((await post(v, [{ itemId: foot, quantity: 1, technicianId: tech['14'], callType: 'designated' }], 12800)).body.error.code).toBe('TECHNICIAN_ON_LEAVE');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).status).toBe(200);
    expect((await techOf('14')).state).toBe('leave');
    expect((await state('14', 'sign_in')).status).toBe(200);
    expect(techFilterOf(await techOf('14'))).toBe('idle');
    expect((await events()).find((e) => e.kind === 'sign_in' && e.techNo === '14')!.text).toContain('取消休假');

    // 停牌：没写原因拒绝
    expect((await state('14', 'suspend')).status).toBe(422);
    expect((await state('14', 'suspend', '迟到三次')).status).toBe(200);
    const t14 = await techOf('14');
    expect(t14).toMatchObject({ state: 'off', position: null });
    expect(t14.suspendedAt).not.toBeNull();
    expect(techFilterOf(t14)).toBe('suspended');
    expect((await state('14', 'sign_in')).body.error.code).toBe('TECHNICIAN_SUSPENDED');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).status).toBe(200);
    expect((await techOf('14')).state).toBe('off');
    expect((await post(v, [{ itemId: foot, quantity: 1, technicianId: tech['14'], callType: 'designated' }], 12800)).body.error.code).toBe('TECHNICIAN_SUSPENDED');
    // 停牌跨天：只看停牌那一列，换了营业日照样停着
    expect((await state('14', 'resume')).status).toBe(200);
    expect(techFilterOf(await techOf('14'))).toBe('off');
    const log = await events();
    expect(log.find((e) => e.kind === 'suspend' && e.techNo === '14')!.text).toBe('迟到三次');
    expect(log.find((e) => e.kind === 'resume' && e.techNo === '14')!.text).toContain('迟到三次');

    // 在钟上的不能停牌、不能休假
    const d = await dispatch({ visitId: v, itemId: foot, technicianId: tech['12'], callType: 'designated', expectedTotal: 12800 });
    expect(d.status).toBe(200);
    expect((await state('12', 'suspend', '临时有事')).body.error.code).toBe('TECHNICIAN_BUSY');
    expect((await state('12', 'leave')).body.error.code).toBe('TECHNICIAN_BUSY');
    expect(techFilterOf(await techOf('12'))).toBe('serving');
    const sid = (await board()).sessions.find((x) => x.visitId === v)!.id;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sid}/finish`)).status).toBe(200);
  });
});

describe('转钟（B05）', () => {
  it('上钟中的转给另一位：原明细作废、新技师同项目同金额、马上上钟、房间照旧；原技师按退钟算；同一编号重提不重复；同一张不能转两次', async () => {
    const v = await enter();
    const d = await dispatch({ visitId: v, itemId: foot, technicianId: tech['11'], callType: 'designated', expectedTotal: 12800 });
    expect(d.status).toBe(200);
    const s = (d.body.sessions as BoardSession[]).find((x) => x.visitId === v)!;
    const streak = (await techOf('11')).rejectStreak;

    // 转给同一位、价格档对不上的都拒绝
    expect((await transfer(s.id, { technicianId: tech['11'], callType: 'designated' })).body.error.code).toBe('TRANSFER_SAME');
    const key = randomUUID();
    const r = await transfer(s.id, { technicianId: tech['12'], callType: 'designated' }, key);
    expect(r.status).toBe(200);
    const mine = (r.body.sessions as BoardSession[]).filter((x) => x.visitId === v);
    expect(mine).toEqual([expect.objectContaining({ techNo: '12', status: 'serving', clocks: 1 })]);
    const lines = await visitLines(v);
    expect(lines.map((l) => [l.status, l.amount, l.technician?.techNo])).toEqual([
      ['voided', 12800, '11'],
      ['active', 12800, '12'],
    ]);
    expect(lines[0]!.voidReason).toBe('转钟：客人要换技师');
    expect((await techOf('11')).rejectStreak).toBe(streak + 1);
    expect(techFilterOf(await techOf('11'))).toBe('idle');
    const log = await events();
    expect(log.find((e) => e.kind === 'transfer' && e.techNo === '11')!.text).toContain('转给 12 号 技师12');
    expect(log.find((e) => e.kind === 'transfer' && e.techNo === '12')!.text).toContain('从 11 号 技师11 转来');

    // 同一个操作编号重提：返回原结果，不重复作废、挂账
    const again = await transfer(s.id, { technicianId: tech['12'], callType: 'designated' }, key);
    expect(again.status).toBe(200);
    expect(await visitLines(v)).toHaveLength(2);
    // 原钟单已经转出（结束）了，再转拒绝
    expect((await transfer(s.id, { technicianId: tech['13'], callType: 'designated' })).body.error.code).toBe('SESSION_CLOSED');
    const s2 = mine[0]!.id;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s2}/finish`)).status).toBe(200);
  });

  it('待上钟的转过去也是待上钟；价格跟等级时只能转给同等级的', async () => {
    const v = await enter();
    const d = await dispatch({ visitId: v, itemId: care, technicianId: tech['11'], callType: 'designated', startNow: false, expectedTotal: 19800 });
    expect(d.status).toBe(200);
    const s = (d.body.sessions as BoardSession[]).find((x) => x.visitId === v)!;
    expect(s.status).toBe('waiting');
    const tier = await transfer(s.id, { technicianId: tech['13'], callType: 'designated' });
    expect(tier.status).toBe(409);
    expect(tier.body.error.code).toBe('TECHNICIAN_TIER');
    const r = await transfer(s.id, { technicianId: tech['12'], callType: 'designated' });
    expect(r.status).toBe(200);
    expect((r.body.sessions as BoardSession[]).filter((x) => x.visitId === v)).toEqual([expect.objectContaining({ techNo: '12', status: 'waiting' })]);
    // 原技师没上钟：按取消派钟，不算被退
    expect((await events()).find((e) => e.kind === 'cancel' && e.techNo === '11')!.text).toBe('转钟：客人要换技师');
  });

  /** 在岗、空闲、没停牌的技师，按轮钟排位 */
  const idleQueue = async () =>
    (await board()).technicians.filter((t) => t.state === 'on' && !t.busy && !t.suspendedAt && t.position !== null).sort((x, y) => x.position! - y.position!);

  it('轮钟转给排在后面的那位：原技师（按退钟回到原位）不算在「该派给谁」里，不用写跳过原因（Codex 审查 9470097）', async () => {
    const v = await enter();
    const [a, b] = await idleQueue();
    expect(a && b).toBeTruthy();
    const d = await dispatch({ visitId: v, itemId: foot, technicianId: a!.id, callType: 'rotation', expectedTotal: 12800 });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const s = (d.body.sessions as BoardSession[]).find((x) => x.visitId === v)!;
    // 修之前：原技师按退钟回到排在前面，服务端要求写跳过原因（SKIP_REASON_REQUIRED），转钟对话框却不让写
    const r = await transfer(s.id, { technicianId: b!.id, callType: 'rotation' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mine = (r.body.sessions as BoardSession[]).filter((x) => x.visitId === v);
    expect(mine).toEqual([expect.objectContaining({ techNo: b!.techNo, status: 'serving' })]);
    expect((await events()).filter((e) => e.kind === 'skip' && e.techNo === a!.techNo && e.text.includes(b!.techNo))).toHaveLength(0);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${mine[0]!.id}/finish`)).status).toBe(200);
  });

  it('转过去的明细照原来的挂账人、时间与营业日：店员不能借转钟作废别人挂的（Codex 审查 9470097）', async () => {
    const v = await enter();
    const [x, y] = await idleQueue();
    // 店主派的点钟：挂账人是店主
    const d = await api(ctx.app, ctx.owner, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      quantity: 1,
      startNow: true,
      visitId: v,
      itemId: foot,
      technicianId: x!.id,
      callType: 'designated',
      expectedTotal: 12800,
    });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const s = (d.body.sessions as BoardSession[]).find((z) => z.visitId === v)!;
    const provenance = (sessionId: number) =>
      ctx.sql<{ postedBy: number; postedAt: string; businessDate: string }[]>`
        SELECT posted_by, posted_at, business_date::text AS business_date FROM bill_lines WHERE session_id = ${sessionId}`;
    const [orig] = await provenance(s.id);
    // 店员转钟可以（转钟不受「本人 15 分钟内」的限制）
    const r = await transfer(s.id, { technicianId: y!.id, callType: 'designated' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const moved = (r.body.sessions as BoardSession[]).find((z) => z.visitId === v)!;
    const [now] = await provenance(moved.id);
    expect(now).toEqual(orig);
    expect(now!.postedBy).toBe(ctx.ownerId);
    // 店员作废新钟单、新明细都拒绝（不是自己挂的）；店主能
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${moved.id}/void`, { reason: '客人不做了' })).status).toBe(403);
    const line = (await visitLines(v)).find((l) => l.status === 'active' && l.source === 'therapist')!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '客人不做了' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/clockroom/sessions/${moved.id}/void`, { reason: '客人不做了' })).status).toBe(200);
  });
});
