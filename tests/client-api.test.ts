// 前端请求的结果分类（v0.7.23；Codex 在 main v0.7.22 上报的 P1：付款已经登记、回复却是 500，页面当作被拒绝、丢掉原编号，
// 再点一次就用新编号又登记一笔）。写请求遇到服务器出错（5xx）按「结果不确定」处理——服务端可能已经提交了事务、只是读结果或回复时出错；
// 读请求的 500 仍是普通错误；4xx 是明确拒绝。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request, UncertainError } from '../src/client/lib/api';

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('前端请求的结果分类', () => {
  it('写请求遇到 500：结果不确定（可能已经提交），不是被拒绝；读请求的 500 是普通错误', async () => {
    vi.stubGlobal('fetch', reply(500, { error: { code: 'INTERNAL', message: '服务器出了点问题，操作可能未完成，请通过单号或流水核对结果' } }));
    const post = await request('POST', '/api/payables/payments', {}).catch((e: unknown) => e);
    expect(post).toBeInstanceOf(UncertainError);
    expect(post).toMatchObject({ reason: 'server' });
    expect(await request('PUT', '/api/membership/rules', {}).catch((e: unknown) => e)).toBeInstanceOf(UncertainError);
    const get = await request('GET', '/api/payables/payments').catch((e: unknown) => e);
    expect(get).toBeInstanceOf(ApiError);
    expect(get).toMatchObject({ status: 500, code: 'INTERNAL' });
  });

  it('502 / 503 / 504 按网络中断、结果不确定；4xx 是明确拒绝，带错误码', async () => {
    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', reply(status, {}));
      expect(await request('POST', '/api/x', {}).catch((e: unknown) => e)).toMatchObject({ reason: 'network' });
    }
    vi.stubGlobal('fetch', reply(409, { error: { code: 'BUSY', message: '该会员正在被其他终端操作，本次未生效，请稍后重试' } }));
    const busy = await request('POST', '/api/x', {}).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ApiError);
    expect(busy).toMatchObject({ status: 409, code: 'BUSY' });
  });
});
