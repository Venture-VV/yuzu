// 导出设定稿的静态 SVG：node docs/mascot/export.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const { yuzuSVG } = createRequire(import.meta.url)('./yuzu-mascot.cjs');
const moods = { happy: '开心', yum: '好吃', sleepy: '困了', oops: '哎呀', wink: '眨眼' };
for (const [mood, name] of Object.entries(moods)) {
  writeFileSync(join(here, `yuzu-${mood}.svg`), yuzuSVG({ mood, id: `yz-${mood}`, title: `柚子 · ${name}` }) + '\n');
}
writeFileSync(join(here, 'yuzu-bowl.svg'), yuzuSVG({ mood: 'yum', pose: 'bowl', id: 'yz-bowl', title: '柚子 · 开饭啦' }) + '\n');
console.log('ok');
