// 8.1.15 技师（docs/TECHNICIANS_V8115.md；《浴族系统需求汇总》技师 1–3）：
//   · 名册的花名、类型、入职日期，类型的清单；组别（分组、组长、换组）；班次、排班表、临时调班与对调（逐条留痕）；
//   · 休假：申请（同一编号重提不重复建）、日期重叠、批准 / 驳回 / 撤回 / 销假；批了的含今天的不进排位、不能派钟、
//     不能在钟房上牌，销假以后照常；休假从以后开始的今天不受影响；到了日子不用谁去点就是休假（读的时候算）；
//   · 排位播报：派钟自动记一条叫号（排位号、工号、花名、房间）、手动叫号、主播报终端的登记 / 接管 / 放下 / 报到；
//   · 权限：钟房的岗位能看、能替技师申请与撤回休假，改名册、组别、班次、排班与审批要「维护技师名册」。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClockroomBoard } from '../src/shared/clockroom';
import { shiftDate } from '../src/shared/labels';
import type { ScheduleView, TechLeave, TechnicianAdminView } from '../src/shared/technician-admin';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let backoffice: string; // 后勤：没有钟房、技师名册权限
let foot = 0;
let roomId = 0;
let today = '';
let tagNo = 0;
const tech: Record<string, number> = {};

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L3,合成足浴区,Sample Foot,合成样例'].join('\r\n');
const SPACES_CSV = ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', 'L3,F,F312,足浴,4,合成足浴间,,合成 F312,'].join('\r\n');

/** 被拒绝时响应里是 error（用例里两样都会读） */
type Fail = { error: { code: string; message: string } };

const view = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', '/api/technician-admin')).body as TechnicianAdminView;
const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body as ClockroomBoard;
const boardTech = async (no: string) => (await board()).technicians.find((t) => t.techNo === no)!;
/** 轮钟队列里的工号，按排位 */
const queueOf = (b: ClockroomBoard) =>
  b.technicians
    .filter((t) => t.position !== null)
    .sort((x, y) => x.position! - y.position!)
    .map((t) => t.techNo);
const state = (no: string, action: string, extra: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action, ...(['leave', 'suspend', 'resume'].includes(action) ? { clientKey: randomUUID() } : {}), ...extra });
const enter = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `T${String(tagNo).padStart(3, '0')}`, zone: 'female' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const dispatch = (body: Record<string, unknown>) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), quantity: 1, startNow: true, itemId: foot, expectedTotal: 12800, callType: 'rotation', ...body });
const apply = (body: Record<string, unknown>, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api<TechLeave & Fail>(ctx.app, cookie, 'POST', '/api/technician-admin/leaves', { clientKey, leaveType: 'personal', reason: '家里有事', ...body });
const decide = (id: number, action: 'approve' | 'reject', note = '', cookie = ctx.owner) =>
  api<TechLeave & Fail>(ctx.app, cookie, 'POST', `/api/technician-admin/leaves/${id}/decide`, { action, note });
const cancel = (id: number, reason = '', cookie = ctx.owner) => api<TechLeave & Fail>(ctx.app, cookie, 'POST', `/api/technician-admin/leaves/${id}/cancel`, { reason });
const audits = async (action: string) =>
  ctx.sql<{ detail: { summary?: string; action?: string } }[]>`SELECT detail FROM audit_logs WHERE action = ${action} ORDER BY id`.then((rows) => rows.map((r) => r.detail));

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'hq', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  backoffice = await login(ctx.app, 'hq');
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  roomId = ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]).find((s) => s.code === 'F312')!.id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'T', from: 1, to: 40, width: 3, zone: 'female' })).status).toBe(200);
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '足疗', durationMinutes: 60, technicianRequired: true, price: 12800 });
  expect(item.status, JSON.stringify(item.body)).toBe(200);
  foot = item.body.items.find((i: { name: string }) => i.name === '足疗').id;
  for (const [no, name] of [
    ['11', '张小明'],
    ['12', '李婷'],
    ['13', '王芳'],
    ['14', '赵敏'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name, gender: 'female', grade: 'standard' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true, requireTechnician: false })).status).toBe(200);
  today = (await view()).businessDate;
});
afterAll(async () => ctx.close());

