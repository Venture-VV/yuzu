// 手绘线条的小图标（底部导航、按钮）与手抖描边的滤镜（docs/CANTEEN.md 第 13 节）。
// 线条故意画得不那么规整（一点歪、一点多出来的笔头），配合 #yz-rough 的噪声，看起来像马克笔画的。
// 颜色跟着文字走（currentColor），选中时用 fill 填一块柚黄的「涂色」。

import type { ReactNode, SVGProps } from 'react';

/** 手抖描边的滤镜（.sketch 的边框用）：放在 App 最外层一次 */
export function RoughDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <filter id="yz-rough" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={2} seed={7} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'fill'> & { size?: number; fill?: string };

function Doodle({ size = 24, fill, children, ...rest }: IconProps & { children: (fill: string) => ReactNode }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children(fill ?? 'none')}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M6.5 15.2 16.2 6.4l9.4 8.9" />
        <path d="M8.6 13.6c-.3 4.4-.2 8.4.2 12.1 4.6.3 9.6.3 14.6-.1.3-3.9.4-8 .2-12.2" fill={f} />
        <path d="M13.4 25.6c-.2-2.6 0-4.6.3-6 1.6-.4 3.2-.4 4.8 0 .3 1.6.4 3.6.2 6" />
        <path d="M22 9.6V6.8h2.4v4.6" />
      </>
    )}
  </Doodle>
);

/** 菜单：一只碗、一双筷子 */
export const IconMenu = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M5 15.4c7.2.5 14.6.4 22-.2-.6 5.8-4.6 9.8-11 9.9-6.2-.1-10.4-4-11-9.7Z" fill={f} />
        <path d="M12.6 25.4c-.4 1 .1 1.6 3.4 1.6s3.9-.6 3.4-1.7" />
        <path d="M17.6 12.6 25.2 4.4M20.8 13.2l6.2-6.8" />
        <path d="M9.6 12.4c-.6-1.2.6-2 0-3.4M13.4 11.8c-.6-1.2.6-2 0-3.4" strokeWidth={1.8} />
      </>
    )}
  </Doodle>
);

/** 饭卡码：一张小票，中间一个码 */
export const IconTicket = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M6.2 7.6c6.6-.4 13.2-.3 19.8.1.3 2.2.2 3.4-.1 4.6-1.6.4-2.4 1.6-2.4 3.2s.9 2.8 2.5 3.2c.3 1.6.3 3.2 0 5.6-6.6.6-13.2.6-19.8.1-.3-2.2-.2-3.8.1-5.6 1.6-.4 2.5-1.6 2.5-3.2S7.9 12.8 6.3 12.4c-.4-1.6-.4-3.2-.1-4.8Z" fill={f} />
        <path d="M13 12.6h2.6v2.6H13zM16.8 16.8h2.6v2.6h-2.6zM13 17.2h1.4M18.2 12.6v1.6" strokeWidth={1.8} />
      </>
    )}
  </Doodle>
);

/** 厨房：厨师帽 */
export const IconChef = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M10 18.8c-3.6-.4-5.6-3-4.8-5.8.8-2.8 3.8-3.8 6-2.6.8-3 3-4.6 5.4-4.4 2.4.2 4.2 2 4.6 4.4 2.4-1 5.2.4 5.6 3.2.4 2.6-1.4 4.8-4.4 5.2" fill={f} />
        <path d="M10 18.6c-.1 2.4-.1 4.6.1 6.6 4.2.4 8.4.4 12.2 0 .2-2.2.2-4.4 0-6.6" fill={f} />
        <path d="M10.4 21.6c3.8.4 7.6.3 11.6-.1" strokeWidth={1.8} />
      </>
    )}
  </Doodle>
);

/** 扫码：相机 */
export const IconCamera = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M5.4 11.4c.1-1.6 1-2.4 2.6-2.4h2.8l1.8-2.6c2.4-.2 5-.2 7.4 0l1.8 2.6h2.6c1.6 0 2.6.8 2.6 2.4.3 4.2.3 8.4 0 12.6-.1 1.4-1 2.2-2.6 2.2-5.6.3-11.2.3-16.6 0-1.6 0-2.4-.8-2.6-2.2-.3-4.2-.2-8.4.2-12.6Z" fill={f} />
        <path d="M16 13.2c2.6 0 4.4 1.8 4.4 4.2 0 2.6-1.8 4.4-4.4 4.4s-4.4-1.8-4.4-4.4c0-2.4 1.8-4.2 4.4-4.2Z" />
      </>
    )}
  </Doodle>
);

