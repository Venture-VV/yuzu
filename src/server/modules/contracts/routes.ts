// 合同的接口（v0.7.31，docs/CONTRACTS.md）：前缀 /api/erp/contracts，跟 ERP「合同」模块的开关走（模块关着时一律拒绝）。
// 查看要「查看合同」，维护要「维护合同」，审批（同意、退回）与审批中心一样要能用审批中心；能不能审某一级看审批规则。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTRACT_CATEGORIES } from '@shared/contracts';
import { guardAny } from '../../auth/guard';
import { readSnapshot } from '../../db';
import type { Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import {
  actOnChange,
  actOnContract,
  actOnSeal,
  addFile,
  archiveContract,
  createChange,
  createContract,
  createSeal,
  removeFile,
  resubmitSeal,
  signContract,
  submitChange,
  submitContract,
  terminateContract,
  updateChange,
  updateContract,
  voidChange,
  voidContract,
  withdrawChange,
  withdrawContract,
  withdrawSeal,
} from './flow';
import { checkAgainstContract, contractOptions, expiringContracts, getContract, listContracts, type ContractListFilter } from './ledger';

const READ = guardAny('contract.read');
const MANAGE = guardAny('contract.manage');
const ACT = guardAny('approval.act', 'inventory.approve', 'expense.approve');
const PO = guardAny('purchase.manage', 'contract.read');

const ListQuery = z.object({
  filter: z.enum(['all', 'drafting', 'reviewing', 'effective', 'expiring', 'closed']).default('all'),
  category: z.enum(CONTRACT_CATEGORIES).optional(),
  q: z.string().trim().max(32).optional(),
});
const CheckBody = z.object({
  contractId: z.number().int().positive(),
  poId: z.number().int().positive().nullable().default(null),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        materialId: z.number().int().positive(),
        purchaseUnit: z.string().max(8),
        purchaseQtyMilli: z.number().int().positive(),
        priceCents: z.number().int().min(0),
      }),
    )
    .max(200),
});

const param = (req: FastifyRequest, name = 'id') => parse(idParam, { id: (req.params as Record<string, unknown>)[name] }).id;

