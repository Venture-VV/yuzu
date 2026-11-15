import postgres from 'postgres';
import { currentStoreId, DEFAULT_STORE_ID } from './lib/store-context';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** 既可传入连接池，也可传入事务。 */
export type Db = Sql | Tx;
/** 拼进查询里的一段条件（db`...` 不带 await） */
export type Fragment = postgres.PendingQuery<postgres.Row[]>;

export function createSql(databaseUrl: string, options: { max?: number } = {}): Sql {
  return withStoreContext(postgres(databaseUrl, {
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
  }) as unknown as Sql);
}

/**
 * 每个事务（含只读快照）开头记上当前门店（8.0.22，docs/MULTISTORE_V8022.md 第 3 节）：当前门店不是本店时
 * set_config('yuzu.store', 门店编号, true)，业务表 store_id 的默认值取它；本店什么都不做（与以往完全一样）。
 */
function withStoreContext(sql: Sql): Sql {
  const begin = sql.begin.bind(sql) as unknown as (...args: unknown[]) => Promise<unknown>;
  (sql as unknown as { begin: unknown }).begin = (...args: unknown[]) => {
    const storeId = currentStoreId();
    if (storeId === DEFAULT_STORE_ID) return begin(...args);
    const fn = args[args.length - 1] as (tx: Tx) => unknown;
    const scoped = async (tx: Tx) => {
      await tx`SELECT set_config('yuzu.store', ${String(storeId)}, true)`;
      const result = await fn(tx);
      return Array.isArray(result) ? Promise.all(result) : result;
    };
    return begin(...args.slice(0, -1), scoped);
  };
  return sql;
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