/** 我的：一张笑脸 */
export const IconMe = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M16.2 5.2c6.2 0 10.6 4.6 10.6 10.8 0 6.4-4.6 10.8-10.8 10.8-6.2 0-10.8-4.4-10.8-10.6C5.2 9.8 9.8 5.2 16.2 5.2Z" fill={f} />
        <path d="M11.8 13.6v1.4M20.2 13.4v1.4" strokeWidth={2.6} />
        <path d="M11 18.8c2.8 3 7.4 3.2 10.2 0" />
      </>
    )}
  </Doodle>
);

/** 跟柚子说：一封信 */
export const IconLetter = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M5.2 9.6c7.2-.6 14.4-.6 21.6 0 .3 4.4.3 8.8 0 13.2-7.2.6-14.4.6-21.6 0-.3-4.4-.3-8.8 0-13.2Z" fill={f} />
        <path d="M5.6 10.2c3.4 3 6.8 5.2 10.4 6.8 3.6-1.6 7.2-3.8 10.6-6.8" />
        <path d="M24.4 4.6c1.2.2 2 1.2 1.6 2.4-.4 1.2-2 2.2-3 2.6-.8-.8-1.8-2.2-1.6-3.4.2-1.2 1.6-1.8 3-1.6Z" strokeWidth={1.6} />
      </>
    )}
  </Doodle>
);

export const IconHeart = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => <path d="M16 26.2C8.8 21.6 4.6 17.4 5.2 12.4c.4-3.6 3.8-5.6 6.8-4.6 1.8.6 3.2 2 4 3.6.8-1.8 2.4-3.2 4.2-3.6 3.2-.8 6.4 1.4 6.6 5 .2 4.6-4 8.8-10.8 13.4Z" fill={f} />}
  </Doodle>
);

export const IconSparkle = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => <path d="M16 4.6c.6 5.6 2.4 8 8.6 9.4-6 1.6-8 3.6-8.6 9.6-.8-6-2.6-8-8.6-9.6 6-1.4 8-3.8 8.6-9.4Z" fill={f} />}
  </Doodle>
);

export const IconPhone = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M10.2 4.8c3.8-.3 7.8-.3 11.6 0 .5 7.4.5 14.8 0 22.4-3.8.3-7.8.3-11.6 0-.5-7.6-.5-15 0-22.4Z" fill={f} />
        <path d="M14.4 23.8h3.2" />
      </>
    )}
  </Doodle>
);

export const IconKey = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M11.2 9.6c3 0 5.2 2.2 5.2 5s-2.2 5-5.2 5-5-2.2-5-5 2-5 5-5Z" fill={f} />
        <path d="M16.2 15h10.2M22.6 15.2v3.6M25.6 15.2v2.6" />
      </>
    )}
  </Doodle>
);

export const IconDoor = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M8.4 26.4c-.3-6.8-.2-13.6.2-20.6 5-.4 10-.4 15 0 .4 7 .4 13.8.1 20.6" fill={f} />
        <path d="M5.6 26.6h20.8M19.2 16.4v.6" strokeWidth={2.6} />
      </>
    )}
  </Doodle>
);

export const IconPlay = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => <path d="M10.2 6.4c5.4 2.8 10 5.8 13.8 9.4-3.8 3.6-8.4 6.8-13.8 9.8-.6-6.4-.6-12.8 0-19.2Z" fill={f} />}
  </Doodle>
);

export const IconInstall = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M8.6 12.4c-.2 4.6-.1 9.2.3 13.6 4.8.3 9.6.3 14.4 0 .4-4.6.4-9.2.2-13.6" fill={f} />
        <path d="M16 4.6v13.8M11.4 14l4.6 4.6 4.8-4.8" />
      </>
    )}
  </Doodle>
);

