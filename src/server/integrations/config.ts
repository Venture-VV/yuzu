// 对外接口的模式（8.0.21，docs/INTEGRATIONS_V8021.md 第 1、6 节）：只由运行环境决定，页面上改不了。
//   · mock（模拟）：INTEGRATIONS_MOCK=true，只许在 APP_ENV 是 development / test、实例不是 prod / shadow / test；
//     和任何正式密钥同时出现时拒绝启动（免得以为在测模拟、其实连着真的商户）。
//   · live（正式）：那一样的环境变量都在才算配置好。8.0.21 只有接口与模拟实现（CW22），正式实现等联调——
//     配好了也只显示「已配置，等联调」，不会去调。
//   · off：都没有。
// 密钥只放运行环境（.env / 云端环境变量），不进库、不进仓库、不进聊天与飞书；这里只看「有没有」，不读出来存。

import type { InstanceKind } from '@shared/instance';
import type { AppEnv } from '../config';

export const INTEGRATION_KINDS = ['pay_terminal', 'platform_voucher', 'einvoice', 'bank_direct', 'ota', 'ai'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export type IntegrationMode = 'off' | 'mock' | 'live';

/** 每一样正式接口要的环境变量（都有才算配置好）；数电票服务商、银企直连、OTA 联调时按对方定 */
export const LIVE_ENV: Record<string, { kind: IntegrationKind; label: string; vars: string[] }> = {
  wechat_micro: { kind: 'pay_terminal', label: '微信付款码支付', vars: ['WXPAY_MICRO_MCH_ID', 'WXPAY_MICRO_APP_ID', 'WXPAY_MICRO_API_KEY'] },
  alipay_f2f: { kind: 'pay_terminal', label: '支付宝当面付', vars: ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY_PATH', 'ALIPAY_PUBLIC_KEY_PATH'] },
  meituan: { kind: 'platform_voucher', label: '美团团购', vars: ['MEITUAN_APP_KEY', 'MEITUAN_APP_SECRET', 'MEITUAN_SESSION'] },
  douyin: { kind: 'platform_voucher', label: '抖音来客', vars: ['DOUYIN_CLIENT_KEY', 'DOUYIN_CLIENT_SECRET', 'DOUYIN_ACCOUNT_ID'] },
  // AI 辅助（8.0.22，docs/AI_V8022.md 第 4 节）：只认专门给浴族配的密钥（YUZU_AI_PROVIDER、YUZU_AI_BASE_URL、YUZU_AI_MODEL 选填）；
  // 8.1.1 起默认 DeepSeek（MD8），YUZU_AI_PROVIDER=claude 时用 Claude
  ai_model: { kind: 'ai', label: 'AI 辅助的模型服务（默认 DeepSeek）', vars: ['YUZU_AI_API_KEY'] },
};

/** AI 辅助用哪家（8.1.1 起默认 DeepSeek，店主 2026-11-15 定 MD8；Claude 留作可选） */
export const AI_SERVICES = ['deepseek', 'claude'] as const;
export type AiService = (typeof AI_SERVICES)[number];

/** 读 YUZU_AI_PROVIDER：不写是 deepseek；写错的启动时就报出来，免得以为配好了、其实一条都发不出去 */
export function aiServiceOf(env: NodeJS.ProcessEnv): AiService {
  const v = (env.YUZU_AI_PROVIDER ?? '').trim().toLowerCase();
  if (!v) return 'deepseek';
  if ((AI_SERVICES as readonly string[]).includes(v)) return v as AiService;
  throw new Error(`YUZU_AI_PROVIDER 只能是 deepseek 或 claude（现在是「${v.slice(0, 20)}」）`);
}

export interface IntegrationsConfig {
  mock: boolean;
  /** AI 辅助用哪家（YUZU_AI_PROVIDER）；不写（用例里手搭的配置）当 deepseek */
  aiService?: AiService;
  /** 配好了正式环境变量的那几样（LIVE_ENV 的键） */
  liveConfigured: string[];
}

export function loadIntegrationsConfig(env: NodeJS.ProcessEnv, appEnv: AppEnv, instance: InstanceKind): IntegrationsConfig {
  const liveConfigured = Object.entries(LIVE_ENV)
    .filter(([, v]) => v.vars.every((name) => (env[name] ?? '').trim() !== ''))
    .map(([k]) => k);
  const mock = env.INTEGRATIONS_MOCK === 'true';
  const aiService = aiServiceOf(env);
  if (mock) {
    if (appEnv !== 'development' && appEnv !== 'test') throw new Error('INTEGRATIONS_MOCK=true 只能用在 APP_ENV=development 或 test');
    if (instance === 'prod' || instance === 'shadow' || instance === 'test') throw new Error(`INTEGRATIONS_MOCK=true 不能用在 ${instance} 实例（正式服、影子运行、测试服）`);
    const anyLive = Object.values(LIVE_ENV).some((v) => v.vars.some((name) => (env[name] ?? '').trim() !== ''));
    if (anyLive) throw new Error('INTEGRATIONS_MOCK=true 不能和正式接口的密钥同时配置：要测模拟就把正式的变量去掉');
  }
  return { mock, aiService, liveConfigured };
}

/** 某一类现在是什么模式：模拟优先；正式的要那一类下面至少一样配好了 */
export function modeOf(cfg: IntegrationsConfig, kind: IntegrationKind): IntegrationMode {
  if (cfg.mock) return 'mock';
  return cfg.liveConfigured.some((k) => LIVE_ENV[k]?.kind === kind) ? 'live' : 'off';
}
