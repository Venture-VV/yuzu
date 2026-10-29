import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OperationLookup, OperationResult } from '@shared/types';
import { api, ApiError, UncertainError } from '../../lib/api';
import {
  PENDING_LABELS,
  PendingStoreError,
  removePending,
  savePending,
  setClaimed,
  setInFlight,
  type PendingOp,
  type PendingType,
} from '../../lib/pendingOps';
import { uuid } from '../../lib/utils';
import { useToast } from '../../components/Toast';

export type OperationState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; result: OperationResult; recovered: boolean }
  | { status: 'error'; error: ApiError }
  | { status: 'uncertain'; reason: 'timeout' | 'network' | 'server' }
  | { status: 'checking' }
  | { status: 'not_found' }
  | { status: 'abandoning' };

export interface OperationSpec {
  type: PendingType;
  url: string;
  /** 由当前表单生成请求体，以及待确认时展示用的信息 */
  build: (idempotencyKey: string) => { body: unknown; meta: Omit<PendingOp, 'key' | 'type' | 'url' | 'body' | 'createdAt'> };
}

/** 在服务端作废操作编号：之后原请求即使到达也不会入账。原操作已经入账时，返回查回的结果 */
export function abandonOnServer(op: PendingOp) {
  return api.post<OperationLookup>(`/api/operations/${op.key}/abandon`, {
    type: op.type,
    memberId: op.memberId > 0 ? op.memberId : undefined,
    amount: op.amount,
    summary: op.summary.slice(0, 200),
  });
}

const uncertainReason = (error: unknown) => (error instanceof UncertainError ? error.reason : error instanceof ApiError ? 'server' : 'network');

/**
 * 记账操作的提交状态机。
 * - 每次进入「核对」步骤生成新的操作编号；重试与查询都沿用同一个编号，服务端保证不会重复记账。
 * - 提交前把编号和原请求存到本机（pendingOps）并读回核对；存不进去就不发请求。超时 / 断网 / 服务器异常时保留，
 *   面板关闭或刷新后仍可查回。
 * - 查不到不能断定没有入账（原请求可能还在路上或在等锁）。员工只能按原内容重新提交（同一编号，安全），
 *   或确认作废：服务端先登记作废，原请求之后即使到达也会整笔回滚，然后才开始新的一笔。
 */
