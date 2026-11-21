// 分部门岗位职权配置（8.2.0 P05，回测 5-2，docs/YUZU_REQ_V820.md 第 6 节）：后台「岗位权限」的第二个页签。
//   · 按部门列出岗位：岗位名、所属部门、建议权限几项、配置状态、在职人数；按部门、岗位搜索在页面上做；
//   · 页面维护每个岗位的建议权限（P04 的 position_suggestions），后续调整不用再找开发；同一个岗位名在不同部门各自一份；
//   · 导出 Excel：一张「职权表」（权限 × 岗位打 ✔，与原始表格逐条核对）、一张岗位汇总、一张变更记录；
//   · 每次改动记 position_config_log（操作人、时间、加了与去了哪几项），另记审计。
// 加锁：规则设置的咨询锁（与「设立岗位」「旧岗位」两张权限表的保存串行）→ 这个岗位一行（FOR UPDATE，核对版本）→ 整批换建议权限。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EditablePosition, PositionCatalogLog, PositionCatalogPosition, PositionCatalogView } from '@shared/admin';
import { ALL_PERMISSIONS, LOCKED_PERMISSIONS, PERMISSION_GROUPS, PERMISSION_LABELS, type Permission } from '@shared/permissions';
import { ADMIN_LEVEL_LABELS, isPositionKey } from '@shared/positions';
import type { Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { knownPermissions, loadRoleOverrides, loadSuggestions } from '../auth/role-permissions';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { attachment } from '../lib/csv';
import { badRequest, conflict, notFound } from '../lib/errors';
import { lockSettings } from '../lib/rule-settings';
import { parse } from '../lib/validate';
import { buildWorkbook, type WbSheet } from '../lib/xlsx';

const PERMISSION_ENUM = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]], '有不认识的权限，请刷新页面后重试');
const SaveInput = z.object({
  permissions: z.array(PERMISSION_ENUM).max(ALL_PERMISSIONS.length),
  /** 打开时这个岗位的版本；别人先改过就拒绝 */
  version: z.string().min(1).max(40),
});

