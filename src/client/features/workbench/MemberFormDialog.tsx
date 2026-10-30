import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { normalizeFieldValue, type MemberFieldDef } from '@shared/member-fields';
import type { MemberDetail, MemberSummary } from '@shared/types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Segmented, Select, Textarea } from '../../components/ui';

type Gender = 'female' | 'male' | 'unknown';

/** 新建 / 编辑会员档案 */
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
  /** 启用的自定义字段（#12） */
  const fields = session.rules.memberFields.filter((d) => d.active);
  // 启用的渠道；编辑时会员原来的渠道已停用也照常列出，不改就保留
  const channels = (session.rules.memberChannels ?? []).filter((c) => c.active || c.key === member?.channel);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<Gender>('unknown');
  const [birthday, setBirthday] = useState('');
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<{ id: number; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useResetOnOpen(
    open,
    () => {
      const digits = prefill?.replace(/\D/g, '') ?? '';
      setName(member?.name ?? (prefill && !digits ? prefill : ''));
      setPhone(member?.phone ?? (digits.length >= 3 ? digits : ''));
      setGender(member?.gender ?? 'unknown');
      setBirthday(member?.birthday ?? '');
      setNote(member?.note ?? '');
      setChannel(member?.channel ?? '');
      setCustom(Object.fromEntries(Object.entries(member?.customFields ?? {}).map(([k, v]) => [k, String(v)])));
      setErrors({});
      setExisting(null);
    },
    [member, prefill],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const cleanPhone = phone.replace(/[\s-]/g, '');
    if (!name.trim()) errs.name = '请填写会员姓名';
    if (!/^1\d{10}$/.test(cleanPhone)) errs.phone = '请输入 11 位手机号';
    for (const f of fields) {
      const { value, error } = normalizeFieldValue(f, custom[f.key]);
      if (error) errs[`customFields.${f.key}`] = error;
      else if (value === undefined && f.required) errs[`customFields.${f.key}`] = `请填写「${f.label}」`;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setExisting(null);
    const customFields = Object.fromEntries(fields.map((f) => [f.key, custom[f.key] ?? '']));
    const body = { name, phone: cleanPhone, gender: gender === 'unknown' ? null : gender, birthday: birthday || null, note, customFields, channel: channel || null };
    try {
      const saved = member
        ? await api.put<MemberDetail>(`/api/members/${member.id}`, body)
        : await api.post<MemberSummary>('/api/members', body);
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['member', saved.id] });
      toast({ tone: 'success', title: member ? '会员资料已更新' : `已为「${saved.name}」建档`, body: member ? undefined : `会员号 ${saved.memberNo}` });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PHONE_EXISTS' && typeof err.details?.memberId === 'number') {
        setExisting({ id: err.details.memberId, message: err.message });
      } else if (err instanceof ApiError && err.details?.field) {
        setErrors({ [String(err.details.field)]: err.message });
      } else {
        setErrors({ form: errorMessage(err) });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={member ? '编辑会员资料' : '新建会员'}
      description={member ? `${member.memberNo} · 余额与流水不受影响` : '手机号是查找会员的主要依据，请与顾客当面核对。'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" type="submit" form="member-form" loading={saving}>
            {member ? '保存' : '建档'}
          </Button>
        </>
      }
    >
      <form id="member-form" onSubmit={submit} className="grid gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="姓名" htmlFor="m-name" error={errors.name}>
            <Input id="m-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} data-autofocus />
          </Field>
          <Field label="手机号" htmlFor="m-phone" error={errors.phone}>
            <Input id="m-phone" value={phone} inputMode="tel" maxLength={13} onChange={(e) => setPhone(e.target.value)} invalid={!!errors.phone} className="num" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="性别">
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
          <Field label="生日" htmlFor="m-birthday" hint="选填">
            <Input id="m-birthday" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
          </Field>
        </div>
        {channels.length > 0 && (
          <Field label="渠道来源" htmlFor="m-channel" hint="选填，顾客从哪里知道我们" error={errors.channel}>
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
        {fields.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2" data-testid="member-custom-form">
            {fields.map((f) => (
              <CustomFieldInput
                key={f.key}
                def={f}
                value={custom[f.key] ?? ''}
                error={errors[`customFields.${f.key}`]}
                onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
              />
            ))}
          </div>
        )}
        <Field label="备注" htmlFor="m-note" hint="选填，如偏好、过敏或注意事项">
          <Textarea id="m-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
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
    </Dialog>
  );
}

/** 一个自定义字段的输入：文字、数字、日期、单选 */
function CustomFieldInput({ def, value, error, onChange }: { def: MemberFieldDef; value: string; error?: string; onChange: (v: string) => void }) {
  const id = `m-field-${def.key}`;
  return (
    <Field label={def.label} htmlFor={id} hint={def.required ? '必填' : '选填'} error={error}>
      {def.type === 'select' ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error || undefined}>
          <option value="">{def.required ? '请选择' : '不填'}</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={def.type === 'date' ? 'date' : 'text'}
          inputMode={def.type === 'number' ? 'decimal' : undefined}
          maxLength={def.type === 'text' ? 100 : undefined}
          value={value}
          invalid={!!error}
          className={def.type === 'number' ? 'num' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
