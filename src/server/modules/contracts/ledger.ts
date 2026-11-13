// 合同的读取（v0.7.31，docs/CONTRACTS.md）：台账、详情（内容与版本、提交记录与各级意见、审批进度、签署、用印、归档、扫描件、
// 变更单、挂的采购单）、到期提醒（C11）、采购单选合同与按单价表核对（C9）。读都不加锁。

import {
  CONTRACT_EFFECTIVE,
  type ChangeKind,
  type ChangeStatus,
  type ChangeView,
  type ContractCategory,
  type ContractCheckResult,
  type ContractDetail,
  type ContractExpiryItem,
  type ContractFileView,
  type ContractLineCheck,
  type ContractLineView,
  type ContractOption,
  type ContractPoView,
  type ContractStatus,
  type ContractSummary,
  type ReviewItem,
  type ReviewView,
  type RevisionView,
  type SealStatus,
  type SealType,
  type SealView,
} from '@shared/contracts';
import type { Db } from '../../db';
import { notFound, unprocessable } from '../../lib/errors';
import { approvalBrief, approvalBriefById } from '../approvals/engine';
import { readContent } from './content';
import { loadSettings } from '../settings';

/** 采购单的状态里算「已经下单」的（草稿、退回、撤回的不算；关闭的按全数算） */
export const PO_ORDERED_STATUSES = ['submitted', 'approved', 'closed'] as const;

export const contractFileUrl = (fileId: number) => `/api/erp/contracts/files/${fileId}`;

interface HeaderRow {
  id: number;
  contractNo: string;
  category: ContractCategory;
  title: string;
  counterparty: string;
  supplierId: number | null;
  supplierName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  handlerId: number;
  handlerName: string;
  status: ContractStatus;
  startDate: string | null;
  endDate: string | null;
  totalCents: number;
  currentVersion: number;
  currentRevisionId: number | null;
  daysLeft: number | null;
  renewalId: number | null;
  renewalNo: string | null;
  renewalStatus: ContractStatus | null;
  openChangeNo: string | null;
  updatedAt: string;
}

const headerSelect = (db: Db, today: string) => db`
  SELECT c.id, c.contract_no, c.category, c.title, c.counterparty, c.supplier_id, s.name AS supplier_name,
         c.department_id, d.name AS department_name, c.handler_id, h.display_name AS handler_name, c.status,
         c.start_date, c.end_date, c.total_cents, c.current_version, c.current_revision_id,
         CASE WHEN c.status IN ('signed', 'archived') AND c.end_date IS NOT NULL THEN (c.end_date - ${today}::date) END AS days_left,
         rn.id AS renewal_id, rn.contract_no AS renewal_no, rn.status AS renewal_status,
         (SELECT x.change_no FROM contract_changes x WHERE x.contract_id = c.id AND x.status IN ('draft', 'reviewing', 'returned') LIMIT 1) AS open_change_no,
         c.updated_at
  FROM contracts c
  JOIN staff h ON h.id = c.handler_id
  LEFT JOIN suppliers s ON s.id = c.supplier_id
  LEFT JOIN departments d ON d.id = c.department_id
  LEFT JOIN LATERAL (SELECT r.id, r.contract_no, r.status FROM contracts r WHERE r.renewal_of = c.id AND r.status <> 'voided' ORDER BY r.id DESC LIMIT 1) rn ON true`;

function toSummary(r: HeaderRow): ContractSummary {
  return {
    id: Number(r.id),
    contractNo: r.contractNo,
    category: r.category,
    title: r.title,
    counterparty: r.counterparty,
    supplierId: r.supplierId === null ? null : Number(r.supplierId),
    departmentName: r.departmentName,
    handlerName: r.handlerName,
    status: r.status,
    startDate: r.startDate,
    endDate: r.endDate,
    totalCents: Number(r.totalCents),
    currentVersion: r.currentVersion,
    daysLeft: r.daysLeft === null ? null : Number(r.daysLeft),
    renewal: r.renewalId === null ? null : { id: Number(r.renewalId), contractNo: r.renewalNo!, status: r.renewalStatus! },
    openChangeNo: r.openChangeNo,
    updatedAt: r.updatedAt,
  };
}

