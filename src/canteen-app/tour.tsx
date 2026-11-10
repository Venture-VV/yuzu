// 新手教程（docs/CANTEEN.md 第 15 节，K15）：登记好（或第一次登录）以后接着走，「我的」里能再走一遍。
// 柚子在旁边说话、指着要点的地方；要员工自己点一下才往下走（点别处不算），右上角能跳过。
// 页面上要指的东西带 data-tour="…"；聚光灯外面四块挡住点击，只有被指着的那一块点得到。
// 每一步开始时不在那一页就先跳过去，只跳这一次（「点一下」那一步员工自己点过去的页面不再被拉回来）；
// 要指的东西一会儿没出来，说话框先在屏幕中间出来（能「下一步」、能跳过），不会整屏挡着又什么都不显示。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canEditMenu, canScan, type CanteenRole } from '@shared/canteen';
import { Mascot, type Mood, type Pose } from './Mascot';
import { IconHeart } from './doodles';
import { Button, cn } from './ui';

export interface TourStep {
  id: string;
  /** 要指的东西（data-tour 的值）；没有的放在屏幕中间 */
  target?: string;
  /** 这一步在哪一页（不在就先跳过去） */
  route?: string;
  text: string;
  mood: Mood;
  pose: Pose;
  /** tap：点被指的东西才往下走；next：点「下一步」；like：在说话框里给示例菜点赞；finish：最后一步 */
  wait: 'tap' | 'next' | 'like' | 'finish';
}

const TOUR_KEY = 'yuzu.canteen.tour.v1';

export function tourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === 'done';
  } catch {
    return true;
  }
}
export function markTourDone() {
  try {
    localStorage.setItem(TOUR_KEY, 'done');
  } catch {
    /* 存不下就下次再走一遍 */
  }
}

/** 按角色排好的几步：员工 6 步，厨师多「厨房」，负责人多「扫码」 */
export function tourSteps(role: CanteenRole): TourStep[] {
  const steps: TourStep[] = [
    { id: 'home', route: 'home', target: 'focus-meal', text: '这里是首页：现在这一顿吃什么，一眼就能看到。', mood: 'happy', pose: 'point', wait: 'next' },
    { id: 'like', text: '喜欢哪道菜，就点一下爱心告诉厨师。来，给这道试试！', mood: 'yum', pose: 'bowl', wait: 'like' },
  ];
  if (canScan(role)) {
    steps.push({ id: 'scan', route: 'home', target: 'tab-scan', text: '你是食堂负责人：开饭时点中间的「扫码」，对准同事的饭卡码就打卡啦。', mood: 'wink', pose: 'point', wait: 'next' });
  } else {
    steps.push(
      { id: 'code', route: 'home', target: 'tab-code', text: '开饭时点中间的「饭卡码」，给食堂负责人扫一下就打卡啦。点一下试试！', mood: 'happy', pose: 'point', wait: 'tap' },
      { id: 'qr', route: 'code', target: 'meal-code', text: '码每 30 秒换一次，截图没用哦；没网也能亮。', mood: 'wink', pose: 'point', wait: 'next' },
    );
  }
  if (canEditMenu(role)) {
    steps.push({ id: 'kitchen', route: 'home', target: 'tab-kitchen', text: '在「厨房」写每天的菜单、发布给大家，还能看到每道菜收了几个赞。', mood: 'yum', pose: 'point', wait: 'next' });
  }
  steps.push(
    { id: 'talk', route: 'home', target: 'talk-entry', text: '想让柚子在汤崎的线上空间做什么、有什么碎碎念，都在这里跟我说！', mood: 'love', pose: 'point', wait: 'next' },
    { id: 'me', route: 'home', target: 'tab-me', text: '「我的」里能换头像、看这个月吃了几顿，还能再看一遍开场和这个教程。', mood: 'happy', pose: 'point', wait: 'next' },
    { id: 'done', route: 'home', text: '就这些啦！开饭愉快，好好吃饭～', mood: 'happy', pose: 'cheer', wait: 'finish' },
  );
  return steps;
}

type Rect = { top: number; left: number; width: number; height: number };
const PAD = 8;

function measure(target: string | undefined): Rect | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

const same = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1);

/** 要指的东西这么久还没出来，说话框先在屏幕中间出来（平时换页后一两百毫秒就找到了，不会闪一下） */
const BUBBLE_WAIT_MS = 600;
/** 等这么久还没出来，就说一声「这会儿没出来，先往下走吧」 */
const TARGET_WAIT_MS = 2500;

