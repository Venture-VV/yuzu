// UI 工作台 8.1.2 第 4 步（docs/WORKBENCH_V811.md 第 13 节）：定时发布（到点才换、没生效前能撤，GZ27）、批注（GZ28）、
// 「谁在改」、设计包（导出、导进来：图按内容重新核对）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultStudioDoc, type StudioDoc, type StudioNode, type StudioPack } from '../src/shared/studio';
import { createStaff } from '../src/server/modules/staff';
import { studioPublishedRef } from '../src/server/modules/studio/published';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let designer: string;
let designer2: string;
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9Qz8DAwMAAAA4AAf8Y9gqmAAAAAElFTkSuQmCC';
const svg = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40" height="20">${inner}</svg>`).toString('base64');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const base = { name: '', rotate: 0, opacity: 1, hidden: false, locked: false };

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'sheji1', displayName: '设计师甲', role: 'designer', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'sheji2', displayName: '设计师乙', role: 'designer', password: PASSWORD, mustChangePassword: false });
  designer = await login(ctx.app, 'sheji1');
  designer2 = await login(ctx.app, 'sheji2');
}, 60_000);
afterAll(async () => ctx.close());

const d = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, who = designer) => api<T>(ctx.app, who, method, url, payload);

/** 改一下草稿再发布（可以定时） */
async function publishWith(change: (doc: StudioDoc) => void, note: string, effectiveAt?: string) {
  const s = (await d('GET', '/api/studio/emenu')).body;
  const doc = clone(s.draft.doc) as StudioDoc;
  change(doc);
  const saved = await d('PUT', '/api/studio/emenu/draft', { rev: s.draft.rev, doc });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return d('POST', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: saved.body.rev, note, ...(effectiveAt ? { effectiveAt } : {}) });
}
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('定时发布（GZ27）', () => {
  it('现在发布的马上生效；定在以后的到点前不换、写在「定时」里；时间太近、太远的拒绝', async () => {
    const now1 = await publishWith((doc) => (doc.theme.colors.tan = '#8a6d3b'), '现在换强调色');
    expect(now1.status, JSON.stringify(now1.body)).toBe(200);
    expect(now1.body.effectiveAt).toBeNull();
    expect((await studioPublishedRef(ctx.sql, 'emenu'))?.version).toBe(now1.body.version);

    const later = await publishWith((doc) => (doc.theme.colors.tan = '#6b5232'), '周末再换深一点', inMinutes(120));
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body.effectiveAt).not.toBeNull();
    // 还没到点：平板照旧用上一版
    expect((await studioPublishedRef(ctx.sql, 'emenu'))?.version).toBe(now1.body.version);
    const s = (await d('GET', '/api/studio/emenu')).body;
    expect(s.published.version).toBe(now1.body.version);
    expect(s.scheduled.map((v: { version: number }) => v.version)).toEqual([later.body.version]);
    const list = (await d('GET', '/api/studio/emenu/versions')).body as { version: number; current: boolean }[];
    expect(list.find((v) => v.current)?.version).toBe(now1.body.version);
    // 后台「工作台」首页写着下一次定时换版
    const overview = (await d('GET', '/api/studio')).body.surfaces as { surface: string; scheduled: { version: number } | null }[];
    expect(overview.find((x) => x.surface === 'emenu')?.scheduled?.version).toBe(later.body.version);
    expect(overview.find((x) => x.surface === 'mp')?.scheduled).toBeNull();

    const tooSoon = await publishWith((doc) => (doc.theme.colors.tan = '#6b5233'), '一分钟后', inMinutes(1));
    expect([tooSoon.status, tooSoon.body.error.code]).toEqual([422, 'STUDIO_SCHEDULE']);
    const tooFar = await publishWith((doc) => (doc.theme.colors.tan = '#6b5234'), '一百天后', inMinutes(100 * 1440));
    expect([tooFar.status, tooFar.body.error.code]).toEqual([422, 'STUDIO_SCHEDULE']);
    const badTime = await d('POST', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: s.draft.rev, note: 'x', effectiveAt: '明天' });
    expect(badTime.status).toBe(400);
  });

  it('到点的定时那一版生效（到点前又发的一版，到点照样换成定时的）；撤销没生效的、撤过的原样返回；生效了的、不是定时的撤不了', async () => {
    const versions = (await d('GET', '/api/studio/emenu/versions')).body as { id: number; version: number; effectiveAt: string | null }[];
    const pending = versions.find((v) => v.effectiveAt)!;
    // 撤销：没生效的能撤；再撤一次原样返回
    const c1 = await d('POST', `/api/studio/emenu/versions/${pending.version}/cancel`, { reason: '改主意了' });
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body.cancelledAt).not.toBeNull();
    expect(c1.body.cancelledBy).toBe('设计师甲');
    expect((await d('POST', `/api/studio/emenu/versions/${pending.version}/cancel`, {})).body.cancelledAt).toBe(c1.body.cancelledAt);
    expect((await d('GET', '/api/studio/emenu')).body.scheduled).toEqual([]);
    // 不是定时的、没有的撤不了
    const live = versions.find((v) => !v.effectiveAt)!;
    expect((await d('POST', `/api/studio/emenu/versions/${live.version}/cancel`, {})).body.error.code).toBe('STUDIO_NOT_SCHEDULED');
    expect((await d('POST', '/api/studio/emenu/versions/999/cancel', {})).status).toBe(404);
    // 店员没有发布权限
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/studio/emenu/versions/${pending.version}/cancel`, {})).status).toBe(403);

    // 模拟一版十分钟前定时发布、刚刚到点：生效时间比上面那一版的发布时间晚，现在用的是它（按生效时间排，不按版本号）
    const after = await publishWith((doc) => (doc.theme.colors.tan = '#7a5c3a'), '后来又发了一版');
    expect(after.status).toBe(200);
    const [me] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'sheji1'`;
    const staffId = me!.id;
    const doc = defaultStudioDoc('emenu');
    doc.theme.colors.tan = '#5c4632';
    const [row] = await ctx.sql<{ id: number }[]>`
      INSERT INTO studio_versions (surface, store_id, version, kind, doc, doc_hash, note, screens_changed, client_key, request_hash, published_by, published_at, effective_at)
      VALUES ('emenu', 1, ${after.body.version + 1}, 'publish', ${ctx.sql.json(doc as never)}, ${'a'.repeat(64)}, '定时的那一版', '{theme}', ${randomUUID()}, 'x', ${staffId},
              now() - interval '10 minutes', now())
      RETURNING id`;
    expect((await studioPublishedRef(ctx.sql, 'emenu'))?.id).toBe(Number(row!.id));
    // 已经生效了的撤不了
    const late = await d('POST', `/api/studio/emenu/versions/${after.body.version + 1}/cancel`, {});
    expect([late.status, late.body.error.code]).toEqual([422, 'STUDIO_ALREADY_LIVE']);
  });
});

