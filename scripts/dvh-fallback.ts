// 老浏览器的屏幕高度（8.1.4，店主 2026-11-16 报「侧边栏划不动，右边滑着左边超了」）：
// dvh（随地址栏伸缩的屏幕高度）要 Chrome 108、Safari 15.4 以后才认识。没法更新内核的安卓平板、内核偏老的浏览器
// 不认识，整条声明就当没写——门店、后台、ERP 的整屏版面（h-dvh）没有了高度，变成整页跟着内容一起滚：
// 侧栏被撑得和内容一样长、自己划不动，右边一滚、左边跟着跑出屏幕。
//
// 打包时给每一条用到 dvh / svh / lvh（dvw……）的规则，紧跟着补一条只给不认识 dvh 的浏览器用的规则，单位换成 vh / vw：
//   .h-dvh{height:100dvh}  →  .h-dvh{height:100dvh}@supports not (height:1dvh){.h-dvh{height:100vh}}
// 不写成同一条规则里的两条声明（height:100vh;height:100dvh）：Vite 用 Lightning CSS 压缩时按目标浏览器
// （都认识 dvh）把前一条当多余的删掉；单独的 @supports 不会被删。紧跟在原规则后面，层叠的先后与原来一样。
// 自定义属性（--x）不补：老浏览器照样存下原值，用到时才失效，补了也没用。
import type { AtRule, Container, Declaration, Plugin } from 'postcss';

const DYNAMIC_UNIT = /(\d*\.?\d+)[dsl]v([hw])\b/g;
const HAS_DYNAMIC_UNIT = /\d[dsl]v[hw]\b/;
export const OLD_BROWSER_SUPPORTS = 'not (height: 1dvh)';

/** 在动画关键帧里、或者已经是给老浏览器的那一块里：不补 */
function skip(node: Container | undefined): boolean {
  for (let p = node; p; p = p.parent as Container | undefined) {
    if (p.type !== 'atrule') continue;
    const at = p as AtRule;
    if (/keyframes$/i.test(at.name)) return true;
    if (at.name === 'supports' && at.params === OLD_BROWSER_SUPPORTS) return true;
  }
  return false;
}

export function toOldUnits(value: string): string {
  return value.replace(DYNAMIC_UNIT, '$1v$2');
}

export function dvhFallback(): Plugin {
  return {
    postcssPlugin: 'yuzu-dvh-fallback',
    Rule(rule, { atRule }) {
      if (skip(rule.parent)) return;
      const decls = (rule.nodes ?? []).filter((n): n is Declaration => n.type === 'decl' && !n.prop.startsWith('--') && HAS_DYNAMIC_UNIT.test(n.value));
      if (!decls.length) return;
      const next = rule.next();
      if (next?.type === 'atrule' && next.name === 'supports' && next.params === OLD_BROWSER_SUPPORTS) return; // 已经补过
      const fallback = rule.clone({ nodes: [] });
      for (const d of decls) fallback.append(d.clone({ value: toOldUnits(d.value) }));
      rule.after(atRule({ name: 'supports', params: OLD_BROWSER_SUPPORTS, nodes: [fallback] }));
    },
  };
}
