// 打印用的只读数据（R1.3）：80mm 结账单。交班表直接用 /api/shifts/:id 的班次记录。
// 不改任何单据；结账单在同一个快照里读结账单、明细与余额流水。
//
// v0.7.28 ⑥ 业务单据打到小票机（docs/SCHEDULE_FINISH.md 第 7 节，N7）：结账单、退款单、交班表、日结单（80mm 汇总）
// 在只读快照里排好 ESC/POS 内容（不加业务锁），建成打印任务交给按台的队列；能不能打看「打印单据到小票机」与能不能看那张单据
// （与浏览器打印同一套）。打印机离线、故障时进「等打印机恢复」，恢复后自动补打（devices.ts 的断网打印队列）。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { isDocJobKind, PRINT_PAYLOAD_MAX_BYTES, type DeviceJob, type DeviceJobKind } from '@shared/devices';
import { INSTANCE_LABELS } from '@shared/instance';
import { can } from '@shared/permissions';
import type { CheckoutPrint, CheckoutPrintLine, PrintDoc, PrintPrinter } from '@shared/print';
import { guard } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import { buildCheckoutSlip, buildRefundSlip, buildSettlementSlip, buildShiftSlip, type SlipMeta } from '../devices/slips';
import { ctxOf, type Deps } from '../lib/context';
import { forbidden, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { cancelJob, createDocJob, getJob, listJobs } from './devices';
import { getCheckout } from './frontdesk/checkout';
import { getRefund } from './frontdesk/refunds';
import { resolveReadableDate } from './ledger';
import { loadSettings } from './settings';
import { computeSettlement } from './settlement';
import { getShift } from './shifts';
import { technicianTextSql } from './technicians';

export async function checkoutForPrint(db: Db, id: number): Promise<CheckoutPrint> {
  const detail = await getCheckout(db, id);
  const billIds = detail.bills.map((b) => b.billId);
  // 结账那一刻的明细：结账时已经挂上、当时还没作废的。反结账时作废的门票照样打出，之后新挂的明细不算这张单
  const lines = billIds.length
    ? await db<(CheckoutPrintLine & { billId: number })[]>`
        SELECT l.bill_id, l.name, l.unit_price, l.quantity, l.amount, ${technicianTextSql(db, 'l')} AS technician
        FROM bill_lines l JOIN checkouts c ON c.id = ${id}
        WHERE l.bill_id IN ${db(billIds)} AND l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at)
        ORDER BY l.bill_id, l.id`
    : [];
  const consumptionIds = detail.payments.flatMap((p) => (p.consumption ? [p.consumption.id] : []));
  const entries = consumptionIds.length
    ? await db<{ consumptionId: number; principalDelta: number; bonusDelta: number; principalAfter: number; bonusAfter: number }[]>`
        SELECT consumption_id, principal_delta, bonus_delta, principal_after, bonus_after FROM ledger_entries
        WHERE consumption_id IN ${db(consumptionIds)} AND entry_type = 'consume'`
    : [];
  return {
    ...detail,
    bills: detail.bills.map((b) => {
      const own = lines.filter((l) => l.billId === b.billId).map(({ name, unitPrice, quantity, amount, technician }) => ({ name, unitPrice, quantity, amount, technician }));
      return { ...b, lines: own, linesTotal: own.reduce((s, l) => s + l.amount, 0) };
    }),
    payments: detail.payments.map((p) => {
      const e = p.consumption ? entries.find((x) => x.consumptionId === p.consumption!.id) : undefined;
      return {
        ...p,
        balance: e
          ? {
              before: { principal: e.principalAfter - e.principalDelta, bonus: e.bonusAfter - e.bonusDelta },
              after: { principal: e.principalAfter, bonus: e.bonusAfter },
            }
          : null,
      };
    }),
  };
}

// ───────────────────────── 业务单据打到小票机（v0.7.28） ─────────────────────────

/** 「打到小票机」能选的打印机：启用的、配好了地址的小票打印机（按区域、编号），带这台排队、等恢复的张数 */
export async function listPrinters(db: Db): Promise<PrintPrinter[]> {
  const rows = await db<(Omit<PrintPrinter, 'paperWidth'> & { options: { paperWidth?: 58 | 80 } })[]>`
    SELECT d.id, d.code, d.name, d.area, d.status, d.status_code, d.options,
           (SELECT count(*)::int FROM device_jobs j WHERE j.device_id = d.id AND j.status IN ('queued', 'sending', 'waiting')) AS waiting
    FROM devices d
    WHERE d.enabled AND d.kind = 'printer' AND d.connection IN ('network', 'print_server') AND d.host IS NOT NULL AND d.port IS NOT NULL
    ORDER BY d.area, d.code`;
  return rows.map(({ options, ...r }) => ({ ...r, paperWidth: options.paperWidth === 58 ? 58 : 80 }));
}

const PrintDocInput = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('checkout'), id: z.number().int().positive() }),
    z.object({ type: z.literal('refund'), id: z.number().int().positive() }),
    z.object({ type: z.literal('shift'), id: z.number().int().positive() }),
    z.object({ type: z.literal('settlement'), date: z.string().regex(ISO_DATE, '营业日格式应为 YYYY-MM-DD') }),
  ],
  '请选择要打的单据',
);
const PrintJobInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  deviceId: z.number('请选择打印机').int().positive('请选择打印机'),
  doc: PrintDocInput,
});

