// v0.7.28 ⑦（docs/SCHEDULE_FINISH.md 第 8 节，N8）：会员实体卡——发卡、刷卡找会员、挂失、补卡。全部是合成数据。
//   · 发卡：卡号规整（去空格、横线、转大写）；同一编号重提返回原来那张、内容不同拒绝；一位会员一张在用的；同一张卡不能发给两个人；会员码不是卡号；
//   · 刷卡找会员：查找框按在用的卡号找到会员（合并过的找到合并到的那位）；挂失的卡号查不到人，查卡给出卡主；
//   · 补卡：卡坏了换下在用的（写原因，原卡号以后可以再发）；挂失后补新卡（挂失的卡号不能再发）；
//   · 停用的会员不能发卡；确认作废后原请求晚到整笔拒绝。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberCard, MemberCardLookup } from '../src/shared/member-cards';
import type { MemberSummary } from '../src/shared/types';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let am: string;

const issue = (memberId: number, body: Record<string, unknown>, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/members/${memberId}/cards`, { clientKey, ...body });
const cardsOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/cards`)).body as MemberCard[];
const search = async (q: string) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members?q=${encodeURIComponent(q)}`)).body as MemberSummary[];
const lookup = async (cardNo: string) => (await api(ctx.app, ctx.clerk, 'GET', `/api/member-cards/lookup?cardNo=${encodeURIComponent(cardNo)}`)).body as MemberCardLookup;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  am = await login(ctx.app, 'am');
});
afterAll(async () => ctx?.close());

describe('发卡与刷卡找会员', () => {
  it('卡号规整；同一编号重提返回原来那张、内容不同拒绝；查找框刷卡找到这位会员', async () => {
    const a = await createMember(ctx, '持卡甲', '19900000101');
    const key = randomUUID();
    const r = await issue(a.id, { cardNo: '0012 3456-78' }, ctx.clerk, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, card: { cardNo: '0012345678', memberId: a.id, status: 'active', issuedByName: '测试店员', replacesId: null } });
    expect((await issue(a.id, { cardNo: '0012345678' }, ctx.clerk, key)).body).toMatchObject({ replayed: true, card: { id: r.body.card.id } });
    expect((await issue(a.id, { cardNo: '0012345679' }, ctx.clerk, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 刷卡（读卡器打进查找框，带不带空格都行）：这位会员排在最前
    expect((await search('0012345678'))[0]).toMatchObject({ id: a.id, name: '持卡甲' });
    expect((await search(' 0012 345 678 '))[0]?.id).toBe(a.id);
    expect(await lookup('0012345678')).toMatchObject({ cardNo: '0012345678', status: 'active', member: { id: a.id } });
    expect(await lookup('NOSUCHCARD')).toEqual({ cardNo: 'NOSUCHCARD', status: 'unknown', member: null });
    // 客户经理也能发卡（N8）
    const b = await createMember(ctx, '持卡乙', '19900000102');
    expect((await issue(b.id, { cardNo: 'a1b2c3d4' }, am)).body.card).toMatchObject({ cardNo: 'A1B2C3D4', status: 'active' });
  });

  it('一位会员一张在用的；同一张卡不能发给两个人；会员码不是卡号；卡号格式；停用的会员不能发卡', async () => {
    const a = await createMember(ctx, '持卡丙', '19900000103');
    const b = await createMember(ctx, '持卡丁', '19900000104');
    expect((await issue(a.id, { cardNo: 'C0000001' })).status).toBe(200);
    const again = await issue(a.id, { cardNo: 'C0000002' });
    expect(again.body.error.code).toBe('CARD_EXISTS');
    expect(again.body.error.message).toContain('0001');
    const taken = await issue(b.id, { cardNo: 'c000-0001' });
    expect(taken.body.error.code).toBe('CARD_TAKEN');
    expect(taken.body.error.message).toContain('持卡丙');
    expect((await issue(b.id, { cardNo: '8123456789012345' })).status).toBe(400);
    expect((await issue(b.id, { cardNo: 'AB1' })).status).toBe(400);
    expect((await issue(b.id, { cardNo: '卡号12345' })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${b.id}/status`, { clientKey: randomUUID(), status: 'frozen', reason: '会员本人要求' })).status).toBe(200);
    expect((await issue(b.id, { cardNo: 'D0000001' })).body.error.code).toBe('MEMBER_INACTIVE');
  });
});

