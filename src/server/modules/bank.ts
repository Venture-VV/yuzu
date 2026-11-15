// 8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17）。
//   · 账户：本公司的账户，只存开户行与后四位；记住导入时列怎么对。
//   · 导入：网银导出的 CSV / Excel，按同义词认列（@shared/bank），同一份文件只导一次，流水按去重键不重复记。
//   · 勾对：一条流水对系统里的一笔或几笔；导入时自动对「金额相等、日期前后 3 天、对方户名对得上、只有一个候选」的，其余人工挑。
//     勾对的金额合计等于流水金额才算对平。撤销写原因。对象后来作废了不拦，标红。
// 锁：导入先取操作编号的咨询锁（与「确认作废」串行，业务类型 bank_import）→「账户 + 文件摘要」的咨询锁 → 写导入与流水（新行）→
//     自动勾对（新流水已在本事务里，对象 FOR KEY SHARE）；人工勾对：流水一行（FOR UPDATE，带版本号）→ 对象（FOR KEY SHARE，按种类、id 升序，
//     锁住以后核对没作废、没对过）→ 写勾对，同一个对象靠部分唯一索引兜底；撤销：流水一行 → 勾对一行。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BANK_TEMPLATES,
  columnMapProblem,
  detectColumns,
  IN_TARGETS,
  MATCH_TARGET_LABELS,
  MATCH_TARGET_TYPES,
  OUT_TARGETS,
  parseStatementRows,
  STATEMENT_FIELDS,
  type BankAccount,
  type BankImportPreview,
  type BankLine,
  type BankMatch,
  type BankOverview,
  type ColumnMap,
  type MatchTarget,
  type MatchTargetType,
} from '@shared/bank';
import { guard } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Fragment, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { todayIn } from '../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { readSheet } from '../lib/sheet-read';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { recordItemPaid } from './payment-batches';

const READ = guard('payable.read');
const MANAGE = guard('payable.manage');
const AUTO_DAYS = 3;
const STALE_DAYS = 7;

// ───────────────────────── 账户 ─────────────────────────

interface AccountRow extends Omit<BankAccount, 'id'> {
  id: number;
}
async function listAccounts(db: Db): Promise<BankAccount[]> {
  const rows = await db<AccountRow[]>`SELECT id, name, bank_name, account_tail, template, column_map, active, version FROM bank_accounts ORDER BY NOT active, id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), columnMap: (r.columnMap ?? {}) as ColumnMap }));
}
async function getAccount(db: Db, id: number): Promise<BankAccount> {
  const a = (await listAccounts(db)).find((x) => x.id === id);
  if (!a) throw notFound('银行账户不存在');
  return a;
}

const AccountInput = z.object({
  name: z.string('请填写账户名称').trim().min(1, '请填写账户名称').max(30, '账户名称最多 30 个字'),
  bankName: z.string('请填写开户行').trim().min(1, '请填写开户行').max(40, '开户行最多 40 个字'),
  accountTail: z.string('请填写账号后四位').trim().regex(/^[0-9]{4}$/, '只填账号的后四位数字（完整账号不进系统）'),
  template: z.enum(BANK_TEMPLATES, '网银格式不对').default('generic'),
});

async function createAccount(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(AccountInput, raw);
  try {
    const [row] = await deps.sql<{ id: number }[]>`
      INSERT INTO bank_accounts (name, bank_name, account_tail, template, created_by)
      VALUES (${input.name}, ${input.bankName}, ${input.accountTail}, ${input.template}, ${actor.id}) RETURNING id`;
    await writeAudit(deps.sql, { staffId: actor.id, action: 'bank_account', targetType: 'bank_account', targetId: row!.id, detail: { op: 'create', ...input }, ip });
    return getAccount(deps.sql, Number(row!.id));
  } catch (error) {
    if (isUniqueViolation(error, 'bank_accounts_name_key')) throw conflict('BANK_ACCOUNT_EXISTS', `已经有叫「${input.name}」的账户`);
    throw error;
  }
}

async function updateAccount(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(AccountInput.extend({ version: z.number().int().min(1), active: z.boolean() }), raw);
  try {
    await deps.sql.begin(async (tx) => {
      const [a] = await tx<{ version: number }[]>`SELECT version FROM bank_accounts WHERE id = ${id} FOR UPDATE`;
      if (!a) throw notFound('银行账户不存在');
      if (a.version !== input.version) throw conflict('BANK_ACCOUNT_CHANGED', '这个账户刚被别人改过，请刷新后再改');
      await tx`
        UPDATE bank_accounts SET name = ${input.name}, bank_name = ${input.bankName}, account_tail = ${input.accountTail}, template = ${input.template},
               active = ${input.active}, version = version + 1
        WHERE id = ${id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'bank_account', targetType: 'bank_account', targetId: id, detail: { op: 'update', ...input }, ip });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'bank_accounts_name_key')) throw conflict('BANK_ACCOUNT_EXISTS', `已经有叫「${input.name}」的账户`);
    throw error;
  }
  return getAccount(deps.sql, id);
}

// ───────────────────────── 导入 ─────────────────────────

