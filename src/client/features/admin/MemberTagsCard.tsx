// 后台「会员与渠道 → 会员标签」（8.0.4 需求表 05，docs/MEMBERSHIP_V804.md 第 5 节）：原来的「会员资料字段」改成标签。
// 按分组列出标签与人数；新建、改名、改分组、停用 / 启用（不能删：停用后不能再挂，已挂的保留）。
// 原来自定义字段里填过的值，升级时都转成了标签（分组是原来的字段名），标「由自定义字段转来」。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PencilLine, Plus } from 'lucide-react';
import { groupTags, MAX_TAG_GROUP, MAX_TAG_NAME, MEMBER_TAG_SOURCE_LABELS, type MemberTag } from '@shared/member-tags';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';
import { memberTagKeys, useMemberTags } from '../membership/TagPicker';

export function MemberTagsCard() {
  const tags = useMemberTags();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<MemberTag | 'new' | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  if (tags.isPending) return <Skeleton className="h-40" />;
  if (tags.error || !tags.data) return <Notice tone="error" title={tags.error?.message ?? '会员标签没有加载出来'} />;
  const refresh = () => qc.invalidateQueries({ queryKey: memberTagKeys.all });
  const toggle = async (t: MemberTag) => {
    setBusy(t.id);
    try {
      await api.put(`/api/member-tags/${t.id}`, { expectedVersion: t.version, active: !t.active });
      toast({ tone: 'success', title: t.active ? `已停用「${t.name}」` : `已启用「${t.name}」`, body: t.active ? '以后不能再挂；已经挂着的会员保留。' : undefined });
    } catch (e) {
      toast({ tone: 'error', title: '没有改成', body: errorMessage(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  return (
    <Card className="p-5" data-testid="member-tags-card">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="HY06：自定义字段转成标签（字段名做分组、填过的值做标签），另建客群「亲子客」「商务客」；只有店主维护（待确认）" />
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="member-tag-new">
              新建标签
            </Button>
          </span>
        }
      >
        会员标签
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        给会员打上亲子客、商务客等标签做客群分层；前台新建、编辑会员时勾选，数据看板「会员总览 → 按标签」可以筛选、导出名单。原来的「会员资料字段」已改成标签：填过的值都转过来了，分组就是原来的字段名。标签不能删，不用时停用（已挂的会员保留）。
      </p>
      {tags.data.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-ink-3">还没有会员标签</p>
      ) : (
        <div className="mt-4 space-y-3">
          {groupTags(tags.data).map((g) => (
            <div key={g.group || '-'}>
              <p className="text-[12.5px] font-bold text-ink-2">{g.group || '未分组'}</p>
              <ul className="mt-1 divide-y divide-line/70 rounded-lg border border-line">
                {g.tags.map((t) => (
                  <li key={t.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2', !t.active && 'opacity-60')} data-testid={`member-tag-${t.id}`}>
                    <span className="text-[14px] font-bold text-ink">{t.name}</span>
                    <span className="num text-[12.5px] text-ink-3">{t.memberCount} 位会员</span>
                    {t.source === 'field' && <Badge tone="lake">{MEMBER_TAG_SOURCE_LABELS.field}</Badge>}
                    {!t.active && <Badge tone="clay">已停用</Badge>}
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" icon={<PencilLine className="size-3.5" />} onClick={() => setEditing(t)}>
                      改名
                    </Button>
                    <Button size="sm" variant="ghost" loading={busy === t.id} onClick={() => void toggle(t)} data-testid={`member-tag-toggle-${t.id}`}>
                      {t.active ? '停用' : '启用'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <TagDialog tag={editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />
    </Card>
  );
}

function TagDialog({ tag, onClose, onSaved }: { tag: MemberTag | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFor, setOpenFor] = useState<MemberTag | 'new' | null>(null);
  if (tag !== openFor) {
    setOpenFor(tag);
    setName(tag && tag !== 'new' ? tag.name : '');
    setGroup(tag && tag !== 'new' ? tag.groupName : '客群');
    setError(null);
  }
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tag === 'new') await api.post('/api/member-tags', { name: name.trim(), groupName: group.trim() });
      else if (tag) await api.put(`/api/member-tags/${tag.id}`, { expectedVersion: tag.version, name: name.trim(), groupName: group.trim() });
      toast({ tone: 'success', title: tag === 'new' ? `已建标签「${name.trim()}」` : '标签已保存' });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={tag !== null}
      onClose={onClose}
      title={tag === 'new' ? '新建会员标签' : '修改会员标签'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()} data-testid="member-tag-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="名称" htmlFor="tag-name" hint={`最多 ${MAX_TAG_NAME} 个字，例如亲子客、商务客`}>
          <Input id="tag-name" value={name} maxLength={MAX_TAG_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="member-tag-name" />
        </Field>
        <Field label="分组" htmlFor="tag-group" hint={`选填，最多 ${MAX_TAG_GROUP} 个字，例如客群、偏好；同一分组里名称不能重复`}>
          <Input id="tag-group" value={group} maxLength={MAX_TAG_GROUP} onChange={(e) => setGroup(e.target.value)} data-testid="member-tag-group" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