export type ContractListFilter = 'all' | 'drafting' | 'reviewing' | 'effective' | 'expiring' | 'closed';

/** 台账：按状态、类型、关键字（合同号、标题、相对方）筛；最近更新的在前，最多 300 份 */
export async function listContracts(
  db: Db,
  today: string,
  f: { filter?: ContractListFilter; category?: ContractCategory; q?: string } = {},
): Promise<ContractSummary[]> {
  const filter = f.filter ?? 'all';
  const q = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  // 到期提醒的天数（C11，8.0.7 起在「门店基本规则 → 可调的数值」里改）
  const { contractRemindDays } = await loadSettings(db);
  const rows = await db<HeaderRow[]>`
    ${headerSelect(db, today)}
    WHERE true
      ${filter === 'drafting' ? db`AND c.status IN ('draft', 'returned')` : db``}
      ${filter === 'reviewing' ? db`AND c.status = 'reviewing'` : db``}
      ${filter === 'effective' ? db`AND c.status IN ('approved', 'signed', 'archived')` : db``}
      ${filter === 'expiring' ? db`AND c.status IN ('signed', 'archived') AND c.end_date IS NOT NULL AND c.end_date - ${today}::date <= ${contractRemindDays}` : db``}
      ${filter === 'closed' ? db`AND c.status IN ('terminated', 'voided')` : db``}
      ${f.category ? db`AND c.category = ${f.category}` : db``}
      ${q ? db`AND (c.contract_no ILIKE ${q} OR c.title ILIKE ${q} OR c.counterparty ILIKE ${q})` : db``}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 300`;
  return rows.map(toSummary);
}

async function linesOf(db: Db, revisionIds: number[]): Promise<Map<number, ContractLineView[]>> {
  const out = new Map<number, ContractLineView[]>();
  if (revisionIds.length === 0) return out;
  const rows = await db<(ContractLineView & { revisionId: number })[]>`
    SELECT l.revision_id, l.line_no, l.material_id, m.name AS material_name, l.item_name, l.spec, l.unit, l.price_cents, l.tax_rate_bp, l.qty_milli
    FROM contract_lines l LEFT JOIN materials m ON m.id = l.material_id
    WHERE l.revision_id IN ${db(revisionIds)} ORDER BY l.revision_id, l.line_no`;
  for (const r of rows) {
    const list = out.get(Number(r.revisionId)) ?? [];
    list.push({
      lineNo: r.lineNo,
      materialId: r.materialId === null ? null : Number(r.materialId),
      materialName: r.materialName,
      itemName: r.itemName,
      spec: r.spec,
      unit: r.unit,
      priceCents: Number(r.priceCents),
      taxRateBp: r.taxRateBp,
      qtyMilli: r.qtyMilli === null ? null : Number(r.qtyMilli),
    });
    out.set(Number(r.revisionId), list);
  }
  return out;
}

/** 法务审查清单的结论（挂在提交记录上） */
export async function reviewsOf(db: Db, revisionIds: number[]): Promise<Map<number, ReviewView[]>> {
  const out = new Map<number, ReviewView[]>();
  if (revisionIds.length === 0) return out;
  const rows = await db<(Omit<ReviewView, 'items'> & { revisionId: number; items: ReviewItem[] })[]>`
    SELECT v.id, v.revision_id, v.level, v.action, v.items, r.display_name AS reviewer_name, b.display_name AS on_behalf_of_name, v.created_at
    FROM contract_reviews v JOIN staff r ON r.id = v.reviewer_id LEFT JOIN staff b ON b.id = v.on_behalf_of
    WHERE v.revision_id IN ${db(revisionIds)} ORDER BY v.id`;
  for (const r of rows) {
    const { revisionId, ...view } = r;
    const list = out.get(Number(revisionId)) ?? [];
    list.push({ ...view, id: Number(view.id) });
    out.set(Number(revisionId), list);
  }
  return out;
}

