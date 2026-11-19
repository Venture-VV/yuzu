// 门店主导航按业务域分组（8.1.15，《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8115.md 3.G）：
// 七组的顺序与名字、每个页面在哪一组、按权限与功能开关筛、地址属于哪一组；ERP「返回门店」回到哪一页照旧。
import { describe, expect, it } from 'vitest';
import type { Permission } from '../src/shared/permissions';
import { storeDomainOf, storePageOf, visibleStoreNav } from '../src/client/components/storeNav';

type Session = Parameters<typeof visibleStoreNav>[1];

function session(over: Partial<{ technicians: boolean; dining: boolean; rooms: boolean; permissions: Permission[] }> = {}): Session {
  return { technicians: true, dining: true, rooms: true, permissions: [], ...over } as unknown as Session;
}

const OWNER: Permission[] = [
  'frontdesk.read',
  'frontdesk.checkout',
  'booking.manage',
  'dining.order',
  'room.operate',
  'technician.dispatch',
  'member.read',
  'customer.read',
  'concierge.read',
  'ledger.readToday',
  'device.view',
  'guide.view',
  'settings.manage',
];
const canOf = (perms: Permission[]) => (p: Permission) => perms.includes(p);

describe('主导航的业务域', () => {
  it('七组按需求的顺序：前台、餐饮、房态、技师、会员、财务、设置；每页在对的组里', () => {
    const nav = visibleStoreNav(canOf(OWNER), session({ permissions: OWNER }));
    expect(nav.map((d) => d.label)).toEqual(['前台', '餐饮', '房态', '技师', '会员', '财务', '设置']);
    const where = Object.fromEntries(nav.flatMap((d) => d.items.map((i) => [i.label, d.label])));
    expect(where).toMatchObject({
      发卡台: '前台',
      收银台: '前台',
      预约: '前台',
      餐饮: '餐饮',
      客房: '房态',
      钟房: '技师',
      会员: '会员',
      客户部: '会员',
      管家: '会员',
      流水: '财务',
      日结: '财务',
      交班: '财务',
      设备: '设置',
      导览: '设置',
      后台: '设置',
    });
  });

  it('功能没开、没有权限的入口不显示，空了的组整组不显示', () => {
    const off = visibleStoreNav(canOf(OWNER), session({ technicians: false, dining: false, rooms: false, permissions: OWNER }));
    expect(off.map((d) => d.label)).toEqual(['前台', '会员', '财务', '设置']);
    // 只有管家职责的后勤：会员这一组只剩「管家」，加上所有岗位都能看的导览
    const concierge: Permission[] = ['concierge.read', 'guide.view'];
    const nav = visibleStoreNav(canOf(concierge), session({ permissions: concierge }));
    expect(nav.map((d) => [d.label, d.items.map((i) => i.label)])).toEqual([
      ['会员', ['管家']],
      ['设置', ['导览']],
    ]);
    // 他店查询：没有会员查看权限、有「查会员档阶」的看到「会员查询」，看得到会员的不另显示
    const lookup: Permission[] = ['member.lookup'];
    expect(visibleStoreNav(canOf(lookup), session({ permissions: lookup })).flatMap((d) => d.items.map((i) => i.label))).toEqual(['会员查询']);
    const both: Permission[] = ['member.lookup', 'member.read'];
    expect(visibleStoreNav(canOf(both), session({ permissions: both })).flatMap((d) => d.items.map((i) => i.label))).toEqual(['会员']);
  });

  it('地址属于哪一组：子页面也算；会员工作台只认「/」；改密码这类不属于任何一组', () => {
    expect(storeDomainOf('/frontdesk')).toBe('frontdesk');
    expect(storeDomainOf('/cashier')).toBe('frontdesk');
    expect(storeDomainOf('/dining/ledger')).toBe('dining');
    expect(storeDomainOf('/settlement/2026-11-19')).toBe('finance');
    expect(storeDomainOf('/concierge/members')).toBe('members');
    expect(storeDomainOf('/')).toBe('members');
    expect(storeDomainOf('/password')).toBeNull();
    expect(storeDomainOf('/network')).toBeNull();
    // 没有权限时退回首页用的判断照旧：会员工作台不算
    expect(storePageOf('/')).toBeNull();
    expect(storePageOf('/shift')?.label).toBe('交班');
    expect(storePageOf('/admin/studio')?.label).toBe('后台');
  });
});