interface CatalogRow {
  key: string;
  department: string;
  departmentName: string;
  title: string;
  level: 'super' | 'senior' | 'admin';
  allPermissions: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

async function catalogRows(db: Db): Promise<CatalogRow[]> {
  return db<CatalogRow[]>`
    SELECT c.key, c.department, d.name AS department_name, c.title, c.level, c.all_permissions, c.updated_at, s.display_name AS updated_by
    FROM position_catalog c JOIN org_departments d ON d.key = c.department LEFT JOIN staff s ON s.id = c.updated_by
    ORDER BY d.sort, c.sort`;
}

const versionOf = (at: string | Date) => new Date(at).toISOString();
const ordered = (list: readonly Permission[]) => ALL_PERMISSIONS.filter((p) => list.includes(p));

export async function positionCatalog(db: Db): Promise<PositionCatalogView> {
  const rows = await catalogRows(db);
  const suggested = await loadSuggestions(db);
  const overrides = (await loadRoleOverrides(db)).positions;
  const staff = await db<{ position: string; n: number }[]>`SELECT position, count(*)::int AS n FROM staff WHERE active AND position IS NOT NULL GROUP BY position`;
  const departments: PositionCatalogView['departments'] = [];
  for (const r of rows) {
    if (r.allPermissions || !isPositionKey(r.key) || r.key === 'president' || r.level === 'super') continue;
    const key = r.key as EditablePosition;
    let dept = departments.find((d) => d.key === r.department);
    if (!dept) departments.push((dept = { key: r.department, name: r.departmentName, positions: [] }));
    const o = overrides[key];
    dept.positions.push({
      key,
      department: r.department,
      departmentName: r.departmentName,
      title: r.title,
      level: r.level,
      suggested: ordered(suggested[key] ?? []),
      staff: Number(staff.find((x) => x.position === key)?.n ?? 0),
      adjusted: !!o && o.add.length + o.remove.length > 0,
      version: versionOf(r.updatedAt),
      updatedBy: r.updatedBy,
    } satisfies PositionCatalogPosition);
  }
  const log = await db<
    { id: number; at: string; staffName: string | null; action: PositionCatalogLog['action']; positionKey: string | null; positionTitle: string | null; detail: Record<string, unknown> }[]
  >`
    SELECT l.id, l.at, s.display_name AS staff_name, l.action, l.position_key, c.title AS position_title, l.detail
    FROM position_config_log l LEFT JOIN staff s ON s.id = l.staff_id LEFT JOIN position_catalog c ON c.key = l.position_key
    ORDER BY l.id DESC LIMIT 100`;
  const [legacy] = await db<{ waiting: number; special: number }[]>`
    SELECT count(*) FILTER (WHERE needs_position)::int AS waiting,
           count(*) FILTER (WHERE role IN ('other_store', 'tablet', 'designer'))::int AS special
    FROM staff WHERE active AND NOT system AND position IS NULL`;
  return {
    departments,
    log: log.map((l) => ({
      id: Number(l.id),
      at: new Date(l.at).toISOString(),
      staffName: l.staffName,
      action: l.action,
      positionKey: l.positionKey,
      positionTitle: l.positionTitle,
      added: knownPermissions(l.detail.added),
      removed: knownPermissions(l.detail.removed),
      note: logNote(l.action, l.detail),
    })),
    legacy: { waiting: Number(legacy?.waiting ?? 0), special: Number(legacy?.special ?? 0) },
  };
}

function logNote(action: PositionCatalogLog['action'], d: Record<string, unknown>): string {
  if (action === 'init') return `按 8.1.18 岗位职权表初始化：${String(d.departments ?? '')} 个部门、${String(d.positions ?? '')} 个岗位、${String(d.suggestions ?? '')} 项建议权限`;
  if (action === 'legacy_migrate')
    return `旧岗位账号：${String(d.waiting ?? 0)} 个老账号等本人登录时选岗位，${String(d.legacy ?? 0)} 个照旧按旧岗位，专用账号 ${String(d.special ?? 0)} 个照旧；不删账号与历史`;
  if (action === 'restore') return '恢复成初始的建议权限';
  return typeof d.reason === 'string' ? d.reason : '';
}

/** 改一个岗位的建议权限：整批换；店主专属的权限不能建议给别的岗位 */
export async function saveSuggestions(deps: Deps, key: string, raw: unknown, actor: { id: number }, ip?: string): Promise<PositionCatalogView> {
  if (!isPositionKey(key) || key === 'president') throw notFound('没有这个岗位');
  const { permissions, version } = parse(SaveInput, raw);
  const locked = permissions.find((p) => LOCKED_PERMISSIONS.includes(p));
  if (locked) throw badRequest(`「${PERMISSION_LABELS[locked]}」只属于总裁，不能作为别的岗位的建议权限`);
  await deps.sql.begin(async (tx) => {
    await lockSettings(tx);
    const [row] = await tx<{ updatedAt: string; allPermissions: boolean; title: string }[]>`
      SELECT updated_at, all_permissions, title FROM position_catalog WHERE key = ${key} FOR UPDATE`;
    if (!row || row.allPermissions) throw notFound('没有这个岗位');
    if (versionOf(row.updatedAt) !== version) throw conflict('POSITION_STALE', `「${row.title}」的建议权限刚被别人改过，请刷新以后再改`);
    const before = knownPermissions((await tx<{ permission: string }[]>`SELECT permission FROM position_suggestions WHERE position_key = ${key}`).map((r) => r.permission));
    const want = ordered(permissions);
    const added = want.filter((p) => !before.includes(p));
    const removed = before.filter((p) => !want.includes(p));
    if (added.length === 0 && removed.length === 0) return;
    await tx`DELETE FROM position_suggestions WHERE position_key = ${key}`;
    if (want.length) await tx`INSERT INTO position_suggestions (position_key, permission) SELECT ${key}, unnest(${want}::text[])`;
    await tx`UPDATE position_catalog SET updated_at = clock_timestamp(), updated_by = ${actor.id} WHERE key = ${key}`;
    await tx`INSERT INTO position_config_log (staff_id, action, position_key, detail) VALUES (${actor.id}, 'suggestions', ${key}, ${tx.json({ added, removed } as never)})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'settings_updated',
      targetType: 'position_suggestions',
      targetId: key,
      detail: { key: 'position_suggestions', position: key, title: row.title, added, removed },
      ip,
    });
  });
  return positionCatalog(deps.sql);
}

/** 导出：职权表（权限 × 岗位打 ✔，与原始表格逐条核对）、岗位汇总、变更记录 */
export async function positionCatalogWorkbook(db: Db): Promise<Buffer> {
  const view = await positionCatalog(db);
  const positions = view.departments.flatMap((d) => d.positions);
  const head = (v: string) => ({ v, style: 'title' as const });
  const matrix: WbSheet = {
    name: '职权表',
    active: true,
    freezeRows: 2,
    widths: [14, 44, 22, ...positions.map(() => 10)],
    rows: [
      { cells: [head('分组'), head('权限'), head('权限编号'), ...positions.map((p) => head(p.departmentName))] },
      { cells: [head(''), head(''), head(''), ...positions.map((p) => head(p.title.replace(p.departmentName, '') || p.title))] },
      ...PERMISSION_GROUPS.flatMap((g) => g.items.map((perm) => ({ cells: [g.title, PERMISSION_LABELS[perm], perm, ...positions.map((p) => (p.suggested.includes(perm) ? '✔' : ''))] }))),
    ],
  };
  const summary: WbSheet = {
    name: '岗位汇总',
    freezeRows: 1,
    widths: [16, 22, 12, 14, 10, 18, 22],
    rows: [
      { cells: ['部门', '岗位', '级别', '建议权限项数', '在职人数', '设立岗位里增减过', '最后修改'].map(head) },
      ...positions.map((p) => ({
        cells: [
          p.departmentName,
          p.title,
          ADMIN_LEVEL_LABELS[p.level],
          p.suggested.length,
          p.staff,
          p.adjusted ? '是' : '否',
          p.updatedBy ? `${p.updatedBy} ${p.version.slice(0, 16).replace('T', ' ')}` : '初始数据',
        ],
      })),
    ],
  };
  const log: WbSheet = {
    name: '变更记录',
    freezeRows: 1,
    widths: [20, 10, 18, 40, 40, 40],
    rows: [
      { cells: ['时间', '操作人', '岗位', '加了', '去了', '说明'].map(head) },
      ...view.log.map((l) => ({
        cells: [
          l.at.slice(0, 19).replace('T', ' '),
          l.staffName ?? '系统',
          l.positionTitle ?? '',
          l.added.map((p) => PERMISSION_LABELS[p]).join('；'),
          l.removed.map((p) => PERMISSION_LABELS[p]).join('；'),
          l.note,
        ],
      })),
    ],
  };
  return buildWorkbook([matrix, summary, log]);
}

export function registerPositionCatalogRoutes(app: FastifyInstance, deps: Deps) {
  const read = { preHandler: guardAny('settings.manage', 'audit.read') };
  app.get('/api/admin/position-catalog', read, async () => positionCatalog(deps.sql));
  app.get('/api/admin/position-catalog/export', read, async (_req, reply) => {
    const buf = await positionCatalogWorkbook(deps.sql);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    attachment(reply, `分部门岗位职权配置-${day}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(buf);
  });
  // 只有超级管理员（总裁）改：与「设立岗位」一样要「修改经营规则」
  app.put('/api/admin/position-catalog/:key', { preHandler: guard('settings.manage') }, async (req) => {
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    return saveSuggestions(deps, key, req.body, req.actor, req.ip);
  });
}
