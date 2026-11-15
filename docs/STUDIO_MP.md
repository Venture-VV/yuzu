# 工作台 · 小程序的版面格式（8.1.2，给小程序线）

设计师在系统的「工作台」里排小程序的版面，发布以后小程序照版面画。这份说明写给小程序线（Gemini）：版面长什么样、每一项怎么画、从哪里读。

- **主线**管格式、编辑器、发布：`src/shared/studio/`（格式与界面登记）、`src/server/modules/studio/`（发布、读取）。
- **小程序线**管在小程序里画：读已发布的版面，在 `miniprogram/` 里写一个递归渲染的自定义组件。主线的这几个目录小程序线不改；格式要改，在主线的 PR 上提。
- 设计依据：`docs/WORKBENCH_V811.md` 第 3、8 节。

## 0. 小程序线要做的事

1. 在 `src/server/modules/mp/` 里加一个读取入口：调主线的 `readPublishedStudio(db, 'mp', storeId)`，取图调 `readStudioAssetFor(db, 'mp', id)`，见第 5 节。网关照小程序线的习惯转出去。
2. 在 `miniprogram/` 里写渲染组件：照第 1–4 节把版面画出来。功能块接小程序原来的页面逻辑，动作接 `wx.navigateTo` 等，数据字段接小程序已有的数据。
3. 首页、活动页、会员页（「我的」）改成按版面画。没发布过版面、取不到、格式认不出时，照旧画小程序原来的页面（第 6 节）。
4. 用第 7 节的样例逐张比对。要真机的部分由 Codex「小程序助手」在门店 Mac mini 上做。

## 1. 坐标与单位

- 设计稿按 **375 宽**排，版面里的数都是这个宽下的像素。小程序里 **1 像素 = 2rpx**：`x: 18` 写成 `36rpx`，字号 `14` 写成 `28rpx`。
- 一屏多高：`screens.<屏>.height`；没写用 812。手机往下滚：
  - 整屏「自动排列」时，内容多了往下长，`height` 是最少这么高；
  - 整屏「自由摆放」时，就是这么高，超出的不显示。
- 坐标原点是这一屏（或所在的框）的左上角，往右、往下是正。

## 2. 版面的结构

```jsonc
{
  "schema": 1,                       // 格式版本：现在是 1；以后改格式会加一，并在这里写升级说明
  "surface": "mp",
  "theme": {
    "colors": { "bg": "#F5F1EA", "wood": "#937051", ... },   // 主题色，键见第 3.1 节
    "fonts": { "zh": "system", "en": "helvetica" }           // 中文、英文字体，见第 3.2 节
  },
  "screens": {
    "home":     { "background": "$bg", "height": 812, "layout": { ... }, "nodes": [ ... ] },
    "activity": { ... },
    "member":   { ... }
  }
}
```

- **屏**：`home` 首页、`activity` 活动页、`member` 会员页（「我的」）。只开放这三屏；充值、支付、退款等页只跟主题色和字体，不开放结构。
- `background`：这一屏的底色，`null` 时用 `$bg`。
- `layout`：整屏的排列，见第 4 节；没写是自由摆放。
- `nodes`：这一屏的节点。**后面的盖在前面的上面**；在自动排列里，先后就是排的顺序。
- 版面最外层另有的项（`templates` 卡片模板、`dishStates` 菜的几种样子，8.1.2）只有平板菜单的版面有，小程序的版面里不会出现（核对拦着）；以后再加的外层项照第 8 节，认不出的不用管。
- **组件**（8.1.2）：设计师在工作台里可以把一块存成组件、在几处重复用（编辑器里是 `instance` 节点 + 最外层的 `components`）。**`readPublishedStudio` 读出来的版面里组件已经展开成普通节点**：没有 `instance`、没有 `components`，组件里面节点的编号是「实例编号__原编号」（不重复，可以当 `wx:key`）。小程序照本文画普通节点就行。

## 3. 节点

### 3.0 每个节点都有的

