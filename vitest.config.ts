import { availableParallelism } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { clearAppOnlyEnv } from './tests/app-only-env';

// 集成测试按文件并行：每个并行进程用自己的测试库（库名加进程编号，见 tests/helpers.ts 的 TEST_DB），互不清库；
// 开跑前由 tests/global-setup.ts 建好这些库。TEST_WORKERS=1 时回到原来的单库串行（库名不加编号）。
const workers = Math.max(1, Number(process.env.TEST_WORKERS) || Math.min(4, availableParallelism()));
process.env.TEST_WORKERS = String(workers);

// 只给应用用的开关不带进用例（8.1.5，说明见 tests/app-only-env.ts）：秒级一档的 vitest.unit.config.ts 用同一份清单
clearAppOnlyEnv();

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
