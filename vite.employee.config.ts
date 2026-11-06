import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/employee/client',
  publicDir: 'public',
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL('./dist/employee/client', import.meta.url)), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 18963,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.EMPLOYEE_PORT ?? 18962}`, changeOrigin: true } },
  },
});