const DATE_HEADERS = ['交易日期', '记账日期', '交易时间', '入账日期', '日期', '交易日'];
const FileInput = z
  .object({
    accountId: z.number().int().positive('请选择账户'),
    fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
    csv: z.string().max(8_000_000, '文件太大').optional(),
    xlsxBase64: z.string().max(14_000_000, '文件太大').optional(),
    columnMap: z.partialRecord(z.enum(STATEMENT_FIELDS), z.string().max(60)).optional(),
  })
  .refine((v) => (v.csv === undefined) !== (v.xlsxBase64 === undefined), '请选一份 CSV 或 Excel 文件');

/** 表头里像表头的那一行：有日期列、又有金额类的列 */
const looksLikeHeader = (cells: string[]) => {
  const m = detectColumns(cells);
  return !!m.date && !!(m.in || m.out || m.amount);
};

function readStatement(f: z.infer<typeof FileInput>, saved: ColumnMap) {
  // 列怎么对：页面上传来的 → 这个账户记住的（表头都还在）→ 按同义词认；Excel 存成序号的日期按对上的那一列换
  const mapFor = (header: string[]): ColumnMap => {
    const savedFits = Object.keys(saved).length > 0 && Object.values(saved).every((h) => !h || header.includes(h));
    return f.columnMap ?? (savedFits ? saved : detectColumns(header));
  };
  const sheet = readSheet(
    { csv: f.csv, xlsxBase64: f.xlsxBase64 },
    { dateColumns: DATE_HEADERS, dateColumnsFor: (header) => [mapFor(header).date], findHeader: looksLikeHeader, headerScan: 30 },
  );
  const map = mapFor(sheet.header);
  const problem = columnMapProblem(map);
  const parsed = problem ? { lines: [], problems: [] } : parseStatementRows(sheet.header, sheet.rows.map((r) => ({ row: r.row, cells: r.cells })), map);
  return { sheet, map, problem, ...parsed };
}

async function previewImport(db: Db, raw: unknown): Promise<BankImportPreview> {
  const f = parse(FileInput, raw);
  const account = await getAccount(db, f.accountId);
  const r = readStatement(f, account.columnMap);
  const keys = r.lines.map((l) => l.dedupeKey);
  const [dup] = keys.length
    ? await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_statement_lines WHERE account_id = ${f.accountId} AND dedupe_key IN ${db(keys)}`
    : [{ n: 0 }];
  const [imp] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_imports WHERE account_id = ${f.accountId} AND file_sha256 = ${r.sheet.sha256}`;
  return { sha256: r.sheet.sha256, header: r.sheet.header, columnMap: r.map, problem: r.problem, lines: r.lines.slice(0, 200), problems: r.problems.slice(0, 50), duplicates: dup!.n, alreadyImported: imp!.n > 0 };
}

const ImportInput = FileInput.and(z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }));

async function importStatement(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const f = parse(ImportInput, raw);
  const account = await getAccount(deps.sql, f.accountId);
  const r = readStatement(f, account.columnMap);
  if (r.problem) throw unprocessable('BANK_COLUMNS', r.problem);
  if (r.lines.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有认得出的流水');
  // 列的对法按固定顺序进摘要（存进库的 jsonb 会改键的顺序）
  const requestHash = hashRequest({ accountId: f.accountId, sha256: r.sheet.sha256, map: STATEMENT_FIELDS.map((k) => r.map[k] ?? '') });
  const result = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertNotFenced(tx, f.clientKey, 'bank_import', erpOpAbandoned);
    const [existing] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM bank_imports WHERE client_key = ${f.clientKey}`;
    if (existing) {
      if (existing.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一份文件，请刷新页面后重新导入');
      return { importId: Number(existing.id), replayed: true };
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`bank_import:${f.accountId}:${r.sheet.sha256}`}, 0))`;
    const [dupFile] = await tx<{ id: number }[]>`SELECT id FROM bank_imports WHERE account_id = ${f.accountId} AND file_sha256 = ${r.sheet.sha256}`;
    if (dupFile) throw conflict('BANK_FILE_IMPORTED', '这份文件已经导入过了');
    const keys = r.lines.map((l) => l.dedupeKey);
    const known = new Set((await tx<{ dedupeKey: string }[]>`SELECT dedupe_key FROM bank_statement_lines WHERE account_id = ${f.accountId} AND dedupe_key IN ${tx(keys)}`).map((x) => x.dedupeKey));
    // 同一份文件里重复的也只记一次
    const fresh = r.lines.filter((l, i) => !known.has(l.dedupeKey) && keys.indexOf(l.dedupeKey) === i);
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO bank_imports (account_id, file_sha256, file_name, line_count, new_count, dup_count, client_key, request_hash, created_by)
      VALUES (${f.accountId}, ${r.sheet.sha256}, ${f.fileName}, ${r.lines.length}, ${fresh.length}, ${r.lines.length - fresh.length}, ${f.clientKey}, ${requestHash}, ${actor.id})
      RETURNING id`;
    const importId = Number(imp!.id);
    const ids: number[] = [];
    for (const l of fresh) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO bank_statement_lines (account_id, import_id, txn_date, direction, amount_cents, balance_cents, counterparty, counterparty_account, summary, bank_ref, dedupe_key)
        VALUES (${f.accountId}, ${importId}, ${l.txnDate}, ${l.direction}, ${l.amountCents}, ${l.balanceCents}, ${l.counterparty}, ${l.counterpartyAccount}, ${l.summary}, ${l.bankRef}, ${l.dedupeKey})
        RETURNING id`;
      ids.push(Number(row!.id));
    }
    // 记住这个账户的列怎么对（不算改账户，不加版本号）
    await tx`UPDATE bank_accounts SET column_map = ${tx.json(r.map as never)} WHERE id = ${f.accountId}`;
    const auto = await autoMatch(tx, ids, actor);
    await writeAudit(tx, { staffId: actor.id, action: 'bank_import', targetType: 'bank_import', targetId: importId, detail: { account: account.name, fileName: f.fileName, lines: r.lines.length, fresh: fresh.length, autoMatched: auto }, ip });
    return { importId, replayed: false };
  });
  // 自动对上的批量付款行：照「按申请登记付款」记账（事务外，各自的操作编号；记不了的留给人手工处理）。
  // 原样重提也跑一遍（Codex 审查 e64932b 后补）：上一次导入提交了、记账没做完就停了的接着记——只挑还没结论的行，各行用自己固定的付款编号，不会记两次
  const followUps = await recordBatchMatches(deps, deps.sql`l.import_id = ${result.importId} AND m.auto`, actor, ip);
  const [summary] = await deps.sql<{ lineCount: number; newCount: number; dupCount: number; autoMatched: number }[]>`
    SELECT i.line_count, i.new_count, i.dup_count,
           (SELECT count(DISTINCT m.line_id)::int FROM bank_matches m JOIN bank_statement_lines l ON l.id = m.line_id WHERE l.import_id = i.id AND m.auto AND m.status = 'active') AS auto_matched
    FROM bank_imports i WHERE i.id = ${result.importId}`;
  return { import: { id: result.importId, ...summary!, problems: r.problems.slice(0, 50), followUps }, replayed: result.replayed };
}

