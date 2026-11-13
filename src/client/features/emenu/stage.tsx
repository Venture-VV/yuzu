// 平板点餐页的舞台：整页按 1024×768 的设计稿等比缩放到屏幕（DC15）。4:3 的 iPad 正好铺满，别的比例上下或左右留边。
// 里面的元素一律按设计稿的像素写，不用管屏幕多大。
//
// 8.0.13（docs/EMENU.md 第 11.2 节）：键盘弹起时不重新缩放——缩放按「稳定的窗口大小」算（viewport.ts），页面与菜品图的大小不变；
// 键盘盖住输入框时整页往上挪到输入框露出来。动效的总开关也在这里：系统「减少动态效果」或后台设成「简洁」时
// 舞台带 data-motion="off"，emenu.css 里所有动画、过渡都关掉。

import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
}

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

const StageContext = createContext<StageInfo>({ scale: 1, visible: STAGE_H, keyboard: false, animated: false });
export const useStage = () => useContext(StageContext);
/** 现在缩放到多少倍（把屏幕上的距离换算回设计稿的像素用） */
export const useStageScale = () => useContext(StageContext).scale;

const isEditable = (el: Element | null): el is HTMLElement =>
  !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'file', 'range', 'color', 'submit', 'reset'].includes(el.type)) || (el as HTMLElement).isContentEditable);

/** 失去焦点以后这么久之内仍当作正在输入：键盘收起（窗口变回原来的高度）比失去焦点晚一点 */
const EDIT_GRACE_MS = 900;

function readViewport(lastEditAt: number): ViewportNow {
  const vv = window.visualViewport;
  const editing = isEditable(document.activeElement) || Date.now() - lastEditAt < EDIT_GRACE_MS;
  return { width: window.innerWidth, height: window.innerHeight, visibleTop: vv?.offsetTop ?? 0, visibleHeight: vv?.height ?? window.innerHeight, editing };
}

const INITIAL: StageLayout = { scale: 1, left: 0, top: 0, shift: 0, visible: STAGE_H, keyboard: false };

export function Stage({
  children,
  testId,
  motion = true,
  lang = 'zh',
  big = false,
}: {
  children: ReactNode;
  testId?: string;
  motion?: boolean;
  /** 现在的语言：切到英文时整页的字默认用英文字体（emenu.css） */
  lang?: 'zh' | 'en';
  /** 字与按钮放大的一档（后台设置；菜单还没取到时不放大） */
  big?: boolean;
}) {
  const stable = useRef<StableSize | null>(null);
  const lastEditAt = useRef(0);
  const stageEl = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<StageLayout>(INITIAL);
  const [height, setHeight] = useState<number | null>(null);
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

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
      setLayout((cur) => (cur.scale === next.scale && cur.left === next.left && cur.top === next.top && cur.visible === next.visible && cur.keyboard === next.keyboard ? cur : next));
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
  return (
    <StageContext.Provider value={{ scale: layout.scale, visible: layout.visible, keyboard: layout.keyboard, animated }}>
      <BigContext.Provider value={big}>
      <div
        className="emenu"
        // 高度写成稳定的那个数（不用 inset: 0）：键盘把窗口压矮时这一层不跟着变矮，舞台不会被挤
        style={{ position: 'fixed', left: 0, top: 0, width: '100%', height: height ?? '100%', overflow: 'hidden', background: 'var(--em-bg)' }}
        data-motion={animated ? undefined : 'off'}
        data-lang={lang}
        data-size={big ? 'large' : 'design'}
        data-keyboard={layout.keyboard || undefined}
        data-testid={testId}
      >
        <div
          ref={stageEl}
          style={{
            position: 'absolute',
            left: layout.left,
            top: layout.top,
            width: STAGE_W,
            height: STAGE_H,
            transform: `scale(${layout.scale})`,
            transformOrigin: '0 0',
            overflow: 'hidden',
            background: 'var(--em-bg)',
            transition: layout.keyboard || layout.shift ? 'top 0.28s ease' : undefined,
          }}
          data-emenu-stage
        >
          {children}
          {/* 退场的影子、飞向订单的小圆点画在这一层（motion.tsx 直接往里放节点，React 不管它的内容） */}
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
