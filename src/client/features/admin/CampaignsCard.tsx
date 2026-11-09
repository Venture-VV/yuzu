// 后台「券与会员权益 → 批量发券」（8.0.4 需求表 06，docs/MEMBERSHIP_V804.md 第 6 节）：按档级、标签圈一批会员发券，
// 先预览人数，再发；通知两个开关——短信、会员端弹窗（到账当天起弹，到期前 N 天再弹）。
// 发券走「结果待确认」：没收到结果时记在页面上方，查回、按原内容重新提交（同一编号，不会多发）或确认作废。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, MessageSquareText, Plus, Send, Smartphone } from 'lucide-react';
import {
  CAMPAIGN_STATUS_LABELS,
  DEFAULT_REMIND_DAYS,
  MAX_CAMPAIGN_MEMBERS,
  MAX_REMIND_DAYS,
  type CampaignPreview,
  type CouponCampaign,
  type CouponCampaignDetail,
} from '@shared/coupon-campaigns';
import { MAX_MANUAL_COUPONS } from '@shared/coupons';
import { groupTags } from '@shared/member-tags';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, downloadUrl, formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { couponKeys, templateExpired, useCouponMeta, useCouponTemplates, useInvalidateCoupons } from '../coupons/queries';
import { useMemberTags } from '../membership/TagPicker';

const campaignKeys = { list: ['coupons', 'campaigns'] as const, one: (id: number) => ['coupons', 'campaigns', id] as const };