describe('挂失与补卡', () => {
  it('卡坏了：补卡换下在用的（写原因），原卡号以后可以再发；挂失：原卡查不到人、提醒卡主，不能再发；挂失后补新卡', async () => {
    const a = await createMember(ctx, '持卡戊', '19900000105');
    const b = await createMember(ctx, '持卡己', '19900000106');
    const first = (await issue(a.id, { cardNo: 'E0000001' })).body.card as MemberCard;
    // 补卡换下在用的：不写原因拒绝
    expect((await issue(a.id, { cardNo: 'E0000002', replace: true })).status).toBe(400);
    const second = await issue(a.id, { cardNo: 'E0000002', replace: true, replaceReason: '卡坏了' });
    expect(second.body.card).toMatchObject({ cardNo: 'E0000002', status: 'active', replacesId: first.id });
    expect((await cardsOf(a.id)).map((c) => [c.cardNo, c.status, c.endReason])).toEqual([
      ['E0000002', 'active', null],
      ['E0000001', 'canceled', '卡坏了'],
    ]);
    // 换下的卡号查找框找不到人，查卡说已换下；可以再发给别人
    expect((await search('E0000001')).some((m) => m.id === a.id)).toBe(false);
    expect(await lookup('E0000001')).toMatchObject({ status: 'canceled', member: { id: a.id } });
    expect((await issue(b.id, { cardNo: 'E0000001' })).body.card).toMatchObject({ memberId: b.id, status: 'active' });

    // 挂失：要写原因；挂失后查找框找不到人、查卡给出卡主；同一张卡不能再挂失、不能再发
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/member-cards/${second.body.card.id}/lost`, { reason: '' })).status).toBe(400);
    const lost = await api(ctx.app, ctx.clerk, 'POST', `/api/member-cards/${second.body.card.id}/lost`, { reason: '客人来电说卡丢了' });
    expect(lost.body).toMatchObject({ status: 'lost', endReason: '客人来电说卡丢了', endedByName: '测试店员' });
    expect((await search('E0000002')).some((m) => m.id === a.id)).toBe(false);
    expect(await lookup('E0000002')).toMatchObject({ status: 'lost', member: { id: a.id, name: '持卡戊' } });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/member-cards/${second.body.card.id}/lost`, { reason: '再挂失' })).body.error.code).toBe('CARD_NOT_ACTIVE');
    const reuse = await issue(b.id, { cardNo: 'E0000002', replace: true, replaceReason: '换卡' });
    expect(reuse.body.error.code).toBe('CARD_LOST');
    // 挂失后补卡：不用写原因，记下换的是挂失的那张
    const third = await issue(a.id, { cardNo: 'E0000003', replace: true });
    expect(third.body.card).toMatchObject({ cardNo: 'E0000003', status: 'active', replacesId: second.body.card.id });
    expect((await search('E0000003'))[0]?.id).toBe(a.id);
  });

  it('合并过的会员：刷原来那位的卡找到合并到的那位', async () => {
    const src = await createMember(ctx, '合并来源', '19900000107');
    const dst = await createMember(ctx, '合并目标', '19900000108');
    expect((await issue(src.id, { cardNo: 'F0000001' })).status).toBe(200);
    const check = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${src.id}/merge-check?targetId=${dst.id}`)).body;
    const m = await api(ctx.app, ctx.owner, 'POST', `/api/members/${src.id}/merge`, {
      clientKey: randomUUID(),
      targetId: dst.id,
      reason: '同一个人建了两份',
      expectedPrincipal: check.principal,
      expectedBonus: check.bonus,
    });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await search('F0000001'))[0]?.id).toBe(dst.id);
    expect(await lookup('F0000001')).toMatchObject({ status: 'active', member: { id: dst.id } });
    // 合并来源的档案不能再发卡
    expect((await issue(src.id, { cardNo: 'F0000002', replace: true })).body.error.code).toBe('MEMBER_MERGED');
  });

  it('结果待确认：确认作废后原请求晚到整笔拒绝；建好后查回能找到', async () => {
    const a = await createMember(ctx, '持卡庚', '19900000109');
    const key = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'member_card', summary: '发卡' })).body).toMatchObject({ abandoned: true });
    expect((await issue(a.id, { cardNo: 'G0000001' }, ctx.clerk, key)).body.error.code).toBe('OP_ABANDONED');
    const key2 = randomUUID();
    const r = await issue(a.id, { cardNo: 'G0000001' }, ctx.clerk, key2);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key2}?type=member_card`)).body).toEqual({ found: true, abandoned: false, refId: r.body.card.id });
  });
});