const KIND_OF: Record<PrintDoc['type'], DeviceJobKind> = { checkout: 'checkout_slip', refund: 'refund_slip', shift: 'shift_slip', settlement: 'settlement_slip' };

/**
 * 核对能看这张单据（与浏览器打印同一套权限），在只读快照里排好内容。
 * 结账单、退款单：前台查询；交班表：只能打自己的，能看历史营业日的岗位能打别人的；日结单：按能看的营业日。
 */
async function renderDoc(deps: Deps, req: FastifyRequest, doc: PrintDoc, paperWidth: 58 | 80) {
  const { sql, config } = deps;
  const settings = await loadSettings(sql);
  const meta: SlipMeta = {
    storeName: settings.storeName,
    instanceLabel: INSTANCE_LABELS[config.instance],
    production: config.instance === 'prod',
    timeZone: config.timezone,
    paperWidth,
    issuedAt: new Date(),
    issuedBy: req.actor.displayName,
    businessDayStartHour: settings.businessDayStartHour,
  };
  const need = (perm: Parameters<typeof can>[1]) => {
    if (!can(req.actor, perm)) throw forbidden();
  };
  switch (doc.type) {
    case 'checkout': {
      need('frontdesk.read');
      const d = await readSnapshot(sql, (tx) => checkoutForPrint(tx, doc.id));
      return { ref: String(doc.id), label: `结账单 ${d.checkoutNo}`, payload: buildCheckoutSlip(d, meta) };
    }
    case 'refund': {
      need('frontdesk.read');
      const d = await readSnapshot(sql, (tx) => getRefund(tx, doc.id));
      return { ref: String(doc.id), label: `退款单 ${d.refundNo}`, payload: buildRefundSlip(d, meta) };
    }
    case 'shift': {
      need('ledger.readToday');
      const shift = await getShift(sql, doc.id);
      if (shift.staffId !== req.actor.id && !can(req.actor, 'ledger.readHistory')) throw forbidden('只能打印自己的交班表');
      return { ref: String(doc.id), label: `交班表 ${shift.shiftNo}`, payload: buildShiftSlip(shift, meta) };
    }
    case 'settlement': {
      need('ledger.readToday');
      const target = await resolveReadableDate(deps, req, doc.date);
      const today = businessDateOf(new Date(), config.timezone, settings.businessDayStartHour);
      const st = await readSnapshot(sql, (tx) => computeSettlement(tx, target, today));
      return { ref: target, label: `日结单 ${target}`, payload: buildSettlementSlip(st, meta) };
    }
  }
}

export function registerPrintRoutes(app: FastifyInstance, deps: Deps) {
  const log = (msg: string, err: unknown) => app.log.error({ err }, msg);

  app.get('/api/print/checkouts/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(deps.sql, (tx) => checkoutForPrint(tx, id));
  });

  app.get('/api/print/printers', { preHandler: guard('print.network') }, async () => listPrinters(deps.sql));

  // 打一张单据：先核对、排好内容（只读，不加锁），再建打印任务（操作编号的咨询锁 → 打印机一行）
  app.post('/api/print/jobs', { preHandler: guard('print.network') }, async (req) => {
    const input = parse(PrintJobInput, req.body);
    const [printer] = await deps.sql<{ options: { paperWidth?: 58 | 80 } }[]>`SELECT options FROM devices WHERE id = ${input.deviceId}`;
    if (!printer) throw notFound('打印机不存在');
    const r = await renderDoc(deps, req, input.doc, printer.options.paperWidth === 58 ? 58 : 80);
    if (r.payload.length > PRINT_PAYLOAD_MAX_BYTES) throw unprocessable('PRINT_TOO_LONG', '这张单据太长，打不到小票机上，请用浏览器打印');
    return createDocJob(deps, { clientKey: input.clientKey, deviceId: input.deviceId, kind: KIND_OF[input.doc.type], docRef: r.ref, docLabel: r.label, payload: r.payload }, ctxOf(req), log);
  });

  app.get('/api/print/jobs/:id', { preHandler: guard('print.network') }, async (req): Promise<DeviceJob> => getJob(deps.sql, parse(idParam, req.params).id));

  // 还没打完的单据（排队、发送中、等打印机恢复）：设备页的「打印队列」
  app.get('/api/print/queue', { preHandler: guard('print.network') }, async () => {
    const jobs = await listJobs(deps.sql, { open: true, limit: 100 });
    return jobs.filter((j) => isDocJobKind(j.kind));
  });

  app.post('/api/print/jobs/:id/cancel', { preHandler: guard('print.network') }, async (req) =>
    cancelJob(deps, parse(idParam, req.params).id, ctxOf(req), can(req.actor, 'device.manage')),
  );
}

