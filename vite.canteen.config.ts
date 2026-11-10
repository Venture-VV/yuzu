import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 柚子饭堂（员工手机端，docs/CANTEEN.md）：产物输出到 dist/canteen-app，由 yuzu 的员工端口（CANTEEN_PORT）托管。
// 本机调界面：npm run dev:canteen（接口转到 CANTEEN_PORT，默认 8090）。
export default defineConfig({
  root: 'src/canteen-app',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/canteen-app', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.CANTEEN_PORT ?? 8090}`, changeOrigin: false },
    },
  },
});
