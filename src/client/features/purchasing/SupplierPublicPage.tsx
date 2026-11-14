// 供应商门户（8.0.21，docs/FINANCE_V8021.md 第 7 节，CW-F）：供应商打开门店发来的链接（不用登录），手机上也能填。
//   · 报价：按询价单的行填单价、运费、交期、付款条件、有效期；可以再报一次（替换上一次的）。
//   · 订单确认：确认能供、写承诺到货日；只能确认一次。
//   · 发货预告：发货日、预计到货、各行发了多少、物流单号；可以分批报多次。
// 每次提交带页面生成的操作编号：没收到结果再点一次只记一次。

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { SUPPLIER_LINK_LABELS, type SupplierPublicView } from '@shared/supplier-portal';
import { uuid } from '../../lib/utils';
import { Button, Field, Input, Notice, Skeleton, Textarea } from '../../components/ui';

const yuan = (cents: number) => `¥${formatAmount(cents)}`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `出错了（${res.status}），请稍后再试`);
  return body as T;
}

export function SupplierPublicPage() {
  const { token = '' } = useParams();
  const [view, setView] = useState<SupplierPublicView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<SupplierPublicView>(`/api/public/supplier/${encodeURIComponent(token)}`)
      .then((v) => {
        document.title = SUPPLIER_LINK_LABELS[v.kind];
        setView(v);
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);
  const s = view?.snapshot;
  return (
    <div className="min-h-screen bg-paper px-4 py-6 text-ink">
      <div className="mx-auto max-w-3xl space-y-4">
        {error ? (
          <Notice tone="error" title={error} />
        ) : !view || !s ? (
          <Skeleton className="h-80" />
        ) : (
          <>
            <header className="space-y-1">
              <p className="text-[13px] text-ink-3">
                {s.storeName} · {SUPPLIER_LINK_LABELS[view.kind]}
              </p>
              <h1 className="text-[20px] font-bold" data-testid="supplier-public-title">
                {s.supplierName}
              </h1>
              <p className="text-[13.5px] text-ink-2">
                <span className="num">{s.docNo}</span>
                {view.kind === 'quote' ? ` · ${s.title}` : ''}
                {s.needBy ? ` · ${view.kind === 'quote' ? '要货日期' : '期望到货'} ${s.needBy}` : ''}
                {s.totalCents !== null ? ` · 合计 ${yuan(s.totalCents)}` : ''}
              </p>
              {s.note && <p className="text-[13px] text-ink-3">门店备注：{s.note}</p>}
            </header>
            {!view.open && view.closedReason && <Notice tone="info" title={view.closedReason} />}
            {view.kind === 'quote' ? (
              <QuoteForm token={token} view={view} onDone={setView} />
            ) : view.kind === 'po_confirm' ? (
              <ConfirmForm token={token} view={view} onDone={setView} />
            ) : (
              <DeliveryForm token={token} view={view} onDone={setView} />
            )}
            <p className="text-center text-[12px] text-ink-3">链接 {view.expiresAt.slice(0, 10)} 前有效；有问题请直接联系门店采购。</p>
          </>
        )}
      </div>
    </div>
  );
}

function useSubmit(token: string, onDone: (v: SupplierPublicView) => void) {
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const submit = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await call<SupplierPublicView>(`/api/public/supplier/${encodeURIComponent(token)}/reply`, { method: 'POST', body: JSON.stringify({ ...body, clientKey: key }) }));
      setKey(uuid());
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, sent, submit };
}

