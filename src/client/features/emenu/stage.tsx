// 平板点餐页的舞台：整页按 1024×768 的设计稿等比缩放到屏幕（DC15）。4:3 的 iPad 正好铺满，别的比例上下或左右留边。
// 里面的元素一律按设计稿的像素写，不用管屏幕多大。
//
// 8.0.13（docs/EMENU.md 第 11.2 节）：键盘弹起时不重新缩放——缩放按「稳定的窗口大小」算（viewport.ts），页面与菜品图的大小不变；
// 键盘盖住输入框时整页往上挪到输入框露出来。动效的总开关也在这里：系统「减少动态效果」或后台设成「简洁」时
// 舞台带 data-motion="off"，emenu.css 里所有动画、过渡都关掉。

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useBrandFont, warmEmenuFonts } from './brandFont';
import { nextStable, STAGE_H, STAGE_W, stageLayout, type StableSize, type StageLayout, type ViewportNow } from './viewport';
import './emenu.css';

export { STAGE_H, STAGE_W };
/** 顶栏的高度（菜品详情的大图从这里往下） */
export const HEADER_H = 102;

interface StageInfo {
  scale: number;
  /** 键盘上面还看得见的高度（设计稿的像素，从舞台上沿起）；没有键盘时是 768 */
  visible: number;
  keyboard: boolean;
  /** 动效开着（系统没有要求减少动态效果、后台也没设成简洁） */
  animated: boolean;
  /** 出血（8.1.6）：屏幕比设计稿多出来的那一圈（设计稿的像素，左右各 x、上下各 y）；工作台的画布、4:3 的屏是 0 */
  bleed: { x: number; y: number };
}

const NO_BLEED = { x: 0, y: 0 } as const;

/**
 * 字与按钮放大的一档（8.0.15，docs/EMENU.md 第 12 节）：后台「电子菜单 → 设置 → 字与按钮的大小」是「放大」时为 true。
 * 各处里面仍照设计稿的像素写，外面套一层按倍数放大、位置重新排；「设计稿原样」时为 false，与 8.0.14 一模一样。
 * 后台的版面预览不在舞台里，自己用 BigProvider 给。
 */
const BigContext = createContext(false);
export const BigProvider = BigContext.Provider;
export const useBig = () => useContext(BigContext);

/** 放大那一档各处用的倍数 */
export const BIG = {
  /** 菜单页上一道菜的文字（菜名、英文名、介绍、价格、加号） */
  dish: 1.4,
  /** 文字陈列的一行、竖排小标题 */
  row: 1.35,
  /** 顶栏右边的几样（中 | EN、搜索、订单、手牌）、菜品详情的卡片、搜索框、弹窗、提示条 */
  ui: 1.3,
  /** 右侧抽屉（订单、备注） */
  drawer: 1.25,
} as const;

/**
 * 放大的一块：里面照设计稿的像素写，整块绕 (x, y) 这个点放大 k 倍。里面的元素相对这个点定位（可以是负数）。
 * 自己不占位置、不挡点按；k = 1 时等于没套。
 */
export function ZoomAt({ x, y, k, children, style }: { x: number; y: number; k: number; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, transform: k === 1 ? undefined : `scale(${k})`, transformOrigin: '0 0', ...style }}>{children}</div>;
}

const StageContext = createContext<StageInfo>({ scale: 1, visible: STAGE_H, keyboard: false, animated: false, bleed: NO_BLEED });
export const useStage = () => useContext(StageContext);
/** 出血（8.1.6）：屏幕比设计稿多出来的那一圈 */
export const useBleed = () => useContext(StageContext).bleed;

/**
 * 铺到屏幕边的一层（8.1.6，docs/EMENU.md 第 15.2 节）：放在一个占满设计稿宽度的块里（左 0、宽 1024），往指定的几边伸出出血那么多。
 * 只画底（底色、压暗、大图），点按照旧落到它所在的那一块；里面的东西照旧按设计稿的坐标写在它外面。
 * sides：all 四边都伸；x 左右；xb 左右与下边（顶栏下面的大图）；right 右边与上下（右侧抽屉）。
 */
export function Bleed({ sides = 'all', style, className, testId }: { sides?: 'all' | 'x' | 'xb' | 'right'; style?: CSSProperties; className?: string; testId?: string }) {
  const b = useBleed();
  const top = sides === 'all' || sides === 'right' ? -b.y : 0;
  const bottom = sides === 'x' ? 0 : -b.y;
  const left = sides === 'right' ? 0 : -b.x;
  return <div aria-hidden className={className} style={{ position: 'absolute', left, right: -b.x, top, bottom, ...style }} data-testid={testId} />;
}

