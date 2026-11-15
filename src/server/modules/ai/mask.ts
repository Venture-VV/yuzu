// 发给模型之前的打码（8.0.22，docs/AI_V8022.md 第 0 节，MD7）：会员姓名只留姓，手机号只留前三后四，证件号整个去掉。
// 工具与事实包按构造只给汇总；这里是发出去之前的最后一道：要发的内容整个走一遍——
//   · 键名是会员姓名的（memberName、guestName、customerName……）只留第一个字；
//   · 键名像电话的（phone、mobile、tel……）只留前三后四；
//   · 所有文字里出现的手机号、18 位证件号也打码（员工手填的文字里可能夹着）。

import { maskPhone } from '@shared/membership';
import type { Db } from '../../db';

// 中间夹着空格、横线的也认（「139 1234 5678」「139-1234-5678」，测试会话 e25d122 复验）
const PHONE = /(?<!\d)(1[3-9]\d)[\s-]?\d{4}[\s-]?(\d{4})(?!\d)/g;
const ID_CARD = /(?<![\dXx])\d{6}[\s-]?\d{8}[\s-]?\d{3}[\dXx](?![\dXx])/g;
const NAME_KEYS = /^(member|guest|customer|contact|holder)_?name$/i;
const PHONE_KEYS = /(phone|mobile|tel)$/i;

/** 会员姓名只留第一个字（「张三」→「张*」） */
export function aiMaskName(name: string): string {
  const chars = [...name.trim()];
  return chars.length ? `${chars[0]}*` : '';
}

/** 文字里的证件号去掉、手机号只留前三后四 */
export function aiMaskText(text: string): string {
  return text.replace(ID_CARD, '[证件号已隐去]').replace(PHONE, '$1****$2');
}

/** 整个走一遍：发给模型的事实包、工具结果都过这一道 */
export function maskForAi<T>(value: T): T {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (NAME_KEYS.test(key)) return aiMaskName(v);
      if (PHONE_KEYS.test(key)) return maskPhone(v.replace(/\s/g, ''));
      return aiMaskText(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** 每个字符串都换一遍（对象、数组里的也换）；键名不动 */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * 认的时候不算数的字：空白、零宽字符与常见的分隔符号——「欧阳 测试」「欧阳·测试」「欧阳-测试」都认作「欧阳测试」；
 * 全角、半角与大小写也先统一（NFKC + 小写）。
 */
const SKIP = /[\s\u200b-\u200d\u2060\ufeff·•・\-_.,，、。'"‘’“”()（）[\]【】:：;；/\\|]/u;
/**
 * 档案里常见的占位「名字」（导入的旧数据、前台随手填的），不当成某一位会员的姓名找——
 * 不然「这个月新会员多少」「客人数」都会被认成写了会员姓名。
 */
const GENERIC_NAMES = new Set(['会员', '客人', '散客', '顾客', '客户', '先生', '女士', '小姐', '老板', '老师', '师傅', '贵宾', 'vip', '测试', '未知', '无名', '匿名', '本人', '朋友', '同事', '员工', '临时', '其他', '其它']);

function normChar(ch: string): string {
  return [...ch.normalize('NFKC').toLowerCase()].filter((c) => !SKIP.test(c)).join('');
}

/** 统一后的文字，与每一位落在原文的哪个位置（打码时按原文换） */
function normalize(text: string): { norm: string; origin: number[] } {
  let norm = '';
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) origin.push(i);
    norm += n;
    i += ch.length;
  }
  return { norm, origin };
}

const normKey = (s: string) => [...s].map(normChar).join('');

export type MemberHitKind = 'name' | 'no' | 'phone';
export interface MemberHit {
  kind: MemberHitKind;
  /** 打码后的样子（给页面提示用，不含原文） */
  masked: string;
}
export interface MemberTextGuard {
  /** 文字里出现的会员身份（按会员档案认：姓名、会员号、手机号） */
  find(text: string): MemberHit[];
  /** 把认出来的换掉：姓名只留第一个字，会员号换成「[会员号]」，手机号只留前三后四 */
  mask(text: string): string;
}

/**
 * 自由文字（员工写的问题、合同正文与备注）里的会员身份：正则认不出名字，所以拿会员档案逐个对（8.0.22，测试会话在
 * `80284a9`、`e25d122` 报的 P1）。系统允许的姓名长度（1–32 字）都认，空格、分隔符号、全半角、大小写的变形也认；
 * 一个字的名字不找（打码规则本来就留第一个字），全是数字的「名字」与常见的占位名不找。
 * 取不出会员档案时整个抛错（问答、条款提示就不发出去），宁可不发也不漏。
 */
export async function memberTextGuard(db: Db): Promise<MemberTextGuard> {
  const rows = await db<{ name: string | null; no: string | null; phone: string | null }[]>`SELECT name, member_no AS no, phone FROM members`;
  const keys = new Map<string, MemberHitKind>();
  const add = (key: string, kind: MemberHitKind) => {
    if (!keys.has(key)) keys.set(key, kind);
  };
  for (const r of rows) {
    const name = normKey((r.name ?? '').trim());
    if ([...name].length >= 2 && !/^\d+$/.test(name) && !GENERIC_NAMES.has(name)) add(name, 'name');
    const no = normKey((r.no ?? '').trim());
    if (no.length >= 4 && !(/^\d+$/.test(no) && no.length < 6)) add(no, 'no');
    const phone = (r.phone ?? '').replace(/\D/g, '');
    if (phone.length >= 7) add(phone, 'phone');
  }
  // 先认长的（「王先生」先于「王先」）
  const lengths = [...new Set([...keys.keys()].map((k) => k.length))].sort((a, b) => b - a);

  const scan = (text: string): { start: number; end: number; kind: MemberHitKind; key: string }[] => {
    if (!text || !keys.size) return [];
    const { norm, origin } = normalize(text);
    const hits: { start: number; end: number; kind: MemberHitKind; key: string }[] = [];
    let s = 0;
    while (s < norm.length) {
      let matched = 0;
      for (const len of lengths) {
        if (s + len > norm.length) continue;
        const piece = norm.slice(s, s + len);
        const kind = keys.get(piece);
        if (kind) {
          const last = origin[s + len - 1]!;
          const lastLen = (text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1;
          hits.push({ start: origin[s]!, end: last + lastLen, kind, key: piece });
          matched = len;
          break;
        }
      }
      s += matched || 1;
    }
    return hits;
  };
  const show = (h: { kind: MemberHitKind; key: string }, original: string) =>
    h.kind === 'name' ? aiMaskName(original) : h.kind === 'no' ? '[会员号]' : maskPhone(h.key);

  return {
    find(text) {
      return scan(text).map((h) => ({ kind: h.kind, masked: show(h, text.slice(h.start, h.end)) }));
    },
    mask(text) {
      let out = '';
      let at = 0;
      for (const h of scan(text)) {
        out += text.slice(at, h.start) + show(h, text.slice(h.start, h.end));
        at = h.end;
      }
      return out + text.slice(at);
    },
  };
}
