// 8.0.12 管家部 · 主线整改的回归（docs/HANDOFF_V8012.md「主线整改」）：Codex 写的 PR #96 合进主线分支后复查出的问题，逐条有用例。
// 用独立的测试库（TEST_DATABASE_URL），只有合成数据。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';
import { createStaff } from '../src/server/modules/staff';

let ctx: TestContext;
let butler = '';
let manager = '';
let butlerId = 0;

const endpoint = '/api/concierge/workspace';
const mutate = (cookie: string, action: string, payload: Record<string, unknown>, requestId = randomUUID()) =>
  api(ctx.app, cookie, 'POST', endpoint, { action, payload, requestId });
const revision = async () => (await api(ctx.app, butler, 'GET', '/api/concierge/revision')).body.revision as string;
const profile = (name: string, cardNo: string) => ({ name, phone: '', cardNo, ownerId: String(butlerId), cardTier: '', preferences: '', source: '整改回归', joinedAt: '2026-11-12' });
async function newMember(name: string, cardNo: string, extra: Record<string, unknown> = {}) {
  const nativeMemberId = extra.nativeMemberId ?? (await createMember(ctx, name)).id;
  const r = await mutate(butler, 'createMember', { ...profile(name, cardNo), nativeMemberId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
}
const versionOf = async (table: 'concierge_members' | 'concierge_records', id: string) =>
  (await ctx.sql.unsafe<{ version: number }[]>(`SELECT version FROM ${table} WHERE id = $1`, [id]))[0]!.version;

describe('8.0.12 管家部 · 主线整改', () => {
  beforeAll(async () => {
    ctx = await setup();
    butlerId = await createStaff(ctx.sql, { username: 'gj_butler', displayName: '整改管家', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
    await createStaff(ctx.sql, { username: 'gj_manager', displayName: '整改经理', role: 'backoffice', duties: ['concierge_manager'], password: PASSWORD, mustChangePassword: false });
    butler = await login(ctx.app, 'gj_butler');
    manager = await login(ctx.app, 'gj_manager');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('同步版本号是管家部自己的：别的模块记审计不动它；管家部每写一次加一，原样重提不加', async () => {
    const before = await revision();
    // 别的模块的审计（登录）：原来比的是全店 audit_logs 的最大编号，会让所有管家页面重新取整个工作区
    await login(ctx.app, 'gj_manager');
    await login(ctx.app, 'linlan').catch(() => undefined);
    expect(await revision()).toBe(before);
    const key = randomUUID();
    const body = { ...profile('版本号会员', 'GJ-REV-1'), nativeMemberId: (await createMember(ctx, '版本号会员')).id };
    const first = await mutate(butler, 'createMember', body, key);
    expect(first.status).toBe(200);
    expect(BigInt((await revision()).split(':')[0]!)).toBe(BigInt(before.split(':')[0]!) + 1n);
    const replay = await mutate(butler, 'createMember', body, key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(BigInt((await revision()).split(':')[0]!)).toBe(BigInt(before.split(':')[0]!) + 1n);
    // 被拒绝的请求不加
    expect((await mutate(butler, 'createMember', { ...body, joinedAt: 'invalid' })).status).toBe(400);
    expect(BigInt((await revision()).split(':')[0]!)).toBe(BigInt(before.split(':')[0]!) + 1n);
  });

  it('关联的企业会员后来被停用：管家档案照样能改；换成另一位停用的会员不行', async () => {
    const native = await createMember(ctx, '整改企业会员', '19900003001');
    const other = await createMember(ctx, '整改企业会员二', '19900003002');
    const id = await newMember('关联会员', 'GJ-LINK-1');
    // 管家没有会员查看权限：由店主来关联
    const linked = await mutate(ctx.owner, 'updateMember', { ...profile('关联会员', 'GJ-LINK-1'), id, version: 1, nativeMemberId: native.id, reason: '关联企业会员' });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id IN (${native.id}, ${other.id})`;
    // 页面每次保存都带着原来的关联
    const edit = await mutate(ctx.owner, 'updateMember', { ...profile('关联会员（改过）', 'GJ-LINK-1'), id, version: 2, nativeMemberId: native.id, reason: '改称呼' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const [row] = await ctx.sql<{ name: string; nativeMemberId: number }[]>`SELECT data->>'name' AS name, native_member_id FROM concierge_members WHERE id = ${id}`;
    expect(row).toEqual({ name: '整改企业会员', nativeMemberId: native.id });
    const relink = await mutate(ctx.owner, 'updateMember', { ...profile('关联会员（改过）', 'GJ-LINK-1'), id, version: 3, nativeMemberId: other.id, reason: '换关联' });
    expect(relink.status).toBe(400);
    expect(relink.body.error.message).toContain('不可用');
  });

  it('接待：关联的协调预约不能摘掉、不能换；预约状态只往前走，没变不重写', async () => {
    const memberId = await newMember('接待会员', 'GJ-VISIT-1');
    const appt = (startAt: string, endAt: string) => ({ memberId, startAt, endAt, partySize: 1, service: '管家协调', resource: '', status: '已确认', hostId: String(butlerId), note: '' });
    const a = await mutate(butler, 'createAppointment', appt('2026-11-13T02:00:00Z', '2026-11-13T03:00:00Z'));
    const b = await mutate(butler, 'createAppointment', appt('2026-11-14T02:00:00Z', '2026-11-14T03:00:00Z'));
    expect([a.status, b.status]).toEqual([200, 200]);
    const visit = { memberId, appointmentId: a.body.id, hostId: String(butlerId), partySize: 1, status: '接待中' };
    const v = await mutate(butler, 'saveVisit', visit);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const status = async () => (await ctx.sql<{ status: string }[]>`SELECT data->>'status' AS status FROM concierge_records WHERE id = ${a.body.id}`)[0]!.status;
    expect(await status()).toBe('已到店');
    expect(await versionOf('concierge_records', a.body.id)).toBe(2);
    // 再保存一次同样的接待：预约不再多写一版
    const again = await mutate(butler, 'saveVisit', { ...visit, id: v.body.id, version: 1, feedback: '补一句' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await versionOf('concierge_records', a.body.id)).toBe(2);
    // 摘掉、换一张：都不行（原来先传空摘掉、再挂另一张就绕过去了）
    const detach = await mutate(butler, 'saveVisit', { ...visit, id: v.body.id, version: 2, appointmentId: '' });
    expect(detach.status).toBe(400);
    expect(detach.body.error.message).toContain('不能换单');
    const swap = await mutate(butler, 'saveVisit', { ...visit, id: v.body.id, version: 2, appointmentId: b.body.id });
    expect(swap.status).toBe(400);
    // 预约已经「已完成」以后，再改还在「接待中」的接待：预约不退回「已到店」
    const done = await mutate(butler, 'updateAppointment', { ...appt('2026-11-13T02:00:00Z', '2026-11-13T03:00:00Z'), id: a.body.id, version: 2, status: '已完成', reason: '服务结束' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const late = await mutate(butler, 'saveVisit', { ...visit, id: v.body.id, version: 2, feedback: '事后补记' });
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(await status()).toBe('已完成');
    expect(await versionOf('concierge_records', a.body.id)).toBe(3);
  });

  it('凭证：拿不带明细的摘要去保存会被拒绝，库里的逐项明细与识别原文还在；支付分录只留认得的字段', async () => {
    const memberId = await newMember('凭证会员', 'GJ-RCPT-1');
    const draft = {
      memberId,
      number: 'GJ-RCPT-001',
      store: '合成店',
      occurredAt: '2026-11-12T02:00:00.000Z',
      kind: '结算单',
      status: '待核对',
      amount: '88.00',
      payments: [{ method: '微信', amount: '88.00', memberId: '', injected: '不该进库', nested: { a: 1 } }],
      items: [{ name: '合成项目', quantity: '1', unitPrice: '88.00', amount: '88.00', rawText: '合成项目 88.00' }],
      totals: { subtotal: '88.00', due: '88.00', rounding: '0.00', paid: '88.00' },
      details: {},
      warnings: [],
      uploadIds: [],
      rawText: '合成小票原文 合成项目 88.00',
      itemsText: '合成项目 88.00',
      note: '',
    };
    const saved = await mutate(butler, 'saveReceipt', draft);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const stored = async () => (await ctx.sql<{ data: { items: unknown[]; rawText: string; itemsText: string; payments: Record<string, unknown>[] } }[]>`SELECT data FROM concierge_records WHERE id = ${saved.body.id}`)[0]!.data;
    expect(Object.keys((await stored()).payments[0]!).sort()).toEqual(['amountCents', 'memberId', 'method', 'originalMethod']);
    // 列表里的摘要：没有 items / rawText / itemsText / warnings，页面拿它去保存时发的就是空的
    const wiped = await mutate(butler, 'saveReceipt', { ...draft, id: saved.body.id, version: 1, items: [], rawText: '', itemsText: '', warnings: [], note: '只想改个备注' });
    expect(wiped.status).toBe(409);
    expect(wiped.body.error.message).toContain('还没有载入');
    const after = await stored();
    expect(after.items).toHaveLength(1);
    expect(after.rawText).toBe('合成小票原文 合成项目 88.00');
    expect(await versionOf('concierge_records', saved.body.id)).toBe(1);
    // 带着完整明细的修改照常
    const ok = await mutate(butler, 'saveReceipt', { ...draft, id: saved.body.id, version: 1, note: '改了备注' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('作废的凭证不能当余额依据', async () => {
    const memberId = await newMember('依据会员', 'GJ-EVID-1');
    const r = await mutate(manager, 'saveReceipt', { memberId, number: 'GJ-VOID-001', store: '合成店', occurredAt: '2026-11-12T03:00:00.000Z', kind: '结算单', status: '已作废', amount: '10.00', payments: [], items: [], totals: {}, details: {}, warnings: [], uploadIds: [], rawText: '', itemsText: '', note: '', reason: '录错作废' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = await mutate(butler, 'saveBalance', { memberId, expectedBalanceId: null, amount: '50000.00', note: '人工核对', receiptIds: [r.body.id], uploadIds: [] });
    expect(b.status).toBe(400);
    expect(b.body.error.message).toContain('消费依据');
  });

  it('两种导出都留痕；审计里不放整段识别原文', async () => {
    const count = async () => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE target_type = 'concierge_export'`)[0]!.n;
    const before = await count();
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/concierge/audits/export', headers: { cookie: manager } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('新建会员');
    const backup = await api(ctx.app, manager, 'GET', '/api/concierge/backup');
    expect(backup.status).toBe(200);
    expect(await count()).toBe(before + 2);
    // 管家（没有导出权限）不能导出，也不留导出的审计
    expect((await api(ctx.app, butler, 'GET', '/api/concierge/backup')).status).toBe(403);
    expect(await count()).toBe(before + 2);
    const [big] = await ctx.sql<{ detail: { after: Record<string, unknown> } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'concierge_record' AND detail->>'objectType' = 'receipt' ORDER BY id LIMIT 1`;
    expect(big!.detail.after.rawText).toBeUndefined();
    expect(big!.detail.after.itemsText).toBeUndefined();
    expect(big!.detail.after.rawTextLength).toBeGreaterThan(0);
    // 完整的那一版在修订历史里
    const [rev] = await ctx.sql<{ snapshot: { rawText: string } }[]>`SELECT snapshot FROM concierge_revisions WHERE object_type = 'receipt' ORDER BY id LIMIT 1`;
    expect(rev!.snapshot.rawText).toContain('合成小票原文');
  });

  it('同事的登录名不发给页面；编号不是 UUID 当作不存在；NUL 字符明确拒绝（不是 500）', async () => {
    const ws = (await api(ctx.app, butler, 'GET', endpoint)).body as { team: { login: string; name: string }[]; user: { login: string } };
    expect(ws.team.length).toBeGreaterThan(1);
    expect(ws.team.every((t) => t.login === '')).toBe(true);
    expect(ws.user.login).toBe('gj_butler');
    expect((await api(ctx.app, butler, 'GET', '/api/concierge/receipts/not-a-uuid')).status).toBe(404);
    expect((await api(ctx.app, butler, 'GET', '/api/concierge/uploads/1%27%20OR%201=1')).status).toBe(404);
    expect((await api(ctx.app, butler, 'GET', '/api/concierge/audits/abc')).status).toBe(404);
    expect((await mutate(butler, 'saveNote', { memberId: 'x', content: '记录' })).status).toBe(404);
    const memberId = await newMember('字符会员', 'GJ-NUL-1');
    const nul = await mutate(butler, 'saveNote', { memberId, content: '带\u0000空字符' });
    expect(nul.status).toBe(400);
    expect(nul.body.error.message).toContain('无法保存的字符');
  });

  it('数据库保护：管家会员不能删、编号与建档信息不能改；记录的修改要带新的版本号', async () => {
    const id = await newMember('保护会员', 'GJ-GUARD-1');
    await expect(ctx.sql`DELETE FROM concierge_members WHERE id = ${id}`).rejects.toMatchObject({ code: 'P0001' });
    await expect(ctx.sql`UPDATE concierge_members SET data = '{}' WHERE id = ${id}`).rejects.toMatchObject({ code: 'P0001' });
    await expect(ctx.sql`UPDATE concierge_members SET created_by = ${ctx.ownerId}, version = version + 1 WHERE id = ${id}`).rejects.toMatchObject({ code: 'P0001' });
    const t = await mutate(butler, 'saveTask', { memberId: id, kind: '回访', status: '待处理', assigneeId: String(butlerId), category: '', content: '回访一下', dueAt: '2026-11-13T02:00:00Z', result: '', nextAction: '' });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    await expect(ctx.sql`UPDATE concierge_records SET data = data || '{"status":"已完成"}'::jsonb WHERE id = ${t.body.id}`).rejects.toMatchObject({ code: 'P0001' });
    await expect(ctx.sql`UPDATE concierge_sync SET revision = -1`).rejects.toMatchObject({ code: '23514' });
  });

  it('自检：管家部的记录与修订历史一致；被绕过应用改过的认得出', async () => {
    const mine = async () => ((await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[]).find((c) => c.key === 'concierge_records')!;
    const ok = await mine();
    expect(ok.ok, ok.detail).toBe(true);
    expect(ok.detail).toContain('每一版都有修订快照');
    // 直接改库（带上新版本号能过触发器）但不留修订：自检认得出
    const [m] = await ctx.sql<{ id: string }[]>`SELECT id FROM concierge_members ORDER BY code LIMIT 1`;
    await ctx.sql`UPDATE concierge_members SET version = version + 1 WHERE id = ${m!.id}`;
    const broken = await mine();
    expect(broken.ok).toBe(false);
    expect(broken.detail).toContain('管家会员');
  });
});
