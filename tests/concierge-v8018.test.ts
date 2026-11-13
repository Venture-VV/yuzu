// 8.0.18 把管家同源联动（PR #99）整合进主线时改的几处：
// 未建服务档案的会员手机号打码、会员摘要一批取（含合并）、不给原生表的行加锁、同步指纹、自检。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';
import { createStaff } from '../src/server/modules/staff';
import { conciergeCheck } from '../src/server/modules/concierge/checks';
import { canonicalMemberIds, nativeMemberSummaries } from '../src/server/modules/concierge/native-links';
import type { WorkspaceData } from '../src/shared/concierge/types';

let ctx: TestContext;
let butler: string; // 只有「管家」职责：没有「查找与查看会员」
const path = '/api/concierge/workspace';
const mutate = (action: string, payload: Record<string, unknown>, cookie = butler) =>
  api(ctx.app, cookie, 'POST', path, { action, payload, requestId: randomUUID() });
const revision = async () => (await api(ctx.app, butler, 'GET', '/api/concierge/revision')).body.revision as string;
async function enroll(nativeMemberId: number) {
  const r = await mutate('createMember', { nativeMemberId, joinedAt: '2026-11-13' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
}

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'v18_butler', displayName: '整合管家', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
  butler = await login(ctx.app, 'v18_butler');
});
afterAll(async () => ctx?.close());

describe('未建服务档案的会员手机号', () => {
  it('没有会员查看权限的管家：名单、查找、单个详情里都打码；建了服务档案的照旧显示；店主都看得到', async () => {
    const plain = await createMember(ctx, '打码会员', '19900018001');
    const served = await createMember(ctx, '服务会员', '19900018002');
    await enroll(served.id);

    const list = await api(ctx.app, butler, 'GET', '/api/concierge/member-insights?q=1990001800');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const byId = new Map((list.body.members as { id: number; phone: string }[]).map((m) => [m.id, m.phone]));
    expect(byId.get(plain.id)).toBe('199 **** 8001');
    expect(byId.get(served.id)).toBe('19900018002');

    const one = await api(ctx.app, butler, 'GET', `/api/concierge/member-insights/${plain.id}`);
    expect(one.body.member.phone).toBe('199 **** 8001');
    const found = await api(ctx.app, butler, 'GET', `/api/concierge/native-members?q=${encodeURIComponent('打码会员')}`);
    expect(found.body.members[0]).toMatchObject({ id: plain.id, phone: '199 **** 8001' });
    const detail = await api(ctx.app, butler, 'GET', `/api/concierge/native-members/${plain.id}`);
    expect(detail.body.member.phone).toBe('199 **** 8001');
    // 打了码也照样按手机号找得到（查找在服务端做）
    const byPhone = await api(ctx.app, butler, 'GET', '/api/concierge/native-members?q=19900018001');
    expect(byPhone.body.members.map((m: { id: number }) => m.id)).toContain(plain.id);

    // 店主有会员查看权限：完整
    const owner = await api(ctx.app, ctx.owner, 'GET', `/api/concierge/member-insights/${plain.id}`);
    expect(owner.body.member.phone).toBe('19900018001');
    // 工作区里的服务档案（已建档）不打码
    const ws = (await api<WorkspaceData>(ctx.app, butler, 'GET', path)).body;
    expect(ws.members.find((m) => m.nativeMemberId === served.id)?.phone).toBe('19900018002');
  });
});

