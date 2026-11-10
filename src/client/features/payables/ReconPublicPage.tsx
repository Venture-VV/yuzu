// 供应商在线对账确认（8.0.7 供应链收尾 2.6）：供应商打开门店发来的链接（不用登录），看这一期的对账单，
// 点「确认无误」或「有异议」（写原因、留姓名），只能回一次。手机上也能看。

import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { RECON_REPLY_LABELS, type ReconPublicView, type ReconReply } from '@shared/cycles';
import { formatAmount } from '@shared/money';
import { Button, Field, Input, Notice, Skeleton, Textarea } from '../../components/ui';

const yuan = (cents: number) => `¥${formatAmount(cents)}`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `出错了（${res.status}），请稍后再试`);
  return body as T;
}

export function ReconPublicPage() {
  const { token = '' } = useParams();
  const [view, setView] = useState<ReconPublicView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ReconReply | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => {
    document.title = '对账确认';
    call<ReconPublicView>(`/api/public/recon/${encodeURIComponent(token)}`)
      .then(setView)
      .catch((e: Error) => setError(e.message));
  }, [token]);
  const problem = !answer ? '请选择确认无误还是有异议' : !name.trim() ? '请留下您的姓名' : answer === 'disputed' && note.trim().length < 2 ? '有异议请写明哪里不对' : null;
  const submit = async () => {
    if (problem || !answer) return;
    setBusy(true);
    setSubmitError(null);
    try {
      setView(await call<ReconPublicView>(`/api/public/recon/${encodeURIComponent(token)}/reply`, { method: 'POST', body: JSON.stringify({ answer, name: name.trim(), note: note.trim() }) }));
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
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
              <p className="text-[13px] text-ink-3">{s.storeName} · 供应商对账确认</p>
              <h1 className="text-[20px] font-bold" data-testid="recon-public-title">
                {s.supplierName}
              </h1>
              <p className="text-[13.5px] text-ink-2">
                {s.kind === 'month' ? `${s.month} 月结对账` : `按批次对账（${s.from} 至 ${s.to}）`} · 合计 <span className="num font-bold">{yuan(s.totalCents)}</span>
              </p>
            </header>
            {s.totals && (
              <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-card p-3 text-[13px] sm:grid-cols-4">
                {(
                  [
                    ['期初余额', s.totals.beginCents],
                    ['期初未付登记', s.totals.openingCents],
                    ['收货', s.totals.receivedCents],
                    ['退货扣款', -s.totals.returnCreditCents],
                    ['付款', -s.totals.paidCents],
                    ['供应商退款', s.totals.refundedCents],
                    ['期末余额', s.totals.endCents],
                  ] as const
                ).map(([label, cents]) => (
                  <div key={label}>
                    <dt className="text-ink-3">{label}</dt>
                    <dd className="num font-bold">{yuan(cents)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
                  <tr>
                    <th className="px-3 py-2 font-semibold">日期</th>
                    <th className="px-3 py-2 font-semibold">单号</th>
                    <th className="px-3 py-2 font-semibold">类型</th>
                    <th className="px-3 py-2 text-right font-semibold">金额</th>
                    <th className="px-3 py-2 font-semibold">摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-3 text-ink-3">
                        这一期没有往来
                      </td>
                    </tr>
                  ) : (
                    s.rows.map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="num px-3 py-1.5">{r.date}</td>
                        <td className="num px-3 py-1.5">{r.docNo}</td>
                        <td className="px-3 py-1.5">{r.kind}</td>
                        <td className="num px-3 py-1.5 text-right">{yuan(r.amountCents)}</td>
                        <td className="px-3 py-1.5 text-ink-2">{r.note}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {view.reply ? (
              <Notice tone={view.reply === 'confirmed' ? 'success' : 'warning'} title={`已回复：${RECON_REPLY_LABELS[view.reply]}`} data-testid="recon-public-replied">
                {view.replyName} · {view.repliedAt?.slice(0, 16).replace('T', ' ')}
                {view.replyNote ? ` · ${view.replyNote}` : ''}
              </Notice>
            ) : (
              <section className="space-y-3 rounded-lg border border-line bg-card p-4">
                <p className="text-[14px] font-bold">请核对后回复（只能回一次；链接 {view.expiresAt.slice(0, 10)} 前有效）</p>
                <div className="flex flex-wrap gap-2">
                  {(['confirmed', 'disputed'] as const).map((a) => (
                    <Button key={a} variant={answer === a ? 'primary' : 'secondary'} onClick={() => setAnswer(a)} data-testid={`recon-public-${a}`}>
                      {a === 'confirmed' ? '确认无误' : '有异议'}
                    </Button>
                  ))}
                </div>
                <Field label="您的姓名" htmlFor="rp-name">
                  <Input id="rp-name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} className="h-10 max-w-xs" data-testid="recon-public-name" />
                </Field>
                <Field label={answer === 'disputed' ? '哪里不对（必填）' : '留言（选填）'} htmlFor="rp-note">
                  <Textarea id="rp-note" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} data-testid="recon-public-note" />
                </Field>
                {submitError && <Notice tone="error" title={submitError} />}
                <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="recon-public-submit">
                  提交回复
                </Button>
                {problem && <p className="text-[12.5px] text-ink-3">{problem}</p>}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
