// 会员标签（8.0.4 需求表 05，docs/MEMBERSHIP_V804.md 第 5 节）：原来的会员自定义字段改成标签——亲子客、商务客……
// 一位会员可以挂几个标签；标签按分组列（转来的标签按原来的字段名分组）。标签不能删、只能停用：停用后不能再挂，已挂的保留。

export const MAX_TAG_NAME = 16;
export const MAX_TAG_GROUP = 16;
/** 一位会员最多挂几个标签；最多建几个标签 */
export const MAX_MEMBER_TAGS = 30;
export const MAX_TAGS = 300;
/** 按标签导出一次最多多少位 */
export const MAX_TAG_EXPORT = 5000;

export type MemberTagSource = 'manual' | 'field';
export const MEMBER_TAG_SOURCE_LABELS: Record<MemberTagSource, string> = { manual: '手工建的', field: '由自定义字段转来' };

/** 会员身上的标签（会员详情、编辑会员） */
export interface MemberTagBrief {
  id: number;
  groupName: string;
  name: string;
  active: boolean;
}

/** 后台「会员标签」的一行 */
export interface MemberTag extends MemberTagBrief {
  source: MemberTagSource;
  sortOrder: number;
  version: number;
  /** 挂着这个标签的会员人数（含停用的会员） */
  memberCount: number;
  updatedAt: string;
  updatedByName: string | null;
}

/** 「客群 · 亲子客」；没有分组只显示名称 */
export const tagLabel = (t: Pick<MemberTagBrief, 'groupName' | 'name'>) => (t.groupName ? `${t.groupName} · ${t.name}` : t.name);

/** 按分组排好（没分组的在最后），组内按顺序、名称 */
export function groupTags<T extends Pick<MemberTagBrief, 'groupName' | 'name'> & { sortOrder?: number }>(tags: readonly T[]): { group: string; tags: T[] }[] {
  const map = new Map<string, T[]>();
  for (const t of tags) map.set(t.groupName, [...(map.get(t.groupName) ?? []), t]);
  return [...map]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh')))
    .map(([group, list]) => ({ group, tags: [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'zh')) }));
}

/** 按标签筛选：任一（有其中一个就算）或同时有 */
export type TagMatchMode = 'any' | 'all';

/** 按标签筛出来的一位会员（数据看板「会员总览 → 按标签」、导出） */
export interface TagMemberRow {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
  gradeLabel: string;
  status: 'active' | 'frozen';
  principalBalance: number;
  bonusBalance: number;
  lastActivityAt: string | null;
  tags: string[];
}

export interface TagMemberReport {
  tagIds: number[];
  mode: TagMatchMode;
  /** 一共几位 */
  count: number;
  /** 页面上列出的（最多 200 位，导出不限） */
  rows: TagMemberRow[];
}
