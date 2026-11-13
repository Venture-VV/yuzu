// 企业微信每周一推（8.0.7 A4，docs/ERP_V807.md 第 4 节，V19、V20，迁移 104）。
//   · 每分钟的自动任务：周一 9:00（门店时区）以后、「门店基本规则 → 可调的数值」的开关打开、服务器 .env 配了 ERP_WECOM_WEBHOOK 时，
//     把本周应付、待审批、快到期的（质保金、合同、证照、批次）、逾期应收推到企业微信群机器人；只看开着的 ERP 模块。
//     同一周只推一次：先认领（周一日期的部分唯一索引兜底，几个进程同时跑也只有一个认领到、写 2 分钟的租约），事务外发送，再记结果；
//     发不出去的隔 5 分钟再试，最多 3 次；进程在发送中断了的，租约过期以后记失败、照样隔 5 分钟再试（宁可重发，不漏发）。
//     周一整天没跑（应用停着）的那一周不补推。
//   · 「发一条试试」：经营规则页上的按钮，马上推一条（内容与每周一推的一样，标题写「试发」），每次一行记录。
//   · 只读业务数据，不加锁（与 ERP 导航上的数字一样）；推送记录只锁自己那一行。
//   · 机器人地址是密钥：只从 config 读，不进库、不写日志、出错原因里不带地址。

import type { FastifyInstance } from 'fastify';
import { INSTANCE_LABELS } from '@shared/instance';
import { formatYuan } from '@shared/money';
import { WECOM_MAX_ATTEMPTS, WECOM_WEEKLY_AT, type WecomPushView, type WecomStatus, type WecomTestResult } from '@shared/wecom';
import type { AppConfig } from '../config';
import { readSnapshot, type Db, type Sql } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { clockIn, dateIn } from '../lib/dates';
import { conflict, unprocessable } from '../lib/errors';
import { expiringContracts } from './contracts/ledger';
import { enabledErpModules } from './erp';
import { supplyTodo } from './inventory/expiry';
import { warrantyLedger, weeklyPayables } from './payments/ledger';
import { arTodo } from './receivables';
import { loadSettings } from './settings';

/** 一条最多等多久 */
const SEND_TIMEOUT_MS = 10_000;
/** 认领后这一次最多发多久（之后算中断） */
const LEASE_SECONDS = 120;
/** 发不出去隔几分钟再试 */
const RETRY_MINUTES = 5;
/** 企业微信 markdown 消息最长 4096 字节 */
const MAX_BYTES = 4096;

