import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ApiError, UncertainError } from './lib/api';
import { noteProblem, reportClientError } from './lib/clientLog';
import { startConnectionWatch } from './lib/connection';

// 看连接（8.1.3，docs/RESILIENCE_V813.md 第 3.2 节）：问服务器而不只看网卡，接管 React Query 的在线判断
startConnectionWatch();

// 没接住的错误报给服务器（8.1.3 WL7）。网络问题（结果不确定、明确拒绝）是预料之中的、页面各自处理，不报；
// 别的网站的脚本（浏览器插件）、浏览器自己的 ResizeObserver 提示不报
window.addEventListener('error', (event) => {
  if (!event.error || (event.filename && !event.filename.startsWith(location.origin))) return;
  if (/ResizeObserver loop/.test(String(event.message))) return;
  reportClientError('error', event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  if (reason instanceof UncertainError || reason instanceof ApiError) return;
  if (reason instanceof DOMException && reason.name === 'AbortError') return;
  reportClientError('rejection', reason);
});
// Vite 预加载页面代码或样式表失败：记下来；不拦，交给按需加载的重试（lib/lazyPage）
window.addEventListener('vite:preloadError', (event) => {
  const payload = (event as Event & { payload?: unknown }).payload;
  noteProblem('retry', `页面代码预加载失败：${payload instanceof Error ? payload.message : String(payload ?? '')}`.slice(0, 200));
});

createRoot(document.getElementById('root')!, {
  // 错误边界外面没接住的（例如错误边界自己出错）也报
  onUncaughtError: (error) => reportClientError('render', error),
}).render(
  <StrictMode>
    <ErrorBoundary variant="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
