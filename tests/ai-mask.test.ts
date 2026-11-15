// 发给模型之前的打码（8.0.22，docs/AI_V8022.md 第 0 节，MD7）：会员姓名只留姓，手机号只留前三后四，证件号去掉。
import { describe, expect, it } from 'vitest';
import { aiMaskName, aiMaskText, maskForAi } from '../src/server/modules/ai/mask';

describe('发给模型之前的打码', () => {
  it('会员姓名只留第一个字；手机号只留前三后四；文字里的手机号、证件号也打码', () => {
    expect(aiMaskName('张三')).toBe('张*');
    expect(aiMaskName('欧阳修')).toBe('欧*');
    expect(aiMaskName(' ')).toBe('');
    expect(aiMaskText('客人 13812345678 说明天来')).toBe('客人 138****5678 说明天来');
    expect(aiMaskText('证件 11010119900307123X 已核对')).toBe('证件 [证件号已隐去] 已核对');
    // 单号、日期、金额不动
    expect(aiMaskText('JZ20261115001 · 2026-11-15 · ¥1,234.50')).toBe('JZ20261115001 · 2026-11-15 · ¥1,234.50');
  });

  it('整个走一遍：按键名打码姓名、电话，别的文字里的号码也打码，数字原样', () => {
    const out = maskForAi({
      date: '2026-11-15',
      revenueCents: 123_450,
      top: [{ memberName: '李四', phone: '139 1234 5678', note: '让 13700001111 回电', amount: '¥99.00' }],
      guest_name: '王五',
      contactTel: '13600002222',
    });
    expect(out).toEqual({
      date: '2026-11-15',
      revenueCents: 123_450,
      top: [{ memberName: '李*', phone: '139****5678', note: '让 137****1111 回电', amount: '¥99.00' }],
      guest_name: '王*',
      contactTel: '136****2222',
    });
    const raw = JSON.stringify(out);
    for (const secret of ['李四', '王五', '13912345678', '13700001111', '13600002222']) expect(raw).not.toContain(secret);
  });
});
