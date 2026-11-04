import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import type { DrawerBoard, ShiftRecord } from '@shared/checkout';
import { parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Field, MoneyInput, Notice, Select } from '../../components/ui';

// 收款前必须先开班（R1.2，店主 2026-10-29 签认，经营规则可关闭）：充值、结账、反结账的页面上没有开班时就地开班，
// 不用先跳到「交班」页。服务端同样核对（SHIFT_REQUIRED），页面只是提前提示。

export const shiftKeys = {
  all: ['shift'] as const,
  current: ['shift', 'current'] as const,
  drawers: ['shift', 'drawers'] as const,
  list: (date: string) => ['shift', 'list', date] as const,
};

/**
 * 交班方式与各钱箱此刻的班次（v0.7.28 ⑨）：开班表单按它显示「只填备用金」（按人交班）或「选钱箱、开班或加入」（按钱箱交班）。
 * 加载完之前按登录时的规则显示（后台刚切换时以接口为准）。
 */
export function useDrawerBoard(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: shiftKeys.drawers,
    queryFn: () => api.get<DrawerBoard>('/api/shifts/drawers'),
    enabled,
    refetchInterval: 30_000,
    placeholderData: { mode: session.rules.shiftMode ?? 'person', drawers: [], mine: null },
  });
}

export function useCurrentShift(enabled = true) {
  return useQuery({
    queryKey: shiftKeys.current,
    queryFn: () => api.get<{ shift: ShiftRecord | null; today?: string }>('/api/shifts/current'),
    enabled,
    refetchInterval: 30_000,
  });
}

/**
 * 班次跨营业日的提醒（店主 2026-11-01 同意，v0.7.10）：本人还没交班的班次，开班时的营业日早于今天的营业日，
 * 提醒先交班；只提醒、不拦截收款（按人交班、交班时核对现金的规则不变）。
 * 「今天」用当班接口每 30 秒轮询时带回的营业日：页面一直开着、过了营业日切换时间也能提醒（登录时的营业日会过时）。
 */
export function CrossDayShiftNotice({ className }: { className?: string }) {
  const session = useSession();
  const can = useCan();
  const current = useCurrentShift(can('ledger.readToday'));
  const shift = current.data?.shift;
  const today = current.data?.today ?? session.today;
  if (!shift || shift.status !== 'open' || shift.businessDate >= today) return null;
  const [, m, d] = shift.businessDate.split('-');
  return (
    <div className={className} data-testid="shift-cross-day">
      <Notice tone="warning" title={`这个班次从 ${Number(m)} 月 ${Number(d)} 日开到现在，请先交班`}>
        班次 {shift.shiftNo} 开班时是营业日 {shift.businessDate}，今天是 {today}。交班后再开新班，交班表按营业日分开；收款照常可以办理。
      </Notice>
    </div>
  );
}

/** 这次收款能不能直接办理：规则关闭，或本人已开班 */
export function useShiftReady(enabled = true) {
  const session = useSession();
  const required = session.rules.requireOpenShift;
  const current = useCurrentShift(enabled && required);
  return {
    required,
    loading: required && current.isPending,
    ready: !required || !!current.data?.shift,
    shift: current.data?.shift ?? null,
  };
}

/**
 * 开班表单（交班页与收款页共用）：按人交班时登记钱箱里的备用金后开班；
 * 按钱箱交班时选钱箱——这个钱箱已经开班就「加入」，还没开班就登记备用金开班。
 */