// ───────────────────────── 对象（系统里的付款、回款……） ─────────────────────────

/** 某几种对象的候选（没作废、没对过）；party 用来与对方户名比 */
/**
 * 一条流水能对的记录。`accountId`：流水所在的本公司账户——批量付款的一行只认从这个账户导出的批次
 * （别的账户的流水同户名、同金额也不对上，Codex 审查 26fe580 后补）；查已有的勾对时不给
 */
async function candidates(
  db: Db,
  types: MatchTargetType[],
  filter: { amountMax?: number; amountEq?: number; from: string; to: string; ids?: { type: MatchTargetType; id: number }[]; accountId?: number },
): Promise<MatchTarget[]> {
  const out: MatchTarget[] = [];
  const amt = (col: Fragment) => (filter.amountEq !== undefined ? db`${col} = ${filter.amountEq}` : filter.amountMax !== undefined ? db`${col} <= ${filter.amountMax}` : db`TRUE`);
  const idsOf = (t: MatchTargetType) => filter.ids?.filter((x) => x.type === t).map((x) => x.id);
  const notMatched = (t: MatchTargetType, col: Fragment) => db`NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.target_type = ${t} AND m.target_id = ${col} AND m.status = 'active')`;
  // 批量付款记账出来的付款：那一行已经对上流水了，付款本身不再算没对上
  const notViaBatch = (kind: 'payment' | 'payout', col: Fragment) => db`NOT EXISTS (
    SELECT 1 FROM payment_batch_items bi JOIN bank_matches bm ON bm.target_type = 'batch_item' AND bm.target_id = bi.id AND bm.status = 'active'
    WHERE bi.payment_kind = ${kind} AND bi.payment_id = ${col})`;
  for (const t of types) {
    const only = idsOf(t);
    if (filter.ids && !only?.length) continue;
    const pick = (col: Fragment) => (only ? db`${col} IN ${db(only)}` : db`TRUE`);
    let rows: { id: number; docNo: string; date: string; amountCents: string; party: string; voided: boolean }[] = [];
    if (t === 'payment') {
      rows = await db`
        SELECT p.id, p.doc_no, p.pay_date::text AS date, p.amount_cents::text AS amount_cents, s.name AS party, p.status = 'voided' AS voided
        FROM payments p JOIN suppliers s ON s.id = p.supplier_id
        WHERE ${only ? db`TRUE` : db`p.status = 'confirmed' AND p.method <> 'cash' AND p.pay_date BETWEEN ${filter.from} AND ${filter.to} AND ${notMatched(t, db`p.id`)} AND ${notViaBatch('payment', db`p.id`)}`}
          AND ${amt(db`p.amount_cents`)} AND ${pick(db`p.id`)}`;
    } else if (t === 'contract_payout') {
      rows = await db`
        SELECT o.id, o.doc_no, o.pay_date::text AS date, o.amount_cents::text AS amount_cents, coalesce(c.counterparty, r.payee) AS party, o.status = 'voided' AS voided
        FROM contract_payouts o JOIN payment_requests r ON r.id = o.payment_request_id LEFT JOIN contracts c ON c.id = r.contract_id
        WHERE ${only ? db`TRUE` : db`o.status = 'confirmed' AND o.method <> 'cash' AND o.pay_date BETWEEN ${filter.from} AND ${filter.to} AND ${notMatched(t, db`o.id`)} AND ${notViaBatch('payout', db`o.id`)}`}
          AND ${amt(db`o.amount_cents`)} AND ${pick(db`o.id`)}`;
    } else if (t === 'petty_advance') {
      rows = await db`
        SELECT a.id, a.doc_no, a.advance_date::text AS date, a.amount_cents::text AS amount_cents, s.display_name AS party, a.status = 'voided' AS voided
        FROM petty_advances a JOIN staff s ON s.id = a.handler_id
        WHERE ${only ? db`TRUE` : db`a.status = 'active' AND a.method <> 'cash' AND a.advance_date BETWEEN ${filter.from} AND ${filter.to} AND ${notMatched(t, db`a.id`)}`}
          AND ${amt(db`a.amount_cents`)} AND ${pick(db`a.id`)}`;
    } else if (t === 'petty_topup' || t === 'petty_return') {
      const kind = t === 'petty_topup' ? 'topup' : 'return';
      rows = await db`
        SELECT x.id, x.doc_no, x.settle_date::text AS date, x.amount_cents::text AS amount_cents, s.display_name AS party, x.status = 'voided' AS voided
        FROM petty_settlements x JOIN petty_advances a ON a.id = x.advance_id JOIN staff s ON s.id = a.handler_id
        WHERE x.kind = ${kind} AND ${only ? db`TRUE` : db`x.status = 'active' AND x.method <> 'cash' AND x.settle_date BETWEEN ${filter.from} AND ${filter.to} AND ${notMatched(t, db`x.id`)}`}
          AND ${amt(db`x.amount_cents`)} AND ${pick(db`x.id`)}`;
    } else if (t === 'ar_collection') {
      rows = await db`
        SELECT c.id, c.doc_no, c.collected_on::text AS date, c.amount_cents::text AS amount_cents, a.name AS party, c.voided_at IS NOT NULL AS voided
        FROM ar_collections c JOIN ar_accounts a ON a.id = c.account_id
        WHERE ${only ? db`TRUE` : db`c.voided_at IS NULL AND c.method <> 'cash' AND c.collected_on BETWEEN ${filter.from} AND ${filter.to} AND ${notMatched(t, db`c.id`)}`}
          AND ${amt(db`c.amount_cents`)} AND ${pick(db`c.id`)}`;
    } else if (t === 'platform_settlement') {
      rows = await db`
        SELECT p.id, p.settlement_no AS doc_no, p.received_on::text AS date, p.amount::text AS amount_cents,
               CASE p.platform WHEN 'meituan' THEN '美团' WHEN 'dianping' THEN '大众点评' WHEN 'douyin' THEN '抖音' ELSE '其他平台' END AS party,
               p.status = 'voided' AS voided
        FROM platform_settlements p
        WHERE ${only ? db`TRUE` : db`p.status = 'active' AND p.received_on BETWEEN ${filter.from} AND ${filter.to} AND ${notMatched(t, db`p.id`)}`}
          AND ${amt(db`p.amount`)} AND ${pick(db`p.id`)}`;
    } else if (t === 'batch_item') {
      // 批量付款的一行（第 5 节）：导出以后、还没有结论的；日期按导出的那天，与别的对象一样只在给的日期范围里找
      // （导一份早的对账单时，不会拿几个月前同户名同金额的一笔去对后来才导出的批次）
      rows = await db`
        SELECT i.id, b.batch_no || '-' || i.line_no AS doc_no, coalesce(b.exported_at, b.created_at)::date::text AS date, i.amount_cents::text AS amount_cents, i.payee_name AS party,
               -- 这一行记的付款后来冲销了，也算对象失效（与直接对上付款的一样标出来，Codex 审查 55ccc5e 后补）
               i.status IN ('removed', 'failed') OR b.status = 'voided'
                 OR (i.payment_kind = 'payment' AND EXISTS (SELECT 1 FROM payments p WHERE p.id = i.payment_id AND p.status = 'voided'))
                 OR (i.payment_kind = 'payout' AND EXISTS (SELECT 1 FROM contract_payouts o WHERE o.id = i.payment_id AND o.status = 'voided')) AS voided
        FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id
        WHERE ${only ? db`TRUE` : db`b.status = 'exported' AND i.status = 'pending' AND coalesce(b.exported_at, b.created_at)::date BETWEEN ${filter.from}::date AND ${filter.to}::date AND ${notMatched(t, db`i.id`)}`}
          AND ${filter.accountId !== undefined ? db`b.account_id = ${filter.accountId}` : db`TRUE`}
          AND ${amt(db`i.amount_cents`)} AND ${pick(db`i.id`)}`;
    }
    for (const r of rows) out.push({ type: t, id: Number(r.id), docNo: r.docNo, date: r.date, amountCents: Number(r.amountCents), party: r.party, voided: r.voided });
  }
  return out;
}

