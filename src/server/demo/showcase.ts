// 演示数据的「场景块」（v0.7.18，飞书需求 RQ-007，见 docs/DEMO_DATA.md）：建在会员、库存、前台、结账、旧账五块之上，
// 补上空间台账与底图（房态图）、客房、技师与钟房、餐饮与厨房、实时位置，打开演示库就能看到互相关联的业务。
//
// 全部是合成数据（名字带「演示」或「样例」，柜号用合成柜号），只用于独立的演示 / 开发库：
//   · 试用与正式环境一律拒绝，没有绕过开关；库里有非合成手牌时拒绝；
//   · 已经准备过（settings.demo_showcase）就整块跳过：过几天再执行不补当天的，要当天的新场景用 demo-reset 重建；
//   · 先只读核对全部冲突（台账编码被改成别的业态、工号是一位不带「演示」标记的技师、样例房号被别的房间占用……），
//     有冲突什么都不写，逐条列出处理办法；没有冲突才逐步写入；
//   · 每一步都可以重复执行：按编码、工号、名称认已有的记录（已有且一致的直接用，不改、不删），
//     业务操作的操作编号与选中的手牌先记在 settings.demo_showcase_progress，中途出错再执行一次原样重发、接着补。
// 所有业务都走正式接口（在本进程里起一个不监听端口的应用，用演示店主、前台的临时会话调用，结束时删掉会话），
// 账单、流水、位置与各模块的自检天然一致。时间是执行当时（不随 --previous-day 前移）。固定预期见 showcase-expected.json。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { businessDateOf } from '@shared/business-date';
import { DEFAULT_ROOM_RULES } from '@shared/rooms';
import { buildApp } from '../app';
import { createSession, destroySession, SESSION_COOKIE } from '../auth/session';
import type { AppConfig } from '../config';
import type { Sql } from '../db';
import { loadSettings } from '../modules/settings';
import { floorplanSampleDxf } from './floorplan-sample';
import { SAMPLE_SPACES_CSV, SAMPLE_ZONES_CSV } from './space-sample';

export const SHOWCASE_KEY = 'demo_showcase';
export const SHOWCASE_PROGRESS_KEY = 'demo_showcase_progress';
const NOTE = '演示场景';

/** 场景块自己的区域与空间（样例台账之外）：接待区、技师休息区，与第三间演示客房 */
export const SHOWCASE_ZONES_CSV = `楼层,区域名(中文),区域名(英文),备注
L3,样例接待区,Sample Reception,演示场景（合成）
L3,样例技师休息区,Sample Staff Lounge,演示场景（合成）
`;
export const SHOWCASE_SPACES_CSV = `楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注
L3,W,W303,客房,2,演示客房,,演示客房 W303,演示场景（合成）
`;

/** 场景用到的空间：编码 → 楼层、业态、所在区域（空间清单没有区域列，导入后按这里一次设好） */
const SPACES: { code: string; floor: string; type: string; zone: string }[] = [
  { code: 'T301', floor: 'L3', type: 'SPA', zone: '样例SPA区' },
  { code: 'T302', floor: 'L3', type: 'SPA', zone: '样例SPA区' },
  { code: 'U310', floor: 'L3', type: '踩背', zone: '样例SPA区' },
  { code: 'V312', floor: 'L3', type: '足浴', zone: '样例SPA区' },
  { code: 'W301', floor: 'L3', type: '客房', zone: '样例客房区' },
  { code: 'W302', floor: 'L3', type: '客房', zone: '样例客房区' },
  { code: 'W303', floor: 'L3', type: '客房', zone: '样例客房区' },
  { code: 'X201', floor: 'L2', type: '派对房', zone: '样例派对区' },
];
const ZONES: { floor: string; name: string }[] = [
  { floor: 'L3', name: '样例SPA区' },
  { floor: 'L3', name: '样例客房区' },
  { floor: 'L2', name: '样例派对区' },
  { floor: 'L3', name: '样例接待区' },
  { floor: 'L3', name: '样例技师休息区' },
];
const ROOM_TYPE = { name: '演示大床房', kind: 'daily' as const, price: 38800 };
const ROOM_CODES = ['W301', 'W302', 'W303'];
const TECHS = [
  { techNo: 'D01', name: '演示技师·林', gender: 'female' as const, grade: 'professional' as const },
  { techNo: 'D02', name: '演示技师·周', gender: 'female' as const, grade: 'standard' as const },
  { techNo: 'D03', name: '演示技师·陈', gender: 'male' as const, grade: 'standard' as const },
  { techNo: 'D04', name: '演示技师·许', gender: 'male' as const, grade: 'premium' as const },
];
const TECH_ITEM = { name: '演示足疗 60 分钟', category: '足疗', price: 19800, durationMinutes: 60 };
const STATIONS = ['演示厨房', '演示水吧'];
const DISHES = [
  { name: '演示简餐', category: '餐饮', price: 4800, station: '演示厨房' },
  { name: '演示果汁', category: '餐饮', price: 2200, station: '演示水吧' },
];
const TABLE = { name: '演示1号桌', area: '样例派对区', seats: 4 };
const READERS = [
  { code: 'DEMO-R1', name: '演示·接待台', zone: '样例接待区', space: null },
  { code: 'DEMO-R2', name: '演示·足浴 V312', zone: null, space: 'V312' },
] as const;
const CHECKIN_ZONE = '样例接待区';
const REST_ZONE = '样例技师休息区';
/** 三位在店客人（甲：做完足疗、入住 W301；乙：D01 在 T301 服务中；丙：D02 待上钟、点了果汁、在 V312 刷了卡） */
export const SHOWCASE_GUESTS = ['演示客人甲', '演示客人乙', '演示客人丙'] as const;
const TABLE_GUEST = '演示桌客';
const MODULES = [
  { key: 'room_rules', label: '客房' },
  { key: 'technician_rules', label: '技师' },
  { key: 'dining_rules', label: '餐饮' },
  { key: 'location_rules', label: '实时位置' },
] as const;

