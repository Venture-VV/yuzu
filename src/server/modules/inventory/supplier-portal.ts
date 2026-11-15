// 供应商门户（8.0.21，docs/FINANCE_V8021.md 第 7 节，CW-F / CW6；迁移 147）。
// 在对账确认链接（recon-links.ts）的做法上扩成三种，不开账号、凭链接，有效天数用同一项设置（默认 14 天），能作废、重发：
//   · 报价（开着的询价单，发给某一家）：供应商按询价单的行填单价、运费、交期、付款条件、有效期 → 替他登记一份报价
//     （经办人记生成链接的员工，来源记这条链接）；这家已经有有效报价的先撤下旧的再登记新的。定标、撤销以后不能再报。
//   · 订单确认（已确认的采购单）：确认能供、承诺到货日、备注 → 记一条确认（一张采购单只认第一次），采购单与流程图用承诺日。
//   · 发货预告（供应商已确认的采购单）：发货日、预计到货、各行发多少、物流单号 → 每次记一条（可以分批），收货时提示。
// 链接只存摘要（原文只在生成时给一次）；同一来源地址 10 分钟里试错最多 30 次；采购模块关着、过期、作废的打不开。
// 供应商的每次回复带页面生成的操作编号（client_key 唯一），没收到结果再点一次只记一次、内容不同的拒绝。
// 原样重提先认原编号（在采购模块开关、链接作废 / 过期 / 关了这些检查之前）：已经登记过的直接返回那一份；
// 采购模块关着报 `PORTAL_PAUSED`（会再开），与链接作废、过期的 `NOT_FOUND` 分开——页面只在后者这类以后也登记不上的拒绝时
// 清掉本机记着的那一份（Codex 审查 `970c95c` 后补）。
//
// 锁（没有反过来的路径）：生成先锁对象一行（询价单 / 采购单 `FOR NO KEY UPDATE`）→ 作废同一对象、同一家、同种类还在用的旧链接 → 写新链接；
// 回复：先不加锁读出链接对应的对象 → 锁对象一行（与员工端同一把：询价单 `FOR UPDATE`，与登记报价、定标串行；采购单 `FOR NO KEY UPDATE`）
// → 锁链接一行（`FOR UPDATE`，锁住以后再核对没作废、没过期）→ 写回复与结果；作废只锁链接一行。

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeliveryNotice, PoSupplierPortal, PortalQuote, SupplierConfirmation, SupplierLinkKind, SupplierLinkSnapshot, SupplierLinkState, SupplierPublicView } from '@shared/supplier-portal';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { idParam, parse } from '../../lib/validate';
import { AttemptLimiter } from '../canteen/portal-auth';
import { enabledErpModules } from '../erp';
import { loadSettings } from '../settings';
import { docDateSchema, setTxTimeouts, todayIn } from './common';
import { getPo } from './purchasing';
import { getSourcing, insertQuoteLocked, lockEvent } from './sourcing';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ───────────────────────── 读取 ─────────────────────────

