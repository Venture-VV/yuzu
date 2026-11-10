// 合同详情（v0.7.31，docs/CONTRACTS.md 第 3–8 节）：基本信息与状态、四要素与单价表、审批进度（能审的人在这里审，
// 法务那一级按审查清单逐条给结论）、签署登记、用印申请（走审批）、扫描件、归档、变更单、终止、续签、挂这份合同的采购单，
// 以及每一次提交（合同本身、变更单）的内容与法务审查结论。

import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import {
  Archive,
  ArrowLeft,
  FilePen,
  FileStack,
  ImagePlus,
  PenLine,
  RefreshCw,
  Send,
  Stamp,
  Trash2,
  Undo2,
  XCircle,
} from 'lucide-react';
import { APPROVAL_STATUS_LABELS } from '@shared/approvals';
import {
  CHANGE_KIND_LABELS,
  CHANGE_STATUS_LABELS,
  CONTRACT_CATEGORY_LABELS,
  CONTRACT_EDITABLE,
  CONTRACT_EFFECTIVE,
  SEAL_STATUS_LABELS,
  SEAL_TYPES,
  SEAL_TYPE_LABELS,
  formatPercentBp,
  type ChangeView,
  type ContractDetail,
  type SealType,
  type SealView,
} from '@shared/contracts';
import { formatAmount } from '@shared/money';
import { PO_STATUS_LABELS, type PoStatus } from '@shared/purchasing';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { imagePayload } from '../../components/Images';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { ApprovalProgress } from '../approvals/ApprovalProgress';
import { ReviewActions } from '../approvals/DocReviewActions';
import { useErpAccess } from '../erp/access';
import { ErpPage } from '../erp/ErpHome';
import { ContractPaymentCard } from '../payments/ContractPaymentCard';
import { ContractStatusBadge, daysLeftText, Fact, Facts, LinesView, ReviewsView, TermsView } from './parts';
import { useContract, useContractMeta, useInvalidateContracts } from './queries';

export function ContractDetailPage() {
  const can = useCan();
  const { id } = useParams();
  const contractId = Number(id) || null;
  const q = useContract(contractId);
  if (!can('contract.read')) return <Navigate to="/erp" replace />;
  return (
    <ErpPage
      title={q.data ? `${q.data.contractNo} · ${q.data.title}` : '合同'}
      description={q.data ? `${CONTRACT_CATEGORY_LABELS[q.data.category]}合同 · ${q.data.counterparty}` : undefined}
      actions={
        <Link to="/erp/contracts" className="flex items-center gap-1 text-[13px] font-semibold text-ink-3 hover:text-ink">
          <ArrowLeft className="size-4" />
          回到台账
        </Link>
      }
    >
      {q.isPending ? <Skeleton className="h-96" /> : q.error ? <Notice tone="error" title={errorMessage(q.error)} /> : <Detail c={q.data!} />}
    </ErpPage>
  );
}

type DialogState =
  | { kind: 'void' }
  | { kind: 'sign' }
  | { kind: 'archive' }
  | { kind: 'terminate' }
  | { kind: 'seal'; seal: SealView | null }
  | { kind: 'change-void'; change: ChangeView }
  | null;

