// AI 辅助（8.0.22，docs/AI_V8022.md 第 8 节）：打码、事实包与工具里没有会员个人信息、工具的参数校验与按权限给、
// 模拟模式的小结每天一份、问数原样重提只答一次、限额与开关、没配模型服务时、合同条款提示、适配器的请求形状。
// 正式的模型调用不在用例里跑（要密钥、要外网）。
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AiQuestionView, AiRules, AiSummaryResponse } from '../src/shared/ai';
import { DEFAULT_AI_RULES } from '../src/shared/ai';
import { shiftDate } from '../src/shared/labels';
import { readSnapshot } from '../src/server/db';
import { AiRefused, claudeProvider, mockAiProvider, type AiProvider, type AiTool } from '../src/server/integrations/ai';
import { runAiSummaries, setAiProviderForTests } from '../src/server/modules/ai';
import { buildDailyFacts } from '../src/server/modules/ai/facts';
import { aiMaskName, aiMaskText, maskForAi, memberTextGuard } from '../src/server/modules/ai/mask';
import { aiTools } from '../src/server/modules/ai/tools';
import { loadSettings } from '../src/server/modules/settings';
import { businessDateOf } from '../src/shared/business-date';
import { api, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let memberNo: string;
const MEMBER_NAME = '欧阳测试';
const MEMBER_PHONE = '13912345678';
/** 系统允许的最长姓名（32 字）：测试会话 e25d122 复验时 21 字以上的没认出来 */
const LONG_NAME = `长${'名字测'.repeat(10)}尾`;

const rules = async (patch: Partial<AiRules>) => {
  const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/ai-rules', patch);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const waitQuestion = async (id: number): Promise<AiQuestionView> => {
  for (let i = 0; i < 50; i++) {
    const r = await api(ctx.app, ctx.owner, 'GET', `/api/ai/questions/${id}`);
    if (r.body.status !== 'running') return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('问数一直在回答中');
};
const noPersonal = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(MEMBER_PHONE);
  expect(text).not.toContain(MEMBER_NAME);
  expect(text).not.toContain('欧阳');
};

beforeAll(async () => {
  ctx = await setup();
  const s = await loadSettings(ctx.sql);
  today = businessDateOf(new Date(), ctx.config.timezone, s.businessDayStartHour);
  // 一位会员、一笔充值：名字和手机号都不能出现在发给模型的内容里
  const m = await createMember(ctx, MEMBER_NAME, MEMBER_PHONE);
  memberNo = (await ctx.sql<{ no: string }[]>`SELECT member_no AS no FROM members WHERE id = ${m.id}`)[0]!.no;
  await createMember(ctx, LONG_NAME);
  // 档案里常见的占位名：不当成某一位会员的姓名认（不然「新会员多少」也会被拦）
  await createMember(ctx, '会员');
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 50_000));
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}, 90_000);
afterEach(() => setAiProviderForTests(undefined));
afterAll(async () => ctx.close());

describe('打码', () => {
  it('会员姓名只留第一个字，手机号留前三后四，证件号去掉', () => {
    expect(aiMaskName('欧阳测试')).toBe('欧*');
    expect(aiMaskText('客人 13912345678 说')).toBe('客人 139****5678 说');
    expect(aiMaskText('证件 11010119900307123X')).toBe('证件 [证件号已隐去]');
    expect(maskForAi({ memberName: '张三', phone: '13912345678', note: '回电 13912345678', n: 3 })).toEqual({ memberName: '张*', phone: '139****5678', note: '回电 139****5678', n: 3 });
  });
});

