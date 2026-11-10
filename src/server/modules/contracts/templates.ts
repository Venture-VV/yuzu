// 验收标准模板（8.0.7 供应链收尾 2.5，docs/ERP_V807.md，迁移 099）：名称与逐条标准。
// 合同的「验收」一节可以选模板，逐条标准写进合同内容（随合同版本走；改模板不影响已经写进合同的）；登记验收时按条打勾。
// 维护合同的人（contract.manage）新建、修改、停用；能看合同的都能看。不能删，不用了停用。
// 锁：新建只靠名称的唯一约束；修改、停用只锁那一条（带版本号，对不上拒绝 VERSION_CONFLICT）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCEPTANCE_ITEM_MAX_CHARS, ACCEPTANCE_ITEMS_MAX, type AcceptanceTemplate } from '@shared/contracts';
import { isUniqueViolation, type Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { conflict, notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';


const Items = z
  .array(z.string().trim().min(1, '验收标准不能有空行').max(ACCEPTANCE_ITEM_MAX_CHARS, `每条验收标准最多 ${ACCEPTANCE_ITEM_MAX_CHARS} 个字`), '请填写验收标准')
  .min(1, '至少写一条验收标准')
  .max(ACCEPTANCE_ITEMS_MAX, `验收标准最多 ${ACCEPTANCE_ITEMS_MAX} 条`);
const TemplateInput = z.object({
  name: z.string('请填写模板名称').trim().min(1, '请填写模板名称').max(40, '模板名称最多 40 个字'),
  items: Items,
});
const UpdateInput = TemplateInput.extend({
  active: z.boolean().default(true),
  expectedVersion: z.number('缺少版本号，请刷新后再改').int().positive(),
});

export async function listTemplates(db: Db, includeInactive: boolean): Promise<AcceptanceTemplate[]> {
  const rows = await db<AcceptanceTemplate[]>`
    SELECT id, name, items, active, version, updated_at FROM acceptance_templates
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, name`;
  return rows.map((r) => ({ ...r, id: Number(r.id), items: (r.items as unknown as string[]).map(String) }));
}

export async function createTemplate(db: Db, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  const input = parse(TemplateInput, raw);
  try {
    const [row] = await db<{ id: number }[]>`
      INSERT INTO acceptance_templates (name, items, created_by, updated_by)
      VALUES (${input.name}, ${db.json(input.items)}, ${actor.id}, ${actor.id}) RETURNING id`;
    await writeAudit(db, { staffId: actor.id, action: 'acceptance_template', targetType: 'acceptance_template', targetId: row!.id, detail: { op: 'create', name: input.name, items: input.items.length }, ip });
    return Number(row!.id);
  } catch (error) {
    if (isUniqueViolation(error, 'acceptance_templates_name_key')) throw conflict('NAME_EXISTS', `已经有叫「${input.name}」的模板`);
    throw error;
  }
}

export async function updateTemplate(db: Deps['sql'], id: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(UpdateInput, raw);
  try {
    await db.begin(async (tx) => {
      const [cur] = await tx<{ version: number }[]>`SELECT version FROM acceptance_templates WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('模板不存在');
      if (cur.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '模板刚被别人改过，请刷新后再改');
      await tx`
        UPDATE acceptance_templates SET name = ${input.name}, items = ${tx.json(input.items)}, active = ${input.active},
               version = version + 1, updated_by = ${actor.id}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'acceptance_template', targetType: 'acceptance_template', targetId: id, detail: { op: 'update', name: input.name, items: input.items.length, active: input.active }, ip });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'acceptance_templates_name_key')) throw conflict('NAME_EXISTS', `已经有叫「${input.name}」的模板`);
    throw error;
  }
}

export function registerTemplateRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/erp/contracts/acceptance-templates', { preHandler: guard('contract.read') }, async (req) =>
    listTemplates(sql, (req.query as { all?: string } | undefined)?.all === '1'),
  );
  app.post('/api/erp/contracts/acceptance-templates', { preHandler: guard('contract.manage') }, async (req, reply) => {
    await createTemplate(sql, req.body, req.actor, req.ip);
    reply.code(201);
    return listTemplates(sql, true);
  });
  app.put('/api/erp/contracts/acceptance-templates/:id', { preHandler: guard('contract.manage') }, async (req) => {
    await updateTemplate(sql, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    return listTemplates(sql, true);
  });
}
