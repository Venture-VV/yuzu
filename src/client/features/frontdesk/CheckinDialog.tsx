import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Crown, Link2, Plus, Search, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
import {
  matchTags,
  normalizeTagCode,
  uniqueTagMatch,
  ZONE_LABELS,
  ZONES,
  type BoardTag,
  type CheckinResult,
  type FrontdeskRules,
  type Zone,
} from '@shared/frontdesk';
import { grantCovers, ticketGrantCovers, type TicketGrant, type TicketGrantItem, type TicketGrantRequest, type VipGrant, type VipGrantTag } from '@shared/grants';
import { isFreeTicket } from '@shared/checkout';
import { maskPhone } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { errorMessage } from '../../lib/api';
import { memberCodeOf, useMembers } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Input, Notice, Segmented, Select } from '../../components/ui';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { GroupMark, VipChip, ZONE_STYLE } from './parts';
import { BackfillNotice, backfillBody, backfillSummary, useBackfill } from './backfill';
import { PendingPanel, useFrontdeskOp } from './pending';
import { useMemberGrade, useTicketTypes } from './queries';

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
  /** 票种；null 表示沿用默认票种（票种列表还没加载时） */
  ticketTypeId: number | null;
}

type TagStatus = { ok: true; tag: BoardTag } | { ok: false; message: string; choices?: BoardTag[] } | null;

/** 授权或等级相关的错误：清掉已有授权，请经理按当前内容重新授权 */
const GRANT_ERRORS = ['VIP_AUTH_REQUIRED', 'TICKET_AUTH_REQUIRED', 'GRANT_INVALID', 'GRANT_USED', 'GRANT_EXPIRED', 'GRANT_SCOPE'];

const issuable = (t: BoardTag) => t.active && !t.locked && !t.visit;

