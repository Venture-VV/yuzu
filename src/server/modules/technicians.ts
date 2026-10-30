// 技师（S6 第一步，v0.7.0）：技师名册、技师规则、需要技师的项目、技师业绩。
// 挂账时选技师在 frontdesk/bills.ts；钟房看板、轮钟排队、上下钟计时与提成在第二步。
//
// 名册是主数据：可以改名字、等级、可做分类，不删除（离职的停用）；工号保存后不变，纸质单与历史明细都按工号对得上。
// 明细只记技师编号，显示时取当前的工号与名字（与经办人的显示方式一致）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRICE_TIERS, type PriceTier } from '@shared/catalog';
import {
  CALL_TYPES,
  DEFAULT_TECHNICIAN_RULES,
  gradeLabel,
  MAX_TECH_NAME,
  TECH_NO_PATTERN,
  type FrontdeskTechnicians,
  type Technician,
  type TechnicianAdmin,
  type TechnicianReport,
  type TechnicianRules,
} from '@shared/technicians';
import { isUniqueViolation, type Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { businessDate } from './frontdesk/common';

export async function loadTechnicianRules(db: Db): Promise<TechnicianRules> {
  const [row] = await db<{ value: Partial<TechnicianRules> }[]>`SELECT value FROM settings WHERE key = 'technician_rules'`;
  return { ...DEFAULT_TECHNICIAN_RULES, ...(row?.value ?? {}) };
}

const TECH_COLUMNS = (db: Db) => db`
  t.id, t.tech_no, t.name, t.gender, t.grade, t.skills, t.active, t.sort_order, t.note, t.is_synthetic`;

/** 按工号排序：数字工号按数值（2 号在 10 号前面），其余按字母 */
const ORDER = (db: Db) => db`t.active DESC, t.sort_order, (t.tech_no ~ '^[0-9]+$') DESC, length(t.tech_no), t.tech_no COLLATE "C", t.id`;

export async function loadTechnicians(db: Db, ids?: number[]): Promise<Map<number, Technician>> {
  const unique = [...new Set(ids ?? [])];
  if (ids && unique.length === 0) return new Map();
  const rows = await db<Technician[]>`
    SELECT ${TECH_COLUMNS(db)} FROM technicians t ${ids ? db`WHERE t.id IN ${db(unique)}` : db``} ORDER BY ${ORDER(db)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** 前台选技师：在职技师与今日（当前营业日）已上的钟数 */
export async function frontdeskTechnicians(db: Db, deps: Deps): Promise<FrontdeskTechnicians> {
  const rules = await loadTechnicianRules(db);
  const today = await businessDate(db, deps, new Date());
  const technicians = await db<FrontdeskTechnicians['technicians']>`
    SELECT ${TECH_COLUMNS(db)},
           coalesce((SELECT sum(l.quantity) FROM bill_lines l
                     WHERE l.technician_id = t.id AND l.status = 'active' AND l.business_date = ${today}), 0)::int AS today_clocks
    FROM technicians t WHERE t.active ORDER BY ${ORDER(db)}`;
  return { rules, technicians };
}

export async function technicianAdmin(db: Db): Promise<TechnicianAdmin> {
  const rules = await loadTechnicianRules(db);
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'technician_rules'`;
  const technicians = await db<TechnicianAdmin['technicians']>`
    SELECT ${TECH_COLUMNS(db)}, t.created_at, t.updated_at,
           (SELECT count(*) FROM bill_lines l WHERE l.technician_id = t.id)::int AS line_count
    FROM technicians t ORDER BY ${ORDER(db)}`;
  // 分类按价目表里的顺序（与「价目与套餐」一致），不依赖数据库的排序规则
  const categories = await db<{ category: string }[]>`
    SELECT coalesce(nullif(category, ''), '其他') AS category FROM service_items GROUP BY 1 ORDER BY min(sort_order), min(id)`;
  return {
    rules,
    rulesUpdatedAt: meta ? new Date(meta.updatedAt).toISOString() : null,
    rulesUpdatedBy: meta?.updatedBy ?? null,
    technicians: technicians.map((t) => ({ ...t, createdAt: new Date(t.createdAt).toISOString(), updatedAt: new Date(t.updatedAt).toISOString() })),
    categories: categories.map((c) => c.category),
  };
}

const skillsInput = z
  .array(z.string().trim().min(1, '分类不能为空').max(16, '分类最多 16 个字'))
  .max(30, '可做的分类最多 30 个')
  .default([])
  .transform((list) => [...new Set(list)]);

const TechnicianInput = z.object({
  name: z.string().trim().min(1, '请填写技师名字').max(MAX_TECH_NAME, `名字最多 ${MAX_TECH_NAME} 个字`),
  gender: z.enum(['male', 'female'], '请选择性别'),
  grade: z.enum(PRICE_TIERS, '请选择技师等级'),
  skills: skillsInput,
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

const NewTechnicianInput = TechnicianInput.extend({
  techNo: z.string().trim().regex(TECH_NO_PATTERN, '工号为 1–6 位数字或字母，例如 08、A12'),
});

const RulesInput = z.object({
  enabled: z.boolean(),
  requireTechnician: z.boolean(),
  tierByGrade: z.boolean(),
  defaultCallType: z.enum(CALL_TYPES, '默认上钟方式应为点钟或轮钟'),
});

const ItemsInput = z.object({
  items: z
    .array(z.object({ id: z.number().int().positive(), required: z.boolean() }))
    .min(1, '没有要调整的项目')
    .max(500),
});

const describeTechnician = (t: { techNo: string; name: string; grade: PriceTier; active: boolean }) =>
  `${t.techNo} 号 ${t.name}（${gradeLabel(t.grade)}${t.active ? '' : '，已停用'}）`;

/** 技师业绩：时段内结账的技师明细，结账那一刻的明细（与部门构成、对账包的部门参考表同一口径）；时段内反结账的冲回 */
export async function technicianReport(db: Db, from: string, to: string): Promise<TechnicianReport> {
  const rows = await db<{ technicianId: number | null; callType: string | null; clocks: number; amount: number }[]>`
    WITH k AS (
      SELECT id, created_at, 1 AS sign FROM checkouts WHERE business_date BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT id, created_at, -1 FROM checkouts WHERE void_business_date BETWEEN ${from} AND ${to}
    )
    SELECT l.technician_id, l.call_type, sum(k.sign * l.quantity)::int AS clocks, sum(k.sign * l.amount)::bigint AS amount
    FROM k JOIN checkout_bills cb ON cb.checkout_id = k.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id AND l.posted_at <= k.created_at AND (l.voided_at IS NULL OR l.voided_at > k.created_at)
    WHERE l.technician_id IS NOT NULL OR l.source = 'therapist'
    GROUP BY 1, 2`;
  const techs = await loadTechnicians(db);
  const byTech = new Map<number, TechnicianReport['rows'][number]>();
  const unassigned = { clocks: 0, amount: 0 };
  for (const r of rows) {
    if (r.technicianId === null) {
      unassigned.clocks += r.clocks;
      unassigned.amount += r.amount;
      continue;
    }
    const t = techs.get(r.technicianId)!;
    const x = byTech.get(t.id) ?? { technicianId: t.id, techNo: t.techNo, name: t.name, grade: t.grade, active: t.active, clocks: 0, designated: 0, rotation: 0, amount: 0 };
    x.clocks += r.clocks;
    x.amount += r.amount;
    if (r.callType === 'designated') x.designated += r.clocks;
    else x.rotation += r.clocks;
    byTech.set(t.id, x);
  }
  // 在职技师都列出（没有钟的也列，排轮钟时看得出谁少）；停用的只在有业绩时列出
  for (const t of techs.values()) {
    if (t.active && !byTech.has(t.id)) {
      byTech.set(t.id, { technicianId: t.id, techNo: t.techNo, name: t.name, grade: t.grade, active: t.active, clocks: 0, designated: 0, rotation: 0, amount: 0 });
    }
  }
  const order = [...techs.keys()];
  const list = [...byTech.values()].sort((a, b) => b.clocks - a.clocks || b.amount - a.amount || order.indexOf(a.technicianId) - order.indexOf(b.technicianId));
  const totals = list.reduce(
    (s, r) => ({ clocks: s.clocks + r.clocks, designated: s.designated + r.designated, rotation: s.rotation + r.rotation, amount: s.amount + r.amount }),
    { clocks: 0, designated: 0, rotation: 0, amount: 0 },
  );
  return { from, to, rows: list, totals, unassigned };
}

export function registerTechnicianRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  app.get('/api/frontdesk/technicians', { preHandler: guard('frontdesk.read') }, async () => frontdeskTechnicians(sql, deps));

  app.get('/api/admin/technicians', { preHandler: guardAny('technician.manage', 'settings.manage', 'catalog.manage', 'audit.read') }, async () =>
    technicianAdmin(sql),
  );

  app.post('/api/admin/technicians', { preHandler: guard('technician.manage') }, async (req) => {
    const t = parse(NewTechnicianInput, req.body);
    try {
      await sql.begin(async (tx) => {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO technicians (tech_no, name, gender, grade, skills, active, sort_order, note, created_by)
          VALUES (${t.techNo}, ${t.name}, ${t.gender}, ${t.grade}, ${t.skills}::text[], ${t.active}, ${t.sortOrder}, ${t.note}, ${req.actor.id})
          RETURNING id`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'technician_saved',
          targetType: 'technician',
          targetId: row!.id,
          detail: { ...t, summary: `新建技师 ${describeTechnician(t)}` },
          ip: req.ip,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('TECH_NO_TAKEN', `工号 ${t.techNo} 已有技师在用（停用的也算），请换一个工号`);
      throw error;
    }
    return technicianAdmin(sql);
  });

  app.put('/api/admin/technicians/:id', { preHandler: guard('technician.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const t = parse(TechnicianInput, req.body);
    await sql.begin(async (tx) => {
      const [before] = await tx<Technician[]>`SELECT ${TECH_COLUMNS(tx)} FROM technicians t WHERE t.id = ${id} FOR UPDATE`;
      if (!before) throw notFound('技师不存在');
      await tx`
        UPDATE technicians SET name = ${t.name}, gender = ${t.gender}, grade = ${t.grade}, skills = ${t.skills}::text[], active = ${t.active},
               sort_order = ${t.sortOrder}, note = ${t.note}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'technician_saved',
        targetType: 'technician',
        targetId: id,
        detail: {
          name: t.name,
          before: { name: before.name, gender: before.gender, grade: before.grade, skills: before.skills, active: before.active, sortOrder: before.sortOrder, note: before.note },
          after: t,
          summary: `修改技师 ${describeTechnician({ ...t, techNo: before.techNo })}`,
        },
        ip: req.ip,
      });
    });
    return technicianAdmin(sql);
  });

  // 技师规则：只改提交的字段，其余沿用当前规则（与前台规则相同的做法）
  app.put('/api/admin/technicians/rules', { preHandler: guard('settings.manage') }, async (req) => {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
      const before = await loadTechnicianRules(tx);
      const after = parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) });
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('technician_rules', ${tx.json(after as never)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key: 'technician_rules', before, after }, ip: req.ip });
    });
    return technicianAdmin(sql);
  });

  // 需要技师的项目：只提交要改的项目（与同时进行的项目编辑按项目 id 升序加锁，串行）
  app.put('/api/admin/technicians/items', { preHandler: guard('catalog.manage') }, async (req) => {
    const { items } = parse(ItemsInput, req.body);
    const ids = [...new Set(items.map((i) => i.id))];
    if (ids.length !== items.length) throw badRequest('同一个项目提交了两次');
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: number; name: string; technicianRequired: boolean }[]>`
        SELECT id, name, technician_required FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
      if (rows.length !== ids.length) throw notFound('有项目不存在，请刷新后重试');
      const want = new Map(items.map((i) => [i.id, i.required]));
      const changed = rows.filter((r) => r.technicianRequired !== want.get(r.id));
      if (changed.length === 0) return;
      const on = changed.filter((r) => want.get(r.id)).map((r) => r.id);
      const off = changed.filter((r) => !want.get(r.id)).map((r) => r.id);
      if (on.length) await tx`UPDATE service_items SET technician_required = true, updated_at = now() WHERE id IN ${tx(on)}`;
      if (off.length) await tx`UPDATE service_items SET technician_required = false, updated_at = now() WHERE id IN ${tx(off)}`;
      const names = (list: number[]) => rows.filter((r) => list.includes(r.id)).map((r) => r.name);
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'items_technician_updated',
        targetType: 'item',
        detail: {
          required: names(on),
          notRequired: names(off),
          summary: [on.length ? `需要技师：${names(on).join('、')}` : '', off.length ? `不需要技师：${names(off).join('、')}` : ''].filter(Boolean).join('；'),
        },
        ip: req.ip,
      });
    });
    return { updated: items.length };
  });
}

/** 明细上的技师（JSON：id、工号、名字、点钟 / 轮钟）；line 为 bill_lines 的别名 */
export const lineTechnicianSql = (db: Db, line: string) => db`
  (SELECT json_build_object('id', t.id, 'techNo', t.tech_no, 'name', t.name, 'callType', ${db(`${line}.call_type`)})
   FROM technicians t WHERE t.id = ${db(`${line}.technician_id`)})`;

/** 明细上的技师文字（结账单、对账包用），例如「08 号 小李 · 点钟」 */
export const technicianTextSql = (db: Db, line: string) => db`
  (SELECT t.tech_no || ' 号 ' || t.name || ' · ' || CASE ${db(`${line}.call_type`)} WHEN 'designated' THEN '点钟' ELSE '轮钟' END
   FROM technicians t WHERE t.id = ${db(`${line}.technician_id`)})`;
