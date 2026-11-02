import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Hourglass } from 'lucide-react';
import type { FrontdeskOpLookup } from '@shared/frontdesk';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button, Notice } from '../../components/ui';

// 前台「结果待确认」的操作（接待发牌、挂账、换牌、结账，以及餐饮的开台、桌台点单、桌台结账），保存在本机浏览器里。
//
// 提交前先记下操作编号、对象和原请求，并读回核对确实已保存；保存不了（存储已满或被禁用）就不发请求。
// 只有确认了结果（成功、服务端明确拒绝、员工作废且服务端确认作废）才删除。
// 关闭对话框、刷新、切换手牌或重新登录后，同一对象上仍提示待确认，原操作确认前不能另起一笔。
// 处理方式：
//   · 查回：只读查询，查不到只代表此刻还没有已提交的结果，不能据此断定没有生效；
//   · 按原内容重新提交：沿用原编号与原请求，服务端保证只生效一次；重提被明确拒绝时，先在服务端作废编号再下结论；
//   · 确认作废：服务端先把编号登记为作废，原请求之后即使到达也整笔回滚，然后才允许重新填写。

export type FrontdeskOpType =
  | 'checkin'
  | 'bill_post'
  | 'tag_swap'
  | 'checkout'
  | 'table_open'
  | 'table_post'
  | 'table_checkout'
  | 'room_checkin'
  | 'room_extend'
  | 'room_deposit'
  | 'room_refund'
  | 'room_close'
  | 'line_move'
  | 'usage_open'
  | 'usage_end'
  | 'usage_cancel'
  | 'checkout_refund';

export interface FrontdeskPendingOp {
  key: string;
  type: FrontdeskOpType;
  url: string;
  body: unknown;
  /** 挂账、换牌对应的来访；接待为 null；结账为发起结账的那张手牌 */
  visitId: number | null;
  /** 结账涉及的全部来访（同行合并结账），这些手牌上都不能另起一笔结账 */
  visitIds?: number[];
  /** 开台：那张桌台（同一张桌台上不能另起一笔开台） */
  tableId?: number;
  /** 桌台点单：那次开台；桌台结账：涉及的全部开台（这几桌都不能另起一笔） */
  sessionIds?: number[];
  /** 客房入住（S7）：那间房（同一间房上不能另起一笔入住） */
  roomId?: number;
  /** 客房续住、押金、退房：那张入住单 */
  stayIds?: number[];
  /** 派对房等开单（v0.7.19）：那间房（空间；同一间房上不能另起一笔开单） */
  spaceId?: number;
  /** 使用单结束、撤单：那张使用单 */
  usageIds?: number[];
  /** 退款单（v0.7.20）：原结账单（同一张结账单上不能另起一笔退款） */
  checkoutIds?: number[];
  /** 展示用：涉及的手牌（桌台为「桌 A1」）、内容摘要、金额 */
  tagCodes: string[];
  summary: string;
  amount: number | null;
  staffName: string;
  createdAt: string;
}

export const FRONTDESK_OP_LABELS: Record<FrontdeskOpType, string> = {
  checkin: '接待发牌',
  bill_post: '挂账',
  tag_swap: '换牌',
  checkout: '结账',
  table_open: '开台',
  table_post: '桌台点单',
  table_checkout: '桌台结账',
  room_checkin: '客房入住',
  room_extend: '客房续住',
  room_deposit: '收押金',
  room_refund: '退押金',
  room_close: '客房退房',
  line_move: '转单',
  usage_open: '开单使用',
  usage_end: '结束使用',
  usage_cancel: '撤使用单',
  checkout_refund: '退款单',
};

/** 餐饮桌台的操作：对象是桌台或开台，不是手牌 */
export const isTableOp = (type: FrontdeskOpType) => type === 'table_open' || type === 'table_post' || type === 'table_checkout';
/** 客房的操作（S7）：对象是房间或入住单，在客房页处理 */
export const isRoomOp = (type: FrontdeskOpType) => type.startsWith('room_');
/** 派对房等的使用单（v0.7.19）：对象是空间或使用单，在客房页的平面图上处理 */
export const isUsageOp = (type: FrontdeskOpType) => type.startsWith('usage_');

const STORAGE_KEY = 'yuzu.frontdeskPending.v1';
const listeners = new Set<() => void>();
const inFlight = new Set<string>();
/** 正由打开的对话框处理的编号：顶部提醒不显示、不抢先自动查回，避免对话框里的内容被悄悄解锁 */
const claimed = new Set<string>();
/** 已有结论、但本机删不掉记录的编号：本页先隐藏，下次进入页面自动查回后再删 */
const settled = new Set<string>();
let cachedRaw: string | null | undefined;
let cachedList: FrontdeskPendingOp[] = [];

