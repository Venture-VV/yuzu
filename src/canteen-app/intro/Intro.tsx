// 开场动画（docs/CANTEEN.md 第 14 节，店主 2026-11-06 写的台词）：这台手机第一次打开柚子饭堂时放一遍，可以跳过；「我的」里能再看。
// 七段：柚子每段换一个动作和表情，旁边的小道具跟着变；字一个一个打出来（说话时嘴一张一合），点一下打完这句、再点下一句。
// 最后一段画出「柚子食堂」的暖帘，点「进门」暖帘掀开，接着是新同事登记（没登录的）或新手教程（已登录的）。
// 系统设了「减少动态效果」时字直接出来、柚子不动。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mascot, type Mood, type Pose } from '../Mascot';
import { IconArrow, IconDoor } from '../doodles';
import { cn } from '../ui';
import { BuildingSketch, BurningClock, Feast, Noren, ScribbleCloud, SignBoard, TokenRain, Twinkles } from './props';

type Scene = 'hello' | 'build' | 'tokens' | 'burn' | 'scribble' | 'feast' | 'door';

interface Beat {
  text: string;
  pose: Pose;
  mood: Mood;
  scene: Scene;
}

/** 店主写的台词，原样分成七段（连起来就是原文） */
export const INTRO_BEATS: readonly Beat[] = [
  { text: 'hi！欢迎加入汤崎，我是柚子，汤崎的小AI助理，', pose: 'wave', mood: 'happy', scene: 'hello' },
  { text: '目前我在搭建汤崎的线上数字化空间。', pose: 'point', mood: 'wink', scene: 'build' },
  { text: '感谢你的辛勤工作，为我带来足够的token，让我每天都能吃饱饱，', pose: 'bowl', mood: 'yum', scene: 'tokens' },
  { text: '目前我的能力还很弱，狂烧24小时token，能做到的事情依然很有限，', pose: 'rest', mood: 'oops', scene: 'burn' },
  { text: '我想，在汤崎工作的你，遇到难以克服的工作困难的时候，也会懊恼，也会抓耳挠腮。', pose: 'scratch', mood: 'worried', scene: 'scribble' },
  { text: '所以，我也希望你能每天也吃饱饱，吃到好吃的饭菜的时候，心情也会变得很好呀！', pose: 'bowl', mood: 'love', scene: 'feast' },
  { text: '所以，关于我与你的第一次接触，我想从我开的这家柚子食堂开始。', pose: 'point', mood: 'wink', scene: 'door' },
];

const CHAR_MS = 55;
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function SceneProps({ scene, opening }: { scene: Scene; opening: boolean }) {
  switch (scene) {
    case 'hello':
      return (
        <>
          <SignBoard />
          <Twinkles />
        </>
      );
    case 'build':
      return <BuildingSketch />;
    case 'tokens':
      return <TokenRain />;
    case 'burn':
      return <BurningClock />;
    case 'scribble':
      return <ScribbleCloud />;
    case 'feast':
      return <Feast />;
    case 'door':
      return <Noren open={opening} />;
  }
}

/**
 * cta：最后那个按钮上的字（没登录的「进门登记」，已登录的「进门」）。
 * onDone(skipped)：点了「进门」或「跳过」。
 */
