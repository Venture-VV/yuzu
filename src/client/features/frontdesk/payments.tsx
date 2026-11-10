import { useState } from 'react';
import { spendQuotaText, type SpendQuota } from '@shared/spend-quota';
import { BadgePercent, Plus, ShieldCheck, Ticket, TicketCheck, Trash2, UserRound, WalletCards } from 'lucide-react';
import { DISCOUNT_TARGET_LABELS, rateText } from '@shared/benefits';
import {
  CHECKOUT_METHOD_LABELS,
  COUPON_CODE_PATTERN,
  COUPON_PLATFORM_LABELS,
  COUPON_PLATFORMS,
  normalizeCouponCode,
  type CheckoutMethod,
  type CouponPlatform,
  type MemberDiscountOption,
} from '@shared/checkout';
import { formatStoreCouponCode, normalizeStoreCouponCode, STORE_COUPON_CODE_PATTERN, type CheckoutCouponOption } from '@shared/coupons';
import { splitDeduction } from '@shared/deduction';
import type { DiscountGrant, DiscountGrantRequest } from '@shared/grants';
import { maskPhone, PAYMENT_METHODS } from '@shared/labels';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { Money } from '../../components/Money';
import { Badge, Button, Input, MoneyInput, Select } from '../../components/ui';

// 结账收款（手牌结账与餐饮桌台结账共用）：可组合多种方式，收款合计等于应收才能结清。
// R1.2（店主 2026-10-29 签认）：「优惠 / 免单」由值班经理及以上当场授权（这几张手牌或这几桌、这个金额），
// 原因随授权填写，店员不能自行抹零；「其他」收款必须填备注；储值只能用本次结账客人里的会员。

/** 可以用储值支付的会员（本次结账客人里的会员），附余额 */
export interface PayMember {
  id: number;
  name: string;
  memberNo: string;
  principalBalance: number;
  bonusBalance: number;
  status: 'active' | 'frozen';
  /** 充值当日的储值额度（8.0.4 需求表 04）：当天没充值为空；结账前核对带来，服务端入账时再核对一遍 */
  spendQuota?: SpendQuota | null;
}

/** 选储值会员时的说明：没有会员时的提示与规则 */
export interface WalletHint {
  none: string;
  rule: string;
}
const VISIT_WALLET_HINT: WalletHint = { none: '本次结账的客人里没有会员。', rule: '只能用本次结账客人里的会员储值支付；同行朋友请合并到同一张结账单' };

export interface PayRow {
  id: number;
  method: CheckoutMethod;
  /** 金额（元，输入框原文） */
  amount: string;
  ref: string;
  member: PayMember | null;
  platform: CouponPlatform;
  code: string;
  dealName: string;
  /** 现金：客人实给的金额（只用于计算找零，不登记） */
  tendered: string;
  /** 优惠 / 免单：原因与当场授权（授权绑定这几张手牌或这几桌与金额，改了要重新授权） */
  reason: string;
  grant: DiscountGrant | null;
  /** 券抵扣（v0.7.20）：选中的券（能抵多少由服务端按此刻的明细算好）；输入券码核对时的原文 */
  coupon: CheckoutCouponOption | null;
  couponInput: string;
}

let paySeq = 1;
export const newRow = (method: CheckoutMethod, amount: number): PayRow => ({
  id: paySeq++,
  method,
  amount: amount > 0 ? centsToInput(amount) : '',
  ref: '',
  member: null,
  platform: 'meituan',
  code: '',
  dealName: '',
  tendered: '',
  reason: '',
  grant: null,
  coupon: null,
  couponInput: '',
});

export const QUICK_METHODS: CheckoutMethod[] = ['wechat', 'alipay', 'cash', 'bank_card', 'other', 'wallet', 'coupon', 'store_coupon', 'discount'];

/** 结账用券（v0.7.20）：会员的券（结账核对里列出）与输入券码核对；没有时不显示「券抵扣」 */
export interface CouponSource {
  options: CheckoutCouponOption[];
  /** 按券码核对（这次结账的手牌或桌台）；没有这张券返回 null */
  check: (code: string) => Promise<CheckoutCouponOption | null>;
}