export function StartShiftForm({ compact, onStarted }: { compact?: boolean; onStarted?: (s: ShiftRecord) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const board = useDrawerBoard();
  const [cash, setCash] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseYuan(cash || '0');
  const drawerMode = board.data?.mode === 'drawer';
  const drawers = board.data?.drawers ?? [];
  // 没选过时：先选已经开班的钱箱（来接班的人多半是加入），否则第一个启用的
  const drawer = drawers.find((d) => d.key === pick) ?? drawers.find((d) => d.shift) ?? drawers.find((d) => d.active) ?? null;
  const done = async (s: ShiftRecord, title: string) => {
    toast({ tone: 'success', title, body: compact ? '可以继续办理这一笔了' : undefined });
    await qc.invalidateQueries({ queryKey: shiftKeys.all });
    onStarted?.(s);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: shiftKeys.all });
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      const s = await api.post<ShiftRecord>('/api/shifts', { openingCash: cents, ...(drawerMode ? { drawer: drawer?.key ?? null } : {}) });
      await done(s, s.drawerName ? `已在${s.drawerName}开班 ${s.shiftNo}` : `已开班 ${s.shiftNo}`);
    });
  const join = () =>
    run(async () => {
      const s = await api.post<ShiftRecord>(`/api/shifts/${drawer!.shift!.id}/join`, {});
      await done(s, `已加入${s.drawerName ?? ''}（班次 ${s.shiftNo}）`);
    });
  const cashField = (
    <Field label="备用金（元）" className={compact ? 'w-[160px]' : 'w-[200px]'}>
      <MoneyInput value={cash} onChange={(e) => setCash(e.target.value)} aria-label="备用金" data-testid="shift-opening-cash" />
    </Field>
  );
  if (drawerMode) {
    const names = (d: (typeof drawers)[number]) => d.shift!.members.map((m) => m.staffName).join('、') || '没有人';
    return (
      <>
        <div className={cn('flex flex-wrap items-end gap-3', compact ? 'mt-2' : 'mt-4')} data-testid="shift-drawer-form">
          <Field label="钱箱" className={compact ? 'w-[240px]' : 'w-[280px]'}>
            <Select value={drawer?.key ?? ''} onChange={(e) => setPick(e.target.value)} aria-label="钱箱" data-testid="shift-drawer">
              {drawers.length === 0 && <option value="">没有启用的钱箱</option>}
              {drawers.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                  {d.shift ? `（当班：${names(d)}）` : d.active ? '（还没开班）' : '（已停用）'}
                </option>
              ))}
            </Select>
          </Field>
          {drawer?.shift ? (
            <Button variant="primary" size={compact ? 'md' : 'lg'} loading={busy} onClick={() => void join()} data-testid="shift-join-submit">
              加入{drawer.name}
            </Button>
          ) : (
            <>
              {cashField}
              <Button variant="primary" size={compact ? 'md' : 'lg'} disabled={cents === null || !drawer?.active} loading={busy} onClick={() => void start()} data-testid="shift-start-submit">
                在{drawer?.name ?? '钱箱'}开班
              </Button>
            </>
          )}
        </div>
        <p className="mt-1.5 text-[12px] text-ink-3">按钱箱交班：同一个钱箱的人在同一个班次上，收款都记进来；交班时点这个钱箱的钱。</p>
        {error && <Notice tone="error" title={error} className="mt-3" />}
      </>
    );
  }
  return (
    <>
      <div className={cn('flex flex-wrap items-end gap-3', compact ? 'mt-2' : 'mt-4')}>
        {cashField}
        <Button variant="primary" size={compact ? 'md' : 'lg'} disabled={cents === null} loading={busy} onClick={() => void start()} data-testid="shift-start-submit">
          开班
        </Button>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </>
  );
}

/**
 * 收款页上的开班提示：规则要求先开班、本人还没有开班时显示；开班后自动消失，员工继续办理。
 * 服务端以 SHIFT_REQUIRED / SHIFT_CLOSED 拒绝时（班次可能刚在别处交班），调用方刷新当前班次，这里随之出现。
 */
export function ShiftGate({ action }: { action: string }) {
  const { required, ready, loading } = useShiftReady();
  if (loading || !required || ready) return null;
  return (
    <div data-testid="shift-gate">
      <Notice tone="warning" icon={<ClipboardCheck className="size-4" />} title={`${action}前要先开班`}>
        收款记到你当班的交班表里：登记钱箱里的备用金后开班（按钱箱交班时选钱箱，已经开班的点「加入」），再继续办理这一笔（交班时按备用金与当班收款核对现金）。
        <StartShiftForm compact />
      </Notice>
    </div>
  );
}

/** 收款被拒绝是因为没有开班或班次刚交班：刷新当前班次，让页面上的开班提示出现 */
export const SHIFT_ERRORS = ['SHIFT_REQUIRED', 'SHIFT_CLOSED'];
