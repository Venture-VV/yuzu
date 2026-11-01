// 8–10 月旧账只读对照（v0.7.10，飞书需求 RQ-005 收尾，见 docs/LEGACY_LEDGER.md）。
// 四份原始 Excel 按原样导入只读表：页面常显「不进正式账」；核验按「账目问题清单」的结构与口径重算，点开看是原表哪几行。

import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Archive, ChevronDown, ChevronRight, CircleAlert, CircleCheck, ExternalLink } from 'lucide-react';
import {
  LEGACY_LEDGER_KIND_LABELS,
  LEGACY_RULES,
  LEGACY_SOURCE_LABELS,
  legacyLedgerKind,
  type LegacyAudit,
  type LegacyFinding,
  type LegacyLedgerKind,
  type LegacyRawCells,
  type LegacyRowRef,
  type LegacySource,
} from '@shared/legacy';
import { formatYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { errorMessage } from '../../lib/api';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Badge, Card, Notice, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useLegacyAudit, useLegacyImports, useLegacyRows } from './queries';

type Tab = 'audit' | 'ledger' | 'payments' | 'materials' | 'ordered' | 'brand' | 'imports';
const TABS: { value: Tab; label: string }[] = [
  { value: 'audit', label: '核验' },
  { value: 'ledger', label: '采购台账' },
  { value: 'payments', label: '付款台账' },
  { value: 'materials', label: '采购物资明细' },
  { value: 'ordered', label: '已下单物料' },
  { value: 'brand', label: '品牌寻款清单' },
  { value: 'imports', label: '导入记录' },
];

/** 核验里引用的行 → 哪个页签 */
function tabOf(ref: LegacyRowRef, paymentSheet: string | undefined): Tab {
  if (ref.source === 'purchase_ledger') return ref.sheet === paymentSheet ? 'payments' : 'ledger';
  if (ref.source === 'material_detail') return 'materials';
  if (ref.source === 'ordered_materials') return 'ordered';
  return 'brand';
}
const rowKey = (sheet: string, rowNo: number) => `${sheet}:${rowNo}`;
const yuan = (cents: number | null) => (cents === null ? '—' : formatYuan(cents));
/** 只放行 http(s) 链接（旧表里的链接是外部来的文字） */
const safeUrl = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url.trim() : null);

