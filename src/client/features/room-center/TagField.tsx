// 登记表单里的手牌号（《浴族系统需求汇总》房态中心第 3 条：手牌号 NFC 或手输）：用发卡台那一块的 TagCardInput（经 VisitDialogs 的 InStoreTagInput，
// 刷到的牌要在店；为什么不直接引见那里的说明）——
// 读卡器刷到一张牌（桥报的、键盘式读卡器打进来的，都先按芯片号查绑定）把牌号带进来，随时能手输；读卡器状态那一行写着连没连上。
// 牌号齐了以后问服务端这张牌上的在店客人：带出会员与档阶、账单此刻多少、是不是已经登记在别的房间（docs/FRONTDESK_RISK_V8115.md 第 2.5 节）。

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { normalizeTagCode, TAG_CODE_PATTERN, ZONE_LABELS } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { RoomGuestLookup } from '@shared/room-center';
import { api, errorMessage } from '../../lib/api';
import { Badge, Field } from '../../components/ui';
import { InStoreTagInput } from '../frontdesk/VisitDialogs';

export interface TagFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 查到这张牌上的在店客人时给出来；牌号没填完、查不到时给 null */
  onGuest: (guest: RoomGuestLookup | null) => void;
  disabled?: boolean;
}

/** 输入停下来多久以后去查（边打边查会把「A0」「A02」都查一遍） */
const LOOKUP_DELAY_MS = 350;

export function TagField({ value, onChange, onGuest, disabled }: TagFieldProps) {
  const code = normalizeTagCode(value);
  const valid = TAG_CODE_PATTERN.test(code);
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSettled(valid ? code : ''), LOOKUP_DELAY_MS);
    return () => clearTimeout(t);
  }, [code, valid]);
  const q = useQuery({
    queryKey: ['room-center', 'guest', settled],
    queryFn: () => api.get<RoomGuestLookup>(`/api/room-center/guest?tag=${encodeURIComponent(settled)}`),
    enabled: settled !== '',
    staleTime: 0,
    retry: false,
  });
  const guest = settled !== '' && settled === code && q.data?.tagCode === code ? q.data : null;
  useEffect(() => {
    onGuest(guest);
    // 只在查到的客人变了的时候告诉表单
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest?.visitId, guest?.registeredIn]);
  const error =
    value && !valid
      ? '牌号格式不正确（例如 A023、1088）'
      : settled === code && q.isError
        ? errorMessage(q.error)
        : guest?.registeredIn
          ? `这位客人还登记在 ${guest.registeredIn}：先在那间房退房，或用「换房」换过来`
          : null;
  return (
    <Field label="手牌号" htmlFor="rc-tag" error={error} hint={guest ? undefined : '刷手牌或手输在店客人的牌号（客人要先在发卡台接待、领手牌）'}>
      <InStoreTagInput
        id="rc-tag"
        value={value}
        onChange={onChange}
        disabled={disabled}
        listening={!disabled}
        autoFocus
        placeholder="例如 A023"
        ariaLabel="手牌号"
        inputClassName="num text-[16px] font-bold"
        testId="rc-register-tag"
      />
      {guest && !guest.registeredIn && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2" data-testid="rc-register-guest">
          <span className="font-bold text-ink">{guest.guest}</span>
          <span className="text-ink-3">{ZONE_LABELS[guest.zone].title}</span>
          {guest.memberGradeLabel && <Badge tone="yuzu">{guest.memberGradeLabel}</Badge>}
          <span className="text-ink-3">账单已有 {formatYuan(guest.billAmount)}</span>
        </p>
      )}
    </Field>
  );
}
