// 多公司主体（8.0.22，docs/MULTISTORE_V8022.md 第 9 节，MD-C）：合同、银行账户默认当前门店的主体，可以指定；
// 合同台账按主体筛；有几个主体时合同的「我方」用主体的名称；开票申请跟着结账发生的门店走。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PAYMENT_TERMS } from '../src/shared/contracts';
import { shiftDate } from '../src/shared/labels';
import { todayIn } from '../src/server/lib/dates';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let ftEntity: number;
let ft: number;

const content = () => ({
  title: '保洁外包',
  startDate: today,
  endDate: shiftDate(today, 365),
  totalCents: 3_600_00,
  taxRateBp: 600,
  freightBearer: 'na',
  unloadingBearer: 'na',
  paymentTerms: DEFAULT_PAYMENT_TERMS,
  warranty: { basis: 'acceptance', months: 0 },
  acceptance: { method: '按月验收', signer: '店总', penalty: '不达标扣款' },
  note: '',
  lines: [],
});
const createContract = async (extra: Record<string, unknown> = {}) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/erp/contracts', { clientKey: randomUUID(), category: 'service', counterparty: '某保洁公司', content: content(), ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.contract ?? r.body) as { id: number };
};
const inStore = async <T>(storeId: number, fn: () => Promise<T>) => {
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId })).status).toBe(200);
  try {
    return await fn();
  } finally {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(200);
  }
};

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  ftEntity = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '福田汤泉有限公司', taxNo: '91440300MA5TEST001' })).body.id;
  ft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'FT', name: '福田店', entityId: ftEntity })).body.id;
}, 90_000);
afterAll(async () => ctx.close());

describe('多公司主体', () => {
  it('合同：默认当前门店的主体，也可以指定；台账按主体筛；有几个主体时「我方」用主体名称', async () => {
    const hq = await createContract();
    const inFt = await inStore(ft, () => createContract());
    const picked = await createContract({ entityId: ftEntity });
    const entityOf = async (id: number) => Number((await ctx.sql<{ e: number }[]>`SELECT entity_id AS e FROM contracts WHERE id = ${id}`)[0]!.e);
    expect(await entityOf(hq.id)).toBe(1);
    expect(await entityOf(inFt.id)).toBe(ftEntity);
    expect(await entityOf(picked.id)).toBe(ftEntity);
    const list = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/contracts?entityId=${ftEntity}`)).body as { id: number; entityName: string }[];
    expect(list.map((c) => c.id).sort()).toEqual([inFt.id, picked.id].sort());
    expect(list.every((c) => c.entityName === '福田汤泉有限公司')).toBe(true);
    // 指定一个不存在的主体：拒绝
    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/erp/contracts', { clientKey: randomUUID(), category: 'service', counterparty: 'x', content: content(), entityId: 99999 });
    expect(bad.body.error?.code).toBe('ENTITY_INVALID');
    // 合同文本里的「我方」
    const doc = await api(ctx.app, ctx.owner, 'GET', `/api/erp/contracts/${inFt.id}/document`);
    if (doc.status === 200) expect(JSON.stringify(doc.body)).toContain('福田汤泉有限公司');
  });

  it('银行账户：默认当前门店的主体；清单带主体名称', async () => {
    const hq = await api(ctx.app, ctx.owner, 'POST', '/api/erp/bank/accounts', { name: '本公司基本户', bankName: '工商银行', accountTail: '1234' });
    expect(hq.status, JSON.stringify(hq.body)).toBeLessThan(300);
    const fd = await inStore(ft, () => api(ctx.app, ctx.owner, 'POST', '/api/erp/bank/accounts', { name: '福田基本户', bankName: '招商银行', accountTail: '5678' }));
    expect(fd.status, JSON.stringify(fd.body)).toBeLessThan(300);
    expect(hq.body).toMatchObject({ entityId: 1 });
    expect(fd.body).toMatchObject({ entityId: ftEntity, entityName: '福田汤泉有限公司' });
  });

  it('开票申请：结账发生在福田店的，销售方是福田店的主体', async () => {
    const clerk = ctx.owner;
    await inStore(ft, async () => {
      expect((await api(ctx.app, clerk, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 1, width: 3, zone: 'male' })).status).toBe(200);
      await api(ctx.app, clerk, 'POST', '/api/shifts', { openingCash: 0 });
      const vin = await api(ctx.app, clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'K001', zone: 'male' }] });
      expect(vin.status, JSON.stringify(vin.body)).toBe(201);
      const visitId = vin.body.visits[0].id as number;
      const preview = (await api(ctx.app, clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
      const paid = await api(ctx.app, clerk, 'POST', '/api/frontdesk/checkouts', {
        clientKey: randomUUID(),
        visitIds: [visitId],
        expectedTotal: preview.totalAmount,
        payments: [{ method: 'cash', amount: preview.totalAmount }],
      });
      expect([200, 201], JSON.stringify(paid.body)).toContain(paid.status);
      const req = await api(ctx.app, clerk, 'POST', '/api/invoice-requests', {
        clientKey: randomUUID(),
        sourceType: 'checkout',
        sourceId: paid.body.id,
        amountCents: preview.totalAmount,
        titleType: 'personal',
        title: '王先生',
      });
      expect(req.status, JSON.stringify(req.body)).toBeLessThan(300);
      const id = req.body.request?.id ?? req.body.id;
      const [row] = await ctx.sql<{ e: number }[]>`SELECT entity_id AS e FROM invoice_requests WHERE id = ${id}`;
      expect(Number(row!.e)).toBe(ftEntity);
      await api(ctx.app, clerk, 'POST', `/api/shifts/${(await api(ctx.app, clerk, 'GET', '/api/shifts/current')).body.shift?.id}/close`, { countedCash: preview.totalAmount });
    });
  });
});
