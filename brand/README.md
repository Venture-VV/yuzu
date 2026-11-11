# 品牌资料

汤崎的品牌资料与品牌内容放在这里，和门店系统的代码分开（Docker 构建不带这个目录，测试也不碰它）。

| 目录 | 内容 |
| --- | --- |
| [`concept-film/`](concept-film/README.md) | 品牌概念片《动静之间》：成片（横版、竖版）、配乐、源码、脚本与授权清单 |

## 两份品牌书

店主 2026-11-11 说明两份各管什么：

| 文件 | 管什么 |
| --- | --- |
| 《汤崎品牌书》（`汤崎品牌书-rgb.pdf`，66 页） | **内部规格**：品牌哲学（起源山水、三横三竖）、标志与组合、字体、色彩、五种景象的图形、应用示例 |
| 《TANGQI Branding & VI Strategy》（系综文化事务所，2026-03-17，178 页） | **对外宣传用**：品牌定位与口号、品牌屋、标志的调整（竖排字标为主）、字体与版式、餐饮 / 按摩 / 娱乐三条线的视觉方向、影像风格、导视 |

**两份 PDF 不放进这个仓库，飞书链接也不写在这里**（店主 2026-11-11 定）：仓库是公开的，两份都是保密资料，里面还有第三方的图片。原件在店主的飞书云空间，要用时向店主要链接。

云端会话拿到链接以后，读法与读需求文档一样（`AGENTS.md`「需求来源」）：用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 取 `tenant_access_token`，再调云空间的下载接口 `drive/v1/files/<文件 token>/download`（文件 token 是链接最后那一段）。下载下来的 PDF、逐页的截图与文字都只放在会话自己的临时目录里，不提交。

做对外的东西（片子、海报、公众号）先看 Strategy；要用到标志、色值、图形时按品牌书。两份有出入的地方以较新的 Strategy 为准（比如主标志用竖排字标、图形标与字标分开用、「汤崎」与 TOUCHILL 不同时并用）。

从品牌书里取出的矢量（图形标、竖排字标、五种景象的笔画与底色、木 / 麻六个主色）在 [`concept-film/film/assets/brand.json`](concept-film/film/assets/brand.json)，取法在 [`concept-film/tools/extract_brand_assets.py`](concept-film/tools/extract_brand_assets.py)。