/** 铃铛：饭点提醒（docs/CANTEEN.md 第 19 节），带两道晃动的线 */
export const IconBell = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M9.6 21.6c.6-2.6.6-5.4.8-8 .3-3.6 2.6-6 5.6-6.1 3 .1 5.4 2.5 5.7 6.1.2 2.6.2 5.4.8 8" fill={f} />
        <path d="M7 21.8c6-.5 12-.5 18 0M16 7.4V5.6" />
        <path d="M13.6 24.4c.4 1.6 1.3 2.4 2.4 2.4s2-.8 2.4-2.4" />
        <path d="M5.8 10.6c-.6 1.4-.8 2.8-.6 4.2M26.2 10.6c.6 1.4.8 2.8.6 4.2" strokeWidth={1.6} />
      </>
    )}
  </Doodle>
);

/** 喇叭：on 时带两道声波，关了是一个小叉（开场动画的声音开关） */
export const IconSound = ({ on = true, ...p }: IconProps & { on?: boolean }) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M5.2 12.6c1.6-.2 3.2-.2 4.8-.1l6.4-5.4c.4 6 .4 11.8 0 17.8l-6.4-5.2c-1.6.1-3.2.1-4.8-.1-.3-2.4-.3-4.6 0-7Z" fill={f} />
        {on ? (
          <>
            <path d="M20.4 12.2c1.4 2.4 1.4 5.2 0 7.6" />
            <path d="M23.8 9c3 4.4 3 9.6 0 14" />
          </>
        ) : (
          <>
            <path d="M20.6 12.6l6 6.4" />
            <path d="M26.6 12.4l-6 6.6" />
          </>
        )}
      </>
    )}
  </Doodle>
);

export const IconArrow = (p: IconProps) => (
  <Doodle {...p}>
    {() => (
      <>
        <path d="M5.4 16.4c6.6-.4 13-.6 20.4-.2" />
        <path d="M19.2 9.8c2.6 2.4 4.6 4.4 6.6 6.4-2.2 2-4.2 4-6.4 6.4" />
      </>
    )}
  </Doodle>
);

/** 工作台（8.0.9）：四个歪歪的小格子 */
export const IconWork = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M6.6 7.2c2.6-.3 5.2-.3 7.6 0 .3 2.4.3 4.8 0 7.4-2.6.2-5 .2-7.6 0-.2-2.6-.2-5 0-7.4Z" fill={f} />
        <path d="M18 7c2.6-.2 5.2-.2 7.6.2.2 2.4.2 4.8-.1 7.2-2.4.3-5 .3-7.4 0-.3-2.4-.3-4.8-.1-7.4Z" />
        <path d="M6.8 18c2.4-.3 5-.3 7.4 0 .3 2.4.3 4.8 0 7.4-2.4.2-5 .2-7.6-.1-.1-2.4 0-4.8.2-7.3Z" />
        <path d="M18.2 18.2c2.4-.3 5-.2 7.4.1.2 2.4.2 4.8-.1 7.2-2.6.2-5 .2-7.4 0-.2-2.4-.2-4.8.1-7.3Z" fill={f} />
      </>
    )}
  </Doodle>
);

/** 巡场（8.0.9）：一面盾牌、里面一个勾 */
export const IconShield = (p: IconProps) => (
  <Doodle {...p}>
    {(f) => (
      <>
        <path d="M16.2 4.8c3.2 2 6.4 2.8 9.6 2.8.4 7.6-1.8 15-9.8 19.8-7.8-4.6-10.2-12-9.6-19.6 3.4 0 6.6-1 9.8-3Z" fill={f} />
        <path d="M11.4 16.2c1.4 1.4 2.6 2.6 3.8 3.8 2.4-3 4.4-5.4 6.6-7.6" />
      </>
    )}
  </Doodle>
);

/** 标题下的一道手绘波浪线 */
export function Squiggle({ className, color = 'var(--color-yuzu)' }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 120 10" className={className} preserveAspectRatio="none" aria-hidden focusable="false">
      <path d="M2 6.5C12 2.5 20 9.5 30 5.5S48 2 58 6s18 2.5 28-1 18 3.5 32 0" fill="none" stroke={color} strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}
