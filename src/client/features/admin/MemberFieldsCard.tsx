import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PencilLine, Plus } from 'lucide-react';
import { MAX_MEMBER_FIELDS, MEMBER_FIELD_TYPE_LABELS, MEMBER_FIELD_TYPES, type MemberFieldDef, type MemberFieldType } from '@shared/member-fields';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Select, Skeleton, Textarea } from '../../components/ui';

/** 编辑中的字段：新字段还没有编号 */
type DraftField = Omit<MemberFieldDef, 'key'> & { key: string | null };

/**
 * 会员自定义字段（店主 #12）：固定字段之外的会员资料。
 * 字段保存后不能删除、不能改类型，只能停用；停用的字段不再显示和要求填写，已填的内容保留。
 */
export function MemberFieldsCard() {
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<DraftField[] | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; field: DraftField } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (settings.data && !draft) setDraft(settings.data.memberFields);
  if (!draft) return <Skeleton className="h-40" />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data?.memberFields ?? []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<{ memberFields: MemberFieldDef[] }>('/api/settings', { memberFields: draft });
      setDraft(next.memberFields);
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: '会员字段已保存', body: '新建和编辑会员时按新的字段填写。' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5" data-testid="member-fields-card">
      <SectionTitle
        aside={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={draft.length >= MAX_MEMBER_FIELDS}
            onClick={() => setEditing({ index: null, field: { key: null, label: '', type: 'text', options: [], required: false, active: true } })}
          >
            新增字段
          </Button>
        }
      >
        会员资料字段
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        姓名、手机号、性别、生日、备注是固定字段（一人只能登记一个手机号）；这里增加其他字段，例如车牌号、了解渠道。字段保存后不能删除、不能改类型，不用时停用，已填的内容保留。
      </p>
      {draft.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-ink-3">还没有自定义字段</p>
      ) : (
        <ul className="mt-4 divide-y divide-line/70 rounded-lg border border-line">
          {draft.map((f, i) => (
            <li key={f.key ?? `new-${i}`} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5', !f.active && 'opacity-60')}>
              <span className="text-[14px] font-bold text-ink">{f.label}</span>
              <Badge tone="neutral">{MEMBER_FIELD_TYPE_LABELS[f.type]}</Badge>
              {f.required && <Badge tone="ember">必填</Badge>}
              {!f.active && <Badge tone="clay">已停用</Badge>}
              {!f.key && <Badge tone="lake">未保存</Badge>}
              {f.type === 'select' && <span className="min-w-0 truncate text-[12.5px] text-ink-3">{f.options.join(' / ')}</span>}
              <span className="flex-1" />
              <Button size="sm" variant="ghost" icon={<PencilLine className="size-3.5" />} onClick={() => setEditing({ index: i, field: f })}>
                编辑
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save} data-testid="member-fields-save">
          保存会员字段
        </Button>
      </div>
      <FieldDialog
        editing={editing}
        labels={draft.filter((_, i) => i !== editing?.index).map((f) => f.label)}
        onClose={() => setEditing(null)}
        onDone={(field) => {
          setDraft((d) => (editing?.index == null ? [...d!, field] : d!.map((f, i) => (i === editing.index ? field : f))));
          setEditing(null);
        }}
        onRemove={
          editing && editing.index !== null && !editing.field.key
            ? () => {
                setDraft((d) => d!.filter((_, i) => i !== editing.index));
                setEditing(null);
              }
            : undefined
        }
      />
    </Card>
  );
}

function FieldDialog({
  editing,
  labels,
  onClose,
  onDone,
  onRemove,
}: {
  editing: { index: number | null; field: DraftField } | null;
  labels: string[];
  onClose: () => void;
  onDone: (field: DraftField) => void;
  /** 只有还没保存的新字段可以直接删掉 */
  onRemove?: () => void;
}) {
  const [field, setField] = useState<DraftField | null>(null);
  const [optionsText, setOptionsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<typeof editing>(null);
  if (editing !== lastOpened) {
    setLastOpened(editing);
    setField(editing?.field ?? null);
    setOptionsText(editing?.field.options.join('\n') ?? '');
    setError(null);
  }
  const saved = !!editing?.field.key;

  const done = () => {
    if (!field) return;
    const label = field.label.trim();
    const options = [...new Set(optionsText.split('\n').map((o) => o.trim()).filter(Boolean))];
    if (!label) return setError('请填写字段名称');
    if (labels.includes(label)) return setError(`已有名为「${label}」的字段`);
    if (field.type === 'select' && options.length === 0) return setError('单选字段至少要有一个可选值（每行一个）');
    if (options.some((o) => o.length > 16)) return setError('每个可选值最多 16 个字');
    onDone({ ...field, label, options: field.type === 'select' ? options : [] });
  };

  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      title={editing?.index == null ? '新增会员字段' : '编辑会员字段'}
      description={saved ? '保存后的字段不能删除和改类型；不用时停用，已填的内容保留。' : '确认后点「保存会员字段」才会生效。'}
      footer={
        <>
          {onRemove && (
            <Button variant="ghost" className="mr-auto text-clay" onClick={onRemove}>
              删除这个新字段
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={done} data-testid="member-field-done">
            确定
          </Button>
        </>
      }
    >
      {field && (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="字段名称" htmlFor="mf-label">
              <Input id="mf-label" value={field.label} maxLength={16} onChange={(e) => setField({ ...field, label: e.target.value })} data-autofocus />
            </Field>
            <Field label="类型" htmlFor="mf-type" hint={saved ? '保存后不能修改' : undefined}>
              <Select id="mf-type" value={field.type} disabled={saved} onChange={(e) => setField({ ...field, type: e.target.value as MemberFieldType })}>
                {MEMBER_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {MEMBER_FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {field.type === 'select' && (
            <Field label="可选值" htmlFor="mf-options" hint="每行一个，最多 20 个">
              <Textarea id="mf-options" value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder={'朋友推荐\n大众点评\n路过'} />
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            <label className={cn('flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5', field.required ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card')}>
              <input type="checkbox" checked={field.required} onChange={(e) => setField({ ...field, required: e.target.checked })} className="size-4 accent-[var(--color-pine)]" />
              <span className="text-[13.5px] font-semibold">必填（新建和编辑会员时必须填写）</span>
            </label>
            <label className={cn('flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5', field.active ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card')}>
              <input type="checkbox" checked={field.active} onChange={(e) => setField({ ...field, active: e.target.checked })} className="size-4 accent-[var(--color-pine)]" />
              <span className="text-[13.5px] font-semibold">启用</span>
            </label>
          </div>
          {error && <Notice tone="error" title={error} />}
        </div>
      )}
    </Dialog>
  );
}
