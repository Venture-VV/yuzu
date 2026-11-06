import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ChefHat, ClipboardList, KeyRound, LogOut, QrCode, ScanLine, ShieldCheck, UserRound, Utensils, WifiOff } from 'lucide-react';
import type { CanteenSession } from '@shared/canteen';
import { EmployeeApiError, employeeApi, errorMessage, setEmployeeIdentity, useOnline } from './api';
import { Menus } from './Menus';
import { EmployeeCode } from './EmployeeCode';
import { Scanner } from './Scanner';
import { Checkins } from './Checkins';

type Tab = 'menus' | 'code' | 'profile' | 'manage' | 'scan' | 'password';
interface Health { instance: string; version: string; commit: string }
const roleLabel = { employee: '员工', chef: '食堂厨师', manager: '食堂负责人' };
const instanceLabel: Record<string, string> = { demo: '合成测试', test: '测试环境', development: '开发环境', prod: '正式环境', production: '正式环境', shadow: '影子环境' };

export function App() {
  const [session, setSession] = useState<CanteenSession | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('menus');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const online = useOnline();
  const refreshSession = useCallback(async () => {
    try {
      const next = await employeeApi<CanteenSession>('/session');
      setEmployeeIdentity(next.employee.id); setSession(next); setHealth(next); setError('');
      return next;
    } catch (failure) {
      if (failure instanceof EmployeeApiError && failure.status === 401) { setEmployeeIdentity(null); setSession(null); setTab('menus'); }
      else setError(errorMessage(failure));
      return null;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refreshSession();
    void fetch('/api/health', { cache: 'no-store' }).then(async response => {
      if (response.ok) { const value = await response.json() as Health; setHealth(value); }
    }).catch(() => {});
    const timer = window.setInterval(() => { if (!document.hidden && navigator.onLine) void refreshSession(); }, 60_000);
    return () => clearInterval(timer);
  }, [refreshSession]);
  function navigate(next: Tab) { setTab(next); window.scrollTo({ top: 0, behavior: 'instant' }); }
  async function logout() {
    setLogoutBusy(true); setError('');
    try { await employeeApi('/logout', {}); setEmployeeIdentity(null); setSession(null); navigate('menus'); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLogoutBusy(false); }
  }
  const changeRequired = session?.employee.mustChangePassword;
  return <div className="app-shell">
    <header className="app-header">
      <a href="/" className="brand" aria-label="YuZu 员工食堂首页"><img src="/icon.svg" alt="" /><span>YuZu <span className="brand-caption">员工食堂</span></span></a>
      <span className="instance" title={health?.commit ?? ''}>{health ? `${instanceLabel[health.instance] ?? health.instance} · v${health.version}` : '正在连接员工服务'}</span>
    </header>
    <div className="version-line">{health?.commit ? `版本标识 ${health.commit.slice(0, 12)}` : '版本信息待确认'}</div>
    {!online && <div className="offline-banner" role="status"><WifiOff size={16} />当前离线，菜单更新和扫码核验需要网络。</div>}
    <main className="main-content">
      {error && <p className="message error" role="alert">{error}</p>}
      {loading ? <div className="loading-page" role="status">正在连接员工食堂…</div> : !session ? <Login onLogin={value => { setEmployeeIdentity(value.employee.id); setSession(value); setHealth(value); setError(''); navigate('menus'); }} /> : <div key={session.employee.id}>
        {changeRequired || tab === 'password' ? <Password required={Boolean(changeRequired)} complete={async () => { const next = await refreshSession(); if (next) navigate('profile'); }} back={() => navigate('profile')} /> : <>
          {tab === 'menus' && <Menus employee={session.employee} />}
          {tab === 'code' && <EmployeeCode employee={session.employee} />}
          {tab === 'profile' && <div className="page-stack">
            <div className="page-heading"><span className="eyebrow">我的 YuZu</span><h1>{session.employee.name}</h1><p>工号 {session.employee.employeeNo} · {session.employee.departmentName}</p><span className="role-badge">{roleLabel[session.employee.role]}</span></div>
            {session.employee.role !== 'employee' && <div className="management-links">
              <button className="management-link" onClick={() => navigate('manage')}><ChefHat size={24} /><span><strong>菜单管理</strong><small>编辑、保存草稿与发布每日菜单</small></span><ArrowRight size={19} /></button>
              {session.employee.role === 'manager' && <button className="management-link" onClick={() => navigate('scan')}><ScanLine size={24} /><span><strong>负责人扫码打卡</strong><small>核验动态员工码，查看食堂记录</small></span><ArrowRight size={19} /></button>}
            </div>}
            <Checkins />
            <div className="profile-actions"><button type="button" className="secondary" onClick={() => navigate('password')}><KeyRound size={18} />修改密码</button><button type="button" className="text-button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={18} />退出登录</button></div>
            <details className="install-help"><summary>把员工食堂添加到手机桌面</summary><p>iPhone：用 Safari 打开，点分享，再选「添加到主屏幕」。安卓：在支持安装的浏览器菜单中选择「安装应用」或「添加到主屏幕」。</p><p>菜单和打卡需要网络；退出登录不会删除仍待确认的操作，再次登录可继续核对。</p></details>
          </div>}
          {tab === 'manage' && session.employee.role !== 'employee' && <><button className="back-button text-button" onClick={() => navigate('profile')}><ArrowLeft size={17} />返回我的</button><Menus employee={session.employee} manage /></>}
          {tab === 'scan' && session.employee.role === 'manager' && <><button className="back-button text-button" onClick={() => navigate('profile')}><ArrowLeft size={17} />返回我的</button><Scanner employee={session.employee} /></>}
          {((tab === 'manage' && session.employee.role === 'employee') || (tab === 'scan' && session.employee.role !== 'manager')) && <p className="message error" role="alert">你的权限已更新，请返回菜单或个人页面。</p>}
        </>}
      </div>}
    </main>
    {session && !changeRequired && <nav className="bottom-nav" aria-label="员工导航">
      <button className={tab === 'menus' ? 'active' : ''} aria-current={tab === 'menus' ? 'page' : undefined} onClick={() => navigate('menus')}><Utensils size={21} /><span>今日菜单</span></button>
      <button className={tab === 'code' ? 'active' : ''} aria-current={tab === 'code' ? 'page' : undefined} onClick={() => navigate('code')}><QrCode size={21} /><span>员工码</span></button>
      <button className={['profile', 'manage', 'scan', 'password'].includes(tab) ? 'active' : ''} aria-current={['profile', 'manage', 'scan', 'password'].includes(tab) ? 'page' : undefined} onClick={() => navigate('profile')}><UserRound size={21} /><span>我的</span></button>
    </nav>}
  </div>;
}

function Login({ onLogin }: { onLogin: (session: CanteenSession) => void }) {
  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin(await employeeApi<CanteenSession>('/login', { employeeNo: employeeNo.trim(), password })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <div className="login-page">
    <div className="login-intro"><span className="eyebrow">YUZU STAFF</span><h1>这一餐，<br />一起好好吃。</h1><p>看看今日菜单，带上员工码，<br />来食堂享用一顿热乎饭。</p><div className="login-illustration" aria-hidden="true"><Utensils size={58} strokeWidth={1.4} /><span /></div></div>
    <form className="login-form form-stack" onSubmit={submit}>
      <h2>员工登录</h2><label>工号<input name="employeeNo" autoComplete="username" value={employeeNo} maxLength={40} onChange={event => setEmployeeNo(event.target.value)} required placeholder="请输入你的工号" /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" value={password} maxLength={72} onChange={event => setPassword(event.target.value)} required placeholder="请输入员工端密码" /></label>
      {error && <p className="message error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? '正在登录…' : '登录员工食堂'}<ArrowRight size={18} /></button>
      <p className="meta">账号由公司统一开通。忘记密码，请联系管理员重置。</p>
    </form>
    <div className="login-features"><span><Utensils size={16} />每日菜单</span><span><QrCode size={16} />动态员工码</span><span><ClipboardList size={16} />打卡记录</span></div>
  </div>;
}

function Password({ required, complete, back }: { required: boolean; complete: () => Promise<void>; back: () => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (newPassword !== confirm) { setError('两次新密码不一致，请重新输入。'); return; }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) { setError('新密码至少 8 位，并同时包含字母和数字。'); return; }
    setBusy(true);
    try { await employeeApi('/password', { oldPassword, newPassword }); await complete(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <div className="page-stack">
    {!required && <button className="text-button back-button" onClick={back}><ArrowLeft size={17} />返回我的</button>}
    <div className="page-heading"><ShieldCheck size={34} className="heading-icon" /><h1>{required ? '先设置你的密码' : '修改密码'}</h1><p>{required ? '首次登录请更换临时密码，再进入员工食堂。' : '员工端密码独立使用，请妥善保管。'}</p></div>
    <form onSubmit={submit} className="form-stack login-form">
      <label>{required ? '临时密码' : '当前密码'}<input type="password" autoComplete="current-password" required maxLength={72} value={oldPassword} onChange={event => setOldPassword(event.target.value)} /></label>
      <label>新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
      <label>确认新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
      <p className="meta">至少 8 位，同时包含字母和数字。</p>
      {error && <p role="alert" className="message error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</button>
    </form>
  </div>;
}
