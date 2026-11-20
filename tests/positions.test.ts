// 8.1.18 组织架构与岗位（docs/POSITIONS_V8118.md）：岗位模板按店主表格《分部门岗位职权配置》逐列核对，不要数据库。

import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, LOCKED_PERMISSIONS, permissionsOf, type Permission } from '../src/shared/permissions';
import {
  LINED_DEPARTMENTS,
  ORG_DEPARTMENTS,
  PERMISSION_COLUMN,
  POSITIONS,
  positionDefaults,
  positionOf,
  selfSelectablePositions,
  type PermissionColumn,
  type PositionKey,
} from '../src/shared/positions';

const columnsOf = (perms: readonly Permission[]) => new Set(perms.map((p) => PERMISSION_COLUMN[p]));

describe('组织架构（表 1）', () => {
  it('总裁、总经办与十三个部门；大客户部新增；每个部门下设负责人与员工', () => {
    expect(ORG_DEPARTMENTS.map((d) => d.name)).toEqual([
      '汤崎汤泉生活（公司）',
      '总经办',
      '人力行政部',
      '前厅部',
      '男宾部',
      '女宾部',
      '娱乐部',
      '餐饮部',
      '康美部',
      '出品部',
      '保健部',
      '工程部',
      '财务部',
      '外联部',
      '大客户部',
    ]);
    expect(POSITIONS).toHaveLength(2 + LINED_DEPARTMENTS.length * 2);
    for (const d of LINED_DEPARTMENTS) {
      expect(positionOf(`${d}.lead`).level).toBe('senior');
      expect(positionOf(`${d}.staff`).level).toBe('admin');
    }
    // 不再单独设库存岗、采购岗（表 4 第 4 条）：岗位里没有
    expect(POSITIONS.some((p) => /库存|采购|仓库/.test(p.title))).toBe(false);
  });

  it('三级管理员（表 2）：总裁 = 超级管理员；总经办成员、各部门负责人 = 高级管理员；各部门员工 = 管理员', () => {
    expect(positionOf('president').level).toBe('super');
    expect(positionOf('president').legacyRole).toBe('owner');
    expect(positionOf('gmo').level).toBe('senior');
    expect(POSITIONS.filter((p) => p.level === 'super').map((p) => p.key)).toEqual(['president']);
  });
});

