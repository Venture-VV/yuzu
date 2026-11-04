// 会员详情「次卡」（v0.7.28 ④，docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）：
//   · 这位会员的次卡：能抵什么、剩几次、到哪天、状态；
//   · 售次卡（前台岗位）：选卡种、收款方式（现金类，记到当班），是收款不是营业额；结账时在结账对话框里「用次卡」；
//   · 退卡（值班经理以上）：退剩下的次数，默认按售价折算，可以改少；
//   · 售卡、退卡动的是钱：超时、断网、回复 500 时结果待确认，在卡片上方查回、按原内容重新提交或作废。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ticket } from 'lucide-react';
import {
  COUNT_CARD_SOURCE_LABELS,
  COUNT_CARD_STATUS_LABELS,
  countCardTermsText,
  defaultCountCardRefund,
  type CountCard,
  type CountCardType,
} from '@shared/count-cards';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, type ErpPendingOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';

const cardsKey = (memberId: number) => ['member', memberId, 'count-cards'] as const;
const STATUS_TONES = { active: 'moss', used_up: 'neutral', expired: 'neutral', refunded: 'clay' } as const;

export function CountCardsCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: cardsKey(member.id), queryFn: () => api.get<CountCard[]>(`/api/members/${member.id}/count-cards`) });
  const [selling, setSelling] = useState(false);
  const [refunding, setRefunding] = useState<CountCard | null>(null);
  const ids = new Set((cards.data ?? []).map((c) => c.id));
  // 售卡的待确认按会员分；退卡的按卡
  const ofMember = (op: ErpPendingOp) =>
    op.type === 'count_card_sale' ? (op.body as { memberId?: number }).memberId === member.id : ids.has(Number(op.url.split('/')[3]));
  const refresh = () => qc.invalidateQueries({ queryKey: cardsKey(member.id) });
  if (cards.isPending) return <Skeleton className="h-24" />;
  if (cards.error || !cards.data) return <Notice tone="error" title={cards.error?.message ?? '次卡没有加载出来'} />;
  const list = cards.data;
  return (
    <Card className="p-5" data-testid="member-count-cards">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="N5：现金类收款、按项目价抵、一次一份、默认 365 天；不和券、会员折扣同用；退卡按售价折算（待店主确认）" />
            {can('countcard.sell') && (
              <Button size="sm" variant="secondary" icon={<Ticket className="size-3.5" />} disabled={member.status !== 'active'} onClick={() => setSelling(true)} data-testid="count-card-sell-open">
                售次卡
              </Button>
            )}
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <Ticket className="size-4 text-yuzu-deep" /> 次卡
        </span>
      </SectionTitle>
      {(can('countcard.sell') || can('countcard.refund')) && (
        <ErpPendingPanel types={['count_card_sale', 'count_card_refund']} filter={ofMember} className="mt-3 space-y-2" onFound={() => void refresh()} />
      )}
      {list.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">还没有次卡。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13.5px]" data-testid={`count-card-${c.cardNo}`}>
              <span className="font-semibold">{c.name}</span>
              <Badge tone={STATUS_TONES[c.status]}>{COUNT_CARD_STATUS_LABELS[c.status]}</Badge>
              <span className="num">
                剩 <span className="font-bold">{c.remaining}</span> / {c.totalUses} 次
              </span>
              <span className="text-ink-3">{c.targetNames.join('、')}</span>
              <span className="text-[12px] text-ink-3">
                {c.cardNo} · {COUNT_CARD_SOURCE_LABELS[c.source]}
                {c.price > 0 && ` · ${formatYuan(c.price)}`}
                {c.paymentMethod && `（${PAYMENT_METHOD_LABELS[c.paymentMethod]}）`} · {c.expiresOn ? `到 ${c.expiresOn}` : '长期有效'}
                {c.refund && ` · 退 ${formatYuan(c.refund.amount)}（${c.refund.reason}）`}
              </span>
              {c.status === 'active' && can('countcard.refund') && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRefunding(c)} data-testid={`count-card-refund-${c.cardNo}`}>
                  退卡
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {selling && <SellDialog member={member} onClose={() => setSelling(false)} onDone={() => void refresh()} />}
      {refunding && <RefundDialog card={refunding} onClose={() => setRefunding(null)} onDone={() => void refresh()} />}
    </Card>
  );
}

function MethodPicker({ value, onChange }: { value: PaymentMethod; onChange: (m: PaymentMethod) => void }) {
  return <Segmented value={value} onChange={onChange} ariaLabel="方式" size="sm" options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} />;
}

