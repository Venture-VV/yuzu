import { cn } from '../lib/utils';

/** 品牌标识：松林绿底，柚黄的日/柚子从温泉水面升起 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-9', className)} aria-hidden>
      <rect width="64" height="64" rx="18" fill="var(--color-pine)" />
      <circle cx="32" cy="27" r="12" fill="var(--color-yuzu)" />
      <path
        d="M12 41c4.5-3.2 8.8-3.2 13.3 0s8.8 3.2 13.4 0 8.8-3.2 13.3 0"
        fill="none"
        stroke="var(--color-paper)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M17 50c3.7-2.6 7.3-2.6 11 0s7.3 2.6 11 0 7.3-2.6 8-2"
        fill="none"
        stroke="var(--color-paper)"
        strokeOpacity=".55"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 登录页插画：远山层叠、松林剪影、柚黄的日，以及温泉水面上缓慢升起的蒸汽。
 * 纯 SVG，随应用一起打包，离线可用。
 */
export function LandscapeIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 640 760" preserveAspectRatio="xMidYMax slice" className={className} aria-hidden>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8ecd0" />
          <stop offset="0.55" stopColor="#f3ead8" />
          <stop offset="1" stopColor="#eae4d5" />
        </linearGradient>
        <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f6cf55" stopOpacity="0.55" />
          <stop offset="1" stopColor="#f6cf55" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5f8a80" />
          <stop offset="1" stopColor="#2c6066" />
        </linearGradient>
      </defs>

      <rect width="640" height="760" fill="url(#sky)" />
      <circle cx="430" cy="250" r="190" fill="url(#glow)" />
      <circle cx="430" cy="250" r="62" fill="var(--color-yuzu)" />
      <circle cx="430" cy="250" r="62" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1.5" />

      {/* 远山 */}
      <path d="M0 420 L90 352 L160 388 L250 300 L340 372 L420 330 L520 392 L640 318 V760 H0Z" fill="#d6d6bf" />
      <path d="M0 470 L70 430 L150 456 L240 392 L320 446 L410 404 L500 452 L580 414 L640 440 V760 H0Z" fill="#aab68f" />
      <path d="M0 520 L110 470 L200 508 L300 456 L390 502 L470 470 L560 512 L640 486 V760 H0Z" fill="#7e9468" />

      {/* 松林剪影 */}
      <g fill="#3e5f4a">
        <path d="M40 560 L64 488 L88 560Z" />
        <path d="M74 566 L104 470 L134 566Z" />
        <path d="M120 566 L142 506 L164 566Z" />
        <path d="M486 560 L512 482 L538 560Z" />
        <path d="M528 566 L560 458 L592 566Z" />
        <path d="M584 566 L606 500 L628 566Z" />
      </g>
      <path d="M0 560 C120 548 220 572 320 566 C430 560 520 548 640 558 V760 H0Z" fill="var(--color-pine)" />

      {/* 温泉 */}
      <ellipse cx="320" cy="640" rx="250" ry="58" fill="url(#water)" />
      <g fill="none" stroke="#f6f3ec" strokeLinecap="round" strokeWidth="3" opacity=".7">
        <path d="M150 630 c22-10 44-10 66 0 s44 10 66 0" />
        <path d="M300 652 c22-10 44-10 66 0 s44 10 66 0" />
        <path d="M220 670 c18-8 36-8 54 0" opacity=".6" />
      </g>
      <g className="steam" fill="none" stroke="#fffdf8" strokeLinecap="round" strokeWidth="5" opacity=".85">
        <path d="M250 600 c-14-20 14-34 0-56" />
        <path d="M320 596 c-14-22 14-36 0-60" />
        <path d="M392 602 c-14-20 14-34 0-56" />
      </g>

      {/* 石块 */}
      <path d="M60 700 c10-26 60-34 92-18 c18 10 14 30-8 36 c-34 8-90 8-84-18Z" fill="#cfc6b3" />
      <path d="M500 708 c8-22 58-28 84-12 c14 8 8 26-12 30 c-30 6-78 4-72-18Z" fill="#c2b9a5" />
      <rect y="728" width="640" height="32" fill="#1a3a2d" />
    </svg>
  );
}
