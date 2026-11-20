// 拼音首字母（8.1.15，docs/TECHNICIANS_V8115.md）：钟房、技师管理里打「zxm」找到「张小明」。
// 不带字库：用运行环境自带的拼音排序（Intl.Collator 的 zh-CN-u-co-pinyin）——汉字按拼音排好以后，每个声母有一个「排在最前面的字」，
// 一个字排在哪两个分界字之间，声母就是哪个。Node（带完整 ICU）与各家浏览器都有这套排序；没有的环境汉字取不到首字母（返回空），只按原文找。
// 多音字按排序表里的那个读音（「曾」是 c、「单」是 d、「区」是 q），不认姓氏的读法。

/** 每个声母排在最前面的字：给几个候选，按当前环境的排序取最靠前的那个（各版本 ICU 的字表略有出入） */
const CANDIDATES: readonly (readonly [string, string])[] = [
  ['a', '吖阿啊'],
  ['b', '八巴'],
  ['c', '嚓擦'],
  ['d', '咑哒搭'],
  ['e', '妸婀屙'],
  ['f', '发'],
  ['g', '旮嘎'],
  ['h', '哈'],
  ['j', '丌讥击'],
  ['k', '咔咖'],
  ['l', '垃拉'],
  ['m', '呣妈'],
  ['n', '拏拿'],
  ['o', '喔噢哦'],
  ['p', '妑趴'],
  ['q', '七'],
  ['r', '呥然'],
  ['s', '仨撒'],
  ['t', '他它塌'],
  ['w', '屲穵挖'],
  ['x', '夕吸'],
  ['y', '丫压'],
  ['z', '帀匝'],
];

const HAN = /\p{Script=Han}/u;

interface Table {
  compare: (a: string, b: string) => number;
  bounds: readonly (readonly [string, string])[];
}

let table: Table | null | undefined;

function loadTable(): Table | null {
  if (table !== undefined) return table;
  table = null;
  try {
    if (Intl.Collator.supportedLocalesOf(['zh-CN']).length === 0) return table;
    const { compare } = new Intl.Collator('zh-CN-u-co-pinyin');
    const bounds = CANDIDATES.map(([letter, chars]) => [letter, [...chars].sort(compare)[0]!] as const);
    // 分界字要一个比一个靠后；不是（这个环境没有拼音排序，退回了按编码排）就当没有
    if (bounds.every(([, ch], i) => i === 0 || compare(bounds[i - 1]![1], ch) < 0)) table = { compare, bounds };
  } catch {
    /* 没有 Intl 的环境：只按原文找 */
  }
  return table;
}

/** 一个汉字的拼音首字母（小写）；取不到返回空 */
function initialOf(ch: string): string {
  const t = loadTable();
  if (!t) return '';
  let found = '';
  for (const [letter, bound] of t.bounds) {
    if (t.compare(ch, bound) < 0) break;
    found = letter;
  }
  return found;
}

/** 「张小明」→ zxm，「小雅 2 号」→ xy2h，「Amy」→ amy：汉字取首字母，字母数字原样（小写），其余的丢掉 */
export function pinyinInitials(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/[0-9a-z]/i.test(ch)) out += ch.toLowerCase();
    else if (HAN.test(ch)) out += initialOf(ch);
  }
  return out;
}

/** 搜索词归一：去掉空白、转小写 */
export const normalizeQuery = (query: string) => query.replace(/\s+/g, '').toLowerCase();

/**
 * 搜索词对不对得上这几样文字（姓名、花名、工号……）：原文包含，或拼音首字母包含。
 * 空的搜索词都对得上。query 传归一过的（normalizeQuery）。
 */
export function matchesQuery(query: string, fields: readonly string[]): boolean {
  if (!query) return true;
  return fields.some((f) => {
    if (!f) return false;
    const plain = normalizeQuery(f);
    return plain.includes(query) || pinyinInitials(f).includes(query);
  });
}
