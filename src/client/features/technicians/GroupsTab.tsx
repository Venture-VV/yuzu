// 技师管理 · 技师组别（8.1.15）：分组与组长。一位技师一个组；组员整份保存——名单里的归到这个组（原来在别的组的挪过来），
// 不在名单里的退出；组长是组员之一。停用的组不留组员。钟房的技师卡片、名册上都显示组别。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Crown, Plus } from 'lucide-react';
import { MAX_GROUP_NAME, type RosterTechnician, type TechGroup, type TechnicianAdminView } from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select } from '../../components/ui';
import { techViewKey, useTechAdminRefresh } from './queries';

const techLabel = (t: { techNo: string; name: string; nickname: string }) => `${t.techNo} 号 ${t.name}${t.nickname ? `「${t.nickname}」` : ''}`;

export function GroupsTab({ view }: { view: TechnicianAdminView }) {
  const [editing, setEditing] = useState<TechGroup | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const byId = new Map(view.technicians.map((t) => [t.id, t]));
  const groups = view.groups.filter((g) => showInactive || g.active);
  const inactive = view.groups.filter((g) => !g.active).length;
  const ungrouped = view.technicians.filter((t) => t.active && t.groupId === null);

  return (
    <div className="space-y-4" data-testid="tech-groups">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="min-w-0 flex-1 basis-60 text-[13px] text-ink-2">
          一位技师一个组，组长是组员之一。组别显示在钟房的技师卡片与名册上。
          {inactive > 0 && (
            <button type="button" className="ml-2 font-semibold text-ink-3 underline-offset-2 hover:underline" onClick={() => setShowInactive((v) => !v)}>
              {showInactive ? '不看' : '也看'}停用的 {inactive} 个
            </button>
          )}
        </p>
        {view.canManage && (
          <Button size="lg" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="tech-group-new">
            新建组别
          </Button>
        )}
      </div>
      {groups.length === 0 ? (
        <Card>
          <EmptyState art="leaf" title="还没有组别" description={view.canManage ? '点「新建组别」，起个名字、选组员与组长。' : '请有「维护技师名册」权限的同事来分组。'} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const leader = g.leaderId === null ? null : byId.get(g.leaderId);
            const members = g.memberIds.map((id) => byId.get(id)).filter((t): t is RosterTechnician => !!t);
            return (
              <Card key={g.id} className={cn('flex flex-col p-4', !g.active && 'bg-paper-2/60')} data-testid={`tech-group-${g.name}`}>
                <SectionTitle
                  aside={
                    view.canManage && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(g)} data-testid={`tech-group-edit-${g.name}`}>
                        编辑
                      </Button>
                    )
                  }
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {g.name}
                    {g.active ? <Badge tone="pine">{members.length} 人</Badge> : <Badge tone="clay">已停用</Badge>}
                  </span>
                </SectionTitle>
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-2">
                  <Crown className="size-4 text-yuzu-deep" aria-hidden />
                  组长：{leader ? <span className="font-semibold text-ink">{techLabel(leader)}</span> : <span className="text-ink-3">没有设</span>}
                </p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {members.map((t) => (
                    <li
                      key={t.id}
                      className={cn('rounded-full border px-2.5 py-1 text-[13px] font-semibold', t.id === g.leaderId ? 'border-yuzu-deep/40 bg-yuzu-tint text-ink' : 'border-line-strong text-ink-2')}
                    >
                      <span className="num">{t.techNo}</span> {t.nickname || t.name}
                      {!t.active && <span className="ml-1 font-normal text-clay">已离职</span>}
                    </li>
                  ))}
                  {g.active && members.length === 0 && <li className="text-[13px] text-ink-3">还没有组员</li>}
                </ul>
                {g.note && <p className="mt-2 text-[12.5px] text-ink-3">{g.note}</p>}
              </Card>
            );
          })}
        </div>
      )}
      {ungrouped.length > 0 && (
        <Card className="p-4" data-testid="tech-ungrouped">
          <SectionTitle>未分组 {ungrouped.length} 人</SectionTitle>
          <p className="mt-2 flex flex-wrap gap-1.5">
            {ungrouped.map((t) => (
              <span key={t.id} className="rounded-full border border-dashed border-line-strong px-2.5 py-1 text-[13px] font-semibold text-ink-2">
                <span className="num">{t.techNo}</span> {t.nickname || t.name}
              </span>
            ))}
          </p>
        </Card>
      )}
      <GroupDialog target={editing} view={view} onClose={() => setEditing(null)} />
    </div>
  );
}

