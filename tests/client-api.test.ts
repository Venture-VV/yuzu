// 前端请求的结果分类（v0.7.23；Codex 在 main v0.7.22 上报的 P1：付款已经登记、回复却是 500，页面当作被拒绝、丢掉原编号，
// 再点一次就用新编号又登记一笔）。写请求遇到服务器出错（5xx）按「结果不确定」处理——服务端可能已经提交了事务、只是读结果或回复时出错；
// 读请求的 500 仍是普通错误；4xx 是明确拒绝。
// 8.1.3（docs/RESILIENCE_V813.md 第 3.2、3.3 节）：服务器明确没处理的三种（系统忙、请求太频繁、系统正忙）原样自动重发；
// 判定连不上服务器以后写请求不发、报「没发出去」（第一次提交可以当成明确拒绝，重提不行）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ApiModule = typeof import('../src/client/lib/api');
let mod: ApiModule;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const PING = { ok: true, version: '8.1.3', commit: '', instance: 'test', client: null, time: new Date().toISOString() };

/** 服务器：/api/ping 照常回（连得上），其余按给的顺序回；calls 记下除 ping 以外的请求 */
function server(...replies: Array<() => Response>) {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/ping') return json(200, PING);
      calls.push(url);
      const next = replies[Math.min(i++, replies.length - 1)]!;
      return next();
    }),
  );
  return calls;
}

