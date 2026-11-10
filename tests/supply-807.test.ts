// 8.0.7 供应链收尾（docs/ERP_V807.md 第 2 节）与合同扫描件 PDF（A4）：
//   · 2.1 供应商准入与证照：页面新建的是待准入；准入要有没过期的营业执照；暂停写原因；证照不能删、撤下写原因；
//     打开「只能给已准入的供应商」后，待准入、暂停的采购单提交被拒（SUPPLIER_NOT_ADMITTED），关着不拦；到期提醒；
//   · 2.2 季度评分：准时率、合格率、价格指数、分数、观察名单；导出；
//   · 2.3 部门耗用的用途与经办人：用途只能从设置的列表选；耗用记录按用途筛、能导出；之前的单据为空；
//   · 2.4 呆滞与周转：超过天数没出库的标呆滞；
//   · 2.5 验收标准模板、逐条验收；最近一次不合格时付款挂起（ACCEPTANCE_HOLD），开关关掉以后照常；
//   · 2.6 供应商在线对账确认：生成链接（只给一次）、不用登录打开、确认或有异议（只能回一次）、作废、过期、撤销登记后打不开；
//   · A4 合同扫描件可以传 PDF。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { LEGAL_ITEM_KEYS, type ContractDetail } from '../src/shared/contracts';
import { shiftDate } from '../src/shared/labels';
import { quarterOf, quarterRange, recentQuarters, scoreOf } from '../src/shared/supply';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let buyer: string; // 采购（维护合同、采购单）
let buyerId: number;
let payer: string; // 对账付款
let keeper: string; // 仓库
let lawyer: string;
let mgr: string; // 负责人（inventory.approve）
let matId: number;

const q = (n: number) => Math.round(n * 1000);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const settings = (body: Record<string, unknown>) => ok(api(ctx.app, ctx.owner, 'PUT', '/api/settings', body), 200);

async function newSupplier(code: string, name: string): Promise<number> {
  const list = await ok<{ id: number; code: string }[]>(api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code, name }));
  return list.find((x) => x.code === code)!.id;
}

/** 下一张采购单（确认）并按单全部收货；收货日 = docDate */
async function receive(supplierId: number, boxes: number, priceCents: number, opts: { expectedDate?: string; docDate?: string; rejectBoxes?: number } = {}) {
  const po = await ok(
    api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: shiftDate(today, -10),
      ...(opts.expectedDate ? { expectedDate: opts.expectedDate } : {}),
      approveNow: true,
      lines: [{ materialId: matId, purchaseQtyMilli: q(boxes), priceCents }],
    }),
  );
  expect(po.po.status, JSON.stringify(po.po)).toBe('approved');
  const reject = opts.rejectBoxes ?? 0;
  const rc = await ok(
    api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docDate: opts.docDate ?? today,
      docType: 'receipt',
      supplierId,
      purchaseOrderId: po.po.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: matId, poLineId: po.po.lines[0].id, deliveredMilli: q(boxes * 10), acceptedMilli: q((boxes - reject) * 10), ...(reject ? { rejectReason: '破损' } : {}) }],
    }),
  );
  expect(rc.doc.status).toBe('confirmed');
  return { poId: po.po.id as number, receiptId: rc.doc.id as number };
}

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyerId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id);
  const staff = async (username: string, displayName: string, duties: ('approve' | 'legal')[]) => {
    await createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties, password: PASSWORD, mustChangePassword: false });
    return login(ctx.app, username);
  };
  lawyer = await staff('s807_legal', '法务甲', ['legal']);
  mgr = await staff('s807_mgr', '负责人乙', ['approve']);
  const m = await ok(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'S807-M1', name: '8.0.7 测试物料', inventoryUnit: '个', purchaseUnit: '箱', purchaseFactorMilli: q(10) }));
  matId = m.id;
}, 60_000);
afterAll(async () => ctx.close());

