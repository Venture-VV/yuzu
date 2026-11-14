// 「确认作废」的业务类型：代码里登记的每一种（lib/fences 的 FENCED_OPS）都要过得了 op_fences 的类型约束。
// 以前每加一种就在迁移里用固定名单重建约束（…110、111）；客户部的迁移（162）是在当时的约束上追加的。
// 以后的迁移要是照着某一份旧名单重建、漏了别的迁移加进来的类型，那一类的「确认作废」会被数据库拒绝（422），
// 原请求晚到时就拦不住了——这条用例在所有迁移都跑完的库上逐个核对，漏了哪一种直接指出来。
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FENCED_OPS } from '../src/server/lib/fences';
import { setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx?.close());

it('代码里登记的作废类型，数据库的约束都认', async () => {
  const [row] = await ctx.sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check'`;
  expect(row, 'op_fences_op_type_check 不存在').toBeTruthy();
  const missing = FENCED_OPS.filter((t) => !row!.def.includes(`'${t}'`));
  expect(missing, '这些类型代码里登记了、约束里没有（新迁移重建约束时在原来的基础上追加，不要用旧名单覆盖）').toEqual([]);
});