describe('批注（GZ28）', () => {
  it('在画布上留言、回复、标解决与重新打开；同一个操作编号原样重提返回那一条；回复不能再回复', async () => {
    const key = randomUUID();
    const c1 = await d('POST', '/api/studio/emenu/comments', { clientKey: key, screen: 'start', nodeId: 'start-logo', x: 500, y: 380, body: '字标再往上一点？' });
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body).toMatchObject({ screen: 'start', nodeId: 'start-logo', x: 500, y: 380, body: '字标再往上一点？', createdBy: '设计师甲', resolvedAt: null });
    const again = await d('POST', '/api/studio/emenu/comments', { clientKey: key, screen: 'start', nodeId: 'start-logo', x: 500, y: 380, body: '字标再往上一点？' });
    expect(again.body.id).toBe(c1.body.id);
    const other = await d('POST', '/api/studio/emenu/comments', { clientKey: key, screen: 'start', x: 1, y: 1, body: '换了内容' });
    expect(other.status).toBe(409);

    const reply = await d('POST', '/api/studio/emenu/comments', { clientKey: randomUUID(), screen: 'start', x: 500, y: 380, parentId: c1.body.id, body: '好，挪了 20' }, designer2);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ parentId: c1.body.id, createdBy: '设计师乙' });
    const nested = await d('POST', '/api/studio/emenu/comments', { clientKey: randomUUID(), screen: 'start', x: 1, y: 1, parentId: reply.body.id, body: '回复的回复' });
    expect([nested.status, nested.body.error.code]).toEqual([422, 'STUDIO_COMMENT']);

    const openOf = async () => ((await d('GET', '/api/studio')).body.surfaces as { surface: string; openComments: number }[]).find((x) => x.surface === 'emenu')!.openComments;
    expect(await openOf()).toBe(1);
    const done = await d('POST', `/api/studio/comments/${c1.body.id}/resolve`, { resolved: true }, designer2);
    expect(done.body).toMatchObject({ resolvedBy: '设计师乙' });
    expect((await d('POST', `/api/studio/comments/${reply.body.id}/resolve`, { resolved: true })).status).toBe(404);
    expect(await openOf()).toBe(0);
    const reopened = await d('POST', `/api/studio/comments/${c1.body.id}/resolve`, { resolved: false });
    expect(reopened.body.resolvedAt).toBeNull();
    expect(await openOf()).toBe(1);

    const list = (await d('GET', '/api/studio/emenu/comments')).body as { id: number }[];
    expect(list.map((c) => c.id)).toEqual([c1.body.id, reply.body.id]);
    expect((await d('GET', '/api/studio/mp/comments')).body).toEqual([]);
    // 空的、太长的不收
    expect((await d('POST', '/api/studio/emenu/comments', { clientKey: randomUUID(), screen: 'start', x: 1, y: 1, body: '  ' })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/studio/emenu/comments')).status).toBe(403);
  });
});

