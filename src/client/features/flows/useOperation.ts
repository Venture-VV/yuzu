import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OperationLookup, OperationResult } from '@shared/types';
import { api, ApiError, UncertainError } from '../../lib/api';
import { removePending, savePending, setClaimed, setInFlight, type PendingOp, type PendingType } from '../../lib/pendingOps';
import { uuid } from '../../lib/utils';

export type OperationState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; result: OperationResult; recovered: boolean }
  | { status: 'error'; error: ApiError }
  | { status: 'uncertain'; reason: 'timeout' | 'network' | 'server' }
  | { status: 'checking' }
  | { status: 'not_found' };

export interface OperationSpec {
  type: PendingType;
  url: string;
  /** 由当前表单生成请求体，以及待确认时展示用的信息 */
  build: (idempotencyKey: string) => { body: unknown; meta: Omit<PendingOp, 'key' | 'type' | 'url' | 'body' | 'createdAt'> };
}

/**
 * 记账操作的提交状态机。
 * - 每次进入「核对」步骤生成新的操作编号；重试与查询都沿用同一个编号，服务端保证不会重复记账。
 * - 提交前把编号和原请求存到本机（pendingOps）；超时 / 断网 / 服务器异常时保留，面板关闭或刷新后仍可查回。
 * - 查不到时由员工选择：按原内容重新提交（同一编号，安全），或明确放弃后再开一笔新的。
 */
export function useOperation(spec: OperationSpec) {
  const qc = useQueryClient();
  const keyRef = useRef(uuid());
  const pendingRef = useRef<PendingOp | null>(null);
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

  const send = useCallback(
    async (op: PendingOp) => {
      setState({ status: 'submitting' });
      savePending(op);
      setInFlight(op.key, true);
      try {
        const result = await api.post<OperationResult>(op.url, op.body);
        removePending(op.key);
        setState({ status: 'success', result, recovered: result.replayed });
        refreshAfter(result);
      } catch (error) {
        if (error instanceof UncertainError) {
          setState({ status: 'uncertain', reason: error.reason });
        } else if (error instanceof ApiError && error.status >= 500) {
          // 服务器异常时无法确定是否已入账（例如入账后读取结果失败），按待确认处理
          setState({ status: 'uncertain', reason: 'server' });
        } else if (error instanceof ApiError) {
          // 服务端明确拒绝：没有入账
          removePending(op.key);
          setState({ status: 'error', error });
        } else {
          setState({ status: 'uncertain', reason: 'network' });
        }
      } finally {
        setInFlight(op.key, false);
      }
    },
    [refreshAfter],
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

  const check = useCallback(async (): Promise<'found' | 'not_found' | 'unknown'> => {
    const key = pendingRef.current?.key ?? keyRef.current;
    setState({ status: 'checking' });
    try {
      const found = await api.get<OperationLookup>(`/api/operations/${key}`);
      if (found.found) {
        const { found: _found, ...result } = found;
        removePending(key);
        setState({ status: 'success', result, recovered: true });
        refreshAfter(result);
        return 'found';
      }
      setState({ status: 'not_found' });
      return 'not_found';
    } catch (error) {
      if (error instanceof UncertainError) setState({ status: 'uncertain', reason: error.reason });
      else if (error instanceof ApiError && error.status < 500) setState({ status: 'error', error });
      else setState({ status: 'uncertain', reason: 'server' });
      return 'unknown';
    }
  }, [refreshAfter]);

  /** 接手一笔之前留下的待确认操作，并立即查询结果 */
  const adopt = useCallback(
    (op: PendingOp) => {
      keyRef.current = op.key;
      pendingRef.current = op;
      setAdopted(op);
      setClaimedKey(op.key);
      void check();
    },
    [check],
  );

  /** 内容变化（返回修改、再登记一笔）时换一个新编号；不会删除未确认的记录 */
  const reset = useCallback(() => {
    keyRef.current = uuid();
    pendingRef.current = null;
    setAdopted(null);
    setClaimedKey(null);
    setState({ status: 'idle' });
  }, []);

  /** 员工明确放弃原操作：再查一次确认没有入账，然后删除记录、开始新的一笔 */
  const discard = useCallback(async () => {
    const op = pendingRef.current;
    if (!op) return reset();
    const outcome = await check();
    if (outcome === 'not_found') {
      removePending(op.key);
      reset();
    }
  }, [check, reset]);

  return { state, submit, retry, check, adopt, discard, reset, adopted, pending: pendingRef };
}

export const isLocked = (s: OperationState) => s.status === 'uncertain' || s.status === 'checking' || s.status === 'not_found';
export const isBusy = (s: OperationState) => s.status === 'submitting' || s.status === 'checking';
