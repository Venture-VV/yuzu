// 会员详情「会员卡」（v0.7.28 ⑦，docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）：会员实体卡的发卡、挂失、补卡。
//   · 卡只是认人：钱照旧在会员钱包里；发卡、补卡不收工本费；
//   · 押金（8.1.15，docs/MEMBERS_V8115.md 第 3 节）：名下没有押金的发卡时按后台设的金额收（负债，不进储值）；换下在用的卡不另收，
//     补卡沿用原来的押金；「退卡」把在用的卡退回来、押着的押金全额退（卡丢了没卡可退的也在这里退）；
//   · 读卡：读卡器（模拟键盘）把卡号打进输入框，或这台终端的设备服务（桥）报上来的读卡自动填进来；也可以手输；
//   · 挂失：原卡从此不能用（找回也不解挂），之后「补卡」发一张新卡；卡坏了直接「补卡」换下在用的那张（写原因）；
//   · 发卡带操作编号：没收到结果时在卡片上方查回、按原内容重新提交或确认作废。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Undo2 } from 'lucide-react';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { MEMBER_CARD_STATUS_LABELS, normalizeCardNo, MEMBER_CARD_RE, type MemberCard } from '@shared/member-cards';
import { CARD_DEPOSIT_KIND_LABELS, MEMBER_CARD_TYPE_LABELS, type MemberCardDeposits } from '@shared/member-form';
import { formatYuan } from '@shared/money';
import type { MemberDetail } from '@shared/types';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, type ErpPendingOp } from '../../lib/erpPending';
import { qk } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';
import { useTerminalState } from '../devices/terminal';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { CardDepositFields, depositPayProblem, EMPTY_DEPOSIT_PAY, type DepositPayDraft } from './CardDepositFields';

const cardsKey = (memberId: number) => ['member', memberId, 'cards'] as const;
const depositsKey = (memberId: number) => ['member', memberId, 'card-deposits'] as const;
const STATUS_TONES = { active: 'moss', lost: 'clay', canceled: 'neutral', returned: 'neutral' } as const;
const ENDED_WORDS = { active: '', lost: '挂失', canceled: '换下', returned: '退卡' } as const;
/** 押金的金额对不上（后台刚改了押金、别处刚收过或退过）：刷新规则与会员，页面按最新的再办 */
const DEPOSIT_ERRORS = ['CARD_DEPOSIT_REQUIRED', 'CARD_DEPOSIT_CHANGED'];