describe('计算', () => {
  it('季度与分数', () => {
    expect(quarterOf('2026-11-10')).toBe('2026Q4');
    expect(quarterRange('2026Q1')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(quarterRange('2024Q1')!.to).toBe('2024-03-31');
    expect(quarterRange('2026Q5')).toBeNull();
    expect(recentQuarters('2026-02-01', 3)).toEqual(['2026Q1', '2025Q4', '2025Q3']);
    expect(scoreOf(10_000, 10_000, 10_000)).toBe(1000); // 满分
    expect(scoreOf(10_000, 10_000, null)).toBe(1000); // 没有可比价格不扣分
    expect(scoreOf(5_000, 10_000, 10_000)).toBe(800); // 准时一半：扣 20 分
    expect(scoreOf(10_000, 10_000, 11_000)).toBe(960); // 贵 10%：价格分 80 → 扣 4 分
    expect(scoreOf(10_000, 10_000, 20_000)).toBe(800); // 贵一倍：价格分 0
  });
});

describe('2.1 供应商准入与证照', () => {
  let sid: number;
  it('新建是待准入；没有没过期的营业执照不能准入；证照不能删，撤下写原因；暂停写原因；到期提醒', async () => {
    sid = await newSupplier('S807A', '准入测试供应商');
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; admission: string; licenseDue: string | null }[];
    expect(list.find((s) => s.id === sid)).toMatchObject({ admission: 'pending', licenseDue: null });
    // 种子里的供应商（升级前已有的）照旧是已准入
    expect(list.filter((s) => s.id !== sid).every((s) => s.admission === 'approved')).toBe(true);

    const noLicense = await api(ctx.app, mgr, 'POST', `/api/inventory/suppliers/${sid}/admission`, { action: 'approve' });
    expect(noLicense.status).toBe(422);
    expect(noLicense.body.error.code).toBe('LICENSE_REQUIRED');
    // 过期的营业执照不算
    await ok(api(ctx.app, ctx.owner, 'POST', `/api/inventory/suppliers/${sid}/licenses`, { kind: 'business', licenseNo: 'OLD-001', validUntil: shiftDate(today, -1) }));
    expect((await api(ctx.app, mgr, 'POST', `/api/inventory/suppliers/${sid}/admission`, { action: 'approve' })).body.error.code).toBe('LICENSE_REQUIRED');
    // 「其他」证照要写名称
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/inventory/suppliers/${sid}/licenses`, { kind: 'other', licenseNo: 'X1' })).status).toBe(400);
    // 新的营业执照（PDF），20 天后到期；食品经营许可证长期
    const view = await ok(api(ctx.app, ctx.owner, 'POST', `/api/inventory/suppliers/${sid}/licenses`, { kind: 'business', licenseNo: 'NEW-002', validUntil: shiftDate(today, 20), mime: 'application/pdf', data: PDF }));
    await ok(api(ctx.app, ctx.owner, 'POST', `/api/inventory/suppliers/${sid}/licenses`, { kind: 'food', licenseNo: 'JY-003', validUntil: null }));
    expect(view.canApprove).toBe(true);
    const pdf = view.licenses.find((l: { licenseNo: string }) => l.licenseNo === 'NEW-002');
    expect(pdf.media.kind).toBe('pdf');
    const dl = await ctx.app.inject({ method: 'GET', url: pdf.media.url, headers: { cookie: ctx.owner } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    // 仓库没有「审核」权限：不能准入
    expect((await api(ctx.app, keeper, 'POST', `/api/inventory/suppliers/${sid}/admission`, { action: 'approve' })).status).toBe(403);
    const approved = await ok(api(ctx.app, mgr, 'POST', `/api/inventory/suppliers/${sid}/admission`, { action: 'approve', note: '证照齐全' }), 200);
    expect(approved).toMatchObject({ admission: 'approved', admissionNote: '证照齐全', admissionByName: '负责人乙' });

    // 证照不能删；撤下要写原因，撤下以后不再算
    const old = approved.licenses.find((l: { licenseNo: string }) => l.licenseNo === 'OLD-001');
    await expect(ctx.sql`DELETE FROM supplier_licenses WHERE id = ${old.id}`).rejects.toThrow(/禁止删除/);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/inventory/supplier-licenses/${old.id}/remove`, { reason: '' })).status).toBe(400);
    const after = await ok(api(ctx.app, ctx.owner, 'POST', `/api/inventory/supplier-licenses/${old.id}/remove`, { reason: '换了新证' }), 200);
    expect(after.licenses.map((l: { licenseNo: string }) => l.licenseNo).sort()).toEqual(['JY-003', 'NEW-002']);
    await expect(ctx.sql`UPDATE supplier_licenses SET license_no = 'HACK' WHERE id = ${old.id}`).rejects.toThrow(/只能撤下一次/);

    // 到期提醒：20 天后到期的营业执照在 30 天以内
    const due = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/supplier-licenses/due')).body as { licenseNo: string; daysLeft: number }[];
    expect(due.find((d) => d.licenseNo === 'NEW-002')?.daysLeft).toBe(20);
    expect(due.some((d) => d.licenseNo === 'OLD-001' || d.licenseNo === 'JY-003')).toBe(false);
    const suppliers = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; licenseDue: string | null }[];
    expect(suppliers.find((s) => s.id === sid)!.licenseDue).toBe(shiftDate(today, 20));

    // 暂停要写原因
    expect((await api(ctx.app, mgr, 'POST', `/api/inventory/suppliers/${sid}/admission`, { action: 'suspend' })).body.error.code).toBe('REASON_REQUIRED');
    const suspended = await ok(api(ctx.app, mgr, 'POST', `/api/inventory/suppliers/${sid}/admission`, { action: 'suspend', note: '质量问题待整改' }), 200);
    expect(suspended.admission).toBe('suspended');
  });

  it('打开「只能给已准入的供应商」后，暂停的供应商采购单提交被拒；关着照常', async () => {
    const draft = async () =>
      (
        await ok(
          api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
            clientKey: randomUUID(),
            supplierId: sid,
            orderDate: today,
            action: 'save',
            lines: [{ materialId: matId, purchaseQtyMilli: q(1), priceCents: 10_00 }],
          }),
        )
      ).po.id as number;
    await settings({ supplierApprovedOnly: true });
    const blocked = await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${await draft()}/submit`, {});
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
    expect(blocked.body.error.code).toBe('SUPPLIER_NOT_ADMITTED');
    expect(blocked.body.error.message).toContain('已暂停');
    await settings({ supplierApprovedOnly: false });
    const passed = await api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${await draft()}/submit`, {});
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
  });
});

