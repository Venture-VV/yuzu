// 合成演示数据：仅用于开发与界面验收。所有会员标记为 is_synthetic，手机号使用 199 0000 号段。
// 业务数据全部通过正式的充值/消费/撤销流程生成，因此流水与余额天然一致。

import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@shared/business-date';
import { shiftDate } from '@shared/labels';
import type { AppConfig } from './config';
import { withShiftOptional } from './demo/shift-rule';
import type { Sql } from './db';
import type { Actor, Deps } from './lib/context';
import { createMember } from './modules/members';
import { loadSettings } from './modules/settings';
import { createStaff } from './modules/staff';
import { consume, recharge, reverse } from './modules/wallet';

export const DEMO_PASSWORD = 'yuzu2026';

const PLANS = [
  { name: '轻享 300', pay: 30000, bonus: 0, note: '体验档，无赠送' },
  { name: '常泡 500', pay: 50000, bonus: 5000, note: '' },
  { name: '山野 1000', pay: 100000, bonus: 15000, note: '' },
  { name: '四季 2000', pay: 200000, bonus: 40000, note: '' },
];

export const DEMO_ITEMS = [
  { name: '汤泉入场 · 成人', category: '入场', price: 12800 },
  { name: '汤泉入场 · 儿童', category: '入场', price: 6800 },
  { name: '夜场入场', category: '入场', price: 9800 },
  { name: '搓背', category: '护理', price: 5800 },
  { name: '精油按摩 60 分钟', category: '护理', price: 29800 },
  { name: '足疗 45 分钟', category: '护理', price: 16800 },
  { name: '山野简餐', category: '餐饮', price: 4800 },
  { name: '柚子气泡水', category: '餐饮', price: 2200 },
  { name: '浴服加购', category: '加购', price: 1000 },
];

const NAMES = [
  '林小满', '周以安', '陈一禾', '沈知夏', '许嘉木', '苏晚晴', '顾青山', '叶闻溪', '江屿白', '宋雨棠',
  '程野', '白露', '秦朗', '温言', '夏栀', '陆川', '姜禾', '方澄', '唐果', '孟夏',
  '何溪', '黎明月', '杜若', '简一', '欧阳山野与温泉同行',
];

