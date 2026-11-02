// 空间台账（飞书需求 RQ-004 第一段，v0.7.14，见 docs/SPACES.md）：楼层 → 区域 → 空间、别名（只追加）、核对状态、
// 导入（先预览；有错整份不写；编码已存在不覆盖并列出差异；同一个文件只写一次；操作编号）、导出、只读树、
// 客房房间挂接空间（房号 = 编码；换挂、取消挂接要写原因；有人住不改挂接）、自检。
// 文件内容全是合成样例（不是门店真实台账；真实台账由店主同意后在门店环境导入）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpaceImportPreview, SpaceLedger, SpaceTree } from '../src/shared/spaces';
import { areaText, parseArea, parseCapacity, verifyStatusFromNote } from '../src/shared/spaces';
import { spaceChecks } from '../src/server/modules/spaces';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let duty: string;
let roomType = 0;
const room: Record<string, number> = {};

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L3,合成SPA区,Sample SPA,合成样例', 'L3,合成客房区,Sample Rooms,', 'L2,合成派对区,Sample Party,'].join('\r\n');
const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L3,S,S301,SPA,1,合成SPA 1人间,,合成 SPA S301 1人间,',
  'L3,S,S302,SPA,2,合成SPA 2人间,,合成 SPA S302 2人间,',
  'L3,M,M310,踩背,1,合成踩背 1人间,,合成 M310,近邻标签 踩背1人间',
  'L3,F,F312,足浴,4,合成足浴 4人间,,合成 F312 4人间,按品牌平面图推断',
  'L3,G,G301,客房,2,合成客房,,合成客房 G301,',
  'L3,G,G302,客房,2,合成客房,,合成客房 G302,',
  'L2,P,P201,宠物轰趴房,,合成轰趴房,120m²,合成轰趴房P201,',
].join('\r\n');