export function Tour({ steps, route, go, onClose }: { steps: TourStep[]; route: string; go: (route: string) => void; onClose: (finished: boolean) => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [liked, setLiked] = useState(false);
  const [slow, setSlow] = useState(false);
  const [missing, setMissing] = useState(false);
  const step = steps[index]!;
  const scrolled = useRef<string | null>(null);
  // 外壳每次重新渲染都给新的 steps、onClose：下面按这一步的编号算，最新的 onClose、页面从这里读
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const routeRef = useRef(route);
  routeRef.current = route;

  // 每一步先等要指的东西出来；等一会儿还没有，说话框先出来，等久了再说一声没出来
  // （不然整屏挡着、说话框和「跳过」都不出来，像卡住了）
  useEffect(() => {
    setSlow(false);
    setMissing(false);
    if (!step.target) return;
    const bubble = setTimeout(() => setSlow(true), BUBBLE_WAIT_MS);
    const timer = setTimeout(() => setMissing(true), TARGET_WAIT_MS);
    return () => {
      clearTimeout(bubble);
      clearTimeout(timer);
    };
  }, [step.id, step.target]);

  const next = useCallback(() => {
    setLiked(false);
    setRect(null);
    if (index >= steps.length - 1) {
      markTourDone();
      closeRef.current(true);
    } else setIndex(index + 1);
  }, [index, steps.length]);

  // 这一步要在哪一页：开始时不在就先过去。只在换步时跳一次——「点一下饭卡码」那一步，员工点过去以后、
  // 下一步接上之前页面已经换了，不能又把人拉回首页（来回跳一下，慢的手机上看着像卡住）
  useEffect(() => {
    if (step.route && routeRef.current !== step.route) go(step.route);
  }, [step.id, step.route, go]);

  // 找要指的东西（页面可能还在取数据：每 200 毫秒找一次），找到先滚到中间
  useLayoutEffect(() => {
    const find = () => {
      const r = measure(step.target);
      if (r && scrolled.current !== step.id) {
        scrolled.current = step.id;
        const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
        const fixed = el?.closest('nav');
        if (el && !fixed) {
          el.scrollIntoView({ block: 'center' });
          setRect(measure(step.target));
          return;
        }
      }
      setRect((old) => (same(old, r) ? old : r));
    };
    find();
    const timer = setInterval(find, 200);
    window.addEventListener('resize', find);
    window.addEventListener('scroll', find, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', find);
      window.removeEventListener('scroll', find, true);
    };
  }, [step.id, step.target]);

  // tap：等员工点被指的那一下（让页面先处理这次点击，再往下走）
  useEffect(() => {
    if (step.wait !== 'tap' || !step.target) return;
    const onClick = (e: MouseEvent) => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el && e.target instanceof Node && el.contains(e.target)) setTimeout(next, 60);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [step.id, step.wait, step.target, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const like = () => {
    if (liked) return;
    setLiked(true);
    setTimeout(next, 900);
  };

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const targetGone = !!step.target && !rect && missing;
  // 刚换步、要指的东西还没找到：先暗一下，不出说话框（一般一两百毫秒就找到了）
  const waitingForTarget = !!step.target && !rect && !slow;
  // 找了一会儿还没找到：说话框先在中间出来，「点一下」的那一步也给「下一步」
  const notYet = !!step.target && !rect && slow;
  const below = rect ? rect.top + rect.height / 2 < vh * 0.5 : false;
  const bubbleStyle: React.CSSProperties = rect
    ? below
      ? { top: Math.min(rect.top + rect.height + 14, vh - 260) }
      : { bottom: Math.min(vh - rect.top + 14, vh - 120) }
    : { top: '50%', transform: 'translateY(-50%)' };
  const shade = 'rgb(28 26 23 / 0.5)';

  return (
    // 外层不接点击：只有四块挡板和说话框接，聚光灯里那一块点得到下面的东西
    <div className="pointer-events-none fixed inset-0 z-[65]" data-testid="tour" data-step={step.id} aria-live="polite">
      {/* 聚光灯：四块挡板，中间露出被指的东西 */}
      {rect ? (
        <>
          <div className="pointer-events-auto absolute inset-x-0 top-0" style={{ height: Math.max(0, rect.top), background: shade }} />
          <div className="pointer-events-auto absolute inset-x-0 bottom-0" style={{ top: rect.top + rect.height, background: shade }} />
          <div className="pointer-events-auto absolute left-0" style={{ top: rect.top, height: rect.height, width: Math.max(0, rect.left), background: shade }} />
          <div className="pointer-events-auto absolute right-0" style={{ top: rect.top, height: rect.height, left: rect.left + rect.width, background: shade }} />
          {step.wait !== 'tap' && <div className="pointer-events-auto absolute" style={{ ...rect }} />}
          <div className="pointer-events-none absolute rounded-[22px]" style={{ ...rect, ['--sketch-color' as string]: 'var(--color-yuzu)' }} data-testid="tour-spotlight">
            <div className="sketch absolute inset-0 rounded-[22px]" style={{ ['--sketch-color' as string]: 'var(--color-yuzu)' }} />
            <div className="absolute inset-0 rounded-[22px] ring-4 ring-yuzu" style={{ animation: 'yz-ring 1.4s ease-out infinite' }} />
          </div>
        </>
      ) : (
        <div className="pointer-events-auto absolute inset-0" style={{ background: waitingForTarget ? 'rgb(28 26 23 / 0.25)' : shade, transition: 'background .2s' }} />
      )}

      {!waitingForTarget && (
        <div className="absolute inset-x-0 flex justify-center px-4" style={bubbleStyle}>
          <div className="sketch pointer-events-auto relative w-full max-w-[380px] rounded-[22px] bg-card p-4 shadow-[var(--shadow-pop)]" style={{ animation: 'yz-pop-in .3s both' }} key={step.id}>
            <div className="flex items-start gap-3">
              <Mascot pose={step.pose} mood={liked ? 'love' : step.mood} talking={false} className="h-24 w-auto shrink-0" title="柚子" />
              <div className="min-w-0 flex-1 pt-1">
                <p className="eyebrow">
                  Step {index + 1} / {steps.length}
                </p>
                <p className="mt-1 text-[16px] leading-relaxed font-bold text-ink">{step.text}</p>
                {targetGone && <p className="mt-1 text-[13px] text-ink-3">这一步要指的地方这会儿没出来，先往下走吧。</p>}
              </div>
            </div>
            {step.wait === 'like' && (
              <div className="mt-3 flex items-center gap-3 rounded-2xl bg-cream px-3 py-2.5 ring-1 ring-line" data-testid="tour-demo-dish">
                <span className="flex size-11 items-center justify-center rounded-2xl bg-card text-[24px]">🍅</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-bold">番茄炒蛋</p>
                  <p className="text-[12px] text-ink-3">示例，不会记进菜单</p>
                </div>
                <button
                  type="button"
                  onClick={like}
                  aria-pressed={liked}
                  aria-label="点赞：番茄炒蛋（示例）"
                  className={cn('flex h-10 min-w-16 items-center justify-center gap-1 rounded-full px-3 text-[14px] font-extrabold transition-all active:scale-90', liked ? 'bg-energy text-white' : 'bg-card text-ink-3 ring-1 ring-line-strong')}
                >
                  <span className={cn(liked && 'animate-pop')}>
                    <IconHeart size={20} fill={liked ? '#fff' : 'none'} />
                  </span>
                  <span className="num">{liked ? 13 : 12}</span>
                </button>
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              {step.wait !== 'finish' && (
                <button type="button" onClick={() => closeRef.current(false)} className="rounded-full px-2 py-1 text-[13px] font-bold text-ink-3 active:bg-cream-2" data-testid="tour-skip">
                  跳过教程
                </button>
              )}
              <span className="ml-auto" />
              {(step.wait === 'next' || (step.wait === 'tap' && notYet)) && (
                <Button onClick={next} data-testid="tour-next">
                  下一步
                </Button>
              )}
              {step.wait === 'tap' && !notYet && <span className="text-[13px] font-bold text-wood-deep">↑ 点一下亮着的地方</span>}
              {step.wait === 'like' && !liked && <span className="text-[13px] font-bold text-wood-deep">点一下爱心试试</span>}
              {step.wait === 'like' && liked && <span className="text-[13px] font-bold text-organic">厨师收到啦！</span>}
              {step.wait === 'finish' && (
                <Button big onClick={next} data-testid="tour-finish">
                  开始用吧
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {step.wait === 'finish' && <Confetti width={vw} />}
    </div>
  );
}

function Confetti({ width }: { width: number }) {
  const colors = ['#F2C230', '#937051', '#5D6B3B', '#B5532F', '#4E6B82'];
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[18%] flex justify-center" aria-hidden>
      {Array.from({ length: 18 }, (_, i) => {
        const angle = (i / 18) * Math.PI * 2;
        const dist = Math.min(width * 0.42, 170);
        return (
          <span
            key={i}
            className="absolute size-2.5 rounded-[3px]"
            style={{
              background: colors[i % colors.length],
              ['--cx' as string]: `${Math.cos(angle) * dist}px`,
              ['--cy' as string]: `${Math.sin(angle) * dist + 80}px`,
              ['--cr' as string]: `${(i % 2 ? 1 : -1) * (200 + i * 20)}deg`,
              animation: `yz-confetti 1.4s ${i * 0.02}s cubic-bezier(.2,.7,.4,1) both`,
            }}
          />
        );
      })}
    </div>
  );
}
