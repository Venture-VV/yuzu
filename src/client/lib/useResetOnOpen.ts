import { useState } from 'react';

/**
 * 对话框每次打开时重置填写的内容（deps 里的值在打开期间变了也重置，与 useEffect 的依赖相同）。
 *
 * 在打开的这一次渲染里就重置，不放进 useEffect：effect 在窗口显示之后才执行，手快或扫码枪输入时，
 * 会把刚输入的内容又清掉（Codex 复测 PR #18 的 P2：派钟窗口的手牌号被清空；店主 2026-10-30 定所有对话框一起改）。
 * reset 里只能改本组件的状态（React「属性变化时调整状态」的写法），不能发请求、读写本机存储。
 */
export function useResetOnOpen(open: boolean, reset: () => void, deps: readonly unknown[] = []) {
  const [seen, setSeen] = useState<{ open: boolean; deps: readonly unknown[] }>({ open: false, deps });
  const changed = seen.open !== open || (open && (deps.length !== seen.deps.length || deps.some((d, i) => !Object.is(d, seen.deps[i]))));
  if (changed) {
    setSeen({ open, deps });
    if (open) reset();
  }
}
