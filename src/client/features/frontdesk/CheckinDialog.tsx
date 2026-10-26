import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Link2, Plus, Search, Trash2, UserRound, Users } from 'lucide-react';
import {
  matchTags,
  normalizeTagCode,
  ZONE_LABELS,
  ZONES,
  type BoardTag,
  type CheckinResult,
  type Zone,
} from '@shared/frontdesk';
import { maskPhone } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { api } from '../../lib/api';
import { useMembers } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Input, Notice, Segmented } from '../../components/ui';
import { GroupMark, useKeyedSubmit, ZONE_STYLE } from './parts';

export interface CheckinPrefill {
  tagCode?: string;
  zone?: Zone;
  join?: { visitId: number; tagCode: string; groupNo: string | null };
}

interface Row {
  id: number;
  zone: Zone;
  code: string;
  label: string;
}

type TagStatus = { ok: true; tag: BoardTag } | { ok: false; message: string } | null;

const issuable = (t: BoardTag) => t.active && !t.locked && !t.visit;

function statusOf(tags: BoardTag[], code: string, zone: Zone, usedElsewhere: Set<string>): TagStatus {
  const c = normalizeTagCode(code);
  if (!c) return null;
  let tag = tags.find((t) => t.code === c);
  if (!tag) {
    // 只输了末位：同分区有空闲牌就提示回车补全；只匹配到在店 / 锁定的牌时直接说明原因
    const sameZone = matchTags(tags.filter((t) => t.zone === zone && !usedElsewhere.has(t.code)), c);
    const free = sameZone.find(issuable);
    if (free) return { ok: false, message: `按回车补全为 ${free.code}` };
    if (sameZone[0]) {
      tag = sameZone[0];
    } else {
      const other = matchTags(tags, c)[0];
      return { ok: false, message: other ? `${c} 只匹配到${ZONE_LABELS[other.zone].title}牌 ${other.code}` : `没有牌号 ${c}` };
    }
  }
  if (usedElsewhere.has(tag.code)) return { ok: false, message: `${tag.code} 已分给本次另一位客人` };
  if (!tag.active) return { ok: false, message: `${tag.code} 已停用` };
  if (tag.locked) return { ok: false, message: `${tag.code} 已锁定（${tag.lockReason}）` };
  if (tag.visit) return { ok: false, message: `${tag.code} 已在店，不能重复发出` };
  if (tag.zone !== zone) return { ok: false, message: `${tag.code} 是${ZONE_LABELS[tag.zone].title}牌，不能发给${ZONE_LABELS[zone].title}` };
  return { ok: true, tag };
}

let rowSeq = 1;

