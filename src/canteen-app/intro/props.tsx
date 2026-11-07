// 开场动画每一段的小道具（docs/CANTEEN.md 第 14 节）：手绘线条的 SVG，动画写在 styles.css（yz-*）。
// 都是装饰（aria-hidden），台词在对话框里。

import type { CSSProperties, ReactNode } from 'react';

// 颜色照汤崎品牌书：深胡桃的线、木与麻、柔和的柚黄（Pure）、Energy 橙、Relax 蓝、Organic 绿
const INK = '#4A3628';
const WOOD = '#937051';
const WOOD_DEEP = '#8A684A';
const LINEN = '#FBF6EE';
const YUZU = '#E9C75E';
const ENERGY = '#C04A1F';
const RELAX = '#4D718C';

const line = (w = 2.6, color = INK) => ({ stroke: color, strokeWidth: w, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' });

function Layer({ style, className, children }: { style: CSSProperties; className?: string; children: ReactNode }) {
  return (
    <div className={`pointer-events-none absolute ${className ?? ''}`} style={style} aria-hidden>
      {children}
    </div>
  );
}

/** 一笔一笔画出来：dasharray 设成路径长度，动画把 offset 拉到 0 */
const draw = (len: number, delay: number, dur = 0.9): CSSProperties => ({
  strokeDasharray: len,
  strokeDashoffset: len,
  animation: `yz-draw ${dur}s ${delay}s ease-out forwards`,
});

/** 1：从上面荡下来的小木牌「汤崎 TOUCHILL」 */
export function SignBoard() {
  return (
    <Layer style={{ left: '4%', top: '2%', width: 'min(40vw, 170px)', transformOrigin: '50% 0', animation: 'yz-pop-in .5s .15s both, yz-wiggle 3.4s 0.7s ease-in-out infinite' }}>
      <svg viewBox="0 0 220 120" className="w-full">
        <path d="M60 2L74 40M160 2L146 40" {...line(2.4, WOOD_DEEP)} />
        <path d="M18 42c60 -6 124 -6 184 0c4 22 4 42 0 62c-60 6 -124 6 -184 0c-4 -20 -4 -40 0 -62z" fill="#C4A67E" {...{ stroke: INK, strokeWidth: 2.8, strokeLinejoin: 'round' as const }} />
        <path d="M30 56c40 -3 70 -2 100 0M90 92c30 2 60 1 100 -2" {...line(1.6, WOOD)} />
        <text x="110" y="76" textAnchor="middle" fontSize="26" fontWeight="900" fill={INK} letterSpacing="6">
          汤崎
        </text>
        <text x="110" y="96" textAnchor="middle" fontSize="11" fontWeight="700" fill={WOOD_DEEP} letterSpacing="4.5" fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif">
          TOUCHILL
        </text>
      </svg>
    </Layer>
  );
}

/** 2：一座「线上的」小房子：线条一笔笔画出来，窗户一格一格亮起 */
export function BuildingSketch() {
  const windows: [number, number][] = [
    [52, 74],
    [86, 74],
    [120, 74],
    [52, 104],
    [86, 104],
    [120, 104],
  ];
  return (
    <Layer style={{ right: '2%', top: '4%', width: 'min(44vw, 190px)' }}>
      <svg viewBox="0 0 180 170" className="w-full">
        <path d="M20 58L90 12L160 58" {...line(3)} style={draw(190, 0.1)} />
        <path d="M32 54V148H148V54" {...line(3)} style={draw(320, 0.5)} />
        <path d="M80 148V122H100V148" {...line(2.6)} style={draw(70, 1.2, 0.4)} />
        {windows.map(([x, y], i) => (
          <g key={i}>
            <rect x={x} y={y} width="20" height="18" rx="3" fill="none" stroke={INK} strokeWidth="2.2" style={draw(80, 1.1 + i * 0.12, 0.35)} />
            <rect x={x + 2} y={y + 2} width="16" height="14" rx="2" fill={YUZU} opacity="0" style={{ animation: `yz-pop-in .3s ${1.8 + i * 0.22}s both` }} />
          </g>
        ))}
        {/* 小铅笔在画 */}
        <g style={{ animation: 'yz-float 1.2s ease-in-out infinite' }}>
          <path d="M150 20l18 -14l6 7l-18 14z" fill={YUZU} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          <path d="M150 20l-4 11l10 -4" fill={LINEN} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        </g>
        <g fill={WOOD}>
          {[0, 1, 2].map((i) => (
            <rect key={i} x={8 + i * 12} y={150 - i * 10} width="7" height="7" rx="1.5" style={{ animation: `yz-pop-in .3s ${2.6 + i * 0.2}s both` }} />
          ))}
        </g>
      </svg>
    </Layer>
  );
}

function Coin({ x, delay, flame }: { x: string; delay: number; flame?: boolean }) {
  return (
    <div className="absolute top-0" style={{ left: x, width: 38, animation: flame ? undefined : `yz-coin 1.8s ${delay}s cubic-bezier(.5,0,.9,.6) infinite` }}>
      <svg viewBox="0 0 40 52" className="w-full">
        {flame && (
          <path
            d="M20 2c6 6 9 11 6 16c4 -1 5 -4 5 -6c4 6 2 13 -5 15h-12c-7 -2 -9 -9 -5 -15c0 2 1 5 5 6c-3 -5 0 -10 6 -16z"
            fill="#F28B30"
            stroke={INK}
            strokeWidth="1.8"
            style={{ transformOrigin: '50% 100%', animation: `yz-flicker .5s ${delay}s ease-in-out infinite` }}
          />
        )}
        <ellipse cx="20" cy="36" rx="16" ry="14" fill={YUZU} stroke={INK} strokeWidth="2.4" />
        <ellipse cx="20" cy="36" rx="10.5" ry="9" fill="none" stroke="#B8932C" strokeWidth="1.8" />
        <text x="20" y="41" textAnchor="middle" fontSize="13" fontWeight="900" fill={INK} fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif">
          T
        </text>
      </svg>
    </div>
  );
}

/** 3：token 小金币一枚枚掉进柚子的碗里（落点是碗口：柚子身高的 27% 往上一点） */
export function TokenRain() {
  return (
    <Layer style={{ left: '36%', right: '36%', top: 0, bottom: 0, ['--land' as string]: 'calc(100% - min(48dvh, 350px) * 0.29 - 40px)' }}>
      <Coin x="0%" delay={0} />
      <Coin x="45%" delay={0.6} />
      <Coin x="20%" delay={1.2} />
      <Coin x="60%" delay={1.5} />
    </Layer>
  );
}

/** 4：「24h」的钟飞快地转，金币冒着小火苗 */
export function BurningClock() {
  return (
    <>
      <Layer style={{ left: '4%', top: '6%', width: 'min(34vw, 140px)' }}>
        <svg viewBox="0 0 140 140" className="w-full">
          <path d="M70 12c32 0 56 24 56 58s-24 58 -56 58s-58 -24 -58 -58s26 -58 58 -58z" fill={LINEN} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2;
            return <path key={i} d={`M${70 + Math.sin(a) * 46} ${70 - Math.cos(a) * 46}L${70 + Math.sin(a) * 52} ${70 - Math.cos(a) * 52}`} {...line(2.4)} />;
          })}
          <g style={{ transformOrigin: '70px 70px', animation: 'yz-spin .7s linear infinite' }}>
            <path d="M70 70V30" {...line(3.4)} />
          </g>
          <g style={{ transformOrigin: '70px 70px', animation: 'yz-spin 3s linear infinite' }}>
            <path d="M70 70H96" {...line(3.4, ENERGY)} />
          </g>
          <circle cx="70" cy="70" r="4" fill={INK} />
          <text x="70" y="106" textAnchor="middle" fontSize="18" fontWeight="900" fill={ENERGY} fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif">
            24h
          </text>
        </svg>
      </Layer>
      <Layer style={{ right: '6%', top: '10%', width: 'min(30vw, 120px)', height: 120 }}>
        <Coin x="0%" delay={0} flame />
        <Coin x="50%" delay={0.25} flame />
      </Layer>
    </>
  );
}

