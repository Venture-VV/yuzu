import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Button, Notice } from './ui';

/**
 * 列表没取回来（店主 2026-11-14 的需求 3、4）：与「真的一条都没有」分开——写明是加载失败、给一个「重试」，
 * 不引导去后台添加。重试只重发这一个请求，页面上已经填的东西不动。
 */
export function LoadFailed({
  title,
  children,
  onRetry,
  retrying,
  className,
  testId,
}: {
  title: string;
  children?: ReactNode;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <Notice
      tone="error"
      title={title}
      className={className}
      data-testid={testId}
      action={
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} loading={retrying} onClick={onRetry} data-testid={testId ? `${testId}-retry` : undefined}>
          重试
        </Button>
      }
    >
      {children}
    </Notice>
  );
}
