import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import type { CanteenCheckin } from '@shared/canteen';
import { chinaDate, employeeApi, errorMessage, timeOf } from './api';

export function Checkins({ manager = false, revision = 0 }: { manager?: boolean; revision?: number }) {
  const [date, setDate] = useState(chinaDate);
  const [records, setRecords] = useState<CanteenCheckin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fetchSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++fetchSequence.current;
    setLoading(true); setError('');
    try { const result = await employeeApi<{ checkins: CanteenCheckin[] }>(`/checkins?date=${date}`); if (sequence === fetchSequence.current) setRecords(result.checkins); }
    catch (failure) { if (sequence === fetchSequence.current) { setRecords([]); setError(errorMessage(failure)); } }
    finally { if (sequence === fetchSequence.current) setLoading(false); }
  }, [date]);
  useEffect(() => { void refresh(); return () => { fetchSequence.current += 1; }; }, [refresh, revision]);
  return <section className="page-stack" aria-label="食堂打卡记录">
    <div className="section-heading"><h2>{manager ? '食堂打卡记录' : '我的打卡记录'}</h2><button type="button" className="icon-button secondary" aria-label="刷新打卡记录" disabled={loading} onClick={() => void refresh()}><RefreshCw size={17} /></button></div>
    <label className="date-label">打卡日期<input type="date" aria-label="打卡日期" value={date} onChange={event => setDate(event.target.value || chinaDate())} /></label>
    {error && <p className="message error" role="alert">{error}</p>}
    {loading ? <p role="status" className="muted">正在读取记录…</p> : records.length ? <ol className="checkin-list">{records.map(record => <li key={record.id} data-testid="checkin-record"><span className="checkin-icon"><Check size={17} /></span><div><strong>{record.name} <span className="meta">{record.employeeNo}</span></strong><p>{record.departmentName} · 核验人 {record.scannerName}</p></div><time dateTime={record.checkedAt}>{timeOf(record.checkedAt)}</time></li>)}</ol> : <p className="empty-meal">{error ? '暂时无法读取记录' : '这一天暂无已确认的打卡记录。'}</p>}
    <p className="meta">显示服务器已确认的记录。待确认请求请先查回，避免重复登记。</p>
  </section>;
}
