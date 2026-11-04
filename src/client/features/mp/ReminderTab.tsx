// 后台「微信小程序」→「到期提醒」（小程序线第三期 3a，docs/MP_PHASE3.md 第 1 节；权限 mp.reminder：店主、店总）：
//   · 设置：开关（默认关）、三种提醒各用哪个订阅消息模板、模板的每个字段填什么；带版本号保存，结果待确认照其他开关；
//   · 最近 30 天同意了多少、各状态的消息多少、还没到发的时候的有多少；网关最近一次来取消息的时间；最近 50 条消息。
// 模板由店主在微信公众平台「订阅消息」从公共模板库选：模板详情里的 {{thing1.DATA}} 就填 thing1。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import {
  MP_REMINDER_FIELD_KEY,
  MP_REMINDER_FIELDS_MAX,
  MP_REMINDER_LEAD_DAYS,
  MP_REMINDER_SEND_HOURS,
  MP_REMINDER_TEMPLATE_ID,
  type MpAdminData,
  type MpReminderAdminData,
  type MpReminderKind,
  type MpReminderSource,
  type MpReminderStatus,
  type MpReminderTemplate,
  type MpReminderTemplateKind,
} from '@shared/mp';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { mpAdminKey, PendingUpdates, updateFailed } from './mpAdminShared';
import { sendUpdate, useMpPending } from './mpPending';

const reminderKey = ['mp', 'reminders'] as const;

const KINDS: { kind: MpReminderTemplateKind; title: string; when: string; sources: MpReminderSource[] }[] = [
  { kind: 'coupon', title: '券快到期', when: `券到期前 ${MP_REMINDER_LEAD_DAYS.coupon} 天`, sources: ['name', 'date', 'tip', 'store'] },
  {
    kind: 'membership',
    title: '会籍快到期、进补充期',
    when: `会籍到期前 ${MP_REMINDER_LEAD_DAYS.membership} 天；进补充期当天再发一次（顾客要再同意一次）`,
    sources: ['name', 'date', 'amount', 'tip', 'store'],
  },
  { kind: 'bonus', title: '赠金快到期', when: `赠金作废前 ${MP_REMINDER_LEAD_DAYS.bonus} 天`, sources: ['name', 'date', 'amount', 'tip', 'store'] },
];

const SOURCE_TEXT: Record<MpReminderTemplateKind, Record<MpReminderSource, string>> = {
  coupon: { name: '券名', date: '到期日', amount: '—', tip: '提示：到前台结账时出示会员码就能用', store: '门店名' },
  membership: { name: '档阶（如 L3 观澜 · 享）', date: '到期日（补充期写补充期到哪天）', amount: '保级还差多少储值消费', tip: '提示：再消费多少可保级', store: '门店名' },
  bonus: { name: '「赠金」', date: '作废的那一天', amount: '那一天作废的赠金', tip: '提示：到期前消费会先用快到期的赠金', store: '门店名' },
};

const STATUS: Record<MpReminderStatus, { label: string; tone: 'neutral' | 'moss' | 'yuzu' | 'ember' | 'lake' }> = {
  queued: { label: '排队', tone: 'lake' },
  leased: { label: '网关在发', tone: 'lake' },
  sent: { label: '已发出', tone: 'moss' },
  failed: { label: '没发出', tone: 'ember' },
  unknown: { label: '结果不明', tone: 'yuzu' },
  skipped: { label: '不用发了', tone: 'neutral' },
};
const KIND_LABELS: Record<MpReminderKind, string> = { coupon: '券快到期', membership: '会籍快到期', grace: '进补充期', bonus: '赠金快到期' };

export function ReminderTab({ data }: { data: MpAdminData }) {
  const q = useQuery({ queryKey: reminderKey, queryFn: () => api.get<MpReminderAdminData>('/api/admin/mp/reminders') });
  const pending = useMpPending('reminder_rules_update');
  if (!q.data) return <Skeleton className="h-48" />;
  return (
    <div className="space-y-4">
      {pending.length > 0 && <PendingUpdates ops={pending} data={data} />}
      <RulesForm key={data.reminderRules.version} rules={data.reminderRules} pending={pending.length > 0} />
      <Stats d={q.data} />
    </div>
  );
}

type FieldRow = { key: string; source: MpReminderSource };
type TplRow = { on: boolean; templateId: string; fields: FieldRow[] };

