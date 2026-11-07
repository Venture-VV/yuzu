// 新同事登记（docs/CANTEEN.md 第 14 节，K12–K14）：开场动画的最后进门就是这里。一本手绘的登记簿，三格——用户名、手机号、密码，
// 不要注册口令（店主 2026-11-07）。登记好账号马上开好、直接进去（接着是新手教程）。
// 同一个手机号、同一个密码再点一次就是登录：回复没收到时原样再点不会登记两次。

import { useEffect, useState, type FormEvent } from 'react';
import { normalizePhone, normalizeUsername, PASSWORD_MIN, PHONE, usernameProblem, type CanteenMe, type RegisterInfo } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { IconKey, IconMe, IconPhone } from '../doodles';
import { ApiError, call, messageOf, NetworkError } from '../lib';
import { Button, cn, inputClass, Stamp } from '../ui';

type Field = 'username' | 'phone' | 'password';

export function RegisterPage({ onDone, onLogin }: { onDone: (me: CanteenMe) => void; onLogin: () => void }) {
  const [info, setInfo] = useState<RegisterInfo | null>(null);
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: Field | null; text: string } | null>(null);

  // 打开时问一下：开着自己登记没有（问不到的先当作开着，提交时门店系统会再说）
  useEffect(() => {
    let alive = true;
    call<RegisterInfo>('GET', '/api/canteen/register')
      .then((r) => alive && setInfo(r))
      .catch((e) => {
        if (!alive) return;
        setInfo({ open: true });
        if (e instanceof NetworkError) setError({ field: null, text: '连不上门店系统：联网后再登记' });
      });
    return () => {
      alive = false;
    };
  }, []);

  const check = (): { field: Field; text: string } | null => {
    const name = normalizeUsername(username);
    const bad = usernameProblem(name);
    if (bad) return { field: 'username', text: bad };
    if (!PHONE.test(normalizePhone(phone))) return { field: 'phone', text: '手机号写 11 位，例如 13800138000' };
    if (password.length < PASSWORD_MIN) return { field: 'password', text: `密码至少 ${PASSWORD_MIN} 位` };
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = check();
    if (bad) return setError(bad);
    setBusy(true);
    setError(null);
    try {
      onDone(await call<CanteenMe>('POST', '/api/canteen/register', { username: normalizeUsername(username), phone: normalizePhone(phone), password }));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'REGISTRATION_CLOSED') setInfo({ open: false });
        const field: Field | null = err.code === 'USERNAME_TAKEN' ? 'username' : err.code === 'PHONE_TAKEN' ? 'phone' : null;
        setError({ field, text: err.message });
      } else {
        // 回复没收到：账号可能已经开好了。原样再点一次就是登录，不会登记两次
        setError({ field: null, text: err instanceof NetworkError ? '网络不太好，不知道登记上没有：原样再点一次「登记好了」就行，不会登记两次' : messageOf(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  const closed = info && !info.open;
  const fieldError = (f: Field) => (error?.field === f ? error.text : null);

  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-[480px] flex-col px-5 pb-10" data-testid="register-page">
      <div className="mt-3 flex items-end gap-2">
        <Mascot pose={closed ? 'rest' : 'point'} mood={closed ? 'sleepy' : 'happy'} className="h-36 w-auto shrink-0" title="柚子" />
        <div className="sketch relative mb-6 rounded-[18px] bg-card px-4 py-3 text-[15px] leading-relaxed font-semibold shadow-[var(--shadow-sticker)]">
          {closed ? '饭堂现在没开放自己登记，找管理员问问吧～' : '欢迎进门！填好这三格，柚子就记住你啦～'}
          <span className="absolute -left-2 bottom-4 size-4 rotate-45 border-b-[1.6px] border-l-[1.6px] border-wood-ink/50 bg-card" aria-hidden />
        </div>
      </div>

      <div className="sketch relative overflow-hidden rounded-[22px] bg-card shadow-[var(--shadow-sticker)]">
        <div className="flex items-center justify-between bg-wood-deep px-5 py-2.5 text-white">
          <div>
            <h1 className="text-[20px] font-black tracking-wide">新同事登记</h1>
            <span className="text-[11px] font-semibold tracking-[0.2em] text-wood-5" style={{ fontFamily: 'var(--font-en)' }}>
              NEW FRIEND
            </span>
          </div>
          <Stamp tone="light">
            汤崎
            <br />
            新同事
          </Stamp>
        </div>
        {closed ? (
          <div className="space-y-4 p-5 text-[15px] text-ink-2">
            <p>员工食堂现在没开放自己登记。可以找管理员要一张开通卡片，或者用已有的账号登录。</p>
            <Button big className="w-full" onClick={onLogin}>
              去登录
            </Button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="relative space-y-1 px-5 pt-3 pb-5"
            style={{ backgroundImage: 'repeating-linear-gradient(transparent 0 47px, rgb(147 112 81 / .16) 47px 48px)', backgroundPosition: '0 30px' }}
            noValidate
          >
            <Line
              icon={<IconMe size={22} />}
              label="用户名"
              hint="同事们怎么叫你：登录用，扫码打卡时负责人也看到它"
              error={fieldError('username')}
            >
              <input
                className={inputClass}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如 林小雨"
                autoComplete="username"
                maxLength={16}
                aria-label="用户名"
              />
            </Line>
            <Line icon={<IconPhone size={22} />} label="手机号" hint="登录也可以用手机号" error={fieldError('phone')}>
              <input
                className={`${inputClass} num`}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="11 位手机号"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                aria-label="手机号"
              />
            </Line>
            <Line icon={<IconKey size={22} />} label="密码" hint={`至少 ${PASSWORD_MIN} 位，别用 123456 这种`} error={fieldError('password')}>
              <div className="relative">
                <input
                  className={`${inputClass} pr-16`}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-label="密码"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-xl px-2.5 py-1.5 text-[13px] font-bold text-wood-deep active:bg-cream-2"
                  aria-pressed={showPw}
                >
                  {showPw ? '藏起来' : '看一眼'}
                </button>
              </div>
            </Line>
            {error && error.field === null && (
              <p className="pt-2 text-[14px] font-bold text-danger" role="alert">
                {error.text}
              </p>
            )}
            <div className="pt-4">
              <Button type="submit" big className="w-full" disabled={busy || !info} data-testid="register-submit">
                {busy ? '正在登记…' : '登记好了，进门！'}
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className="mt-6 space-y-2 text-center text-[14px] text-ink-2">
        <button type="button" onClick={onLogin} className="font-bold underline decoration-yuzu decoration-[3px] underline-offset-4">
          已经有账号了？去登录
        </button>
        <p className="text-[12.5px] text-ink-3">没手机、不方便自己登记的同事，找管理员要一张开通卡片</p>
      </div>
    </div>
  );
}

function Line({ icon, label, hint, error, children }: { icon: React.ReactNode; label: string; hint: string; error: string | null; children: React.ReactNode }) {
  return (
    <label className="block pt-3">
      <span className="mb-1.5 flex items-center gap-1.5 text-[14px] font-black text-ink">
        <span className="text-wood">{icon}</span>
        {label}
      </span>
      {children}
      <span className={cn('mt-1 block text-[12.5px]', error ? 'font-bold text-danger' : 'text-ink-3')} role={error ? 'alert' : undefined}>
        {error ?? hint}
      </span>
    </label>
  );
}
