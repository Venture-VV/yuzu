// 后台「微信小程序」→「领券中心」（小程序线第二期 2c，docs/MP_COUPONS.md；权限 mp.coupon：店主、店总，MP27）：
//   · 设置：开关（默认关）、可领的券（从启用的券模板里加，按列表的先后给顾客看）、每张的领取限制（每人限领 N 张，默认 1 张；或不限领）、停领；
//     带版本号保存，结果待确认照其他开关（这一页上方查回、按原内容重新提交或放弃）；
//   · 每张券一共领了多少、最近 7 天领了多少；最近的领取记录。
// 券本身（有效期、门槛、范围、限定档级）照券模板，在「券与会员权益」里改。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { MP_COUPON_OFFERS_MAX, MP_COUPON_PER_MEMBER_DEFAULT, MP_COUPON_PER_MEMBER_MAX, type MpAdminData, type MpCouponAdminData, type MpCouponOffer } from '@shared/mp';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { mpAdminKey, PendingUpdates, updateFailed } from './mpAdminShared';
import { sendUpdate, useMpPending } from './mpPending';

const couponKey = ['mp', 'coupons'] as const;

export function CouponTab({ data }: { data: MpAdminData }) {
  const q = useQuery({ queryKey: couponKey, queryFn: () => api.get<MpCouponAdminData>('/api/admin/mp/coupons') });
  const pending = useMpPending('coupon_rules_update');
  if (!q.data) return <Skeleton className="h-48" />;
  return (
    <div className="space-y-4">
      {pending.length > 0 && <PendingUpdates ops={pending} data={data} />}
      <RulesForm key={data.couponRules.version} d={q.data} rules={data.couponRules} pending={pending.length > 0} />
      <RecentClaims d={q.data} />
    </div>
  );
}

/** 每人限领几张的输入：留字符串，保存时再核对 */
type Row = Omit<MpCouponOffer, 'perMember'> & { perMember: string };

