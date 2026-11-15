// 8.0.21 合同模板与导出（docs/FINANCE_V8021.md 第 6 节，CW-E / CW20；迁移 146）
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amountInChinese, renderContractDoc } from '../src/shared/contract-templates';
import type { ContractContent } from '../src/shared/contracts';
import { ContentInput } from '../src/server/modules/contracts/content';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let legal: string;
let viewer: string;

const content = (over: Partial<Omit<ContractContent, 'template'>> & Record<string, unknown> = {}) => ({
  title: '保洁服务合同',
  startDate: '2026-12-01',
  endDate: '2027-11-30',
  totalCents: 1_234_500,
  taxRateBp: 600,
  freightBearer: 'na',
  unloadingBearer: 'na',
  paymentTerms: [
    { stage: 'prepay', percentBp: 3000, condition: '签订后 7 天内' },
    { stage: 'delivery', percentBp: 0, condition: '' },
    { stage: 'acceptance', percentBp: 7000, condition: '每月验收后' },
    { stage: 'warranty', percentBp: 0, condition: '' },
  ],
  warranty: { basis: 'acceptance', months: 0 },
  acceptance: { method: '按月检查', signer: '前厅经理', penalty: '扣当月服务费 5%', templateName: '', items: [] },
  note: '',
  lines: [],
  ...over,
});

/** 从 .docx（zip）里取出某个文件的内容 */
function unzipEntry(buf: Buffer, name: string): string | null {
  let i = 0;
  while (i < buf.length - 30 && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const n = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extra;
    const data = buf.subarray(start, start + size);
    if (n === name) return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    i = start + size;
  }
  return null;
}

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'ct-legal', displayName: '法务甲', role: 'backoffice', duties: ['legal'] as never, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'ct-cost', displayName: '成本乙', role: 'backoffice', duties: ['cost'] as never, password: PASSWORD, mustChangePassword: false });
  legal = await login(ctx.app, 'ct-legal');
  viewer = await login(ctx.app, 'ct-cost');
}, 60_000);
afterAll(async () => ctx.close());

describe('渲染', () => {
  it('人民币大写', () => {
    expect(amountInChinese(1_234_500)).toBe('壹万贰仟叁佰肆拾伍元整');
    expect(amountInChinese(100_000_007)).toBe('壹佰万元零柒分');
    expect(amountInChinese(1_000_050)).toBe('壹万元伍角');
    expect(amountInChinese(1_000_105)).toBe('壹万零壹元零伍分');
    expect(amountInChinese(10_000_000)).toBe('壹拾万元整');
    expect(amountInChinese(0)).toBe('零元整');
    expect(amountInChinese(305_00)).toBe('叁佰零伍元整');
  });
  it('占位换成值、表格单独成段、勾的条款接在后面；没填的显示【字段】', () => {
    const c = { ...(content() as unknown as ContractContent), template: { id: 1, code: 'HT-001', version: 1, name: '保洁', values: { 服务区域: '一楼大堂' }, clauses: ['k2'] } };
    const blocks = renderContractDoc(c, { contractNo: 'HT2026-001', counterparty: '城南保洁', storeName: '汤崎', versionLabel: '草稿' }, {
      body: '# 第一条 服务内容\n\n乙方 {{相对方}} 为甲方 {{我方}} 提供 {{服务区域}} 的保洁，总价 {{总价}}（{{总价大写}}），联系人 {{联系人}}。\n\n{{付款节点}}',
      clauses: [
        { key: 'k1', title: '保密', text: '不外传', default: true },
        { key: 'k2', title: '违约', text: '按 {{不合格处理}}', default: false },
      ],
    });
    expect(blocks[0]).toEqual({ kind: 'heading', text: '保洁服务合同' });
    expect(blocks[1]).toEqual({ kind: 'heading', text: '第一条 服务内容' });
    expect(blocks[2]).toEqual({ kind: 'para', text: '乙方 城南保洁 为甲方 汤崎 提供 一楼大堂 的保洁，总价 ¥12,345.00（壹万贰仟叁佰肆拾伍元整），联系人 【联系人】。' });
    expect(blocks[3]).toMatchObject({ kind: 'table', header: ['付款节点', '比例', '金额', '条件'], rows: [['预付', '30%', '¥3,703.50', '签订后 7 天内'], ['验收', '70%', '¥8,641.50', '每月验收后']] });
    expect(blocks.slice(-2)).toEqual([
      { kind: 'heading', text: '补充条款' },
      { kind: 'para', text: '1. 违约：按 扣当月服务费 5%' },
    ]);
  });
  it('内置字段以合同本身为准：模板值里有同名的（旧数据）也盖不掉总价、相对方', () => {
    const c = { ...(content() as unknown as ContractContent), template: { id: 1, code: 'HT-001', version: 1, name: '保洁', values: { 总价: '¥999.00', 相对方: '别人' }, clauses: [] } };
    const blocks = renderContractDoc(c, { contractNo: 'HT2026-001', counterparty: '城南保洁', storeName: '汤崎', versionLabel: '草稿' }, { body: '乙方 {{相对方}}，总价 {{总价}}。', clauses: [] });
    expect(blocks[1]).toEqual({ kind: 'para', text: '乙方 城南保洁，总价 ¥12,345.00。' });
  });
  it('没选模板时解析结果里没有 template 这个键（原请求摘要与升级前一样），传 null 也一样', () => {
    expect('template' in ContentInput.parse(content())).toBe(false);
    expect(JSON.stringify(ContentInput.parse({ ...content(), template: null }))).toBe(JSON.stringify(ContentInput.parse(content())));
    expect(ContentInput.parse({ ...content(), template: { id: 3 } }).template).toEqual({ id: 3, values: {}, clauses: [] });
  });
});