/** 提交给服务端的一笔收款 */
export type PaymentBody =
  | { method: 'wallet'; memberId: number; amount: number; expectedSplit: { principal: number; bonus: number } }
  | { method: 'coupon'; platform: CouponPlatform; code: string; dealName: string; amount: number }
  | { method: 'discount'; amount: number; grantId: string }
  | { method: 'store_coupon'; code: string; amount: number }
  | { method: 'member_discount'; memberId: number; benefitId: number; amount: number }
  | { method: 'count_card'; cardId: number; uses: number; amount: number }
  | { method: Exclude<CheckoutMethod, 'wallet' | 'coupon' | 'discount' | 'store_coupon' | 'member_discount' | 'count_card'>; amount: number; ref: string };

/**
 * 收款登记的状态与核对：每笔的金额、储值扣款构成（余额不足、会员不在本次结账里）、团购券码、「其他」备注、
 * 现金实给、优惠原因与授权（grantFits：授权仍覆盖本次结账的对象与金额）。open 变为 true 时清空。
 */
export function usePayRows(opts: {
  open: boolean;
  total: number | null;
  /** 本次结账可用储值的会员；核对数据还没取到时为 null（不核对会员是否在本次结账里） */
  members: PayMember[] | null;
  grantFits: (grant: DiscountGrant | null, cents: number) => boolean;
  /** 补录纸质单：不能用会员储值 */
  backfill: boolean;
  /** 对象的叫法（「手牌」「桌台」），用于提示授权要重新做 */
  scopeName: string;
  locked: boolean;
  onEdit: () => void;
  /** 结账核对里最新的券（能抵多少）：选中的券金额变了时提示重新选 */
  coupons?: CheckoutCouponOption[] | null;
  /**
   * 会员折扣（v0.7.25，只有手牌结账）：结账核对给出的省得最多的一种。没选券、优惠 / 免单时自动带上（算进已收、不能单独去掉）；
   * 选了券或优惠 / 免单就不用（二选一，M45）
   */
  memberDiscount?: MemberDiscountOption | null;
  /**
   * 次卡（v0.7.28，只有手牌结账）：结账对话框里选的几张卡这次抵多少（同一个算法分配好的）；用了次卡就不打会员折扣、
   * 不能再用券与优惠 / 免单（二选一）。problem 是分配不下（例如选的次数多于能抵的份数）
   */
  countCard?: { amount: number; payments: Extract<PaymentBody, { method: 'count_card' }>[]; problem: string | null } | null;
}) {
  const session = useSession();
  const [rows, setRows] = useState<PayRow[]>([]);
  useResetOnOpen(opts.open, () => setRows([]));

  const rowCents = rows.map((r) => parseYuan(r.amount));
  const countCard = opts.countCard && opts.countCard.payments.length > 0 ? opts.countCard : null;
  const otherReduction = rows.some((r) => r.method === 'store_coupon' || r.method === 'discount') || countCard !== null;
  const memberDiscount = opts.memberDiscount && !otherReduction ? opts.memberDiscount : null;
  const paid = rowCents.reduce<number>((s, c) => s + (c ?? 0), 0) + (memberDiscount?.amount ?? 0) + (countCard?.amount ?? 0);
  const remaining = opts.total === null ? null : opts.total - paid;
  const splitOf = (r: PayRow, cents: number | null) =>
    r.member && cents && cents > 0
      ? splitDeduction(cents, { principal: r.member.principalBalance, bonus: r.member.bonusBalance }, session.rules.deductionRule)
      : null;
  const rowProblem = (r: PayRow, i: number): string | null => {
    const c = rowCents[i];
    if (c === null || c === undefined || c <= 0) return '请填写金额';
    if (r.method === 'wallet') {
      if (opts.backfill) return '补录的结账不能用会员储值，请按纸质单上的实际收款方式登记';
      if (!r.member) return '请选择会员';
      // 改了勾选的手牌（桌）后，原来选的会员可能已不在本次结账里
      if (opts.members && !opts.members.some((m) => m.id === r.member!.id)) return '这位会员不在本次结账的客人里，请重新选择';
      if (r.member.status !== 'active') return '会员已停用';
      const s = splitOf(r, c);
      if (s && !s.ok) return `余额不足，还差 ¥${(s.shortfall / 100).toFixed(2)}`;
      // 充值当日的储值额度（8.0.4 需求表 04，HY02）：同一位会员几行储值合起来算，超了拦下并提示剩余额度
      const q = r.member.spendQuota;
      if (q) {
        const used = rows.reduce((sum, x, j) => (x.method === 'wallet' && x.member?.id === r.member!.id ? sum + (rowCents[j] ?? 0) : sum), 0);
        if (used > q.remaining) return `超过今天的储值额度：剩余 ${formatYuan(q.remaining)}（充值前余额 ${formatYuan(q.priorBalance)} + 今日充值 ${formatYuan(q.recharged)} × ${q.pct}%），其余请用别的方式付`;
      }
    }
    if (r.method === 'coupon' && !COUPON_CODE_PATTERN.test(normalizeCouponCode(r.code))) return '请填写完整券码';
    if (r.method === 'other' && !r.ref.trim()) return '「其他」收款请在备注里写明收的是什么';
    if (r.method === 'cash' && r.tendered.trim()) {
      // 「客人实给」只用来算找零，不登记；填了却少于这笔现金，说明现金没收够（测试服 E2E 报告 BUG-2）
      const given = parseYuan(r.tendered);
      if (given === null) return '客人实给的金额不正确';
      if (given < c) return `客人实给少于这笔现金，还差 ¥${((c - given) / 100).toFixed(2)}；请核对现金或改收款方式`;
    }
    if (r.method === 'discount') {
      if (r.reason.trim().length < 2) return '请填写优惠原因（至少 2 个字），例如：抹零、投诉补偿';
      if (!opts.grantFits(r.grant, c)) return r.grant ? `${opts.scopeName}或金额改了，请按当前内容重新授权` : '请值班经理、店总或店主当场授权';
      if (rows.some((x) => x.method === 'store_coupon')) return '券不能和优惠 / 免单同时用，请二选一';
      if (countCard) return '次卡不能和优惠 / 免单同时用，请二选一';
    }
    return null;
  };
  // 券抵扣（v0.7.20）：要先选券（金额由服务端算好、不能改）；每单最多 1 张；结账核对刷新后这张券能抵的变了要重新选
  const couponProblem = (r: PayRow): string | null => {
    if (!r.coupon) return '请选一张券，或输入券码核对';
    if (!r.coupon.usable) return r.coupon.reason ?? '这张券现在不能用';
    const latest = opts.coupons?.find((o) => o.code === r.coupon!.code);
    if (latest && (latest.amount !== r.coupon.amount || !latest.usable)) {
      return latest.usable ? `账单有变化，这张券现在能抵 ${formatYuan(latest.amount)}，请重新选一次` : (latest.reason ?? '这张券现在不能用');
    }
    if (rows.filter((x) => x.method === 'store_coupon').length > 1) return '每张结账单最多用 1 张券';
    if (countCard) return '次卡不能和券同时用，请二选一';
    return null;
  };
  const problems = rows.map((r, i) => (r.method === 'store_coupon' ? couponProblem(r) : rowProblem(r, i)));
  const walletMembers = rows.filter((r) => r.method === 'wallet' && r.member).map((r) => r.member!.id);
  const dupWallet = new Set(walletMembers).size !== walletMembers.length;

  const edit = (fn: () => void) => {
    if (opts.locked) return;
    opts.onEdit();
    fn();
  };
  const addRow = (method: CheckoutMethod) =>
    edit(() => {
      // 券抵扣的金额等选了券再定
      const row = newRow(method, method === 'store_coupon' ? 0 : Math.max(0, remaining ?? 0));
      if (method === 'wallet') {
        const m = opts.members?.find((x) => !rows.some((r) => r.member?.id === x.id));
        if (m) row.member = m;
      }
      setRows((list) => [...list, row]);
    });
  const update = (id: number, patch: Partial<PayRow>) => edit(() => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r))));
  const remove = (id: number) => edit(() => setRows((list) => list.filter((x) => x.id !== id)));
  /** 授权弹窗签发后记到那一笔上（不经过 edit：授权时表单没有锁） */
  const setGrant = (id: number, grant: DiscountGrant) => setRows((list) => list.map((r) => (r.id === id ? { ...r, grant } : r)));

  /** 按登记的收款生成提交内容（调用前 ok 必须为 true） */
  const payments = (): PaymentBody[] => [
    ...(memberDiscount
      ? [{ method: 'member_discount' as const, memberId: memberDiscount.memberId, benefitId: memberDiscount.benefitId, amount: memberDiscount.amount }]
      : []),
    ...(countCard?.payments ?? []),
    ...rows.map((r, i): PaymentBody => {
      const amount = rowCents[i]!;
      if (r.method === 'wallet') {
        const s = splitOf(r, amount);
        return { method: 'wallet' as const, memberId: r.member!.id, amount, expectedSplit: s && s.ok ? { principal: s.principal, bonus: s.bonus } : { principal: amount, bonus: 0 } };
      }
      if (r.method === 'coupon') return { method: 'coupon' as const, platform: r.platform, code: normalizeCouponCode(r.code), dealName: r.dealName.trim(), amount };
      if (r.method === 'discount') return { method: 'discount' as const, amount, grantId: r.grant!.grantId };
      if (r.method === 'store_coupon') return { method: 'store_coupon' as const, code: r.coupon!.code, amount };
      return { method: r.method as Exclude<CheckoutMethod, 'wallet' | 'coupon' | 'discount' | 'store_coupon' | 'member_discount' | 'count_card'>, amount, ref: r.ref.trim() };
    }),
  ];

  return {
    rows,
    rowCents,
    paid,
    remaining,
    problems,
    dupWallet,
    hasDiscount: rows.some((r) => r.method === 'discount'),
    hasStoreCoupon: rows.some((r) => r.method === 'store_coupon'),
    /** 自动带上的会员折扣（选了券、优惠时为空）与能享的那一种 */
    memberDiscount,
    memberDiscountOffered: opts.memberDiscount ?? null,
    /** 用了次卡（v0.7.28）：不能再加券、优惠 / 免单 */
    hasCountCard: countCard !== null,
    /** 每笔都填好了、没有重复的储值会员，次卡分配得下 */
    ok: problems.every((x) => x === null) && !dupWallet && !countCard?.problem,
    methods: [
      ...new Set([
        ...(memberDiscount ? [CHECKOUT_METHOD_LABELS.member_discount] : []),
        ...(countCard ? [CHECKOUT_METHOD_LABELS.count_card] : []),
        ...rows.map((r) => CHECKOUT_METHOD_LABELS[r.method]),
      ]),
    ],
    splitOf,
    grantFits: opts.grantFits,
    locked: opts.locked,
    addRow,
    update,
    remove,
    setGrant,
    payments,
  };
}

