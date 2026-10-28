import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { GRANT_TTL_MINUTES, type GrantPurpose, type GrantRequest, type Granted } from '@shared/grants';
import { api, errorMessage } from '../lib/api';
import { Dialog } from './Overlay';
import { Button, Field, Input, Notice } from './ui';

const TEXT: Record<GrantPurpose, { title: string; who: string }> = {
  vip_tag: { title: '使用 VIP 柜', who: '请值班经理、店总或店主输入自己的账号密码' },
  over_limit: { title: '超过单笔上限', who: '请店总或店主输入自己的账号密码' },
};

/**
 * 当场授权：授权人在这里输入自己的账号密码，服务端签发 5 分钟内一次有效的授权。
 * 密码只随这一次授权请求发出，不保存、不进入「结果待确认」记录；业务请求只带授权编号。
 * 用于 VIP 柜（散客或等级不够的会员）与超过单笔上限的充值 / 消费。
 */
export function AuthorizeDialog<R extends GrantRequest>({
  open,
  request,
  lines,
  onClose,
  onGranted,
}: {
  open: boolean;
  /** 授权用途与对象（与业务请求一致，服务端核销时逐项核对） */
  request: R;
  /** 给授权人看的内容，例如「散客 · VIP 柜 9058（第 3 级）」「会员 沈知夏 · 充值实收 ¥600,000.00」 */
  lines: string[];
  onClose: () => void;
  onGranted: (grant: Granted<R>) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setUsername('');
    setPassword('');
    setError(null);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const grant = await api.post<Granted<R>>('/api/auth/authorize', { username: username.trim(), password, ...request });
      setPassword('');
      onGranted(grant);
    } catch (e) {
      setPassword('');
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-pine" /> 当场授权 · {TEXT[request.purpose].title}
        </span>
      }
      description={`${TEXT[request.purpose].who}。授权 ${GRANT_TTL_MINUTES} 分钟内有效，只能用于这一次办理。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!username.trim() || !password} onClick={submit} data-testid="authorize-submit">
            授权
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (username.trim() && password) void submit();
        }}
      >
        <ul className="space-y-1 rounded-lg border border-yuzu-deep/25 bg-yuzu-tint px-4 py-3 text-[13.5px] font-semibold text-ink">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="授权人账号" htmlFor="authorize-username">
            <Input id="authorize-username" data-autofocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="off" />
          </Field>
          <Field label="授权人密码" htmlFor="authorize-password">
            <Input id="authorize-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        {/* 回车提交 */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        {error && <Notice tone="error" title={error} />}
      </form>
    </Dialog>
  );
}
