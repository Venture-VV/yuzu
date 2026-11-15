// UI 工作台的中英文案（8.1.2，docs/WORKBENCH_V811.md 第 13 节）：一份版面里所有的字列成一张表（文字、按钮、数据字段前后的字，连同组件里的），
// 按编号改、只改有变化的；导出 CSV（带 BOM，Excel 打开不乱码）再导回来原样对上。只测纯函数（不连数据库）。
import { describe, expect, it } from 'vitest';
import { applyCopy, collectCopy, copyFromCsv, copyToCsv, defaultStudioDoc, DocSchema, NodeSchema, validateStudioDoc, type StudioDoc } from '../src/shared/studio';

const node = (raw: Record<string, unknown>) => NodeSchema.parse({ name: '', x: 0, y: 0, w: 120, h: 40, ...raw });

function sample(): StudioDoc {
  const doc = defaultStudioDoc('mp');
  doc.screens.home!.nodes.push(
    node({ type: 'text', id: 't1', name: '标题', text: { zh: '冬日限定', en: 'Winter special' } }),
    node({ type: 'button', id: 'b1', text: { zh: '开始点餐', en: '' } }),
    node({ type: 'field', id: 'f1', field: 'store.name', prefix: { zh: '欢迎来到', en: 'Welcome to ' }, suffix: { zh: '', en: '' } }),
    node({ type: 'rect', id: 'r1' }),
  );
  doc.components = { 'c-badge': { name: '角标', node: node({ type: 'frame', id: 'cf', children: [node({ type: 'text', id: 'ct', text: { zh: '新品', en: 'New' } })] }) } };
  return DocSchema.parse(doc) as StudioDoc;
}

describe('中英文案', () => {
  it('收齐所有的字：文字、按钮、字段前面的字（后面空的不列）、组件里的；功能块与形状不列', () => {
    const mine = new Set(['t1', 'b1', 'f1', 'r1', 'ct']);
    const rows = collectCopy(sample()).filter((r) => mine.has(r.nodeId));
    expect(rows.map((r) => r.key)).toEqual(['home|t1|text', 'home|b1|text', 'home|f1|prefix', '@c-badge|ct|text']);
    expect(rows[0]).toMatchObject({ screenLabel: '首页', label: '标题', zh: '冬日限定', en: 'Winter special' });
    expect(rows[1]).toMatchObject({ label: '开始点餐', en: '' });
    expect(rows[2]).toMatchObject({ label: '欢迎来到（前面的字）', zh: '欢迎来到', en: 'Welcome to ' });
    expect(rows[3]).toMatchObject({ screen: '@c-badge', screenLabel: '组件：角标', zh: '新品' });
  });

  it('按编号改、只数有变化的；对不上的编号不管；没变化时原样返回同一份', () => {
    const doc = sample();
    const r = applyCopy(doc, [
      { key: 'home|b1|text', en: 'Start ordering' },
      { key: 'home|t1|text', zh: '冬日限定', en: 'Winter Special' },
      { key: '@c-badge|ct|text', zh: '上新' },
      { key: 'home|nope|text', en: 'x' },
    ]);
    expect(r.changed).toBe(3);
    const rows = collectCopy(r.doc);
    expect(rows.find((x) => x.key === 'home|b1|text')!.en).toBe('Start ordering');
    expect(rows.find((x) => x.key === 'home|t1|text')!.en).toBe('Winter Special');
    expect(rows.find((x) => x.key === '@c-badge|ct|text')!.zh).toBe('上新');
    expect(validateStudioDoc(r.doc).filter((i) => i.level === 'error')).toEqual([]);
    // 原来那份没被改
    expect(collectCopy(doc).find((x) => x.key === 'home|b1|text')!.en).toBe('');
    const same = applyCopy(doc, [{ key: 'home|t1|text', zh: '冬日限定' }]);
    expect(same).toEqual({ doc, changed: 0 });
  });

  it('导出 CSV 再导回来：带 BOM、逗号引号换行原样回来；只有「编号」「英文」两列也行；表头不对报错', () => {
    const doc = applyCopy(sample(), [{ key: 'home|t1|text', zh: '冬日, "限定"\n第二行' }]).doc;
    const csv = copyToCsv(collectCopy(doc));
    expect(csv.startsWith('\uFEFF编号,屏,名字,中文,英文\r\n')).toBe(true);
    const back = copyFromCsv(csv);
    expect(back.error).toBeNull();
    expect(applyCopy(doc, back.updates).changed).toBe(0);
    expect(back.updates.find((u) => u.key === 'home|t1|text')!.zh).toBe('冬日, "限定"\n第二行');
    // 字后面的空格原样回来
    expect(back.updates.find((u) => u.key === 'home|f1|prefix')!.en).toBe('Welcome to ');

    const onlyEn = copyFromCsv('编号,英文\r\nhome|b1|text,Order now\r\n');
    expect(onlyEn).toEqual({ updates: [{ key: 'home|b1|text', en: 'Order now' }], error: null });
    expect(applyCopy(doc, onlyEn.updates).changed).toBe(1);

    expect(copyFromCsv('名字,中文\r\n标题,x\r\n').error).toContain('编号');
    expect(copyFromCsv('编号,中文\r\n"home|t1|text,x\r\n').error).toContain('引号');
  });
});
