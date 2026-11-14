// 库存与采购合成演示数据：把 demo/inventory-demo.json（全部虚构，来自需求附件）适配成真实单据。
//
// 只用于独立的演示 / 开发库：
//   · 试用与正式环境一律拒绝；
//   · 库里已有任何非合成的物料、供应商或库存单据时拒绝，避免与真实数据混在一起；
//   · 已经灌过则跳过，可重复执行。
// 所有单据都走正式的建单、确认流程，因此库存流水、应付流水与余额天然一致；记录标记为 is_synthetic
// （先建成草稿 / 待确认、标记后再确认，已确认的付款记录不可再改）。

import { randomUUID } from 'node:crypto';
import { DEFAULT_APPROVAL_RULES } from './modules/inventory/common';
import type { AppConfig } from './config';
import type { Sql } from './db';
import type { Actor, Deps } from './lib/context';
import { answerReturn, approveDoc, createDoc } from './modules/inventory/docs';
import { saveMaterial, saveSupplier } from './modules/inventory/master';
import { actOnOpening, actOnPayment, createOpening, createPayment } from './modules/inventory/payables';
import { approvePo, createPo, submitPo } from './modules/inventory/purchasing';
import { createStaff } from './modules/staff';
import { DEMO_PASSWORD } from './seed';
import demo from './demo/inventory-demo.json' with { type: 'json' };
import { dateIn } from './lib/dates';

type Demo = typeof demo;
const q = (text: string) => Math.round(Number(text) * 1000);

export function demoData(): Demo {
  return demo;
}