function GroupDialog({ target, view, onClose }: { target: TechGroup | 'new' | null; view: TechnicianAdminView; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [leaderId, setLeaderId] = useState<number | null>(null);
  const [sortOrder, setSortOrder] = useState('0');
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = view.technicians.filter((t) => t.active);
  useResetOnOpen(
    !!target,
    () => {
      const activeIds = new Set(candidates.map((t) => t.id));
      setName(existing?.name ?? '');
      setMemberIds((existing?.memberIds ?? []).filter((id) => activeIds.has(id)));
      setLeaderId(existing?.leaderId != null && activeIds.has(existing.leaderId) ? existing.leaderId : null);
      setSortOrder(String(existing?.sortOrder ?? 0));
      setNote(existing?.note ?? '');
      setActive(existing?.active ?? true);
      setError(null);
    },
    [target],
  );
  const groupName = new Map(view.groups.map((g) => [g.id, g.name]));
  const problem = !name.trim() ? '请填写组名' : !/^\d{1,4}$/.test(sortOrder) ? '排序请填 0–9999 的整数' : null;
  const toggle = (id: number) => {
    const on = memberIds.includes(id);
    setMemberIds(on ? memberIds.filter((x) => x !== id) : [...memberIds, id]);
    if (on && leaderId === id) setLeaderId(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), leaderId, memberIds, sortOrder: Number(sortOrder), note: note.trim(), active };
    try {
      const next = existing ? await api.put<TechnicianAdminView>(`/api/technician-admin/groups/${existing.id}`, body) : await api.post<TechnicianAdminView>('/api/technician-admin/groups', body);
      qc.setQueryData(techViewKey, next);
      refresh();
      toast({ tone: 'success', title: existing ? `组别「${body.name}」已保存` : `已新建组别「${body.name}」` });
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
      title={existing ? `编辑组别 · ${existing.name}` : '新建组别'}
      description="组员整份保存：勾上的归到这个组（原来在别的组的挪过来），没勾的退出。"
      width="max-w-2xl"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="tech-group-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <Field label="组名" htmlFor="tg-name">
            <Input id="tg-name" value={name} maxLength={MAX_GROUP_NAME} onChange={(e) => setName(e.target.value)} placeholder="例如：足浴一组" data-autofocus data-testid="tech-group-name" />
          </Field>
          <Field label="排序" htmlFor="tg-sort" hint="小的在前">
            <Input id="tg-sort" value={sortOrder} inputMode="numeric" maxLength={4} onChange={(e) => setSortOrder(e.target.value)} className="num" />
          </Field>
        </div>
        {active && (
          <>
            <Field label={`组员（已选 ${memberIds.length} 人）`} hint="只列在职的技师">
              <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto" data-testid="tech-group-members">
                {candidates.length === 0 && <span className="text-[13px] text-ink-3">名册里还没有在职的技师</span>}
                {candidates.map((t) => {
                  const on = memberIds.includes(t.id);
                  const elsewhere = t.groupId !== null && t.groupId !== existing?.id ? groupName.get(t.groupId) : undefined;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(t.id)}
                      className={cn('h-9 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                      data-testid={`tech-group-member-${t.techNo}`}
                    >
                      <span className="num">{t.techNo}</span> {t.nickname || t.name}
                      {elsewhere && <span className="ml-1 font-normal text-ink-3">（现在在{elsewhere}）</span>}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="组长" htmlFor="tg-leader" hint="从组员里选；可以先不设">
              <Select id="tg-leader" className="h-11" value={leaderId ?? ''} onChange={(e) => setLeaderId(e.target.value ? Number(e.target.value) : null)} data-testid="tech-group-leader">
                <option value="">不设组长</option>
                {candidates
                  .filter((t) => memberIds.includes(t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {techLabel(t)}
                    </option>
                  ))}
              </Select>
            </Field>
          </>
        )}
        <Field label="备注" htmlFor="tg-note">
          <Input id="tg-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
        </Field>
        {existing && (
          <Field label="状态" hint={active ? undefined : '停用以后组员都退出这个组、不再有组长；名字仍占着，不能再建同名的。'}>
            <Segmented
              ariaLabel="组别状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '在用' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
