// 刷卡带出牌号：读卡器、扫码枪一口气打进来的一串怎么认（@shared/frontdesk-risk 的 resolveScan，TagCardInput 在输入框里、输入框外都用它）。
// Codex 审查 d12390f 的 P2：芯片号也可能「像」某张牌——芯片 00000001 绑在 A002，手牌池有 A001，按数字比较「00000001」配得上 A001；
// 以前先认牌号，刷 A002 的卡反而选中了 A001。现在先按芯片号查绑定，没绑定的、本身是牌号的才当牌号。不要数据库。

import { describe, expect, it } from 'vitest';
import { matchTags } from '../src/shared/frontdesk';
import { resolveScan, type TagByCard } from '../src/shared/frontdesk-risk';

const POOL = [{ code: 'A001' }, { code: 'A002' }, { code: 'B023' }];
/** 发卡台的认法：手牌池里模糊对得上（末位、数字）就算牌号 */
const fuzzy = (code: string) => matchTags(POOL, code).length > 0;

const A002 = {
  found: true,
  cardUid: '00000001',
  tag: { id: 2, code: 'A002', zone: 'male', kind: 'normal', vipLevel: null, locked: false, lockReason: null, active: true },
  state: 'free',
  visit: null,
} as const satisfies TagByCard;

/** 假的「按芯片号查」：只有 00000001 绑着 A002；记下查过哪些 */
function binder() {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (uid: string): Promise<TagByCard> => {
      asked.push(uid);
      return uid === '00000001' ? A002 : { found: false, cardUid: uid };
    },
  };
}

describe('读卡器打进来的一串：先按芯片号查绑定，没绑定才当牌号', () => {
  it('芯片号「像」另一张牌（00000001 配得上 A001）：照样选中绑着的 A002', async () => {
    expect(fuzzy('00000001')).toBe(true);
    const b = binder();
    const r = await resolveScan('00000001', { lookup: b.lookup, isTagCode: fuzzy, tagFallback: true });
    expect(r).toMatchObject({ kind: 'card', found: { tag: { code: 'A002' } } });
    expect(b.asked).toEqual(['00000001']);
    // 读卡器报的写法不一（带分隔符、小写）：照样按芯片号查
    expect(await resolveScan('00:00:00:01', { lookup: b.lookup, isTagCode: fuzzy, tagFallback: true })).toMatchObject({ kind: 'card' });
  });

  it('没有绑定：扫进来的本身是牌号（扫了印着牌号的码）当牌号用；不是牌号的写明没绑', async () => {
    const b = binder();
    expect(await resolveScan('b023', { lookup: b.lookup, isTagCode: fuzzy, tagFallback: true })).toEqual({ kind: 'tag', code: 'B023' });
    expect(b.asked).toEqual(['B023']);
    expect(await resolveScan('E2E9F00D1', { lookup: b.lookup, isTagCode: fuzzy, tagFallback: true })).toEqual({ kind: 'unbound', uid: 'E2E9F00D1' });
    // 按牌号格式认（房态中心的默认认法）：00000002 不是牌号格式，没绑就是没绑
    const strict = (code: string) => /^[A-Z]{0,2}[0-9]{1,5}$/.test(code);
    expect(await resolveScan('00000002', { lookup: b.lookup, isTagCode: strict, tagFallback: true })).toEqual({ kind: 'unbound', uid: '00000002' });
  });

  it('桥报上来的一定是芯片号：没绑定也不当牌号猜；不像芯片号的写明没读全', async () => {
    const b = binder();
    expect(await resolveScan('B023', { lookup: b.lookup, isTagCode: fuzzy, tagFallback: false })).toEqual({ kind: 'unbound', uid: 'B023' });
    expect(await resolveScan('A1', { lookup: b.lookup, isTagCode: fuzzy, tagFallback: false })).toEqual({ kind: 'unreadable' });
    // 太短、不像芯片号，但本身是牌号（扫码）：当牌号，不去查
    const c = binder();
    expect(await resolveScan('A1', { lookup: c.lookup, isTagCode: fuzzy, tagFallback: true })).toEqual({ kind: 'tag', code: 'A1' });
    expect(c.asked).toEqual([]);
  });

  it('按芯片号查的时候出错（连不上服务器）：不当牌号猜，交给页面写明原因', async () => {
    const r = await resolveScan('00000001', {
      lookup: async () => {
        throw new Error('连不上');
      },
      isTagCode: fuzzy,
      tagFallback: true,
    });
    expect(r.kind).toBe('failed');
  });
});