/** 收款区：添加收款方式的按钮、每笔收款的编辑、请值班经理授权优惠的弹窗 */
export function PaymentsSection({
  pay,
  total,
  members,
  canWallet,
  walletHint,
  authorize,
  coupons,
}: {
  pay: ReturnType<typeof usePayRows>;
  total: number | null;
  members: PayMember[];
  /** 可以用储值支付（有会员消费权限、不是补录） */
  canWallet: boolean;
  walletHint?: WalletHint;
  /** 优惠授权：申请的对象与弹窗里的说明 */
  authorize: (amount: number, reason: string) => { request: DiscountGrantRequest; lines: string[] };
  /** 结账用券（v0.7.20）；不传时不显示「券抵扣」 */
  coupons?: CouponSource;
}) {
  /** 正在请值班经理授权优惠的那一笔 */
  const [authorizing, setAuthorizing] = useState<number | null>(null);
  const authRow = pay.rows.find((r) => r.id === authorizing) ?? null;
  const authCents = authRow ? pay.rowCents[pay.rows.indexOf(authRow)] : null;
  const auth = authRow && authCents ? authorize(authCents, authRow.reason.trim()) : null;
  return (
    <div className="rounded-lg border border-line bg-paper/50 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-bold text-ink-2">收款</span>
        {QUICK_METHODS.filter((m) => (m !== 'wallet' || canWallet) && (m !== 'store_coupon' || !!coupons)).map((m) => (
          <Button
            key={m}
            size="sm"
            variant="secondary"
            icon={m === 'discount' ? <BadgePercent className="size-3.5" /> : m === 'store_coupon' ? <TicketCheck className="size-3.5" /> : <Plus className="size-3.5" />}
            // 应收合计取回之前不能选（店主 2026-10-30 定）：网络慢时先点了，新加的一笔没有默认金额
            // 券（v0.7.20）：每单最多 1 张，不与优惠 / 免单同时用
            disabled={
              pay.locked ||
              total === null ||
              (m === 'discount' && (pay.hasDiscount || pay.hasStoreCoupon || pay.hasCountCard)) ||
              (m === 'store_coupon' && (pay.hasStoreCoupon || pay.hasDiscount || pay.hasCountCard))
            }
            onClick={() => pay.addRow(m)}
            data-testid={`pay-add-${m}`}
          >
            {CHECKOUT_METHOD_LABELS[m]}
          </Button>
        ))}
      </div>
      {pay.memberDiscountOffered && <MemberDiscountRow offered={pay.memberDiscountOffered} applied={!!pay.memberDiscount} />}
      {pay.rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3" data-testid="pay-hint">
          {total === null
            ? '正在取应收合计，取到后才能选收款方式。'
            : total === 0
              ? '应收为 0（例如儿童免票），不用登记收款，直接确认结清。'
              : '点上面的收款方式添加一笔，金额默认为还差的部分；可组合多种方式。'}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {pay.rows.map((r, i) => (
            <PayRowEditor
              key={r.id}
              row={r}
              cents={pay.rowCents[i] ?? null}
              problem={pay.problems[i] ?? null}
              members={members}
              split={pay.splitOf(r, pay.rowCents[i] ?? null)}
              locked={pay.locked}
              granted={r.method === 'discount' && pay.grantFits(r.grant, pay.rowCents[i] ?? 0)}
              onChange={(patch) => pay.update(r.id, patch)}
              onAuthorize={() => setAuthorizing(r.id)}
              onRemove={() => pay.remove(r.id)}
              walletHint={walletHint}
              coupons={coupons}
            />
          ))}
        </ul>
      )}
      {authRow && auth ? (
        <AuthorizeDialog<DiscountGrantRequest>
          open
          request={auth.request}
          lines={auth.lines}
          onClose={() => setAuthorizing(null)}
          onGranted={(grant) => {
            pay.setGrant(authRow.id, grant);
            setAuthorizing(null);
          }}
        />
      ) : null}
      {pay.dupWallet && <p className="mt-2 text-[12.5px] font-semibold text-clay">同一位会员的储值支付请合并为一笔</p>}
    </div>
  );
}

