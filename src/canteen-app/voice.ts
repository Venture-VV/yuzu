// 柚子的声音（docs/CANTEEN.md 第 14 节，K19）：开场动画里柚子说的每一句都念出来。
// 有录好的音频就放录音：放在 src/canteen-app/intro/voice/，第几句就叫几（1.mp3 … 7.mp3，也认 .m4a、.ogg、.wav），
// 打包时自动带上；没有录音的句子用手机自带的朗读（Web Speech API）：挑普通话的女声，音调调高一点。
// 浏览器要先点过一下屏幕才肯出声（自动播放的限制）：没点过的那一句，等员工点一下再念（说话框里提示「点一下，听柚子说」）。
// 念不出来的手机（没有中文朗读、部分微信里）不显示声音开关，照常看字。关掉声音这台手机会记住。
// 扫码后柚子播报（店主 2026-11-10，第 18 节，K21）也用这一套：录音另放（scan-voice.ts），开关另记。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PREF_KEY = 'yuzu.canteen.voice.v1';

/** 这台手机有没有关掉柚子的声音（默认开）；prefKey 是记开关用的键（开场动画与扫码播报各记各的） */
export function voicePref(prefKey = PREF_KEY): boolean {
  try {
    return localStorage.getItem(prefKey) !== 'off';
  } catch {
    return true;
  }
}
function saveVoicePref(on: boolean, prefKey: string) {
  try {
    if (on) localStorage.removeItem(prefKey);
    else localStorage.setItem(prefKey, 'off');
  } catch {
    /* 存不下就下次还是开着 */
  }
}

