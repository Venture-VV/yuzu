// 供应商门户（8.0.21，docs/FINANCE_V8021.md 第 7 节，CW-F）：员工这边发链接、看回复。
//   · 询价单详情「请供应商在线报价」：选一家、发报价链接，供应商在链接里报的价直接进报价列表（标「供应商链接」）。
//   · 采购单详情「供应商确认与发货」：发订单确认链接 → 看到承诺到货日；之后发发货预告链接 → 看到每批发了什么。
//   · 收货单按采购单收货时提示供应商的发货预告（DeliveryNoticesHint）。
// 链接原文只在生成时显示一次；重发时同一家、同种类的旧链接作废。正式服对公网开放前只能在内网 / Tailscale 里打开。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Send } from 'lucide-react';
import type { PurchaseOrder } from '@shared/purchasing';
import { formatQty } from '@shared/quantity';
import { SUPPLIER_LINK_LABELS, type DeliveryNotice, type PoSupplierPortal, type SupplierLinkKind, type SupplierLinkState } from '@shared/supplier-portal';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Select } from '../../components/ui';
import { useSuppliers } from '../inventory/queries';
import { pk } from './queries';

const linksKey = (what: 'event' | 'po', id: number) => [...pk.all, 'supplier-links', what, id] as const;

function linkState(l: SupplierLinkState) {
  if (l.voidedAt) return { tone: 'neutral' as const, text: '已作废' };
  if (l.expired) return { tone: 'neutral' as const, text: `已过期（${formatDateTime(l.expiresAt)}）` };
  if (l.replies) return { tone: 'pine' as const, text: `已回复 ${l.replies} 次 · ${l.lastReplyName ?? ''} · ${formatDateTime(l.lastReplyAt!)}` };
  return { tone: 'yuzu' as const, text: `等回复（${formatDateTime(l.expiresAt)} 前有效）` };
}

/** 刚生成的链接：只显示这一次 */
function FreshUrl({ url, onDone }: { url: string; onDone: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ tone: 'success', title: '链接已复制', body: '发给供应商（微信、短信都行），对方不用登录就能打开' });
    } catch {
      toast({ tone: 'info', title: '复制不了，请长按链接手动复制' });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper-2 px-2.5 py-1.5 text-[12.5px]">
      <span className="min-w-0 flex-1 break-all font-mono" data-testid="supplier-link-url">
        {url}
      </span>
      <Button size="sm" variant="secondary" onClick={() => void copy()}>
        复制
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        收起
      </Button>
      <span className="w-full text-ink-3">链接只显示这一次；丢了就重发一条（上一条会作废）。正式服对公网开放前，只有在门店内网或 Tailscale 里才打得开。</span>
    </div>
  );
}

