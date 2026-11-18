// 签赠知识库（8.1.9，docs/GIFTS_V819.md 第 2.1、2.2 节）：签赠券类型的清单、新建与修改。
// 一个类型 = 送什么（兑换一个项目或票种 / 一个金额以内的代金）、有效期，加知识库里的板块、权益内容、规则说明。
// 发过券以后送什么、有效期不能改（与券一样）；名称、板块、内容、规则、停用随时能改。

import { useState } from 'react';
import { BookOpen, PenLine, Plus } from 'lucide-react';
import { GIFT_KIND_LABELS, type GiftKind, type GiftType } from '@shared/gifts';
import { formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useGiftMeta, useGiftRules, useGiftTypes, useInvalidateGifts, type GiftMeta } from './queries';

export function GiftTypesTab() {
  const can = useCan();
  const types = useGiftTypes();
  const invalidate = useInvalidateGifts();
  const manage = can('gift.manage');
  const [editing, setEditing] = useState<GiftType | 'new' | null>(null);
  const list = types.data ?? [];
  return (
    <div className="space-y-3" data-testid="gift-types">
      {manage && <ErpPendingPanel types={['gift_type']} onFound={() => void invalidate()} />}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-ink-3">送什么、有效期，以及板块、权益内容、规则说明。全公司一套；发放、前台结账、台账都按这里的。</p>
        {manage && (
          <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="gift-type-new">
            新建签赠券类型
          </Button>
        )}
      </div>
      {types.isPending ? (
        <Skeleton className="h-40" />
      ) : types.isError && !types.data ? (
        <LoadFailed title="签赠知识库没取回来" onRetry={() => void types.refetch()} retrying={types.isFetching}>
          {errorMessage(types.error)}
        </LoadFailed>
      ) : list.length === 0 ? (
        <EmptyState art="leaf" title="还没有签赠券类型" description={manage ? '点「新建签赠券类型」：例如「签赠按摩 60 分钟」「签赠餐饮 ¥88」。' : undefined} className="py-8" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((t) => (
            <Card key={t.id} className={cn('p-4', !t.active && 'opacity-70')} data-testid={`gift-type-${t.id}`}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[15px] font-bold">
                    {t.name}
                    <Badge tone="lake">{t.giftSegment}</Badge>
                    {!t.active && <Badge tone="neutral">已停用</Badge>}
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-2">
                    {t.summary} · {t.validityText}
                  </p>
                </div>
                {manage && (
                  <Button size="sm" variant="ghost" icon={<PenLine className="size-3.5" />} onClick={() => setEditing(t)} data-testid={`gift-type-edit-${t.id}`}>
                    修改
                  </Button>
                )}
              </div>
              {(t.giftContent || t.giftRules) && (
                <div className="mt-2 space-y-1 rounded-md bg-paper-2/60 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
                  {t.giftContent && (
                    <p className="whitespace-pre-line">
                      <b className="text-ink">权益内容</b> {t.giftContent}
                    </p>
                  )}
                  {t.giftRules && (
                    <p className="whitespace-pre-line">
                      <b className="text-ink">规则说明</b> {t.giftRules}
                    </p>
                  )}
                </div>
              )}
              <p className="num mt-2 text-[12.5px] text-ink-3">
                发出 {t.issued} · 已使用 {t.used} · 未使用 {t.available} · 作废 {t.voided} · 过期 {t.expired}
              </p>
            </Card>
          ))}
        </div>
      )}
      {editing && <GiftTypeDialog type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => invalidate()} />}
    </div>
  );
}

type Validity = 'days' | 'fixed';
type ExchangeTarget = 'item' | 'ticket';

