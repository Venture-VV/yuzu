import { useRef, useState } from 'react';
import { clearPending, employeeApi, errorMessage, isUncertain, readPending, storePending, type PendingWrite } from './api';

interface Operation<R> { status: 'completed' | 'abandoned' | 'unknown'; kind: string | null; result?: R }
export function usePendingWrite<T, R>(employeeId: string, kind: 'menu' | 'checkin', path: string, body: (value: T) => object, done: (result: R) => void) {
  const key = `yuzu-employee:${employeeId}:${kind}:pending`;
  const [initial] = useState(() => {
    try { return { pending: readPending<T>(key), error: '' }; }
    catch (error) { return { pending: null, error: errorMessage(error) }; }
  });
  const [pending, setPending] = useState<PendingWrite<T> | null>(initial.pending);
  const pendingRef = useRef(pending);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  function update(value: PendingWrite<T> | null) { pendingRef.current = value; setPending(value); }
  function finish(result?: R) {
    clearPending(key); update(null); setError(''); setNotice('');
    if (result !== undefined) done(result);
  }
  async function send(value: PendingWrite<T>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await employeeApi<R>(path, { ...body(value.value), requestId: value.requestId });
      finish(result);
    } catch (failure) {
      const uncertain = value.uncertain || isUncertain(failure);
      if (uncertain) {
        const next = { ...value, uncertain: true };
        update(next);
        try { storePending(key, next); } catch { /* 发送前的原请求仍在存储；恢复时本来就按不确定处理。 */ }
        setError(`${errorMessage(failure)}。本次结果待确认，请查回或原样重试。`);
      } else {
        try { finish(); } catch (storageError) { setError(errorMessage(storageError)); }
        setError(errorMessage(failure));
      }
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function begin(value: T) {
    if (pendingRef.current || busyRef.current || initial.error) return;
    const next: PendingWrite<T> = { requestId: crypto.randomUUID(), value, uncertain: false };
    try { storePending(key, next); } catch (failure) { setError(errorMessage(failure)); return; }
    update(next); await send(next);
  }
  async function resolve(abandon: boolean) {
    const current = pendingRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await employeeApi<Operation<R>>(`/operations/${current.requestId}${abandon ? '/abandon' : ''}`, abandon ? { kind } : undefined);
      if (result.status === 'completed' && result.result !== undefined) finish(result.result);
      else if (result.status === 'abandoned') { finish(); setNotice('本次请求已确认作废，可以重新操作。'); }
      else setNotice('暂未查到确认结果；这不代表没有生效。请原样重试，或由服务器确认作废本次请求。');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return { pending, busy, error, notice, blocked: Boolean(initial.error), begin, retry: () => pendingRef.current ? send({ ...pendingRef.current, uncertain: true }) : Promise.resolve(), resolve };
}

export function PendingActions({ pending, busy, error, notice, retry, resolve }: {
  pending: PendingWrite<unknown> | null; busy: boolean; error: string; notice: string;
  retry: () => Promise<void>; resolve: (abandon: boolean) => Promise<void>;
}) {
  return <>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    {pending && <section className="pending-box" aria-label="结果待确认">
      <strong>{busy ? '正在等待服务器确认' : '这次操作还没有完成确认'}</strong>
      <p>请先处理这一笔，再开始下一次操作。</p>
      <div className="button-row">
        <button type="button" className="secondary" disabled={busy} onClick={() => void resolve(false)}>核对结果</button>
        <button type="button" disabled={busy} onClick={() => void retry()}>原样重试</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void resolve(true)}>确认作废本次请求</button>
      </div>
    </section>}
  </>;
}
