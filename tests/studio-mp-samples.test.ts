// 给小程序线的样例版面（8.1.2，docs/STUDIO_MP.md 第 7 节）：仓库里的样例与生成脚本一致（格式改了要重新生成）、都合格式、
// 核对与检查没有红的、用到的图都在样例的图里；每一种节点、每一种排列都至少出现一次（小程序线照这几份核对渲染组件）。
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkStudioDoc, DocSchema, docAssets, validateStudioDoc, walkNodes, type StudioDoc } from '../src/shared/studio';
import { buildMpSamples } from '../scripts/studio-mp-samples';

const DIR = 'tests/fixtures/studio/mp';

describe('小程序的样例版面', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  const samples = buildMpSamples();

  it('仓库里的样例与生成脚本一致（改了格式或样例，跑 npx tsx scripts/studio-mp-samples.ts 重新生成）', () => {
    expect(files).toEqual(samples.map((s) => `${s.name}.json`));
    for (const s of samples) expect(JSON.parse(readFileSync(`${DIR}/${s.name}.json`, 'utf8'))).toEqual(JSON.parse(JSON.stringify(s)));
  });

  it('都合格式、核对与检查没有红的；用到的图都在 assets 里、文件名就是内容的 SHA-256', () => {
    const assets = new Map<string, number>();
    for (const f of readdirSync(`${DIR}/assets`)) {
      const bytes = readFileSync(`${DIR}/assets/${f}`);
      expect(f).toBe(`${createHash('sha256').update(bytes).digest('hex')}.png`);
      assets.set(f.slice(0, 64), bytes.length);
    }
    for (const f of files) {
      const s = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as { screen: string; doc: StudioDoc };
      const doc = DocSchema.parse(s.doc);
      expect(doc.surface, f).toBe('mp');
      expect(doc.screens[s.screen], f).toBeDefined();
      expect(validateStudioDoc(doc), f).toEqual([]);
      expect(checkStudioDoc(doc, { assets }).filter((i) => i.level === 'error'), f).toEqual([]);
      for (const a of docAssets(doc)) expect(assets.has(a), `${f} 用的图 ${a}`).toBe(true);
    }
  });

  it('每一种节点、排列、尺寸规则、动作都至少出现一次', () => {
    const seen = new Set<string>();
    for (const s of samples) {
      const screen = s.doc.screens[s.screen]!;
      if (screen.layout) seen.add(`layout:${screen.layout.mode}`);
      walkNodes(screen.nodes, (n) => {
        seen.add(`type:${n.type}`);
        if (n.type === 'frame' && n.layout) {
          seen.add(`layout:${n.layout.mode}`);
          seen.add(`align:${n.layout.align}`);
          seen.add(`justify:${n.layout.justify}`);
          if (n.layout.wrap) seen.add('wrap');
        }
        if (n.sizing) {
          seen.add(`w:${n.sizing.w}`);
          seen.add(`h:${n.sizing.h}`);
        }
        if ((n.type === 'button' || n.type === 'frame' || n.type === 'image') && n.action) seen.add(`action:${n.action.action}`);
        if (n.rotate) seen.add('rotate');
      });
    }
    for (const want of [
      'type:frame', 'type:text', 'type:rect', 'type:ellipse', 'type:image', 'type:button', 'type:field', 'type:block',
      'layout:row', 'layout:column', 'wrap', 'align:start', 'align:center', 'align:end', 'align:stretch',
      'justify:start', 'justify:center', 'justify:end', 'justify:between',
      'w:fixed', 'w:fill', 'w:hug', 'h:fixed', 'h:fill', 'h:hug',
      'action:open.page', 'action:call.store', 'action:nav.store', 'rotate',
    ]) expect(seen.has(want), want).toBe(true);
  });
});