const normName = (s: string) => s.replace(/[\s()（）·.,，、]/g, '').toLowerCase();
/** 对方户名与对象的名称对得上：相等，或长一点的名称互相包含（网银常把户名截短） */
export function partyMatches(counterparty: string, party: string): boolean {
  const a = normName(counterparty);
  const b = normName(party);
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 4 && b.includes(a)) || (b.length >= 2 && a.includes(b));
}

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** 新导入的流水自动勾对：金额相等、日期前后 3 天、对方户名对得上、只有一个候选的 */
async function autoMatch(tx: Tx, lineIds: number[], actor: Actor): Promise<number> {
  let n = 0;
  const claimed = new Set<string>();
  for (const id of lineIds) {
    const [l] = await tx<{ accountId: number; txnDate: string; direction: 'in' | 'out'; amountCents: string; counterparty: string }[]>`
      SELECT account_id, txn_date::text AS txn_date, direction, amount_cents::text AS amount_cents, counterparty FROM bank_statement_lines WHERE id = ${id} FOR UPDATE`;
    if (!l || !l.counterparty) continue;
    const list = (
      await candidates(tx, l.direction === 'out' ? OUT_TARGETS : IN_TARGETS, { amountEq: Number(l.amountCents), from: shift(l.txnDate, -AUTO_DAYS), to: shift(l.txnDate, AUTO_DAYS), accountId: Number(l.accountId) })
    )
      .filter((c) => partyMatches(l.counterparty, c.party) && !claimed.has(`${c.type}:${c.id}`));
    if (list.length !== 1) continue;
    const c = list[0]!;
    if (!(await lockTarget(tx, c.type, c.id))) continue;
    await tx`INSERT INTO bank_matches (line_id, target_type, target_id, amount_cents, auto, created_by) VALUES (${id}, ${c.type}, ${c.id}, ${c.amountCents}, true, ${actor.id})`;
    await tx`UPDATE bank_statement_lines SET status = 'matched', version = version + 1 WHERE id = ${id}`;
    claimed.add(`${c.type}:${c.id}`);
    n += 1;
  }
  return n;
}

