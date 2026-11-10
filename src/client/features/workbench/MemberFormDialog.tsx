import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MemberPhoneGrantRequest } from '@shared/grants';
import { formatPhone } from '@shared/labels';
import type { MemberDetail, MemberSummary } from '@shared/types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Segmented, Select, Textarea } from '../../components/ui';
import { TagPicker } from '../membership/TagPicker';

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
  const can = useCan();
  // 启用的渠道；编辑时会员原来的渠道已停用也照常列出，不改就保留
  const channels = (session.rules.memberChannels ?? []).filter((c) => c.active || c.key === member?.channel);
  /** 会员标签（8.0.4，替代原来的自定义字段） */
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<Gender>('unknown');
  const [birthday, setBirthday] = useState('');
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<{ id: number; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 改手机号（v0.7.26，M77）：要写原因；没有「改会员手机号」权限的要值班经理及以上当场授权
  const [phoneReason, setPhoneReason] = useState('');
  const [authorizing, setAuthorizing] = useState(false);
  const cleanPhone = phone.replace(/[\s-]/g, '');
  const phoneChanged = !!member && cleanPhone !== member.phone;

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
      setTagIds((member?.tags ?? []).map((t) => t.id));
      setErrors({});
      setExisting(null);
      setPhoneReason('');
      setAuthorizing(false);
    },
    [member, prefill],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const save = async (phoneGrantId?: string) => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = '请填写会员姓名';
    if (!/^1\d{10}$/.test(cleanPhone)) errs.phone = '请输入 11 位手机号';
    if (phoneChanged && phoneReason.trim().length < 2) errs.phoneReason = '改手机号要写原因（至少 2 个字）';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    // 没有「改会员手机号」权限：先请值班经理、店总或店主当场授权（授权绑定这位会员与新号码）
    if (phoneChanged && !can('member.phone') && !phoneGrantId) {
      setAuthorizing(true);
      return;
    }
    setSaving(true);
    setExisting(null);
    const body = {
      name,
      phone: cleanPhone,
      gender: gender === 'unknown' ? null : gender,
      birthday: birthday || null,
      note,
      tagIds,
      channel: channel || null,
      ...(phoneChanged ? { phoneReason: phoneReason.trim(), ...(phoneGrantId ? { phoneGrantId } : {}) } : {}),
    };
    try {
      const saved = member
        ? await api.put<MemberDetail>(`/api/members/${member.id}`, body)
        : await api.post<MemberSummary>('/api/members', body);
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['member', saved.id] });
      // 换手机号的记录列在「储值与账户」里（v0.7.26）
      if (phoneChanged) void qc.invalidateQueries({ queryKey: ['member-account-history', saved.id] });
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
        {phoneChanged && (
          <Field
            label="改手机号的原因"
            htmlFor="m-phone-reason"
            hint={can('member.phone') ? `${formatPhone(member!.phone)} → ${formatPhone(cleanPhone)}` : '保存时请值班经理、店总或店主当场授权'}
            error={errors.phoneReason}
          >
            <Input id="m-phone-reason" value={phoneReason} maxLength={200} onChange={(e) => setPhoneReason(e.target.value)} invalid={!!errors.phoneReason} data-testid="member-phone-reason" />
          </Field>
        )}
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
        <Field label="会员标签" hint="选填，例如亲子客、商务客；按标签筛选、导出在数据看板「会员总览」" error={errors.tagIds}>
          <TagPicker value={tagIds} onChange={setTagIds} current={member?.tags ?? []} />
        </Field>
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
