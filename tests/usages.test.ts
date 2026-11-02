// v0.7.19 · D37 / D39（docs/FLOORPLAN_FINISH.md 第 1 节）：派对房、宠物轰趴房、娱乐室「开单即占用」的使用单——
// 开单（在店客人的手牌、人数、备注）、同一间房只能一张、结束、撤单（写原因、更正时限）、使用人结账与撤销来访时自动结束、
// 平面图「使用中」、实时位置、空间台账停用与改业态的拦截、业态规则、操作编号（重提、查回、作废）、并发开单、自检与对账包、权限。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceStatus, type FloorMapData, type FloorMapSpace } from '../src/shared/floormap';
import type { LocationsCurrent } from '../src/shared/locations';
import type { SpaceLedger } from '../src/shared/spaces';
import type { UsageDetail } from '../src/shared/usages';
import { frontdeskChecks } from '../src/server/modules/frontdesk/checks';
import { buildDailyRecon } from '../src/server/ops/recon';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: string; // 客户经理：没有客房权限
let tagNo = 0;

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L2,合成娱乐区,Sample Fun,合成样例'].join('\r\n');
const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L2,X,X201,派对房,12,合成派对房,,合成派对房 X201,',
  'L2,X,X202,宠物轰趴房,8,合成宠物房,,合成宠物轰趴房 X202,',
  'L2,X,X203,娱乐室,6,合成娱乐室,,合成娱乐室 X203,',
  'L2,X,X204,派对房,6,合成派对房停售,,合成派对房 X204,',
  'L2,S,S201,SPA,1,合成SPA,,合成 SPA S201,',
].join('\r\n');