/** 锁住对象一行（共享键锁，与它的作废串行）；返回它还有效没有 */
async function lockTarget(tx: Tx, type: MatchTargetType, id: number): Promise<boolean> {
  const rows =
    type === 'payment'
      ? await tx<{ ok: boolean }[]>`SELECT status = 'confirmed' AS ok FROM payments WHERE id = ${id} FOR KEY SHARE`
      : type === 'contract_payout'
        ? await tx<{ ok: boolean }[]>`SELECT status = 'confirmed' AS ok FROM contract_payouts WHERE id = ${id} FOR KEY SHARE`
        : type === 'petty_advance'
          ? await tx<{ ok: boolean }[]>`SELECT status = 'active' AS ok FROM petty_advances WHERE id = ${id} FOR KEY SHARE`
          : type === 'petty_topup' || type === 'petty_return'
            ? await tx<{ ok: boolean }[]>`SELECT status = 'active' AND kind = ${type === 'petty_topup' ? 'topup' : 'return'} AS ok FROM petty_settlements WHERE id = ${id} FOR KEY SHARE`
            : type === 'ar_collection'
              ? await tx<{ ok: boolean }[]>`SELECT voided_at IS NULL AS ok FROM ar_collections WHERE id = ${id} FOR KEY SHARE`
              : type === 'platform_settlement'
                ? await tx<{ ok: boolean }[]>`SELECT status = 'active' AS ok FROM platform_settlements WHERE id = ${id} FOR KEY SHARE`
                : await tx<{ ok: boolean }[]>`SELECT i.status = 'pending' AND b.status = 'exported' AS ok FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id WHERE i.id = ${id} FOR KEY SHARE OF i`;
  return !!rows[0]?.ok;
}

// ───────────────────────── 读 ─────────────────────────

const ListQuery = z.object({
  status: z.enum(['open', 'matched', 'ignored', 'all']).default('open'),
  accountId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(60).default(''),
});

