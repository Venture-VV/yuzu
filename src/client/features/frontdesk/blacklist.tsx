// 黑名单（8.1.15 发牌前风控，docs/FRONTDESK_RISK_V8115.md 第 3.1 节）：
//   · MemberBlacklistCard：会员详情里的黑名单入口——在不在、为什么、谁登记的；有「维护黑名单」的人加入 / 解除；
//   · BlacklistPane：后台「手牌与前台 → 黑名单」的清单——按会员或手机号登记、解除，能看已经解除的（留痕）。
// 登记只追加：同一位会员、同一个手机号同时只有一条没解除的，重复登记服务端拒绝。命中的会员发牌时被拒绝。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldBan, ShieldCheck, UserRound } from 'lucide-react';
import type { BlacklistEntry } from '@shared/frontdesk-risk';
import { maskPhone } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useMembers } from '../../lib/queries';
import { useCan, useReasons } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonChips } from '../../components/ReasonChips';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Button, Card, ConfirmCheck, Field, Input, Notice, SectionTitle, Segmented, Skeleton, Textarea } from '../../components/ui';
import { StatusChip } from './parts';

const key = {
  list: (all: boolean) => ['frontdesk', 'blacklist', all] as const,
  member: (id: number) => ['frontdesk', 'blacklist', 'member', id] as const,
};

