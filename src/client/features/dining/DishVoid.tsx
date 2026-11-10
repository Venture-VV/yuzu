// 退菜（8.0.8，B02「改单、退单按金额分级」）：
//   · 小额（单条 ≤ 餐饮设置的上限，默认 ¥50）：写原因直接退；
//   · 超过的：本人 15 分钟内、有更正权限的照旧直接退；其余请值班经理及以上「当场授权」——授权人在弹窗里看得到菜名、金额与原因，
//     输自己的账号密码，授权绑定这一条与金额，5 分钟内有效、只能用一次；
//   · 改单：退掉这道（同样分级）后把它放回购物车，改数量或换菜再下单。
// 服务端照同样的规则核对（判断不一致时以服务端为准：提示要授权就转到授权）。

import { useState } from 'react';
import { formatYuan } from '@shared/money';
import { isSmallDishVoid } from '@shared/dining';
import type { LineVoidGrantRequest } from '@shared/grants';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice } from '../../components/ui';
import { useDiningMenu } from './queries';

export interface VoidableDish {
  billLineId: number;
  name: string;
  quantity: number;
  amount: number;
  postedBy: number;
  postedAt: string;
  /** 已经出餐了的提示 */
  served?: boolean;
}

export function DishVoidDialog({
  dish,
  url,
  mode = 'void',
  onClose,
  onDone,
}: {
  dish: VoidableDish | null;
  /** 手牌客人的走前台作废（/api/frontdesk/lines/:id/void），桌台的走桌台接口 */
  url: string;
  /** void 退菜 / modify 改单（退掉后放回购物车） */
  mode?: 'void' | 'modify';
  onClose: () => void;
  /** result 是退菜接口的返回（前台作废返回这位客人的账单） */
  onDone: (dish: VoidableDish, result: unknown) => void;
}) {
  const session = useSession();
  const can = useCan();
  const menu = useDiningMenu();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceGrant, setForceGrant] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  useResetOnOpen(!!dish, () => {
    setReason(mode === 'modify' ? '改单' : '');
    setError(null);
    setForceGrant(false);
    setAuthorizing(false);
  });
  if (!dish) return null;

  const rules = menu.data?.rules;
  const limit = rules?.voidFreeCents ?? 0;
  const small = !!rules && isSmallDishVoid(rules, { source: 'dining', amount: dish.amount });
  const selfMinutes = menu.data?.selfVoidMinutes ?? 15;
  const mine = dish.postedBy === session.staff.id && (Date.now() - new Date(dish.postedAt).getTime()) / 60_000 <= selfMinutes;
  // 规则还没取到时先按「直接退」：服务端照同样的规则核对，要授权时提示后转到授权
  const direct = !forceGrant && (!rules || small || can('frontdesk.correct') || mine);
  const tierText = !rules
    ? '退菜按金额分级：小额直接退，超过的请值班经理及以上当场授权'
    : small
    ? `小额（不超过 ${formatYuan(limit)}）：写原因直接退`
    : can('frontdesk.correct')
      ? '你的岗位可以直接退'
      : mine
        ? `你点的、${selfMinutes} 分钟内：直接退`
        : `超过${limit > 0 ? `小额上限 ${formatYuan(limit)}` : '上限'}：请值班经理及以上当场授权`;
  const ok = reason.trim().length >= 2;

  const send = async (grantId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<unknown>(url, { reason: reason.trim(), ...(grantId ? { grantId } : {}) });
      onDone(dish, result);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VOID_NEEDS_GRANT') {
        setForceGrant(true);
        setError(`${e.message}（点「请经理授权」）`);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const request: LineVoidGrantRequest = { purpose: 'line_void', scope: { lineId: dish.billLineId, amount: dish.amount, name: dish.name, reason: reason.trim() } };
  return (
    <>
      <Dialog
        open={!authorizing}
        onClose={busy ? () => {} : onClose}
        title={`${mode === 'modify' ? '改单' : '退菜'} · ${dish.name} × ${dish.quantity}`}
        description={
          mode === 'modify'
            ? '先退掉这道（作废这条挂账，留痕），再把它放回购物车，改数量或换菜后重新下单。'
            : `${dish.served ? '这道菜已经出餐了。' : ''}退菜就是作废这条挂账（留痕，不收这道菜的钱），厨房屏上显示「已退」；估清的菜按原份数加回。`
        }
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            {direct ? (
              <Button variant="danger" disabled={!ok} loading={busy} onClick={() => void send()} data-testid="dish-void-confirm">
                {mode === 'modify' ? '退掉并改单' : '确认退菜'}
              </Button>
            ) : (
              <Button variant="primary" disabled={!ok} onClick={() => setAuthorizing(true)} data-testid="dish-void-authorize">
                请经理授权
              </Button>
            )}
          </>
        }
      >
        <div className="mb-3 flex items-center justify-between rounded-lg bg-paper-2 px-3 py-2 text-[13.5px]">
          <span className="font-semibold">
            {dish.name} × {dish.quantity}
          </span>
          <span className="font-bold">{formatYuan(dish.amount)}</span>
        </div>
        <p className="mb-3 text-[12.5px] text-ink-3" data-testid="dish-void-tier">
          {forceGrant ? '请值班经理及以上当场授权' : tierText}
        </p>
        <Field label="原因" htmlFor="reason-text" hint="至少 2 个字，记在明细与退菜记录里">
          <Input id="reason-text" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如：客人点错了、等太久不要了" data-autofocus data-testid="dish-void-reason" />
        </Field>
        {error && <Notice tone="error" title={error} className="mt-3" />}
      </Dialog>
      <AuthorizeDialog
        open={authorizing}
        request={request}
        lines={[`${dish.name} × ${dish.quantity}`, `金额 ${formatYuan(dish.amount)}`, `原因：${reason.trim()}`]}
        onClose={() => setAuthorizing(false)}
        onGranted={(g) => {
          setAuthorizing(false);
          void send(g.grantId);
        }}
      />
    </>
  );
}