/** 提交记录（合同本身与变更单的，按提交先后倒排） */
export async function revisionsOf(db: Db, contractId: number): Promise<RevisionView[]> {
  const rows = await db<{
    id: number;
    seq: number;
    changeId: number | null;
    changeNo: string | null;
    versionNo: number | null;
    content: unknown;
    submittedByName: string;
    submittedAt: string;
    approvalRequestId: number | null;
  }[]>`
    SELECT r.id, r.seq, r.change_id, x.change_no, v.version_no, r.content, s.display_name AS submitted_by_name, r.submitted_at, r.approval_request_id
    FROM contract_revisions r JOIN staff s ON s.id = r.submitted_by
    LEFT JOIN contract_changes x ON x.id = r.change_id LEFT JOIN contract_versions v ON v.revision_id = r.id
    WHERE r.contract_id = ${contractId} ORDER BY r.seq DESC`;
  const ids = rows.map((r) => Number(r.id));
  const lines = await linesOf(db, ids);
  const reviews = await reviewsOf(db, ids);
  const out: RevisionView[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    const { lines: _l, ...content } = readContent(r.content);
    out.push({
      id,
      seq: r.seq,
      changeId: r.changeId === null ? null : Number(r.changeId),
      changeNo: r.changeNo,
      versionNo: r.versionNo,
      content,
      lines: lines.get(id) ?? [],
      submittedByName: r.submittedByName,
      submittedAt: r.submittedAt,
      approval: r.approvalRequestId === null ? null : await approvalBriefById(db, Number(r.approvalRequestId)),
      reviews: reviews.get(id) ?? [],
    });
  }
  return out;
}

async function sealsOf(db: Db, contractId: number): Promise<SealView[]> {
  const rows = await db<{
    id: number;
    sealNo: string;
    sealType: SealType;
    copies: number;
    operatorId: number;
    operatorName: string;
    sealDate: string;
    purpose: string;
    status: SealStatus;
    version: number;
    createdByName: string;
    createdAt: string;
  }[]>`
    SELECT s.id, s.seal_no, s.seal_type, s.copies, s.operator_id, o.display_name AS operator_name, s.seal_date, s.purpose, s.status, s.version,
           c.display_name AS created_by_name, s.created_at
    FROM contract_seals s JOIN staff o ON o.id = s.operator_id JOIN staff c ON c.id = s.created_by
    WHERE s.contract_id = ${contractId} ORDER BY s.id DESC`;
  const out: SealView[] = [];
  for (const r of rows) {
    out.push({ ...r, id: Number(r.id), operatorId: Number(r.operatorId), approval: await approvalBrief(db, 'contract_seal', Number(r.id)) });
  }
  return out;
}

async function changesOf(db: Db, contractId: number): Promise<ChangeView[]> {
  const rows = await db<{
    id: number;
    changeNo: string;
    baseVersion: number;
    kinds: ChangeKind[];
    reason: string;
    draft: unknown;
    totalCents: number;
    baseTotalCents: number | null;
    deltaCents: number;
    status: ChangeStatus;
    version: number;
    resultVersion: number | null;
    closedReason: string | null;
    createdByName: string;
    createdAt: string;
  }[]>`
    SELECT x.id, x.change_no, x.base_version, x.kinds, x.reason, x.draft, x.total_cents, x.delta_cents, x.status, x.version, x.result_version,
           x.closed_reason, c.display_name AS created_by_name, x.created_at,
           (SELECT (r.content->>'totalCents')::bigint FROM contract_versions v JOIN contract_revisions r ON r.id = v.revision_id
            WHERE v.contract_id = x.contract_id AND v.version_no = x.base_version) AS base_total_cents
    FROM contract_changes x JOIN staff c ON c.id = x.created_by
    WHERE x.contract_id = ${contractId} ORDER BY x.id DESC`;
  const out: ChangeView[] = [];
  for (const r of rows) {
    out.push({
      ...r,
      id: Number(r.id),
      draft: readContent(r.draft),
      totalCents: Number(r.totalCents),
      baseTotalCents: r.baseTotalCents === null ? Number(r.totalCents) : Number(r.baseTotalCents),
      deltaCents: Number(r.deltaCents),
      approval: await approvalBrief(db, 'contract_change', Number(r.id)),
    });
  }
  return out;
}