function SellDialog({ member, onClose, onDone }: { member: MemberDetail; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const types = useQuery({ queryKey: ['count-card-types'], queryFn: () => api.get<CountCardType[]>('/api/count-card-types') });
  const [typeId, setTypeId] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [ref, setRef] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const active = (types.data ?? []).filter((t) => t.active);
  const t = active.find((x) => x.id === typeId) ?? active[0] ?? null;
  const ok = !!t && (method !== 'other' || ref.trim().length >= 2);
  const submit = async () => {
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'count_card_sale',
        url: '/api/count-cards',
        body: { clientKey: key, memberId: member.id, typeId: t.id, expectedVersion: t.version, expectedPrice: t.price, method, ref: ref.trim() },
        summary: `${member.name} 买「${t.name}」${formatYuan(t.price)}（${PAYMENT_METHOD_LABELS[method]}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已售卡', body: `${member.name}：${t.name}，${t.uses} 次` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '售卡结果待确认', body: '已记在本机：请在「次卡」上方查回、按原内容重新提交或作废，不要另收一笔。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${member.name}：售次卡`}
      description="是收款，记到你当班的班次（交班时算钱箱里的钱），不是营业额；结账时用一次算一次的营业额。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ok || busy} data-testid="count-card-sell-submit">
            收 {t ? formatYuan(t.price) : ''} 并售卡
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        {types.isPending ? (
          <Skeleton className="h-10" />
        ) : active.length === 0 ? (
          <Notice tone="warning" title="还没有在售的卡种" >请店主或店总在后台「价目与套餐 → 次卡」里添加。</Notice>
        ) : (
          <Field label="卡种" htmlFor="count-card-type">
            <Select id="count-card-type" value={t?.id ?? ''} onChange={(e) => setTypeId(Number(e.target.value))} data-testid="count-card-type">
              {active.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}（{x.uses} 次 {formatYuan(x.price)}）
                </option>
              ))}
            </Select>
          </Field>
        )}
        {t && <p className="text-[13px] text-ink-2">{countCardTermsText(t, formatYuan)}</p>}
        <Field label="收款方式">
          <MethodPicker value={method} onChange={setMethod} />
        </Field>
        <Field label={method === 'other' ? '收的是什么（必填）' : '收款备注（可不填）'} htmlFor="count-card-ref">
          <Input id="count-card-ref" value={ref} maxLength={64} onChange={(e) => setRef(e.target.value)} placeholder={method === 'cash' ? '' : '例如支付单号后几位'} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}

function RefundDialog({ card, onClose, onDone }: { card: CountCard; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const max = defaultCountCardRefund(card);
  const [amount, setAmount] = useState(centsToInput(max));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const cents = parseYuan(amount);
  const amountOk = cents !== null && cents >= 0 && cents <= max;
  const ok = amountOk && reason.trim().length >= 2 && (cents === 0 || method === 'cash' || ref.trim().length >= 2);
  const submit = async () => {
    if (cents === null) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'count_card_refund',
        url: `/api/count-cards/${card.id}/refund`,
        body: { clientKey: key, expectedVersion: card.version, amount: cents, method, ref: ref.trim(), reason: reason.trim() },
        summary: `${card.memberName} 退「${card.name}」剩 ${card.remaining} 次，退 ${formatYuan(cents)}（${PAYMENT_METHOD_LABELS[method]}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已退卡', body: `${card.name}：退 ${formatYuan(cents)}` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '退卡结果待确认', body: '已记在本机：请在「次卡」上方查回、按原内容重新提交或作废，不要另退一笔。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`退卡：${card.name}`}
      description={`剩 ${card.remaining} / ${card.totalUses} 次；最多退 ${formatYuan(max)}（售价 × 剩下次数 ÷ 总次数），可以改少。现金从你当班的钱箱退，扫码、银行卡在商户后台原路退回后填退款单号。`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={!ok || busy} data-testid="count-card-refund-submit">
            退卡
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field label="退多少" htmlFor="count-card-refund-amount" error={amount && !amountOk ? `最多退 ${formatYuan(max)}` : null}>
          <MoneyInput id="count-card-refund-amount" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!amount && !amountOk} data-testid="count-card-refund-amount" />
        </Field>
        <Field label="退款方式">
          <MethodPicker value={method} onChange={setMethod} />
        </Field>
        {method !== 'cash' && (
          <Field label={method === 'other' ? '怎么退的（必填）' : '退款单号（必填）'} htmlFor="count-card-refund-ref">
            <Input id="count-card-refund-ref" value={ref} maxLength={64} onChange={(e) => setRef(e.target.value)} />
          </Field>
        )}
        <Field label="原因" htmlFor="count-card-refund-reason">
          <Input id="count-card-refund-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如 客人搬家" data-testid="count-card-refund-reason" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
