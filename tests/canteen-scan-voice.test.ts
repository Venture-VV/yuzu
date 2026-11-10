// 扫码后柚子播报（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K21）：每一种结果念哪一句。不连数据库。
//   · 店主定的两句：扫码成功「扫码成功，可以开饭！」；认不出是汤崎的人「未识别到汤崎身份，不可开饭！」——
//     不是柚子饭堂的码、码对不上、码过期、这个人停用了、没有这位员工、照片里没找到二维码；
//   · 其余几种（店主 2026-11-10：照默认）：手动登记成功、已经打过卡、不在开饭时间、没网先记下、别的原因没登记上（不说成「不是汤崎的人」）。

import { describe, expect, it } from 'vitest';
import { SCAN_VOICE, SCAN_VOICE_KEYS, SCAN_VOICE_LINES, SCAN_VOICE_RECORDED, scanVoiceIndex, scanVoiceKey } from '../src/canteen-app/scan-voice';

const line = (...args: Parameters<typeof scanVoiceKey>) => SCAN_VOICE[scanVoiceKey(...args)];

describe('扫码后柚子念哪一句', () => {
  it('店主定的两句一字不差', () => {
    expect(line({ status: 'ok' })).toBe('扫码成功，可以开饭！');
    expect(line({ status: 'error', code: 'CODE_INVALID' })).toBe('未识别到汤崎身份，不可开饭！');
  });

  it('认不出是汤崎的人都念「未识别到汤崎身份，不可开饭！」', () => {
    for (const code of ['CODE_INVALID', 'CODE_EXPIRED', 'EMPLOYEE_INACTIVE', 'NOT_FOUND', 'NO_QR']) {
      expect(line({ status: 'error', code }), code).toBe('未识别到汤崎身份，不可开饭！');
    }
  });

  it('不是认人的问题不说成「不是汤崎的人」：不在开饭时间、没登记上的别的原因各念各的', () => {
    expect(line({ status: 'error', code: 'NOT_MEAL_TIME' })).toBe('现在不是开饭时间！');
    for (const code of ['CLOCK_AHEAD', 'SCAN_TOO_OLD', 'STORE', 'FORBIDDEN', 'BAD_REQUEST']) {
      expect(line({ status: 'error', code }), code).toBe('没登记上，请看一下手机。');
    }
  });

  it('已经打过卡、没网先记下、手动登记成功', () => {
    expect(line({ status: 'already' })).toBe('这一餐已经打过卡啦！');
    expect(line({ status: 'queued' })).toBe('已记下，联网后自动补登。');
    expect(line({ status: 'ok' }, true)).toBe('登记成功，可以开饭！');
    // 手动登记也会被拒（例如这个人刚停用）：照样念认不出
    expect(line({ status: 'error', code: 'EMPLOYEE_INACTIVE' }, true)).toBe('未识别到汤崎身份，不可开饭！');
  });

  it('交给 useYuzuVoice 的句子按名字排好；没放录音时都用手机自带的朗读', () => {
    expect(SCAN_VOICE_LINES).toHaveLength(SCAN_VOICE_KEYS.length);
    for (const k of SCAN_VOICE_KEYS) expect(SCAN_VOICE_LINES[scanVoiceIndex(k)]).toBe(SCAN_VOICE[k]);
    expect(SCAN_VOICE_RECORDED.every((u) => u === undefined)).toBe(true);
  });
});