async function filesOf(db: Db, contractId: number): Promise<ContractFileView[]> {
  const rows = await db<{ id: number; imageId: number | null; fileId: number | null; name: string; sortNo: number; addedByName: string; addedAt: string }[]>`
    SELECT f.id, f.image_id, f.file_id, f.name, f.sort_no, s.display_name AS added_by_name, f.added_at
    FROM contract_files f JOIN staff s ON s.id = f.added_by
    WHERE f.contract_id = ${contractId} AND f.removed_at IS NULL ORDER BY f.sort_no`;
  return rows.map(({ fileId, ...r }) => ({
    ...r,
    id: Number(r.id),
    imageId: r.imageId === null ? null : Number(r.imageId),
    kind: fileId === null ? 'image' : 'pdf',
    url: contractFileUrl(Number(r.id)),
  }));
}

async function posOf(db: Db, contractId: number): Promise<ContractPoView[]> {
  const rows = await db<{ id: number; docNo: string; status: string; totalCents: number; contractNote: string; createdAt: string }[]>`
    SELECT id, doc_no, status, total_cents, contract_note, created_at FROM purchase_orders
    WHERE contract_id = ${contractId} ORDER BY id DESC LIMIT 100`;
  return rows.map((r) => ({ ...r, id: Number(r.id), totalCents: Number(r.totalCents) }));
}

/** 详情：没生效前的内容取草稿，生效以后取生效的那一版（含单价表） */
export async function getContract(db: Db, today: string, contractId: number): Promise<ContractDetail> {
  const [h] = await db<(HeaderRow & {
    draft: unknown;
    version: number;
    renewalOf: number | null;
    renewalOfNo: string | null;
    signedOn: string | null;
    ourSignatory: string | null;
    theirSignatory: string | null;
    signedByName: string | null;
    archiveNo: string | null;
    archiveLocation: string | null;
    archivedAt: string | null;
    closedReason: string | null;
    closedOn: string | null;
    closedByName: string | null;
    createdByName: string;
    createdAt: string;
  })[]>`
    SELECT x.*, c.draft, c.version, c.renewal_of, ro.contract_no AS renewal_of_no, c.signed_on, c.our_signatory, c.their_signatory,
           sb.display_name AS signed_by_name, c.archive_no, c.archive_location, c.archived_at, c.closed_reason, c.closed_on,
           cb.display_name AS closed_by_name, cr.display_name AS created_by_name, c.created_at
    FROM (${headerSelect(db, today)} WHERE c.id = ${contractId}) x
    JOIN contracts c ON c.id = x.id
    JOIN staff cr ON cr.id = c.created_by
    LEFT JOIN contracts ro ON ro.id = c.renewal_of
    LEFT JOIN staff sb ON sb.id = c.signed_by
    LEFT JOIN staff cb ON cb.id = c.closed_by`;
  if (!h) throw notFound('合同不存在');
  let content = readContent(h.draft);
  if (h.currentRevisionId !== null) {
    const [rev] = await db<{ content: unknown }[]>`SELECT content FROM contract_revisions WHERE id = ${h.currentRevisionId}`;
    const lines = (await linesOf(db, [Number(h.currentRevisionId)])).get(Number(h.currentRevisionId)) ?? [];
    content = { ...readContent(rev!.content), lines: lines.map(({ lineNo: _n, materialName: _m, ...l }) => l) };
  }
  return {
    ...toSummary(h),
    supplierName: h.supplierName,
    departmentId: h.departmentId === null ? null : Number(h.departmentId),
    handlerId: Number(h.handlerId),
    renewalOf: h.renewalOf === null ? null : { id: Number(h.renewalOf), contractNo: h.renewalOfNo! },
    content,
    version: h.version,
    signedOn: h.signedOn,
    ourSignatory: h.ourSignatory,
    theirSignatory: h.theirSignatory,
    signedByName: h.signedByName,
    archiveNo: h.archiveNo,
    archiveLocation: h.archiveLocation,
    archivedAt: h.archivedAt,
    closedReason: h.closedReason,
    closedOn: h.closedOn,
    closedByName: h.closedByName,
    createdByName: h.createdByName,
    createdAt: h.createdAt,
    approval: await approvalBrief(db, 'contract', contractId),
    revisions: await revisionsOf(db, contractId),
    seals: await sealsOf(db, contractId),
    changes: await changesOf(db, contractId),
    files: await filesOf(db, contractId),
    purchaseOrders: await posOf(db, contractId),
  };
}