| 字段 | 意思 |
| --- | --- |
| `id` | 编号，同一份版面里不重复，可以当 `wx:key` |
| `type` | `frame` 框、`rect` 矩形、`ellipse` 椭圆、`text` 文字、`image` 图片、`button` 按钮、`field` 数据字段、`block` 功能块 |
| `x` `y` `w` `h` | 位置、大小（自由摆放时用；在自动排列里看 `sizing`，见第 4 节） |
| `rotate` | 绕中心转的度数（`transform: rotate(…deg)`，中心是这一块的中心） |
| `opacity` | 0–1 |
| `hidden` | `true` 的不画，也不占位置 |
| `locked` | 编辑器用的，小程序不看 |
| `name` | 设计师取的名字，小程序不看 |
| `sizing` | 可选。在自动排列里宽、高怎么定，见第 4 节 |

**不认识的 `type`：这一个节点不画（连同它里面的），别的照画，不要整页白屏。不认识的字段：不看。**

### 3.1 颜色

颜色有三种写法：
- `#RRGGBB`；
- `#RRGGBBAA`：带透明度，换成 `rgba()` 写，老的 WebView 不认 8 位的；
- `$主题色`：去 `theme.colors` 里找。

主题色对应小程序 `app.wxss` 里的变量，设计师改了的值在 `theme.colors` 里，用版面里的值：

| 主题色 | app.wxss | 默认 | | 主题色 | app.wxss | 默认 |
| --- | --- | --- | --- | --- | --- | --- |
| `bg` | `--bg` | #F5F1EA | | `wood5` | `--wood-5` | #E4D0B3 |
| `surface` | `--surface` | #FCFAF6 | | `wood6` | `--wood-6` | #EBDECA |
| `ink` | `--ink` | #1C1A17 | | `organic` | `--organic` | #5D6B3B |
| `muted` | `--muted` | #776C60 | | `relax` | `--relax` | #4E6B82 |
| `line` | `--line` | #E0D7C9 | | `energy` | `--energy` | #B5532F |
| `wood` | `--wood` | #937051 | | `danger` | `--danger` | #A6452F |
| `wood2` | `--wood-2` | #AD8E69 | | `cardA` | `--card-a` | #5B4432 |
| `wood3` | `--wood-3` | #C4A67E | | `cardB` | `--card-b` | #937051 |
| `wood4` | `--wood-4` | #D2B993 | | `cardInk` / `cardMuted` | `--card-ink` / `--card-muted` | #FBF6EE / #E2CFB2 |

建议把 `theme.colors` 整份设到页面最外层的 `style` 上（`--wood: #8A6A4A; ...`），这样充值、支付这些不开放结构的页也跟着主题走。

### 3.2 字体

- `theme.fonts.zh`：
  - `system`：系统字体，等于现在的 `--font-zh`；
  - `serif`：宋体，`'Songti SC', 'STSong', 'Noto Serif CJK SC', serif`。
- `theme.fonts.en`：
  - `helvetica`：等于现在的 `--font-en`；
  - `serif`：`Georgia, 'Times New Roman', serif`。
- 文字类节点的 `font` 是 `zh` 或 `en`，指用主题里的中文字体还是英文字体。

### 3.3 `frame` 框

底色 `fill`、描边 `stroke` + `strokeWidth`、圆角 `radius`、投影 `shadow`，`clip: true` 时超出框的不显示（`overflow: hidden`）。里面的节点在 `children`：
- 有 `layout` 且 `mode` 是 `row` / `column` 时，自动排列，见第 4 节；
- 没有 `layout`（或 `mode: free`）时，按各自的 `x / y` 绝对定位，相对框的左上角。

有 `action` 的框整块能点，见第 3.8 节。

投影只有四档：

| shadow | box-shadow |
| --- | --- |
| `none` | 无 |
| `sm` | `0 1px 3px rgba(0,0,0,0.12)` |
| `md` | `0 4px 14px rgba(0,0,0,0.16)` |
| `lg` | `0 12px 32px rgba(0,0,0,0.22)` |

描边画在框里面（`box-sizing: border-box`），不往外长。

### 3.4 `rect` 矩形、`ellipse` 椭圆

和框的样式一样（`fill`、`stroke`、`strokeWidth`、`radius`、`shadow`）。椭圆是 `border-radius: 50%`，不看 `radius`。里面没有东西。

### 3.5 `text` 文字、`field` 数据字段

