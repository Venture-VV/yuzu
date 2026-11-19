// 新建 / 编辑会员档案。
// 8.1.15（《浴族系统需求汇总》会员 1、2，docs/MEMBERS_V8115.md）：新建分两步——先选卡类型（电子卡 / 实体卡 / 匿名卡），再填表；
// 选的类型固定在表单顶上，「上一步」回去改（填过的内容留着）。实体卡在同一笔里发卡、收押金；匿名卡手机号可以不留。
// 选填项显示不显示、必填不必填按后台「会员体系 → 渠道与标签 → 建档表单」的设置（按门店），服务端同样核对。
// 新建带操作编号：没收到结果时记录留在本机，会员列表上方查回、按原内容重新提交或确认作废（匿名卡没有手机号去重、实体卡同时收了押金）。

import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, CreditCard, Smartphone, VenetianMask } from 'lucide-react';
import type { MemberPhoneGrantRequest } from '@shared/grants';
import { formatPhone } from '@shared/labels';
import { MEMBER_CARD_RE, normalizeCardNo } from '@shared/member-cards';
import {
  ANONYMOUS_MEMBER_NAME,
  DEFAULT_MEMBER_FORM_RULES,
  MAX_PREFERRED_ITEM_LENGTH,
  MAX_PREFERRED_ITEMS,
  MEMBER_CARD_TYPE_HINTS,
  MEMBER_CARD_TYPE_LABELS,
  MEMBER_CARD_TYPES,
  splitPreferredItems,
  type MemberCardType,
  type MemberFormField,
} from '@shared/member-form';
import { MAX_GRADE, TIER_LABELS } from '@shared/membership';
import { formatYuan } from '@shared/money';
import type { MemberDetail, MemberSummary } from '@shared/types';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { qk } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, ConfirmCheck, Field, Input, Notice, Segmented, Select, Textarea } from '../../components/ui';
import { CardDepositFields, depositPayProblem, EMPTY_DEPOSIT_PAY, type DepositPayDraft } from '../membership/CardDepositFields';
import { CardNoInput } from '../membership/MemberCardsCard';
import { useMembershipRules } from '../membership/queries';
import { ReferrerPicker, type ReferrerChoice } from '../membership/ReferrerPicker';
import { TagPicker } from '../membership/TagPicker';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';

type Gender = 'female' | 'male' | 'unknown';

const CARD_TYPE_ICONS = { ecard: Smartphone, physical: CreditCard, anonymous: VenetianMask } as const;
/** 表单顶上那一枚卡类型的底色与字色（颜色配文字，不只靠颜色认） */
const CARD_TYPE_CLASSES = { ecard: 'bg-paper-2 text-ink', physical: 'bg-moss-soft text-moss', anonymous: 'bg-lake-soft text-lake' } as const;
/** 服务端按字段报的错放到哪个输入框下面（接口里的字段名 → 页面上的） */
const FIELD_ERRORS: Record<string, string> = {
  name: 'name',
  phone: 'phone',
  phoneReason: 'phoneReason',
  gender: 'gender',
  birthday: 'birthday',
  channel: 'channel',
  referrerMemberId: 'referrer',
  preferredItems: 'preferredItems',
  tagIds: 'tagIds',
  note: 'note',
  'card.cardNo': 'cardNo',
  'card.deposit.ref': 'depositRef',
  'deposit.ref': 'depositRef',
  'grade.reason': 'gradeReason',
};

/** 必填项标签后面的记号 */
const Req = () => (
  <span className="ml-0.5 text-clay" aria-hidden>
    *
  </span>
);