export function CheckinDialog({
  open,
  tags,
  prefill,
  onClose,
  onDone,
}: {
  open: boolean;
  tags: BoardTag[];
  prefill: CheckinPrefill;
  onClose: () => void;
  onDone: (result: CheckinResult) => void;
}) {
  const can = useCan();
  const [guestType, setGuestType] = useState<'walkin' | 'member'>('walkin');
  const [memberQ, setMemberQ] = useState('');
  const [member, setMember] = useState<MemberSummary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const firstInput = useRef<HTMLInputElement>(null);
  const members = useMembers(guestType === 'member' && !member ? memberQ.trim() : '');
  const op = useKeyedSubmit<CheckinResult>((found) => (found as { checkin: CheckinResult }).checkin ?? null);

  useEffect(() => {
    if (!open) return;
    setGuestType('walkin');
    setMemberQ('');
    setMember(null);
    setRows([{ id: rowSeq++, zone: prefill.zone ?? 'male', code: prefill.tagCode ?? '', label: '' }]);
    op.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const freeOf = (zone: Zone, except: Set<string>) => tags.filter((t) => t.zone === zone && t.active && !t.locked && !t.visit && !except.has(t.code));

  const statuses = rows.map((r) => {
    const others = new Set(rows.filter((x) => x.id !== r.id).map((x) => normalizeTagCode(x.code)).filter(Boolean));
    return statusOf(tags, r.code, r.zone, others);
  });
  const ready = rows.length > 0 && statuses.every((s) => s?.ok) && (guestType === 'walkin' || !!member);

  // 结果待确认时锁定内容（先查回）；被明确拒绝后改了内容，换一个新的操作编号再提交
  const locked = op.state.phase === 'uncertain' || op.state.phase === 'busy';
  const edit = (fn: () => void) => {
    if (locked) return;
    if (op.state.phase === 'error') op.reset();
    fn();
  };
  const update = (id: number, patch: Partial<Row>) => edit(() => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r))));

  /** 输入末位后回车 / 离开输入框：只有一张同分区空闲牌匹配时自动补全牌号 */
  const complete = (r: Row) => {
    const c = normalizeTagCode(r.code);
    if (!c || tags.some((t) => t.code === c)) return;
    const used = new Set(rows.filter((x) => x.id !== r.id).map((x) => normalizeTagCode(x.code)));
    const candidates = matchTags(freeOf(r.zone, used), c);
    if (candidates[0]) update(r.id, { code: candidates[0].code });
  };

  const pickMember = (m: MemberSummary) => {
    if (op.state.phase === 'error') op.reset();
    setMember(m);
    if (m.gender) setRows((list) => list.map((r, i) => (i === 0 && !normalizeTagCode(r.code) ? { ...r, zone: m.gender! } : r)));
    setTimeout(() => firstInput.current?.focus(), 30);
  };

  const submit = async () => {
    if (!ready) return;
    const result = await op.submit((key) =>
      api.post<CheckinResult>('/api/frontdesk/checkins', {
        clientKey: key,
        joinVisitId: prefill.join?.visitId ?? null,
        guests: rows.map((r, i) => ({
          tagCode: normalizeTagCode(r.code),
          zone: r.zone,
          memberId: i === 0 && member ? member.id : null,
          guestLabel: r.label.trim(),
        })),
      }),
    );
    if (result) onDone(result);
  };

  const busy = op.state.phase === 'busy';
  const groupHint = prefill.join ? '加入已在店客人的同行组' : rows.length > 1 ? `${rows.length} 位同行，自动建立同行组，离店时可合并结账` : null;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="接待发牌"
      description="选择宾客分区后输入牌号（输入末位即可，回车自动补全）；牌号与分区不一致时不能发出"
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            共 <b className="num text-ink">{rows.length}</b> 位 · 本阶段只发牌挂账，不收款、不扣会员余额
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ready} loading={busy} onClick={submit} data-testid="checkin-submit">
            确认发牌{rows.length > 1 ? `（${rows.length} 张）` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {prefill.join && (
          <Notice tone="info" icon={<Link2 className="size-4" />} title={`与 ${prefill.join.tagCode} 同行`}>
            新发的手牌会加入 {prefill.join.tagCode} 的同行组
            {prefill.join.groupNo ? <GroupMark groupNo={prefill.join.groupNo} className="ml-1.5 align-middle" /> : '（自动新建）'}。
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={guestType}
            onChange={(v) =>
              edit(() => {
                setGuestType(v);
                if (v === 'walkin') setMember(null);
              })
            }
            ariaLabel="客人类型"
            options={[
              { value: 'walkin', label: '散客' },
              ...(can('member.read') ? [{ value: 'member' as const, label: '会员' }] : []),
            ]}
          />
          {guestType === 'member' && member && (
            <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-pine/25 bg-pine-tint px-3 py-2" data-testid="checkin-member">
              <UserRound className="size-4 shrink-0 text-pine" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-bold">
                  {member.name} <span className="num text-[12px] font-semibold text-ink-3">{member.memberNo}</span>
                </p>
                <p className="num text-[12px] text-ink-3">
                  {maskPhone(member.phone)} · 余额 <Money cents={member.principalBalance + member.bonusBalance} /> <span className="text-ink-4">（仅显示）</span>
                </p>
              </div>
              {member.status === 'frozen' && <Badge tone="clay">已停用</Badge>}
              <Button size="sm" variant="ghost" onClick={() => edit(() => setMember(null))}>
                换人
              </Button>
            </div>
          )}
        </div>

        {guestType === 'member' && !member && (
          <div className="rounded-lg border border-line bg-paper/60 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
              <Input value={memberQ} onChange={(e) => setMemberQ(e.target.value)} placeholder="手机号 / 姓名 / 会员号" className="pl-9" aria-label="查找会员" data-autofocus />
            </div>
            <ul className="mt-2 space-y-1">
              {memberQ.trim() &&
                members.data?.slice(0, 5).map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => pickMember(m)}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-card"
                    >
                      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{m.name}</span>
                      <span className="num text-[12.5px] text-ink-3">{maskPhone(m.phone)}</span>
                      <span className="num text-[12px] text-ink-4">{m.memberNo}</span>
                    </button>
                  </li>
                ))}
              {memberQ.trim() && members.data?.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">没有找到会员，可先按散客接待</li>}
            </ul>
          </div>
        )}

        <ol className="space-y-2.5">
          {rows.map((r, i) => {
            const s = statuses[i];
            const used = new Set(rows.filter((x) => x.id !== r.id).map((x) => normalizeTagCode(x.code)));
            const next = freeOf(r.zone, used)[0];
            return (
              <li key={r.id} className={cn('rounded-lg border bg-card p-3', s && !s.ok ? 'border-clay/40' : 'border-line')} data-testid={`guest-row-${i}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="num flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-2 text-[13px] font-bold text-ink-2">{i + 1}</span>
                  <div role="radiogroup" aria-label={`第 ${i + 1} 位宾客分区`} className="flex gap-1">
                    {ZONES.map((z) => (
                      <button
                        key={z}
                        type="button"
                        role="radio"
                        aria-checked={r.zone === z}
                        onClick={() => update(r.id, { zone: z })}
                        className={cn(
                          'h-10 min-w-[56px] rounded-md border px-3 text-[14px] font-bold transition-colors',
                          r.zone === z ? cn(ZONE_STYLE[z].chip, 'border-transparent ring-2 ring-current/25') : 'border-line bg-card text-ink-3 hover:text-ink',
                        )}
                      >
                        {ZONE_LABELS[z].title}
                      </button>
                    ))}
                  </div>
                  <div className="relative w-[132px]">
                    <Input
                      ref={i === 0 && (guestType === 'walkin' || member) ? firstInput : undefined}
                      data-autofocus={i === 0 && guestType === 'walkin' ? true : undefined}
                      fullWidth={false}
                      value={r.code}
                      onChange={(e) => update(r.id, { code: e.target.value.toUpperCase() })}
                      onBlur={() => complete(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          complete(r);
                        }
                      }}
                      placeholder="牌号"
                      inputMode="text"
                      aria-label={`第 ${i + 1} 位牌号`}
                      invalid={!!s && !s.ok}
                      className="num h-10 w-full text-[18px] font-bold tracking-wide"
                    />
                  </div>
                  <Input
                    fullWidth={false}
                    value={r.label}
                    onChange={(e) => update(r.id, { label: e.target.value })}
                    placeholder={i === 0 && member ? '会员本人' : '称呼（选填）'}
                    maxLength={16}
                    aria-label={`第 ${i + 1} 位称呼`}
                    className="h-10 min-w-0 flex-1 basis-28"
                  />
                  {rows.length > 1 && (
                    <button
                      type="button"
                      aria-label={`移除第 ${i + 1} 位`}
                      onClick={() => edit(() => setRows((list) => list.filter((x) => x.id !== r.id)))}
                      className="flex size-10 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
                <div className="mt-2 flex min-h-5 flex-wrap items-center gap-2 pl-[38px] text-[12.5px]">
                  {s?.ok ? (
                    <span className="flex items-center gap-1 font-semibold text-pine">
                      <CircleCheck className="size-3.5" /> {s.tag.code} · {ZONE_LABELS[s.tag.zone].title}牌 · 空闲可发
                    </span>
                  ) : s ? (
                    <span className="flex items-center gap-1 font-semibold text-clay" role="alert">
                      <CircleAlert className="size-3.5" /> {s.message}
                    </span>
                  ) : (
                    <span className="text-ink-3">输入牌号，或</span>
                  )}
                  {!s?.ok && next && (
                    <button type="button" onClick={() => update(r.id, { code: next.code })} className="rounded-full bg-paper-2 px-2 py-0.5 font-semibold text-ink-2 hover:bg-pine-soft hover:text-pine">
                      用 {next.code}
                    </button>
                  )}
                  {!next && !s?.ok && <span className="text-clay">{ZONE_LABELS[r.zone].title}区没有空闲手牌</span>}
                  {i === 0 && member && <Badge tone="pine">会员本人</Badge>}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={rows.length >= 12}
            onClick={() => edit(() => setRows((list) => [...list, { id: rowSeq++, zone: list.at(-1)?.zone ?? 'male', code: '', label: '' }]))}
          >
            添加同行客人
          </Button>
          {groupHint && (
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-pine">
              <Users className="size-4" />
              {groupHint}
            </span>
          )}
        </div>

        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
        {op.state.phase === 'uncertain' && (
          <Notice
            tone="warning"
            title="结果待确认"
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const r = await op.check();
                  if (r) onDone(r);
                }}
              >
                查回结果
              </Button>
            }
          >
            {op.state.message}。请先查回结果，不要换一张牌重新发。
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
