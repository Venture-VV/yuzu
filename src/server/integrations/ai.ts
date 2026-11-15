// AI 辅助的模型适配器（8.0.22，docs/AI_V8022.md 第 4 节）。
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

/** 模型（连同回退的模型）拒答了：页面写「这个问题答不了」 */
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
  schema: z.ZodObject;
  /** 只读：返回给模型看的结果（已经打码的汇总） */
  run: (input: unknown) => Promise<unknown>;
}

export interface AiProvider {
  mode: 'mock' | 'live';
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
export function claudeProvider(opts: { apiKey: string; baseURL?: string; model?: string; fallbacks?: boolean }): AiProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
  const model = opts.model?.trim() || AI_DEFAULT_MODEL;
  const fallback = opts.fallbacks === false ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const };
  const refused = (stop: string | null | undefined) => {
    if (stop === 'refusal') throw new AiRefused('这个问题答不了（模型拒答）');
  };
  return {
    mode: 'live',
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
          tools: runnable.map((t) => ({ ...t, strict: true })),
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

/** 模拟：不出网，按材料套固定模板（开发、测试实例；用例与演示用） */
export function mockAiProvider(): AiProvider {
  return {
    mode: 'mock',
    model: 'mock',
    async write({ prompt }) {
      return { text: `【模拟小结】${prompt.slice(0, 200)}`, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async ask({ question, tools }) {
      // 模拟：按问题里的关键字挑第一样工具、用它的默认参数取一次数，把结果摘要写成答案
      const calls: AiToolCall[] = [];
      const tool = tools.find((t) => question.includes(t.description.slice(0, 2))) ?? tools[0];
      if (!tool) return { text: '【模拟回答】没有可用的报表', usage: { inputTokens: 0, outputTokens: 0 }, calls };
      const parsed = tool.schema.safeParse({});
      const started = Date.now();
      const out = parsed.success ? await tool.run(parsed.data) : null;
      calls.push({ name: tool.name, input: parsed.success ? parsed.data : {}, ms: Date.now() - started, ok: parsed.success });
      return { text: `【模拟回答】按「${tool.name}」取了一次数：${JSON.stringify(out).slice(0, 300)}`, usage: { inputTokens: 0, outputTokens: 0 }, calls };
    },
    async structured<T>({ schema }: { schema: z.ZodType<T> }) {
      // 模拟：交一份空的提示清单（各字段取 schema 能接受的最小值由调用方给默认）
      const value = schema.parse({ hints: [] });
      return { value, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