describe('自由文字里的会员身份（测试会话 80284a9、e25d122 的 P1）', () => {
  it('按会员档案认：系统允许的姓名长度、空格与符号的变形、会员号、手机号；一个字、占位名、不在档案里的不动', async () => {
    expect([...LONG_NAME].length).toBe(32);
    const guard = await memberTextGuard(ctx.sql);
    expect(guard.mask(`会员${MEMBER_NAME}昨天消费多少？会员号 ${memberNo}`)).toBe('会员欧*昨天消费多少？会员号 [会员号]');
    expect(guard.mask(`问一下${LONG_NAME}的情况`)).toBe('问一下长*的情况');
    // 中间夹空格、间隔号、顿号、全角空格；会员号小写、夹横线；手机号夹空格、横线
    expect(guard.mask('欧阳 测试来过吗')).toBe('欧*来过吗');
    expect(guard.mask('欧阳·测试、欧阳　测试')).toBe('欧*、欧*');
    expect(guard.mask(`会员号 ${memberNo.slice(0, 2).toLowerCase()}-${memberNo.slice(2)}`)).toBe('会员号 [会员号]');
    expect(guard.mask('电话 139 1234 5678')).toBe('电话 139****5678');
    expect(guard.find('欧阳 测试 139-1234-5678').map((h) => h.kind)).toEqual(['name', 'phone']);
    expect(guard.find(`${LONG_NAME.slice(0, 10)} ${LONG_NAME.slice(10)}`).map((h) => h.masked)).toEqual(['长*']);
    // 不认的：占位名「会员」、不在档案里的人
    expect(guard.find('这个月新会员多少？欧先生来过吗')).toEqual([]);
    // 不在档案里的手机号、证件号靠正则：中间夹空格、横线的也打码
    expect(aiMaskText('客人 138-0000-1111，证件 110101 19900307 123X')).toBe('客人 138****1111，证件 [证件号已隐去]');
  });
});

describe('事实包与工具', () => {
  it('事实包只有汇总数：没有会员的姓名、手机号', async () => {
    const s = await loadSettings(ctx.sql);
    const facts = await readSnapshot(ctx.sql, (tx) => buildDailyFacts(tx, today, { tz: ctx.config.timezone, startHour: s.businessDayStartHour }, '本店', today));
    expect(facts.members.rechargeCount).toBeGreaterThanOrEqual(1);
    expect(facts.members.rechargePaid).toContain('500');
    noPersonal(facts);
  });

  it('工具：按权限给；参数校验（不晚于今天、最多 92 天）；返回值里没有会员个人信息', async () => {
    const base = { sql: ctx.sql, today, timeZone: ctx.config.timezone, erp: new Set(['inventory', 'payments'] as const), stores: [{ id: 1, code: 'HQ', name: '本店' }], currentStoreId: 1 };
    const all = aiTools({ ...base, can: () => true });
    expect(all.map((t) => t.name).sort()).toEqual(['bookings_overview', 'daily_close', 'dept_items', 'inventory_alerts', 'member_overview', 'payables_week', 'revenue_by_day', 'technician_performance']);
    // 只有经营总览权限的：看不到会员、技师、库存、付款
    const exec = aiTools({ ...base, can: (p) => p === 'report.executive' });
    expect(exec.map((t) => t.name).sort()).toEqual(['bookings_overview', 'daily_close', 'dept_items', 'revenue_by_day']);
    const tool = (name: string) => all.find((t) => t.name === name)!;
    await expect(tool('daily_close').run({ from: today, to: shiftDate(today, 1) })).rejects.toThrow('不能晚于今天');
    await expect(tool('daily_close').run({ from: shiftDate(today, -92), to: today })).rejects.toThrow('最多 92 天');
    await expect(tool('daily_close').run({ from: today, to: today, sql: 'DROP TABLE members' })).rejects.toThrow();
    for (const t of all) {
      expect(t.schema.safeParse(t.example).success, t.name).toBe(true);
      noPersonal(await t.run('from' in t.example ? { ...t.example, from: today, to: today } : t.example));
    }
    const member = (await tool('member_overview').run({ from: today, to: today })) as { rechargeCount: number };
    expect(member.rechargeCount).toBeGreaterThanOrEqual(1);
  });

  it('能进几家店的多一个「门店」参数，只能是自己能进的店', async () => {
    const stores = [
      { id: 1, code: 'HQ', name: '本店' },
      { id: 2, code: 'FT', name: '福田店' },
    ];
    const tools = aiTools({ sql: ctx.sql, today, timeZone: ctx.config.timezone, can: () => true, erp: new Set(), stores, currentStoreId: 1 });
    const daily = tools.find((t) => t.name === 'daily_close')!;
    expect(daily.example).toMatchObject({ store: 'current' });
    expect(daily.schema.safeParse({ from: today, to: today, store: 'SZ' }).success).toBe(false);
    const r = (await daily.run({ from: today, to: today, store: 'all' })) as { store: string };
    expect(r.store).toBe('合并');
  });
});

