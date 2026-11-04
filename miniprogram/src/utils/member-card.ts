// 会员卡上显示的字（会员体系 v2）：数字全由门店系统算好（档阶、周期储值消费、升阶与保级要的数、下一档还差多少），这里只拼成句子。

import type { MpMe } from '../../../src/shared/mp';
import { percentOfBp, price, yuan } from './format';

export type MeMember = NonNullable<MpMe['member']>;

export interface CardView {
  name: string;
  memberNo: string;
  frozen: boolean;
  /** L3 */
  code: string;
  gradeName: string;
  /** 初、享、尊；L0 为空 */
  tierName: string;
  ladder: { name: string; state: 'done' | 'cur' | '' }[];
  /** 进度条：周期储值消费到尊阶（保级）门槛的百分比；L0 没有 */
  bar: { fill: number; mark: number; enjoy: string; honor: string; text: string; hint: string } | null;
  cycle: string;
  next: string;
  total: string;
  principal: string;
  bonus: string;
  deduction: string;
  coupons: number;
  /** 线上充值开着（第二期 2a）：菜单里有「充值」 */
  recharge: boolean;
  /** 这张会员卡已合并到另一张：请到前台换绑（MP25） */
  merged: boolean;
  /** 领券中心开着、有可领的券（第二期 2c）：菜单里有「领券中心」 */
  couponCenter: boolean;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, Math.floor((part * 100) / whole))) : 0);

export function cardView(m: MeMember): CardView {
  const g = m.grade;
  let bar: CardView['bar'] = null;
  if (g.targets && g.targets.honor > 0) {
    const spend = g.cycleSpendCents;
    const { enjoy, honor } = g.targets;
    let hint: string;
    if (g.inGrace) hint = spend < honor ? '再储值消费 ' + yuan(honor - spend) + ' 就能保级' : '补充期内已够保级';
    else if (spend < enjoy) hint = '再储值消费 ' + yuan(enjoy - spend) + ' 升享阶';
    else if (spend < honor) hint = '再储值消费 ' + yuan(honor - spend) + ' 升尊阶，同时够保级';
    else hint = '本周期已够保级';
    bar = {
      fill: pct(spend, honor),
      mark: pct(enjoy, honor),
      enjoy: '享 ' + price(enjoy),
      honor: '尊 · 保级 ' + price(honor),
      text: (g.inGrace ? '补充期内' : '本周期') + '储值消费 ' + yuan(spend),
      hint,
    };
  }
  let cycle = '';
  if (g.grade > 0) {
    const days = g.daysLeft === null ? '' : ' · 还有 ' + Math.max(0, g.daysLeft) + ' 天';
    cycle = g.inGrace ? '补充期' + days : g.cycleEnd ? '会籍到期 ' + g.cycleEnd + days : '';
  }
  let next = '';
  if (g.next) {
    const to = 'L' + g.next.grade + ' ' + g.next.name;
    const gift = g.next.bonusBp > 0 ? '，这一档充值赠送 ' + percentOfBp(g.next.bonusBp) : '';
    next = (g.next.needCents > 0 ? '累计充值再 ' + yuan(g.next.needCents) + ' 升到 ' + to : '下一笔充值就升到 ' + to) + gift;
  }
  return {
    name: m.name,
    memberNo: m.memberNo,
    frozen: m.frozen,
    code: 'L' + g.grade,
    gradeName: g.gradeName,
    tierName: g.tierName || '',
    ladder: g.ladder.map((name, i) => ({ name, state: i < g.grade ? 'done' : i === g.grade ? 'cur' : '' })),
    bar,
    cycle,
    next,
    total: yuan(m.principalBalance + m.bonusBalance),
    principal: yuan(m.principalBalance),
    bonus: yuan(m.bonusBalance),
    deduction: m.deductionRule,
    coupons: m.availableCoupons,
    recharge: m.rechargeOpen === true && m.merged !== true,
    merged: m.merged === true,
    couponCenter: m.couponCenterOpen === true && m.merged !== true,
  };
}
