// 对客导览（飞书需求 RQ-004 第四段，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 2 节）：在用的底图按楼层画，
// 同一区域的房间轮廓填同一种颜色（区域色块），写区域的中文名、英文名，画设施图标；可大屏轮播。
// 对客只到区域级：不显示房号、房态、人员；页面上没有任何经营数据。

/** 区域的导览分类：动区（娱乐、餐饮、水区）暖色、静区（休息、客房、SPA、按摩）冷色、公共（接待、大堂、走道）浅中性色；后场不显示 */
export const GUIDE_KINDS = ['active', 'quiet', 'public', 'back'] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];
export const GUIDE_KIND_LABELS: Record<GuideKind, string> = { active: '动区', quiet: '静区', public: '公共', back: '后场（不显示）' };
export const GUIDE_KIND_EN: Record<Exclude<GuideKind, 'back'>, string> = { active: 'Activity', quiet: 'Relax', public: 'Public' };
export const GUIDE_KIND_HINTS: Record<GuideKind, string> = {
  active: '娱乐、餐饮、水区',
  quiet: '休息、客房、SPA、按摩',
  public: '接待、大堂、走道',
  back: '员工区、技师休息区、布草间：导览图上不显示',
};

/** 默认配色：同一分类里按区域顺序轮流取色，相邻的区域分得开（区域单独指定的颜色优先） */
export const GUIDE_PALETTES: Record<Exclude<GuideKind, 'back'>, readonly string[]> = {
  active: ['#f4ad85', '#f3c77b', '#ec9a86', '#f6d79e', '#e8b27c'],
  quiet: ['#9fc4e6', '#a5d3c4', '#b3b6e4', '#8fc0d3', '#bcd7ee'],
  public: ['#ebe4d6', '#e1dccf', '#efe8dc'],
};

export const GUIDE_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** 设施图标（待确认：这八种） */
export const GUIDE_MARKER_KINDS = ['toilet', 'elevator', 'stairs', 'reception', 'entrance', 'locker', 'dining', 'smoking'] as const;
export type GuideMarkerKind = (typeof GUIDE_MARKER_KINDS)[number];
export const GUIDE_MARKER_LABELS: Record<GuideMarkerKind, { zh: string; en: string }> = {
  toilet: { zh: '卫生间', en: 'Restroom' },
  elevator: { zh: '电梯', en: 'Elevator' },
  stairs: { zh: '楼梯', en: 'Stairs' },
  reception: { zh: '前台', en: 'Reception' },
  entrance: { zh: '出入口', en: 'Entrance' },
  locker: { zh: '更衣室', en: 'Locker Room' },
  dining: { zh: '餐厅', en: 'Dining' },
  smoking: { zh: '吸烟区', en: 'Smoking Area' },
};

/** 自动识别：底图里不带编码的文字按关键字认（先排除员工区、后场等） */
export const GUIDE_MARKER_KEYWORDS: [GuideMarkerKind, RegExp][] = [
  ['toilet', /卫生间|洗手间|厕所|男卫|女卫|公卫|\bWC\b|TOILET/i],
  ['elevator', /电梯|客梯|\bELEV|LIFT\b/i],
  ['stairs', /楼梯|步梯|\bSTAIR/i],
  ['reception', /前台|接待|服务台|收银台|RECEPTION/i],
  ['entrance', /出入口|入口|大门|门厅|ENTRANCE/i],
  ['locker', /更衣/],
  ['dining', /餐厅|自助餐|餐区|DINING|RESTAURANT/i],
  ['smoking', /吸烟/],
];
export const GUIDE_MARKER_EXCLUDE = /员工|后场|内部|布草|机房|配电|货梯|消防|仓库|办公|技师|设备/;

/** 按文字认设施；认不出返回 null */
export function detectMarkerKind(text: string): GuideMarkerKind | null {
  const t = text.trim();
  if (!t || t.length > 24 || GUIDE_MARKER_EXCLUDE.test(t)) return null;
  for (const [kind, re] of GUIDE_MARKER_KEYWORDS) if (re.test(t)) return kind;
  return null;
}

export interface GuideRules {
  /** 大屏轮播：每层停留秒数 */
  carouselSeconds: number;
}
export const DEFAULT_GUIDE_RULES: GuideRules = { carouselSeconds: 15 };
export const MIN_CAROUSEL_SECONDS = 5;
export const MAX_CAROUSEL_SECONDS = 300;

/** 导览图上的一个区域色块（对客：只有区域名，不带房号） */
export interface GuideZone {
  id: number;
  floorCode: string;
  name: string;
  nameEn: string;
  kind: Exclude<GuideKind, 'back'>;
  color: string;
  /** 区域里各空间的轮廓（本地坐标） */
  polygons: [number, number][][];
  /** 区域名写在哪（轮廓按面积加权的中心） */
  labelAt: [number, number];
  /** 轮廓总面积（本地单位²，用来定字号） */
  area: number;
}

/** 导览图上的一个设施图标（本地坐标） */
export interface GuideMarker {
  id: number;
  floorCode: string;
  kind: GuideMarkerKind;
  x: number;
  y: number;
  label: string;
  labelEn: string;
}

export interface GuideFloor {
  code: string;
  title: string;
  width: number;
  height: number;
  /** 底图（去掉了图上的文字，GET image/svg+xml） */
  svgUrl: string;
}

export interface GuideData {
  storeName: string;
  batchId: number | null;
  floors: GuideFloor[];
  zones: GuideZone[];
  markers: GuideMarker[];
  carouselSeconds: number;
}

/** 后台「对客导览」 */
export interface GuideAdminZone {
  id: number;
  version: number;
  floorCode: string;
  floorName: string;
  name: string;
  nameEn: string;
  kind: GuideKind;
  /** 单独指定的颜色（没指定为 null，按分类取色） */
  color: string | null;
  /** 导览图上实际用的颜色 */
  shownColor: string | null;
  /** 在用底图上配上轮廓的空间数（0 时导览图上没有这个区域） */
  drawnSpaces: number;
  spaceCount: number;
}

export interface GuideAdminMarker extends GuideMarker {
  source: 'auto' | 'manual';
  hidden: boolean;
  version: number;
  /** 图纸坐标（毫米） */
  xMm: number;
  yMm: number;
  /** 在在用底图的这一层图框里（换了底图后可能落在图外） */
  onPlan: boolean;
}

export interface GuideAdmin {
  rules: GuideRules;
  batchId: number | null;
  floors: GuideFloor[];
  zones: GuideAdminZone[];
  markers: GuideAdminMarker[];
}

/** 区域实际用的颜色：单独指定的优先，否则按分类在同一层里轮流取色 */
export function zoneColor(kind: GuideKind, color: string | null, indexInKind: number): string | null {
  if (kind === 'back') return null;
  if (color) return color;
  const palette = GUIDE_PALETTES[kind];
  return palette[indexInKind % palette.length]!;
}
