// 会员码页的屏幕亮度（Codex 审查 PR #42）：打开时调亮、离开时恢复；读亮度的回调在离开之后才回来时不再调亮。
// 用页面真实的代码（Page 的选项），wx 换成假的。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Opts = Record<string, unknown> & { data: Record<string, unknown> };

async function loadPage() {
  let opts: Opts | null = null;
  vi.stubGlobal('Page', (o: Opts) => (opts = o));
  const pending: ((r: { value: number }) => void)[] = [];
  const set: number[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '', appId: 'wx0' } }),
    getWindowInfo: () => ({ windowWidth: 375, pixelRatio: 2 }),
    getStorageSync: () => '',
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    login: (o: { fail: () => void }) => o.fail(),
    request: (o: { fail: (e: unknown) => void }) => setTimeout(() => o.fail({ errMsg: 'request:fail' }), 0),
    setKeepScreenOn: () => Promise.resolve(),
    getScreenBrightness: (o: { success: (r: { value: number }) => void }) => pending.push(o.success),
    setScreenBrightness: (o: { value: number }) => {
      set.push(o.value);
      return Promise.resolve();
    },
  });
  vi.resetModules();
  await import('../src/pages/code/index');
  const o = opts as unknown as Opts;
  const page: Record<string, unknown> & { data: Record<string, unknown> } = { ...o, data: { ...o.data } };
  page.setData = (d: Record<string, unknown>) => Object.assign(page.data, d);
  page.createSelectorQuery = () => ({ select: () => ({ fields: () => ({ exec: () => undefined }) }) });
  for (const k of Object.keys(o)) if (typeof o[k] === 'function') page[k] = (o[k] as (...a: unknown[]) => unknown).bind(page);
  return { page: page as unknown as Record<string, (...a: unknown[]) => unknown> & { brightness: number }, pending, set };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('会员码页的亮度', () => {
  it('打开时调到最亮，离开时恢复原来的亮度', async () => {
    const { page, pending, set } = await loadPage();
    page.onShow!();
    pending.shift()!({ value: 0.25 });
    expect(set).toEqual([1]);
    page.onHide!();
    expect(set).toEqual([1, 0.25]);
  });

  it('读亮度的回调在离开之后才回来：不再调亮', async () => {
    const { page, pending, set } = await loadPage();
    page.onShow!();
    page.onUnload!();
    pending.shift()!({ value: 0.25 });
    expect(set).toEqual([]);
  });

  it('离开又回来，早先的回调这时才到：照常调亮，离开时恢复成最早的亮度', async () => {
    const { page, pending, set } = await loadPage();
    page.onShow!();
    page.onHide!();
    page.onShow!();
    pending.shift()!({ value: 0.25 });
    pending.shift()!({ value: 0.25 });
    page.onHide!();
    expect(set).toEqual([1, 1, 0.25]);
  });
});