const isEditable = (el: Element | null): el is HTMLElement =>
  !!el &&
  (el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'file', 'range', 'color', 'submit', 'reset'].includes(el.type)) ||
    (el as HTMLElement).isContentEditable);

/** 失去焦点以后这么久之内仍当作正在输入：键盘收起（窗口变回原来的高度）比失去焦点晚一点 */
const EDIT_GRACE_MS = 900;

function readViewport(lastEditAt: number): ViewportNow {
  const vv = window.visualViewport;
  const editing = isEditable(document.activeElement) || Date.now() - lastEditAt < EDIT_GRACE_MS;
  return { width: window.innerWidth, height: window.innerHeight, visibleTop: vv?.offsetTop ?? 0, visibleHeight: vv?.height ?? window.innerHeight, editing };
}

const INITIAL: StageLayout = { scale: 1, left: 0, top: 0, shift: 0, visible: STAGE_H, keyboard: false, bleedX: 0, bleedY: 0 };

export function Stage({
  children,
  testId,
  motion = true,
  lang = 'zh',
  big = false,
  vars,
}: {
  children: ReactNode;
  testId?: string;
  motion?: boolean;
  /** 现在的语言：切到英文时整页的字默认用英文字体（emenu.css） */
  lang?: 'zh' | 'en';
  /** 字与按钮放大的一档（后台设置；菜单还没取到时不放大） */
  big?: boolean;
  /** UI 工作台（8.1.1）发布的主题：改过的颜色、字体（--em-*）；默认版面一个都不给 */
  vars?: Record<string, string>;
}) {
  const stable = useRef<StableSize | null>(null);
  const lastEditAt = useRef(0);
  const stageEl = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<StageLayout>(INITIAL);
  const [height, setHeight] = useState<number | null>(null);
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  // 字体开机就备好（第一次切英文不等下载，8.1.6）
  useLayoutEffect(() => warmEmenuFonts(), []);

  useLayoutEffect(() => {
    let timer = 0;
    const update = () => {
      const now = readViewport(lastEditAt.current);
      stable.current = nextStable(stable.current, now);
      const el = document.activeElement;
      // 输入框的下沿在「没有往上挪」时的位置：按它离舞台上沿多远算（舞台现在挪没挪、挪了多少都不影响这个数），
      // 再让 stageLayout 决定要挪多少
      const base = stageLayout(stable.current, now, null);
      const stageTop = stageEl.current?.getBoundingClientRect().top ?? base.top;
      const focusBottom = isEditable(el) && stageEl.current?.contains(el) ? el.getBoundingClientRect().bottom - stageTop + base.top : null;
      const next = stageLayout(stable.current, now, focusBottom);
      setHeight(stable.current.h);
      setLayout((cur) =>
        cur.scale === next.scale && cur.left === next.left && cur.top === next.top && cur.visible === next.visible && cur.keyboard === next.keyboard && cur.bleedY === next.bleedY ? cur : next,
      );
    };
    const onFocusOut = () => {
      lastEditAt.current = Date.now();
      window.clearTimeout(timer);
      // 过了宽限期再看一次：键盘已经收起就回到原位；窗口真的变矮了（不是键盘）这时才认
      timer = window.setTimeout(update, EDIT_GRACE_MS + 50);
      update();
    };
    update();
    const vv = window.visualViewport;
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', onFocusOut);
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduce(!!mq?.matches);
    mq?.addEventListener?.('change', onMotion);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', onFocusOut);
      mq?.removeEventListener?.('change', onMotion);
    };
  }, []);

  const animated = motion && !reduce;
  const brandEn = useBrandFont();
  // 出血（8.1.6）：两边、上下多出来的那一圈。一次布局里同一个对象，免得下面的人白白重画
  const bx = layout.bleedX;
  const by = layout.bleedY;
  const bleed = useMemo(() => ({ x: bx, y: by }), [bx, by]);
  return (
    <StageContext.Provider value={{ scale: layout.scale, visible: layout.visible, keyboard: layout.keyboard, animated, bleed }}>
      <BigContext.Provider value={big}>
        <div
          className="emenu"
          // 高度写成稳定的那个数（不用 inset: 0）：键盘把窗口压矮时这一层不跟着变矮，舞台不会被挤
          style={{ position: 'fixed', left: 0, top: 0, width: '100%', height: height ?? '100%', overflow: 'hidden', background: 'var(--em-bg)', ...vars }}
          data-motion={animated ? undefined : 'off'}
          data-brand-en={brandEn ? '' : undefined}
          data-lang={lang}
          data-size={big ? 'large' : 'design'}
          data-keyboard={layout.keyboard || undefined}
          data-testid={testId}
        >
          {/*
            舞台（8.1.6 起分两层）：外面一层铺满屏幕（设计稿外再加出血那一圈）、在屏幕边上裁；里面一层是 1024 × 768 的设计稿，
            居中、不裁——底色、压暗层、大图可以从里面往外铺到屏幕边（Bleed），别的东西照旧按设计稿的坐标写。
          */}
          <div
            style={{
              position: 'absolute',
              left: layout.left - bx * layout.scale,
              top: layout.top - by * layout.scale,
              width: STAGE_W + 2 * bx,
              height: STAGE_H + 2 * by,
              transform: `scale(${layout.scale})`,
              transformOrigin: '0 0',
              overflow: 'hidden',
              background: 'var(--em-bg)',
              transition: layout.keyboard || layout.shift ? 'top 0.28s ease' : undefined,
            }}
          >
            <div
              ref={stageEl}
              style={{ position: 'absolute', left: bx, top: by, width: STAGE_W, height: STAGE_H, ['--em-bleed-x' as string]: `${bx}px`, ['--em-bleed-y' as string]: `${by}px` }}
              data-emenu-stage
              data-bleed-x={bx > 0.5 ? Math.round(bx * 10) / 10 : undefined}
            >
              {children}
              {/*
                退场的影子、飞向订单的小圆点画在这一层（motion.tsx 直接往里放节点，React 不管它的内容）。原点与设计稿一致（影子照原来的
                坐标放），不裁：影子里铺到出血那一圈的底照样看得见，屏幕边由外面一层裁
              */}
              <div data-emenu-ghosts aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            </div>
          </div>
        </div>
      </BigContext.Provider>
    </StageContext.Provider>
  );
}

