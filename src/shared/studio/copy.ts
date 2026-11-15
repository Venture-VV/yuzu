// UI 工作台的中英文案（8.1.2，docs/WORKBENCH_V811.md 第 13 节）：一份版面里所有的字（文字、按钮、数据字段前后的字，连同组件里的）
// 列成一张表，中文、英文对着改；可以导出 CSV 给人翻译、再导回来（按编号对上，只改有变化的）。

import { readCsvTable } from '../csv-read';
import { walkNodes } from './core';
import type { StudioDoc, StudioNode } from './format';
import { STUDIO_SURFACE_DEFS } from './surfaces';

export type CopyPart = 'text' | 'prefix' | 'suffix';

export interface CopyRow {
  /** 「屏|节点编号|哪一段」：导出、导回来按它对 */
  key: string;
  /** 哪一屏（组件是「@组件编号」） */
  screen: string;
  /** 给人看的：屏的名字（组件写「组件：名字」） */
  screenLabel: string;
  nodeId: string;
  part: CopyPart;
  /** 给人看的：这一块的名字（没取名字的写前几个字） */
  label: string;
  zh: string;
  en: string;
}

const PART_LABEL: Record<CopyPart, string> = { text: '', prefix: '（前面的字）', suffix: '（后面的字）' };

function partsOf(n: StudioNode): { part: CopyPart; zh: string; en: string }[] {
  if (n.type === 'text' || n.type === 'button') return [{ part: 'text', zh: n.text.zh, en: n.text.en }];
  if (n.type === 'field')
    return (
      [
        { part: 'prefix' as const, ...n.prefix },
        { part: 'suffix' as const, ...n.suffix },
      ] as const
    ).filter((p) => p.zh || p.en);
  return [];
}

/** 一份版面里所有的字：按屏（界面登记的先后），再是组件；没有中文也没有英文的不列 */
export function collectCopy(doc: StudioDoc): CopyRow[] {
  const def = STUDIO_SURFACE_DEFS[doc.surface];
  const rows: CopyRow[] = [];
  const add = (screen: string, screenLabel: string, nodes: readonly StudioNode[]) =>
    walkNodes(nodes, (n) => {
      for (const p of partsOf(n)) {
        const label = (n.name || p.zh || p.en || n.id).slice(0, 20) + PART_LABEL[p.part];
        rows.push({ key: `${screen}|${n.id}|${p.part}`, screen, screenLabel, nodeId: n.id, part: p.part, label, zh: p.zh, en: p.en });
      }
    });
  for (const s of def.screens) add(s.key, s.label, doc.screens[s.key]?.nodes ?? []);
  for (const [cid, c] of Object.entries(doc.components ?? {})) add(`@${cid}`, `组件：${c.name}`, [c.node]);
  return rows;
}

export interface CopyUpdate {
  key: string;
  zh?: string;
  en?: string;
}

/** 按编号改字（只改有变化的）；返回新的一份版面与改了几处。对不上的编号不管 */
export function applyCopy(doc: StudioDoc, updates: readonly CopyUpdate[]): { doc: StudioDoc; changed: number } {
  const byKey = new Map(updates.map((u) => [u.key, u]));
  const next = JSON.parse(JSON.stringify(doc)) as StudioDoc;
  let changed = 0;
  const visit = (screen: string, nodes: readonly StudioNode[]) =>
    walkNodes(nodes, (n) => {
      const targets: [CopyPart, { zh: string; en: string }][] =
        n.type === 'text' || n.type === 'button'
          ? [['text', n.text]]
          : n.type === 'field'
            ? [
                ['prefix', n.prefix],
                ['suffix', n.suffix],
              ]
            : [];
      for (const [part, t] of targets) {
        const u = byKey.get(`${screen}|${n.id}|${part}`);
        if (!u) continue;
        if (u.zh !== undefined && u.zh !== t.zh) {
          t.zh = u.zh;
          changed += 1;
        }
        if (u.en !== undefined && u.en !== t.en) {
          t.en = u.en;
          changed += 1;
        }
      }
    });
  for (const [key, s] of Object.entries(next.screens)) visit(key, s.nodes);
  for (const [cid, c] of Object.entries(next.components ?? {})) visit(`@${cid}`, [c.node]);
  return { doc: changed ? next : doc, changed };
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 导出成 CSV（Excel 打开不乱码：带 BOM）：编号、屏、名字、中文、英文 */
export function copyToCsv(rows: readonly CopyRow[]): string {
  const lines = [['编号', '屏', '名字', '中文', '英文'], ...rows.map((r) => [r.key, r.screenLabel, r.label, r.zh, r.en])];
  return `\uFEFF${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** 从 CSV 读回来：要有「编号」列，「中文」「英文」有哪列改哪列；空的格子也算（清空） */
export function copyFromCsv(text: string): { updates: CopyUpdate[]; error: string | null } {
  // 字前后的空格原样保留（「Welcome to 」后面的空格是字的一部分）；编号、表头去掉空白再对
  const t = readCsvTable(text.replace(/^\uFEFF/, ''), { trim: false });
  if (t.unclosedQuoteLine !== null) return { updates: [], error: `第 ${t.unclosedQuoteLine} 行的引号没有配对` };
  const head = (t.header?.cells ?? []).map((c) => c.trim());
  const iKey = head.indexOf('编号');
  const iZh = head.indexOf('中文');
  const iEn = head.indexOf('英文');
  if (iKey < 0 || (iZh < 0 && iEn < 0)) return { updates: [], error: '表头要有「编号」，和「中文」「英文」里的至少一列（照导出的那份改）' };
  const updates: CopyUpdate[] = [];
  for (const r of t.rows) {
    const key = r.cells[iKey]?.trim();
    if (!key) continue;
    const u: CopyUpdate = { key };
    if (iZh >= 0 && r.cells[iZh] !== undefined) u.zh = r.cells[iZh]!;
    if (iEn >= 0 && r.cells[iEn] !== undefined) u.en = r.cells[iEn]!;
    updates.push(u);
  }
  return { updates, error: null };
}