describe('权限模板（表 3 逐列）', () => {
  it('每项权限都归到了八列中的一列', () => {
    for (const p of ALL_PERMISSIONS) expect(PERMISSION_COLUMN[p], p).toBeTruthy();
  });

  it('总裁全部权限；别的岗位都没有「基础数据 / 价格配置」与店主专属的权限', () => {
    expect(positionDefaults('president', ALL_PERMISSIONS)).toEqual(ALL_PERMISSIONS);
    for (const pos of POSITIONS.filter((p) => p.key !== 'president')) {
      const perms = positionDefaults(pos.key, ALL_PERMISSIONS);
      expect(columnsOf(perms).has('base'), pos.title).toBe(false);
      for (const l of LOCKED_PERMISSIONS) expect(perms, `${pos.title} ${l}`).not.toContain(l);
    }
  });

  it('岗位只拿表上打了 ✔ 的那几列里的权限', () => {
    for (const pos of POSITIONS.filter((p) => p.key !== 'president')) {
      const cols = columnsOf(positionDefaults(pos.key, ALL_PERMISSIONS));
      for (const c of cols) expect(pos.columns, `${pos.title}：${c}`).toContain(c);
    }
  });

  it('管理员（各部门员工）：不能审核审批、不能配置账号权限与基础数据；只有财务部员工能看本岗账务、大客户部员工能登记权益', () => {
    for (const d of LINED_DEPARTMENTS) {
      const cols = columnsOf(positionDefaults(`${d}.staff`, ALL_PERMISSIONS));
      for (const c of ['approve', 'account', 'base', 'cross'] as PermissionColumn[]) expect(cols.has(c), `${d}.staff ${c}`).toBe(false);
      expect(cols.has('dept'), `${d}.staff dept`).toBe(d === 'finance');
      expect(cols.has('member'), `${d}.staff member`).toBe(d === 'vip');
      expect(cols.has('entry'), `${d}.staff entry`).toBe(true);
    }
  });

  it('负责人：账号与权限配置（本部门员工）除财务部外都有；跨部门、会员与券按表', () => {
    const cross: Record<string, boolean> = {
      hr: true,
      front: true,
      male: false,
      female: false,
      ent: false,
      dining: true,
      kangmei: false,
      kitchen: true,
      wellness: false,
      eng: true,
      finance: true,
      outreach: true,
      vip: true,
    };
    const member: Record<string, boolean> = {
      hr: false,
      front: true,
      male: false,
      female: false,
      ent: false,
      dining: false,
      kangmei: true,
      kitchen: false,
      wellness: true,
      eng: false,
      finance: true,
      outreach: false,
      vip: true,
    };
    for (const d of LINED_DEPARTMENTS) {
      const perms = positionDefaults(`${d}.lead`, ALL_PERMISSIONS);
      expect(perms.includes('staff.dept'), `${d} staff.dept`).toBe(d !== 'finance');
      expect(perms, `${d} approval`).toContain('approval.act');
      expect(columnsOf(perms).has('cross'), `${d} cross`).toBe(cross[d]);
      expect(columnsOf(perms).has('member'), `${d} member`).toBe(member[d]);
    }
  });

  it('库存、采购归外联部（表 4 第 4 条）：入库、采购、库存台账在外联部；负责人审核', () => {
    const staff = positionDefaults('outreach.staff', ALL_PERMISSIONS);
    for (const p of ['inventory.operate', 'purchase.manage', 'supplierReturn.create'] as Permission[]) expect(staff).toContain(p);
    const lead = positionDefaults('outreach.lead', ALL_PERMISSIONS);
    for (const p of ['inventory.read', 'inventory.approve', 'request.review', 'payable.read'] as Permission[]) expect(lead).toContain(p);
    // 别的部门的员工都不能入库、采购
    for (const d of LINED_DEPARTMENTS.filter((x) => x !== 'outreach')) {
      const perms = positionDefaults(`${d}.staff`, ALL_PERMISSIONS);
      expect(perms, d).not.toContain('inventory.operate');
      expect(perms, d).not.toContain('purchase.manage');
    }
  });

  it('入库、采购、负责人确认的岗位都看得到库存（ERP 的库存、采购页要先有「查看库存与物资单据」）', () => {
    for (const pos of POSITIONS) {
      const perms = positionDefaults(pos.key, ALL_PERMISSIONS);
      if (perms.some((p) => ['inventory.operate', 'purchase.manage', 'inventory.approve'].includes(p))) expect(perms, pos.title).toContain('inventory.read');
    }
  });

  it('退菜按出品口（8.1.17）跟着下单：能在哪个出品口下单就能退哪个出品口的菜；康美部没有餐厅', () => {
    for (const pos of POSITIONS.filter((p) => p.key !== 'president')) {
      const perms = positionDefaults(pos.key, ALL_PERMISSIONS);
      for (const [order, voids] of [
        ['dining.orderRestaurant', 'dining.voidRestaurant'],
        ['dining.orderWater', 'dining.voidWater'],
        ['dining.orderFruit', 'dining.voidFruit'],
      ] as [Permission, Permission][])
        expect(perms.includes(voids), `${pos.title} ${voids}`).toBe(perms.includes(order));
    }
    expect(positionDefaults('kangmei.staff', ALL_PERMISSIONS)).not.toContain('dining.voidRestaurant');
  });

  it('能点单的岗位都能在平板上确认下单（要「餐饮点单」+「前台挂账」，Codex 审查 4e118c1）', () => {
    for (const pos of POSITIONS) {
      const perms = positionDefaults(pos.key, ALL_PERMISSIONS);
      if (perms.includes('dining.order')) expect(perms, pos.title).toContain('frontdesk.operate');
    }
  });

  it('总经办成员：跨部门，除账号与基础数据外都开', () => {
    const perms = positionDefaults('gmo', ALL_PERMISSIONS);
    expect(perms).toContain('report.executive');
    expect(perms).toContain('approval.act');
    expect(perms).not.toContain('catalog.manage');
    expect(perms).not.toContain('staff.dept');
  });
});

