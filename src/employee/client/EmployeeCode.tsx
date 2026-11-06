import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, RefreshCw, WifiOff } from 'lucide-react';
import type { CanteenCode, CanteenEmployee } from '@shared/canteen';
import { employeeApi, errorMessage, useOnline } from './api';

export function EmployeeCode({ employee }: { employee: CanteenEmployee }) {
  const online = useOnline();
  const [code, setCode] = useState<CanteenCode | null>(null);
  const [image, setImage] = useState('');
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (busy.current || !navigator.onLine) return;
    busy.current = true; setLoading(true); setError(''); setCode(null); setImage('');
    try {
      const next = await employeeApi<CanteenCode>('/code');
      const data = await QRCode.toDataURL(next.code, { width: 320, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#193e2f', light: '#ffffff' } });
      if (!mounted.current) return;
      setOffset(Date.parse(next.serverTime) - Date.now()); setNow(Date.now()); setCode(next); setImage(data);
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    const renew = window.setInterval(() => { if (!document.hidden) void refresh(); }, 45_000);
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('online', focus); document.addEventListener('visibilitychange', focus);
    return () => { mounted.current = false; clearInterval(ticker); clearInterval(renew); window.removeEventListener('online', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  const remaining = code ? Math.max(0, Math.ceil((Date.parse(code.expiresAt) - now - offset) / 1000)) : 0;
  const valid = online && code && image && remaining > 0;
  return <div className="page-stack">
    <div className="page-heading"><span className="eyebrow">食堂打卡</span><h1>我的员工码</h1><p>到食堂后，向负责人出示此码。</p></div>
    <section className="employee-pass" aria-label="我的员工码">
      <div className="pass-heading"><span className="brand-small">YUZU · 员工</span><QrCode size={22} aria-hidden="true" /></div>
      <h2>{employee.name}</h2><p className="pass-id">工号 {employee.employeeNo} · {employee.departmentName}</p>
      <div className="qr-frame">
        {valid ? <img src={image} alt="用于食堂核验的动态员工二维码" data-testid="employee-qr" /> : <div className="qr-placeholder">{online ? <QrCode size={48} /> : <WifiOff size={48} />}<span>{!online ? '网络已断开' : loading ? '正在获取员工码' : '暂时没有有效员工码'}</span></div>}
      </div>
      <p className="code-countdown" role="status">{valid ? `${remaining} 秒后过期 · 自动刷新` : online ? '请联网刷新后出示' : '联网后重新获取员工码'}</p>
      <button type="button" className="secondary" onClick={() => void refresh()} disabled={loading || !online}><RefreshCw size={17} />刷新员工码</button>
      <p className="meta pass-note">仅限本人使用。每个动态码只能成功核验一次。</p>
    </section>
    {error && <p className="message error" role="alert">{error}</p>}
  </div>;
}