function GiftTypeDialog({ type, onClose, onDone }: { type: GiftType | null; onClose: () => void; onDone: () => Promise<unknown> }) {
  const session = useSession();
  const toast = useToast();
  const meta = useGiftMeta();
  const rules = useGiftRules();
  const [clientKey] = useState(uuid);
  const locked = !!type && type.issued > 0;
  const [name, setName] = useState(type?.name ?? '');
  const [kind, setKind] = useState<GiftKind>(type?.kind === 'cash' ? 'cash' : 'exchange');
  const [target, setTarget] = useState<ExchangeTarget>(type?.exchangeTicketTypeId ? 'ticket' : 'item');
  const [itemId, setItemId] = useState<number | ''>(type?.exchangeItemId ?? '');
  const [ticketId, setTicketId] = useState<number | ''>(type?.exchangeTicketTypeId ?? '');
  const [face, setFace] = useState(type?.faceValue ? (type.faceValue / 100).toFixed(2) : '');
  const [threshold, setThreshold] = useState(type?.threshold ? (type.threshold / 100).toFixed(2) : '');
  const [scope, setScope] = useState<'all' | 'categories'>(type?.scope === 'categories' ? 'categories' : 'all');
  const [categories, setCategories] = useState<string[]>(type?.scopeCategories ?? []);
  const [validity, setValidity] = useState<Validity>(type?.validity ?? 'days');
  const [days, setDays] = useState(String(type?.validDays ?? 30));
  const [validFrom, setValidFrom] = useState(type?.validFrom ?? session.today);
  const [validTo, setValidTo] = useState(type?.validTo ?? session.today);
  const [picked, setSegment] = useState(type?.giftSegment ?? '');
  const [content, setContent] = useState(type?.giftContent ?? '');
  const [rulesText, setRulesText] = useState(type?.giftRules ?? '');
  const [active, setActive] = useState(type?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const segments = rules.data ? (type && !rules.data.segments.includes(type.giftSegment) ? [type.giftSegment, ...rules.data.segments] : rules.data.segments) : [];
  // 还没选时默认第一个板块
  const segment = picked || segments[0] || '';

  const body = () => {
    const faceCents = parseYuan(face);
    const thresholdCents = threshold.trim() ? parseYuan(threshold) : 0;
    if (!name.trim()) throw new Error('请写名称');
    if (kind === 'exchange' && target === 'item' && !itemId) throw new Error('请选送哪个项目');
    if (kind === 'exchange' && target === 'ticket' && !ticketId) throw new Error('请选送哪个票种');
    if (kind === 'cash' && (faceCents === null || faceCents <= 0)) throw new Error('请写面额（大于 0，写到分）');
    if (kind === 'cash' && thresholdCents === null) throw new Error('门槛写成金额，不要门槛就留空');
    if (kind === 'cash' && scope === 'categories' && categories.length === 0) throw new Error('请勾适用的部门');
    if (validity === 'days' && !(Number(days) >= 1)) throw new Error('有效天数至少 1 天');
    if (validity === 'fixed' && validFrom > validTo) throw new Error('结束日期不能早于开始日期');
    if (!segment) throw new Error('请选板块');
    return {
      name: name.trim(),
      kind,
      faceValue: kind === 'cash' ? faceCents : null,
      threshold: kind === 'cash' ? thresholdCents : 0,
      scope: kind === 'cash' ? scope : 'all',
      scopeCategories: kind === 'cash' && scope === 'categories' ? categories : [],
      exchangeItemId: kind === 'exchange' && target === 'item' ? itemId || null : null,
      exchangeTicketTypeId: kind === 'exchange' && target === 'ticket' ? ticketId || null : null,
      validity,
      validDays: validity === 'days' ? Number(days) : null,
      validFrom: validity === 'fixed' ? validFrom : null,
      validTo: validity === 'fixed' ? validTo : null,
      note: type?.note ?? '',
      active,
      segment,
      content: content.trim(),
      rules: rulesText.trim(),
    };
  };

  const submit = async () => {
    setError(null);
    let payload: ReturnType<typeof body>;
    try {
      payload = body();
    } catch (e) {
      return setError((e as Error).message);
    }
    setSaving(true);
    try {
      if (type) {
        await api.put(`/api/gifts/types/${type.id}`, { ...payload, expectedVersion: type.version });
        toast({ tone: 'success', title: `已保存「${payload.name}」` });
      } else {
        await sendErpOp({
          key: clientKey,
          type: 'gift_type',
          url: '/api/gifts/types',
          body: { clientKey, ...payload },
          summary: `新建签赠券类型 · ${payload.name}（${payload.segment}）`,
          staffName: session.staff.displayName,
        });
        toast({ tone: 'success', title: `已新建「${payload.name}」` });
      }
      await onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError && !type) {
        setUncertain(true);
        setError('没收到结果，不知道建没建上。不要改内容，再点一次「保存」——建过了不会再建一个。也可以先关掉：这一笔在页面上方的「结果待确认」里处理。');
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const items = meta.data?.items.filter((i) => i.active || i.id === type?.exchangeItemId) ?? [];
  const byCategory = new Map<string, GiftMeta['items']>();
  for (const i of items) byCategory.set(i.category, [...(byCategory.get(i.category) ?? []), i]);
  const off = uncertain || saving;
  return (
    <Dialog
      open
      onClose={onClose}
      title={type ? `修改「${type.name}」` : '新建签赠券类型'}
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {uncertain ? '先关掉（在「结果待确认」里处理）' : '取消'}
          </Button>
          <Button variant="primary" icon={<BookOpen className="size-4" />} loading={saving} disabled={meta.isPending || rules.isPending} onClick={() => void submit()} data-testid="gift-type-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="gift-type-dialog">
        {meta.isError && !meta.data ? (
          <LoadFailed title="价目、票种没取回来" onRetry={() => void meta.refetch()} retrying={meta.isFetching}>
            {errorMessage(meta.error)}
          </LoadFailed>
        ) : null}
        {locked && (
          <Notice tone="info" title={`已经发过 ${type!.issued} 张`}>
            送什么、有效期不能改了；名称、板块、权益内容、规则说明、停用照常能改。要换送的东西请另建一个类型。
          </Notice>
        )}
        <Field label="名称" htmlFor="gift-type-name">
          <Input id="gift-type-name" maxLength={24} value={name} disabled={off} onChange={(e) => setName(e.target.value)} placeholder="例如：签赠按摩 60 分钟" data-testid="gift-type-name" />
        </Field>
        <Field label="送什么">
          <Segmented
            value={kind}
            onChange={(v) => !locked && setKind(v)}
            options={(['exchange', 'cash'] as const).map((k) => ({ value: k, label: GIFT_KIND_LABELS[k], disabled: locked || off }))}
            ariaLabel="签赠券的种类"
          />
        </Field>
        {kind === 'exchange' ? (
          <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
            <Segmented
              value={target}
              onChange={(v) => !locked && setTarget(v)}
              options={[
                { value: 'item' as const, label: '价目项目', disabled: locked || off },
                { value: 'ticket' as const, label: '票种', disabled: locked || off },
              ]}
              ariaLabel="兑换项目还是票种"
            />
            {target === 'item' ? (
              <Select aria-label="兑换的项目" value={itemId} disabled={locked || off} onChange={(e) => setItemId(e.target.value ? Number(e.target.value) : '')} data-testid="gift-type-item">
                <option value="">选一个项目</option>
                {[...byCategory.entries()].map(([cat, list]) => (
                  <optgroup key={cat} label={cat}>
                    {list.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            ) : (
              <Select aria-label="兑换的票种" value={ticketId} disabled={locked || off} onChange={(e) => setTicketId(e.target.value ? Number(e.target.value) : '')} data-testid="gift-type-ticket">
                <option value="">选一个票种</option>
                {(meta.data?.ticketTypes ?? [])
                  .filter((t) => t.active || t.id === type?.exchangeTicketTypeId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </Select>
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="面额（元）" htmlFor="gift-type-face">
                <MoneyInput id="gift-type-face" value={face} disabled={locked || off} onChange={(e) => setFace(e.target.value)} data-testid="gift-type-face" />
              </Field>
              <Field label="门槛（满多少能用，元）" htmlFor="gift-type-threshold" hint="不要门槛就留空">
                <MoneyInput id="gift-type-threshold" value={threshold} disabled={locked || off} onChange={(e) => setThreshold(e.target.value)} />
              </Field>
            </div>
            <Field label="能抵哪些">
              <Segmented
                value={scope}
                onChange={(v) => !locked && setScope(v)}
                options={[
                  { value: 'all' as const, label: '整张结账单', disabled: locked || off },
                  { value: 'categories' as const, label: '只抵勾选的部门', disabled: locked || off },
                ]}
                ariaLabel="代金券的适用范围"
              />
            </Field>
            {scope === 'categories' && (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {(meta.data?.categories ?? []).map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={categories.includes(c)}
                      disabled={locked || off}
                      onChange={(e) => setCategories((list) => (e.target.checked ? [...list, c] : list.filter((x) => x !== c)))}
                    />
                    {c}
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        <Field label="有效期">
          <Segmented
            value={validity}
            onChange={(v) => !locked && setValidity(v)}
            options={[
              { value: 'days' as const, label: '发放当天起 N 天', disabled: locked || off },
              { value: 'fixed' as const, label: '固定日期', disabled: locked || off },
            ]}
            ariaLabel="有效期"
          />
        </Field>
        {validity === 'days' ? (
          <Field label="有效天数" htmlFor="gift-type-days">
            <Input id="gift-type-days" type="number" min={1} max={3650} value={days} disabled={locked || off} onChange={(e) => setDays(e.target.value)} className="w-32" fullWidth={false} />
          </Field>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" aria-label="开始日期" fullWidth={false} className="w-[10rem]" value={validFrom} disabled={locked || off} onChange={(e) => setValidFrom(e.target.value)} />
            <span className="text-ink-3">至</span>
            <Input type="date" aria-label="结束日期" fullWidth={false} className="w-[10rem]" value={validTo} disabled={locked || off} onChange={(e) => setValidTo(e.target.value)} />
          </div>
        )}
        <Field label="板块" htmlFor="gift-type-segment" hint="板块的选项在「配置」里改">
          <Select id="gift-type-segment" value={segment} disabled={off} onChange={(e) => setSegment(e.target.value)} data-testid="gift-type-segment">
            {segments.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="权益内容" htmlFor="gift-type-content" hint="送什么、包含什么；发放与前台核销时照着看">
          <Textarea id="gift-type-content" rows={3} maxLength={1000} value={content} disabled={off} onChange={(e) => setContent(e.target.value)} data-testid="gift-type-content" />
        </Field>
        <Field label="规则说明" htmlFor="gift-type-rules" hint="谁能送、送给谁、有什么限制">
          <Textarea id="gift-type-rules" rows={3} maxLength={1000} value={rulesText} disabled={off} onChange={(e) => setRulesText(e.target.value)} data-testid="gift-type-rules" />
        </Field>
        {type && (
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={!active} disabled={off} onChange={(e) => setActive(!e.target.checked)} data-testid="gift-type-inactive" />
            停用（不能再发；已发的照常能用）
          </label>
        )}
        {kind === 'cash' && parseYuan(face) !== null && (parseYuan(face) ?? 0) > 0 && <p className="text-[12.5px] text-ink-3">结账时最多抵 {formatYuan(parseYuan(face)!)}。</p>}
        {error && (
          <Notice tone={uncertain ? 'warning' : 'error'} title={uncertain ? '结果待确认' : '没有保存'}>
            {error}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
