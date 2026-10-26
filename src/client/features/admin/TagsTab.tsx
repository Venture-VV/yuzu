import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { LOCK_REASONS, ZONE_LABELS, ZONES, type FrontdeskRules, type HandTag, type Zone } from '@shared/frontdesk';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { ZoneChip, ZONE_STYLE } from '../frontdesk/parts';

type AdminTag = HandTag & { inUse: boolean; lockedByName: string | null; lockedAt: string | null };

/** 手牌池：按分区批量建牌、锁定 / 解锁、改分区、停用；前台更正时限 */
export function TagsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const tags = useQuery({ queryKey: ['frontdesk', 'tags'], queryFn: () => api.get<AdminTag[]>('/api/frontdesk/tags') });
  const rules = useQuery({ queryKey: ['frontdesk', 'rules'], queryFn: () => api.get<FrontdeskRules>('/api/frontdesk/rules') });
  const [editing, setEditing] = useState<AdminTag | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <BatchCard onCreated={refresh} />
        <RulesCard rules={rules.data} onSaved={() => { refresh(); toast({ tone: 'success', title: '前台规则已保存' }); }} />
      </div>

      <Card className="p-5">
        <SectionTitle>手牌池</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">点一张手牌可锁定 / 解锁、改分区或停用。在店手牌不能改分区、停用或锁定，请先在前台给客人换牌。</p>
        {tags.isPending ? (
          <Skeleton className="mt-3 h-40" />
        ) : tags.data?.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有手牌，先在上方批量建牌</p>
        ) : (
          ZONES.map((z) => {
            const list = tags.data?.filter((t) => t.zone === z) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={z} className="mt-4">
                <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-3">
                  <ZoneChip zone={z} size="md" /> 共 {list.length} 张 · 在店 {list.filter((t) => t.inUse).length} · 锁定 {list.filter((t) => t.locked).length} · 停用{' '}
                  {list.filter((t) => !t.active).length}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setEditing(t)}
                      title={t.locked ? `锁定：${t.lockReason}` : t.inUse ? '在店' : t.active ? '空闲' : '已停用'}
                      className={cn(
                        'num flex h-8 items-center gap-1 rounded-md border px-2.5 text-[13px] font-bold',
                        !t.active
                          ? 'border-line bg-paper-2 text-ink-4 line-through'
                          : t.locked
                            ? 'border-clay/40 bg-clay-soft/60 text-clay'
                            : t.inUse
                              ? cn('border-transparent', ZONE_STYLE[t.zone].chip)
                              : 'border-line bg-card text-ink-2 hover:border-line-strong',
                      )}
                    >
                      {t.locked && <Lock className="size-3" />}
                      {t.code}
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </Card>

      {editing && (
        <TagDialog
          tag={editing}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            refresh();
            toast({ tone: 'success', title: msg });
          }}
        />
      )}
    </div>
  );
}

function BatchCard({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [zone, setZone] = useState<Zone>('male');
  const [prefix, setPrefix] = useState('A');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('40');
  const [width, setWidth] = useState('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPrefix(zone === 'male' ? 'A' : zone === 'female' ? 'B' : 'C');
  }, [zone]);
  const f = Number(from);
  const t = Number(to);
  const w = Number(width);
  const valid = /^[A-Z]{0,2}$/.test(prefix) && Number.isInteger(f) && Number.isInteger(t) && t >= f && t - f < 500 && w >= 1 && w <= 5 && String(t).length <= w;
  const sample = useMemo(() => (valid ? `${prefix}${String(f).padStart(w, '0')} – ${prefix}${String(t).padStart(w, '0')}` : ''), [valid, prefix, f, t, w]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ created: number; skipped: string[] }>('/api/frontdesk/tags/batch', { prefix, from: f, to: t, width: w, zone });
      toast({ tone: 'success', title: `已建 ${r.created} 张${ZONE_LABELS[zone].title}牌`, body: r.skipped.length ? `${r.skipped.length} 张已存在，已跳过` : undefined });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <SectionTitle>
        <span className="flex items-center gap-2">
          批量建牌 <PendingBadge title="实际号段与男女宾 / 儿童分区待店主按实物手牌确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">按实物手牌号段建立；分区决定能发给哪类宾客（男宾牌不能发给女宾）。已存在的牌号自动跳过。</p>
      <div className="mt-4 space-y-4">
        <Segmented value={zone} onChange={setZone} ariaLabel="分区" options={ZONES.map((z) => ({ value: z, label: ZONE_LABELS[z].title }))} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="前缀" hint="0–2 个字母">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={2} className="num" />
          </Field>
          <Field label="起始号">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" className="num" />
          </Field>
          <Field label="结束号">
            <Input value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" className="num" />
          </Field>
          <Field label="数字位数" hint="不足补 0">
            <Input value={width} onChange={(e) => setWidth(e.target.value)} inputMode="numeric" className="num" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={<Plus className="size-4" />} disabled={!valid} loading={busy} onClick={create}>
            建立手牌
          </Button>
          {valid ? (
            <span className="text-[13px] text-ink-2">
              将建立 <b className="num">{sample}</b>，共 <b className="num">{t - f + 1}</b> 张{ZONE_LABELS[zone].title}牌
            </span>
          ) : (
            <span className="text-[13px] text-clay">请检查号段：结束号不小于起始号、一次最多 500 张、位数足够</span>
          )}
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Card>
  );
}

