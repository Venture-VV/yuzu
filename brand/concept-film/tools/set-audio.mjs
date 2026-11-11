// 给已经渲染好的成片换配乐（画面不重新渲染、不重新编码，几秒钟）。
//   node tools/set-audio.mjs out/tangqi-concept-film-16x9-1080p.mp4 [音乐.wav] [--lufs -14]
// 不写音乐文件时用 audio/score.wav。响度统一调到 -14 LUFS，峰值留出余量；音乐比片子长就截到片长并在结尾收掉。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './serve.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const video = path.resolve(files[0] || '');
const audio = path.resolve(files[1] || path.join(ROOT, 'audio', 'score.wav'));
const target = parseFloat(flag('lufs', '-14'));
if (!files[0] || !fs.existsSync(video) || !fs.existsSync(audio)) {
  console.error('用法：node tools/set-audio.mjs <成片.mp4> [音乐.wav] [--lufs -14]');
  process.exit(1);
}

const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' });
const dur = parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).stdout);
const m = run('ffmpeg', ['-hide_banner', '-nostats', '-t', String(dur), '-i', audio, '-af', 'ebur128', '-f', 'null', '-']);
const I = /I:\s+(-?\d+(\.\d+)?) LUFS/.exec(m.stderr.split('Summary:').pop() || '');
const gain = I ? target - parseFloat(I[1]) : 0;
console.log(`片长 ${dur.toFixed(2)}s，音乐响度 ${I ? I[1] : '?'} LUFS，调整 ${gain.toFixed(1)} dB`);

const tmp = video.replace(/\.mp4$/, '.tmp.mp4');
const fadeAt = Math.max(0, dur - 1.2);
const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'warning', '-i', video, '-t', String(dur), '-i', audio,
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
  '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.79:level=false,afade=t=out:st=${fadeAt.toFixed(2)}:d=1.2`,
  '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-t', String(dur),
  '-movflags', '+faststart', '-map_metadata', '0', tmp], { stdio: 'inherit' });
if (r.status !== 0) { fs.rmSync(tmp, { force: true }); process.exit(r.status || 1); }
fs.renameSync(tmp, video);
const out = run('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr.split('Summary:').pop() || '';
const I2 = /I:\s+(-?\d+(\.\d+)?) LUFS/.exec(out), P2 = /Peak:\s+(-?\d+(\.\d+)?) dBFS/.exec(out);
console.log(`完成：${video}  ${(fs.statSync(video).size / 1e6).toFixed(1)} MB  响度 ${I2 ? I2[1] : '?'} LUFS  真峰值 ${P2 ? P2[1] : '?'} dBFS`);
