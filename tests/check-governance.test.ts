// 治理基线（工程治理一期，scripts/check-governance.mjs）：每一条认得出该认的、放得过该放的。不要数据库。
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as gov from '../scripts/check-governance.mjs';

interface Numbers {
  hexColors: Record<string, number>;
  fontSizes: string[];
  largeFiles: string[];
  deadExports: string[];
}
const { colorBucket, compareBaseline, layerViolations, loosened, scanPageCode } = gov as {
  colorBucket: (file: string) => string;
  compareBaseline: (baseline: Numbers & { duplicationMaxPercent: number }, current: Numbers & { duplicationPercent: number }) => { problems: string[]; notes: string[] };
  layerViolations: (file: string, code: string) => { specifier: string; target: string; why: string }[];
  loosened: (oldBase: Numbers, newBase: Numbers) => string[];
  scanPageCode: (fileName: string, code: string) => { hex: number; fontSizes: Record<string, number> };
};

const BASE = {
  hexColors: { 'src/client/features/rooms': 2 },
  fontSizes: ['12', '13'],
  largeFiles: ['src/server/modules/admin.ts'],
  deadExports: ['src/shared/a.ts:OLD'],
  duplicationMaxPercent: 1,
};
const same = { hexColors: { 'src/client/features/rooms': 2 }, fontSizes: ['12', '13'], largeFiles: ['src/server/modules/admin.ts'], deadExports: ['src/shared/a.ts:OLD'], duplicationPercent: 0.8 };

describe('页面代码里的颜色与字号', () => {
  it('只数字符串、模板、JSX 里的；注释里的、不是颜色的 # 不算（字符串里三四位的 #333 这类算颜色）', () => {
    const code = [
      '// 见 PR #107、颜色 #ffffff（注释不算）',
      'const a = \'#fff\'; const b = "#1A2b3C"; const c = `1px solid #00000080`;',
      "const mixed = ['#333', '#section', '#12345', 'a#ffz'];",
      'export const X = () => <div className="text-[13px] bg-[#f5f5f5] text-[12.5px]">编号 #abc 的<span className={`text-[13px] ${a}`} /></div>;',
    ].join('\n');
    const found = scanPageCode('x.tsx', code);
    expect(found.hex).toBe(6); // #fff、#1A2b3C、#00000080、#333、#f5f5f5、JSX 文字里的 #abc
    expect(found.fontSizes).toEqual({ '13': 2, '12.5': 1 });
  });

  it('颜色按模块目录记数', () => {
    expect(['src/client/features/rooms/a/B.tsx', 'src/client/components/Brand.tsx', 'src/client/App.tsx', 'src/canteen-app/x/Y.tsx'].map(colorBucket)).toEqual([
      'src/client/features/rooms',
      'src/client/components',
      'src/client',
      'src/canteen-app',
    ]);
  });
});

describe('分层', () => {
  it('shared 引服务端或页面、页面引服务端、服务端引页面都认出来；引 shared、引第三方放过', () => {
    expect(layerViolations('src/shared/a.ts', "import { x } from '../server/db';\nimport y from '@client/lib/api';\nimport z from './b';").map((v) => v.specifier)).toEqual([
      '../server/db',
      '@client/lib/api',
    ]);
    expect(
      layerViolations('src/client/features/a/B.tsx', "import { x } from '../../../server/modules/wallet';\nimport { y } from '@shared/money';\nimport React from 'react';").map((v) => v.specifier),
    ).toEqual(['../../../server/modules/wallet']);
    expect(layerViolations('src/server/modules/a.ts', "const page = await import('../../client/App');\nimport { y } from '@shared/money';").map((v) => v.specifier)).toEqual(['../../client/App']);
    expect(layerViolations('src/server/modules/a.ts', "import { s } from '../serverless';\nimport { t } from '../lib/tx';")).toEqual([]);
    expect(layerViolations('tests/a.test.ts', "import { x } from '../src/server/db';")).toEqual([]);
  });
});

describe('与基线比', () => {
  it('持平通过；变少只给提示', () => {
    expect(compareBaseline(BASE, same)).toEqual({ problems: [], notes: [] });
    const fewer = compareBaseline(BASE, { hexColors: {}, fontSizes: ['12'], largeFiles: [], deadExports: [], duplicationPercent: 0.1 });
    expect(fewer.problems).toEqual([]);
    expect(fewer.notes).toHaveLength(4);
  });

  it('颜色变多、新字号、新的大文件、新的没人引用的导出、重复率超上限，各报一条', () => {
    const worse = compareBaseline(BASE, {
      hexColors: { 'src/client/features/rooms': 3, 'src/client/features/new': 1 },
      fontSizes: ['12', '13', '13.25'],
      largeFiles: ['src/server/modules/admin.ts', 'src/server/modules/big.ts'],
      deadExports: ['src/shared/a.ts:OLD', 'src/shared/b.ts:NEW'],
      duplicationPercent: 1.01,
    });
    expect(worse.problems).toHaveLength(5);
    expect(worse.problems[0]).toContain('src/client/features/rooms：2 → 3');
    expect(worse.problems[0]).toContain('src/client/features/new：0 → 1');
    expect(worse.problems[1]).toContain('text-[13.25px]');
    expect(worse.problems[2]).toContain('src/server/modules/big.ts');
    expect(worse.problems[3]).toContain('src/shared/b.ts:NEW');
    expect(worse.problems[4]).toContain('1.01%');
  });

  it('收紧基线时发现会放宽的地方', () => {
    expect(loosened(BASE, { ...BASE, hexColors: { 'src/client/features/rooms': 1 }, deadExports: [] })).toEqual([]);
    expect(loosened(BASE, { ...BASE, hexColors: { 'src/client/features/rooms': 3 }, fontSizes: ['12', '13', '15'] })).toEqual(['颜色 src/client/features/rooms：2 → 3', 'fontSizes 新增 15']);
  });
});
