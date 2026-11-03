// 把小程序网关打成一个不依赖 node_modules 的文件，给网关的小镜像用（docs/DEPLOY_GATEWAY.md）。
//   node src/gateway/deploy/build.mjs [输出文件，默认 dist/gateway-standalone/gateway.mjs]
// 与 scripts/build-server.mjs 里的 dist/gateway/index.js 是同一份代码，区别只是依赖（Fastify、zod）也打进来：
// 网关服务器上只放这一个文件，不带 yuzu 的后端、管理后台和数据库工具。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outfile = resolve(process.argv[2] ?? join(root, 'dist/gateway-standalone/gateway.mjs'));

await build({
  absWorkingDir: root,
  entryPoints: ['src/gateway/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@shared': './src/shared' },
  sourcemap: true,
  // 打进来的依赖里有 CommonJS 写法（require、__dirname）：在 ES 模块里补上
  banner: {
    js: [
      "import { createRequire as __gwCreateRequire } from 'node:module';",
      "import { fileURLToPath as __gwFileURLToPath } from 'node:url';",
      "import { dirname as __gwDirname } from 'node:path';",
      'const require = __gwCreateRequire(import.meta.url);',
      'const __filename = __gwFileURLToPath(import.meta.url);',
      'const __dirname = __gwDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
console.log(`✓ 网关已打包：${outfile}`);
