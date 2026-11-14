import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { can } from '@shared/permissions';
import type { PraiseCenterData, PraisePage, PraiseRanking, PraiseRecord, PraiseStaff } from '@shared/concierge/praise-types';
import { guard } from '../../auth/guard';
import { readSnapshot, type Db, type Tx } from '../../db';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { requireMember } from './store';
import { idList, text, uuid, version, WorkspaceError } from './validation';

const MAX_BYTES = 12 * 1024 * 1024;
const isPraiseStaff = (row: { active: boolean; system: boolean; duties: string[] }) =>
  row.active && !row.system && row.duties.some((d) => d === 'concierge' || d === 'concierge_manager');
const staffId = (value: unknown) => {
  const s = text(value, 20, true);
  if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) throw new WorkspaceError('请选择真实管家员工');
  return s;
};
const day = (value: unknown) => {
  const s = text(value, 10, true);
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s)
    throw new WorkspaceError('好评日期不正确');
  return s;
};
function monthRange(value: string) {
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) throw new WorkspaceError('月份不正确');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5));
  return { from: `${value}-01`, to: `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01` };
}
function previousMonth(month: string) {
  const year = Number(month.slice(0, 4)), n = Number(month.slice(5));
  return `${n === 1 ? year - 1 : year}-${String(n === 1 ? 12 : n - 1).padStart(2, '0')}`;
}
type Cursor = { occurredOn: string; createdAt: string; id: string };
function parseCursor(value: unknown): Cursor | null {
  const s = text(value, 512);
  if (!s) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    const occurredOn = day(v.occurredOn), id = uuid(text(v.id, 80, true)), createdAt = text(v.createdAt, 40, true);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw new Error('invalid');
    // PostgreSQL保留微秒；转为JS Date会截成毫秒，分页会漏掉同一毫秒内的记录。
    return { occurredOn, createdAt, id };
  } catch {
    throw new WorkspaceError('分页位置无效，请从第一页重新查看');
  }
}
function cursorFor(record: PraiseRecord) {
  return Buffer.from(JSON.stringify({ occurredOn: record.occurredOn, createdAt: record.createdAt, id: record.id })).toString('base64url');
}

const selectRecords = (db: Db) => db`
 SELECT p.*,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
        s.active AS staff_active,m.data->>'name' AS member_name,m.code AS member_code,
        creator.display_name AS created_by_name,voider.display_name AS voided_by_name,
        ARRAY(SELECT e.upload_id::text FROM concierge_praise_evidence e WHERE e.praise_id=p.id ORDER BY e.position) AS upload_ids
 FROM concierge_praise p JOIN staff s ON s.id=p.staff_id JOIN staff creator ON creator.id=p.created_by
 LEFT JOIN staff voider ON voider.id=p.voided_by LEFT JOIN concierge_members m ON m.id=p.member_id`;
