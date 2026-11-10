// 供应商准入与证照（8.0.7 供应链收尾 2.1，docs/ERP_V807.md，迁移 097）。
//   · 准入状态：待准入 / 已准入 / 暂停。页面上新建的供应商是「待准入」；已有的（升级前）都是「已准入」。
//   · 准入由负责人（inventory.approve）登记：要有一张没过期的营业执照（V1）；暂停要写原因。
//   · 证照：号码、有效期至（空 = 长期）、照片或 PDF；不能删，撤下要写原因（换证 = 撤下旧的、登记新的）。
//   · 采购单提交时：供应商不是「已准入」的，打开了「采购单只能给已准入的供应商」（V2，默认关）就拒绝（SUPPLIER_NOT_ADMITTED），
//     关着只在页面上提醒；补单（急采后补）、演示数据不拦。
//   · 证照到期前 N 天（V3，默认 30）进 ERP 待办，已过期的标红。
// 加锁：照片、PDF 先按内容存（唯一索引去重，不加锁），再锁供应商一行（FOR NO KEY UPDATE）写证照；撤下：供应商一行 → 证照一行；
// 准入、暂停只锁供应商一行（FOR NO KEY UPDATE，锁里读证照）。采购单提交在采购单的锁里只读供应商，不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LICENSE_KINDS, type LicenseDueItem, type SupplierAdmissionView, type SupplierLicense } from '@shared/supply';
import type { Db, Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { attachment } from '../../lib/csv';
import type { Actor, Deps } from '../../lib/context';
import { notFound, unprocessable } from '../../lib/errors';
import { dateSchema, idParam, parse } from '../../lib/validate';
import { todayIn } from '../../lib/dates';
import { setTxTimeouts } from '../../lib/tx';
import { saveImage } from '../requests';
import { loadSettings } from '../settings';
import { readFile, storePdf } from './files';

const LicenseInput = z
  .object({
    kind: z.enum(LICENSE_KINDS, '请选择证照种类'),
    name: z.string().trim().max(40, '证照名称最多 40 个字').default(''),
    licenseNo: z.string().trim().min(1, '请填写证照号码').max(64, '证照号码最多 64 个字'),
    /** 有效期至；不填 = 长期 */
    validUntil: dateSchema('有效期至').nullable().default(null),
    /** 照片（压缩后 ≤ 1 MB）或 PDF（≤ 设置里的大小）；可以不传 */
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], '只能上传照片（JPEG、PNG、WebP）或 PDF').optional(),
    data: z.string().min(16).optional(),
  })
  .refine((l) => l.kind !== 'other' || l.name.length > 0, { message: '「其他」证照请写名称', path: ['name'] })
  .refine((l) => (l.mime === undefined) === (l.data === undefined), { message: '文件不完整，请重新选择', path: ['data'] });

const RemoveInput = z.object({ reason: z.string().trim().min(2, '请写撤下的原因（至少 2 个字）').max(200, '原因最多 200 个字') });

const AdmissionInput = z.object({
  action: z.enum(['approve', 'suspend'], '请选择准入还是暂停'),
  note: z.string().trim().max(200, '说明最多 200 个字').default(''),
});

const licenseUrl = (id: number) => `/api/inventory/supplier-licenses/${id}/download`;

export async function supplierLicenses(db: Db, supplierId: number): Promise<SupplierLicense[]> {
  const rows = await db<{ id: number; supplierId: number; kind: SupplierLicense['kind']; name: string; licenseNo: string; validUntil: string | null; imageId: number | null; fileId: number | null; addedByName: string; addedAt: string }[]>`
    SELECT l.id, l.supplier_id, l.kind, l.name, l.license_no, l.valid_until::text AS valid_until, l.image_id, l.file_id,
           s.display_name AS added_by_name, l.added_at
    FROM supplier_licenses l JOIN staff s ON s.id = l.added_by
    WHERE l.supplier_id = ${supplierId} AND l.removed_at IS NULL
    ORDER BY l.kind = 'business' DESC, l.valid_until NULLS LAST, l.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    supplierId: Number(r.supplierId),
    kind: r.kind,
    name: r.name,
    licenseNo: r.licenseNo,
    validUntil: r.validUntil,
    media: r.imageId ? { kind: 'image', url: `/api/erp/images/${r.imageId}` } : r.fileId ? { kind: 'pdf', url: licenseUrl(Number(r.id)) } : null,
    addedByName: r.addedByName,
    addedAt: r.addedAt,
  }));
}

/** 准入的条件（V1）：有一张没撤下、没过期（或长期）的营业执照 */
async function hasValidBusinessLicense(db: Db, supplierId: number, today: string): Promise<boolean> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM supplier_licenses
    WHERE supplier_id = ${supplierId} AND kind = 'business' AND removed_at IS NULL AND (valid_until IS NULL OR valid_until >= ${today}::date)`;
  return (row?.n ?? 0) > 0;
}