/**
 * 会员折扣（v0.7.25）：自动带上、不能单独去掉；选了券或优惠 / 免单就不用（二选一），这里写明两边的取舍
 */
function MemberDiscountRow({ offered, applied }: { offered: MemberDiscountOption; applied: boolean }) {
  // 同行优惠（v0.7.26）：写明打的是哪几位同行
  const whom = offered.companions?.length ? ` ${offered.companions.join('、')}` : '';
  const what = `${offered.memberName} · ${offered.stateLabel} ${rateText(offered.rate)} · ${offered.name}（${DISCOUNT_TARGET_LABELS[offered.target]}${whom}）`;
  return applied ? (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-yuzu/40 bg-yuzu-soft/40 px-3 py-2" data-testid="member-discount">
      <Badge tone="yuzu">会员折扣</Badge>
      <span className="text-[13px] font-semibold text-ink-2">{what}</span>
      <Money cents={-offered.amount} signed className="ml-auto text-[15px] font-bold text-yuzu-deep" />
      <p className="w-full text-[12px] text-ink-3">结账时自动用省得最多的一种；客人要用券或经理授权优惠时二选一（会员折扣就不用了）。</p>
    </div>
  ) : (
    <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-[12.5px] text-ink-3" data-testid="member-discount-off">
      已改用券或优惠 / 免单，会员折扣「{what}」省 {formatYuan(offered.amount)} 不用了（二选一）；去掉券或优惠就恢复会员折扣。
    </p>
  );
}

