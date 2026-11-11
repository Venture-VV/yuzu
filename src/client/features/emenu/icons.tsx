// 平板点餐页的图标：照设计稿的尺寸与线宽重画（放大镜、订单、加减、关闭、左右箭头、退格、对勾）。
// 都很小（加号的圆直径 12.6），点按区域由外面的按钮放大。

import type { CSSProperties } from 'react';

const INK = 'var(--em-ink)';
const TAN = 'var(--em-tan)';
const LIGHT = 'var(--em-light)';

/** 顶栏的放大镜（设计稿 20.4 × 20.5） */
export function SearchIcon({ size = 20.5, color = INK }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20.5 20.5" fill="none" aria-hidden>
      <circle cx="8.55" cy="8.55" r="7.82" stroke={color} strokeWidth="1.45" />
      <path d="M15.6 15.5 19.7 19.6" stroke={color} strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

/** 顶栏的订单（设计稿 17.9 × 20.4：右上角开口的圆角方框，里面两道横线） */
export function OrderIcon({ color = INK }: { color?: string }) {
  return (
    <svg width="17.9" height="20.4" viewBox="0 0 17.9 20.4" fill="none" aria-hidden>
      <path d="M16.6.65H2.65a2 2 0 0 0-2 2v15.1a2 2 0 0 0 2 2h12.6a2 2 0 0 0 2-2V3.2" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <rect x="4.1" y="7" width="9.6" height="1.3" fill={color} />
      <rect x="4.1" y="11.2" width="6.5" height="1.3" fill={color} />
    </svg>
  );
}

/** 卡其色圆里的加号（设计稿直径 12.6） */
export function PlusDot({ size = 12.6, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12.6 12.6" aria-hidden style={{ display: 'block', opacity: muted ? 0.35 : 1 }}>
      <circle cx="6.3" cy="6.3" r="6.3" fill={TAN} />
      <path d="M3.35 6.3h5.9M6.3 3.35v5.9" stroke={LIGHT} strokeWidth="0.6" />
    </svg>
  );
}

/** 订单抽屉里减一份的圆（设计稿比加号浅） */
export function MinusDot({ size = 12.6 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12.6 12.6" aria-hidden style={{ display: 'block' }}>
      <circle cx="6.3" cy="6.3" r="6.3" fill="#cdc8c3" />
      <path d="M3.35 6.3h5.9" stroke={LIGHT} strokeWidth="0.6" />
    </svg>
  );
}

/** 菜品详情右上角的关闭（设计稿直径 30） */
export function CloseDot({ size = 30 }: { size?: number }) {
  // 设计稿：直径 30 的灰圆（PDF 里圆上的点在四个斜角，量出来的外框 21.2 是 30 × 0.707），里面的叉 11.2 见方
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden style={{ display: 'block' }}>
      <circle cx="15" cy="15" r="15" fill="#afafaf" />
      <path d="M9.4 9.35l11.2 11.3M20.6 9.35l-11.2 11.3" stroke="#f0f0f0" strokeWidth="0.9" />
    </svg>
  );
}

/** 菜品详情左右的箭头（设计稿直径 30） */
export function ArrowDot({ dir, size = 30 }: { dir: 'left' | 'right'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden style={{ display: 'block', transform: dir === 'left' ? 'scaleX(-1)' : undefined }}>
      <circle cx="15" cy="15" r="15" fill="#afafaf" />
      <path d="M12 7.7 19.6 15 12 22.3" stroke="#f0f0f0" strokeWidth="0.9" fill="none" />
    </svg>
  );
}

/** 数字键盘的退格（设计稿 23.6 × 13.8：向左的箭头形里一个叉） */
export function BackspaceIcon() {
  return (
    <svg width="23.6" height="13.8" viewBox="0 0 23.6 13.8" aria-hidden style={{ display: 'block' }}>
      <path d="M5.1 0h18.5v13.8H5.1L0 6.9z" fill={INK} />
      <path d="M11.1 3.6l6.6 6.6M17.7 3.6l-6.6 6.6" stroke="#f4f3f2" strokeWidth="0.75" />
    </svg>
  );
}

/** 下单成功的对勾（设计稿圆直径 191、线宽 10），圆和勾依次画出来 */
export function CheckMark({ style }: { style?: CSSProperties }) {
  return (
    <svg width="201" height="201" viewBox="0 0 201 201" fill="none" aria-hidden style={style}>
      {/* 设计稿：圆心在画布正中、半径 95.4（线宽 10 的中线），对勾三个点 (37.6, 94.5) → (82.3, 139.4) → (162.3, 59.3) */}
      <circle className="em-check-circle" cx="100.5" cy="100.5" r="95.4" stroke={INK} strokeWidth="10" transform="rotate(-90 100.5 100.5)" />
      <path className="em-check-mark" d="M37.6 94.5 82.3 139.4 162.3 59.3" stroke={INK} strokeWidth="10" />
    </svg>
  );
}
