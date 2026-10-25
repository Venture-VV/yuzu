import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** 既可传入连接池，也可传入事务。 */
export type Db = Sql | Tx;

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

/** PostgreSQL 唯一约束冲突 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint_name?: string };
  return e?.code === '23505' && (!constraint || e.constraint_name === constraint);
}