beforeEach(async () => {
  vi.resetModules(); // 连接状态是模块里的，每条用例从头来
  mod = await import('../src/client/lib/api');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('前端请求的结果分类', () => {
  it('写请求遇到 500：结果不确定（可能已经提交），不是被拒绝；读请求的 500 是普通错误', async () => {
    server(() => json(500, { error: { code: 'INTERNAL', message: '服务器出了点问题，操作可能未完成，请通过单号或流水核对结果' } }));
    const post = await mod.request('POST', '/api/payables/payments', {}).catch((e: unknown) => e);
    expect(post).toBeInstanceOf(mod.UncertainError);
    expect(post).toMatchObject({ reason: 'server' });
    expect(await mod.request('PUT', '/api/membership/rules', {}).catch((e: unknown) => e)).toBeInstanceOf(mod.UncertainError);
    const get = await mod.request('GET', '/api/payables/payments').catch((e: unknown) => e);
    expect(get).toBeInstanceOf(mod.ApiError);
    expect(get).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(mod.isRejected(get)).toBe(false);
  });

  it('502 / 503 / 504（网关说连不上后面）按网络中断、结果不确定；4xx 是明确拒绝，带错误码', async () => {
    for (const status of [502, 503, 504]) {
      server(() => json(status, {}));
      expect(await mod.request('POST', '/api/x', {}).catch((e: unknown) => e)).toMatchObject({ reason: 'network' });
    }
    server(() => json(422, { error: { code: 'CONSTRAINT', message: '数据校验未通过' } }));
    const rejected = await mod.request('POST', '/api/x', {}).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(mod.ApiError);
    expect(rejected).toMatchObject({ status: 422, code: 'CONSTRAINT' });
    expect(mod.isRejected(rejected)).toBe(true);
  });
});

describe('服务器明确没处理的自动重发（WL5）', () => {
  const busy = () => json(409, { error: { code: 'BUSY', message: '该会员正在被其他终端操作，本次未生效，请稍后重试' } });

  it('系统忙：同样的请求原样重发，成功了就当没事', async () => {
    vi.useFakeTimers();
    const calls = server(busy, busy, () => json(200, { ok: 1 }));
    const pending = mod.request('POST', '/api/members/1/recharge', { clientKey: 'k1', amount: 100 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ ok: 1 });
    expect(calls).toEqual(['/api/members/1/recharge', '/api/members/1/recharge', '/api/members/1/recharge']);
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => u !== '/api/ping').map(([, init]) => (init as RequestInit).body);
    expect(new Set(sent).size).toBe(1); // 同一个操作编号、同样的内容
  });

  it('一直忙：最多再发 3 次，之后照旧报「没生效」（明确拒绝）', async () => {
    vi.useFakeTimers();
    const calls = server(busy);
    const pending = mod.request('POST', '/api/x', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await pending;
    expect(error).toMatchObject({ status: 409, code: 'BUSY' });
    expect(mod.isRejected(error)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('请求太频繁：照 Retry-After 等；要等的太久（超过 12 秒）就不重发了', async () => {
    vi.useFakeTimers();
    const calls = server(
      () => json(429, { error: { code: 'RATE_LIMITED', message: '请求太频繁' } }, { 'retry-after': '1' }),
      () => json(200, { ok: 2 }),
    );
    const pending = mod.request('GET', '/api/y');
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(1); // 还没到 1 秒
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({ ok: 2 });

    const long = server(() => json(429, { error: { code: 'RATE_LIMITED', message: '请求太频繁' } }, { 'retry-after': '60' }));
    const error = await mod.request('POST', '/api/z', {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterMs: 60_000 });
    expect(long).toHaveLength(1);
  });

  it('系统正忙（过载保护的 503 带错误码）：确定没处理，重发；不当成网关的 503（结果不确定）', async () => {
    vi.useFakeTimers();
    const overloaded = () => json(503, { error: { code: 'OVERLOADED', message: '系统正忙，这次没有处理' } }, { 'retry-after': '2' });
    const calls = server(overloaded, () => json(200, { ok: 3 }));
    const pending = mod.request('POST', '/api/x', {});
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(pending).resolves.toEqual({ ok: 3 });
    expect(calls).toHaveLength(2);

    server(overloaded);
    const stuck = mod.request('POST', '/api/x', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await stuck;
    expect(error).toBeInstanceOf(mod.ApiError);
    expect(error).toMatchObject({ status: 503, code: 'OVERLOADED' });
    expect(mod.isRejected(error)).toBe(true);
  });

  it('页面数据（React Query）的重试只在一层：上面三种不再叠一层，明确拒绝不重试，其余最多 2 次', () => {
    expect(mod.shouldRetryQuery(0, new mod.ApiError(409, 'BUSY', 'x'))).toBe(false);
    expect(mod.shouldRetryQuery(0, new mod.ApiError(503, 'OVERLOADED', 'x'))).toBe(false);
    expect(mod.shouldRetryQuery(0, new mod.ApiError(404, 'NOT_FOUND', 'x'))).toBe(false);
    expect(mod.shouldRetryQuery(0, new mod.ApiError(500, 'INTERNAL', 'x'))).toBe(true);
    expect(mod.shouldRetryQuery(1, new mod.UncertainError('network'))).toBe(true);
    expect(mod.shouldRetryQuery(2, new mod.UncertainError('network'))).toBe(false);
    for (let n = 0; n < 6; n++) expect(mod.queryRetryDelay(n)).toBeLessThanOrEqual(15_000);
  });
});

describe('连不上服务器时不发（WL4）', () => {
  it('问了两次都问不到：写请求不发、报「没发出去」；第一次提交可以当成明确拒绝；服务器回来以后照常发', async () => {
    vi.useFakeTimers();
    let up = false;
    const posted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!up) throw new TypeError('Failed to fetch');
        if (url === '/api/ping') return json(200, PING);
        posted.push(url);
        return json(200, { ok: 4 });
      }),
    );
    // 第一次：请求发出去了、断网 → 结果不确定（网络中断）
    const first = await mod.request('POST', '/api/a', {}).catch((e: unknown) => e);
    expect(first).toMatchObject({ reason: 'network' });
    // 页面去问服务器：问不到两次就判定断了（第二次在 2 秒左右以后）
    await vi.advanceTimersByTimeAsync(3_000);
    const conn = await import('../src/client/lib/connection');
    expect(conn.connectionSnapshot().state).toBe('offline');
    // 断了以后再提交：当场再问一次，问不到就不发
    const second = await mod.request('POST', '/api/b', {}).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(mod.OfflineError);
    expect(second).toBeInstanceOf(mod.UncertainError); // 没改过的页面照旧当待确认，不会出错
    const asRejection = mod.notSentAsRejection(second);
    expect(asRejection).toMatchObject({ status: 0, code: 'OFFLINE' });
    expect(mod.isRejected(asRejection)).toBe(true);
    expect(posted).toEqual([]);
    // 服务器回来了：下一次问到就恢复，照常发
    up = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(conn.connectionSnapshot().state).toBe('online');
    await expect(mod.request('POST', '/api/c', {})).resolves.toEqual({ ok: 4 });
    expect(posted).toEqual(['/api/c']);
  });

  it('请求发不出去时还在路上的那次检查，后来成功回来也不算数：再问一次，断了照样判定断了（8.1.5）', async () => {
    vi.useFakeTimers();
    const conn = await import('../src/client/lib/connection');
    let down = false;
    const held: { release?: () => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/ping' && !down && !held.release) return new Promise<Response>((resolve) => (held.release = () => resolve(json(200, PING))));
        return Promise.reject(new TypeError('Failed to fetch'));
      }),
    );
    const before = conn.probe(); // 断网以前发出去的那次检查
    down = true; // 这时网断了
    conn.noteNetworkFailure(); // 一个请求发不出去
    held.release!(); // 那次检查这时才成功回来
    await expect(before).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(conn.connectionSnapshot().state).toBe('offline');
  });
});