/** 到期提醒（C11）：生效中、结束日在 N 天内（默认 60，8.0.7 起可改；含已过的）、没续签生效的 */
export async function expiringContracts(db: Db, today: string): Promise<ContractExpiryItem[]> {
  const { contractRemindDays } = await loadSettings(db);
  const rows = await db<HeaderRow[]>`
    ${headerSelect(db, today)}
    WHERE c.status IN ('signed', 'archived') AND c.end_date IS NOT NULL AND c.end_date - ${today}::date <= ${contractRemindDays}
      AND NOT EXISTS (SELECT 1 FROM contracts n WHERE n.renewal_of = c.id AND n.status IN ('signed', 'archived'))
    ORDER BY c.end_date, c.id`;
  return rows.map((r) => {
    const s = toSummary(r);
    return { id: s.id, contractNo: s.contractNo, title: s.title, counterparty: s.counterparty, endDate: s.endDate!, daysLeft: s.daysLeft!, handlerName: s.handlerName, renewal: s.renewal };
  });
}

/** 生效那一版的单价表 */
export async function currentLines(db: Db, contractId: number): Promise<ContractLineView[]> {
  const [c] = await db<{ revisionId: number | null }[]>`SELECT current_revision_id AS revision_id FROM contracts WHERE id = ${contractId}`;
  if (!c || c.revisionId === null) return [];
  return (await linesOf(db, [Number(c.revisionId)])).get(Number(c.revisionId)) ?? [];
}

/** 挂这份合同、已经下单的数量（按物料与采购单位；excludePoId：核对某张采购单自己时不算它） */
export async function orderedQty(db: Db, contractId: number, excludePoId: number | null): Promise<Map<string, number>> {
  const rows = await db<{ materialId: number; unit: string; qty: string }[]>`
    SELECT pl.material_id, pl.purchase_unit AS unit, sum(pl.purchase_qty_milli)::text AS qty
    FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    WHERE po.contract_id = ${contractId} AND po.status IN ${db(PO_ORDERED_STATUSES as unknown as string[])}
      ${excludePoId === null ? db`` : db`AND po.id <> ${excludePoId}`}
    GROUP BY pl.material_id, pl.purchase_unit`;
  return new Map(rows.map((r) => [`${r.materialId}|${r.unit}`, Number(r.qty)]));
}

/** 采购单选合同用（C9）：同一供应商、采购类型、生效中、今天在起止日内 */
export async function contractOptions(db: Db, today: string, supplierId: number): Promise<ContractOption[]> {
  const rows = await db<{ id: number; contractNo: string; title: string; endDate: string | null }[]>`
    SELECT id, contract_no, title, end_date FROM contracts
    WHERE supplier_id = ${supplierId} AND category = 'purchase' AND status IN ${db(CONTRACT_EFFECTIVE as string[])}
      AND (start_date IS NULL OR start_date <= ${today}) AND (end_date IS NULL OR end_date >= ${today})
    ORDER BY id DESC`;
  const out: ContractOption[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    const lines = await currentLines(db, id);
    const ordered = await orderedQty(db, id, null);
    const orderedMilli: Record<number, number> = {};
    for (const l of lines) if (l.materialId !== null) orderedMilli[l.lineNo] = ordered.get(`${l.materialId}|${l.unit}`) ?? 0;
    out.push({ id, contractNo: r.contractNo, title: r.title, endDate: r.endDate, lines, orderedMilli });
  }
  return out;
}

