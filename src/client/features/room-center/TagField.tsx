// 登记表单里的手牌号（《浴族系统需求汇总》房态中心第 3 条：手牌号 NFC 或手输）。
// 现在这一个是手输牌号：输成完整的牌号以后问服务端这张牌上的在店客人——带出会员与档阶、账单此刻多少、是不是已经登记在别的房间。
// 单独做成一个小部件，登记表单只认它的 value / onChange / onGuest：前台那一块做好「刷卡带出牌号」以后，
// 换成带读卡的那一个（读卡器刷到的牌号从 onChange 填进来，其余照旧），登记表单不用改。

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { normalizeTagCode, TAG_CODE_PATTERN, ZONE_LABELS } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { RoomGuestLookup } from '@shared/room-center';
import { api, errorMessage } from '../../lib/api';
import { Badge, Field, Input } from '../../components/ui';

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
  const error = value && !valid ? '牌号格式不正确（例如 A023、1088）' : settled === code && q.isError ? errorMessage(q.error) : guest?.registeredIn ? `这位客人还登记在 ${guest.registeredIn}：先在那间房退房，或用「换房」换过来` : null;
  return (
    <Field label="手牌号" htmlFor="rc-tag" error={error} hint={guest ? undefined : '输入在店客人的手牌号（客人要先在发卡台接待、领手牌）'}>
      <Input
        id="rc-tag"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        disabled={disabled}
        className="num text-[16px] font-bold"
        placeholder="例如 A023"
        autoComplete="off"
        data-autofocus
        data-testid="rc-register-tag"
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
