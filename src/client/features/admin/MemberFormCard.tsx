// 后台「会员体系 → 渠道与标签」里的「建档表单」（8.1.15，docs/MEMBERS_V8115.md）：
// 新建、编辑会员时每个选填项显示不显示、必填不必填，以及实体卡押金。按门店：第二家店在这里改的只管它自己。
// 姓名、手机号（匿名卡除外）、卡类型、会员等级固定必填，不在这里配。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_MEMBER_FORM_RULES, MAX_CARD_DEPOSIT, MEMBER_FORM_FIELD_LABELS, MEMBER_FORM_FIELDS, type MemberFormField, type MemberFormRules } from '@shared/member-form';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

export function MemberFormCard() {
  const settings = useSettings();
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<MemberFormRules['fields'] | null>(null);
  const [deposit, setDeposit] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = settings.data ? (settings.data.memberForm ?? DEFAULT_MEMBER_FORM_RULES) : null;
  if (saved && !draft) {
    setDraft(saved.fields);
    setDeposit(centsToInput(saved.cardDeposit));
  }
  if (!draft || !saved) return <Skeleton className="h-64" />;
  const cents = parseYuan(deposit);
  const problem = cents === null || cents < 0 ? '押金金额不正确' : cents > MAX_CARD_DEPOSIT ? `押金最多 ${formatYuan(MAX_CARD_DEPOSIT)}` : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.fields) || (cents !== null && cents !== saved.cardDeposit);
  const set = (key: MemberFormField, patch: Partial<MemberFormRules['fields'][MemberFormField]>) => {
    const next = { ...draft[key], ...patch };
    // 不显示的字段不会是必填
    setDraft({ ...draft, [key]: { show: next.show, required: next.show && next.required } });
  };

  const save = async () => {
    if (problem || cents === null) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<{ memberForm: MemberFormRules }>('/api/settings', { memberForm: { cardDeposit: cents, fields: draft } });
      setDraft(next.memberForm.fields);
      setDeposit(centsToInput(next.memberForm.cardDeposit));
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: '建档表单已保存', body: '新建、编辑会员时按新的设置显示与核对。' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5" data-testid="member-form-card">
      <SectionTitle>
        <span className="inline-flex items-center gap-2">
          建档表单 <PendingBadge title="8.1.15：选填项默认都显示、都不必填；实体卡押金默认 20 元（待店主确认）" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        新建会员先选卡类型（电子卡 / 实体卡 / 匿名卡）再填表。姓名、手机号（匿名卡除外）、卡类型、会员等级固定必填；下面的选填项可以设成不显示或必填。不显示的字段已经登记的内容保持原样。
        {session.store.id !== 1 && <b className="text-ink-2"> 这一份是「{session.store.name}」单独的设置，不影响别的门店。</b>}
      </p>
      <ul className="mt-4 divide-y divide-line/70 rounded-lg border border-line">
        {MEMBER_FORM_FIELDS.map((key) => (
          <li key={key} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5', !draft[key].show && 'bg-paper-2/50')} data-testid={`member-form-field-${key}`}>
            <span className={cn('min-w-[5em] flex-1 text-[14px] font-semibold', draft[key].show ? 'text-ink' : 'text-ink-3')}>{MEMBER_FORM_FIELD_LABELS[key]}</span>
            <Segmented
              size="sm"
              ariaLabel={`「${MEMBER_FORM_FIELD_LABELS[key]}」显示不显示`}
              value={draft[key].show ? 'show' : 'hide'}
              onChange={(v) => set(key, { show: v === 'show' })}
              options={[
                { value: 'show', label: '显示' },
                { value: 'hide', label: '不显示' },
              ]}
            />
            <Segmented
              size="sm"
              ariaLabel={`「${MEMBER_FORM_FIELD_LABELS[key]}」必填不必填`}
              value={draft[key].required ? 'required' : 'optional'}
              onChange={(v) => set(key, { required: v === 'required' })}
              options={[
                { value: 'optional', label: '选填', disabled: !draft[key].show },
                { value: 'required', label: '必填', disabled: !draft[key].show },
              ]}
            />
          </li>
        ))}
      </ul>
      <div className="mt-4 max-w-[320px]">
        <Field label="实体卡押金（元）" htmlFor="member-card-deposit" hint="发实体卡时收，0 = 不收押金。押金是负债：不进储值、不算营业额，退卡时全额退" error={problem}>
          <MoneyInput id="member-card-deposit" value={deposit} onChange={(e) => setDeposit(e.target.value)} invalid={!!problem} data-testid="member-card-deposit-input" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {dirty && !problem && <span className="text-[12.5px] text-ink-3">有未保存的修改</span>}
        <Button variant="primary" size="lg" loading={saving} disabled={!dirty || !!problem} onClick={() => void save()} data-testid="member-form-save">
          保存建档表单
        </Button>
      </div>
    </Card>
  );
}
