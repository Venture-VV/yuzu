// 前台（S2）合成演示数据：手牌池 + 11 位在店客人，覆盖散客、会员、一家三口同行、朋友后到同行、
// 换牌锁定原牌、时限内作废明细、超 6 小时在店、刚开牌未挂账、撤销误开的牌。
// 固定预期结果见 demo/frontdesk-expected.json。
//
// 只用于独立的演示 / 开发库：
//   · 试用与正式环境一律拒绝（不得向正在试用的数据库灌入样例）；
//   · 库里已有非演示手牌时拒绝，避免与真实手牌池混在一起；
//   · 已经灌过则跳过，可重复执行。
// 所有业务都走正式的接待、挂账、作废、换牌、同行流程，因此账单与明细天然一致。
// 演示会员通过正式充值流程获得余额；前台挂账不会改变这两位会员的余额。

import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config';
import type { Sql } from './db';
import type { Actor, Deps, OpContext } from './lib/context';
import { postCharges, voidLine } from './modules/frontdesk/bills';
import { lockHandTag } from './modules/frontdesk/tags';
import { cancelVisit, changeGroup, checkin, swapTag } from './modules/frontdesk/visits';
import { createMember } from './modules/members';
import { createStaff } from './modules/staff';
import { recharge } from './modules/wallet';
import { DEMO_ITEMS, DEMO_PASSWORD } from './seed';

const TAG_RANGES = [
  { zone: 'male', prefix: 'A', count: 40 },
  { zone: 'female', prefix: 'B', count: 40 },
  { zone: 'child', prefix: 'C', count: 12 },
] as const;

const MEMBERS = [
  { name: '韩松（演示）', phone: '19900008801', gender: 'male' as const, paid: 100000, bonus: 15000 },
  { name: '乔木（演示）', phone: '19900008802', gender: 'female' as const, paid: 50000, bonus: 5000 },
];