const ledger = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', '/api/admin/spaces')).body as SpaceLedger;
const space = async (code: string) => (await ledger()).spaces.find((s) => s.code === code)!;
const floorId = async (code: string) => (await ledger()).floors.find((f) => f.code === code)!.id;
const zoneId = async (name: string) => (await ledger()).zones.find((z) => z.name === name)!.id;
const preview = async (kind: string, csv: string, fileName = `${kind}.csv`, cookie = ctx.owner) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/admin/spaces/imports/preview', { kind, fileName, csv, encoding: 'UTF-8' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as SpaceImportPreview;
};
const apply = (kind: string, csv: string, clientKey = randomUUID(), fileName = `${kind}.csv`, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/admin/spaces/imports', { kind, fileName, csv, encoding: 'UTF-8', clientKey });
/** 编辑空间的请求体：读到的字段与版本号，再改 patch 里的 */
const fieldsOf = (s: SpaceLedger['spaces'][number], patch: Record<string, unknown> = {}) => ({
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
const saveRoom = (body: Record<string, unknown>, id?: number) =>
  id ? api(ctx.app, boss, 'PUT', `/api/admin/rooms/rooms/${id}`, body) : api(ctx.app, boss, 'POST', '/api/admin/rooms/rooms', body);
const allChecksOk = async () => {
  for (const c of await spaceChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店长', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  // 升级前就有的房间（手工房号）：台账导入后照常能用，自检列出还没挂接
  const t = await api(ctx.app, boss, 'POST', '/api/admin/rooms/types', { name: '大床房', kind: 'daily', price: 30000 });
  roomType = t.body.types[0].id;
  const r = await saveRoom({ roomNo: '901', floor: '9', roomTypeId: roomType });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  room['901'] = r.body.rooms[0].id;
});
afterAll(async () => ctx.close());

describe('解析规则', () => {
  it('面积、容量、核对状态按备注', () => {
    expect([parseArea('120m²'), parseArea('95 ㎡'), parseArea('12.5'), parseArea(''), parseArea('abc'), parseArea('0')]).toEqual([12000, 9500, 1250, null, undefined, undefined]);
    expect([areaText(12000), areaText(1250), areaText(1205), areaText(null)]).toEqual(['120', '12.5', '12.05', '']);
    expect([parseCapacity('2'), parseCapacity('4人'), parseCapacity(''), parseCapacity('0'), parseCapacity('两')]).toEqual([2, 4, null, undefined, undefined]);
    expect([verifyStatusFromNote(''), verifyStatusFromNote('近邻标签 踩背1人间'), verifyStatusFromNote('按品牌图推断'), verifyStatusFromNote('品牌名待现场核对')]).toEqual([
      'confirmed',
      'inferred',
      'inferred',
      'site_check',
    ]);
  });
});

describe('权限与楼层', () => {
  it('店主、店长能进；值班经理、店员不能；预置 L1–L3 三层', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/spaces')).status).toBe(403);
    expect((await api(ctx.app, duty, 'GET', '/api/admin/spaces')).status).toBe(403);
    expect((await api(ctx.app, duty, 'POST', '/api/admin/spaces/imports/preview', { kind: 'zones', fileName: 'a.csv', csv: ZONES_CSV })).status).toBe(403);
    const l = await ledger(boss);
    expect(l.floors.map((f) => [f.code, f.name, f.active])).toEqual([
      ['L1', '一层', true],
      ['L2', '二层', true],
      ['L3', '三层', true],
    ]);
    expect(l.spaces).toEqual([]);
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces/floors', { code: 'l3', name: '重复' })).body.error.code).toBe('FLOOR_CODE_TAKEN');
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces/floors', { code: '3F', name: '错' })).status).toBe(400);
  });
});

describe('导入区域清单与空间清单', () => {
  it('区域清单：预览、写入、同一编号重提、同一个文件再导入都只写一次；查回能找到', async () => {
    const p = await preview('zones', ZONES_CSV);
    expect([p.rowCount, p.createCount, p.skipCount, p.issues, p.duplicateOf]).toEqual([3, 3, 0, [], null]);
    const key = randomUUID();
    const a = await apply('zones', ZONES_CSV, key);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect([a.body.replayed, a.body.import.createdCount, a.body.import.kind]).toEqual([false, 3, 'zones']);
    const again = await apply('zones', ZONES_CSV, key);
    expect([again.status, again.body.replayed, again.body.import.id]).toEqual([200, true, a.body.import.id]);
    const sameFile = await apply('zones', ZONES_CSV);
    expect([sameFile.status, sameFile.body.replayed, sameFile.body.import.id]).toEqual([200, true, a.body.import.id]);
    expect((await preview('zones', ZONES_CSV)).duplicateOf?.id).toBe(a.body.import.id);
    // 编号用在不同的文件上：拒绝
    expect((await apply('zones', `${ZONES_CSV}\r\nL1,合成大堂,,`, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, boss, 'GET', `/api/erp/ops/${key}?type=space_import`)).body).toEqual({ found: true, abandoned: false, refId: a.body.import.id });
    expect((await api(ctx.app, duty, 'GET', `/api/erp/ops/${key}?type=space_import`)).status).toBe(403);
    expect((await ledger()).zones.map((z) => z.name)).toEqual(['合成派对区', '合成SPA区', '合成客房区']);
  });

  it('确认作废过的编号晚到不写入', async () => {
    const key = randomUUID();
    expect((await api(ctx.app, boss, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'space_import', summary: '测试作废' })).body).toEqual({ found: false, abandoned: true });
    const late = await apply('zones', 'L1,合成大堂,,'.replace(/^/, '楼层,区域名(中文),区域名(英文),备注\r\n'), key);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect((await ledger()).zones.some((z) => z.name === '合成大堂')).toBe(false);
  });

  it('空间清单有错的整份不写，逐行列出问题', async () => {
    const bad = [
      '楼层,区域字母,编码,业态,容量（人）,建议显示名,面积,编码图原始标注,备注',
      'L9,S,S399,SPA,1,甲,,,',
      'L3,S,3S01,SPA,1,乙,,,',
      'L3,M,S398,SPA,1,丙,,,',
      'L3,S,S397,SPA,两,丁,,,',
      'L3,S,S396,SPA,1,戊,九十,,',
      'L3,S,S395,SPA,1,己,,,',
      'L3,S,S395,SPA,1,庚,,,',
      'L3,S,S394,,1,辛,,,',
    ].join('\n');
    const p = await preview('spaces', bad);
    expect(p.issues.map((i) => i.row)).toEqual([2, 3, 4, 5, 6, 8, 9]);
    expect(p.issues[0]!.message).toContain('楼层「L9」不在台账里');
    expect(p.issues[2]!.message).toContain('与区域字母「M」对不上');
    expect(p.issues[5]!.message).toContain('与第 7 行重复');
    const r = await apply('spaces', bad);
    expect([r.status, r.body.error.code]).toEqual([422, 'IMPORT_INVALID']);
    expect((await ledger()).spaces).toEqual([]);
    const noHeader = await preview('spaces', '编码,业态\nS301,SPA');
    expect(noHeader.issues[0]!.message).toContain('表头缺少「楼层」列');
  });

  it('空间清单：备注写「推断」「近邻标签」的标为推断；编码图原始标注记为别名；面积、容量可空', async () => {
    const p = await preview('spaces', SPACES_CSV);
    expect([p.createCount, p.skipCount, p.inferredCount, p.siteCheckCount, p.issues]).toEqual([7, 0, 2, 0, []]);
    const r = await apply('spaces', SPACES_CSV);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const l = await ledger();
    expect(l.spaces.map((s) => s.code)).toEqual(['P201', 'F312', 'G301', 'G302', 'M310', 'S301', 'S302']);
    const m310 = l.spaces.find((s) => s.code === 'M310')!;
    expect([m310.verifyStatus, m310.businessType, m310.capacity, m310.aliases.map((a) => [a.alias, a.kind])]).toEqual(['inferred', '踩背', 1, [['合成 M310', 'source']]]);
    expect(l.spaces.find((s) => s.code === 'F312')!.verifyStatus).toBe('inferred');
    const p201 = l.spaces.find((s) => s.code === 'P201')!;
    expect([p201.capacity, p201.areaCentiM2, p201.floorId === (await floorId('L2'))]).toEqual([null, 12000, true]);
    expect(l.counts).toEqual({ spaces: 7, active: 7, unverified: 2, roomSpaces: 2, roomSpacesLinked: 0, roomSpacesWithoutBrand: 2 });
    await allChecksOk();
  });

  it('再导入新文件：编码已在台账里的不覆盖、列出差异，只建新的；全是旧编码的拒绝；可选的「区域」列', async () => {
    const next = [
      '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注,区域',
      'L3,S,S301,SPA,2,合成SPA 改名,,合成 SPA S301 1人间,,合成SPA区',
      'L3,S,S303,SPA,3,合成SPA 3人间,,,,合成SPA区',
    ].join('\r\n');
    const p = await preview('spaces', next);
    expect([p.createCount, p.skipCount, p.issues]).toEqual([1, 1, []]);
    expect(p.diffs).toEqual([
      {
        row: 2,
        key: 'S301',
        fields: [
          { field: '区域', ledger: '', file: '合成SPA区' },
          { field: '容量(人)', ledger: '1', file: '2' },
          { field: '建议显示名', ledger: '合成SPA 1人间', file: '合成SPA 改名' },
        ],
      },
    ]);
    expect((await apply('spaces', next)).status).toBe(201);
    const s301 = await space('S301');
    expect([s301.displayName, s301.capacity, s301.zoneId]).toEqual(['合成SPA 1人间', 1, null]);
    expect((await space('S303')).zoneId).toBe(await zoneId('合成SPA区'));
    const old = await apply('spaces', ['楼层,编码,业态', 'L3,S301,SPA'].join('\n'));
    expect(old.body.error.code).toBe('IMPORT_NOTHING_NEW');
    const wrongZone = await preview('spaces', ['楼层,编码,业态,区域', 'L2,P209,派对房,合成SPA区'].join('\n'));
    expect(wrongZone.issues[0]!.message).toContain('L2 没有区域「合成SPA区」');
  });
});

describe('逐条维护：新建、编辑、核对、别名、批量设区域', () => {
  it('新建：编码转大写、不能重复；区域要在同一层；编码建好后不能改、不能删', async () => {
    const l3 = await floorId('L3');
    const body = { code: 's305', floorId: l3, zoneId: null, businessType: 'SPA', capacity: 2, displayName: '合成SPA', areaCentiM2: null };
    const r = await api(ctx.app, boss, 'POST', '/api/admin/spaces', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await space('S305')).verifyStatus).toBe('confirmed');
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces', body)).body.error.code).toBe('SPACE_CODE_TAKEN');
    const wrong = await api(ctx.app, boss, 'POST', '/api/admin/spaces', { ...body, code: 'S306', zoneId: await zoneId('合成派对区') });
    expect(wrong.body.error.code).toBe('ZONE_FLOOR_MISMATCH');
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces', { ...body, code: 'S3060000X' })).status).toBe(400);
    await expect(ctx.sql`UPDATE spaces SET code = 'S399' WHERE code = 'S305'`).rejects.toThrow('空间编码建好后不能改');
    await expect(ctx.sql`DELETE FROM spaces WHERE code = 'S305'`).rejects.toThrow('空间不能删除');
  });

  it('编辑与停用；核对状态改成已核对要写说明、留经办人', async () => {
    // 每次按最新读到的（含版本号）提交
    const put = async (patch: Record<string, unknown>) => {
      const s = await space('S305');
      return api(ctx.app, boss, 'PUT', `/api/admin/spaces/${s.id}`, fieldsOf(s, patch));
    };
    expect((await put({ displayName: '合成SPA 新名', sellable: false })).status).toBe(200);
    expect([(await space('S305')).displayName, (await space('S305')).sellable]).toEqual(['合成SPA 新名', false]);
    expect((await put({ active: false })).status).toBe(200);
    expect((await ledger()).counts.active).toBe(8);
    expect((await put({ active: true })).status).toBe(200);

    const m310 = await space('M310');
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${m310.id}/verify`, { status: 'confirmed', note: '', version: m310.version })).status).toBe(400);
    const v = await api(ctx.app, boss, 'POST', `/api/admin/spaces/${m310.id}/verify`, { status: 'confirmed', note: '店长现场按门牌核对', version: m310.version });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const after = await space('M310');
    expect([after.verifyStatus, after.verifyNote, after.verifiedByName]).toEqual(['confirmed', '店长现场按门牌核对', '店长']);
    const [audit] = await ctx.sql<{ detail: { summary: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'space_saved' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.summary).toBe('空间 M310 核对状态：推断 → 已核对（店长现场按门牌核对）');
  });

  it('别名：品牌名在不同空间之间可以重复；同一空间不重复；停用一次、不能改', async () => {
    const g301 = await space('G301');
    const g302 = await space('G302');
    for (const id of [g301.id, g302.id]) {
      const r = await api(ctx.app, boss, 'POST', `/api/admin/spaces/${id}/aliases`, { alias: '客房 C5', kind: 'brand' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${g301.id}/aliases`, { alias: ' 客房 c5 ', kind: 'legacy' })).body.error.code).toBe('ALIAS_EXISTS');
    const alias = (await space('G301')).aliases.find((a) => a.alias === '客房 C5')!;
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${g302.id}/aliases/${alias.id}/retire`, {})).status).toBe(404);
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${g301.id}/aliases/${alias.id}/retire`, {})).status).toBe(200);
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${g301.id}/aliases/${alias.id}/retire`, {})).body.error.code).toBe('ALIAS_RETIRED');
    const retired = (await space('G301')).aliases.find((a) => a.id === alias.id)!;
    expect([retired.active, retired.retiredByName]).toEqual([false, '店长']);
    await expect(ctx.sql`UPDATE space_aliases SET alias = '改名' WHERE id = ${alias.id}`).rejects.toThrow('别名只能停用一次');
    // 停用后可以重新加同名的（旧的留着可以搜）
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${g301.id}/aliases`, { alias: '客房 C5', kind: 'brand' })).status).toBe(200);
    expect((await ledger()).counts.roomSpacesWithoutBrand).toBe(0);
  });

  it('批量设区域：空间都要在区域那一层', async () => {
    const picked = [await space('S301'), await space('S302')].map((s) => ({ id: s.id, version: s.version }));
    const p201 = await space('P201');
    const zone = await zoneId('合成SPA区');
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces/bulk-zone', { spaces: [...picked, { id: p201.id, version: p201.version }], zoneId: zone })).body.error.code).toBe(
      'ZONE_FLOOR_MISMATCH',
    );
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces/bulk-zone', { spaces: picked, zoneId: zone })).status).toBe(200);
    // 同一批（版本号已经过时）再提交一次：拒绝
    expect((await api(ctx.app, boss, 'POST', '/api/admin/spaces/bulk-zone', { spaces: picked, zoneId: null })).body.error.code).toBe('SPACE_STALE');
    expect([(await space('S301')).zoneId, (await space('S302')).zoneId]).toEqual([zone, zone]);
    // 区域里还有在用的空间不能停用
    const z = (await ledger()).zones.find((x) => x.id === zone)!;
    const off = await api(ctx.app, boss, 'PUT', `/api/admin/spaces/zones/${zone}`, { name: z.name, nameEn: z.nameEn, note: z.note, sortOrder: z.sortOrder, active: false, version: z.version });
    expect(off.body.error.code).toBe('ZONE_IN_USE');
  });

  it('修改带版本号：迟到的旧请求、别人同时的修改都不会悄悄覆盖新的修改（v0.7.14 审查 P1）', async () => {
    // 第一次提交「没收到结果」，操作员改了别的值又提交；第一次的请求之后才到：按版本号拒绝，不覆盖后来的修改
    const s = await space('S303');
    const late = fieldsOf(s, { displayName: '超时那次' });
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${s.id}`, fieldsOf(s, { displayName: '后来改的' }))).status).toBe(200);
    const r = await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${s.id}`, late);
    expect([r.status, r.body.error.code]).toEqual([409, 'SPACE_STALE']);
    expect((await space('S303')).displayName).toBe('后来改的');
    // 同一次修改原样重提（第一次其实已经生效）：拒绝，刷新后看到已经改好
    const now = await space('S303');
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${now.id}`, fieldsOf(now, { note: '一次' }))).status).toBe(200);
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${now.id}`, fieldsOf(now, { note: '一次' }))).body.error.code).toBe('SPACE_STALE');
    expect((await space('S303')).version).toBe(now.version + 1);
    // 核对状态同样按版本号
    const s305 = await space('S305');
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${s305.id}/verify`, { status: 'site_check', note: '要现场看', version: s305.version })).status).toBe(200);
    expect((await api(ctx.app, boss, 'POST', `/api/admin/spaces/${s305.id}/verify`, { status: 'confirmed', note: '迟到的那次', version: s305.version })).body.error.code).toBe(
      'SPACE_STALE',
    );
    expect((await space('S305')).verifyStatus).toBe('site_check');
    // 楼层、区域
    const l1 = (await ledger()).floors.find((f) => f.code === 'L1')!;
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/floors/${l1.id}`, { name: '一层大堂', sortOrder: l1.sortOrder, active: true, version: l1.version })).status).toBe(200);
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/floors/${l1.id}`, { name: '一层', sortOrder: l1.sortOrder, active: true, version: l1.version })).body.error.code).toBe('FLOOR_STALE');
    const z = (await ledger()).zones.find((x) => x.name === '合成派对区')!;
    const zoneBody = { name: z.name, nameEn: z.nameEn, note: '改备注', sortOrder: z.sortOrder, active: true, version: z.version };
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/zones/${z.id}`, zoneBody)).status).toBe(200);
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/zones/${z.id}`, zoneBody)).body.error.code).toBe('ZONE_STALE');
    // 没带版本号：400
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${s.id}`, { ...fieldsOf(await space('S303')), version: undefined })).status).toBe(400);
  });

  it('导入与改区域同时进行：不会互相等成死锁（v0.7.14 审查 P2）', async () => {
    const z = (await ledger()).zones.find((x) => x.name === '合成派对区')!;
    // 改区域的事务先锁住区域这一行，导入在这时开始、要插入挂在这个区域的空间；改区域的事务接着更新区域再提交
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const rowLocked = new Promise<void>((r) => (locked = r));
    const editing = ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM zones WHERE id = ${z.id} FOR UPDATE`;
      locked();
      await holding;
      await tx`UPDATE zones SET note = '并发改备注', version = version + 1, updated_at = now() WHERE id = ${z.id}`;
    });
    await rowLocked;
    const importing = apply('spaces', ['楼层,编码,业态,区域', 'L2,P209,派对房,合成派对区'].join('\n'));
    // 让导入走到等区域行锁的地方
    await new Promise((r) => setTimeout(r, 600));
    release();
    await editing;
    const r = await importing;
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await space('P209')).zoneId).toBe(z.id);
    expect((await ledger()).zones.find((x) => x.id === z.id)!.note).toBe('并发改备注');
  });

  it('台账被别的终端占着超过 5 秒：按「正在被其他终端操作」拒绝（BUSY），什么都没改（v0.7.15 验收报告的测试缺口）', async () => {
    const z = (await ledger()).zones.find((x) => x.name === '合成派对区')!;
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const ledgerLocked = new Promise<void>((r) => (locked = r));
    // 另一个终端拿着台账的那把锁不放
    const other = ctx.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('space_ledger', 0))`;
      locked();
      await holding;
    });
    await ledgerLocked;
    try {
      const r = await api(ctx.app, boss, 'PUT', `/api/admin/spaces/zones/${z.id}`, { name: z.name, nameEn: z.nameEn, note: '等不到锁', sortOrder: z.sortOrder, active: z.active, version: z.version });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error.code).toBe('BUSY');
      expect(r.body.error.message).toContain('空间台账正在被其他终端操作');
    } finally {
      release();
      await other;
    }
    expect((await ledger()).zones.find((x) => x.id === z.id)).toMatchObject({ note: z.note, version: z.version });
  }, 20_000);
});