describe('算权限', () => {
  it('有岗位的按岗位模板，后台按岗位的调整与个人微调依次生效；店主专属的加不上', () => {
    const subject = { role: 'clerk' as const, duties: [], position: 'front.staff' as PositionKey };
    const base = permissionsOf(subject);
    expect(base).toEqual(positionDefaults('front.staff', ALL_PERMISSIONS));
    const tuned = permissionsOf(subject, { roles: {}, positions: { 'front.staff': { add: ['ledger.readHistory', 'staff.manage'], remove: ['recharge.create'] } } });
    expect(tuned).toContain('ledger.readHistory');
    expect(tuned).not.toContain('recharge.create');
    expect(tuned).not.toContain('staff.manage');
    const mine = permissionsOf(
      { ...subject, adjust: { add: ['recharge.create'], remove: ['ledger.readHistory'] } },
      { roles: {}, positions: { 'front.staff': { add: ['ledger.readHistory'], remove: ['recharge.create'] } } },
    );
    expect(mine).toContain('recharge.create');
    expect(mine).not.toContain('ledger.readHistory');
    // 旧岗位的调整不影响有岗位的人
    expect(permissionsOf(subject, { roles: { clerk: { add: ['ledger.export'], remove: [] } }, positions: {} })).not.toContain('ledger.export');
  });

  it('总裁全部；没有岗位的老账号照旧按旧岗位', () => {
    expect(permissionsOf({ role: 'owner', position: 'president' })).toEqual(ALL_PERMISSIONS);
    expect(permissionsOf({ role: 'duty_manager', position: null })).toContain('ledger.readHistory');
    expect(permissionsOf({ role: 'duty_manager', position: null })).not.toContain('staff.dept');
  });

  it('有财务职责的账号照旧看不到营销成本（HY14）：财务部负责人', () => {
    expect(permissionsOf({ role: 'backoffice', duties: ['payable', 'cost'], position: 'finance.lead', adjust: { add: ['marketing.cost'], remove: [] } })).not.toContain('marketing.cost');
  });
});

describe('老账号自己选岗（GW7，店主定方案 B：按原来的岗位与职责限定部门）', () => {
  const keys = (role: Parameters<typeof selfSelectablePositions>[0], duties: Parameters<typeof selfSelectablePositions>[1] = []) => selfSelectablePositions(role, duties).map((p) => p.key);

  it('前台店员只能选一线部门的员工；选不了财务部、外联部、大客户部，也选不了负责人（Codex 安全审查 02d66df）', () => {
    const clerk = keys('clerk');
    expect(clerk).toContain('front.staff');
    expect(clerk).toContain('wellness.staff');
    for (const k of ['finance.staff', 'outreach.staff', 'vip.staff', 'hr.staff', 'front.lead', 'gmo', 'president']) expect(clerk, k).not.toContain(k);
  });

  it('财务、外联、大客户部要有对应的旧职责或岗位；财务部负责人谁也选不了', () => {
    expect(keys('backoffice', ['payable'])).toContain('finance.staff');
    expect(keys('backoffice', ['stock'])).toEqual(expect.arrayContaining(['outreach.staff']));
    expect(keys('backoffice', ['stock'])).not.toContain('finance.staff');
    expect(keys('backoffice', ['approve'])).toContain('outreach.lead');
    expect(keys('account_manager')).toEqual(['vip.staff']);
    expect(keys('backoffice', ['concierge_manager'])).toContain('vip.lead');
    for (const r of ['clerk', 'duty_manager', 'store_manager', 'backoffice', 'account_manager'] as const) {
      expect(keys(r), r).not.toContain('finance.staff');
      expect(keys(r, ['payable', 'cost']), r).not.toContain('finance.lead');
    }
  });

  it('值班经理选一线部门的负责人或员工；店总还能选总经办，不能选财务部、外联部；店主不用选', () => {
    expect(keys('duty_manager')).toContain('front.lead');
    expect(keys('duty_manager')).not.toContain('gmo');
    expect(keys('duty_manager')).not.toContain('hr.lead');
    expect(keys('store_manager')).toContain('gmo');
    expect(keys('store_manager')).not.toContain('outreach.staff');
    expect(keys('owner')).toEqual([]);
    for (const r of ['clerk', 'duty_manager', 'store_manager', 'backoffice'] as const) expect(keys(r, ['approve', 'payable']), r).not.toContain('president');
  });
});
