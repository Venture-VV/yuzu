# 汤崎 TOUCHILL 微信小程序

小程序线的代码（`docs/MINIPROGRAM.md`）：原生小程序 + TypeScript，只连小程序网关（`src/gateway`），网关经 Tailscale 只连门店系统 yuzu 的小程序端口。会员、余额、券都由 yuzu 算好，小程序只显示。

视觉照汤崎品牌书与 VI（`docs/MINIPROGRAM.md` 第 13 节）：米白、亚麻底，木色 `#937051`，细线、规则网格、留白，英文小标题大写加字距。两份原件是保密文件，不进仓库。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/app.*` | 页面清单、底部标签栏、全局样式（品牌色、字体、按钮） |
| `src/pages/home` | 首页：版头大图加标志（首页轮播）、两家门店的信息、三块业务、服务入口、公告 |
| `src/pages/prices` | 价目表：门票与价目表项目（各档价格、项目介绍与图片） |
| `src/pages/guide` | 楼层导览：区域色块、中英文名、设施图标（只到区域），点图放大 |
| `src/pages/me` | 我的：用微信手机号绑定会员、会员卡（会员体系 v2 的档阶与进度）、余额、菜单 |
| `src/pages/code` | 会员码：二维码 + 数字，每 60 秒换一次，打开时调亮屏幕 |
| `src/pages/ledger`、`coupons`、`unbind` | 余额与流水、我的券、解绑与换号（到前台办） |
| `src/utils` | 连网关（登录、会话、断网时的旧内容）、金额与日期、会员码二维码、导览图、会员卡与列表的文字 |
| `src/config/env.ts` | 按小程序的版本（开发版、体验版、正式版）选网关 |
| `tests/` | 单元测试（不要微信开发者工具） |
| `scripts/render-icons.mjs` | 生成底部标签栏的图标 |
| `assets-src/brand/*.svg`、`src/assets/brand/*.png` | 汤崎标志（店主 11-03 定用品牌书 / VI 的几何字）：竖版方形主标志、横版、英文字标 TOUCHILL。SVG 是从品牌书 / VI 的 PDF 里按区域取出的原矢量路径（不是截图），放在 `src/` 外面、不进小程序包；页面用 `scripts/render-logo.mjs` 生成的 PNG（按用到的地方换颜色、透明底） |

接口的类型直接用 yuzu 的 `src/shared/mp.ts`、`src/shared/guide.ts`（只引类型，编译后不留引用），接口改了这里的类型检查会报错。

## 检查（不要开发者工具）

```bash
cd miniprogram
npm ci
npm run check      # 类型检查 + 单元测试；CI 的「小程序：类型检查 · 单元测试」跑的就是这个
```

二维码的测试用独立的解码器（jsQR）把生成的会员码读回来核对。

## 在微信开发者工具里打开

开发者工具只有 macOS、Windows 版。

1. 先在本机起一套演示环境（独立演示库，见仓库根目录的 `AGENTS.md`）：
   - yuzu 的 `.env` 加 `YUZU_INSTANCE=demo`、`MP_PORT=8081`、`MP_GATEWAY_KEY=<32 位以上的随机串>`、`MP_CODE_SECRET=<32 位以上的随机串>`；
   - `npm run build`，再 `node dist/server/index.js`；
   - 后台「微信小程序」打开「对顾客开放」。
2. 起网关（模拟微信，不用 AppID）：

   ```bash
   MP_UPSTREAM_URL=http://127.0.0.1:8081 MP_GATEWAY_KEY=<同上> MP_SESSION_SECRET=<32 位以上的随机串> MP_MOCK_WECHAT=true node dist/gateway/index.js
   ```

3. 开发者工具「导入项目」选 `miniprogram/` 这个目录（不是 `src/`）。仓库里的 AppID 是占位的 `touristappid`：开发者工具稳定版（2.02）用命令行打开时不认它（报「不存在此 AppID」），先在 https://developers.weixin.qq.com/sandbox 扫码领一个测试号，导入时填测试号的 AppID；有了正式 AppID 也这样填。填的 AppID 存在 `project.private.config.json`（按人存，不进仓库）。
4. 右上角「详情 → 本地设置」勾上「不校验合法域名」（本机网关是 http）。
5. 「我的」页会显示「开发版 · 模拟微信」：填演示库里会员的手机号点「模拟绑定」；「换一个微信」就像换了一个微信用户。
6. 自动化冒烟（`e2e/smoke.mjs`）：`MP_APPID=<测试号的 AppID> WECHAT_CLI=<开发者工具的 cli> YUZU_URL=http://127.0.0.1:<演示库 yuzu 的端口> npm run e2e`。
   - `YUZU_URL` 没有默认值，必须写明；yuzu 的实例标识必须是 `demo`（试用库、正式服、测试服、没设标识的一律拒绝），网关必须是模拟微信。这几样只读检查都过了才登录、才改数据。
   - 给了 `MP_APPID` 时脚本把它写进 `project.private.config.json`、关掉合法域名校验，并以「信任项目」打开。
   - 绑定照顾客的操作：填手机号、点「模拟绑定」。
   - 改了数据之后不论成败都收尾：解绑、关上小程序开关，再回读核对。几步互不影响，哪一步出错就记「收尾未确认」，后面的照做；没确认完时脚本会提示去后台核对。脚本的这些保护有单元测试（`tests/smoke-guard.test.ts`）。
   - 新项目第一次打开时开发者工具要初始化，自动化常常连不上：脚本等 5 秒自动再试一次。

真机预览时手机连不到 `127.0.0.1`：把 `src/config/env.ts` 的 `DEV_GATEWAY` 改成电脑的局域网地址（不要提交），手机上打开「开发调试」。

## 各版本连哪里

| 版本 | 网关 | 微信 |
| --- | --- | --- |
| 开发版 | `DEV_GATEWAY`（本机，默认 `http://127.0.0.1:8300`） | 网关是模拟微信时用模拟 |
| 体验版 | `https://api-test.<域名>`（测试服，连演示库） | 同上 |
| 正式版 | `https://api.<域名>` | 一律用真的微信登录与手机号验证 |

两个域名等备案下来再填进 `src/config/env.ts`，并在小程序后台加进 request、downloadFile 合法域名（导览图的底图用画布加载，要 downloadFile 域名）。

## 写法上的约定

- 类型检查分两份：`tsconfig.json` 只查 `src/`，不带 Node 的类型（页面里用不了 Node 的东西）；`tests/tsconfig.json` 查测试，带 Node 的类型。
- 开发者工具自带的 TypeScript 编译版本不一定新：`import type` 单独写，不用 `import { a, type B }`；不用数字分隔符（`1_000`）。
- 样式不用 flex 的 `gap`（老 iOS 不认），间距用外边距或 grid 的 `grid-gap`。
- 金额一律整数「分」，显示用 `utils/format.ts`，不用浮点数算钱。
- 会员相关的数字不存本机；展示内容（门店信息、价目、导览）存一份，门店连不上时标「之前的信息」。
- 标志用图片，不用文字拼：首页版头与会员卡用竖版主标志，滚过版头的导航栏用横版（VI 说横版只在特定情况用），英文字标与主标志同宽。改了源文件或颜色后在仓库根目录执行 `node miniprogram/scripts/render-logo.mjs`。
- `tests/pages.test.ts` 会查：页面四个文件齐全、页面上绑的事件在代码里有、标签栏图标不超过 40KB、页面用到的本地图片都在且不超过 60KB、上面这几条写法。
