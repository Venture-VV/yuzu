// AI 辅助的模型适配器（8.0.22，docs/AI_V8022.md 第 4 节）。
//   · 8.1.1 起默认用 DeepSeek（店主 2026-11-15 定 MD8，适配器在 ai-deepseek.ts）；这里的 Claude 适配器留作可选
//     （YUZU_AI_PROVIDER=claude），服务端回退（MD9）只对它有用。
//   · 只认 YUZU_AI_API_KEY（显式传给 SDK）：不读 ANTHROPIC_API_KEY、`ant auth` 的登录或机器上别处的密钥——
//     店主没给浴族专门配，就一条数据都不发出去（MD7：发出去的只有打码后的汇总）。
//   · 模型默认 claude-opus-5-5（YUZU_AI_MODEL 可换），思考深度显式设 medium；请求带服务端回退
//     （server-side-fallback-2026-07-01，fallbacks: "default"：模型因安全分类拒答时由服务端按类别换模型重跑，MD9）。
//   · 模拟（INTEGRATIONS_MOCK=true，只许开发、测试实例）不出网：按给的材料套固定模板，用例与演示用。
//   · 模型只出文字；问数的工具都是服务端的只读函数，参数先过 zod 校验（工具定义 strict），模型说的话不会被当成命令执行。

import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod/v4';

export const AI_DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** 一次请求最多等多久（SDK 自己会重试 2 次） */
const REQUEST_TIMEOUT_MS = 120_000;

/** 模型（连同回退的模型）拒答了、或内容被模型服务的审核拦下：页面写「这个问题答不了（原因）」；message 是括号里的原因 */
export class AiRefused extends Error {}
/** 连不上模型服务、密钥不对、额度用完……：页面写明原因，别的功能不受影响 */
export class AiUnavailable extends Error {}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface AiToolCall {
  name: string;
  input: unknown;
  ms: number;
  ok: boolean;
}
export interface AiTool {
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  /** 一份合格的参数（模拟模式按它取一次数；正式模式不用） */
  example: Record<string, unknown>;
  /** 只读：返回给模型看的结果（已经打码的汇总） */
  run: (input: unknown) => Promise<unknown>;
}

/** 用的哪家（记在对外调用里、页面上显示） */
export type AiProviderName = 'deepseek' | 'claude' | 'mock';

