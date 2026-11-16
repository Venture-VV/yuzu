// 代码整洁检查（8.1.3，scripts/check-code.mjs）：三条规则各自认得出该认的、放得过该放的；小程序线的文件不查
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { floatingQueries, inlineTypeImports, unusedFindings } from '../scripts/check-code.mjs';

describe('事务里没等结果的查询', () => {
  it('单独一句 tx`…`、tx.unsafe(…)、void tx`…` 都认出来；await、return、赋值、交给 Promise.all 的放过', () => {
    const code = `
      async function run(sql) {
        await sql.begin(async (tx) => {
          tx\`UPDATE a SET b = 1\`;
          void tx\`UPDATE a SET b = 2\`;
          tx.unsafe('SET LOCAL lock_timeout = 1');
          await tx\`UPDATE a SET b = 3\`;
          const rows = await tx\`SELECT 1\`;
          await Promise.all([tx\`SELECT 2\`, tx\`SELECT 3\`]);
          return tx\`SELECT 4\`;
        });
      }`;
    const found = floatingQueries('x.ts', code) as { line: number; text: string }[];
    expect(found.map((f) => f.text)).toEqual(['tx`…`', 'void tx`…`', 'tx.unsafe(…)']);
    expect(found.map((f) => f.line)).toEqual([4, 5, 6]);
  });
});

describe('只用到类型的导入', () => {
  it('import { type A, type B } 认出来（跨几行的也算）；import type、混着值的导入放过', () => {
    const code = ["import { type A, type B } from './x';", "import type { C } from './y';", "import { d, type E } from './z';", "import { type F } from '@shared/f';", 'import {', '  type G,', '  type H,', "} from './g';"].join('\n');
    expect((inlineTypeImports(code) as { line: number }[]).map((f) => f.line)).toEqual([1, 4, 5]);
  });
});

describe('没用到的导入、变量、参数', () => {
  it('只留主线的；小程序线自己的目录、用例不算', () => {
    const out = [
      "src/client/a.tsx(1,10): error TS6133: 'x' is declared but its value is never read.",
      "src/server/modules/mp/coupon-center.ts(51,9): error TS6133: 'boundMember' is declared but its value is never read.",
      "tests/mp-member.test.ts(162,11): error TS6133: 'memberId' is declared but its value is never read.",
      "src/server/b.ts(3,1): error TS6192: All imports in import declaration are unused.",
      "src/server/c.ts(9,9): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join('\n');
    expect(unusedFindings(out)).toEqual([
      "src/client/a.tsx(1,10): error TS6133: 'x' is declared but its value is never read.",
      'src/server/b.ts(3,1): error TS6192: All imports in import declaration are unused.',
    ]);
  });
});
