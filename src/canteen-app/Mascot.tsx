// 看板娘「柚子」（docs/MASCOT.md）：浴族 yuzu 总被 AI 认成柚子，干脆就叫柚子——汤崎的小 AI 助理、柚子饭堂的老板娘。
// 手绘动画的样子：墨色描线带一点「抖动」（每秒换几次噪声种子，像一帧一帧重画的线），平涂两色的赛璐璐阴影。
// 头顶叠好的汤巾上坐着小柚子「柚柚」，米白浴衣、松林绿领口与前掛け（围裙上一个「柚」字），栗木色短发、柚子切片发夹。
//
// 表情 mood 与动作 pose 可以随意组合；talking 时嘴一张一合（开场动画说话用）。动画全用 SVG 自带的 SMIL，
// 管理后台与柚子饭堂两边都能用、不依赖页面的样式；系统设了「减少动态效果」或传 still 时一动不动（打印用）。
// 纯 SVG，随页面打包，离线也能显示。

import { useId, type ReactNode } from 'react';

export type Mood = 'happy' | 'yum' | 'sleepy' | 'oops' | 'wink' | 'worried' | 'love';
export type Pose = 'rest' | 'wave' | 'bowl' | 'point' | 'scratch' | 'cheer';

export const MOODS: readonly Mood[] = ['happy', 'yum', 'sleepy', 'oops', 'wink', 'worried', 'love'];
export const POSES: readonly Pose[] = ['rest', 'wave', 'bowl', 'point', 'scratch', 'cheer'];

const C = {
  ink: '#3A2A1F',
  skin: '#FFE7D6',
  skinShade: '#F6C9AF',
  hair: '#7A5233',
  hairShade: '#5C3B24',
  hairHi: '#A87F55',
  robe: '#FCF7EC',
  robeShade: '#E8DDC6',
  pine: '#24493A',
  pineShade: '#183428',
  pineHi: '#3D6B56',
  yuzu: '#F2C230',
  yuzuShade: '#D9A21C',
  yuzuHi: '#FFE38C',
  wood: '#937051',
  woodHi: '#C4A67E',
  woodShade: '#735539',
  irisDark: '#4A2A13',
  iris: '#C98A16',
  blush: '#F49A84',
  mouth: '#9C3A2E',
  tongue: '#F28A86',
  heart: '#E0604A',
  steam: '#D8CFBE',
  sweat: '#8FC9E6',
  white: '#FFFFFF',
} as const;

const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 描线的共同样式（圆头圆角，看起来像毛笔、马克笔画的） */
const line = (w = 3, color: string = C.ink) => ({ stroke: color, strokeWidth: w, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const });

export interface MascotProps {
  mood?: Mood;
  pose?: Pose;
  /** 说话：嘴一张一合 */
  talking?: boolean;
  /** 一动不动（打印、缩略图）；系统设了「减少动态效果」时也是这样 */
  still?: boolean;
  className?: string;
  title?: string;
}