export async function seedFrontdeskDemo(sql: Sql, config: AppConfig, options: { now?: Date } = {}) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入前台演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [real] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags WHERE NOT is_synthetic`;
  if (real!.n > 0) throw new Error('库里已有非演示的手牌，为避免混入真实数据，已停止。请使用独立的演示库。');
  const [done] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags WHERE is_synthetic`;
  if (done!.n > 0) return { skipped: true as const };

  const deps: Deps = { sql, config };
  const ensure = async (username: string, displayName: string, role: 'owner' | 'clerk'): Promise<Actor> => {
    const [row] = await sql<{ id: number; role: Actor['role'] }[]>`SELECT id, role FROM staff WHERE username = ${username}`;
    const id = row?.id ?? (await createStaff(sql, { username, displayName, role, password: DEMO_PASSWORD, mustChangePassword: false }));
    return { id, username, displayName, role: row?.role ?? role, duties: [], mustChangePassword: false };
  };
  const owner = await ensure('linlan', '林岚', 'owner');
  const clerk = await ensure('xiaozhou', '周小舟', 'clerk');

  // 项目：演示金额依赖固定价格，已有同名项目但价格不同时停止，避免预期结果对不上
  const items = new Map<string, number>();
  for (const [i, it] of DEMO_ITEMS.entries()) {
    const [found] = await sql<{ id: number; price: number; active: boolean }[]>`SELECT id, price, active FROM service_items WHERE name = ${it.name}`;
    if (found) {
      if (found.price !== it.price || !found.active) {
        throw new Error(`项目「${it.name}」的价格或状态与演示设定不同（应为 ¥${(it.price / 100).toFixed(2)} 且启用），请使用新的独立演示库`);
      }
      items.set(it.name, found.id);
    } else {
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO service_items (name, category, price, sort_order) VALUES (${it.name}, ${it.category}, ${it.price}, ${i}) RETURNING id`;
      items.set(it.name, row!.id);
    }
  }

  // 手牌池（全部标记为合成）
  for (const r of TAG_RANGES) {
    const codes = Array.from({ length: r.count }, (_, i) => `${r.prefix}${String(i + 1).padStart(3, '0')}`);
    await sql`INSERT INTO hand_tags (code, zone, is_synthetic) SELECT unnest(${codes}::text[]), ${r.zone}, true`;
  }

  // 演示会员：通过正式充值流程获得余额（已存在同号演示会员时沿用）
  const memberIds = new Map<string, number>();
  for (const m of MEMBERS) {
    const [found] = await sql<{ id: number; isSynthetic: boolean }[]>`SELECT id, is_synthetic FROM members WHERE phone = ${m.phone}`;
    if (found && !found.isSynthetic) throw new Error(`手机号 ${m.phone} 属于真实会员，已停止`);
    let id = found?.id;
    if (!id) {
      id = (await createMember(sql, { name: m.name, phone: m.phone, gender: m.gender, birthday: null, note: '前台演示会员' }, { actor: owner })).id;
      await sql`UPDATE members SET is_synthetic = true WHERE id = ${id}`;
      await recharge(deps, { idempotencyKey: randomUUID(), memberId: id, planId: null, paidAmount: m.paid, bonusAmount: m.bonus, paymentMethod: 'wechat', paymentConfirmed: true }, { actor: owner });
    }
    memberIds.set(m.name, id);
  }

  const now = options.now ?? new Date();
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const as = (actor: Actor, minAgo: number): OpContext => ({ actor, at: ago(minAgo) });
  const item = (name: string) => items.get(name)!;
  const price = (name: string) => DEMO_ITEMS.find((i) => i.name === name)!.price;
  const charge = async (visitId: number, lines: [string, number][], ctx: OpContext) =>
    postCharges(deps, visitId, { clientKey: randomUUID(), lines: lines.map(([n, q]) => ({ itemId: item(n), quantity: q })), expectedTotal: lines.reduce((s, [n, q]) => s + price(n) * q, 0) }, ctx);
  const open = async (guests: { tagCode: string; zone: 'male' | 'female' | 'child'; guestLabel?: string; memberId?: number }[], ctx: OpContext, joinVisitId: number | null = null) =>
    (await checkin(deps, { clientKey: randomUUID(), guests: guests.map((g) => ({ memberId: null, guestLabel: '', ...g })), joinVisitId }, ctx)).visits;

  // ① 夜场客：在店 7 小时（超 6 小时提示）
  const [night] = await open([{ tagCode: 'B030', zone: 'female', guestLabel: '夜场客' }], as(clerk, 420));
  await charge(night!.id, [['夜场入场', 1]], as(clerk, 418));

  // ② 会员林小满：3 小时前入场，按摩与简餐挂账（只显示余额，不扣款）
  const [m1] = await open([{ tagCode: 'A008', zone: 'male', memberId: memberIds.get('韩松（演示）')! }], as(clerk, 180));
  await charge(m1!.id, [['精油按摩 60 分钟', 1]], as(clerk, 170));
  await charge(m1!.id, [['山野简餐', 1]], as(clerk, 95));

  // ③ 散客王先生：门票 + 两瓶气泡水
  const [wang] = await open([{ tagCode: 'A003', zone: 'male', guestLabel: '王先生' }], as(clerk, 130));
  await charge(wang!.id, [['汤泉入场 · 成人', 1], ['柚子气泡水', 2]], as(clerk, 128));

  // ④ 一家三口一次接待：自动建同行组
  const family = await open(
    [
      { tagCode: 'A015', zone: 'male', guestLabel: '爸爸' },
      { tagCode: 'B015', zone: 'female', guestLabel: '妈妈' },
      { tagCode: 'C003', zone: 'child', guestLabel: '孩子' },
    ],
    as(clerk, 100),
  );
  await charge(family[0]!.id, [['汤泉入场 · 成人', 1]], as(clerk, 99));
  await charge(family[1]!.id, [['汤泉入场 · 成人', 1]], as(clerk, 99));
  await charge(family[2]!.id, [['汤泉入场 · 儿童', 1]], as(clerk, 99));
  await charge(family[1]!.id, [['搓背', 1]], as(clerk, 60));

  // ⑤ 李先生：A021 丢失，换到 A022 并锁定 A021，账单跟着人走
  const [li] = await open([{ tagCode: 'A021', zone: 'male', guestLabel: '李先生' }], as(clerk, 90));
  await charge(li!.id, [['夜场入场', 1]], as(clerk, 88));
  await swapTag(deps, li!.id, { clientKey: randomUUID(), toTagCode: 'A022', reason: '手牌丢失', lockOld: true }, as(clerk, 40));

  // ⑥ 会员周以安先到，闺蜜后到：在店内加入同行
  const [m2] = await open([{ tagCode: 'B021', zone: 'female', memberId: memberIds.get('乔木（演示）')! }], as(clerk, 50));
  await charge(m2!.id, [['足疗 45 分钟', 1]], as(clerk, 45));
  const [friend] = await open([{ tagCode: 'B022', zone: 'female', guestLabel: '闺蜜' }], as(clerk, 20));
  await changeGroup(deps, friend!.id, { action: 'join', targetVisitId: m2!.id }, as(clerk, 19));
  await charge(friend!.id, [['浴服加购', 1]], as(clerk, 18));

  // ⑦ 赵先生：店员登记错了搓背，5 分钟内自行作废
  const [zhao] = await open([{ tagCode: 'A030', zone: 'male', guestLabel: '赵先生' }], as(clerk, 35));
  const wrong = await charge(zhao!.id, [['搓背', 1]], as(clerk, 30));
  await voidLine(deps, wrong.lines[0]!.id, { reason: '项目选错' }, as(clerk, 27));
  await charge(zhao!.id, [['柚子气泡水', 1]], as(clerk, 26));

  // ⑧ 开错的牌：A025 开出后立即撤销
  const [mistake] = await open([{ tagCode: 'A025', zone: 'male' }], as(clerk, 15));
  await cancelVisit(deps, mistake!.id, { reason: '开错手牌' }, as(clerk, 14));

  // ⑨ 刚开牌、还没挂账的小朋友
  await open([{ tagCode: 'C010', zone: 'child', guestLabel: '小朋友' }], as(clerk, 5));

  // 异常锁定的手牌
  const lockByCode = async (code: string, reason: string) => {
    const [t] = await sql<{ id: number }[]>`SELECT id FROM hand_tags WHERE code = ${code}`;
    await lockHandTag(deps, t!.id, { reason }, { actor: owner });
  };
  await lockByCode('A039', '手牌丢失');
  await lockByCode('B040', '柜锁故障');

  const [stats] = await sql<{ tags: number; inStore: number }[]>`
    SELECT (SELECT count(*) FROM hand_tags) AS tags, (SELECT count(*) FROM visits WHERE status = 'open') AS in_store`;
  return { skipped: false as const, tags: stats!.tags, inStore: stats!.inStore };
}