/** 可复现的伪随机数 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 门店时区 +08:00 下的「营业日 + 时刻」→ 时间点（演示数据按中国时区生成） */
function localTime(date: string, hour: number, minute: number): Date {
  const realDate = hour < 6 ? shiftDate(date, 1) : date;
  return new Date(`${realDate}T${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
}

/** force：库里已有会员演示数据时仍再写一遍（只在开发环境可用）；试用、正式环境一律拒绝，与其他演示数据命令一致 */
export async function seedDemo(sql: Sql, config: AppConfig, options: { force?: boolean; days?: number } = {}) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入会员演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  // 演示充值按「开班可选」入账（R1.2 起默认收款前必须先开班）
  return withShiftOptional(sql, config, () => seedMemberDemo(sql, config, options));
}

async function seedMemberDemo(sql: Sql, config: AppConfig, options: { force?: boolean; days?: number }) {
  const [existing] = await sql<{ count: number }[]>`SELECT count(*) AS count FROM members WHERE is_synthetic`;
  if (existing && existing.count > 0 && !options.force) {
    return { skipped: true as const };
  }

  // 员工
  const ensureStaff = async (username: string, displayName: string, role: 'owner' | 'clerk') => {
    const [row] = await sql<{ id: number }[]>`SELECT id FROM staff WHERE username = ${username}`;
    const id = row?.id ?? (await createStaff(sql, { username, displayName, role, password: DEMO_PASSWORD, mustChangePassword: false }));
    return { id, username, displayName, role, duties: [], mustChangePassword: false } satisfies Actor;
  };
  const owner = await ensureStaff('linlan', '林岚', 'owner');
  const clerk = await ensureStaff('xiaozhou', '周小舟', 'clerk');
  const clerk2 = await ensureStaff('ajie', '阿杰', 'clerk');

  // 套餐与项目
  const [planCount] = await sql<{ count: number }[]>`SELECT count(*) AS count FROM recharge_plans`;
  if (!planCount?.count) {
    for (const [i, p] of PLANS.entries()) {
      await sql`INSERT INTO recharge_plans (name, pay_amount, bonus_amount, note, sort_order) VALUES (${p.name}, ${p.pay}, ${p.bonus}, ${p.note}, ${i})`;
    }
  }
  const [itemCount] = await sql<{ count: number }[]>`SELECT count(*) AS count FROM service_items`;
  if (!itemCount?.count) {
    for (const [i, it] of DEMO_ITEMS.entries()) {
      await sql`INSERT INTO service_items (name, category, price, sort_order) VALUES (${it.name}, ${it.category}, ${it.price}, ${i})`;
    }
  }
  const plans = await sql<{ id: number; payAmount: number; bonusAmount: number }[]>`SELECT id, pay_amount, bonus_amount FROM recharge_plans WHERE active ORDER BY sort_order`;
  const items = await sql<{ id: number; price: number }[]>`SELECT id, price FROM service_items WHERE active ORDER BY sort_order`;

  const deps: Deps = { sql, config };
  const settings = await loadSettings(sql);
  const now = new Date();
  const today = businessDateOf(now, config.timezone, settings.businessDayStartHour);
  const days = options.days ?? 6;
  const random = rng(20261025);
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!;
  const staffPool = [owner, clerk, clerk, clerk2];

  // 会员
  const members: { id: number }[] = [];
  for (const [i, name] of NAMES.entries()) {
    const phone = `1990000${String(1001 + i).padStart(4, '0')}`;
    const [found] = await sql<{ id: number }[]>`SELECT id FROM members WHERE phone = ${phone}`;
    if (found) {
      members.push(found);
      continue;
    }
    const m = await createMember(
      sql,
      {
        name,
        phone,
        gender: i % 3 === 0 ? 'male' : 'female',
        birthday: null,
        note: i === 0 ? '喜欢靠窗的位置，常点柚子气泡水' : i === 24 ? '长姓名样例，用于检查界面排版' : '',
      },
      { actor: pick(staffPool) },
      { enforceRequired: false },
    );
    await sql`UPDATE members SET is_synthetic = true WHERE id = ${m.id}`;
    members.push({ id: m.id });
  }

  const doRecharge = (memberId: number, at: Date, actor: Actor) => {
    const plan = pick(plans);
    return recharge(
      deps,
      {
        idempotencyKey: randomUUID(),
        memberId,
        planId: plan.id,
        paidAmount: plan.payAmount,
        bonusAmount: plan.bonusAmount,
        paymentMethod: pick(['wechat', 'wechat', 'alipay', 'cash', 'bank_card'] as const),
        paymentRef: '',
        note: '',
        paymentConfirmed: true,
      },
      { actor, at },
    );
  };

  const doConsume = async (memberId: number, at: Date, actor: Actor) => {
    const lineCount = 1 + Math.floor(random() * 3);
    const chosen = new Map<number, number>();
    for (let k = 0; k < lineCount; k++) {
      const item = pick(items);
      chosen.set(item.id, (chosen.get(item.id) ?? 0) + 1);
    }
    const lines = [...chosen].map(([itemId, quantity]) => ({ itemId, quantity }));
    const total = lines.reduce((s, l) => s + items.find((i) => i.id === l.itemId)!.price * l.quantity, 0);
    try {
      return await consume(deps, { idempotencyKey: randomUUID(), memberId, lines, expectedTotal: total, note: '' }, { actor, at });
    } catch {
      return null; // 余额不足时跳过
    }
  };

  // 历史营业日：先给每位会员开卡充值，再逐日生成消费
  const startDate = shiftDate(today, -days);
  for (const [i, m] of members.entries()) {
    if (i === members.length - 3) continue; // 留两位零余额会员用于空状态与余额不足
    if (i === members.length - 2) continue;
    await doRecharge(m.id, localTime(startDate, 11 + (i % 10), (i * 7) % 60), pick(staffPool));
  }
  for (let d = days - 1; d >= 0; d--) {
    const date = shiftDate(today, -d);
    const isToday = d === 0;
    const count = isToday ? 7 : 6 + Math.floor(random() * 6);
    const times: Date[] = [];
    for (let k = 0; k < count; k++) {
      const t = isToday
        ? new Date(now.getTime() - (count - k) * 11 * 60_000)
        : localTime(date, 10 + Math.floor((k / count) * 14), Math.floor(random() * 60));
      if (businessDateOf(t, config.timezone, settings.businessDayStartHour) === date) times.push(t);
    }
    const consumed: number[] = [];
    for (const [k, at] of times.entries()) {
      const member = pick(members.slice(0, members.length - 3));
      const actor = pick(staffPool);
      if (k % 4 === 1) {
        await doRecharge(member.id, at, actor);
      } else {
        const r = await doConsume(member.id, at, actor);
        if (r?.type === 'consume') consumed.push(r.consumption.id);
      }
    }
    // 每隔一天有一笔撤销
    if (consumed.length > 0 && d % 2 === 0) {
      const target = consumed[consumed.length - 1]!;
      const at = new Date((times[times.length - 1] ?? now).getTime() + 3 * 60_000);
      if (at < now) {
        await reverse(deps, target, { idempotencyKey: randomUUID(), reason: pick(['项目选错', '金额录入错误', '重复登记']) }, { actor: owner, at });
      }
    }
  }

  return { skipped: false as const, members: members.length, owner: owner.username, clerk: clerk.username };
}