export async function admissionView(db: Db, supplierId: number, today: string): Promise<SupplierAdmissionView> {
  const [s] = await db<{ admission: SupplierAdmissionView['admission']; admissionNote: string; admissionByName: string | null; admissionAt: string | null }[]>`
    SELECT s.admission, s.admission_note, st.display_name AS admission_by_name, s.admission_at
    FROM suppliers s LEFT JOIN staff st ON st.id = s.admission_by WHERE s.id = ${supplierId}`;
  if (!s) throw notFound('供应商不存在');
  return {
    supplierId,
    ...s,
    licenses: await supplierLicenses(db, supplierId),
    canApprove: await hasValidBusinessLicense(db, supplierId, today),
  };
}

async function lockSupplier(tx: Tx, supplierId: number) {
  const [s] = await tx<{ id: number; name: string; code: string; admission: string; active: boolean }[]>`
    SELECT id, name, code, admission, active FROM suppliers WHERE id = ${supplierId} FOR NO KEY UPDATE`;
  if (!s) throw notFound('供应商不存在');
  return s;
}

export async function addLicense(deps: Deps, supplierId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(LicenseInput, raw);
  // 先存内容（同一份只存一份，不加锁）
  let imageId: number | null = null;
  let fileId: number | null = null;
  if (input.mime && input.data) {
    if (input.mime === 'application/pdf') fileId = (await storePdf(deps.sql, 'supplier_license', input.data, actor)).id;
    else imageId = (await saveImage(deps.sql, { mime: input.mime, data: input.data }, actor)).id;
  }
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = await lockSupplier(tx, supplierId);
    // 同一种、同一个号码、同一个有效期的已经登记着（上次没收到结果、重新提交的）：不另记一份
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM supplier_licenses
      WHERE supplier_id = ${supplierId} AND kind = ${input.kind} AND license_no = ${input.licenseNo}
        AND valid_until IS NOT DISTINCT FROM ${input.validUntil}::date AND removed_at IS NULL`;
    if (dup) return;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO supplier_licenses (supplier_id, kind, name, license_no, valid_until, image_id, file_id, added_by)
      VALUES (${supplierId}, ${input.kind}, ${input.name}, ${input.licenseNo}, ${input.validUntil}, ${imageId}, ${fileId}, ${actor.id})
      RETURNING id`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'supplier_license',
      targetType: 'supplier',
      targetId: supplierId,
      detail: { op: 'add', supplier: s.name, licenseId: row!.id, kind: input.kind, licenseNo: input.licenseNo, validUntil: input.validUntil },
      ip,
    });
  });
  return admissionView(deps.sql, supplierId, todayIn(deps.config.timezone));
}

export async function removeLicense(deps: Deps, licenseId: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(RemoveInput, raw);
  const [l] = await deps.sql<{ supplierId: number }[]>`SELECT supplier_id FROM supplier_licenses WHERE id = ${licenseId}`;
  if (!l) throw notFound('证照不存在');
  const supplierId = Number(l.supplierId);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = await lockSupplier(tx, supplierId);
    const [row] = await tx<{ removedAt: string | null; kind: string; licenseNo: string }[]>`
      SELECT removed_at, kind, license_no FROM supplier_licenses WHERE id = ${licenseId} FOR UPDATE`;
    if (!row || row.removedAt) return; // 已经撤下了
    await tx`UPDATE supplier_licenses SET removed_by = ${actor.id}, removed_at = now(), remove_reason = ${reason} WHERE id = ${licenseId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'supplier_license', targetType: 'supplier', targetId: supplierId, detail: { op: 'remove', supplier: s.name, licenseId, kind: row.kind, licenseNo: row.licenseNo, reason }, ip });
  });
  return admissionView(deps.sql, supplierId, todayIn(deps.config.timezone));
}

/** 准入（要有没过期的营业执照，V1）/ 暂停（要写原因） */
export async function setAdmission(deps: Deps, supplierId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(AdmissionInput, raw);
  const today = todayIn(deps.config.timezone);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = await lockSupplier(tx, supplierId);
    if (input.action === 'approve') {
      if (s.admission === 'approved') return;
      if (!(await hasValidBusinessLicense(tx, supplierId, today))) {
        throw unprocessable('LICENSE_REQUIRED', `「${s.name}」还没有登记没过期的营业执照，先在「证照」里登记再准入`);
      }
    } else {
      if (s.admission === 'suspended') return;
      if (input.note.length < 2) throw unprocessable('REASON_REQUIRED', '暂停请写原因（至少 2 个字）');
    }
    const next = input.action === 'approve' ? 'approved' : 'suspended';
    await tx`
      UPDATE suppliers SET admission = ${next}, admission_note = ${input.note}, admission_by = ${actor.id}, admission_at = now(), updated_at = now()
      WHERE id = ${supplierId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'supplier_admission', targetType: 'supplier', targetId: supplierId, detail: { supplier: s.name, from: s.admission, to: next, note: input.note }, ip });
  });
  return admissionView(deps.sql, supplierId, today);
}

