# 小程序线交接说明 · UI 工作台版面渲染组件与定时发布刷新（8.1.2）

对应规格：`docs/STUDIO_MP.md`（第 1–8 节）、`docs/WORKBENCH_V811.md` 第 8 节。

## 1. 范围

本次只改小程序线自己的目录与共享类型文件，不新增迁移、不碰登记处与核心业务表：

1. **门店小程序端口只读接口**（`src/server/modules/mp/studio-routes.ts`、`src/server/modules/mp/app.ts`、`src/shared/mp.ts`）：
   - `GET /api/mp/studio`（可选 `?store=<门店代码>`）：调主线的 `readPublishedStudio(sql, 'mp', storeId)`，返回 `{ layout: { id, version, publishedAt, doc } | null }`，响应头 `cache-control: no-store`。组件实例在服务端已展开成普通节点。
   - `GET /api/mp/studio/assets/:id`：调主线的 `readStudioAssetFor(sql, 'mp', id)`，只允许读取小程序已发布版面（含定时未到点版面）里引用过的图片，带 `public, max-age=31536000, immutable`；SVG 保留禁止脚本的 `Content-Security-Policy`。
2. **小程序网关转发与断网兜底**（`src/gateway/app.ts`）：
   - `GET /v1/studio`：`freshMs = 0`。门店在线时每次直读 yuzu，保证设计师**定时发布**到点后、或后台撤销后下一次进入页面零延迟拿到最新生效版面；门店断外网时才从 `ShowCache` 返回最近存下的有效版面（`x-cache: stale` + `x-fetched-at`）。
   - `GET /v1/studio/assets/:id`：按 SHA-256 长期缓存（30 天），SVG 透传禁止脚本的 CSP。
3. **小程序递归渲染组件与前台刷新**（`miniprogram/src/`）：
   - `utils/studio-style.ts`：375 设计宽换算 `750rpx`（`1px = 2rpx`）；`#RRGGBBAA` 转 `rgba()`、`$主题名` 转 `var(--…)`；横排/竖排不用 CSS `gap`，不换行用方向外边距（末个可见节点不加），横排换行包一层 `width: calc(100% + gap)` 负外边距抵消；支持 `frame`、`rect`、`ellipse`、`text`、`field`、`image`、`button`、`block` 八种节点、`store.*` / `member.*` / `today.date` 数据字段，以及 `open.page` / `call.store` / `nav.store` 动作。
   - `utils/studio.ts` + `app.ts`：**每次小程序回到前台（`App.onShow`）与每次进入任意页面（`Page.onShow`）都重新请求 `/v1/studio`**（50ms 内并发去重）；`id` 不变时复用已解析版面不重绘闪烁，`id` 变化（含定时发布到点、发新版、撤销回退 `null`）立即通知当前页面切换；断网时回退本机 7 天内的 `tq_studio_mp` 缓存。
   - `components/studio-node`、`components/studio-screen`：开启 `virtualHost: true`，内部节点直接作为父容器的 flex / 绝对定位子项；顶层功能块（`mp.banner`、`mp.store`、`mp.memberCard`）通过静态具名 `slot` 嵌入原页面的真实业务模块。
   - 页面接入：`pages/home/index`（`home` 屏）、`pages/me/index`（`member` 屏）、新增 `pages/activity/index`（`activity` 屏，已在 `app.json` 登记）；其余 15 个不开放结构的页面最外层统一挂上 `.page-root` 与 `style="{{themeStyle}}"`，跟随已发布版面的主题色与字体。
   - 容错与隐私：未发布、`schema !== 1` 或关键字段缺失时回退原页面；未知节点 `type` 与 `hidden` 节点静默跳过不白屏；会员相关数据字段绝不落本机存储，离开页面或绑定版本号变化时立即清空旧会员显示。
