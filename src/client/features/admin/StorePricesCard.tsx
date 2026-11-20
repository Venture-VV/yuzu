// 本店价（8.0.22，docs/MULTISTORE_V8022.md 第 10 节）：价目表全公司一套；第二家店可以对某个项目的某一档单独定价，
// 挂账、点单按本店价，没设的按全公司的。只在第二家店里打开时有这个页签。
// 8.1.17（BW-11，docs/FRONTDESK_V8117.md 第 6 节）：改本店价要写原因（快捷原因与菜品改价同一份）；菜品的改价进「菜品管理」的改价记录（能按门店筛）。
// 带上打开时看到的本店价，别人刚改过的拒绝（STORE_PRICE_STALE，刷新后再改）；改成的价与现在一样的什么都不做。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatYuan, parseYuan } from '@shared/money';
import { PRICE_TIER_LABELS, type PriceTier } from '@shared/catalog';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useReasons, useSession } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { ReasonDialog } from '../../components/ReasonDialog';
import { Button, Card, Input, Skeleton } from '../../components/ui';

interface Row {
  itemId: number;
  name: string;
  category: string;
  active: boolean;
  tier: PriceTier;
  price: number;
  storePrice: number | null;
}

export function StorePricesCard() {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** 要改的那一档（写原因的弹窗开着时） */
  const [asking, setAsking] = useState<{ row: Row; price: number | null } | null>(null);
  const reasons = useReasons('dishPriceReasons');
  const rows = useQuery({ queryKey: ['catalog', 'store-prices'], queryFn: () => api.get<Row[]>('/api/admin/catalog/store-prices') });
  const shown = useMemo(() => (rows.data ?? []).filter((r) => !q.trim() || r.name.includes(q.trim()) || r.category.includes(q.trim())), [rows.data, q]);
  const ask = (r: Row, clear = false) => {
    const key = `${r.itemId}:${r.tier}`;
    const price = clear ? null : parseYuan(draft[key] ?? '');
    if (!clear && (price === null || price <= 0)) {
      toast({ tone: 'error', title: '请填写大于 0 的金额' });
      return;
    }
    setAsking({ row: r, price });
  };
  const save = async (reason: string) => {
    if (!asking) return;
    const { row: r, price } = asking;
    const key = `${r.itemId}:${r.tier}`;
    setBusy(key);
    try {
      await api.put('/api/admin/catalog/store-prices', { itemId: r.itemId, tier: r.tier, price, expected: r.storePrice, reason });
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      await qc.invalidateQueries({ queryKey: ['dining', 'dishes', 'price-changes'] });
      setDraft((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      setAsking(null);
      toast({ tone: 'success', title: price === null ? `「${r.name}」按全公司的价` : `「${r.name}」本店价已保存`, body: '改前改后、原因记进了改价记录' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      if (e instanceof ApiError && e.code === 'STORE_PRICE_STALE') {
        setAsking(null);
        void rows.refetch();
      }
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="p-5" data-testid="store-prices">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-[16px] font-bold">{session.store.name}的本店价</h2>
        <Input className="h-9 w-48" placeholder="搜项目或分类" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜项目" />
      </div>
      <p className="mb-3 text-[13px] text-ink-3">价目表全公司一套；这里单独定了价的档，这家店挂账、点单按本店价，没定的按全公司的。改全公司的价目请回本店。</p>
      {rows.isPending ? (
        <Skeleton className="h-40" />
      ) : rows.isError && !rows.data ? (
        <LoadFailed title="价目取不回来，请检查网络" onRetry={() => void rows.refetch()} retrying={rows.isFetching} testId="store-prices-error" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[14px]">
            <thead className="text-left text-[12.5px] text-ink-3">
              <tr>
                <th className="py-2 pr-3 font-medium">项目</th>
                <th className="py-2 pr-3 font-medium">档</th>
                <th className="py-2 pr-3 text-right font-medium">全公司价</th>
                <th className="py-2 pr-3 font-medium">本店价</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const key = `${r.itemId}:${r.tier}`;
                return (
                  <tr key={key} className="border-t border-line" data-testid={`store-price-${r.itemId}-${r.tier}`}>
                    <td className="py-2 pr-3">
                      {r.name}
                      <span className="ml-1.5 text-[12px] text-ink-3">{r.category}</span>
                      {!r.active && <span className="ml-1.5 text-[12px] text-ink-3">（已停用）</span>}
                    </td>
                    <td className="py-2 pr-3 text-ink-2">{PRICE_TIER_LABELS[r.tier]}</td>
                    <td className="num py-2 pr-3 text-right">{formatYuan(r.price)}</td>
                    <td className="py-2 pr-3">
                      <Input
                        className="h-9 w-28"
                        inputMode="decimal"
                        placeholder={r.storePrice === null ? '同全公司' : ''}
                        value={draft[key] ?? (r.storePrice === null ? '' : String(r.storePrice / 100))}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                        aria-label={`${r.name}${PRICE_TIER_LABELS[r.tier]}的本店价`}
                      />
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {draft[key] !== undefined && (
                        <Button size="sm" variant="primary" loading={busy === key} onClick={() => ask(r)} data-testid={`store-price-save-${r.itemId}-${r.tier}`}>
                          保存
                        </Button>
                      )}
                      {r.storePrice !== null && draft[key] === undefined && (
                        <Button size="sm" variant="ghost" loading={busy === key} onClick={() => ask(r, true)} data-testid={`store-price-clear-${r.itemId}-${r.tier}`}>
                          按全公司的
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog
        open={!!asking}
        busy={!!busy}
        title={asking ? `改本店价 · ${asking.row.name}（${PRICE_TIER_LABELS[asking.row.tier]}）` : '改本店价'}
        description={
          asking
            ? `${asking.row.storePrice === null ? `同全公司（${formatYuan(asking.row.price)}）` : formatYuan(asking.row.storePrice)} → ${asking.price === null ? `同全公司（${formatYuan(asking.row.price)}）` : formatYuan(asking.price)}。要写原因，记进改价记录（哪家店、改前改后、谁、几点）。`
            : undefined
        }
        label="改价的原因"
        confirmLabel="确认改价"
        reasons={reasons}
        testId="store-price"
        onClose={() => setAsking(null)}
        onConfirm={(reason) => void save(reason)}
      />
    </Card>
  );
}