function RawCells({ raw }: { raw: LegacyRawCells }) {
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md bg-paper-2/70 px-3 py-2 text-[12px]">
      {Object.entries(raw).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 一行原表：标题行 + 说明 + 可展开的原始单元格；被核验点名的行高亮 */
function RowItem({ id, title, lines, flags, raw, highlight }: { id: string; title: ReactNode; lines: ReactNode; flags?: ReactNode; raw: LegacyRawCells; highlight: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li id={id} className={cn('px-4 py-2.5', highlight && 'bg-yuzu-soft/60')} data-testid={`legacy-row-${id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {title}
        {flags}
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto text-[12px] font-semibold text-lake hover:underline">
          {open ? '收起原表' : '看原表'}
        </button>
      </div>
      <div className="mt-0.5 text-[12.5px] text-ink-2">{lines}</div>
      {open && <RawCells raw={raw} />}
    </li>
  );
}

function useHighlight(tab: Tab) {
  const [params] = useSearchParams();
  const row = params.get('row');
  useEffect(() => {
    if (!row) return;
    const t = setTimeout(() => document.getElementById(`r-${row}`)?.scrollIntoView({ block: 'center' }), 50);
    return () => clearTimeout(t);
  }, [row, tab]);
  return row;
}

// ───────────────────────── 核验 ─────────────────────────

function RefList({ refs, count, onOpen }: { refs: LegacyRowRef[]; count: number | null; onOpen: (r: LegacyRowRef) => void }) {
  return (
    <ul className="space-y-1 border-t border-line/70 bg-paper-2/40 px-4 py-2 pl-[52px]">
      {refs.map((r, i) => (
        <li key={i} className="text-[13px]">
          <button type="button" onClick={() => onOpen(r)} className="text-left font-semibold text-lake hover:underline">
            {r.text}
          </button>
        </li>
      ))}
      {count !== null && count > refs.length && <li className="text-[12px] text-ink-3">只列前 {refs.length} 行，共 {count} 行</li>}
    </ul>
  );
}

function FindingRow({ f, onOpen, testId }: { f: LegacyFinding | { key: string; title: string; detail: string; count: number | null; rows: LegacyRowRef[] }; onOpen: (r: LegacyRowRef) => void; testId: string }) {
  const [open, setOpen] = useState(false);
  const canOpen = f.rows.length > 0;
  return (
    <li data-testid={testId}>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-left enabled:hover:bg-paper-2"
        aria-expanded={canOpen ? open : undefined}
      >
        <span className="min-w-0">
          <span className="block text-[14px] font-bold">{f.title}</span>
          <span className="mt-0.5 block text-[13px] text-ink-2">{f.detail}</span>
        </span>
        {canOpen && <span className="pt-0.5 text-ink-3">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>}
      </button>
      {open && <RefList refs={f.rows} count={f.count} onOpen={onOpen} />}
    </li>
  );
}

function AuditTab({ audit, paymentSheet, onOpen }: { audit: LegacyAudit; paymentSheet: string | undefined; onOpen: (r: LegacyRowRef) => void }) {
  const days = audit.daily?.days ?? [];
  return (
    <div className="space-y-4" data-testid="legacy-audit">
      <Card className="p-4">
        <h2 className="text-[15px] font-bold">一、总览</h2>
        <ul className="mt-2 divide-y divide-line/70">
          {audit.overview.map((o) => (
            <li key={o.label} className="py-2">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-bold">{o.label}</span>
                <span className="num text-[13px] text-ink-2">
                  {o.rows} 行 · {o.period} · {o.amountText}
                </span>
              </p>
              <p className="text-[12.5px] text-clay">{o.problems}</p>
            </li>
          ))}
        </ul>
      </Card>

      {audit.crossChecks.length > 0 && (
        <Card className="overflow-hidden">
          <h2 className="px-4 pt-4 text-[15px] font-bold">二、三套账之间的差额</h2>
          <ul className="mt-1 divide-y divide-line/70">
            {audit.crossChecks.map((c) => (
              <FindingRow key={c.key} f={c} onOpen={onOpen} testId={`legacy-cross-${c.key}`} />
            ))}
          </ul>
        </Card>
      )}

      {audit.daily && (
        <Card className="p-4" data-testid="legacy-daily">
          <h2 className="text-[15px] font-bold">三、每日平账</h2>
          <p className="mt-1 text-[13px] text-ink-2">
            打款 − 当日台账支出 − 应退回：{days.length} 个付款日里 <b className="text-clay">{audit.daily.unbalanced} 天不平</b>（另有 {audit.daily.tail} 天差额不到{' '}
            {formatYuan(LEGACY_RULES.tailToleranceCents)}，算尾差）；{audit.daily.zeroAdvanceWithSpend.length} 天打款为 0 但当天仍有支出。
          </p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {days.map((d) => (
              <li
                key={d.date}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-[12.5px]',
                  d.state === 'unbalanced' ? 'border-clay/40 bg-clay-soft/40' : d.state === 'tail' ? 'border-yuzu/40 bg-yuzu-soft/40' : 'border-line',
                )}
                data-testid={`legacy-day-${d.date}`}
              >
                <p className="flex justify-between gap-2 font-semibold">
                  <span className="num">{d.date}</span>
                  <span className={cn('num', d.state === 'unbalanced' ? 'text-clay' : d.state === 'tail' ? 'text-yuzu-deep' : 'text-pine')}>
                    {d.state === 'balanced' ? '平' : `${d.diffCents > 0 ? '+' : ''}${formatYuan(d.diffCents)}`}
                  </span>
                </p>
                <p className="num text-ink-3">
                  打款 {formatYuan(d.advanceCents)} · 支出 {formatYuan(d.spendCents)} · 应退回 {formatYuan(d.shouldReturnCents)} · 退回 {formatYuan(d.returnedCents)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {audit.fieldIssues.length > 0 && (
        <Card className="overflow-hidden">
          <h2 className="px-4 pt-4 text-[15px] font-bold">四、字段与口径问题</h2>
          <ul className="mt-1 divide-y divide-line/70">
            {audit.fieldIssues.map((f) => (
              <FindingRow key={f.key} f={f} onOpen={onOpen} testId={`legacy-field-${f.key}`} />
            ))}
          </ul>
        </Card>
      )}

      <Card className="overflow-hidden">
        <h2 className="px-4 pt-4 text-[15px] font-bold">五、12 条规则在旧账上</h2>
        <p className="px-4 text-[12.5px] text-ink-3">新账从 11 月起按这 12 条在登记时拦截或每日预警（「账目自检」页）；这里是旧账按同样的规则查出来的情况。</p>
        <ul className="mt-1 divide-y divide-line/70">
          {audit.rules.map((r) => (
            <li key={r.no} data-testid={`legacy-rule-${r.no}`}>
              <FindingRow
                f={{ key: String(r.no), title: `${r.no}. ${r.title}`, detail: r.result, count: r.count, rows: r.rows }}
                onOpen={onOpen}
                testId={`legacy-rule-row-${r.no}`}
              />
              <span className="sr-only">{r.count === null ? '无法核对' : r.count === 0 ? '没有问题' : `${r.count} 条`}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4 text-[12.5px] text-ink-2">
        <h2 className="text-[14px] font-bold text-ink">核验口径（与账目问题清单一致，待确认）</h2>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>采购台账从序号 1 那一行算起；表头下面、序号 1 之前的金额单列，不计入合计。</li>
          <li>台账「金额」的负数：绝对值大于 {formatYuan(LEGACY_RULES.payoutThresholdCents)} 推定为打款，小于的推定为退款（冲减当天支出），正好相等的单列「无法判断」。</li>
          <li>当日台账支出：当天的正数支出减去退款；没写日期的行不算进任何一天。差额不到 {formatYuan(LEGACY_RULES.tailToleranceCents)} 算尾差。</li>
          <li>合并的金额格算在第一行；同一合并格里的其他行算「没有金额」。采购物资明细表有序号或日期的行都算一行；品牌清单表格里的空行也算行。</li>
          <li>只标「推定」，不改原值；不把按人记的备用金转成按部门（D14）。付款台账「{paymentSheet ?? '付款台账'}」以原表为准。</li>
        </ul>
      </Card>
    </div>
  );
}

// ───────────────────────── 原表逐行 ─────────────────────────

const KIND_TONE: Record<LegacyLedgerKind, 'pine' | 'clay' | 'lake' | 'yuzu' | 'neutral'> = {
  expense: 'pine',
  refund: 'yuzu',
  payout: 'lake',
  unclear: 'clay',
  no_amount: 'clay',
  pre_header: 'neutral',
};

function LedgerTab({ highlight }: { highlight: string | null }) {
  const rows = useLegacyRows('purchase_ledger');
  const [kind, setKind] = useState<'all' | LegacyLedgerKind | 'problem'>('all');
  if (rows.isPending) return <Skeleton className="h-64" />;
  if (rows.error) return <Notice tone="error" title={errorMessage(rows.error)} />;
  const imp = rows.data!.import;
  if (!imp) return <EmptyState art="calm" title="采购台账还没有导入" />;
  const sheet = imp.sheets[0]?.name ?? '';
  const lines = (rows.data!.ledger ?? []).map((l) => ({ l, k: legacyLedgerKind(l) }));
  const problem = (l: (typeof lines)[number]['l']) => l.amountCents === null || l.date === null || !l.item;
  const shown = lines.filter(({ l, k }) => (kind === 'all' ? true : kind === 'problem' ? !l.preHeader && problem(l) : k === kind));
  const filters: { value: typeof kind; label: string }[] = [
    { value: 'all', label: `全部 ${lines.length}` },
    { value: 'expense', label: '支出' },
    { value: 'refund', label: '退款（推定）' },
    { value: 'payout', label: '打款（推定）' },
    { value: 'unclear', label: '无法判断' },
    { value: 'problem', label: '缺日期 / 金额 / 类别' },
  ];
  return (
    <Card className="overflow-hidden" data-testid="legacy-ledger">
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setKind(f.value)}
            className={cn('rounded-full border px-3 py-1 text-[12.5px] font-semibold', kind === f.value ? 'border-pine bg-pine text-paper' : 'border-line text-ink-2 hover:bg-paper-2')}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-line/70">
        {shown.map(({ l, k }) => (
          <RowItem
            key={l.rowNo}
            id={`r-${rowKey(sheet, l.rowNo)}`}
            highlight={highlight === rowKey(sheet, l.rowNo)}
            raw={l.raw}
            title={
              <>
                <span className="num text-[12px] text-ink-3">第 {l.rowNo} 行</span>
                <span className="font-semibold">{l.item || '（没有类别）'}</span>
                <span className="num font-bold">{yuan(l.amountCents)}</span>
              </>
            }
            flags={
              <>
                <Badge tone={KIND_TONE[k]}>{LEGACY_LEDGER_KIND_LABELS[k]}</Badge>
                {!l.preHeader && l.date === null && <Badge tone="clay">无日期</Badge>}
                {l.mergedInto !== null && <Badge tone="neutral">金额与第 {l.mergedInto} 行合并</Badge>}
              </>
            }
            lines={[l.date ?? l.dateText, l.qtyText && `数量 ${l.qtyText}`, l.merchant, l.purpose, l.invoice, l.note].filter(Boolean).join(' · ') || '—'}
          />
        ))}
      </ul>
    </Card>
  );
}

function PaymentsTab({ highlight }: { highlight: string | null }) {
  const rows = useLegacyRows('purchase_ledger');
  if (rows.isPending) return <Skeleton className="h-64" />;
  if (rows.error) return <Notice tone="error" title={errorMessage(rows.error)} />;
  const imp = rows.data!.import;
  if (!imp) return <EmptyState art="calm" title="采购台账还没有导入" />;
  const sheet = imp.sheets[1]?.name ?? '';
  const totals = imp.fileTotals;
  return (
    <Card className="overflow-hidden" data-testid="legacy-payments">
      {Object.keys(totals).length > 0 && (
        <p className="border-b border-line px-4 py-2 text-[12.5px] text-ink-2">
          表里自带的合计：{Object.entries(totals).map(([k, v]) => `${k} ${formatYuan(v)}`).join('、')}
        </p>
      )}
      <ul className="divide-y divide-line/70">
        {(rows.data!.payments ?? []).map((p) => (
          <RowItem
            key={p.rowNo}
            id={`r-${rowKey(sheet, p.rowNo)}`}
            highlight={highlight === rowKey(sheet, p.rowNo)}
            raw={p.raw}
            title={
              <>
                <span className="num font-bold">{p.date ?? p.dateText ?? `第 ${p.rowNo} 行`}</span>
                <span className="num text-[13px]">打款 {yuan(p.advanceCents)}</span>
              </>
            }
            lines={`应退回 ${yuan(p.shouldReturnCents)} · 退回出纳 ${yuan(p.returnedCents)}${p.note ? ` · ${p.note}` : ''}`}
          />
        ))}
      </ul>
    </Card>
  );
}

function MaterialsTab({ highlight }: { highlight: string | null }) {
  const rows = useLegacyRows('material_detail');
  if (rows.isPending) return <Skeleton className="h-64" />;
  if (rows.error) return <Notice tone="error" title={errorMessage(rows.error)} />;
  const imp = rows.data!.import;
  if (!imp) return <EmptyState art="calm" title="采购物资明细表还没有导入" />;
  const lines = rows.data!.materials ?? [];
  return (
    <div className="space-y-3" data-testid="legacy-materials">
      {imp.sheets.map((s) => {
        const inSheet = lines.filter((m) => m.sheet === s.name);
        return (
          <Card key={s.name} className="overflow-hidden">
            <h3 className="border-b border-line px-4 py-2 text-[14px] font-bold">
              {s.name} <span className="font-normal text-ink-3">{inSheet.length} 行</span>
            </h3>
            {inSheet.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-clay">这张表是空的</p>
            ) : (
              <ul className="divide-y divide-line/70">
                {inSheet.map((m) => (
                  <RowItem
                    key={m.rowNo}
                    id={`r-${rowKey(m.sheet, m.rowNo)}`}
                    highlight={highlight === rowKey(m.sheet, m.rowNo)}
                    raw={m.raw}
                    title={
                      <>
                        <span className="num text-[12px] text-ink-3">第 {m.rowNo} 行</span>
                        <span className="font-semibold">{m.item || '（没有物品名）'}</span>
                        <span className="num font-bold">{yuan(m.amountCents)}</span>
                      </>
                    }
                    flags={
                      <>
                        {m.category && <Badge tone="neutral">{m.category}</Badge>}
                        {m.mergedInto !== null && <Badge tone="neutral">金额与第 {m.mergedInto} 行合并</Badge>}
                      </>
                    }
                    lines={
                      [
                        m.date ?? m.dateText,
                        m.department && `部门 ${m.department.replace(/\n/g, '')}`,
                        (m.boughtText || m.receivedText) && `购买 ${m.boughtText || '—'} / 到货 ${m.receivedText || '—'}`,
                        (m.invoice || m.taxText) && `${m.invoice || '发票没填'} ${m.taxRateBp !== null ? `${m.taxRateBp / 100}%` : m.taxText || '税点没填'}`,
                        m.purpose,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'
                    }
                  />
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function OrderedTab({ highlight }: { highlight: string | null }) {
  const rows = useLegacyRows('ordered_materials');
  if (rows.isPending) return <Skeleton className="h-64" />;
  if (rows.error) return <Notice tone="error" title={errorMessage(rows.error)} />;
  if (!rows.data!.import) return <EmptyState art="calm" title="已下单物料还没有导入" />;
  return (
    <Card className="overflow-hidden" data-testid="legacy-ordered">
      <p className="border-b border-line px-4 py-2 text-[12.5px] text-ink-2">图片是原表里的 WPS 单元格图（导出 Excel 会丢），导入时已把原图存下来；点图片看大图。</p>
      <ul className="divide-y divide-line/70">
        {(rows.data!.ordered ?? []).map((o) => (
          <li
            key={`${o.sheet}:${o.rowNo}`}
            id={`r-${rowKey(o.sheet, o.rowNo)}`}
            className={cn('flex gap-3 px-4 py-2.5', highlight === rowKey(o.sheet, o.rowNo) && 'bg-yuzu-soft/60')}
          >
            {o.imageId !== null ? (
              <a href={`/api/erp/legacy/images/${o.imageId}`} target="_blank" rel="noreferrer" className="shrink-0">
                <img src={`/api/erp/legacy/images/${o.imageId}`} alt={o.product} loading="lazy" className="size-14 rounded-md border border-line object-cover" />
              </a>
            ) : (
              <span className="flex size-14 shrink-0 items-center justify-center rounded-md border border-dashed border-clay/50 text-[11px] text-clay">没有图</span>
            )}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="num text-[12px] text-ink-3">
                  {o.sheet} 第 {o.rowNo} 行
                </span>
                <span className="font-semibold">{o.product}</span>
                <span className="num font-bold">{yuan(o.amountCents)}</span>
                {o.imageShared && <Badge tone="neutral">与上一行同一张图</Badge>}
              </p>
              <p className="text-[12.5px] text-ink-2">
                {[o.date ?? o.dateText, o.variant, o.department, o.orderer, o.qtyMilli !== null ? `数量 ${formatQty(o.qtyMilli)}` : o.qtyText, o.note].filter(Boolean).join(' · ')}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BrandTab({ highlight }: { highlight: string | null }) {
  const rows = useLegacyRows('brand_requests');
  if (rows.isPending) return <Skeleton className="h-64" />;
  if (rows.error) return <Notice tone="error" title={errorMessage(rows.error)} />;
  const imp = rows.data!.import;
  if (!imp) return <EmptyState art="calm" title="品牌寻款清单还没有导入" />;
  const sheet = imp.sheets[0]?.name ?? '';
  return (
    <Card className="overflow-hidden" data-testid="legacy-brand">
      <ul className="divide-y divide-line/70">
        {(rows.data!.brand ?? []).map((b) => {
          const url = safeUrl(b.linkUrl) ?? safeUrl(b.linkText);
          return (
            <RowItem
              key={b.rowNo}
              id={`r-${rowKey(sheet, b.rowNo)}`}
              highlight={highlight === rowKey(sheet, b.rowNo)}
              raw={b.raw}
              title={
                <>
                  <span className="num text-[12px] text-ink-3">第 {b.rowNo} 行</span>
                  <span className="font-semibold">{b.product || '（没有产品名）'}</span>
                </>
              }
              flags={
                <>
                  {b.ordered && <Badge tone="lake">已下单</Badge>}
                  {b.received && <Badge tone="pine">已到货</Badge>}
                  {b.returned && <Badge tone="clay">已退货</Badge>}
                </>
              }
              lines={
                <>
                  {[b.purpose, b.qtyText && `数量 ${b.qtyText}`, b.details, b.note].filter(Boolean).join(' · ') || '—'}
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold text-lake hover:underline">
                      <ExternalLink className="size-3.5" />
                      {b.linkText && b.linkText !== url ? b.linkText : '链接'}
                    </a>
                  ) : (
                    b.linkText && <span className="ml-2">{b.linkText}</span>
                  )}
                </>
              }
            />
          );
        })}
      </ul>
    </Card>
  );
}

function ImportsTab() {
  const imports = useLegacyImports();
  if (imports.isPending) return <Skeleton className="h-40" />;
  if (imports.error) return <Notice tone="error" title={errorMessage(imports.error)} />;
  if (imports.data!.length === 0) return <EmptyState art="calm" title="还没有导入旧账" />;
  return (
    <Card className="overflow-hidden" data-testid="legacy-imports">
      <ul className="divide-y divide-line/70">
        {imports.data!.map((i) => (
          <li key={i.id} className="px-4 py-2.5 text-[13px]">
            <p className="flex flex-wrap items-center gap-2">
              <span className="num text-ink-3">第 {i.id} 次</span>
              <span className="font-semibold">{LEGACY_SOURCE_LABELS[i.source]}</span>
              <Badge tone={i.status === 'active' ? 'pine' : 'neutral'}>{i.status === 'active' ? '有效' : '已作废'}</Badge>
            </p>
            <p className="text-ink-2">
              {i.fileName} · 摘要 <span className="num">{i.sha256.slice(0, 12)}</span> · {i.sheets.map((s) => `「${s.name}」${s.rows} 行`).join('、')}
            </p>
            <p className="text-[12px] text-ink-3">
              {i.importedByName} 导入于 {formatDateTime(i.importedAt)}
              {i.voidedAt && ` · ${i.voidedByName} 作废于 ${formatDateTime(i.voidedAt)}：${i.voidReason}`}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function LegacyPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'audit') as Tab;
  const audit = useLegacyAudit();
  const imports = useLegacyImports();
  const highlight = useHighlight(tab);
  const paymentSheet = imports.data?.find((i) => i.source === 'purchase_ledger' && i.status === 'active')?.sheets[1]?.name;
  const setTab = (t: Tab) => setParams(t === 'audit' ? {} : { tab: t }, { replace: true });
  const open = (r: LegacyRowRef) => setParams({ tab: tabOf(r, paymentSheet), row: rowKey(r.sheet, r.rowNo) });
  const imported = audit.data?.imported ?? [];

  return (
    <ErpPage
      title="旧账对照（8–10 月）"
      description="店主的四份原始 Excel 按原样导入的只读对照：采购台账、采购物资明细表、已下单物料、品牌新增寻款采购清单。核验按「账目问题清单」重算。"
    >
      <div className="space-y-4" data-testid="legacy-page">
        <Notice tone="warning" icon={<Archive className="size-5" />} title="8–10 月旧账 · 只读对照 · 不进正式账，不参与 11 月起的统计">
          11 月起的新账在「费用报销」「备用金与每日平账」「采购台账」里；旧账只在这里看，不能改。
        </Notice>
        <div role="tablist" aria-label="旧账对照" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={cn('rounded-md px-3 py-1.5 text-[13px] font-semibold', tab === t.value ? 'bg-ink text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink')}
              data-testid={`legacy-tab-${t.value}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'audit' &&
          (audit.isPending ? (
            <Skeleton className="h-96" />
          ) : audit.error ? (
            <Notice tone="error" title={errorMessage(audit.error)} />
          ) : imported.length === 0 ? (
            <EmptyState
              art="calm"
              title="还没有导入旧账"
              description="由店主同意后在服务器上用命令导入四份原始 Excel（默认只预览）：node dist/server/cli.js import-legacy <文件.xlsx> --operator <店主账号>，见 docs/LEGACY_LEDGER.md。"
            />
          ) : (
            <>
              {imported.length < 4 && (
                <Notice tone="info" title={`还有 ${4 - imported.length} 份没有导入`}>
                  {(['purchase_ledger', 'material_detail', 'ordered_materials', 'brand_requests'] as LegacySource[])
                    .filter((s) => !imported.includes(s))
                    .map((s) => LEGACY_SOURCE_LABELS[s])
                    .join('、')}
                  ；相关的核验写「还没有导入」。
                </Notice>
              )}
              <AuditTab audit={audit.data!} paymentSheet={paymentSheet} onOpen={open} />
            </>
          ))}
        {tab === 'ledger' && <LedgerTab highlight={highlight} />}
        {tab === 'payments' && <PaymentsTab highlight={highlight} />}
        {tab === 'materials' && <MaterialsTab highlight={highlight} />}
        {tab === 'ordered' && <OrderedTab highlight={highlight} />}
        {tab === 'brand' && <BrandTab highlight={highlight} />}
        {tab === 'imports' && <ImportsTab />}
        {audit.data && audit.data.rules.length > 0 && tab === 'audit' && (
          <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
            {audit.data.rules.every((r) => !r.count) ? <CircleCheck className="size-4 text-pine" /> : <CircleAlert className="size-4 text-clay" />}
            旧账的问题只在这里列出，不影响系统自检（check）与新账的账目自检。
          </p>
        )}
      </div>
    </ErpPage>
  );
}