/** 5：头顶一团乱线（抓狂），旁边几个问号 */
export function ScribbleCloud() {
  return (
    <Layer style={{ left: '50%', top: '0%', width: 'min(60vw, 260px)', marginLeft: 'min(-30vw, -130px)' }}>
      <svg viewBox="0 0 260 120" className="w-full">
        <g style={{ transformOrigin: '130px 60px', animation: 'yz-wiggle .5s ease-in-out infinite' }}>
          <path
            d="M70 70c-30 -6 -20 -46 14 -40c6 -26 54 -28 62 -4c24 -14 58 6 44 32c26 6 18 42 -14 38c-8 22 -52 22 -60 2c-22 12 -56 -6 -46 -28z"
            {...line(3)}
            style={draw(600, 0, 0.7)}
          />
          <path d="M96 64c10 -20 40 -20 44 0c6 -16 30 -14 30 4c-10 12 -30 10 -36 -2c-8 14 -32 14 -38 -2z" {...line(2.4)} style={draw(260, 0.5, 0.6)} />
        </g>
        <text x="30" y="40" fontSize="30" fontWeight="900" fill={ENERGY} style={{ animation: 'yz-pop-in .3s .8s both' }}>
          ?
        </text>
        <text x="214" y="50" fontSize="26" fontWeight="900" fill={RELAX} style={{ animation: 'yz-pop-in .3s 1.1s both' }}>
          !?
        </text>
      </svg>
    </Layer>
  );
}