function mapRecord(row: any): PraiseRecord {
  return {
    id: String(row.id), staffId: String(row.staffId), staffName: row.staffNameSnapshot, staffActive: row.staffActive,
    occurredOn: row.occurredOn, source: row.source, content: row.content, guestName: row.guestName,
    memberId: row.memberId || '', memberName: row.memberName || '', memberCode: row.memberCode ? String(row.memberCode).padStart(6, '0') : '',
    status: row.status, version: row.version, uploadIds: row.uploadIds,
    createdById: String(row.createdBy), createdByName: row.createdByName, createdAt: row.createdAt,
    voidedById: row.voidedBy ? String(row.voidedBy) : '', voidedByName: row.voidedByName || '', voidedAt: row.voidedAt || '', voidReason: row.voidReason,
  };
}
export async function praiseDetail(db: Db, id: string): Promise<PraiseRecord> {
  const [row] = await db`${selectRecords(db)} WHERE p.id=${uuid(id)}::uuid`;
  if (!row) throw new WorkspaceError('好评记录不存在', 404);
  return mapRecord(row);
}
async function candidates(db: Db): Promise<PraiseStaff[]> {
  const rows = await db`SELECT id,display_name,active FROM staff WHERE active AND NOT system AND duties && ARRAY['concierge','concierge_manager']::text[] ORDER BY id`;
  return rows.map((r) => ({ id: String(r.id), name: r.displayName, active: r.active }));
}
async function ranking(db: Db, month: string): Promise<PraiseRanking[]> {
  const { from, to } = monthRange(month);
  const rows = await db`
    WITH counts AS (SELECT staff_id,count(*)::int AS count FROM concierge_praise WHERE status='active' AND occurred_on>=${from}::date AND occurred_on<${to}::date GROUP BY staff_id)
    SELECT s.id,s.display_name,s.active,coalesce(c.count,0)::int AS count
    FROM staff s LEFT JOIN counts c ON c.staff_id=s.id
    WHERE (s.active AND NOT s.system AND s.duties && ARRAY['concierge','concierge_manager']::text[]) OR c.count>0
    ORDER BY count DESC,s.id`;
  let lastCount = -1, rank = 0;
  return rows.map((r, i) => {
    if (r.count !== lastCount) { rank = i + 1; lastCount = r.count; }
    return { id: String(r.id), name: r.displayName, active: r.active, count: r.count, rank: r.count ? rank : null };
  });
}
export async function praiseCenter(db: Db, actor: Actor, timezone: string): Promise<PraiseCenterData> {
  const today = todayIn(timezone), month = today.slice(0, 7), previous = previousMonth(month);
  const staff = await candidates(db), currentMonthRanking = await ranking(db, month), previousMonthRanking = await ranking(db, previous);
  const [total] = await db`SELECT count(*)::int AS count FROM concierge_praise WHERE status='active'`;
  return {
    today, timezone, month, previousMonth: previous,
    monthCount: currentMonthRanking.reduce((sum, row) => sum + row.count, 0),
    previousMonthCount: previousMonthRanking.reduce((sum, row) => sum + row.count, 0), totalCount: total!.count,
    staff, currentMonthRanking, previousMonthRanking,
    canOperate: can(actor, 'concierge.operate'), canManage: can(actor, 'concierge.manage'),
  };
}
export async function praiseList(db: Db, query: Record<string, unknown>): Promise<PraisePage> {
  const month = text(query.month, 7), selectedStaff = query.staffId ? staffId(query.staffId) : '';
  const range = month ? monthRange(month) : null;
  const status = text(query.status, 10) || 'active';
  if (!['active', 'voided', 'all'].includes(status)) throw new WorkspaceError('好评状态不正确');
  const limitText = query.limit === undefined ? '20' : text(query.limit, 2, true);
  if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 50) throw new WorkspaceError('每页数量须为1至50');
  const limit = Number(limitText), cursor = parseCursor(query.cursor);
  const rows = await db`${selectRecords(db)} WHERE true
    ${range ? db`AND p.occurred_on>=${range.from}::date AND p.occurred_on<${range.to}::date` : db``}
    ${selectedStaff ? db`AND p.staff_id=${selectedStaff}::bigint` : db``}
    ${status === 'all' ? db`` : db`AND p.status=${status}`}
    ${cursor ? db`AND (p.occurred_on,p.created_at,p.id)<(${cursor.occurredOn}::date,${cursor.createdAt}::timestamptz,${cursor.id}::uuid)` : db``}
    ORDER BY p.occurred_on DESC,p.created_at DESC,p.id DESC LIMIT ${limit + 1}`;
  const records = rows.slice(0, limit).map(mapRecord);
  const last = rows[limit - 1];
  return { records, nextCursor: rows.length > limit ? cursorFor({ ...records[records.length - 1]!, createdAt: last!.cursorCreatedAt }) : null };
}
async function auditPraise(tx: Tx, actor: Actor, record: PraiseRecord, before: PraiseRecord | null, reason: string, ip?: string) {
  await tx`INSERT INTO concierge_revisions(object_type,object_id,version,snapshot,actor_id,reason) VALUES('praise',${record.id}::uuid,${record.version},${tx.json({ ...record })},${actor.id},${reason})`;
  await writeAudit(tx, {
    staffId: actor.id, action: 'concierge_record', targetType: 'concierge_praise', targetId: record.id,
    detail: { actorName: actor.displayName, label: before ? '撤销管家好评' : '录入管家好评', objectType: 'praise', memberId: record.memberId, before, after: record, reason }, ip,
  });
}
/** 仅由既有 mutate 在同一个模块锁、幂等事务中调用，不在这里另建操作编号机制。 */
export async function executePraise(tx: Tx, actor: Actor, action: string, p: Record<string, any>, timezone: string, ip?: string): Promise<{ id: string }> {
  if (action === 'savePraise') {
    if (p.id) throw new WorkspaceError('好评原始信息不能覆盖，请撤销后重新登记');
    const selectedStaff = staffId(p.staffId), occurredOn = day(p.occurredOn);
    if (occurredOn > todayIn(timezone)) throw new WorkspaceError('好评发生日期不能在未来');
    const source = text(p.source, 80, true), content = text(p.content, 4000, true), guestName = text(p.guestName, 80, true), rawMemberId = text(p.memberId, 80), memberId = rawMemberId ? uuid(rawMemberId) : '';
    const uploadIds = [...new Set(idList(p.uploadIds, 12).map(uuid))];
    if (!uploadIds.length) throw new WorkspaceError('请至少上传一张好评原图凭证');
    const [staff] = await tx`SELECT id,display_name,active,system,duties FROM staff WHERE id=${selectedStaff}::bigint`; // 只读核对，不锁员工一行（8.0.18 整合）
    if (!staff || !isPraiseStaff(staff as any)) throw new WorkspaceError('所选员工不是在岗管家，请重新选择');
    if (memberId) await requireMember(tx, memberId);
    const photos = await tx`SELECT u.id,u.member_id,i.scope,i.size_bytes FROM concierge_uploads u JOIN erp_images i ON i.id=u.image_id WHERE u.id IN ${tx(uploadIds)}`;
    if (photos.length !== uploadIds.length || photos.some((photo) => photo.scope !== 'concierge')) throw new WorkspaceError('好评照片不存在或用途不匹配');
    if (photos.some((photo) => photo.memberId && photo.memberId !== memberId)) throw new WorkspaceError('不能借用其他会员关联的照片，请重新上传好评凭证');
    if (photos.reduce((sum, photo) => sum + Number(photo.sizeBytes), 0) > MAX_BYTES) throw new WorkspaceError('一条好评的照片合计不能超过12MB');
    const id = randomUUID();
    await tx`INSERT INTO concierge_praise(id,staff_id,staff_name_snapshot,occurred_on,source,content,guest_name,member_id,created_by) VALUES(${id}::uuid,${selectedStaff}::bigint,${staff.displayName},${occurredOn}::date,${source},${content},${guestName},${memberId || null}::uuid,${actor.id})`;
    for (const [position, uploadId] of uploadIds.entries()) await tx`INSERT INTO concierge_praise_evidence(praise_id,upload_id,position) VALUES(${id}::uuid,${uploadId}::uuid,${position})`;
    const record = await praiseDetail(tx, id);
    await auditPraise(tx, actor, record, null, '', ip);
    return { id };
  }
  if (action === 'voidPraise') {
    if (!can(actor, 'concierge.manage')) throw new WorkspaceError('只有管家经理可以撤销好评', 403);
    const id = uuid(text(p.id, 80, true)), reason = text(p.reason, 1000, true), expected = version(p.version);
    const [row] = await tx`SELECT id,status,version FROM concierge_praise WHERE id=${id}::uuid FOR UPDATE`;
    if (!row) throw new WorkspaceError('好评记录不存在', 404);
    if (row.version !== expected || row.status !== 'active') throw new WorkspaceError('好评已被同事处理，请刷新核对', 409);
    const before = await praiseDetail(tx, id);
    await tx`UPDATE concierge_praise SET status='voided',version=version+1,voided_by=${actor.id},voided_at=clock_timestamp(),void_reason=${reason} WHERE id=${id}::uuid`;
    await auditPraise(tx, actor, await praiseDetail(tx, id), before, reason, ip);
    return { id };
  }
  throw new WorkspaceError('好评操作不正确');
}
function fail(error: unknown): never {
  if (error instanceof WorkspaceError) throw new AppError(error.status, error.status === 404 ? 'NOT_FOUND' : error.status === 403 ? 'FORBIDDEN' : error.status === 409 ? 'CONCIERGE_CONFLICT' : 'CONCIERGE_VALIDATION', error.message);
  throw error;
}
export function registerConciergePraiseRoutes(app: FastifyInstance, deps: Deps) {
  const route = (path: string, handler: (tx: Tx, req: any) => Promise<unknown>) => app.get(path, { preHandler: guard('concierge.read') }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try { return await readSnapshot(deps.sql, (tx) => handler(tx, req)); } catch (error) { return fail(error); }
  });
  route('/api/concierge/praise/center', (tx, req) => praiseCenter(tx, req.actor, deps.config.timezone));
  route('/api/concierge/praise', (tx, req) => praiseList(tx, req.query));
  route('/api/concierge/praise/:id', (tx, req) => praiseDetail(tx, text(req.params.id, 80, true)));
}
