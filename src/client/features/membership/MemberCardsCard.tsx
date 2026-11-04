// 会员详情「会员卡」（v0.7.28 ⑦，docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）：会员实体卡的发卡、挂失、补卡。
//   · 卡只是认人：钱照旧在会员钱包里；发卡、补卡不收工本费；
//   · 读卡：读卡器（模拟键盘）把卡号打进输入框，或这台终端的设备服务（桥）报上来的读卡自动填进来；也可以手输；
//   · 挂失：原卡从此不能用（找回也不解挂），之后「补卡」发一张新卡；卡坏了直接「补卡」换下在用的那张（写原因）；
//   · 发卡带操作编号：没收到结果时在卡片上方查回、按原内容重新提交或确认作废。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { MEMBER_CARD_STATUS_LABELS, normalizeCardNo, MEMBER_CARD_RE, type MemberCard } from '@shared/member-cards';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, type ErpPendingOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';
import { useTerminalState } from '../devices/terminal';

const cardsKey = (memberId: number) => ['member', memberId, 'cards'] as const;
const STATUS_TONES = { active: 'moss', lost: 'clay', canceled: 'neutral' } as const;

export function MemberCardsCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: cardsKey(member.id), queryFn: () => api.get<MemberCard[]>(`/api/members/${member.id}/cards`) });
  const [issuing, setIssuing] = useState<null | 'issue' | 'replace'>(null);
  const [losing, setLosing] = useState<MemberCard | null>(null);
  // 发卡、挂失之后，查找框按卡号找人的结果也变了：会员查找的缓存一起作废（刚挂失就刷这张卡不能还找到人）
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: cardsKey(member.id) });
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['member-cards'] });
  };
  const ofMember = (op: ErpPendingOp) => op.url === `/api/members/${member.id}/cards`;
  if (cards.isPending) return <Skeleton className="h-20" />;
  if (cards.error || !cards.data) return <Notice tone="error" title={cards.error?.message ?? '会员卡没有加载出来'} />;
  const list = cards.data;
  const current = list.find((c) => c.status === 'active') ?? null;
  const hasLost = list.some((c) => c.status === 'lost');
  const usable = member.status === 'active' && !member.mergedIntoId;
  return (
    <Card className="p-5" data-testid="member-cards">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="N8：发卡、补卡不收工本费；挂失后原卡不能再用、找回也不解挂，补一张新卡（待店主确认）" />
            {can('member.card') && usable && !current && (
              <Button size="sm" variant="secondary" icon={<CreditCard className="size-3.5" />} onClick={() => setIssuing(hasLost ? 'replace' : 'issue')} data-testid="member-card-issue-open">
                {hasLost ? '补卡' : '发卡'}
              </Button>
            )}
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <CreditCard className="size-4 text-yuzu-deep" /> 会员卡
        </span>
      </SectionTitle>
      {can('member.card') && <ErpPendingPanel types={['member_card']} filter={ofMember} className="mt-3 space-y-2" onFound={() => void refresh()} />}
      {list.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">还没有发实体卡。刷卡找会员、结账认人用；钱照旧在会员钱包里。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13.5px]" data-testid={`member-card-${c.cardNo}`} data-status={c.status}>
              <span className="font-mono font-semibold">{c.cardNo}</span>
              <Badge tone={STATUS_TONES[c.status]}>{MEMBER_CARD_STATUS_LABELS[c.status]}</Badge>
              <span className="text-[12px] text-ink-3">
                {c.issuedByName} {formatDateTime(c.issuedAt)} 发
                {c.endedAt && ` · ${c.endedByName ?? ''} ${formatDateTime(c.endedAt)} ${c.status === 'lost' ? '挂失' : '换下'}（${c.endReason}）`}
              </span>
              {c.status === 'active' && can('member.card') && (
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setIssuing('replace')} data-testid="member-card-replace-open">
                    补卡
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setLosing(c)} data-testid={`member-card-lost-${c.cardNo}`}>
                    挂失
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {issuing && <IssueDialog member={member} mode={issuing} current={current} onClose={() => setIssuing(null)} onDone={() => void refresh()} />}
      {losing && <LostDialog card={losing} memberName={member.name} onClose={() => setLosing(null)} onDone={() => void refresh()} />}
    </Card>
  );
}

/**
 * 读卡输入框：读卡器（模拟键盘）把卡号打进来；这台终端的设备服务（桥）报上来的读卡也填进来（打开之后的新读卡）。
 * 按回车等于点确认。
 */
function CardNoInput({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
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
      autoFocus
      data-autofocus
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
  onClose,
  onDone,
}: {
  member: MemberDetail;
  mode: 'issue' | 'replace';
  current: MemberCard | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [cardNo, setCardNo] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const normalized = normalizeCardNo(cardNo);
  const replacingActive = mode === 'replace' && !!current;
  const ok = MEMBER_CARD_RE.test(normalized) && (!replacingActive || reason.trim().length >= 2);
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'member_card',
        url: `/api/members/${member.id}/cards`,
        body: { clientKey: key, cardNo: normalized, replace: mode === 'replace', replaceReason: replacingActive ? reason.trim() : '' },
        summary: `${member.name} ${mode === 'replace' ? '补卡' : '发卡'}（卡号尾号 ${normalized.slice(-4)}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: mode === 'replace' ? '已补卡' : '已发卡', body: `${member.name}：卡号 ${normalized}` });
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
            ? '原卡已挂失，发一张新卡。'
            : '卡只是认人：刷卡找到这位会员，钱照旧在会员钱包里。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={() => void submit()} data-testid="member-card-issue-submit">
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
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function LostDialog({ card, memberName, onClose, onDone }: { card: MemberCard; memberName: string; onClose: () => void; onDone: () => void }) {
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
      description={`卡号 ${card.cardNo}。挂失后这张卡不能再用，找回也不解挂；之后给会员补一张新卡。`}
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