function RulesCard({ rules, onSaved }: { rules: FrontdeskRules | undefined; onSaved: () => void }) {
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules) setMinutes(String(rules.selfVoidMinutes));
  }, [rules]);
  const n = Number(minutes);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/frontdesk/rules', { selfVoidMinutes: n });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5">
      <SectionTitle>
        <span className="flex items-center gap-2">
          前台更正规则 <PendingBadge />
        </span>
      </SectionTitle>
      <Field label="店员自行更正时限（分钟）" hint="店员可在此时间内作废本人刚登记的明细、撤销本人刚开的牌；超过后或他人登记的，由店主处理" className="mt-3">
        <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" className="num" />
      </Field>
      <Button className="mt-3" variant="secondary" disabled={!Number.isInteger(n) || n < 0 || n > 120 || n === rules?.selfVoidMinutes} loading={busy} onClick={save}>
        保存
      </Button>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}

function TagDialog({ tag, onClose, onDone }: { tag: AdminTag; onClose: () => void; onDone: (message: string) => void }) {
  const [zone, setZone] = useState<Zone>(tag.zone);
  const [active, setActive] = useState(tag.active);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          手牌 <span className="num">{tag.code}</span> <ZoneChip zone={tag.zone} size="md" />
          {tag.inUse && <Badge tone="pine">在店</Badge>}
          {tag.locked && <Badge tone="clay">已锁定</Badge>}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            disabled={busy || (zone === tag.zone && active === tag.active)}
            onClick={() => run(() => api.put(`/api/frontdesk/tags/${tag.id}`, { zone, active }), `${tag.code} 已更新`)}
          >
            保存分区与启用
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="分区">
          <Segmented value={zone} onChange={setZone} options={ZONES.map((z) => ({ value: z, label: ZONE_LABELS[z].title }))} />
        </Field>
        <Field label="启用">
          <Segmented value={active ? 'on' : 'off'} onChange={(v) => setActive(v === 'on')} options={[{ value: 'on', label: '启用' }, { value: 'off', label: '停用' }]} />
        </Field>
        <div className="rounded-lg border border-line bg-paper/60 p-4">
          {tag.locked ? (
            <>
              <p className="text-[13.5px]">
                锁定原因：<b>{tag.lockReason}</b>
                {tag.lockedByName && <span className="text-ink-3"> · {tag.lockedByName}</span>}
              </p>
              <Button className="mt-3" variant="secondary" loading={busy} onClick={() => run(() => api.post(`/api/frontdesk/tags/${tag.id}/unlock`), `${tag.code} 已解锁`)}>
                解锁（已找回 / 已修好）
              </Button>
            </>
          ) : (
            <>
              <p className="text-[13px] font-semibold text-ink-2">锁定后前台不能发出这张牌</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {LOCK_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={cn('h-8 rounded-full border px-3 text-[13px] font-semibold', reason === r ? 'border-clay bg-clay-soft text-clay' : 'border-line bg-card text-ink-2')}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <Button
                className="mt-3"
                variant="danger"
                disabled={reason.trim().length < 2 || tag.inUse}
                loading={busy}
                onClick={() => run(() => api.post(`/api/frontdesk/tags/${tag.id}/lock`, { reason }), `${tag.code} 已锁定`)}
              >
                锁定
              </Button>
              {tag.inUse && <p className="mt-2 text-[12.5px] text-clay">这张牌上有在店客人，请先在前台给客人换牌并勾选「锁定原手牌」。</p>}
            </>
          )}
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
