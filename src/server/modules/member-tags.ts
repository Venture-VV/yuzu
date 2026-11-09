// 会员标签（8.0.4 需求表 05，docs/MEMBERSHIP_V804.md 第 5 节）：原来的会员自定义字段改成标签（迁移 088 把填过的值都转成了标签）。
//   · 后台「会员与渠道 → 会员标签」：建、改名、改分组、停用 / 启用（不能删；权限「修改经营规则」，与原来的自定义字段一样）；
//   · 新建、编辑会员时挂标签（整组替换，在编辑会员的事务里、锁住会员一行之后写；只能挂启用的，已经挂着的停用标签保留）；
//   · 按标签筛选：前台会员列表（查看会员）；数据看板「会员总览 → 按标签」列名单、导出（会员总览的岗位）。
// 锁：改标签只锁标签一行（带版本号）；挂标签：会员一行 → 标签（共享锁，id 升序）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_MEMBER_TAGS,
  MAX_TAG_EXPORT,
  MAX_TAG_GROUP,
  MAX_TAG_NAME,
  MAX_TAGS,
  tagLabel,
  type MemberTag,
  type MemberTagBrief,
  type TagMatchMode,
  type TagMemberReport,
  type TagMemberRow,
} from '@shared/member-tags';
import { gradeLabel } from '@shared/membership';
import { guard } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { loadMembershipRules } from './membership';

const TAG_COLUMNS = (db: Db) => db`
  t.id, t.group_name, t.name, t.active, t.source, t.sort_order, t.version, t.updated_at, s.display_name AS updated_by_name,
  (SELECT count(*)::int FROM member_tag_links l WHERE l.tag_id = t.id) AS member_count`;

export async function listTags(db: Db): Promise<MemberTag[]> {
  const rows = await db<MemberTag[]>`
    SELECT ${TAG_COLUMNS(db)} FROM member_tags t LEFT JOIN staff s ON s.id = t.updated_by
    ORDER BY t.group_name = '', t.group_name, t.sort_order, t.name, t.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), updatedAt: new Date(r.updatedAt).toISOString() }));
}

async function getTag(db: Db, id: number): Promise<MemberTag> {
  const [r] = await db<MemberTag[]>`SELECT ${TAG_COLUMNS(db)} FROM member_tags t LEFT JOIN staff s ON s.id = t.updated_by WHERE t.id = ${id}`;
  if (!r) throw notFound('标签不存在');
  return { ...r, id: Number(r.id), updatedAt: new Date(r.updatedAt).toISOString() };
}

/** 这几位会员挂的标签（会员详情、编辑会员） */
export async function memberTagsOf(db: Db, memberIds: number[]): Promise<Map<number, MemberTagBrief[]>> {
  const out = new Map<number, MemberTagBrief[]>();
  if (!memberIds.length) return out;
  const rows = await db<(MemberTagBrief & { memberId: number })[]>`
    SELECT l.member_id, t.id, t.group_name, t.name, t.active
    FROM member_tag_links l JOIN member_tags t ON t.id = l.tag_id
    WHERE l.member_id IN ${db(memberIds)}
    ORDER BY t.group_name = '', t.group_name, t.sort_order, t.name, t.id`;
  for (const r of rows) {
    const id = Number(r.memberId);
    out.set(id, [...(out.get(id) ?? []), { id: Number(r.id), groupName: r.groupName, name: r.name, active: r.active }]);
  }
  return out;
}

const NameField = z.string('请填写标签名称').trim().min(1, '请填写标签名称').max(MAX_TAG_NAME, `标签名称最多 ${MAX_TAG_NAME} 个字`);
const GroupField = z.string().trim().max(MAX_TAG_GROUP, `分组最多 ${MAX_TAG_GROUP} 个字`).default('');
const CreateInput = z.object({ name: NameField, groupName: GroupField });
const UpdateInput = z.object({
  expectedVersion: z.number('缺少版本号，请刷新后重试').int().min(1),
  name: NameField.optional(),
  groupName: z.string().trim().max(MAX_TAG_GROUP, `分组最多 ${MAX_TAG_GROUP} 个字`).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

/** 同一分组里不能有同名（不分大小写）的标签 */
async function assertNoTwin(db: Db, groupName: string, name: string, exceptId: number | null) {
  const [twin] = await db<{ id: number }[]>`
    SELECT id FROM member_tags WHERE group_name = ${groupName} AND lower(name) = lower(${name}) AND id <> ${exceptId ?? 0}`;
  if (twin) throw conflict('TAG_EXISTS', `「${tagLabel({ groupName, name })}」已经有了`);
}

export async function createTag(deps: Deps, raw: unknown, ctx: OpContext): Promise<MemberTag> {
  const input = parse(CreateInput, raw);
  try {
    const id = await deps.sql.begin(async (tx) => {
      // 标签的新建串行（数上限、查重名都在锁里）
      await tx`SELECT pg_advisory_xact_lock(hashtext('member_tags'))`;
      const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM member_tags`;
      if (count!.n >= MAX_TAGS) throw unprocessable('TOO_MANY_TAGS', `标签最多 ${MAX_TAGS} 个；不用的请停用`);
      await assertNoTwin(tx, input.groupName, input.name, null);
      const [order] = await tx<{ next: number }[]>`SELECT coalesce(max(sort_order), 0) + 1 AS next FROM member_tags WHERE group_name = ${input.groupName}`;
      const next = order!.next;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO member_tags (group_name, name, source, sort_order, created_by, updated_by)
        VALUES (${input.groupName}, ${input.name}, 'manual', ${next}, ${ctx.actor.id}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'member_tag_saved', targetType: 'member_tag', targetId: row!.id, detail: { created: tagLabel(input) }, ip: ctx.ip });
      return row!.id;
    });
    return getTag(deps.sql, Number(id));
  } catch (error) {
    if (isUniqueViolation(error, 'member_tags_group_name_name_key')) throw conflict('TAG_EXISTS', `「${tagLabel(input)}」已经有了`);
    throw error;
  }
}

