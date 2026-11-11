// 时间线：72 秒，30 帧 / 秒。配乐是 60 拍 / 分钟，一小节 4 秒，场景都卡在小节上。
import { opening } from './scenes/opening.js';
import { radicals, initRadicals } from './scenes/radicals.js';
import { landscapes, initLands } from './scenes/landscapes.js';
import { words, slogan, ending } from './scenes/closing.js';

export const FPS = 30;
export const DURATION = 72;

// 各场的起点（秒）
export const T = {
  opening: 0,     // 城市节奏 → 山是层次，水为间奏
  radicals: 8,    // 提取「汤」里的水、「崎」里的山
  mark: 16,       // 三横三竖，标志成形
  scenes: 24,     // 五种景象，每个 4 秒：24 / 28 / 32 / 36 / 40
  words: 44,      // 品牌文字
  slogan: 56,     // YOUR NEXT URBAN PLEASURE
  end: 64,        // 落版
};

// 按先后顺序画；相邻两场有一小段重叠用来转场
export const SCENES = [
  { id: 'opening', t0: 0, t1: 8.0, draw: opening },
  { id: 'radicals', t0: 8.0, t1: 24.3, draw: radicals, init: initRadicals },
  { id: 'landscapes', t0: 23.4, t1: 44.5, draw: landscapes, init: initLands },
  { id: 'words', t0: 43.6, t1: 64.3, draw: words },
  { id: 'slogan', t0: 55.8, t1: 64.0, draw: slogan },
  { id: 'ending', t0: 63.5, t1: 72.0, draw: ending },
];