export function CampaignsCard() {
  const list = useQuery({ queryKey: campaignKeys.list, queryFn: () => api.get<CouponCampaign[]>('/api/coupons/campaigns'), refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'issuing') ? 5000 : false) });
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const pending = useErpPending(['coupon_campaign']).length > 0;
  return (
    <Card className="p-5" data-testid="coupon-campaigns">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="HY07、HY08、HY16：一次最多 2,000 位；短信要在 .env 配阿里云短信，没配的导出手动发；会员端弹窗到账当天起弹、到期前 7 天再弹（待店主确认）" />
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} disabled={pending} onClick={() => setCreating(true)} data-testid="campaign-new">
              批量发券
            </Button>
          </span>
        }
      >
        批量发券
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        按档级、会员标签圈一批会员，每人发几张券，直接到会员账户。可以同时发短信、在会员端（小程序）弹窗提醒：到账当天起弹一次，到期前几天再弹一次。
        {pending && ' 有一笔批量发券还没收到结果：先在页面上方查回、重提或作废。'}
      </p>
      {list.isPending ? (
        <Skeleton className="mt-4 h-24" />
      ) : list.error ? (
        <Notice tone="error" className="mt-4" title={list.error.message} />
      ) : (list.data ?? []).length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有批量发过券</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="text-left text-[12px] text-ink-3">
              <tr>
                <th className="py-1.5 pr-3">发券单</th>
                <th className="py-1.5 pr-3">券</th>
                <th className="py-1.5 pr-3">发给谁</th>
                <th className="py-1.5 pr-3 text-right">到账 / 圈到</th>
                <th className="py-1.5 pr-3">短信</th>
                <th className="py-1.5 pr-3">弹窗</th>
                <th className="py-1.5 pr-3">状态</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {list.data!.map((c) => (
                <tr key={c.id} data-testid={`campaign-${c.campaignNo}`}>
                  <td className="py-2 pr-3">
                    <span className="num block font-semibold text-ink">{c.campaignNo}</span>
                    <span className="text-[12px] text-ink-3">
                      {formatDateTime(c.createdAt)} · {c.createdByName}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {c.templateName} × {c.quantity}
                  </td>
                  <td className="max-w-[220px] py-2 pr-3 text-ink-2">{c.audienceText}</td>
                  <td className="num py-2 pr-3 text-right whitespace-nowrap">
                    <b className="text-ink">{c.issued}</b> / {c.targeted}
                    {c.skipped > 0 && <span className="block text-[12px] text-ember">跳过 {c.skipped}</span>}
                  </td>
                  <td className="py-2 pr-3 text-[12px] whitespace-nowrap text-ink-2">{c.notifySms ? `已发 ${c.sms.sent} · 待发 ${c.sms.pending}${c.sms.failed ? ` · 失败 ${c.sms.failed}` : ''}` : '—'}</td>
                  <td className="py-2 pr-3 text-[12px] whitespace-nowrap text-ink-2">{c.notifyPopup ? `已读 ${c.notices.read} / ${c.notices.total}` : '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={c.status === 'done' ? 'pine' : 'ember'}>{CAMPAIGN_STATUS_LABELS[c.status]}</Badge>
                  </td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => setViewing(c.id)}>
                      详情
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CampaignDialog open={creating} onClose={() => setCreating(false)} onDone={(id) => setViewing(id)} />
      <CampaignDetailDialog id={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

function CampaignDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = useInvalidateCoupons();
  const templates = useCouponTemplates(open);
  const meta = useCouponMeta();
  const tags = useMemberTags(open);
  const [templateId, setTemplateId] = useState(0);
  const [quantity, setQuantity] = useState('1');
  const [grades, setGrades] = useState<number[]>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [tagMode, setTagMode] = useState<'any' | 'all'>('any');
  const [reason, setReason] = useState('');
  const [sms, setSms] = useState(false);
  const [popup, setPopup] = useState(true);
  const [remind, setRemind] = useState(String(DEFAULT_REMIND_DAYS));
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setTemplateId(0);
    setQuantity('1');
    setGrades([]);
    setTagIds([]);
    setTagMode('any');
    setReason('');
    setSms(false);
    setPopup(true);
    setRemind(String(DEFAULT_REMIND_DAYS));
    setPreview(null);
    setError(null);
  });
  const choices = (templates.data ?? []).filter((t) => t.active && !templateExpired(t, session.today));
  const template = choices.find((t) => t.id === templateId) ?? null;
  const audience = { grades, tagIds, tagMode };
  const n = Number(quantity);
  const days = Number(remind);
  const problem = !template
    ? '请选择券'
    : !Number.isInteger(n) || n < 1 || n > MAX_MANUAL_COUPONS
      ? `每人张数请填 1 到 ${MAX_MANUAL_COUPONS}`
      : popup && (!Number.isInteger(days) || days < 1 || days > MAX_REMIND_DAYS)
        ? `到期前几天请填 1 到 ${MAX_REMIND_DAYS}`
        : reason.trim().length < 2
          ? '请填写发券原因（至少 2 个字）'
          : null;
  // 圈选条件改了，预览作废
  const resetPreview = () => setPreview(null);

  const doPreview = async () => {
    if (!template) return;
    setBusy('preview');
    setError(null);
    try {
      setPreview(await api.post<CampaignPreview>('/api/coupons/campaigns/preview', { templateId: template.id, audience }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const send = async () => {
    if (problem || !template || !preview) return;
    setBusy('send');
    setError(null);
    const key = uuid();
    try {
      const c = await sendErpOp<CouponCampaignDetail>({
        key,
        type: 'coupon_campaign',
        url: '/api/coupons/campaigns',
        body: { clientKey: key, templateId: template.id, quantity: n, audience, reason: reason.trim(), notifySms: sms, notifyPopup: popup, remindDays: popup ? days : DEFAULT_REMIND_DAYS },
        summary: `${template.name} × ${n} 张 · ${preview.count} 位会员`,
        staffName: session.staff.displayName,
      });
      void qc.invalidateQueries({ queryKey: campaignKeys.list });
      void invalidate();
      toast({ tone: 'success', title: `已发给 ${c.issued} 位会员`, body: `${c.campaignNo}：${c.templateName} × ${c.quantity}${c.skipped ? `，跳过 ${c.skipped} 位（详情里看原因）` : ''}` });
      onClose();
      onDone(c.id);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '批量发券：没收到结果', body: '可能已经发了。这笔记在页面上方「结果待确认」里：先查回；查不到就按原内容重新提交（同一编号，不会多发）或确认作废。' });
        onClose();
      } else {
        setError(errorMessage(e));
        if (e instanceof ApiError && ['TEMPLATE_INACTIVE', 'TEMPLATE_EXPIRED'].includes(e.code)) void qc.invalidateQueries({ queryKey: couponKeys.templates });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="批量发券"
      description="圈一批会员发券，直接到会员账户；先预览人数再发"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={!!busy}>
            取消
          </Button>
          <Button variant="secondary" icon={<Eye className="size-4" />} loading={busy === 'preview'} disabled={!template || !!busy} onClick={() => void doPreview()} data-testid="campaign-preview">
            预览人数
          </Button>
          <Button
            variant="primary"
            icon={<Send className="size-4" />}
            loading={busy === 'send'}
            disabled={!!problem || !preview || preview.count === 0 || preview.tooMany || !!busy}
            onClick={() => void send()}
            data-testid="campaign-submit"
          >
            {preview ? `发给 ${preview.count - preview.outOfLevel} 位` : '发券'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="发哪张券" htmlFor="campaign-template">
            <Select
              id="campaign-template"
              value={templateId}
              onChange={(e) => {
                setTemplateId(Number(e.target.value));
                resetPreview();
              }}
              data-testid="campaign-template"
            >
              <option value={0}>请选择</option>
              {choices.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.summary}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="每人几张" htmlFor="campaign-qty">
            <Input id="campaign-qty" value={quantity} inputMode="numeric" onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} data-testid="campaign-quantity" />
          </Field>
        </div>
        <Field label="档级" hint="不选 = 全部档级；只发在用的会员（停用、合并的不发）">
          <div className="flex flex-wrap gap-1.5">
            {(meta.data?.levels ?? []).map((l) => (
              <button
                key={l.level}
                type="button"
                aria-pressed={grades.includes(l.level)}
                onClick={() => {
                  setGrades(grades.includes(l.level) ? grades.filter((g) => g !== l.level) : [...grades, l.level]);
                  resetPreview();
                }}
                className={cn('h-8 rounded-full px-3 text-[12.5px] font-semibold ring-1', grades.includes(l.level) ? 'bg-pine text-paper ring-pine' : 'bg-card text-ink-2 ring-line hover:ring-ink-3')}
                data-testid={`campaign-grade-${l.level}`}
              >
                {l.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="会员标签" hint="不选 = 不按标签">
          <div className="space-y-1.5">
            {groupTags((tags.data ?? []).filter((t) => t.active)).map((g) => (
              <div key={g.group || '-'} className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 shrink-0 text-[12px] font-semibold text-ink-3">{g.group || '其他'}</span>
                {g.tags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tagIds.includes(t.id)}
                    onClick={() => {
                      setTagIds(tagIds.includes(t.id) ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id]);
                      resetPreview();
                    }}
                    className={cn('h-7 rounded-full px-2.5 text-[12.5px] font-semibold ring-1', tagIds.includes(t.id) ? 'bg-pine text-paper ring-pine' : 'bg-card text-ink-2 ring-line hover:ring-ink-3')}
                    data-testid={`campaign-tag-${t.id}`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            ))}
            {tagIds.length > 1 && (
              <Segmented
                size="sm"
                ariaLabel="标签怎么匹配"
                value={tagMode}
                onChange={(v) => {
                  setTagMode(v);
                  resetPreview();
                }}
                options={[
                  { value: 'any', label: '有其中一个' },
                  { value: 'all', label: '同时都有' },
                ]}
              />
            )}
          </div>
        </Field>
        <Field label="发券原因" htmlFor="campaign-reason" hint="写进发券记录与审计，例如「双十一会员回馈」">
          <Textarea id="campaign-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="campaign-reason" />
        </Field>
        <div className="grid gap-2">
          <ConfirmCheck checked={sms} onChange={setSms}>
            <span className="flex items-center gap-1.5" data-testid="campaign-sms">
              <MessageSquareText className="size-4 text-pine" /> 发短信到会员手机号
            </span>
            <span className="block text-[12.5px] font-normal text-ink-3">「【{session.storeName}】您收到 N 张「券名」，有效期至……」。没配短信通道时留在待发箱，发券单详情里能导出名单手动发</span>
          </ConfirmCheck>
          <ConfirmCheck checked={popup} onChange={setPopup}>
            <span className="flex items-center gap-1.5" data-testid="campaign-popup">
              <Smartphone className="size-4 text-pine" /> 会员端（小程序）弹窗提醒
            </span>
            <span className="block text-[12.5px] font-normal text-ink-3">到账当天起弹「您收到 N 张券」；到期前几天再弹一次，看过就不再弹</span>
          </ConfirmCheck>
          {popup && (
            <Field label="到期前几天再提醒" htmlFor="campaign-remind">
              <Input id="campaign-remind" value={remind} inputMode="numeric" className="w-28" fullWidth={false} onChange={(e) => setRemind(e.target.value.replace(/\D/g, ''))} data-testid="campaign-remind" />
            </Field>
          )}
        </div>
        {preview && (
          <Notice
            tone={preview.tooMany || preview.count === 0 ? 'error' : 'info'}
            title={
              preview.tooMany
                ? `圈到 ${preview.count} 位，一次最多 ${MAX_CAMPAIGN_MEMBERS} 位：请缩小范围、分几次发`
                : preview.count === 0
                  ? '按这个条件圈到的会员是 0 位'
                  : `圈到 ${preview.count} 位会员${preview.outOfLevel ? `，其中 ${preview.outOfLevel} 位档级不在券限定的档级里、会跳过` : ''}`
            }
          >
            <span data-testid="campaign-preview-result">
              {preview.validTo && `券有效期到 ${preview.validTo}。`}
              {preview.sample.length > 0 && `前几位：${preview.sample.map((m) => `${m.name}（${m.gradeLabel}）`).join('、')}${preview.count > preview.sample.length ? '……' : ''}`}
            </span>
          </Notice>
        )}
        {!preview && template && <p className="text-[12.5px] text-ink-3">先点「预览人数」，核对圈到的人数再发。</p>}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function CampaignDetailDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: campaignKeys.one(id ?? 0), queryFn: () => api.get<CouponCampaignDetail>(`/api/coupons/campaigns/${id}`), enabled: id !== null });
  const c = q.data;
  return (
    <Dialog open={id !== null} onClose={onClose} title={c ? `发券单 ${c.campaignNo}` : '发券单'} width="max-w-2xl">
      {!c ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-3 text-[13px]" data-testid="campaign-detail">
          <p>
            <b>{c.templateName}</b> × {c.quantity}（{c.templateSummary}）· 发给 {c.audienceText}
          </p>
          <p className="text-ink-2">原因：{c.reason}</p>
          <p className="text-ink-2">
            圈到 {c.targeted} 位：到账 <b className="text-ink">{c.issued}</b> 位{c.skipped ? `、跳过 ${c.skipped} 位` : ''}
            {c.pending ? `、还在发 ${c.pending} 位` : ''} · {CAMPAIGN_STATUS_LABELS[c.status]}
          </p>
          {c.notifySms && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-2">
                短信：已发 {c.sms.sent} · 待发 {c.sms.pending} · 失败 {c.sms.failed}
                {!c.smsProvider && '（没配短信通道，待发的请导出手动发）'}
              </span>
              {(c.sms.pending > 0 || c.sms.failed > 0) && (
                <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} onClick={() => downloadUrl(`/api/coupons/campaigns/${c.id}/sms.csv`)} data-testid="campaign-sms-export">
                  导出待发短信
                </Button>
              )}
            </div>
          )}
          {c.notifyPopup && (
            <p className="text-ink-2">
              会员端弹窗：{c.notices.total} 条，已读 {c.notices.read} 条（到期前 {c.remindDays} 天再提醒）
            </p>
          )}
          {c.skippedMembers.length > 0 && (
            <div>
              <p className="font-semibold text-ink-2">跳过的会员</p>
              <ul className="mt-1 max-h-48 divide-y divide-line/70 overflow-y-auto rounded-md border border-line">
                {c.skippedMembers.map((m) => (
                  <li key={m.memberId} className="px-3 py-1.5">
                    {m.name} <span className="num text-ink-3">{m.memberNo}</span> · {m.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
