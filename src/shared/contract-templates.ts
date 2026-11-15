// 8.0.21 合同模板与起草（docs/FINANCE_V8021.md 第 6 节，CW-E / CW20）：前后端共用。
// 正文是纯文本加段落（空行分段），用 {{字段}} 占位：内置字段从合同带出，模板自己的可填字段起草时填；
// {{付款节点}}、{{单价表}} 单独占一段时换成表格；可选条款起草时勾选，接在正文后面编号。结构化的部分照旧在合同表单里填。

import { BEARER_LABELS, PAYMENT_STAGE_LABELS, WARRANTY_BASIS_LABELS, type ContractCategory, type ContractContent } from './contracts';

export type TemplateFieldType = 'text' | 'number' | 'date';
export interface TemplateField {
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
}
export interface TemplateClause {
  key: string;
  title: string;
  text: string;
  /** 起草时默认勾上 */
  default: boolean;
}

export interface ContractTemplate {
  id: number;
  code: string;
  version: number;
  name: string;
  category: ContractCategory;
  body: string;
  fields: TemplateField[];
  clauses: TemplateClause[];
  status: 'active' | 'retired';
  createdByName: string;
  createdAt: string;
  /** 用这一版起草的合同份数 */
  usedBy: number;
}

export type { ContractTemplateRef } from './contracts';

/** 内置字段：名称 → 说明（正文里写 {{名称}}） */
export const BUILTIN_TEMPLATE_FIELDS: { key: string; hint: string }[] = [
  { key: '合同编号', hint: '合同号' },
  { key: '合同标题', hint: '合同标题' },
  { key: '我方', hint: '门店名称（门店基本规则里的）' },
  { key: '相对方', hint: '供应商或相对方名称' },
  { key: '开始日期', hint: '合同开始日' },
  { key: '结束日期', hint: '合同结束日（不定期写「不定期」）' },
  { key: '总价', hint: '含税总价，如 ¥12,345.00' },
  { key: '总价大写', hint: '人民币大写，如 壹万贰仟叁佰肆拾伍元整' },
  { key: '税率', hint: '主要税率，如 13%' },
  { key: '运费', hint: '运费谁承担' },
  { key: '卸货', hint: '卸货谁承担' },
  { key: '质保', hint: '质保起算与期限' },
  { key: '验收方法', hint: '验收方法' },
  { key: '验收签字', hint: '验收签字人' },
  { key: '不合格处理', hint: '不合格怎么处理' },
  { key: '付款节点', hint: '单独一段写它，换成付款节点表' },
  { key: '单价表', hint: '单独一段写它，换成单价表' },
];
const TABLE_KEYS = new Set(['付款节点', '单价表']);
/** 内置字段的名字：模板自己的可填字段不能用这些名字（不然导出的正文会和合同里结构化的金额、相对方对不上） */
export const BUILTIN_TEMPLATE_KEYS: ReadonlySet<string> = new Set(BUILTIN_TEMPLATE_FIELDS.map((f) => f.key));
export const TEMPLATE_FIELD_KEY = /^[一-龥A-Za-z][一-龥A-Za-z0-9_]{0,11}$/;

const DIGITS = '零壹贰叁肆伍陆柒捌玖';
const UNITS = ['', '拾', '佰', '仟'];
const BIG = ['', '万', '亿', '兆'];
/** 金额（分）→ 人民币大写；不用浮点数 */
export function amountInChinese(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) return '';
  if (cents === 0) return '零元整';
  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;
  let out = '';
  if (yuan > 0) {
    const groups: number[] = [];
    let n = yuan;
    while (n > 0) {
      groups.push(n % 10000);
      n = Math.floor(n / 10000);
    }
    let needZero = false;
    for (let g = groups.length - 1; g >= 0; g--) {
      const v = groups[g]!;
      if (v === 0) {
        needZero = out !== '';
        continue;
      }
      if (needZero || (out !== '' && v < 1000)) out += '零';
      needZero = false;
      let part = '';
      let zero = false;
      for (let i = 3; i >= 0; i--) {
        const d = Math.floor(v / 10 ** i) % 10;
        if (d === 0) {
          zero = part !== '';
          continue;
        }
        if (zero) part += '零';
        zero = false;
        part += DIGITS[d]! + UNITS[i]!;
      }
      out += part + BIG[g]!;
    }
    out += '元';
  }
  if (jiao === 0 && fen === 0) return `${out}整`;
  if (jiao > 0) out += `${DIGITS[jiao]}角`;
  else if (yuan > 0) out += '零';
  if (fen > 0) out += `${DIGITS[fen]}分`;
  return out;
}

