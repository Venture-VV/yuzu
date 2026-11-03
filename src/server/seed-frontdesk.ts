// 前台（S2 / Batch 2.2）合成演示数据：店主 2026-10-27 的真实柜号清单（747 个，男宾 / 女宾，普通柜与 VIP 柜）+ 13 位在店客人，
// 覆盖散客、会员、一家三口同行（孩子跟爸爸用男宾牌）、朋友后到同行、丢牌换牌并收赔偿、时限内作废明细、超 6 小时在店、
// 刚开牌未挂账、撤销误开的牌，以及第 1 / 2 / 3 级会员使用对应等级的 VIP 柜。
// 固定预期结果见 demo/frontdesk-expected.json。
//
// 只用于独立的演示 / 开发库：
//   · 试用与正式环境一律拒绝（不得向正在试用的数据库灌入样例）；
//   · 库里已有非演示手牌时拒绝，避免与真实手牌池混在一起；
//   · 已经灌过则跳过，可重复执行。
// 所有业务都走正式的接待、挂账、作废、换牌、同行流程，因此账单与明细天然一致。
// 演示会员通过正式充值流程获得余额与会员等级；前台挂账不会改变会员余额。

import { randomUUID } from 'node:crypto';
import type { Zone } from '@shared/frontdesk';
import { parseHandTagCsv } from '@shared/hand-tag-import';
import type { AppConfig } from './config';
import { withShiftOptional } from './demo/shift-rule';
import type { Sql } from './db';
import { STORE_HAND_TAGS_CSV } from './demo/hand-tags-2026-10-27';
import type { Actor, Deps, OpContext } from './lib/context';
import { postCharges, voidLine } from './modules/frontdesk/bills';
import { importHandTags, lockHandTag } from './modules/frontdesk/tags';
import { cancelVisit, changeGroup, checkin, swapTag } from './modules/frontdesk/visits';
import { createMember } from './modules/members';
import { createStaff } from './modules/staff';
import { recharge } from './modules/wallet';
import { DEMO_ITEMS, DEMO_PASSWORD } from './seed';

/** 演示会员与充值（每笔不超过默认单笔上限 5 万元）；会员等级按默认口径「累计充值实收」：≥0 第 1 级、≥5 万第 2 级、≥10 万第 3 级 */
const MEMBERS = [
  { name: '韩松（演示）', phone: '19900008801', gender: 'male' as const, recharges: [{ paid: 100000, bonus: 15000 }] },
  { name: '乔木（演示）', phone: '19900008802', gender: 'female' as const, recharges: [{ paid: 50000, bonus: 5000 }] },
  { name: '周董（演示）', phone: '19900008803', gender: 'male' as const, recharges: [4_000_000, 4_000_000, 4_000_000].map((paid) => ({ paid, bonus: 0 })) },
  { name: '林女士（演示）', phone: '19900008804', gender: 'female' as const, recharges: [2_500_000, 2_500_000].map((paid) => ({ paid, bonus: 0 })) },
];

export async function seedFrontdeskDemo(sql: Sql, config: AppConfig, options: { now?: Date } = {}) {
  // 演示会员的充值按「开班可选」入账（R1.2 起默认收款前必须先开班）
  return withShiftOptional(sql, config, () => seedFrontdesk(sql, config, options));
}