export function MemberCardsCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: cardsKey(member.id), queryFn: () => api.get<MemberCard[]>(`/api/members/${member.id}/cards`) });
  const deposits = useQuery({ queryKey: depositsKey(member.id), queryFn: () => api.get<MemberCardDeposits>(`/api/members/${member.id}/card-deposits`) });
  const [issuing, setIssuing] = useState<null | 'issue' | 'replace'>(null);
  const [losing, setLosing] = useState<MemberCard | null>(null);
  const [returning, setReturning] = useState(false);
  // 发卡、挂失之后，查找框按卡号找人的结果也变了：会员查找的缓存一起作废（刚挂失就刷这张卡不能还找到人）；
  // 发卡、退卡会改卡类型与押着的押金（8.1.15）：会员详情一起刷新
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.member(member.id) });
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['member-cards'] });
    void qc.invalidateQueries({ queryKey: shiftKeys.all });
  };
  const ofMember = (op: ErpPendingOp) => op.url === `/api/members/${member.id}/cards` || op.url === `/api/members/${member.id}/cards/return`;
  if (cards.isPending) return <Skeleton className="h-20" />;
  if (cards.error || !cards.data) return <Notice tone="error" title={cards.error?.message ?? '会员卡没有加载出来'} />;
  const list = cards.data;
  const current = list.find((c) => c.status === 'active') ?? null;
  const hasLost = list.some((c) => c.status === 'lost');
  const usable = member.status === 'active' && !member.mergedIntoId;
  // 押着的押金：台账读出来以前先用会员详情里带的
  const held = deposits.data?.held ?? member.cardDepositHeld;
  const depositRows = deposits.data?.rows ?? [];
  return (
    <Card className="p-5" data-testid="member-cards">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="N8：发卡、补卡不收工本费；挂失后原卡不能再用、找回也不解挂，补一张新卡。8.1.15：发卡收押金（后台设金额，默认 20 元），挂失不退、补卡沿用、退卡全额退（都待店主确认）" />
            {can('member.card') && usable && !current && (
              <Button size="sm" variant="secondary" icon={<CreditCard className="size-3.5" />} onClick={() => setIssuing(hasLost ? 'replace' : 'issue')} data-testid="member-card-issue-open">
                {hasLost ? '补卡' : '发卡'}
              </Button>
            )}
            {/* 退卡：停用、合并过的会员也能退——押金是欠客人的钱 */}
            {can('member.card') && !current && held > 0 && (
              <Button size="sm" variant="secondary" icon={<Undo2 className="size-3.5" />} onClick={() => setReturning(true)} data-testid="member-card-return-open">
                退押金
              </Button>
            )}
          </span>
        }
      >
        <span className="flex flex-wrap items-center gap-2">
          <CreditCard className="size-4 text-yuzu-deep" /> 会员卡
          <Badge tone={member.cardType === 'physical' ? 'moss' : member.cardType === 'anonymous' ? 'lake' : 'neutral'}>{MEMBER_CARD_TYPE_LABELS[member.cardType]}</Badge>
        </span>
      </SectionTitle>
      {can('member.card') && <ErpPendingPanel types={['member_card', 'member_card_return']} filter={ofMember} className="mt-3 space-y-2" onFound={() => void refresh()} />}
      {held > 0 && (
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 rounded-md bg-paper-2 px-3 py-2 text-[13px] text-ink-2" data-testid="member-card-deposit-held">
          押着押金 <Money cents={held} className="text-[16px] font-bold text-ink" />
          <span className="text-[12.5px] text-ink-3">押金不在储值余额里；退卡时全额退</span>
        </p>
      )}
      {list.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">还没有发实体卡。刷卡找会员、结账认人用；钱照旧在会员钱包里。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13.5px]" data-testid={`member-card-${c.cardNo}`} data-status={c.status}>
              <span className="font-mono font-semibold">{c.cardNo}</span>
              <Badge tone={STATUS_TONES[c.status]}>{MEMBER_CARD_STATUS_LABELS[c.status]}</Badge>
              <span className="text-[12px] text-ink-3">
                {c.issuedByName} {formatDateTime(c.issuedAt)} 发{c.endedAt && ` · ${c.endedByName ?? ''} ${formatDateTime(c.endedAt)} ${ENDED_WORDS[c.status]}（${c.endReason}）`}
              </span>
              {c.status === 'active' && can('member.card') && (
                <span className="ml-auto flex gap-1.5">
                  {usable && (
                    <Button size="sm" variant="ghost" onClick={() => setIssuing('replace')} data-testid="member-card-replace-open">
                      补卡
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setLosing(c)} data-testid={`member-card-lost-${c.cardNo}`}>
                    挂失
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setReturning(true)} data-testid="member-card-return-open">
                    退卡
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {depositRows.length > 0 && (
        <details className="mt-3 text-[13px]" data-testid="member-card-deposit-rows">
          <summary className="cursor-pointer font-semibold text-ink-2">押金记录（{depositRows.length} 笔）</summary>
          <ul className="mt-1.5 divide-y divide-line">
            {depositRows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                <span className="font-semibold text-ink">{CARD_DEPOSIT_KIND_LABELS[d.kind]}</span>
                <Money cents={d.kind === 'refund' ? -d.amount : d.amount} className="font-bold text-ink" />
                <span className="text-[12.5px] text-ink-3">
                  {PAYMENT_METHOD_LABELS[d.method]}
                  {d.ref ? `（${d.ref}）` : ''} · {d.docNo}
                  {d.cardNo ? ` · 卡 ${d.cardNo}` : ''} · {d.operatorName} {formatDateTime(d.createdAt)}
                  {d.reason ? ` · ${d.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {issuing && <IssueDialog member={member} mode={issuing} current={current} held={held} onClose={() => setIssuing(null)} onDone={() => void refresh()} />}
      {losing && <LostDialog card={losing} memberName={member.name} held={held} onClose={() => setLosing(null)} onDone={() => void refresh()} />}
      {returning && <ReturnDialog member={member} current={current} held={held} onClose={() => setReturning(false)} onDone={() => void refresh()} />}
    </Card>
  );
}

/**
 * 读卡输入框：读卡器（模拟键盘）把卡号打进来；这台终端的设备服务（桥）报上来的读卡也填进来（打开之后的新读卡）。
 * 按回车等于点确认。
 */
export function CardNoInput({ value, onChange, onEnter, autoFocus = true, invalid }: { value: string; onChange: (v: string) => void; onEnter: () => void; autoFocus?: boolean; invalid?: boolean }) {
  const events = useTerminalState().events;
  const seen = useRef<string | null>(events[0]?.id ?? null);
  useEffect(() => {
    const latest = events[0];
    if (!latest || latest.id === seen.current) return;
    seen.current = latest.id;
    if (latest.type === 'card' && latest.source === 'bridge') onChange(latest.value);
  }, [events, onChange]);
  return (
    <Input
      autoFocus={autoFocus}
      data-autofocus={autoFocus || undefined}
      invalid={invalid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter();
        }
      }}
      placeholder="把卡放到读卡器上，或手输卡号"
      autoComplete="off"
      inputMode="text"
      data-testid="member-card-no"
    />
  );
}

function IssueDialog({
  member,
  mode,
  current,
  held,
  onClose,
  onDone,
}: {
  member: MemberDetail;
  mode: 'issue' | 'replace';
  current: MemberCard | null;
  /** 这位会员押着的押金 */
  held: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [cardNo, setCardNo] = useState('');
  const [reason, setReason] = useState('');
  const [pay, setPay] = useState<DepositPayDraft>(EMPTY_DEPOSIT_PAY);
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const normalized = normalizeCardNo(cardNo);
  const replacingActive = mode === 'replace' && !!current;
  // 押金（8.1.15）：名下没有押金、又不是换下在用的卡，按后台设的金额收；服务端按自己算的核对
  const deposit = held > 0 || replacingActive ? 0 : (session.rules.memberForm?.cardDeposit ?? 0);
  const payProblem = deposit > 0 ? depositPayProblem(pay, 'receive') : null;
  const shiftReady = useShiftReady(deposit > 0);
  const ok = MEMBER_CARD_RE.test(normalized) && (!replacingActive || reason.trim().length >= 2) && !payProblem && (deposit === 0 || shiftReady.ready);
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'member_card',
        url: `/api/members/${member.id}/cards`,
        body: {
          clientKey: key,
          cardNo: normalized,
          replace: mode === 'replace',
          replaceReason: replacingActive ? reason.trim() : '',
          ...(deposit > 0 ? { deposit: { amount: deposit, method: pay.method, ref: pay.ref.trim() } } : {}),
        },
        summary: `${member.name} ${mode === 'replace' ? '补卡' : '发卡'}（卡号尾号 ${normalized.slice(-4)}${deposit > 0 ? `，收押金 ${formatYuan(deposit)}` : ''}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: mode === 'replace' ? '已补卡' : '已发卡', body: `${member.name}：卡号 ${normalized}${deposit > 0 ? `，收押金 ${formatYuan(deposit)}` : ''}` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '发卡：没收到结果', body: '记录留在本机，在「会员卡」上方查回、按原内容重新提交或确认作废' });
        onDone();
        onClose();
      } else {
        setError(errorMessage(e));
        // 被拒绝（卡已发给别人、已挂失……）：换一张卡要用新的操作编号
        setKey(uuid());
        if (e instanceof ApiError && SHIFT_ERRORS.includes(e.code)) void qc.invalidateQueries({ queryKey: shiftKeys.all });
        if (e instanceof ApiError && DEPOSIT_ERRORS.includes(e.code)) {
          void qc.invalidateQueries({ queryKey: qk.session });
          onDone();
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'replace' ? `给${member.name}补卡` : `给${member.name}发卡`}
      description={
        replacingActive
          ? `换下在用的卡（尾号 ${current!.cardNo.slice(-4)}），原卡记「已换下」，不能再用。卡丢了请先「挂失」。`
          : mode === 'replace'
            ? `原卡已挂失，发一张新卡。${held > 0 ? '押金沿用原来的，不另收。' : ''}`
            : '卡只是认人：刷卡找到这位会员，钱照旧在会员钱包里。'
      }
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={busy} disabled={!ok} onClick={() => void submit()} data-testid="member-card-issue-submit">
            {mode === 'replace' ? '确认补卡' : '确认发卡'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="卡号" hint={normalized && !MEMBER_CARD_RE.test(normalized) ? '卡号是 4–32 位数字或字母' : normalized ? `识别为 ${normalized}` : undefined}>
          <CardNoInput value={cardNo} onChange={setCardNo} onEnter={() => void submit()} />
        </Field>
        {replacingActive && (
          <Field label="换卡原因">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：卡坏了" maxLength={100} data-testid="member-card-replace-reason" />
          </Field>
        )}
        {deposit > 0 && (
          <>
            <ShiftGate action="收押金" />
            <CardDepositFields kind="receive" amount={deposit} value={pay} onChange={setPay} disabled={busy} error={pay.ref || pay.method === 'other' ? payProblem : null} />
          </>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/**
 * 退卡（8.1.15）：在用的卡退回来记「已退卡」，押着的押金全额退；卡已经挂失、没卡可退的只退押金。
 * 带操作编号：没收到结果时在卡片上方查回、按原内容重新提交或确认作废。
 */
function ReturnDialog({ member, current, held, onClose, onDone }: { member: MemberDetail; current: MemberCard | null; held: number; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [pay, setPay] = useState<DepositPayDraft>(EMPTY_DEPOSIT_PAY);
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payProblem = held > 0 ? depositPayProblem(pay, 'refund') : null;
  const shiftReady = useShiftReady(held > 0);
  const ok = reason.trim().length >= 2 && !payProblem && (held === 0 || shiftReady.ready);
  const what = current ? (held > 0 ? '退卡、退押金' : '退卡') : '退押金';
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'member_card_return',
        url: `/api/members/${member.id}/cards/return`,
        body: { clientKey: key, reason: reason.trim(), expectedDeposit: held, ...(held > 0 ? { method: pay.method, ref: pay.ref.trim() } : {}) },
        summary: `${member.name} ${what}${current ? `（卡号尾号 ${current.cardNo.slice(-4)}）` : ''}${held > 0 ? ` ${formatYuan(held)}` : ''}`,
        staffName: session.staff.displayName,
      });
      toast({
        tone: 'success',
        title: current ? '已退卡' : '已退押金',
        body: held > 0 ? `${member.name}：退押金 ${formatYuan(held)}（${PAYMENT_METHOD_LABELS[pay.method]}）` : `${member.name} 的卡已退回`,
      });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: `${what}：没收到结果`, body: '记录留在本机，在「会员卡」上方查回、按原内容重新提交或确认作废' });
        onDone();
        onClose();
      } else {
        setError(errorMessage(e));
        setKey(uuid());
        if (e instanceof ApiError && SHIFT_ERRORS.includes(e.code)) void qc.invalidateQueries({ queryKey: shiftKeys.all });
        // 押着的押金刚有变化：刷新以后按最新的再办
        if (e instanceof ApiError && DEPOSIT_ERRORS.includes(e.code)) onDone();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${member.name}：${what}`}
      description={
        current
          ? `卡号 ${current.cardNo} 退回来以后记「已退卡」，这张卡不能再刷；卡号可以再发给别人。${held > 0 ? '押着的押金全额退。' : '这位会员没有押金。'}`
          : '原卡已挂失、不补卡了：把押着的押金全额退给客人。'
      }
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" size="lg" loading={busy} disabled={!ok} onClick={() => void submit()} data-testid="member-card-return-submit">
            确认{what}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="原因" hint="至少 2 个字">
          <Input autoFocus data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：客人不再用卡了" maxLength={100} data-testid="member-card-return-reason" />
        </Field>
        {held > 0 && (
          <>
            <ShiftGate action="退押金" />
            <CardDepositFields kind="refund" amount={held} value={pay} onChange={setPay} disabled={busy} error={pay.ref || pay.method !== 'cash' ? payProblem : null} />
          </>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function LostDialog({ card, memberName, held, onClose, onDone }: { card: MemberCard; memberName: string; held: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/member-cards/${card.id}/lost`, { reason: reason.trim() });
      toast({ tone: 'success', title: '已挂失', body: `${memberName} 的卡（尾号 ${card.cardNo.slice(-4)}）从现在起不能用；补卡请点「补卡」` });
      onDone();
      onClose();
    } catch (e) {
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
      title={`挂失 ${memberName} 的卡`}
      description={`卡号 ${card.cardNo}。挂失后这张卡不能再用，找回也不解挂；之后给会员补一张新卡。${held > 0 ? `押金 ${formatYuan(held)} 照旧押着：补卡沿用，不补了在「退押金」里退。` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={() => void submit()} data-testid="member-card-lost-submit">
            确认挂失
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="原因">
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：客人来电说卡丢了" maxLength={100} data-testid="member-card-lost-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
