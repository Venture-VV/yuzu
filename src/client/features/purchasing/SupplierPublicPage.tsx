// 供应商门户（8.0.21，docs/FINANCE_V8021.md 第 7 节，CW-F）：供应商打开门店发来的链接（不用登录），手机上也能填。
//   · 报价：按询价单的行填单价、运费、交期、付款条件、有效期；可以再报一次（替换上一次的）。
//   · 订单确认：确认能供、写承诺到货日；只能确认一次。
//   · 发货预告：发货日、预计到货、各行发了多少、物流单号；可以分批报多次。
// 每次提交带页面生成的操作编号：没收到结果再点一次只记一次。
// 结果待确认（AGENTS.md；Codex 审查 73ae462 后补）：发出去之前把编号与原内容存进本机并读回核对，存不了不发；
// 断网、超时、服务器出错以后这一份留着，刷新、关掉再开链接都还在，只能「按原内容重新提交」（服务端先认原编号：
// 已经登记过的直接返回那一份，不会再记一次），不能另填一份。
// 被拒绝时分两种（Codex 审查 970c95c 后补）：以后也登记不上的（链接作废、过期，内容本身不合规则、日期过了，编号已经用在别的内容上）
// 才清掉、可以重新填写——服务端在所有检查之前先认原编号，这些条件也不会倒回去，原来那次晚到也一样被拒；
// 别的（门店暂时关了供应商链接、链接暂时关着……情况可能会变）照旧留着，只能按原内容重新提交。

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { SUPPLIER_LINK_LABELS, type SupplierPublicView } from '@shared/supplier-portal';
import { formatDateTime, uuid } from '../../lib/utils';
import { Button, Field, Input, Notice, Skeleton, Textarea } from '../../components/ui';

const yuan = (cents: number) => `¥${formatAmount(cents)}`;

/** 没收到结果（断网、超时、服务器出错、太频繁）：可能已经登记了，也可能没有 */
class UncertainReply extends Error {}

/** 服务端明确拒绝了（4xx）：带错误码，据此判断原来那次以后还会不会登记 */
class RejectedReply extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * 这些拒绝说明原来那次没有登记、以后也登记不上（服务端先认原编号，这些条件不会倒回去）：可以清掉本机的记录重新填写。
 * 别的（`PORTAL_PAUSED` 门店暂时关了链接、`LINK_CLOSED` 链接暂时关着、没见过的）都留着。
 */
const FINAL_REJECTIONS = new Set(['NOT_FOUND', 'LINK_EXPIRED', 'BAD_REQUEST', 'QUOTE_EXPIRED', 'DATE_PASSED', 'DATE_ORDER', 'QTY_OVER', 'IDEMPOTENCY_CONFLICT']);

async function call<T>(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new UncertainReply('网络断了或太慢，没收到结果');
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new UncertainReply(body?.error?.message ?? `服务器出错（${res.status}），没收到结果`);
    throw new RejectedReply(body?.error?.message ?? `出错了（${res.status}），请稍后再试`, body?.error?.code ?? '');
  }
  return body as T;
}

