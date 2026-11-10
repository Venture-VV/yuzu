// 扫码后柚子播报（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K21）：负责人扫完一笔，柚子把结果念出来，不用低头看手机。
// 店主定的两句：扫码成功「扫码成功，可以开饭！」，认不出是汤崎的人「未识别到汤崎身份，不可开饭！」；其余几种情况（已经打过卡、
// 不在开饭时间、没网先记下、手动登记、别的原因没登记上）先按下面的默认念，待店主确认。
// 有录好的音频就放录音：放在 src/canteen-app/scan-voice/，按这一句的名字（ok.mp3、fail.mp3……，也认 .m4a、.ogg、.wav），
// 重新打包就带上；没有录音的用手机自带的朗读（与开场动画同一个声音，voice.ts）。开关在扫码页右上角，这台手机记住（默认开）。

export const SCAN_VOICE = {
  ok: '扫码成功，可以开饭！',
  manual: '登记成功，可以开饭！',
  fail: '未识别到汤崎身份，不可开饭！',
  already: '这一餐已经打过卡啦！',
  closed: '现在不是开饭时间！',
  queued: '已记下，联网后自动补登。',
  error: '没登记上，请看一下手机。',
  // 打开播报时念一句（不念「可以开饭」，免得旁边的人误会）
  hello: '柚子来播报扫码结果啦！',
} as const;
export type ScanVoiceKey = keyof typeof SCAN_VOICE;

export const SCAN_VOICE_KEYS = Object.keys(SCAN_VOICE) as ScanVoiceKey[];
/** 按 SCAN_VOICE_KEYS 的顺序排好的句子（交给 useYuzuVoice） */
export const SCAN_VOICE_LINES: readonly string[] = SCAN_VOICE_KEYS.map((k) => SCAN_VOICE[k]);
export const scanVoiceIndex = (key: ScanVoiceKey) => SCAN_VOICE_KEYS.indexOf(key);

/** 扫码播报的开关记在这台手机上（与开场动画的声音分开记） */
export const SCAN_VOICE_PREF = 'yuzu.canteen.scanVoice.v1';

/**
 * 认不出是汤崎的人：不是柚子饭堂的饭卡码、码对不上、码过期、这个人停用了、没有这位员工、照片里没找到二维码。
 * 不在开饭时间、手机时间不对、24 小时以前扫的、手机存不下记录这些不是认人的问题，念「没登记上」，看手机上写的原因。
 */
const NOT_RECOGNIZED = new Set(['CODE_INVALID', 'CODE_EXPIRED', 'EMPLOYEE_INACTIVE', 'NOT_FOUND', 'NO_QR']);

export type ScanShown = { status: 'ok' | 'already' | 'queued' } | { status: 'error'; code: string };

/** 这一笔该念哪一句：manual 是负责人手动登记的（不是扫码） */
export function scanVoiceKey(shown: ScanShown, manual = false): ScanVoiceKey {
  switch (shown.status) {
    case 'ok':
      return manual ? 'manual' : 'ok';
    case 'already':
      return 'already';
    case 'queued':
      return 'queued';
    default:
      if (NOT_RECOGNIZED.has(shown.code)) return 'fail';
      return shown.code === 'NOT_MEAL_TIME' ? 'closed' : 'error';
  }
}

// 录好的音频：文件名就是这一句的名字（打包时 Vite 按目录里有的文件生成地址；没有这个目录就是空的）
const RECORDED = import.meta.glob('./scan-voice/*.{mp3,m4a,ogg,wav}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const SCAN_VOICE_RECORDED: readonly (string | undefined)[] = SCAN_VOICE_KEYS.map(
  (k) => Object.entries(RECORDED).find(([path]) => path.endsWith(`/${k}.mp3`) || new RegExp(`/${k}\\.(m4a|ogg|wav)$`).test(path))?.[1],
);