export async function seedInventoryDemo(sql: Sql, config: AppConfig) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入库存演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [real] = await sql<{ n: number }[]>`
    SELECT (SELECT count(*) FROM materials WHERE NOT is_synthetic) + (SELECT count(*) FROM suppliers WHERE NOT is_synthetic)
         + (SELECT count(*) FROM inv_docs WHERE NOT is_synthetic) + (SELECT count(*) FROM purchase_orders WHERE NOT is_synthetic) AS n`;
  if (real!.n > 0) throw new Error('库里已有非演示的物料、供应商或单据，为避免混入真实数据，已停止。请使用独立的演示库。');
  const [done] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM materials WHERE is_synthetic`;
  if (done!.n > 0) return { skipped: true as const };

  const deps: Deps = { sql, config };
  // 演示库统一使用默认的模拟审批规则；免确认门槛设为 0（全部要负责人确认），固定预期里的待确认单据才会停在待确认（v0.7.12）。
  // 验收 #18 时在 后台「规则总表 → 库存与采购」把门槛改回 2000 元。
  await sql`
    INSERT INTO settings (key, value) VALUES ('inventory_approval_rules', ${sql.json(DEFAULT_APPROVAL_RULES as never)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await sql`
    INSERT INTO settings (key, value) VALUES ('inventory_approval_threshold_cents', '0')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

  const ensure = async (username: string, displayName: string, role: Actor['role'], duties: Actor['duties']): Promise<Actor> => {
    const [row] = await sql<{ id: number; role: Actor['role']; duties: Actor['duties'] }[]>`SELECT id, role, duties FROM staff WHERE username = ${username}`;
    const staffId = row?.id ?? (await createStaff(sql, { username, displayName, role, duties, password: DEMO_PASSWORD, mustChangePassword: false }));
    return { id: staffId, username, displayName, role: row?.role ?? role, duties: row?.duties ?? duties, mustChangePassword: false };
  };
  const owner = await ensure('linlan', '林岚', 'owner', []);
  const keeper = await ensure('lixiao', '李晓（物资）', 'backoffice', ['stock']);
  // 分岗不兼任（#17，v0.7.12）：采购与对账付款是两个人
  const buyer = await ensure('zhouyi', '周一（采购）', 'backoffice', ['purchase']);
  const payer = await ensure('qianfen', '钱芬（对账付款）', 'backoffice', ['payable']);

  // ── 档案 ──
  const suppliers = new Map<string, number>();
  for (const s of demo.suppliers) {
    suppliers.set(s.code, await saveSupplier(sql, null, { code: s.code, name: s.name, note: s.scope === 'pilot' ? '首轮试点（模拟）' : '后续候选，未进入首轮（模拟）' }, { isSynthetic: true }));
  }
  const materials = new Map<string, number>();
  for (const m of demo.materials) {
    const decimals = m.inventoryUnit === 'kg' ? 3 : 0;
    materials.set(
      m.code,
      await saveMaterial(
        sql,
        null,
        {
          code: m.code,
          name: m.name,
          category: m.category,
          specification: m.specification,
          inventoryUnit: m.inventoryUnit,
          decimals,
          purchaseUnit: m.purchaseUnit,
          purchaseFactorMilli: q(m.baseUnitsPerPurchaseUnit),
          refPriceCents: m.simulatedPurchaseUnitPriceCents,
          defaultSupplierId: suppliers.get(m.supplierCode) ?? null,
          lowStockMilli: m.inventoryTracked && Number(m.simulatedLowStockThreshold) > 0 ? q(m.simulatedLowStockThreshold) : null,
          tracked: m.inventoryTracked,
          note: m.scope === 'pilot' ? '' : '后续候选，暂不纳入库存（模拟）',
        },
        { isSynthetic: true },
      ),
    );
  }
  const departments = new Map((await sql<{ id: number; name: string }[]>`SELECT id, name FROM departments`).map((d) => [d.name, d.id]));

  const mark = (table: 'inv_docs' | 'purchase_orders' | 'payments' | 'opening_payables', id: number) =>
    sql`UPDATE ${sql(table)} SET is_synthetic = true WHERE id = ${id}`;

  // ── 按日期依次发生的业务 ──
  const docIds = new Map<string, number>();
  const poIds = new Map<string, number>();
  const doc = async (key: string, actor: Actor, body: Record<string, unknown>) => {
    const r = await createDoc(deps, { clientKey: randomUUID(), ...body } as never, actor);
    await mark('inv_docs', r.doc.id);
    docIds.set(key, r.doc.id);
    return r.doc;
  };
  const lineOf = async (docId: number, materialCode: string) => {
    const [l] = await sql<{ id: number }[]>`SELECT id FROM inv_doc_lines WHERE doc_id = ${docId} AND material_id = ${materials.get(materialCode)!}`;
    return l!.id;
  };

  // 期初库存（店主确认）
  const opening = demo.openingInventory;
  await doc(opening.id, owner, {
    docType: 'opening',
    docDate: opening.date,
    note: '首轮试点期初盘点（模拟）',
    approveNow: true,
    lines: opening.lines.map((l) => ({ materialId: materials.get(l.materialCode)!, qtyMilli: q(l.quantity) })),
  });

  // 期初未付：对账开账，先提交再由店主确认
  for (const o of demo.openingPayables) {
    const r = await createOpening(deps, { clientKey: randomUUID(), supplierId: suppliers.get(o.supplierCode)!, amountCents: o.amountCents, asOfDate: o.date, note: o.note }, payer);
    await mark('opening_payables', r.opening.id);
    await actOnOpening(deps, r.opening.id, 'approve', {}, owner);
    docIds.set(o.id, r.opening.id);
  }

  const events: { date: string; order: number; run: () => Promise<unknown> }[] = [];
  const at = (date: string, order: number, run: () => Promise<unknown>) => events.push({ date, order, run });

  for (const po of demo.purchaseOrders) {
    at(po.date, 1, async () => {
      const r = await createPo(
        deps,
        {
          clientKey: randomUUID(),
          supplierId: suppliers.get(po.supplierCode)!,
          orderDate: po.date,
          note: (po.approval as { note?: string }).note ?? '',
          action: 'save',
          lines: po.lines.map((l) => ({ materialId: materials.get(l.materialCode)!, purchaseQtyMilli: q(l.purchaseQuantity), priceCents: l.purchaseUnitPriceCents })),
        },
        buyer,
      );
      await mark('purchase_orders', r.po.id);
      poIds.set(po.id, r.po.id);
      await submitPo(deps, r.po.id, buyer, false);
      if (po.status === 'approved') await approvePo(deps, r.po.id, owner);
    });
  }

  for (const rc of demo.receipts) {
    at(rc.date, 2, async () => {
      const poId = poIds.get(rc.orderId)!;
      const poLines = await sql<{ id: number; materialId: number }[]>`SELECT id, material_id FROM purchase_order_lines WHERE po_id = ${poId}`;
      await doc(rc.id, keeper, {
        docType: 'receipt',
        docDate: rc.date,
        supplierId: suppliers.get(rc.supplierCode)!,
        purchaseOrderId: poId,
        handler: rc.receiver,
        // #17：采购和仓库一起验收（v0.7.11）
        coAcceptorId: buyer.id,
        note: (rc as { note?: string }).note ?? '',
        lines: rc.lines.map((l) => {
          const materialId = materials.get(l.materialCode)!;
          return {
            materialId,
            poLineId: poLines.find((p) => p.materialId === materialId)!.id,
            deliveredMilli: q(l.deliveredQuantity),
            acceptedMilli: q(l.acceptedQuantity),
            rejectReason: Number(l.rejectedQuantity) > 0 ? '包装破损，拒收未入库（模拟）' : '',
          };
        }),
      });
    });
  }

  for (const is of demo.issues) {
    at(is.date, 3, () =>
      doc(is.id, keeper, {
        docType: 'issue',
        docDate: is.date,
        departmentId: departments.get(is.department)!,
        handler: is.actor,
        lines: is.lines.map((l) => ({ materialId: materials.get(l.materialCode)!, qtyMilli: q(l.quantity) })),
      }),
    );
  }

  for (const r of demo.issueReturns) {
    at(r.date, 4, async () => {
      const src = docIds.get(r.sourceIssueId)!;
      await doc(r.id, keeper, { docType: 'issue_return', docDate: r.date, sourceDocId: src, note: r.reason, lines: [{ sourceLineId: await lineOf(src, r.materialCode), qtyMilli: q(r.quantity) }] });
    });
  }

  for (const u of demo.directUses) {
    at(u.date, 5, () => doc(u.id, keeper, { docType: 'direct_use', docDate: u.date, note: u.reason, lines: [{ materialId: materials.get(u.materialCode)!, qtyMilli: q(u.quantity) }] }));
  }

  for (const d of demo.damages) {
    at(d.date, 6, async () => {
      const created = await doc(d.id, keeper, { docType: 'damage', docDate: d.date, note: d.reason, lines: [{ materialId: materials.get(d.materialCode)!, qtyMilli: q(d.quantity) }] });
      if (d.status === 'approved') await approveDoc(deps, created.id, {}, owner);
    });
  }

  for (const c of demo.counts) {
    at(c.date, 7, async () => {
      const created = await doc(c.id, keeper, {
        docType: 'count',
        docDate: c.date,
        note: c.reason,
        lines: [{ materialId: materials.get(c.materialCode)!, countedMilli: q(c.countedQuantity), expectedBookMilli: q(c.bookQuantity) }],
      });
      if (c.status === 'approved') await approveDoc(deps, created.id, { countReasons: { [created.lines[0]!.id]: 'unknown' } }, owner);
    });
  }

  for (const r of demo.supplierReturns) {
    at(r.date, 8, async () => {
      const src = docIds.get(r.sourceReceiptId)!;
      const created = await doc(r.id, keeper, { docType: 'supplier_return', docDate: r.date, sourceDocId: src, note: r.reason, lines: [{ sourceLineId: await lineOf(src, r.materialCode), qtyMilli: q(r.quantity) }] });
      if (r.status === 'confirmed') {
        // 负责人确认后等供应商同意（#20，v0.7.12）：采购登记供应商已同意，才出库、扣款
        await approveDoc(deps, created.id, {}, owner);
        await answerReturn(deps, created.id, { agreed: true, date: r.date, note: '供应商已确认扣款（模拟）' }, buyer);
      }
    });
  }

  for (const p of demo.payments) {
    at(p.date, 9, async () => {
      const r = await createPayment(
        deps,
        {
          clientKey: randomUUID(),
          supplierId: suppliers.get(p.supplierCode)!,
          payDate: p.date,
          amountCents: p.amountCents,
          method: 'bank_transfer',
          evidence: p.evidence,
          note: p.method,
          allocations: p.allocations.map((a) =>
            a.sourceId.startsWith('OPEN-AP')
              ? { kind: 'opening', targetId: docIds.get(a.sourceId)!, amountCents: a.amountCents }
              : { kind: 'receipt', targetId: docIds.get(a.sourceId)!, amountCents: a.amountCents },
          ),
        },
        payer,
      );
      await mark('payments', r.payment.id);
      if (p.status === 'confirmed') await actOnPayment(deps, r.payment.id, 'approve', {}, owner);
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  for (const e of events) await e.run();

  // 自动补货（8.0.20）默认开着、到点会按补货建议自己建采购单草稿。演示数据写进来的这一天记成「今天已经跑过」：
  // 准备完的库不随钟点多出几张草稿（固定预期与浏览器用例才对得上）；第二天起照常自动跑，当天要看效果在「补货建议」里点「现在跑一次」
  await sql`INSERT INTO replenish_runs (run_date, status, finished_at) VALUES (${dateIn(new Date(), config.timezone)}, 'done', now()) ON CONFLICT (run_date) DO NOTHING`;

  return { skipped: false as const, materials: materials.size, suppliers: suppliers.size, docs: docIds.size, purchaseOrders: poIds.size };
}