function Detail({ c }: { c: ContractDetail }) {
  const remindDays = useSession().rules.contractRemindDays;
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const access = useErpAccess();
  const invalidate = useInvalidateContracts();
  const manage = can('contract.manage');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const effective = CONTRACT_EFFECTIVE.includes(c.status);
  const editable = CONTRACT_EDITABLE.includes(c.status);
  const openChange = c.changes.find((x) => ['draft', 'reviewing', 'returned'].includes(x.status)) ?? null;
  const approvedSeal = c.seals.some((s) => s.status === 'approved');

  /** 提交、撤回、签署、归档、终止、作废……都带版本号：重复发不会多做一次（做过的会提示刷新） */
  const run = async (key: string, url: string, body: unknown, success: string) => {
    setBusy(key);
    try {
      await api.post(url, body);
      toast({ tone: 'success', title: success, body: c.contractNo });
      setDialog(null);
    } catch (e) {
      toast({
        tone: 'error',
        title: e instanceof UncertainError ? `没收到结果：${errorMessage(e)}` : errorMessage(e),
        body: e instanceof UncertainError ? '刷新后看状态；再做一次不会重复（带了版本号）' : c.contractNo,
      });
    } finally {
      setBusy(null);
      await invalidate();
    }
  };

  return (
    <div className="space-y-4" data-testid="contract-detail">
      {manage && (
        <ErpPendingPanel
          types={['contract_change', 'contract_seal']}
          filter={(op) => op.url.startsWith(`/api/erp/contracts/${c.id}/`)}
          onFound={() => void invalidate()}
        />
      )}
      {effective && c.daysLeft !== null && c.daysLeft <= remindDays && !c.renewal && (
        <Notice tone={c.daysLeft < 0 ? 'error' : 'warning'} title={`${c.endDate} ${daysLeftText(c.daysLeft)}，还没有续签`} data-testid="contract-expiry-notice">
          {manage ? '要接着合作就续签（照这份合同预填一份新合同，走审查）；不再合作的可以不管，过了结束日台账里标「已过期」。' : '请经办人续签或确认不再合作。'}
        </Notice>
      )}
      {c.status === 'returned' && <Notice tone="warning" title="审批退回了：看下面的审批意见与法务审查清单，改好后再提交审查" />}

      {/* 概要 */}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ContractStatusBadge status={c.status} />
          {c.currentVersion > 0 && <Badge tone="neutral">第 {c.currentVersion} 版</Badge>}
          {openChange && <Badge tone="yuzu">变更单 {openChange.changeNo} {CHANGE_STATUS_LABELS[openChange.status]}</Badge>}
          <Money cents={c.totalCents} className="ml-auto text-[20px] font-bold" />
        </div>
        <Facts>
          <Fact label="合同号">
            <span className="num">{c.contractNo}</span>
          </Fact>
          <Fact label="类型">{CONTRACT_CATEGORY_LABELS[c.category]}</Fact>
          <Fact label="相对方">{c.counterparty}</Fact>
          <Fact label="供应商档案">{c.supplierName ?? '—'}</Fact>
          <Fact label="期限">{c.startDate ? `${c.startDate} 至 ${c.endDate ?? '不定期'}` : '还没填'}</Fact>
          <Fact label="部门">{c.departmentName ?? '不分部门'}</Fact>
          <Fact label="经办">{c.handlerName}</Fact>
          <Fact label="税率">{formatPercentBp(c.content.taxRateBp)}</Fact>
          {c.renewalOf && (
            <Fact label="续签自">
              <Link to={`/erp/contracts/${c.renewalOf.id}`} className="num text-lake hover:underline">
                {c.renewalOf.contractNo}
              </Link>
            </Fact>
          )}
          {c.renewal && (
            <Fact label="已续签为">
              <Link to={`/erp/contracts/${c.renewal.id}`} className="num text-lake hover:underline">
                {c.renewal.contractNo}
              </Link>
            </Fact>
          )}
          {c.signedOn && (
            <Fact label="签署" wide>
              {c.signedOn} · 我方 {c.ourSignatory} · 对方 {c.theirSignatory}
            </Fact>
          )}
          {c.archiveNo && (
            <Fact label="归档" wide>
              <span className="num">{c.archiveNo}</span> · {c.archiveLocation}
            </Fact>
          )}
          {c.closedReason && (
            <Fact label={c.status === 'voided' ? '作废' : '终止'} wide>
              {c.closedOn} · {c.closedReason} · {c.closedByName}
            </Fact>
          )}
          <Fact label="起草">
            {c.createdByName} · {formatDateTime(c.createdAt)}
          </Fact>
        </Facts>

        {/* 操作 */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3" data-testid="contract-actions">
          {manage && editable && (
            <>
              <Button size="sm" variant="secondary" icon={<FilePen className="size-4" />} onClick={() => navigate(`/erp/contracts/${c.id}/edit`)} data-testid="contract-edit">
                修改
              </Button>
              <Button size="sm" variant="primary" icon={<Send className="size-4" />} loading={busy === 'submit'} onClick={() => void run('submit', `/api/erp/contracts/${c.id}/submit`, { version: c.version }, '已提交审查')} data-testid="contract-submit">
                提交审查
              </Button>
            </>
          )}
          {manage && c.status === 'reviewing' && (
            <Button size="sm" variant="secondary" icon={<Undo2 className="size-4" />} loading={busy === 'withdraw'} onClick={() => void run('withdraw', `/api/erp/contracts/${c.id}/withdraw`, { version: c.version }, '已撤回，回到起草中')} data-testid="contract-withdraw">
              撤回
            </Button>
          )}
          {manage && c.status === 'approved' && (
            <Button size="sm" variant="primary" icon={<PenLine className="size-4" />} onClick={() => setDialog({ kind: 'sign' })} data-testid="contract-sign">
              登记签署
            </Button>
          )}
          {manage && (c.status === 'approved' || c.status === 'signed') && (
            <Button size="sm" variant="secondary" icon={<Stamp className="size-4" />} onClick={() => setDialog({ kind: 'seal', seal: null })} data-testid="contract-seal">
              用印申请
            </Button>
          )}
          {manage && c.status === 'signed' && (
            <Button size="sm" variant="secondary" icon={<Archive className="size-4" />} onClick={() => setDialog({ kind: 'archive' })} data-testid="contract-archive">
              归档
            </Button>
          )}
          {manage && effective && !openChange && (
            <Button size="sm" variant="secondary" icon={<FileStack className="size-4" />} onClick={() => navigate(`/erp/contracts/${c.id}/change`)} data-testid="contract-change">
              开变更单
            </Button>
          )}
          {manage && effective && !c.renewal && (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => navigate(`/erp/contracts/new?renew=${c.id}`)} data-testid="contract-renew">
              续签
            </Button>
          )}
          {manage && effective && (
            <Button size="sm" variant="ghost" icon={<XCircle className="size-4" />} onClick={() => setDialog({ kind: 'terminate' })} data-testid="contract-terminate">
              终止
            </Button>
          )}
          {manage && (editable || c.status === 'approved') && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDialog({ kind: 'void' })} data-testid="contract-void">
              作废
            </Button>
          )}
          <span className="ml-auto">
            <ReviewActions approval={c.approval} kind="contract" docNo={c.contractNo} urlBase={`/api/erp/contracts/${c.id}`} onDone={invalidate} />
          </span>
        </div>
      </Card>

      {c.approval && c.status === 'reviewing' && (
        <Card className="p-5">
          <ApprovalProgress approval={c.approval} />
          {c.revisions[0]?.reviews.length ? <ReviewsView reviews={c.revisions[0].reviews} /> : null}
        </Card>
      )}

      {/* 内容 */}
      <Card className="space-y-4 p-5">
        <h2 className="text-[14px] font-bold">
          {editable ? '草稿内容（还没提交审查）' : c.status === 'reviewing' ? '提交审查的内容' : `合同内容（第 ${c.currentVersion} 版）`}
        </h2>
        <TermsView content={c.content} />
        <div>
          <h4 className="mb-1.5 text-[12.5px] font-bold text-ink-2">单价表</h4>
          <LinesView lines={c.content.lines.map((l, i) => ({ ...l, lineNo: i + 1, materialName: null }))} />
        </div>
        {c.content.note && <p className="text-[13px] text-ink-2">备注：{c.content.note}</p>}
      </Card>

      {/* 付款计划、验收与质量问题（v0.7.32）：审批通过以后才有生效的一版 */}
      {c.currentVersion > 0 && c.status !== 'voided' && <ContractPaymentCard c={c} />}

      {/* 变更单 */}
      {(c.changes.length > 0 || (manage && effective)) && (
        <Card className="p-5">
          <h2 className="mb-2 text-[14px] font-bold">变更单</h2>
          {c.changes.length === 0 ? (
            <p className="text-[13px] text-ink-3">改价、改量、延期……开变更单，走与合同相同的审查，同意后合同升一版（旧版本留着）。</p>
          ) : (
            <ul className="space-y-3" data-testid="contract-changes">
              {c.changes.map((x) => (
                <li key={x.id} className="rounded-lg border border-line px-4 py-3" data-testid={`change-${x.changeNo}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num font-bold">{x.changeNo}</span>
                    <Badge tone={x.status === 'approved' ? 'pine' : x.status === 'reviewing' ? 'yuzu' : x.status === 'returned' ? 'clay' : 'neutral'}>{CHANGE_STATUS_LABELS[x.status]}</Badge>
                    <span className="text-[12.5px] text-ink-2">{x.kinds.map((k) => CHANGE_KIND_LABELS[k]).join('、')}</span>
                    <span className="text-[12.5px] text-ink-3">
                      在第 {x.baseVersion} 版上{x.resultVersion ? ` → 第 ${x.resultVersion} 版` : ''}
                    </span>
                    <span className="ml-auto text-[13px]">
                      总价 <Money cents={x.totalCents} className="font-bold" />
                      {/* 涨跌按变更前那一版的总价算（deltaCents 是绝对值，给审批规则匹配金额用） */}
                      {x.totalCents !== x.baseTotalCents && (
                        <span className={cn('num ml-1 font-semibold', x.totalCents > x.baseTotalCents ? 'text-clay' : 'text-pine')} data-testid={`change-delta-${x.changeNo}`}>
                          （{x.totalCents > x.baseTotalCents ? '+' : '−'}¥{formatAmount(Math.abs(x.totalCents - x.baseTotalCents))}）
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px]">{x.reason}</p>
                  {/* 变更后的内容：审查中的展开，审批人在这里就看得到改了什么（Codex 自动审查 315e7f7） */}
                  {(x.status === 'draft' || x.status === 'reviewing' || x.status === 'returned') && (
                    <details className="mt-2 rounded-md border border-line bg-paper-2/40 px-3 py-2" open={x.status === 'reviewing'} data-testid={`change-draft-${x.changeNo}`}>
                      <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-2">
                        变更后的内容（第 {x.baseVersion} 版 ¥{formatAmount(x.baseTotalCents)} → ¥{formatAmount(x.totalCents)}）
                      </summary>
                      <div className="mt-2 space-y-3">
                        <p className="text-[13px] text-ink-2">
                          {x.draft.title} · {x.draft.startDate ?? '—'} 至 {x.draft.endDate ?? '不定期'}
                        </p>
                        <TermsView content={x.draft} />
                        <LinesView lines={x.draft.lines.map((l, i) => ({ ...l, lineNo: i + 1, materialName: null }))} />
                        {x.draft.note && <p className="text-[12.5px] text-ink-2">备注：{x.draft.note}</p>}
                      </div>
                    </details>
                  )}
                  <p className="text-[12px] text-ink-3">
                    {x.createdByName} · {formatDateTime(x.createdAt)}
                    {x.closedReason && ` · 作废：${x.closedReason}`}
                  </p>
                  {x.status === 'reviewing' && <ApprovalProgress approval={x.approval} className="mt-2" />}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {manage && (x.status === 'draft' || x.status === 'returned') && (
                      <>
                        <Button size="sm" variant="secondary" icon={<FilePen className="size-4" />} onClick={() => navigate(`/erp/contracts/${c.id}/changes/${x.id}/edit`)}>
                          修改
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Send className="size-4" />}
                          loading={busy === `change-submit-${x.id}`}
                          onClick={() => void run(`change-submit-${x.id}`, `/api/erp/contracts/changes/${x.id}/submit`, { version: x.version }, `变更单 ${x.changeNo} 已提交审查`)}
                          data-testid={`change-submit-${x.changeNo}`}
                        >
                          提交审查
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDialog({ kind: 'change-void', change: x })}>
                          作废
                        </Button>
                      </>
                    )}
                    {manage && x.status === 'reviewing' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Undo2 className="size-4" />}
                        loading={busy === `change-withdraw-${x.id}`}
                        onClick={() => void run(`change-withdraw-${x.id}`, `/api/erp/contracts/changes/${x.id}/withdraw`, { version: x.version }, `变更单 ${x.changeNo} 已撤回`)}
                      >
                        撤回
                      </Button>
                    )}
                    <span className="ml-auto">
                      <ReviewActions approval={x.approval} kind="contract_change" docNo={x.changeNo} urlBase={`/api/erp/contracts/changes/${x.id}`} onDone={invalidate} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* 用印与扫描件 */}
      {(c.seals.length > 0 || c.files.length > 0 || ['approved', 'signed', 'archived'].includes(c.status)) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <h2 className="mb-2 text-[14px] font-bold">用印</h2>
            {c.seals.length === 0 ? (
              <p className="text-[13px] text-ink-3">审批通过以后申请用印（走审批，默认店主批）；归档前要有一条已生效的用印登记。</p>
            ) : (
              <ul className="space-y-2.5" data-testid="contract-seals">
                {c.seals.map((s) => (
                  <li key={s.id} className="rounded-lg border border-line px-3.5 py-2.5 text-[13px]" data-testid={`seal-${s.sealNo}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num font-bold">{s.sealNo}</span>
                      <Badge tone={s.status === 'approved' ? 'pine' : s.status === 'reviewing' ? 'yuzu' : s.status === 'returned' ? 'clay' : 'neutral'}>{SEAL_STATUS_LABELS[s.status]}</Badge>
                      <span>
                        {SEAL_TYPE_LABELS[s.sealType]} × {s.copies} 份
                      </span>
                    </div>
                    <p className="text-[12.5px] text-ink-2">
                      {s.sealDate} · 用印人 {s.operatorName}
                      {s.purpose && ` · ${s.purpose}`}
                    </p>
                    {s.status === 'reviewing' && <ApprovalProgress approval={s.approval} className="mt-2" />}
                    {s.status === 'returned' && s.approval?.actions.some((a) => a.action === 'return') && (
                      <p className="mt-1 text-[12.5px] font-semibold text-clay">退回：{s.approval.actions.filter((a) => a.action === 'return').at(-1)!.comment}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {manage && s.status === 'returned' && (
                        <Button size="sm" variant="secondary" icon={<FilePen className="size-4" />} onClick={() => setDialog({ kind: 'seal', seal: s })}>
                          改了再提交
                        </Button>
                      )}
                      {manage && (s.status === 'reviewing' || s.status === 'returned') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Undo2 className="size-4" />}
                          loading={busy === `seal-withdraw-${s.id}`}
                          onClick={() => void run(`seal-withdraw-${s.id}`, `/api/erp/contracts/seals/${s.id}/withdraw`, { version: s.version }, `用印申请 ${s.sealNo} 已撤回`)}
                        >
                          撤回
                        </Button>
                      )}
                      <span className="ml-auto">
                        <ReviewActions approval={s.approval} kind="contract_seal" docNo={s.sealNo} urlBase={`/api/erp/contracts/seals/${s.id}`} onDone={invalidate} />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <FilesCard c={c} manage={manage} onChanged={invalidate} />
        </div>
      )}

      {/* 采购单 */}
      {c.category === 'purchase' && effective && (
        <Card className="p-5">
          <h2 className="mb-2 text-[14px] font-bold">挂这份合同的采购单</h2>
          {c.purchaseOrders.length === 0 ? (
            <p className="text-[13px] text-ink-3">采购单选了这份合同以后列在这里；提交时按单价表核对，超价、超量要写原因。</p>
          ) : (
            <ul className="divide-y divide-line/70 text-[13px]" data-testid="contract-pos">
              {c.purchaseOrders.map((po) => (
                <li key={po.id} className="flex flex-wrap items-center gap-2 py-2">
                  {access.modules.includes('purchasing') ? (
                    <Link to={`/purchasing?po=${po.id}`} className="num font-semibold text-lake hover:underline">
                      {po.docNo}
                    </Link>
                  ) : (
                    <span className="num font-semibold">{po.docNo}</span>
                  )}
                  <Badge tone="neutral">{PO_STATUS_LABELS[po.status as PoStatus] ?? po.status}</Badge>
                  {po.contractNote && <span className="text-[12.5px] text-ember">超出合同：{po.contractNote}</span>}
                  <Money cents={po.totalCents} className="ml-auto font-semibold" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* 提交记录 */}
      {c.revisions.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-2 text-[14px] font-bold">提交记录与审查结论</h2>
          <ol className="space-y-3" data-testid="contract-revisions">
            {c.revisions.map((r) => (
              <li key={r.id} className="rounded-lg border border-line px-4 py-3">
                <p className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-bold">第 {r.seq} 次提交</span>
                  <span className="text-ink-2">{r.changeNo ? `变更单 ${r.changeNo}` : '合同'}</span>
                  {r.versionNo ? (
                    <Badge tone="pine">成为第 {r.versionNo} 版</Badge>
                  ) : r.approval ? (
                    <Badge tone={r.approval.status === 'pending' ? 'yuzu' : r.approval.status === 'returned' ? 'clay' : 'neutral'}>{APPROVAL_STATUS_LABELS[r.approval.status]}</Badge>
                  ) : null}
                  <span className="text-[12.5px] text-ink-3">
                    {r.submittedByName} · {formatDateTime(r.submittedAt)}
                  </span>
                  <span className="ml-auto text-[12.5px]">
                    总价 <Money cents={r.content.totalCents} className="font-semibold" />
                  </span>
                </p>
                {r.approval?.actions.some((a) => a.action === 'return') && (
                  <p className="mt-1 text-[12.5px] text-clay">
                    退回：
                    {r.approval.actions
                      .filter((a) => a.action === 'return')
                      .map((a) => `${a.actorName}「${a.comment}」`)
                      .join('；')}
                  </p>
                )}
                {r.reviews.length > 0 && <ReviewsView reviews={r.reviews} />}
                {/* 这次提交时的内容与单价表：旧版本留着可以查（Codex 自动审查 344f7e8） */}
                <details className="mt-2 rounded-md border border-line bg-paper-2/40 px-3 py-2" data-testid={`revision-content-${r.seq}`}>
                  <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-2">这次提交的内容与单价表</summary>
                  <div className="mt-2 space-y-3">
                    <p className="text-[13px] text-ink-2">
                      {r.content.title} · {r.content.startDate ?? '—'} 至 {r.content.endDate ?? '不定期'}
                    </p>
                    <TermsView content={r.content} />
                    <LinesView lines={r.lines} />
                    {r.content.note && <p className="text-[12.5px] text-ink-2">备注：{r.content.note}</p>}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <SignDialog open={dialog?.kind === 'sign'} c={c} busy={busy === 'sign'} onClose={() => setDialog(null)} onConfirm={(body) => void run('sign', `/api/erp/contracts/${c.id}/sign`, { version: c.version, ...body }, '已登记签署，合同生效')} />
      <ArchiveDialog
        open={dialog?.kind === 'archive'}
        c={c}
        ready={approvedSeal && c.files.length > 0}
        busy={busy === 'archive'}
        onClose={() => setDialog(null)}
        onConfirm={(archiveLocation) => void run('archive', `/api/erp/contracts/${c.id}/archive`, { version: c.version, archiveLocation }, '已归档')}
      />
      <TerminateDialog
        open={dialog?.kind === 'terminate'}
        c={c}
        busy={busy === 'terminate'}
        onClose={() => setDialog(null)}
        onConfirm={(reason, closedOn) => void run('terminate', `/api/erp/contracts/${c.id}/terminate`, { version: c.version, reason, closedOn }, '合同已终止')}
      />
      <ReasonDialog
        open={dialog?.kind === 'void'}
        busy={busy === 'void'}
        title={`作废 ${c.contractNo}`}
        description="作废后这份合同不能再改、不能再提交；记录留着。已签署的合同不能作废，请终止。"
        confirmLabel="确认作废"
        danger
        testId="contract-void-dialog"
        onClose={() => setDialog(null)}
        onConfirm={(reason) => void run('void', `/api/erp/contracts/${c.id}/void`, { version: c.version, reason }, '合同已作废')}
      />
      <ReasonDialog
        open={dialog?.kind === 'change-void'}
        busy={!!busy}
        title={`作废变更单 ${dialog?.kind === 'change-void' ? dialog.change.changeNo : ''}`}
        description="作废后这张变更单不再生效，合同保持当前版本。"
        confirmLabel="确认作废"
        danger
        onClose={() => setDialog(null)}
        onConfirm={(reason) =>
          dialog?.kind === 'change-void' &&
          void run(`change-void-${dialog.change.id}`, `/api/erp/contracts/changes/${dialog.change.id}/void`, { version: dialog.change.version, reason }, `变更单 ${dialog.change.changeNo} 已作废`)
        }
      />
      <SealDialog open={dialog?.kind === 'seal'} c={c} seal={dialog?.kind === 'seal' ? dialog.seal : null} onClose={() => setDialog(null)} onDone={invalidate} />
    </div>
  );
}

// ───────────────────────── 签署、归档、终止 ─────────────────────────

function SignDialog({ open, c, busy, onClose, onConfirm }: { open: boolean; c: ContractDetail; busy: boolean; onClose: () => void; onConfirm: (body: { signedOn: string; ourSignatory: string; theirSignatory: string }) => void }) {
  const session = useSession();
  const [signedOn, setSignedOn] = useState('');
  const [ours, setOurs] = useState('');
  const [theirs, setTheirs] = useState('');
  useResetOnOpen(open, () => {
    setSignedOn(session.calendarToday);
    setOurs('');
    setTheirs('');
  });
  const ok = !!signedOn && signedOn <= session.calendarToday && ours.trim() && theirs.trim();
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`登记签署 ${c.contractNo}`}
      description="双方签好字以后登记：签订日、双方签署人。登记后合同生效，采购单可以挂它；之后申请用印、上传扫描件、归档。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={() => onConfirm({ signedOn, ourSignatory: ours.trim(), theirSignatory: theirs.trim() })} data-testid="sign-confirm">
            登记签署
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="签订日" htmlFor="sg-date">
          <Input id="sg-date" type="date" value={signedOn} max={session.calendarToday} onChange={(e) => setSignedOn(e.target.value)} className="h-10" data-testid="sign-date" />
        </Field>
        <Field label="我方签署人" htmlFor="sg-ours">
          <Input id="sg-ours" value={ours} maxLength={20} onChange={(e) => setOurs(e.target.value)} className="h-10" data-testid="sign-ours" />
        </Field>
        <Field label="对方签署人" htmlFor="sg-theirs">
          <Input id="sg-theirs" value={theirs} maxLength={20} onChange={(e) => setTheirs(e.target.value)} className="h-10" data-testid="sign-theirs" />
        </Field>
      </div>
    </Dialog>
  );
}

function ArchiveDialog({ open, c, ready, busy, onClose, onConfirm }: { open: boolean; c: ContractDetail; ready: boolean; busy: boolean; onClose: () => void; onConfirm: (location: string) => void }) {
  const [location, setLocation] = useState('');
  useResetOnOpen(open, () => setLocation(''));
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`归档 ${c.contractNo}`}
      description="归档前要有一条已生效的用印登记和合同的扫描件；归档后给归档号，扫描件只能追加、不能删。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready || !location.trim()} onClick={() => onConfirm(location.trim())} data-testid="archive-confirm">
            归档
          </Button>
        </>
      }
    >
      {!ready && (
        <Notice tone="warning" className="mb-3" title="还不能归档">
          {!c.seals.some((s) => s.status === 'approved') && <span className="block">· 还没有已生效的用印登记</span>}
          {c.files.length === 0 && <span className="block">· 还没有上传扫描件</span>}
        </Notice>
      )}
      <Field label="纸质合同放在哪" htmlFor="ar-loc">
        <Input id="ar-loc" value={location} maxLength={60} onChange={(e) => setLocation(e.target.value)} placeholder="例如：财务室 1 号柜第 2 层" className="h-10" data-testid="archive-location" />
      </Field>
    </Dialog>
  );
}

function TerminateDialog({ open, c, busy, onClose, onConfirm }: { open: boolean; c: ContractDetail; busy: boolean; onClose: () => void; onConfirm: (reason: string, closedOn: string) => void }) {
  const session = useSession();
  const [reason, setReason] = useState('');
  const [closedOn, setClosedOn] = useState('');
  useResetOnOpen(open, () => {
    setReason('');
    setClosedOn(session.calendarToday);
  });
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`终止 ${c.contractNo}`}
      description="提前解除或不再履行时终止：写原因与终止日期。终止后采购单不能再挂这份合同；已经挂了的不受影响。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 2 || !closedOn} onClick={() => onConfirm(reason.trim(), closedOn)} data-testid="terminate-confirm">
            确认终止
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="终止日期" htmlFor="tm-date">
          <Input id="tm-date" type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} className="h-10" />
        </Field>
        <Field label="原因" htmlFor="tm-reason" className="sm:col-span-2">
          <Input id="tm-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className="h-10" data-testid="terminate-reason" />
        </Field>
      </div>
    </Dialog>
  );
}

// ───────────────────────── 用印申请 ─────────────────────────

function SealDialog({ open, c, seal, onClose, onDone }: { open: boolean; c: ContractDetail; seal: SealView | null; onClose: () => void; onDone: () => unknown }) {
  const session = useSession();
  const toast = useToast();
  const meta = useContractMeta();
  const [sealType, setSealType] = useState<SealType>('contract');
  const [copies, setCopies] = useState('2');
  const [operatorId, setOperatorId] = useState<number>(session.staff.id);
  const [sealDate, setSealDate] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 上一条用印申请没收到结果：先在页面上方查回、按原内容重新提交或作废，不另起一条（Codex 自动审查 315e7f7）
  const sealUrl = `/api/erp/contracts/${c.id}/seals`;
  const pendingSeal = useErpPending(['contract_seal']).filter((p) => p.url === sealUrl);
  const blockedByPending = !seal && pendingSeal.length > 0;
  useResetOnOpen(open, () => {
    setSealType(seal?.sealType ?? 'contract');
    setCopies(String(seal?.copies ?? 2));
    setOperatorId(seal?.operatorId ?? c.handlerId);
    setSealDate(seal?.sealDate ?? session.calendarToday);
    setPurpose(seal?.purpose ?? '合同盖章');
    setError(null);
  });
  const n = Number(copies);
  const ok = Number.isInteger(n) && n >= 1 && n <= 20 && !!sealDate;
  const submit = async () => {
    setBusy(true);
    setError(null);
    const fields = { sealType, copies: n, operatorId, sealDate, purpose: purpose.trim() };
    try {
      if (seal) {
        await api.put(`/api/erp/contracts/seals/${seal.id}`, { version: seal.version, ...fields });
      } else {
        const body = { clientKey: uuid(), ...fields };
        await sendErpOp({
          key: body.clientKey,
          type: 'contract_seal',
          url: `/api/erp/contracts/${c.id}/seals`,
          body,
          summary: `${c.contractNo} · ${SEAL_TYPE_LABELS[sealType]} × ${n} 份`,
          staffName: session.staff.displayName,
        });
      }
      toast({ tone: 'success', title: '用印申请已提交', body: `${c.contractNo}：在审批中心等批` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '用印申请没收到结果', body: seal ? '刷新后看状态（带了版本号，重复提交不会多一条）' : '记在页面上方「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={seal ? `修改用印申请 ${seal.sealNo}` : `用印申请 · ${c.contractNo}`}
      description="提交后走审批（默认店主批）；批了才算用印登记，归档前要有一条。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok || blockedByPending} onClick={() => void submit()} data-testid="seal-confirm">
            {seal ? '改了再提交' : '提交用印申请'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="印章" htmlFor="sl-type">
          <Select id="sl-type" value={sealType} onChange={(e) => setSealType(e.target.value as SealType)} data-testid="seal-type">
            {SEAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {SEAL_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="份数" htmlFor="sl-copies">
          <Input id="sl-copies" inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value)} className="h-10 text-right" />
        </Field>
        <Field label="用印人" htmlFor="sl-op">
          <Select id="sl-op" value={operatorId} onChange={(e) => setOperatorId(Number(e.target.value))}>
            {(meta.data?.staff ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="用印日期" htmlFor="sl-date">
          <Input id="sl-date" type="date" value={sealDate} onChange={(e) => setSealDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="用途" htmlFor="sl-purpose" className="sm:col-span-2">
          <Input id="sl-purpose" value={purpose} maxLength={100} onChange={(e) => setPurpose(e.target.value)} className="h-10" />
        </Field>
      </div>
      {blockedByPending && (
        <Notice tone="warning" className="mt-3" title="上一条用印申请结果待确认" data-testid="seal-pending-block">
          请先在页面上方查回、按原内容重新提交（同一编号只建一条）或确认作废，再申请新的。
        </Notice>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

// ───────────────────────── 扫描件 ─────────────────────────

function FilesCard({ c, manage, onChanged }: { c: ContractDetail; manage: boolean; onChanged: () => unknown }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // 一次选了几页时逐页上传，按钮上显示进度（Codex 自动审查 d64e3ed：原来只传前 20 张、后面的悄悄丢掉）
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const canAdd = manage && c.status !== 'voided';
  // 归档过的（含归档后终止的）扫描件只能追加
  const canRemove = manage && !c.archiveNo && c.status !== 'voided';
  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = [...files];
    let done = 0;
    setBusy(true);
    try {
      for (const f of list) {
        setProgress({ done, total: list.length });
        await api.post(`/api/erp/contracts/${c.id}/files`, await imagePayload(f), { timeoutMs: 30_000 });
        done += 1;
      }
      toast({ tone: 'success', title: '扫描件已上传', body: `${c.contractNo}：${done} 页` });
    } catch (e) {
      // 说清楚传到第几页：前面的已经存好，没传上的重新选了再传（同一张图重新上传不会多记一份）
      const which = list.length > 1 ? `第 ${done + 1} 页（共 ${list.length} 页）` : '扫描件';
      toast({
        tone: 'error',
        title: e instanceof UncertainError ? `${which}上传没收到结果` : `${which}没传上：${errorMessage(e)}`,
        body: `已上传 ${done} 页；${e instanceof UncertainError ? '刷新看看，' : ''}没传上的几页重新选了再传，同一张图重新上传不会多记一份`,
      });
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
      await onChanged();
    }
  };
  const remove = async (fileId: number) => {
    setRemoving(fileId);
    try {
      await api.post(`/api/erp/contracts/files/${fileId}/remove`, {});
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setRemoving(null);
      await onChanged();
    }
  };
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[14px] font-bold">扫描件</h2>
        <span className="text-[12.5px] text-ink-3">签好的合同按页拍照上传；归档后只能追加</span>
        {canAdd && (
          <>
            <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void upload(e.target.files)} data-testid="contract-file-input" />
            <Button size="sm" variant="secondary" className="ml-auto" loading={busy} icon={<ImagePlus className="size-4" />} onClick={() => input.current?.click()} data-testid="contract-file-upload">
              {progress && progress.total > 1 ? `上传中 ${progress.done + 1}/${progress.total}` : '上传'}
            </Button>
          </>
        )}
      </div>
      {c.files.length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有扫描件。</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="contract-files">
          {c.files.map((f, i) => (
            <li key={f.id} className="relative">
              <button type="button" onClick={() => setViewing(f.url)} className="block size-20 overflow-hidden rounded-md border border-line bg-paper-2 hover:border-line-strong" aria-label={`查看第 ${i + 1} 页`}>
                <img src={f.url} alt="" loading="lazy" className="size-full object-cover" />
              </button>
              {canRemove && (
                <button
                  type="button"
                  disabled={removing === f.id}
                  onClick={() => void remove(f.id)}
                  className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full bg-ink text-paper shadow disabled:opacity-50"
                  aria-label={`删除第 ${i + 1} 页`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!viewing} onClose={() => setViewing(null)} title="扫描件" width="max-w-3xl" footer={null}>
        {viewing && <img src={viewing} alt="" className="mx-auto max-h-[75vh] w-auto rounded-md" />}
      </Dialog>
    </Card>
  );
}
