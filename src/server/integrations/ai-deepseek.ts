// AI 辅助的 DeepSeek 适配器（8.1.1，店主 2026-11-15 定 MD8；docs/SCHEDULE_V811.md 第 2 节、docs/AI_V8022.md 第 4 节）。
//   · 走 DeepSeek 的主格式：与 OpenAI 兼容的 POST {YUZU_AI_BASE_URL}/chat/completions（默认 https://api.deepseek.com），
//     不加依赖（Node 自带的 fetch）。正式服在阿里云（大陆）直接连得上，不用境外代理。
//   · 与 Claude 适配器同一个接口（integrations/ai.ts 的 AiProvider）：写小结、带只读工具的问数、合同条款提示。
//   · 模型默认 deepseek-v4-pro（DS1，YUZU_AI_MODEL 可换 deepseek-flash）；思考模式显式关掉（DS2：DeepSeek 不写这一项时默认开）。
//   · 问数的工具照 OpenAI 的格式交给模型（参数是 zod 转出来的 JSON Schema，不用要 /beta 地址的 strict 模式）；
//     模型给的参数在服务端按 zod 校验，不合格的不执行、把原因告诉模型；最后一轮不再给工具（tool_choice: none），逼它写答案。
//   · 合同条款提示用 JSON 模式（DS3）：服务端按同一份 zod 格式核对，不合格的重试一次，再不行写「这次没整理出来」。
//   · 内容被 DeepSeek 的审核拦下（finish_reason = content_filter）算拒答（页面写「答不了」）；模型自己说答不了的照它的原话显示。
//   · 密钥只认 YUZU_AI_API_KEY；看着是 Anthropic 的密钥（sk-ant-）一律不发：8.0.22 起配过 Claude 密钥的实例升级以后
//     默认换成了 DeepSeek，不能把那把密钥发到 DeepSeek 去。

import { z } from 'zod';
import { AiRefused, AiUnavailable, type AiProvider, type AiTool, type AiToolCall, type AiUsage } from './ai';

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
/** 一次请求最多等多久；连不上、429、5xx 再试 2 次（与 Claude 适配器一样，小结的 10 分钟租约够用） */
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
/** 非思考模式默认 8K；小结 2000 字、答案 4000 字、条款提示 10 条都够 */
const MAX_TOKENS = 8000;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

interface ToolCallOut {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type ChatMessage = { role: 'system' | 'user'; content: string } | { role: 'assistant'; content: string; tool_calls?: ToolCallOut[] } | { role: 'tool'; tool_call_id: string; content: string };
interface ChatChoice {
  finish_reason?: string | null;
  message?: { content?: string | null; refusal?: string | null; tool_calls?: ToolCallOut[] | null } | null;
}
interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
}

const ZERO: AiUsage = { inputTokens: 0, outputTokens: 0 };
const addUsage = (a: AiUsage, u: ChatResponse['usage']): AiUsage => ({ inputTokens: a.inputTokens + (u?.prompt_tokens ?? 0), outputTokens: a.outputTokens + (u?.completion_tokens ?? 0) });

/** zod → 交给模型的 JSON Schema：去掉 $schema；日期只留 format（zod 带的那一长串正则对模型没用、还占字数） */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  const strip = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(strip);
    const o = node as Record<string, unknown>;
    if (o.format === 'date' && typeof o.pattern === 'string') delete o.pattern;
    Object.values(o).forEach(strip);
  };
  strip(out);
  return out;
}

/** 对方错误里的一句说明（只留短短一句；看着像密钥的打掉） */
async function errorDetail(res: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const raw = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
    return typeof raw === 'string'
      ? raw
          .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-…')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      : '';
  } catch {
    return '';
  }
}

/** HTTP 错误翻成页面上看得懂的话（DeepSeek 的错误码：docs 里的 400 / 401 / 402 / 422 / 429 / 500 / 503） */
function statusError(status: number, detail: string): AiUnavailable {
  const more = detail ? `：${detail}` : '';
  switch (status) {
    case 401:
      return new AiUnavailable('模型服务的密钥不对，请检查服务器上的 YUZU_AI_API_KEY（DeepSeek 开放平台的 API key）');
    case 402:
      return new AiUnavailable('模型服务的余额用完了（DeepSeek 返回 402），请到 DeepSeek 开放平台充值');
    case 403:
      return new AiUnavailable('模型服务没有权限（403），请检查 YUZU_AI_API_KEY');
    case 404:
      return new AiUnavailable('模型服务的地址不对（404），请检查 YUZU_AI_BASE_URL');
    case 400:
    case 422:
      return new AiUnavailable(`模型服务不接受这次请求（${status}${more}），请检查 YUZU_AI_MODEL`);
    case 429:
      return new AiUnavailable('模型服务这会儿太忙（请求太频繁），请稍后再试');
    case 503:
      return new AiUnavailable('模型服务这会儿太忙（服务器过载），请稍后再试');
    default:
      return new AiUnavailable(`模型服务出错（${status}），请稍后再试`);
  }
}

/** 这一次回答停下来的原因：审核拦下算拒答；资源不够、中断算连不上 */
function checkFinish(choice: ChatChoice): void {
  switch (choice.finish_reason) {
    case 'content_filter':
      throw new AiRefused('内容被模型服务的审核拦下');
    case 'insufficient_system_resource':
      throw new AiUnavailable('模型服务这会儿资源不够，请稍后再试');
    case 'aborted':
      throw new AiUnavailable('模型服务中断了这次回答，请再试一次');
  }
}