function statusOf(tags: BoardTag[], code: string, zone: Zone, usedElsewhere: Set<string>): TagStatus {
  const c = normalizeTagCode(code);
  if (!c) return null;
  let tag = tags.find((t) => t.code === c);
  if (!tag) {
    // 只输了末位：能唯一确定一张同分区空闲牌时提示回车补全；对上多张时要求点选，不自动取第一张；
    // 只匹配到在店 / 锁定的牌时直接说明原因
    const sameZone = matchTags(tags.filter((t) => t.zone === zone && !usedElsewhere.has(t.code)), c);
    const freeMatches = sameZone.filter(issuable);
    const unique = uniqueTagMatch(freeMatches, c);
    if (unique) return { ok: false, message: `按回车补全为 ${unique.code}` };
    if (freeMatches.length > 1) return { ok: false, message: `「${c}」对上 ${freeMatches.length} 张空闲牌，请点选实际拿到的`, choices: freeMatches.slice(0, 8) };
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
  rules,
  prefill,
  onClose,
  onDone,
}: {
  open: boolean;
  tags: BoardTag[];
  rules: FrontdeskRules | undefined;
  prefill: CheckinPrefill;
  onClose: () => void;
  onDone: (result: CheckinResult) => void;
}) {
  const can = useCan();
  const session = useSession();
  const [guestType, setGuestType] = useState<'walkin' | 'member'>('walkin');
  const [memberQ, setMemberQ] = useState('');
  const [member, setMember] = useState<MemberSummary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  /** 当场授权（值班经理 / 店总签发，5 分钟内一次有效）；只在有客人等级不够、要用 VIP 柜时使用 */
  const [grant, setGrant] = useState<VipGrant | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  /** 免票（例如 1 米以下儿童）的当场授权：同一次接待只授权一次（R1.2，店主 2026-10-29 签认） */
  const [ticketGrant, setTicketGrant] = useState<TicketGrant | null>(null);
  const [ticketReason, setTicketReason] = useState('1 米以下儿童');
  const [ticketAuthOpen, setTicketAuthOpen] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const members = useMembers(guestType === 'member' && !member ? memberQ.trim() : '');
  const ticketTypes = useTicketTypes();
  const defaultTicket = ticketTypes.data?.find((t) => t.isDefault)?.id ?? ticketTypes.data?.[0]?.id ?? null;
  const backfill = useBackfill();
  // 上一笔接待结果待确认时，先处理那一笔再发新牌（避免同一批客人被开两次牌）
  const op = useFrontdeskOp<CheckinResult>({
    type: 'checkin',
    visitId: null,
    staffName: session.staff.displayName,
    pick: (found) => ('checkin' in found ? found.checkin : null),
  });

  useResetOnOpen(open, () => {
    setGuestType('walkin');
    setMemberQ('');
    setMember(null);
    setRows([{ id: rowSeq++, zone: prefill.zone ?? 'male', code: prefill.tagCode ?? '', label: '', ticketTypeId: null }]);
    setGrant(null);
    setTicketGrant(null);
    setTicketReason('1 米以下儿童');
    op.clearError();
  });

  const freeOf = (zone: Zone, except: Set<string>) => tags.filter((t) => t.zone === zone && t.active && !t.locked && !t.visit && !except.has(t.code));

  const statuses = rows.map((r) => {
    const others = new Set(rows.filter((x) => x.id !== r.id).map((x) => normalizeTagCode(x.code)).filter(Boolean));
    return statusOf(tags, r.code, r.zone, others);
  });
  // VIP 柜：会员本人（第 1 位）按档级能用的柜子等级（会员规则里的对应表），其他同行与散客为 0
  const level = useMemberGrade(guestType === 'member' && member ? member.id : null);
  const guestLevelOf = (i: number): number | null => (i === 0 && guestType === 'member' && member ? (level.data?.lockerLevel ?? null) : 0);
  const vipRows = rows.map((r, i) => {
    const s = statuses[i];
    if (!s?.ok || s.tag.kind !== 'vip') return null;
    return { code: s.tag.code, memberId: i === 0 && guestType === 'member' && member ? member.id : null, tagLevel: s.tag.vipLevel!, guestLevel: guestLevelOf(i) };
  });
  const levelPending = vipRows.some((v) => v && v.guestLevel === null);
  const short = vipRows.filter((v): v is NonNullable<typeof v> => !!v && v.guestLevel !== null && v.guestLevel < v.tagLevel);
  const needs: VipGrantTag[] = short.map(({ code, memberId }) => ({ code, memberId }));
  const overrideOn = !!rules?.vipOverrideEnabled;
  const grantOk = needs.length === 0 || (!!grant && grantCovers(grant.scope, needs) && new Date(grant.expiresAt).getTime() > Date.now());
  // 选了免票的客人：要值班经理及以上当场授权（这几张牌、这个票种），同一次接待授权一次
  const freeItems: TicketGrantItem[] = rows.flatMap((r) => {
    const t = ticketTypes.data?.find((x) => x.id === (r.ticketTypeId ?? defaultTicket));
    const code = normalizeTagCode(r.code);
    return t && isFreeTicket(t) && code ? [{ tagCode: code, ticketTypeId: t.id }] : [];
  });
  const freeNames = [...new Set(freeItems.map((f) => ticketTypes.data?.find((t) => t.id === f.ticketTypeId)?.name ?? '免票'))].join('、');
  const ticketGrantOk =
    freeItems.length === 0 || (!!ticketGrant && ticketGrantCovers(ticketGrant.scope, freeItems) && new Date(ticketGrant.expiresAt).getTime() > Date.now());
  const ready =
    rows.length > 0 &&
    statuses.every((s) => s?.ok) &&
    (guestType === 'walkin' || !!member) &&
    !levelPending &&
    (needs.length === 0 || (overrideOn && grantOk)) &&
    ticketGrantOk;
  const guestText = (v: { memberId: number | null; guestLevel: number | null }) =>
    v.memberId && member ? `会员「${member.name}」（${level.data?.label ?? ''}，能用 ${v.guestLevel} 级柜）` : '散客 / 同行客人';
  const authLines = short.map((v) => `${guestText(v)} · VIP 柜 ${v.code}（第 ${v.tagLevel} 级）`);

  useEffect(() => {
    if (op.state.phase === 'error' && op.state.code && GRANT_ERRORS.includes(op.state.code)) {
      setGrant(null);
      setTicketGrant(null);
    }
  }, [op.state]);

  // 有待确认的接待时锁定内容；每次新提交都使用新的操作编号
  const locked = op.locked;
  const edit = (fn: () => void) => {
    if (locked) return;
    op.clearError();
    fn();
  };
  const update = (id: number, patch: Partial<Row>) => edit(() => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r))));

  /** 输入末位后回车 / 离开输入框：只有能唯一确定一张同分区空闲牌时才自动补全 */
  const complete = (r: Row) => {
    const c = normalizeTagCode(r.code);
    if (!c || tags.some((t) => t.code === c)) return;
    const used = new Set(rows.filter((x) => x.id !== r.id).map((x) => normalizeTagCode(x.code)));
    const unique = uniqueTagMatch(freeOf(r.zone, used), c);
    if (unique) update(r.id, { code: unique.code });
  };

  const pickMember = (m: MemberSummary) => {
    if (locked) return;
    op.clearError();
    setMember(m);
    if (m.gender) setRows((list) => list.map((r, i) => (i === 0 && !normalizeTagCode(r.code) ? { ...r, zone: m.gender! } : r)));
    setTimeout(() => firstInput.current?.focus(), 30);
  };
  // 扫到会员码（v0.7.25，小程序 MP9）：校验通过就直接选上这位会员（不用再点一下）
  useEffect(() => {
    if (memberCodeOf(memberQ) && members.isSuccess && members.data.length === 1) {
      pickMember(members.data[0]!);
      setMemberQ('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.isSuccess, members.data]);

  const submit = async () => {
    if (!ready || backfillBlocked) return;
    const codes = rows.map((r) => normalizeTagCode(r.code));
    const result = await op.submit((key) => ({
      url: '/api/frontdesk/checkins',
      body: {
        clientKey: key,
        joinVisitId: prefill.join?.visitId ?? null,
        guests: rows.map((r, i) => ({
          tagCode: normalizeTagCode(r.code),
          zone: r.zone,
          memberId: i === 0 && member ? member.id : null,
          guestLabel: r.label.trim(),
          ...((r.ticketTypeId ?? defaultTicket) ? { ticketTypeId: r.ticketTypeId ?? defaultTicket } : {}),
        })),
        vipGrantId: needs.length && grant ? grant.grantId : null,
        ticketGrantId: freeItems.length && ticketGrant ? ticketGrant.grantId : null,
        ...backfillBody(backfill),
      },
      tagCodes: codes,
      summary: `接待 ${rows.length} 位${member ? `（会员 ${member.name}）` : ''}${needs.length && grant ? `，VIP 柜 ${needs.map((n) => n.code).join('、')} 由${grant.approverName}授权` : ''}${freeItems.length && ticketGrant ? `，${freeItems.map((f) => f.tagCode).join('、')} 免票由${ticketGrant.approverName}授权` : ''}${backfillSummary(backfill)}`,
      amount: null,
    }));
    if (result) onDone(result);
  };

  const busy = op.busy;
  /** 补录模式下纸质单号或时间没填好：不能提交 */
  const backfillBlocked = backfill.state.active && !backfill.request;
  const groupHint = prefill.join ? '加入已在店客人的同行组' : rows.length > 1 ? `${rows.length} 位同行，自动建立同行组，离店时可合并结账` : null;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="接待发牌"
      description="从状态板点了手牌进来的，分区跟着手牌；输入牌号时先选男宾 / 女宾（输入末位即可，回车自动补全），牌号与分区不一致时不能发出"
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            共 <b className="num text-ink">{rows.length}</b> 位 · 门票离店结账时按在店时长计算（每 12 小时跳一档）
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ready || op.locked || backfillBlocked} loading={busy} onClick={submit} data-testid="checkin-submit">
            确认发牌{rows.length > 1 ? `（${rows.length} 张）` : ''}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={onDone} />
      <div className="space-y-4">
        <BackfillNotice action="接待" />
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
                {level.data && (
                  <p className="num flex items-center gap-1 text-[12px] font-semibold text-ink-2" data-testid="checkin-member-level">
                    <Crown className="size-3.5 text-yuzu-deep" /> {level.data.label} · 能用 {level.data.lockerLevel} 级及以下的 VIP 柜
                    {level.data.graceUntil && <span className="text-ember">· 补充期至 {level.data.graceUntil}</span>}
                    {level.data.trial && (
                      <span className="text-lake">
                        · 体验 {level.data.trial.label}（至 {level.data.trial.endsOn}，VIP 柜按体验的）
                      </span>
                    )}
                  </p>
                )}
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
              {memberCodeOf(memberQ) && members.error && (
                <li className="px-3 py-2 text-[13px] font-semibold text-clay" data-testid="checkin-member-code-error">
                  {errorMessage(members.error)}
                </li>
              )}
            </ul>
          </div>
        )}

        <ol className="space-y-2.5">
          {rows.map((r, i) => {
            const s = statuses[i];
            const used = new Set(rows.filter((x) => x.id !== r.id).map((x) => normalizeTagCode(x.code)));
            // 快捷建议只给普通柜；VIP 柜请按清单原样输入
            const next = freeOf(r.zone, used).find((t) => t.kind === 'normal');
            const v = vipRows[i];
            const vipShort = !!v && v.guestLevel !== null && v.guestLevel < v.tagLevel;
            // 分区跟着手牌走：牌号对上一张同分区的手牌（例如从状态板点了这张牌进来）就固定显示，不再给另一个分区选；
            // 还没填牌号时先选男宾 / 女宾（用来补全末位、提示空闲牌），选了女宾却填男宾牌的照样拦下
            const exact = tags.find((t) => t.code === normalizeTagCode(r.code));
            const fixedZone = exact && exact.zone === r.zone ? exact.zone : null;
            // 会员登记的性别与这张牌的分区不同：只提醒核对，不拦（性别是选填资料，可能登记错）
            const otherZone = i === 0 && member?.gender && s?.ok && s.tag.zone !== member.gender ? s.tag.zone : null;
            return (
              <li key={r.id} className={cn('rounded-lg border bg-card p-3', s && !s.ok ? 'border-clay/40' : 'border-line')} data-testid={`guest-row-${i}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="num flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-2 text-[13px] font-bold text-ink-2">{i + 1}</span>
                  {fixedZone ? (
                    <span
                      className={cn('flex h-10 min-w-[56px] items-center justify-center rounded-md px-3 text-[14px] font-bold', ZONE_STYLE[fixedZone].chip)}
                      title={`${exact!.code} 是${ZONE_LABELS[fixedZone].title}牌，分区跟着手牌；要换分区请先改牌号`}
                      data-testid={`guest-zone-${i}`}
                    >
                      {ZONE_LABELS[fixedZone].title}
                    </span>
                  ) : (
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
                  )}
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
                  {(ticketTypes.data?.length ?? 0) > 0 && (
                    <Select
                      fullWidth={false}
                      value={String(r.ticketTypeId ?? defaultTicket ?? '')}
                      onChange={(e) => update(r.id, { ticketTypeId: Number(e.target.value) })}
                      aria-label={`第 ${i + 1} 位票种`}
                      className="h-10 w-[150px] text-[13.5px]"
                      data-testid={`guest-ticket-${i}`}
                    >
                      {ticketTypes.data!.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} {t.price12h ? `¥${t.price12h / 100}` : '免票'}
                        </option>
                      ))}
                    </Select>
                  )}
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
                  {s?.ok && vipShort ? (
                    <span
                      className={cn('flex items-center gap-1 font-semibold', overrideOn ? 'text-yuzu-deep' : 'text-clay')}
                      role={overrideOn ? undefined : 'alert'}
                      data-testid={`vip-short-${i}`}
                    >
                      <VipChip level={v!.tagLevel} />
                      {s.tag.code} 是第 {v!.tagLevel} 级 VIP 柜，{v!.memberId ? `会员第 ${v!.guestLevel} 级不够` : '散客不能使用'}
                      {overrideOn
                        ? grant && grantCovers(grant.scope, [{ code: v!.code, memberId: v!.memberId }])
                          ? `；已由${grant.approverName}当场授权`
                          : '；需值班经理或店总当场授权'
                        : '；请换普通柜或等级相符的 VIP 柜'}
                    </span>
                  ) : s?.ok ? (
                    <span className="flex items-center gap-1 font-semibold text-pine">
                      <CircleCheck className="size-3.5" /> {s.tag.code} · {ZONE_LABELS[s.tag.zone].title}
                      {s.tag.kind === 'vip' ? ` VIP ${s.tag.vipLevel} 级柜` : '牌'} · {v?.guestLevel === null ? '核对会员等级…' : '空闲可发'}
                    </span>
                  ) : s ? (
                    <span className="flex items-center gap-1 font-semibold text-clay" role="alert">
                      <CircleAlert className="size-3.5" /> {s.message}
                    </span>
                  ) : (
                    <span className="text-ink-3">输入牌号，或</span>
                  )}
                  {s && !s.ok && s.choices?.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => update(r.id, { code: t.code })}
                      className="num rounded-full border border-yuzu-deep/40 bg-yuzu-tint px-2.5 py-0.5 font-bold text-ink hover:border-pine hover:text-pine"
                    >
                      {t.code}
                    </button>
                  ))}
                  {!s?.ok && !(s && 'choices' in s && s.choices) && next && (
                    <button type="button" onClick={() => update(r.id, { code: next.code })} className="rounded-full bg-paper-2 px-2 py-0.5 font-semibold text-ink-2 hover:bg-pine-soft hover:text-pine">
                      用 {next.code}
                    </button>
                  )}
                  {!next && !s?.ok && <span className="text-clay">{ZONE_LABELS[r.zone].title}区没有空闲普通柜</span>}
                  {i === 0 && member && <Badge tone="pine">会员本人</Badge>}
                  {otherZone && (
                    <span className="font-semibold text-clay" data-testid="guest-gender-mismatch">
                      会员登记的是{ZONE_LABELS[member!.gender!].title}，这张是{ZONE_LABELS[otherZone].title}牌，请核对
                    </span>
                  )}
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
            onClick={() => edit(() => setRows((list) => [...list, { id: rowSeq++, zone: list.at(-1)?.zone ?? 'male', code: '', label: '', ticketTypeId: list.at(-1)?.ticketTypeId ?? null }]))}
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

        {needs.length > 0 && overrideOn && (
          <Notice tone={grantOk ? 'success' : 'warning'} icon={<ShieldCheck className="size-4" />} title={grantOk && grant ? `已由${grant.approverName}当场授权` : 'VIP 柜需要当场授权'}>
            <div className="flex flex-wrap items-center gap-3">
              <span>
                {grantOk && grant
                  ? `授权 ${formatTime(grant.expiresAt)} 前有效，只能用于这一次发牌。`
                  : `${authLines.join('；')}。请值班经理、店总或店主输入账号密码授权。`}
              </span>
              {!grantOk && (
                <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} disabled={locked} onClick={() => setAuthOpen(true)} data-testid="request-authorize">
                  请经理授权
                </Button>
              )}
            </div>
          </Notice>
        )}

        {freeItems.length > 0 && (
          <Notice
            tone={ticketGrantOk ? 'success' : 'warning'}
            icon={<ShieldCheck className="size-4" />}
            title={ticketGrantOk && ticketGrant ? `免票已由${ticketGrant.approverName}当场授权` : `${freeNames}需要当场授权`}
          >
            <div className="flex flex-wrap items-center gap-2" data-testid="free-ticket-grant">
              {ticketGrantOk && ticketGrant ? (
                <span>
                  手牌 {freeItems.map((f) => f.tagCode).join('、')} 免票 · 原因：{ticketGrant.scope.reason}；{formatTime(ticketGrant.expiresAt)} 前有效，只能用于这一次接待。
                </span>
              ) : (
                <>
                  <span>手牌 {freeItems.map((f) => f.tagCode).join('、')} 选了免票，同一次接待请值班经理、店总或店主授权一次。</span>
                  <Input
                    fullWidth={false}
                    value={ticketReason}
                    onChange={(e) => {
                      setTicketReason(e.target.value);
                      setTicketGrant(null);
                    }}
                    maxLength={100}
                    disabled={locked}
                    className="h-9 min-w-0 flex-1 basis-40 text-[13px]"
                    aria-label="免票原因"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ShieldCheck className="size-4" />}
                    disabled={locked || ticketReason.trim().length < 2}
                    onClick={() => setTicketAuthOpen(true)}
                    data-testid="request-ticket-authorize"
                  >
                    请经理授权
                  </Button>
                </>
              )}
            </div>
          </Notice>
        )}

        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
      {ticketAuthOpen && (
        <AuthorizeDialog<TicketGrantRequest>
          open
          request={{ purpose: 'ticket_discount', scope: { items: freeItems, reason: ticketReason.trim() } }}
          lines={[`手牌 ${freeItems.map((f) => f.tagCode).join('、')} · ${freeNames}`, `原因：${ticketReason.trim()}`]}
          onClose={() => setTicketAuthOpen(false)}
          onGranted={(g) => {
            setTicketGrant(g);
            setTicketAuthOpen(false);
            op.clearError();
          }}
        />
      )}
      <AuthorizeDialog
        open={authOpen}
        request={{ purpose: 'vip_tag', scope: { tags: needs } }}
        lines={authLines}
        onClose={() => setAuthOpen(false)}
        onGranted={(g) => {
          setGrant(g);
          setAuthOpen(false);
          op.clearError();
        }}
      />
    </Dialog>
  );
}