export async function updateTag(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<MemberTag> {
  const input = parse(UpdateInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      const [t] = await tx<{ groupName: string; name: string; active: boolean; sortOrder: number; version: number }[]>`
        SELECT group_name, name, active, sort_order, version FROM member_tags WHERE id = ${id} FOR UPDATE`;
      if (!t) throw notFound('标签不存在');
      if (t.version !== input.expectedVersion) throw conflict('TAG_CHANGED', '这个标签刚被别人改过，请刷新后再改');
      const next = {
        groupName: input.groupName ?? t.groupName,
        name: input.name ?? t.name,
        active: input.active ?? t.active,
        sortOrder: input.sortOrder ?? t.sortOrder,
      };
      if (next.groupName === t.groupName && next.name === t.name && next.active === t.active && next.sortOrder === t.sortOrder) return;
      if (next.groupName !== t.groupName || next.name.toLowerCase() !== t.name.toLowerCase()) await assertNoTwin(tx, next.groupName, next.name, id);
      await tx`
        UPDATE member_tags SET group_name = ${next.groupName}, name = ${next.name}, active = ${next.active}, sort_order = ${next.sortOrder},
               version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_tag_saved',
        targetType: 'member_tag',
        targetId: id,
        detail: { before: { label: tagLabel(t), active: t.active }, after: { label: tagLabel(next), active: next.active } },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'member_tags_group_name_name_key')) throw conflict('TAG_EXISTS', '这个分组里已经有同名的标签');
    throw error;
  }
  return getTag(deps.sql, id);
}

export const TagIdsField = z
  .array(z.number('标签编号不对').int('标签编号不对').positive('标签编号不对'))
  .max(MAX_MEMBER_TAGS, `一位会员最多挂 ${MAX_MEMBER_TAGS} 个标签`);

/**
 * 整组替换会员的标签（在编辑、新建会员的事务里，会员一行已锁或刚建）：新挂的只能是启用的标签，已经挂着的停用标签可以留着；
 * 返回挂上、摘掉的标签名（写进会员的审计）
 */
export async function setMemberTags(tx: Tx, memberId: number, tagIds: number[], staffId: number): Promise<{ added: string[]; removed: string[] }> {
  const want = [...new Set(tagIds)].sort((a, b) => a - b);
  const current = await tx<{ tagId: number }[]>`SELECT tag_id FROM member_tag_links WHERE member_id = ${memberId}`;
  const have = new Set(current.map((c) => Number(c.tagId)));
  const tags = want.length
    ? await tx<{ id: number; groupName: string; name: string; active: boolean }[]>`
        SELECT id, group_name, name, active FROM member_tags WHERE id IN ${tx(want)} ORDER BY id FOR SHARE`
    : [];
  if (tags.length !== want.length) throw badRequest('有选中的标签不存在，请刷新后重选', { field: 'tagIds' });
  const fresh = tags.filter((t) => !have.has(Number(t.id)));
  const off = fresh.find((t) => !t.active);
  if (off) throw unprocessable('TAG_INACTIVE', `标签「${tagLabel(off)}」已停用，不能再挂`, { field: 'tagIds' });
  const drop = [...have].filter((id) => !want.includes(id));
  const dropped = drop.length
    ? await tx<{ groupName: string; name: string }[]>`SELECT group_name, name FROM member_tags WHERE id IN ${tx(drop)} ORDER BY id`
    : [];
  if (drop.length) await tx`DELETE FROM member_tag_links WHERE member_id = ${memberId} AND tag_id IN ${tx(drop)}`;
  for (const t of fresh) {
    await tx`INSERT INTO member_tag_links (member_id, tag_id, created_by) VALUES (${memberId}, ${t.id}, ${staffId}) ON CONFLICT DO NOTHING`;
  }
  return { added: fresh.map(tagLabel), removed: dropped.map(tagLabel) };
}

// ───────────────────────── 按标签筛选、导出 ─────────────────────────

const ReportQuery = z.object({
  tagIds: z
    .string('请选择标签')
    .transform((s) => [...new Set(s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))])
    .pipe(z.array(z.number()).min(1, '请至少选一个标签').max(50, '一次最多选 50 个标签')),
  mode: z.enum(['any', 'all']).default('any'),
});

async function tagMembers(db: Db, tagIds: number[], mode: TagMatchMode, limit: number): Promise<{ count: number; rows: TagMemberRow[] }> {
  const need = mode === 'all' ? tagIds.length : 1;
  const matched = await db<{ memberId: number }[]>`
    SELECT l.member_id FROM member_tag_links l JOIN members m ON m.id = l.member_id
    WHERE l.tag_id IN ${db(tagIds)} AND m.merged_into_id IS NULL
    GROUP BY l.member_id HAVING count(DISTINCT l.tag_id) >= ${need}`;
  const ids = matched.map((m) => Number(m.memberId));
  if (!ids.length) return { count: 0, rows: [] };
  const rules = await loadMembershipRules(db);
  const rows = await db<(Omit<TagMemberRow, 'gradeLabel' | 'tags'> & { grade: number; tier: number | null })[]>`
    SELECT m.id, m.member_no, m.name, m.phone, m.status, m.principal_balance, m.bonus_balance, m.grade, m.tier,
           (SELECT max(le.created_at) FROM ledger_entries le WHERE le.member_id = m.id) AS last_activity_at
    FROM members m WHERE m.id IN ${db(ids)}
    ORDER BY last_activity_at DESC NULLS LAST, m.id DESC
    LIMIT ${limit}`;
  const tags = await memberTagsOf(db, rows.map((r) => Number(r.id)));
  return {
    count: ids.length,
    rows: rows.map(({ grade, tier, ...r }) => ({
      ...r,
      id: Number(r.id),
      principalBalance: Number(r.principalBalance),
      bonusBalance: Number(r.bonusBalance),
      lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
      gradeLabel: gradeLabel(rules, grade, tier),
      tags: (tags.get(Number(r.id)) ?? []).map(tagLabel),
    })),
  };
}

export async function tagMemberReport(db: Db, raw: unknown): Promise<TagMemberReport> {
  const q = parse(ReportQuery, raw);
  const { count, rows } = await tagMembers(db, q.tagIds, q.mode, 200);
  return { tagIds: q.tagIds, mode: q.mode, count, rows };
}

const yuanText = (cents: number) => (cents / 100).toFixed(2);

export function registerMemberTagRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 标签清单：新建、编辑会员时挑标签（能看会员的都能读），后台维护（修改经营规则）
  app.get('/api/member-tags', { preHandler: guard('member.read') }, async () => listTags(sql));
  app.post('/api/member-tags', { preHandler: guard('settings.manage') }, async (req, reply) => {
    const tag = await createTag(deps, req.body, ctxOf(req));
    reply.code(201);
    return tag;
  });
  app.put('/api/member-tags/:id', { preHandler: guard('settings.manage') }, async (req) => updateTag(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  // 按标签筛选导出（数据看板「会员总览」的岗位：店主、店总、客户经理）
  app.get('/api/member-tags/members', { preHandler: guard('report.members') }, async (req) => readSnapshot(sql, (tx) => tagMemberReport(tx, req.query ?? {})));
  app.get('/api/member-tags/members.csv', { preHandler: guard('report.members') }, async (req, reply) => {
    const q = parse(ReportQuery, req.query ?? {});
    const { count, rows } = await readSnapshot(sql, (tx) => tagMembers(tx, q.tagIds, q.mode, MAX_TAG_EXPORT));
    const names = (await listTags(sql)).filter((t) => q.tagIds.includes(t.id)).map(tagLabel);
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'member_tags_exported',
      targetType: 'member_tag',
      detail: { tags: names, mode: q.mode, count: Math.min(count, MAX_TAG_EXPORT) },
      ip: req.ip,
    });
    const csv = toCsv([
      ['会员号', '姓名', '手机号', '档阶', '状态', '本金', '赠金', '最近余额变动', '标签'],
      ...rows.map((r) => [r.memberNo, r.name, r.phone, r.gradeLabel, r.status === 'active' ? '正常' : '已停用', yuanText(r.principalBalance), yuanText(r.bonusBalance), r.lastActivityAt ?? '', r.tags.join('、')]),
    ]);
    return csvReply(reply, `会员标签-${names.join('+').slice(0, 40) || '名单'}.csv`, csv);
  });
}
