// 发给模型之前的打码（8.0.22，docs/AI_V8022.md 第 0 节，MD7）：会员姓名只留姓，手机号只留前三后四，证件号整个去掉。
// 工具与事实包按构造只给汇总；这里是发出去之前的最后一道：要发的内容整个走一遍——
//   · 键名是会员姓名的（memberName、guestName、customerName……）只留第一个字；
//   · 键名像电话的（phone、mobile、tel……）只留前三后四；
//   · 所有文字里出现的手机号、18 位证件号也打码（员工手填的文字里可能夹着）。

import { maskPhone } from '@shared/membership';
import type { Db } from '../../db';

const PHONE = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g;
const ID_CARD = /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g;
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

/** 名字最长按多少个字找（再长的档案名不会是员工随手写进问题里的） */
const NAME_MAX = 20;

/**
 * 自由文字（员工写的问题、合同正文与备注）里的会员姓名、会员号：正则认不出名字，所以拿库里的会员档案逐个对——
 * 出现了的姓名只留第一个字（与结构化字段同一条规则），会员号整个换成「[会员号]」。两个字以下的名字不找（一个字的会误伤）。
 * 8.0.22 测试会话在 `80284a9` 报的 P1：原来自由文字只打码手机号、证件号，会员姓名会原样发给模型。
 * 取不出会员档案时整个抛错（问答、条款提示就不发出去），宁可不发也不漏。
 */
export async function memberTextMasker(db: Db): Promise<(text: string) => string> {
  const rows = await db<{ name: string | null; no: string | null }[]>`SELECT name, member_no AS no FROM members`;
  const names = new Set<string>();
  const nos = new Set<string>();
  let maxLen = 0;
  for (const r of rows) {
    const name = (r.name ?? '').trim();
    const n = [...name].length;
    if (n >= 2 && n <= NAME_MAX) {
      names.add(name);
      maxLen = Math.max(maxLen, name.length);
    }
    const no = (r.no ?? '').trim();
    if (no.length >= 4 && no.length <= NAME_MAX) {
      nos.add(no);
      maxLen = Math.max(maxLen, no.length);
    }
  }
  return (text: string) => {
    if (!maxLen || !text) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      let hit = 0;
      let kind: 'name' | 'no' | null = null;
      // 同一个位置先认最长的（「王先生」先于「王先」）
      for (let len = Math.min(maxLen, text.length - i); len >= 2; len--) {
        const piece = text.slice(i, i + len);
        if (names.has(piece)) {
          hit = len;
          kind = 'name';
          break;
        }
        if (nos.has(piece)) {
          hit = len;
          kind = 'no';
          break;
        }
      }
      if (kind === 'name') out += aiMaskName(text.slice(i, i + hit));
      else if (kind === 'no') out += '[会员号]';
      else {
        out += text[i];
        hit = 1;
      }
      i += hit;
    }
    return out;
  };
}
