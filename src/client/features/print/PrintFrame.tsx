import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Printer } from 'lucide-react';
import { INSTANCE_LABELS } from '@shared/instance';
import { formatYuan } from '@shared/money';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui';

// 80mm 热敏打印（R1.3）：纸宽 80mm，可打印宽度约 72mm，用浏览器打印（@media print）。
// 打印页在新窗口打开（带 ?auto=1 时读到数据后自动调出打印、打完关闭）；屏幕上显示一张纸的预览。
// 热敏纸只打黑色：打印页一律用黑字，不用灰色。打印时 72mm 的内容在纸上居中：驱动按 80mm 报纸宽时两边各留 4mm，按 72mm 报时正好占满。

/** 年月日 时:分，按门店时区（小票要带年份，页面其他地方的时间不带） */
export function stamp(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export const yuan = formatYuan;

export function PrintFrame({ title, ready, error, children }: { title: string; ready: boolean; error: string | null; children: ReactNode }) {
  const [params] = useSearchParams();
  const auto = params.has('auto');
  const popup = typeof window !== 'undefined' && window.opener !== null;

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    if (!auto || !ready) return;
    let cancelled = false;
    const done = () => {
      if (window.opener) window.close();
    };
    window.addEventListener('afterprint', done);
    // 等字体加载完再打印，避免打出来的字形与预览不同
    void document.fonts.ready.then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', done);
    };
  }, [auto, ready]);

  return (
    <div className="min-h-dvh bg-paper-2 py-6 print:min-h-0 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex w-[80mm] max-w-full flex-wrap items-center gap-2 px-2 print:hidden">
        <Button variant="primary" icon={<Printer className="size-4" />} disabled={!ready} onClick={() => window.print()} data-testid="print-now">
          打印
        </Button>
        <Button variant="ghost" onClick={() => (popup ? window.close() : window.history.back())}>
          {popup ? '关闭' : '返回'}
        </Button>
        <p className="w-full text-[12px] text-ink-3">打印机选前台的 80mm 热敏机，边距选「无」，缩放 100%。</p>
      </div>
      <div
        data-testid="print-paper"
        className="mx-auto w-[80mm] bg-white px-[4mm] py-[5mm] text-[12px] leading-[1.45] text-black shadow-[0_1px_3px_rgba(0,0,0,0.15)] print:my-0 print:w-[72mm] print:px-0 print:py-0 print:shadow-none"
      >
        {error ? <p className="font-bold">{error}</p> : ready ? children : <p>正在读取…</p>}
      </div>
    </div>
  );
}

/** 小票抬头：店名、单据名；不是正式服时醒目标出实例（测试、影子、演示打出来的单不能当真） */
export function SlipHeader({ title }: { title: string }) {
  const session = useSession();
  return (
    <header className="mb-1.5 text-center">
      <p className="text-[16px] leading-tight font-bold">{session.storeName}</p>
      <p className="mt-0.5 text-[14px] font-bold tracking-[0.3em]">{title}</p>
      {session.instance !== 'prod' && (
        <p className="mt-1 border-2 border-black py-0.5 text-[13px] font-bold" data-testid="print-instance">
          {INSTANCE_LABELS[session.instance] ?? INSTANCE_LABELS.unset}
        </p>
      )}
    </header>
  );
}

/** 左右两端对齐的一行：左边说明，右边金额或取值 */
export function Row({ left, right, strong, big }: { left: ReactNode; right: ReactNode; strong?: boolean; big?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2', strong && 'font-bold', big && 'text-[15px] font-bold')}>
      <span className="min-w-0 break-all">{left}</span>
      <span className="num shrink-0 text-right">{right}</span>
    </div>
  );
}

export function Rule({ double }: { double?: boolean }) {
  return <hr className={cn('my-1.5 border-0 border-t border-black', double ? 'border-double border-t-[3px]' : 'border-dashed')} />;
}

/** 签字栏：留出手写的空白 */
export function SignLine({ label, name }: { label: string; name?: string | null }) {
  return (
    <div className="mt-2">
      <p>
        {label}：{name ?? ''}
      </p>
      <div className="mt-7 border-b border-black" />
    </div>
  );
}

export function PrintedAt() {
  const session = useSession();
  return <p className="mt-3 text-center text-[11px]">打印时间 {stamp(new Date().toISOString(), session.timezone)}</p>;
}
