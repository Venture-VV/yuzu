import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// 秒级这一档（npm run test:unit，工程治理三期）：只跑不要数据库的用例，不建测试库、不迁移。
// 跑哪些文件由 scripts/test-tiers.mjs 按导入关系认出来、从命令行传进来；这里只是去掉了 vitest.config.ts 里建库的那一步。
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
    testTimeout: 30_000,
  },
});