// 录好的音频：文件名就是第几句（打包时 Vite 按目录里有的文件生成地址；没有这个目录就是空的）
const RECORDED = import.meta.glob('./intro/voice/*.{mp3,m4a,ogg,wav}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const recordedUrls: (string | undefined)[] = [];
for (const [path, url] of Object.entries(RECORDED)) {
  const n = Number(/\/(\d+)\.\w+$/.exec(path)?.[1]);
  if (Number.isInteger(n) && n >= 1) recordedUrls[n - 1] = url;
}

type VoiceLike = Pick<SpeechSynthesisVoice, 'lang' | 'name' | 'localService'>;

/** 从系统的声音里挑一个念中文的：普通话优先（台湾国语其次，粤语最后），女声名字优先，本机的优先；没有中文的返回 null */
export function pickVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
  let best: V | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const lang = v.lang.replace(/_/g, '-').toLowerCase();
    let score: number;
    if (lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-hans') || lang.startsWith('cmn')) score = 100;
    else if (lang === 'zh-tw' || lang.startsWith('zh-hant')) score = 60;
    else if (lang.startsWith('zh') || lang.startsWith('yue')) score = 40;
    else continue;
    const name = v.name.toLowerCase();
    if (/xiaoxiao|xiaoyi|xiaohan|xiaomo|xiaoxuan|xiaorui|tingting|ting-ting|meijia|huihui|yaoyao|lili|female|女/.test(name)) score += 20;
    else if (/yunxi|yunjian|yunyang|yunfeng|kangkang|\bmale\b|男/.test(name)) score -= 30;
    if (v.localService) score += 5;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

/** 浏览器已经点过（允许出声）：有 userActivation 的按它，没有的（老的 iPhone）当作没点过，先试一下 */
const activated = () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;

/** 有的浏览器（iPhone 没点过屏幕时）不出声也不报错：这么久还没开始念，就当作要员工点一下 */
const START_WAIT_MS = 2500;

export interface YuzuVoice {
  /** 这台手机念得出来（有录音，或有中文朗读；点着念也念不出来的，这次不再试） */
  available: boolean;
  /** 声音开着 */
  on: boolean;
  /** 正在念（柚子的嘴跟着动） */
  speaking: boolean;
  /** 浏览器不让出声（还没点过屏幕）：要员工点一下 */
  blocked: boolean;
  /** 第 i 句已经开始念（或正在等它开始） */
  heard: (i: number) => boolean;
  /** 在点击里念第 i 句（打断正在念的）：iPhone 要在点的那一下里第一次出声。点着念也念不出来的，这次不再试 */
  say: (i: number) => void;
  /** 没点过屏幕也试着念（例如从「我的」点「再看一遍」进来的，已经点过了）；浏览器不让就等员工点 */
  autoSay: (i: number) => void;
  stop: () => void;
  /** 开、关声音（打开时接着念第 i 句） */
  toggle: (i: number) => void;
  /**
   * 在点击里先让浏览器允许出声，不念任何一句（扫码播报用：结果是扫到码时才有的，不在点击里，
   * iPhone 要先在点的那一下里出过一声，之后才肯念）。念不出来的手机什么也不做。
   */
  prime: () => void;
}

export interface YuzuVoiceOptions {
  /** 第几句的录音地址（没有的句子用手机自带的朗读）；默认是开场动画的录音 */
  recorded?: readonly (string | undefined)[];
  /** 记开关用的键（默认开场动画的那一个） */
  prefKey?: string;
}

export function useYuzuVoice(lines: readonly string[], options: YuzuVoiceOptions = {}): YuzuVoice {
  const recorded = options.recorded ?? recordedUrls;
  const prefKey = options.prefKey ?? PREF_KEY;
  const [on, setOn] = useState(() => voicePref(prefKey));
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth()?.getVoices() ?? []);
  const [speaking, setSpeaking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [broken, setBroken] = useState(false);
  const said = useRef(-1);
  const seq = useRef(0);
  const keep = useRef<SpeechSynthesisUtterance | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  // 系统的声音列表常常要等一会儿才有（安卓 Chrome 要等 voiceschanged，iPhone 有时不发这个事件）
  useEffect(() => {
    const s = synth();
    if (!s) return;
    const update = () => setVoices(s.getVoices());
    s.addEventListener?.('voiceschanged', update);
    const timers = [300, 1200, 3000].map((ms) => setTimeout(update, ms));
    return () => {
      s.removeEventListener?.('voiceschanged', update);
      timers.forEach(clearTimeout);
    };
  }, []);

  const voice = useMemo(() => pickVoice(voices), [voices]);
  const available = !broken && (recorded.some(Boolean) || (!!synth() && !!voice));

  const stop = useCallback(() => {
    seq.current++;
    said.current = -1;
    keep.current = null;
    audio.current?.pause();
    const s = synth();
    if (s && (s.speaking || s.pending)) s.cancel();
    setSpeaking(false);
  }, []);

  /** gesture：在点击里念的——浏览器不该拦，念不出来就是这台手机念不了，这次不再试；不是点出来的念不了就等员工点一下 */
  const speak = useCallback(
    (i: number, gesture: boolean) => {
      const text = lines[i];
      stop();
      if (!text) return;
      const my = ++seq.current;
      said.current = i;
      let begun = false;
      const started = () => {
        begun = true;
        if (seq.current !== my) return;
        setSpeaking(true);
        setBlocked(false);
        setBroken(false);
      };
      const ended = () => {
        if (seq.current === my) setSpeaking(false);
      };
      const failed = () => {
        if (seq.current !== my) return;
        said.current = -1;
        setSpeaking(false);
        if (gesture) {
          setBroken(true);
          setBlocked(false);
        } else setBlocked(true);
      };
      setTimeout(() => !begun && failed(), START_WAIT_MS);

      const url = recorded[i];
      if (url) {
        const a = (audio.current ??= new Audio());
        a.src = url;
        a.onplaying = started;
        a.onended = ended;
        a.onerror = failed;
        a.play().catch(failed);
        return;
      }
      const s = synth();
      if (!s || !voice) return failed();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.pitch = 1.2;
      u.rate = 1.02;
      u.onstart = started;
      u.onend = ended;
      u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? ended() : failed());
      // 留着引用：不然有的浏览器把它当垃圾收掉，念完不发 end，柚子的嘴一直动
      keep.current = u;
      if (s.paused) s.resume();
      s.speak(u);
    },
    [lines, recorded, voice, stop],
  );
  const say = useCallback((i: number) => speak(i, true), [speak]);

  const primed = useRef(false);
  const prime = useCallback(() => {
    if (primed.current) return;
    primed.current = true;
    // 系统朗读：在点的这一下里念一个空句子（不出声），之后不在点击里的也肯念
    const s = synth();
    if (s && voice) {
      try {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        s.speak(u);
      } catch {
        /* 念不了就算了，到时候按「要点一下」处理 */
      }
    }
    // 录音：在点的这一下里让同一个播放器静音放一下再停，之后换着放不用再点
    const url = recorded.find(Boolean);
    if (url) {
      const a = (audio.current ??= new Audio());
      a.src = url;
      a.muted = true;
      a.play()
        .then(() => {
          a.pause();
          a.muted = false;
        })
        .catch(() => {
          a.muted = false;
        });
    }
  }, [recorded, voice]);

  const autoSay = useCallback(
    (i: number) => {
      if (activated() === false) {
        said.current = -1;
        setBlocked(true);
        return;
      }
      speak(i, false);
    },
    [speak],
  );

  const toggle = useCallback(
    (i: number) => {
      saveVoicePref(!on, prefKey);
      setOn(!on);
      if (on) {
        stop();
        setBlocked(false);
      } else say(i);
    },
    [on, prefKey, say, stop],
  );

  // 切到别的应用、锁屏时别再念；离开开场时停下
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && stop();
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      stop();
    };
  }, [stop]);

  const heard = useCallback((i: number) => said.current === i, []);
  return { available, on, speaking, blocked, heard, say, autoSay, stop, toggle, prime };
}