export function useOperation(spec: OperationSpec) {
  const qc = useQueryClient();
  const toast = useToast();
  const keyRef = useRef(uuid());
  const pendingRef = useRef<PendingOp | null>(null);
  /** 曾经结果不明的编号：对它的重提即使被明确拒绝，之前那次请求也可能随后入账 */
  const unsettledRef = useRef(new Set<string>());
  const [state, setState] = useState<OperationState>({ status: 'idle' });
  /** 正在处理一笔之前留下的待确认操作 */
  const [adopted, setAdopted] = useState<PendingOp | null>(null);
  /** 本流程正在处理的编号；流程打开期间由它负责，关闭后交给页面顶部的提醒 */
  const [claimedKey, setClaimedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!claimedKey) return;
    setClaimed(claimedKey, true);
    return () => setClaimed(claimedKey, false);
  }, [claimedKey]);

  const refreshAfter = useCallback(
    (result: OperationResult) => {
      void qc.invalidateQueries({ queryKey: ['member', result.member.id] });
      void qc.invalidateQueries({ queryKey: ['activity', result.member.id] });
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['ledger'] });
      void qc.invalidateQueries({ queryKey: ['settlement'] });
      void qc.invalidateQueries({ queryKey: ['consumption'] });
    },
    [qc],
  );

  const succeed = useCallback(
    (key: string, result: OperationResult, recovered: boolean) => {
      removePending(key);
      unsettledRef.current.delete(key);
      setState({ status: 'success', result, recovered });
      refreshAfter(result);
    },
    [refreshAfter],
  );

  /** 内容变化（返回修改、再登记一笔）时换一个新编号；不会删除未确认的记录 */
  const reset = useCallback(() => {
    keyRef.current = uuid();
    pendingRef.current = null;
    setAdopted(null);
    setClaimedKey(null);
    setState({ status: 'idle' });
  }, []);

  /** 服务端确认编号已作废：这笔永远不会入账，删除记录、开始新的一笔 */
  const voided = useCallback(
    (op: PendingOp) => {
      removePending(op.key);
      unsettledRef.current.delete(op.key);
      reset();
      toast({ tone: 'info', title: `已作废这笔${PENDING_LABELS[op.type]}，没有入账`, body: '原请求即使稍后到达也不会入账，可以重新填写。' });
    },
    [reset, toast],
  );

  /** 服务端明确拒绝了这一次提交 */
  const rejected = useCallback(
    async (op: PendingOp, error: ApiError) => {
      let fenced = error.code === 'OP_ABANDONED';
      if (!fenced && unsettledRef.current.has(op.key)) {
        // 这是对一笔结果不明的操作的重提：这次被拒绝，不代表之前那次请求不会随后入账。
        // 先在服务端作废编号，确认作废（或查到其实已入账）后才算有结论
        try {
          const res = await abandonOnServer(op);
          if (res.found) {
            const { found: _found, ...result } = res;
            return succeed(op.key, result, true);
          }
          fenced = res.abandoned;
        } catch {
          fenced = false;
        }
        if (!fenced) return setState({ status: 'uncertain', reason: 'network' });
      }
      removePending(op.key);
      unsettledRef.current.delete(op.key);
      // 编号已作废时，之后的提交换用新编号
      if (fenced && keyRef.current === op.key) keyRef.current = uuid();
      setState({ status: 'error', error });
    },
    [succeed],
  );

  const send = useCallback(
    async (op: PendingOp) => {
      try {
        savePending(op);
      } catch (error) {
        // 记录存不进本机：一旦响应丢失就无法查回原编号，所以这笔不提交
        if (!(error instanceof PendingStoreError)) throw error;
        setState({ status: 'error', error: new ApiError(0, error.code, error.message) });
        return;
      }
      setState({ status: 'submitting' });
      setInFlight(op.key, true);
      try {
        const result = await api.post<OperationResult>(op.url, op.body);
        succeed(op.key, result, result.replayed);
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          await rejected(op, error);
        } else {
          // 超时、断网或服务器异常（例如入账后读取结果失败）：无法确定是否已入账，按待确认处理
          unsettledRef.current.add(op.key);
          setState({ status: 'uncertain', reason: uncertainReason(error) });
        }
      } finally {
        setInFlight(op.key, false);
      }
    },
    [succeed, rejected],
  );

  /** 按当前表单提交一笔新的操作 */
  const submit = useCallback(async () => {
    const key = keyRef.current;
    const { body, meta } = spec.build(key);
    const op: PendingOp = { ...meta, key, type: spec.type, url: spec.url, body, createdAt: new Date().toISOString() };
    pendingRef.current = op;
    setClaimedKey(key);
    await send(op);
  }, [spec, send]);

  /** 按原内容、原编号重新提交 */
  const retry = useCallback(async () => {
    if (pendingRef.current) await send(pendingRef.current);
  }, [send]);

  /** 只读查回：查不到只代表此刻还没有已提交的结果 */
  const check = useCallback(async () => {
    const op = pendingRef.current;
    const key = op?.key ?? keyRef.current;
    setState({ status: 'checking' });
    try {
      const found = await api.get<OperationLookup>(`/api/operations/${key}?type=${op?.type ?? spec.type}`);
      if (found.found) {
        const { found: _found, ...result } = found;
        succeed(key, result, true);
      } else if (found.abandoned && op) {
        // 已经确认作废（例如作废的答复在网络中丢失，或在另一个页面处理过）
        voided(op);
      } else {
        setState({ status: 'not_found' });
      }
    } catch (error) {
      // 查询失败不说明原操作的结果，仍按待确认处理
      setState({ status: 'uncertain', reason: uncertainReason(error) });
    }
  }, [succeed, voided, spec.type]);

  /** 接手一笔之前留下的待确认操作，并立即查询结果 */
  const adopt = useCallback(
    (op: PendingOp) => {
      keyRef.current = op.key;
      pendingRef.current = op;
      unsettledRef.current.add(op.key);
      setAdopted(op);
      setClaimedKey(op.key);
      void check();
    },
    [check],
  );

  /** 员工确认作废原操作：服务端登记作废后才删除记录、开始新的一笔；原操作其实已经入账时显示入账结果 */
  const discard = useCallback(async () => {
    const op = pendingRef.current;
    if (!op) return reset();
    setState({ status: 'abandoning' });
    try {
      const res = await abandonOnServer(op);
      if (res.found) {
        const { found: _found, ...result } = res;
        succeed(op.key, result, true);
        toast({ tone: 'info', title: `这笔${PENDING_LABELS[op.type]}已经入账，不能作废`, body: '已显示第一次提交的结果，没有重复入账。' });
      } else if (res.abandoned) {
        voided(op);
      } else {
        setState({ status: 'not_found' });
      }
    } catch (error) {
      // 作废没有完成：原操作仍待确认
      setState({ status: 'uncertain', reason: uncertainReason(error) });
    }
  }, [reset, succeed, voided, toast]);

  return { state, submit, retry, check, adopt, discard, reset, adopted, pending: pendingRef };
}

export const isLocked = (s: OperationState) =>
  s.status === 'uncertain' || s.status === 'checking' || s.status === 'not_found' || s.status === 'abandoning';
export const isBusy = (s: OperationState) => s.status === 'submitting' || s.status === 'checking' || s.status === 'abandoning';