async function linkStates(db: Db, where: { eventId?: number; poId?: number }): Promise<SupplierLinkState[]> {
  const rows = await db<(Omit<SupplierLinkState, 'replies'> & { replies: number })[]>`
    SELECT l.id, l.kind, l.supplier_id, s.name AS supplier_name, l.created_at, st.display_name AS created_by_name, l.expires_at, l.expires_at < now() AS expired,
           l.voided_at, (SELECT count(*)::int FROM supplier_link_replies r WHERE r.link_id = l.id) AS replies,
           (SELECT max(r.created_at) FROM supplier_link_replies r WHERE r.link_id = l.id) AS last_reply_at,
           (SELECT r.reply_name FROM supplier_link_replies r WHERE r.link_id = l.id ORDER BY r.id DESC LIMIT 1) AS last_reply_name
    FROM supplier_links l JOIN suppliers s ON s.id = l.supplier_id JOIN staff st ON st.id = l.created_by
    WHERE ${where.eventId ? db`l.sourcing_event_id = ${where.eventId}` : db`l.purchase_order_id = ${where.poId!}`}
    ORDER BY l.id DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id), supplierId: Number(r.supplierId) }));
}

/** 当前版次的订单确认（迁移 152：一张采购单的一个版次一次确认；改版前的留着，不算） */
async function confirmationOf(db: Db, poId: number): Promise<SupplierConfirmation | null> {
  const [c] = await db<SupplierConfirmation[]>`
    SELECT c.promised_date::text AS promised_date, c.reply_name, c.note, c.created_at
    FROM po_supplier_confirmations c JOIN purchase_orders p ON p.id = c.purchase_order_id AND c.po_revision = p.revision
    WHERE c.purchase_order_id = ${poId}`;
  return c ?? null;
}

export async function deliveryNotices(db: Db, poId: number): Promise<DeliveryNotice[]> {
  const rows = await db<{ id: number; content: { shipDate: string; eta: string | null; trackingNo: string; lines: { lineId: number; qtyMilli: number }[]; note: string }; replyName: string; createdAt: string }[]>`
    SELECT r.id, r.content, r.reply_name, r.created_at
    FROM supplier_link_replies r JOIN supplier_links l ON l.id = r.link_id JOIN purchase_orders p ON p.id = l.purchase_order_id
    WHERE l.purchase_order_id = ${poId} AND l.kind = 'delivery'
      -- 只认当前版次、当前供应商的链接报的（改版前、换供应商前的不算）
      AND l.supplier_id = p.supplier_id AND coalesce((l.snapshot ->> 'revision')::int, p.revision) = p.revision
    ORDER BY r.id`;
  return rows.map((r) => ({ id: Number(r.id), ...r.content, replyName: r.replyName, createdAt: r.createdAt }));
}

export async function poSupplierPortal(db: Db, poId: number): Promise<PoSupplierPortal> {
  return { confirmation: await confirmationOf(db, poId), notices: await deliveryNotices(db, poId), links: await linkStates(db, { poId }) };
}

// ───────────────────────── 生成、作废 ─────────────────────────

async function quoteSnapshot(db: Db, eventId: number, supplierName: string): Promise<SupplierLinkSnapshot> {
  const ev = await getSourcing(db, eventId);
  const { storeName } = await loadSettings(db);
  return {
    storeName,
    supplierName,
    docNo: ev.docNo,
    title: ev.title,
    needBy: ev.needBy,
    orderDate: null,
    note: ev.note,
    lines: ev.lines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, materialName: l.materialName, spec: l.spec, purchaseUnit: l.purchaseUnit, purchaseQtyMilli: l.purchaseQtyMilli, priceCents: null, amountCents: null })),
    totalCents: null,
  };
}

async function poSnapshot(db: Db, poId: number): Promise<SupplierLinkSnapshot> {
  const po = await getPo(db, poId);
  const { storeName } = await loadSettings(db);
  return {
    storeName,
    supplierName: po.supplier.name,
    docNo: po.docNo,
    title: `采购单 ${po.docNo}`,
    needBy: po.expectedDate,
    orderDate: po.orderDate,
    note: po.note,
    lines: po.lines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, materialName: l.materialName, spec: l.spec || l.specification, purchaseUnit: l.purchaseUnit, purchaseQtyMilli: l.purchaseQtyMilli, priceCents: l.priceCents, amountCents: l.amountCents })),
    totalCents: po.totalCents,
    // 发链接时的版次：采购单改版以后这条链接不能再回复（Codex 审查 beabd59 后补）
    revision: po.revision,
  };
}

/** 采购单的链接还算数吗：供应商还是这一家，发链接以后没改过版 */
function poLinkCurrent(l: { supplierId: number; snapshot: SupplierLinkSnapshot }, po: { supplierId: number; revision: number }) {
  return Number(po.supplierId) === l.supplierId && (l.snapshot.revision === undefined || l.snapshot.revision === Number(po.revision));
}

async function insertLink(tx: Tx, a: { kind: SupplierLinkKind; eventId: number | null; poId: number | null; supplierId: number; snapshot: SupplierLinkSnapshot; days: number }, actor: Actor, ip?: string) {
  const token = randomBytes(24).toString('base64url');
  // 同一对象、同一家、同种类还在用的旧链接作废（只留新发的一条能用）
  await tx`
    UPDATE supplier_links SET voided_by = ${actor.id}, voided_at = now()
    WHERE kind = ${a.kind} AND supplier_id = ${a.supplierId} AND voided_at IS NULL
      AND ${a.eventId ? tx`sourcing_event_id = ${a.eventId}` : tx`purchase_order_id = ${a.poId!}`}`;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO supplier_links (kind, sourcing_event_id, purchase_order_id, supplier_id, token_hash, snapshot, expires_at, created_by)
    VALUES (${a.kind}, ${a.eventId}, ${a.poId}, ${a.supplierId}, ${hashToken(token)}, ${tx.json(a.snapshot as never)}, now() + make_interval(days => ${a.days}), ${actor.id})
    RETURNING id`;
  await writeAudit(tx, {
    staffId: actor.id,
    action: 'supplier_link',
    targetType: a.eventId ? 'sourcing_event' : 'purchase_order',
    targetId: (a.eventId ?? a.poId)!,
    detail: { op: 'create', kind: a.kind, linkId: Number(row!.id), supplierId: a.supplierId, docNo: a.snapshot.docNo, days: a.days },
    ip,
  });
  return { token, id: Number(row!.id) };
}