describe('2.2 季度评分与观察名单', () => {
  it('准时率、合格率、价格指数、分数；低于观察线进观察名单；导出', async () => {
    const good = await newSupplier('S807G', '准时又便宜');
    const bad = await newSupplier('S807B', '晚到又贵');
    for (const s of [good, bad]) await ctx.sql`UPDATE suppliers SET admission = 'approved' WHERE id = ${s}`;
    await receive(good, 10, 50_00, { expectedDate: today });
    // 晚到（预计昨天到）、贵一倍、拒收 2 箱
    await receive(bad, 10, 100_00, { expectedDate: shiftDate(today, -1), rejectBoxes: 2 });
    await settings({ supplierWatchScore: 80 });
    const report = (await api(ctx.app, buyer, 'GET', '/api/purchase-compare/scores')).body;
    expect(report.quarter).toBe(quarterOf(today));
    const g = report.rows.find((r: { supplierId: number }) => r.supplierId === good);
    const b = report.rows.find((r: { supplierId: number }) => r.supplierId === bad);
    expect(g).toMatchObject({ receipts: 1, onTime: 1, onTimeBp: 10_000, qualityBp: 10_000, rejectedCents: 0, watch: false });
    expect(b).toMatchObject({ receipts: 1, onTime: 0, onTimeBp: 0, watch: true });
    // 拒收 2 箱 × ¥100 = ¥200；送货 = 合格 8 箱 ¥800 + 拒收 ¥200
    expect(b.rejectedCents).toBe(200_00);
    expect(b.deliveredCents).toBe(1000_00);
    expect(b.qualityBp).toBe(8_000);
    // 同一物料的加权均价：(8×100 + 10×50) / 18 箱 ≈ 72.22；晚到又贵的进价指数 > 1，便宜的 < 1
    expect(b.priceIndexBp).toBeGreaterThan(10_000);
    expect(g.priceIndexBp).toBeLessThan(10_000);
    expect(b.scoreX10).toBeLessThan(800);
    // 观察名单在前
    expect(report.rows[0].watch).toBe(true);
    const watch = (await api(ctx.app, buyer, 'GET', '/api/purchase-compare/watch')).body as { supplierId: number }[];
    expect(watch.some((w) => w.supplierId === bad)).toBe(true);
    expect(watch.some((w) => w.supplierId === good)).toBe(false);
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/purchase-compare/scores/export', headers: { cookie: buyer } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('晚到又贵');
    expect(csv.body).toContain('观察名单');
    await settings({ supplierWatchScore: 70 });
    expect((await api(ctx.app, buyer, 'GET', '/api/purchase-compare/scores?quarter=2026Q9')).status).toBe(400);
  });
});

