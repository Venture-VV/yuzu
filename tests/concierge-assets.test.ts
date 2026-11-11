// 8.0.12 管家部 · 本机 OCR 资源与构建（主线整改，docs/CONCIERGE.md「构建资源」）：
// 仓库里的第三方文件与清单一致；构建的压缩步骤不删本来就以 .gz 发布的语言模型（原来会删，打包后的系统识别不了小票）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error 构建脚本是 .mjs，没有类型声明
import { checkOcrAssets } from '../scripts/check-ocr-assets.mjs';

const OCR = 'src/client/public/concierge/ocr';
const tmp = mkdtempSync(join(tmpdir(), 'yuzu-ocr-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function walk(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, join(base, e.name)) : [join(base, e.name)]));
}

describe('管家部本机 OCR 资源', () => {
  it('仓库里的第三方文件与清单逐个一致（大小与 SHA-256），没有清单外的大文件', async () => {
    const { count, problems } = (await checkOcrAssets(OCR)) as { count: number; problems: string[] };
    expect(problems).toEqual([]);
    expect(count).toBe(11);
    const listed = new Set((JSON.parse(readFileSync(join(OCR, 'assets.sha256.json'), 'utf8')) as { files: { path: string }[] }).files.map((f) => f.path));
    // 不在清单里的只能是许可、说明、我们自己写的 worker 与两份清单本身；用不到的识别内核不再放进仓库
    const others = walk(OCR).filter((f) => !listed.has(f.split('\\').join('/')));
    expect(others.sort()).toEqual(
      [
        'NOTICE.txt',
        'assets.sha256.json',
        'core/LICENSE',
        'name-LICENSE-ONNXRuntime.txt',
        'name-LICENSE-PaddleOCR.txt',
        'name-NOTICE.txt',
        'name-ThirdPartyNotices-ONNXRuntime.txt',
        'name-assets.sha256.json',
        'name-worker.js',
        'tesseract.min.js.LICENSE.txt',
        'worker.min.js.LICENSE.txt',
      ].sort(),
    );
  });

  it('清单核对认得出缺文件与被改过的文件', async () => {
    const dir = join(tmp, 'broken');
    mkdirSync(join(dir, 'lang'), { recursive: true });
    writeFileSync(join(dir, 'lang/eng.traineddata.gz'), '<!doctype html><title>不是模型</title>');
    const { problems } = (await checkOcrAssets(dir)) as { problems: string[] };
    expect(problems).toContain('缺文件：lang/chi_sim.traineddata.gz');
    expect(problems.some((p) => p.startsWith('大小不对：lang/eng.traineddata.gz'))).toBe(true);
  });

  it('构建的压缩步骤：本来就以 .gz 发布的文件留着；自己上次压出来的（旁边有原文件）清掉重压', () => {
    const dir = join(tmp, 'dist');
    mkdirSync(join(dir, 'concierge/ocr/lang'), { recursive: true });
    const model = gzipSync(Buffer.from('合成的语言模型'.repeat(200)));
    writeFileSync(join(dir, 'concierge/ocr/lang/chi_sim.traineddata.gz'), model);
    const js = `console.log(${JSON.stringify('x'.repeat(4000))});`;
    writeFileSync(join(dir, 'app.js'), js);
    writeFileSync(join(dir, 'app.js.gz'), 'stale');
    writeFileSync(join(dir, 'app.js.br'), 'stale');
    execFileSync(process.execPath, ['scripts/compress-assets.mjs', dir], { stdio: 'pipe' });
    expect(readFileSync(join(dir, 'concierge/ocr/lang/chi_sim.traineddata.gz')).equals(model)).toBe(true);
    expect(readFileSync(join(dir, 'app.js.gz')).toString()).not.toBe('stale');
    expect(readFileSync(join(dir, 'app.js.br')).toString()).not.toBe('stale');
    // 再跑一次结果一样（单独重跑这个脚本）
    execFileSync(process.execPath, ['scripts/compress-assets.mjs', dir], { stdio: 'pipe' });
    expect(walk(dir).sort()).toEqual(['app.js', 'app.js.br', 'app.js.gz', 'concierge/ocr/lang/chi_sim.traineddata.gz']);
  });
});