describe('谁在改', () => {
  it('两个人开着同一个界面的编辑器：各自看得到对方，看不到自己；别的界面不算', async () => {
    expect((await d('POST', '/api/studio/emenu/presence')).body).toEqual([]);
    const seen = (await d('POST', '/api/studio/emenu/presence', undefined, designer2)).body as { name: string }[];
    expect(seen.map((p) => p.name)).toEqual(['设计师甲']);
    expect(((await d('POST', '/api/studio/emenu/presence')).body as { name: string }[]).map((p) => p.name)).toEqual(['设计师乙']);
    expect((await d('POST', '/api/studio/mp/presence')).body).toEqual([]);
  });
});

describe('设计包', () => {
  it('导出现在的草稿连同用到的图；导进来：图按内容重新核对、版面交回编辑器（不改草稿）；别的界面、被改过的图拒绝', async () => {
    const pic = (await d('POST', '/api/studio/assets', { name: '冬日海报.png', data: PNG_1x1 })).body.id as string;
    const s = (await d('GET', '/api/studio/mp')).body;
    const doc = clone(s.draft.doc) as StudioDoc;
    doc.screens.activity!.nodes.unshift({ type: 'image', id: 'poster', ...base, x: 0, y: 0, w: 375, h: 200, asset: pic, fit: 'cover', radius: 0, fill: null } as StudioNode);
    const saved = await d('PUT', '/api/studio/mp/draft', { rev: s.draft.rev, doc });
    expect(saved.status).toBe(200);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/studio/mp/pack', headers: { cookie: designer } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const pack = JSON.parse(res.body) as StudioPack;
    expect(pack).toMatchObject({ kind: 'yuzu-studio-pack', version: 1, surface: 'mp' });
    expect(pack.doc).toEqual(doc);
    expect(pack.assets.map((a) => a.id)).toEqual([pic]);

    // 导进来：版面原样交回，草稿不动
    const back = await d('POST', '/api/studio/mp/pack', pack);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ doc, assets: 1, added: 0 });
    expect((await d('GET', '/api/studio/mp')).body.draft.rev).toBe(saved.body.rev);

    // 设计包里带一张这里没有的图：存进素材库
    const extra = clone(pack);
    extra.assets.push({ id: (await import('node:crypto')).createHash('sha256').update(Buffer.from(PNG_2x1, 'base64')).digest('hex'), name: '新图.png', mime: 'image/png', data: PNG_2x1 });
    expect((await d('POST', '/api/studio/mp/pack', extra)).body.added).toBe(1);

    // 被改过的图、带脚本的 SVG、别的界面、格式不对：拒绝
    const tampered = clone(pack);
    tampered.assets[0]!.data = PNG_2x1;
    expect((await d('POST', '/api/studio/mp/pack', tampered)).body.error.code).toBe('STUDIO_PACK');
    const evil = clone(pack);
    evil.assets = [{ id: 'b'.repeat(64), name: 'x.svg', mime: 'image/svg+xml', data: svg('<script>alert(1)</script>') }];
    expect((await d('POST', '/api/studio/mp/pack', evil)).status).toBe(422);
    expect((await d('POST', '/api/studio/emenu/pack', pack)).body.error.code).toBe('STUDIO_PACK');
    expect((await d('POST', '/api/studio/mp/pack', { ...pack, kind: 'other' })).status).toBe(400);
    // 版面用到的图设计包里没有、这里也没有：拒绝
    const missing = clone(pack);
    (missing.doc.screens.activity!.nodes[0] as { asset: string }).asset = 'c'.repeat(64);
    expect((await d('POST', '/api/studio/mp/pack', missing)).body.error.code).toBe('STUDIO_PACK');
  });
});