describe('每天的经营小结', () => {
  it('模拟模式：每天一份，重跑不重复；没配模型时只记数字，配好以后再生成一次', async () => {
    const now = new Date();
    const first = await runAiSummaries({ sql: ctx.sql, config: ctx.config }, now);
    expect(first).toEqual([{ storeId: 1, date: shiftDate(today, -1), status: 'done' }]);
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, now)).toEqual([]);
    const [row] = await ctx.sql<{ n: number; text: string; attempts: number }[]>`
      SELECT count(*) OVER ()::int AS n, text, attempts FROM ai_summaries WHERE business_date = ${shiftDate(today, -1)}`;
    expect(row).toMatchObject({ n: 1, attempts: 1 });
    expect(row!.text).toContain('【模拟小结】');
    const got = await api(ctx.app, ctx.owner, 'GET', '/api/ai/summaries');
    expect((got.body as AiSummaryResponse).summary).toMatchObject({ status: 'done', storeId: 1, businessDate: shiftDate(today, -1) });

    // 第二天：没配模型服务 → 只有事实包；配好以后的下一分钟再认领一次
    const tomorrow = new Date(now.getTime() + 86_400_000);
    setAiProviderForTests(null);
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, tomorrow)).toEqual([{ storeId: 1, date: today, status: 'unconfigured' }]);
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, tomorrow)).toEqual([]);
    setAiProviderForTests(undefined);
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, tomorrow)).toEqual([{ storeId: 1, date: today, status: 'done' }]);
    const [fact] = await ctx.sql<{ facts: unknown }[]>`SELECT facts FROM ai_summaries WHERE business_date = ${today}`;
    noPersonal(fact!.facts);
  });

  it('失败的隔 5 分钟再试、最多 3 次；「重新生成」从头再来', async () => {
    const date = shiftDate(today, -3);
    await ctx.sql`DELETE FROM ai_summaries WHERE business_date = ${date}`;
    const broken: AiProvider = { ...mockAiProvider(), write: async () => Promise.reject(new Error('连不上模型服务（网络不通或超时）')) };
    setAiProviderForTests(broken);
    const at = new Date(Date.parse(`${shiftDate(date, 1)}T12:00:00+08:00`));
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, at)).toEqual([{ storeId: 1, date, status: 'failed' }]);
    // 5 分钟内不再试
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, at)).toEqual([]);
    await ctx.sql`UPDATE ai_summaries SET updated_at = now() - interval '6 minutes', attempts = 3 WHERE business_date = ${date}`;
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, at)).toEqual([]);
    setAiProviderForTests(undefined);
    const re = await api(ctx.app, ctx.owner, 'POST', '/api/ai/summaries/regenerate', { date });
    expect(re.status, JSON.stringify(re.body)).toBe(202);
    let s = (re.body as AiSummaryResponse).summary!;
    for (let i = 0; i < 50 && s.status === 'running'; i++) {
      await new Promise((res) => setTimeout(res, 100));
      s = ((await api(ctx.app, ctx.owner, 'GET', `/api/ai/summaries?date=${date}`)).body as AiSummaryResponse).summary!;
    }
    expect(s).toMatchObject({ status: 'done', attempts: 1, error: null });
    // 今天还没过完的不能生成
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/ai/summaries/regenerate', { date: today })).status).toBe(400);
    // 只有一家店时没有全公司的那一份
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/ai/summaries?scope=all')).status).toBe(403);
  });

  it('生成得太久被当成中断、别人重新生成以后，晚到的结果不算数', async () => {
    const date = shiftDate(today, -4);
    await ctx.sql`DELETE FROM ai_summaries WHERE business_date = ${date}`;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow: AiProvider = { ...mockAiProvider(), write: async () => (await gate, { text: '晚到的旧结果', usage: { inputTokens: 0, outputTokens: 0 } }) };
    setAiProviderForTests(slow);
    const at = new Date(Date.parse(`${shiftDate(date, 1)}T12:00:00+08:00`));
    const first = runAiSummaries({ sql: ctx.sql, config: ctx.config }, at);
    // 等第一次认领好、事实包写进去
    for (let i = 0; i < 100; i++) {
      const [r] = await ctx.sql<{ hash: string }[]>`SELECT facts_hash AS hash FROM ai_summaries WHERE business_date = ${date}`;
      if (r?.hash) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    // 租约过了（当成中断）→ 换成正常的模型服务、「重新生成」
    await ctx.sql`UPDATE ai_summaries SET lease_until = now() - interval '1 second' WHERE business_date = ${date}`;
    setAiProviderForTests(undefined);
    const re = await api(ctx.app, ctx.owner, 'POST', '/api/ai/summaries/regenerate', { date });
    expect(re.status, JSON.stringify(re.body)).toBe(202);
    let s = (re.body as AiSummaryResponse).summary!;
    for (let i = 0; i < 50 && s.status === 'running'; i++) {
      await new Promise((res) => setTimeout(res, 100));
      s = ((await api(ctx.app, ctx.owner, 'GET', `/api/ai/summaries?date=${date}`)).body as AiSummaryResponse).summary!;
    }
    expect(s.status).toBe('done');
    // 第一次的结果这时才回来：不盖掉
    release();
    await first;
    const [row] = await ctx.sql<{ text: string; status: string }[]>`SELECT text, status FROM ai_summaries WHERE business_date = ${date}`;
    expect(row).toMatchObject({ status: 'done' });
    expect(row!.text).toContain('【模拟小结】');
    expect(row!.text).not.toContain('晚到的旧结果');
  });

  it('关掉小结时什么都不做', async () => {
    await rules({ dailySummary: false });
    expect(await runAiSummaries({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 5 * 86_400_000))).toEqual([]);
    await rules({ dailySummary: true });
  });
});