export function Intro({ cta, onDone }: { cta: string; onDone: (skipped: boolean) => void }) {
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [opening, setOpening] = useState(false);
  const still = useRef(reduceMotion()).current;
  const beat = INTRO_BEATS[index]!;
  const chars = [...beat.text];
  const typing = shown < chars.length;
  const last = index === INTRO_BEATS.length - 1;

  // 字一个一个打出来：每次在当前的基础上加一个字（点一下打完以后，计时器不会把字又缩回去）
  useEffect(() => {
    const total = [...INTRO_BEATS[index]!.text].length;
    if (still) {
      setShown(total);
      return;
    }
    setShown(0);
    const timer = setInterval(() => {
      setShown((s) => {
        if (s >= total) {
          clearInterval(timer);
          return s;
        }
        return s + 1;
      });
    }, CHAR_MS);
    return () => clearInterval(timer);
    // 每段开始时重新打
  }, [index, still]);

  const finish = useCallback(() => {
    if (opening) return;
    setOpening(true);
    setTimeout(() => onDone(false), still ? 0 : 750);
  }, [opening, onDone, still]);

  const advance = useCallback(() => {
    if (opening) return;
    if (typing) return setShown(chars.length);
    if (last) return finish();
    setIndex((i) => Math.min(i + 1, INTRO_BEATS.length - 1));
  }, [opening, typing, chars.length, last, finish]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'Escape') {
        onDone(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, onDone]);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-cream" data-testid="intro" data-beat={index} role="dialog" aria-modal="true" aria-label="柚子的开场">
      {/* 顶上：第几段、跳过 */}
      <div className="safe-top mx-auto flex w-full max-w-[480px] items-center gap-3 px-4 pb-1">
        <p className="eyebrow">YUZU · 汤崎的小 AI 助理</p>
        <ol className="ml-auto flex gap-1.5" aria-label={`第 ${index + 1} 段，共 ${INTRO_BEATS.length} 段`}>
          {INTRO_BEATS.map((b, i) => (
            <li key={b.scene} className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-5 bg-wood-deep' : i < index ? 'w-1.5 bg-wood-3' : 'w-1.5 bg-line-strong')} />
          ))}
        </ol>
        <button type="button" onClick={() => onDone(true)} className="rounded-full px-3 py-1.5 text-[14px] font-bold text-ink-3 active:bg-cream-2" data-testid="intro-skip">
          跳过
        </button>
      </div>

      {/* 场景：点哪里都是「下一句」 */}
      <div className="relative mx-auto block w-full max-w-[480px] flex-1 cursor-pointer overflow-hidden" onClick={advance} role="presentation" data-testid="intro-stage">
        <div key={beat.scene} className="absolute inset-0">
          <SceneProps scene={beat.scene} opening={opening} />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-center">
          <div
            key={`${index}`}
            className="h-[min(48dvh,350px)] w-auto"
            style={{ animation: still ? undefined : index === 0 ? 'yz-hop-in .7s cubic-bezier(.3,1.4,.5,1) both' : 'yz-boing .55s cubic-bezier(.3,1.6,.5,1) both', transformOrigin: '50% 100%' }}
          >
            <Mascot pose={beat.pose} mood={beat.mood} talking={typing} className="h-full w-auto" title="柚子" />
          </div>
        </div>
      </div>

      {/* 对话框 */}
      <div className="safe-bottom mx-auto w-full max-w-[480px] px-4 pt-2">
        <div className="sketch relative rounded-[22px] bg-card px-5 pt-6 pb-4 shadow-[var(--shadow-sticker)]" onClick={advance} role="presentation">
          <span className="absolute -top-3.5 left-4 rounded-full bg-wood-deep px-3 py-1 text-[13px] font-black tracking-wide text-white shadow-[2px_2px_0_var(--color-wood-ink)]">柚子</span>
          <p className="min-h-[5.1em] text-[17px] leading-[1.7] font-semibold text-ink" aria-hidden>
            {chars.slice(0, shown).join('')}
            {typing && <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-wood" style={{ animation: 'yz-caret .8s steps(1) infinite' }} />}
          </p>
          <p className="sr-only" aria-live="polite">
            {beat.text}
          </p>
          <div className="mt-2 flex min-h-11 items-center justify-end">
            {last && !typing ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  finish();
                }}
                className="inline-flex h-11 items-center gap-2 rounded-2xl bg-wood-deep px-5 text-[16px] font-black text-white shadow-[0_4px_0_var(--color-wood-ink)] active:translate-y-[3px] active:shadow-[0_1px_0_var(--color-wood-ink)]"
                style={{ animation: still ? undefined : 'yz-pop-in .35s both' }}
                data-testid="intro-enter"
              >
                <IconDoor size={22} fill="var(--color-yuzu)" /> {cta}
              </button>
            ) : (
              <span className={cn('flex items-center gap-1 text-[13px] font-bold text-ink-3', !typing && 'animate-pulse')}>
                {typing ? '…' : '点一下继续'} {!typing && <IconArrow size={18} />}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