export interface AiProvider {
  mode: 'mock' | 'live';
  name: AiProviderName;
  model: string;
  /** 一次请求写一段文字（每天的经营小结） */
  write(input: { system: string; prompt: string }): Promise<{ text: string; usage: AiUsage }>;
  /** 带只读工具的问答（问数）：最多来回 maxIterations 次 */
  ask(input: { system: string; question: string; tools: AiTool[]; maxIterations: number }): Promise<{ text: string; usage: AiUsage; calls: AiToolCall[] }>;
  /** 按固定格式输出（合同条款提示） */
  structured<T>(input: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<{ value: T; usage: AiUsage }>;
}

const usageOf = (u: { input_tokens?: number | null; output_tokens?: number | null } | undefined): AiUsage => ({ inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 });

function textOf(content: Array<{ type: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** 把 SDK 的错误翻成页面上看得懂的两类：拒答 / 连不上（不带密钥、地址） */
function translate(error: unknown): Error {
  if (error instanceof AiRefused || error instanceof AiUnavailable) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return new AiUnavailable('模型服务的密钥不对或没有权限，请检查服务器上的 YUZU_AI_API_KEY');
  if (error instanceof Anthropic.RateLimitError) return new AiUnavailable('模型服务这会儿太忙或额度用完了，请稍后再试');
  if (error instanceof Anthropic.APIConnectionError) return new AiUnavailable('连不上模型服务（网络不通或超时）');
  if (error instanceof Anthropic.APIError) return new AiUnavailable(`模型服务出错（${error.status ?? '未知'}）`);
  return error instanceof Error ? error : new Error(String(error));
}

/** 正式：Anthropic 的 Claude（官方 SDK） */
export function claudeProvider(opts: { apiKey: string; baseURL?: string; model?: string; fallbacks?: boolean; client?: Anthropic }): AiProvider {
  // client：用例换一个假的 SDK 客户端核对请求形状（正式不传）
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
  const model = opts.model?.trim() || AI_DEFAULT_MODEL;
  const fallback = opts.fallbacks === false ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const };
  const refused = (stop: string | null | undefined) => {
    if (stop === 'refusal') throw new AiRefused('模型拒答');
  };
  return {
    mode: 'live',
    name: 'claude',
    model,
    async write({ system, prompt }) {
      try {
        const r = await client.beta.messages.create({ model, max_tokens: 16000, ...fallback, output_config: { effort: 'medium' }, system, messages: [{ role: 'user', content: prompt }] });
        refused(r.stop_reason);
        return { text: textOf(r.content), usage: usageOf(r.usage) };
      } catch (error) {
        throw translate(error);
      }
    },
    async ask({ system, question, tools, maxIterations }) {
      const calls: AiToolCall[] = [];
      const runnable = tools.map((t) =>
        betaZodTool({
          name: t.name,
          description: t.description,
          inputSchema: t.schema,
          // 工具定义 strict：模型给的参数一定合 schema；服务端执行前仍按 zod 再校验一次（日期范围等）
          strict: true,
          run: async (input) => {
            const started = Date.now();
            try {
              const out = await t.run(input);
              calls.push({ name: t.name, input, ms: Date.now() - started, ok: true });
              return JSON.stringify(out);
            } catch (error) {
              calls.push({ name: t.name, input, ms: Date.now() - started, ok: false });
              return JSON.stringify({ error: error instanceof Error ? error.message : '取数出错' });
            }
          },
        }),
      );
      try {
        const final = await client.beta.messages.toolRunner({
          model,
          max_tokens: 16000,
          ...fallback,
          output_config: { effort: 'medium' },
          system,
          tools: runnable,
          max_iterations: maxIterations,
          messages: [{ role: 'user', content: question }],
        });
        refused(final.stop_reason);
        return { text: textOf(final.content), usage: usageOf(final.usage), calls };
      } catch (error) {
        throw translate(error);
      }
    },
    async structured({ system, prompt, schema }) {
      try {
        const r = await client.beta.messages.parse({ model, max_tokens: 16000, ...fallback, output_config: { effort: 'medium', format: zodOutputFormat(schema) }, system, messages: [{ role: 'user', content: prompt }] });
        refused(r.stop_reason);
        if (r.parsed_output == null) throw new AiUnavailable('模型的回复不合格式，请再试一次');
        return { value: r.parsed_output as never, usage: usageOf(r.usage) };
      } catch (error) {
        throw translate(error);
      }
    },
  };
}

type MockStoreFacts = {
  store: string;
  date: string;
  revenue: { net: string; checkouts: number; guests: number };
  compare: { lastWeekSameDay: string };
  members: { newMembers: number; rechargePaid: string };
  anomalies: { kind: string; count: number }[];
  erpTodo?: string[];
};
const mockStoreLine = (f: MockStoreFacts) =>
  `${f.store}：净营业额 ${f.revenue.net}（上周同一天 ${f.compare.lastWeekSameDay}），结账 ${f.revenue.checkouts} 张、客人 ${f.revenue.guests} 位；` +
  `新会员 ${f.members.newMembers} 位、充值 ${f.members.rechargePaid}。` +
  (f.anomalies.length ? `对账要看一下：${f.anomalies.map((a) => `${a.kind} ${a.count} 条`).join('、')}。` : '对账没有要看的。');

/** 模拟的小结：按事实包套模板（单店的、全公司的两种）；认不出的返回空 */
function mockSummaryText(facts: unknown): string | null {
  const f = facts as Partial<MockStoreFacts> & { stores?: MockStoreFacts[]; erpTodo?: string[] };
  const todo = (list?: string[]) => (list?.length ? `ERP 待办：${list.join('；')}。` : '');
  const tail = '（模拟模式：没有调用模型，按数字套的固定模板）';
  if (Array.isArray(f.stores)) return `【模拟小结】${f.date} 全公司：${f.stores.map(mockStoreLine).join(' ')}${todo(f.erpTodo)}${tail}`;
  if (f.revenue && f.compare && f.members && f.anomalies) return `【模拟小结】${f.date} ${mockStoreLine(f as MockStoreFacts)}${todo(f.erpTodo)}今天可以先看看昨天变化大的项目。${tail}`;
  return null;
}

/** 模拟：不出网，按材料套固定模板（开发、测试实例；用例与演示用） */
export function mockAiProvider(): AiProvider {
  return {
    mode: 'mock',
    name: 'mock',
    model: 'mock',
    async write({ prompt }) {
      // 按材料（提示第一行之后的 JSON）套固定模板；认不出的照原样截一段
      let text = `【模拟小结】${prompt.slice(0, 200)}`;
      try {
        text = mockSummaryText(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1))) ?? text;
      } catch {
        // 不是 JSON：用截的那一段
      }
      return { text, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async ask({ question, tools }) {
      // 模拟：按问题里的关键字挑第一样工具、用它的默认参数取一次数，把结果摘要写成答案
      const calls: AiToolCall[] = [];
      const tool = tools.find((t) => question.includes(t.description.slice(0, 2))) ?? tools[0];
      if (!tool) return { text: '【模拟回答】没有可用的报表', usage: { inputTokens: 0, outputTokens: 0 }, calls };
      const parsed = tool.schema.safeParse(tool.example);
      const started = Date.now();
      const out = parsed.success ? await tool.run(parsed.data) : null;
      calls.push({ name: tool.name, input: parsed.success ? parsed.data : {}, ms: Date.now() - started, ok: parsed.success });
      // 只摘结果最外一层的数（文字、数字），写成一句话
      const facts =
        out && typeof out === 'object' && !Array.isArray(out)
          ? Object.entries(out as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
              .map(([k, v]) => `${k} ${String(v)}`)
              .slice(0, 12)
              .join('，')
          : `${Array.isArray(out) ? out.length : 0} 行`;
      const input = (parsed.success ? parsed.data : {}) as { from?: string; to?: string };
      const range = input.from ? `（${input.from === input.to ? input.from : `${input.from} 至 ${input.to}`}）` : '';
      return { text: `【模拟回答】按「${tool.description.split('：')[0]}」${range}取了一次数：${facts}。（模拟模式：没有调用模型，只把取到的数原样列出来）`, usage: { inputTokens: 0, outputTokens: 0 }, calls };
    },
    async structured<T>({ schema }: { schema: z.ZodType<T> }) {
      // 模拟：交一条固定的提示（合同条款提示的格式；别的格式交空清单）
      const sample = { hints: [{ kind: 'missing', title: '【模拟】保密条款', detail: '模拟模式：没有调用模型，这一条是固定的示例。' }] };
      const parsed = schema.safeParse(sample);
      return { value: parsed.success ? parsed.data : schema.parse({ hints: [] }), usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
