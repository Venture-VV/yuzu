// 起转换进程（RQ-004 第二段，v0.7.15）：应用主进程与命令行都通过这里调用 worker.ts，等它写出结果文件。
// 打包后（dist/server/index.js、cli.js）用同目录的 floorplan-worker.js；开发与测试直接用 tsx 跑源码。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerOutput } from './worker';

export type { WorkerOutput } from './worker';

/** 转换进程的 JS 堆上限（MB）；LibreDWG 的 WebAssembly 内存另算（编码图约 1 GB） */
const WORKER_HEAP_MB = 3072;

export function workerCommand(): { file: string; execArgv: string[] } {
  const dir = dirname(fileURLToPath(import.meta.url));
  const built = join(dir, 'floorplan-worker.js');
  if (existsSync(built)) return { file: built, execArgv: [] };
  return { file: join(dir, 'worker.ts'), execArgv: ['--import', 'tsx'] };
}

/** 转换进程只拿到运行需要的环境变量（不带数据库地址等配置） */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'NODE_ENV', 'SYSTEMROOT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export interface RunningConversion {
  done: Promise<WorkerOutput>;
  /** 停掉转换进程（应用关闭时） */
  kill: () => void;
}

/** 起一个转换进程：读 input，结果写到 output；超过 timeoutMs 强制停掉 */
export function startConversion(input: string, output: string, timeoutMs: number): RunningConversion {
  const { file, execArgv } = workerCommand();
  const child = spawn(process.execPath, [...execArgv, `--max-old-space-size=${WORKER_HEAP_MB}`, file, input, output], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: workerEnv(),
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const done = new Promise<WorkerOutput>((resolve) => {
    let settled = false;
    const finish = (out: WorkerOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    child.on('error', (e) => finish({ ok: false, error: `转换进程启动失败：${e.message}` }));
    child.on('exit', (code, signal) => {
      if (timedOut) {
        const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} 分钟` : `${Math.max(1, Math.round(timeoutMs / 1000))} 秒`;
        return finish({ ok: false, error: `转换超过 ${limit} 没完成，已停止` });
      }
      readFile(output, 'utf8')
        .then((text) => finish(JSON.parse(text) as WorkerOutput))
        .catch(() => {
          const last = stderr.trim().split('\n').pop()?.slice(0, 200) ?? '';
          finish({
            ok: false,
            error: signal ? `转换进程被终止（${signal}），可能是内存不足` : `转换进程异常退出（${code ?? '?'}）${last ? `：${last}` : ''}`,
          });
        });
    });
  });
  return { done, kill: () => child.kill('SIGKILL') };
}