| 字段 | 画法 |
| --- | --- |
| `text: { zh, en }` | 显示 `zh`（小程序没有中英切换；以后加了，英文没填的显示中文） |
| `font` | `zh` / `en`，见第 3.2 节 |
| `size` | 字号（像素，×2 成 rpx） |
| `weight` | 300 / 400 / 500 / 600 / 700 / 900 |
| `color` | 颜色 |
| `lineHeight` | 行高是字号的几倍，换成像素：`size × lineHeight` |
| `letterSpacing` | 字距，单位是 em：`0.2` 写成 `letter-spacing: 0.2em` |
| `align` | 左右对齐：`left` / `center` / `right` |
| `valign` | 在框里上下对齐：`top` / `middle` / `bottom`，用竖排的 flex 加 `justify-content` 做 |
| `italic` / `underline` | 斜体、下划线 |
| `fill` | 文字框的底色，`null` 不画 |

文字保留换行（`white-space: pre-wrap`），长词随处可断（`overflow-wrap: anywhere`），超出框的不显示（`overflow: hidden`）。

**`field` 数据字段**和文字一样画，只是内容是 `prefix.zh + 数据 + suffix.zh`。数据见第 3.9 节；取不到的显示空串，前后的字照写。

### 3.6 `image` 图片

- `asset` 是素材的编号：64 位十六进制，是图片内容的 SHA-256。图片地址照第 5 节取。
- `fit`：`cover` 铺满（多出来的裁掉，小程序 `mode="aspectFill"`）、`contain` 完整显示（`aspectFit`）、`fill` 拉伸（`scaleToFill`）。
- `radius` 圆角；`fill` 是图片还没出来时的底色。
- 有 `action` 的图片能点。

### 3.7 `button` 按钮

一个框里一行字。样式字段同框（`fill`、`stroke`、`strokeWidth`、`radius`、`shadow`），字的字段同文字（第 3.5 节）。左右各留 12 像素（24rpx）内边距，字默认上下居中。有 `action` 时点了做那个动作，没有时只是样子。小程序 `button` 的默认样式要去掉，`app.wxss` 里已经去掉了。

### 3.8 `action` 点了做什么

只有这几种（编辑器只给选这几种，服务端也核对过）：

| action | arg | 小程序里 |
| --- | --- | --- |
| `open.page` | 页名，见下表 | 打开那一页（tabBar 的页用 `wx.switchTab`，别的用 `wx.navigateTo`） |
| `call.store` | 空 | 拨打当前门店的电话（`wx.makePhoneCall`），门店没有电话时不做事 |
| `nav.store` | 空 | 打开当前门店的位置（`wx.openLocation`），没有经纬度时不做事 |

`open.page` 的 `arg`：
- `home`、`prices`、`guide`、`me`：tabBar 的页；
- `code`、`coupons`、`coupon-center`、`benefits`、`ledger`、`recharge`、`invite`、`food`、`booking`、`bookings`：对应 `pages/<名>/index`；
- `activity`：按版面画的活动页（小程序线新加一页，或在已有的页里显示 `activity` 这一屏）。

认不出的 `action` 或 `arg`：点了不做事。

### 3.9 数据字段

| field | 内容 | 编辑器里的样例 |
| --- | --- | --- |
| `store.name` | 当前门店名 | 汤崎·前海店 |
| `store.hours` | 营业时间 | 10:00–次日 02:00 |
| `store.address` | 地址 | 深圳市南山区前海路 88 号 |
| `store.phone` | 电话 | 0755-8888 0000 |
| `store.notice` | 门店公告 | 本周三 14:00–16:00 温泉池例行保养 |
| `member.name` | 会员称呼（没登录：空） | 林女士 |
| `member.grade` | 会员等级名 | 金卡会员 |
| `member.balance` | 储值余额，`¥1,280.00` 的写法 | ¥1,280.00 |
| `member.coupons` | 可用的券的张数 | 3 |
| `today.date` | 今天，`11 月 15 日 周日` 的写法 | 11 月 15 日 周日 |

数据都用小程序已有的接口取（门店信息、「我的」），不另开口子。会员的数据只显示给登录的本人。

### 3.10 `block` 功能块

