// 合同内容（标题、起止日、总价、税率、运费卸货、四要素、单价表、备注）的校验与整理（v0.7.31，docs/CONTRACTS.md 第 2 节）。
// 起草、变更单保存时只校验格式；提交审查时再核对必填的（起始日、付款节点加起来 100%、采购合同至少一行单价表）。

import { z } from 'zod';
import {
  ACCEPTANCE_ITEM_MAX_CHARS,
  ACCEPTANCE_ITEMS_MAX,
  BEARERS,
  CONTRACT_MAX_LINES,
  PAYMENT_STAGES,
  WARRANTY_BASES,
  type ContractCategory,
  type ContractContent,
  type ContractLineInput,
} from '@shared/contracts';
import { ISO_DATE } from '@shared/business-date';
import type { Db } from '../../db';
import { badRequest, unprocessable } from '../../lib/errors';

const id = z.number().int().positive();
const bp = (label: string) => z.number(`${label}必须是数字`).int(`${label}最多两位小数`).min(0, `${label}不能为负数`).max(10000, `${label}不能超过 100%`);
const text = (label: string, max: number) => z.string().trim().max(max, `${label}最多 ${max} 个字`).default('');
const date = (label: string) => z.string(`${label}格式应为 YYYY-MM-DD`).regex(ISO_DATE, `${label}格式应为 YYYY-MM-DD`).nullable().default(null);
/** 合同金额上限 ¥1 亿（整数分） */
export const CONTRACT_MAX_CENTS = 10_000_000_000;

const LineInput = z.object({
  materialId: id.nullable().default(null),
  itemName: z.string().trim().max(40, '品名最多 40 个字').default(''),
  spec: text('规格', 80),
  unit: z.string().trim().max(8, '单位最多 8 个字').default(''),
  priceCents: z.number('请填写单价').int('单价必须精确到分').min(0, '单价不能为负数').max(CONTRACT_MAX_CENTS, '单价过大'),
  taxRateBp: bp('税率').default(1300),
  qtyMilli: z.number('数量必须是数字').int().positive('数量必须大于 0').max(1_000_000_000_000).nullable().default(null),
});

export const ContentInput = z.object({
  title: z.string('请填写合同标题').trim().min(1, '请填写合同标题').max(60, '标题最多 60 个字'),
  startDate: date('开始日期'),
  endDate: date('结束日期'),
  totalCents: z.number('请填写合同总价').int('总价必须精确到分').min(0, '总价不能为负数').max(CONTRACT_MAX_CENTS, '总价过大'),
  taxRateBp: bp('税率').default(1300),
  freightBearer: z.enum(BEARERS).default('supplier'),
  unloadingBearer: z.enum(BEARERS).default('supplier'),
  paymentTerms: z
    .array(z.object({ stage: z.enum(PAYMENT_STAGES), percentBp: bp('付款比例'), condition: text('付款条件', 60) }))
    .length(PAYMENT_STAGES.length, '付款节点要有预付、到货、验收、质保四段'),
  warranty: z.object({ basis: z.enum(WARRANTY_BASES).default('acceptance'), months: z.number().int('质保期限按整月').min(0).max(120, '质保期限最多 120 个月').default(12) }),
  acceptance: z.object({
    method: text('验收方法', 200),
    signer: text('验收签字', 60),
    penalty: text('不合格处理', 200),
    // 验收标准（8.0.7 2.5）：从模板带出、可以再改；逐条写进合同内容
    templateName: text('验收标准模板', 40),
    items: z
      .array(z.string().trim().min(1, '验收标准不能有空行').max(ACCEPTANCE_ITEM_MAX_CHARS, `每条验收标准最多 ${ACCEPTANCE_ITEM_MAX_CHARS} 个字`))
      .max(ACCEPTANCE_ITEMS_MAX, `验收标准最多 ${ACCEPTANCE_ITEMS_MAX} 条`)
      .default([]),
  }),
  note: text('备注', 200),
  lines: z.array(LineInput).max(CONTRACT_MAX_LINES, `单价表最多 ${CONTRACT_MAX_LINES} 行`).default([]),
});
export type ContentInputT = z.infer<typeof ContentInput>;

/**
 * 整理并核对格式（保存草稿、变更单时）：付款节点按预付 → 到货 → 验收 → 质保的顺序、每段一次；起止日先后；
 * 单价表的物料要在档案里、在用（品名、单位没填的取物料档案的名称、采购单位）。
 */
