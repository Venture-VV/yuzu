// 管家部本机 OCR 的第三方文件（docs/CONCIERGE.md「构建资源」）：按 assets.sha256.json 逐个核对大小与 SHA-256。
// 这些文件缺了或不对时页面不报错（只是识别不了），所以构建完核对一次、测试里核对一次（8.0.12 整改：
// 原来的构建会把两份语言模型当成「上次留下的压缩文件」删掉，打包后的系统识别不了小票）。
// 用法：node scripts/check-ocr-assets.mjs [目录，默认 src/client/public/concierge/ocr]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../src/client/public/concierge/ocr/assets.sha256.json', import.meta.url));

/** 核对一个目录，返回问题清单（空 = 都对） */
export async function checkOcrAssets(dir) {
  const { files } = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const problems = [];
  for (const f of files) {
    let data;
    try {
      data = await readFile(resolve(dir, f.path));
    } catch {
      problems.push(`缺文件：${f.path}`);
      continue;
    }
    if (data.length !== f.bytes) problems.push(`大小不对：${f.path}（${data.length}，应为 ${f.bytes}）`);
    else if (createHash('sha256').update(data).digest('hex') !== f.sha256) problems.push(`内容不对（SHA-256 不一致）：${f.path}`);
  }
  return { count: files.length, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'src/client/public/concierge/ocr';
  const { count, problems } = await checkOcrAssets(dir);
  if (problems.length) {
    console.error(`本机 OCR 资源核对不通过（${dir}）：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`本机 OCR 资源核对通过：${count} 个文件（${dir}）`);
}
