// 后台「岗位权限 → 分部门岗位职权配置」（8.2.0 P05，回测 5-2，docs/YUZU_REQ_V820.md 第 6 节）：
//   · 左边按部门列出岗位：岗位名、级别、建议权限几项、配置状态、在职人数；按部门或岗位搜索；
//   · 右边改选中岗位的建议权限（按模块分组勾选），保存后这个岗位的员工下一次操作就按新的算（「设立岗位」里的增减照旧叠在上面）；
//   · 有没保存的修改时换岗位，先问「是否放弃当前修改」；
//   · 导出 Excel（职权表、岗位汇总、变更记录）；下面列出变更记录（谁、什么时候、加了与去了哪几项）。
//   · 只有总裁（「修改经营规则」）能改，能看审计的只能看。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, History, RotateCcw, Search } from 'lucide-react';
import type { EditablePosition, PositionCatalogPosition, PositionCatalogView } from '@shared/admin';
import { PERMISSION_LABELS, type Permission } from '@shared/permissions';
import { ADMIN_LEVEL_LABELS } from '@shared/positions';
import { api, ApiError, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { cn, downloadUrl, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, Skeleton } from '../../components/ui';
import { PermissionPicker } from './PermissionPicker';

const sameSet = (a: readonly Permission[], b: readonly Permission[]) => a.length === b.length && a.every((p) => b.includes(p));

export function PositionCatalog({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'position-catalog'], queryFn: () => api.get<PositionCatalogView>('/api/admin/position-catalog') });
  const [search, setSearch] = useState('');
  const [key, setKey] = useState<EditablePosition | null>(null);
  // 草稿连同岗位、开始改时看到的版本一起记（Codex 审查 e770cb9）：保存带开始改时的版本，别人先改过就拒绝；
  // 冲突以后不给旧草稿换上新版本号，要「放弃我的修改」按最新的重新改，免得把别人刚去掉的又加回去
  const [draft, setDraft] = useState<{ key: EditablePosition; perms: Permission[]; version: string } | null>(null);
  const [asking, setAsking] = useState<EditablePosition | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = useMemo(() => q.data?.departments.flatMap((d) => d.positions) ?? [], [q.data]);
  const current: PositionCatalogPosition | null = all.find((p) => p.key === key) ?? all[0] ?? null;
  const mine = current && draft?.key === current.key ? draft : null;
  const value = mine?.perms ?? current?.suggested ?? [];
  const dirty = !!current && !!mine && !sameSet(mine.perms, current.suggested);
  /** 开始改以后别人保存过：这份草稿不能再保存 */
  const stale = !!current && !!mine && mine.version !== current.version;
  const shown = useMemo(() => {
    const t = search.trim();
    if (!q.data) return [];
    return q.data.departments.map((d) => ({ ...d, positions: d.name.includes(t) ? d.positions : d.positions.filter((p) => p.title.includes(t)) })).filter((d) => d.positions.length);
  }, [q.data, search]);

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error || !q.data || !current)
    return (
      <LoadFailed title="分部门岗位职权配置取不到" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="catalog-load-failed">
        {q.error ? errorMessage(q.error) : null}
      </LoadFailed>
    );

  const pick = (k: EditablePosition) => {
    if (k === current.key || saving) return;
    if (dirty) return setAsking(k);
    setKey(k);
    setDraft(null);
    setError(null);
  };
  const save = async () => {
    if (!mine || stale) return;
    setSaving(true);
    setError(null);
    try {
      // 保存期间勾选、换岗位都锁着，回来时草稿还是发出去的那一份
      const next = await api.put<PositionCatalogView>(`/api/admin/position-catalog/${current.key}`, { permissions: mine.perms, version: mine.version });
      qc.setQueryData(['admin', 'position-catalog'], next);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'permissions'] });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: `「${current.title}」的建议权限已保存`, body: '这个岗位的员工下一次操作就按新的算（「设立岗位」里的增减照旧叠在上面）。' });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'POSITION_STALE') void q.refetch();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="position-catalog">
      <Notice tone="info" title={editable ? '按部门找到岗位，改它的建议权限；保存立即生效' : '只有总裁（超级管理员）可以改建议权限'}>
        建议权限是每个岗位的起点，初始按 8.1.18 的岗位职权表；「设立岗位」里按岗位的增减、员工的个人微调都在它上面算。同一个岗位名在不同部门各是一行，互不影响。
        {(q.data.legacy.waiting > 0 || q.data.legacy.special > 0) &&
          ` 还在用旧岗位的：${q.data.legacy.waiting} 个老账号等本人登录时选岗位，${q.data.legacy.special} 个专用账号（点餐平板、他店查询、设计师）照旧按旧岗位表。`}
      </Notice>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card className="min-w-0 p-3" data-testid="catalog-list">
          <span className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜部门或岗位" className="pl-9" aria-label="搜部门或岗位" data-testid="catalog-search" />
          </span>
          <div className="mt-3 max-h-[640px] space-y-3 overflow-y-auto pr-1">
            {shown.length === 0 && <p className="py-6 text-center text-[13px] text-ink-3">没有对上的部门或岗位</p>}
            {shown.map((d) => (
              <div key={d.key} data-testid={`catalog-dept-${d.key}`}>
                <p className="px-1 pb-1 text-[12px] font-bold text-ink-3">{d.name}</p>
                <ul className="space-y-1">
                  {d.positions.map((p) => (
                    <li key={p.key}>
                      <button
                        type="button"
                        onClick={() => pick(p.key)}
                        aria-pressed={p.key === current.key}
                        className={cn('w-full rounded-md border px-2.5 py-2 text-left', p.key === current.key ? 'border-pine bg-pine-tint' : 'border-line hover:border-line-strong')}
                        data-testid={`catalog-pos-${p.key}`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{p.title}</span>
                          <span className="text-[12px] text-ink-3">{ADMIN_LEVEL_LABELS[p.level]}</span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                          <span>
                            建议 <b className="num text-ink-2">{p.suggested.length}</b> 项
                          </span>
                          {p.suggested.length === 0 ? <Badge tone="clay">未配置</Badge> : <Badge tone="pine">已配置</Badge>}
                          {p.adjusted && <Badge tone="ember">设立岗位里改过</Badge>}
                          {p.staff > 0 && <span>· {p.staff} 人</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
        <div className="min-w-0 space-y-3" data-testid="catalog-editor">
          <Card className="flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-bold" data-testid="catalog-title">
                {current.departmentName} · {current.title}
              </p>
              <p className="text-[12.5px] text-ink-3">
                {ADMIN_LEVEL_LABELS[current.level]} · 建议 {current.suggested.length} 项 · {current.staff} 人在职
                {current.updatedBy ? ` · ${current.updatedBy} ${formatDateTime(current.version)} 改过` : ' · 初始数据'}
              </p>
            </div>
            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                {dirty && <span className="text-[12.5px] text-ink-3">未保存</span>}
                <Button variant="ghost" icon={<RotateCcw className="size-4" />} disabled={!dirty || saving} onClick={() => setDraft(null)} data-testid="catalog-discard">
                  撤销修改
                </Button>
                <Button variant="primary" loading={saving} disabled={!dirty || stale} onClick={() => void save()} data-testid="catalog-save">
                  保存建议权限
                </Button>
              </div>
            )}
          </Card>
          {stale ? (
            <Notice
              tone="warning"
              title="别人刚刚改过这个岗位的建议权限"
              data-testid="catalog-stale"
              action={
                <Button size="sm" variant="secondary" onClick={() => setDraft(null)} data-testid="catalog-stale-reload">
                  放弃我的修改，按最新的重新改
                </Button>
              }
            >
              你的修改是在旧的那一份上做的，直接保存会把别人的改动盖掉，所以不能保存。下面标黄的是你的草稿与最新的不同之处，记下来以后按最新的重新改。
            </Notice>
          ) : (
            error && <Notice tone="error" title={error} />
          )}
          <PermissionPicker
            value={value}
            onChange={(perms) => setDraft({ key: current.key, perms, version: mine?.version ?? current.version })}
            baseline={current.suggested}
            baselineLabel="保存的"
            editable={editable && !saving}
            testId="catalog-perms"
          />
        </div>
      </div>
      <Card className="p-0" data-testid="catalog-log">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <History className="size-4 text-ink-3" />
          <h3 className="text-[15px] font-bold">变更记录</h3>
          <span className="text-[12.5px] text-ink-3">最近 100 条，只追加</span>
          <Button
            className="ml-auto"
            size="sm"
            variant="secondary"
            icon={<Download className="size-4" />}
            onClick={() => downloadUrl('/api/admin/position-catalog/export')}
            data-testid="catalog-export"
          >
            导出 Excel
          </Button>
        </div>
        <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">
          {q.data.log.map((l) => (
            <li key={l.id} className="px-4 py-2 text-[13px]" data-testid="catalog-log-row">
              <span className="num text-ink-3">{formatDateTime(l.at)}</span>
              <span className="ml-2 font-semibold">{l.staffName ?? '系统'}</span>
              {l.positionTitle && <span className="ml-2">「{l.positionTitle}」</span>}
              {l.added.length > 0 && <span className="ml-2 text-pine">加了：{l.added.map((p) => PERMISSION_LABELS[p]).join('、')}</span>}
              {l.removed.length > 0 && <span className="ml-2 text-clay">去了：{l.removed.map((p) => PERMISSION_LABELS[p]).join('、')}</span>}
              {l.note && <span className="ml-2 text-ink-3">{l.note}</span>}
            </li>
          ))}
        </ul>
      </Card>
      <Dialog
        open={!!asking}
        onClose={() => setAsking(null)}
        title="是否放弃当前修改？"
        description={`「${current.title}」改了还没保存，换到别的岗位会丢掉这些修改。`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              继续改
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setKey(asking);
                setDraft(null);
                setAsking(null);
              }}
              data-testid="catalog-discard-confirm"
            >
              放弃修改
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">要留着的话先点「继续改」，再点「保存建议权限」。</p>
      </Dialog>
    </div>
  );
}
