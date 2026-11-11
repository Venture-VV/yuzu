// 需求单草稿箱（供应链二次整改 03，docs/ERP_ROUND2.md）：查询、删除，与填单页的自动保存。
//
// 自动保存：每 30 秒看一次，内容与上次存的不一样就存（不弹提示）；切到别的标签页、关页面、刷新时马上存一次
// （keepalive：页面关了浏览器也把请求发完）；离开填单页时再存一次并提示「已保存草稿」。
// 草稿带版本号：别处存过以后这边再存会被拒绝，这一页就停止自动保存，不会悄悄盖掉别处的内容。
// 没收到回复的那一次保存，下一次先原样再发（同一个保存编号，服务端只算一次），再存新的内容。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DRAFT_AUTOSAVE_SECONDS, type RequestDraft, type RequestDraftSaveInput, type RequestDraftsList, type RequestDraftSummary } from '@shared/requests';
import { api, ApiError } from '../../lib/api';
import { uuid } from '../../lib/utils';

// 与需求单共用 'inv' 缓存前缀：需求单提交、审核以后草稿箱一起刷新
const dk = {
  list: (requestId: number | null) => ['inv', 'request-drafts', requestId ?? 0] as const,
  all: ['inv', 'request-drafts'] as const,
  one: (key: string) => ['inv', 'request-draft', key] as const,
};

/** 自己的草稿；requestId 给了就只要这张需求单的修改草稿 */
export const useDrafts = (requestId: number | null = null, enabled = true) =>
  useQuery({
    queryKey: dk.list(requestId),
    queryFn: () => api.get<RequestDraftsList>(`/api/erp/requests/drafts${requestId ? `?requestId=${requestId}` : ''}`),
    enabled,
  });

/** 一份草稿的全部内容。继续填写时只在打开的那一刻读一次：之后页面上的内容以页面为准，不跟着重新读 */
export const useDraft = (key: string | null) =>
  useQuery({
    queryKey: dk.one(key ?? ''),
    queryFn: () => api.get<RequestDraft>(`/api/erp/requests/drafts/${key}`),
    enabled: !!key,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

export const fetchDraft = (key: string) => api.get<RequestDraft>(`/api/erp/requests/drafts/${key}`);
export const deleteDraft = (key: string) => api.post<{ ok: true }>(`/api/erp/requests/drafts/${key}/delete`);

export function useInvalidateDrafts() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: dk.all });
}

export const DRAFT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DraftStatus =
  /** 还没存过 */
  | { state: 'idle' }
  | { state: 'saved'; at: string }
  /** 这一次没存上（断网、服务器出错），下一次再试 */
  | { state: 'error'; message: string }
  /** 草稿箱满了：这一页的内容还没存成草稿 */
  | { state: 'full'; message: string }
  /** 不再自动保存：changed 别处改过；closed 已提交、已删除或已过期 */
  | { state: 'stopped'; reason: 'changed' | 'closed'; message: string };

type Outcome = 'saved' | 'unchanged' | 'skipped' | 'failed' | 'stopped';

export interface DraftAutosaveOptions {
  draftKey: string;
  /** 继续填写的草稿打开时的版本与保存时间；新起的是 0 */
  initialRev: number;
  initialSavedAt?: string;
  /** 打开时的内容（继续填写的草稿、要修改的需求单、空白单）：与它一样就不用存 */
  baseline: string;
  requestId: number | null;
  /** 现在页面上的内容；blank = 一个字都没填（还没有草稿时不存） */
  snapshot: () => { body: RequestDraftSaveInput['body']; blank: boolean };
  /** 先不存：正在提交，或上一张需求单结果待确认 */
  paused: boolean;
  /** 第一次存成草稿 */
  onCreated?: () => void;
  /** 每次存上以后（刷新草稿箱的份数） */
  onSaved?: (summary: RequestDraftSummary) => void;
  /** 离开填单页时草稿存好了 */
  onLeaveSaved?: () => void;
}