// ── 本机记下的「没收到结果」的那一份：按链接分开记（链接本身不存，存一个短摘要当键） ──
interface PendingReply {
  key: string;
  body: Record<string, unknown>;
  summary: string;
  createdAt: string;
}
const PENDING_STORE = 'yuzu.supplierReply.pending.v1';
/** 链接的短摘要（FNV-1a）：只用来分开不同链接的记录；内网 HTTP 下没有 crypto.subtle，不用它 */
function linkKey(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}-${token.length}`;
}
function readAllPending(): Record<string, PendingReply> {
  const raw = localStorage.getItem(PENDING_STORE);
  return raw ? (JSON.parse(raw) as Record<string, PendingReply>) : {};
}
function readPending(token: string): PendingReply | null {
  try {
    return readAllPending()[linkKey(token)] ?? null;
  } catch {
    return null;
  }
}
/** 存进本机并读回核对；存不了抛错（调用方据此不发请求） */
function savePending(token: string, p: PendingReply): void {
  const all = readAllPending();
  all[linkKey(token)] = p;
  localStorage.setItem(PENDING_STORE, JSON.stringify(all));
  if (readAllPending()[linkKey(token)]?.key !== p.key) throw new Error('本机存不进去');
}
function clearPending(token: string): void {
  try {
    const all = readAllPending();
    delete all[linkKey(token)];
    localStorage.setItem(PENDING_STORE, JSON.stringify(all));
  } catch {
    // 清不掉：下次打开会再提示一次，按原内容重新提交照样只记一次
  }
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
  const [pending, setPending] = useState<PendingReply | null>(() => readPending(token));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = async (p: PendingReply) => {
    setBusy(true);
    setError(null);
    try {
      const v = await call<SupplierPublicView>(`/api/public/supplier/${encodeURIComponent(token)}/reply`, { method: 'POST', body: JSON.stringify({ ...p.body, clientKey: p.key }) });
      clearPending(token);
      setPending(null);
      setSent(true);
      onDone(v);
    } catch (e) {
      if (e instanceof UncertainReply) {
        // 可能已经登记了：留着这一份，只能按原内容重新提交
        setPending(p);
        setError(`${e.message}。可能已经提交上了，也可能没有：请点「按原内容重新提交」（同一份只会登记一次），不要重新填一份。`);
      } else if (e instanceof RejectedReply && FINAL_REJECTIONS.has(e.code)) {
        // 以后也登记不上：这一份（以及之前没收到结果的那次）都没有、也不会再登记，清掉，可以重新填写
        clearPending(token);
        setPending(null);
        setError(e.message);
      } else {
        // 别的拒绝（门店暂时关了链接、链接暂时关着……）：情况可能会变，原来那次也说不定还会到——留着这一份，只能按原内容重新提交
        setPending(p);
        setError(`${(e as Error).message}。这一份先留在这台设备上：等门店那边好了再点「按原内容重新提交」（同一份只会登记一次），处理完之前不能另填一份；急的话直接联系门店采购。`);
        // 链接可能已经关了：刷新一下页面上的状态（取不回来就算了）
        call<SupplierPublicView>(`/api/public/supplier/${encodeURIComponent(token)}`).then(onDone, () => undefined);
      }
    } finally {
      setBusy(false);
    }
  };
  const submit = async (body: Record<string, unknown>, summary: string) => {
    const p: PendingReply = { key: uuid(), body, summary, createdAt: new Date().toISOString() };
    try {
      savePending(token, p);
    } catch {
      setError('这台设备记不下这次提交（可能是无痕模式或存储满了）。为免断网时重复登记，这次没有提交：请换一个浏览器打开链接，或直接联系门店采购。');
      return;
    }
    await send(p);
  };
  const resend = () => (pending ? send(pending) : Promise.resolve());
  return { busy, error, sent, submit, pending, resend };
}

/** 上次提交的还没有确认登记上（没收到结果，或被暂时拒绝）：只能按原内容重新提交 */
function PendingReplyNotice({ pending, busy, onResend }: { pending: PendingReply; busy: boolean; onResend: () => void }) {
  return (
    <Notice
      tone="warning"
      title="上次提交的还没有确认登记上"
      data-testid="sp-pending"
      action={
        <Button size="sm" variant="primary" loading={busy} onClick={onResend} data-testid="sp-pending-resend">
          按原内容重新提交
        </Button>
      }
    >
      {pending.summary}（{formatDateTime(pending.createdAt)}）。可能已经提交上了，也可能没有；重新提交用同一个编号，只会登记一次。处理完之前不能另填一份。
    </Notice>
  );
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
  const { busy, error, sent, submit, pending, resend } = useSubmit(token, onDone);
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
      {pending && <PendingReplyNotice pending={pending} busy={busy} onResend={() => void resend()} />}
      {pending && error && <Notice tone="error" title={error} />}
      {view.open && !pending && (
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
              void submit(
                {
                  name: name.trim(),
                  prices: parsed,
                  freightCents,
                  payTerms: payTerms.trim(),
                  creditDays: Number(/(\d+)\s*天/.exec(payTerms)?.[1] ?? 0),
                  deliveryDays: deliveryDays ? Number(deliveryDays) : null,
                  validUntil: validUntil || null,
                  note: note.trim(),
                },
                `报价：${parsed.length} 行单价${freightCents ? `、运费 ${yuan(freightCents)}` : ''}，付款条件「${payTerms.trim()}」，${name.trim()}`,
              )
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
  const { busy, error, submit, pending, resend } = useSubmit(token, onDone);
  const c = view.confirmation;
  const problem = !promisedDate ? '请写承诺到货日' : !name.trim() ? '请留下您的姓名' : null;
  return (
    <div className="space-y-3">
      <LinesTable view={view} head="" cell={() => null} />
      {pending && <PendingReplyNotice pending={pending} busy={busy} onResend={() => void resend()} />}
      {pending && error && <Notice tone="error" title={error} />}
      {c ? (
        <Notice tone="success" title={`已确认：承诺 ${c.promisedDate} 到货`} data-testid="sp-confirmed">
          {c.replyName} · {c.createdAt.slice(0, 16).replace('T', ' ')}
          {c.note ? ` · ${c.note}` : ''}。到货日有变的，请直接联系门店采购。
        </Notice>
      ) : (
        view.open &&
        !pending && (
          <>
            <Field label="承诺到货日" htmlFor="sp-promised">
              <Input id="sp-promised" type="date" value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} className="h-10" data-testid="sp-promised" />
            </Field>
            <Field label="备注（选填）" htmlFor="sp-cnote">
              <Textarea id="sp-cnote" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className="min-h-16" />
            </Field>
            <NameField name={name} setName={setName} />
            {error && <Notice tone="error" title={error} />}
            <Button variant="primary" className="w-full" loading={busy} disabled={!!problem} onClick={() => void submit({ name: name.trim(), promisedDate, note: note.trim() }, `确认：承诺 ${promisedDate} 到货，${name.trim()}`)} data-testid="sp-submit">
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
  const { busy, error, sent, submit, pending, resend } = useSubmit(token, onDone);
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
      {pending && <PendingReplyNotice pending={pending} busy={busy} onResend={() => void resend()} />}
      {pending && error && <Notice tone="error" title={error} />}
      {view.open && !pending && (
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
            onClick={() =>
              void submit(
                { name: name.trim(), shipDate, eta: eta || null, trackingNo: trackingNo.trim(), lines, note: note.trim() },
                `发货预告：${shipDate} 发货，${lines.length} 行${trackingNo.trim() ? `，物流单号 ${trackingNo.trim()}` : ''}，${name.trim()}`,
              )
            }
            data-testid="sp-submit"
          >
            {problem ?? '提交发货预告'}
          </Button>
        </>
      )}
    </div>
  );
}