/**
 * 采购单的行与合同的单价表核对（C9）：同一物料、同一采购单位的，单价超过合同价、数量超过合同剩余量（合同数量 − 别的采购单已经下的）的标出来；
 * 合同里没有这一项、单位不同的只提示，不算超出。
 */
export async function checkAgainstContract(
  db: Db,
  contractId: number,
  contractNo: string,
  poLines: { lineNo: number; materialId: number; purchaseUnit: string; purchaseQtyMilli: number; priceCents: number }[],
  excludePoId: number | null,
): Promise<ContractCheckResult> {
  const lines = await currentLines(db, contractId);
  const ordered = await orderedQty(db, contractId, excludePoId);
  // 同一张采购单里同一物料几行时，数量一起算
  const usedHere = new Map<string, number>();
  const out: ContractLineCheck[] = [];
  for (const pl of poLines) {
    const sameMaterial = lines.filter((l) => l.materialId === pl.materialId);
    const line = sameMaterial.find((l) => l.unit === pl.purchaseUnit) ?? null;
    if (!line) {
      out.push({
        lineNo: pl.lineNo,
        materialId: pl.materialId,
        notInContract: sameMaterial.length === 0,
        unitMismatch: sameMaterial.length > 0,
        contractPriceCents: null,
        priceOverCents: 0,
        remainingMilli: null,
        overQtyMilli: 0,
      });
      continue;
    }
    const key = `${pl.materialId}|${pl.purchaseUnit}`;
    const before = (ordered.get(key) ?? 0) + (usedHere.get(key) ?? 0);
    usedHere.set(key, (usedHere.get(key) ?? 0) + pl.purchaseQtyMilli);
    const remaining = line.qtyMilli === null ? null : line.qtyMilli - before;
    out.push({
      lineNo: pl.lineNo,
      materialId: pl.materialId,
      notInContract: false,
      unitMismatch: false,
      contractPriceCents: line.priceCents,
      priceOverCents: Math.max(0, pl.priceCents - line.priceCents),
      remainingMilli: remaining,
      overQtyMilli: remaining === null ? 0 : Math.max(0, pl.purchaseQtyMilli - Math.max(0, remaining)),
    });
  }
  return { contractId, contractNo, lines: out, exceeded: out.some((l) => l.priceOverCents > 0 || l.overQtyMilli > 0) };
}

/**
 * 合同自检（进 `check`，v0.7.31）：
 *   · 审批通过以后的合同，生效的那份提交记录在版本表里、版本号对得上，那张审批单已通过；
 *   · 合同、合同变更通过的审批单，审批链里有法务那一级的，法务同意时都留了审查清单的结论；
 *   · 已归档的合同有生效的用印登记与扫描件；同一合同没结束的变更单不超过一张（索引兜底）。
 */
export async function contractChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const versions = await db<{ contractNo: string }[]>`
    SELECT c.contract_no FROM contracts c
    LEFT JOIN contract_versions v ON v.revision_id = c.current_revision_id
    LEFT JOIN contract_revisions r ON r.id = c.current_revision_id
    LEFT JOIN approval_requests q ON q.id = r.approval_request_id
    WHERE c.current_revision_id IS NOT NULL
      AND (v.id IS NULL OR v.version_no <> c.current_version OR v.contract_id <> c.id OR q.status IS DISTINCT FROM 'approved')`;
  const legal = await db<{ docNo: string }[]>`
    SELECT q.doc_no FROM approval_requests q
    JOIN contract_revisions r ON r.approval_request_id = q.id
    WHERE q.doc_kind IN ('contract', 'contract_change') AND q.status = 'approved'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.steps) s WHERE s->>'group' = 'legal')
      AND NOT EXISTS (SELECT 1 FROM contract_reviews v WHERE v.revision_id = r.id AND v.approval_request_id = q.id AND v.action = 'approve')`;
  const archived = await db<{ contractNo: string }[]>`
    SELECT c.contract_no FROM contracts c
    WHERE c.archived_at IS NOT NULL
      AND (NOT EXISTS (SELECT 1 FROM contract_seals s WHERE s.contract_id = c.id AND s.status = 'approved')
           OR NOT EXISTS (SELECT 1 FROM contract_files f WHERE f.contract_id = c.id AND f.removed_at IS NULL))`;
  const bad = [
    ...versions.map((v) => `${v.contractNo} 生效的版本与提交记录、审批单对不上`),
    ...legal.map((l) => `${l.docNo} 审批通过了但法务那一级没有审查清单的结论`),
    ...archived.map((a) => `${a.contractNo} 归档过但没有生效的用印登记或扫描件`),
  ];
  return [
    {
      key: 'contracts',
      label: '合同：生效的版本、法务审查清单、归档的用印与扫描件一致',
      ok: bad.length === 0,
      detail: bad.length ? bad.join('；') : '一致',
    },
  ];
}