export async function normalizeContent(db: Db, input: ContentInputT): Promise<ContractContent> {
  const stages = input.paymentTerms.map((t) => t.stage);
  if (PAYMENT_STAGES.some((s, i) => stages[i] !== s)) throw badRequest('付款节点要按预付、到货、验收、质保的顺序各填一段');
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw badRequest('结束日期不能早于开始日期');
  const materialIds = [...new Set(input.lines.map((l) => l.materialId).filter((x): x is number => x !== null))];
  const mats = new Map<number, { name: string; purchaseUnit: string; active: boolean }>();
  if (materialIds.length) {
    const rows = await db<{ id: number; name: string; purchaseUnit: string; active: boolean }[]>`
      SELECT id, name, purchase_unit, active FROM materials WHERE id IN ${db(materialIds)}`;
    for (const r of rows) mats.set(Number(r.id), r);
  }
  const lines: ContractLineInput[] = input.lines.map((l, i) => {
    const m = l.materialId === null ? null : mats.get(l.materialId);
    if (l.materialId !== null && !m) throw unprocessable('MATERIAL_NOT_FOUND', `单价表第 ${i + 1} 行的物料不存在，请刷新后重试`);
    const itemName = l.itemName || m?.name || '';
    const unit = l.unit || m?.purchaseUnit || '';
    if (!itemName) throw badRequest(`单价表第 ${i + 1} 行请填写品名或选择物料`);
    if (!unit) throw badRequest(`单价表第 ${i + 1} 行请填写单位`);
    return { materialId: l.materialId, itemName, spec: l.spec, unit, priceCents: l.priceCents, taxRateBp: l.taxRateBp, qtyMilli: l.qtyMilli };
  });
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.materialId === null) continue;
    const key = `${l.materialId}|${l.unit}`;
    if (seen.has(key)) throw badRequest(`单价表里「${l.itemName}」（${l.unit}）出现了两次，同一物料同一单位只写一行`);
    seen.add(key);
  }
  return {
    title: input.title,
    startDate: input.startDate,
    endDate: input.endDate,
    totalCents: input.totalCents,
    taxRateBp: input.taxRateBp,
    freightBearer: input.freightBearer,
    unloadingBearer: input.unloadingBearer,
    paymentTerms: input.paymentTerms.map((t) => ({ stage: t.stage, percentBp: t.percentBp, condition: t.condition })),
    warranty: { basis: input.warranty.basis, months: input.warranty.months },
    acceptance: {
      method: input.acceptance.method,
      signer: input.acceptance.signer,
      penalty: input.acceptance.penalty,
      templateName: input.acceptance.templateName,
      items: input.acceptance.items,
    },
    note: input.note,
    lines,
  };
}

/** 提交审查前要齐的（C5、C9）：开始日期、付款节点加起来 100%、采购合同至少一行单价表且都选了物料、单价表的物料都还在用 */
export async function assertSubmittable(db: Db, category: ContractCategory, c: ContractContent) {
  if (!c.startDate) throw unprocessable('CONTRACT_INCOMPLETE', '提交审查前请填写合同的开始日期');
  const sum = c.paymentTerms.reduce((s, t) => s + t.percentBp, 0);
  if (sum !== 10000) throw unprocessable('CONTRACT_PAYMENT_TERMS', `付款节点四段加起来要等于 100%（现在是 ${sum / 100}%）`);
  if (c.paymentTerms.find((t) => t.stage === 'warranty')!.percentBp > 0 && c.warranty.months === 0) {
    throw unprocessable('CONTRACT_WARRANTY', '付款节点里有质保金，请填写质保期限');
  }
  if (category === 'purchase') {
    if (c.lines.length === 0) throw unprocessable('CONTRACT_INCOMPLETE', '采购合同提交审查前请填写单价表');
    if (c.lines.some((l) => l.materialId === null)) throw unprocessable('CONTRACT_INCOMPLETE', '采购合同的单价表每一行都要选物料（采购单按它核对）');
  }
  const ids = [...new Set(c.lines.map((l) => l.materialId).filter((x): x is number => x !== null))];
  if (ids.length) {
    const inactive = await db<{ name: string }[]>`SELECT name FROM materials WHERE id IN ${db(ids)} AND NOT active ORDER BY name`;
    if (inactive.length) throw unprocessable('MATERIAL_INACTIVE', `单价表里的「${inactive.map((m) => m.name).join('、')}」已停用`);
  }
}

/** 存进提交记录的内容（单价表另存 contract_lines） */
export function contentWithoutLines(c: ContractContent): Omit<ContractContent, 'lines'> {
  const { lines: _lines, ...rest } = c;
  return rest;
}

/** 读回存着的内容（旧数据缺的字段按空白内容补上） */
export function readContent(raw: unknown): ContractContent {
  const c = (raw ?? {}) as Partial<ContractContent>;
  return {
    title: c.title ?? '',
    startDate: c.startDate ?? null,
    endDate: c.endDate ?? null,
    totalCents: Number(c.totalCents ?? 0),
    taxRateBp: Number(c.taxRateBp ?? 0),
    freightBearer: c.freightBearer ?? 'na',
    unloadingBearer: c.unloadingBearer ?? 'na',
    paymentTerms: (c.paymentTerms ?? []).map((t) => ({ stage: t.stage, percentBp: Number(t.percentBp), condition: t.condition ?? '' })),
    warranty: { basis: c.warranty?.basis ?? 'acceptance', months: Number(c.warranty?.months ?? 0) },
    acceptance: {
      method: c.acceptance?.method ?? '',
      signer: c.acceptance?.signer ?? '',
      penalty: c.acceptance?.penalty ?? '',
      templateName: c.acceptance?.templateName ?? '',
      items: Array.isArray(c.acceptance?.items) ? c.acceptance.items.map(String) : [],
    },
    note: c.note ?? '',
    lines: (c.lines ?? []).map((l) => ({
      materialId: l.materialId === null || l.materialId === undefined ? null : Number(l.materialId),
      itemName: l.itemName ?? '',
      spec: l.spec ?? '',
      unit: l.unit ?? '',
      priceCents: Number(l.priceCents ?? 0),
      taxRateBp: Number(l.taxRateBp ?? 0),
      qtyMilli: l.qtyMilli === null || l.qtyMilli === undefined ? null : Number(l.qtyMilli),
    })),
  };
}