export function useDraftAutosave(o: DraftAutosaveOptions) {
  const [status, setStatus] = useState<DraftStatus>(o.initialRev > 0 && o.initialSavedAt ? { state: 'saved', at: o.initialSavedAt } : { state: 'idle' });
  const opts = useRef(o);
  opts.current = o;
  const st = useRef({
    rev: o.initialRev,
    saved: o.baseline,
    stopped: false,
    /** 没收到回复的那一次保存：下一次先原样再发 */
    retry: null as { saveId: string; json: string } | null,
    queue: Promise.resolve<Outcome>('unchanged'),
    busy: false,
  });

  const put = async (json: string, saveId: string, keepalive: boolean): Promise<Outcome> => {
    const s = st.current;
    const first = s.rev === 0;
    try {
      const res = await api.put<RequestDraftSummary>(
        `/api/erp/requests/drafts/${opts.current.draftKey}`,
        { rev: s.rev, saveId, requestId: opts.current.requestId, body: JSON.parse(json) as RequestDraftSaveInput['body'] } satisfies RequestDraftSaveInput,
        { keepalive },
      );
      s.rev = res.rev;
      s.saved = json;
      s.retry = null;
      setStatus({ state: 'saved', at: res.updatedAt });
      if (first) opts.current.onCreated?.();
      opts.current.onSaved?.(res);
      return 'saved';
    } catch (e) {
      if (e instanceof ApiError) {
        s.retry = null;
        if (e.code === 'DRAFT_CHANGED') {
          s.stopped = true;
          setStatus({ state: 'stopped', reason: 'changed', message: e.message });
          return 'stopped';
        }
        if (e.code === 'DRAFT_CLOSED' || e.code === 'DRAFT_GONE' || e.status === 404) {
          s.stopped = true;
          setStatus({ state: 'stopped', reason: 'closed', message: e.message });
          return 'stopped';
        }
        if (e.code === 'DRAFT_LIMIT') {
          setStatus({ state: 'full', message: e.message });
          return 'failed';
        }
        setStatus({ state: 'error', message: e.message });
        return 'failed';
      }
      // 结果不明（超时、断网、服务器出错）：可能已经存上了，下一次先按同一个保存编号原样再发
      s.retry = { saveId, json };
      setStatus({ state: 'error', message: '草稿这一次没存上，稍后自动再试' });
      return 'failed';
    }
  };

  const run = async (keepalive: boolean): Promise<Outcome> => {
    const s = st.current;
    if (s.stopped) return 'stopped';
    if (opts.current.paused) return 'skipped';
    if (s.retry) {
      const again = await put(s.retry.json, s.retry.saveId, keepalive);
      if (again !== 'saved') return again;
    }
    const { body, blank } = opts.current.snapshot();
    const json = JSON.stringify(body);
    if (json === s.saved) return s.rev > 0 ? 'unchanged' : 'skipped';
    if (s.rev === 0 && blank) return 'skipped';
    return put(json, uuid(), keepalive);
  };

  /** 排队存一次（同一时刻只有一个保存请求在路上） */
  const save = (keepalive = false): Promise<Outcome> => {
    const s = st.current;
    const next = s.queue.then(() => run(keepalive));
    s.busy = true;
    const tracked = next.catch((): Outcome => 'failed');
    s.queue = tracked;
    void tracked.then(() => {
      if (s.queue === tracked) s.busy = false;
    });
    return tracked;
  };

  /** 不再保存（提交成功以后离开页面时用） */
  const stop = () => {
    st.current.stopped = true;
  };

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => {
      if (!st.current.busy) void save();
    }, DRAFT_AUTOSAVE_SECONDS * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void save(true);
    };
    const onPageHide = () => void save(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      // 离开填单页：马上存一次。开发模式下 React 会把副作用先卸一次再装回来（StrictMode），那一次不算离开
      setTimeout(() => {
        if (mounted.current) return;
        void save().then((r) => {
          if ((r === 'saved' || r === 'unchanged') && !st.current.stopped) opts.current.onLeaveSaved?.();
        });
      }, 0);
    };
    // 只在装上、卸下时各做一次；要用到的值都从 ref 里取最新的
  }, []);

  return { status, save, stop };
}