function LinkList({ links, onVoid, busy }: { links: SupplierLinkState[]; onVoid: (id: number) => void; busy: boolean }) {
  const can = useCan();
  if (!links.length) return null;
  return (
    <ul className="divide-y divide-line/70 rounded-md border border-line text-[12.5px]" data-testid="supplier-links">
      {links.map((l) => {
        const st = linkState(l);
        return (
          <li key={l.id} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
            <Badge>{SUPPLIER_LINK_LABELS[l.kind]}</Badge>
            <span className="font-semibold">{l.supplierName}</span>
            <Badge tone={st.tone}>{st.text}</Badge>
            <span className="text-ink-3">
              {l.createdByName} · {formatDateTime(l.createdAt)}
            </span>
            <span className="flex-1" />
            {can('purchase.manage') && !l.voidedAt && !l.expired && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVoid(l.id)}>
                作废
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function useLinkActions(key: readonly unknown[]) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const create = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>(path, body);
      setUrl(`${window.location.origin}/s/${r.token}`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: number) => {
    setBusy(true);
    try {
      await api.post(`/api/purchase-supplier-links/${id}/void`, {});
      setUrl(null);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, url, setUrl, create, revoke };
}

/** 询价单详情：请供应商在线报价 */
export function SourcingSupplierLinks({ eventId, open }: { eventId: number; open: boolean }) {
  const can = useCan();
  const key = linksKey('event', eventId);
  const links = useQuery({ queryKey: key, queryFn: () => api.get<SupplierLinkState[]>(`/api/purchase-sourcing/${eventId}/supplier-links`) });
  const suppliers = useSuppliers(false, open && can('purchase.manage'));
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const a = useLinkActions(key);
  // 取不回来（也没有上一次的）不当成「没有链接」（Codex 审查 d72ea42 后补）
  if (!open && !links.data?.length && !(links.isError && !links.data)) return null;
  return (
    <Card className="space-y-2 p-4" data-testid="sourcing-supplier-links">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-bold">请供应商在线报价</h3>
        <span className="text-[12.5px] text-ink-3">发一条链接给供应商，对方不用登录、按行填单价就行；报的价直接进上面的报价（标「供应商链接」）。</span>
      </div>
      {open && can('purchase.manage') && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={supplierId ?? ''} fullWidth={false} className="h-9 w-56" onChange={(e) => setSupplierId(Number(e.target.value) || null)} aria-label="发给哪家供应商" data-testid="supplier-link-supplier">
            <option value="">选供应商</option>
            {(suppliers.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />} loading={a.busy} disabled={!supplierId} onClick={() => void a.create(`/api/purchase-sourcing/${eventId}/supplier-links`, { supplierId })} data-testid="supplier-link-create">
            生成报价链接
          </Button>
        </div>
      )}
      {a.url && <FreshUrl url={a.url} onDone={() => a.setUrl(null)} />}
      {links.isError && !links.data ? (
        <LoadFailed title="发出去的报价链接取不回来，请检查网络" onRetry={() => void links.refetch()} retrying={links.isFetching} testId="sourcing-links-error" />
      ) : (
        <LinkList links={links.data ?? []} busy={a.busy} onVoid={(id) => void a.revoke(id)} />
      )}
    </Card>
  );
}

const noticeLine = (n: DeliveryNotice, po: Pick<PurchaseOrder, 'lines'>) =>
  n.lines
    .map((x) => {
      const l = po.lines.find((y) => y.id === x.lineId);
      return l ? `${l.materialName} ${formatQty(x.qtyMilli)}${l.purchaseUnit}` : '';
    })
    .filter(Boolean)
    .join('、');

export const usePoSupplierPortal = (poId: number | null) =>
  useQuery({ queryKey: linksKey('po', poId ?? 0), queryFn: () => api.get<PoSupplierPortal>(`/api/purchase-orders/${poId}/supplier-portal`), enabled: !!poId });

/** 采购单详情：供应商确认与发货 */
export function PoSupplierCard({ po }: { po: PurchaseOrder }) {
  const can = useCan();
  const key = linksKey('po', po.id);
  const portal = usePoSupplierPortal(po.id);
  const a = useLinkActions(key);
  const d = portal.data;
  const live = po.status === 'approved' && !po.backfill;
  // 取不回来（也没有上一次的）：写明加载失败、可以重试，不把整块（含发链接的按钮、供应商的回复）藏起来（Codex 审查 d72ea42 后补）
  if (portal.isError && !d)
    return (
      <LoadFailed title="供应商确认与发货取不回来，请检查网络" onRetry={() => void portal.refetch()} retrying={portal.isFetching} testId="po-supplier-error">
        供应商有没有确认、报了哪几批发货，重试取回来以后再看。
      </LoadFailed>
    );
  if (!d || (!live && !d.links.length && !d.confirmation)) return null;
  const make = (kind: SupplierLinkKind) => void a.create(`/api/purchase-orders/${po.id}/supplier-links`, { kind });
  return (
    <section className="space-y-2 rounded-lg border border-line bg-card p-3" data-testid="po-supplier-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13.5px] font-bold">供应商确认与发货</h3>
        {d.confirmation ? (
          <span data-testid="po-supplier-confirmed">
            <Badge tone="pine">
              供应商已确认，承诺 {d.confirmation.promisedDate} 到 · {d.confirmation.replyName}
            </Badge>
          </span>
        ) : (
          <Badge tone="neutral">供应商还没确认</Badge>
        )}
        <span className="flex-1" />
        {live && can('purchase.manage') && (
          <Button size="sm" variant="secondary" icon={<Send className="size-3.5" />} loading={a.busy} onClick={() => make(d.confirmation ? 'delivery' : 'po_confirm')} data-testid="po-supplier-link-create">
            {d.confirmation ? '发发货预告链接' : '发订单确认链接'}
          </Button>
        )}
      </div>
      {d.confirmation?.note && <p className="text-[12.5px] text-ink-2">供应商留言：{d.confirmation.note}</p>}
      {a.url && <FreshUrl url={a.url} onDone={() => a.setUrl(null)} />}
      {d.notices.length > 0 && (
        <ul className="space-y-1 text-[12.5px]" data-testid="po-delivery-notices">
          {d.notices.map((n) => (
            <li key={n.id} className="rounded-md bg-paper-2 px-2.5 py-1.5">
              <span className="font-semibold">
                {n.shipDate} 发货{n.eta ? `，预计 ${n.eta} 到` : ''}
              </span>
              ：{noticeLine(n, po)}
              {n.trackingNo && <span className="ml-1 text-ink-3">物流单号 {n.trackingNo}</span>}
              {n.note && <span className="ml-1 text-ink-3">· {n.note}</span>}
              <span className="ml-1 text-ink-3">（{n.replyName}）</span>
            </li>
          ))}
        </ul>
      )}
      <LinkList links={d.links} busy={a.busy} onVoid={(id) => void a.revoke(id)} />
    </section>
  );
}

/** 按采购单收货时：供应商的发货预告 */
export function DeliveryNoticesHint({ po }: { po: PurchaseOrder }) {
  const portal = usePoSupplierPortal(po.id);
  const d = portal.data;
  if (portal.isError && !d)
    return (
      <LoadFailed title="供应商的发货预告取不回来，请检查网络" onRetry={() => void portal.refetch()} retrying={portal.isFetching} testId="delivery-notices-error">
        按实际到的数量收货；预告只是参考。
      </LoadFailed>
    );
  if (!d || (!d.notices.length && !d.confirmation)) return null;
  return (
    <Notice tone="info" title={d.notices.length ? `供应商预告了 ${d.notices.length} 批发货` : `供应商已确认，承诺 ${d.confirmation!.promisedDate} 到货`}>
      <ul className="space-y-0.5" data-testid="receipt-delivery-notices">
        {d.notices.map((n) => (
          <li key={n.id}>
            {n.shipDate} 发货{n.eta ? `、预计 ${n.eta} 到` : ''}：{noticeLine(n, po)}
            {n.trackingNo ? `（物流单号 ${n.trackingNo}）` : ''}
          </li>
        ))}
      </ul>
      按实际到的数量收货；预告只是参考。
    </Notice>
  );
}
