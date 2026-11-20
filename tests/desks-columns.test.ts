// 8.1.15 前台 1 细化（docs/DESKS_V8115.md 第 7 节，PENDING_DECISIONS「8.1.15 追加」YB2、YB3、YB5–YB8）——不要数据库的一档：
//   · 结账预览六列的顺序与名字；已挂的明细按来源归到餐饮、客房、服务三列，带条数（一份套餐是一条餐饮）；
//   · 两个台的入口谁看得到：按「接待发牌、挂账、换牌」「结账收款」两项权限分；默认的岗位权限下前台的四个岗位两个台都看得到，
//     后台「岗位权限」去掉其中一项就只剩一个台。
// 押金一列（在住客房还押着多少）要数据库，在 tests/desks.test.ts；页面在 e2e/desks.spec.ts。

import { describe, expect, it } from 'vitest';
import { deskEntries, PREVIEW_COLUMN_LABELS, PREVIEW_COLUMNS, previewBuckets } from '../src/shared/frontdesk';
import { overridesFrom, permissionsOf, ROLES, type EditableRole, type Permission, type Role, type RoleOverrides } from '../src/shared/permissions';

describe('结账预览分列：门票、餐饮、客房、服务、优惠、押金', () => {
  it('六列的顺序与名字', () => {
    expect(PREVIEW_COLUMNS.map((c) => PREVIEW_COLUMN_LABELS[c])).toEqual(['门票', '餐饮', '客房', '服务', '优惠', '押金']);
  });

  it('已挂的明细按来源归列：餐饮、客房各一列，技师服务、洗浴项目、其他都算服务；一份套餐是一条餐饮', () => {
    expect(previewBuckets([])).toEqual({ dining: 0, room: 0, service: 0, other: 0, lines: { dining: 0, room: 0, service: 0 } });
    // 餐饮两条：一份套餐 ¥88（套餐里含哪几样只在出品单上拆开，账单上就是一条）+ 一条加料 ¥10
    const one = [
      { source: 'bath', amountCents: 6800, lineCount: 1 },
      { source: 'dining', amountCents: 9800, lineCount: 2 },
      { source: 'therapist', amountCents: 12800, lineCount: 1 },
      { source: 'room', amountCents: 38800, lineCount: 1 },
      { source: 'other', amountCents: 5000, lineCount: 1 },
    ] as const;
    expect(previewBuckets(one)).toEqual({ dining: 9800, room: 38800, service: 6800 + 12800 + 5000, other: 5000, lines: { dining: 2, room: 1, service: 3 } });
    // 三列加起来就是已挂的合计：门票、优惠、押金不在明细里
    const b = previewBuckets(one);
    expect(b.dining + b.room + b.service).toBe(one.reduce((s, x) => s + x.amountCents, 0));
  });

  it('几位客人的一起传进来，同一来源的加在一起；没给条数的按 0', () => {
    const a = [
      { source: 'dining', amountCents: 5800, lineCount: 1 },
      { source: 'bath', amountCents: 6800, lineCount: 1 },
    ] as const;
    const b = [
      { source: 'dining', amountCents: 3000, lineCount: 2 },
      { source: 'therapist', amountCents: 12800, lineCount: 1 },
    ] as const;
    expect(previewBuckets([...a, ...b])).toEqual({ dining: 8800, room: 0, service: 19600, other: 0, lines: { dining: 3, room: 0, service: 2 } });
    expect(previewBuckets([{ source: 'dining', amountCents: 5800 }]).lines).toEqual({ dining: 0, room: 0, service: 0 });
  });
});

describe('两个台的入口按权限显示（YB2）', () => {
  const READ: Permission = 'frontdesk.read';
  const OPERATE: Permission = 'frontdesk.operate';
  const CHECKOUT: Permission = 'frontdesk.checkout';

  it('有「接待发牌、挂账、换牌」的看得到发卡台，有「结账收款」的看得到收银台；只有查看的两个都看得到；连查看都没有的都看不到', () => {
    expect(deskEntries([READ, OPERATE, CHECKOUT])).toEqual({ issue: true, cashier: true });
    expect(deskEntries([READ, OPERATE])).toEqual({ issue: true, cashier: false });
    expect(deskEntries([READ, CHECKOUT])).toEqual({ issue: false, cashier: true });
    expect(deskEntries([READ])).toEqual({ issue: true, cashier: true });
    expect(deskEntries([])).toEqual({ issue: false, cashier: false });
    // 两个台的页面都要「查看在店手牌」才进得去，光有操作的权限、没有查看的不显示入口
    expect(deskEntries([OPERATE, CHECKOUT])).toEqual({ issue: false, cashier: false });
  });

  const entriesOf = (role: Role, overrides?: RoleOverrides) => deskEntries(permissionsOf({ position: null, role, duties: [] }, overrides));

  it('默认的岗位权限：店主、店总、值班经理、前台店员两个台都看得到，别的岗位都看不到', () => {
    const both = ROLES.filter((r) => entriesOf(r).issue && entriesOf(r).cashier);
    expect(both).toEqual(['owner', 'store_manager', 'duty_manager', 'clerk']);
    for (const role of ROLES.filter((r) => !both.includes(r))) expect(entriesOf(role), role).toEqual({ issue: false, cashier: false });
  });

  it('后台「岗位权限」去掉其中一项，就把这个岗位分到一个台；两项都去掉只留查看的，两个台都能进去看', () => {
    const base = permissionsOf({ position: null, role: 'clerk', duties: [] });
    const without = (...drop: Permission[]) => overridesFrom({ clerk: base.filter((p) => !drop.includes(p)) } satisfies Partial<Record<EditableRole, Permission[]>>);
    expect(entriesOf('clerk', without(CHECKOUT))).toEqual({ issue: true, cashier: false });
    expect(entriesOf('clerk', without(OPERATE))).toEqual({ issue: false, cashier: true });
    expect(entriesOf('clerk', without(OPERATE, CHECKOUT))).toEqual({ issue: true, cashier: true });
    expect(entriesOf('clerk', without(READ, OPERATE, CHECKOUT))).toEqual({ issue: false, cashier: false });
    // 只调了前台店员，别的岗位不受影响
    expect(entriesOf('duty_manager', without(CHECKOUT))).toEqual({ issue: true, cashier: true });
  });
});