/** 采购单挂的合同与按单价表核对的结果（采购单详情、审批中心的要点、提交时的核对共用；只读） */
export async function poContract(db: Db, poId: number): Promise<{ contract: { id: number; contractNo: string; title: string } | null; contractNote: string; contractCheck: ContractCheckResult | null }> {
  const [p] = await db<{ contractId: number | null; contractNo: string | null; title: string | null; contractNote: string }[]>`
    SELECT po.contract_id, c.contract_no, c.title, po.contract_note
    FROM purchase_orders po LEFT JOIN contracts c ON c.id = po.contract_id WHERE po.id = ${poId}`;
  if (!p || p.contractId === null) return { contract: null, contractNote: p?.contractNote ?? '', contractCheck: null };
  const lines = await db<{ lineNo: number; materialId: number; purchaseUnit: string; purchaseQtyMilli: number; priceCents: number }[]>`
    SELECT line_no, material_id, purchase_unit, purchase_qty_milli, price_cents FROM purchase_order_lines WHERE po_id = ${poId} ORDER BY line_no`;
  const contractId = Number(p.contractId);
  return {
    contract: { id: contractId, contractNo: p.contractNo!, title: p.title! },
    contractNote: p.contractNote,
    contractCheck: await checkAgainstContract(
      db,
      contractId,
      p.contractNo!,
      lines.map((l) => ({ lineNo: l.lineNo, materialId: Number(l.materialId), purchaseUnit: l.purchaseUnit, purchaseQtyMilli: Number(l.purchaseQtyMilli), priceCents: Number(l.priceCents) })),
      poId,
    ),
  };
}

/** 采购单能挂这份合同吗（C9）：同一供应商、采购类型、已签署或已归档、下单日在起止日内 */
export async function assertContractForPo(db: Db, contractId: number, supplierId: number, orderDate: string): Promise<void> {
  const [c] = await db<{ contractNo: string; supplierId: number | null; category: ContractCategory; status: ContractStatus; startDate: string | null; endDate: string | null }[]>`
    SELECT contract_no, supplier_id, category, status, start_date, end_date FROM contracts WHERE id = ${contractId}`;
  if (!c) throw unprocessable('CONTRACT_NOT_FOUND', '合同不存在，请刷新后重新选');
  if (c.category !== 'purchase' || Number(c.supplierId) !== supplierId) throw unprocessable('CONTRACT_MISMATCH', `合同 ${c.contractNo} 不是这家供应商的采购合同`);
  if (!CONTRACT_EFFECTIVE.includes(c.status)) throw unprocessable('CONTRACT_NOT_EFFECTIVE', `合同 ${c.contractNo} 不在生效中（已签署或已归档的才能挂）`);
  if ((c.startDate && orderDate < c.startDate) || (c.endDate && orderDate > c.endDate)) {
    throw unprocessable('CONTRACT_NOT_EFFECTIVE', `下单日不在合同 ${c.contractNo} 的起止日内（${c.startDate ?? '—'} 至 ${c.endDate ?? '长期'}）`);
  }
}
