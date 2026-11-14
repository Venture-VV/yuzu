import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';
import { createStaff } from '../src/server/modules/staff';
import type { PraiseCenterData, PraisePage, PraiseRecord } from '../src/shared/concierge/praise-types';
import { todayIn } from '../src/server/lib/dates';

let ctx: TestContext, butler = '', manager = '', a = 0, b = 0, managerId = 0;
let uploadId = '', profileA = '', profileB = '', today = '', oldDay = '', oldMonth = '';
const base = '/api/concierge/praise';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=';
const mutate = (cookie: string, action: string, payload: Record<string, unknown>, requestId = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/concierge/workspace', { action, payload, requestId });
const body = (extra: Record<string, unknown> = {}) => ({
  staffId: String(a), occurredOn: today, source: '现场反馈', content: '仅用于独立测试库的合成好评', guestName: '匿名客人', uploadIds: [uploadId], ...extra,
});
async function save(extra: Record<string, unknown> = {}) {
  const r = await mutate(butler, 'savePraise', body(extra));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
}
async function detail(id: string, cookie = butler) {
  const r = await api<PraiseRecord>(ctx.app, cookie, 'GET', `${base}/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function center() {
  const r = await api<PraiseCenterData>(ctx.app, butler, 'GET', `${base}/center`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function profile(name: string, phone: string) {
  const native = await createMember(ctx, name, phone);
  const r = await mutate(butler, 'createMember', { name, phone, cardNo: '', ownerId: String(a), nativeMemberId: native.id, joinedAt: today });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
}

describe('管家好评中心：企业身份、凭证、幂等与按月统计', () => {
  beforeAll(async () => {
    ctx = await setup();
    a = await createStaff(ctx.sql, { username: 'praise-a', displayName: '合成管家甲', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
    b = await createStaff(ctx.sql, { username: 'praise-b', displayName: '合成管家乙', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
    managerId = await createStaff(ctx.sql, { username: 'praise-manager', displayName: '合成管家经理', role: 'backoffice', duties: ['concierge_manager'], password: PASSWORD, mustChangePassword: false });
    butler = await login(ctx.app, 'praise-a'); manager = await login(ctx.app, 'praise-manager');
    today = todayIn(ctx.config.timezone);
    const date = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); date.setUTCDate(0);
    oldDay = date.toISOString().slice(0, 10); oldMonth = oldDay.slice(0, 7);
    const photo = await api(ctx.app, butler, 'POST', '/api/concierge/uploads', { files: [{ mime: 'image/png', data: png }] });
    expect(photo.status).toBe(201); uploadId = photo.body.uploads[0].id;
    profileA = await profile('合成客人甲', '19900002001'); profileB = await profile('合成客人乙', '19900002002');
  });
  afterAll(async () => { await ctx?.close(); });

  it('沿用企业会话；普通收银员及未登录不能看历史、榜单或原图', async () => {
    for (const url of [`${base}/center`, base, `/api/concierge/uploads/${uploadId}`]) {
      expect((await api(ctx.app, null, 'GET', url)).status).toBe(401);
      expect((await api(ctx.app, ctx.clerk, 'GET', url)).status).toBe(403);
    }
    expect((await mutate(ctx.clerk, 'savePraise', body())).status).toBe(403);
    const response = await ctx.app.inject({ url: `${base}/center`, headers: { cookie: butler } });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('真实管家候选不把仅有查看权限的店主算作员工，空库无伪造榜单', async () => {
    const data = await center();
    expect(data.staff.map((row) => row.id)).toEqual([a, b, managerId].map(String));
    expect(data.staff.some((row) => row.id === String(ctx.ownerId))).toBe(false);
    expect(data.monthCount).toBe(0);
    expect(data.previousMonthRanking.every((row) => row.count === 0 && row.rank === null)).toBe(true);
    expect((await mutate(butler, 'savePraise', body({ staffId: String(ctx.ownerId) }))).status).toBe(400);
    expect((await mutate(butler, 'savePraise', body({ staffId: '99999999' }))).status).toBe(400);
  });

  it('必须有真实私有凭证与有效日期，未来、空内容及缺图明确拒绝', async () => {
    const tomorrow = new Date(`${today}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    for (const extra of [
      { uploadIds: [] }, { uploadIds: [randomUUID()] }, { occurredOn: tomorrow.toISOString().slice(0, 10) },
      { occurredOn: '2026-02-30' }, { content: ' ' }, { source: '' }, { guestName: '' },
      { uploadIds: Array.from({ length: 13 }, () => randomUUID()) },
    ]) expect((await mutate(butler, 'savePraise', body(extra))).status, JSON.stringify(extra)).toBe(400);
  });

  it('通用原图可关联客人；原图绑定别的会员时不得借用', async () => {
    const id = await save({ memberId: profileA });
    expect(await detail(id)).toMatchObject({ memberId: profileA, memberName: '合成客人甲', uploadIds: [uploadId] });
    const bound = await api(ctx.app, butler, 'POST', '/api/concierge/uploads', { memberId: profileA, files: [{ mime: 'image/png', data: png }] });
    expect(bound.status).toBe(201);
    const boundId = bound.body.uploads[0].id;
    expect((await mutate(butler, 'savePraise', body({ memberId: profileB, uploadIds: [boundId] }))).status).toBe(400);
    expect((await mutate(butler, 'savePraise', body({ uploadIds: [boundId] }))).status).toBe(400);
    expect((await mutate(butler, 'savePraise', body({ memberId: profileA, uploadIds: [boundId] }))).status).toBe(200);
  });

  it('一条好评的多批照片仍受12MiB总量限制', async () => {
    const images = [1, 2, 3].map((marker) => {
      const bytes = Buffer.alloc(4 * 1024 * 1024); Buffer.from(png, 'base64').copy(bytes); bytes[bytes.length - 1] = marker;
      return { mime: 'image/png', data: bytes.toString('base64') };
    });
    const photos = await api(ctx.app, butler, 'POST', '/api/concierge/uploads', { files: images });
    expect(photos.status, JSON.stringify(photos.body)).toBe(201);
    const ids = photos.body.uploads.map((row: any) => row.id);
    expect((await mutate(butler, 'savePraise', body({ uploadIds: [...ids, uploadId] }))).status).toBe(400);
    expect((await mutate(butler, 'savePraise', body({ uploadIds: ids }))).status).toBe(200);
  });

  it('并发同操作编号只产生一条，原样重提查回一致，操作人由会话确定', async () => {
    const requestId = randomUUID(), payload = body({ content: '合成幂等好评', createdById: '999', createdByName: '伪造人' });
    const [one, two] = await Promise.all([mutate(butler, 'savePraise', payload, requestId), mutate(butler, 'savePraise', payload, requestId)]);
    expect(one.status, JSON.stringify(one.body)).toBe(200); expect(two.status).toBe(200); expect(two.body).toEqual(one.body);
    const record = await detail(one.body.id);
    expect(record).toMatchObject({ createdById: String(a), createdByName: '合成管家甲', status: 'active', version: 1 });
    const [count] = await ctx.sql`SELECT count(*)::int AS count FROM concierge_praise WHERE content='合成幂等好评'`;
    expect(count!.count).toBe(1);
    expect((await mutate(butler, 'savePraise', { ...payload, content: '换内容' }, requestId)).status).toBe(409);
    const found = await api(ctx.app, butler, 'GET', `/api/concierge/ops/${requestId}`);
    expect(found.body).toMatchObject({ found: true, response: one.body });
    expect((await api(ctx.app, manager, 'GET', `/api/concierge/ops/${requestId}`)).body).toEqual({ found: false });
  });

  it('沿用原操作编号的确认不再执行，不另开幂等表', async () => {
    const key = randomUUID();
    expect((await api(ctx.app, butler, 'POST', `/api/concierge/ops/${key}/abandon`)).status).toBe(200);
    expect((await mutate(butler, 'savePraise', body({ content: '不应执行' }), key)).status).toBe(409);
    const [row] = await ctx.sql`SELECT count(*)::int AS count FROM concierge_praise WHERE content='不应执行'`;
    expect(row!.count).toBe(0);
  });

  it('上月榜按发生日期及有效记录数统计，同数同名次，撤销后立即扣除', async () => {
    const ids = [];
    for (const employee of [a, a, b, b]) ids.push(await save({ staffId: String(employee), occurredOn: oldDay, content: `上月合成${employee}` }));
    let data = await center();
    expect(data.previousMonth).toBe(oldMonth); expect(data.previousMonthCount).toBe(4);
    const leaders = data.previousMonthRanking.filter((row) => row.count > 0);
    expect(leaders.map((row) => [row.count, row.rank])).toEqual([[2, 1], [2, 1]]);
    const id = ids[0]!;
    expect((await mutate(butler, 'voidPraise', { id, version: 1, reason: '普通管家不应撤销' })).status).toBe(403);
    expect((await mutate(manager, 'voidPraise', { id, version: 1, reason: '' })).status).toBe(400);
    expect((await mutate(manager, 'voidPraise', { id, version: 2, reason: '版本过期' })).status).toBe(409);
    const operation = randomUUID();
    const one = await mutate(manager, 'voidPraise', { id, version: 1, reason: '合成重复好评撤销' }, operation);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect((await mutate(manager, 'voidPraise', { id, version: 1, reason: '合成重复好评撤销' }, operation)).body).toEqual(one.body);
    expect(await detail(id)).toMatchObject({ status: 'voided', version: 2, voidedById: String(managerId), voidReason: '合成重复好评撤销', uploadIds: [uploadId] });
    data = await center(); expect(data.previousMonthCount).toBe(3);
    expect(data.previousMonthRanking.filter((row) => row.count > 0).map((row) => [row.id, row.count, row.rank])).toEqual([[String(b), 2, 1], [String(a), 1, 2]]);
    const revisions = await ctx.sql`SELECT version,reason FROM concierge_revisions WHERE object_type='praise' AND object_id=${id}::uuid ORDER BY version`;
    expect(revisions.map((row) => row.version)).toEqual([1, 2]); expect(revisions[1]!.reason).toBe('合成重复好评撤销');
  });

  it('停用员工退出录入候选，已有历史和上月榜保留', async () => {
    await ctx.sql`UPDATE staff SET active=false WHERE id=${b}`;
    const data = await center();
    expect(data.staff.some((row) => row.id === String(b))).toBe(false);
    expect(data.previousMonthRanking.find((row) => row.id === String(b))).toMatchObject({ active: false, count: 2, rank: 1 });
    expect((await mutate(butler, 'savePraise', body({ staffId: String(b) }))).status).toBe(400);
  });

  it('历史分页使用稳定游标，管家/月份/撤销筛选由服务端执行', async () => {
    const first = await api<PraisePage>(ctx.app, butler, 'GET', `${base}?month=${oldMonth}&staffId=${a}&status=all&limit=1`);
    expect(first.status).toBe(200); expect(first.body.records).toHaveLength(1); expect(first.body.nextCursor).toBeTruthy();
    const second = await api<PraisePage>(ctx.app, butler, 'GET', `${base}?month=${oldMonth}&staffId=${a}&status=all&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.status).toBe(200); expect(second.body.records).toHaveLength(1); expect(second.body.records[0]!.id).not.toBe(first.body.records[0]!.id); expect(second.body.nextCursor).toBeNull();
    const active = await api<PraisePage>(ctx.app, butler, 'GET', `${base}?month=${oldMonth}&staffId=${a}`);
    expect(active.body.records).toHaveLength(1); expect(active.body.records[0]!.status).toBe('active');
    expect((await api(ctx.app, butler, 'GET', `${base}?cursor=invalid`)).status).toBe(400);
    expect((await api(ctx.app, butler, 'GET', `${base}?month=2026-13`)).status).toBe(400);
    expect((await api(ctx.app, butler, 'GET', `${base}?limit=99`)).status).toBe(400);
  });

  it('同一毫秒内的多条记录按数据库微秒分页，不漏行', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await ctx.sql.begin(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx`INSERT INTO concierge_praise(id,staff_id,staff_name_snapshot,occurred_on,source,content,guest_name,created_by,created_at)
          VALUES(${id}::uuid,${managerId},'合成管家经理',${oldDay}::date,'分页边界合成样例','同毫秒不同微秒','匿名客人',${a},${`${today}T00:00:00.12345${6 - i}Z`}::timestamptz)`;
        await tx`INSERT INTO concierge_praise_evidence(praise_id,upload_id,position) VALUES(${id}::uuid,${uploadId}::uuid,0)`;
      }
    });
    let cursor = '';
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await api<PraisePage>(ctx.app, butler, 'GET', `${base}?month=${oldMonth}&staffId=${managerId}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.records).toHaveLength(1);
      seen.push(page.body.records[0]!.id); cursor = page.body.nextCursor || '';
    }
    expect(seen).toEqual(ids); expect(cursor).toBe('');
  });

  it('数据库拒绝删记录、改原始内容、删图和无图提交；旧小票与钱包不受影响', async () => {
    const id = await save({ content: '数据库保护合成好评' });
    await expect(ctx.sql`DELETE FROM concierge_praise WHERE id=${id}::uuid`).rejects.toThrow();
    await expect(ctx.sql`UPDATE concierge_praise SET content='覆盖原文',version=version+1 WHERE id=${id}::uuid`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM concierge_praise_evidence WHERE praise_id=${id}::uuid`).rejects.toThrow();
    await expect(ctx.sql`INSERT INTO concierge_praise(id,staff_id,staff_name_snapshot,occurred_on,source,content,guest_name,created_by) VALUES(${randomUUID()}::uuid,${a},'合成管家',${today}::date,'测试','没有原图','匿名客人',${a})`).rejects.toThrow();
    expect((await mutate(butler, 'savePraise', body({ id }))).status).toBe(400);
    const [counts] = await ctx.sql`SELECT (SELECT count(*)::int FROM concierge_records WHERE kind='receipt') AS receipts,(SELECT count(*)::int FROM consumptions) AS consumptions,(SELECT count(*)::int FROM ledger_entries) AS ledger`;
    expect(counts).toMatchObject({ receipts: 0, consumptions: 0, ledger: 0 });
    const photo = await ctx.app.inject({ url: `/api/concierge/uploads/${uploadId}`, headers: { cookie: butler } });
    expect(photo.statusCode).toBe(200); expect(photo.headers['cache-control']).toContain('no-store');
  });
});
