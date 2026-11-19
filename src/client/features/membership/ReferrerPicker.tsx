// 推荐人（8.1.15）：建档、编辑会员时找一位已有的会员。按姓名、手机号、会员号、实体卡号找（与会员查找同一个接口）。

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { maskPhone } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { api } from '../../lib/api';
import { IconButton, Input } from '../../components/ui';

export interface ReferrerChoice {
  id: number;
  memberNo: string;
  name: string;
}

export function ReferrerPicker({
  value,
  onChange,
  excludeId,
  invalid,
}: {
  value: ReferrerChoice | null;
  onChange: (v: ReferrerChoice | null) => void;
  /** 编辑时不能选会员自己 */
  excludeId?: number;
  invalid?: boolean;
}) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);
  const search = useQuery({
    queryKey: ['member-referrer-search', debounced],
    queryFn: () => api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(debounced)}&limit=6`),
    enabled: debounced.length >= 2 && !value,
  });
  if (value) {
    return (
      <div className="flex h-11 items-center gap-2 rounded-md border border-line-strong bg-card pr-1 pl-3.5" data-testid="member-referrer-chosen">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
          {value.name} <span className="num font-normal text-ink-3">{value.memberNo}</span>
        </span>
        <IconButton label="换一位推荐人" onClick={() => onChange(null)}>
          <X className="size-4" />
        </IconButton>
      </div>
    );
  }
  // 合并过的档案不能当推荐人（服务端也拒绝）
  const candidates = (search.data ?? []).filter((m) => m.id !== excludeId && m.mergedIntoId === null);
  return (
    <div>
      <Input
        id="m-referrer"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="输入推荐人的姓名、手机号或会员号"
        maxLength={32}
        invalid={invalid}
        autoComplete="off"
        data-testid="member-referrer-input"
      />
      {debounced.length >= 2 && (
        <ul className="mt-1.5 overflow-hidden rounded-md border border-line" data-testid="member-referrer-results">
          {search.isPending ? (
            <li className="px-3 py-2.5 text-[13px] text-ink-3">查找中…</li>
          ) : search.isError ? (
            <li className="px-3 py-2.5 text-[13px] font-medium text-clay">推荐人没有查出来，稍后再试</li>
          ) : candidates.length === 0 ? (
            <li className="px-3 py-2.5 text-[13px] text-ink-3">没有找到这位会员</li>
          ) : (
            candidates.map((m) => (
              <li key={m.id} className="border-t border-line first:border-t-0">
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-2"
                  onClick={() => {
                    onChange({ id: m.id, memberNo: m.memberNo, name: m.name });
                    setTerm('');
                  }}
                  data-testid={`member-referrer-option-${m.id}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{m.name}</span>
                  <span className="num shrink-0 text-[12.5px] text-ink-3">
                    {m.memberNo} · {maskPhone(m.phone)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
