// 灌演示数据的时间（PR #13 Codex 复核 P2-3）：营业日切换后 5 个半小时内灌前台、结账演示会跨营业日——命令行提示；
// 加 --previous-day 时整体放到前一个营业日，结账演示沿用前台演示记下的时间。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { DEMO_ANCHOR_KEY, demoSeedTime, demoSeedWindow, rememberDemoAnchor } from '../src/server/ops/demo-time';
import { setup, type TestContext } from './helpers';

const TZ = 'Asia/Shanghai';
/** 上海时间 2026-10-30 的某个时刻 */
const at = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00+08:00`);

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('会不会跨营业日', () => {
  it('切换（06:00）后 330 分钟内会；锚点是切换前 30 分钟，落在前一个营业日', () => {
    expect(demoSeedWindow(at('05:59'), TZ, 6)).toBeNull();
    expect(demoSeedWindow(at('11:30'), TZ, 6)).toBeNull();
    expect(demoSeedWindow(at('23:00'), TZ, 6)).toBeNull();
    for (const t of ['06:00', '08:15', '11:29']) {
      const w = demoSeedWindow(at(t), TZ, 6)!;
      expect(w.anchor.toISOString()).toBe(at('05:30').toISOString());
      expect(businessDateOf(w.anchor, TZ, 6)).toBe('2026-10-29');
    }
    expect(demoSeedWindow(at('08:15'), TZ, 6)!.since).toBe(135);
    // 切换时间改为 0 点：00:00–05:29 之间会跨
    expect(demoSeedWindow(at('03:00'), TZ, 0)!.anchor.toISOString()).toBe(new Date('2026-10-29T23:30:00+08:00').toISOString());
    expect(demoSeedWindow(at('08:15'), TZ, 0)).toBeNull();
  });
});

describe('命令行用的时间', () => {
  it('不在那段时间：按实际时间，不提示', async () => {
    expect(await demoSeedTime(ctx.sql, { timeZone: TZ, kind: 'frontdesk', previousDay: false, now: at('14:00') })).toEqual({ anchored: false });
    expect(await demoSeedTime(ctx.sql, { timeZone: TZ, kind: 'frontdesk', previousDay: true, now: at('14:00') })).toEqual({ anchored: false });
  });

  it('在那段时间、没加 --previous-day：按实际时间照常灌，说明结账演示压进当天（v0.7.25 起不再跨营业日）', async () => {
    const t = await demoSeedTime(ctx.sql, { timeZone: TZ, kind: 'frontdesk', previousDay: false, now: at('07:10') });
    expect(t.now).toBeUndefined();
    expect(t.warning).toBeUndefined();
    expect(t.notice).toContain('切换（06:00）后 70 分钟');
    expect(t.notice).toContain('压进当天营业日');
    expect(t.notice).toContain('--previous-day');
  });

  it('加了 --previous-day：前台演示放到前一个营业日并记下时间，结账演示沿用；前台没放时结账不能单独放', async () => {
    await expect(demoSeedTime(ctx.sql, { timeZone: TZ, kind: 'billing', previousDay: true, now: at('07:10') })).rejects.toThrow('结账会早于接待');
    const front = await demoSeedTime(ctx.sql, { timeZone: TZ, kind: 'frontdesk', previousDay: true, now: at('07:10') });
    expect(front).toMatchObject({ anchored: true, now: at('05:30') });
    expect(front.notice).toContain('2026-10-29');
    await rememberDemoAnchor(ctx.sql, front.now!);
    // 结账演示晚些执行、甚至不加参数，也沿用同一时间
    const billing = await demoSeedTime(ctx.sql, { timeZone: TZ, kind: 'billing', previousDay: false, now: at('12:40') });
    expect(billing).toMatchObject({ anchored: true, now: at('05:30') });
    await ctx.sql`DELETE FROM settings WHERE key = ${DEMO_ANCHOR_KEY}`;
  });
});