describe('2.3 部门耗用的用途与经办人', () => {
  it('用途只能从列表选；记经办人（默认是自己）；耗用记录按用途筛、导出；生效后不能改', async () => {
    const [dep] = await ctx.sql<{ id: number; warehouseId: number }[]>`
      SELECT d.id, w.id AS warehouse_id FROM departments d JOIN warehouses w ON w.department_id = d.id WHERE d.active ORDER BY d.id LIMIT 1`;
    const depId = Number(dep!.id);
    const whId = Number(dep!.warehouseId);
    // 先领料到这个部门的小仓
    await ok(api(ctx.app, keeper, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'issue', docDate: today, departmentId: depId, handler: '领料人', lines: [{ materialId: matId, qtyMilli: q(30) }] }));
    const use = (body: Record<string, unknown>) =>
      api(ctx.app, ctx.owner, 'POST', '/api/erp/dept-stock/docs', { clientKey: randomUUID(), docType: 'direct_use', docDate: today, warehouseId: whId, note: '客房补充', lines: [{ materialId: matId, qtyMilli: q(2) }], ...body });
    const bad = await use({ purpose: '随便用' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('PURPOSE_INVALID');
    const doc = await ok(use({ purpose: '客用消耗' }));
    expect(doc.doc).toMatchObject({ status: 'confirmed', usePurpose: '客用消耗' });
    expect(doc.doc.useHandler.name).toBeTruthy();
    const [s] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'lixiao'`;
    await ok(use({ purpose: '员工使用', handlerId: Number(s!.id) }));
    // 没带用途的（旧的调用）照旧能登记，两样都为空
    const legacy = await ok(use({}));
    expect(legacy.doc.usePurpose).toBeNull();
    // 生效以后不能改
    await expect(ctx.sql`UPDATE inv_docs SET use_purpose = '其他' WHERE id = ${doc.doc.id}`).rejects.toThrow(/不可修改/);

    const all = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/dept-stock/${depId}/consumption`)).body as { purpose: string | null; handlerName: string | null }[];
    expect(all.length).toBeGreaterThanOrEqual(3);
    const staffUse = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/dept-stock/${depId}/consumption?purpose=${encodeURIComponent('员工使用')}`)).body as { purpose: string; handlerName: string }[];
    expect(staffUse.length).toBe(1);
    expect(staffUse[0]!.handlerName).toBeTruthy();
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/erp/dept-stock/${depId}/consumption/export`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('（v8.0.7 以前没记）');
    // 用途列表在设置里改；部门页的下拉跟着变
    await settings({ consumptionPurposes: ['客用消耗', '员工使用', '新用途'] });
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/erp/dept-stock/meta')).body.purposes).toContain('新用途');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { consumptionPurposes: ['重复', '重复'] })).status).toBe(400);
    await settings({ consumptionPurposes: ['客用消耗', '员工使用', '清洁卫生', '维修保养', '活动与赠送', '其他'] });
  });
});

