// 页面出错不白屏（8.1.3，docs/RESILIENCE_V813.md 第 3.4 节，WL7；照 bvaughn/react-error-boundary 的做法）：
// 门店、后台、ERP 的内容区各一层（换页面自动重置），最外面再一层兜底；只换掉出错的那一块，导航还能用。
// 出错时报给服务器（只报错误本身与地址，不带填的内容）。

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { reportClientError } from '../lib/clientLog';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  /** 变了就重置（例如换了页面） */
  resetKey?: unknown;
  /** root：整页兜底（没有导航可用时） */
  variant?: 'section' | 'root';
}

export class ErrorBoundary extends Component<Props, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    const withStack = error instanceof Error ? error : new Error(String(error));
    if (info.componentStack && withStack.stack && !withStack.stack.includes('组件：')) withStack.stack += `\n组件：${info.componentStack.slice(0, 1200)}`;
    reportClientError('render', withStack);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const root = this.props.variant === 'root';
    return (
      <div className={root ? 'flex h-dvh flex-col items-center justify-center gap-3 bg-paper px-6 text-center' : 'flex flex-col items-center gap-3 px-6 py-16 text-center'} data-testid="page-error">
        <TriangleAlert className="size-8 text-clay" />
        <p className="text-[16px] font-bold text-ink">{root ? '页面出了点问题' : '这一块出了点问题'}</p>
        <p className="max-w-md text-[13px] leading-relaxed text-ink-3">
          先点「重试」；还不行就「刷新页面」（这一页没提交的内容会丢，先记下）。已经自动报给了系统，店主在「网络与同步」里看得到。 已经提交过、还在「结果待确认」的记录存在这台电脑上，刷新不会丢。
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => this.setState({ error: null })} data-testid="page-error-retry">
            重试
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
          {!root && (
            <Button variant="ghost" onClick={() => window.location.assign('/')}>
              回首页
            </Button>
          )}
        </div>
      </div>
    );
  }
}