功能块带逻辑，由小程序线照原来的页面画（真实的数据、原来的点按）。版面只管放在哪、多大、几样颜色（`props`）。

| block | 在哪一屏 | 画什么 | props |
| --- | --- | --- | --- |
| `mp.banner` | 首页、活动页 | 现在首页的版头：轮播图（后台配的），没配时是氛围底色加字标 | `shade` 0–0.8 压暗；`wordmark` 显示字标；`autoplay` 自动轮播 |
| `mp.store` | 首页（**必需**） | 现在首页的门店信息：多店切换、营业时间、地址、电话、公告、导航到店、拨打电话 | `card` 卡片底色（颜色）；`buttons` 显示导航与拨打 |
| `mp.memberCard` | 会员页（**必需**） | 现在「我的」的会员卡：等级、余额、到下一档还差多少、会员码入口；没登录时是「登录 / 注册」 | `from` / `to` 渐变两头的颜色；`ink` 卡上的字色 |

- 功能块只放在屏上，不会在框里。
- 在整屏自动排列里，它们的 `sizing` 一般是宽撑满、高跟内容（`mp.banner` 是固定高）。
- 编辑器、样例截图里的功能块是示意，样子以小程序原来的为准。

## 4. 自动排列与尺寸规则

`layout`（框、屏都可能有）：

| 字段 | 意思 | CSS / WXSS |
| --- | --- | --- |
| `mode` | `free` 自由摆放（按 x / y）；`row` 横排；`column` 竖排 | `display: flex; flex-direction: row / column` |
| `wrap` | 横排放不下时换行 | `flex-wrap: wrap` |
| `gap` | 一个与下一个之间的距离（换行时也是行与行之间） | 见下面「间距」 |
| `padding` | 内边距：上、右、下、左 | `padding` |
| `align` | 另一个方向上怎么对齐：`start` / `center` / `end` / `stretch`（撑满） | `align-items: flex-start / center / flex-end / stretch` |
| `justify` | 排的方向上怎么分：`start` / `center` / `end` / `between`（两头对齐、中间平分） | `justify-content: flex-start / center / flex-end / space-between` |

自动排列里的节点：
- **不看 `x / y`**，按先后排；
- 位置是 `position: relative`，里面再有自由摆放的框照样绝对定位；
- 不缩（`flex-shrink: 0`），撑满的除外；
- 宽、高看 `sizing`：

| sizing | 在排的方向上（横排的宽、竖排的高） | 在另一个方向上 |
| --- | --- | --- |
| `fixed` 固定（没写 `sizing` 也是固定） | 用 `w` / `h` | 用 `w` / `h` |
| `fill` 撑满 | 分剩下的：`flex: 1 1 0; min-width / min-height: 0` | 拉满：`align-self: stretch` |
| `hug` 跟内容 | 不写宽高，由内容撑开 | 不写宽高；父级 `align: stretch` 时照样被拉满 |

**间距**：本仓库的 React 渲染器用 CSS 的 `gap`。小程序里不用 flex 的 `gap`（老 iOS 不认，见 `app.wxss` 开头），换成外边距：
- **不换行时**：除最后一个外，每个往排的方向留 `gap`。横排是 `margin-right`，竖排是 `margin-bottom`；被 `hidden` 跳过的不算。
- **换行时**：每个都留 `margin-right: gap; margin-bottom: gap`，里面再包一层 `margin-right: -gap; margin-bottom: -gap`，把多出来的抵掉。

画出来要与样例截图一致（第 7 节）。

## 5. 读已发布的版面（主线给的函数）

在 `src/server/modules/studio/published.ts`，小程序线在 `src/server/modules/mp/` 里引用：

```ts
import { readPublishedStudio, readStudioAssetFor } from '../studio/published';

// 这家店现在用哪一版小程序版面：这家店现在用的那一版（定时发布的到点才算，撤销的不算），没有就用本店（编号 1）的；都没有返回 null
const p = await readPublishedStudio(db, 'mp', storeId);
// p = { id, version, inherited, publishedAt, doc } | null
//   id：全局编号，内容不会变（只追加），可以按 id 长期缓存
//   doc：已经按格式与界面登记核对过；以后界面登记改了、旧的一版对不上时返回 null（不给半份）

// 取版面里的一张图：只给发布过的小程序版面里用到的图，别的返回 null；内容按编号不变，可以长期缓存
const img = await readStudioAssetFor(db, 'mp', assetId);   // { mime, data: Buffer } | null
```

