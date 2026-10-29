import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import type { SessionInfo } from '@shared/types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useSession } from '../../lib/session';
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
      </div>
    </>
  );
}
