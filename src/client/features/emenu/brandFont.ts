// 授权的品牌英文字体（8.1.5，docs/EMENU.md 第 14.2 节，PENDING_DECISIONS.md PP4）：门店服务器上放了 brand-fonts/en.woff2 时，
// 平板菜单、工作台、后台的版面预览用它显示英文（字体名 Tangqi Brand En，排在英文字体列表里 Average Sans 的前面）；
// 没放、取不到时什么都不做，照旧用 Average Sans。取到以后根节点带 data-brand-en，样式表去掉给顶替字体补的字距。
// 一个页面取到一次就记住；没取到的 10 分钟内不再取（页面开着时门店放上文件，刷新一下页面就用上）。

import { useEffect, useState } from 'react';

export const BRAND_EN_FAMILY = 'Tangqi Brand En';
const SOURCE = "url(/api/emenu/fonts/en.woff2) format('woff2')";
const RETRY_MS = 10 * 60_000;

let loaded = false;
let pending: Promise<boolean> | null = null;
let failedAt = 0;

export function loadBrandFont(): Promise<boolean> {
  if (loaded) return Promise.resolve(true);
  if (pending) return pending;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(false);
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return Promise.resolve(false);
  pending = (async () => {
    try {
      const face = new FontFace(BRAND_EN_FAMILY, SOURCE, { display: 'swap' });
      await face.load();
      document.fonts.add(face);
      loaded = true;
    } catch {
      failedAt = Date.now();
    }
    pending = null;
    return loaded;
  })();
  return pending;
}

/** 这个页面用不用得上授权的英文字体（取到了才是 true） */
export function useBrandFont(): boolean {
  const [ok, setOk] = useState(loaded);
  useEffect(() => {
    let live = true;
    void loadBrandFont().then((v) => {
      if (live) setOk(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

/**
 * 开机就把平板菜单的几款字体备好（8.1.6，QZ4、QZ5）：英文（Average Sans，顶替的那款）与两个行框字体。
 * 原来第一次切到英文时浏览器才去下载英文字体，那一下字先用别的字体画、下载完再换一次（闪一下、跳一下）。
 * 中文朱雀仿宋按用到的字分块下载，起始页、菜单一出来就用上了，不用另备；授权的品牌英文字体由 loadBrandFont 取。
 */
let warmed = false;
export function warmEmenuFonts(): void {
  if (warmed || typeof document === 'undefined' || !document.fonts?.load) return;
  warmed = true;
  for (const spec of ["16px 'Average Sans'", "16px 'Em Box En'", "16px 'Em Box Zh'"]) void document.fonts.load(spec, 'Ab0').catch(() => undefined);
}
