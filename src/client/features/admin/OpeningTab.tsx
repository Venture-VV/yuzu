import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, FileUp, RotateCcw, Search } from 'lucide-react';
import { formatPhone } from '@shared/labels';
import { lastUsableDate } from '@shared/business-date';
import { parseYuan } from '@shared/money';
import type {
  OpeningBalanceRow,
  OpeningControlCheck,
  OpeningImportDetail,
  OpeningImportReport,
  OpeningImportSummary,
  OpeningTotals,
} from '@shared/opening-import';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { readImportFile } from '../../lib/import-file';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';

const listKey = ['opening-imports'] as const;

/** 旧系统（EBC）会员余额期初导入（店主 #6）：先预览核对，再整批导入；导入记录可逐位或整批作废 */
export function OpeningTab() {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <div className="space-y-5">
      <ImportCard />
      <HistoryCard onOpen={setOpenId} />
      {openId !== null && <ImportDetailDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

type Uncertain = { clientKey: string; body: Record<string, unknown> };

// EBC 控制总数（R1.5）：旧系统报表上的会员人数与本金、赠金、累计充值合计。导入 + 排除清单 = 控制总数才能导入
type ControlForm = Record<keyof OpeningTotals, string>;
const EMPTY_CONTROL: ControlForm = { count: '', principal: '', bonus: '', legacyRecharged: '' };
const CONTROL_FIELDS: [keyof OpeningTotals, string][] = [
  ['count', '会员人数'],
  ['principal', '本金合计（元）'],
  ['bonus', '赠金合计（元）'],
  ['legacyRecharged', '累计充值合计（元）'],
];

/** 四项都空 = 没填（不比对）；只填了一部分或格式不对时报错 */
function parseControlForm(f: ControlForm): { totals: OpeningTotals | null; error: string | null } {
  const values = Object.values(f).map((v) => v.trim());
  if (values.every((v) => v === '')) return { totals: null, error: null };
  if (values.some((v) => v === '')) return { totals: null, error: 'EBC 控制总数四项都要填（没有的填 0）' };
  const count = Number(f.count.trim());
  if (!Number.isInteger(count) || count < 0) return { totals: null, error: '会员人数应为不小于 0 的整数' };
  const [principal, bonus, legacyRecharged] = [f.principal, f.bonus, f.legacyRecharged].map((v) => parseYuan(v.trim().replace(/[¥￥,，\s]/g, '')));
  if ([principal, bonus, legacyRecharged].some((a) => a == null || a < 0)) return { totals: null, error: '控制总数的金额格式不正确（单位元，最多两位小数）' };
  return { totals: { count, principal: principal!, bonus: bonus!, legacyRecharged: legacyRecharged! }, error: null };
}

function ImportCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('EBC');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<{ name: string; label: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<OpeningImportReport | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<{ line: number; message: string }[]>([]);
  const [uncertain, setUncertain] = useState<Uncertain | null>(null);
  const [done, setDone] = useState<OpeningImportReport | null>(null);
  const session = useSession();
  const [control, setControl] = useState<ControlForm>(EMPTY_CONTROL);
  const [excluded, setExcluded] = useState<{ label: string; csv: string } | null>(null);
  const excludedRef = useRef<HTMLInputElement>(null);
  const controlParsed = parseControlForm(control);
  const production = session.env === 'production';
  // 上一次预览用的控制总数：输入框失焦时只有数字真的变了才重新预览（重新预览会清掉「我已核对」）
  const [previewedControl, setPreviewedControl] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setClientKey(null);
    setChecked(false);
    setLineErrors([]);
  };

  const runPreview = async (f: { name: string; csv: string }, src = source, ctl = controlParsed, ex = excluded) => {
    setDone(null);
    setLineErrors([]);
    if (ctl.error) {
      setPreview(null);
      setError(ctl.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const report = await api.post<OpeningImportReport>(
        '/api/opening-imports/preview',
        { source: src, fileName: f.name, csv: f.csv, control: ctl.totals, excludedCsv: ex?.csv ?? '' },
        { timeoutMs: 60_000 },
      );
      setPreview(report);
      setPreviewedControl(JSON.stringify(ctl.totals));
      setLineErrors(report.errors);
      // 每次预览生成新的操作编号：确认导入时带上，超时后用同一编号查回或重提，不会重复导入
      setClientKey(uuid());
      setChecked(false);
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = (report: OpeningImportReport) => {
    setUncertain(null);
    setDone(report);
    reset();
    toast({
      tone: 'success',
      title: report.replayed ? `批次 ${report.importNo} 已导入（查回结果）` : `已导入期初 ${report.total} 位会员`,
      body: `本金 ¥${(report.principalTotal / 100).toFixed(2)} · 赠金 ¥${(report.bonusTotal / 100).toFixed(2)}`,
    });
    void qc.invalidateQueries({ queryKey: listKey });
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['ledger'] });
    void qc.invalidateQueries({ queryKey: ['settlement'] });
  };

  const submit = async (pending: Uncertain) => {
    setBusy(true);
    setError(null);
    setLineErrors([]);
    try {
      finish(await api.post<OpeningImportReport>('/api/opening-imports', { ...pending.body, clientKey: pending.clientKey }, { timeoutMs: 120_000 }));
    } catch (e) {
      if (e instanceof UncertainError) {
        // 结果待确认：服务端可能已导入。用同一编号查回或原样重提都不会重复导入
        setUncertain(pending);
      } else {
        const details = (e as { details?: { errors?: { line: number; message: string }[] } }).details;
        setLineErrors(details?.errors ?? []);
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const lookup = async (pending: Uncertain) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<{ found: boolean; report: OpeningImportReport | null }>(`/api/opening-imports/by-key/${pending.clientKey}`);
      if (r.found && r.report) finish(r.report);
      else setError('暂时没有查到这次导入。查不到不代表没有导入，请稍后再查，或原样重提（同一编号不会重复导入）');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // 填了控制总数就必须一致；正式环境必须填
  const controlOk = preview?.control ? preview.control.ok : !production;
  const canImport = !!preview && preview.errors.length === 0 && preview.total > 0 && controlOk && checked && !!clientKey && !!file;

  return (
    <Card className="p-5" data-testid="opening-import">
      <SectionTitle>
        <span className="flex items-center gap-2">
          <ArchiveRestore className="size-4 text-pine" />
          导入旧系统会员余额（期初）
        </span>
      </SectionTitle>
      <div className="mt-1 space-y-1 text-[12.5px] leading-relaxed text-ink-3">
        <p>
          CSV 列为 <code className="num break-all">name,phone,legacy_no,principal,bonus,bonus_expires_on,total_recharged,gender,birthday,note</code>
          （也可用中文表头：姓名、手机号、旧卡号、本金、赠金、赠金到期日、累计充值、性别、生日、备注）。金额单位为元；赠金到期日是最后一天可用的日期，留空为长期有效。
        </p>
        <p>
          按手机号匹配已有会员（姓名须一致），没有的新建档案。本金、赠金分开记一条「期初导入」流水，<b className="text-ink-2">不计入充值实收</b>
          ；一位会员只能有一笔有效的期初。任一行有问题整批不导入。旧系统累计充值只用于 VIP 柜等级（口径待确认）。
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label="来源系统" htmlFor="opening-source">
          <Input
            id="opening-source"
            value={source}
            maxLength={32}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
              setClientKey(null);
            }}
            onBlur={() => file && source.trim() && void runPreview(file, source.trim())}
            data-testid="opening-source"
          />
        </Field>
        <Field label="备注（可选）" htmlFor="opening-note">
          <Input id="opening-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例如：EBC 2026-10-31 打烊后导出" />
        </Field>
      </div>

      <fieldset className="mt-3 rounded-lg border border-line p-3" data-testid="opening-control-form">
        <legend className="px-1 text-[12.5px] font-semibold text-ink-2">
          EBC 控制总数（旧系统报表上的数字；{production ? '正式环境必填' : '填了才比对'}）
        </legend>
        <div className="grid gap-3 sm:grid-cols-4">
          {CONTROL_FIELDS.map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`opening-control-${key}`}>
              <Input
                id={`opening-control-${key}`}
                inputMode={key === 'count' ? 'numeric' : 'decimal'}
                value={control[key]}
                onChange={(e) => {
                  const value = e.target.value;
                  setControl((c) => ({ ...c, [key]: value }));
                  setPreview(null);
                  setClientKey(null);
                }}
                onBlur={() => {
                  if (!file) return;
                  if (controlParsed.error) {
                    setPreview(null);
                    setError(controlParsed.error);
                  } else if (!preview || JSON.stringify(controlParsed.totals) !== previewedControl) void runPreview(file);
                }}
                data-testid={`opening-control-${key}`}
              />
            </Field>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          <input
            ref={excludedRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              let loaded: { label: string; csv: string };
              try {
                const decoded = await readImportFile(f);
                loaded = { label: decoded.label, csv: decoded.text };
              } catch (err) {
                setError(errorMessage(err));
                return;
              }
              setExcluded(loaded);
              if (file) await runPreview(file, source, controlParsed, loaded);
            }}
            data-testid="opening-excluded-file"
          />
          <Button size="sm" variant="ghost" icon={<FileUp className="size-3.5" />} onClick={() => excludedRef.current?.click()}>
            选择排除清单（可选）
          </Button>
          {excluded ? (
            <>
              <span className="text-ink-2">{excluded.label}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setExcluded(null);
                  if (file) void runPreview(file, source, controlParsed, null);
                }}
              >
                移除
              </Button>
            </>
          ) : (
            <span>这次不导入、之后到店补导的会员（没有合格手机号、一号多卡等），表头与导入文件相同，只用来对总数</span>
          )}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            let decoded: Awaited<ReturnType<typeof readImportFile>>;
            try {
              decoded = await readImportFile(f);
            } catch (err) {
              reset();
              setError(errorMessage(err));
              return;
            }
            const loaded = { name: f.name, label: decoded.label, csv: decoded.text };
            setFile(loaded);
            await runPreview(loaded);
          }}
          data-testid="opening-file"
        />
        <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()} loading={busy && !preview}>
          选择 CSV 文件
        </Button>
        {file && <span className="text-[13px] text-ink-2">{file.label}</span>}
      </div>

      {preview && (
        <div className="mt-4 space-y-3" data-testid="opening-preview">
          <div className="grid gap-3 rounded-lg border border-line bg-paper-2/40 p-4 sm:grid-cols-4">
            <Stat label="会员" value={<span className="num">{preview.total}</span>} hint={`新建 ${preview.createCount} · 匹配 ${preview.matchCount}`} />
            <Stat label="期初本金" value={<Money cents={preview.principalTotal} className="text-pine" />} />
            <Stat label="期初赠金" value={<Money cents={preview.bonusTotal} className="text-yuzu-deep" />} />
            <Stat label="旧系统累计充值" value={<Money cents={preview.legacyRechargedTotal} />} hint={preview.zeroCount ? `${preview.zeroCount} 位余额为 0，只建档` : undefined} />
          </div>
          {preview.control ? (
            <ControlCompare check={preview.control} />
          ) : (
            <Notice tone={production ? 'error' : 'info'} title={production ? '正式环境导入期初必须填写 EBC 控制总数' : '没有填写 EBC 控制总数，这次没有比对'}>
              填上旧系统报表上的会员人数与本金、赠金、累计充值合计后，系统核对「导入 + 排除清单 = 控制总数」，四项一致才能导入。
            </Notice>
          )}
          {preview.samples.length > 0 && (
            <div className="scroll-thin max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-paper-2 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-left">行</th>
                    <th className="px-3 py-2 text-left">会员</th>
                    <th className="px-3 py-2 text-left">处理</th>
                    <th className="px-3 py-2 text-right">本金</th>
                    <th className="px-3 py-2 text-right">赠金</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {preview.samples.map((r) => (
                    <tr key={r.line}>
                      <td className="num px-3 py-2 text-ink-3">{r.line}</td>
                      <td className="px-3 py-2">
                        <span className="font-semibold">{r.name}</span> <span className="num text-ink-3">{formatPhone(r.phone)}</span>
                      </td>
                      <td className="px-3 py-2">
                        {r.action === 'create' ? <Badge tone="lake">新建档案</Badge> : <Badge tone="neutral">匹配 {r.memberNo}</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money cents={r.principal} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money cents={r.bonus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.total > preview.samples.length && (
                <p className="border-t border-line px-3 py-2 text-[12px] text-ink-3">只显示前 {preview.samples.length} 位，导入后可在导入记录里查看全部</p>
              )}
            </div>
          )}
          {preview.errors.length === 0 && (
            <>
              <ConfirmCheck checked={checked} onChange={setChecked}>
                我已核对：期初本金 <Money cents={preview.principalTotal} />、期初赠金 <Money cents={preview.bonusTotal} /> 与旧系统一致
                <span className="block text-[12.5px] font-normal text-ink-3">导入后记入今天的营业日；导入错了可以在导入记录里作废（会员还没有后续余额变动时）</span>
              </ConfirmCheck>
              <Button
                variant="primary"
                disabled={!canImport}
                loading={busy}
                onClick={() =>
                  file &&
                  clientKey &&
                  void submit({
                    clientKey,
                    body: { source: source.trim(), fileName: file.name, note: note.trim(), csv: file.csv, control: controlParsed.totals, excludedCsv: excluded?.csv ?? '' },
                  })
                }
                data-testid="opening-confirm"
              >
                确认导入 {preview.total} 位会员的期初余额
              </Button>
            </>
          )}
        </div>
      )}

      {lineErrors.length > 0 && (
        <Notice tone="error" title={`有 ${lineErrors.length} 处需要修改，整批不导入`} className="mt-3">
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto text-[12.5px]" data-testid="opening-errors">
            {lineErrors.slice(0, 50).map((e) => (
              <li key={`${e.line}-${e.message}`}>
                {e.line > 0 ? `第 ${e.line} 行：` : ''}
                {e.message}
              </li>
            ))}
            {lineErrors.length > 50 && <li>…另有 {lineErrors.length - 50} 处</li>}
          </ul>
        </Notice>
      )}
      {uncertain && (
        <Notice
          tone="warning"
          title="导入结果待确认"
          className="mt-3"
          action={
            <>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void lookup(uncertain)}>
                查回结果
              </Button>
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} loading={busy} onClick={() => void submit(uncertain)}>
                原样重提
              </Button>
            </>
          }
        >
          服务器没有及时答复，这批可能已经导入。请先查回结果；原样重提使用同一个操作编号，已导入时直接返回第一次的结果，不会重复记账。
        </Notice>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {done && (
        <Notice tone="success" title={`批次 ${done.importNo}：已导入 ${done.total} 位会员`} className="mt-3">
          新建档案 {done.createCount} · 匹配已有会员 {done.matchCount} · 本金 <Money cents={done.principalTotal} /> · 赠金 <Money cents={done.bonusTotal} />
          。请到「日结」核对：期初 + 本日变动 = 期末。
        </Notice>
      )}
    </Card>
  );
}

/** 与 EBC 控制总数的逐项比对 */
function ControlCompare({ check }: { check: OpeningControlCheck }) {
  const show = (key: keyof OpeningTotals, v: number) => (key === 'count' ? <span className="num">{v}</span> : <Money cents={v} />);
  return (
    <div className={cn('rounded-lg border p-3', check.ok ? 'border-pine/30 bg-pine-soft/30' : 'border-clay/40 bg-clay-soft/40')} data-testid="opening-control">
      <p className={cn('text-[13.5px] font-bold', check.ok ? 'text-pine' : 'text-clay')}>
        {check.ok ? '导入 + 排除清单 = EBC 控制总数，四项一致' : '与 EBC 控制总数不一致，不能导入'}
      </p>
      <div className="scroll-thin overflow-x-auto">
        <table className="mt-2 w-full min-w-[420px] text-[13px]">
          <thead className="text-[12px] text-ink-3">
            <tr>
              <th className="py-1 text-left font-semibold">项目</th>
              <th className="py-1 text-right font-semibold">本次导入</th>
              <th className="py-1 text-right font-semibold">排除清单</th>
              <th className="py-1 text-right font-semibold">控制总数</th>
              <th className="py-1 text-right font-semibold">结果</th>
            </tr>
          </thead>
          <tbody>
            {CONTROL_FIELDS.map(([key, label]) => {
              const ok = check.imported[key] + check.excluded[key] === check.expected[key];
              return (
                <tr key={key}>
                  <td className="py-1">{label.replace(/合计|（元）/g, '')}</td>
                  <td className="py-1 text-right">{show(key, check.imported[key])}</td>
                  <td className="py-1 text-right">{show(key, check.excluded[key])}</td>
                  <td className="py-1 text-right">{show(key, check.expected[key])}</td>
                  <td className={cn('py-1 text-right font-bold', ok ? 'text-pine' : 'text-clay')}>{ok ? '一致' : '不一致'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!check.ok && (
        <ul className="mt-2 space-y-0.5 text-[12.5px] text-clay">
          {check.mismatches.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] font-semibold text-ink-3">{label}</p>
      <p className="mt-0.5 text-[20px] leading-tight font-bold">{value}</p>
      {hint && <p className="mt-0.5 text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}

function HistoryCard({ onOpen }: { onOpen: (id: number) => void }) {
  const list = useQuery({ queryKey: listKey, queryFn: () => api.get<OpeningImportSummary[]>('/api/opening-imports') });
  return (
    <Card className="p-5" data-testid="opening-history">
      <SectionTitle>导入记录</SectionTitle>
      {list.isPending ? (
        <Skeleton className="mt-3 h-20" />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState art="pool" title="还没有导入过期初" description="导入旧系统的会员余额后，这里保留每一批的来源、文件与经办人。" />
      ) : (
        <div className="mt-3 divide-y divide-line rounded-lg border border-line">
          {list.data!.map((imp) => (
            <button
              key={imp.id}
              type="button"
              onClick={() => onOpen(imp.id)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-paper-2/60"
              data-testid="opening-history-row"
            >
              <span className="num font-bold">{imp.importNo}</span>
              <Badge tone="pine">{imp.source}</Badge>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">
                {imp.fileName || '（未命名文件）'} · {formatDateTime(imp.createdAt)} · {imp.importedByName}
              </span>
              <span className="text-[13px]">
                <span className="num">{imp.rowCount}</span> 位 · 本金 <Money cents={imp.principalTotal} /> · 赠金 <Money cents={imp.bonusTotal} />
              </span>
              {imp.voidedCount > 0 && <Badge tone="clay">{imp.activeCount === 0 ? '已全部作废' : `已作废 ${imp.voidedCount} 位`}</Badge>}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

type VoidTarget = { kind: 'row'; row: OpeningBalanceRow } | { kind: 'all'; detail: OpeningImportDetail };

function ImportDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const session = useSession();
  const detail = useQuery({ queryKey: [...listKey, id], queryFn: () => api.get<OpeningImportDetail>(`/api/opening-imports/${id}`) });
  const [q, setQ] = useState('');
  const [voiding, setVoiding] = useState<VoidTarget | null>(null);
  const rows = useMemo(() => {
    const all = detail.data?.rows ?? [];
    const t = q.trim();
    if (!t) return all;
    return all.filter((r) => r.memberName.includes(t) || r.memberPhone.includes(t) || r.legacyNo.includes(t) || r.memberNo.includes(t));
  }, [detail.data, q]);
  const d = detail.data;
  const voidableAll = !!d && d.rows.some((r) => r.status === 'active') && d.rows.every((r) => r.status !== 'active' || !r.laterActivity);

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-4xl"
      title={d ? `期初批次 ${d.importNo}` : '期初批次'}
      description={d ? `${d.source} · ${d.fileName || '（未命名文件）'} · ${formatDateTime(d.createdAt)} · ${d.importedByName}${d.note ? ` · ${d.note}` : ''}` : undefined}
    >
      {!d ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-3" data-testid="opening-detail">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="姓名、手机号、旧卡号" className="pl-9" />
            </div>
            <span className="text-[13px] text-ink-3">
              有效 {d.activeCount} 位{d.voidedCount ? ` · 已作废 ${d.voidedCount} 位` : ''}
            </span>
            {d.activeCount > 0 && (
              <Button size="sm" variant="danger" disabled={!voidableAll} onClick={() => setVoiding({ kind: 'all', detail: d })} data-testid="opening-void-all">
                整批作废
              </Button>
            )}
          </div>
          {!voidableAll && d.activeCount > 0 && (
            <p className="text-[12.5px] text-ink-3">批内有会员在期初之后已有余额变动，不能整批作废；可以逐位作废还没有后续变动的会员。</p>
          )}
          <div className="scroll-thin max-h-[55vh] overflow-auto rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-paper-2 text-[12px] font-bold text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left">会员</th>
                  <th className="px-3 py-2 text-left">旧卡号</th>
                  <th className="px-3 py-2 text-right">本金</th>
                  <th className="px-3 py-2 text-right">赠金</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className={cn(r.status === 'voided' && 'text-ink-3')} data-testid="opening-row">
                    <td className="px-3 py-2">
                      <span className="font-semibold">{r.memberName}</span> <span className="num text-ink-3">{formatPhone(r.memberPhone)}</span>
                      <span className="block text-[12px] text-ink-3">
                        {r.memberNo} · {r.docNo}
                        {r.memberCreated ? ' · 导入时建档' : ''}
                      </span>
                    </td>
                    <td className="num px-3 py-2">{r.legacyNo || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Money cents={r.principal} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money cents={r.bonus} />
                      {r.bonusExpiresAt && (
                        <span className="block text-[12px] text-ink-3">
                          有效至 {lastUsableDate(r.bonusExpiresAt, session.timezone, session.rules.businessDayStartHour)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === 'voided' ? (
                        <span title={`${r.voidedByName ?? ''} ${r.voidedAt ? formatDateTime(r.voidedAt) : ''}`}>
                          <Badge tone="clay">已作废</Badge>
                          <span className="block text-[12px]">{r.voidReason}</span>
                        </span>
                      ) : r.laterActivity ? (
                        <Badge tone="neutral">已有后续变动</Badge>
                      ) : (
                        <Badge tone="pine">有效</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.status === 'active' && !r.laterActivity && (
                        <Button size="sm" variant="ghost" onClick={() => setVoiding({ kind: 'row', row: r })} data-testid="opening-void-row">
                          作废
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {voiding && <VoidDialog target={voiding} importId={id} onClose={() => setVoiding(null)} />}
    </Dialog>
  );
}

function VoidDialog({ target, importId, onClose }: { target: VoidTarget; importId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount =
    target.kind === 'row'
      ? { principal: target.row.principal, bonus: target.row.bonus, count: 1 }
      : target.detail.rows
          .filter((r) => r.status === 'active')
          .reduce((s, r) => ({ principal: s.principal + r.principal, bonus: s.bonus + r.bonus, count: s.count + 1 }), { principal: 0, bonus: 0, count: 0 });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'row') await api.post(`/api/opening-balances/${target.row.id}/void`, { reason });
      else await api.post(`/api/opening-imports/${importId}/void`, { reason });
      toast({ tone: 'success', title: target.kind === 'row' ? `已作废「${target.row.memberName}」的期初` : `已作废 ${amount.count} 位会员的期初` });
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['member'] });
      void qc.invalidateQueries({ queryKey: ['ledger'] });
      void qc.invalidateQueries({ queryKey: ['settlement'] });
      onClose();
    } catch (e) {
      // 作废请求重复提交时服务端拒绝（已作废），不会重复扣回；查回最新状态即可
      void qc.invalidateQueries({ queryKey: listKey });
      setError(e instanceof UncertainError ? '服务器没有及时答复，请关闭后刷新导入记录查看是否已作废' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={target.kind === 'row' ? `作废「${target.row.memberName}」的期初` : `整批作废（${amount.count} 位会员）`}
      description="作废记一条「期初作废」流水，把期初余额减回去；原记录保留，会员档案保留。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={() => void run()} data-testid="opening-void-confirm">
            确认作废
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13.5px] text-ink-2">
          将扣回本金 <Money cents={amount.principal} className="font-bold text-pine" />、赠金 <Money cents={amount.bonus} className="font-bold text-yuzu-deep" />
        </p>
        <Field label="作废原因" htmlFor="opening-void-reason">
          <Input id="opening-void-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如：旧系统导出的金额有误，更正后重新导入" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