/** 发报价链接给某一家：询价单要在询价中，供应商没停用 */
export async function createQuoteLink(deps: Deps, eventId: number, raw: unknown, actor: Actor, ip?: string) {
  const { supplierId } = parse(z.object({ supplierId: z.number().int().positive() }), raw);
  const { reconLinkDays } = await loadSettings(deps.sql);
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [e] = await tx<{ status: string }[]>`SELECT status FROM sourcing_events WHERE id = ${eventId} FOR NO KEY UPDATE`;
    if (!e) throw notFound('询价单不存在');
    if (e.status !== 'open') throw conflict('INVALID_STATE', e.status === 'awarded' ? '询价单已定标，不能再请供应商报价' : '询价单已撤销');
    const [s] = await tx<{ active: boolean; name: string }[]>`SELECT active, name FROM suppliers WHERE id = ${supplierId}`;
    if (!s?.active) throw unprocessable('SUPPLIER_INACTIVE', '供应商不存在或已停用');
    return insertLink(tx, { kind: 'quote', eventId, poId: null, supplierId, snapshot: await quoteSnapshot(tx, eventId, s.name), days: reconLinkDays }, actor, ip);
  });
  return { token: r.token, link: (await linkStates(deps.sql, { eventId })).find((l) => l.id === r.id)! };
}

/** 发订单确认 / 发货预告链接：采购单要已确认（没撤回、没关闭）；确认过的不再发确认链接，没确认的不发发货预告 */
export async function createPoLink(deps: Deps, poId: number, raw: unknown, actor: Actor, ip?: string) {
  const { kind } = parse(z.object({ kind: z.enum(['po_confirm', 'delivery'], '链接种类不对') }), raw);
  const { reconLinkDays } = await loadSettings(deps.sql);
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [po] = await tx<{ status: string; supplierId: number; backfill: boolean }[]>`
      SELECT status, supplier_id, backfill FROM purchase_orders WHERE id = ${poId} FOR NO KEY UPDATE`;
    if (!po) throw notFound('采购单不存在');
    if (po.status !== 'approved') throw conflict('INVALID_STATE', '只有已确认（还没关闭）的采购单能发给供应商');
    if (po.backfill) throw conflict('INVALID_STATE', '先收货后补的单不用供应商确认');
    const confirmed = await confirmationOf(tx, poId);
    if (kind === 'po_confirm' && confirmed) throw conflict('ALREADY_CONFIRMED', `供应商已经确认过（${confirmed.replyName}，承诺 ${confirmed.promisedDate} 到货）`);
    if (kind === 'delivery' && !confirmed) throw conflict('NOT_CONFIRMED', '供应商还没确认这张采购单，先发「订单确认」链接');
    return insertLink(tx, { kind, eventId: null, poId, supplierId: Number(po.supplierId), snapshot: await poSnapshot(tx, poId), days: reconLinkDays }, actor, ip);
  });
  return { token: r.token, link: (await linkStates(deps.sql, { poId })).find((l) => l.id === r.id)! };
}

