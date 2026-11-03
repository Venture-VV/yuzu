// 上传小程序体验版（docs/DEPLOY_GATEWAY.md 第 7 节）：用微信官方的 miniprogram-ci 把 miniprogram/ 编译后传到小程序后台，
// 成为「ci 机器人 N」的开发版本；店主在后台把它选为体验版（之后同一个机器人再传，体验版跟着换）。
//   node upload.mjs              上传：要 MP_APPID 与 MP_UPLOAD_KEY
//   node upload.mjs --dry-run    只在本机编译一遍：不要密钥、不上传，看能不能编过、包多大
//                                （miniprogram-ci 会顺手向微信取一次允许的文件类型，取不到不影响编译）
// 环境变量：
//   MP_APPID        小程序的 AppID（与网关的 WX_APPID 相同）
//   MP_UPLOAD_KEY   代码上传密钥文件的路径（小程序后台「开发管理 → 开发设置 → 小程序代码上传」下载；只放上传的那台机器，不进 GitHub）
//   MP_ROBOT        用几号 ci 机器人（1–30，默认 1）
//   MP_COMMIT、MP_SUBJECT   写进版本说明的提交与说明（不给时读 git）
// 版本号用 miniprogram/package.json 的 version。平时在网关服务器上由 src/gateway/deploy/upload-miniprogram.sh 调
// （密钥的 IP 白名单填那台的公网 IP）；依赖多（一千多个包），不放进 CI。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ci from 'miniprogram-ci';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); // miniprogram/
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
function need(key) {
  const v = process.env[key]?.trim();
  if (!v) fail(`缺少 ${key}（见本文件开头的说明）`);
  return v;
}
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('miniprogram/package.json 的 version 应为 x.y.z');

// 体验版、正式版连的网关（src/config/env.ts）还是占位的地址时不上传：传上去也连不上
const envTs = readFileSync(join(root, 'src/config/env.ts'), 'utf8');
if (!dryRun && /\.invalid\b/.test(envTs)) {
  fail('src/config/env.ts 里体验版、正式版的网关地址还是占位的（domain.invalid）：备案域名下来、改成 https://api-test.<域名> 与 https://api.<域名> 并合并进 main 之后再上传');
}

const robot = Number(process.env.MP_ROBOT?.trim() || 1);
if (!Number.isInteger(robot) || robot < 1 || robot > 30) fail('MP_ROBOT 应为 1–30');
const commit = process.env.MP_COMMIT?.trim() || git(['rev-parse', 'HEAD']);
const subject = process.env.MP_SUBJECT?.trim() || git(['log', '-1', '--format=%s']);
const desc = [version, commit.slice(0, 7), subject].filter(Boolean).join(' · ').slice(0, 120);

// 只传小程序本身（project.config.json 的 miniprogramRoot 是 src/）；这些目录不扫
const ignores = ['node_modules/**', 'tools/**', 'tests/**', 'e2e/**', 'assets-src/**', 'scripts/**'];
const project = dryRun
  ? // 本机编译不用密钥：项目属性（包大小上限等）不向微信要，用 miniprogram-ci 自带的默认值
    new ci.Project({
      appid: process.env.MP_APPID?.trim() || 'wx0000000000000000',
      type: 'miniProgram',
      projectPath: root,
      privateKey: 'dry-run',
      ignores,
      attr: async () => ci.DefaultProjectAttr,
    })
  : new ci.Project({ appid: need('MP_APPID'), type: 'miniProgram', projectPath: root, privateKeyPath: need('MP_UPLOAD_KEY'), ignores });

const notes = [];
const onProgressUpdate = (task) => {
  if (task && typeof task === 'object' && (task.status === 'warn' || task.status === 'fail') && task.message) notes.push(`${task.status}：${task.message}`);
};
const setting = { useProjectConfig: true };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const MAX_MAIN = 2 * 1024 * 1024; // 主包上限 2MB（微信的规定）

try {
  if (dryRun) {
    const files = await ci.getCompiledResult({ project, desc, setting, onProgressUpdate });
    const sizes = Object.entries(files).map(([name, v]) => [name, Buffer.byteLength(v)]);
    const total = sizes.reduce((s, [, n]) => s + n, 0);
    const { pages } = JSON.parse(readFileSync(join(root, 'src/app.json'), 'utf8'));
    const missing = pages.filter((p) => !(`${p}.js` in files));
    if (missing.length) fail(`这些页面没有编出 .js：${missing.join('、')}`);
    console.log(`✓ 本机编译通过（${desc}）：${sizes.length} 个文件，共 ${kb(total)}`);
    for (const [name, n] of sizes.sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${kb(n).padStart(9)}  ${name}`);
    for (const note of notes) console.log(`· ${note}`);
    if (total > MAX_MAIN) fail(`代码包 ${kb(total)} 超过主包上限 2MB`);
  } else {
    const result = await ci.upload({ project, version, desc, robot, setting, onProgressUpdate });
    const full = result.subPackageInfo?.find((p) => p.name === '__FULL__');
    console.log(`✓ 已上传为 ci 机器人 ${robot} 的开发版本：${desc}${full ? `（代码包 ${kb(full.size)}）` : ''}`);
    console.log('  小程序后台「管理 → 版本管理 → 开发版本」里能看到。第一次要「选为体验版」；之后同一个机器人再上传就换掉这一版，体验版跟着更新');
    for (const note of notes) console.log(`· ${note}`);
  }
  // miniprogram-ci 编完、传完进程不会自己退出
  process.exit(0);
} catch (error) {
  fail(`${dryRun ? '本机编译' : '上传'}没有成功：${error instanceof Error ? error.message : String(error)}`);
}
