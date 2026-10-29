import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Eye, EyeOff, Lock, User } from 'lucide-react';
import { versionText, type InstanceKind } from '@shared/instance';
import type { SessionInfo } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { LandscapeIllustration, LogoMark } from '../../components/Brand';
import { InstanceBadge } from '../../components/InstanceTag';
import { Button, Field, Input, Notice } from '../../components/ui';

interface PublicInfo {
  storeName: string;
  env: string;
  version: string;
  commit: string;
  instance: InstanceKind;
  demoHint: boolean;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<PublicInfo>('/api/public/info'), retry: 1 });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const state = location.state as { from?: string; expired?: boolean } | null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const session = await api.post<SessionInfo>('/api/auth/login', { username, password });
      qc.setQueryData(qk.session, session);
      navigate(state?.from && state.from !== '/login' ? state.from : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-dvh bg-paper lg:grid-cols-[minmax(0,1.08fr)_minmax(440px,1fr)]">
      {/* 品牌区 */}
      <section className="relative h-[260px] overflow-hidden bg-[#f3ead8] sm:h-[320px] lg:h-auto">
        <LandscapeIllustration className="absolute inset-0 h-full w-full" />
        <div className="relative flex h-full flex-col p-7 sm:p-10 lg:p-14">
          <div className="flex items-center gap-3">
            <LogoMark className="size-10" />
            <span className="text-[13px] font-bold tracking-[0.32em] text-pine">浴族 · YUZU</span>
          </div>
          <div className="mt-6 max-w-md sm:mt-10 lg:mt-24">
            <p className="font-display text-[56px] leading-[0.9] tracking-tight text-ink italic sm:text-[76px] lg:text-[104px]">
              yuzu
            </p>
            <p className="mt-3 text-[15px] font-semibold tracking-[0.2em] text-ink-2 sm:text-[17px] lg:mt-5">
              城市里的山野汤泉
            </p>
          </div>
        </div>
      </section>

      {/* 登录表单 */}
      <section className="flex items-center justify-center px-6 py-10 sm:px-10">
        <div className="w-full max-w-[380px] animate-rise">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold text-ink-3">{info.data?.storeName ?? '浴族 · 城市汤泉'}</p>
            {info.data && <InstanceBadge instance={info.data.instance} />}
          </div>
          <h1 className="mt-1.5 text-[28px] font-bold tracking-tight text-ink">欢迎回来</h1>
          <p className="mt-1.5 text-[14px] text-ink-3">登录门店工作台，开始今天的接待。</p>

          {state?.expired && (
            <Notice tone="info" className="mt-6" title="登录已过期">
              为保护账务安全，请重新登录。
            </Notice>
          )}

          <form onSubmit={submit} className="mt-8 flex flex-col gap-5" noValidate>
            <Field label="账号" htmlFor="username">
              <div className="relative">
                <User className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-ink-4" />
                <Input
                  id="username"
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="员工账号"
                  className="h-12 pl-10 text-[15px]"
                />
              </div>
            </Field>
            <Field label="密码" htmlFor="password">
              <div className="relative">
                <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-ink-4" />
                <Input
                  id="password"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="密码"
                  className="h-12 pr-12 pl-10 text-[15px]"
                />
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? '隐藏密码' : '显示密码'}
                  className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2"
                >
                  {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
                </button>
              </div>
            </Field>

            {error && <Notice tone="error" title={error} />}

            <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-1 w-full">
              登录
              {!loading && <ArrowRight className="size-[18px]" />}
            </Button>
          </form>

          <p className="mt-6 text-[13px] text-ink-3">忘记密码请联系店主在「管理 → 员工」中重置。</p>

          {info.data?.demoHint && (
            <div className="mt-8 rounded-lg border border-dashed border-line-strong bg-card/70 px-4 py-3 text-[13px] text-ink-2">
              <p className="font-bold text-ink">演示环境 · 合成数据</p>
              <p className="mt-1">
                店主 <code className="num font-semibold text-pine">linlan</code>、店员{' '}
                <code className="num font-semibold text-pine">xiaozhou</code>，密码均为{' '}
                <code className="num font-semibold text-pine">yuzu2026</code>
              </p>
            </div>
          )}
          {info.data && (
            <p className="num mt-10 text-[12px] text-ink-4" data-testid="login-version">
              浴族门店经营系统 · {versionText(info.data.version, info.data.commit)}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
