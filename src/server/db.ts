import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** 既可传入连接池，也可传入事务。 */
export type Db = Sql | Tx;
/** 拼进查询里的一段条件（db`...` 不带 await） */
export type Fragment = postgres.PendingQuery<postgres.Row[]>;

export function createSql(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    // 结果列名转为驼峰；金额（bigint / sum 结果）转为 number；
    // 营业日 date 保持 "YYYY-MM-DD"；时间戳统一为 ISO 字符串，便于直接输出 JSON。
    transform: { column: { from: postgres.toCamel } },
    types: {
      bigint: { to: 20, from: [20, 1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      dateOnly: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
      timestamptz: {
        to: 1184,
        from: [1184],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
        parse: (x: string) => new Date(x).toISOString(),
      },
    },
  }) as unknown as Sql;
}

/**
 * 在同一个数据库快照里执行一组只读查询（REPEATABLE READ）。
 * 日结要分多条 SQL 汇总单据、流水与余额，必须读同一时刻的数据，否则营业中查询会出现假差异。
 */
export function readSnapshot<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin('isolation level repeatable read read only', fn) as Promise<T>;
}

/** PostgreSQL 唯一约束冲突 */
/** 外键约束失败（引用的行不存在） */
export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503';
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint_name?: string };
  return e?.code === '23505' && (!constraint || e.constraint_name === constraint);
}
