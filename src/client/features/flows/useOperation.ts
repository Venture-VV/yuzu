import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OperationLookup, OperationResult } from '@shared/types';
import { api, ApiError, UncertainError } from '../../lib/api';
import { uuid } from '../../lib/utils';

export type OperationState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; result: OperationResult; recovered: boolean }
  | { status: 'error'; error: ApiError }
  | { status: 'uncertain'; reason: 'timeout' | 'network' }
  | { status: 'checking' }
  | { status: 'not_found' };

/**
 * 记账操作的提交状态机。
 * - 每次进入「核对」步骤生成新的操作编号；重试与查询都沿用同一个编号，服务端保证不会重复记账。
 * - 超时/断网时进入「结果待确认」，员工可以按编号查回结果，查不到再安全地重新提交。
 */
export function useOperation(submitFn: (idempotencyKey: string) => Promise<OperationResult>) {
  const qc = useQueryClient();
  const keyRef = useRef(uuid());
  const [state, setState] = useState<OperationState>({ status: 'idle' });

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

  const submit = useCallback(async () => {
    setState({ status: 'submitting' });
    try {
      const result = await submitFn(keyRef.current);
      setState({ status: 'success', result, recovered: result.replayed });
      refreshAfter(result);
    } catch (error) {
      if (error instanceof UncertainError) setState({ status: 'uncertain', reason: error.reason });
      else if (error instanceof ApiError) setState({ status: 'error', error });
      else setState({ status: 'error', error: new ApiError(0, 'UNKNOWN', '操作没有完成，请稍后重试') });
    }
  }, [submitFn, refreshAfter]);

  const check = useCallback(async () => {
    setState({ status: 'checking' });
    try {
      const found = await api.get<OperationLookup>(`/api/operations/${keyRef.current}`);
      if (found.found) {
        const { found: _found, ...result } = found;
        setState({ status: 'success', result, recovered: true });
        refreshAfter(result);
      } else {
        setState({ status: 'not_found' });
      }
    } catch (error) {
      if (error instanceof UncertainError) setState({ status: 'uncertain', reason: error.reason });
      else setState({ status: 'error', error: error as ApiError });
    }
  }, [refreshAfter]);

  /** 内容变化（返回修改）时换一个新编号 */
  const reset = useCallback(() => {
    keyRef.current = uuid();
    setState({ status: 'idle' });
  }, []);

  return { state, submit, check, reset, key: keyRef };
}