export function PayRowEditor({
  row,
  cents,
  problem,
  members,
  split,
  locked,
  granted,
  onChange,
  onAuthorize,
  onRemove,
  walletHint = VISIT_WALLET_HINT,
  coupons,
}: {
  row: PayRow;
  cents: number | null;
  problem: string | null;
  members: PayMember[];
  split: ReturnType<typeof splitDeduction> | null;
  locked: boolean;
  /** 优惠 / 免单：授权仍覆盖这几张手牌（这几桌）与金额 */
  granted: boolean;
  onChange: (patch: Partial<PayRow>) => void;
  onAuthorize: () => void;
  onRemove: () => void;
  /** 选储值会员时的说明（手牌结账与桌台结账不同） */
  walletHint?: WalletHint;
  coupons?: CouponSource;
}) {
  const tendered = parseYuan(row.tendered);
  return (
    <li className={cn('rounded-lg border bg-card p-3', problem ? 'border-clay/40' : 'border-line')} data-testid={`pay-row-${row.method}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={row.method === 'wallet' ? 'pine' : row.method === 'coupon' || row.method === 'discount' || row.method === 'store_coupon' ? 'yuzu' : 'neutral'}
          className="h-7 px-3 text-[13px]"
        >
          {row.method === 'wallet' ? (
            <WalletCards className="size-3.5" />
          ) : row.method === 'coupon' ? (
            <Ticket className="size-3.5" />
          ) : row.method === 'discount' ? (
            <BadgePercent className="size-3.5" />
          ) : row.method === 'store_coupon' ? (
            <TicketCheck className="size-3.5" />
          ) : null}
          {CHECKOUT_METHOD_LABELS[row.method]}
        </Badge>
        <div className="w-[150px]">
          <MoneyInput
            value={row.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            // 券抵扣的金额由服务端按此刻的明细算好，不能改
            disabled={locked || row.method === 'store_coupon'}
            aria-label={`${CHECKOUT_METHOD_LABELS[row.method]}金额`}
            className="h-10"
          />
        </div>
        {(PAYMENT_METHODS as readonly string[]).includes(row.method) && (
          <Input
            fullWidth={false}
            value={row.ref}
            onChange={(e) => onChange({ ref: e.target.value })}
            placeholder={row.method === 'cash' ? '备注（选填）' : row.method === 'other' ? '写明收的是什么（必填）' : '单号后几位（选填）'}
            maxLength={64}
            disabled={locked}
            className="h-10 min-w-0 flex-1 basis-32"
            aria-label="收款备注"
          />
        )}
        {row.method === 'coupon' && (
          <>
            <Select fullWidth={false} value={row.platform} onChange={(e) => onChange({ platform: e.target.value as CouponPlatform })} disabled={locked} className="h-10 w-[120px]" aria-label="团购平台">
              {COUPON_PLATFORMS.map((pl) => (
                <option key={pl} value={pl}>
                  {COUPON_PLATFORM_LABELS[pl]}
                </option>
              ))}
            </Select>
            <Input
              fullWidth={false}
              value={row.code}
              onChange={(e) => onChange({ code: e.target.value.toUpperCase() })}
              onBlur={() => onChange({ code: normalizeCouponCode(row.code) })}
              placeholder="完整券码"
              disabled={locked}
              className="num h-10 min-w-0 flex-1 basis-40 font-semibold tracking-wide"
              aria-label="完整券码"
              data-testid="coupon-code"
            />
          </>
        )}
        <span className="flex-1" />
        <button type="button" aria-label="移除这笔收款" onClick={onRemove} disabled={locked} className="flex size-9 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay disabled:opacity-40">
          <Trash2 className="size-4" />
        </button>
      </div>

      {row.method === 'coupon' && (
        <Input value={row.dealName} onChange={(e) => onChange({ dealName: e.target.value })} placeholder="团购项目（选填，例如「不含餐 12 小时」）" maxLength={48} disabled={locked} className="mt-2 h-9 text-[13px]" aria-label="团购项目" />
      )}

      {row.method === 'store_coupon' && coupons && (
        <StoreCouponPicker
          row={row}
          source={coupons}
          locked={locked}
          onPick={(c) => onChange({ coupon: c, amount: c && c.usable ? centsToInput(c.amount) : '' })}
          onInput={(v) => onChange({ couponInput: v })}
        />
      )}

      {row.method === 'discount' && (
        // 优惠 / 免单：员工填原因，值班经理及以上在弹窗里输入自己的账号密码授权；店员不能自行抹零
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="discount-row">
          <Input
            fullWidth={false}
            value={row.reason}
            // 原因随授权一起记下：改了原因要重新授权
            onChange={(e) => onChange({ reason: e.target.value, grant: null })}
            placeholder="优惠原因（必填），例如：抹零、投诉补偿"
            maxLength={64}
            disabled={locked}
            className="h-9 min-w-0 flex-1 basis-48 text-[13px]"
            aria-label="优惠原因"
          />
          {granted && row.grant ? (
            <span data-testid="discount-granted">
              <Badge tone="pine" className="h-8 px-3 text-[12.5px]">
                <ShieldCheck className="size-3.5" /> {row.grant.approverName}已授权
              </Badge>
            </span>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<ShieldCheck className="size-3.5" />}
              disabled={locked || !cents || cents <= 0 || row.reason.trim().length < 2}
              onClick={onAuthorize}
              data-testid="discount-authorize"
            >
              请值班经理授权
            </Button>
          )}
        </div>
      )}

      {row.method === 'cash' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          客人实给
          <div className="w-[120px]">
            <MoneyInput value={row.tendered} onChange={(e) => onChange({ tendered: e.target.value })} className="h-8 text-[13px]" aria-label="客人实给现金" />
          </div>
          {tendered !== null && cents !== null && tendered >= cents && (
            <span className="font-semibold text-ink-2">
              找零 <Money cents={tendered - cents} className="font-bold text-pine" />（找零不用登记）
            </span>
          )}
        </div>
      )}

      {row.method === 'wallet' &&
        (row.member ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-pine-tint px-3 py-2 text-[12.5px]">
            <UserRound className="size-3.5 text-pine" />
            <span className="font-bold text-ink">{row.member.name}</span>
            <span className="num text-ink-3">{row.member.memberNo}</span>
            <span className="text-ink-2">
              本金 <Money cents={row.member.principalBalance} /> · 赠金 <Money cents={row.member.bonusBalance} />
            </span>
            {split?.ok && (
              <span className="font-semibold text-pine" data-testid="wallet-split">
                将扣本金 <Money cents={split.principal} /> · 赠金 <Money cents={split.bonus} />
              </span>
            )}
            {row.member.spendQuota && (
              <span className="w-full text-[12px] font-semibold text-ember" data-testid="wallet-spend-quota">
                {spendQuotaText(row.member.spendQuota)}
              </span>
            )}
            <span className="flex-1" />
            {members.length > 1 && (
              <Select
                fullWidth={false}
                value={String(row.member.id)}
                onChange={(e) => onChange({ member: members.find((m) => m.id === Number(e.target.value)) ?? row.member })}
                disabled={locked}
                className="h-8 w-[130px] text-[12.5px]"
                aria-label="换一位会员"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" variant="ghost" disabled={locked} onClick={() => onChange({ member: null })}>
              换人
            </Button>
          </div>
        ) : (
          // 只能用本次结账客人里的会员储值（服务端同样核对）；会员替朋友付，把朋友的手牌合并进本次结账
          <div className="mt-2" data-testid="wallet-members">
            <p className="text-[12.5px] text-ink-3">
              {members.length ? '选择付款会员：' : walletHint.none}
              {walletHint.rule}
            </p>
            {members.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {members.map((m) => (
                  <MemberPick key={m.id} m={m} onPick={() => onChange({ member: m })} />
                ))}
              </ul>
            )}
          </div>
        ))}
      {problem && <p className="mt-1.5 text-[12.5px] font-semibold text-clay">{problem}</p>}
    </li>
  );
}

function MemberPick({ m, onPick }: { m: { name: string; memberNo: string; principalBalance: number; bonusBalance: number; phone?: string }; onPick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onPick} className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-card">
        <span className="min-w-0 flex-1 truncate font-semibold">{m.name}</span>
        {m.phone && <span className="num text-ink-3">{maskPhone(m.phone)}</span>}
        <span className="num text-ink-3">
          余额 <Money cents={m.principalBalance + m.bonusBalance} />
        </span>
      </button>
    </li>
  );
}

/**
 * 券抵扣（v0.7.20）：会员的券（本次结账客人里的会员，能用的在前、写明能抵多少；不能用的写原因），或输入无记名券的券码核对。
 * 能抵多少由服务端按此刻的明细算好，结账时再核对一遍（变了会提示重新选）
 */
function StoreCouponPicker({
  row,
  source,
  locked,
  onPick,
  onInput,
}: {
  row: PayRow;
  source: CouponSource;
  locked: boolean;
  onPick: (c: CheckoutCouponOption | null) => void;
  onInput: (v: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const code = normalizeStoreCouponCode(row.couponInput);
  const check = async () => {
    setChecking(true);
    setNote(null);
    try {
      const found = await source.check(code);
      if (!found) setNote('没有这张券，请核对券码');
      else if (!found.usable) setNote(found.reason ?? '这张券现在不能用');
      else onPick(found);
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  if (row.coupon) {
    const c = row.coupon;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-yuzu-tint px-3 py-2 text-[12.5px]" data-testid="store-coupon-picked">
        <TicketCheck className="size-3.5 text-yuzu-deep" />
        <span className="font-bold text-ink">{c.templateName}</span>
        <span className="num text-ink-3">{formatStoreCouponCode(c.code)}</span>
        <span className="text-ink-2">{c.summary}</span>
        {c.memberName && <span className="text-ink-3">会员 {c.memberName}</span>}
        <span className="text-ink-3">有效期到 {c.validTo}</span>
        <span className="font-semibold text-pine">
          抵 <Money cents={c.amount} />
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={locked} onClick={() => onPick(null)}>
          换一张
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-2" data-testid="store-coupon-options">
      {source.options.length > 0 ? (
        <ul className="space-y-1">
          {source.options.map((o) => (
            <li key={o.couponId}>
              <button
                type="button"
                disabled={locked || !o.usable}
                onClick={() => onPick(o)}
                className={cn(
                  'flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border px-3 py-1.5 text-left text-[12.5px]',
                  o.usable ? 'border-line bg-card hover:border-line-strong' : 'cursor-not-allowed border-dashed border-line bg-paper-2/50 text-ink-3',
                )}
                data-testid={`store-coupon-${o.code}`}
              >
                <span className="font-bold">{o.templateName}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3">
                  {o.summary}
                  {o.memberName ? ` · ${o.memberName}` : ''} · 到 {o.validTo}
                </span>
                {o.usable ? (
                  <span className="font-semibold text-pine">
                    抵 <Money cents={o.amount} />
                  </span>
                ) : (
                  <span className="text-[12px]">{o.reason}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">本次结账的客人里没有可用的会员券；无记名券请输入券码。</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          fullWidth={false}
          value={row.couponInput}
          onChange={(e) => {
            setNote(null);
            onInput(e.target.value.toUpperCase());
          }}
          placeholder="无记名券：输入 12 位券码"
          maxLength={20}
          disabled={locked}
          className="num h-9 min-w-0 flex-1 basis-44 font-semibold tracking-wide"
          aria-label="券码"
          data-testid="store-coupon-code"
        />
        <Button size="sm" variant="secondary" loading={checking} disabled={locked || !STORE_COUPON_CODE_PATTERN.test(code)} onClick={() => void check()} data-testid="store-coupon-check">
          核对券码
        </Button>
      </div>
      {note && <p className="text-[12.5px] font-semibold text-clay">{note}</p>}
    </div>
  );
}
