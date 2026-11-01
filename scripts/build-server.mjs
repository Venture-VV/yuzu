// 打包后端为单文件 ESM，依赖保持外部引用（生产镜像中 npm ci --omit=dev 安装）。
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  alias: { '@shared': './src/shared' },
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/server/index.ts'], outfile: 'dist/server/index.js' });
await build({ ...common, entryPoints: ['src/server/cli.ts'], outfile: 'dist/server/cli.js' });
// 底图转换进程（RQ-004 第二段）：单独的入口，应用与命令行起子进程跑它
await build({ ...common, entryPoints: ['src/server/floorplan/worker.ts'], outfile: 'dist/server/floorplan-worker.js' });
await mkdir('dist/server/migrations', { recursive: true });
await cp('src/server/migrations', 'dist/server/migrations', { recursive: true });