4. **合入主线 8.1.3 并接入小程序端口过载与锁忙防护**（回应【主线·开发】在 #118 的留言）：
   - 清理小程序线 3 处未用到的符号（`src/server/modules/mp/coupon-center.ts` 的 `boundMember`、`tests/mp-member.test.ts` 的 `memberId`、`tests/mp-reminders.test.ts` 的 `MpReminderLeased`），全套小程序线文件通过 `tsc --noUnusedLocals --noUnusedParameters`、浮动查询与 `import type` 检查。
   - **小程序端口防护**（`src/server/modules/mp/app.ts`）：接入主线 `createProtection({ ...config.protection, sessionPerMin: 0, ipPerMin: 0, allowCidrs: [] })`（网关探活 `/api/mp/health` 豁免），过载时回 503 `OVERLOADED` + `Retry-After: 2`（确定没处理）；错误处理把 `55P03`、`57014`、`40P01`、`40001` 统一回成 409 `BUSY`（事务已回滚，确定没生效）。
   - **网关与小程序单层重试衔接**（`src/gateway/upstream.ts`、`src/gateway/app.ts`、`miniprogram/src/utils/`）：
     - 展示接口（含 `freshMs = 0` 的 `/v1/studio`）遇到门店 `OVERLOADED` / `BUSY` 时，网关有旧缓存则优先给 `stale`，没有缓存则透传 `Retry-After`、由小程序回退本机 7 天缓存；
     - 带一次性微信手机号 `phoneCode` 的接口（`/v1/bind`、`/v1/invites/:code/claim`）换出手机号后遇到 `OVERLOADED` / `BUSY`，只在网关层带原 `clientKey` 短暂重发最多 2 次（不再调第二次微信换手机号）；其余接口网关不重发，交给小程序 `api.ts` 单层带原编号短暂重发最多 2 次，避免多层重试放大；
     - 重发后仍返回 `OVERLOADED` 或 `BUSY` 时，各待确认模块（`pending-store`、绑定、充值建单、领券、点餐、预约、领邀请）按「确定没处理」立即清掉手机上的待确认记录，不再多发一次作废请求；到期提醒与会员端提醒已读遇到暂时忙时保留在手机上下次打开补发。

## 2. 数据库迁移

无新迁移（直接只读复用主线 164–166 已建好的 `studio_versions`、`studio_version_cancels`、`studio_assets` 与读取函数）。

## 3. 已执行验证与受阻说明

- **云端开发环境已跑通**：
  1. `cd miniprogram && npm ci && npm run check`（`tsc` 类型检查 + 20 个测试文件，含 `tests/studio-renderer.test.ts` 与 8.1.3 忙/过载重试单测）—— **通过**。
  2. `npm run typecheck && npm run format:check && npm run check:code && npm run build` —— **通过**。
  3. 独立测试库集成用例 `npx vitest run tests/mp-*.test.ts tests/gateway*.test.ts`（含新增 `tests/mp-studio.test.ts`、`tests/gateway-studio.test.ts`、`tests/mp-protection.test.ts`）—— **通过**。
  4. 线范围检查 `node scripts/check-line-scope.mjs` —— **通过**（0 个范围外文件、0 个登记处文件、0 个新迁移）。
- **受阻未测（待门店 Mac mini 小程序助手实测）**：
  - 云端开发容器内没有微信开发者工具与真手机环境，小程序真实渲染画面与 `miniprogram/e2e/smoke.mjs` 自动化冒烟在云端记为**受阻未测**，请 Codex「小程序助手」在门店 Mac mini 上按第 4 节核验。

## 4. 验收要点与发给测试 AI 的指令

```text
请对小程序线当前草稿 PR 的最新完整 SHA 做预检，报告第一行按约定写：
【小程序线·测试】→ 小程序线 · PR #<号> · <完整 SHA>

重点核对（规格见 docs/STUDIO_MP.md）：
1. 自动化全套：miniprogram 目录 npm run check，根目录 npm run typecheck && npm run format:check && npm run check:code && npm run build，独立测试库跑 tests/mp-*.test.ts tests/gateway*.test.ts（含 8.1.3 过载与锁忙防护 tests/mp-protection.test.ts），以及独立演示库 + 微信开发者工具跑 miniprogram/e2e/smoke.mjs（未发布版面与发布默认版面两种状态下首页、我的绑定都能跑通）。
2. 五份样例对照（tests/fixtures/studio/mp/01..05.json 与同名 .png）：
   - 在独立演示库后台「UI 工作台 → 微信小程序」依次导入/发布五份样例（03 需先上传 tests/fixtures/studio/mp/assets/00424d7a0218b97c8e5bbae2da9e8b7cd341468e9b8780d77d0f3754b3cc8ca8.png），在微信开发者工具 375 宽机型下核对 pages/home/index、pages/me/index、pages/activity/index 的字号、木色/概念色、横排换行（4 列宫格与 04 的 3+3+1 换行）、自由定位旋转圆角、按钮点击跳转（含跳子页面、跳标签页、冻结会员点会员码提示、拨号与导航）。
3. 定时发布与撤销刷新：
   - 在工作台定一个 1 分钟后生效的小程序版面：到点前打开小程序看是旧版；等过了生效时刻后，切后台再回前台（App.onShow）或切页面再进页面（Page.onShow），不用重启小程序即刻切到新版面。
   - 全部撤销或未发布时，页面回退到原来的首页/我的/活动页，无报错、无白屏；换一套主题色发布后，价目、充值等不开放结构的页面底色与字体同步跟主题变化。
```