export async function voidSupplierLink(deps: Deps, linkId: number, actor: Actor, ip?: string) {
  await deps.sql.begin(async (tx) => {
    const [l] = await tx<{ kind: SupplierLinkKind; voidedAt: string | null; eventId: number | null; poId: number | null }[]>`
      SELECT kind, voided_at, sourcing_event_id AS event_id, purchase_order_id AS po_id FROM supplier_links WHERE id = ${linkId} FOR UPDATE`;
    if (!l) throw notFound('链接不存在');
    if (l.voidedAt) return;
    await tx`UPDATE supplier_links SET voided_by = ${actor.id}, voided_at = now() WHERE id = ${linkId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'supplier_link', targetType: l.eventId ? 'sourcing_event' : 'purchase_order', targetId: Number(l.eventId ?? l.poId), detail: { op: 'void', kind: l.kind, linkId }, ip });
  });
  const [l] = await deps.sql<{ eventId: number | null; poId: number | null }[]>`SELECT sourcing_event_id AS event_id, purchase_order_id AS po_id FROM supplier_links WHERE id = ${linkId}`;
  return linkStates(deps.sql, l!.eventId ? { eventId: Number(l!.eventId) } : { poId: Number(l!.poId) });
}

// ───────────────────────── 供应商打开链接 ─────────────────────────

interface LinkRow {
  id: number;
  kind: SupplierLinkKind;
  eventId: number | null;
  poId: number | null;
  supplierId: number;
  snapshot: SupplierLinkSnapshot;
  expiresAt: string;
  expired: boolean;
  voidedAt: string | null;
  createdBy: number;
}

async function findByToken(db: Db, token: string, lock: boolean): Promise<LinkRow | null> {
  const [l] = await db<LinkRow[]>`
    SELECT id, kind, sourcing_event_id AS event_id, purchase_order_id AS po_id, supplier_id, snapshot, expires_at, expires_at < now() AS expired, voided_at, created_by
    FROM supplier_links WHERE token_hash = ${hashToken(token)}
    ${lock ? db`FOR UPDATE` : db``}`;
  return l ? { ...l, id: Number(l.id), eventId: n(l.eventId), poId: n(l.poId), supplierId: Number(l.supplierId), createdBy: Number(l.createdBy) } : null;
}

async function currentQuote(db: Db, eventId: number, supplierId: number): Promise<PortalQuote | null> {
  const [q] = await db<(Omit<PortalQuote, 'prices'> & { id: number })[]>`
    SELECT id, goods_cents, freight_cents, pay_terms, credit_days, delivery_days, valid_until::text AS valid_until, note, via_link_id IS NOT NULL AS via_link, created_at
    FROM sourcing_quotes WHERE event_id = ${eventId} AND supplier_id = ${supplierId} AND status = 'active'`;
  if (!q) return null;
  const prices = await db<{ lineId: number; priceCents: number }[]>`
    SELECT sourcing_line_id AS line_id, price_cents FROM sourcing_quote_lines WHERE quote_id = ${q.id}`;
  const { id: _id, ...rest } = q;
  return {
    ...rest,
    goodsCents: Number(q.goodsCents),
    freightCents: Number(q.freightCents),
    prices: prices.map((p) => ({ lineId: Number(p.lineId), priceCents: Number(p.priceCents) })),
  };
}

async function viewOf(db: Db, l: LinkRow): Promise<SupplierPublicView> {
  let open = true;
  let closedReason: string | null = null;
  let quote: PortalQuote | null = null;
  let confirmation: SupplierConfirmation | null = null;
  let notices: DeliveryNotice[] = [];
  if (l.kind === 'quote') {
    const [e] = await db<{ status: string }[]>`SELECT status FROM sourcing_events WHERE id = ${l.eventId!}`;
    if (e!.status !== 'open') {
      open = false;
      closedReason = '这次询价已经结束，不再接受报价。谢谢！';
    }
    quote = await currentQuote(db, l.eventId!, l.supplierId);
  } else {
    const [po] = await db<{ status: string; supplierId: number; revision: number }[]>`SELECT status, supplier_id, revision FROM purchase_orders WHERE id = ${l.poId!}`;
    const current = poLinkCurrent(l, po!);
    confirmation = current ? await confirmationOf(db, l.poId!) : null;
    if (l.kind === 'delivery' && current) notices = await deliveryNotices(db, l.poId!);
    if (!current) {
      open = false;
      closedReason = '这张采购单改过了（或换了供应商），这个链接不再用；请以门店重新发的链接为准。';
    } else if (po!.status !== 'approved') {
      open = false;
      closedReason = po!.status === 'closed' ? '这张采购单已经关闭，不用再回复。' : '这张采购单已经撤回，请以门店的通知为准。';
    } else if (l.kind === 'po_confirm' && confirmation) {
      open = false;
      closedReason = null;
    }
  }
  return { kind: l.kind, snapshot: l.snapshot, expiresAt: l.expiresAt, open, closedReason, quote, confirmation, notices };
}

const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, '链接不对') });
const Name = z.string('请留下您的姓名').trim().min(1, '请留下您的姓名').max(20, '姓名最多 20 个字');
const Base = { clientKey: z.uuid('页面过期了，请刷新后重试'), name: Name };
const QuoteReply = z.object({
  ...Base,
  prices: z.array(z.object({ lineId: z.number().int().positive(), priceCents: z.number('请填写单价').int().min(0, '单价不能为负').max(100_000_000) })).min(1).max(30),
  freightCents: z.number().int().min(0, '运费不能为负').max(100_000_000).default(0),
  payTerms: z.string().trim().min(1, '请写付款条件，例如「月结 30 天」「现付」').max(30, '付款条件最多 30 个字'),
  creditDays: z.number().int().min(0).max(365).default(0),
  deliveryDays: z.number().int().min(0).max(365).nullable().default(null),
  validUntil: docDateSchema.nullable().default(null),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
});
const ConfirmReply = z.object({ ...Base, promisedDate: docDateSchema, note: z.string().trim().max(300, '备注最多 300 个字').default('') });
const DeliveryReply = z.object({
  ...Base,
  shipDate: docDateSchema,
  eta: docDateSchema.nullable().default(null),
  trackingNo: z.string().trim().max(40, '物流单号最多 40 个字').default(''),
  lines: z.array(z.object({ lineId: z.number().int().positive(), qtyMilli: z.number().int().positive('发货数量要大于 0').max(1_000_000_000) })).min(1, '至少写一行发了多少').max(60),
  note: z.string().trim().max(300, '备注最多 300 个字').default(''),
});

export function registerSupplierPortalRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const limiter = new AttemptLimiter();

  // ── 员工端 ──
  app.get('/api/purchase-sourcing/:id/supplier-links', { preHandler: guard('inventory.read') }, async (req) => readSnapshot(sql, (tx) => linkStates(tx, { eventId: parse(idParam, req.params).id })));
  app.post('/api/purchase-sourcing/:id/supplier-links', { preHandler: guard('purchase.manage') }, async (req, reply) => {
    const r = await createQuoteLink(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    reply.code(201);
    return r;
  });
  app.get('/api/purchase-orders/:id/supplier-portal', { preHandler: guard('inventory.read') }, async (req) => readSnapshot(sql, (tx) => poSupplierPortal(tx, parse(idParam, req.params).id)));
  app.post('/api/purchase-orders/:id/supplier-links', { preHandler: guard('purchase.manage') }, async (req, reply) => {
    const r = await createPoLink(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    reply.code(201);
    return r;
  });
  app.post('/api/purchase-supplier-links/:id/void', { preHandler: guard('purchase.manage') }, async (req) => voidSupplierLink(deps, parse(idParam, req.params).id, req.actor, req.ip));

  // ── 供应商打开链接（不用登录）──
  const open = async (token: string, ip: string, db: Db = sql) => {
    limiter.check(ip);
    // 采购模块关着：会再开，与链接作废、过期分开（页面据此留着本机记着的那一份，不当成「以后也登记不上」）
    if (!(await enabledErpModules(db)).has('purchasing')) throw new AppError(404, 'PORTAL_PAUSED', '门店暂时关了供应商链接，请稍后再打开，或直接联系门店采购');
    const l = await findByToken(db, token, false);
    if (!l || l.voidedAt || l.expired) {
      limiter.fail(ip);
      throw notFound(l?.expired && !l.voidedAt ? '链接已过期，请联系门店重新发一份' : '链接不存在或已失效，请联系门店重新发一份');
    }
    return l;
  };
  app.get('/api/public/supplier/:token', async (req, reply) => {
    const { token } = parse(TokenParam, req.params);
    reply.header('cache-control', 'no-store');
    return viewOf(sql, await open(token, req.ip));
  });

  const parseReply = (kind: SupplierLinkKind, raw: unknown) => (kind === 'quote' ? parse(QuoteReply, raw) : kind === 'po_confirm' ? parse(ConfirmReply, raw) : parse(DeliveryReply, raw));

  app.post('/api/public/supplier/:token/reply', async (req, reply) => {
    const { token } = parse(TokenParam, req.params);
    reply.header('cache-control', 'no-store');
    // 原样重提先认原编号，在采购模块开关、链接作废 / 过期 / 关了这些检查之前：已经登记过的直接返回那一份。
    // 原来模块暂时关着时先报「链接不存在」，页面据此清掉本机记着的那一份，再开以后重新填写就记两次（Codex 审查 970c95c 后补）
    limiter.check(req.ip);
    const key = z.object({ clientKey: z.uuid() }).safeParse(req.body);
    if (key.success) {
      const [prev] = await sql<{ linkId: number; requestHash: string }[]>`SELECT link_id, request_hash FROM supplier_link_replies WHERE client_key = ${key.data.clientKey}`;
      const mine = prev ? await findByToken(sql, token, false) : null;
      if (prev && mine && Number(prev.linkId) === mine.id) {
        const again = parseReply(mine.kind, req.body);
        if (prev.requestHash !== hashRequest({ ...again, clientKey: undefined, linkId: mine.id })) throw conflict('IDEMPOTENCY_CONFLICT', '这次提交的内容和刚才的不一样，请刷新页面后重新填写');
        return viewOf(sql, mine);
      }
    }
    const first = await open(token, req.ip);
    const input = parseReply(first.kind, req.body);
    const requestHash = hashRequest({ ...input, clientKey: undefined, linkId: first.id });
    const today = todayIn(config.timezone);
    try {
      await sql.begin(async (tx) => {
        await setTxTimeouts(tx);
        // 对象一行（与员工端同一把锁）→ 链接一行
        if (first.kind === 'quote') await lockEvent(tx, first.eventId!);
        const [poRow] = first.kind === 'quote' ? [] : await tx<{ revision: number }[]>`SELECT revision FROM purchase_orders WHERE id = ${first.poId!} FOR NO KEY UPDATE`;
        const l = await findByToken(tx, token, true);
        if (!l || l.voidedAt) throw notFound('链接已失效，请联系门店重新发一份');
        // 同一个操作编号：原样重提照样返回，内容不同的拒绝
        const [prev] = await tx<{ requestHash: string; linkId: number }[]>`SELECT request_hash, link_id FROM supplier_link_replies WHERE client_key = ${input.clientKey}`;
        if (prev) {
          if (prev.requestHash !== requestHash || Number(prev.linkId) !== l.id) throw conflict('IDEMPOTENCY_CONFLICT', '这次提交的内容和刚才的不一样，请刷新页面后重新填写');
          return;
        }
        if (l.expired) throw unprocessable('LINK_EXPIRED', '链接已过期，请联系门店重新发一份');
        const view = await viewOf(tx, l);
        if (!view.open) throw conflict('LINK_CLOSED', view.closedReason ?? (l.kind === 'po_confirm' ? '这张采购单已经确认过了' : '链接已失效'));
        const insertReply = async (content: unknown, quoteId: number | null) => {
          const [r] = await tx<{ id: number }[]>`
            INSERT INTO supplier_link_replies (link_id, client_key, request_hash, reply_name, content, quote_id, ip)
            VALUES (${l.id}, ${input.clientKey}, ${requestHash}, ${input.name}, ${tx.json(content as never)}, ${quoteId}, ${req.ip})
            RETURNING id`;
          return Number(r!.id);
        };
        if (l.kind === 'quote') {
          const q = input as z.infer<typeof QuoteReply>;
          if (q.validUntil && q.validUntil < today) throw unprocessable('QUOTE_EXPIRED', '报价有效期不能早于今天');
          // 这家已经有有效报价（员工登记的或上一次链接里报的）：先撤下，再登记这一份
          await tx`
            UPDATE sourcing_quotes SET status = 'withdrawn', withdraw_reason = '供应商通过报价链接重新报价', withdrawn_by = ${l.createdBy}, withdrawn_at = now()
            WHERE event_id = ${l.eventId!} AND supplier_id = ${l.supplierId} AND status = 'active'`;
          const quote = await insertQuoteLocked(
            tx,
            l.eventId!,
            { supplierId: l.supplierId, clientKey: q.clientKey, freightCents: q.freightCents, payTerms: q.payTerms, creditDays: q.creditDays, deliveryDays: q.deliveryDays, validUntil: q.validUntil, note: q.note, prices: q.prices },
            requestHash,
            l.createdBy,
            l.id,
          );
          await tx`UPDATE sourcing_events SET updated_at = now() WHERE id = ${l.eventId!}`;
          await insertReply({ goodsCents: quote.goodsCents, freightCents: q.freightCents, payTerms: q.payTerms, deliveryDays: q.deliveryDays, validUntil: q.validUntil, note: q.note }, quote.id);
          await writeAudit(tx, { staffId: null, action: 'supplier_reply', targetType: 'sourcing_event', targetId: l.eventId!, detail: { kind: 'quote', linkId: l.id, quoteId: quote.id, name: input.name, goodsCents: quote.goodsCents, freightCents: q.freightCents }, ip: req.ip });
        } else if (l.kind === 'po_confirm') {
          const c = input as z.infer<typeof ConfirmReply>;
          if (c.promisedDate < today) throw unprocessable('DATE_PASSED', '承诺到货日不能早于今天');
          const replyId = await insertReply({ promisedDate: c.promisedDate, note: c.note }, null);
          await tx`
            INSERT INTO po_supplier_confirmations (purchase_order_id, link_id, reply_id, promised_date, reply_name, note, po_revision)
            VALUES (${l.poId!}, ${l.id}, ${replyId}, ${c.promisedDate}, ${input.name}, ${c.note}, ${Number(poRow!.revision)})`;
          await writeAudit(tx, { staffId: null, action: 'supplier_reply', targetType: 'purchase_order', targetId: l.poId!, detail: { kind: 'po_confirm', linkId: l.id, name: input.name, promisedDate: c.promisedDate }, ip: req.ip });
        } else {
          const d = input as z.infer<typeof DeliveryReply>;
          if (d.eta && d.eta < d.shipDate) throw unprocessable('DATE_ORDER', '预计到货不能早于发货日');
          const byId = new Map(l.snapshot.lines.map((x) => [x.lineId, x]));
          const seen = new Set<number>();
          for (const x of d.lines) {
            const line = byId.get(x.lineId);
            if (!line) throw badRequest('有一行不在这张采购单上，请刷新后重试');
            if (seen.has(x.lineId)) throw badRequest('同一行只写一次');
            seen.add(x.lineId);
            if (x.qtyMilli > line.purchaseQtyMilli) throw unprocessable('QTY_OVER', `「${line.materialName}」发货数量超过了下单数量`);
          }
          await insertReply({ shipDate: d.shipDate, eta: d.eta, trackingNo: d.trackingNo, lines: d.lines, note: d.note }, null);
          await writeAudit(tx, { staffId: null, action: 'supplier_reply', targetType: 'purchase_order', targetId: l.poId!, detail: { kind: 'delivery', linkId: l.id, name: input.name, shipDate: d.shipDate, eta: d.eta, lines: d.lines.length }, ip: req.ip });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'supplier_link_replies_client_key_key')) {
        const [prev] = await sql<{ requestHash: string }[]>`SELECT request_hash FROM supplier_link_replies WHERE client_key = ${input.clientKey}`;
        if (!prev || prev.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这次提交的内容和刚才的不一样，请刷新页面后重新填写');
      } else if (isUniqueViolation(error, 'po_supplier_confirmations_po_revision')) {
        throw conflict('LINK_CLOSED', '这张采购单已经确认过了');
      } else throw error;
    }
    return viewOf(sql, (await findByToken(sql, token, false))!);
  });
}