async function seedFrontdesk(sql: Sql, config: AppConfig, options: { now?: Date }) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入前台演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [real] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags WHERE NOT is_synthetic`;
  if (real!.n > 0) throw new Error('库里已有非演示的手牌，为避免混入真实数据，已停止。请使用独立的演示库。');
  const [done] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM hand_tags WHERE is_synthetic`;
  if (done!.n > 0) return { skipped: true as const };

  const deps: Deps = { sql, config };
  const ensure = async (username: string, displayName: string, role: 'owner' | 'clerk' | 'duty_manager'): Promise<Actor> => {
    const [row] = await sql<{ id: number; role: Actor['role'] }[]>`SELECT id, role FROM staff WHERE username = ${username}`;
    const id = row?.id ?? (await createStaff(sql, { username, displayName, role, password: DEMO_PASSWORD, mustChangePassword: false }));
    return { id, username, displayName, role: row?.role ?? role, duties: [], mustChangePassword: false };
  };
  const owner = await ensure('linlan', '林岚', 'owner');
  const clerk = await ensure('xiaozhou', '周小舟', 'clerk');
  // 值班经理：当场授权 VIP 柜、作废他人或超时的明细（Batch 2.1 岗位）
  await ensure('zhangjl', '张经理', 'duty_manager');

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

  // 手牌池：店主的真实柜号清单，在演示库里标记为合成
  const list = parseHandTagCsv(STORE_HAND_TAGS_CSV);
  if (list.errors.length) throw new Error(`内置柜号清单有误：${list.errors[0]!.message}`);
  await importHandTags(sql, { rows: list.rows, dryRun: false }, { staffId: owner.id, via: 'demo' }, { synthetic: true });

  // 演示会员：通过正式充值流程获得余额（已存在同号演示会员时沿用）
  const memberIds = new Map<string, number>();
  for (const m of MEMBERS) {
    const [found] = await sql<{ id: number; isSynthetic: boolean }[]>`SELECT id, is_synthetic FROM members WHERE phone = ${m.phone}`;
    if (found && !found.isSynthetic) throw new Error(`手机号 ${m.phone} 属于真实会员，已停止`);
    let id = found?.id;
    if (!id) {
      id = (await createMember(sql, { name: m.name, phone: m.phone, gender: m.gender, birthday: null, note: '前台演示会员' }, { actor: owner }, { enforceRequired: false })).id;
      await sql`UPDATE members SET is_synthetic = true WHERE id = ${id}`;
      for (const r of m.recharges) {
        await recharge(deps, { idempotencyKey: randomUUID(), memberId: id, planId: null, paidAmount: r.paid, bonusAmount: r.bonus, paymentMethod: 'wechat', paymentConfirmed: true }, { actor: owner }, { history: true });
      }
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
  const open = async (guests: { tagCode: string; zone: Zone; guestLabel?: string; memberId?: number }[], ctx: OpContext, joinVisitId: number | null = null) =>
    (await checkin(deps, { clientKey: randomUUID(), guests: guests.map((g) => ({ memberId: null, guestLabel: '', ...g })), joinVisitId }, ctx)).visits;

  // ① 夜场客：在店 7 小时（超 6 小时提示）
  const [night] = await open([{ tagCode: 'B6215', zone: 'female', guestLabel: '夜场客' }], as(clerk, 420));
  await charge(night!.id, [['夜场入场', 1]], as(clerk, 418));

  // ② 会员韩松（第 1 级）：用第 1 级 VIP 柜 8001，按摩与简餐挂账（只显示余额，不扣款）
  const [m1] = await open([{ tagCode: '8001', zone: 'male', memberId: memberIds.get('韩松（演示）')! }], as(clerk, 180));
  await charge(m1!.id, [['精油按摩 60 分钟', 1]], as(clerk, 170));
  await charge(m1!.id, [['山野简餐', 1]], as(clerk, 95));

  // ③ 散客王先生：门票 + 两瓶气泡水
  const [wang] = await open([{ tagCode: 'A8062', zone: 'male', guestLabel: '王先生' }], as(clerk, 130));
  await charge(wang!.id, [['汤泉入场 · 成人', 1], ['柚子气泡水', 2]], as(clerk, 128));

  // ④ 一家三口一次接待：自动建同行组；孩子跟爸爸进男宾区，用男宾牌、挂儿童票
  const family = await open(
    [
      { tagCode: 'A8075', zone: 'male', guestLabel: '爸爸' },
      { tagCode: 'A6010', zone: 'female', guestLabel: '妈妈' },
      { tagCode: 'A8076', zone: 'male', guestLabel: '孩子' },
    ],
    as(clerk, 100),
  );
  await charge(family[0]!.id, [['汤泉入场 · 成人', 1]], as(clerk, 99));
  await charge(family[1]!.id, [['汤泉入场 · 成人', 1]], as(clerk, 99));
  await charge(family[2]!.id, [['汤泉入场 · 儿童', 1]], as(clerk, 99));
  await charge(family[1]!.id, [['搓背', 1]], as(clerk, 60));

  // ⑤ 李先生：A8090 丢失，换到 A8091、锁定 A8090，并挂丢牌赔偿 200 元；账单跟着人走
  const [li] = await open([{ tagCode: 'A8090', zone: 'male', guestLabel: '李先生' }], as(clerk, 90));
  await charge(li!.id, [['夜场入场', 1]], as(clerk, 88));
  await swapTag(deps, li!.id, { clientKey: randomUUID(), toTagCode: 'A8091', reason: '手牌丢失', lockOld: true, lostFee: 20000 }, as(clerk, 40));

  // ⑥ 会员乔木先到，闺蜜后到：在店内加入同行
  const [m2] = await open([{ tagCode: 'A6020', zone: 'female', memberId: memberIds.get('乔木（演示）')! }], as(clerk, 50));
  await charge(m2!.id, [['足疗 45 分钟', 1]], as(clerk, 45));
  const [friend] = await open([{ tagCode: 'A6021', zone: 'female', guestLabel: '闺蜜' }], as(clerk, 20));
  await changeGroup(deps, friend!.id, { action: 'join', targetVisitId: m2!.id }, as(clerk, 19));
  await charge(friend!.id, [['浴服加购', 1]], as(clerk, 18));

  // ⑦ 赵先生：店员登记错了搓背，3 分钟后在时限内自行作废
  const [zhao] = await open([{ tagCode: 'A8100', zone: 'male', guestLabel: '赵先生' }], as(clerk, 35));
  const wrong = await charge(zhao!.id, [['搓背', 1]], as(clerk, 30));
  await voidLine(deps, wrong.lines[0]!.id, { reason: '项目选错' }, as(clerk, 27));
  await charge(zhao!.id, [['柚子气泡水', 1]], as(clerk, 26));

  // ⑧ 开错的牌：A8095 开出后立即撤销
  const [mistake] = await open([{ tagCode: 'A8095', zone: 'male' }], as(clerk, 15));
  await cancelVisit(deps, mistake!.id, { reason: '开错手牌' }, as(clerk, 14));

  // ⑨ 刚开牌、还没挂账的客人
  await open([{ tagCode: 'B6216', zone: 'female', guestLabel: '刚到的客人' }], as(clerk, 5));

  // ⑩ 会员周董（累计充值 12 万，第 3 级）：用第 3 级 VIP 柜 9058
  const [boss] = await open([{ tagCode: '9058', zone: 'male', memberId: memberIds.get('周董（演示）')! }], as(clerk, 150));
  await charge(boss!.id, [['精油按摩 60 分钟', 1], ['搓背', 1]], as(clerk, 140));

  // ⑪ 会员林女士（累计充值正好 5 万，第 2 级）：用女宾第 2 级 VIP 柜 9001
  const [lin] = await open([{ tagCode: '9001', zone: 'female', memberId: memberIds.get('林女士（演示）')! }], as(clerk, 70));
  await charge(lin!.id, [['足疗 45 分钟', 1]], as(clerk, 65));

  // 异常锁定的手牌
  const lockByCode = async (code: string, reason: string) => {
    const [t] = await sql<{ id: number }[]>`SELECT id FROM hand_tags WHERE code = ${code}`;
    await lockHandTag(deps, t!.id, { reason }, { actor: owner });
  };
  await lockByCode('A8185', '手牌丢失');
  await lockByCode('D6750', '柜锁故障');

  const [stats] = await sql<{ tags: number; inStore: number }[]>`
    SELECT (SELECT count(*) FROM hand_tags) AS tags, (SELECT count(*) FROM visits WHERE status = 'open') AS in_store`;
  return { skipped: false as const, tags: stats!.tags, inStore: stats!.inStore };
}
