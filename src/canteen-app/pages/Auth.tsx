// 开通与登录：扫开通卡片（或输入开通码）→ 打个招呼 → 设密码 → 开吃；以后用工号 + 密码登录（30 天不用再登录）。

import { useEffect, useState, type FormEvent } from 'react';
import { displayActivationCode, normalizeActivationCode, PASSWORD_MIN, type CanteenMe } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { call, messageOf } from '../lib';
import { Button, Card, Field, inputClass } from '../ui';

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
      <div className="mt-6 flex flex-col items-center text-center">
        <Mascot mood={who ? 'yum' : 'happy'} className="size-28 animate-float" />
        <h1 className="mt-2 text-[26px] font-black tracking-tight">{who ? `欢迎你，${who.name}！` : '开通柚子饭堂'}</h1>
        <p className="mt-1 text-[15px] text-ink-2">{who ? `工号 ${who.empNo} · 设一个自己的密码，就能开吃啦` : '输入开通卡片上的 8 位开通码'}</p>
      </div>
      <Card className="mt-6">
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
            {error && <p className="text-[14px] font-bold text-berry">{error}</p>}
            <Button type="submit" big className="w-full" disabled={busy}>
              {busy ? '正在查…' : '下一步'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex items-center gap-3 rounded-2xl bg-yuzu-soft px-4 py-3">
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
            {error && <p className="text-[14px] font-bold text-berry">{error}</p>}
            <Button type="submit" big className="w-full" disabled={busy}>
              {busy ? '正在开通…' : '开吃！🍚'}
            </Button>
          </form>
        )}
      </Card>
      <button type="button" onClick={onLogin} className="mt-6 text-center text-[14px] font-bold text-ink-2 underline decoration-yuzu decoration-2 underline-offset-4">
        已经开通过了？用工号登录
      </button>
    </div>
  );
}

export function LoginPage({ onDone, onJoin }: { onDone: (me: CanteenMe) => void; onJoin: () => void }) {
  const [empNo, setEmpNo] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await call<CanteenMe>('POST', '/api/canteen/login', { empNo, password: pw }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col px-5 pb-10">
      <div className="mt-8 flex flex-col items-center text-center">
        <Mascot className="size-28 animate-float" />
        <h1 className="mt-2 text-[28px] font-black tracking-tight">柚子饭堂</h1>
        <p className="mt-1 text-[15px] text-ink-2">今天吃什么？登录看看 👀</p>
      </div>
      <Card className="mt-6">
        <form onSubmit={submit} className="space-y-4">
          <Field label="工号">
            <input className={`${inputClass} uppercase`} value={empNo} onChange={(e) => setEmpNo(e.target.value)} autoCapitalize="characters" autoComplete="username" aria-label="工号" />
          </Field>
          <Field label="密码">
            <input className={inputClass} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" aria-label="密码" />
          </Field>
          {error && <p className="text-[14px] font-bold text-berry" role="alert">{error}</p>}
          <Button type="submit" big className="w-full" disabled={busy || !empNo || !pw}>
            {busy ? '正在登录…' : '登录'}
          </Button>
        </form>
      </Card>
      <div className="mt-6 space-y-2 text-center text-[14px] text-ink-2">
        <button type="button" onClick={onJoin} className="font-bold underline decoration-yuzu decoration-2 underline-offset-4">
          第一次用？我有开通码
        </button>
        <p className="text-[13px] text-ink-3">忘了密码、换了手机，请找管理员「重新开通」</p>
      </div>
    </div>
  );
}

export function ClosedPage({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col items-center justify-center px-6 text-center">
      <Mascot mood="sleepy" className="size-32" />
      <h1 className="mt-3 text-[22px] font-black">饭堂还没开张</h1>
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
      <Mascot mood="oops" className="size-32" />
      <h1 className="mt-3 text-[22px] font-black">连不上门店系统</h1>
      <p className="mt-2 text-[15px] text-ink-2">第一次打开要联网登录一次；之后饭卡码没网也能亮。</p>
      <Button className="mt-6" onClick={onRetry}>
        再试一次
      </Button>
    </div>
  );
}
