// 发给模型之前的打码（8.0.22，docs/AI_V8022.md 第 0 节，MD7）：会员姓名只留姓，手机号只留前三后四，证件号整个去掉。
// 工具与事实包按构造只给汇总；这里是发出去之前的最后一道：要发的内容整个走一遍——
//   · 键名是会员姓名的（memberName、guestName、customerName……）只留第一个字；
//   · 键名像电话的（phone、mobile、tel……）只留前三后四；
//   · 所有文字里出现的手机号、18 位证件号也打码（员工手填的文字里可能夹着）。

import { maskPhone } from '@shared/membership';

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
