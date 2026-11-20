# v8.1.19 交接说明 · 菜品与顶栏的英文换成品牌部的示例字体（电子菜单）

主线 [PR #140](https://github.com/Venture-VV/yuzu/pull/140)。店主 2026-11-20 转来《品牌部工作台需求汇总 1.3》：「这是新需求，请你用新版号开发它，开发完合并」。

- 设计：`docs/EMENU.md` 第 19 节。
- 默认做法：`docs/PENDING_DECISIONS.md`「8.1.19」PD1–PD5（待确认）。
- **没有迁移**，版面数据的格式不变；服务端没有改动；不改账。

## 0. 升级后会看到的变化

- 门店服务器上**放了**授权的品牌英文字体（`brand-fonts/en.woff2`，`docs/EMENU.md` 第 14.2 节）：平板电子菜单、工作台画布、后台版面预览里**所有的英文**都是 ABC Arizona Flare（品牌部数据包里的示例字体）——顶栏分类的英文、每道菜的英文名（原来是 Playfair Display）、中文里夹的字母数字（原来是朱雀仿宋自带的字母），别处的英文 8.1.5 起本来就是；工作台主题选「衬线」「无衬线」也一样（店主追加，PD5）。
- **没放**：与 8.1.18 一样（Playfair Display）。
- 品牌部数据包里的字体文件是**试用版**（`ABCArizonaFlareVariable-Trial.ttf`），试用条款不许放在服务器上、不许随软件发出去，所以没有用它；要看到效果，门店要用 Dinamo 网页授权包里的 WOFF2（店主 2026-11-17 说已有网页授权，PP4）。

## 1. 范围

- `features/emenu/emenu.css`：`--em-en-display` 里 `Tangqi Brand En`（授权的品牌英文字体）排到 Playfair Display 前面。
- `features/emenu/header.tsx`：顶栏量宽的字体串 `EN_FONTS` 同样调整。
- `features/emenu/emenu.css` 的 `--em-zh`、`features/emenu/brandFont.ts`：授权文件另以只含拉丁字母的 `Tangqi Brand Latin` 加载，排在中文字体串里朱雀仿宋前面（PD5）。
- `shared/studio/surfaces.ts`：工作台主题每个英文字体选项先用品牌字体，中文选项带上 `Tangqi Brand Latin`。
- `tests/emenu-brand-font.test.ts`：核对每一串字体。
- `features/emenu/i18n.tsx`：`EnName` 的注释（英文是手录还是经「英文对照表」导入的翻译都走这里）。
- `e2e/emenu-8114.spec.ts`：字体串的断言改成品牌字体在最前。

## 2. 已执行的验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint` / `check:code` / `check:docs` / `check:gov` / `format:check` | 通过 |
| `npm run test:unit` | 通过 |
| 浏览器验收 `e2e/emenu-8114.spec.ts` 等 | 交 CI（测试环境没放授权文件，画出来的是 Playfair Display） |

## 3. 验收要点

1. 在验收用的服务器上放授权文件：ABC Arizona Flare Regular 的 WOFF2 改名 `en.woff2`，放到 `compose.yaml` 旁边的 `brand-fonts/`；平板账号打开 `/api/emenu/fonts/en.woff2` 能下载到（没放时 404）。
2. 平板（或浏览器 1355 × 903）进电子菜单，逐页看：菜名下面的英文名、顶栏分类下面的英文是 ABC Arizona Flare；切到英文后顶栏英文与菜名本身同样。
3. 菜品详情、搜索结果、订单抽屉里的英文名同样；工作台 `/studio/emenu` 的画布、后台「电子菜单」的版面预览同样。
4. 删掉授权文件、刷新：这两处回到 Playfair Display，页面不报错。
5. 别处的英文（封面大标题、介绍、价格、按钮、弹窗、手牌，中文时手牌号的字母数字）也是 ABC Arizona Flare；工作台主题的英文字体改成「衬线」「无衬线」后仍是。

## 4. 给测试 AI 的指令

```
【主线·测试】→ 主线 · main v8.1.19 · <完整 SHA>
在独立演示库上验收 v8.1.19（docs/HANDOFF_V8119.md）：
1. 不放授权字体：E2E_BASE_URL=http://127.0.0.1:<端口> npx playwright test e2e/emenu-8114.spec.ts e2e/emenu.spec.ts --project=门店电脑，全部通过。
2. 有授权的 en.woff2 时（只在店主给的授权文件上做，试用版不要放）：平板大小逐页核对顶栏与菜名下方的英文是 ABC Arizona Flare，截图发在 PR 上。
没有授权文件就把第 2 条记「受阻未测」，不记通过。
```
