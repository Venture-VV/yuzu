// 治理基线（工程治理一期，scripts/check-governance.mjs）：每一条认得出该认的、放得过该放的。不要数据库。
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as gov from '../scripts/check-governance.mjs';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as bundle from '../scripts/check-bundle.mjs';

interface Numbers {
  hexColors: Record<string, number>;
  fontSizes: string[];
  largeFiles: string[];
  deadExports: string[];
}
const { colorBucket, compareBaseline, layerViolations, loosened, scanPageCode } = gov as {
  colorBucket: (file: string) => string;
  compareBaseline: (
    baseline: Numbers & { duplicationMaxPercent: number; conventions?: Record<string, number> },
    current: Numbers & { duplicationPercent: number; conventions?: Record<string, number> },
  ) => { problems: string[]; notes: string[] };
  layerViolations: (file: string, code: string) => { specifier: string; target: string; why: string }[];
  loosened: (oldBase: Numbers, newBase: Numbers) => string[];
  scanPageCode: (fileName: string, code: string) => { hex: number; fontSizes: Record<string, number>; inlineDvh: number };
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

describe('约定检查（docs/CONVENTIONS.md 里能查的几条）', () => {
  const { conventionCounts, focusedTests, stripComments } = gov as {
    conventionCounts: (file: string, code: string) => Record<string, number>;
    focusedTests: (code: string, fileName?: string) => number[];
    stripComments: (code: string) => string;
  };

  it('注释里提到的不算；网址里的 // 不当成注释', () => {
    const code = ['// 不看 navigator.onLine', "const url = 'https://example.com/a'; /* status < 500 */", 'const a = 1; // setInterval('].join('\n');
    expect(stripComments(code)).toBe(['', "const url = 'https://example.com/a'; ", 'const a = 1; '].join('\n'));
  });

  it('看 navigator.onLine、手写 status < 500、用 refetchInterval 定时取数，各自记数；约定自己的实现所在不算', () => {
    const code = ['if (!navigator.onLine) return;', 'if (res.status >= 500) retry();', 'if (e.status < 500) stop();', 'useQuery({ queryKey, queryFn, refetchInterval: 60_000 });'].join('\n');
    expect(conventionCounts('src/client/features/x/Page.tsx', code)).toEqual({ 'navigator.onLine': 1, 'status-500': 2, polling: 1 });
    expect(conventionCounts('src/client/lib/connection.ts', 'const online = navigator.onLine;')).toEqual({});
    expect(conventionCounts('src/client/lib/api.ts', 'if (error.status < 500) return true;')).toEqual({});
    // 公共小工具（lib/）与服务端不在「定时取数」这一条的范围里
    expect(conventionCounts('src/client/lib/queries.ts', 'useQuery({ refetchInterval: 1000 });')).toEqual({});
    expect(conventionCounts('src/server/jobs.ts', 'const refetchInterval = 60_000;')).toEqual({});
  });

  it('纯界面的计时器不算定时取数：倒计时、轮播、「现在几点」用 setInterval 不报（Codex 审查 ca1f116）', () => {
    const timers = [
      'const t = setInterval(() => setTick(Date.now()), 1000);',
      'const c = setInterval(() => setIndex((i) => (i + 1) % n), seconds * 1000);',
      'const now = window.setInterval(() => setNow(Date.now()), 60_000);',
    ].join('\n');
    expect(conventionCounts('src/client/features/clockroom/ClockroomPage.tsx', timers)).toEqual({});
  });

  it('小于 12 像素的字、手写的表格与弹窗各自记数；打印纸样、电子菜单版面、公共部件自己的实现不算（8.1.17 YS-1、YS-5）', () => {
    const page = [
      'export const A = () => <p className="text-[11px] text-[11.5px] text-[9px] text-[12px] text-[12.5px] text-[13px]">x</p>;',
      'export const B = () => <table><tbody /></table>;',
      'export const C = () => <div role="dialog" aria-modal>x</div>;',
      '// <table> 与 text-[10px] 写在注释里不算',
    ].join('\n');
    expect(conventionCounts('src/client/features/x/Page.tsx', page)).toEqual({ 'small-text': 3, 'raw-table': 1, 'raw-dialog': 1 });
    expect(conventionCounts('src/canteen-app/pages/Me.tsx', page)).toEqual({ 'small-text': 3, 'raw-table': 1, 'raw-dialog': 1 });
    // 整个目录除外（以 / 结尾）与单个文件除外
    expect(conventionCounts('src/client/features/print/CheckoutPrintPage.tsx', page)).toEqual({ 'raw-dialog': 1 });
    expect(conventionCounts('src/client/features/emenu/EmenuPage.tsx', page)).toEqual({ 'raw-table': 1 });
    expect(conventionCounts('src/client/features/studio/Canvas.tsx', page)).toEqual({ 'raw-table': 1, 'raw-dialog': 1 });
    expect(conventionCounts('src/client/features/studio/panels.tsx', page)).toEqual({ 'small-text': 3, 'raw-table': 1, 'raw-dialog': 1 });
    expect(conventionCounts('src/client/components/DataTable.tsx', '<table className="w-full" />')).toEqual({});
    expect(conventionCounts('src/client/components/Overlay.tsx', '<div role="dialog" />')).toEqual({});
    // 服务端不是页面
    expect(conventionCounts('src/server/modules/x.ts', page)).toEqual({});
  });

  it('样式表里小于 12 像素的字：font-size 与 font 简写里的第一个像素值；注释里的、rem / em 写法不算', () => {
    const { cssSmallFonts } = gov as { cssSmallFonts: (css: string) => number };
    const css = [
      '.a { font-size: 11px; }',
      '.b { font: 600 10px/1.4 var(--font-sans); }',
      '.c { font: 12px/1.9 var(--font-sans); font-size: 12.5px; }',
      '/* .d { font-size: 8px; } */',
      '.e { font-size: 0.7rem; line-height: 10px; }',
    ].join('\n');
    expect(cssSmallFonts(css)).toBe(2);
  });

  it('行内样式里的 dvh 记数；类名里带方括号的写法（打包时会补 vh）不算', () => {
    const code = "export const X = () => <div className=\"h-dvh max-h-[88dvh]\" style={{ height: '100dvh', minHeight: 'calc(100dvh - 2rem)' }} />;";
    expect(scanPageCode('x.tsx', code).inlineDvh).toBe(2);
  });

  it('用例里的 .only 认出来（注释掉的、字符串里写着的不算）', () => {
    const code = [
      "it('a', () => {});",
      "it.only('b', () => {});",
      "// test.only('c', () => {});",
      "describe.only('d', () => {});",
      "test.skip(cond, '按尺寸跳过');",
      'const sample = "it.only(\'字符串里的\', () => {});";',
      "test.describe.only('e', () => {});",
      'list.only(1);',
    ].join('\n');
    expect(focusedTests(code)).toEqual([2, 4, 7]);
  });

  it('变多了报出来并写明该怎么写；持平、变少通过', () => {
    const base = { ...BASE, conventions: { polling: 2, 'inline-dvh': 1 } };
    expect(compareBaseline(base, { ...same, conventions: { polling: 2, 'inline-dvh': 1 } }).problems).toEqual([]);
    expect(compareBaseline(base, { ...same, conventions: { polling: 1 } })).toEqual({ problems: [], notes: ['没照约定写的地方有 2 条变少了'] });
    const worse = compareBaseline(base, { ...same, conventions: { polling: 3, 'inline-dvh': 1, 'navigator.onLine': 1 } }).problems;
    expect(worse).toHaveLength(1);
    expect(worse[0]).toContain('polling：2 → 3');
    expect(worse[0]).toContain('useLivePoll');
    expect(worse[0]).toContain('navigator.onLine：0 → 1');
  });
});

describe('打包体积', () => {
  const { bundleProblem, entryScripts } = bundle as { bundleProblem: (entryKb: number, maxKb: number) => string | null; entryScripts: (html: string) => string[] };

  it('认出 index.html 直接引的入口脚本（样式表、预加载的不算）', () => {
    const html = '<link rel="stylesheet" href="/assets/index-a.css"><link rel="modulepreload" href="/assets/vendor-b.js"><script type="module" crossorigin src="/assets/index-c.js"></script>';
    expect(entryScripts(html)).toEqual(['assets/index-c.js']);
  });

  it('刚好在上限里通过，超了报出来', () => {
    expect(bundleProblem(900, 900)).toBeNull();
    expect(bundleProblem(901, 900)).toContain('901 KB');
  });
});
