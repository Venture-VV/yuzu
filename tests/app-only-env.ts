// 只给应用用的开关不带进用例（8.1.5；工程治理三期起两份 vitest 配置共用，Codex 审查 ca1f116）：
// 测试会话在 PR #117 报，把 INTEGRATIONS_MOCK=true 设到了整个终端，几份按正式、试用环境加载配置的老用例被「正式环境不许用模拟」拦下；
// 8.1.3 的访问网段（ACCESS_ALLOW_CIDRS）设在终端里，用例的请求全被当成外来网络拒掉。用例要模拟、要哪样的防护，在自己的配置里写明
// （tests/helpers.ts 的 integrations、tests/protection.test.ts 的 protection）。在 vitest 的配置里调用，分出去跑用例的进程都继承不到。
import { LIVE_ENV } from '../src/server/integrations/config';

export const APP_ONLY_ENV: readonly string[] = [
  'INTEGRATIONS_MOCK',
  'YUZU_AI_PROVIDER',
  'YUZU_AI_BASE_URL',
  'YUZU_AI_MODEL',
  ...Object.values(LIVE_ENV).flatMap((v) => v.vars),
  'ACCESS_ALLOW_CIDRS',
  'RATE_LIMIT_SESSION_PER_MIN',
  'RATE_LIMIT_IP_PER_MIN',
  'OVERLOAD_MAX_INFLIGHT',
  'OVERLOAD_MAX_LAG_MS',
];

/** 从环境变量里去掉只给应用用的那些（全量 vitest.config.ts 与秒级 vitest.unit.config.ts 都在加载配置时调用） */
export function clearAppOnlyEnv(env: Record<string, string | undefined> = process.env): void {
  for (const name of APP_ONLY_ENV) delete env[name];
}