async function linesWhere(db: Db, where: Fragment, limit: number): Promise<BankLine[]> {
  const rows = await db<(Omit<BankLine, 'id' | 'accountId' | 'amountCents' | 'balanceCents' | 'matchedCents' | 'matches' | 'targetVoided'> & { id: number; accountId: number; amountCents: string; balanceCents: string | null })[]>`
    SELECT l.id, l.account_id, a.name AS account_name, l.txn_date::text AS txn_date, l.direction, l.amount_cents::text AS amount_cents,
           l.balance_cents::text AS balance_cents, l.counterparty, l.counterparty_account, l.summary, l.bank_ref, l.status, l.ignore_reason, l.version
    FROM bank_statement_lines l JOIN bank_accounts a ON a.id = l.account_id
    WHERE ${where}
    ORDER BY l.txn_date DESC, l.id DESC LIMIT ${limit}`;
  const ids = rows.map((r) => Number(r.id));
  const matches = ids.length
    ? await db<{ id: number; lineId: number; targetType: MatchTargetType; targetId: number; amountCents: string; auto: boolean; createdByName: string; createdAt: string }[]>`
        SELECT m.id, m.line_id, m.target_type, m.target_id, m.amount_cents::text AS amount_cents, m.auto, s.display_name AS created_by_name, m.created_at
        FROM bank_matches m JOIN staff s ON s.id = m.created_by
        WHERE m.line_id IN ${db(ids)} AND m.status = 'active' ORDER BY m.id`
    : [];
  const targets = matches.length ? await candidates(db, [...MATCH_TARGET_TYPES], { from: '1900-01-01', to: '2999-12-31', ids: matches.map((m) => ({ type: m.targetType, id: Number(m.targetId) })) }) : [];
  const tKey = (t: { type: string; id: number }) => `${t.type}:${t.id}`;
  const tMap = new Map(targets.map((t) => [tKey(t), t]));
  return rows.map((r) => {
    const ms: BankMatch[] = matches
      .filter((m) => Number(m.lineId) === Number(r.id))
      .map((m) => ({
        id: Number(m.id),
        target: tMap.get(`${m.targetType}:${Number(m.targetId)}`) ?? { type: m.targetType, id: Number(m.targetId), docNo: `#${m.targetId}`, date: '', amountCents: Number(m.amountCents), party: '', voided: true },
        amountCents: Number(m.amountCents),
        auto: m.auto,
        createdByName: m.createdByName,
        createdAt: new Date(m.createdAt).toISOString(),
      }));
    return {
      ...r,
      id: Number(r.id),
      accountId: Number(r.accountId),
      amountCents: Number(r.amountCents),
      balanceCents: r.balanceCents === null ? null : Number(r.balanceCents),
      matchedCents: ms.reduce((s, m) => s + m.amountCents, 0),
      matches: ms,
      targetVoided: ms.some((m) => m.target.voided),
    };
  });
}

async function getLine(db: Db, id: number): Promise<BankLine> {
  const [l] = await linesWhere(db, db`l.id = ${id}`, 1);
  if (!l) throw notFound('这条流水不存在');
  return l;
}

