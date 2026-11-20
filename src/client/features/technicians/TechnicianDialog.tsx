// 新建、编辑技师的对话框：门店「技师管理 → 名册」与后台「技师 → 技师名册」共用（8.1.15 从后台的名册卡片里搬出来，
// 补上花名、类型、入职日期）。保存走原来的名册接口（/api/admin/technicians，要「维护技师名册」权限）。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import { MAX_TECH_NAME, TECH_NO_PATTERN, type Technician, type TechnicianAdmin } from '@shared/technicians';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { useTechAdminRefresh } from './queries';

export type EditableTechnician = Technician & { lineCount?: number };

export function TechnicianDialog({
  target,
  categories,
  kinds,
  onClose,
}: {
  target: EditableTechnician | 'new' | null;
  /** 项目分类（可做的分类从这里选） */
  categories: string[];
  /** 技师类型的清单 */
  kinds: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const isNew = target === 'new';
  const existing = target && target !== 'new' ? target : null;
  const [techNo, setTechNo] = useState('');
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [kind, setKind] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('female');
  const [grade, setGrade] = useState<PriceTier>('standard');
  const [skills, setSkills] = useState<string[]>([]);
  const [hiredOn, setHiredOn] = useState('');
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<typeof target>(null);
  if (target !== last) {
    setLast(target);
    setTechNo(existing?.techNo ?? '');
    setName(existing?.name ?? '');
    setNickname(existing?.nickname ?? '');
    setKind(existing?.kind ?? '');
    setGender(existing?.gender ?? 'female');
    setGrade(existing?.grade ?? 'standard');
    setSkills(existing?.skills ?? []);
    setHiredOn(existing?.hiredOn ?? '');
    setNote(existing?.note ?? '');
    setActive(existing?.active ?? true);
    setSortOrder(String(existing?.sortOrder ?? 0));
    setError(null);
  }
  // 名册里的分类可能已不在价目表里（项目改了分类），照样列出，方便去掉；类型同理
  const options = [...new Set([...categories, ...skills])];
  const kindOptions = [...new Set([...kinds, ...(kind ? [kind] : [])])];
  const problem =
    isNew && !TECH_NO_PATTERN.test(techNo.trim()) ? '工号为 1–6 位数字或字母，例如 08、A12' : !name.trim() ? '请填写技师名字' : !/^\d{1,4}$/.test(sortOrder) ? '排序请填 0–9999 的整数' : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), nickname: nickname.trim(), kind, gender, grade, skills, hiredOn: hiredOn || null, note: note.trim(), active, sortOrder: Number(sortOrder) };
    try {
      const next = isNew
        ? await api.post<TechnicianAdmin>('/api/admin/technicians', { ...body, techNo: techNo.trim() })
        : await api.put<TechnicianAdmin>(`/api/admin/technicians/${existing!.id}`, body);
      qc.setQueryData(['admin', 'technicians'], next);
      refresh();
      toast({ tone: 'success', title: isNew ? `已添加技师 ${techNo.trim()} 号 ${name.trim()}` : '已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={isNew ? '新建技师' : `编辑技师 · ${existing?.techNo} 号`}
      description={
        isNew
          ? '工号保存后不能改；离职的技师停用即可，不删除。'
          : existing?.lineCount !== undefined
            ? `${existing.lineCount} 项明细记在这位技师名下，改名字后历史明细也显示新名字。`
            : '工号保存后不能改；改名字后历史明细也显示新名字。'
      }
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="technician-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[120px_minmax(0,1fr)]">
          <Field label="工号" htmlFor="t-no">
            {isNew ? (
              <Input id="t-no" value={techNo} maxLength={6} onChange={(e) => setTechNo(e.target.value)} className="num" placeholder="08" data-autofocus data-testid="technician-no" />
            ) : (
              <p className="num flex h-11 items-center text-[18px] font-bold">{existing?.techNo}</p>
            )}
          </Field>
          <Field label="名字" htmlFor="t-name" hint="艺名或姓名，前台与小票上显示">
            <Input id="t-name" value={name} maxLength={MAX_TECH_NAME} onChange={(e) => setName(e.target.value)} data-testid="technician-name" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="花名" htmlFor="t-nickname" hint="选填；钟房里跟在名字后面，叫号时念花名">
            <Input id="t-nickname" value={nickname} maxLength={MAX_TECH_NAME} onChange={(e) => setNickname(e.target.value)} placeholder="例如：小雅" data-testid="technician-nickname" />
          </Field>
          <Field label="类型" htmlFor="t-kind" hint="钟房按类型筛选；清单在「技师管理 → 名册」里改">
            <Select id="t-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="h-11" data-testid="technician-kind">
              <option value="">不设</option>
              {kindOptions.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="性别">
            <Segmented
              ariaLabel="技师性别"
              value={gender}
              onChange={setGender}
              className="w-full"
              options={[
                { value: 'female', label: '女' },
                { value: 'male', label: '男' },
              ]}
            />
          </Field>
          <Field label="等级" hint="价格跟技师等级时按这一档取价">
            <Segmented ariaLabel="技师等级" value={grade} onChange={setGrade} className="w-full" options={PRICE_TIERS.map((g) => ({ value: g, label: PRICE_TIER_LABELS[g] }))} />
          </Field>
        </div>
        <Field label="可做的项目分类" hint={skills.length ? `只能挂这 ${skills.length} 类的项目` : '不勾选 = 全部需要技师的项目都能做'}>
          <div className="flex flex-wrap gap-1.5">
            {options.length === 0 && <span className="text-[12.5px] text-ink-3">价目表里还没有项目分类</span>}
            {options.map((c) => {
              const on = skills.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSkills(on ? skills.filter((x) => x !== c) : [...skills, c])}
                  className={cn(
                    'h-9 rounded-full border px-3 text-[13px] font-semibold transition-colors',
                    on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4',
                  )}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <Field label="入职日期" htmlFor="t-hired" hint="选填">
            <Input id="t-hired" type="date" value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} data-testid="technician-hired" />
          </Field>
          <Field label="排序" htmlFor="t-sort" hint="小的在前">
            <Input id="t-sort" value={sortOrder} inputMode="numeric" maxLength={4} onChange={(e) => setSortOrder(e.target.value)} className="num" />
          </Field>
        </div>
        <Field label="备注" htmlFor="t-note">
          <Input id="t-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="例如：擅长足疗，周二休" />
        </Field>
        {!isNew && (
          <Field label="状态" hint={existing?.leftOn ? `离职日期 ${existing.leftOn}` : undefined}>
            <Segmented
              ariaLabel="技师状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '在职' },
                { value: 'off', label: '离职（停用，前台不能再选）' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
