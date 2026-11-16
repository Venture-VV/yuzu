// 某时刻之后写进系统的（只读，8.1.0）：回退时恢复升级前的备份之前先看清楚丢的是什么（scripts/rollback.sh；
// 测试会话在 PR #113 be1de5a、3b58876 报的 P1）。恢复会把这些从系统里拿掉——回退前的备份里都留着，要按纸质单补录。
// 「之后」从升级前那份备份的时刻算起（备份说明里的 createdAt，是开始备份的时刻，宁多不少）。
//
// 清单只是帮人核对，不是闸门：rollback.sh 恢复旧快照之前一律当面确认（3b58876 复验：员工端饭堂反馈这类不写审计、
// 原来又不在固定的几张表里的写入，数出来是 0，脚本就跳过了确认）。所以这里不再只数固定的几张表，而是数库里
// 每一张有「写入时刻」列的表（created_at；没有就用第一个默认值是 now() 的时间列；再没有就用第一个必填、名字不像
// 到期 / 截止的时间列，如来访的 checked_in_at、次卡的 sold_at），有 updated_at 的再数改过的行；
// 没有时间列、数不到的表列出张数，提醒「数不到不等于没有」。
import type { Sql } from '../db';
import { balanceChanges } from './balance-changes';

/** 只是登录、登出，不算业务写入 */
const SESSION_ACTIONS = new Set(['login', 'login_failed', 'logout', 'auth_failed']);
/** 登录会话的表：不算业务写入 */
const SESSION_TABLES = new Set(['sessions', 'canteen_sessions']);
/** 不数的表：迁移记录；审计单独按动作数 */
const SKIP_TABLES = new Set(['schema_migrations', 'audit_logs']);
/** 常用几张表的叫法（其余的直接写表名） */
const LABELS: Record<string, string> = {
  visits: '接待（来访）',
  checkouts: '结账单',
  recharges: '充值',
  consumptions: '储值消费',
  inv_docs: '库存单据',
  canteen_feedback: '员工食堂的反馈',
};

