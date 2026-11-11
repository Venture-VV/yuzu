// 平板点餐页的舞台：整页按 1024×768 的设计稿等比缩放到屏幕（DC15）。4:3 的 iPad 正好铺满，别的比例上下或左右留边。
// 里面的元素一律按设计稿的像素写，不用管屏幕多大。

import { createContext, useContext, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import './emenu.css';

export const STAGE_W = 1024;
export const STAGE_H = 768;
/** 顶栏的高度（菜品详情的大图从这里往下） */
export const HEADER_H = 102;

const ScaleContext = createContext(1);
/** 现在缩放到多少倍（把屏幕上的距离换算回设计稿的像素用） */
export const useStageScale = () => useContext(ScaleContext);

const fit = () => (typeof window === 'undefined' ? 1 : Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));

export function Stage({ children, testId }: { children: ReactNode; testId?: string }) {
  const [scale, setScale] = useState(fit);
  useLayoutEffect(() => {
    const onResize = () => setScale(fit());
    onResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return (
    <ScaleContext.Provider value={scale}>
      <div className="emenu" style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: 'var(--em-bg)' }} data-testid={testId}>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: STAGE_W,
            height: STAGE_H,
            marginLeft: -STAGE_W / 2,
            marginTop: -STAGE_H / 2,
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
            overflow: 'hidden',
            background: 'var(--em-bg)',
          }}
          data-emenu-stage
        >
          {children}
        </div>
      </div>
    </ScaleContext.Provider>
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