describe('会员摘要一批取', () => {
  it('给的是被合并的旧编号也落到主账号；不存在的编号不在结果里；工作区一次带出全部服务档案的摘要', async () => {
    const from = await createMember(ctx, '合并来源', '19900018011');
    const to = await createMember(ctx, '合并目标', '19900018012');
    const other = await createMember(ctx, '另一位', '19900018013');
    const profile = await enroll(from.id);
    await enroll(other.id);
    const check = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${from.id}/merge-check?targetId=${to.id}`)).body;
    const merged = await api(ctx.app, ctx.owner, 'POST', `/api/members/${from.id}/merge`, {
      clientKey: randomUUID(), targetId: to.id, reason: '同一位客人', expectedPrincipal: check.principal, expectedBonus: check.bonus,
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    const canonical = await canonicalMemberIds(ctx.sql, [from.id, to.id, other.id, 99_999_999]);
    expect(canonical.get(from.id)).toBe(to.id);
    expect(canonical.get(to.id)).toBe(to.id);
    expect(canonical.get(other.id)).toBe(other.id);
    expect(canonical.has(99_999_999)).toBe(false);

    const summaries = await nativeMemberSummaries(ctx.sql, [from.id, other.id, 99_999_999], 'Asia/Shanghai');
    expect(summaries.get(from.id)).toMatchObject({ id: to.id, name: '合并目标', phone: '19900018012' });
    expect(summaries.get(from.id)!.profiles.map((p) => p.id)).toEqual([profile]);
    expect(summaries.get(other.id)).toMatchObject({ id: other.id, name: '另一位' });
    expect(summaries.has(99_999_999)).toBe(false);

    const ws = (await api<WorkspaceData>(ctx.app, butler, 'GET', path)).body;
    const mine = ws.members.find((m) => m.id === profile)!;
    // 服务档案记的还是当初关联的编号，身份投影到合并后的主账号
    expect(mine.nativeMemberId).toBe(from.id);
    expect(mine.nativeMember).toMatchObject({ id: to.id, name: '合并目标' });
    expect(mine.name).toBe('合并目标');
  });
});

describe('同步指纹', () => {
  it('已关联会员的钱包、资料变了指纹跟着变；没关联的会员变了不变', async () => {
    const linked = await createMember(ctx, '指纹会员', '19900018021');
    const stranger = await createMember(ctx, '路人会员', '19900018022');
    await enroll(linked.id);
    const r0 = await revision();
    expect(await revision()).toBe(r0);

    const edit = await api(ctx.app, ctx.owner, 'PUT', `/api/members/${stranger.id}`, { name: '路人改名', phone: '19900018022' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(await revision()).toBe(r0);

    const rename = await api(ctx.app, ctx.owner, 'PUT', `/api/members/${linked.id}`, { name: '指纹改名', phone: '19900018021' });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
    expect(await revision()).not.toBe(r0);
  });
});

describe('不给原生表的行加锁', () => {
  it('别的事务锁着空间一行、会员一行时，管家照样能保存预约与建档（原来会等到超时）', async () => {
    const [floor] = await ctx.sql<{ id: number }[]>`SELECT id FROM floors ORDER BY id LIMIT 1`;
    const [zone] = await ctx.sql<{ id: number }[]>`INSERT INTO zones(floor_id,name) VALUES(${floor!.id},'整合专区') RETURNING id`;
    const [space] = await ctx.sql<{ id: number }[]>`INSERT INTO spaces(code,floor_id,zone_id,business_type,capacity,display_name) VALUES('GJ1801',${floor!.id},${zone!.id},'按摩房',3,'听泉') RETURNING id`;
    const m = await createMember(ctx, '加锁会员', '19900018031');
    const second = await createMember(ctx, '加锁会员二', '19900018032');
    const profile = await enroll(m.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM spaces WHERE id=${space!.id} FOR NO KEY UPDATE`;
      await tx`SELECT id FROM members WHERE id=${second.id} FOR NO KEY UPDATE`;
      locked();
      await held;
    });
    await ready;
    try {
      const started = Date.now();
      const saved = await mutate('createAppointment', {
        memberId: profile, resourceKey: `space:${space!.id}`, service: '按摩', resource: '听泉',
        startAt: '2026-12-20T02:00:00Z', endAt: '2026-12-20T03:00:00Z', partySize: 2, hostId: '', status: '已确认',
      });
      const enrolled = await mutate('createMember', { nativeMemberId: second.id, joinedAt: '2026-11-14' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      release();
      await holder;
    }
  });
});

describe('自检', () => {
  it('协调预约的系统资源与关联列对不上时报出来', async () => {
    const before = await conciergeCheck(ctx.sql);
    expect(before.ok, before.detail).toBe(true);
    const m = await createMember(ctx, '自检会员', '19900018041');
    const profile = await enroll(m.id);
    const saved = await mutate('createAppointment', {
      memberId: profile, service: '茶歇', resource: '手写的地方',
      startAt: '2026-12-21T02:00:00Z', endAt: '2026-12-21T03:00:00Z', partySize: 1, hostId: '', status: '已确认',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await conciergeCheck(ctx.sql)).ok).toBe(true);
    // 绕过应用直接把 resourceKey 写歪（三列还是空的）：自检要报
    await ctx.sql`ALTER TABLE concierge_records DISABLE TRIGGER USER`;
    try {
      await ctx.sql`UPDATE concierge_records SET data = data || '{"resourceKey":"space:1"}'::jsonb WHERE id=${saved.body.id}::uuid`;
    } finally {
      await ctx.sql`ALTER TABLE concierge_records ENABLE TRIGGER USER`;
    }
    const after = await conciergeCheck(ctx.sql);
    expect(after.ok).toBe(false);
    expect(after.detail).toContain('系统资源与关联列不一致');
    await ctx.sql`ALTER TABLE concierge_records DISABLE TRIGGER USER`;
    try {
      await ctx.sql`UPDATE concierge_records SET data = data - 'resourceKey' WHERE id=${saved.body.id}::uuid`;
    } finally {
      await ctx.sql`ALTER TABLE concierge_records ENABLE TRIGGER USER`;
    }
    expect((await conciergeCheck(ctx.sql)).ok).toBe(true);
  });
});
