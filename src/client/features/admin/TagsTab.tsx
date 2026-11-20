import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Lock, Nfc, Plus, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { MAX_VIP_LEVEL, TAG_KIND_LABELS, TAG_ZONES, ZONE_LABELS, ZONES, type FrontdeskRules, type HandTag, type TagKind, type Zone } from '@shared/frontdesk';
import { CARD_UID_PATTERN, normalizeCardUid, type FrontdeskRiskRules } from '@shared/frontdesk-risk';
import { parseHandTagCsv, type HandTagCsvResult, type HandTagImportReport } from '@shared/hand-tag-import';
import { formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { readImportFile } from '../../lib/import-file';
import { useCan, useReasons } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { groupTags, tagKindText, VipChip, ZoneChip, ZONE_STYLE } from '../frontdesk/parts';
import { BlacklistPane } from '../frontdesk/blacklist';
import { ReaderStatusLine, useCardReader, type CardMessage } from '../frontdesk/TagCardInput';
import { SubPane } from '../../components/SubNav';
import { AdminPage } from './AdminShell';

type AdminTag = HandTag & { inUse: boolean; lockedByName: string | null; lockedAt: string | null; cardUid: string | null };

const LEVELS = Array.from({ length: MAX_VIP_LEVEL }, (_, i) => i + 1);

/**
 * 手牌池：按清单导入、按号段建牌、锁定 / 解锁、改分区与柜型、停用；前台规则（更正时限、丢牌赔偿、VIP 等级）。
 * 8.1.15（docs/FRONTDESK_RISK_V8115.md）：手牌绑 / 解绑芯片号（点一张牌）、发牌前风控的开关（前台规则页签）、黑名单页签
 */
export function TagsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const tags = useQuery({ queryKey: ['frontdesk', 'tags'], queryFn: () => api.get<AdminTag[]>('/api/frontdesk/tags') });
  const rules = useQuery({ queryKey: ['frontdesk', 'rules'], queryFn: () => api.get<FrontdeskRules>('/api/frontdesk/rules') });
  const [editing, setEditing] = useState<AdminTag | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };

  // 二级页签（8.0.17）：规则 → 清单 → 导入与工具。前台规则只有能改经营规则的岗位（店主）能改；
  // 值班经理在这里只维护手牌池，看不到「前台规则」这个页签
  const tabs = [
    ...(can('settings.manage') ? [{ key: 'rules', label: '前台规则' }] : []),
    { key: 'pool', label: '手牌池' },
    ...(can('frontdesk.blacklist') ? [{ key: 'blacklist', label: '黑名单' }] : []),
    { key: 'create', label: '建牌与导入' },
  ];
  return (
    <AdminPage section="tags" description="前台规则、手牌池（分区、VIP 柜、芯片号、锁定与停用）、黑名单、按号段建牌与柜号清单导入。" tabs={tabs}>
      {can('settings.manage') && (
        <SubPane tab="rules" className="space-y-5">
          <RulesCard
            rules={rules.data}
            onSaved={() => {
              refresh();
              toast({ tone: 'success', title: '前台规则已保存' });
            }}
          />
          <RiskSwitchCard />
        </SubPane>
      )}
      {can('frontdesk.blacklist') && (
        <SubPane tab="blacklist">
          <BlacklistPane />
        </SubPane>
      )}
      <SubPane tab="create" className="space-y-5">
        <ImportCard onImported={refresh} />
        <BatchCard onCreated={refresh} />
      </SubPane>

      <SubPane tab="pool">
        <Card className="p-5">
          <SectionTitle>手牌池</SectionTitle>
          <p className="mt-1 text-[12.5px] text-ink-3">
            点一张手牌可锁定 / 解锁、改分区与柜型、停用，或绑定 / 解绑芯片号（绑了的牌带 <Nfc className="inline size-3.5 align-[-2px]" />{' '}
            标，发牌时刷卡就能带出牌号）。在店手牌不能改分区、柜型、停用或锁定，请先在前台给客人换牌。
          </p>
          {tags.isPending ? (
            <Skeleton className="mt-3 h-40" />
          ) : tags.data?.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有手牌，先在上方导入柜号清单</p>
          ) : (
            TAG_ZONES.map((z) => {
              const list = tags.data?.filter((t) => t.zone === z) ?? [];
              if (list.length === 0) return null;
              return (
                <div key={z} className="mt-5" data-testid={`admin-zone-${z}`}>
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ink-3">
                    <ZoneChip zone={z} size="md" /> 共 {list.length} 张 · 在店 {list.filter((t) => t.inUse).length} · 锁定 {list.filter((t) => t.locked).length} · 停用{' '}
                    {list.filter((t) => !t.active).length} · 已绑芯片 {list.filter((t) => t.cardUid).length}
                    {z === 'child' && <span className="text-clay">儿童区已取消，请把这些牌改为男宾或女宾，或停用</span>}
                  </p>
                  {groupTags(list).map((g) => (
                    <div key={g.key} className="mb-3">
                      <p className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-ink-3">
                        {g.kind === 'vip' ? <VipChip level={g.vipLevel!} size="md" /> : <span className="font-bold text-ink-2">{g.area ? `${g.area} 区` : '普通柜'}</span>}
                        <span className="num">{g.tags.length} 张</span>
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {g.tags.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setEditing(t)}
                            title={`${t.locked ? `锁定：${t.lockReason}` : t.inUse ? '在店' : t.active ? '空闲' : '已停用'}${t.cardUid ? ` · 芯片号 ${t.cardUid}` : ' · 没绑芯片号'}`}
                            data-testid={`admin-tag-${t.code}`}
                            data-card={t.cardUid ?? ''}
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
                            {t.cardUid && <Nfc className="size-3 opacity-70" aria-label="已绑芯片号" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </Card>
      </SubPane>

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
    </AdminPage>
  );
}

// ───────────────────────── 按清单导入 ─────────────────────────

function ImportCard({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<HandTagCsvResult | null>(null);
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [preview, setPreview] = useState<HandTagImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean, rows = parsed?.rows ?? [], deactivate = deactivateMissing) => {
    setBusy(true);
    setError(null);
    try {
      const report = await api.post<HandTagImportReport>('/api/frontdesk/tags/import', { rows, deactivateMissing: deactivate, dryRun });
      if (dryRun) {
        setPreview(report);
      } else {
        toast({
          tone: 'success',
          title: `已导入 ${report.total} 个柜号`,
          body: `新建 ${report.created} · 更新 ${report.updated} · 未变 ${report.unchanged}${report.deactivated ? ` · 停用 ${report.deactivated}` : ''}${report.blocked.length ? ` · ${report.blocked.length} 张在店未改` : ''}`,
        });
        setParsed(null);
        setPreview(null);
        setFileName('');
        onImported();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    setPreview(null);
    setError(null);
    if (!file) return;
    let loaded: Awaited<ReturnType<typeof readImportFile>>;
    try {
      loaded = await readImportFile(file);
    } catch (e) {
      setFileName(file.name);
      setParsed(null);
      setError(errorMessage(e));
      return;
    }
    setFileName(loaded.label);
    const result = parseHandTagCsv(loaded.text);
    setParsed(result);
    if (result.errors.length === 0) await run(true, result.rows, deactivateMissing);
  };

  return (
    <Card className="p-5" data-testid="tag-import">
      <SectionTitle>
        <span className="flex items-center gap-2">按清单导入柜号</span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        CSV 列为 <code className="num">code,gender,kind,area,vip_level</code>（与 docs/data/hand-tags-2026-10-27.csv
        相同）。先预览再导入；已有牌号以清单为准更新分区、柜型与等级，锁定状态不变，在店的手牌不改。
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="tag-import-file" />
        <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()} loading={busy && !preview}>
          选择 CSV 文件
        </Button>
        {fileName && <span className="num text-[13px] text-ink-2">{fileName}</span>}
      </div>
      <div className="mt-3">
        <ConfirmCheck
          checked={deactivateMissing}
          onChange={(v) => {
            setDeactivateMissing(v);
            if (parsed && parsed.errors.length === 0) void run(true, parsed.rows, v);
          }}
        >
          同时停用不在清单里的手牌
          <span className="block text-[12.5px] font-normal text-ink-3">例如试用期间按号段建的旧牌；有在店客人的不会停用</span>
        </ConfirmCheck>
      </div>

      {parsed && parsed.errors.length > 0 && (
        <Notice tone="error" title={`清单有 ${parsed.errors.length} 处需要修改，未导入`} className="mt-3">
          <ul className="mt-1 space-y-0.5 text-[12.5px]">
            {parsed.errors.slice(0, 8).map((e) => (
              <li key={`${e.line}-${e.message}`}>
                第 {e.line} 行：{e.message}
              </li>
            ))}
            {parsed.errors.length > 8 && <li>……共 {parsed.errors.length} 处</li>}
          </ul>
        </Notice>
      )}

      {preview && (
        <div className="mt-3 space-y-3" data-testid="tag-import-preview">
          <p className="text-[13.5px] text-ink-2">
            清单共 <b className="num">{preview.total}</b> 个柜号：新建 <b className="num">{preview.created}</b> · 更新 <b className="num">{preview.updated}</b> · 未变{' '}
            <b className="num">{preview.unchanged}</b>
            {deactivateMissing && (
              <>
                {' '}
                · 停用清单外 <b className="num">{preview.deactivated}</b>
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {preview.groups.map((g) => (
              <span key={`${g.zone}-${g.kind}-${g.vipLevel}-${g.area}`} className="flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 text-[12.5px] font-semibold">
                <ZoneChip zone={g.zone} />
                {g.kind === 'vip' ? <VipChip level={g.vipLevel!} /> : <span>{g.area ? `${g.area} 区` : TAG_KIND_LABELS.normal}</span>}
                <span className="num text-ink-3">{g.count}</span>
              </span>
            ))}
          </div>
          {preview.blocked.length > 0 && (
            <Notice tone="warning" title={`${preview.blocked.length} 张在店手牌不会改动`}>
              {preview.blocked
                .slice(0, 6)
                .map((b) => `${b.code}（${b.reason}）`)
                .join('；')}
            </Notice>
          )}
          <Button variant="primary" loading={busy} onClick={() => void run(false)} data-testid="tag-import-confirm">
            确认导入 {preview.total} 个柜号
          </Button>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}

// ───────────────────────── 按号段建牌 ─────────────────────────

function BatchCard({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [zone, setZone] = useState<Zone>('male');
  const [kind, setKind] = useState<TagKind>('normal');
  const [vipLevel, setVipLevel] = useState(1);
  const [prefix, setPrefix] = useState('A');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('40');
  const [width, setWidth] = useState('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = Number(from);
  const t = Number(to);
  const w = Number(width);
  const valid = /^[A-Z]{0,2}$/.test(prefix) && Number.isInteger(f) && Number.isInteger(t) && t >= f && t - f < 500 && w >= 1 && w <= 5 && String(t).length <= w;
  const sample = useMemo(() => (valid ? `${prefix}${String(f).padStart(w, '0')} – ${prefix}${String(t).padStart(w, '0')}` : ''), [valid, prefix, f, t, w]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ created: number; skipped: string[] }>('/api/frontdesk/tags/batch', {
        prefix,
        from: f,
        to: t,
        width: w,
        zone,
        kind,
        vipLevel: kind === 'vip' ? vipLevel : null,
      });
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
      <SectionTitle>按号段建牌</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        真实柜号不连续，请优先按清单导入；这里用于补充连续号段的新柜。分区决定能发给哪类宾客（男宾牌不能发给女宾），VIP 柜按等级使用。已存在的牌号自动跳过。
      </p>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-3">
          <Segmented value={zone} onChange={setZone} ariaLabel="分区" options={ZONES.map((z) => ({ value: z, label: ZONE_LABELS[z].title }))} />
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              setPrefix(k === 'vip' ? '' : 'A');
            }}
            ariaLabel="柜型"
            options={[
              { value: 'normal', label: TAG_KIND_LABELS.normal },
              { value: 'vip', label: TAG_KIND_LABELS.vip },
            ]}
          />
          {kind === 'vip' && (
            <Select value={vipLevel} onChange={(e) => setVipLevel(Number(e.target.value))} fullWidth={false} aria-label="VIP 等级" className="w-32">
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  第 {l} 级
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="前缀（区号）" hint="0–2 个字母">
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
          <Button variant="secondary" icon={<Plus className="size-4" />} disabled={!valid} loading={busy} onClick={create}>
            建立手牌
          </Button>
          {valid ? (
            <span className="text-[13px] text-ink-2">
              将建立 <b className="num">{sample}</b>，共 <b className="num">{t - f + 1}</b> 张{ZONE_LABELS[zone].title}
              {kind === 'vip' ? ` VIP 第 ${vipLevel} 级柜` : '普通柜'}
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

// ───────────────────────── 前台规则 ─────────────────────────

const yuan = (cents: number) => String(cents / 100);

function RulesCard({ rules, onSaved }: { rules: FrontdeskRules | undefined; onSaved: () => void }) {
  const [minutes, setMinutes] = useState('');
  const [fee, setFee] = useState('');
  const [grace, setGrace] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!rules) return;
    setMinutes(String(rules.selfVoidMinutes));
    setFee(yuan(rules.lostTagFeeCents));
    setGrace(String(rules.overtimeGraceMinutes ?? 0));
  }, [rules]);

  const n = Number(minutes);
  const g = Number(grace);
  const feeCents = parseYuan(fee);
  const problem =
    !Number.isInteger(n) || n < 0 || n > 120 ? '更正时限应为 0–120 分钟' : !Number.isInteger(g) || g < 0 || g > 120 ? '跳档宽限应为 0–120 分钟' : feeCents === null ? '丢牌赔偿金额不正确' : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/frontdesk/rules', {
        selfVoidMinutes: n,
        lostTagFeeCents: feeCents,
        overtimeGraceMinutes: g,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="frontdesk-rules">
      <SectionTitle>前台规则</SectionTitle>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="店员自行更正时限（分钟）" hint="店员可在此时间内作废本人登记的明细、撤销本人开的牌；超时或他人登记的由值班经理、店总处理">
          <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" className="num" aria-label="店员自行更正时限" />
        </Field>
        <Field label="丢牌赔偿（元）" hint="换牌原因为手牌丢失时挂到客人账单；填 0 表示不收">
          <Input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" className="num" aria-label="丢牌赔偿" />
        </Field>
        <Field
          label={
            <span className="flex items-center gap-1.5">
              门票跳档宽限（分钟） <PendingBadge title="店主 ❓6：默认 0（超过 12 小时分界点即跳档），待确认" />
            </span>
          }
          hint="每个 12 小时分界点之后多少分钟内不跳档；0 表示超过即跳档"
        >
          <Input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" className="num" aria-label="门票跳档宽限" data-testid="rules-grace" />
        </Field>
      </div>

      {/* VIP 柜（8.0.4 起归「会员权益」，docs/MEMBERSHIP_V804.md 第 2 节）：原来这里的当场授权开关搬过去了，这里只留跳转 */}
      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper/60 p-4" data-testid="vip-moved">
        <ShieldCheck className="size-5 shrink-0 text-pine" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold text-ink">VIP 柜已移到「会员权益」</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">各档能用到几级 VIP 柜、当场授权散客或等级不够的会员使用 VIP 柜，都在「会员权益 → VIP 柜」设置；原来的设置已原样搬过去。</p>
        </div>
        <Link to="/admin/vip-lockers" className="inline-flex h-9 items-center rounded-full bg-pine px-4 text-[13px] font-semibold text-paper hover:bg-pine/90" data-testid="vip-moved-link">
          去设置
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!rules || !!problem} loading={busy} onClick={save} data-testid="frontdesk-rules-save">
          保存前台规则
        </Button>
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
        {!problem && rules && <span className="text-[12.5px] text-ink-3">当前丢牌赔偿 {formatYuan(rules.lostTagFeeCents)}</span>}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}

// ───────────────────────── 单张手牌 ─────────────────────────

function TagDialog({ tag, onClose, onDone }: { tag: AdminTag; onClose: () => void; onDone: (message: string) => void }) {
  const legacy = tag.zone === 'child';
  const lockReasons = useReasons('lockReasons');
  const [zone, setZone] = useState<Zone>(tag.zone === 'child' ? 'male' : tag.zone);
  const [kind, setKind] = useState<TagKind>(tag.kind);
  const [vipLevel, setVipLevel] = useState(tag.vipLevel ?? 1);
  const [active, setActive] = useState(tag.active);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = legacy || zone !== tag.zone || active !== tag.active || kind !== tag.kind || (kind === 'vip' && vipLevel !== tag.vipLevel);
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
          {tag.kind === 'vip' && <VipChip level={tag.vipLevel!} size="md" />}
          {tag.inUse && <Badge tone="pine">在店</Badge>}
          {tag.locked && <Badge tone="clay">已锁定</Badge>}
        </span>
      }
      description={tagKindText(tag)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            disabled={busy || !changed}
            onClick={() => run(() => api.put(`/api/frontdesk/tags/${tag.id}`, { zone, active, kind, vipLevel: kind === 'vip' ? vipLevel : null }), `${tag.code} 已更新`)}
          >
            保存分区、柜型与启用
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {legacy && (
          <Notice tone="warning" title="这是已取消的儿童区手牌">
            请改为男宾或女宾后保存，或选择停用。
          </Notice>
        )}
        <Field label="分区">
          <Segmented value={zone} onChange={setZone} options={ZONES.map((z) => ({ value: z, label: ZONE_LABELS[z].title }))} />
        </Field>
        <Field label="柜型">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: 'normal', label: TAG_KIND_LABELS.normal },
                { value: 'vip', label: TAG_KIND_LABELS.vip },
              ]}
            />
            {kind === 'vip' && (
              <Select value={vipLevel} onChange={(e) => setVipLevel(Number(e.target.value))} fullWidth={false} aria-label="VIP 等级" className="w-32">
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    第 {l} 级
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
        <Field label="启用">
          <Segmented
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        </Field>
        <TagCardField tag={tag} onDone={onDone} />
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
                {lockReasons.map((r) => (
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
                disabled={reason.trim().length < 2 || tag.inUse || legacy}
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

// ───────────────────────── 芯片号、发牌前风控（8.1.15） ─────────────────────────

/** 一张手牌的芯片号：点「绑定」后刷一下（本机读卡器 / 键盘式读卡器），或手输；绑着的可以解绑 */
function TagCardField({ tag, onDone }: { tag: AdminTag; onDone: (message: string) => void }) {
  const [binding, setBinding] = useState(false);
  const [uid, setUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<CardMessage | null>(null);
  const normalized = normalizeCardUid(uid);
  const ok = CARD_UID_PATTERN.test(normalized);
  const save = async (cardUid: string | null) => {
    setBusy(true);
    setNote(null);
    try {
      await api.put(`/api/frontdesk/tags/${tag.id}/card`, { cardUid });
      onDone(cardUid ? `${tag.code} 已绑定芯片号 ${cardUid}` : `${tag.code} 已解绑芯片号`);
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  // 绑定时刷一下：读到的卡号填进来，核对后点「确认绑定」
  useCardReader(binding, {
    onCard: (card) => {
      setUid(normalizeCardUid(card));
      setNote({ tone: 'ok', text: '已读到卡号，核对后点「确认绑定」' });
    },
    onReadError: (text) => setNote({ tone: 'error', text }),
  });
  return (
    <div className="rounded-lg border border-line bg-paper/60 p-4" data-testid="tag-card-field">
      <div className="flex flex-wrap items-center gap-2">
        <Nfc className="size-4 text-ink-3" />
        <p className="text-[13px] font-semibold text-ink-2">芯片号</p>
        {tag.cardUid ? (
          <span className="num rounded-md bg-card px-2 py-0.5 text-[16px] font-bold" data-testid="tag-card-uid">
            {tag.cardUid}
          </span>
        ) : (
          <span className="text-[13px] text-ink-3" data-testid="tag-card-none">
            还没绑；绑了以后发牌时刷这张牌就能带出牌号
          </span>
        )}
        <span className="flex-1" />
        {!binding && (
          <Button size="lg" variant="secondary" disabled={busy} onClick={() => setBinding(true)} data-testid="tag-card-bind">
            {tag.cardUid ? '换一张卡' : '绑定'}
          </Button>
        )}
        {!binding && tag.cardUid && (
          <Button size="lg" variant="ghost" loading={busy} onClick={() => void save(null)} data-testid="tag-card-unbind">
            解绑
          </Button>
        )}
      </div>
      {binding && (
        <div className="mt-3 space-y-2">
          <ReaderStatusLine message={note} />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              fullWidth={false}
              autoFocus
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ok && !busy) {
                  e.preventDefault();
                  void save(normalized);
                }
              }}
              placeholder="把手牌放到读卡器上，或手输芯片号"
              autoComplete="off"
              className="num h-11 min-w-0 flex-1 basis-56"
              aria-label="芯片号"
              invalid={!!uid && !ok}
              data-testid="tag-card-input"
            />
            <Button size="lg" variant="primary" disabled={!ok} loading={busy} onClick={() => void save(normalized)} data-testid="tag-card-save">
              确认绑定
            </Button>
            <Button size="lg" variant="ghost" disabled={busy} onClick={() => setBinding(false)}>
              取消
            </Button>
          </div>
          {uid && !ok && <p className="text-[12.5px] font-medium text-clay">芯片号应为 4–32 位数字或字母（刷卡带出来的原样填）</p>}
        </div>
      )}
      {!binding && note && <p className="mt-2 text-[12.5px] font-semibold text-clay">{note.text}</p>}
    </div>
  );
}

/** 发牌前风控的开关（功能开关，默认开）：黑名单、未结离店授权、重复到店提示、预约带出与核销 */
function RiskSwitchCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['frontdesk', 'risk-rules'], queryFn: () => api.get<FrontdeskRiskRules>('/api/frontdesk/risk-rules') });
  const [busy, setBusy] = useState(false);
  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      qc.setQueryData(['frontdesk', 'risk-rules'], await api.put<FrontdeskRiskRules>('/api/frontdesk/risk-rules', { enabled }));
      void qc.invalidateQueries({ queryKey: ['frontdesk'] });
      toast({ tone: 'success', title: enabled ? '发牌前风控已开启' : '发牌前风控已关闭', body: enabled ? undefined : '发牌与以前一样：不查黑名单、不拦未结离店、不带预约。' });
    } catch (e) {
      toast({ tone: 'error', title: '没有保存', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="risk-switch">
      <SectionTitle aside={<PendingBadge title="发牌前风控的做法是默认值，待确认（docs/PENDING_DECISIONS.md「块 A：前台」FK1 起）" />}>发牌前风控</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        开着时，接待发牌选了会员会核对四样：在黑名单里的不能发；名下有没处理完的「未结离店」的要值班经理及以上当场授权；今天来过的提示第几次到店；今天待到店的预约带出来，发牌成功后自动标「已到店」（派对房除外）。关掉以后发牌与以前一样。
      </p>
      {rules.isPending ? (
        <Skeleton className="mt-3 h-10 w-48" />
      ) : rules.isError && !rules.data ? (
        <Notice tone="error" className="mt-3" title={`开关没取回来：${errorMessage(rules.error)}`} />
      ) : (
        <Segmented
          className="mt-3"
          value={rules.data!.enabled ? 'on' : 'off'}
          onChange={(v) => {
            if (!busy && (v === 'on') !== rules.data!.enabled) void set(v === 'on');
          }}
          ariaLabel="发牌前风控"
          options={[
            { value: 'on', label: '开启' },
            { value: 'off', label: '关闭' },
          ]}
        />
      )}
    </Card>
  );
}
