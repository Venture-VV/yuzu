// 某时刻之后写进系统的（只读，8.1.0）：回退时恢复升级前的备份之前先看清楚丢的是什么（scripts/rollback.sh；
// 测试会话在 PR #113 be1de5a 报的 P1）。恢复会把这些从系统里拿掉——回退前的备份里都留着，要按纸质单补录。
// 「之后」从升级前那份备份的时刻算起（备份说明里的 createdAt，是开始备份的时刻，宁多不少）。
import type { Sql } from '../db';
import { balanceChanges } from './balance-changes';

/** 只是登录、登出，不算业务写入 */
const SESSION_ACTIONS = new Set(['login', 'login_failed', 'logout', 'auth_failed']);

/** 逐张数一数的业务表：表名、时间列、怎么叫 */
const TABLES = [
  ['visits', 'checked_in_at', '接待（来访）'],
  ['checkouts', 'created_at', '结账单'],
  ['recharges', 'created_at', '充值'],
  ['consumptions', 'created_at', '储值消费'],
  ['inv_docs', 'created_at', '库存单据'],
] as const;

export interface ChangesSince {
  /** 审计里的业务动作（不含登录、登出），多的在前 */
  audit: { action: string; n: number }[];
  /** 登录、登出的条数（只显示，不算进合计） */
  sessions: number;
  tables: { table: string; label: string; n: number }[];
  /** 余额有变动的会员数（含被冲回的） */
  members: number;
  /** 业务动作与各表的合计：0 = 这段时间没有业务写入 */
  total: number;
}

export async function changesSince(sql: Sql, since: Date): Promise<ChangesSince> {
  const result = await sql.begin('isolation level repeatable read read only', async (tx) => {
    const rows = await tx<{ action: string; n: number }[]>`
      SELECT action, count(*)::int AS n FROM audit_logs WHERE created_at >= ${since} GROUP BY action ORDER BY n DESC, action`;
    const tables: ChangesSince['tables'] = [];
    for (const [table, column, label] of TABLES) {
      const [r] = await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} >= $1`, [since]);
      tables.push({ table, label, n: Number(r?.n ?? 0) });
    }
    return { rows, tables };
  });
  const audit = result.rows.filter((r) => !SESSION_ACTIONS.has(r.action)).map((r) => ({ action: r.action, n: Number(r.n) }));
  const sessions = result.rows.filter((r) => SESSION_ACTIONS.has(r.action)).reduce((s, r) => s + Number(r.n), 0);
  const members = (await balanceChanges(sql, since, true)).length;
  const total = audit.reduce((s, r) => s + r.n, 0) + result.tables.reduce((s, t) => s + t.n, 0);
  return { audit, sessions, tables: result.tables, members, total };
}

/** 打在终端上的几行；最后一行 CHANGES=<合计> 给脚本读 */
export function changesSinceLines(c: ChangesSince, sinceText: string): string[] {
  const lines = [`${sinceText} 之后写进系统的：`];
  lines.push(`· ${c.tables.map((t) => `${t.label} ${t.n}`).join('、')}`);
  lines.push(`· 余额有变动的会员 ${c.members} 位`);
  lines.push(c.audit.length ? `· 审计记录的业务动作 ${c.audit.reduce((s, r) => s + r.n, 0)} 条：${c.audit.slice(0, 20).map((r) => `${r.action} ${r.n}`).join('、')}${c.audit.length > 20 ? ' ……' : ''}` : '· 审计记录里没有业务动作');
  if (c.sessions) lines.push(`· 另有登录、登出 ${c.sessions} 条（不算业务写入）`);
  lines.push(`CHANGES=${c.total}`);
  return lines;
}
