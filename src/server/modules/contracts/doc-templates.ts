// 8.0.21 合同模板与导出（docs/FINANCE_V8021.md 第 6 节，CW-E / CW20）。
//   · 模板：名称、合同类型、正文（{{字段}} 占位、空行分段、「# 」开头的一行当小标题）、可填字段、可选条款。改模板 = 停用旧版、写一份新版本；
//     已经起草的合同在内容里记着用的是哪一版，模板改了不影响它。维护要「管理合同」，看要「查看合同」。
//   · 导出：合同当时的内容（起草中的是草稿，生效以后是生效的那一版）按模板渲染成段落与两张表；Word（.docx）在这里生成，
//     PDF 用打印页 /print/contract/:id（浏览器「打印 → 存为 PDF」）。导出以后照旧走法务审查、签署与用印（CW5）。
// 锁：模板的新建、改版、停用先取「合同模板 + 编号」的咨询锁（新建取「合同模板」的），改版、停用再锁旧版一行；导出只读。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONTRACT_CATEGORIES } from '@shared/contracts';
import { BUILTIN_TEMPLATE_KEYS, renderContractDoc, TEMPLATE_FIELD_KEY, type ContractTemplate, type DocBlock, type TemplateClause } from '@shared/contract-templates';
import { guard } from '../../auth/guard';
import { readSnapshot, type Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { todayIn } from '../../lib/dates';
import { buildDocx } from '../../lib/docx';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { loadSettings } from '../settings';
import { getContract } from './ledger';

interface Row extends Omit<ContractTemplate, 'id' | 'usedBy'> {
  id: number;
  usedBy: number;
}

export async function listContractTemplates(db: Db, all: boolean): Promise<ContractTemplate[]> {
  const rows = await db<Row[]>`
    SELECT t.id, t.code, t.version, t.name, t.category, t.body, t.fields, t.clauses, t.status, s.display_name AS created_by_name, t.created_at,
           (SELECT count(*)::int FROM contracts c WHERE (c.draft -> 'template' ->> 'id')::bigint = t.id) AS used_by
    FROM contract_templates t JOIN staff s ON s.id = t.created_by
    WHERE ${all} OR t.status = 'active'
    ORDER BY t.code, t.version DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id), createdAt: new Date(r.createdAt).toISOString() }));
}
async function getTemplate(db: Db, id: number): Promise<ContractTemplate> {
  const t = (await listContractTemplates(db, true)).find((x) => x.id === id);
  if (!t) throw notFound('合同模板不存在');
  return t;
}

const FieldInput = z.object({
  key: z.string().trim().regex(TEMPLATE_FIELD_KEY, '字段名用中文或字母开头，最多 12 个字，不要空格和符号'),
  label: z.string().trim().min(1).max(20, '字段说明最多 20 个字'),
  type: z.enum(['text', 'number', 'date']).default('text'),
  required: z.boolean().default(false),
});
const ClauseInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,24}$/, '条款编号用字母数字，最多 24 位'),
  title: z.string().trim().min(1, '请填写条款标题').max(30, '条款标题最多 30 个字'),
  text: z.string().trim().min(1, '请填写条款内容').max(2000, '每条最多 2000 个字'),
  default: z.boolean().default(false),
});
const TemplateInput = z
  .object({
    name: z.string('请填写模板名称').trim().min(1, '请填写模板名称').max(40, '模板名称最多 40 个字'),
    category: z.enum(CONTRACT_CATEGORIES, '请选择合同类型'),
    body: z.string('请填写正文').trim().min(1, '请填写正文').max(30000, '正文最多 30000 个字'),
    fields: z.array(FieldInput).max(30, '可填字段最多 30 个').default([]),
    clauses: z.array(ClauseInput).max(30, '可选条款最多 30 条').default([]),
  })
  .refine((v) => new Set(v.fields.map((f) => f.key)).size === v.fields.length, '可填字段的名字重复了')
  .refine((v) => !v.fields.some((f) => BUILTIN_TEMPLATE_KEYS.has(f.key)), {
    message: '可填字段不能和内置字段重名（合同编号、相对方、总价……这些按合同本身自动带出）',
  })
  .refine((v) => new Set(v.clauses.map((c) => c.key)).size === v.clauses.length, '可选条款的编号重复了');

async function createTemplate(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<ContractTemplate> {
  const input = parse(TemplateInput, raw);
  const id = await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('contract_templates'))`;
    const [n] = await tx<{ n: number }[]>`SELECT count(DISTINCT code)::int AS n FROM contract_templates`;
    const code = `HT-${String(n!.n + 1).padStart(3, '0')}`;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO contract_templates (code, version, name, category, body, fields, clauses, created_by)
      VALUES (${code}, 1, ${input.name}, ${input.category}, ${input.body}, ${tx.json(input.fields as never)}, ${tx.json(input.clauses as never)}, ${actor.id})
      RETURNING id`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_template', targetType: 'contract_template', targetId: row!.id, detail: { op: 'create', code, name: input.name }, ip });
    return Number(row!.id);
  });
  return getTemplate(deps.sql, id);
}

/** 改版：停用这一版、写下一版（只能从在用的那一版改） */
async function reviseTemplate(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<ContractTemplate> {
  const input = parse(TemplateInput, raw);
  const cur = await getTemplate(deps.sql, id);
  const newId = await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`contract_templates:${cur.code}`}))`;
    const [t] = await tx<{ status: string; version: number }[]>`SELECT status, version FROM contract_templates WHERE id = ${id} FOR UPDATE`;
    if (t!.status !== 'active') throw conflict('TEMPLATE_RETIRED', '这一版已经停用了（可能别人刚改过），请刷新后从在用的那一版改');
    await tx`UPDATE contract_templates SET status = 'retired', retired_by = ${actor.id}, retired_at = now() WHERE id = ${id}`;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO contract_templates (code, version, name, category, body, fields, clauses, created_by)
      VALUES (${cur.code}, ${t!.version + 1}, ${input.name}, ${input.category}, ${input.body}, ${tx.json(input.fields as never)}, ${tx.json(input.clauses as never)}, ${actor.id})
      RETURNING id`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_template', targetType: 'contract_template', targetId: row!.id, detail: { op: 'revise', code: cur.code, version: t!.version + 1 }, ip });
    return Number(row!.id);
  });
  return getTemplate(deps.sql, newId);
}

async function retireTemplate(deps: Deps, id: number, actor: Actor, ip?: string): Promise<ContractTemplate> {
  const cur = await getTemplate(deps.sql, id);
  await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`contract_templates:${cur.code}`}))`;
    const [t] = await tx<{ status: string }[]>`SELECT status FROM contract_templates WHERE id = ${id} FOR UPDATE`;
    if (t!.status !== 'active') return;
    await tx`UPDATE contract_templates SET status = 'retired', retired_by = ${actor.id}, retired_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_template', targetType: 'contract_template', targetId: id, detail: { op: 'retire', code: cur.code, version: cur.version }, ip });
  });
  return getTemplate(deps.sql, id);
}

export interface ContractDocument {
  contractNo: string;
  title: string;
  versionLabel: string;
  headerText: string;
  templateName: string | null;
  blocks: DocBlock[];
}

/** 合同当时的内容渲染出来（起草中、已退回的是草稿；之后是生效的那一版） */
export async function contractDocument(db: Db, contractId: number, today: string): Promise<ContractDocument> {
  const c = await getContract(db, today, contractId);
  // 我方（8.0.22）：只有一个公司主体时照旧用门店名；有几个主体时用这份合同的主体（发票抬头）
  const { storeName: shopName } = await loadSettings(db);
  const [ent] = await db<{ name: string; many: boolean }[]>`
    SELECT e.name, (SELECT count(*) FROM legal_entities) > 1 AS many FROM contracts c JOIN legal_entities e ON e.id = c.entity_id WHERE c.id = ${contractId}`;
  const storeName = ent?.many ? ent.name : shopName;
  const draft = c.status === 'draft' || c.status === 'returned' || c.status === 'reviewing' || c.currentVersion === 0;
  const versionLabel = draft ? (c.status === 'reviewing' ? '审查中的稿' : '草稿') : `第 ${c.currentVersion} 版`;
  const ref = c.content.template ?? null;
  const tpl = ref ? ((await db<{ body: string; clauses: TemplateClause[] }[]>`SELECT body, clauses FROM contract_templates WHERE id = ${ref.id}`)[0] ?? null) : null;
  const head = { contractNo: c.contractNo, counterparty: c.counterparty, storeName, versionLabel };
  return {
    contractNo: c.contractNo,
    title: c.content.title,
    versionLabel,
    headerText: `${storeName} · 合同编号 ${c.contractNo} · ${versionLabel}`,
    templateName: ref ? `${ref.name}（第 ${ref.version} 版）` : null,
    blocks: renderContractDoc(c.content, head, tpl),
  };
}

export function registerContractDocRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const today = () => todayIn(deps.config.timezone);
  app.get('/api/erp/contracts/doc-templates', { preHandler: guard('contract.read') }, async (req) => {
    const { all } = parse(z.object({ all: z.coerce.boolean().default(false) }), req.query ?? {});
    return listContractTemplates(sql, all);
  });
  app.get('/api/erp/contracts/doc-templates/:id', { preHandler: guard('contract.read') }, async (req) => getTemplate(sql, parse(idParam, req.params).id));
  // 正文最多 3 万字、条款最多 30 条 × 2000 字：按 UTF-8 的 JSON 超过全局默认的 64 KB，新建、改版放宽到 1 MB（Codex 审查 58100ca 后补）
  app.post('/api/erp/contracts/doc-templates', { preHandler: guard('contract.manage'), bodyLimit: 1_000_000 }, async (req, reply) => {
    const t = await createTemplate(deps, req.body, req.actor, req.ip);
    reply.code(201);
    return t;
  });
  app.post('/api/erp/contracts/doc-templates/:id/revise', { preHandler: guard('contract.manage'), bodyLimit: 1_000_000 }, async (req, reply) => {
    const t = await reviseTemplate(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    reply.code(201);
    return t;
  });
  app.post('/api/erp/contracts/doc-templates/:id/retire', { preHandler: guard('contract.manage') }, async (req) => retireTemplate(deps, parse(idParam, req.params).id, req.actor, req.ip));
  app.get('/api/erp/contracts/:id/document', { preHandler: guard('contract.read') }, async (req) => readSnapshot(sql, (tx) => contractDocument(tx, parse(idParam, req.params).id, today())));
  app.get('/api/erp/contracts/:id/document.docx', { preHandler: guard('contract.read') }, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const doc = await readSnapshot(sql, (tx) => contractDocument(tx, id, today()));
    if (!doc.blocks.length) throw badRequest('合同没有内容');
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'contract_template',
      targetType: 'contract',
      targetId: id,
      detail: { op: 'export_docx', contractNo: doc.contractNo, version: doc.versionLabel },
      ip: req.ip,
    });
    attachment(reply, `合同-${doc.contractNo}-${doc.versionLabel}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    return reply.send(buildDocx(doc.blocks, doc.headerText));
  });
}