const toRow = (t: MpReminderTemplate | null, kind: MpReminderTemplateKind): TplRow =>
  t
    ? { on: true, templateId: t.templateId, fields: t.fields.map((f) => ({ ...f })) }
    : { on: false, templateId: '', fields: [{ key: 'thing1', source: 'name' }, { key: kind === 'coupon' ? 'date2' : 'amount2', source: kind === 'coupon' ? 'date' : 'amount' }] };

function RulesForm({ rules, pending }: { rules: MpAdminData['reminderRules']; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [enabled, setEnabled] = useState(rules.enabled);
  const [rows, setRows] = useState<Record<MpReminderTemplateKind, TplRow>>({
    coupon: toRow(rules.coupon, 'coupon'),
    membership: toRow(rules.membership, 'membership'),
    bonus: toRow(rules.bonus, 'bonus'),
  });
  const [saving, setSaving] = useState(false);
  const patch = (kind: MpReminderTemplateKind, p: Partial<TplRow>) => setRows((r) => ({ ...r, [kind]: { ...r[kind], ...p } }));
  const problem = (() => {
    const ids: string[] = [];
    for (const k of KINDS) {
      const r = rows[k.kind];
      if (!r.on) continue;
      if (!MP_REMINDER_TEMPLATE_ID.test(r.templateId.trim())) return `「${k.title}」的模板编号不对：从微信公众平台「订阅消息 → 我的模板」复制`;
      ids.push(r.templateId.trim());
      if (!r.fields.length) return `「${k.title}」至少填一个字段`;
      const keys = r.fields.map((f) => f.key.trim());
      const bad = keys.find((key) => !MP_REMINDER_FIELD_KEY.test(key));
      if (bad !== undefined) return `「${k.title}」的字段名「${bad}」不对：照模板详情里的写，比如 thing1、date2`;
      if (new Set(keys).size !== keys.length) return `「${k.title}」同一个字段名只能填一次`;
    }
    if (new Set(ids).size !== ids.length) return '三种提醒要用三个不同的模板';
    return null;
  })();
  const save = async () => {
    if (problem) return;
    setSaving(true);
    const tpl = (kind: MpReminderTemplateKind): MpReminderTemplate | null => {
      const r = rows[kind];
      return r.on ? { templateId: r.templateId.trim(), fields: r.fields.map((f) => ({ key: f.key.trim(), source: f.source })) } : null;
    };
    try {
      await sendUpdate({
        type: 'reminder_rules_update',
        url: '/api/admin/mp/reminders/rules',
        target: 'reminder_rules',
        body: { enabled, coupon: tpl('coupon'), membership: tpl('membership'), bonus: tpl('bonus'), version: rules.version },
        summary: '到期提醒的设置',
        staffName: session.staff.displayName,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: mpAdminKey }), qc.invalidateQueries({ queryKey: reminderKey })]);
      toast({ tone: 'success', title: '到期提醒的设置已保存' });
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
          <p className="text-[15px] font-semibold text-ink">到期提醒</p>
          <p className="text-[13px] text-ink-3">
            顾客在小程序的券、会员卡、余额页点「到期提醒我」、在微信的弹窗里同意一次，到时候收到一条微信消息（一次同意只能发一条）。
            北京时间 {MP_REMINDER_SEND_HOURS.from}:00–{MP_REMINDER_SEND_HOURS.to}:00 之间发，晚上到点的推到第二天上午。
          </p>
          {pending && <p className="text-[12.5px] text-ember">设置的修改结果待确认，先在上方处理</p>}
        </div>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel="到期提醒开关"
          onChange={(v) => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: '关闭', disabled: pending },
            { value: 'on', label: '开通', disabled: pending },
          ]}
        />
      </div>
      <Notice tone="info">
        模板在微信公众平台「订阅消息」里从公共模板库选（类目要与小程序一致），选好以后把「模板 ID」和模板详情里每个字段的名字填在下面：
        详情里写 {'{{thing1.DATA}}'} 的，字段名填 thing1。没填模板的那种提醒，小程序里不出现「提醒我」。换了模板以后，之前按旧模板同意的不再发。
      </Notice>
      {KINDS.map((k) => {
        const r = rows[k.kind];
        return (
          <div key={k.kind} className="space-y-3 rounded-lg border border-line p-4" data-testid="mp-reminder-template">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-ink">{k.title}</p>
                <p className="text-[12.5px] text-ink-3">{k.when}</p>
              </div>
              <Segmented
                size="sm"
                value={r.on ? 'on' : 'off'}
                ariaLabel={`${k.title}的模板`}
                onChange={(v) => patch(k.kind, { on: v === 'on' })}
                options={[
                  { value: 'off', label: '不发', disabled: pending },
                  { value: 'on', label: '用模板', disabled: pending },
                ]}
              />
            </div>
            {r.on && (
              <>
                <Field label="模板 ID" htmlFor={`mp-reminder-${k.kind}`}>
                  <Input
                    id={`mp-reminder-${k.kind}`}
                    value={r.templateId}
                    disabled={pending}
                    placeholder="从「我的模板」复制，四十多位字母与数字"
                    onChange={(e) => patch(k.kind, { templateId: e.target.value })}
                  />
                </Field>
                <div className="space-y-2">
                  {r.fields.map((f, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label="字段名"
                        fullWidth={false}
                        className="w-40"
                        value={f.key}
                        disabled={pending}
                        invalid={!MP_REMINDER_FIELD_KEY.test(f.key.trim())}
                        onChange={(e) => patch(k.kind, { fields: r.fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                      />
                      <span className="text-[13px] text-ink-3">填</span>
                      <Select
                        aria-label="这个字段填什么"
                        value={f.source}
                        disabled={pending}
                        onChange={(e) => patch(k.kind, { fields: r.fields.map((x, j) => (j === i ? { ...x, source: e.target.value as MpReminderSource } : x)) })}
                      >
                        {k.sources.map((s) => (
                          <option key={s} value={s}>
                            {SOURCE_TEXT[k.kind][s]}
                          </option>
                        ))}
                      </Select>
                      <Button size="sm" variant="ghost" aria-label="去掉这个字段" disabled={pending} onClick={() => patch(k.kind, { fields: r.fields.filter((_, j) => j !== i) })}>
                        <X size={16} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending || r.fields.length >= MP_REMINDER_FIELDS_MAX}
                    onClick={() => patch(k.kind, { fields: [...r.fields, { key: '', source: 'tip' }] })}
                  >
                    <Plus size={14} /> 加一个字段
                  </Button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {problem && <p className="text-[12.5px] text-ember">{problem}</p>}
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} disabled={pending || !!problem} onClick={save}>
          保存到期提醒的设置
        </Button>
      </div>
    </Card>
  );
}

function Stats({ d }: { d: MpReminderAdminData }) {
  const leaseAgo = d.lastLeaseAt ? Math.round((Date.now() - Date.parse(d.lastLeaseAt)) / 60_000) : null;
  return (
    <Card className="p-0">
      <div className="space-y-1 border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">最近的提醒</p>
        <p className="num text-[13px] text-ink-3">
          最近 30 天同意了 {d.stats.consents} 次 · 已发出 {d.stats.byStatus.sent ?? 0} · 没发出 {d.stats.byStatus.failed ?? 0} · 结果不明 {d.stats.byStatus.unknown ?? 0} · 不用发了{' '}
          {d.stats.byStatus.skipped ?? 0} · 还没到发的时候 {d.stats.waiting}
        </p>
        {d.stats.overdue > 0 && (
          <p className="text-[13px] text-ember">
            有 {d.stats.overdue} 条到了那天还没排成消息：到期提醒关着、不在 {MP_REMINDER_SEND_HOURS.from}:00–{MP_REMINDER_SEND_HOURS.to}:00，或排期出错（看门店系统的日志）
          </p>
        )}
        <p className="text-[13px] text-ink-3">
          {leaseAgo === null
            ? '网关还没来取过消息（重启后等网关下一次来）：开着到期提醒时，网关每 30 秒来取一次'
            : leaseAgo <= 2
              ? `网关在取消息（${formatDateTime(d.lastLeaseAt!)}）`
              : `网关 ${leaseAgo} 分钟没来取消息了：请看网关是不是开着、连得上门店`}
        </p>
      </div>
      {d.recent.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有提醒消息</p>
      ) : (
        <div className="divide-y divide-line">
          {d.recent.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]" data-testid="mp-reminder-message">
              <span className="num text-ink-3">{formatDateTime(m.createdAt)}</span>
              <span className="font-semibold text-ink">{m.memberName}</span>
              <span>{KIND_LABELS[m.kind]}</span>
              <span className="num text-ink-3">到期 {m.targetDate}</span>
              <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
              {m.reason && <span className="text-ink-3">{m.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
