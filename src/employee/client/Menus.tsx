import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, CookingPot, Plus, RefreshCw, Utensils } from 'lucide-react';
import { CANTEEN_MEALS, CANTEEN_MEAL_LABELS, type CanteenEmployee, type CanteenMeal, type CanteenMenu, type CanteenMenuInput } from '@shared/canteen';
import { chinaDate, employeeApi, errorMessage, timeOf } from './api';
import { PendingActions, usePendingWrite } from './pending';

export function Menus({ employee, manage = false }: { employee: CanteenEmployee; manage?: boolean }) {
  const [date, setDate] = useState(chinaDate);
  const [menus, setMenus] = useState<CanteenMenu[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CanteenMenuInput | null>(null);
  const [notice, setNotice] = useState('');
  const fetchSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++fetchSequence.current;
    setLoading(true); setError('');
    try { const result = await employeeApi<{ menus: CanteenMenu[] }>(`/menus?date=${date}`); if (sequence === fetchSequence.current) setMenus(result.menus); }
    catch (failure) { if (sequence === fetchSequence.current) { setMenus([]); setError(errorMessage(failure)); } }
    finally { if (sequence === fetchSequence.current) setLoading(false); }
  }, [date]);
  useEffect(() => { void refresh(); return () => { fetchSequence.current += 1; }; }, [refresh]);
  const writer = usePendingWrite<CanteenMenuInput, { menu: CanteenMenu }>(employee.id, 'menu', '/menus', menu => ({ menu }), ({ menu }) => {
    setEditing(null); setNotice(menu.published ? '菜单已发布，员工可以查看了。' : '草稿已保存。'); void refresh();
  });
  const showEditor = manage && employee.role !== 'employee';
  function create(meal: CanteenMeal = 'lunch') {
    if (writer.pending) return;
    setNotice('');
    setEditing({ id: crypto.randomUUID(), date, meal, title: '', dishes: [], notes: '', published: true, version: 0 });
  }
  return <div className="page-stack">
    <section className="welcome">
      <span className="eyebrow">{showEditor ? '厨房工作台' : '好好吃饭，好好工作'}</span>
      <h1>{showEditor ? '准备今天的好味道' : '今天吃什么'}</h1>
      <p>{showEditor ? '发布后，大家的手机上就能看到。' : `${employee.name}，欢迎来到员工食堂。`}</p>
      <div className="welcome-symbol" aria-hidden="true"><CookingPot size={62} strokeWidth={1.2} /></div>
    </section>
    <div className="date-row">
      <label className="date-label">菜单日期<input aria-label="菜单日期" type="date" value={date} onChange={event => { setDate(event.target.value || chinaDate()); setEditing(null); }} /></label>
      <button className="icon-button secondary" aria-label="刷新菜单" onClick={() => void refresh()} disabled={loading}><RefreshCw size={18} /></button>
    </div>
    {showEditor && <><PendingActions {...writer} />{notice && <p className="message success" role="status">{notice}</p>}</>}
    {error && <p className="message error" role="alert">{error}</p>}
    {loading ? <p className="muted" role="status">正在查看厨房的最新安排…</p> : CANTEEN_MEALS.map(meal => {
      const list = menus.filter(menu => menu.meal === meal && (showEditor || menu.published));
      return <section key={meal} className="meal-section" aria-label={CANTEEN_MEAL_LABELS[meal]}>
        <div className="section-heading"><h2>{CANTEEN_MEAL_LABELS[meal]}</h2>{showEditor && <button type="button" className="text-button" disabled={Boolean(writer.pending) || writer.busy} onClick={() => create(meal)}><Plus size={16} />新增</button>}</div>
        {list.length ? list.map(menu => <article className="menu-card" key={menu.id}>
          <div className="menu-top"><span className="meal-mark"><Utensils size={19} aria-hidden="true" /></span><div><h3>{menu.title}</h3><span className="meta">{menu.published ? '已发布' : '草稿 · 仅厨房可见'} · {timeOf(menu.updatedAt)} 更新</span></div></div>
          <ul className="dishes">{menu.dishes.map((dish, i) => <li key={`${i}-${dish}`}><span className="dish-dot" />{dish}</li>)}</ul>
          {menu.notes && <p className="menu-notes">{menu.notes}</p>}
          {showEditor && <button type="button" className="menu-edit text-button" disabled={Boolean(writer.pending) || writer.busy} onClick={() => { setNotice(''); setEditing({ id: menu.id, date: menu.date, meal: menu.meal, title: menu.title, dishes: menu.dishes, notes: menu.notes, published: menu.published, version: menu.version }); }}>编辑菜单<ChevronRight size={17} /></button>}
        </article>) : <div className="empty-meal"><span>{error ? '暂时无法读取菜单' : '菜单还在准备中'}</span><p>{showEditor ? '安排好菜品，就可以发布给大家。' : '稍后再来看看，或向食堂负责人了解。'}</p></div>}
      </section>;
    })}
    {editing && <MenuEditor key={editing.id} menu={editing} disabled={Boolean(writer.pending) || writer.busy || writer.blocked} close={() => setEditing(null)} save={value => writer.begin(value)} />}
  </div>;
}