function LinesTable({ view, cell, head }: { view: SupplierPublicView; head: string; cell: (lineId: number) => ReactNode }) {
  const s = view.snapshot;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-card">
      <table className="w-full text-[13px]">
        <thead className="bg-paper-2 text-left text-ink-3">
          <tr>
            <th className="px-3 py-2">物料</th>
            <th className="px-3 py-2 text-right">数量</th>
            {s.lines.some((l) => l.priceCents !== null) && <th className="px-3 py-2 text-right">单价</th>}
            <th className="px-3 py-2">{head}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {s.lines.map((l) => (
            <tr key={l.lineId}>
              <td className="px-3 py-2">
                <span className="font-semibold">{l.materialName}</span>
                {l.spec && <span className="block text-[12px] text-ink-3">{l.spec}</span>}
              </td>
              <td className="num px-3 py-2 text-right whitespace-nowrap">
                {formatQty(l.purchaseQtyMilli)} {l.purchaseUnit}
              </td>
              {l.priceCents !== null && <td className="num px-3 py-2 text-right">{yuan(l.priceCents)}</td>}
              <td className="px-3 py-2">{cell(l.lineId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NameField({ name, setName }: { name: string; setName: (v: string) => void }) {
  return (
    <Field label="您的姓名" htmlFor="sp-name">
      <Input id="sp-name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} className="h-10" data-testid="sp-name" />
    </Field>
  );
}

function QuoteForm({ token, view, onDone }: { token: string; view: SupplierPublicView; onDone: (v: SupplierPublicView) => void }) {
  const q = view.quote;
  const [prices, setPrices] = useState<Record<number, string>>(() => Object.fromEntries(view.snapshot.lines.map((l) => [l.lineId, q ? centsToInput(q.prices.find((p) => p.lineId === l.lineId)?.priceCents ?? 0) : ''])));
  const [freight, setFreight] = useState(q ? centsToInput(q.freightCents) : '0');
  const [payTerms, setPayTerms] = useState(q?.payTerms ?? '');
  const [deliveryDays, setDeliveryDays] = useState(q?.deliveryDays?.toString() ?? '');
  const [validUntil, setValidUntil] = useState(q?.validUntil ?? '');
  const [note, setNote] = useState(q?.note ?? '');
  const [name, setName] = useState('');
  const { busy, error, sent, submit } = useSubmit(token, onDone);
  const parsed = view.snapshot.lines.map((l) => ({ lineId: l.lineId, priceCents: parseYuan(prices[l.lineId] ?? '') }));
  const freightCents = parseYuan(freight || '0');
  const problem = parsed.some((p) => p.priceCents === null)
    ? '每一行都要填单价'
    : freightCents === null
      ? '运费的金额不对'
      : !payTerms.trim()
        ? '请写付款条件，例如「月结 30 天」「现付」'
        : deliveryDays && !/^\d{1,3}$/.test(deliveryDays)
          ? '交期写天数'
          : !name.trim()
            ? '请留下您的姓名'
            : null;
  return (
    <div className="space-y-3">
      {q && (
        <Notice tone="success" title={`已报价：货款 ${yuan(q.goodsCents)}${q.freightCents ? `，运费 ${yuan(q.freightCents)}` : ''}`} data-testid="sp-quoted">
          {q.viaLink ? '是您在这个链接里报的。' : '门店已经替您登记了一份报价。'}要改的话重新填一份提交，会替换上一次的。
        </Notice>
      )}
      <LinesTable
        view={view}
        head="含税单价（元 / 采购单位）"
        cell={(id) => (
          <Input inputMode="decimal" value={prices[id] ?? ''} disabled={!view.open} onChange={(e) => setPrices({ ...prices, [id]: e.target.value })} className="h-9 w-32" aria-label="单价" data-testid={`sp-price-${id}`} />
        )}
      />
      {view.open && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="运费（元）" htmlFor="sp-freight">
              <Input id="sp-freight" inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} className="h-10" />
            </Field>
            <Field label="付款条件" htmlFor="sp-terms">
              <Input id="sp-terms" value={payTerms} maxLength={30} placeholder="例如 月结 30 天" onChange={(e) => setPayTerms(e.target.value)} className="h-10" data-testid="sp-terms" />
            </Field>
            <Field label="交期（下单后几天到）" htmlFor="sp-days">
              <Input id="sp-days" inputMode="numeric" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} className="h-10" />
            </Field>
            <Field label="报价有效期至" htmlFor="sp-valid">
              <Input id="sp-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="h-10" />
            </Field>
          </div>
          <Field label="备注" htmlFor="sp-note">
            <Textarea id="sp-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="min-h-16" />
          </Field>
          <NameField name={name} setName={setName} />
          {error && <Notice tone="error" title={error} />}
          {sent && !error && <Notice tone="success" title="报价已提交，谢谢！" />}
          <Button
            variant="primary"
            className="w-full"
            loading={busy}
            disabled={!!problem}
            onClick={() =>
              void submit({
                name: name.trim(),
                prices: parsed,
                freightCents,
                payTerms: payTerms.trim(),
                creditDays: Number(/(\d+)\s*天/.exec(payTerms)?.[1] ?? 0),
                deliveryDays: deliveryDays ? Number(deliveryDays) : null,
                validUntil: validUntil || null,
                note: note.trim(),
              })
            }
            data-testid="sp-submit"
          >
            {problem ?? (q ? '重新报价（替换上一次的）' : '提交报价')}
          </Button>
        </>
      )}
    </div>
  );
}

function ConfirmForm({ token, view, onDone }: { token: string; view: SupplierPublicView; onDone: (v: SupplierPublicView) => void }) {
  const [promisedDate, setPromisedDate] = useState(view.snapshot.needBy ?? '');
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const { busy, error, submit } = useSubmit(token, onDone);
  const c = view.confirmation;
  const problem = !promisedDate ? '请写承诺到货日' : !name.trim() ? '请留下您的姓名' : null;
  return (
    <div className="space-y-3">
      <LinesTable view={view} head="" cell={() => null} />
      {c ? (
        <Notice tone="success" title={`已确认：承诺 ${c.promisedDate} 到货`} data-testid="sp-confirmed">
          {c.replyName} · {c.createdAt.slice(0, 16).replace('T', ' ')}
          {c.note ? ` · ${c.note}` : ''}。到货日有变的，请直接联系门店采购。
        </Notice>
      ) : (
        view.open && (
          <>
            <Field label="承诺到货日" htmlFor="sp-promised">
              <Input id="sp-promised" type="date" value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} className="h-10" data-testid="sp-promised" />
            </Field>
            <Field label="备注（选填）" htmlFor="sp-cnote">
              <Textarea id="sp-cnote" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className="min-h-16" />
            </Field>
            <NameField name={name} setName={setName} />
            {error && <Notice tone="error" title={error} />}
            <Button variant="primary" className="w-full" loading={busy} disabled={!!problem} onClick={() => void submit({ name: name.trim(), promisedDate, note: note.trim() })} data-testid="sp-submit">
              {problem ?? '确认能供，按这个日期送到'}
            </Button>
          </>
        )
      )}
    </div>
  );
}

function DeliveryForm({ token, view, onDone }: { token: string; view: SupplierPublicView; onDone: (v: SupplierPublicView) => void }) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [shipDate, setShipDate] = useState(today);
  const [eta, setEta] = useState(view.confirmation?.promisedDate ?? '');
  const [trackingNo, setTrackingNo] = useState('');
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const { busy, error, sent, submit } = useSubmit(token, onDone);
  const lines = view.snapshot.lines
    .map((l) => ({ lineId: l.lineId, qtyMilli: (qty[l.lineId] ?? '').trim() ? parseQty(qty[l.lineId]!) : 0 }))
    .filter((x) => x.qtyMilli !== 0);
  const problem = lines.some((x) => x.qtyMilli === null || (x.qtyMilli ?? 0) <= 0)
    ? '发货数量写数字'
    : !lines.length
      ? '至少写一行发了多少'
      : !shipDate
        ? '请写发货日'
        : !name.trim()
          ? '请留下您的姓名'
          : null;
  return (
    <div className="space-y-3">
      {view.confirmation && <p className="text-[13px] text-ink-2">已确认：承诺 {view.confirmation.promisedDate} 到货。</p>}
      {view.notices.length > 0 && (
        <div className="rounded-lg border border-line bg-card p-3 text-[13px]" data-testid="sp-notices">
          <p className="mb-1 font-semibold">已报的发货</p>
          <ul className="space-y-0.5">
            {view.notices.map((n) => (
              <li key={n.id}>
                {n.shipDate} 发货{n.eta ? `、预计 ${n.eta} 到` : ''}：
                {n.lines
                  .map((x) => {
                    const l = view.snapshot.lines.find((y) => y.lineId === x.lineId);
                    return l ? `${l.materialName} ${formatQty(x.qtyMilli)}${l.purchaseUnit}` : '';
                  })
                  .join('、')}
                {n.trackingNo ? `（${n.trackingNo}）` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.open && (
        <>
          <LinesTable
            view={view}
            head="这一批发多少（采购单位）"
            cell={(id) => <Input inputMode="decimal" value={qty[id] ?? ''} onChange={(e) => setQty({ ...qty, [id]: e.target.value })} className="h-9 w-28" aria-label="发货数量" data-testid={`sp-qty-${id}`} />}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="发货日" htmlFor="sp-ship">
              <Input id="sp-ship" type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} className="h-10" />
            </Field>
            <Field label="预计到货（选填）" htmlFor="sp-eta">
              <Input id="sp-eta" type="date" value={eta} onChange={(e) => setEta(e.target.value)} className="h-10" />
            </Field>
            <Field label="物流单号（选填）" htmlFor="sp-track">
              <Input id="sp-track" value={trackingNo} maxLength={40} onChange={(e) => setTrackingNo(e.target.value)} className="h-10" />
            </Field>
          </div>
          <Field label="备注（选填）" htmlFor="sp-dnote">
            <Textarea id="sp-dnote" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className="min-h-16" />
          </Field>
          <NameField name={name} setName={setName} />
          {error && <Notice tone="error" title={error} />}
          {sent && !error && <Notice tone="success" title="发货预告已提交，谢谢！还有下一批的话再填一份。" />}
          <Button
            variant="primary"
            className="w-full"
            loading={busy}
            disabled={!!problem}
            onClick={() => void submit({ name: name.trim(), shipDate, eta: eta || null, trackingNo: trackingNo.trim(), lines, note: note.trim() })}
            data-testid="sp-submit"
          >
            {problem ?? '提交发货预告'}
          </Button>
        </>
      )}
    </div>
  );
}