const ledger = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body as SpaceLedger;
const spaceOf = async (code: string) => (await ledger()).spaces.find((s) => s.code === code)!;
const sid: Record<string, number> = {};
const editSpace = async (code: string, patch: Record<string, unknown>) => {
  const s = await spaceOf(code);
  return api(ctx.app, ctx.owner, 'PUT', `/api/admin/spaces/${s.id}`, {
    floorId: s.floorId,
    zoneId: s.zoneId,
    businessType: s.businessType,
    capacity: s.capacity,
    areaCentiM2: s.areaCentiM2,
    displayName: s.displayName,
    nameEn: s.nameEn,
    sellable: s.sellable,
    sourceLabel: s.sourceLabel,
    note: s.note,
    active: s.active,
    version: s.version,
    ...patch,
  });
};
const enter = async () => {
  tagNo += 1;
  const code = `U${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, tagCode: code };
};
const open = (body: Record<string, unknown>, cookie = ctx.clerk, clientKey = randomUUID()) => api(ctx.app, cookie, 'POST', '/api/usages', { clientKey, guests: 4, ...body });
const end = (id: number, cookie = ctx.clerk, clientKey = randomUUID()) => api(ctx.app, cookie, 'POST', `/api/usages/${id}/end`, { clientKey });
const cancel = (id: number, reason: string, cookie = ctx.clerk, clientKey = randomUUID()) => api(ctx.app, cookie, 'POST', `/api/usages/${id}/cancel`, { clientKey, reason });
const map = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/floormap')).body as FloorMapData;
const stateOf = async (code: string) => {
  const m = await map();
  const s = m.spaces.find((x) => x.code === code)!;
  return spaceStatus(s, undefined, m.sessions, m.usages, m.usageTypes).state;
};
const where = async (visitId: number) => ((await api(ctx.app, ctx.owner, 'GET', '/api/locations/current')).body as LocationsCurrent).people.find((p) => p.kind === 'guest' && p.id === visitId) ?? null;
const pay = async (visitId: number) => {
  const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: [{ method: 'cash', amount: preview.totalAmount }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return preview;
};
const usageCheck = async () => (await frontdeskChecks(ctx.sql)).find((c) => c.key === 'space_usages')!;
/** 结束这间房开着的使用单（前面的用例留下的） */
const freeUp = async (code: string) => {
  for (const x of (await map()).usages.filter((u) => u.spaceId === sid[code])) expect((await end(x.id)).status).toBe(200);
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  manager = await login(ctx.app, 'am');
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  expect((await editSpace('X204', { sellable: false })).status).toBe(200);
  for (const s of (await ledger()).spaces) sid[s.code] = s.id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'U', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  // 实时位置开着（开单、结束推导位置）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/locations/rules', { enabled: true })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('状态口径（共用的纯函数）', () => {
  const sp = (patch: Partial<FloorMapSpace> = {}): FloorMapSpace => ({
    id: 7,
    code: 'X201',
    floorCode: 'L2',
    floorName: '二层',
    zoneId: null,
    zoneName: null,
    businessType: '派对房',
    capacity: 12,
    areaCentiM2: null,
    displayName: '合成派对房',
    sellable: true,
    active: true,
    aliases: [],
    roomId: null,
    ...patch,
  });
  const usage = { id: 1, usageNo: 'SY1', spaceId: 7, visitId: 1, tagCode: 'U001', guests: 4, note: '', openedAt: new Date().toISOString(), openedByName: '店员' };
  it('开单即占用的业态：没有使用单为空闲、有为使用中；停售为灰色（还有使用单的照样使用中）；不在规则里的业态只显示业态', () => {
    const types = ['派对房', '宠物轰趴房', '娱乐室'];
    expect(spaceStatus(sp(), undefined, [], [], types)).toMatchObject({ kind: 'usage', state: 'vacant', usage: null });
    expect(spaceStatus(sp(), undefined, [], [usage], types)).toMatchObject({ kind: 'usage', state: 'in_use', usage: { usageNo: 'SY1' } });
    expect(spaceStatus(sp({ sellable: false }), undefined, [], [], types).state).toBe('off');
    expect(spaceStatus(sp({ active: false }), undefined, [], [usage], types).state).toBe('in_use');
    expect(spaceStatus(sp(), undefined, [], [], ['娱乐室'])).toMatchObject({ kind: 'other', state: 'other' });
    // 规则里去掉了这个业态，开着的使用单照样显示使用中，结束后才变
    expect(spaceStatus(sp(), undefined, [], [usage], ['娱乐室']).state).toBe('in_use');
    expect(spaceStatus(sp({ businessType: '客房' }), undefined, [], [], ['客房']).kind).toBe('room');
  });
});

describe('开单、结束、撤单', () => {
  it('开单：在店客人的手牌、人数、备注；平面图使用中；使用人在那间房；同一间房再开拒绝', async () => {
    const g = await enter();
    expect(await stateOf('X201')).toBe('vacant');
    const r = await open({ spaceId: sid.X201, tagCode: g.tagCode.toLowerCase(), note: '合成生日会' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const u = r.body as UsageDetail;
    expect(u).toMatchObject({ spaceCode: 'X201', businessType: '派对房', tagCode: g.tagCode, visitStatus: 'open', guests: 4, note: '合成生日会', status: 'open', closedAt: null, openedByName: '测试店员' });
    expect(u.usageNo).toMatch(/^SY\d{8}-0001$/);
    expect(await stateOf('X201')).toBe('in_use');
    const m = await map();
    expect(m.usageTypes).toEqual(['派对房', '宠物轰趴房', '娱乐室']);
    expect(m.usages).toEqual([expect.objectContaining({ id: u.id, spaceId: sid.X201, visitId: g.visitId, tagCode: g.tagCode, guests: 4 })]);
    // 只带手牌号，不带会员姓名、手机号
    expect(Object.keys(m.usages[0]!).sort()).toEqual(['guests', 'id', 'note', 'openedAt', 'openedByName', 'spaceId', 'tagCode', 'usageNo', 'visitId']);
    expect(await where(g.visitId)).toMatchObject({ spaceCode: 'X201', lastSource: 'usage_open' });

    const g2 = await enter();
    const again = await open({ spaceId: sid.X201, tagCode: g2.tagCode });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('USAGE_TAKEN');
    expect(again.body.error.message).toContain(u.usageNo);
    // 同一位客人可以同时开另一间
    expect((await open({ spaceId: sid.X203, tagCode: g.tagCode })).status).toBe(200);
    expect((await usageCheck()).ok).toBe(true);
  });

  it('开单的拒绝：手牌不在店、业态不按开单即占用、停售、人数超限、没有客房权限', async () => {
    const g = await enter();
    expect((await open({ spaceId: sid.X202, tagCode: 'U039' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    expect((await open({ spaceId: sid.S201, tagCode: g.tagCode })).body.error.code).toBe('USAGE_NOT_ALLOWED');
    expect((await open({ spaceId: sid.X204, tagCode: g.tagCode })).body.error.code).toBe('SPACE_INACTIVE');
    expect((await open({ spaceId: sid.X202, tagCode: g.tagCode, guests: 100 })).status).toBe(400);
    expect((await open({ spaceId: 999999, tagCode: g.tagCode })).status).toBe(404);
    expect((await open({ spaceId: sid.X202, tagCode: g.tagCode }, manager)).status).toBe(403);
    expect((await api(ctx.app, manager, 'GET', '/api/floormap')).status).toBe(403);
  });

  it('结束使用：房间空闲、使用人离开那间房（位置不明）；再结束、再撤单拒绝；使用单只追加', async () => {
    const g = await enter();
    const u = (await open({ spaceId: sid.X202, tagCode: g.tagCode })).body as UsageDetail;
    expect(await stateOf('X202')).toBe('in_use');
    const r = await end(u.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'closed', closeKind: 'end', closedByName: '测试店员', closeReason: null });
    expect(await stateOf('X202')).toBe('vacant');
    const loc = await where(g.visitId);
    expect(loc === null || loc.spaceCode === null).toBe(true);
    expect((await end(u.id)).body.error.code).toBe('USAGE_CLOSED');
    expect((await cancel(u.id, '开错了')).body.error.code).toBe('USAGE_CLOSED');
    await expect(ctx.sql`UPDATE space_usages SET note = 'x' WHERE id = ${u.id}`).rejects.toThrow('使用单已经结束');
    await expect(ctx.sql`DELETE FROM space_usages WHERE id = ${u.id}`).rejects.toThrow('使用单不能删除');
    // 结束后可以再开
    expect((await open({ spaceId: sid.X202, tagCode: g.tagCode })).status).toBe(200);
  });

  it('撤单：写原因（至少 2 个字）；店员只能撤自己开的，店主都能撤', async () => {
    const g = await enter();
    await freeUp('X201');
    const u = (await open({ spaceId: sid.X201, tagCode: g.tagCode }, ctx.owner)).body as UsageDetail;
    expect(u.openedByName).toBe('测试店主');
    expect((await cancel(u.id, '错')).status).toBe(400);
    const denied = await cancel(u.id, '开错了房间');
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('不是你登记的');
    const r = await cancel(u.id, '开错了房间', ctx.owner);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'cancelled', closeKind: 'cancel', closeReason: '开错了房间', closedByName: '测试店主' });
    expect(await stateOf('X201')).toBe('vacant');
  });
});

describe('使用人结账、撤销来访', () => {
  it('结账：预览提示开着的使用单；结账后自动结束（结束方式「使用人结账」），房间空闲，使用人离店；审计记下使用单号', async () => {
    const g = await enter();
    await freeUp('X201');
    const u = (await open({ spaceId: sid.X201, tagCode: g.tagCode })).body as UsageDetail;
    const preview = await pay(g.visitId);
    expect(preview.usages).toEqual([{ usageId: u.id, usageNo: u.usageNo, tagCode: g.tagCode, spaceCode: 'X201', spaceName: '合成派对房' }]);
    const after = (await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${u.id}`)).body as UsageDetail;
    expect(after).toMatchObject({ status: 'closed', closeKind: 'checkout', visitStatus: 'settled', closedByName: '测试店员' });
    expect(await stateOf('X201')).toBe('vacant');
    expect(await where(g.visitId)).toBeNull();
    const [audit] = await ctx.sql<{ detail: { usages?: string[] } }[]>`SELECT detail FROM audit_logs WHERE action = 'frontdesk_checkout' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.usages).toEqual([u.usageNo]);
    expect((await usageCheck()).ok).toBe(true);
  });

  it('撤销来访（误开的牌）：一起结束使用单（结束方式「撤销来访」）', async () => {
    const g = await enter();
    await freeUp('X202');
    const usage = (await open({ spaceId: sid.X202, tagCode: g.tagCode })).body as UsageDetail;
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${g.visitId}/cancel`, { reason: '合成误开' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${usage.id}`)).body).toMatchObject({ status: 'closed', closeKind: 'visit_cancel', visitStatus: 'cancelled' });
    expect(await stateOf('X202')).toBe('vacant');
    expect((await usageCheck()).ok).toBe(true);
  });
});

describe('空间台账、业态规则', () => {
  it('有开着的使用单时不能停用、不能改业态；结束后可以', async () => {
    const g = await enter();
    await freeUp('X203');
    const u = (await open({ spaceId: sid.X203, tagCode: g.tagCode })).body as UsageDetail;
    const off = await editSpace('X203', { active: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('SPACE_HAS_USAGE');
    expect((await editSpace('X203', { businessType: '派对房' })).body.error.code).toBe('SPACE_HAS_USAGE');
    expect((await editSpace('X203', { displayName: '合成娱乐室改名' })).status).toBe(200);
    expect((await end(u.id)).status).toBe(200);
    expect((await editSpace('X203', { businessType: '派对房' })).status).toBe(200);
    expect((await editSpace('X203', { businessType: '娱乐室' })).status).toBe(200);
  });

  it('业态规则：店主可改（不能含客房、技师服务类）；改了以后只有规则里的业态能开单；规则总表列出（待确认）', async () => {
    const g = await enter();
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房'] })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', '客房'] })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', 'SPA'] })).status).toBe(400);
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', '派对房', '娱乐室'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ businessTypes: ['派对房', '娱乐室'] });
    expect((await open({ spaceId: sid.X202, tagCode: g.tagCode })).body.error.code).toBe('USAGE_NOT_ALLOWED');
    expect(await stateOf('X202')).toBe('other');
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; group: string; isDefault: boolean; pending: boolean; section: string; updatedBy: string | null }[];
    expect(catalog.find((x) => x.key === 'usage_rules.businessTypes')).toMatchObject({ group: 'floormap', isDefault: false, pending: true, section: 'spaces', updatedBy: '测试店主' });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', '宠物轰趴房', '娱乐室'] })).status).toBe(200);
    expect(await stateOf('X202')).toBe('vacant');
  });
});

describe('操作编号与并发', () => {
  it('同一编号重提只生效一次；按编号查回；改了内容拒绝；确认作废后原请求不再生效', async () => {
    const g = await enter();
    await freeUp('X201');
    const key = randomUUID();
    const first = await open({ spaceId: sid.X201, tagCode: g.tagCode }, ctx.clerk, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await open({ spaceId: sid.X201, tagCode: g.tagCode }, ctx.clerk, key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect((await open({ spaceId: sid.X201, tagCode: g.tagCode, guests: 5 }, ctx.clerk, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const found = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=usage_open`)).body;
    expect(found).toMatchObject({ found: true, type: 'usage_open', usage: { id: first.body.id, status: 'open' } });

    // 结束时断网：作废编号后，原请求即使到达也不生效
    const endKey = randomUUID();
    const fenced = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${endKey}/abandon`, { type: 'usage_end' });
    expect(fenced.body).toEqual({ found: false, abandoned: true });
    expect((await end(first.body.id, ctx.clerk, endKey)).body.error.code).toBe('OP_ABANDONED');
    expect(await stateOf('X201')).toBe('in_use');
    // 没有客房权限的人不能作废使用单的操作
    expect((await api(ctx.app, manager, 'POST', `/api/frontdesk/ops/${randomUUID()}/abandon`, { type: 'usage_open' })).status).toBe(403);
    const done = await end(first.body.id);
    expect(done.status).toBe(200);
    const endFound = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${endKey}?type=usage_end`)).body;
    expect(endFound).toEqual({ found: false, abandoned: true });
  });

  it('两台终端同时给同一间房开单：只有一张成功，另一张提示已被占用', async () => {
    const a = await enter();
    const b = await enter();
    await freeUp('X203');
    const [r1, r2] = await Promise.all([open({ spaceId: sid.X203, tagCode: a.tagCode }), open({ spaceId: sid.X203, tagCode: b.tagCode })]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('USAGE_TAKEN');
    expect((await map()).usages.filter((u) => u.spaceId === sid.X203)).toHaveLength(1);
  });

  it('结账与开单同时进行：要么开单成功后随结账结束，要么开单因客人已离店被拒；没有留下离店客人开着的使用单', async () => {
    for (let i = 0; i < 3; i += 1) {
      const g = await enter();
      await freeUp('X202');
      const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${g.visitId}`)).body;
      const [o, c] = await Promise.all([
        open({ spaceId: sid.X202, tagCode: g.tagCode }),
        api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/checkouts', {
          clientKey: randomUUID(),
          visitIds: [g.visitId],
          expectedTotal: preview.totalAmount,
          payments: [{ method: 'cash', amount: preview.totalAmount }],
        }),
      ]);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      if (o.status === 200) expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages/${o.body.id}`)).body.status).toBe('closed');
      else expect(['TAG_NOT_IN_STORE', 'VISIT_CLOSED']).toContain(o.body.error.code);
      expect((await usageCheck()).ok).toBe(true);
    }
  });
});

