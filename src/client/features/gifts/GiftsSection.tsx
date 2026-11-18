// 后台「签赠」（8.1.9，docs/GIFTS_V819.md 第 2.2 节，SZ2）：会员与营销组里的一个分区，三个页签——
//   配置（开关、板块与发放渠道的选项、签赠总则）→ 知识库（签赠券类型）→ 台账（与管家部、客户部的签赠台账同一份）。
// 页签写进地址（/admin/gifts/types），顺序与别的分区一样：规则在前，再是清单、统计。

import { useState } from 'react';
import { Plus, Save, X } from 'lucide-react';
import type { GiftRules } from '@shared/gifts';
import { api, errorMessage } from '../../lib/api';
import { LoadFailed } from '../../components/LoadFailed';
import { useActiveSubTab } from '../../components/SubNav';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, Segmented, Skeleton, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { GiftLedger } from './GiftLedger';
import { GiftTypesTab } from './GiftTypes';
import { useGiftRules, useInvalidateGifts } from './queries';

type Tab = 'rules' | 'types' | 'ledger';
const TABS: { key: Tab; label: string }[] = [
  { key: 'rules', label: '配置' },
  { key: 'types', label: '知识库' },
  { key: 'ledger', label: '台账' },
];
const GIFT_TABS = TABS.map((t) => ({ key: t.key, label: <span data-testid={`gift-tab-${t.key}`}>{t.label}</span> }));

export function GiftsSection() {
  return (
    <AdminPage
      section="gifts"
      tabs={GIFT_TABS}
      description="签赠券类型（送什么、板块、权益内容、规则说明）全公司一套；发放要选授权人与渠道，前台结账时客人用掉。管家部、客户部各有「签赠台账」，与这里的台账是同一份。"
    >
      <GiftTabBody />
    </AdminPage>
  );
}

function GiftTabBody() {
  const tab = (useActiveSubTab() ?? TABS[0]!.key) as Tab;
  return tab === 'types' ? <GiftTypesTab /> : tab === 'ledger' ? <GiftLedger testId="gift-admin-ledger" /> : <GiftRulesCard />;
}

/** 选项的增删：板块、发放渠道 */
function OptionEditor({ label, value, onChange, testId }: { label: string; value: string[]; onChange: (next: string[]) => void; testId: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || value.includes(v)) return setDraft('');
    onChange([...value, v]);
    setDraft('');
  };
  return (
    <Field label={label}>
      <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
        {value.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded-full bg-paper-2 py-1 pr-1 pl-3 text-[13px]">
            {v}
            <button
              type="button"
              aria-label={`去掉「${v}」`}
              className="rounded-full p-0.5 text-ink-3 hover:bg-line hover:text-ink"
              disabled={value.length <= 1}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <span className="flex items-center gap-1">
          <Input
            fullWidth={false}
            className="h-8 w-32"
            maxLength={20}
            value={draft}
            placeholder={`加一个${label}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            aria-label={`新的${label}`}
            data-testid={`${testId}-input`}
          />
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add} data-testid={`${testId}-add`}>
            加
          </Button>
        </span>
      </div>
    </Field>
  );
}

function GiftRulesCard() {
  const rules = useGiftRules();
  if (rules.isPending) return <Skeleton className="h-64" />;
  if (rules.isError && !rules.data)
    return (
      <LoadFailed title="签赠的配置没取回来" onRetry={() => void rules.refetch()} retrying={rules.isFetching}>
        {errorMessage(rules.error)}
      </LoadFailed>
    );
  // 保存过以后按服务端回来的重新开一份表单
  return <RulesForm key={JSON.stringify(rules.data)} initial={rules.data!} />;
}

function RulesForm({ initial }: { initial: GiftRules }) {
  const toast = useToast();
  const invalidate = useInvalidateGifts();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/gifts/rules', form);
      toast({ tone: 'success', title: '签赠的配置已保存' });
      await invalidate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="space-y-4 p-4" data-testid="gift-rules">
      <Field label="签赠" hint="关掉以后不能再发签赠；已发的照常能用，台账照常看">
        <Segmented
          value={form.enabled ? 'on' : 'off'}
          onChange={(v) => setForm((f) => ({ ...f, enabled: v === 'on' }))}
          options={[
            { value: 'on', label: '开' },
            { value: 'off', label: '关' },
          ]}
          ariaLabel="签赠开关"
        />
      </Field>
      <OptionEditor label="板块" value={form.segments} onChange={(segments) => setForm((f) => ({ ...f, segments }))} testId="gift-segments" />
      <OptionEditor label="发放渠道" value={form.channels} onChange={(channels) => setForm((f) => ({ ...f, channels }))} testId="gift-channels" />
      <Field label="签赠总则" htmlFor="gift-general-rules" hint="全店通用的说明；发放签赠时显示在弹窗顶上">
        <Textarea
          id="gift-general-rules"
          rows={4}
          maxLength={2000}
          value={form.generalRules}
          onChange={(e) => setForm((f) => ({ ...f, generalRules: e.target.value }))}
          placeholder="例如：签赠只送会员；同一位会员一个月最多两次；超过 ¥200 的要店总授权"
          data-testid="gift-general-rules"
        />
      </Field>
      {error && (
        <Notice tone="error" title="没有保存">
          {error}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={() => void save()} data-testid="gift-rules-save">
          保存
        </Button>
      </div>
    </Card>
  );
}