describe('问数', () => {
  it('模拟模式：问一次答一次；原样重提返回同一份，不再调模型；换了问题的拒绝', async () => {
    const clientKey = randomUUID();
    const before = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM integration_calls WHERE kind = 'ai' AND action = 'question'`;
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey, question: '昨天营收多少？' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const done = await waitQuestion(r.body.id);
    expect(done.status).toBe('done');
    expect(done.answer).toContain('【模拟回答】');
    expect(done.tools.length).toBe(1);
    expect(done.tools[0]!.ok).toBe(true);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey, question: '昨天营收多少？' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);
    const after = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM integration_calls WHERE kind = 'ai' AND action = 'question'`;
    expect(after[0]!.n - before[0]!.n).toBe(1);
    const other = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey, question: '上周呢？' });
    expect(other.body.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const list = await api(ctx.app, ctx.owner, 'GET', '/api/ai/questions');
    expect((list.body as AiQuestionView[]).some((q) => q.id === r.body.id)).toBe(true);
  });

  it('问题里写了会员的姓名、会员号、手机号的拦下、什么都不发；没写的照常问，工具结果都打过码', async () => {
    let called = 0;
    let seen = '';
    const capture: AiProvider = {
      ...mockAiProvider(),
      async ask({ question, tools }: { question: string; tools: AiTool[] }) {
        called += 1;
        seen = question;
        const outs = [];
        for (const t of tools) outs.push(await t.run(t.example));
        noPersonal(outs);
        return { text: '好的', usage: { inputTokens: 1, outputTokens: 1 }, calls: [] };
      },
    };
    setAiProviderForTests(capture);
    for (const question of [
      `会员${MEMBER_NAME}昨天来过吗`,
      '欧阳 测试上个月消费了多少',
      `会员号 ${memberNo} 的余额`,
      '电话 139 1234 5678 的客人来过吗',
      `${LONG_NAME}的充值记录`,
      '证件号 110101199003071234 是谁',
    ]) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question });
      expect(r.status, question).toBe(422);
      expect(r.body.error.code).toBe('AI_MEMBER_INFO');
      noPersonal(r.body);
      expect(JSON.stringify(r.body)).not.toContain(LONG_NAME);
    }
    expect(called).toBe(0);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_questions WHERE question LIKE '%测试%' OR question LIKE '%长名字%'`)[0]!.n).toBe(0);
    // 没写会员身份的照常问（「新会员」里的「会员」是占位名，不拦）
    const ok = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question: '这个月新会员多少？' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect((await waitQuestion(ok.body.id)).status).toBe('done');
    expect(called).toBe(1);
    expect(seen).toBe('这个月新会员多少？');
  });

  it('拒答、每人每天的限额、关掉问数、没配模型服务', async () => {
    const refusing: AiProvider = { ...mockAiProvider(), ask: async () => Promise.reject(new AiRefused('拒答')) };
    setAiProviderForTests(refusing);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question: '随便问问' });
    expect((await waitQuestion(r.body.id)).status).toBe('refused');
    setAiProviderForTests(undefined);

    const used = (await api(ctx.app, ctx.owner, 'GET', '/api/ai/status')).body.usedToday as number;
    await rules({ dailyQuestionLimit: used });
    const limited = await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question: '再问一次' });
    expect(limited.body.error?.code).toBe('AI_LIMIT');
    await rules({ dailyQuestionLimit: DEFAULT_AI_RULES.dailyQuestionLimit, questions: false });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question: '再问一次' })).body.error?.code).toBe('AI_DISABLED');
    await rules({ questions: true });

    setAiProviderForTests(null);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question: '再问一次' })).body.error?.code).toBe('AI_NOT_CONFIGURED');
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/ai/status')).body).toMatchObject({ mode: 'off', model: null });
    // 收银没有经营总览的权限：问不了
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/ai/questions', { clientKey: randomUUID(), question: '昨天营收多少？' })).status).toBe(403);
  });
});

describe('合同条款提示', () => {
  it('模拟模式按格式交回提示；发出去的正文先打码', async () => {
    const body = {
      category: 'service',
      counterparty: '某保洁公司',
      content: { title: '保洁外包', totalCents: 360000, note: `${MEMBER_NAME}介绍的`, acceptance: { signer: `${LONG_NAME.slice(0, 16)} ${LONG_NAME.slice(16)}` } },
      body: `联系人${MEMBER_NAME}，电话 ${MEMBER_PHONE}，身份证 11010119900307123X；备用联系人 欧阳 测试（139-1234-5678），推荐人 ${LONG_NAME}`,
    };
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/ai/contract-hints', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.hints).toEqual([{ kind: 'missing', title: '【模拟】保密条款', detail: expect.any(String) }]);
    let prompt = '';
    setAiProviderForTests({ ...mockAiProvider(), structured: async (input) => ((prompt = input.prompt), mockAiProvider().structured(input)) });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/ai/contract-hints', body)).status).toBe(200);
    expect(prompt).toContain('139****5678');
    expect(prompt).toContain('联系人欧*');
    expect(prompt).not.toContain(MEMBER_PHONE);
    expect(prompt).not.toContain(MEMBER_NAME);
    expect(prompt).not.toContain('欧阳 测试');
    expect(prompt).not.toContain('139-1234-5678');
    expect(prompt).not.toContain(LONG_NAME.slice(0, 16));
    expect(prompt).not.toContain(LONG_NAME.slice(16));
    expect(prompt).not.toContain('11010119900307123X');
  });
});

describe('适配器（假的 SDK 客户端）', () => {
  it('模型、思考深度、服务端回退、工具 strict 都按设计发', async () => {
    const calls: { kind: string; params: Record<string, unknown> }[] = [];
    const reply = { content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } };
    const fake = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => (calls.push({ kind: 'create', params }), reply),
          toolRunner: (params: Record<string, unknown>) => (calls.push({ kind: 'toolRunner', params }), Promise.resolve(reply)),
          parse: async (params: Record<string, unknown>) => (calls.push({ kind: 'parse', params }), { ...reply, parsed_output: { hints: [] } }),
        },
      },
    };
    const p = claudeProvider({ apiKey: 'x', client: fake as never });
    expect(p.model).toBe('claude-opus-5-5');
    expect((await p.write({ system: 's', prompt: 'p' })).text).toBe('好');
    const tools = aiTools({ sql: ctx.sql, today, timeZone: ctx.config.timezone, can: () => true, erp: new Set(), stores: [{ id: 1, code: 'HQ', name: '本店' }], currentStoreId: 1 });
    await p.ask({ system: 's', question: 'q', tools, maxIterations: 6 });
    const { z } = await import('zod');
    await p.structured({ system: 's', prompt: 'p', schema: z.object({ hints: z.array(z.string()) }) });
    for (const c of calls) {
      expect(c.params.model).toBe('claude-opus-5-5');
      expect((c.params.output_config as { effort: string }).effort).toBe('medium');
      expect(c.params.betas).toEqual(['server-side-fallback-2026-07-01']);
      expect(c.params.fallbacks).toBe('default');
      expect(c.params).not.toHaveProperty('thinking.budget_tokens');
    }
    const runner = calls.find((c) => c.kind === 'toolRunner')!.params;
    expect(runner.max_iterations).toBe(6);
    expect((runner.tools as { strict: boolean; name: string }[]).every((t) => t.strict === true)).toBe(true);
    expect((calls.find((c) => c.kind === 'parse')!.params.output_config as { format: unknown }).format).toBeTruthy();
    // 关掉回退时不带
    const off = claudeProvider({ apiKey: 'x', client: fake as never, fallbacks: false });
    calls.length = 0;
    await off.write({ system: 's', prompt: 'p' });
    expect(calls[0]!.params).not.toHaveProperty('betas');
    expect(calls[0]!.params).not.toHaveProperty('fallbacks');
  });
});
