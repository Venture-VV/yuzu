import { useRef, useState } from 'react';
import { api, ApiError, errorMessage, request } from '../../lib/api';
import { useSession } from '../../lib/session';
import { uuid } from '../../lib/utils';

interface PendingOperation {
  label: string;
  method: 'POST' | 'PUT';
  url: string;
  body: Record<string, unknown>;
  uncertain: boolean;
}

/** 请求先落本机再发送；恢复时原样重试。这里只保存请求，不保存返回的临时密码。 */
export function useCanteenOperation(onDone: (result: unknown, label: string) => Promise<void>) {
  const { staff } = useSession();
  const key = `yuzu.canteenPending.v1.${staff.id}`;
  const [pending, setPending] = useState<PendingOperation | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      const value = raw ? JSON.parse(raw) as PendingOperation : null;
      if (value && ['POST', 'PUT'].includes(value.method) && value.url.startsWith('/api/erp/canteen/') && value.body && typeof value.label === 'string') {
        return { ...value, uncertain: true };
      }
      return null;
    } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);

  function persist(value: PendingOperation | null) {
    const raw = value ? JSON.stringify(value) : null;
    try {
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw new Error('storage');
    } catch {
      throw new Error('浏览器无法保存待确认请求，本次没有发送。请允许本地存储后重试。');
    }
    setPending(value);
  }

  async function send(operation: PendingOperation, retry = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    let result: unknown;
    try { persist(operation); }
    catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      inFlight.current = false;
      return;
    }
    try {
      result = await request(operation.method, operation.url, operation.body, { timeoutMs: 25_000 });
    } catch (err) {
      // 原请求尚可能在执行时，重试的权限/来源/状态错误不能证明原请求未成功。
      if (!retry && err instanceof ApiError && err.status < 500) {
        try { persist(null); } catch { /* 原请求已明确被拒，本页不再把它作为待确认。 */ setPending(null); }
      } else {
        const uncertain = { ...operation, uncertain: true };
        try { persist(uncertain); } catch { setPending(uncertain); }
      }
      setError(errorMessage(err));
      setBusy(false);
      inFlight.current = false;
      return;
    }
    // 服务端已返回成功。清理失败保留原请求，安全重放仍能取回相同结果。
    try { persist(null); } catch { setPending({ ...operation, uncertain: true }); }
    try { await onDone(result, operation.label); }
    catch (err) { setError(`操作已成功，列表刷新失败：${errorMessage(err)}`); }
    setBusy(false);
    inFlight.current = false;
  }

  const kind = pending?.method !== 'POST' ? null
    : pending.url === '/api/erp/canteen/employees' ? 'employee_create'
      : pending.url.endsWith('/reset-password') ? 'password_reset'
        : pending.url === '/api/erp/canteen/menus' ? 'menu' : null;

  async function abandon() {
    if (!pending || !kind || typeof pending.body.requestId !== 'string' || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.post<{ status: 'completed' | 'abandoned' }>(`/api/erp/canteen/operations/${pending.body.requestId}/abandon`, { kind });
      if (result.status === 'abandoned') {
        persist(null);
        setMessage('原操作已确认作废，可以重新填写。');
      } else {
        setMessage('原操作已经成功，请按原内容重新提交以取回完整回执。');
      }
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); inFlight.current = false; }
  }

  return {
    pending, busy, error, message, canAbandon: !!kind,
    abandon,
    clearError: () => setError(''),
    submit: (label: string, method: 'POST' | 'PUT', url: string, body: Record<string, unknown>, withRequestId = true) => {
      if (pending || inFlight.current) { setError('请先按原内容重新提交上一次待确认操作。'); return Promise.resolve(); }
      // 同源的另一个标签页可能刚发出请求；先认领已有待确认项，不能覆盖其原编号。
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const previous = JSON.parse(raw) as PendingOperation;
          if (!previous || !['POST', 'PUT'].includes(previous.method) || !previous.url.startsWith('/api/erp/canteen/') || !previous.body) throw new Error('待确认记录损坏，无法安全提交，请先恢复本地记录。');
          setPending({ ...previous, uncertain: true });
          setError('另一页面有待确认操作，请先取回结果。');
          return Promise.resolve();
        }
      } catch (err) { setError(errorMessage(err)); return Promise.resolve(); }
      return send({ label, method, url, body: withRequestId ? { ...body, requestId: uuid() } : body, uncertain: false });
    },
    retry: () => pending ? send(pending, true) : Promise.resolve(),
  };
}
