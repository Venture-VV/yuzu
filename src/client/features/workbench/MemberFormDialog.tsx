import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MemberDetail, MemberSummary } from '@shared/types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Segmented, Textarea } from '../../components/ui';

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
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<Gender>('unknown');
  const [birthday, setBirthday] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<{ id: number; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const digits = prefill?.replace(/\D/g, '') ?? '';
    setName(member?.name ?? (prefill && !digits ? prefill : ''));
    setPhone(member?.phone ?? (digits.length >= 3 ? digits : ''));
    setGender(member?.gender ?? 'unknown');
    setBirthday(member?.birthday ?? '');
    setNote(member?.note ?? '');
    setErrors({});
    setExisting(null);
  }, [open, member, prefill]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const cleanPhone = phone.replace(/[\s-]/g, '');
    if (!name.trim()) errs.name = '请填写会员姓名';
    if (!/^1\d{10}$/.test(cleanPhone)) errs.phone = '请输入 11 位手机号';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setExisting(null);
    const body = { name, phone: cleanPhone, gender: gender === 'unknown' ? null : gender, birthday: birthday || null, note };
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
