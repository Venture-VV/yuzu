// 导出看板娘「柚子」的静态 SVG（docs/MASCOT.md）：npx tsx docs/mascot/export.tsx
// 画法只有一份：src/canteen-app/Mascot.tsx。导出的 SVG 自带动画（SVG 自带的 SMIL，浏览器打开就会动）。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mascot, type Mood, type Pose } from '../../src/canteen-app/Mascot';

const here = dirname(fileURLToPath(import.meta.url));
const shots: [string, Pose, Mood, string][] = [
  ['wave', 'wave', 'happy', '挥手 · 开心'],
  ['point', 'point', 'wink', '指路 · 眨眼'],
  ['bowl', 'bowl', 'yum', '端饭碗 · 好吃'],
  ['oops', 'rest', 'oops', '站着 · 哎呀'],
  ['scratch', 'scratch', 'worried', '抓耳挠腮 · 发愁'],
  ['love', 'bowl', 'love', '端饭碗 · 喜欢'],
  ['cheer', 'cheer', 'happy', '欢呼 · 开心'],
  ['sleepy', 'rest', 'sleepy', '站着 · 困了'],
];
for (const [name, pose, mood, title] of shots) {
  const svg = renderToStaticMarkup(createElement(Mascot, { pose, mood, title: `柚子 · ${title}` })).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  writeFileSync(join(here, `yuzu-${name}.svg`), `${svg}\n`);
}
console.log(`导出 ${shots.length} 张到 ${here}`);