/**
 * 编辑器画布里的舞台（UI 工作台，8.1.1）：与平板同一套样式与上下文，但不铺满窗口、不跟键盘挪，按给的倍数缩放；没有动效。
 * 里面照设计稿的像素画（1024×768），外面的盒子是缩放以后的大小。
 */
export function EmbeddedStage({
  children,
  scale,
  lang = 'zh',
  big = false,
  vars,
  testId,
}: {
  children: ReactNode;
  scale: number;
  lang?: 'zh' | 'en';
  big?: boolean;
  vars?: Record<string, string>;
  testId?: string;
}) {
  const brandEn = useBrandFont();
  return (
    <StageContext.Provider value={{ scale, visible: STAGE_H, keyboard: false, animated: false, bleed: NO_BLEED }}>
      <BigContext.Provider value={big}>
        <div
          className="emenu"
          style={{ position: 'relative', width: STAGE_W * scale, height: STAGE_H * scale, overflow: 'hidden', background: 'var(--em-bg)', ...vars }}
          data-motion="off"
          data-brand-en={brandEn ? '' : undefined}
          data-lang={lang}
          data-size={big ? 'large' : 'design'}
          data-testid={testId}
        >
          <div
            style={{ position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, transformOrigin: '0 0', overflow: 'hidden', background: 'var(--em-bg)' }}
            data-emenu-stage
          >
            {children}
            <div data-emenu-ghosts aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }} />
          </div>
        </div>
      </BigContext.Provider>
    </StageContext.Provider>
  );
}

/**
 * 细边（设计稿的 0.5 描边）：画在一层不占位置的框上，不用元素自己的 border。
 * 0.5px 的边在不同屏幕上实际占的宽度不一样（普通屏算 1px、高清屏 0.5px），用 border 会把里面按设计稿定位的字挤偏。
 */
export function Hairline({ color = 'var(--em-mute)', radius = 1.5 }: { color?: string; radius?: number }) {
  return <span aria-hidden style={{ position: 'absolute', inset: 0, border: `0.5px solid ${color}`, borderRadius: radius, pointerEvents: 'none' }} />;
}

/** 设计稿上的一个矩形：左、上、宽、高 */
export const box = (x: number, y: number, w?: number, h?: number): CSSProperties => ({
  position: 'absolute',
  left: x,
  top: y,
  ...(w === undefined ? {} : { width: w }),
  ...(h === undefined ? {} : { height: h }),
});