describe('合同模板', () => {
  it('维护要「管理合同」；改版 = 停用旧版、写新版；已经起草的合同记着旧版；导出 Word 与打印用的内容', async () => {
    const body = {
      name: '保洁服务（标准版）',
      category: 'service',
      body: '# 第一条\n\n乙方 {{相对方}} 负责 {{服务区域}}，合同编号 {{合同编号}}，总价 {{总价大写}}。\n\n{{付款节点}}',
      fields: [{ key: '服务区域', label: '服务区域', type: 'text', required: true }],
      clauses: [{ key: 'secret', title: '保密', text: '双方对价格保密', default: true }],
    };
    expect((await api(ctx.app, viewer, 'POST', '/api/erp/contracts/doc-templates', body)).status).toBe(403);
    const t1 = await api(ctx.app, legal, 'POST', '/api/erp/contracts/doc-templates', body);
    expect(t1.status, JSON.stringify(t1.body)).toBe(201);
    expect(t1.body).toMatchObject({ code: 'HT-001', version: 1, status: 'active' });
    expect((await api(ctx.app, legal, 'POST', '/api/erp/contracts/doc-templates', { ...body, fields: [body.fields[0], body.fields[0]] })).status).toBe(400);
    // 可填字段不能和内置字段重名
    const clash = await api(ctx.app, legal, 'POST', '/api/erp/contracts/doc-templates', { ...body, fields: [{ key: '总价', label: '总价', type: 'text', required: false }] });
    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toContain('内置字段');
    expect((await api(ctx.app, legal, 'POST', `/api/erp/contracts/doc-templates/${t1.body.id}/revise`, { ...body, fields: [{ key: '相对方', label: '乙方', type: 'text', required: false }] })).status).toBe(400);

    // 没选模板的合同：原样重提（不带 template、带 template: null）都认作同一次
    const plainKey = randomUUID();
    const plain = { clientKey: plainKey, category: 'service', supplierId: null, counterparty: '城北保洁公司', content: content({ title: '不用模板的合同' }) };
    const p1 = await api(ctx.app, legal, 'POST', '/api/erp/contracts', plain);
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    const p2 = await api(ctx.app, legal, 'POST', '/api/erp/contracts', { ...plain, content: { ...plain.content, template: null } });
    expect(p2.body.contract.id).toBe(p1.body.contract.id);

    // 用第 1 版起草一份服务合同
    const created = await api(ctx.app, legal, 'POST', '/api/erp/contracts', {
      clientKey: randomUUID(),
      category: 'service',
      supplierId: null,
      counterparty: '城南保洁公司',
      content: content({ template: { id: t1.body.id, values: {}, clauses: ['secret'] } }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const c = created.body.contract;
    expect(c.content.template).toMatchObject({ id: t1.body.id, code: 'HT-001', version: 1, clauses: ['secret'], values: {} });
    // 模板里没有的字段、条款拒绝
    expect((await api(ctx.app, legal, 'PUT', `/api/erp/contracts/${c.id}`, { version: c.version, category: 'service', supplierId: null, counterparty: '城南保洁公司', content: content({ template: { id: t1.body.id, values: { 不存在: 'x' }, clauses: [] } }) })).status).toBe(400);
    // 必填字段没填：提交审查拦下
    const submit = await api(ctx.app, legal, 'POST', `/api/erp/contracts/${c.id}/submit`, { version: c.version });
    expect(submit.body.error?.code).toBe('CONTRACT_INCOMPLETE');
    expect(submit.body.error.message).toContain('服务区域');
    const saved = await api(ctx.app, legal, 'PUT', `/api/erp/contracts/${c.id}`, { version: c.version, category: 'service', supplierId: null, counterparty: '城南保洁公司', content: content({ template: { id: t1.body.id, values: { 服务区域: '一楼大堂与更衣室' }, clauses: ['secret'] } }) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    // 改版：第 1 版停用、第 2 版在用；合同还记着第 1 版
    const t2 = await api(ctx.app, legal, 'POST', `/api/erp/contracts/doc-templates/${t1.body.id}/revise`, { ...body, body: `${body.body}\n\n第二版加的一段。` });
    expect(t2.body).toMatchObject({ code: 'HT-001', version: 2, status: 'active' });
    expect((await api(ctx.app, legal, 'POST', `/api/erp/contracts/doc-templates/${t1.body.id}/revise`, body)).body.error.code).toBe('TEMPLATE_RETIRED');
    const list = (await api(ctx.app, viewer, 'GET', '/api/erp/contracts/doc-templates?all=1')).body;
    expect(list.map((t: { version: number; status: string; usedBy: number }) => [t.version, t.status, t.usedBy])).toEqual([
      [2, 'active', 0],
      [1, 'retired', 1],
    ]);
    await expect(ctx.sql`UPDATE contract_templates SET body = 'x' WHERE id = ${t1.body.id}`).rejects.toThrow(/不改/);

    // 导出的内容：按第 1 版渲染
    const doc = (await api(ctx.app, viewer, 'GET', `/api/erp/contracts/${c.id}/document`)).body;
    expect(doc).toMatchObject({ versionLabel: '草稿', templateName: '保洁服务（标准版）（第 1 版）' });
    expect(JSON.stringify(doc.blocks)).toContain('乙方 城南保洁公司 负责 一楼大堂与更衣室');
    expect(JSON.stringify(doc.blocks)).toContain('壹万贰仟叁佰肆拾伍元整');
    expect(JSON.stringify(doc.blocks)).not.toContain('第二版加的一段');
    expect(JSON.stringify(doc.blocks)).toContain('双方对价格保密');
    const docx = await ctx.app.inject({ method: 'GET', url: `/api/erp/contracts/${c.id}/document.docx`, headers: { cookie: viewer } });
    expect(docx.statusCode).toBe(200);
    expect(docx.headers['content-type']).toContain('wordprocessingml');
    const xml = unzipEntry(docx.rawPayload, 'word/document.xml');
    expect(xml).toContain('一楼大堂与更衣室');
    expect(xml).toContain('<w:tbl>');
    expect(unzipEntry(docx.rawPayload, 'word/header1.xml')).toContain(c.contractNo);
  });

  it('长模板：正文与条款在上限以内、请求体超过 64 KB 的也能新建、改版（Codex 审查 58100ca 后补）', async () => {
    const long = {
      name: '长篇服务合同',
      category: 'service',
      body: `# 总则\n\n${'甲乙双方本着平等互利的原则协商一致订立本合同'.repeat(1_000)}`,
      fields: [],
      clauses: [],
    };
    expect(Buffer.byteLength(JSON.stringify(long))).toBeGreaterThan(64 * 1024);
    const t = await api(ctx.app, legal, 'POST', '/api/erp/contracts/doc-templates', long);
    expect(t.status, JSON.stringify(t.body).slice(0, 200)).toBe(201);
    const clauses = Array.from({ length: 30 }, (_, i) => ({ key: `c${i}`, title: `第 ${i + 1} 条补充`, text: '条款内容'.repeat(500), default: false }));
    const revised = await api(ctx.app, legal, 'POST', `/api/erp/contracts/doc-templates/${t.body.id}/revise`, { ...long, body: long.body.slice(0, 29_000), clauses });
    expect(revised.status, JSON.stringify(revised.body).slice(0, 200)).toBe(201);
    expect(revised.body).toMatchObject({ version: 2 });
  });
});