describe('2.4 呆滞与周转', () => {
  it('有结存、超过设置的天数没出库的标呆滞；导出', async () => {
    const m = await ok(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'S807-SLOW', name: '放着不用的物料', inventoryUnit: '个', purchaseUnit: '个', purchaseFactorMilli: q(1), refPriceCents: 3_00 }));
    await ok(api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'opening', docDate: shiftDate(today, -40), lines: [{ materialId: m.id, qtyMilli: q(5) }], approveNow: true }));
    await settings({ slowMovingDays: 30 });
    const r = (await api(ctx.app, keeper, 'GET', '/api/inventory/slow-moving?warehouseId=1')).body;
    expect(r.slowDays).toBe(30);
    const row = r.rows.find((x: { materialId: number }) => x.materialId === m.id);
    expect(row).toMatchObject({ warehouseName: '总仓', stockMilli: q(5), lastOutDate: null, idleDays: 40, slow: true, turnoverDays: null, amountCents: 15_00 });
    const slowOnly = (await api(ctx.app, keeper, 'GET', '/api/inventory/slow-moving?slow=1')).body.rows as { slow: boolean }[];
    expect(slowOnly.every((x) => x.slow)).toBe(true);
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/inventory/slow-moving/export', headers: { cookie: keeper } });
    expect(csv.body).toContain('放着不用的物料');
    await settings({ slowMovingDays: 90 });
    const later = (await api(ctx.app, keeper, 'GET', '/api/inventory/slow-moving?warehouseId=1')).body.rows.find((x: { materialId: number }) => x.materialId === m.id);
    expect(later.slow).toBe(false);
  });
});