/** 待办（CW17）：超过 7 天没对上的流水；超过 7 天没对上流水的付款与回款（从有流水的那天起算，以前的不算） */
export async function bankTodo(db: Db, today: string): Promise<{ stale: number; unmatched: number }> {
  const cutoff = shift(today, -STALE_DAYS);
  const [s] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_statement_lines WHERE status = 'open' AND txn_date < ${cutoff}`;
  const [first] = await db<{ d: string | null }[]>`SELECT min(txn_date)::text AS d FROM bank_statement_lines`;
  if (!first!.d) return { stale: s!.n, unmatched: 0 };
  const list = await candidates(db, [...OUT_TARGETS.filter((t) => t !== 'batch_item'), ...IN_TARGETS], { from: first!.d, to: shift(cutoff, -1) });
  return { stale: s!.n, unmatched: list.length };
}

async function overview(db: Db, raw: unknown, today: string): Promise<BankOverview> {
  const q = parse(ListQuery, raw);
  const like = `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const where = db`
    (${q.status} = 'all' OR l.status = ${q.status})
    AND (${q.accountId ?? null}::bigint IS NULL OR l.account_id = ${q.accountId ?? null})
    AND (${q.q} = '' OR l.counterparty ILIKE ${like} OR l.summary ILIKE ${like} OR l.bank_ref ILIKE ${like} OR l.amount_cents::text = ${q.q.replace(/\D/g, '') || '-1'})`;
  const lines = await linesWhere(db, where, 501);
  const [open] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_statement_lines WHERE status = 'open'`;
  const todo = await bankTodo(db, today);
  return { accounts: await listAccounts(db), lines: lines.slice(0, 500), truncated: lines.length > 500, counts: { open: open!.n, stale: todo.stale, unmatchedPayments: todo.unmatched } };
}

// ───────────────────────── 勾对 ─────────────────────────

async function lineCandidates(db: Db, id: number): Promise<{ suggested: MatchTarget[]; others: MatchTarget[] }> {
  const l = await getLine(db, id);
  const remaining = l.amountCents - l.matchedCents;
  if (remaining <= 0 || l.status === 'ignored') return { suggested: [], others: [] };
  const list = await candidates(db, l.direction === 'out' ? OUT_TARGETS : IN_TARGETS, { amountMax: remaining, from: shift(l.txnDate, -30), to: shift(l.txnDate, 30), accountId: l.accountId });
  const score = (c: MatchTarget) => (c.amountCents === remaining ? 2 : 0) + (partyMatches(l.counterparty, c.party) ? 1 : 0);
  const sorted = list.sort((a, b) => score(b) - score(a) || Math.abs(Date.parse(a.date) - Date.parse(l.txnDate)) - Math.abs(Date.parse(b.date) - Date.parse(l.txnDate)));
  return { suggested: sorted.filter((c) => score(c) >= 2).slice(0, 20), others: sorted.filter((c) => score(c) < 2).slice(0, 80) };
}

const MatchInput = z.object({
  version: z.number().int().min(1),
  targets: z.array(z.object({ type: z.enum(MATCH_TARGET_TYPES), id: z.number().int().positive() })).min(1, '请选要对的记录').max(30),
});

async function matchLine(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<BankLine> {
  const input = parse(MatchInput, raw);
  if (new Set(input.targets.map((t) => `${t.type}:${t.id}`)).size !== input.targets.length) throw badRequest('同一笔选了两次');
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [l] = await tx<{ accountId: number; status: string; version: number; direction: 'in' | 'out'; amountCents: string }[]>`
        SELECT account_id, status, version, direction, amount_cents::text AS amount_cents FROM bank_statement_lines WHERE id = ${id} FOR UPDATE`;
      if (!l) throw notFound('这条流水不存在');
      if (l.version !== input.version) throw conflict('BANK_LINE_CHANGED', '这条流水刚被别人勾对过，请刷新后再看');
      if (l.status === 'ignored') throw conflict('BANK_LINE_IGNORED', '这条流水标了「不用对」，先取消');
      const allowed = l.direction === 'out' ? OUT_TARGETS : IN_TARGETS;
      if (input.targets.some((t) => !allowed.includes(t.type))) throw badRequest(l.direction === 'out' ? '付出的流水只能对付款类的记录' : '收入的流水只能对回款类的记录');
      const [done] = await tx<{ n: string }[]>`SELECT coalesce(sum(amount_cents), 0)::text AS n FROM bank_matches WHERE line_id = ${id} AND status = 'active'`;
      // 对象按种类、id 升序锁
      const sorted = [...input.targets].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id - b.id));
      let sum = 0;
      const picked: MatchTarget[] = [];
      for (const t of sorted) {
        if (!(await lockTarget(tx, t.type, t.id))) throw conflict('MATCH_TARGET_INVALID', `${MATCH_TARGET_LABELS[t.type]}（#${t.id}）已作废或状态不对，请刷新后重选`);
        const [taken] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_matches WHERE target_type = ${t.type} AND target_id = ${t.id} AND status = 'active'`;
        if (taken!.n > 0) throw conflict('MATCH_TARGET_TAKEN', `${MATCH_TARGET_LABELS[t.type]}（#${t.id}）已经对到别的流水上了，请刷新后重选`);
        const [c] = await candidates(tx, [t.type], { from: '1900-01-01', to: '2999-12-31', ids: [t], accountId: Number(l.accountId) });
        if (!c) {
          // 批量付款的一行只对从同一个账户导出的批次（Codex 审查 26fe580 后补）
          if (t.type === 'batch_item' && (await candidates(tx, [t.type], { from: '1900-01-01', to: '2999-12-31', ids: [t] })).length)
            throw unprocessable('MATCH_ACCOUNT_MISMATCH', '这一批是从另一个付款账户导出的，不能对这个账户的流水');
          throw notFound(`${MATCH_TARGET_LABELS[t.type]}（#${t.id}）不存在`);
        }
        sum += c.amountCents;
        picked.push(c);
      }
      if (Number(done!.n) + sum > Number(l.amountCents)) throw unprocessable('MATCH_OVER', '选的记录合计超过了这条流水的金额');
      for (const c of picked) {
        await tx`INSERT INTO bank_matches (line_id, target_type, target_id, amount_cents, created_by) VALUES (${id}, ${c.type}, ${c.id}, ${c.amountCents}, ${actor.id})`;
      }
      const settled = Number(done!.n) + sum === Number(l.amountCents);
      await tx`UPDATE bank_statement_lines SET status = ${settled ? 'matched' : 'open'}, version = version + 1 WHERE id = ${id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'bank_match', targetType: 'bank_line', targetId: id, detail: { op: 'match', targets: picked.map((c) => `${MATCH_TARGET_LABELS[c.type]} ${c.docNo}`), settled }, ip });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'bank_matches_target_uq')) throw conflict('MATCH_TARGET_TAKEN', '选的记录已经对到别的流水上了，请刷新后重选');
    throw error;
  }
  const followUps = await recordBatchMatches(deps, deps.sql`m.line_id = ${id}`, actor, ip);
  return { ...(await getLine(deps.sql, id)), followUps };
}

/** 对上流水的批量付款行：照「按申请登记付款」记账；返回记不了的（给页面提示） */
async function recordBatchMatches(deps: Deps, where: Fragment, actor: Actor, ip?: string): Promise<string[]> {
  const rows = await deps.sql<{ itemId: number; txnDate: string; bankRef: string }[]>`
    SELECT m.target_id AS item_id, l.txn_date::text AS txn_date, l.bank_ref
    FROM bank_matches m JOIN bank_statement_lines l ON l.id = m.line_id JOIN payment_batch_items i ON i.id = m.target_id
    WHERE m.target_type = 'batch_item' AND m.status = 'active' AND i.status = 'pending' AND ${where}`;
  const problems: string[] = [];
  for (const r of rows) {
    try {
      await recordItemPaid(deps, Number(r.itemId), { payDate: r.txnDate, bankRef: r.bankRef }, actor, ip);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

async function voidMatch(deps: Deps, matchId: number, raw: unknown, actor: Actor, ip?: string): Promise<BankLine> {
  const { reason } = parse(z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) }), raw);
  const [m] = await deps.sql<{ lineId: number }[]>`SELECT line_id FROM bank_matches WHERE id = ${matchId}`;
  if (!m) throw notFound('这条勾对不存在');
  const lineId = Number(m.lineId);
  await deps.sql.begin(async (tx) => {
    await tx`SELECT id FROM bank_statement_lines WHERE id = ${lineId} FOR UPDATE`;
    const [cur] = await tx<{ status: string; targetType: string; targetId: number }[]>`SELECT status, target_type, target_id FROM bank_matches WHERE id = ${matchId} FOR UPDATE`;
    if (cur!.status !== 'active') throw conflict('MATCH_VOIDED', '这条勾对已经撤销了');
    await tx`UPDATE bank_matches SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${matchId}`;
    await tx`UPDATE bank_statement_lines SET status = 'open', version = version + 1 WHERE id = ${lineId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'bank_match', targetType: 'bank_line', targetId: lineId, detail: { op: 'unmatch', target: `${cur!.targetType}#${cur!.targetId}`, reason }, ip });
  });
  return getLine(deps.sql, lineId);
}

