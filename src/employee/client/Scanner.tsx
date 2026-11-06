import { useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { Camera, CheckCircle2, ImagePlus, ScanLine, Square } from 'lucide-react';
import type { CanteenCheckin, CanteenEmployee } from '@shared/canteen';
import { errorMessage, timeOf, useOnline } from './api';
import { PendingActions, usePendingWrite } from './pending';
import { Checkins } from './Checkins';

export function Scanner({ employee }: { employee: CanteenEmployee }) {
  const online = useOnline();
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const decodingRef = useRef(false);
  const captureBusy = useRef(false);
  const [camera, setCamera] = useState(false);
  const [opening, setOpening] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState<CanteenCheckin | null>(null);
  const [revision, setRevision] = useState(0);
  const writer = usePendingWrite<string, { checkin: CanteenCheckin; replayed: boolean }>(employee.id, 'checkin', '/checkins', code => ({ code }), result => {
    setLast(result.checkin); setRevision(value => value + 1);
  });
  function stopTracks() {
    generation.current += 1;
    controls.current?.stop(); controls.current = null;
    const stream = video.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop());
    if (video.current) video.current.srcObject = null;
  }
  function stop() { stopTracks(); setCamera(false); setOpening(false); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopTracks(); }; }, []);
  useEffect(() => { if (!online) stop(); }, [online]);
  async function consume(text: string) {
    if (!mounted.current || captureBusy.current || writer.pending || writer.busy) return;
    captureBusy.current = true; stop(); setError(''); setLast(null);
    try {
      if (!/^yuzu-employee:[A-Za-z0-9_-]+$/.test(text)) { setError('这不是有效的 YuZu 员工码，请员工打开「我的员工码」。'); return; }
      if (!navigator.onLine) { setError('当前没有网络，尚未发送打卡请求。请联网后重新扫描。'); return; }
      await writer.begin(text);
    } finally { captureBusy.current = false; }
  }
  async function start() {
    if (!mounted.current || !online || writer.pending || writer.busy || opening) return;
    setError(''); setLast(null); setOpening(true);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('摄像头需要 HTTPS 连接。请使用安全的员工入口，或选择员工码图片。'); setOpening(false); return;
    }
    stopTracks(); const current = generation.current;
    try {
      if (!video.current) throw new Error('摄像头预览尚未准备好');
      const reader = new BrowserQRCodeReader();
      const handle = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }, video.current, result => {
        if (mounted.current && current === generation.current && result) void consume(result.getText());
      });
      if (!mounted.current || current !== generation.current) { handle.stop(); return; }
      controls.current = handle; setCamera(true);
    } catch (failure) {
      if (!mounted.current || current !== generation.current) return;
      stopTracks(); setCamera(false);
      const name = failure instanceof Error ? failure.name : '';
      setError(name === 'NotAllowedError' ? '摄像头权限未开启，请在浏览器设置中允许相机后重试。' : name === 'NotFoundError' ? '没有找到可用摄像头，可以选择员工码图片核验。' : `无法打开摄像头：${errorMessage(failure)}`);
    } finally { if (mounted.current) setOpening(false); }
  }
  async function fromFile(file?: File) {
    if (!mounted.current || !file || writer.pending || writer.busy || decodingRef.current) return;
    setError(''); stop(); const current = generation.current; decodingRef.current = true; setDecoding(true);
    if (file.size > 15 * 1024 * 1024) { setError('图片不能超过 15 MB'); decodingRef.current = false; setDecoding(false); return; }
    const url = URL.createObjectURL(file);
    try { const result = await new BrowserQRCodeReader().decodeFromImageUrl(url); if (mounted.current && current === generation.current) await consume(result.getText()); }
    catch { if (mounted.current && current === generation.current) setError('没有识别到二维码，请选择清晰、完整的员工码图片。'); }
    finally { URL.revokeObjectURL(url); decodingRef.current = false; if (mounted.current) setDecoding(false); }
  }
  const disabled = !online || Boolean(writer.pending) || writer.busy || writer.blocked || decoding;
  return <div className="page-stack">
    <div className="page-heading"><span className="eyebrow">食堂负责人</span><h1>扫码打卡</h1><p>扫描员工动态码，核对姓名与工号。</p></div>
    <div className={`camera-frame ${camera ? 'is-live' : ''}`}>
      <video ref={video} autoPlay playsInline muted aria-label="员工码扫描摄像头" />
      {!camera && <div className="camera-placeholder"><ScanLine size={58} strokeWidth={1.2} /><span>{opening ? '正在打开摄像头…' : '将员工码放入取景框'}</span></div>}
      <div className="scan-corners" aria-hidden="true" />
    </div>
    <div className="button-row">
      {camera || opening ? <button type="button" className="secondary" onClick={stop}><Square size={16} />停止扫描</button> : <button type="button" disabled={disabled} onClick={() => void start()}><Camera size={18} />{last ? '扫描下一位' : '打开摄像头'}</button>}
      <label className={`file-button secondary ${disabled ? 'disabled' : ''}`}><ImagePlus size={18} />{decoding ? '正在识别…' : '选择员工码图片'}<input type="file" accept="image/*" aria-label="选择员工码图片" disabled={disabled} onChange={event => { void fromFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
    </div>
    {!online && <p className="message error" role="alert">网络已断开，无法核验或确认打卡。</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    <PendingActions {...writer} />
    {last && <section className="scan-success" role="status" data-testid="checkin-success"><CheckCircle2 size={30} /><div><strong>食堂打卡成功</strong><h2>{last.name} <span>{last.employeeNo}</span></h2><p>{last.departmentName} · {timeOf(last.checkedAt)}</p><p className="meta">服务器已确认 · 记录 #{last.id}</p></div></section>}
    <Checkins manager revision={revision} />
  </div>;
}