function Dish({ emoji, style }: { emoji: string; style: CSSProperties }) {
  return (
    <div className="absolute left-1/2 top-1/2 -ml-[26px] -mt-[26px]" style={style}>
      <div className="flex size-[52px] items-center justify-center rounded-full bg-card text-[28px] shadow-[3px_3px_0_rgb(92_70_57/.16)] ring-2 ring-wood-ink/70">{emoji}</div>
    </div>
  );
}

/** 6：一圈好吃的围着柚子转，冒爱心 */
export function Feast() {
  const dishes = ['🍲', '🍤', '🥟', '🍚', '🍜', '🍡'];
  return (
    <Layer style={{ left: 0, right: 0, top: '4%', height: '62%' }}>
      {dishes.map((d, i) => (
        <Dish
          key={d}
          emoji={d}
          style={{ ['--r' as string]: 'min(38vw, 150px)', animation: `yz-orbit 9s linear infinite`, animationDelay: `${-i * 1.5}s` }}
        />
      ))}
    </Layer>
  );
}

/** 7：「柚子食堂」的暖帘（Organic 绿，「食」）；open 时左右掀开 */
export function Noren({ open }: { open: boolean }) {
  const panels = ['柚', '子', '食', '堂'];
  return (
    <Layer style={{ left: '50%', top: '1%', width: 'min(84vw, 340px)', marginLeft: 'min(-42vw, -170px)', zIndex: 0 }}>
      <svg viewBox="0 0 340 50" className="block w-full">
        <path d="M6 26c110 -6 218 -6 328 0" {...line(7, WOOD_DEEP)} style={draw(340, 0, 0.6)} />
        <path d="M6 26c110 -6 218 -6 328 0" {...line(2.4)} style={draw(340, 0, 0.6)} />
      </svg>
      <div className="-mt-[14px] flex justify-center gap-[3px] px-[6%]">
        {panels.map((ch, i) => (
          <div
            key={ch}
            className="flex h-[min(28vw,118px)] flex-1 items-start justify-center rounded-b-[6px] border-[2.4px] border-wood-ink bg-organic pt-[10%] text-[min(9vw,38px)] font-black text-[#FBF6EE] shadow-[2px_3px_0_rgb(92_70_57/.2)]"
            style={{
              transformOrigin: i < 2 ? '0 0' : '100% 0',
              animation: open
                ? `${i < 2 ? 'yz-curtain-l' : 'yz-curtain-r'} .7s ${Math.abs(1.5 - i) * 0.08}s ease-in forwards`
                : `yz-pop-in .4s ${0.5 + i * 0.12}s both, yz-sway ${2.6 + i * 0.3}s ${1 + i * 0.2}s ease-in-out infinite`,
            }}
          >
            {ch}
          </div>
        ))}
      </div>
    </Layer>
  );
}

/** 开场里散落的星星（手绘的四角星） */
export function Twinkles() {
  const stars: [string, string, number, number][] = [
    ['8%', '30%', 0.9, 0],
    ['86%', '40%', 0.7, 0.6],
    ['14%', '58%', 0.6, 1.1],
    ['80%', '18%', 0.8, 1.5],
  ];
  return (
    <>
      {stars.map(([left, top, s, d]) => (
        <Layer key={`${left}${top}`} style={{ left, top, width: 26 * s }}>
          <svg viewBox="0 0 26 26" className="w-full" style={{ animation: `yz-twinkle 1.8s ${d}s ease-in-out infinite alternate` }}>
            <path d="M13 1c1 7 3 10 12 12c-9 2 -11 5 -12 12c-1 -7 -3 -10 -12 -12c9 -2 11 -5 12 -12z" fill={YUZU} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </Layer>
      ))}
    </>
  );
}