/** 周推的正文（不含标题）：只看开着的 ERP 模块；数字与 ERP 导航、各页面上的一样 */
export async function weeklyDigestLines(db: Db, today: string): Promise<string[]> {
  const on = await enabledErpModules(db);
  const s = await loadSettings(db);
  const lines: string[] = [];

  if (on.has('payments')) {
    const w = await weeklyPayables(db, today);
    const wk = w.weeks[0]!;
    const [a] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_requests WHERE status = 'approved'`;
    const parts = [wk.items.length ? `${formatYuan(wk.totalCents)}（${wk.items.length} 笔，含期望付款日已过的与可付还没申请的）` : '没有'];
    if (a!.n > 0) parts.push(`批了待付款的申请 ${a!.n} 张`);
    lines.push(`**本周应付**：${parts.join('；')}`);
  }

  if (on.has('approvals')) {
    const [r] = await db<{ n: number; overdue: number }[]>`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE level_started_at < now() - make_interval(hours => ${s.approvalOverdueHours}))::int AS overdue
      FROM approval_requests WHERE status = 'pending'`;
    lines.push(`**待审批**：${r!.n ? `${r!.n} 张${r!.overdue ? `（超过 ${s.approvalOverdueHours} 小时没审的 ${r!.overdue} 张）` : ''}` : '没有'}`);
  }

  const due: string[] = [];
  if (on.has('payments')) {
    const n = (await warrantyLedger(db, today, 'due')).length;
    if (n) due.push(`质保金 ${n} 笔`);
  }
  if (on.has('contracts')) {
    const list = await expiringContracts(db, today);
    const past = list.filter((c) => c.daysLeft < 0).length;
    if (list.length) due.push(`合同 ${list.length} 份${past ? `（已过结束日的 ${past} 份）` : ''}`);
  }
  if (on.has('inventory')) {
    const t = await supplyTodo(db, today);
    if (t.licensesDue) due.push(`供应商证照 ${t.licensesDue} 张${t.licensesExpired ? `（已过期的 ${t.licensesExpired} 张）` : ''}`);
    if (t.expiringLots || t.expiredLots) due.push(`批次 ${t.expiringLots + t.expiredLots} 个${t.expiredLots ? `（已过期的 ${t.expiredLots} 个）` : ''}`);
  }
  if (on.has('payments') || on.has('contracts') || on.has('inventory')) lines.push(`**快到期**：${due.length ? due.join('；') : '没有'}`);

  if (on.has('receivables')) {
    const t = await arTodo(db, today);
    const parts: string[] = [];
    if (t.overdueCharges) parts.push(`协议单位挂账 ${t.overdueCharges} 笔 ${formatYuan(t.overdueCents)}`);
    if (t.platformOverdueCents) parts.push(`团购平台 ${formatYuan(t.platformOverdueCents)}`);
    lines.push(`**逾期应收**（超过 ${s.arOverdueDays} 天没回）：${parts.length ? parts.join('；') : '没有'}`);
  }
  return lines;
}

/** 整条消息（markdown）：标题、正文、落款；超过 4096 字节的截断 */
export async function buildWeeklyMessage(db: Db, config: Pick<AppConfig, 'timezone' | 'instance'>, now: Date, test = false): Promise<string> {
  const today = dateIn(now, config.timezone);
  const lines = await weeklyDigestLines(db, today);
  const title = `**浴族 ERP ${test ? '推送试发' : '每周提醒'}** · ${today} · ${INSTANCE_LABELS[config.instance]}`;
  const body = lines.length ? lines.map((l) => `> ${l}`).join('\n') : '> ERP 里没有开着的相关模块（付款、审批、合同、库存、应收）';
  const foot = test
    ? `收到这条说明机器人地址配好了；每周一 ${WECOM_WEEKLY_AT} 以后（开关打开时）推一次，内容同上。`
    : `数字是 ${clockIn(config.timezone, now)} 的，详情到 ERP 里看。`;
  return truncateBytes(`${title}\n${body}\n${foot}`, MAX_BYTES);
}

function truncateBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let s = buf.subarray(0, max - 6).toString('utf8');
  if (s.endsWith('�')) s = s.slice(0, -1);
  return `${s}…`;
}

/** 发一条 markdown 消息；失败抛错（原因里不带地址） */
export async function postWecom(url: string, content: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const e = error as { name?: string; cause?: { code?: string } };
    const why = e?.name === 'TimeoutError' ? `${SEND_TIMEOUT_MS / 1000} 秒没回` : (e?.cause?.code ?? e?.name ?? '网络出错');
    throw new Error(`企业微信连不上（${why}）`);
  }
  const body = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
  if (!res.ok || body?.errcode !== 0) {
    throw new Error(`企业微信没收：${body?.errcode ?? `HTTP ${res.status}`} ${body?.errmsg ?? ''}`.trim().slice(0, 250));
  }
}

type Send = (url: string, content: string) => Promise<void>;

/** 发送中断的（租约过了还在「发送中」）记失败，下一次照常隔 5 分钟再试 */
async function failStale(sql: Sql) {
  await sql`
    UPDATE wecom_pushes SET status = 'failed', error = coalesce(error, '发送中断（应用重启或超时）'), finished_at = now(), claimed_until = NULL
    WHERE status = 'sending' AND claimed_until < now()`;
}

async function finish(sql: Sql, id: number, content: string, error: string | null) {
  await sql`
    UPDATE wecom_pushes SET status = ${error ? 'failed' : 'sent'}, content = ${content}, error = ${error}, finished_at = now(), claimed_until = NULL
    WHERE id = ${id}`;
}

/**
 * 每分钟的自动任务调用：周一 9:00 以后推这一周的（已经推过、开关关着、没配地址的什么都不做）。
 * 返回这一次的结果；没轮到推时返回 null。
 */
export async function runWecomWeekly(
  deps: { sql: Sql; config: AppConfig },
  now: Date = new Date(),
  opts: { send?: Send } = {},
): Promise<{ id: number; ok: boolean; error: string | null } | null> {
  const { sql, config } = deps;
  const url = config.wecom.webhook;
  if (!url) return null;
  const monday = dateIn(now, config.timezone);
  if (new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1 || clockIn(config.timezone, now) < WECOM_WEEKLY_AT) return null;
  const { wecomWeeklyPush } = await loadSettings(sql);
  if (!wecomWeeklyPush) return null;
  const [prev] = await sql<{ status: string }[]>`SELECT status FROM wecom_pushes WHERE kind = 'weekly' AND period_key = ${monday}`;
  if (prev?.status === 'sent') return null;
  await failStale(sql);
  // 认领：这一周还没有记录就新建；上次没发出去（隔了 5 分钟、还没试满 3 次）的再认领一次；已发出、正在发的不认领
  const [claim] = await sql<{ id: number }[]>`
    INSERT INTO wecom_pushes (kind, period_key, status, attempts, claimed_until)
    VALUES ('weekly', ${monday}, 'sending', 1, now() + ${LEASE_SECONDS} * interval '1 second')
    ON CONFLICT (period_key) WHERE kind = 'weekly' DO UPDATE
      SET status = 'sending', attempts = wecom_pushes.attempts + 1, claimed_until = EXCLUDED.claimed_until, error = NULL, finished_at = NULL
      WHERE wecom_pushes.status = 'failed' AND wecom_pushes.attempts < ${WECOM_MAX_ATTEMPTS}
        AND wecom_pushes.finished_at < now() - ${RETRY_MINUTES} * interval '1 minute'
    RETURNING id`;
  if (!claim) return null;
  const id = Number(claim.id);
  let content = '';
  let error: string | null = null;
  try {
    content = await readSnapshot(sql, (tx) => buildWeeklyMessage(tx, config, now));
    await (opts.send ?? postWecom)(url, content);
  } catch (e) {
    error = content ? (e instanceof Error ? e.message : String(e)).slice(0, 250) : `内容没生成出来：${e instanceof Error ? e.message : String(e)}`.slice(0, 250);
  }
  await finish(sql, id, content, error);
  return { id, ok: !error, error };
}

const PUSH_COLUMNS = (db: Db) => db`
  p.id, p.kind, p.period_key::text AS period_key, p.status, p.content, p.error, p.attempts,
  p.created_at, p.finished_at, st.display_name AS created_by_name`;

function toView(r: Record<string, unknown>): WecomPushView {
  return {
    id: Number(r.id),
    kind: r.kind as WecomPushView['kind'],
    periodKey: (r.periodKey as string | null) ?? null,
    status: r.status as WecomPushView['status'],
    content: String(r.content ?? ''),
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts),
    createdAt: new Date(r.createdAt as string).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt as string).toISOString() : null,
    createdByName: (r.createdByName as string | null) ?? null,
  };
}

export async function wecomStatus(db: Db, config: AppConfig): Promise<WecomStatus> {
  const { wecomWeeklyPush } = await loadSettings(db);
  const rows = await db<Record<string, unknown>[]>`
    SELECT ${PUSH_COLUMNS(db)} FROM wecom_pushes p LEFT JOIN staff st ON st.id = p.created_by ORDER BY p.id DESC LIMIT 6`;
  return { configured: !!config.wecom.webhook, invalid: config.wecom.invalid, enabled: wecomWeeklyPush, recent: rows.map(toView) };
}

/** 「发一条试试」：马上推一条（不看开关、不看周几）；10 秒内只能试一次 */
export async function sendWecomTest(deps: Deps, actor: { id: number }, ip: string | undefined, opts: { send?: Send; now?: Date } = {}): Promise<WecomTestResult> {
  const { sql, config } = deps;
  const url = config.wecom.webhook;
  if (!url) {
    throw unprocessable(
      'WECOM_NOT_CONFIGURED',
      config.wecom.invalid
        ? '服务器 .env 里的 ERP_WECOM_WEBHOOK 格式不对：要企业微信群机器人的 https 地址（群设置 → 群机器人 → 复制 Webhook 地址），改好以后重启应用'
        : '服务器 .env 里没配 ERP_WECOM_WEBHOOK（企业微信群机器人的地址），配好以后重启应用再试',
    );
  }
  await failStale(sql);
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO wecom_pushes (kind, status, created_by, claimed_until)
    SELECT 'test', 'sending', ${actor.id}, now() + ${LEASE_SECONDS} * interval '1 second'
    WHERE NOT EXISTS (SELECT 1 FROM wecom_pushes WHERE kind = 'test' AND created_at > now() - interval '10 seconds')
    RETURNING id`;
  if (!row) throw conflict('WECOM_TOO_FAST', '刚试过一条，10 秒以后再试');
  const id = Number(row.id);
  let content = '';
  let error: string | null = null;
  try {
    content = await readSnapshot(sql, (tx) => buildWeeklyMessage(tx, config, opts.now ?? new Date(), true));
    await (opts.send ?? postWecom)(url, content);
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 250);
  }
  await finish(sql, id, content, error);
  await writeAudit(sql, { staffId: actor.id, action: 'wecom_push', targetType: 'wecom_push', targetId: id, detail: { kind: 'test', ok: !error, error }, ip });
  const [view] = await sql<Record<string, unknown>[]>`
    SELECT ${PUSH_COLUMNS(sql)} FROM wecom_pushes p LEFT JOIN staff st ON st.id = p.created_by WHERE p.id = ${id}`;
  return { ok: !error, error, push: toView(view!) };
}

export function registerWecomRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  app.get('/api/settings/wecom', { preHandler: guard('settings.manage') }, async () => wecomStatus(sql, config));
  app.post('/api/settings/wecom/test', { preHandler: guard('settings.manage') }, async (req) => sendWecomTest(deps, req.actor, req.ip));
}