describe('名册：花名、类型、入职日期', () => {
  it('默认的类型清单；改清单要「维护技师名册」，不能空、不能重复', async () => {
    const v = await view();
    expect(v.kinds).toEqual(['足浴', '按摩', 'SPA', '采耳', '其他']);
    expect(v.canManage).toBe(true);
    expect(v.categories).toContain('足疗');
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/technician-admin/kinds', { kinds: ['足浴'] })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/technician-admin/kinds', { kinds: [] })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/technician-admin/kinds', { kinds: ['足浴', '足浴'] })).status).toBe(400);
    const saved = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'PUT', '/api/technician-admin/kinds', { kinds: ['足浴', '按摩', 'SPA', '采耳', '修脚', '其他'] });
    expect(saved.status).toBe(200);
    expect(saved.body.kinds).toContain('修脚');
    // 钟房的看板带着清单（筛选用）
    expect((await board()).kinds).toContain('修脚');
  });

  it('花名、类型、入职日期保存进名册，钟房看板马上看得到；类型不在清单里的拒绝；后台原来的保存（不带这三样）不动它们', async () => {
    const base = { name: '张小明', gender: 'female', grade: 'standard', skills: ['足疗'], note: '', active: true, sortOrder: 0 };
    const bad = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${tech['11']}`, { ...base, kind: '美甲' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('不在清单里');
    const ok = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${tech['11']}`, { ...base, nickname: '小雅', kind: '足浴', hiredOn: '2025-03-01' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const mine = (await view()).technicians.find((t) => t.techNo === '11')!;
    expect(mine).toMatchObject({ nickname: '小雅', kind: '足浴', hiredOn: '2025-03-01', leftOn: null, groupId: null, groupName: null, skills: ['足疗'] });
    expect(await boardTech('11')).toMatchObject({ nickname: '小雅', kind: '足浴', groupName: null, shiftToday: null, restToday: false, approvedLeave: null });
    // 后台名册卡片的保存不带花名、类型、入职日期：原来的不动
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${tech['11']}`, { ...base, note: '擅长足疗' })).status).toBe(200);
    expect((await view()).technicians.find((t) => t.techNo === '11')).toMatchObject({ nickname: '小雅', kind: '足浴', hiredOn: '2025-03-01', note: '擅长足疗' });
    // 新建时直接带上
    const created = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', {
      techNo: '19',
      name: '周琪',
      gender: 'female',
      grade: 'professional',
      nickname: '琪琪',
      kind: 'SPA',
      hiredOn: '2026-01-15',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    tech['19'] = created.body.technicians.find((t: { techNo: string }) => t.techNo === '19').id;
    expect((await view()).technicians.find((t) => t.techNo === '19')).toMatchObject({ nickname: '琪琪', kind: 'SPA', hiredOn: '2026-01-15' });
  });

  it('停用（离职）记下离职日期，重新启用清掉', async () => {
    const body = { name: '周琪', gender: 'female', grade: 'professional', skills: [], note: '', sortOrder: 0 };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${tech['19']}`, { ...body, active: false })).status).toBe(200);
    expect((await view()).technicians.find((t) => t.techNo === '19')).toMatchObject({ active: false, leftOn: today, nickname: '琪琪' });
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${tech['19']}`, { ...body, active: true })).status).toBe(200);
    expect((await view()).technicians.find((t) => t.techNo === '19')).toMatchObject({ active: true, leftOn: null });
  });

  it('权限：钟房的岗位能看（不能改），没有这两样权限的看不了', async () => {
    const v = await view(ctx.clerk);
    expect(v.canManage).toBe(false);
    expect(v.technicians.length).toBe(5);
    expect((await api(ctx.app, backoffice, 'GET', '/api/technician-admin')).status).toBe(403);
    expect((await api(ctx.app, null, 'GET', '/api/technician-admin')).status).toBe(401);
  });
});

describe('组别：分组与组长', () => {
  it('新建组别带组员与组长（组长自动算组员）；重名、停用的技师拒绝；钟房的岗位不能建', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/technician-admin/groups', { name: '足浴一组' })).status).toBe(403);
    const r = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'POST', '/api/technician-admin/groups', { name: '足浴一组', leaderId: tech['11'], memberIds: [tech['12']] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const g = r.body.groups.find((x) => x.name === '足浴一组')!;
    expect(g).toMatchObject({ leaderId: tech['11'], active: true });
    expect(g.memberIds.sort()).toEqual([tech['11'], tech['12']].sort());
    expect(r.body.technicians.find((t) => t.techNo === '12')).toMatchObject({ groupId: g.id, groupName: '足浴一组' });
    expect((await boardTech('12')).groupName).toBe('足浴一组');
    const dup = await api(ctx.app, ctx.owner, 'POST', '/api/technician-admin/groups', { name: ' 足浴一组 ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('GROUP_NAME_TAKEN');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/technician-admin/groups', { name: '不存在的人', memberIds: [999_999] })).body.error.code).toBe('GROUP_MEMBER_INVALID');
    expect((await audits('technician_group')).at(-1)!.summary).toBe('新建技师组别「足浴一组」：2 人，组长 11 号 张小明');
  });

  it('把组长挪到另一个组：原来的组没有组长了；组员整份提交，不在名单里的退出；停用的组不留人', async () => {
    const r = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'POST', '/api/technician-admin/groups', { name: '足浴二组', memberIds: [tech['11'], tech['13']] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const one = r.body.groups.find((x) => x.name === '足浴一组')!;
    const two = r.body.groups.find((x) => x.name === '足浴二组')!;
    expect(one).toMatchObject({ leaderId: null, memberIds: [tech['12']] });
    expect(two.memberIds.sort()).toEqual([tech['11'], tech['13']].sort());
    // 二组只留 13，11 退出
    const edited = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'PUT', `/api/technician-admin/groups/${two.id}`, { name: '足浴二组', leaderId: tech['13'], memberIds: [tech['13']] });
    expect(edited.body.groups.find((x) => x.id === two.id)).toMatchObject({ leaderId: tech['13'], memberIds: [tech['13']] });
    expect(edited.body.technicians.find((t) => t.techNo === '11')!.groupId).toBeNull();
    const off = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'PUT', `/api/technician-admin/groups/${two.id}`, { name: '足浴二组', leaderId: tech['13'], memberIds: [tech['13']], active: false });
    expect(off.body.groups.find((x) => x.id === two.id)).toMatchObject({ active: false, leaderId: null, memberIds: [] });
    expect((await boardTech('13')).groupName).toBeNull();
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/technician-admin/groups/999999', { name: '没有的组' })).status).toBe(404);
  });
});

describe('班次、排班表、临时调班', () => {
  let early = 0;
  let late = 0;
  const schedule = async (from = today, days = 7) => (await api(ctx.app, ctx.clerk, 'GET', `/api/technician-admin/schedule?from=${from}&days=${days}`)).body as ScheduleView;
  const plan = (cells: Record<string, unknown>[], cookie = ctx.owner) => api<ScheduleView & Fail>(ctx.app, cookie, 'PUT', `/api/technician-admin/schedule?from=${today}&days=7`, { cells });
  const adjust = (body: Record<string, unknown>) => api<ScheduleView & Fail>(ctx.app, ctx.owner, 'POST', `/api/technician-admin/schedule/adjust?from=${today}&days=7`, body);
  const cellOf = (v: ScheduleView, no: string, date: string) => v.cells.find((c) => c.technicianId === tech[no] && c.date === date) ?? null;

  it('班次：名字、起止时间；重名、起止相同的拒绝', async () => {
    const a = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'POST', '/api/technician-admin/shifts', { name: '早班', startMinute: 600, endMinute: 1080 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'POST', '/api/technician-admin/shifts', { name: '晚班', startMinute: 1080, endMinute: 120, sortOrder: 1 });
    early = b.body.shifts.find((s) => s.name === '早班')!.id;
    late = b.body.shifts.find((s) => s.name === '晚班')!.id;
    expect(b.body.shifts.map((s) => [s.name, s.startMinute, s.endMinute])).toEqual([
      ['早班', 600, 1080],
      ['晚班', 1080, 120],
    ]);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/technician-admin/shifts', { name: '早班', startMinute: 0, endMinute: 60 })).body.error.code).toBe('SHIFT_NAME_TAKEN');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/technician-admin/shifts', { name: '怪班', startMinute: 60, endMinute: 60 })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/technician-admin/shifts', { name: '中班', startMinute: 0, endMinute: 60 })).status).toBe(403);
    expect((await audits('technician_shift')).at(-1)!.summary).toBe('新建技师班次「晚班」18:00–次日 02:00');
  });

  it('排班：整批排、没变的不记；今天没排的可以直接排，已经排了的要走临时调班；过去的、停用的技师与班次拒绝', async () => {
    const tomorrow = shiftDate(today, 1);
    const r = await plan([
      { technicianId: tech['11'], date: today, shiftId: early },
      { technicianId: tech['12'], date: today, shiftId: null, rest: true },
      { technicianId: tech['11'], date: tomorrow, shiftId: late },
      { technicianId: tech['13'], date: tomorrow, shiftId: early },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.today).toBe(today);
    expect(cellOf(r.body, '11', today)).toMatchObject({ shiftId: early, rest: false });
    expect(cellOf(r.body, '12', today)).toMatchObject({ shiftId: null, rest: true });
    expect(r.body.changes).toHaveLength(4);
    expect(r.body.changes.every((c) => c.kind === 'plan' && c.from === '没排')).toBe(true);
    // 原样再交一次：一格都没变，不记
    expect((await plan([{ technicianId: tech['11'], date: today, shiftId: early }])).body.changes).toHaveLength(4);
    // 今天已经排了的不能在排班里改
    const locked = await plan([{ technicianId: tech['11'], date: today, shiftId: late }]);
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('SCHEDULE_TODAY_NEEDS_REASON');
    // 明天的可以直接改、清掉
    const changed = await plan([
      { technicianId: tech['11'], date: tomorrow, shiftId: early },
      { technicianId: tech['13'], date: tomorrow, shiftId: null },
    ]);
    expect(cellOf(changed.body, '11', tomorrow)).toMatchObject({ shiftId: early });
    expect(cellOf(changed.body, '13', tomorrow)).toBeNull();
    expect(changed.body.changes[0]).toMatchObject({ kind: 'plan', techNo: '13', from: '早班', to: '没排' });
    expect((await plan([{ technicianId: tech['11'], date: shiftDate(today, -1), shiftId: early }])).body.error.code).toBe('SCHEDULE_PAST');
    expect((await plan([{ technicianId: tech['11'], date: shiftDate(today, 200), shiftId: early }])).body.error.code).toBe('SCHEDULE_TOO_FAR');
    expect((await plan([{ technicianId: 999_999, date: tomorrow, shiftId: early }])).body.error.code).toBe('SCHEDULE_TECH_INVALID');
    expect((await plan([{ technicianId: tech['11'], date: tomorrow, shiftId: 999_999 }])).body.error.code).toBe('SCHEDULE_SHIFT_INVALID');
    expect((await plan([{ technicianId: tech['11'], date: tomorrow, shiftId: early }], ctx.clerk)).status).toBe(403);
    // 钟房看板：今天排的班、排休
    expect((await boardTech('11')).shiftToday).toMatchObject({ name: '早班', startMinute: 600, endMinute: 1080 });
    expect(await boardTech('12')).toMatchObject({ shiftToday: null, restToday: true });
    expect((await view()).technicians.find((t) => t.techNo === '12')).toMatchObject({ restToday: true });
  });

  it('临时调班：改当天已经排了的班、两人对调，都要写原因，逐条留痕；没变化的拒绝', async () => {
    expect((await adjust({ technicianId: tech['11'], date: today, shiftId: late, reason: '' })).status).toBe(400);
    const a = await adjust({ technicianId: tech['11'], date: today, shiftId: late, reason: '晚班缺人' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(cellOf(a.body, '11', today)).toMatchObject({ shiftId: late });
    expect(a.body.changes[0]).toMatchObject({ kind: 'adjust', techNo: '11', from: '早班', to: '晚班', reason: '晚班缺人', swapWith: null });
    expect((await adjust({ technicianId: tech['11'], date: today, shiftId: late, reason: '再点一次' })).body.error.code).toBe('SCHEDULE_NO_CHANGE');
    // 11（晚班）与 12（排休）对调
    const s = await adjust({ technicianId: tech['11'], date: today, swapWithId: tech['12'], reason: '两人换班' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(cellOf(s.body, '11', today)).toMatchObject({ shiftId: null, rest: true });
    expect(cellOf(s.body, '12', today)).toMatchObject({ shiftId: late, rest: false });
    expect(s.body.changes.slice(0, 2).map((c) => [c.kind, c.techNo, c.from, c.to, c.swapWith])).toEqual([
      ['swap', '12', '排休', '晚班', '11 号 张小明'],
      ['swap', '11', '晚班', '排休', '12 号 李婷'],
    ]);
    expect((await adjust({ technicianId: tech['13'], date: today, swapWithId: tech['14'], reason: '都没排' })).body.error.code).toBe('SCHEDULE_NO_CHANGE');
    expect((await adjust({ technicianId: tech['11'], date: today, swapWithId: tech['11'], reason: '自己换自己' })).status).toBe(400);
    expect((await audits('technician_schedule')).at(-1)!.summary).toBe(`临时调班 ${today}：11 号 张小明与12 号 李婷对调（两人换班）`);
    // 改动记录只追加
    await expect(ctx.sql`UPDATE technician_schedule_changes SET reason = '改掉'`).rejects.toThrow();
  });

  it('「全部上牌」跳过今天排休的，要上可以单独点', async () => {
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all');
    expect(r.status).toBe(200);
    const b = r.body as ClockroomBoard;
    expect(b.technicians.find((t) => t.techNo === '11')).toMatchObject({ state: 'off', restToday: true });
    expect(b.technicians.filter((t) => t.state === 'on').map((t) => t.techNo)).toEqual(['12', '13', '14', '19']);
    expect((await state('11', 'sign_in')).status).toBe(200);
    expect((await boardTech('11')).state).toBe('on');
    expect((await schedule()).leaves).toEqual([]);
  });
});

describe('休假：申请、审批，批了的不进排位', () => {
  it('申请：钟房的岗位替技师提；同一个编号重提返回同一张；日期重叠、过去的、太长的拒绝', async () => {
    const key = randomUUID();
    const tomorrow = shiftDate(today, 1);
    const first = await apply({ technicianId: tech['14'], fromDate: tomorrow, toDate: shiftDate(today, 2) }, ctx.clerk, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ techNo: '14', techName: '赵敏', status: 'pending', days: 2, leaveType: 'personal', appliedByName: '测试店员', decidedAt: null });
    const again = await apply({ technicianId: tech['14'], fromDate: tomorrow, toDate: shiftDate(today, 2) }, ctx.clerk, key);
    expect(again.body.id).toBe(first.body.id);
    expect((await apply({ technicianId: tech['13'], fromDate: tomorrow, toDate: tomorrow }, ctx.clerk, key)).body.error.code).toBe('KEY_REUSED');
    const overlap = await apply({ technicianId: tech['14'], fromDate: shiftDate(today, 2), toDate: shiftDate(today, 4) });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');
    expect((await apply({ technicianId: tech['14'], fromDate: shiftDate(today, -1), toDate: today })).body.error.code).toBe('LEAVE_PAST');
    expect((await apply({ technicianId: tech['14'], fromDate: shiftDate(today, 10), toDate: shiftDate(today, 60) })).status).toBe(400);
    expect((await apply({ technicianId: tech['14'], fromDate: shiftDate(today, 10), toDate: shiftDate(today, 9) })).status).toBe(400);
    expect((await apply({ technicianId: tech['14'], fromDate: tomorrow, toDate: tomorrow, reason: '' })).status).toBe(400);
    expect((await apply({ technicianId: tech['14'], fromDate: tomorrow, toDate: tomorrow }, backoffice)).status).toBe(403);
    expect((await view()).pendingLeaves).toBe(1);
    expect((await audits('technician_leave')).at(-1)).toMatchObject({ action: 'apply' });
  });

  it('批准要「维护技师名册」；以后才开始的休假今天不受影响；驳回要写原因；待审批的钟房能撤回', async () => {
    const list = (await api(ctx.app, ctx.clerk, 'GET', '/api/technician-admin/leaves?status=pending')).body as TechLeave[];
    expect(list).toHaveLength(1);
    const id = list[0]!.id;
    expect((await decide(id, 'approve', '', ctx.clerk)).status).toBe(403);
    const ok = await decide(id, 'approve', '同意');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decidedByName: '测试店主', decisionNote: '同意' });
    // 重提：已经批准，原样返回，不重复记
    expect((await decide(id, 'approve', '同意')).body.status).toBe('approved');
    expect((await decide(id, 'reject', '改主意了')).body.error.code).toBe('LEAVE_DECIDED');
    expect((await audits('technician_leave')).filter((d) => d.action === 'approve')).toHaveLength(1);
    // 明天才开始：今天照常在队列里
    expect(await boardTech('14')).toMatchObject({ state: 'on', approvedLeave: null });
    // 驳回、撤回
    const other = await apply({ technicianId: tech['13'], fromDate: shiftDate(today, 5), toDate: shiftDate(today, 5), leaveType: 'sick', reason: '看牙' });
    expect((await decide(other.body.id, 'reject', '')).status).toBe(400);
    expect((await decide(other.body.id, 'reject', '那天人手不够')).body).toMatchObject({ status: 'rejected', decisionNote: '那天人手不够' });
    expect((await cancel(other.body.id)).body.error.code).toBe('LEAVE_DECIDED');
    const third = await apply({ technicianId: tech['13'], fromDate: shiftDate(today, 5), toDate: shiftDate(today, 5), reason: '再申请一次' });
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    const withdrawn = await cancel(third.body.id, '', ctx.clerk);
    expect(withdrawn.body).toMatchObject({ status: 'cancelled', cancelledByName: '测试店员' });
    expect((await cancel(third.body.id, '', ctx.clerk)).body.status).toBe('cancelled');
    // 已批准的销假：钟房的岗位不行，要写原因
    expect((await cancel(id, '不休了', ctx.clerk)).status).toBe(403);
    expect((await cancel(id, '')).status).toBe(400);
  });

  it('批准含今天的休假：马上从排位里拿掉、看板上是休假；在钟上的先下钟才能批', async () => {
    const before = await board();
    expect(queueOf(before)).toEqual(['12', '13', '14', '19', '11']);
    // 12 号在钟上：不能批今天开始的休假
    const v = await enter();
    expect((await dispatch({ visitId: v, technicianId: tech['12'] })).status).toBe(200);
    const busy = await apply({ technicianId: tech['12'], fromDate: today, toDate: today });
    const refused = await decide(busy.body.id, 'approve');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TECHNICIAN_BUSY');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/technician-admin/leaves?status=pending')).body.map((l: TechLeave) => l.id)).toContain(busy.body.id);
    const session = (await board()).sessions.find((s) => s.visitId === v)!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${session.id}/finish`)).status).toBe(200);
    const ok = await decide(busy.body.id, 'approve');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await board();
    const t12 = after.technicians.find((t) => t.techNo === '12')!;
    expect(t12).toMatchObject({ state: 'leave', position: null, approvedLeave: { id: busy.body.id, fromDate: today, toDate: today, leaveType: 'personal' } });
    expect(queueOf(after)).toEqual(['13', '14', '19', '11']);
    expect((await view()).technicians.find((t) => t.techNo === '12')!.leaveToday).toMatchObject({ id: busy.body.id });
    const log = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; techNo: string; text: string }[];
    expect(log.find((e) => e.kind === 'leave' && e.techNo === '12')!.text).toBe(`休假单 ${busy.body.id} 批准`);
  });

  it('休假里的技师：钟房不能上牌、不能取消休假、不能派钟、不能叫号，提示去销假；销假以后回到未上牌、照常上牌', async () => {
    for (const action of ['sign_in', 'sign_out', 'back']) {
      const r = await state('12', action);
      expect(r.status, action).toBe(422);
      expect(r.body.error.code).toBe('TECHNICIAN_LEAVE_APPROVED');
      expect(r.body.error.message).toContain('技师管理 → 休假');
    }
    const v = await enter();
    const d = await dispatch({ visitId: v, technicianId: tech['12'], callType: 'designated' });
    expect(d.status).toBe(422);
    expect(d.body.error.code).toBe('TECHNICIAN_ON_LEAVE');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/calls', { technicianId: tech['12'] })).body.error.code).toBe('TECHNICIAN_NOT_ON');
    // 「全部上牌」也跳过
    expect(((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).body as ClockroomBoard).technicians.find((t) => t.techNo === '12')!.state).toBe('leave');
    const leaveId = (await boardTech('12')).approvedLeave!.id;
    const revoked = await cancel(leaveId, '店里缺人，提前回来');
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'cancelled', cancelReason: '店里缺人，提前回来', cancelledByName: '测试店主' });
    expect(await boardTech('12')).toMatchObject({ state: 'off', approvedLeave: null });
    expect((await state('12', 'sign_in')).status).toBe(200);
    expect(await boardTech('12')).toMatchObject({ state: 'on' });
    expect((await audits('technician_leave')).at(-1)).toMatchObject({ action: 'revoke' });
  });

  it('休假是之前批的、今天才开始：不用谁去点，读看板时就是休假（今天记着在岗也不算）', async () => {
    expect((await boardTech('13')).state).toBe('on');
    // 相当于几天前批了一张含今天的休假单（当时不含今天，所以没动过今天的上牌状态）
    const [row] = await ctx.sql<{ id: number }[]>`
      INSERT INTO technician_leaves (technician_id, from_date, to_date, leave_type, reason, status, client_key, applied_by, decided_by, decided_at)
      VALUES (${tech['13']!}, ${shiftDate(today, -1)}, ${shiftDate(today, 1)}, 'annual', '年假', 'approved', ${randomUUID()}, ${ctx.clerkId}, ${ctx.ownerId}, now()) RETURNING id`;
    const t13 = await boardTech('13');
    expect(t13).toMatchObject({ state: 'leave', position: null, approvedLeave: { id: row!.id, leaveType: 'annual' } });
    const b = await board();
    expect(queueOf(b)).not.toContain('13');
    // 轮钟派给他：拒绝；派给排在第一位的照常
    const v = await enter();
    expect((await dispatch({ visitId: v, technicianId: tech['13'] })).body.error.code).toBe('TECHNICIAN_ON_LEAVE');
    const first = b.technicians.filter((t) => t.position !== null).sort((x, y) => x.position! - y.position!)[0]!;
    expect((await dispatch({ visitId: v, technicianId: first.id })).status).toBe(200);
    // 钟房自己设的当天休假照旧能在钟房取消；休假单批的不行
    expect((await state('13', 'sign_out')).body.error.code).toBe('TECHNICIAN_LEAVE_APPROVED');
    // 销假：今天记着在岗的不动它，休假没了就回到在岗
    expect((await cancel(row!.id, '销假回来上班')).status).toBe(200);
    expect(await boardTech('13')).toMatchObject({ state: 'on', approvedLeave: null });
  });

  it('钟房自己设的当天休假（没有休假单）照旧：上牌即取消', async () => {
    // 19 号手上没有钟（14 号刚被派了轮钟，在钟上的不能设休假）
    expect((await state('14', 'leave')).body.error.code).toBe('TECHNICIAN_BUSY');
    expect((await state('19', 'leave')).status).toBe(200);
    expect(await boardTech('19')).toMatchObject({ state: 'leave', approvedLeave: null });
    expect((await state('19', 'sign_in')).status).toBe(200);
    expect((await boardTech('19')).state).toBe('on');
  });
});