export function Mascot({ mood = 'happy', pose = 'rest', talking = false, still = false, className, title }: MascotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const anim = !still && !reduceMotion();
  const id = (name: string) => `yz${uid}${name}`;
  return (
    <svg
      viewBox="0 0 240 320"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-mood={mood}
      data-pose={pose}
    >
      <defs>
        {/* 手绘线的抖动：噪声把描线推开一点点；动画时每 0.14 秒换一次噪声，像一帧一帧重画 */}
        <filter id={id('boil')} x="-6%" y="-6%" width="112%" height="112%">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves={2} seed={3} result="n">
            {anim && <animate attributeName="seed" values="3;11;23" dur="0.42s" calcMode="discrete" repeatCount="indefinite" />}
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <radialGradient id={id('yz')} cx="0.36" cy="0.3" r="0.8">
          <stop offset="0" stopColor={C.yuzuHi} />
          <stop offset="0.62" stopColor={C.yuzu} />
          <stop offset="1" stopColor={C.yuzuShade} />
        </radialGradient>
      </defs>
      <ellipse cx="120" cy="311" rx="62" ry="6.5" fill={C.ink} opacity="0.12" />
      <g filter={`url(#${id('boil')})`}>
        <g transform="translate(0 16)">
          {/* 整个人轻轻上下（呼吸） */}
          <g>
            {anim && <animateTransform attributeName="transform" type="translate" values="0 0;0 -3.5;0 0" dur="2.6s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
            <Body pose={pose} anim={anim} />
            <Head mood={mood} pose={pose} talking={talking} anim={anim} id={id} />
            <FrontArms pose={pose} anim={anim} />
          </g>
        </g>
      </g>
      <g transform="translate(0 16)">
        <Effects mood={mood} anim={anim} />
      </g>
    </svg>
  );
}

// ── 身体：脚、浴衣、前掛け、手 ──

function Body({ pose, anim }: { pose: Pose; anim: boolean }) {
  return (
    <g>
      {/* 后发（在身体后面） */}
      <path
        d="M46 128C42 70 80 38 120 38S198 70 194 128C193 162 187 188 177 204C169 200 163 194 159 186H81C77 194 71 200 63 204C53 188 47 162 46 128Z"
        fill={C.hair}
        {...line()}
      />
      <path d="M150 184C160 176 168 160 172 140" fill="none" {...line(2, C.hairShade)} />
      {/* 木屐与脚 */}
      <g>
        <rect x="88" y="286" width="28" height="8" rx="3" fill={C.wood} {...line(2.2)} />
        <rect x="124" y="286" width="28" height="8" rx="3" fill={C.wood} {...line(2.2)} />
        <ellipse cx="102" cy="283" rx="9" ry="5" fill={C.skin} {...line(2)} />
        <ellipse cx="138" cy="283" rx="9" ry="5" fill={C.skin} {...line(2)} />
      </g>
      {/* 脖子 */}
      <path d="M112 172V194H128V172Z" fill={C.skinShade} />
      {/* 浴衣 */}
      <path d="M86 190C76 214 70 248 70 280Q120 292 170 280C170 248 164 214 154 190Q120 182 86 190Z" fill={C.robe} {...line()} />
      <path d="M150 198C158 222 162 252 163 278Q156 281 149 282C151 252 149 224 143 200Z" fill={C.robeShade} />
      {/* 领口：左襟压右襟，松林绿的领 */}
      <path d="M104 190L120 222L136 190Z" fill={C.skin} />
      <path d="M137 187L146 191L121 231L114 226Z" fill={C.pine} {...line(2)} />
      <path d="M103 187L94 191L122 235L128 229Z" fill={C.pine} {...line(2)} />
      {/* 前掛け（店里的围裙）：松林绿，系柚黄的绳，中间一个「柚」字 */}
      <path d="M84 236H156L160 283Q120 291 80 283Z" fill={C.pine} {...line()} />
      <path d="M100 242L98 284M140 242L142 284" fill="none" {...line(1.6, C.pineShade)} />
      <path d="M82 236H158" fill="none" {...line(3.4, C.yuzu)} />
      <g transform="translate(82 238)">
        <path d="M0 0C-8 -6 -14 -2 -10 4C-6 8 -2 4 0 0Z" fill={C.yuzu} {...line(1.6)} />
        <path d="M0 0C-4 6 -6 12 -2 16M0 0C-8 4 -12 10 -10 14" fill="none" {...line(2.2, C.yuzuShade)} />
      </g>
      <circle cx="120" cy="261" r="13" fill={C.robe} {...line(2)} />
      <text
        x="120"
        y="266.5"
        textAnchor="middle"
        fontSize="15"
        fontWeight="900"
        fill={C.pine}
        fontFamily="'PingFang SC','HarmonyOS Sans SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif"
      >
        柚
      </text>
      <Arms pose={pose} anim={anim} />
    </g>
  );
}

/** 一只袖子 + 手：袖子是米白的宽袖，袖口一圈松林绿 */
function Sleeve({ d, cuff }: { d: string; cuff: string }) {
  return (
    <g>
      <path d={d} fill={C.robe} {...line()} />
      <path d={cuff} fill="none" {...line(3, C.pine)} />
    </g>
  );
}

const Hand = ({ x, y, r = 7.5 }: { x: number; y: number; r?: number }) => <circle cx={x} cy={y} r={r} fill={C.skin} {...line(2.2)} />;

function Arms({ pose, anim }: { pose: Pose; anim: boolean }) {
  const leftDown = <Sleeve d="M88 196C76 206 70 226 76 242C82 252 98 250 108 240C102 228 98 212 96 200Z" cuff="M78 246Q92 254 106 241" />;
  const rightDown = <Sleeve d="M152 196C164 206 170 226 164 242C158 252 142 250 132 240C138 228 142 212 144 200Z" cuff="M162 246Q148 254 134 241" />;
  switch (pose) {
    case 'rest':
      return (
        <g>
          {leftDown}
          {rightDown}
          <Hand x={112} y={239} />
          <Hand x={128} y={239} />
        </g>
      );
    case 'bowl':
      return (
        <g>
          {leftDown}
          {rightDown}
          <Bowl anim={anim} />
          <Hand x={99} y={241} />
          <Hand x={141} y={241} />
        </g>
      );
    case 'wave':
      // 举起来挥的那只手画在头前面（FrontArms）
      return (
        <g>
          {leftDown}
          <Hand x={106} y={240} />
        </g>
      );
    case 'point':
      return (
        <g>
          {leftDown}
          <Hand x={106} y={240} />
          <g>
            {anim && <animateTransform attributeName="transform" type="translate" values="0 0;5 0;0 0" dur="1.1s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
            <Sleeve d="M148 194C164 192 182 190 198 190C200 198 200 206 198 214C180 216 164 216 152 216C148 208 146 200 148 194Z" cuff="M197 190Q201 202 198 214" />
            <PointingHand x={210} y={201} />
          </g>
        </g>
      );
    case 'cheer':
      // 欢呼：两只手举过头，胳膊在大脑袋后面，只露出手和一截袖子
      return (
        <g>
          {anim && <animateTransform attributeName="transform" type="translate" values="0 0;0 -6;0 0" dur="0.6s" repeatCount="indefinite" calcMode="spline" keySplines="0.3 0 0.4 1;0.6 0 0.7 1" />}
          <Sleeve d="M92 198C70 176 50 140 38 104C44 98 52 96 58 98C70 132 88 164 108 188Z" cuff="M38 104Q48 94 58 98" />
          <OpenHand x={42} y={86} flip />
          <Sleeve d="M148 198C170 176 190 140 202 104C196 98 188 96 182 98C170 132 152 164 132 188Z" cuff="M202 104Q192 94 182 98" />
          <OpenHand x={198} y={86} />
        </g>
      );
    case 'scratch':
      return null;
  }
}

/** 画在头前面的胳膊：挥手的右手、抓耳挠腮的两只手 */
function FrontArms({ pose, anim }: { pose: Pose; anim: boolean }) {
  if (pose === 'wave') {
    return (
      <g>
        {anim && <animateTransform attributeName="transform" type="rotate" values="-6 150 200;10 150 200;-6 150 200" dur="0.9s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
        <Sleeve d="M146 194C158 182 170 166 178 150C184 154 190 158 196 160C190 180 176 200 160 212C154 206 150 200 146 194Z" cuff="M176 152Q186 160 196 161" />
        <OpenHand x={188} y={142} />
        <path d="M204 126q6 6 4 14M210 120q9 9 6 22" fill="none" {...line(2)} opacity="0.55" />
      </g>
    );
  }
  if (pose !== 'scratch') return null;
  // 抓耳挠腮：两只手在头两边挠，一上一下
  return (
    <g>
      <g>
        {anim && <animateTransform attributeName="transform" type="translate" values="0 0;0 -5;0 0" dur="0.28s" repeatCount="indefinite" />}
        <Sleeve d="M90 196C78 186 66 166 58 144C64 138 72 136 78 136C84 156 94 176 104 188Z" cuff="M58 144Q68 134 78 136" />
        <Hand x={62} y={122} r={8.5} />
      </g>
      <g>
        {anim && <animateTransform attributeName="transform" type="translate" values="0 -5;0 0;0 -5" dur="0.28s" repeatCount="indefinite" />}
        <Sleeve d="M150 196C162 186 174 166 182 144C176 138 168 136 162 136C156 156 146 176 136 188Z" cuff="M182 144Q172 134 162 136" />
        <Hand x={178} y={122} r={8.5} />
      </g>
      {/* 挠头的小弧线 */}
      <path d="M44 112q-6 8 -2 16M38 106q-9 12 -3 26M196 112q6 8 2 16M202 106q9 12 3 26" fill="none" {...line(2)} opacity="0.6" />
    </g>
  );
}

/** 张开的手（挥手、欢呼）：手掌 + 四个指头 + 大拇指 */
function OpenHand({ x, y, flip }: { x: number; y: number; flip?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})${flip ? ' scale(-1 1)' : ''}`}>
      <path
        d="M-8 4C-10 -2 -9 -8 -6 -11C-6 -15 -2 -16 0 -13C1 -17 5 -17 6 -13C8 -15 11 -13 10 -9C12 -9 13 -6 12 -3C12 3 8 9 1 10C-4 10 -7 8 -8 4Z"
        fill={C.skin}
        {...line(2.2)}
      />
      <path d="M-11 0C-13 -3 -12 -6 -9 -6" fill="none" {...line(2)} />
      <path d="M0 -12V-6M6 -12V-5" fill="none" {...line(1.4, C.skinShade)} />
    </g>
  );
}

/** 指着右边的手（新手教程里指路用） */
function PointingHand({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M-12 -8C-6 -11 2 -10 4 -8H16C19 -8 19 -3 16 -3H6C8 0 8 5 6 8C2 11 -8 11 -12 8C-15 4 -15 -4 -12 -8Z" fill={C.skin} {...line(2.2)} />
      <path d="M-2 -1H4M-3 4H4" fill="none" {...line(1.4, C.skinShade)} />
    </g>
  );
}

/** 端着的饭碗：白碗、松林绿的边、一碗米饭上卧一片柚子，冒热气 */
function Bowl({ anim }: { anim: boolean }) {
  return (
    <g>
      <Steam x={112} y={214} anim={anim} />
      <path d="M96 232Q102 212 120 213Q138 212 144 232Z" fill={C.white} {...line(2)} />
      <g fill={C.robeShade}>
        <ellipse cx="108" cy="224" rx="2" ry="1.2" />
        <ellipse cx="119" cy="219" rx="2" ry="1.2" />
        <ellipse cx="128" cy="226" rx="2" ry="1.2" />
      </g>
      <g transform="translate(131 219)">
        <circle r="7" fill={C.yuzu} {...line(1.8)} />
        <circle r="4.4" fill={C.yuzuHi} />
        <path d="M0 -4.4V4.4M-3.8 -2.2L3.8 2.2M-3.8 2.2L3.8 -2.2" fill="none" {...line(1, C.white)} />
      </g>
      <path d="M90 230Q92 268 120 270Q148 268 150 230Z" fill={C.white} {...line()} />
      <path d="M94 240Q120 250 146 240" fill="none" {...line(3, C.pine)} />
      <path d="M110 270H130L128 276H112Z" fill={C.robeShade} {...line(2)} />
    </g>
  );
}

/** 三缕热气，一缕接一缕往上飘 */
export function Steam({ x, y, anim, color = C.steam }: { x: number; y: number; anim: boolean; color?: string }) {
  return (
    <g fill="none" {...line(2.6, color)}>
      {[0, 11, 22].map((dx, i) => (
        <path key={dx} d={`M${x + dx} ${y}c-4 -4 4 -8 0 -13`} opacity={anim ? 0 : 0.8}>
          {anim && (
            <>
              <animate attributeName="opacity" values="0;0.85;0" dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" />
              <animateTransform attributeName="transform" type="translate" values="0 6;0 -12" dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" />
            </>
          )}
        </path>
      ))}
    </g>
  );
}

// ── 头：脸、五官、刘海、汤巾、柚柚 ──

const EYE_L = 93;
const EYE_R = 147;
const EYE_Y = 136;

function Head({ mood, pose, talking, anim, id }: { mood: Mood; pose: Pose; talking: boolean; anim: boolean; id: (n: string) => string }) {
  // 抓耳挠腮时头左右晃得快一点
  const sway = pose === 'scratch' ? { values: '-3 120 186;3 120 186;-3 120 186', dur: '0.56s' } : { values: '-1.6 120 186;1.6 120 186;-1.6 120 186', dur: '3.4s' };
  return (
    <g>
      {anim && <animateTransform attributeName="transform" type="rotate" values={sway.values} dur={sway.dur} repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
      {/* 脸 */}
      <path d="M62 124C62 88 88 66 120 66S178 88 178 124C178 158 154 182 120 182S62 158 62 124Z" fill={C.skin} {...line()} />
      {/* 刘海下的一条阴影（赛璐璐两色） */}
      <path d="M66 110C82 103 100 106 120 103C140 106 158 103 174 110V122C158 115 140 117 120 114C100 117 82 115 66 122Z" fill={C.skinShade} />
      <Blush />
      <Face mood={mood} talking={talking} anim={anim} />
      {/* 刘海 */}
      <path
        d="M50 128C44 72 82 42 120 42S196 72 190 128C186 116 181 107 174 101C175 109 174 115 171 121C166 109 158 101 148 97C149 105 147 111 143 117C138 106 130 99 121 97C119 105 115 111 109 115C107 105 99 99 89 98C90 106 88 112 84 118C79 108 72 102 66 100C62 108 60 115 58 122Z"
        fill={C.hair}
        {...line()}
      />
      <path d="M60 118C61 104 67 92 76 84C72 96 70 106 69 117Z" fill={C.hairShade} />
      <path d="M80 70Q90 60 101 55M136 54Q150 58 160 67" fill="none" {...line(4.4, C.hairHi)} />
      <path d="M98 59l5 1M138 57l5 1.5" fill="none" {...line(2.4, C.white)} opacity="0.6" />
      {/* 鬓发 */}
      <path d="M52 118C47 150 51 178 64 198C67 186 68 174 67 162C71 170 75 174 79 176C71 160 67 140 67 122Z" fill={C.hair} {...line(2.6)} />
      <path d="M188 118C193 150 189 178 176 198C173 186 172 174 173 162C169 170 165 174 161 176C169 160 173 140 173 122Z" fill={C.hair} {...line(2.6)} />
      {/* 呆毛：一片柚子叶的形状，跟着头晃 */}
      <g>
        {anim && <animateTransform attributeName="transform" type="rotate" values="-10 108 46;12 108 46;-10 108 46" dur="1.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
        <path d="M104 46C94 34 96 18 108 11C106 22 110 34 116 42Z" fill={C.hair} {...line(2.4)} />
      </g>
      {/* 柚子切片发夹 */}
      <g transform="translate(174 97)">
        <circle r="9.5" fill={C.yuzu} {...line(2.2)} />
        <circle r="6.4" fill={C.yuzuHi} />
        <path d="M0 -6.4V6.4M-5.5 -3.2L5.5 3.2M-5.5 3.2L5.5 -3.2" fill="none" {...line(1.3, C.white)} />
      </g>
      {/* 头顶：叠好的汤巾，两道松林绿条纹 */}
      <g transform="rotate(-8 120 40)">
        <rect x="83" y="30" width="74" height="19" rx="8" fill={C.white} {...line(2.6)} />
        <path d="M96 32V47M144 32V47" fill="none" {...line(3, C.pine)} />
        <path d="M100 39H140" fill="none" {...line(1.4, C.robeShade)} />
      </g>
      <Yuyu mood={mood} anim={anim} id={id} />
    </g>
  );
}

/** 柚柚：坐在汤巾上的小柚子，表情跟着柚子一起变 */
function Yuyu({ mood, anim, id }: { mood: Mood; anim: boolean; id: (n: string) => string }) {
  const closed = mood === 'yum' || mood === 'sleepy' || mood === 'worried' || mood === 'love';
  return (
    <g>
      {anim && <animateTransform attributeName="transform" type="rotate" values="-7 128 32;7 128 32;-7 128 32" dur="2.6s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
      <path d="M129 2c1 -5 5 -8 10 -7" fill="none" {...line(2.4, C.wood)} />
      <circle cx="128" cy="18" r="15" fill={`url(#${id('yz')})`} {...line(2.6)} />
      <path d="M130 4c4 -8 13 -10 20 -7c-3 7 -12 10 -20 7z" fill="#5E9B5E" {...line(1.8)} />
      {closed ? (
        <path d="M119 18q3.5 -3 7 0M130 18q3.5 -3 7 0" fill="none" {...line(1.8)} />
      ) : (
        <g fill={C.ink}>
          <circle cx="122.5" cy="17.5" r="2" />
          <circle cx="133.5" cy="17.5" r="2" />
        </g>
      )}
      {mood === 'oops' || mood === 'worried' ? (
        <path d="M124 24q2 -2 4 0t4 0" fill="none" {...line(1.5)} />
      ) : (
        <path d="M125 22q3 3 6 0" fill="none" {...line(1.6)} />
      )}
      <ellipse cx="118.5" cy="22" rx="2.6" ry="1.5" fill={C.blush} opacity="0.6" />
      <ellipse cx="137.5" cy="22" rx="2.6" ry="1.5" fill={C.blush} opacity="0.6" />
    </g>
  );
}

function Blush() {
  return (
    <g>
      <ellipse cx="74" cy="157" rx="11" ry="6" fill={C.blush} opacity="0.45" />
      <ellipse cx="166" cy="157" rx="11" ry="6" fill={C.blush} opacity="0.45" />
      <path d="M67 159l3 -5M73 159l3 -5M79 159l3 -5M161 159l3 -5M167 159l3 -5M173 159l3 -5" fill="none" {...line(1.6, '#E8705C')} opacity="0.55" />
    </g>
  );
}

/** 睁开的眼睛：深色的瞳孔、下半圈琥珀色、两个高光；动画时每隔几秒眨一下 */
function OpenEye({ cx, small, anim }: { cx: number; small?: boolean; anim: boolean }) {
  const cy = EYE_Y;
  if (small) {
    return (
      <g>
        <circle cx={cx} cy={cy} r="11" fill={C.white} {...line(2.8)} />
        <circle cx={cx} cy={cy + 1} r="3.8" fill={C.ink} />
      </g>
    );
  }
  const out = cx < 120 ? -1 : 1;
  return (
    <g>
      <g>
        {anim && <animate attributeName="opacity" values="1;1;0;1" keyTimes="0;0.93;0.955;1" dur="4.6s" repeatCount="indefinite" />}
        <ellipse cx={cx} cy={cy} rx="12.5" ry="15.5" fill={C.irisDark} />
        <path d={`M${cx - 11.5} ${cy + 2}Q${cx} ${cy + 19} ${cx + 11.5} ${cy + 2}Q${cx} ${cy + 9} ${cx - 11.5} ${cy + 2}Z`} fill={C.iris} />
        <ellipse cx={cx} cy={cy + 1} rx="5.6" ry="7.2" fill="#24130A" />
        <circle cx={cx - 4.5} cy={cy - 6} r="4.6" fill={C.white} />
        <circle cx={cx + 4.5} cy={cy + 7} r="2" fill={C.white} opacity="0.9" />
        <path d={`M${cx - 15} ${cy - 8}Q${cx} ${cy - 22} ${cx + 15} ${cy - 8}`} fill="none" {...line(4.6)} />
        <path d={`M${cx + out * 13} ${cy - 10}l${out * 6} -4`} fill="none" {...line(3)} />
      </g>
      {anim && (
        // 眨眼那一下：一条弯弯的线
        <path d={`M${cx - 12} ${cy + 1}Q${cx} ${cy + 6} ${cx + 12} ${cy + 1}`} fill="none" {...line(4)} opacity="0">
          <animate attributeName="opacity" values="0;0;1;0" keyTimes="0;0.93;0.955;1" dur="4.6s" repeatCount="indefinite" />
        </path>
      )}
    </g>
  );
}

const HappyEye = ({ cx }: { cx: number }) => <path d={`M${cx - 11} ${EYE_Y + 3}Q${cx} ${EYE_Y - 11} ${cx + 11} ${EYE_Y + 3}`} fill="none" {...line(4.4)} />;
const SleepyEye = ({ cx }: { cx: number }) => (
  <g fill="none" {...line(4)}>
    <path d={`M${cx - 11} ${EYE_Y}Q${cx} ${EYE_Y + 7} ${cx + 11} ${EYE_Y}`} />
    <path d={`M${cx + (cx < 120 ? -9 : 9)} ${EYE_Y + 3}l${cx < 120 ? -4 : 4} 3`} />
  </g>
);
/** 挤成 > < 的眼睛（抓耳挠腮、眨眼的那一只） */
const SqueezeEye = ({ cx, dir }: { cx: number; dir: 1 | -1 }) => (
  <path d={`M${cx - dir * 10} ${EYE_Y - 7}L${cx + dir * 9} ${EYE_Y}L${cx - dir * 10} ${EYE_Y + 7}`} fill="none" {...line(4.2)} />
);
const HeartEye = ({ cx }: { cx: number }) => (
  <path d={`M${cx} ${EYE_Y + 10}C${cx - 16} ${EYE_Y - 1} ${cx - 10} ${EYE_Y - 14} ${cx} ${EYE_Y - 5}C${cx + 10} ${EYE_Y - 14} ${cx + 16} ${EYE_Y - 1} ${cx} ${EYE_Y + 10}Z`} fill={C.heart} {...line(2.4)} />
);

function mouthOf(mood: Mood): ReactNode {
  switch (mood) {
    case 'yum':
      return (
        <g>
          <path d="M108 160q6 6 12 0q6 6 12 0" fill="none" {...line(2.8)} />
          <path d="M124 162q1 8 6 7q4 -1 2 -8z" fill={C.tongue} {...line(1.4)} />
        </g>
      );
    case 'sleepy':
      return <ellipse cx="120" cy="164" rx="3.6" ry="3" fill={C.mouth} {...line(1.6)} />;
    case 'oops':
      return <path d="M106 165q3.5 -5 7 0t7 0 7 0 7 0" fill="none" {...line(2.8)} />;
    case 'worried':
      return <path d="M104 166l4 -4 4 4 4 -4 4 4 4 -4 4 4 4 -4 4 4" fill="none" {...line(2.6)} />;
    case 'wink':
      return (
        <g>
          <path d="M108 157Q120 170 132 157" fill="none" {...line(2.8)} />
          <path d="M118 163q0 9 6 9t6 -9q-6 2 -12 0z" fill={C.tongue} {...line(1.4)} />
        </g>
      );
    default:
      // happy、love：张嘴笑
      return (
        <g>
          <path d="M107 157Q120 177 133 157Z" fill={C.mouth} {...line(2.4)} />
          <path d="M113 166q7 6 14 0q-7 -4 -14 0z" fill={C.tongue} />
        </g>
      );
  }
}

function Face({ mood, talking, anim }: { mood: Mood; talking: boolean; anim: boolean }) {
  let eyes: ReactNode;
  switch (mood) {
    case 'yum':
      eyes = (
        <>
          <HappyEye cx={EYE_L} />
          <HappyEye cx={EYE_R} />
        </>
      );
      break;
    case 'sleepy':
      eyes = (
        <>
          <SleepyEye cx={EYE_L} />
          <SleepyEye cx={EYE_R} />
        </>
      );
      break;
    case 'oops':
      eyes = (
        <>
          <OpenEye cx={EYE_L} small anim={anim} />
          <OpenEye cx={EYE_R} small anim={anim} />
        </>
      );
      break;
    case 'wink':
      eyes = (
        <>
          <SqueezeEye cx={EYE_L} dir={1} />
          <OpenEye cx={EYE_R} anim={anim} />
        </>
      );
      break;
    case 'worried':
      eyes = (
        <>
          <SqueezeEye cx={EYE_L} dir={1} />
          <SqueezeEye cx={EYE_R} dir={-1} />
        </>
      );
      break;
    case 'love':
      eyes = (
        <>
          <HeartEye cx={EYE_L} />
          <HeartEye cx={EYE_R} />
        </>
      );
      break;
    default:
      eyes = (
        <>
          <OpenEye cx={EYE_L} anim={anim} />
          <OpenEye cx={EYE_R} anim={anim} />
        </>
      );
  }
  const brows =
    mood === 'oops' || mood === 'worried' ? (
      <g fill="none" {...line(3, C.hairShade)}>
        <path d="M80 112l15 5" />
        <path d="M160 112l-15 5" />
      </g>
    ) : (
      <g fill="none" {...line(3, C.hairShade)}>
        <path d="M83 115q9 -5 18 -1" />
        <path d="M139 114q9 -4 18 1" />
      </g>
    );
  const mouth = mouthOf(mood);
  return (
    <g>
      {brows}
      {eyes}
      {talking && anim ? (
        <>
          <g>
            <animate attributeName="opacity" values="1;0" dur="0.36s" calcMode="discrete" repeatCount="indefinite" />
            {mouth}
          </g>
          <g opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.36s" calcMode="discrete" repeatCount="indefinite" />
            <ellipse cx="120" cy="163" rx="6.5" ry="7.5" fill={C.mouth} {...line(2.4)} />
            <ellipse cx="120" cy="167" rx="4" ry="2.4" fill={C.tongue} />
          </g>
        </>
      ) : (
        mouth
      )}
    </g>
  );
}

// ── 表情的小特效：星星、Zz、汗、爱心、抓狂的线团 ──

function Sparkle({ x, y, s = 1, color = C.yuzu, delay = 0, anim }: { x: number; y: number; s?: number; color?: string; delay?: number; anim: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M0 -9C1 -3 3 -1 9 0C3 1 1 3 0 9C-1 3 -3 1 -9 0C-3 -1 -1 -3 0 -9Z" fill={color} {...line(1.4)}>
        {anim && <animate attributeName="opacity" values="0.35;1;0.35" dur="1.8s" begin={`${delay}s`} repeatCount="indefinite" />}
      </path>
    </g>
  );
}

function Heart({ x, y, s = 1, anim, delay = 0 }: { x: number; y: number; s?: number; anim: boolean; delay?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <g>
        {anim && (
          <>
            <animateTransform attributeName="transform" type="translate" values="0 4;0 -14" dur="2.2s" begin={`${delay}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0;1;0" dur="2.2s" begin={`${delay}s`} repeatCount="indefinite" />
          </>
        )}
        <path d="M0 8C-12 0 -8 -10 0 -4C8 -10 12 0 0 8Z" fill={C.heart} {...line(1.6)} />
      </g>
    </g>
  );
}

function Effects({ mood, anim }: { mood: Mood; anim: boolean }) {
  switch (mood) {
    case 'happy':
      return (
        <g>
          <Sparkle x={204} y={112} anim={anim} />
          <Sparkle x={36} y={96} s={0.7} delay={0.9} anim={anim} />
        </g>
      );
    case 'wink':
      return (
        <g>
          <Sparkle x={202} y={126} anim={anim} />
          <Sparkle x={38} y={88} s={0.6} color={C.pine} delay={0.9} anim={anim} />
        </g>
      );
    case 'yum':
      return (
        <g>
          <Heart x={198} y={100} anim={anim} />
          <Sparkle x={40} y={100} s={0.7} delay={0.6} anim={anim} />
        </g>
      );
    case 'love':
      return (
        <g>
          <Heart x={200} y={98} anim={anim} />
          <Heart x={40} y={106} s={0.8} delay={0.7} anim={anim} />
          <Heart x={186} y={64} s={0.6} delay={1.4} anim={anim} />
        </g>
      );
    case 'sleepy':
      return (
        <g fill={C.pine} fontFamily="system-ui, sans-serif" fontWeight="800">
          {anim && <animateTransform attributeName="transform" type="translate" values="0 0;4 -6;0 0" dur="2.4s" repeatCount="indefinite" />}
          <text x="186" y="90" fontSize="20">
            Z
          </text>
          <text x="206" y="70" fontSize="13">
            z
          </text>
        </g>
      );
    case 'oops':
      return (
        <g>
          <Sweat x={190} y={100} anim={anim} />
          <path d="M66 100l-8 -6M60 110l-10 -2" fill="none" {...line(3)} opacity="0.6" />
        </g>
      );
    case 'worried':
      return (
        <g>
          <Sweat x={192} y={112} anim={anim} />
          {/* 头顶一团乱线（抓狂） */}
          <g transform="translate(196 30)">
            <g>
              {anim && <animateTransform attributeName="transform" type="rotate" values="0;360" dur="2.4s" repeatCount="indefinite" />}
              <path d="M-4 -10c-10 -2 -16 8 -8 14c8 6 20 -2 14 -12c-6 -10 -24 -6 -22 8c2 14 26 14 28 0c2 -12 -10 -18 -18 -12" fill="none" {...line(2.6)} />
            </g>
          </g>
        </g>
      );
  }
}

function Sweat({ x, y, anim }: { x: number; y: number; anim: boolean }) {
  return (
    <path d={`M${x} ${y}c5 7 6 11 3 14s-9 1 -7 -5z`} fill={C.sweat} {...line(1.8)}>
      {anim && <animateTransform attributeName="transform" type="translate" values="0 -3;0 6" dur="1.4s" repeatCount="indefinite" />}
    </path>
  );
}