describe('2.5 验收标准模板与不合格挂起付款；A4 合同扫描件 PDF', () => {
  let contract: ContractDetail;
  const allPass = () => LEGAL_ITEM_KEYS.map((key) => ({ key, verdict: 'pass', note: '' }));
  it('模板：新建、名称不重复、修改带版本号；起草合同选模板，逐条标准写进合同', async () => {
    const list = await ok(api(ctx.app, buyer, 'POST', '/api/erp/contracts/acceptance-templates', { name: '布草到货验收', items: ['规格与样品一致', '洗涤 3 次不褪色'] }));
    const t = list.find((x: { name: string }) => x.name === '布草到货验收');
    expect(t.items).toHaveLength(2);
    expect((await api(ctx.app, buyer, 'POST', '/api/erp/contracts/acceptance-templates', { name: '布草到货验收', items: ['x'] })).status).toBe(409);
    expect((await api(ctx.app, buyer, 'POST', '/api/erp/contracts/acceptance-templates', { name: '空的', items: [] })).status).toBe(400);
    expect((await api(ctx.app, buyer, 'PUT', `/api/erp/contracts/acceptance-templates/${t.id}`, { name: '布草到货验收', items: ['a'], expectedVersion: 99 })).body.error.code).toBe('VERSION_CONFLICT');
    await ok(api(ctx.app, buyer, 'PUT', `/api/erp/contracts/acceptance-templates/${t.id}`, { name: '布草到货验收', items: ['规格与样品一致', '洗涤 3 次不褪色', '包装完好'], expectedVersion: t.version }), 200);
    expect((await api(ctx.app, keeper, 'POST', '/api/erp/contracts/acceptance-templates', { name: '仓库建的', items: ['x'] })).status).toBe(403);

    const supplierId = await newSupplier('S807C', '合同验收供应商');
    const created = await ok(
      api(ctx.app, buyer, 'POST', '/api/erp/contracts', {
        clientKey: randomUUID(),
        category: 'purchase',
        supplierId,
        counterparty: '',
        content: {
          title: '验收模板测试合同',
          startDate: today,
          endDate: shiftDate(today, 365),
          totalCents: 1_000_000,
          taxRateBp: 1300,
          freightBearer: 'supplier',
          unloadingBearer: 'supplier',
          paymentTerms: [
            { stage: 'prepay', percentBp: 3000, condition: '' },
            { stage: 'delivery', percentBp: 3000, condition: '' },
            { stage: 'acceptance', percentBp: 4000, condition: '' },
            { stage: 'warranty', percentBp: 0, condition: '' },
          ],
          warranty: { basis: 'acceptance', months: 0 },
          acceptance: { method: '逐条验收', signer: '仓库经办', penalty: '退换', templateName: '布草到货验收', items: ['规格与样品一致', '洗涤 3 次不褪色', '包装完好'] },
          note: '',
          lines: [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: q(200) }],
        },
      }),
    );
    let c = created.contract as ContractDetail;
    expect(c.content.acceptance.items).toEqual(['规格与样品一致', '洗涤 3 次不褪色', '包装完好']);
    c = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/submit`, { version: c.version }), 200);
    const rid = c.approval!.requestId;
    await ok(api(ctx.app, payer, 'POST', `/api/approvals/${rid}/approve`, { level: 1, comment: '' }), 200);
    await ok(api(ctx.app, lawyer, 'POST', `/api/approvals/${rid}/approve`, { level: 2, comment: '', checklist: allPass() }), 200);
    await ok(api(ctx.app, mgr, 'POST', `/api/approvals/${rid}/approve`, { level: 3, comment: '' }), 200);
    c = (await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${c.id}`)).body;
    contract = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/sign`, { version: c.version, signedOn: today, ourSignatory: '林岚', theirSignatory: '王经理' }), 200);
  });

  it('逐条验收：有一条不合格整次不合格；不合格时付款申请被拒（ACCEPTANCE_HOLD），开关关掉照常；重新验收合格解除', async () => {
    const accept = (body: Record<string, unknown>) =>
      api(ctx.app, buyer, 'POST', `/api/erp/contracts/${contract.id}/acceptances`, { clientKey: randomUUID(), acceptedOn: today, signer: '仓库经办', ...body });
    const items = (fails: number[]) => contract.content.acceptance.items.map((item, i) => ({ item, pass: !fails.includes(i) }));
    // 结果与逐条对不上：拒绝
    expect((await accept({ result: 'pass', items: items([1]) })).status).toBe(400);
    await ok(accept({ result: 'fail', note: '第二条褪色，退换', items: items([1]) }));
    const plan = (await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${contract.id}/payment-plan`)).body;
    expect(plan.acceptanceHold).toBe(true);
    expect(plan.canRequest).toBe(false);
    expect(plan.latestAcceptance.items.filter((x: { pass: boolean }) => !x.pass)).toHaveLength(1);
    const request = () =>
      api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', { clientKey: randomUUID(), expectedDate: today, purpose: '预付', source: { kind: 'contract', contractId: contract.id, stage: 'prepay', amountCents: 100_000 } });
    const held = await request();
    expect(held.status, JSON.stringify(held.body)).toBe(422);
    expect(held.body.error.code).toBe('ACCEPTANCE_HOLD');
    // 开关关掉：照常申请
    await settings({ acceptanceHoldsPayment: false });
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${contract.id}/payment-plan`)).body.acceptanceHold).toBe(false);
    const passed = await request();
    expect(passed.status, JSON.stringify(passed.body)).toBe(201);
    await settings({ acceptanceHoldsPayment: true });
    // 重新验收合格：解除
    await ok(accept({ result: 'pass', items: items([]) }));
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${contract.id}/payment-plan`)).body.acceptanceHold).toBe(false);
    // 逐条结果不能改
    await expect(ctx.sql`UPDATE contract_acceptances SET items = '[]'::jsonb WHERE contract_id = ${contract.id}`).rejects.toThrow(/不能改/);
  });

  it('合同扫描件可以传 PDF；打开是 PDF', async () => {
    const d = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${contract.id}/files`, { name: '合同全文', mime: 'application/pdf', data: PDF }));
    const f = (d as ContractDetail).files.find((x) => x.kind === 'pdf')!;
    expect(f).toMatchObject({ kind: 'pdf', name: '合同全文', imageId: null });
    const res = await ctx.app.inject({ method: 'GET', url: f.url, headers: { cookie: buyer } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // 同一份再传一次：不另记
    const again = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${contract.id}/files`, { name: '合同全文', mime: 'application/pdf', data: PDF }));
    expect((again as ContractDetail).files.filter((x) => x.kind === 'pdf')).toHaveLength(1);
    // 不是 PDF 的内容
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${contract.id}/files`, { mime: 'application/pdf', data: Buffer.from('not a pdf at all').toString('base64') })).body.error.code).toBe('FILE_NOT_PDF');
  });
});

describe('2.6 供应商在线对账确认', () => {
  it('生成链接、不用登录打开、确认或有异议只能回一次、作废、撤销登记后打不开、试错限次', async () => {
    const sid = await newSupplier('S807R', '对账确认供应商');
    const month = shiftDate(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const reg = await ok(api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId: sid, kind: 'month', month }));
    const reconId = reg.reconciliation.id as number;
    expect(reg.reconciliation.link).toBeNull();
    // 仓库不能发链接
    expect((await api(ctx.app, keeper, 'POST', `/api/payables/reconciliations/${reconId}/links`, {})).status).toBe(403);
    const first = await ok(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reconId}/links`, {}));
    const second = await ok(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reconId}/links`, {}));
    // 重发以后上一条作废
    const pub = (token: string) => ctx.app.inject({ method: 'GET', url: `/api/public/recon/${token}` });
    expect((await pub(first.token)).statusCode).toBe(404);
    const view = await pub(second.token);
    expect(view.statusCode).toBe(200);
    const v = view.json();
    expect(v.snapshot).toMatchObject({ supplierName: '对账确认供应商', kind: 'month', month });
    expect(v.reply).toBeNull();
    // 库里只有摘要，没有原文
    const [row] = await ctx.sql<{ tokenHash: string }[]>`SELECT token_hash FROM recon_links WHERE id = ${second.link.id}`;
    expect(row!.tokenHash).not.toContain(second.token);

    const replyTo = (token: string, body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: `/api/public/recon/${token}/reply`, payload: body });
    expect((await replyTo(second.token, { answer: 'disputed', name: '王会计' })).statusCode).toBe(400); // 有异议要写原因
    const r1 = await replyTo(second.token, { answer: 'disputed', name: '王会计', note: '10 月 12 日那张少算了运费' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ reply: 'disputed', replyName: '王会计' });
    // 同一个回复再提交一次：照样返回；不同的拒绝
    expect((await replyTo(second.token, { answer: 'disputed', name: '王会计', note: '10 月 12 日那张少算了运费' })).statusCode).toBe(200);
    expect((await replyTo(second.token, { answer: 'confirmed', name: '王会计' })).json().error.code).toBe('ALREADY_REPLIED');
    // 门店这边看得到回复；回过的不能作废
    const detail = (await api(ctx.app, payer, 'GET', `/api/payables/reconciliations/${reconId}`)).body;
    expect(detail.link).toMatchObject({ reply: 'disputed', replyName: '王会计', replyNote: '10 月 12 日那张少算了运费' });
    expect((await api(ctx.app, payer, 'POST', `/api/payables/recon-links/${detail.link.id}/void`, {})).body.error.code).toBe('INVALID_STATE');
    await expect(ctx.sql`UPDATE recon_links SET reply = 'confirmed' WHERE id = ${detail.link.id}`).rejects.toThrow(/只能作废一次、回复一次/);

    // 过期的打不开
    const third = await ok(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reconId}/links`, {}));
    await ctx.sql`ALTER TABLE recon_links DISABLE TRIGGER recon_links_guard`;
    await ctx.sql`UPDATE recon_links SET expires_at = now() - interval '1 minute' WHERE id = ${third.link.id}`;
    await ctx.sql`ALTER TABLE recon_links ENABLE TRIGGER recon_links_guard`;
    const expired = await pub(third.token);
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.message).toContain('过期');
    // 撤销对账登记以后打不开
    const fourth = await ok(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reconId}/links`, {}));
    expect((await pub(fourth.token)).statusCode).toBe(200);
    await ok(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reconId}/void`, { clientKey: randomUUID(), reason: '数字登错了' }), 200);
    expect((await pub(fourth.token)).statusCode).toBe(404);
    expect((await api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reconId}/links`, {})).body.error.code).toBe('INVALID_STATE');
    // 链接格式不对
    expect((await pub('bad')).statusCode).toBe(400);
  });
});
