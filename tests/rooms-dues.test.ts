// S7 客房（v0.7.4）：退房时要付的房费（docs/ROOMS.md 第 3 节）。纯计算，不连数据库。
// 门店时区北京时间、营业日 06:00 切换；退房时间 12:00，18:00 以后再加一晚；钟点房每段 3 小时、宽限 15 分钟。

import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_RULES, chargeLineName, roomDues, type RoomDue } from '../src/shared/rooms';

const clock = { timeZone: 'Asia/Shanghai', startHour: 6 };
const at = (s: string) => new Date(`${s}+08:00`);
const none = { nights: new Set<string>(), halfDays: new Set<string>(), blocks: new Set<number>() };
const daily = (checkedIn: string, businessDate: string) => ({ kind: 'daily' as const, rate: 38800, blockMinutes: null, businessDate, checkedInAt: at(checkedIn) });
const short = (dues: RoomDue[]) => dues.map((d) => (d.kind === 'block' ? `段${d.blockNo}` : `${d.kind === 'night' ? '晚' : '半天'}${d.nightDate}:${d.amount}`));

describe('全天房', () => {
  it('第二天 12:00 前退房只付一晚；12:00–18:00 加收半天；18:00 以后再加一晚', () => {
    const stay = daily('2026-11-01T14:00:00', '2026-11-01');
    const first = { ...none, nights: new Set(['2026-11-01']) };
    expect(short(roomDues(stay, none, at('2026-11-02T11:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['晚2026-11-01:38800']);
    expect(roomDues(stay, first, at('2026-11-02T12:00:00'), DEFAULT_ROOM_RULES, clock)).toEqual([]);
    expect(short(roomDues(stay, first, at('2026-11-02T12:01:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['半天2026-11-02:19400']);
    expect(short(roomDues(stay, first, at('2026-11-02T18:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['晚2026-11-02:38800']);
  });

  it('凌晨入住按前一个营业日算第一晚；当天入住当天走也付一晚；切换前退房仍是同一营业日', () => {
    expect(short(roomDues(daily('2026-11-01T01:00:00', '2026-10-31'), none, at('2026-11-01T11:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['晚2026-10-31:38800']);
    expect(short(roomDues(daily('2026-11-01T08:00:00', '2026-11-01'), none, at('2026-11-01T20:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['晚2026-11-01:38800']);
    expect(short(roomDues(daily('2026-11-01T23:00:00', '2026-11-01'), none, at('2026-11-02T03:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['晚2026-11-01:38800']);
  });

  it('漏做夜审：退房时把少挂的几晚补上；已挂、作废过的不再补', () => {
    const stay = daily('2026-11-01T23:00:00', '2026-11-01');
    expect(short(roomDues(stay, { ...none, nights: new Set(['2026-11-01']) }, at('2026-11-04T10:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual([
      '晚2026-11-02:38800',
      '晚2026-11-03:38800',
    ]);
    // 11-02 那晚作废过（前台有意的更正）：不再补
    expect(short(roomDues(stay, { ...none, nights: new Set(['2026-11-01', '2026-11-02']) }, at('2026-11-04T10:00:00'), DEFAULT_ROOM_RULES, clock))).toEqual([
      '晚2026-11-03:38800',
    ]);
  });

  it('退房时间、加收时刻按规则；半天按房价的一半取整到分', () => {
    const stay = { ...daily('2026-11-01T14:00:00', '2026-11-01'), rate: 38801 };
    const first = { ...none, nights: new Set(['2026-11-01']) };
    const rules = { ...DEFAULT_ROOM_RULES, checkoutMinute: 14 * 60, lateFullMinute: 20 * 60 };
    expect(roomDues(stay, first, at('2026-11-02T13:59:00'), rules, clock)).toEqual([]);
    expect(short(roomDues(stay, first, at('2026-11-02T19:00:00'), rules, clock))).toEqual(['半天2026-11-02:19401']);
    expect(short(roomDues(stay, first, at('2026-11-02T20:00:00'), rules, clock))).toEqual(['晚2026-11-02:38801']);
  });
});

describe('钟点房', () => {
  const stay = { kind: 'hourly' as const, rate: 12800, blockMinutes: 180, businessDate: '2026-11-01', checkedInAt: at('2026-11-01T10:00:00') };
  const first = { ...none, blocks: new Set([1]) };

  it('超过已付时段加 15 分钟宽限才补一段；按段补齐', () => {
    expect(roomDues(stay, first, at('2026-11-01T13:15:00'), DEFAULT_ROOM_RULES, clock)).toEqual([]);
    expect(short(roomDues(stay, first, at('2026-11-01T13:16:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['段2']);
    expect(short(roomDues(stay, first, at('2026-11-01T16:20:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['段2', '段3']);
    // 续住已经加了第 2 段
    expect(short(roomDues(stay, { ...none, blocks: new Set([1, 2]) }, at('2026-11-01T16:20:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['段3']);
    // 一段都没挂（入住时的第一段作废了以外的情况）：至少一段
    expect(short(roomDues(stay, none, at('2026-11-01T10:05:00'), DEFAULT_ROOM_RULES, clock))).toEqual(['段1']);
  });
});

describe('房费明细名称', () => {
  it('写明房号、哪一晚或第几段', () => {
    expect(chargeLineName('301', { kind: 'night', nightDate: '2026-11-01', blockNo: null })).toBe('房费 301 11月1日');
    expect(chargeLineName('301', { kind: 'half_day', nightDate: '2026-11-02', blockNo: null })).toBe('房费 301 11月2日 超时半天');
    expect(chargeLineName('8A', { kind: 'block', nightDate: null, blockNo: 2 })).toBe('钟点房 8A 第 2 段');
  });
});
