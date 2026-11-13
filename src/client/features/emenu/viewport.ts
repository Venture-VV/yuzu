// 平板点餐页的舞台怎么摆（8.0.13，docs/EMENU.md 第 11.2 节）与翻页的手感（第 11.3 节）：只有算术，不碰页面，方便单测。
//
// 键盘：部分安卓平板弹出键盘时会把网页可用的高度压小。舞台原来按「窗口高度」等比缩放，高度一变小整页（连同菜品图）跟着缩小。
// 现在记一份「稳定的窗口大小」：宽度变了（旋转、换窗口大小）或高度变大才更新；正在输入时高度变小当作键盘弹起，不更新。
// 缩放只按稳定的大小算，所以键盘弹起、收起页面大小都不变；键盘盖住输入框时把舞台往上挪到输入框露出来为止。

export const STAGE_W = 1024;
export const STAGE_H = 768;

export interface StableSize {
  w: number;
  h: number;
}

export interface ViewportNow {
  /** 布局视口（window.innerWidth / innerHeight） */
  width: number;
  height: number;
  /** 看得见的那一块（visualViewport）：离布局视口上沿多远、多高。键盘盖在页面上的平板（iPad）只有这一块变小 */
  visibleTop: number;
  visibleHeight: number;
  /** 正在输入（焦点在输入框里，或刚离开不到一秒——键盘收起比失去焦点晚一点） */
  editing: boolean;
}

/** 稳定的窗口大小：键盘弹起（正在输入时高度变小）不算窗口变了 */
export function nextStable(prev: StableSize | null, now: ViewportNow): StableSize {
  if (!prev || now.width !== prev.w || now.height >= prev.h) return { w: now.width, h: now.height };
  return now.editing ? prev : { w: now.width, h: now.height };
}

export interface StageLayout {
  scale: number;
  left: number;
  /** 舞台上沿（已经减去为了露出输入框往上挪的那一段） */
  top: number;
  /** 往上挪了多少（屏幕像素） */
  shift: number;
  /** 键盘上面还看得见的高度，换算成设计稿的像素（从舞台上沿起；没有键盘时是 768） */
  visible: number;
  keyboard: boolean;
}

/** 键盘至少盖住这么多才算（浏览器地址栏收放、系统手势条的几十像素不算） */
const KEYBOARD_MIN = 80;

/**
 * 舞台的位置。focusBottom：输入框下沿在「没有往上挪」时离布局视口上沿多远（没有输入框为 null）。
 * 键盘盖住的部分 = 稳定高度 − 现在看得见的下沿；输入框在键盘下面时往上挪到它露出来（留 12 设计像素），最多挪键盘那么高。
 */
export function stageLayout(stable: StableSize, now: ViewportNow, focusBottom: number | null): StageLayout {
  const scale = Math.min(stable.w / STAGE_W, stable.h / STAGE_H);
  const left = (stable.w - STAGE_W * scale) / 2;
  const top = (stable.h - STAGE_H * scale) / 2;
  const visibleBottom = Math.min(stable.h, now.visibleTop + Math.min(now.visibleHeight, now.height));
  const covered = stable.h - visibleBottom;
  const keyboard = now.editing && covered >= KEYBOARD_MIN;
  let shift = 0;
  if (keyboard && focusBottom !== null) shift = Math.max(0, Math.min(covered, focusBottom + 12 * scale - visibleBottom));
  const visible = keyboard ? Math.max(0, Math.min(STAGE_H, (visibleBottom - (top - shift)) / scale)) : STAGE_H;
  return { scale, left, top: top - shift, shift, visible, keyboard };
}

// ───────────────────────── 翻页 ─────────────────────────

/** 拖过头的阻尼（苹果那种橡皮筋）：拖得越远走得越少，最多走到 size 的一半多一点 */
export function rubberBand(distance: number, size: number): number {
  if (distance <= 0) return 0;
  return (1 - 1 / ((distance * 0.55) / size + 1)) * size;
}

/** 拖动时页面走到哪：在第一页与最后一页之间跟手，出了两头带阻尼 */
export function dragPosition(base: number, dragged: number, count: number): number {
  const max = Math.max(0, count - 1) * STAGE_W;
  const x = base - dragged;
  if (x < 0) return -rubberBand(-x, STAGE_W);
  if (x > max) return max + rubberBand(x - max, STAGE_W);
  return x;
}

/** 松手时翻到第几页：拖过了五分之一屏，或者甩得够快（每毫秒 0.35 设计像素），就翻一页；一次最多翻一页 */
export function settlePage(from: number, moved: number, velocity: number, count: number): number {
  let target = from;
  if (moved > STAGE_W * 0.2 || velocity > 0.35) target = from + 1;
  else if (moved < -STAGE_W * 0.2 || velocity < -0.35) target = from - 1;
  return Math.max(0, Math.min(Math.max(0, count - 1), target));
}