function RulesForm({ d, rules, pending }: { d: MpCouponAdminData; rules: MpAdminData['couponRules']; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [enabled, setEnabled] = useState(rules.enabled);
  const [rows, setRows] = useState<Row[]>(rules.offers.map((o) => ({ ...o, perMember: String(o.perMember) })));
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const byId = new Map(d.templates.map((t) => [t.id, t]));
  const statOf = (id: number) => d.stats.find((s) => s.templateId === id);
  const addable = d.templates.filter((t) => !t.name.endsWith('（已停用）') && !rows.some((r) => r.templateId === t.id));
  const badRow = rows.find((r) => r.limit === 'per_member' && !/^[0-9]{1,2}$/.test(r.perMember.trim()));
  const invalid = badRow
    ? `「${byId.get(badRow.templateId)?.name ?? '券'}」每人限领几张请填 1–${MP_COUPON_PER_MEMBER_MAX}`
    : rows.some((r) => r.limit === 'per_member' && (Number(r.perMember) < 1 || Number(r.perMember) > MP_COUPON_PER_MEMBER_MAX))
      ? `每人限领几张请填 1–${MP_COUPON_PER_MEMBER_MAX}`
      : null;
  const patch = (id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.templateId === id ? { ...r, ...p } : r)));
  const move = (i: number, by: -1 | 1) =>
    setRows((rs) => {
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(i + by, 0, r!);
      return next;
    });
  const add = () => {
    const id = Number(adding);
    if (!id) return;
    setRows((rs) => [...rs, { templateId: id, limit: 'per_member', perMember: String(MP_COUPON_PER_MEMBER_DEFAULT), active: true }]);
    setAdding('');
  };
  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      const offers: MpCouponOffer[] = rows.map((r) => ({
        templateId: r.templateId,
        limit: r.limit,
        // 不限领时照样存着原来的张数：再切回「每人限领」时还是它
        perMember: r.limit === 'per_member' ? Number(r.perMember) : Number(r.perMember) || MP_COUPON_PER_MEMBER_DEFAULT,
        active: r.active,
      }));
      await sendUpdate({
        type: 'coupon_rules_update',
        url: '/api/admin/mp/coupons/rules',
        target: 'coupon_rules',
        body: { enabled, offers, version: rules.version },
        summary: '领券中心的设置',
        staffName: session.staff.displayName,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: mpAdminKey }), qc.invalidateQueries({ queryKey: couponKey })]);
      toast({ tone: 'success', title: '领券中心的设置已保存' });
    } catch (error) {
      updateFailed(toast, error);
      void qc.invalidateQueries({ queryKey: mpAdminKey });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">领券中心</p>
          <p className="text-[13px] text-ink-3">
            顾客在小程序「我的 → 领券中心」领券，领到的在「我的券」里，到前台结账时照常用。限领按会员算：换绑微信也不能多领。
          </p>
          {pending && <p className="text-[12.5px] text-ember">设置的修改结果待确认，先在上方处理</p>}
        </div>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel="领券中心开关"
          onChange={(v) => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: '关闭', disabled: pending },
            { value: 'on', label: '开通', disabled: pending },
          ]}
        />
      </div>

      <div className="divide-y divide-line rounded-lg border border-line">
        {rows.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有可领的券：从下面选一张券模板加进来</p>}
        {rows.map((r, i) => {
          const t = byId.get(r.templateId);
          const s = statOf(r.templateId);
          return (
            <div key={r.templateId} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="mp-coupon-offer">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">
                  {t?.name ?? `券模板 #${r.templateId}`} {!r.active && <Badge tone="neutral">停领</Badge>}
                </p>
                <p className="text-[12.5px] text-ink-3">
                  {t ? `${t.summary} · ${t.validity}${t.levels.length ? ` · 只给 ${t.levels.map((l) => `L${l}`).join('、')}` : ''}` : '这张券模板已经没有了，请拿掉'}
                </p>
                <p className="num text-[12.5px] text-ink-3">
                  已领 {s?.total ?? 0} 张 · 近 7 天 {s?.last7Days ?? 0} 张
                </p>
              </div>
              <Segmented
                size="sm"
                value={r.limit}
                ariaLabel="领取限制"
                onChange={(v) => patch(r.templateId, { limit: v })}
                options={[
                  { value: 'per_member', label: '每人限领', disabled: pending },
                  { value: 'unlimited', label: '不限领', disabled: pending },
                ]}
              />
              {r.limit === 'per_member' && (
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label="每人限领几张"
                    inputMode="numeric"
                    fullWidth={false}
                    className="w-16 text-center"
                    value={r.perMember}
                    disabled={pending}
                    invalid={!/^[0-9]{1,2}$/.test(r.perMember.trim()) || Number(r.perMember) < 1}
                    onChange={(e) => patch(r.templateId, { perMember: e.target.value })}
                  />
                  <span className="text-[13px] text-ink-3">张</span>
                </div>
              )}
              <Segmented
                size="sm"
                value={r.active ? 'on' : 'off'}
                ariaLabel="可领还是停领"
                onChange={(v) => patch(r.templateId, { active: v === 'on' })}
                options={[
                  { value: 'on', label: '可领', disabled: pending },
                  { value: 'off', label: '停领', disabled: pending },
                ]}
              />
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" aria-label="往前挪" disabled={pending || i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={16} />
                </Button>
                <Button size="sm" variant="ghost" aria-label="往后挪" disabled={pending || i === rows.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={16} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="从领券中心拿掉"
                  disabled={pending}
                  onClick={() => setRows((rs) => rs.filter((x) => x.templateId !== r.templateId))}
                >
                  <X size={16} />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {rows.some((r) => r.limit === 'unlimited') && (
        <Notice tone="warning">不限领的券每点一次领一张，没有上限（每个微信每分钟最多领 20 次）。只给多领也不要紧的券用。</Notice>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="加一张券" hint="只列启用的券模板；新加的默认每人限领 1 张（MP22），上线后再按需要改" htmlFor="mp-coupon-add" className="min-w-0 flex-1">
          <Select id="mp-coupon-add" value={adding} disabled={pending || rows.length >= MP_COUPON_OFFERS_MAX} onChange={(e) => setAdding(e.target.value)}>
            <option value="">选券模板…</option>
            {addable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}（{t.summary}）
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" disabled={pending || !adding} onClick={add}>
          加进来
        </Button>
      </div>

      {invalid && <p className="text-[12.5px] text-ember">{invalid}</p>}
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} disabled={pending || !!invalid} onClick={save}>
          保存领券中心的设置
        </Button>
      </div>
    </Card>
  );
}

function RecentClaims({ d }: { d: MpCouponAdminData }) {
  if (d.recent.length === 0) return null;
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">最近的领取</p>
        <p className="text-[13px] text-ink-3">最近 50 条。领到的券在会员详情的券里，发券记录写「小程序领取」。</p>
      </div>
      <div className="divide-y divide-line">
        {d.recent.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]" data-testid="mp-coupon-claim">
            <span className="num text-ink-3">{formatDateTime(c.createdAt)}</span>
            <span className="font-semibold text-ink">{c.memberName}</span>
            <span>{c.templateName}</span>
            <span className="text-ink-3">第 {c.seq} 张</span>
            <span className="num text-ink-3">
              {c.couponCode} · {c.issueNo}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
