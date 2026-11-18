// 代码整洁检查（8.1.3，scripts/check-code.mjs）：三条规则各自认得出该认的、放得过该放的；小程序线的文件不查；
// 编译器没跑完（被信号终止、没有诊断却失败）不当成通过（Codex 验收 v8.1.12 报的那一条）
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { compilerIncomplete, compilerProblems, floatingQueries, inlineTypeImports, runNode, unusedFindings } from '../scripts/check-code.mjs';

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
    const code = [
      "import { type A, type B } from './x';",
      "import type { C } from './y';",
      "import { d, type E } from './z';",
      "import { type F } from '@shared/f';",
      'import {',
      '  type G,',
      '  type H,',
      "} from './g';",
    ].join('\n');
    expect((inlineTypeImports(code) as { line: number }[]).map((f) => f.line)).toEqual([1, 4, 5]);
  });
});

describe('没用到的导入、变量、参数', () => {
  it('只留主线的；小程序线自己的目录、用例不算', () => {
    const out = [
      "src/client/a.tsx(1,10): error TS6133: 'x' is declared but its value is never read.",
      "src/server/modules/mp/coupon-center.ts(51,9): error TS6133: 'boundMember' is declared but its value is never read.",
      "tests/mp-member.test.ts(162,11): error TS6133: 'memberId' is declared but its value is never read.",
      'src/server/b.ts(3,1): error TS6192: All imports in import declaration are unused.',
      "src/server/c.ts(9,9): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join('\n');
    expect(unusedFindings(out)).toEqual([
      "src/client/a.tsx(1,10): error TS6133: 'x' is declared but its value is never read.",
      'src/server/b.ts(3,1): error TS6192: All imports in import declaration are unused.',
    ]);
  });
});

describe('编译器没跑完不算通过', () => {
  type Result = { status: number | null; signal: string | null; code: string | null; output: string };
  const incomplete = compilerIncomplete as (r: Result) => string | null;
  const problems = compilerProblems as (r: Result) => string[];
  const run = runNode as (args: string[]) => Result;
  const UNUSED = "src/client/a.tsx(1,10): error TS6133: 'x' is declared but its value is never read.";
  const TYPE_ERROR = "src/server/c.ts(9,9): error TS2322: Type 'string' is not assignable to type 'number'.";

  it('正常结束、或者带着诊断失败，都算跑完', () => {
    expect(incomplete({ status: 0, signal: null, code: null, output: '' })).toBeNull();
    expect(incomplete({ status: 2, signal: null, code: null, output: `${UNUSED}\n` })).toBeNull();
    expect(incomplete({ status: 1, signal: null, code: null, output: `${TYPE_ERROR}\n` })).toBeNull();
  });

  it('被信号终止：没有输出、或者已经吐出一部分诊断，都算没跑完', () => {
    expect(incomplete({ status: null, signal: 'SIGKILL', code: null, output: '' })).toContain('SIGKILL');
    expect(incomplete({ status: null, signal: 'SIGABRT', code: null, output: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' })).toContain('SIGABRT');
    expect(incomplete({ status: null, signal: 'SIGTERM', code: 'ENOBUFS', output: `${UNUSED}\n` })).toContain('SIGTERM');
  });

  it('退出码不是 0 却没有诊断、根本没起来，都算没跑完', () => {
    expect(incomplete({ status: 137, signal: null, code: null, output: '' })).toContain('137');
    expect(incomplete({ status: 1, signal: null, code: null, output: "Error: Cannot find module 'typescript'" })).toContain('没有任何诊断');
    expect(incomplete({ status: null, signal: null, code: 'ENOENT', output: '' })).toContain('ENOENT');
  });

  it('没跑完只报这一条；跑完了照常分成类型的错与没用到的，都没有就是空', () => {
    const killed = problems({ status: null, signal: 'SIGKILL', code: null, output: `${UNUSED}\n` });
    expect(killed).toHaveLength(1);
    expect(killed[0]).toContain('SIGKILL');
    expect(killed[0]).not.toContain('没用到的导入');

    const both = problems({ status: 2, signal: null, code: null, output: [UNUSED, TYPE_ERROR].join('\n') });
    expect(both).toHaveLength(2);
    expect(both[0]).toContain('TS2322');
    expect(both[1]).toContain('TS6133');

    expect(problems({ status: 0, signal: null, code: null, output: '' })).toEqual([]);
    // 小程序线的文件里有没用到的：编译器带着诊断失败（算跑完），主线这边没有要报的
    expect(problems({ status: 2, signal: null, code: null, output: "src/server/modules/mp/coupon-center.ts(51,9): error TS6133: 'boundMember' is declared but its value is never read." })).toEqual([]);
  });

  it('真起一个子进程：被 SIGKILL 杀掉的、不带诊断就失败的，一路传到「有问题」', () => {
    const killed = run(['-e', "process.kill(process.pid, 'SIGKILL')"]);
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.status).toBeNull();
    expect(problems(killed)).toHaveLength(1);

    const failed = run(['-e', 'process.exit(3)']);
    expect(failed).toMatchObject({ status: 3, signal: null });
    expect(problems(failed)[0]).toContain('退出码 3');

    const diagnosed = run(['-e', `console.log(${JSON.stringify(TYPE_ERROR)}); process.exit(2)`]);
    expect(diagnosed.status).toBe(2);
    expect(problems(diagnosed)[0]).toContain('类型检查本身有错');

    expect(problems(run(['-e', '']))).toEqual([]);
  });
});
