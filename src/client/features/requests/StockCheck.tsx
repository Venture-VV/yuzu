// 8.1.10 核库转领用（docs/ERP_V8110.md 第 2 节）：
//   · 需求行上写总仓现在的结存（部门也看得到这几样，CK9、CK17）与核库结果（领用、替代、转采购）；
//   · 库管的「核库」对话框：逐行选领用（填数量）、替代（选总仓有货的物料、按它的库存单位填数量）或转采购，
//     点「核库完成」时领用的行一起开一张部门领料单、马上生效（CK14）；
//   · 部门答复替代：同意按提议领用，总仓不够了这一行改成转采购；不用就照原来买（CK15）。
// 两样都带操作编号，走「结果待确认」（sendErpOp + 页面顶上的 ErpPendingPanel）。

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Check, PackageSearch, Warehouse, X } from 'lucide-react';
import { formatQty, parseQty } from '@shared/quantity';
import type { PurchaseRequest, RequestLine, StockCheckLineInput, SubstituteAnswerResult } from '@shared/requests';
import { errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Input, Notice, Segmented, Select } from '../../components/ui';
import { useInvalidateRequests, useStockMaterials } from './queries';

/** 需求行上的总仓结存与核库结果 */
export function LineStockInfo({ l, request }: { l: RequestLine; request: PurchaseRequest }) {
  const can = useCan();
  const s = l.stock;
  const c = l.centralStock;
  const showCentral = !!c && !s && (request.status === 'submitted' || request.status === 'returned');
  if (!s && !showCentral) return null;
  return (
    <div className="space-y-1 text-[12px]" data-testid={`request-line-stock-${l.lineNo}`}>
      {showCentral && c && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-ink-3" data-testid={`request-line-central-${l.lineNo}`}>
          <Warehouse className="size-3.5 shrink-0" />
          总仓现有{' '}
          <span className={cn('num font-semibold', c.stockMilli > 0 ? 'text-pine' : 'text-ink-3')}>
            {formatQty(Math.max(0, c.stockMilli))} {c.inventoryUnit}
          </span>
          {c.convertible && c.lineQtyMilli !== null && l.unit !== c.inventoryUnit && (
            <span className="num">
              （约 {formatQty(c.lineQtyMilli)} {l.unit}）
            </span>
          )}
        </p>
      )}
      {s && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {s.decision === 'issue' && (
            <>
              <Badge tone="pine">{s.issuedQtyMilli >= l.qtyMilli ? '整行领用' : '部分领用'}</Badge>
              <span className="num text-ink-2">
                已领 {formatQty(s.issuedQtyMilli)} {l.unit}
                {s.issuedQtyMilli < l.qtyMilli && `，剩下 ${formatQty(l.qtyMilli - s.issuedQtyMilli)} ${l.unit} 转采购`}
              </span>
            </>
          )}
          {s.decision === 'substitute' && s.substitute && (
            <>
              <Badge tone={s.substitute.state === 'accepted' ? 'pine' : s.substitute.state === 'pending' ? 'yuzu' : 'neutral'}>
                {
                  {
                    pending: request.status === 'submitted' ? '替代待部门确认' : '替代没答复',
                    accepted: '用替代品',
                    declined: '不用替代，照原来买',
                    expired: '替代没答复，照原来买',
                    failed: '替代没领成，照原来买',
                  }[s.substitute.state]
                }
              </Badge>
              <span className="text-ink-2">
                库管提议用「{s.substitute.materialName}」×{' '}
                <span className="num">
                  {formatQty(s.substitute.qtyMilli)} {s.substitute.unit}
                </span>
              </span>
            </>
          )}
          {s.decision === 'purchase' && <Badge tone="neutral">转采购</Badge>}
          {s.issueDoc &&
            (can('inventory.read') ? (
              <Link to={`/inventory/docs?doc=${s.issueDoc.id}`} className="num font-semibold text-lake hover:underline">
                {s.issueDoc.docNo}
              </Link>
            ) : (
              <span className="num font-semibold">{s.issueDoc.docNo}</span>
            ))}
          {s.issueDoc?.voided && <span className="font-semibold text-clay">领料单已冲销，这一行没有领用</span>}
          <span className="text-ink-3">· {s.decidedByName}</span>
        </p>
      )}
    </div>
  );
}

