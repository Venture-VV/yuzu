// 开通与登录：扫开通卡片（或输入开通码）→ 打个招呼 → 设密码 → 开吃；以后用账号（用户名、手机号或工号）+ 密码登录（30 天不用再登录）。
// 第二期：没账号的同事点「新同事登记」自己登记（pages/Register.tsx）。

import { useEffect, useState, type FormEvent } from 'react';
import { displayActivationCode, normalizeActivationCode, PASSWORD_MIN, type CanteenMe } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { call, messageOf } from '../lib';
import { Button, Card, Field, inputClass } from '../ui';

function Header({ title, subtitle, mood = 'happy', pose = 'wave' }: { title: string; subtitle: string; mood?: 'happy' | 'yum' | 'wink'; pose?: 'wave' | 'rest' | 'bowl' }) {
  return (
    <div className="mt-4 flex flex-col items-center text-center">
      <Mascot mood={mood} pose={pose} className="h-40 w-auto" title="柚子" />
      <p className="eyebrow mt-1">Yuzu Canteen · 汤崎</p>
      <h1 className="mt-1 text-[26px] font-black tracking-tight">
        <span className="marker">{title}</span>
      </h1>
      <p className="mt-1.5 text-[15px] text-ink-2">{subtitle}</p>
    </div>
  );
}

export function JoinPage({ initialCode, onDone, onLogin }: { initialCode: string; onDone: (me: CanteenMe) => void; onLogin: () => void }) {
  const [code, setCode] = useState(initialCode);
  const [who, setWho] = useState<{ name: string; empNo: string; avatar: string } | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const lookup = async (raw: string) => {
    const c = normalizeActivationCode(raw);
    if (c.length !== 8) return setError('开通码是卡片上的 8 位字母数字');
    setBusy(true);
    setError('');
    try {
      setWho(await call('GET', `/api/canteen/join/${c}`));
      setCode(c);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialCode) void lookup(initialCode);
    // 只在打开时用卡片上的码查一次
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < PASSWORD_MIN) return setError(`密码至少 ${PASSWORD_MIN} 位`);
    if (pw !== pw2) return setError('两次输入的密码不一样');
    setBusy(true);
    setError('');
    try {
      onDone(await call<CanteenMe>('POST', '/api/canteen/join', { code, password: pw }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col px-5 pb-10">
      <Header
        title={who ? `欢迎你，${who.name}！` : '开通柚子饭堂'}
        subtitle={who ? `工号 ${who.empNo} · 设一个自己的密码，就能开吃啦` : '输入开通卡片上的 8 位开通码'}
        mood={who ? 'yum' : 'happy'}
        pose={who ? 'bowl' : 'wave'}
      />
      <Card sketch className="mt-6">
        {!who ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
            className="space-y-4"
          >
            <Field label="开通码">
              <input
                className={`${inputClass} text-center font-mono text-[22px] tracking-[0.3em] uppercase`}
                value={code.length === 8 ? displayActivationCode(code) : code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-2345"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                maxLength={9}
                aria-label="开通码"
              />
            </Field>
            {error && <p className="text-[14px] font-bold text-danger">{error}</p>}
            <Button type="submit" big className="w-full" disabled={busy}>
              {busy ? '正在查…' : '下一步'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex items-center gap-3 rounded-2xl bg-wood-6 px-4 py-3">
              <span className="text-[34px]">{who.avatar}</span>
              <div>
                <p className="text-[16px] font-extrabold">{who.name}</p>
                <p className="text-[13px] text-ink-2">工号 {who.empNo}</p>
              </div>
            </div>
            <Field label="设一个密码" hint={`至少 ${PASSWORD_MIN} 位，别用 123456 这种`}>
              <input className={inputClass} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" aria-label="新密码" />
            </Field>
            <Field label="再输一遍">
              <input className={inputClass} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" aria-label="再输一遍密码" />
            </Field>
            {error && <p className="text-[14px] font-bold text-danger">{error}</p>}
            <Button type="submit" big className="w-full" disabled={busy}>
              {busy ? '正在开通…' : '开吃！🍚'}
            </Button>
          </form>
        )}
      </Card>
      <button type="button" onClick={onLogin} className="mt-6 text-center text-[14px] font-bold text-ink-2 underline decoration-yuzu decoration-[3px] underline-offset-4">
        已经开通过了？去登录
      </button>
    </div>
  );
}

export function LoginPage({ onDone, onJoin, onRegister }: { onDone: (me: CanteenMe) => void; onJoin: () => void; onRegister: () => void }) {
  const [account, setAccount] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await call<CanteenMe>('POST', '/api/canteen/login', { account: account.trim(), password: pw }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col px-5 pb-10" data-testid="login-page">
      <Header title="柚子饭堂" subtitle="今天吃什么？登录看看" />
      <Card sketch className="mt-6">
        <form onSubmit={submit} className="space-y-4">
          <Field label="账号" hint="用户名、手机号或工号都行">
            <input
              className={inputClass}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              autoCapitalize="none"
              autoComplete="username"
              placeholder="用户名 / 手机号 / 工号"
              aria-label="账号"
            />
          </Field>
          <Field label="密码">
            <input className={inputClass} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" aria-label="密码" />
          </Field>
          {error && (
            <p className="text-[14px] font-bold text-danger" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" big className="w-full" disabled={busy || !account.trim() || !pw}>
            {busy ? '正在登录…' : '登录'}
          </Button>
        </form>
      </Card>
      <div className="mt-6 space-y-3 text-center text-[14px] text-ink-2">
        <Button tone="yuzu" className="w-full" onClick={onRegister} data-testid="go-register">
          第一次来？新同事登记
        </Button>
        <button type="button" onClick={onJoin} className="font-bold underline decoration-yuzu decoration-[3px] underline-offset-4">
          我有开通卡片
        </button>
        <p className="text-[13px] text-ink-3">忘了密码、换了手机，请找管理员「重新开通」</p>
      </div>
    </div>
  );
}

export function ClosedPage({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col items-center justify-center px-6 text-center">
      <Mascot mood="sleepy" className="h-44 w-auto" title="柚子在打盹" />
      <h1 className="mt-3 text-[22px] font-black">
        <span className="marker">饭堂还没开张</span>
      </h1>
      <p className="mt-2 text-[15px] text-ink-2">管理员还没在门店系统里打开「员工食堂」，过会儿再来看看吧。</p>
      <Button tone="ghost" className="mt-6" onClick={onRetry}>
        再看看
      </Button>
    </div>
  );
}

export function OfflinePage({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col items-center justify-center px-6 text-center">
      <Mascot mood="oops" pose="scratch" className="h-44 w-auto" title="柚子连不上" />
      <h1 className="mt-3 text-[22px] font-black">
        <span className="marker">连不上门店系统</span>
      </h1>
      <p className="mt-2 text-[15px] text-ink-2">第一次打开要联网登录一次；之后饭卡码没网也能亮。</p>
      <Button className="mt-6" onClick={onRetry}>
        再试一次
      </Button>
    </div>
  );
}
