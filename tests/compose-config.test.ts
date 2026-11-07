// compose.yaml 的端口与正式服的两个环境变量（8.0.0）：用 docker compose config 只读地展开（不启动服务、不连数据库），
// 核对已有实例 .env 的写法照样能用——APP_PORT 只写端口（开在所有网卡上，门店局域网）或写「地址:端口」（只开在这个地址上，
// 测试服、演示库与云上的正式服），以及 COOKIE_SECURE、TRUST_PROXY 传进容器。
// PR #74 第一版另加的 APP_BIND 和「地址:端口」拼在一起，Compose 直接报错、已有实例升级不上去（测试会话 P1），这里防它再来。
// 没有 docker compose 的机器上跳过；CI（GitHub 的运行机自带 docker compose）上一定跑，没有就算失败。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const COMPOSE = fileURLToPath(new URL('../compose.yaml', import.meta.url));
const hasCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;

type App = {
  ports: { host_ip?: string; published: string | number; target: number | string }[];
  environment: Record<string, string | null>;
};

describe.skipIf(!hasCompose && !process.env.CI)('compose.yaml：已有实例的 .env 写法照样能展开（docker compose config，只读）', () => {
  // 空的 env 文件：不读仓库里可能有的 .env；子进程只给 PATH、HOME 与要核对的变量，不带本机或 CI 的其他环境变量
  let dir = '';
  let envFile = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'yuzu-compose-'));
    envFile = join(dir, 'empty.env');
    writeFileSync(envFile, '');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const app = (vars: Record<string, string>): App => {
    const r = spawnSync('docker', ['compose', '-f', COMPOSE, '--env-file', envFile, '-p', 'yuzu-compose-check', 'config', '--format', 'json'], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, POSTGRES_PASSWORD: 'compose-check', ...vars },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status, `docker compose config 失败：${r.stderr || String(r.error)}`).toBe(0);
    return JSON.parse(r.stdout).services.app as App;
  };
  const ports = (vars: Record<string, string>) =>
    app(vars).ports.map((p) => ({ host: p.host_ip ?? '', published: String(p.published), target: Number(p.target) }));

  it('APP_PORT 不设或只写端口：开在所有网卡上（门店局域网）', () => {
    expect(ports({})).toEqual([{ host: '', published: '8080', target: 8080 }]);
    expect(ports({ APP_PORT: '8081' })).toEqual([{ host: '', published: '8081', target: 8080 }]);
  });

  it('APP_PORT 写「地址:端口」：只开在这个地址上（已有的测试服、演示库；云上的正式服写 127.0.0.1 或 Tailscale 地址）', () => {
    expect(ports({ APP_PORT: '127.0.0.1:8080' })).toEqual([{ host: '127.0.0.1', published: '8080', target: 8080 }]);
    expect(ports({ APP_PORT: '100.101.102.103:8081' })).toEqual([{ host: '100.101.102.103', published: '8081', target: 8080 }]);
  });

  it('COOKIE_SECURE、TRUST_PROXY 传进容器；不设时不加 Secure、不信任代理', () => {
    const off = app({}).environment;
    expect([off.COOKIE_SECURE, off.TRUST_PROXY ?? '']).toEqual(['false', '']);
    const on = app({ COOKIE_SECURE: 'true', TRUST_PROXY: '172.18.0.1,10.0.0.0/8' }).environment;
    expect([on.COOKIE_SECURE, on.TRUST_PROXY]).toEqual(['true', '172.18.0.1,10.0.0.0/8']);
  });
});