describe('客房房间挂接空间（RQ-003 剩余项）', () => {
  it('台账有客房后新建房间必须选空间，房号就是编码；只能挂在用的「客房」空间、一个空间一间房', async () => {
    expect((await saveRoom({ roomNo: '902', roomTypeId: roomType })).body.error.code).toBe('ROOM_SPACE_REQUIRED');
    const g301 = await space('G301');
    const r = await saveRoom({ roomNo: '', floor: '3', roomTypeId: roomType, spaceId: g301.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const created = r.body.rooms.find((x: { roomNo: string }) => x.roomNo === 'G301');
    expect([created.spaceId, created.spaceCode, created.spaceName]).toEqual([g301.id, 'G301', '合成客房']);
    room.G301 = created.id;
    expect((await saveRoom({ roomTypeId: roomType, spaceId: g301.id })).body.error.code).toBe('SPACE_LINKED');
    expect((await saveRoom({ roomTypeId: roomType, spaceId: (await space('S301')).id })).body.error.code).toBe('SPACE_NOT_ROOM');
    const admin = (await api(ctx.app, boss, 'GET', '/api/admin/rooms')).body;
    expect(admin.spaceRequired).toBe(true);
    expect(admin.spaces.map((s: { code: string; roomId: number | null }) => [s.code, s.roomId])).toEqual([
      ['G301', room.G301],
      ['G302', null],
    ]);
    // 升级前的房间照常能改（不强制挂接）；自检列出还没挂接的
    expect((await saveRoom({ roomNo: '901', floor: '9', roomTypeId: roomType, sortOrder: 5 }, room['901'])).status).toBe(200);
    const [, link] = await spaceChecks(ctx.sql);
    expect([link!.ok, link!.detail]).toEqual([true, '挂接了空间的房间 1 间，房号都是空间编码、空间都是在用的「客房」；还没挂接的启用房间 1 间']);
  });

  it('挂着的空间不能停用、不能改业态；换挂、取消挂接要写原因；挂着时房号不能另改', async () => {
    const g301 = await space('G301');
    const base = {
      floorId: g301.floorId,
      zoneId: g301.zoneId,
      businessType: g301.businessType,
      capacity: g301.capacity,
      areaCentiM2: g301.areaCentiM2,
      displayName: g301.displayName,
      nameEn: g301.nameEn,
      sellable: g301.sellable,
      sourceLabel: g301.sourceLabel,
      note: g301.note,
      active: true,
      version: g301.version,
    };
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${g301.id}`, { ...base, active: false })).body.error.code).toBe('SPACE_HAS_ROOM');
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/spaces/${g301.id}`, { ...base, businessType: 'SPA' })).body.error.code).toBe('SPACE_HAS_ROOM');
    // 房号输入被忽略：挂着时就是编码
    expect((await saveRoom({ roomNo: 'X1', roomTypeId: roomType }, room.G301)).body.rooms.find((x: { id: number }) => x.id === room.G301).roomNo).toBe('G301');
    const g302 = await space('G302');
    expect((await saveRoom({ roomTypeId: roomType, spaceId: g302.id }, room.G301)).body.error.code).toBe('LINK_REASON_REQUIRED');
    const moved = await saveRoom({ roomTypeId: roomType, spaceId: g302.id, linkReason: '现场核对后发现挂错了' }, room.G301);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.rooms.find((x: { id: number }) => x.id === room.G301).roomNo).toBe('G302');
    const [audit] = await ctx.sql<{ detail: { summary: string; reason: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'room_saved' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.summary).toBe('修改房间「G301」 → 「G302」，换挂空间 G302（现场核对后发现挂错了）');
    // 取消挂接：要写原因，房号回到手工录入
    expect((await saveRoom({ roomNo: 'G302', roomTypeId: roomType, spaceId: null }, room.G301)).body.error.code).toBe('LINK_REASON_REQUIRED');
    const unlinked = await saveRoom({ roomNo: 'T1', roomTypeId: roomType, spaceId: null, linkReason: '这间房改造' }, room.G301);
    expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
    expect(unlinked.body.rooms.find((x: { id: number }) => x.id === room.G301)).toMatchObject({ roomNo: 'T1', spaceId: null });
    // 再挂回 G301（第一次挂接不用写原因）
    const back = await saveRoom({ roomTypeId: roomType, spaceId: g301.id }, room.G301);
    expect(back.body.rooms.find((x: { id: number }) => x.id === room.G301)).toMatchObject({ roomNo: 'G301', spaceId: g301.id });
    await allChecksOk();
  });

  it('有人住的房间不能改挂接；房态看板显示空间的显示名', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 3, width: 3, zone: 'male' })).status).toBe(200);
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'K001', zone: 'male' }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), guests: 1, roomId: room.G301, expectedRate: 30000, tagCode: 'K001' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const g302 = await space('G302');
    expect((await saveRoom({ roomTypeId: roomType, spaceId: g302.id, linkReason: '测试换挂' }, room.G301)).body.error.code).toBe('ROOM_IN_USE');
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/rooms')).body as { rooms: { roomNo: string; spaceName: string | null }[] };
    expect(board.rooms.map((r) => [r.roomNo, r.spaceName])).toEqual([
      ['G301', '合成客房'],
      ['901', null],
    ]);
  });
});