export interface DeepseekOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** 用例换一个假的 fetch 核对请求形状（正式不传，用 Node 自带的） */
  fetch?: FetchLike;
  /** 再试之前等多久（毫秒，第 n 次再试等 n 倍；用例设 0） */
  retryDelayMs?: number;
}

/** 正式：DeepSeek（与 OpenAI 兼容的 /chat/completions） */
export function deepseekProvider(opts: DeepseekOptions): AiProvider {
  const model = opts.model?.trim() || DEEPSEEK_DEFAULT_MODEL;
  const base = (opts.baseURL?.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const delay = opts.retryDelayMs ?? 1000;
  const wrongKey = /^sk-ant-/i.test(opts.apiKey.trim());

  async function chat(body: Record<string, unknown>): Promise<{ choice: ChatChoice; usage: ChatResponse['usage'] }> {
    if (wrongKey) throw new AiUnavailable('YUZU_AI_API_KEY 看着是 Anthropic（Claude）的密钥，现在用的是 DeepSeek，这一次没有发出去：换成 DeepSeek 的密钥，或设 YUZU_AI_PROVIDER=claude');
    const payload = JSON.stringify({ model, thinking: { type: 'disabled' }, max_tokens: MAX_TOKENS, stream: false, ...body });
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${opts.apiKey.trim()}` },
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
          continue;
        }
        throw new AiUnavailable('连不上模型服务（网络不通或超时）');
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
          const after = Number(res.headers.get('retry-after'));
          await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20_000) : delay * (attempt + 1)));
          continue;
        }
        throw statusError(res.status, await errorDetail(res));
      }
      let data: ChatResponse;
      try {
        data = (await res.json()) as ChatResponse;
      } catch {
        throw new AiUnavailable('模型服务的回复看不懂（不是 JSON），请再试一次');
      }
      const choice = data.choices?.[0];
      if (!choice?.message) throw new AiUnavailable('模型服务的回复不完整，请再试一次');
      checkFinish(choice);
      return { choice, usage: data.usage };
    }
  }

  const textOf = (choice: ChatChoice) => (choice.message?.content ?? choice.message?.refusal ?? '').trim();

  return {
    mode: 'live',
    name: 'deepseek',
    model,
    async write({ system, prompt }) {
      const r = await chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ] satisfies ChatMessage[],
      });
      return { text: textOf(r.choice), usage: addUsage(ZERO, r.usage) };
    },
    async ask({ system, question, tools, maxIterations }) {
      const defs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: jsonSchemaOf(t.schema) } }));
      const byName = new Map<string, AiTool>(tools.map((t) => [t.name, t]));
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ];
      const calls: AiToolCall[] = [];
      let usage = ZERO;
      const runTool = async (tc: ToolCallOut): Promise<string> => {
        const name = tc.function?.name ?? '';
        const tool = byName.get(name);
        const started = Date.now();
        const fail = (input: unknown, error: string) => {
          calls.push({ name, input, ms: Date.now() - started, ok: false });
          return JSON.stringify({ error });
        };
        if (!tool) return fail(null, `没有「${name.slice(0, 40)}」这个报表，只能用给你的那几样`);
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          return fail(null, '参数不是合格的 JSON，请按参数格式重新给');
        }
        // 模型给的参数先过 zod：不合格的不执行，把原因告诉模型（工具的 run 里还会再按同一份格式核对一次）
        const parsed = tool.schema.safeParse(input);
        if (!parsed.success) return fail(input, `参数不对：${parsed.error.issues.map((i) => i.message).join('；')}`);
        try {
          const out = await tool.run(parsed.data);
          calls.push({ name, input: parsed.data, ms: Date.now() - started, ok: true });
          return JSON.stringify(out);
        } catch (e) {
          return fail(parsed.data, e instanceof Error ? e.message : '取数出错');
        }
      };
      for (let round = 1; ; round++) {
        // 最后一轮不再让它挑工具：照取到的数写答案
        const last = round >= Math.max(1, maxIterations);
        const r = await chat({ messages, ...(defs.length ? { tools: defs, tool_choice: last ? 'none' : 'auto' } : {}) });
        usage = addUsage(usage, r.usage);
        const toolCalls = r.choice.message?.tool_calls ?? [];
        if (!toolCalls.length || last) return { text: textOf(r.choice), usage, calls };
        messages.push({ role: 'assistant', content: r.choice.message?.content ?? '', tool_calls: toolCalls });
        for (const tc of toolCalls) messages.push({ role: 'tool', tool_call_id: tc.id, content: await runTool(tc) });
      }
    },
    async structured<T>({ system, prompt, schema }: { system: string; prompt: string; schema: z.ZodType<T> }) {
      // JSON 模式要在提示里写明「json」并给出格式（DeepSeek 的要求）
      const format = JSON.stringify(jsonSchemaOf(schema as z.ZodType));
      const sys = `${system}\n\n只输出一个 JSON 对象（json），不要别的文字。格式（JSON Schema）：${format}`;
      let usage = ZERO;
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await chat({
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: prompt },
          ] satisfies ChatMessage[],
          response_format: { type: 'json_object' },
        });
        usage = addUsage(usage, r.usage);
        try {
          const parsed = schema.safeParse(JSON.parse(textOf(r.choice)));
          if (parsed.success) return { value: parsed.data, usage };
        } catch {
          // 不是 JSON（DeepSeek 在 JSON 不合格时会回空白）：再试一次
        }
      }
      throw new AiUnavailable('这次没整理出来（模型的回复不合格式），请再试一次');
    },
  };
}