建议这样转出去（具体路径、网关照小程序线的习惯）：
- **取版面**：返回 `{ id, version, doc }`，或者 `null`。小程序进页面、回到前台时取一次，`id` 没变就用本地缓存的那一份。
  - 8.1.2 起设计师可以「定时发布」（换季、节日到点才换）：到点前读到的是原来那一版，到点以后同一个入口读到新的；所以每次进页面、回到前台都要问一次，不能只按发布时间缓存。
- **取图**：返回图片本身，带长期缓存头。小程序里的 `<image>` 用这个地址；也可以先 `wx.downloadFile` 存本地。

两个函数都只读、不加锁、不写任何表，可以在读快照里用。

## 6. 没发布过、取不到、认不出时

照旧画小程序原来的页面。下面几种都算：
- `readPublishedStudio` 返回 `null`；
- 网络不通又没有缓存；
- `schema` 不是 1；
- 整份 JSON 解析不了。

只有某一个节点认不出时，跳过这一个，别的照画（第 3.0 节）。

主线 `defaultStudioDoc('mp')` 是照小程序现在的首页、「我的」排的一份默认版面（样例 01、02）。工作台里设计师从它开始改；小程序没发布过时可以照它画，也可以照原来的页面画，由小程序线定。

## 7. 样例与比对

- **样例在 `tests/fixtures/studio/mp/`**：
  - 每份 `NN-名字.json` 是 `{ name, screen, note, doc }`：画 `doc` 的 `screen` 这一屏；
  - 同名的 `.png` 是本仓库的 React 渲染器在 375 宽、两倍像素下的截图，正好 750 像素宽，等于小程序的 750rpx；
  - 用到的图在 `assets/<SHA-256>.png`。
- **五份样例**：

| 样例 | 看什么 |
| --- | --- |
| `01-home-default` | 默认首页：整屏竖排；功能块（版头、门店信息）；能点的框（三块业务、入口），横排换行 |
| `02-member-default` | 默认会员页：会员卡功能块；八个入口，两行 |
| `03-activity-poster` | 海报图（铺满）、文字、两栏数据字段（横排 + 撑满）、实心与描边按钮 |
| `04-layout-sheet` | 排列测试表：四种分布、四种对齐、换行、固定 + 撑满、内边距、自由摆放套在竖排里、旋转 |
| `05-text-sheet` | 文字与样式测试表：字号、粗细、字距、英文字体、行高、对齐、竖直对齐、斜体下划线、数据字段、颜色（主题 / 十六进制 / 带透明度）、透明度、投影、描边、圆角、三种按钮 |

- **怎么比**：比位置、大小、颜色、排列、换行，不比字形——截图用的是 Linux 上的字体，小程序里是苹方、鸿蒙字体，字的形状和宽度会有一点不同。功能块是示意，不比。
- **建议**：小程序线在 `miniprogram/tests/` 里用这几份做渲染组件的单元用例（比如核对每个节点算出来的样式）；Codex「小程序助手」在开发者工具里画这几份，与 `.png` 并排看。
- **主线改了格式或样例**：主线跑 `npx tsx scripts/studio-mp-samples.ts` 重新生成 JSON，跑 `scripts/studio-mp-shots.mjs` 重新截图，用例 `tests/studio-mp-samples.test.ts` 核对两边一致。

## 8. 以后的变化

- 格式版本 `schema` 现在是 1，8.1.2 加的都是可选项（`layout`、`sizing`、`action`、按钮、数据字段、屏的高度）；8.1.1 的旧版面一字不改照样能读。
- 以后改格式：
  - 能兼容的，只加可选项，小程序认不出的照第 3.0 节跳过；
  - 不兼容的，`schema` 加一，服务端把旧版面升上来，并在这里写清楚怎么画。
- 以后加功能块、动作、字段，先在主线的界面登记（`src/shared/studio/surfaces.ts` 的 `MP_SURFACE`）加上，这里同时写明；小程序线照着画，没画好之前认不出的照第 3.0 节跳过。
