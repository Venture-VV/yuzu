// 按需加载的页面（v0.7.22 代码整理）：管理后台、ERP、打印、看板等页面第一次打开时才下载代码，
// 前台收银、会员工作台打开得更快。加载失败（断网，或者系统刚更新过、旧页面要的文件已经换掉）时给一个重新加载的按钮。

import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Button, Spinner } from '../components/ui';

/** 动态导入失败的几种浏览器提示（Chrome / Firefox / Safari） */
const isChunkError = (e: unknown) =>
  e instanceof Error && /dynamically imported module|Importing a module script failed/i.test(e.message);

class ChunkErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  // 只处理页面代码没下载下来的情况，别的错误照旧往外抛（交给外层）
  override render() {
    const { error } = this.state;
    if (error && !isChunkError(error)) throw error;
    if (error) {
      return (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center" data-testid="page-load-failed">
          <p className="text-[15px] font-bold text-ink">这一页没有加载出来</p>
          <p className="max-w-sm text-[13px] text-ink-3">网络不通，或者系统刚更新过。网络正常后点「重新加载」；没提交的内容请先记下。</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** load 返回页面组件（命名导出）；第一次渲染时才下载那一页的代码 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Page = lazy(async () => ({ default: await load() }));
  function LazyPage(props: P) {
    return (
      <ChunkErrorBoundary>
        <Suspense
          fallback={
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          }
        >
          <Page {...props} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  }
  return LazyPage;
}