describe('排位播报：叫号记录与主播报终端', () => {
  it('派钟自动记一条叫号：排位号、工号、花名（没有花名念名字）、房间；看板带最近的叫号', async () => {
    const b0 = await board();
    const queue = b0.technicians.filter((t) => t.position !== null && !t.busy).sort((x, y) => x.position! - y.position!);
    const t = queue[0]!;
    const v = await enter();
    const r = await dispatch({ visitId: v, technicianId: t.id, spaceId: roomId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as ClockroomBoard;
    const call = b.calls.at(-1)!;
    expect(call).toMatchObject({ kind: 'dispatch', technicianId: t.id, staffName: '测试店员' });
    expect(call.text).toBe(`请 ${t.position} 号排位，${t.techNo} 号 ${t.nickname || t.name}，到 F312 合成足浴间`);
    expect(call.sessionId).toBe(b.sessions.find((s) => s.visitId === v)!.id);
    // 没选房间的念「准备上钟」；点钟给有花名的 11 号念花名
    const v2 = await enter();
    const d2 = await dispatch({ visitId: v2, technicianId: tech['11'], callType: 'designated', startNow: false });
    expect(d2.status, JSON.stringify(d2.body)).toBe(200);
    expect((d2.body as ClockroomBoard).calls.at(-1)!.text).toMatch(/^请 \d+ 号排位，11 号 小雅，准备上钟$/);
    // 叫号记录只追加
    await expect(ctx.sql`DELETE FROM technician_calls`).rejects.toThrow();
  });

  it('手动叫号：再叫一次（念这位技师手上那一张的房间）；没上牌的不能叫；没有钟房权限的不能叫', async () => {
    const b0 = await board();
    const s = b0.sessions.find((x) => x.space?.id === roomId)!;
    const n = b0.calls.length;
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/calls', { technicianId: s.technicianId, sessionId: s.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as ClockroomBoard;
    expect(b.calls).toHaveLength(n + 1);
    expect(b.calls.at(-1)).toMatchObject({ kind: 'manual', technicianId: s.technicianId, sessionId: s.id });
    expect(b.calls.at(-1)!.text).toContain('到 F312 合成足浴间');
    // 空闲的技师也能叫（只念排位）
    const idle = b.technicians.find((t) => t.position !== null && !t.busy)!;
    const r2 = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/calls', { technicianId: idle.id });
    expect((r2.body as ClockroomBoard).calls.at(-1)!.text).toBe(`请 ${idle.position} 号排位，${idle.techNo} 号 ${idle.nickname || idle.name}，准备上钟`);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/calls', { technicianId: s.technicianId, sessionId: 999_999 })).body.error.code).toBe('SESSION_CLOSED');
    expect((await state('14', 'sign_out')).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/calls', { technicianId: tech['14'] })).body.error.code).toBe('TECHNICIAN_NOT_ON');
    expect((await api(ctx.app, backoffice, 'POST', '/api/clockroom/calls', { technicianId: idle.id })).status).toBe(403);
  });

  it('排位播报单独授权（8.2.0 P03）：只有「排位播报」的账号看得到排位、能叫号、能登记播报终端，钟房的操作做不了', async () => {
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/staff', {
      username: 'paiwei',
      displayName: '排位员',
      position: 'finance.staff',
      permissionAdjust: { add: ['technician.announce'], remove: [] },
      password: PASSWORD,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = 'paiwei'`;
    const caller = await login(ctx.app, 'paiwei');
    const me = (await api(ctx.app, caller, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(me.permissions).toContain('technician.announce');
    expect(me.permissions).not.toContain('technician.dispatch');
    const b = (await api(ctx.app, caller, 'GET', '/api/clockroom')).body as ClockroomBoard;
    const idle = b.technicians.find((t) => t.position !== null && !t.busy)!;
    const r = await api(ctx.app, caller, 'POST', '/api/clockroom/calls', { technicianId: idle.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as ClockroomBoard).calls.at(-1)).toMatchObject({ kind: 'manual', technicianId: idle.id, staffName: '排位员' });
    // 钟房的操作（上下牌）没有权限
    expect((await api(ctx.app, caller, 'POST', `/api/clockroom/technicians/${idle.id}/state`, { action: 'rest' })).status).toBe(403);
    // 两样都没有的看不到排位
    expect((await api(ctx.app, backoffice, 'GET', '/api/clockroom')).status).toBe(403);
  });

  it('主播报终端：登记、另一台接管、只有它自己能放下、报到只认登记的那一台；接管与放下记审计', async () => {
    const a = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const z = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const announcer = (body: Record<string, unknown>, cookie = ctx.clerk) => api<ClockroomBoard>(ctx.app, cookie, 'POST', '/api/clockroom/announcer', body);
    expect((await board()).announcer).toBeNull();
    const first = await announcer({ action: 'claim', clientId: a, label: '钟房 1 号机' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.announcer).toMatchObject({ clientId: a, label: '钟房 1 号机', claimedByName: '测试店员' });
    // 同一台再登记：不算接管，不重复记审计
    await announcer({ action: 'claim', clientId: a, label: '钟房 1 号机' });
    expect(await audits('clock_announcer')).toHaveLength(1);
    // 另一台放不下它、报到也不算
    expect((await announcer({ action: 'release', clientId: z })).body.announcer).toMatchObject({ clientId: a });
    const seen = first.body.announcer!.seenAt;
    await ctx.sql`UPDATE technician_announcer SET seen_at = now() - interval '10 minutes'`;
    expect(new Date((await announcer({ action: 'heartbeat', clientId: z })).body.announcer!.seenAt).getTime()).toBeLessThan(new Date(seen).getTime());
    expect(new Date((await announcer({ action: 'heartbeat', clientId: a })).body.announcer!.seenAt).getTime()).toBeGreaterThanOrEqual(new Date(seen).getTime());
    // 另一台接管
    const taken = await announcer({ action: 'claim', clientId: z, label: '前台 2 号机' }, ctx.owner);
    expect(taken.body.announcer).toMatchObject({ clientId: z, label: '前台 2 号机', claimedByName: '测试店主' });
    expect((await audits('clock_announcer')).at(-1)!.summary).toBe('前台 2 号机负责播报叫号（从「钟房 1 号机」接管）');
    // 放下
    expect((await announcer({ action: 'release', clientId: z, label: '前台 2 号机' }, ctx.owner)).body.announcer).toBeNull();
    expect((await audits('clock_announcer')).at(-1)!.summary).toBe('前台 2 号机不再播报叫号');
    expect((await announcer({ action: 'claim', clientId: 'x' })).status).toBe(400);
    expect((await announcer({ action: 'claim', clientId: a }, backoffice)).status).toBe(403);
  });
});
