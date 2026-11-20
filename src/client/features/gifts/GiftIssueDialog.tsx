// 签赠发放（8.1.9，docs/GIFTS_V819.md 第 2.3 节）：找会员 → 选签赠券类型、张数 → 选授权人、渠道 → 写事由。
// 授权人只列有「签赠授权」的在职员工（只选、不输密码）；渠道默认是当前面板的部门。
// 带操作编号，提交前先把编号与原请求存在本机（存不了就不发）：没收到结果时关掉弹窗，页面上的「结果待确认」里能查回、重提或确认作废。

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Minus, Plus, Search, Signature, UserRound, X } from 'lucide-react';
import { formatStoreCouponCode } from '@shared/coupons';
import { MAX_GIFT_QUANTITY, type GiftIssueResult, type GiftMemberOption } from '@shared/gifts';
import { NO_PHONE_LABEL } from '@shared/labels';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { useGiftAuthorizers, useGiftRules, useGiftTypes } from './queries';

export function GiftIssueDialog({
  defaultChannel,
  presetMember,
  onClose,
  onDone,
}: {
  defaultChannel?: string;
  /** 已经知道发给谁（8.1.15：收银台对着这位客人的账单发）：不用再找，也不能换成别人 */
  presetMember?: GiftMemberOption;
  onClose: () => void;
  onDone: () => Promise<unknown> | void;
}) {
  const session = useSession();
  const toast = useToast();
  const rules = useGiftRules();
  const types = useGiftTypes();
  const authorizers = useGiftAuthorizers();
  // 弹窗开着的时候一直用同一个操作编号
  const [clientKey] = useState(uuid);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [member, setMember] = useState<GiftMemberOption | null>(presetMember ?? null);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [quantity, setQuantity] = useState(1);
  const [qtyHint, setQtyHint] = useState<string | null>(null);
  const [authorizedBy, setAuthorizedBy] = useState<number | ''>('');
  const [channel, setChannel] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);
  const found = useQuery({
    queryKey: ['gifts', 'members', debounced],
    queryFn: () => api.get<GiftMemberOption[]>(`/api/gifts/members?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0 && !member,
  });
  // 渠道默认：当前面板的部门（在配置的选项里才选上）
  useEffect(() => {
    if (!channel && rules.data) setChannel(defaultChannel && rules.data.channels.includes(defaultChannel) ? defaultChannel : (rules.data.channels[0] ?? ''));
  }, [rules.data, defaultChannel, channel]);

  const active = (types.data ?? []).filter((t) => t.active);
  const picked = active.find((t) => t.id === templateId) ?? null;
  const off = rules.data && !rules.data.enabled;
  const locked = uncertain || saving;

  const submit = async () => {
    setError(null);
    if (!member) return setError('请先找到并选中会员');
    if (!picked) return setError('请选择签赠券类型');
    if (!authorizedBy) return setError('请选择授权人');
    if (!channel) return setError('请选择发放渠道');
    if (reason.trim().length < 2) return setError('请写事由（至少 2 个字）');
    setSaving(true);
    try {
      const authorizer = authorizers.data?.find((a) => a.id === authorizedBy)?.name ?? '';
      const result = await sendErpOp<GiftIssueResult>({
        key: clientKey,
        type: 'gift_issue',
        url: '/api/gifts/issues',
        body: { clientKey, memberId: member.id, templateId: picked.id, quantity, authorizedBy, channel, reason: reason.trim() },
        summary: `签赠 · ${member.name} · ${picked.name} × ${quantity} · 授权 ${authorizer}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `已发给 ${member.name}`, body: `${picked.name} × ${quantity}：${result.coupons.map((c) => formatStoreCouponCode(c.code)).join('、')}` });
      await onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        setUncertain(true);
        setError('没收到结果，不知道发没发出去。不要改内容，再点一次「发放」——发过了不会再发一次。也可以先关掉：这一笔在台账上方的「结果待确认」里，能查回、按原内容重新提交或确认作废。');
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const loading = rules.isPending || types.isPending || authorizers.isPending;
  const failed = (rules.isError && !rules.data) || (types.isError && !types.data) || (authorizers.isError && !authorizers.data);
  return (
    <Dialog
      open
      onClose={onClose}
      title="签赠发放"
      description="给会员发签赠券：选券种与授权人，前台结账时客人用掉。每一张都记着授权人、渠道与事由。"
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {uncertain ? '先关掉（在「结果待确认」里处理）' : '取消'}
          </Button>
          <Button variant="primary" icon={<Signature className="size-4" />} loading={saving} disabled={!!off || loading} onClick={() => void submit()} data-testid="gift-issue-save">
            发放
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="gift-issue-dialog">
        {loading ? (
          <Skeleton className="h-48" />
        ) : failed ? (
          <LoadFailed
            title="签赠的选项没取回来"
            onRetry={() => void Promise.all([rules.refetch(), types.refetch(), authorizers.refetch()])}
            retrying={rules.isFetching || types.isFetching || authorizers.isFetching}
          >
            {errorMessage(rules.error ?? types.error ?? authorizers.error)}
          </LoadFailed>
        ) : (
          <>
            {off && (
              <Notice tone="warning" title="签赠已关掉">
                店主在后台「签赠 → 配置」里关掉了签赠，现在不能发；已发的照常能用。
              </Notice>
            )}
            {rules.data?.generalRules && (
              <Notice tone="info" title="签赠总则">
                <span className="whitespace-pre-line">{rules.data.generalRules}</span>
              </Notice>
            )}
            <Field label="会员" htmlFor="gift-member-search" hint={member ? undefined : '手机号、卡号或姓名；还不是会员的先建档'}>
              {member ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper-2/50 px-3 py-2 text-[13.5px]" data-testid="gift-member-picked">
                  <UserRound className="size-4 text-ink-3" />
                  <span className="font-bold">{member.name}</span>
                  <span className="num text-ink-3">{member.memberNo}</span>
                  <span className="num text-ink-3">{member.phone ?? NO_PHONE_LABEL}</span>
                  <Badge tone="lake">L{member.grade}</Badge>
                  <span className="flex-1" />
                  {!presetMember && (
                    <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} disabled={locked} onClick={() => setMember(null)}>
                      换一位
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                    <Input id="gift-member-search" className="pl-9" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="输入后从下面选" data-testid="gift-member-search" />
                  </div>
                  {debounced &&
                    (found.isPending ? (
                      <Skeleton className="mt-2 h-10" />
                    ) : found.isError && !found.data ? (
                      <LoadFailed title="会员没查回来" className="mt-2" onRetry={() => void found.refetch()} retrying={found.isFetching}>
                        {errorMessage(found.error)}
                      </LoadFailed>
                    ) : found.data && found.data.length === 0 ? (
                      <p className="mt-2 text-[12.5px] text-ink-3">没有找到这位会员；还不是会员的请先在前台建档。</p>
                    ) : (
                      <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto" data-testid="gift-member-options">
                        {(found.data ?? []).map((m) => (
                          <li key={m.id}>
                            <button
                              type="button"
                              disabled={!m.usable}
                              onClick={() => setMember(m)}
                              className={cn(
                                'flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border px-3 py-1.5 text-left text-[13px]',
                                m.usable ? 'border-line bg-card hover:border-line-strong' : 'cursor-not-allowed border-dashed border-line text-ink-3',
                              )}
                              data-testid={`gift-member-${m.id}`}
                            >
                              <span className="font-bold">{m.name}</span>
                              <span className="num text-ink-3">{m.memberNo}</span>
                              <span className="num text-ink-3">{m.phone ?? NO_PHONE_LABEL}</span>
                              <span className="text-ink-3">L{m.grade}</span>
                              {!m.usable && <span className="text-[12px]">已停用或已合并，不能发</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ))}
                </>
              )}
            </Field>
            <Field label="签赠券类型" htmlFor="gift-type">
              <Select id="gift-type" value={templateId} disabled={locked} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : '')} data-testid="gift-type">
                <option value="">{active.length ? '请选择' : '知识库里还没有在用的签赠券类型'}</option>
                {active.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.giftSegment} · {t.summary}）
                  </option>
                ))}
              </Select>
            </Field>
            {picked && (
              <div className="rounded-md bg-paper-2/60 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2" data-testid="gift-type-info">
                <p>
                  <b className="text-ink">{picked.summary}</b> · 有效期：{picked.validityText}
                </p>
                {picked.giftContent && <p className="whitespace-pre-line">权益内容：{picked.giftContent}</p>}
                {picked.giftRules && <p className="whitespace-pre-line">规则说明：{picked.giftRules}</p>}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="张数" hint={qtyHint ?? `1–${MAX_GIFT_QUANTITY} 张`}>
                <div className="flex w-fit items-center rounded-md border border-line-strong bg-card">
                  <button
                    type="button"
                    aria-label="少一张"
                    disabled={locked || quantity <= 1}
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    className="tap relative flex size-10 items-center justify-center text-ink-2 hover:bg-paper-2 disabled:opacity-40"
                  >
                    <Minus className="size-3.5" />
                  </button>
                  <QtyInput
                    value={quantity}
                    max={MAX_GIFT_QUANTITY}
                    onChange={setQuantity}
                    onHint={setQtyHint}
                    label="签赠张数"
                    disabled={locked}
                    className="h-10 w-12 text-[15px]"
                    testId="gift-qty"
                  />
                  <button
                    type="button"
                    aria-label="多一张"
                    disabled={locked || quantity >= MAX_GIFT_QUANTITY}
                    onClick={() => setQuantity((q) => Math.min(MAX_GIFT_QUANTITY, q + 1))}
                    className="tap relative flex size-10 items-center justify-center text-ink-2 hover:bg-paper-2 disabled:opacity-40"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
              </Field>
              <Field label="授权人" htmlFor="gift-authorizer">
                <Select id="gift-authorizer" value={authorizedBy} disabled={locked} onChange={(e) => setAuthorizedBy(e.target.value ? Number(e.target.value) : '')} data-testid="gift-authorizer">
                  <option value="">请选择</option>
                  {(authorizers.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="发放渠道" htmlFor="gift-channel">
                <Select id="gift-channel" value={channel} disabled={locked} onChange={(e) => setChannel(e.target.value)} data-testid="gift-channel">
                  {(rules.data?.channels ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="事由" htmlFor="gift-reason">
              <Textarea
                id="gift-reason"
                rows={2}
                maxLength={200}
                value={reason}
                disabled={locked}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：老客户生日；投诉补偿；大客户维护"
                data-testid="gift-reason"
              />
            </Field>
          </>
        )}
        {error && (
          <Notice tone={uncertain ? 'warning' : 'error'} title={uncertain ? '结果待确认' : '没有发出'}>
            {error}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