/** 部门答复替代：同意 / 不用 */
export function SubstituteAnswer({ request, l }: { request: PurchaseRequest; l: RequestLine }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateRequests();
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!request.canAnswerSubstitute || l.stock?.decision !== 'substitute' || l.stock.substitute?.state !== 'pending') return null;
  const sub = l.stock.substitute;
  const answer = async (accept: boolean) => {
    setBusy(accept ? 'yes' : 'no');
    setError(null);
    const key = uuid();
    try {
      const r = await sendErpOp<SubstituteAnswerResult>({
        key,
        type: 'request_stock',
        url: `/api/erp/requests/${request.id}/lines/${l.id}/substitute`,
        body: { clientKey: key, accept },
        summary: `${request.docNo} 第 ${l.lineNo} 行 · ${accept ? '同意替代' : '不用替代'}`,
        staffName: session.staff.displayName,
      });
      if (r.outcome === 'failed') toast({ tone: 'error', title: '替代没领成', body: r.message ?? '总仓不够了，这一行改成转采购' });
      else toast({ tone: 'success', title: r.outcome === 'accepted' ? '已同意替代，领料单已生效' : '不用替代，这一行照原来买' });
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'info', title: '结果待确认', body: '请在页面顶上「结果待确认」里查回或重新提交' });
      else setError(errorMessage(e));
    } finally {
      await invalidate();
      setBusy(null);
    }
  };
  return (
    <div className="space-y-1.5 rounded-md border border-yuzu/40 bg-yuzu-tint/40 px-3 py-2" data-testid={`request-substitute-${l.lineNo}`}>
      <p className="text-[12.5px] text-ink-2">
        库管提议用「<span className="font-semibold">{sub.materialName}</span>」×{' '}
        <span className="num font-semibold">
          {formatQty(sub.qtyMilli)} {sub.unit}
        </span>{' '}
        代替「{l.name}」。同意就从总仓领用；不用就照原来买。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon={<X className="size-4" />}
          loading={busy === 'no'}
          disabled={busy !== null}
          onClick={() => void answer(false)}
          data-testid={`request-substitute-no-${l.lineNo}`}
        >
          不用，照原来买
        </Button>
        <Button size="sm" icon={<Check className="size-4" />} loading={busy === 'yes'} disabled={busy !== null} onClick={() => void answer(true)} data-testid={`request-substitute-yes-${l.lineNo}`}>
          同意替代
        </Button>
      </div>
      {error && <Notice tone="error" title={error} />}
    </div>
  );
}

type Choice = 'issue' | 'substitute' | 'purchase';
interface Draft {
  choice: Choice;
  qty: string;
  materialId: string;
  subQty: string;
}