/** 到期前 days 天以内（含已过期）的证照：在用的供应商、没撤下的 */
export async function licensesDue(db: Db, today: string, days: number): Promise<LicenseDueItem[]> {
  const rows = await db<(Omit<LicenseDueItem, 'daysLeft'> & { daysLeft: number })[]>`
    SELECT l.id AS license_id, s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name, l.kind, l.name, l.license_no,
           l.valid_until::text AS valid_until, (l.valid_until - ${today}::date)::int AS days_left
    FROM supplier_licenses l JOIN suppliers s ON s.id = l.supplier_id
    WHERE l.removed_at IS NULL AND s.active AND l.valid_until IS NOT NULL AND l.valid_until <= ${today}::date + ${days}::int
    ORDER BY l.valid_until, s.code, l.id`;
  return rows.map((r) => ({ ...r, licenseId: Number(r.licenseId), supplierId: Number(r.supplierId), daysLeft: Number(r.daysLeft) }));
}

export async function admissionCounts(db: Db, today: string, days: number) {
  const [row] = await db<{ pending: number; due: number; expired: number }[]>`
    SELECT (SELECT count(*)::int FROM suppliers WHERE active AND admission = 'pending') AS pending,
           (SELECT count(*)::int FROM supplier_licenses l JOIN suppliers s ON s.id = l.supplier_id
             WHERE l.removed_at IS NULL AND s.active AND l.valid_until IS NOT NULL AND l.valid_until <= ${today}::date + ${days}::int) AS due,
           (SELECT count(*)::int FROM supplier_licenses l JOIN suppliers s ON s.id = l.supplier_id
             WHERE l.removed_at IS NULL AND s.active AND l.valid_until < ${today}::date) AS expired`;
  return { pendingAdmission: row!.pending, licensesDue: row!.due, licensesExpired: row!.expired };
}

/**
 * 采购单提交时核对供应商的准入（在采购单的锁里调用，只读供应商）：不是「已准入」的，
 * 设置里打开了「采购单只能给已准入的供应商」（V2）就拒绝；关着不拦（页面上提醒）。补单、演示数据不拦。
 */
export async function assertSupplierAdmitted(tx: Tx, poId: number) {
  const [po] = await tx<{ backfill: boolean; isSynthetic: boolean; admission: string; name: string }[]>`
    SELECT p.backfill, p.is_synthetic, s.admission, s.name FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ${poId}`;
  if (!po || po.backfill || po.isSynthetic || po.admission === 'approved') return;
  const { supplierApprovedOnly } = await loadSettings(tx);
  if (!supplierApprovedOnly) return;
  const state = po.admission === 'suspended' ? '已暂停' : '还没准入';
  throw unprocessable('SUPPLIER_NOT_ADMITTED', `供应商「${po.name}」${state}：采购单只能给已准入的供应商（经营规则「可调的数值」里设的），请负责人先在供应商档案里准入`);
}

export function registerAdmissionRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const today = () => todayIn(config.timezone);
  app.get('/api/inventory/suppliers/:id/admission', { preHandler: guard('inventory.read') }, async (req) => admissionView(sql, parse(idParam, req.params).id, today()));
  // 照片压缩到 1 MB 以内；PDF 按设置（最多 10 MB，Base64 约 13.4 MB）
  app.post('/api/inventory/suppliers/:id/licenses', { preHandler: guard('inventory.master'), bodyLimit: 14_500_000 }, async (req, reply) => {
    const view = await addLicense(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    reply.code(201);
    return view;
  });
  app.post('/api/inventory/supplier-licenses/:id/remove', { preHandler: guard('inventory.master') }, async (req) =>
    removeLicense(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
  app.get('/api/inventory/supplier-licenses/:id/download', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [l] = await sql<{ fileId: number | null; licenseNo: string; kind: string }[]>`SELECT file_id, license_no, kind FROM supplier_licenses WHERE id = ${id}`;
    if (!l || !l.fileId) throw notFound('证照文件不存在');
    const file = await readFile(sql, Number(l.fileId), 'supplier_license');
    if (!file) throw notFound('证照文件不存在');
    attachment(reply, `证照-${l.licenseNo}.pdf`, file.mime);
    return reply.send(file.data);
  });
  app.post('/api/inventory/suppliers/:id/admission', { preHandler: guard('inventory.approve') }, async (req) =>
    setAdmission(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
  app.get('/api/inventory/supplier-licenses/due', { preHandler: guard('inventory.read') }, async () => {
    const { licenseRemindDays } = await loadSettings(sql);
    return licensesDue(sql, today(), licenseRemindDays);
  });
}