export function MemberFormDialog({
  open,
  member,
  prefill,
  onClose,
  onSaved,
  onOpenExisting,
}: {
  open: boolean;
  member?: MemberDetail | null;
  prefill?: string;
  onClose: () => void;
  onSaved: (m: MemberSummary) => void;
  onOpenExisting: (id: number) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const can = useCan();
  // 后台设的建档表单（登录时带下来；刚升级、会话里还没有的按默认）
  const rules = session.rules.memberForm ?? DEFAULT_MEMBER_FORM_RULES;
  const f = rules.fields;
  const creating = !member;
  // 启用的渠道；编辑时会员原来的渠道已停用也照常列出，不改就保留
  const channels = (session.rules.memberChannels ?? []).filter((c) => c.active || c.key === member?.channel);
  const membership = useMembershipRules();

  const [step, setStep] = useState<'type' | 'form'>('type');
  const [cardType, setCardType] = useState<MemberCardType>('ecard');
  /** 会员标签（8.0.4，替代原来的自定义字段） */
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<Gender>('unknown');
  const [birthday, setBirthday] = useState('');
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('');
  const [referrer, setReferrer] = useState<ReferrerChoice | null>(null);
  const [preferred, setPreferred] = useState('');
  // 会员等级：默认按规则自动；有「手动调整会员档阶」权限的可以当场指定
  const [gradeMode, setGradeMode] = useState<'auto' | 'manual'>('auto');
  const [grade, setGrade] = useState(1);
  const [tier, setTier] = useState<'0' | '1' | '2'>('0');
  const [gradeReason, setGradeReason] = useState('');
  // 实体卡：卡号与押金的收款方式；匿名卡可以选配不配卡
  const [withCard, setWithCard] = useState(false);
  const [cardNo, setCardNo] = useState('');
  const [pay, setPay] = useState<DepositPayDraft>(EMPTY_DEPOSIT_PAY);
  const [key, setKey] = useState(uuid);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<{ id: number; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 改手机号（v0.7.26，M77）：要写原因；没有「改会员手机号」权限的要值班经理及以上当场授权
  const [phoneReason, setPhoneReason] = useState('');
  const [authorizing, setAuthorizing] = useState(false);
  // 匿名卡转实名（8.1.15）：留了手机号的匿名卡可以转成电子卡
  const [toNamed, setToNamed] = useState(false);
  const cleanPhone = phone.replace(/[\s-]/g, '');
  const phoneChanged = !!member && cleanPhone !== (member.phone ?? '');
  const type: MemberCardType = member ? member.cardType : cardType;

  useResetOnOpen(open, () => {
    const digits = prefill?.replace(/\D/g, '') ?? '';
    setStep('type');
    setCardType('ecard');
    setName(member?.name ?? (prefill && !digits ? prefill : ''));
    setPhone(member?.phone ?? (digits.length >= 3 ? digits : ''));
    setGender(member?.gender ?? 'unknown');
    setBirthday(member?.birthday ?? '');
    setNote(member?.note ?? '');
    setChannel(member?.channel ?? '');
    setTagIds((member?.tags ?? []).map((t) => t.id));
    setReferrer(member?.referrer ?? null);
    setPreferred((member?.preferredItems ?? []).join('、'));
    setGradeMode('auto');
    setGrade(1);
    setTier('0');
    setGradeReason('');
    setWithCard(false);
    setCardNo('');
    setPay(EMPTY_DEPOSIT_PAY);
    setKey(uuid());
    setErrors({});
    setExisting(null);
    setPhoneReason('');
    setAuthorizing(false);
    setToNamed(false);
  }, [member, prefill]);

  const pickType = (t: MemberCardType) => {
    setCardType(t);
    // 匿名卡预填一个称呼（可以改）；换成别的类型时把预填的拿掉
    if (t === 'anonymous' && !name.trim()) setName(ANONYMOUS_MEMBER_NAME);
    if (t !== 'anonymous' && name === ANONYMOUS_MEMBER_NAME) setName('');
    setErrors({});
    setExisting(null);
    setStep('form');
  };

  const issuingCard = creating && (cardType === 'physical' || (cardType === 'anonymous' && withCard));
  const normalizedCard = normalizeCardNo(cardNo);
  const deposit = issuingCard ? rules.cardDeposit : 0;
  const shiftReady = useShiftReady(open && deposit > 0);
  const preferredItems = splitPreferredItems(preferred);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const save = async (phoneGrantId?: string) => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = '请填写会员姓名';
    // 手机号：匿名卡可以不留；留了的要是 11 位手机号
    if (cleanPhone ? !/^1\d{10}$/.test(cleanPhone) : type !== 'anonymous') errs.phone = '请输入 11 位手机号';
    else if (member?.phone && !cleanPhone) errs.phone = '手机号登记以后不能清空，只能改成别的号';
    if (phoneChanged && cleanPhone && phoneReason.trim().length < 2) errs.phoneReason = '改手机号要写原因（至少 2 个字）';
    if (toNamed && !cleanPhone) errs.phone = '转成实名的卡要先登记手机号';
    // 后台设成必填的选填项
    const missing: Record<MemberFormField, boolean> = {
      gender: gender === 'unknown',
      birthday: !birthday,
      channel: !channel,
      referrer: !referrer,
      preferredItems: preferredItems.length === 0,
      tags: tagIds.length === 0,
      note: !note.trim(),
    };
    const prompts: Record<MemberFormField, [string, string]> = {
      gender: ['gender', '请选择性别'],
      birthday: ['birthday', '请填写生日'],
      channel: ['channel', '请选择来源渠道'],
      referrer: ['referrer', '请选择推荐人'],
      preferredItems: ['preferredItems', '请填写偏好项目'],
      tags: ['tagIds', '请选择会员标签'],
      note: ['note', '请填写备注'],
    };
    for (const k of Object.keys(missing) as MemberFormField[]) {
      // 渠道一个都没启用时这一项不显示，也就不拦
      if (f[k].show && f[k].required && missing[k] && !(k === 'channel' && channels.length === 0)) errs[prompts[k][0]] = prompts[k][1];
    }
    if (f.preferredItems.show) {
      if (preferredItems.length > MAX_PREFERRED_ITEMS) errs.preferredItems = `偏好项目最多 ${MAX_PREFERRED_ITEMS} 个`;
      else if (preferredItems.some((x) => x.length > MAX_PREFERRED_ITEM_LENGTH)) errs.preferredItems = `每个偏好项目最多 ${MAX_PREFERRED_ITEM_LENGTH} 个字`;
    }
    if (creating && gradeMode === 'manual' && gradeReason.trim().length < 2) errs.gradeReason = '请填写指定等级的原因（至少 2 个字）';
    if (issuingCard && !MEMBER_CARD_RE.test(normalizedCard)) errs.cardNo = normalizedCard ? '卡号是 4–32 位数字或字母' : '请刷卡或输入卡号';
    const payProblem = deposit > 0 ? depositPayProblem(pay, 'receive') : null;
    if (payProblem) errs.depositRef = payProblem;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    // 没有「改会员手机号」权限：先请值班经理、店总或店主当场授权（授权绑定这位会员与新号码）
    if (phoneChanged && !can('member.phone') && !phoneGrantId) {
      setAuthorizing(true);
      return;
    }
    setSaving(true);
    setExisting(null);
    const common = {
      name: name.trim(),
      phone: cleanPhone || null,
      gender: gender === 'unknown' ? null : gender,
      birthday: birthday || null,
      note,
      tagIds,
      channel: channel || null,
      referrerMemberId: referrer?.id ?? null,
      preferredItems,
    };
    try {
      let saved: MemberSummary;
      if (member) {
        saved = await api.put<MemberDetail>(`/api/members/${member.id}`, {
          ...common,
          ...(phoneChanged ? { phoneReason: phoneReason.trim(), ...(phoneGrantId ? { phoneGrantId } : {}) } : {}),
          ...(toNamed ? { convertToNamed: true } : {}),
        });
      } else {
        const typeLabel = MEMBER_CARD_TYPE_LABELS[cardType];
        saved = await sendErpOp<MemberSummary>({
          key,
          type: 'member_create',
          url: '/api/members',
          body: {
            ...common,
            clientKey: key,
            cardType,
            grade: gradeMode === 'manual' ? { grade, tier: Number(tier), reason: gradeReason.trim() } : null,
            card: issuingCard ? { cardNo: normalizedCard, deposit: deposit > 0 ? { amount: deposit, method: pay.method, ref: pay.ref.trim() } : null } : null,
          },
          summary: `新建会员「${name.trim()}」（${typeLabel}${cleanPhone ? ` ${formatPhone(cleanPhone)}` : ''}${issuingCard ? `，卡号尾号 ${normalizedCard.slice(-4)}` : ''}${deposit > 0 ? `，收押金 ${formatYuan(deposit)}` : ''}）`,
          staffName: session.staff.displayName,
        });
      }
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['member', saved.id] });
      if (deposit > 0) void qc.invalidateQueries({ queryKey: shiftKeys.all });
      // 换手机号的记录列在「储值与账户」里（v0.7.26）
      if (phoneChanged) void qc.invalidateQueries({ queryKey: ['member-account-history', saved.id] });
      toast({
        tone: 'success',
        title: member ? '会员资料已更新' : `已为「${saved.name}」建档`,
        body: member ? undefined : `会员号 ${saved.memberNo} · ${MEMBER_CARD_TYPE_LABELS[saved.cardType]}${deposit > 0 ? ` · 收押金 ${formatYuan(deposit)}` : ''}`,
      });
      onSaved(saved);
    } catch (err) {
      if (err instanceof UncertainError && creating) {
        // 没收到结果：记录留在本机，会员列表上方查回、按原内容重新提交或确认作废；不要另建一位
        toast({ tone: 'info', title: '建档结果待确认', body: '已记在本机：请在会员列表上方查回、按原内容重新提交或确认作废，不要另建一位。' });
        onClose();
        return;
      }
      // 被明确拒绝：再提交是新的一笔，换一个操作编号
      if (creating) setKey(uuid());
      if (err instanceof ApiError && SHIFT_ERRORS.includes(err.code)) void qc.invalidateQueries({ queryKey: shiftKeys.all });
      // 押金金额、建档表单刚被后台改过：取最新的规则
      if (err instanceof ApiError && (err.code === 'CARD_DEPOSIT_REQUIRED' || err.code === 'CARD_DEPOSIT_CHANGED')) void qc.invalidateQueries({ queryKey: qk.session });
      const field = err instanceof ApiError && typeof err.details?.field === 'string' ? FIELD_ERRORS[err.details.field] : undefined;
      if (err instanceof ApiError && err.code === 'PHONE_EXISTS' && typeof err.details?.memberId === 'number') {
        setExisting({ id: err.details.memberId, message: err.message });
      } else if (err instanceof ApiError && field) {
        setErrors({ [field]: err.message });
        if (err.details?.field && field !== 'name' && field !== 'phone') void qc.invalidateQueries({ queryKey: qk.session });
      } else {
        setErrors({ form: errorMessage(err) });
      }
    } finally {
      setSaving(false);
    }
  };

  const onTypeStep = creating && step === 'type';
  const TypeIcon = CARD_TYPE_ICONS[type];
  const gradeNames = membership.data?.grades;
  const depositBlocked = deposit > 0 && !shiftReady.ready;
  const label = (text: string, required: boolean): ReactNode => (
    <>
      {text}
      {required && <Req />}
    </>
  );
  const optionalHint = (key: MemberFormField, hint: string) => (f[key].required ? hint : `选填，${hint}`);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-xl"
      title={member ? '编辑会员资料' : onTypeStep ? '新建会员 · 第 1 步：选卡类型' : '新建会员 · 第 2 步：填写资料'}
      description={member ? `${member.memberNo} · 余额与流水不受影响` : onTypeStep ? '不同的卡要填的不一样：先选卡类型，再填资料。' : '请与顾客当面核对。带 * 的必填。'}
      footer={
        onTypeStep ? (
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
        ) : (
          <>
            {creating && (
              <Button variant="ghost" size="lg" className="mr-auto" icon={<ChevronLeft className="size-4" />} onClick={() => setStep('type')} disabled={saving} data-testid="member-form-back">
                上一步
              </Button>
            )}
            <Button variant="secondary" size="lg" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" size="lg" type="submit" form="member-form" loading={saving} disabled={depositBlocked} data-testid="member-form-submit">
              {member ? '保存' : deposit > 0 ? `建档并收押金 ${formatYuan(deposit)}` : '建档'}
            </Button>
          </>
        )
      }
    >
      {onTypeStep ? (
        <div className="grid gap-3" role="radiogroup" aria-label="卡类型" data-testid="member-card-type-step">
          {MEMBER_CARD_TYPES.map((t, i) => {
            const Icon = CARD_TYPE_ICONS[t];
            // 实体卡要发卡的权限
            const blocked = t === 'physical' && !can('member.card');
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={cardType === t}
                disabled={blocked}
                data-autofocus={i === 0 || undefined}
                onClick={() => pickType(t)}
                className={cn(
                  'flex min-h-[72px] w-full items-center gap-4 rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-50',
                  cardType === t ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card hover:border-ink-3',
                )}
                data-testid={`card-type-${t}`}
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-2">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-bold text-ink">{MEMBER_CARD_TYPE_LABELS[t]}</span>
                  <span className="mt-0.5 block text-[13px] text-ink-3">
                    {blocked ? '你的岗位没有发实体卡的权限' : MEMBER_CARD_TYPE_HINTS[t]}
                    {t === 'physical' && !blocked && rules.cardDeposit > 0 ? `（押金 ${formatYuan(rules.cardDeposit)}）` : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <form id="member-form" onSubmit={submit} className="grid gap-4" noValidate>
          {/* 选的卡类型固定在表单顶上；新建时可以回上一步改 */}
          <div className="sticky top-0 z-10 -mx-6 -mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-card px-6 py-3" data-testid="member-card-type-pinned">
            <span className="text-[13px] font-semibold text-ink-3">卡类型</span>
            <span className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[16px] font-bold whitespace-nowrap', CARD_TYPE_CLASSES[type])}>
              <TypeIcon className="size-4" />
              {MEMBER_CARD_TYPE_LABELS[type]}
            </span>
            {/* 说明只在够宽时显示：窄屏上挤在一行里会被压成一列一两个字 */}
            <span className="hidden min-w-0 flex-1 text-[12.5px] text-ink-3 sm:block">{creating ? MEMBER_CARD_TYPE_HINTS[type] : '卡类型跟着卡走：发了实体卡是实体卡，退了卡记回电子卡'}</span>
            <span className="flex-1 sm:hidden" />
            {creating && (
              <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-3.5" />} onClick={() => setStep('type')} data-testid="member-card-type-change">
                上一步
              </Button>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={label('姓名', true)} htmlFor="m-name" error={errors.name}>
              <Input id="m-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} autoFocus data-autofocus />
            </Field>
            <Field label={label('手机号', type !== 'anonymous')} htmlFor="m-phone" error={errors.phone} hint={type === 'anonymous' ? '匿名卡可以不留' : '全公司不重复，是查找会员的主要依据'}>
              <Input id="m-phone" value={phone} inputMode="tel" maxLength={13} onChange={(e) => setPhone(e.target.value)} invalid={!!errors.phone} className="num" />
            </Field>
          </div>
          {phoneChanged && cleanPhone && (
            <Field
              label={member!.phone ? '改手机号的原因' : '补登手机号的原因'}
              htmlFor="m-phone-reason"
              hint={can('member.phone') ? `${formatPhone(member!.phone)} → ${formatPhone(cleanPhone)}` : '保存时请值班经理、店总或店主当场授权'}
              error={errors.phoneReason}
            >
              <Input id="m-phone-reason" value={phoneReason} maxLength={200} onChange={(e) => setPhoneReason(e.target.value)} invalid={!!errors.phoneReason} data-testid="member-phone-reason" />
            </Field>
          )}
          {member?.cardType === 'anonymous' && cleanPhone && (
            <ConfirmCheck checked={toNamed} onChange={setToNamed}>
              <span data-testid="member-to-named">转成实名的卡：保存后记成电子卡（名下有在用的实体卡的记成实体卡），以后手机号不能再空着</span>
            </ConfirmCheck>
          )}

          {/* 实体卡：卡号与押金；匿名卡可以选配一张 */}
          {creating && cardType === 'anonymous' && can('member.card') && (
            <Field label="实体卡" hint="配了卡，客人下次刷卡就能找到这份档案">
              <Segmented
                value={withCard ? 'yes' : 'no'}
                onChange={(v) => setWithCard(v === 'yes')}
                ariaLabel="配不配实体卡"
                className="w-full"
                options={[
                  { value: 'no', label: '不配卡' },
                  { value: 'yes', label: '配一张实体卡' },
                ]}
              />
            </Field>
          )}
          {issuingCard && (
            <>
              <Field
                label={label('卡号', true)}
                error={errors.cardNo}
                hint={normalizedCard && MEMBER_CARD_RE.test(normalizedCard) ? `识别为 ${normalizedCard}` : '把卡放到读卡器上，或手输卡号（4–32 位数字或字母）'}
              >
                <CardNoInput value={cardNo} onChange={setCardNo} onEnter={() => void save()} autoFocus={false} invalid={!!errors.cardNo} />
              </Field>
              {deposit > 0 ? (
                <>
                  <ShiftGate action="收押金" />
                  <CardDepositFields kind="receive" amount={deposit} value={pay} onChange={setPay} disabled={saving} error={errors.depositRef} />
                </>
              ) : (
                <p className="text-[12.5px] text-ink-3">后台设的是不收押金。</p>
              )}
            </>
          )}

          {/* 会员等级：必填，默认按规则自动 */}
          {creating ? (
            <Field
              label={label('会员等级', true)}
              hint={gradeMode === 'auto' ? '从 L0 起，充值达到门槛自动升档' : '手动指定走「手动调整」那条路：会籍周期从今天起算，等级卡里留记录'}
              error={errors.gradeReason}
            >
              {can('member.adjust') ? (
                <Segmented
                  value={gradeMode}
                  onChange={setGradeMode}
                  ariaLabel="会员等级"
                  className="w-full"
                  options={[
                    { value: 'auto', label: '按规则自动' },
                    { value: 'manual', label: '手动指定' },
                  ]}
                />
              ) : (
                <p className="flex h-11 items-center rounded-md bg-paper-2 px-3.5 text-[14px] font-semibold text-ink-2" data-testid="member-grade-auto">
                  按规则自动
                </p>
              )}
              {gradeMode === 'manual' && (
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" data-testid="member-grade-manual">
                  <Select value={grade} onChange={(e) => setGrade(Number(e.target.value))} aria-label="档级" data-testid="member-grade-select">
                    {Array.from({ length: MAX_GRADE }, (_, i) => i + 1).map((g) => (
                      <option key={g} value={g}>
                        L{g} {gradeNames?.[g]?.name ?? ''}
                      </option>
                    ))}
                  </Select>
                  <Segmented ariaLabel="阶位" value={tier} onChange={setTier} options={TIER_LABELS.map((t, i) => ({ value: String(i) as '0' | '1' | '2', label: t }))} />
                  <Input
                    value={gradeReason}
                    maxLength={200}
                    onChange={(e) => setGradeReason(e.target.value)}
                    invalid={!!errors.gradeReason}
                    placeholder="指定等级的原因（至少 2 个字）"
                    className="sm:col-span-2"
                    aria-label="指定等级的原因"
                    data-testid="member-grade-reason"
                  />
                </div>
              )}
            </Field>
          ) : (
            <Field label="会员等级" hint="等级在会员详情的等级卡里看、调整">
              <p className="flex h-11 items-center rounded-md bg-paper-2 px-3.5 text-[14px] font-semibold text-ink-2">{member!.gradeInfo.label}</p>
            </Field>
          )}

          {(f.gender.show || f.birthday.show) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {f.gender.show && (
                <Field label={label('性别', f.gender.required)} error={errors.gender}>
                  <Segmented
                    value={gender}
                    onChange={setGender}
                    ariaLabel="性别"
                    className="w-full"
                    options={[
                      { value: 'unknown', label: '不填' },
                      { value: 'female', label: '女' },
                      { value: 'male', label: '男' },
                    ]}
                  />
                </Field>
              )}
              {f.birthday.show && (
                <Field label={label('生日', f.birthday.required)} htmlFor="m-birthday" hint={f.birthday.required ? undefined : '选填'} error={errors.birthday}>
                  <Input id="m-birthday" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} invalid={!!errors.birthday} />
                </Field>
              )}
            </div>
          )}
          {f.channel.show && channels.length > 0 && (
            <Field label={label('来源渠道', f.channel.required)} htmlFor="m-channel" hint={optionalHint('channel', '顾客从哪里知道我们')} error={errors.channel}>
              <Select id="m-channel" value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="member-channel">
                <option value="">不填</option>
                {channels.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                    {c.active ? '' : '（已停用）'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {f.referrer.show && (
            <Field label={label('推荐人', f.referrer.required)} htmlFor="m-referrer" hint={optionalHint('referrer', '哪位会员介绍来的')} error={errors.referrer}>
              <ReferrerPicker value={referrer} onChange={setReferrer} excludeId={member?.id} invalid={!!errors.referrer} />
            </Field>
          )}
          {f.preferredItems.show && (
            <Field label={label('偏好项目', f.preferredItems.required)} htmlFor="m-preferred" hint={optionalHint('preferredItems', '用顿号分开，如：足疗、汗蒸、搓背')} error={errors.preferredItems}>
              <Input id="m-preferred" value={preferred} maxLength={160} onChange={(e) => setPreferred(e.target.value)} invalid={!!errors.preferredItems} data-testid="member-preferred" />
            </Field>
          )}
          {f.tags.show && (
            <Field label={label('会员标签', f.tags.required)} hint={optionalHint('tags', '例如亲子客、商务客；按标签筛选、导出在数据看板「会员总览」')} error={errors.tagIds}>
              <TagPicker value={tagIds} onChange={setTagIds} current={member?.tags ?? []} />
            </Field>
          )}
          {f.note.show && (
            <Field label={label('备注', f.note.required)} htmlFor="m-note" hint={optionalHint('note', '如过敏或注意事项')} error={errors.note}>
              <Textarea id="m-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}
          {existing && (
            <Notice
              tone="warning"
              title={existing.message}
              action={
                <Button size="sm" variant="secondary" onClick={() => onOpenExisting(existing.id)}>
                  查看这位会员
                </Button>
              }
            />
          )}
          {errors.form && <Notice tone="error" title={errors.form} />}
        </form>
      )}
      {member && (
        <AuthorizeDialog<MemberPhoneGrantRequest>
          open={authorizing}
          request={{ purpose: 'member_phone', scope: { memberId: member.id, phone: cleanPhone } }}
          lines={[`会员 ${member.name}（${member.memberNo}）`, `手机号 ${formatPhone(member.phone)} → ${formatPhone(cleanPhone)}`, `原因：${phoneReason.trim()}`]}
          onClose={() => setAuthorizing(false)}
          onGranted={(g) => {
            setAuthorizing(false);
            void save(g.grantId);
          }}
        />
      )}
    </Dialog>
  );
}
