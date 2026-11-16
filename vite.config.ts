import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { dvhFallback } from './scripts/dvh-fallback';

// 前端构建：产物输出到 dist/client，由后端统一托管，局域网内无需访问外网。
export default defineConfig({
  root: 'src/client',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  // 不认识 dvh 的老浏览器退回 vh（8.1.4，scripts/dvh-fallback.ts）
  css: { postcss: { plugins: [dvhFallback()] } },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 8080}`, changeOrigin: false },
    },
  },
});