async function setIgnored(deps: Deps, id: number, raw: unknown, ignore: boolean, actor: Actor, ip?: string): Promise<BankLine> {
  const input = parse(z.object({ version: z.number().int().min(1), reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200).optional() }), raw);
  if (ignore && !input.reason) throw badRequest('请填写为什么不用对（例如利息、手续费）');
  await deps.sql.begin(async (tx) => {
    const [l] = await tx<{ status: string; version: number }[]>`SELECT status, version FROM bank_statement_lines WHERE id = ${id} FOR UPDATE`;
    if (!l) throw notFound('这条流水不存在');
    if (l.version !== input.version) throw conflict('BANK_LINE_CHANGED', '这条流水刚被别人改过，请刷新后再看');
    if (ignore) {
      const [m] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_matches WHERE line_id = ${id} AND status = 'active'`;
      if (m!.n > 0) throw conflict('BANK_LINE_MATCHED', '这条流水已经勾对了，先撤销勾对');
      await tx`UPDATE bank_statement_lines SET status = 'ignored', ignore_reason = ${input.reason!}, version = version + 1 WHERE id = ${id}`;
    } else {
      if (l.status !== 'ignored') throw conflict('BANK_LINE_CHANGED', '这条流水没有标「不用对」');
      await tx`UPDATE bank_statement_lines SET status = 'open', ignore_reason = NULL, version = version + 1 WHERE id = ${id}`;
    }
    await writeAudit(tx, { staffId: actor.id, action: 'bank_match', targetType: 'bank_line', targetId: id, detail: { op: ignore ? 'ignore' : 'reopen', reason: input.reason ?? null }, ip });
  });
  return getLine(deps.sql, id);
}

export function registerBankRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const today = () => todayIn(deps.config.timezone);
  app.get('/api/erp/bank', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => overview(tx, req.query ?? {}, today())));
  app.get('/api/erp/bank/todo', { preHandler: READ }, async () => readSnapshot(sql, (tx) => bankTodo(tx, today())));
  app.post('/api/erp/bank/accounts', { preHandler: MANAGE }, async (req, reply) => {
    const a = await createAccount(deps, req.body, req.actor, req.ip);
    reply.code(201);
    return a;
  });
  app.put('/api/erp/bank/accounts/:id', { preHandler: MANAGE }, async (req) => updateAccount(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/bank/import/preview', { preHandler: MANAGE, bodyLimit: 15_000_000 }, async (req) => readSnapshot(sql, (tx) => previewImport(tx, req.body)));
  app.post('/api/erp/bank/import', { preHandler: MANAGE, bodyLimit: 15_000_000 }, async (req, reply) => {
    const r = await importStatement(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.get('/api/erp/bank/lines/:id', { preHandler: READ }, async (req) => getLine(sql, parse(idParam, req.params).id));
  app.get('/api/erp/bank/lines/:id/candidates', { preHandler: MANAGE }, async (req) => readSnapshot(sql, (tx) => lineCandidates(tx, parse(idParam, req.params).id)));
  app.post('/api/erp/bank/lines/:id/match', { preHandler: MANAGE }, async (req) => matchLine(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/bank/lines/:id/ignore', { preHandler: MANAGE }, async (req) => setIgnored(deps, parse(idParam, req.params).id, req.body, true, req.actor, req.ip));
  app.post('/api/erp/bank/lines/:id/reopen', { preHandler: MANAGE }, async (req) => setIgnored(deps, parse(idParam, req.params).id, req.body, false, req.actor, req.ip));
  app.post('/api/erp/bank/matches/:id/void', { preHandler: MANAGE }, async (req) => voidMatch(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
}
