import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { MemberSummary } from '@shared/types';
import { errorMessage } from '../../lib/api';
import { useMember } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn, isTypingTarget } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Sheet } from '../../components/Overlay';
import { Notice } from '../../components/ui';
import { ConsumeFlow } from '../flows/ConsumeFlow';
import { RechargeFlow } from '../flows/RechargeFlow';
import { ReversalDialog, type ReversalTarget } from '../flows/ReversalDialog';
import { MemberDetail, MemberDetailSkeleton } from './MemberDetail';
import { MemberFormDialog } from './MemberFormDialog';
import { MemberList } from './MemberList';
import { TodayPanel } from './TodayPanel';

function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}

type Flow = 'recharge' | 'consume' | null;

export function WorkbenchPage() {
  const session = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('m')) || null;
  const member = useMember(selectedId);
  const [flow, setFlow] = useState<Flow>(null);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; prefill?: string } | null>(null);
  const [reverseTarget, setReverseTarget] = useState<ReversalTarget | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const wide = useMedia('(min-width: 1280px)');
  const extraWide = useMedia('(min-width: 1536px)');
  const mid = useMedia('(min-width: 900px)');

  const select = useCallback(
    (id: number | null) => {
      setFlow(null);
      setParams(id ? { m: String(id) } : {}, { replace: false });
    },
    [setParams],
  );

  const openFlow = useCallback(
    (f: Flow) => {
      if (!member.data || member.data.status !== 'active') return;
      if (f === 'recharge' && !can('recharge.create')) return;
      if (f === 'consume' && !can('consume.create')) return;
      // 打开流程前刷新一次余额，确保核对时是最新数字
      void qc.invalidateQueries({ queryKey: ['member', member.data.id] });
      void qc.invalidateQueries({ queryKey: ['session'] }); // 取最新的扣款规则
      setFlow(f);
    },
    [member.data, can, qc],
  );

  // 从页面顶部「待确认操作」进入：打开对应流程，由流程按原操作编号自动查回结果
  const resume = params.get('resume');
  const resumeConsumption = Number(params.get('c')) || null;
  useEffect(() => {
    if (!resume || !member.data || member.data.id !== selectedId) return;
    if (resume === 'reversal' && resumeConsumption) {
      setReverseTarget({ consumptionId: resumeConsumption, memberId: member.data.id, memberName: member.data.name });
    } else if (resume === 'recharge' || resume === 'consume') {
      setFlow(resume);
    }
    setParams({ m: String(member.data.id) }, { replace: true });
  }, [resume, resumeConsumption, member.data, selectedId, setParams]);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]') && e.key !== '/') return;
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (key === 'r' && !flow) {
        e.preventDefault();
        openFlow('recharge');
      } else if (key === 'x' && !flow) {
        e.preventDefault();
        openFlow('consume');
      } else if (key === 'n' && can('member.write')) {
        e.preventDefault();
        setForm({ mode: 'create' });
      } else if (e.key === 'Escape' && flow) {
        setFlow(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flow, openFlow, can]);

  const flowNode =
    member.data && flow ? (
      flow === 'recharge' ? (
        <RechargeFlow key={`r-${member.data.id}`} member={member.data} onClose={() => setFlow(null)} onSwitchToConsume={() => setFlow('consume')} />
      ) : (
        <ConsumeFlow key={`c-${member.data.id}`} member={member.data} onClose={() => setFlow(null)} onSwitchToRecharge={() => setFlow('recharge')} />
      )
    ) : null;

  const showList = mid || !selectedId;
  const showDetail = mid || !!selectedId;

  return (
    <>
      <PageHeader title="会员工作台" subtitle={session.storeName} />
      <div
        className={cn(
          'grid min-h-0 flex-1',
          extraWide
            ? 'grid-cols-[320px_minmax(0,1fr)_400px]'
            : wide
              ? 'grid-cols-[288px_minmax(0,1fr)_380px]'
              : mid
                ? 'grid-cols-[300px_minmax(0,1fr)]'
                : 'grid-cols-1',
        )}
      >
        {showList && (
          <aside className="min-h-0 border-r border-line bg-paper-2/45">
            <MemberList
              ref={searchRef}
              selectedId={selectedId}
              onSelect={(m: MemberSummary) => select(m.id)}
              onCreate={(prefill) => setForm({ mode: 'create', prefill })}
            />
          </aside>
        )}

        {showDetail && (
          <main className="scroll-thin min-h-0 overflow-y-auto">
            {!selectedId ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  art="pool"
                  title="先找到会员"
                  description="在左侧输入手机号、后四位或姓名；新顾客可直接新建会员。"
                />
              </div>
            ) : member.isPending ? (
              <MemberDetailSkeleton />
            ) : member.error ? (
              <div className="p-6">
                <Notice tone="error" title={errorMessage(member.error)} />
              </div>
            ) : member.data ? (
              <MemberDetail
                member={member.data}
                activeFlow={flow}
                onRecharge={() => openFlow('recharge')}
                onConsume={() => openFlow('consume')}
                onEdit={() => setForm({ mode: 'edit' })}
                onReverse={(consumptionId) =>
                  setReverseTarget({ consumptionId, memberId: member.data!.id, memberName: member.data!.name })
                }
                onBack={mid ? undefined : () => select(null)}
              />
            ) : null}
          </main>
        )}

        {wide && (
          <section className={cn('min-h-0 border-l border-line', flow ? 'bg-card' : 'bg-paper-2/45')} aria-label={flow ? '操作面板' : '今日概览'}>
            {flowNode ?? <TodayPanel />}
          </section>
        )}
      </div>

      {!wide && (
        <Sheet open={!!flowNode} onClose={() => setFlow(null)} label={flow === 'recharge' ? '会员充值' : '登记消费'}>
          {flowNode}
        </Sheet>
      )}

      <MemberFormDialog
        open={!!form}
        member={form?.mode === 'edit' ? member.data : null}
        prefill={form?.prefill}
        onClose={() => setForm(null)}
        onSaved={(m) => {
          setForm(null);
          select(m.id);
        }}
        onOpenExisting={(id) => {
          setForm(null);
          select(id);
        }}
      />
      <ReversalDialog target={reverseTarget} onClose={() => setReverseTarget(null)} />
    </>
  );
}