/** 库管核库的对话框 */
export function StockCheckDialog({ request, onClose }: { request: PurchaseRequest; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateRequests();
  const materials = useStockMaterials(true);
  const lines = request.lines.filter((l) => l.materialId !== null);
  const fresh = request.lines.filter((l) => l.materialId === null);
  // 默认：总仓有货的领用（能换算的填「申请数量」与「结存」里小的那个），没货的转采购
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() =>
    Object.fromEntries(
      lines.map((l) => {
        const c = l.centralStock;
        const has = !!c && c.stockMilli > 0;
        const qty = has && c.convertible && c.lineQtyMilli !== null ? Math.min(l.qtyMilli, c.lineQtyMilli) : null;
        return [l.id, { choice: has ? 'issue' : 'purchase', qty: qty !== null && qty > 0 ? formatQty(qty).replace(/,/g, '') : '', materialId: '', subQty: '' } satisfies Draft];
      }),
    ),
  );
  const [key] = useState(() => uuid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (id: number, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));
  const matMap = useMemo(() => new Map((materials.data ?? []).map((m) => [m.id, m])), [materials.data]);

  const build = (): StockCheckLineInput[] | string => {
    const out: StockCheckLineInput[] = [];
    for (const l of lines) {
      const d = drafts[l.id]!;
      const c = l.centralStock;
      if (d.choice === 'purchase') out.push({ lineId: l.id, decision: 'purchase' });
      else if (d.choice === 'issue') {
        const q = parseQty(d.qty, 3);
        if (q === null || q <= 0) return `第 ${l.lineNo} 行「${l.name}」请填领用的数量`;
        if (c?.convertible && q > l.qtyMilli) return `第 ${l.lineNo} 行最多领 ${formatQty(l.qtyMilli)} ${l.unit}`;
        out.push({ lineId: l.id, decision: 'issue', qtyMilli: q });
      } else {
        const mid = Number(d.materialId);
        const m = matMap.get(mid);
        if (!m) return `第 ${l.lineNo} 行「${l.name}」请选替代的物料`;
        const q = parseQty(d.subQty, m.decimals);
        if (q === null || q <= 0) return `第 ${l.lineNo} 行请填替代品的数量（${m.inventoryUnit}，最多 ${m.decimals} 位小数）`;
        out.push({ lineId: l.id, decision: 'substitute', materialId: mid, qtyMilli: q });
      }
    }
    return out;
  };

  const submit = async () => {
    const built = build();
    if (typeof built === 'string') return setError(built);
    setBusy(true);
    setError(null);
    try {
      await sendErpOp<{ request: PurchaseRequest }>({
        key,
        type: 'request_stock',
        url: `/api/erp/requests/${request.id}/stock-check`,
        body: { clientKey: key, lines: built },
        summary: `${request.docNo} 核库`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({ tone: 'success', title: '核库完成', body: request.docNo });
      onClose();
    } catch (e) {
      await invalidate();
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '结果待确认', body: '请在页面顶上「结果待确认」里查回或重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={`核库 · ${request.docNo}`}
      description="逐行看总仓有没有：有的领用（开部门领料单、马上生效，部门之后签收），可以只领一部分、剩下的转采购；有别的能替代的提议替代品，等部门确认；没有的转采购。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button icon={<PackageSearch className="size-4" />} onClick={() => void submit()} loading={busy} data-testid="stock-check-submit">
            核库完成
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="stock-check-dialog">
        <ul className="space-y-3">
          {lines.map((l) => {
            const d = drafts[l.id]!;
            const c = l.centralStock;
            const sub = d.materialId ? matMap.get(Number(d.materialId)) : undefined;
            return (
              <li key={l.id} className="min-w-0 space-y-2 rounded-lg border border-line px-3 py-2.5" data-testid={`stock-line-${l.lineNo}`}>
                <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                  <span className="font-semibold">
                    {l.lineNo}. {l.name}
                  </span>
                  <span className="text-[12px] text-ink-3">物料：{l.materialName}</span>
                  <span className="num ml-auto font-bold">
                    申请 {formatQty(l.qtyMilli)} {l.unit}
                  </span>
                </p>
                <p className="text-[12px] text-ink-3">
                  总仓现有{' '}
                  <span className={cn('num font-semibold', c && c.stockMilli > 0 ? 'text-pine' : '')}>
                    {formatQty(Math.max(0, c?.stockMilli ?? 0))} {c?.inventoryUnit ?? ''}
                  </span>
                  {c?.convertible && c.lineQtyMilli !== null && l.unit !== c.inventoryUnit && (
                    <span className="num">
                      （约 {formatQty(c.lineQtyMilli)} {l.unit}）
                    </span>
                  )}
                </p>
                <Segmented
                  size="sm"
                  ariaLabel={`第 ${l.lineNo} 行怎么处理`}
                  value={d.choice}
                  onChange={(v) => set(l.id, { choice: v })}
                  options={[
                    { value: 'issue', label: '领用', disabled: !c || c.stockMilli <= 0 },
                    { value: 'substitute', label: '替代' },
                    { value: 'purchase', label: '转采购' },
                  ]}
                />
                {d.choice === 'issue' && c && (
                  <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                    领用
                    <Input
                      inputMode="decimal"
                      value={d.qty}
                      onChange={(e) => set(l.id, { qty: e.target.value })}
                      className="h-9 w-28"
                      fullWidth={false}
                      aria-label={`第 ${l.lineNo} 行领用数量`}
                      data-testid={`stock-qty-${l.lineNo}`}
                    />
                    {c.convertible ? l.unit : c.inventoryUnit}
                    <span className="text-[12px] text-ink-3">
                      {c.convertible ? '可以只领一部分，剩下的转采购' : `这一行的单位「${l.unit}」换算不了：整行领用，按 ${c.inventoryUnit} 填实际领的数量`}
                    </span>
                  </label>
                )}
                {d.choice === 'substitute' && (
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    {materials.isPending ? (
                      <p className="text-[12.5px] text-ink-3">正在取总仓有货的物料……</p>
                    ) : materials.isError && !materials.data ? (
                      <LoadFailed title="总仓有货的物料没取回来" onRetry={() => void materials.refetch()} retrying={materials.isFetching} />
                    ) : (
                      <Select aria-label={`第 ${l.lineNo} 行的替代品`} value={d.materialId} onChange={(e) => set(l.id, { materialId: e.target.value })} data-testid={`stock-sub-material-${l.lineNo}`}>
                        <option value="">选替代的物料（总仓有货的）</option>
                        {(materials.data ?? [])
                          .filter((m) => m.id !== l.materialId)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.code} {m.name}
                              {m.specification ? ` · ${m.specification}` : ''}（现有 {formatQty(m.stockMilli)} {m.inventoryUnit}）
                            </option>
                          ))}
                      </Select>
                    )}
                    <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                      <Input
                        inputMode="decimal"
                        value={d.subQty}
                        onChange={(e) => set(l.id, { subQty: e.target.value })}
                        className="h-10 w-24"
                        fullWidth={false}
                        aria-label={`第 ${l.lineNo} 行替代品数量`}
                        data-testid={`stock-sub-qty-${l.lineNo}`}
                      />
                      {sub?.inventoryUnit ?? '库存单位'}
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {fresh.length > 0 && <p className="text-[12.5px] text-ink-3">手填的新品（{fresh.map((l) => `第 ${l.lineNo} 行「${l.name}」`).join('、')}）总仓没有，直接转采购。</p>}
        {error && <Notice tone="error" title={error} data-testid="stock-check-error" />}
      </div>
    </Dialog>
  );
}
