// 后台「价目与套餐 → 次卡」（v0.7.28 ④，N5 待确认）：卡种——能抵哪些价目项目、哪些票种，几次、售价、有效期。
// 改卡种只影响之后卖的卡（卖出去的卡记下当时的条件）；停售的卡种不再出现在售卡里。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { countCardTermsText, DEFAULT_COUNT_CARD_VALID_DAYS, type CountCardType } from '@shared/count-cards';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { useTicketTypes } from '../frontdesk/queries';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';

const key = ['count-card-types'] as const;

export function CountCardTypesCard() {
  const types = useQuery({ queryKey: key, queryFn: () => api.get<CountCardType[]>('/api/count-card-types') });
  const [editing, setEditing] = useState<CountCardType | 'new' | null>(null);
  return (
    <Card className="p-5 lg:col-span-2" data-testid="count-card-types">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="count-card-type-new">
            新增卡种
          </Button>
        }
      >
        <span className="flex items-center gap-2">
          次卡 <PendingBadge title="N5：售卡是收款不是营业额，用一次按项目价算营业额；默认有效期 365 天（待店主确认）" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">卖给会员、结账时按次抵扣（一次一份）。改卡种只影响之后卖的卡；停售后不再出现在售卡里。</p>
      <div className="mt-3 space-y-2">
        {types.isPending ? (
          <Skeleton className="h-16" />
        ) : (types.data ?? []).length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有卡种。</p>
        ) : (
          types.data!.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setEditing(t)}
              className={cn('flex w-full items-center gap-3 rounded-lg border border-line px-4 py-3 text-left hover:border-line-strong hover:bg-paper/60', !t.active && 'opacity-50')}
              data-testid={`count-card-type-${t.id}`}
            >
              <span className="font-semibold">{t.name}</span>
              {!t.active && <Badge>停售</Badge>}
              <span className="text-[13px] text-ink-2">{countCardTermsText(t, formatYuan)}</span>
              <span className="ml-auto text-[12px] text-ink-3">已卖 {t.soldCount} 张</span>
            </button>
          ))
        )}
      </div>
      {editing && <TypeDialog editing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TypeDialog({ editing, onClose }: { editing: CountCardType | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog(true);
  const tickets = useTicketTypes(true);
  const [name, setName] = useState(editing?.name ?? '');
  const [itemIds, setItemIds] = useState<number[]>(editing?.itemIds ?? []);
  const [ticketTypeIds, setTicketTypeIds] = useState<number[]>(editing?.ticketTypeIds ?? []);
  const [uses, setUses] = useState(String(editing?.uses ?? 10));
  const [price, setPrice] = useState(editing ? centsToInput(editing.price) : '');
  const [validDays, setValidDays] = useState(editing ? (editing.validDays === null ? '' : String(editing.validDays)) : String(DEFAULT_COUNT_CARD_VALID_DAYS));
  const [active, setActive] = useState(editing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        itemIds,
        ticketTypeIds,
        uses: Number(uses),
        price: parseYuan(price) ?? 0,
        validDays: validDays.trim() === '' ? null : Number(validDays),
        active,
        ...(editing ? { expectedVersion: editing.version } : {}),
      };
      const next = editing ? await api.put<CountCardType[]>(`/api/admin/count-card-types/${editing.id}`, body) : await api.post<CountCardType[]>('/api/admin/count-card-types', body);
      qc.setQueryData(key, next);
      toast({ tone: 'success', title: editing ? '卡种已保存' : '卡种已添加' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const items = (catalog.data?.items ?? []).filter((i) => i.active || itemIds.includes(i.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `卡种：${editing.name}` : '新增卡种'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={busy || !name.trim() || itemIds.length + ticketTypeIds.length === 0} data-testid="count-card-type-save">
            保存
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field label="名称" htmlFor="cct-name">
          <Input id="cct-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="例如 足疗 10 次卡" data-testid="count-card-type-name" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="次数" htmlFor="cct-uses">
            <Input id="cct-uses" type="number" min={1} max={100} value={uses} onChange={(e) => setUses(e.target.value)} data-testid="count-card-type-uses" />
          </Field>
          <Field label="售价" htmlFor="cct-price">
            <MoneyInput id="cct-price" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="count-card-type-price" />
          </Field>
          <Field label="有效期（天，空为长期）" htmlFor="cct-days">
            <Input id="cct-days" type="number" min={1} max={3650} value={validDays} onChange={(e) => setValidDays(e.target.value)} />
          </Field>
        </div>
        <Field label="能抵的项目（一次抵一份）">
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {items.map((i) => (
              <label key={i.id} className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12.5px]">
                <input type="checkbox" checked={itemIds.includes(i.id)} onChange={() => setItemIds((x) => toggle(x, i.id))} className="size-3.5 accent-pine" data-testid={`count-card-type-item-${i.id}`} />
                {i.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="能抵的门票（一位客人一份）">
          <div className="flex flex-wrap gap-1.5">
            {(tickets.data ?? []).map((t) => (
              <label key={t.id} className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12.5px]">
                <input type="checkbox" checked={ticketTypeIds.includes(t.id)} onChange={() => setTicketTypeIds((x) => toggle(x, t.id))} className="size-3.5 accent-pine" />
                {t.name}
              </label>
            ))}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-pine" />
          在售
        </label>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
