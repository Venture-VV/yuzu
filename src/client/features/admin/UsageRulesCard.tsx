// 后台「客房 → 派对房等（开单即占用）」（D37 / D39，v0.7.19）：哪些业态的房间按「有开着的使用单」算使用中（默认派对房、宠物轰趴房、娱乐室，待确认）。
// 这些房间不派技师，在「客房 → 平面图」点房间开单、结束、撤单；客房、技师服务类的业态不能选（它们按入住单、钟单算占用）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_USAGE_BUSINESS_TYPES, type UsageRules } from '@shared/usages';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE, SPACE_BUSINESS_TYPES } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { Button, Card, Input, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';

const key = ['admin', 'usage-rules'] as const;
/** 可以选的业态：台账里的业态里，客房与技师服务类以外的 */
const CANDIDATES = SPACE_BUSINESS_TYPES.filter((t) => t !== ROOM_BUSINESS_TYPE && !isTechnicianBusinessType(t));

export function UsageRulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: key, queryFn: () => api.get<UsageRules>('/api/admin/usage-rules') });
  const [draft, setDraft] = useState<string[] | null>(null);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!rules.data) return <Skeleton className="h-28" />;
  const current = draft ?? rules.data.businessTypes;
  const options = [...new Set([...CANDIDATES, ...rules.data.businessTypes, ...current])];
  const editable = can('settings.manage');
  const isDefault = current.length === DEFAULT_USAGE_BUSINESS_TYPES.length && DEFAULT_USAGE_BUSINESS_TYPES.every((t) => current.includes(t));
  const toggle = (t: string) => setDraft(current.includes(t) ? current.filter((x) => x !== t) : [...current, t]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<UsageRules>('/api/admin/usage-rules', { businessTypes: current });
      qc.setQueryData(key, next);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['rooms'] });
      toast({ tone: 'success', title: '开单即占用的业态已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5" data-testid="usage-rules">
      <div className="flex items-center gap-2">
        <SectionTitle>派对房等：开单即占用</SectionTitle>
        {isDefault && <PendingBadge />}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">
        这些业态的房间不派技师，在「客房 → 平面图」点房间「开单」（选在店客人的手牌）即显示使用中；结束使用、使用人结账或撤单后空闲。场次费到前台挂到使用人的手牌账单上。
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((t) => (
          <label key={t} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[13px]">
            <input type="checkbox" checked={current.includes(t)} disabled={!editable || busy} onChange={() => toggle(t)} className="size-4 accent-pine" data-testid={`usage-type-${t}`} />
            {t}
          </label>
        ))}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={extra} maxLength={8} onChange={(e) => setExtra(e.target.value)} placeholder="台账里的其他业态名" className="w-44" aria-label="其他业态" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!extra.trim() || current.includes(extra.trim())}
            onClick={() => {
              setDraft([...current, extra.trim()]);
              setExtra('');
            }}
          >
            加上
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="primary" loading={busy} disabled={draft === null} onClick={save} data-testid="usage-rules-save">
            保存
          </Button>
        </div>
      )}
      {!editable && <p className="text-[12.5px] text-ink-3">只有店主能改</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}
