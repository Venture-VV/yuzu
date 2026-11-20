// 念一句话（8.1.15 排位播报，docs/TECHNICIANS_V8115.md 第 3 节）：用浏览器自带的朗读（Web Speech API）。
// 做法从员工食堂的「柚子的声音」（src/canteen-app/voice.ts）搬来：挑普通话的声音、留着朗读对象不让浏览器提前收掉、
// 声音列表要等一会儿才有。那边是另一个应用（单独打包，还管录音与开场动画的一句一句），各留一份。
//
// 浏览器要先点过一下页面才肯出声（自动播放的限制）：没点过的，speak 会报 not-allowed，这里记成 blocked，页面上提示点一下。
// 没有中文声音的设备也试着念（交给系统默认的声音，语言标成 zh-CN）；连朗读接口都没有的（supported 为假）念不了。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type VoiceLike = Pick<SpeechSynthesisVoice, 'lang' | 'name' | 'localService'>;

/** 从系统的声音里挑一个念中文的：普通话优先（台湾国语其次，粤语最后），女声名字优先，本机的优先；没有中文的返回 null */
function pickZhVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
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
    if (v.localService) score += 5;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

interface Speech {
  /** 这个浏览器有朗读接口 */
  supported: boolean;
  /** 找到了念中文的声音（没找到也会试着念，可能念不出来） */
  hasVoice: boolean;
  /** 正在念，或还有排着没念的 */
  speaking: boolean;
  /** 浏览器不让出声（还没点过页面）：要人点一下 */
  blocked: boolean;
  /** 念一句（排在正在念的后面，不打断）；volume 0–1 */
  speak: (text: string, volume: number) => void;
  /** 在点击里叫一下：让浏览器之后肯出声（念一个不出声的空句子） */
  prime: () => void;
  /** 停下、清掉排着的 */
  stop: () => void;
}

export function useSpeech(): Speech {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth()?.getVoices() ?? []);
  const [pending, setPending] = useState(0);
  const [blocked, setBlocked] = useState(false);
  // 留着引用：不然有的浏览器把朗读对象当垃圾收掉，念完不发 end
  const keep = useRef(new Set<SpeechSynthesisUtterance>());

  // 系统的声音列表常常要等一会儿才有（安卓 Chrome 要等 voiceschanged）
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

  const voice = useMemo(() => pickZhVoice(voices), [voices]);

  const speak = useCallback(
    (text: string, volume: number) => {
      const s = synth();
      if (!s || !text) return;
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? 'zh-CN';
      u.volume = Math.min(1, Math.max(0, volume));
      u.rate = 0.95;
      const done = () => {
        if (keep.current.delete(u)) setPending(keep.current.size);
      };
      u.onstart = () => setBlocked(false);
      u.onend = done;
      u.onerror = (e) => {
        if (e.error === 'not-allowed') setBlocked(true);
        done();
      };
      keep.current.add(u);
      setPending(keep.current.size);
      if (s.paused) s.resume();
      s.speak(u);
    },
    [voice],
  );

  const prime = useCallback(() => {
    const s = synth();
    if (!s) return;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      s.speak(u);
      setBlocked(false);
    } catch {
      /* 念不了就算了，到时候按「要点一下」处理 */
    }
  }, []);

  const stop = useCallback(() => {
    keep.current.clear();
    setPending(0);
    const s = synth();
    if (s && (s.speaking || s.pending)) s.cancel();
  }, []);

  // 离开页面时停下
  useEffect(() => stop, [stop]);

  return { supported: !!synth(), hasVoice: !!voice, speaking: pending > 0, blocked, speak, prime, stop };
}
