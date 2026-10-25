import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { centsToInput, parseYuan } from '@shared/money';
import type { Catalog, RechargePlan, ServiceItem } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

type Editing = { kind: 'plan'; data: RechargePlan | null } | { kind: 'item'; data: ServiceItem | null } | null;

export function CatalogTab() {
  const catalog = useCatalog(true);
  const [editing, setEditing] = useState<Editing>(null);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          aside={
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'plan', data: null })}>
              新增套餐
            </Button>
          }
        >
          <span className="flex items-center gap-2">
            充值套餐 <PendingBadge title="实际充值与赠送方案待店主确认" />
          </span>
        </SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">实收金额计入本金，赠送部分计入赠金。停用后不再出现在充值页，历史单据不受影响。</p>
        <div className="mt-3 space-y-2">
          {catalog.isPending ? (
            <Skeleton className="h-32" />
          ) : catalog.data?.plans.length === 0 ? (
            <EmptyState art="leaf" title="还没有充值套餐" className="py-6" />
          ) : (
            catalog.data?.plans.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setEditing({ kind: 'plan', data: p })}
                className={cn('flex w-full items-center gap-3 rounded-lg border border-line px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-paper/60', !p.active && 'opacity-50')}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-bold">{p.name}</p>
                  {p.note && <p className="text-[12px] text-ink-3">{p.note}</p>}
                </div>
                {!p.active && <Badge>已停用</Badge>}
                <div className="text-right">
                  <Money cents={p.payAmount} className="text-[15px] font-bold" />
                  <p className="text-[12px] font-semibold text-yuzu-deep">
                    {p.bonusAmount ? (
                      <>
                        送 <Money cents={p.bonusAmount} />
                      </>
                    ) : (
                      <span className="text-ink-4">无赠送</span>
                    )}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle
          aside={
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'item', data: null })}>
              新增项目
            </Button>
          }
        >
          消费项目
        </SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">价格以这里为准；改价后，正在登记的消费会提示重新核对。</p>
        <div className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {catalog.isPending ? (
            <Skeleton className="m-3 h-32" />
          ) : catalog.data?.items.length === 0 ? (
            <EmptyState art="leaf" title="还没有消费项目" className="py-6" />
          ) : (
            catalog.data?.items.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => setEditing({ kind: 'item', data: i })}
                className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-paper/60', !i.active && 'opacity-50')}
              >
                <span className="w-12 shrink-0 text-[12px] font-semibold text-ink-3">{i.category || '其他'}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{i.name}</span>
                {!i.active && <Badge>已停用</Badge>}
                <Money cents={i.price} className="text-[14px] font-bold" />
              </button>
            ))
          )}
        </div>
      </Card>

      <CatalogDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function CatalogDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [bonus, setBonus] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [sort, setSort] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<Editing>(null);

  if (editing !== last) {
    setLast(editing);
    if (editing?.kind === 'plan') {
      const p = editing.data;
      setName(p?.name ?? '');
      setAmount(p ? centsToInput(p.payAmount) : '');
      setBonus(p ? centsToInput(p.bonusAmount) : '');
      setNote(p?.note ?? '');
      setActive(p?.active ?? true);
      setSort(String(p?.sortOrder ?? 0));
    } else if (editing?.kind === 'item') {
      const i = editing.data;
      setName(i?.name ?? '');
      setAmount(i ? centsToInput(i.price) : '');
      setCategory(i?.category ?? '');
      setActive(i?.active ?? true);
      setSort(String(i?.sortOrder ?? 0));
    }
    setError(null);
  }

  const save = async () => {
    const cents = parseYuan(amount);
    const bonusCents = bonus.trim() ? parseYuan(bonus) : 0;
    if (!name.trim()) return setError('请填写名称');
    if (!cents) return setError('请填写正确的金额');
    if (bonusCents === null) return setError('赠金格式不正确');
    setSaving(true);
    setError(null);
    try {
      const sortOrder = Number(sort) || 0;
      let result: Catalog;
      if (editing?.kind === 'plan') {
        const body = { name, payAmount: cents, bonusAmount: bonusCents, note, active, sortOrder };
        result = editing.data ? await api.put(`/api/plans/${editing.data.id}`, body) : await api.post('/api/plans', body);
      } else {
        const body = { name, price: cents, category, active, sortOrder };
        result = editing?.data ? await api.put(`/api/items/${editing.data.id}`, body) : await api.post('/api/items', body);
      }
      qc.setQueryData(['catalog', true], result);
      void qc.invalidateQueries({ queryKey: ['catalog', false] });
      toast({ tone: 'success', title: '已保存' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const isPlan = editing?.kind === 'plan';
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      title={`${editing?.data ? '编辑' : '新增'}${isPlan ? '充值套餐' : '消费项目'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="名称" htmlFor="c-name">
          <Input id="c-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={isPlan ? '实收金额' : '价格'} htmlFor="c-amount">
            <MoneyInput id="c-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          {isPlan ? (
            <Field label="赠金" htmlFor="c-bonus" hint="无赠送填 0">
              <MoneyInput id="c-bonus" value={bonus} onChange={(e) => setBonus(e.target.value)} />
            </Field>
          ) : (
            <Field label="分类" htmlFor="c-cat" hint="如 入场 / 护理 / 餐饮">
              <Input id="c-cat" value={category} maxLength={16} onChange={(e) => setCategory(e.target.value)} />
            </Field>
          )}
        </div>
        {isPlan && (
          <Field label="说明" htmlFor="c-note" hint="选填">
            <Input id="c-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="状态">
            <Segmented
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '启用' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
          <Field label="排序" htmlFor="c-sort" hint="数字越小越靠前">
            <Input id="c-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ''))} />
          </Field>
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