describe('自检、对账包、列表', () => {
  it('自检：离店客人还有开着的使用单时报出来', async () => {
    const g = await enter();
    await freeUp('X201');
    const u = (await open({ spaceId: sid.X201, tagCode: g.tagCode })).body as UsageDetail;
    expect((await usageCheck()).ok).toBe(true);
    // 绕过业务直接把来访改成已结账（模拟数据被改坏），在一个事务里核对后回滚
    const rollback = new Error('rollback');
    await expect(
      ctx.sql.begin(async (tx) => {
        await tx`ALTER TABLE visits DISABLE TRIGGER visits_guard`;
        await tx`UPDATE visits SET status = 'settled', closed_at = now() WHERE id = ${g.visitId}`;
        const bad = (await frontdeskChecks(tx)).find((c) => c.key === 'space_usages')!;
        expect(bad.ok).toBe(false);
        expect(bad.detail).toContain(u.usageNo);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await end(u.id)).status).toBe(200);
    expect((await usageCheck()).ok).toBe(true);
  });

  it('当天的使用单列表与对账包 08-使用单.csv：房间、手牌、结束方式、撤单原因', async () => {
    const [today] = await ctx.sql<{ d: string }[]>`SELECT business_date::text AS d FROM space_usages ORDER BY id LIMIT 1`;
    const list = (await api(ctx.app, ctx.clerk, 'GET', `/api/usages?date=${today!.d}`)).body as UsageDetail[];
    expect(list.length).toBeGreaterThan(5);
    expect(list.some((u) => u.closeKind === 'cancel' && u.closeReason === '开错了房间')).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/usages?date=${today!.d}&spaceId=${sid.X201}`)).body.every((u: UsageDetail) => u.spaceCode === 'X201')).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/usages?date=bad')).status).toBe(400);
    const recon = await buildDailyRecon(ctx.sql, ctx.config, today!.d);
    const f08 = recon.files.find((f) => f.name === '08-使用单.csv')!.content;
    expect(f08).toContain('使用单,房间,名称,业态,使用人手牌');
    expect(f08).toContain('开错了房间');
    expect(f08).toContain('使用人结账');
    expect(f08).toContain('撤销来访');
    expect(recon.files.find((f) => f.name === '00-说明.txt')!.content).toContain('派对房等使用单');
  });
});
