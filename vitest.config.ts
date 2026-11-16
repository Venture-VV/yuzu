import { availableParallelism } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { LIVE_ENV } from './src/server/integrations/config';

// 集成测试按文件并行：每个并行进程用自己的测试库（库名加进程编号，见 tests/helpers.ts 的 TEST_DB），互不清库；
// 开跑前由 tests/global-setup.ts 建好这些库。TEST_WORKERS=1 时回到原来的单库串行（库名不加编号）。
const workers = Math.max(1, Number(process.env.TEST_WORKERS) || Math.min(4, availableParallelism()));
process.env.TEST_WORKERS = String(workers);

// 只给应用用的开关不带进用例（8.1.5）：测试会话在 PR #117 报，把 INTEGRATIONS_MOCK=true 设到了整个终端，
// 几份按正式、试用环境加载配置的老用例被「正式环境不许用模拟」拦下；8.1.3 的访问网段（ACCESS_ALLOW_CIDRS）设在终端里，
// 用例的请求全被当成外来网络拒掉。用例要模拟、要哪样的防护，在自己的配置里写明（tests/helpers.ts 的 integrations、
// tests/protection.test.ts 的 protection）。在这里去掉，分出去跑用例的进程都继承不到。
const APP_ONLY_ENV = [
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
for (const name of APP_ONLY_ENV) delete process.env[name];

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: workers > 1,
    maxWorkers: workers,
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
