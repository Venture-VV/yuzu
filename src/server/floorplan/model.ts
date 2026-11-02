// 底图转换（RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）用的中性图元：DWG 读出来以后先换成这几种，
// 转换（分楼层、围合房间、出底图）只认这里的结构——读图的库换了（LibreDWG 换 ODA）也不用改转换。
// 坐标单位是图纸单位（编码图是毫米）。

export type Pt = [number, number];

/** 线：直线、多段线、圆弧、圆、椭圆、样条都折成折线 */
export interface PlanPath {
  /** 去掉 xref 前缀后的图层名（如 `02-二层B区平面系统图$0$AD-建筑楼梯` → `AD-建筑楼梯`） */
  layer: string;
  pts: Pt[];
  closed: boolean;
}

/** 单行文字、多行文字、块属性 */
export interface PlanText {
  layer: string;
  text: string;
  /** 对齐点（已换成世界坐标） */
  x: number;
  y: number;
  height: number;
  /** 弧度 */
  rotation: number;
  /** 对齐点在文字宽度上的位置：0 左、0.5 中、1 右 */
  ax: number;
  /** 对齐点在文字高度上的位置：0 基线 / 底、0.5 中、1 顶 */
  ay: number;
}

export interface PlanDrawing {
  paths: PlanPath[];
  texts: PlanText[];
  /** 每个图层（去掉前缀后）的图元数（含没有转成线或文字的，如填充、标注） */
  layerCounts: Record<string, number>;
  stats: {
    /** 模型空间图元数（块参照算一个） */
    entities: number;
    layers: number;
    /** 展开的块参照数 */
    inserts: number;
    /** 没转换的图元类型与数量（填充、标注、视口……） */
    skipped: Record<string, number>;
    /** 读图时的非致命错误码（LibreDWG，如 64 = 个别数值超出范围），没有为空 */
    readErrorCode?: number;
    /** PDF 才有：页数、换算用的图纸比例 1:N，比例从哪来（图上的比例文字 / 上传时填的） */
    /** PDF（v0.7.19）：页数、换算用的比例、比例从哪来（上传时填的 / 页面上的文字）、页面上写的比例（没有为 null） */
    pdf?: { pages: number; scale: number; scaleFrom: 'text' | 'option'; textScale: number | null };
  };
}

/** `xxx$0$AD-建筑楼梯` → `AD-建筑楼梯`；去掉首尾空白 */
export const baseLayer = (name: string) => name.replace(/^.*\$0\$/, '').trim();