export class ShowcaseConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(
      `演示场景有 ${conflicts.length} 处与库里已有的记录对不上，场景块什么都没写：\n${conflicts.map((c) => `  · ${c}`).join('\n')}\n` +
        '处理办法：在页面上改名或停用冲突的那条（或按上面写的打开功能），再执行一次；或者在独立演示库上用 demo-reset 重建。',
    );
    this.name = 'ShowcaseConflictError';
  }
}

export interface ShowcaseResult {
  skipped: boolean;
  /** 写了什么（已有的直接用，不在这里列） */
  done: string[];
  /** 已有、沿用的东西，与要提醒的事 */
  notes: string[];
}

interface Progress {
  keys: Record<string, string>;
  tags: string[];
}

type Method = 'GET' | 'POST' | 'PUT';

/** 用一位演示员工的临时会话调用正式接口；失败时抛出带接口与原因的错误（allow 里的错误码照常返回） */
function client(app: FastifyInstance, token: string) {
  return async <T = Record<string, unknown>>(method: Method, url: string, payload?: unknown, allow: string[] = []) => {
    const res = await app.inject({ method, url, payload: payload as never, cookies: { [SESSION_COOKIE]: token } });
    let body: unknown = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    if (res.statusCode >= 400 && !(error?.code && allow.includes(error.code))) {
      throw new Error(`演示场景：${method} ${url} 没有成功（${res.statusCode}${error?.code ? ` ${error.code}` : ''}）：${error?.message ?? String(res.body).slice(0, 200)}`);
    }
    return { status: res.statusCode, code: error?.code ?? null, body: body as T };
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function zoneIdOf(sql: Sql, floor: string, name: string): Promise<number | null> {
  const [z] = await sql<{ id: number }[]>`
    SELECT z.id FROM zones z JOIN floors f ON f.id = z.floor_id WHERE f.code = ${floor} AND z.name = ${name} AND z.active ORDER BY z.id LIMIT 1`;
  return z ? Number(z.id) : null;
}

interface SpaceRow {
  id: number;
  code: string;
  floor: string;
  businessType: string;
  active: boolean;
  zoneId: number | null;
  version: number;
}

async function spaceOf(sql: Sql, code: string): Promise<SpaceRow | null> {
  const [s] = await sql<SpaceRow[]>`
    SELECT s.id, s.code, f.code AS floor, s.business_type, s.active, s.zone_id, s.version
    FROM spaces s JOIN floors f ON f.id = s.floor_id WHERE s.code = ${code}`;
  return s ? { ...s, id: Number(s.id), zoneId: s.zoneId === null ? null : Number(s.zoneId) } : null;
}

async function idOf(sql: Sql, query: Promise<{ id: number }[]>): Promise<number> {
  const [row] = await query;
  if (!row) throw new Error('演示场景：刚建好的记录没找到，请再执行一次');
  return Number(row.id);
}

/** 只读核对：有冲突时一条都不写 */
async function findConflicts(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  for (const s of SPACES) {
    const cur = await spaceOf(sql, s.code);
    if (!cur) continue;
    if (cur.businessType !== s.type) out.push(`台账里的 ${s.code} 是「${cur.businessType}」业态（演示场景要「${s.type}」）`);
    else if (cur.floor !== s.floor) out.push(`台账里的 ${s.code} 在 ${cur.floor}（演示场景要在 ${s.floor}）`);
    else if (!cur.active) out.push(`台账里的 ${s.code} 已停用`);
  }
  const zones = await sql<{ floor: string; name: string }[]>`
    SELECT f.code AS floor, z.name FROM zones z JOIN floors f ON f.id = z.floor_id WHERE NOT z.active AND z.name IN ${sql(ZONES.map((z) => z.name))}`;
  for (const z of zones) {
    if (ZONES.some((x) => x.floor === z.floor && x.name === z.name) && !(await zoneIdOf(sql, z.floor, z.name))) out.push(`区域「${z.name}」（${z.floor}）已停用`);
  }
  const [type] = await sql<{ kind: string; active: boolean }[]>`SELECT kind, active FROM room_types WHERE name = ${ROOM_TYPE.name} ORDER BY id LIMIT 1`;
  if (type && (!type.active || type.kind !== ROOM_TYPE.kind)) out.push(`房型「${ROOM_TYPE.name}」${type.active ? '不是全天房' : '已停用'}`);
  for (const code of ROOM_CODES) {
    const [room] = await sql<{ roomNo: string; active: boolean; spaceCode: string | null }[]>`
      SELECT r.room_no, r.active, sp.code AS space_code FROM rooms r LEFT JOIN spaces sp ON sp.id = r.space_id
      WHERE lower(btrim(r.room_no)) = lower(${code}) OR sp.code = ${code}`;
    if (!room) continue;
    if (room.spaceCode !== code) {
      out.push(
        room.spaceCode === null
          ? `样例房号 ${code} 已被一间没挂样例空间的房间占用`
          : room.roomNo.toUpperCase() === code
            ? `房间 ${code} 挂的是空间 ${room.spaceCode}`
            : `空间 ${code} 已挂在房间「${room.roomNo}」上`,
      );
    } else if (!room.active) out.push(`房间 ${code} 已停用`);
  }
  for (const t of TECHS) {
    const [cur] = await sql<{ name: string; active: boolean; isSynthetic: boolean }[]>`SELECT name, active, is_synthetic FROM technicians WHERE tech_no = ${t.techNo}`;
    if (!cur) continue;
    if (!cur.isSynthetic) out.push(`工号 ${t.techNo} 是一位不带「演示」标记的技师（${cur.name}）`);
    else if (!cur.active) out.push(`演示技师 ${t.techNo} 已停用`);
  }
  const items = await sql<{ name: string; active: boolean; technicianRequired: boolean }[]>`
    SELECT name, active, technician_required FROM service_items WHERE name IN ${sql([TECH_ITEM.name, ...DISHES.map((d) => d.name)])}`;
  for (const i of items) {
    if (!i.active) out.push(`项目「${i.name}」已停用`);
    else if (i.name === TECH_ITEM.name && !i.technicianRequired) out.push(`项目「${i.name}」没有设成「需要技师」`);
    else if (i.name !== TECH_ITEM.name && i.technicianRequired) out.push(`菜品「${i.name}」被设成了「需要技师」`);
  }
  const stations = await sql<{ name: string }[]>`SELECT name FROM kitchen_stations WHERE name IN ${sql(STATIONS)} AND NOT active`;
  for (const s of stations) out.push(`出品档口「${s.name}」已停用`);
  const [table] = await sql<{ active: boolean }[]>`SELECT active FROM dining_tables WHERE name = ${TABLE.name}`;
  if (table && !table.active) out.push(`桌台「${TABLE.name}」已停用`);
  for (const r of READERS) {
    const [cur] = await sql<{ active: boolean; zoneName: string | null; spaceCode: string | null }[]>`
      SELECT r.active, z.name AS zone_name, sp.code AS space_code
      FROM location_readers r LEFT JOIN zones z ON z.id = r.zone_id LEFT JOIN spaces sp ON sp.id = r.space_id WHERE r.code = ${r.code}`;
    if (!cur) continue;
    if (!cur.active) out.push(`刷卡点 ${r.code} 已停用`);
    else if (cur.zoneName !== r.zone || cur.spaceCode !== r.space) out.push(`刷卡点 ${r.code} 装在别处（${cur.spaceCode ?? cur.zoneName ?? '未知'}），演示场景要装在 ${r.space ?? r.zone}`);
  }
  for (const m of MODULES) {
    const [row] = await sql<{ value: { enabled?: boolean } }[]>`SELECT value FROM settings WHERE key = ${m.key}`;
    if (row && row.value?.enabled === false) out.push(`后台把「${m.label}」功能关了：演示场景要用它，请到后台打开`);
  }
  const [busy] = await sql<{ id: number; fileName: string }[]>`SELECT id, file_name FROM floorplan_batches WHERE status = 'converting'`;
  if (busy) out.push(`有一份底图正在转换（第 ${busy.id} 批，${busy.fileName}）：等它转换完再执行；如果是之前中途退出留下的，重启一次应用会把它记成失败`);
  const [real] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hand_tags WHERE NOT is_synthetic`;
  if (real!.n > 0) out.push('库里有非合成的手牌：演示场景只在独立演示库里写');
  return out;
}

async function loadProgress(sql: Sql): Promise<Progress> {
  const [row] = await sql<{ value: Progress }[]>`SELECT value FROM settings WHERE key = ${SHOWCASE_PROGRESS_KEY}`;
  return row?.value ?? { keys: {}, tags: [] };
}

async function saveProgress(sql: Sql, p: Progress) {
  await sql`
    INSERT INTO settings (key, value) VALUES (${SHOWCASE_PROGRESS_KEY}, ${sql.json(p as never)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** 场景块：已经准备过就跳过；有冲突抛 ShowcaseConflictError（什么都不写） */
export async function seedShowcaseDemo(sql: Sql, config: AppConfig): Promise<ShowcaseResult> {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入演示场景。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [marker] = await sql`SELECT 1 FROM settings WHERE key = ${SHOWCASE_KEY}`;
  if (marker) return { skipped: true, done: [], notes: [] };

  const staff = await sql<{ id: number; username: string; active: boolean }[]>`SELECT id, username, active FROM staff WHERE username IN ('linlan', 'xiaozhou')`;
  const ownerId = staff.find((s) => s.username === 'linlan' && s.active)?.id;
  const clerkId = staff.find((s) => s.username === 'xiaozhou' && s.active)?.id;
  if (!ownerId || !clerkId) throw new Error('演示场景要用演示账号 linlan（店主）与 xiaozhou（前台），请先执行 seed-demo 与 seed-frontdesk-demo');
  const [tags] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hand_tags WHERE is_synthetic`;
  if (!tags!.n) throw new Error('演示场景建在前台演示数据上，请先执行 seed-frontdesk-demo');

  const conflicts = await findConflicts(sql);
  if (conflicts.length) throw new ShowcaseConflictError(conflicts);

  const done: string[] = [];
  const notes: string[] = [];
  const app = await buildApp(sql, { ...config, logLevel: 'silent' });
  const tokens: string[] = [];
  try {
    const ownerToken = await createSession(sql, Number(ownerId), 1, { userAgent: 'demo-prepare' });
    tokens.push(ownerToken);
    const clerkToken = await createSession(sql, Number(clerkId), 1, { userAgent: 'demo-prepare' });
    tokens.push(clerkToken);
    const owner = client(app, ownerToken);
    const clerk = client(app, clerkToken);

    // ── 空间台账：样例区域与空间（与 v0.7.14 起的验收同一份）+ 接待区、技师休息区、第三间演示客房 ──
    for (const [kind, fileName, csv] of [
      ['zones', 'space-zones-sample.csv', SAMPLE_ZONES_CSV],
      ['zones', 'demo-showcase-zones.csv', SHOWCASE_ZONES_CSV],
      ['spaces', 'space-ledger-sample.csv', SAMPLE_SPACES_CSV],
      ['spaces', 'demo-showcase-spaces.csv', SHOWCASE_SPACES_CSV],
    ] as const) {
      const r = await owner('POST', '/api/admin/spaces/imports', { kind, fileName, csv, encoding: 'UTF-8', clientKey: randomUUID() }, ['IMPORT_NOTHING_NEW']);
      if (!r.code) done.push(`空间台账导入 ${fileName}`);
    }
    for (const z of ZONES) {
      const zoneId = await zoneIdOf(sql, z.floor, z.name);
      if (!zoneId) throw new Error(`演示场景：区域「${z.name}」导入后没找到`);
      const rows: SpaceRow[] = [];
      for (const s of SPACES.filter((x) => x.zone === z.name)) {
        const cur = await spaceOf(sql, s.code);
        if (!cur) throw new Error(`演示场景：空间 ${s.code} 导入后没找到`);
        if (cur.zoneId === null) rows.push(cur);
      }
      if (rows.length) {
        await owner('POST', '/api/admin/spaces/bulk-zone', { spaces: rows.map((r) => ({ id: r.id, version: r.version })), zoneId });
        done.push(`${rows.map((r) => r.code).join('、')} 设为区域「${z.name}」`);
      }
    }
    const space = async (code: string) => (await spaceOf(sql, code))!.id;
    const zone = async (name: string) => (await zoneIdOf(sql, ZONES.find((z) => z.name === name)!.floor, name))!;

    // ── 底图：没有在用的底图时转换并启用样例底图（与 v0.7.15 起的验收同一份合成 DXF） ──
    const [activeBatch] = await sql<{ id: number }[]>`SELECT id FROM floorplan_batches WHERE status = 'active'`;
    if (activeBatch) {
      notes.push(`已经有在用的底图（第 ${activeBatch.id} 批），没有换：样例房间可能不在这份底图上`);
    } else {
      type Batch = { batch: { id: number; status: string; error: string | null } };
      const upload = (dxf: string) =>
        owner<Batch>('POST', '/api/admin/floorplans', { fileName: 'floorplan-sample.dxf', contentBase64: Buffer.from(dxf).toString('base64'), note: `${NOTE}：合成样例底图` });
      let batch = (await upload(floorplanSampleDxf())).body.batch;
      // 同一份图纸以前转换过、后来被换下：换下的批次不能再启用，加一行注释当成新文件重新转换
      if (batch.status === 'retired') batch = (await upload(`999\n${NOTE} ${new Date().toISOString()}\n${floorplanSampleDxf()}`)).body.batch;
      const deadline = Date.now() + 120_000;
      while (batch.status === 'converting') {
        if (Date.now() > deadline) throw new Error('演示场景：样例底图两分钟还没转换完，请稍后再执行一次');
        await new Promise((r) => setTimeout(r, 300));
        batch = (await owner<Batch>('GET', `/api/admin/floorplans/${batch.id}`)).body.batch;
      }
      if (batch.status !== 'ready' && batch.status !== 'active') throw new Error(`演示场景：样例底图转换失败：${batch.error ?? batch.status}`);
      await owner('POST', `/api/admin/floorplans/${batch.id}/activate`, { expectedActiveId: null });
      done.push(`样例底图转换并启用（第 ${batch.id} 批）`);
    }

    // ── 功能开关：只在从来没设过时打开（设过且打开的沿用；关着的已在上面当冲突拦下） ──
    const unset = async (key: string) => !(await sql`SELECT 1 FROM settings WHERE key = ${key}`)[0];
    if (await unset('room_rules')) {
      await owner('PUT', '/api/admin/rooms/rules', { ...DEFAULT_ROOM_RULES, enabled: true });
      done.push('打开客房功能（默认规则）');
    }
    if (await unset('technician_rules')) {
      await owner('PUT', '/api/admin/technicians/rules', { enabled: true });
      done.push('打开技师功能（默认规则）');
    }
    if (await unset('dining_rules')) {
      await owner('PUT', '/api/admin/dining/rules', { enabled: true });
      done.push('打开餐饮功能（默认规则）');
    }
    const checkinZoneId = await zone(CHECKIN_ZONE);
    const restZoneId = await zone(REST_ZONE);
    if (await unset('location_rules')) {
      await owner('PUT', '/api/admin/locations/rules', { enabled: true, checkinZoneId, restZoneId });
      done.push(`打开实时位置（接待区「${CHECKIN_ZONE}」、技师休息区「${REST_ZONE}」）`);
    } else {
      const [row] = await sql<{ value: { checkinZoneId?: number | null; restZoneId?: number | null } }[]>`SELECT value FROM settings WHERE key = 'location_rules'`;
      if (Number(row!.value.checkinZoneId) !== checkinZoneId || Number(row!.value.restZoneId) !== restZoneId) {
        notes.push('实时位置的接待区、技师休息区沿用后台已有的设置：人员位置可能与 showcase-expected.json 不同');
      }
    }

    // ── 客房：房型、三间房挂样例空间 ──
    const typeQuery = () => sql<{ id: number; price: number }[]>`SELECT id, price FROM room_types WHERE name = ${ROOM_TYPE.name} ORDER BY id LIMIT 1`;
    if (!(await typeQuery())[0]) {
      await owner('POST', '/api/admin/rooms/types', { name: ROOM_TYPE.name, kind: ROOM_TYPE.kind, price: ROOM_TYPE.price });
      done.push(`房型「${ROOM_TYPE.name}」`);
    }
    const [roomType] = await typeQuery();
    const roomTypeId = Number(roomType!.id);
    const rooms: Record<string, number> = {};
    for (const code of ROOM_CODES) {
      const spaceId = await space(code);
      const find = () => sql<{ id: number }[]>`SELECT id FROM rooms WHERE space_id = ${spaceId}`;
      if (!(await find())[0]) {
        await owner('POST', '/api/admin/rooms/rooms', { roomNo: '', floor: '3', roomTypeId, spaceId });
        done.push(`房间 ${code}（挂空间 ${code}）`);
      }
      rooms[code] = await idOf(sql, find());
    }

    // ── 技师与项目 ──
    const techs: Record<string, number> = {};
    for (const t of TECHS) {
      const find = () => sql<{ id: number }[]>`SELECT id FROM technicians WHERE tech_no = ${t.techNo}`;
      if (!(await find())[0]) {
        await owner('POST', '/api/admin/technicians', { techNo: t.techNo, name: t.name, gender: t.gender, grade: t.grade, note: NOTE });
        await sql`UPDATE technicians SET is_synthetic = true WHERE tech_no = ${t.techNo}`;
        done.push(`技师 ${t.techNo} ${t.name}`);
      }
      techs[t.techNo] = await idOf(sql, find());
    }
    const itemQuery = (name: string) => sql<{ id: number; price: number; zoneId: number | null; stationId: number | null }[]>`
      SELECT id, price, zone_id, station_id FROM service_items WHERE name = ${name} ORDER BY id LIMIT 1`;
    if (!(await itemQuery(TECH_ITEM.name))[0]) {
      await owner('POST', '/api/items', { ...TECH_ITEM, technicianRequired: true });
      done.push(`项目「${TECH_ITEM.name}」（需要技师）`);
    }
    for (const d of DISHES) {
      if (!(await itemQuery(d.name))[0]) {
        await owner('POST', '/api/items', { name: d.name, category: d.category, price: d.price });
        done.push(`菜品「${d.name}」`);
      }
    }

    // ── 餐饮：出品档口、菜品进档口、桌台 ──
    const stations: Record<string, number> = {};
    for (const name of STATIONS) {
      const find = () => sql<{ id: number }[]>`SELECT id FROM kitchen_stations WHERE name = ${name} ORDER BY id LIMIT 1`;
      if (!(await find())[0]) {
        await owner('POST', '/api/admin/dining/stations', { name });
        done.push(`出品档口「${name}」`);
      }
      stations[name] = await idOf(sql, find());
    }
    const toStation = [];
    for (const d of DISHES) {
      const [item] = await itemQuery(d.name);
      if (item!.stationId === null) toStation.push({ id: Number(item!.id), stationId: stations[d.station]! });
    }
    if (toStation.length) {
      await owner('PUT', '/api/admin/dining/items', { items: toStation });
      done.push(`菜品进档口（${toStation.length} 道）`);
    }
    const tableQuery = () => sql<{ id: number }[]>`SELECT id FROM dining_tables WHERE name = ${TABLE.name} ORDER BY id LIMIT 1`;
    if (!(await tableQuery())[0]) {
      await owner('POST', '/api/admin/dining/tables', TABLE);
      done.push(`桌台「${TABLE.name}」`);
    }
    const tableId = await idOf(sql, tableQuery());

    // ── 实时位置：刷卡点、项目所在区域 ──
    for (const r of READERS) {
      if ((await sql`SELECT 1 FROM location_readers WHERE code = ${r.code}`)[0]) continue;
      await owner('POST', '/api/admin/locations/readers', {
        code: r.code,
        name: r.name,
        zoneId: r.zone ? await zone(r.zone) : null,
        spaceId: r.space ? await space(r.space) : null,
        note: NOTE,
      });
      done.push(`刷卡点 ${r.code}（${r.space ?? r.zone}）`);
    }
    const itemZones = [];
    for (const [name, zoneName] of [[TECH_ITEM.name, '样例SPA区'], ...DISHES.map((d) => [d.name, '样例派对区'] as const)] as const) {
      const [item] = await itemQuery(name);
      if (item!.zoneId === null) itemZones.push({ id: Number(item!.id), zoneId: await zone(zoneName) });
    }
    if (itemZones.length) {
      await owner('PUT', '/api/admin/locations/items', { items: itemZones });
      done.push(`项目所在区域（${itemZones.length} 个）`);
    }

    // ── 业务：操作编号与选中的手牌先记下来，中途出错再执行一次原样重发 ──
    const progress = await loadProgress(sql);
    const key = (name: string) => (progress.keys[name] ??= randomUUID());
    if (progress.tags.length < SHOWCASE_GUESTS.length) {
      const free = await sql<{ code: string }[]>`
        SELECT t.code FROM hand_tags t
        WHERE t.is_synthetic AND t.active AND NOT t.locked AND t.kind = 'normal' AND t.zone = 'male'
          AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.tag_id = t.id AND v.status = 'open')
        ORDER BY t.code LIMIT ${SHOWCASE_GUESTS.length}`;
      if (free.length < SHOWCASE_GUESTS.length) throw new Error('演示场景：空闲的合成男宾普通柜不够 3 张');
      progress.tags = free.map((f) => f.code);
    }
    for (const name of [
      'checkin0', 'checkin1', 'checkin2', 'dispatchA', 'stay', 'dispatchB', 'dispatchC', 'table', 'tableOrder', 'dishC', 'swipeC', 'swipeD02',
    ]) key(name);
    await saveProgress(sql, progress);
    const k = progress.keys as Record<string, string>;
    const [tagA, tagB, tagC] = progress.tags as [string, string, string];

    // 前台小舟开班（入住收押金要在班上）；已经在班上就沿用
    const shift = await clerk('POST', '/api/shifts', { openingCash: 50000 }, ['SHIFT_OPEN']);
    if (!shift.code) done.push('前台 xiaozhou 开班（备用金 500 元）');

    // 三位客人入场（各自一张账单，在接待区）
    const visitOf = async (tag: string) =>
      idOf(sql, sql<{ id: number }[]>`
        SELECT v.id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${tag} AND v.status = 'open' ORDER BY v.id DESC LIMIT 1`);
    for (const [i, tag] of progress.tags.entries()) {
      await clerk('POST', '/api/frontdesk/checkins', { clientKey: k[`checkin${i}`], guests: [{ tagCode: tag, zone: 'male', guestLabel: SHOWCASE_GUESTS[i] }] });
    }
    const [visitA, visitB, visitC] = [await visitOf(tagA), await visitOf(tagB), await visitOf(tagC)];
    done.push(`在店客人 ${SHOWCASE_GUESTS.map((g, i) => `${g}（${progress.tags[i]}）`).join('、')}`);

    // 技师 D01–D03 上牌（在技师休息区），D04 不上牌
    for (const no of ['D01', 'D02', 'D03']) await clerk('POST', `/api/clockroom/technicians/${techs[no]}/state`, { action: 'sign_in' });

    const [techItem] = await itemQuery(TECH_ITEM.name);
    const techItemId = Number(techItem!.id);
    const dispatch = (clientKey: string, visitId: number, techNo: string, startNow: boolean, spaceCode: string) =>
      space(spaceCode).then((spaceId) =>
        clerk('POST', '/api/clockroom/dispatch', {
          clientKey,
          visitId,
          itemId: techItemId,
          quantity: 1,
          technicianId: techs[techNo],
          callType: 'designated',
          startNow,
          spaceId,
          expectedTotal: Number(techItem!.price),
        }),
      );
    const sessionOf = (visitId: number, techNo: string) =>
      sql<{ id: number; status: string }[]>`
        SELECT id, status FROM technician_sessions WHERE visit_id = ${visitId} AND technician_id = ${techs[techNo]!} ORDER BY id DESC LIMIT 1`;

    // 甲：D03 在 T302 做完足疗（今天已下钟，记进技师业绩），再入住 W301（带 200 元现金押金）
    await dispatch(k.dispatchA!, visitA, 'D03', true, 'T302');
    const [sessionA] = await sessionOf(visitA, 'D03');
    if (sessionA!.status === 'serving') await clerk('POST', `/api/clockroom/sessions/${sessionA!.id}/finish`, {});
    await clerk('POST', '/api/rooms/checkin', {
      clientKey: k.stay,
      roomId: rooms.W301,
      tagCode: tagA,
      guestLabel: SHOWCASE_GUESTS[0],
      guests: 1,
      expectedCheckoutDate: null,
      expectedRate: Number(roomType!.price),
      deposit: { method: 'cash', amount: 20000 },
    });
    // 乙：D01 点钟、马上在 T301 上钟（服务中）；丙：D02 点钟、待上钟（T302）
    await dispatch(k.dispatchB!, visitB, 'D01', true, 'T301');
    await dispatch(k.dispatchC!, visitC, 'D02', false, 'T302');
    done.push('钟单：甲 D03 已下钟（T302）、乙 D01 服务中（T301）、丙 D02 待上钟（T302）；甲入住 W301');

    // 桌台开台点菜：简餐上了桌，果汁还没出；丙在手牌上点了一杯果汁；果汁估清
    await clerk('POST', '/api/dining/tables/open', { clientKey: k.table, tableId, guests: 2, guestLabel: TABLE_GUEST });
    const sessionId = await idOf(sql, sql<{ id: number }[]>`SELECT id FROM table_sessions WHERE table_id = ${tableId} AND status = 'open' ORDER BY id DESC LIMIT 1`);
    const [meal] = await itemQuery(DISHES[0]!.name);
    const [juice] = await itemQuery(DISHES[1]!.name);
    await clerk('POST', `/api/dining/tables/sessions/${sessionId}/orders`, {
      clientKey: k.tableOrder,
      lines: [
        { itemId: Number(meal!.id), quantity: 2 },
        { itemId: Number(juice!.id), quantity: 1 },
      ],
      expectedTotal: Number(meal!.price) * 2 + Number(juice!.price),
    });
    const [kitchenMeal] = await sql<{ id: number; status: string }[]>`
      SELECT id, status FROM kitchen_items WHERE table_session_id = ${sessionId} AND item_id = ${meal!.id} AND status <> 'cancelled' ORDER BY id LIMIT 1`;
    if (!kitchenMeal) throw new Error('演示场景：桌台点的简餐没有进厨房');
    const steps: Record<string, 'start' | 'done' | 'serve'> = { queued: 'start', cooking: 'done', done: 'serve' };
    for (let status = kitchenMeal.status; steps[status]; ) {
      await clerk('POST', `/api/kitchen/items/${kitchenMeal.id}/${steps[status]}`, {});
      status = (await sql<{ status: string }[]>`SELECT status FROM kitchen_items WHERE id = ${kitchenMeal.id}`)[0]!.status;
    }
    await clerk('POST', '/api/dining/orders', { clientKey: k.dishC, visitId: visitC, lines: [{ itemId: Number(juice!.id), quantity: 1 }], expectedTotal: Number(juice!.price) });
    await clerk('PUT', `/api/kitchen/limits/${juice!.id}`, { remaining: 0 });
    done.push(`${TABLE.name}开台：简餐 2 份已上、果汁 1 杯待出；丙点果汁 1 杯待出；演示果汁估清`);

    // 房态：W302 待打扫、W303 维修
    await clerk('PUT', `/api/rooms/${rooms.W302}/housekeeping`, { status: 'dirty' });
    await clerk('PUT', `/api/rooms/${rooms.W303}/housekeeping`, { status: 'maintenance', note: '演示：空调检修' });
    done.push('房态：W301 在住、W302 待打扫、W303 维修');

    // 模拟刷卡两次：丙在足浴 V312 刷卡；D02 在接待台刷卡
    await owner('POST', '/api/locations/report', { opId: k.swipeC, source: 'reader', readerCode: 'DEMO-R2', tagCode: tagC });
    await owner('POST', '/api/locations/report', { opId: k.swipeD02, source: 'reader', readerCode: 'DEMO-R1', technicianNo: 'D02' });
    done.push('模拟刷卡：丙在 V312（DEMO-R2）、D02 在接待台（DEMO-R1）');

    const { businessDayStartHour } = await loadSettings(sql);
    const businessDate = businessDateOf(new Date(), config.timezone, businessDayStartHour);
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO settings (key, value) VALUES (${SHOWCASE_KEY}, ${tx.json({ version: 1, preparedAt: new Date().toISOString(), businessDate, guests: progress.tags } as never)})
        ON CONFLICT (key) DO NOTHING`;
      await tx`DELETE FROM settings WHERE key = ${SHOWCASE_PROGRESS_KEY}`;
    });
    return { skipped: false, done, notes };
  } finally {
    for (const t of tokens) await destroySession(sql, t).catch(() => {});
    await app.close();
  }
}

// ───────────────────────── 核对（demo-check，只读） ─────────────────────────

export interface ShowcaseState {
  guests: string[];
  rooms: Record<string, string>;
  sessions: { guest: string; techNo: string; status: string; space: string | null }[];
  technicians: Record<string, string>;
  kitchen: { target: string; item: string; quantity: number; status: string }[];
  soldOut: string[];
  table: { name: string; open: boolean; guests: number | null };
  floorplan: { active: boolean; outlined: string[] };
  locations: Record<string, string>;
  readers: string[];
}

/** 场景块现在的样子（与 showcase-expected.json 同一个形状）；按天的状态（在岗、估清）按今天的营业日取 */
export async function showcaseState(sql: Sql, timeZone: string): Promise<ShowcaseState> {
  const { businessDayStartHour } = await loadSettings(sql);
  const today = businessDateOf(new Date(), timeZone, businessDayStartHour);
  const labels = [...SHOWCASE_GUESTS] as string[];
  const guests = (await sql<{ label: string }[]>`SELECT guest_label AS label FROM visits WHERE status = 'open' AND guest_label IN ${sql(labels)}`)
    .map((g) => g.label)
    .sort(cmp);
  // 按固定顺序列（数据库读出来的顺序不固定）
  const rooms: Record<string, string> = Object.fromEntries(ROOM_CODES.map((c) => [c, '没有这间房']));
  for (const r of await sql<{ code: string; housekeeping: string; occupied: boolean }[]>`
    SELECT sp.code, r.housekeeping, EXISTS (SELECT 1 FROM room_stays s WHERE s.room_id = r.id AND s.status = 'open') AS occupied
    FROM rooms r JOIN spaces sp ON sp.id = r.space_id WHERE sp.code IN ${sql(ROOM_CODES)}`) {
    rooms[r.code] = r.occupied ? 'occupied' : r.housekeeping;
  }
  const sessions = (
    await sql<{ guest: string; techNo: string; status: string; space: string | null }[]>`
      SELECT v.guest_label AS guest, t.tech_no, s.status, sp.code AS space
      FROM technician_sessions s JOIN visits v ON v.id = s.visit_id JOIN technicians t ON t.id = s.technician_id
      LEFT JOIN spaces sp ON sp.id = s.space_id
      WHERE v.guest_label IN ${sql(labels)} AND t.tech_no IN ${sql(TECHS.map((x) => x.techNo))}`
  )
    .map((s) => ({ guest: s.guest, techNo: s.techNo, status: s.status, space: s.space }))
    .sort((a, b) => cmp(a.techNo, b.techNo) || cmp(a.guest, b.guest) || cmp(a.status, b.status));
  const technicians: Record<string, string> = {};
  for (const t of TECHS) technicians[t.techNo] = 'off';
  for (const t of await sql<{ techNo: string; state: string }[]>`
    SELECT t.tech_no, st.state FROM technician_status st JOIN technicians t ON t.id = st.technician_id
    WHERE st.business_date = ${today} AND t.tech_no IN ${sql(TECHS.map((x) => x.techNo))}`) {
    technicians[t.techNo] = t.state;
  }
  const dishNames = DISHES.map((d) => d.name);
  const kitchen = (
    await sql<{ target: string; item: string; quantity: number; status: string }[]>`
      SELECT COALESCE(dt.name, v.guest_label) AS target, i.name AS item, k.quantity, k.status
      FROM kitchen_items k JOIN service_items i ON i.id = k.item_id
      LEFT JOIN table_sessions ts ON ts.id = k.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
      LEFT JOIN visits v ON v.id = k.visit_id
      WHERE i.name IN ${sql(dishNames)} AND (dt.name = ${TABLE.name} OR v.guest_label IN ${sql(labels)})`
  )
    .map((r) => ({ target: r.target, item: r.item, quantity: Number(r.quantity), status: r.status }))
    .sort((a, b) => cmp(a.target, b.target) || cmp(a.item, b.item) || cmp(a.status, b.status));
  const soldOut = (
    await sql<{ name: string }[]>`
      SELECT i.name FROM dish_limits l JOIN service_items i ON i.id = l.item_id
      WHERE l.business_date = ${today} AND l.remaining = 0 AND i.name IN ${sql(dishNames)}`
  )
    .map((r) => r.name)
    .sort(cmp);
  const [table] = await sql<{ guests: number | null }[]>`
    SELECT (SELECT ts.guests FROM table_sessions ts WHERE ts.table_id = dt.id AND ts.status = 'open' ORDER BY ts.id DESC LIMIT 1) AS guests
    FROM dining_tables dt WHERE dt.name = ${TABLE.name}`;
  const [active] = await sql<{ id: number }[]>`SELECT id FROM floorplan_batches WHERE status = 'active'`;
  const outlined = active
    ? (
        await sql<{ code: string }[]>`
          SELECT code FROM floorplan_rooms WHERE batch_id = ${active.id} AND status = 'ok' AND code IN ${sql(SPACES.map((s) => s.code))}`
      )
        .map((r) => r.code)
        .sort(cmp)
    : [];
  const locations: Record<string, string> = {};
  for (const g of labels) locations[g] = '没有位置';
  for (const t of TECHS) locations[t.techNo] = '没有位置';
  const placeOf = (r: { state: string; spaceCode: string | null; zoneName: string | null; floorCode: string | null }) =>
    r.state === 'at' ? (r.spaceCode ?? r.zoneName ?? r.floorCode ?? '?') : r.state === 'left' ? '位置不明' : r.state === 'gone' ? '离店' : '没有位置';
  for (const r of await sql<{ who: string; state: string; spaceCode: string | null; zoneName: string | null; floorCode: string | null }[]>`
    SELECT COALESCE(v.guest_label, t.tech_no) AS who, c.state, sp.code AS space_code, z.name AS zone_name, f.code AS floor_code
    FROM current_locations c
    LEFT JOIN visits v ON v.id = c.visit_id AND v.status = 'open'
    LEFT JOIN technicians t ON t.id = c.technician_id
    LEFT JOIN spaces sp ON sp.id = c.space_id LEFT JOIN zones z ON z.id = c.zone_id LEFT JOIN floors f ON f.id = c.floor_id
    WHERE v.guest_label IN ${sql(labels)} OR t.tech_no IN ${sql(TECHS.map((x) => x.techNo))}`) {
    locations[r.who] = placeOf(r);
  }
  const readers = (await sql<{ code: string }[]>`SELECT code FROM location_readers WHERE active AND code IN ${sql(READERS.map((r) => r.code))}`)
    .map((r) => r.code)
    .sort(cmp);
  return {
    guests,
    rooms,
    sessions,
    technicians,
    kitchen,
    soldOut,
    table: { name: TABLE.name, open: table?.guests != null, guests: table?.guests ?? null },
    floorplan: { active: !!active, outlined },
    locations,
    readers,
  };
}

/** 场景块按天的部分：过了准备的那个营业日会自然清掉，demo-check 不再核对 */
export const SHOWCASE_DAILY_FIELDS = ['technicians', 'soldOut'] as const;