const money = (cents: number) => `¥${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (bp: number) => `${bp / 100}%`;

/** 渲染出来的一段：文字，或者一张表 */
export type DocBlock = { kind: 'heading'; text: string } | { kind: 'para'; text: string } | { kind: 'table'; header: string[]; rows: string[][] };

export interface DocHead {
  contractNo: string;
  counterparty: string;
  storeName: string;
  /** 页眉的版本说明：「草稿」「第 2 版」 */
  versionLabel: string;
}

/** 付款节点表、单价表（不管有没有模板都要用） */
export function contractTables(content: ContractContent): { payment: DocBlock & { kind: 'table' }; lines: DocBlock & { kind: 'table' } } {
  return {
    payment: {
      kind: 'table',
      header: ['付款节点', '比例', '金额', '条件'],
      rows: content.paymentTerms
        .filter((t) => t.percentBp > 0)
        .map((t) => [PAYMENT_STAGE_LABELS[t.stage], percent(t.percentBp), money(Math.round((content.totalCents * t.percentBp) / 10000)), t.condition ?? '']),
    },
    lines: {
      kind: 'table',
      header: ['序号', '品名', '规格', '单位', '含税单价', '税率', '数量'],
      rows: content.lines.map((l, i) => [String(i + 1), l.itemName, l.spec, l.unit, money(l.priceCents), percent(l.taxRateBp), l.qtyMilli === null ? '按实际' : String(l.qtyMilli / 1000)]),
    },
  };
}

/** 内置字段的值 */
export function builtinValues(content: ContractContent, head: DocHead): Record<string, string> {
  return {
    合同编号: head.contractNo,
    合同标题: content.title,
    我方: head.storeName,
    相对方: head.counterparty,
    开始日期: content.startDate ?? '',
    结束日期: content.endDate ?? '不定期',
    总价: money(content.totalCents),
    总价大写: amountInChinese(content.totalCents),
    税率: percent(content.taxRateBp),
    运费: BEARER_LABELS[content.freightBearer],
    卸货: BEARER_LABELS[content.unloadingBearer],
    质保: content.warranty.months > 0 ? `自${WARRANTY_BASIS_LABELS[content.warranty.basis]}起 ${content.warranty.months} 个月` : '无质保期',
    验收方法: content.acceptance.method,
    验收签字: content.acceptance.signer,
    不合格处理: content.acceptance.penalty,
  };
}

/**
 * 按模板渲染合同正文：{{字段}} 换成值（找不到的保留「【字段】」提醒人补）；单独一段的 {{付款节点}}、{{单价表}} 换成表；
 * 勾选的可选条款接在后面。没用模板的合同：标题 + 两张表 + 备注。
 */
export function renderContractDoc(
  content: ContractContent,
  head: DocHead,
  template: { body: string; clauses: TemplateClause[] } | null,
): DocBlock[] {
  const tables = contractTables(content);
  const blocks: DocBlock[] = [{ kind: 'heading', text: content.title }];
  if (!template || !content.template) {
    blocks.push({ kind: 'para', text: `甲方：${head.storeName}　　乙方：${head.counterparty}` });
    blocks.push({ kind: 'para', text: `合同期限：${content.startDate ?? ''} 至 ${content.endDate ?? '不定期'}；含税总价 ${money(content.totalCents)}（${amountInChinese(content.totalCents)}）。` });
    if (tables.payment.rows.length) blocks.push({ kind: 'heading', text: '付款节点' }, tables.payment);
    if (tables.lines.rows.length) blocks.push({ kind: 'heading', text: '单价表' }, tables.lines);
    if (content.note) blocks.push({ kind: 'para', text: `备注：${content.note}` });
    return blocks;
  }
  // 内置字段以合同本身为准：模板自己的字段与内置的重名时（旧模板，8.0.21 起新建、改版都拦）不让它盖掉合同的金额、相对方等
  const values: Record<string, string> = { ...content.template.values, ...builtinValues(content, head) };
  const fill = (s: string) => s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, k: string) => (values[k] !== undefined && values[k] !== '' ? values[k]! : `【${k}】`));
  for (const para of template.body.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const t = para.trim();
    if (!t) continue;
    const table = /^\{\{\s*(付款节点|单价表)\s*\}\}$/.exec(t);
    if (table && TABLE_KEYS.has(table[1]!)) {
      blocks.push(table[1] === '付款节点' ? tables.payment : tables.lines);
      continue;
    }
    // 「# 标题」单独一行当小标题
    if (/^#\s+/.test(t)) blocks.push({ kind: 'heading', text: fill(t.replace(/^#\s+/, '')) });
    else blocks.push({ kind: 'para', text: fill(t) });
  }
  const chosen = template.clauses.filter((c) => content.template!.clauses.includes(c.key));
  if (chosen.length) {
    blocks.push({ kind: 'heading', text: '补充条款' });
    chosen.forEach((c, i) => blocks.push({ kind: 'para', text: `${i + 1}. ${c.title}：${fill(c.text)}` }));
  }
  return blocks;
}
