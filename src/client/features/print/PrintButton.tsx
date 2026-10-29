import { Printer } from 'lucide-react';
import { Button } from '../../components/ui';
import { useToast } from '../../components/Toast';

/** 在新窗口打开打印页：读到数据后自动调出打印，打完关闭；弹出窗口被浏览器拦下时提示 */
export function PrintButton({ path, children, testId, size = 'md' }: { path: string; children: string; testId?: string; size?: 'sm' | 'md' | 'lg' }) {
  const toast = useToast();
  return (
    <Button
      size={size}
      icon={<Printer className="size-4" />}
      data-testid={testId}
      onClick={() => {
        const w = window.open(`${path}?auto=1`, '_blank', 'popup,width=420,height=760');
        if (!w) toast({ tone: 'error', title: '打印窗口被浏览器拦下了', body: '请在地址栏右侧允许本站弹出窗口，再点一次打印' });
      }}
    >
      {children}
    </Button>
  );
}