export interface ChangesSince {
  /** 审计里的业务动作（不含登录、登出），多的在前 */
  audit: { action: string; n: number }[];
  /** 登录、登出与登录会话（只显示，不算进合计） */
  sessions: number;
  /** 有写入的表：新增的行、改过的行（有 updated_at 的表才数） */
  tables: { table: string; label: string; inserted: number; updated: number }[];
  /** 数过的表有几张；没有时间列、数不到的表有几张 */
  scanned: number;
  unscanned: number;
  /** 余额有变动的会员数（含被冲回的） */
  members: number;
  /** 业务动作与各表新增、改过的行的合计：0 只说明数得到的地方没有写入 */
  total: number;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** 名字像到期、截止、计划的时间列不当写入时刻（值可能在将来，会被误数成新写入） */
const NOT_INSERT_TIME = /expire|until|due|deadline|ends?_at|scheduled|valid|last_at|closed_at|left_at|ended_at|voided_at|resolved_at|reviewed_at/;

export async function changesSince(sql: Sql, since: Date): Promise<ChangesSince> {
  const result = await sql.begin('isolation level repeatable read read only', async (tx) => {
    const rows = await tx<{ action: string; n: number }[]>`
      SELECT action, count(*)::int AS n FROM audit_logs WHERE created_at >= ${since} GROUP BY action ORDER BY n DESC, action`;
    const cols = await tx<{ tbl: string; col: string; isNow: boolean; required: boolean }[]>`
      SELECT c.table_name AS tbl, c.column_name AS col, c.is_nullable = 'NO' AS required,
             coalesce(c.column_default ILIKE '%now()%' OR c.column_default ILIKE '%current_timestamp%', false) AS is_now
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.data_type = 'timestamp with time zone'
      ORDER BY c.table_name, c.ordinal_position`;
    const [all] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
    // 每张表挑写入时刻：created_at > 默认值是 now() 的 > 必填、名字不像到期截止的；有 updated_at 的另数改过的行
    const byTable = new Map<string, { insert?: string; rank?: number; update?: string }>();
    for (const c of cols) {
      if (SKIP_TABLES.has(c.tbl)) continue;
      const t = byTable.get(c.tbl) ?? {};
      if (c.col === 'updated_at') t.update = c.col;
      else {
        const rank = c.col === 'created_at' ? 0 : c.isNow ? 1 : c.required && !NOT_INSERT_TIME.test(c.col) ? 2 : null;
        if (rank !== null && (t.rank === undefined || rank < t.rank)) {
          t.insert = c.col;
          t.rank = rank;
        }
      }
      byTable.set(c.tbl, t);
    }
    const tables: ChangesSince['tables'] = [];
    let sessions = 0;
    let scanned = 0;
    for (const [table, t] of [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!t.insert && !t.update) continue;
      scanned += 1;
      const [ins] = t.insert ? await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${ident(t.insert)} >= $1`, [since]) : [{ n: 0 }];
      const [upd] = t.update
        ? await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${ident(t.update)} >= $1${t.insert ? ` AND ${ident(t.insert)} < $1` : ''}`, [since])
        : [{ n: 0 }];
      const inserted = Number(ins?.n ?? 0);
      const updated = Number(upd?.n ?? 0);
      if (!inserted && !updated) continue;
      if (SESSION_TABLES.has(table)) {
        sessions += inserted + updated;
        continue;
      }
      tables.push({ table, label: LABELS[table] ?? table, inserted, updated });
    }
    // 没有任何时间列的表（数不到），加上审计、迁移记录两张不按表数的
    const unscanned = Math.max(0, Number(all?.n ?? 0) - scanned - SKIP_TABLES.size);
    return { rows, tables, sessions, scanned, unscanned };
  });
  const audit = result.rows.filter((r) => !SESSION_ACTIONS.has(r.action)).map((r) => ({ action: r.action, n: Number(r.n) }));
  const sessions = result.sessions + result.rows.filter((r) => SESSION_ACTIONS.has(r.action)).reduce((s, r) => s + Number(r.n), 0);
  const members = (await balanceChanges(sql, since, true)).length;
  const total = audit.reduce((s, r) => s + r.n, 0) + result.tables.reduce((s, t) => s + t.inserted + t.updated, 0);
  return { audit, sessions, tables: result.tables, scanned: result.scanned, unscanned: result.unscanned, members, total };
}

/** 打在终端上的几行；最后一行 CHANGES=<合计> 给脚本读 */
export function changesSinceLines(c: ChangesSince, sinceText: string): string[] {
  const lines = [`${sinceText} 之后写进系统的（数了 ${c.scanned} 张有时间列的表与审计）：`];
  if (c.tables.length) {
    for (const t of c.tables.slice(0, 40)) lines.push(`· ${t.label}：新增 ${t.inserted} 行${t.updated ? `、改过 ${t.updated} 行` : ''}`);
    if (c.tables.length > 40) lines.push(`· …… 另有 ${c.tables.length - 40} 张表有写入`);
  } else {
    lines.push('· 数得到的表里没有新增、改过的行');
  }
  lines.push(`· 余额有变动的会员 ${c.members} 位`);
  lines.push(
    c.audit.length
      ? `· 审计记录的业务动作 ${c.audit.reduce((s, r) => s + r.n, 0)} 条：${c.audit
          .slice(0, 20)
          .map((r) => `${r.action} ${r.n}`)
          .join('、')}${c.audit.length > 20 ? ' ……' : ''}`
      : '· 审计记录里没有业务动作',
  );
  if (c.sessions) lines.push(`· 另有登录、登出 ${c.sessions} 条（不算业务写入）`);
  if (c.unscanned) lines.push(`· 另有 ${c.unscanned} 张表没有时间列、数不到：数不到不等于没有写入`);
  lines.push(`CHANGES=${c.total}`);
  return lines;
}
