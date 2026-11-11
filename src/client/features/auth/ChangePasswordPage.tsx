import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UtensilsCrossed } from 'lucide-react';
import type { OrderPinStatus } from '@shared/emenu';
import type { SessionInfo } from '@shared/types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { relativeTime } from '../../lib/utils';
import { LogoMark } from '../../components/Brand';
import { PageHeader } from '../../components/AppShell';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice } from '../../components/ui';

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!current) errs.currentPassword = '请输入当前密码';
    if (next.length < 8) errs.newPassword = '新密码至少 8 位';
    else if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) errs.newPassword = '新密码需同时包含字母和数字';
    if (next !== confirm) errs.confirm = '两次输入的新密码不一致';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const info = await api.post<SessionInfo>('/api/auth/change-password', { currentPassword: current, newPassword: next });
      qc.setQueryData(qk.session, info);
      toast({ tone: 'success', title: '密码已修改', body: '其他设备上的登录已退出。' });
      navigate('/', { replace: true });
    } catch (err) {
      const field = err instanceof ApiError ? (err.details?.field as string | undefined) : undefined;
      setErrors(field ? { [field]: errorMessage(err) } : { form: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  const form = (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <Field label={forced ? '临时密码' : '当前密码'} htmlFor="cur" error={errors.currentPassword}>
        <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} invalid={!!errors.currentPassword} autoFocus />
      </Field>
      <Field label="新密码" htmlFor="new" hint="至少 8 位，同时包含字母和数字" error={errors.newPassword}>
        <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} invalid={!!errors.newPassword} />
      </Field>
      <Field label="再次输入新密码" htmlFor="confirm" error={errors.confirm}>
        <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!errors.confirm} />
      </Field>
      {errors.form && <Notice tone="error" title={errors.form} />}
      <Button type="submit" variant="primary" size="lg" loading={loading}>
        保存新密码
      </Button>
    </form>
  );

  if (forced) {
    return (
      <div className="paper-grain flex min-h-dvh items-center justify-center bg-paper px-6 py-10">
        <div className="w-full max-w-[420px] animate-rise">
          <LogoMark className="size-11" />
          <h1 className="mt-6 text-[26px] font-bold tracking-tight">设置你的密码</h1>
          <p className="mt-2 text-[14px] text-ink-2">
            你好，{session.staff.displayName}。首次登录请把临时密码换成只有你知道的新密码，之后的每笔操作都会记录在你的名下。
          </p>
          <Card className="mt-7 p-6">{form}</Card>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="修改密码" subtitle={`${session.staff.displayName} · ${session.staff.username}`} />
      <div className="scroll-thin flex-1 overflow-y-auto p-5 md:p-8">
        <Card className="mx-auto max-w-md p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-pine-soft text-pine">
              <ShieldCheck className="size-5" />
            </span>
            <p className="text-[13px] text-ink-2">修改后，其他设备上的登录会自动退出。</p>
          </div>
          {form}
        </Card>
        <OrderPinCard />
      </div>
    </>
  );
}

/**
 * 本人的点单密码（8.0.10，docs/EMENU.md 第 3.7 节）：在点餐平板上确认下单用的 6 位数字。
 * 系统生成、只显示一次；能点单的岗位、平板点餐开着才显示这一块。
 */
function OrderPinCard() {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const show = session.emenu && can('dining.order') && can('frontdesk.operate');
  const status = useQuery({ queryKey: ['auth', 'order-pin'], queryFn: () => api.get<OrderPinStatus>('/api/auth/order-pin'), enabled: show });
  const [pin, setPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!show) return null;

  const make = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ pin: string }>('/api/auth/order-pin');
      setPin(r.pin);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['auth', 'order-pin'] });
    } catch (err) {
      toast({ tone: 'error', title: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto mt-5 max-w-md p-6" data-testid="order-pin-card">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-yuzu-soft text-yuzu-deep">
          <UtensilsCrossed className="size-5" />
        </span>
        <div>
          <p className="text-[15px] font-bold">点单密码</p>
          <p className="text-[13px] text-ink-2">客人在餐桌的平板上选好菜，你输这 6 位数字确认下单，这一单记在你名下。</p>
        </div>
      </div>
      {pin ? (
        <div className="rounded-lg border border-dashed border-pine/40 bg-pine-tint px-4 py-5 text-center">
          <p className="text-[13px] text-ink-2">你的新点单密码（只显示这一次，请记住）</p>
          <p className="num mt-2 text-[26px] font-bold tracking-wider text-pine select-all" data-testid="order-pin-value">
            {pin}
          </p>
          <Button className="mt-4" variant="secondary" size="sm" onClick={() => setPin(null)}>
            我记住了
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[13.5px] text-ink-2" data-testid="order-pin-status">
            {status.isPending ? '正在查…' : status.isError ? '没查到，稍后再试。' : status.data.has ? `已有点单密码（${relativeTime(status.data.setAt)}生成）。忘了可以重新生成，旧的马上失效。` : '还没有点单密码。'}
          </p>
          {confirming ? (
            <div className="mt-4 flex items-center gap-2">
              <span className="text-[13px] text-ink-2">重新生成后旧密码马上失效，确定吗？</span>
              <Button variant="primary" size="sm" loading={busy} onClick={make} data-testid="order-pin-confirm">
                确定
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                取消
              </Button>
            </div>
          ) : (
            <Button className="mt-4" variant="secondary" loading={busy} disabled={status.isPending} onClick={() => (status.data?.has ? setConfirming(true) : void make())} data-testid="order-pin-make">
              {status.data?.has ? '重新生成' : '生成点单密码'}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