/** 加入黑名单：给定会员时只填原因；没给时按会员查找或按手机号登记 */
function AddDialog({ member, onClose, onDone }: { member?: { id: number; name: string }; onClose: () => void; onDone: (entry: BlacklistEntry) => void }) {
  const reasons = useReasons('blacklistReasons');
  const [by, setBy] = useState<'member' | 'phone'>('member');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<MemberSummary | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const found = useMembers(!member && by === 'member' && !picked ? q.trim() : '');
  const target = member ?? picked;
  const phoneOk = /^1\d{10}$/.test(phone.trim());
  const ok = reason.trim().length >= 2 && (target ? true : by === 'phone' && phoneOk && name.trim().length > 0);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<BlacklistEntry>('/api/frontdesk/blacklist', target ? { memberId: target.id, reason: reason.trim() } : { phone: phone.trim(), name: name.trim(), reason: reason.trim() }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={member ? `把「${member.name}」加入黑名单` : '加入黑名单'}
      description="加入以后，这位会员发牌时会被拒绝（提示原因与登记人）；确有需要时由值班经理及以上解除。登记与解除都留痕。"
      footer={
        <>
          <Button size="lg" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="lg" variant="danger" disabled={!ok} loading={busy} onClick={submit} data-testid="blacklist-add-confirm">
            加入黑名单
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!member && (
          <>
            <Segmented
              value={by}
              onChange={(v) => {
                setBy(v);
                setPicked(null);
              }}
              ariaLabel="按什么登记"
              options={[
                { value: 'member', label: '按会员' },
                { value: 'phone', label: '按手机号（不是会员）' },
              ]}
            />
            {by === 'member' ? (
              picked ? (
                <p className="flex items-center gap-2 rounded-lg border border-line bg-paper/60 px-3 py-2 text-[14px]" data-testid="blacklist-picked">
                  <UserRound className="size-4 text-pine" />
                  <b>{picked.name}</b>
                  <span className="num text-[12.5px] text-ink-3">
                    {picked.memberNo} · {maskPhone(picked.phone)}
                  </span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPicked(null)}>
                    换人
                  </Button>
                </p>
              ) : (
                <Field label="找会员">
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="手机号 / 姓名 / 会员号" data-autofocus aria-label="查找会员" data-testid="blacklist-member-q" />
                  {q.trim() && (
                    <ul className="mt-1 space-y-1">
                      {found.data?.slice(0, 5).map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => setPicked(m)}
                            className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-paper-2"
                            data-testid={`blacklist-pick-${m.id}`}
                          >
                            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{m.name}</span>
                            <span className="num text-[12.5px] text-ink-3">{maskPhone(m.phone)}</span>
                          </button>
                        </li>
                      ))}
                      {found.isError && <li className="px-3 py-2 text-[13px] font-semibold text-clay">会员没查回来：{errorMessage(found.error)}</li>}
                      {found.data?.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">没有找到会员；不是会员的可以按手机号登记</li>}
                    </ul>
                  )}
                </Field>
              )
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="手机号" error={phone && !phoneOk ? '手机号应为 11 位数字' : null} hint="这个号码以后办了会员，发牌时照样拦">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" maxLength={11} className="num" aria-label="手机号" data-testid="blacklist-phone" />
                </Field>
                <Field label="称呼" hint="方便以后认人">
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} aria-label="称呼" data-testid="blacklist-name" />
                </Field>
              </div>
            )}
          </>
        )}
        <Field label="原因" hint="至少 2 个字；发牌被拒绝时会显示给当班的人">
          <ReasonChips reasons={reasons} value={reason} onPick={setReason} />
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label="加入黑名单的原因" data-testid="blacklist-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 解除：写原因，留痕 */
function useLift(onDone: () => void) {
  const toast = useToast();
  const [lifting, setLifting] = useState<BlacklistEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = (
    <ReasonDialog
      open={!!lifting}
      title={lifting ? `解除「${lifting.name}」的黑名单` : ''}
      description="解除以后这位照常发牌；原来的登记留着，以后还能再加入。"
      label="解除的原因"
      confirmLabel="解除"
      busy={busy}
      testId="blacklist-lift"
      onClose={() => setLifting(null)}
      onConfirm={async (reason) => {
        setBusy(true);
        try {
          await api.post(`/api/frontdesk/blacklist/${lifting!.id}/lift`, { reason });
          toast({ tone: 'success', title: `已解除「${lifting!.name}」的黑名单` });
          setLifting(null);
          onDone();
        } catch (e) {
          toast({ tone: 'error', title: '没有解除', body: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    />
  );
  return { open: setLifting, dialog };
}

/** 会员详情里的黑名单入口（能看会员的人都看得到在不在；加入、解除要「维护黑名单」） */
export function MemberBlacklistCard({ member }: { member: { id: number; name: string } }) {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: key.member(member.id), queryFn: () => api.get<{ entry: BlacklistEntry | null }>(`/api/frontdesk/blacklist/member/${member.id}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['frontdesk', 'blacklist'] });
  const lift = useLift(refresh);
  const manage = can('frontdesk.blacklist');
  const entry = q.data?.entry ?? null;
  // 不在黑名单、自己又不能加的：这一块不占地方
  if (q.isSuccess && !entry && !manage) return null;
  return (
    <Card className="p-5" data-testid="member-blacklist" data-listed={entry ? 'true' : 'false'}>
      <SectionTitle
        aside={
          manage && q.isSuccess ? (
            entry ? (
              <Button size="lg" variant="secondary" icon={<ShieldCheck className="size-4" />} onClick={() => lift.open(entry)} data-testid="member-blacklist-lift">
                解除
              </Button>
            ) : (
              <Button size="lg" variant="secondary" icon={<ShieldBan className="size-4" />} onClick={() => setAdding(true)} data-testid="member-blacklist-add">
                加入黑名单
              </Button>
            )
          ) : null
        }
      >
        黑名单
      </SectionTitle>
      {q.isPending ? (
        <Skeleton className="mt-3 h-8" />
      ) : q.isError && !q.data ? (
        <LoadFailed className="mt-3" title="黑名单没取回来" onRetry={() => void q.refetch()} retrying={q.isFetching}>
          {errorMessage(q.error)}
        </LoadFailed>
      ) : entry ? (
        <Notice tone="error" className="mt-3" icon={<ShieldBan className="size-4" />} title="在黑名单里：发牌时会被拒绝">
          原因：{entry.reason} · {entry.createdByName} {formatDateTime(entry.createdAt)} 登记{entry.phone ? `（按手机号 ${maskPhone(entry.phone)} 登记的）` : ''}
        </Notice>
      ) : (
        <p className="mt-2 text-[13px] text-ink-3">不在黑名单里。加入以后这位会员发牌时会被拒绝，确有需要再由值班经理及以上解除。</p>
      )}
      {adding && (
        <AddDialog
          member={member}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            refresh();
            toast({ tone: 'success', title: `「${member.name}」已加入黑名单` });
          }}
        />
      )}
      {lift.dialog}
    </Card>
  );
}

/** 后台的黑名单清单 */
export function BlacklistPane() {
  const toast = useToast();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: key.list(all), queryFn: () => api.get<BlacklistEntry[]>(`/api/frontdesk/blacklist${all ? '?all=1' : ''}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['frontdesk', 'blacklist'] });
  const lift = useLift(refresh);
  return (
    <Card className="p-5" data-testid="blacklist-pane">
      <SectionTitle
        aside={
          <Button size="lg" variant="secondary" icon={<ShieldBan className="size-4" />} onClick={() => setAdding(true)} data-testid="blacklist-add">
            加入黑名单
          </Button>
        }
      >
        黑名单
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">在名单里的会员发牌时会被拒绝，提示原因与登记人。按手机号登记的，这个号码以后办了会员照样拦。会员详情里也能加入、解除。</p>
      <div className="mt-3">
        <ConfirmCheck checked={all} onChange={setAll}>
          连已经解除的一起看
        </ConfirmCheck>
      </div>
      {list.isPending ? (
        <Skeleton className="mt-3 h-32" />
      ) : list.isError && !list.data ? (
        <LoadFailed className="mt-3" title="黑名单没取回来" onRetry={() => void list.refetch()} retrying={list.isFetching}>
          {errorMessage(list.error)}
        </LoadFailed>
      ) : list.data!.length === 0 ? (
        <EmptyState art="calm" title={all ? '还没有登记过黑名单' : '黑名单是空的'} description="点右上角「加入黑名单」按会员或手机号登记。" />
      ) : (
        <ul className="mt-3 space-y-2" data-testid="blacklist-list">
          {list.data!.map((e) => (
            <li key={e.id} className="rounded-lg border border-line bg-card px-4 py-3 text-[13.5px]" data-testid={`blacklist-${e.id}`} data-active={e.liftedAt ? 'false' : 'true'}>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <b className="text-[14px]">{e.name}</b>
                <span className="num text-[12.5px] text-ink-3">{e.memberNo ?? (e.phone ? `手机号 ${maskPhone(e.phone)}` : '')}</span>
                <StatusChip tone={e.liftedAt ? 'neutral' : 'clay'} icon={e.liftedAt ? <ShieldCheck className="size-4 shrink-0" /> : <ShieldBan className="size-4 shrink-0" />}>
                  {e.liftedAt ? '已解除' : '生效中'}
                </StatusChip>
                {!e.liftedAt && (
                  <Button size="lg" variant="secondary" className="ml-auto" onClick={() => lift.open(e)} data-testid={`blacklist-${e.id}-lift`}>
                    解除
                  </Button>
                )}
              </p>
              <p className="mt-1 break-all text-ink-2">原因：{e.reason}</p>
              <p className="num mt-0.5 text-[12px] text-ink-3">
                {e.createdByName} {formatDateTime(e.createdAt)} 登记
                {e.liftedAt && ` · ${e.liftedByName ?? ''} ${formatDateTime(e.liftedAt)} 解除：${e.liftReason ?? ''}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onDone={(entry) => {
            setAdding(false);
            refresh();
            toast({ tone: 'success', title: `「${entry.name}」已加入黑名单` });
          }}
        />
      )}
      {lift.dialog}
    </Card>
  );
}