function MenuEditor({ menu, disabled, close, save }: { menu: CanteenMenuInput; disabled: boolean; close: () => void; save: (menu: CanteenMenuInput) => Promise<void> }) {
  const [value, setValue] = useState(menu);
  const [dishes, setDishes] = useState(menu.dishes.join('\n'));
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const list = dishes.split('\n').map(dish => dish.trim()).filter(Boolean);
    if (!list.length) { setError('请至少填写一道菜，每行一道。'); return; }
    if (list.length > 30) { setError('每份菜单最多 30 道菜。'); return; }
    if (list.some(dish => dish.length > 80)) { setError('每道菜的名称和说明最多 80 个字。'); return; }
    setError(''); void save({ ...value, title: value.title.trim(), dishes: list, notes: value.notes.trim() });
  }
  return <section className="editor" aria-label="编辑菜单">
    <div className="section-heading"><h2>{menu.version ? '编辑菜单' : '新建菜单'}</h2><button type="button" className="text-button" onClick={close} disabled={disabled}>收起</button></div>
    <form onSubmit={submit} className="form-stack">
      <fieldset disabled={disabled} className="form-stack">
        <div className="field-grid"><label>日期<input type="date" value={value.date} onChange={event => setValue({ ...value, date: event.target.value })} required /></label><label>餐次<select value={value.meal} onChange={event => setValue({ ...value, meal: event.target.value as CanteenMeal })}>{CANTEEN_MEALS.map(meal => <option key={meal} value={meal}>{CANTEEN_MEAL_LABELS[meal]}</option>)}</select></label></div>
        <label>菜单标题<input autoFocus value={value.title} maxLength={80} required placeholder="例如：周五暖心午餐" onChange={event => setValue({ ...value, title: event.target.value })} /></label>
        <label>菜品 · 每行一道<textarea rows={5} required value={dishes} maxLength={2430} onChange={event => setDishes(event.target.value)} placeholder={'香菇滑鸡\n清炒时蔬\n冬瓜排骨汤'} /><span className="meta">最多 30 道，每道最多 80 个字。</span></label>
        <label>供餐说明<textarea rows={3} value={value.notes} maxLength={500} onChange={event => setValue({ ...value, notes: event.target.value })} placeholder="供餐时间、辣度、过敏原提示等" /></label>
        <label className="check-label"><input type="checkbox" checked={value.published} onChange={event => setValue({ ...value, published: event.target.checked })} />发布给员工查看</label>
        <button type="submit">{value.published ? '保存并发布菜单' : '保存草稿'}</button>
      </fieldset>
      {error && <p className="message error" role="alert">{error}</p>}
      {menu.version > 0 && <p className="meta">正在编辑第 {menu.version} 版；其他人修改后，需要刷新再编辑。</p>}
    </form>
  </section>;
}
