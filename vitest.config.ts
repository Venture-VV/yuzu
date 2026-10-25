import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 集成测试共用一个测试数据库，按文件串行执行，避免互相清库。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