/** 待确认记录无法可靠保存到本机：为防止断网后重复登记，这笔不能提交 */
export const PENDING_STORE_FAILED =
  '本机浏览器无法保存「结果待确认」记录（存储空间已满或被禁用），为防止断网后重复发牌或挂账，这笔没有提交。请联系店主清理浏览器数据，或换一台终端办理。';

function readAll(): FrontdeskPendingOp[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null; // 存储不可用：写入同样会失败，提交前就会被拦下，这里不会有记录
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as FrontdeskPendingOp[]) : [];
    cachedList = (Array.isArray(parsed) ? parsed : []).filter((p) => !settled.has(p.key));
  } catch {
    cachedList = [];
  }
  return cachedList;
}

/** 写入并读回核对：写入被拒绝（例如存储已满）或被静默丢弃时返回 false */
function persist(list: FrontdeskPendingOp[]): boolean {
  const raw = list.length ? JSON.stringify(list) : null;
  try {
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
    return localStorage.getItem(STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

function notify() {
  cachedRaw = undefined;
  snapshotCache = null;
  bannerCache = null;
  listeners.forEach((fn) => fn());
}

/** 提交前保存；保存不了时返回 false，调用方不得发出请求 */
function save(op: FrontdeskPendingOp): boolean {
  const list = readAll();
  if (list.some((p) => p.key === op.key)) return true; // 原样重提：记录已在本机
  if (!persist([...list, op])) return false;
  notify();
  return true;
}

export function removeFrontdeskPending(key: string) {
  const list = readAll();
  if (!list.some((p) => p.key === key)) return;
  if (!persist(list.filter((p) => p.key !== key))) settled.add(key);
  notify();
}

function setInFlight(key: string, active: boolean) {
  if (active) inFlight.add(key);
  else inFlight.delete(key);
  snapshotCache = null;
  bannerCache = null;
  listeners.forEach((fn) => fn());
}

function setClaimed(key: string, active: boolean) {
  if (active) claimed.add(key);
  else claimed.delete(key);
  bannerCache = null;
  listeners.forEach((fn) => fn());
}

let snapshotCache: { source: FrontdeskPendingOp[]; result: FrontdeskPendingOp[] } | null = null;
function snapshot(): FrontdeskPendingOp[] {
  const all = readAll();
  if (snapshotCache && snapshotCache.source === all) return snapshotCache.result;
  snapshotCache = { source: all, result: all.filter((p) => !inFlight.has(p.key)) };
  return snapshotCache.result;
}

let bannerCache: { source: FrontdeskPendingOp[]; result: FrontdeskPendingOp[] } | null = null;
function bannerSnapshot(): FrontdeskPendingOp[] {
  const all = readAll();
  if (bannerCache && bannerCache.source === all) return bannerCache.result;
  bannerCache = { source: all, result: all.filter((p) => !inFlight.has(p.key) && !claimed.has(p.key)) };
  return bannerCache.result;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      snapshotCache = null;
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 全部待确认的前台操作（不含本页正在提交中的） */
export function useFrontdeskPending(): FrontdeskPendingOp[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** 顶部提醒用：另外排除正由打开的对话框处理的 */
export function useFrontdeskPendingForBanner(): FrontdeskPendingOp[] {
  return useSyncExternalStore(subscribe, bannerSnapshot);
}

/**
 * 某个对象上的待确认操作：接待看全部接待；挂账、换牌看同一位客人；结账看涉及这位客人的结账；
 * 开台看同一张桌台；桌台点单看同一次开台；桌台结账看涉及这次开台的结账。
 */
export function pendingFor(
  list: FrontdeskPendingOp[],
  type: FrontdeskOpType,
  visitId: number | null,
  table: {
    tableId?: number | null;
    sessionId?: number | null;
    roomId?: number | null;
    stayId?: number | null;
    spaceId?: number | null;
    usageId?: number | null;
    checkoutId?: number | null;
  } = {},
) {
  return list.find((p) => {
    if (p.type !== type) return false;
    if (type === 'checkin') return true;
    if (type === 'checkout_refund') return table.checkoutId != null && !!p.checkoutIds?.includes(table.checkoutId);
    if (type === 'usage_open') return table.spaceId != null && p.spaceId === table.spaceId;
    if (isUsageOp(type)) return table.usageId != null && !!p.usageIds?.includes(table.usageId);
    if (type === 'table_open') return table.tableId != null && p.tableId === table.tableId;
    if (type === 'table_post' || type === 'table_checkout') return table.sessionId != null && !!p.sessionIds?.includes(table.sessionId);
    if (type === 'room_checkin') return table.roomId != null && p.roomId === table.roomId;
    if (isRoomOp(type)) return table.stayId != null && !!p.stayIds?.includes(table.stayId);
    return p.visitId === visitId || (visitId !== null && !!p.visitIds?.includes(visitId));
  });
}

export type OpState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'error'; message: string; code?: string }
  | { phase: 'uncertain'; message: string }
  | { phase: 'not_found' };

type Pick<T> = (found: Extract<FrontdeskOpLookup, { found: true }>) => T | null;

/**
 * 前台写操作的提交状态机（与会员记账的待确认流程同一思路）。
 * 有待确认记录时，表单锁定、只能查回 / 原样重提 / 确认作废；没有时每次提交使用新的操作编号。
 */
export function useFrontdeskOp<T>(opts: {
  type: FrontdeskOpType;
  visitId: number | null;
  /** 开台：桌台；桌台点单、桌台结账：开台（发起结账的那桌） */
  tableId?: number | null;
  sessionId?: number | null;
  /** 客房入住：房间；续住、押金、退房：入住单 */
  roomId?: number | null;
  stayId?: number | null;
  /** 派对房等开单：空间；结束、撤单：使用单 */
  spaceId?: number | null;
  usageId?: number | null;
  /** 退款单：原结账单 */
  checkoutId?: number | null;
  staffName: string;
  pick: Pick<T>;
}) {
  const all = useFrontdeskPending();
  const pending =
    pendingFor(all, opts.type, opts.visitId, {
      tableId: opts.tableId,
      sessionId: opts.sessionId,
      roomId: opts.roomId,
      stayId: opts.stayId,
      spaceId: opts.spaceId,
      usageId: opts.usageId,
      checkoutId: opts.checkoutId,
    }) ?? null;
  const [state, setState] = useState<OpState>({ phase: 'idle' });
  const { pick } = opts;
  const pendingKey = pending?.key;
  useEffect(() => {
    if (!pendingKey) return;
    setClaimed(pendingKey, true);
    return () => setClaimed(pendingKey, false);
  }, [pendingKey]);

  const send = useCallback(
    async (op: FrontdeskPendingOp, isRetry = false): Promise<T | null> => {
      // 记录存不进本机：一旦响应丢失就无法查回原编号，所以这笔不提交
      if (!save(op)) {
        setState({ phase: 'error', message: PENDING_STORE_FAILED, code: 'PENDING_STORE_FAILED' });
        return null;
      }
      setState({ phase: 'busy' });
      setInFlight(op.key, true);
      try {
        const result = await api.post<T>(op.url, op.body);
        removeFrontdeskPending(op.key);
        setState({ phase: 'idle' });
        return result;
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          if (isRetry && error.code !== 'OP_ABANDONED') {
            // 重提被明确拒绝，不代表之前那次结果不明的请求不会随后生效：先在服务端作废编号，再下结论
            let fenced: FrontdeskOpLookup | null = null;
            try {
              fenced = await api.post<FrontdeskOpLookup>(`/api/frontdesk/ops/${op.key}/abandon`, { type: op.type });
            } catch {
              /* 作废没有完成，下面按待确认处理 */
            }
            if (fenced?.found) {
              removeFrontdeskPending(op.key);
              setState({ phase: 'idle' });
              return pick(fenced);
            }
            if (!fenced?.abandoned) {
              setState({ phase: 'uncertain', message: `重新提交被拒绝（${error.message}），但原请求是否会生效仍不确定` });
              return null;
            }
          }
          // 服务端明确拒绝（含该编号已作废）：没有生效
          removeFrontdeskPending(op.key);
          setState({ phase: 'error', message: error.message, code: error.code });
        } else {
          const reason = error instanceof UncertainError ? error.message : '服务器出了点问题';
          setState({ phase: 'uncertain', message: `${reason}，这次${FRONTDESK_OP_LABELS[op.type]}是否已生效暂不确定` });
        }
        return null;
      } finally {
        setInFlight(op.key, false);
      }
    },
    [pick],
  );

  /** 提交一笔新的操作（有待确认记录时不允许） */
  const submit = useCallback(
    async (
      build: (key: string) => {
        url: string;
        body: unknown;
        tagCodes: string[];
        summary: string;
        amount: number | null;
        visitIds?: number[];
        sessionIds?: number[];
        stayIds?: number[];
      },
    ) => {
      if (pending) return null;
      const key = uuid();
      const b = build(key);
      const table = {
        ...(opts.tableId != null ? { tableId: opts.tableId } : {}),
        ...(opts.sessionId != null ? { sessionIds: [opts.sessionId] } : {}),
        ...(opts.roomId != null ? { roomId: opts.roomId } : {}),
        ...(opts.stayId != null ? { stayIds: [opts.stayId] } : {}),
        ...(opts.spaceId != null ? { spaceId: opts.spaceId } : {}),
        ...(opts.usageId != null ? { usageIds: [opts.usageId] } : {}),
        ...(opts.checkoutId != null ? { checkoutIds: [opts.checkoutId] } : {}),
      };
      return send({ key, type: opts.type, visitId: opts.visitId, staffName: opts.staffName, createdAt: new Date().toISOString(), ...table, ...b });
    },
    [pending, send, opts.type, opts.visitId, opts.tableId, opts.sessionId, opts.roomId, opts.stayId, opts.spaceId, opts.usageId, opts.checkoutId, opts.staffName],
  );

  /** 按原内容、原编号重新提交 */
  const retry = useCallback(async () => (pending ? send(pending, true) : null), [pending, send]);

  const settle = useCallback(
    (key: string, found: FrontdeskOpLookup): T | null => {
      if (found.found) {
        removeFrontdeskPending(key);
        setState({ phase: 'idle' });
        return pick(found);
      }
      if (found.abandoned) {
        // 服务端确认已作废：原操作永远不会生效，可以重新填写
        removeFrontdeskPending(key);
        setState({ phase: 'idle' });
        return null;
      }
      setState({ phase: 'not_found' });
      return null;
    },
    [pick],
  );

  /** 只读查回 */
  const check = useCallback(async () => {
    if (!pending) return null;
    setState({ phase: 'busy' });
    try {
      return settle(pending.key, await api.get<FrontdeskOpLookup>(`/api/frontdesk/ops/${pending.key}?type=${pending.type}`));
    } catch (error) {
      setState({ phase: 'uncertain', message: `仍然无法确认：${errorMessage(error)}` });
      return null;
    }
  }, [pending, settle]);

  /** 确认作废：原操作已生效时返回其结果，否则服务端登记作废后才删除本机记录 */
  const abandon = useCallback(async () => {
    if (!pending) return null;
    setState({ phase: 'busy' });
    try {
      return settle(pending.key, await api.post<FrontdeskOpLookup>(`/api/frontdesk/ops/${pending.key}/abandon`, { type: pending.type }));
    } catch (error) {
      setState({ phase: 'uncertain', message: `作废未完成，原操作仍待确认：${errorMessage(error)}` });
      return null;
    }
  }, [pending, settle]);

  const clearError = useCallback(() => setState((s) => (s.phase === 'error' ? { phase: 'idle' } : s)), []);

  return { pending, state, submit, retry, check, abandon, clearError, busy: state.phase === 'busy', locked: !!pending || state.phase === 'busy' };
}

/** 对话框里的待确认处理区：查回 / 按原内容重新提交 / 确认作废 */
export function PendingPanel<T>({
  op,
  onResolved,
}: {
  op: ReturnType<typeof useFrontdeskOp<T>>;
  onResolved: (result: T) => void;
}) {
  const p = op.pending;
  const run = async (fn: () => Promise<T | null>) => {
    const r = await fn();
    if (r) onResolved(r);
  };
  // 出现待确认记录（刚提交失败、或重新打开对话框）时自动只读查回一次：已生效的直接完成，查不到的继续待确认
  const autoChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!p || autoChecked.current === p.key) return;
    autoChecked.current = p.key;
    void run(op.check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.key]);
  if (!p) return null;
  return (
    <Notice
      tone="warning"
      icon={<Hourglass className="size-4" />}
      title={`上一笔${FRONTDESK_OP_LABELS[p.type]}结果待确认`}
      className="mb-4"
      action={
        <>
          <Button size="sm" variant="primary" loading={op.busy} onClick={() => run(op.check)} data-testid="pending-check">
            查回结果
          </Button>
          <Button size="sm" variant="secondary" disabled={op.busy} onClick={() => run(op.retry)} data-testid="pending-retry">
            按原内容重新提交
          </Button>
          <Button size="sm" variant="ghost" disabled={op.busy} onClick={() => run(op.abandon)} data-testid="pending-abandon">
            确认作废，重新填写
          </Button>
        </>
      }
    >
      <span data-testid="pending-op">
        {p.tagCodes.join('、')} · {p.summary}
        {p.amount !== null && (
          <>
            {' '}
            · <Money cents={p.amount} className="font-bold" />
          </>
        )}
        <span className="text-ink-3">
          {' '}
          · {formatDateTime(p.createdAt)} {p.staffName}
        </span>
      </span>
      <span className="mt-1 block">
        {op.state.phase === 'uncertain'
          ? `${op.state.message}。`
          : op.state.phase === 'not_found'
            ? '暂未查到已生效的结果，原请求可能仍在处理。可按原内容重新提交（沿用原编号，不会重复），或确认作废后重新填写（作废后原请求即使到达也不会生效）。'
            : `处理前不能对这${isTableOp(p.type) ? '桌' : isRoomOp(p.type) || isUsageOp(p.type) ? '间房' : '张手牌'}另起一笔，避免重复。`}
      </span>
    </Notice>
  );
}