describe('导出、只读树与自检', () => {
  it('导出空间清单 CSV（含别名、核对状态、在用）', async () => {
    const r = await api(ctx.app, boss, 'GET', '/api/admin/spaces/export');
    expect(r.status).toBe(200);
    const lines = String(r.body).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('楼层,区域,编码,业态,容量(人),面积,建议显示名,英文名,编码图原始标注,别名,可售,核对状态,备注,在用');
    expect(lines.find((l) => l.startsWith('L3,,G301,'))).toBe('L3,,G301,客房,2,,合成客房,,合成客房 G301,客房 C5,是,已核对,,是');
    expect(lines.find((l) => l.startsWith('L2,,P201,'))).toBe('L2,,P201,宠物轰趴房,,120,合成轰趴房,,合成轰趴房P201,,是,已核对,,是');
    expect(lines.find((l) => l.includes(',F312,'))).toContain(',推断,按品牌平面图推断,是');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/spaces/export')).status).toBe(403);
  });

  it('只读树：只含在用的楼层、区域、空间；前台客房岗位也能看', async () => {
    const tree = (await api(ctx.app, ctx.clerk, 'GET', '/api/spaces/tree')).body as SpaceTree;
    const l3 = tree.floors.find((f) => f.code === 'L3')!;
    expect(l3.zones.find((z) => z.name === '合成SPA区')!.spaces.map((s) => s.code)).toEqual(['S301', 'S302', 'S303']);
    expect(l3.spaces.find((s) => s.code === 'G301')).toMatchObject({ roomId: room.G301, aliases: ['合成客房 G301', '客房 C5'] });
    expect(tree.floors.find((f) => f.code === 'L1')!.zones).toEqual([]);
  });

  it('自检能发现挂接不一致', async () => {
    await allChecksOk();
    await ctx.sql`UPDATE rooms SET room_no = 'ZZ1' WHERE id = ${room['901']!}`;
    await allChecksOk();
    await ctx.sql`UPDATE rooms SET room_no = 'ZZ2' WHERE id = ${room.G301!}`;
    const [, link] = await spaceChecks(ctx.sql);
    expect([link!.ok, link!.detail]).toEqual([false, '1 间房的挂接不符（空间不是在用的「客房」或房号不是空间编码，如 ZZ2）']);
    await ctx.sql`UPDATE rooms SET room_no = 'G301' WHERE id = ${room.G301!}`;
    await allChecksOk();
  });
});
