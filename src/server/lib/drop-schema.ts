// 分批删掉一个模式（v0.7.30）：一句 DROP SCHEMA … CASCADE 要在一个事务里拿下模式里所有表、索引、类型、约束、触发器的锁
// （迁移好的库约 6500 把，表越多越多），快超出数据库默认的共享锁表（max_locks_per_transaction 64 × 连接数），
// 同一时刻别的连接要锁就报 out of shared memory（CI 上 demo-reset 与并行的集成测试撞上过）。
// 这里每批一个事务删表（锁随事务放掉），最后再删模式里剩下的函数、类型与序列（几把锁）。
// demo-reset 清库、集成测试清空测试库都用它。

/** 一批删多少张表：一张表连同索引、类型、约束、触发器平均二十来把锁，一批几百把 */
const BATCH = 25;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** 删掉模式 schema（不存在就什么都不做）。只给内部固定的模式名用（不是用户输入） */
export async function dropSchemaInBatches(sql: { unsafe: (query: string) => PromiseLike<unknown> }, schema: string): Promise<void> {
  const tables = (await sql.unsafe(`SELECT tablename FROM pg_tables WHERE schemaname = '${schema.replace(/'/g, "''")}' ORDER BY tablename`)) as { tablename: string }[];
  for (let i = 0; i < tables.length; i += BATCH) {
    const names = tables.slice(i, i + BATCH).map((t) => `${ident(schema)}.${ident(t.tablename)}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${names.join(', ')} CASCADE`);
  }
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
}