export function registerContractRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const today = () => todayIn(deps.config.timezone);
  const detail = (contractId: number) => readSnapshot(sql, (tx) => getContract(tx, today(), contractId));
  /** 变更单、用印申请、扫描件属于哪份合同（接口返回整份合同的详情） */
  const contractOf = async (table: 'contract_changes' | 'contract_seals' | 'contract_files', rowId: number) => {
    const rows =
      table === 'contract_changes'
        ? await sql<{ contractId: number }[]>`SELECT contract_id FROM contract_changes WHERE id = ${rowId}`
        : table === 'contract_seals'
          ? await sql<{ contractId: number }[]>`SELECT contract_id FROM contract_seals WHERE id = ${rowId}`
          : await sql<{ contractId: number }[]>`SELECT contract_id FROM contract_files WHERE id = ${rowId}`;
    if (!rows[0]) throw notFound(table === 'contract_changes' ? '变更单不存在' : table === 'contract_seals' ? '用印申请不存在' : '扫描件不存在');
    return Number(rows[0].contractId);
  };

  // ── 读 ──
  app.get('/api/erp/contracts', { preHandler: READ }, async (req) => {
    const q = parse(ListQuery, req.query);
    return readSnapshot(sql, (tx) => listContracts(tx, today(), { filter: q.filter as ContractListFilter, category: q.category, q: q.q }));
  });
  app.get('/api/erp/contracts/meta', { preHandler: READ }, async () =>
    readSnapshot(sql, async (tx) => ({
      today: today(),
      suppliers: await tx<{ id: number; name: string }[]>`SELECT id, name FROM suppliers WHERE active ORDER BY name`,
      departments: await tx<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active ORDER BY name`,
      staff: await tx<{ id: number; displayName: string }[]>`SELECT id, display_name FROM staff WHERE active ORDER BY display_name`,
      materials: await tx<{ id: number; name: string; purchaseUnit: string; specification: string }[]>`
        SELECT id, name, purchase_unit, specification FROM materials WHERE active ORDER BY name`,
    })),
  );
  app.get('/api/erp/contracts/expiring', { preHandler: READ }, async () => readSnapshot(sql, (tx) => expiringContracts(tx, today())));
  // 采购单选合同、按单价表核对（C9）：采购经办与看合同的人能用
  app.get('/api/erp/contracts/options', { preHandler: PO }, async (req) => {
    const { supplierId } = parse(z.object({ supplierId: z.coerce.number().int().positive('请选择供应商') }), req.query);
    return readSnapshot(sql, (tx) => contractOptions(tx, today(), supplierId));
  });
  app.post('/api/erp/contracts/check', { preHandler: PO }, async (req) => {
    const b = parse(CheckBody, req.body);
    return readSnapshot(sql, async (tx) => {
      const [c] = await tx<{ contractNo: string }[]>`SELECT contract_no FROM contracts WHERE id = ${b.contractId}`;
      if (!c) throw notFound('合同不存在');
      return checkAgainstContract(tx, b.contractId, c.contractNo, b.lines, b.poId);
    });
  });
  app.get('/api/erp/contracts/files/:id', { preHandler: READ }, async (req, reply) => {
    const [img] = await sql<{ mime: string; data: Buffer }[]>`
      SELECT i.mime, i.data FROM contract_files f JOIN erp_images i ON i.id = f.image_id WHERE f.id = ${param(req)}`;
    if (!img) throw notFound('扫描件不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
  app.get('/api/erp/contracts/:id', { preHandler: READ }, async (req) => detail(param(req)));

  // ── 合同 ──
  app.post('/api/erp/contracts', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createContract(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return { contract: await detail(r.id), replayed: r.replayed };
  });
  app.put('/api/erp/contracts/:id', { preHandler: MANAGE }, async (req) => {
    await updateContract(deps, param(req), req.body, req.actor, req.ip);
    return detail(param(req));
  });
  const contractOps = { submit: submitContract, withdraw: withdrawContract, void: voidContract, terminate: terminateContract, sign: signContract, archive: archiveContract };
  for (const [op, fn] of Object.entries(contractOps)) {
    app.post(`/api/erp/contracts/:id/${op}`, { preHandler: MANAGE }, async (req) => {
      await fn(deps, param(req), req.body ?? {}, req.actor, req.ip);
      return detail(param(req));
    });
  }
  for (const action of ['approve', 'return'] as const) {
    app.post(`/api/erp/contracts/:id/${action}`, { preHandler: ACT }, async (req) => {
      await actOnContract(deps, param(req), action, req.body ?? {}, req.actor);
      return detail(param(req));
    });
  }

  // ── 扫描件 ──
  app.post('/api/erp/contracts/:id/files', { preHandler: MANAGE, bodyLimit: 1_600_000 }, async (req, reply) => {
    await addFile(deps, param(req), req.body, req.actor, req.ip);
    reply.code(201);
    return detail(param(req));
  });
  app.post('/api/erp/contracts/files/:id/remove', { preHandler: MANAGE }, async (req) => {
    const contractId = await contractOf('contract_files', param(req));
    await removeFile(deps, param(req), req.actor, req.ip);
    return detail(contractId);
  });

  // ── 变更单（C10） ──
  app.post('/api/erp/contracts/:id/changes', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createChange(deps, param(req), req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    const contract = await detail(param(req));
    return { change: contract.changes.find((c) => c.id === r.id)!, contract, replayed: r.replayed };
  });
  app.put('/api/erp/contracts/changes/:id', { preHandler: MANAGE }, async (req) => {
    const contractId = await contractOf('contract_changes', param(req));
    await updateChange(deps, param(req), req.body, req.actor, req.ip);
    return detail(contractId);
  });
  const changeOps = { submit: submitChange, withdraw: withdrawChange, void: voidChange };
  for (const [op, fn] of Object.entries(changeOps)) {
    app.post(`/api/erp/contracts/changes/:id/${op}`, { preHandler: MANAGE }, async (req) => {
      const contractId = await contractOf('contract_changes', param(req));
      await fn(deps, param(req), req.body ?? {}, req.actor, req.ip);
      return detail(contractId);
    });
  }
  for (const action of ['approve', 'return'] as const) {
    app.post(`/api/erp/contracts/changes/:id/${action}`, { preHandler: ACT }, async (req) => {
      const contractId = await contractOf('contract_changes', param(req));
      await actOnChange(deps, param(req), action, req.body ?? {}, req.actor);
      return detail(contractId);
    });
  }

  // ── 用印申请（C7） ──
  app.post('/api/erp/contracts/:id/seals', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createSeal(deps, param(req), req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    const contract = await detail(param(req));
    return { seal: contract.seals.find((s) => s.id === r.id)!, contract, replayed: r.replayed };
  });
  app.put('/api/erp/contracts/seals/:id', { preHandler: MANAGE }, async (req) => {
    const contractId = await contractOf('contract_seals', param(req));
    await resubmitSeal(deps, param(req), req.body, req.actor, req.ip);
    return detail(contractId);
  });
  app.post('/api/erp/contracts/seals/:id/withdraw', { preHandler: MANAGE }, async (req) => {
    const contractId = await contractOf('contract_seals', param(req));
    await withdrawSeal(deps, param(req), req.body ?? {}, req.actor, req.ip);
    return detail(contractId);
  });
  for (const action of ['approve', 'return'] as const) {
    app.post(`/api/erp/contracts/seals/:id/${action}`, { preHandler: ACT }, async (req) => {
      const contractId = await contractOf('contract_seals', param(req));
      await actOnSeal(deps, param(req), action, req.body ?? {}, req.actor);
      return detail(contractId);
    });
  }
}
