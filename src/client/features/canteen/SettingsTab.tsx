// 设置：食堂部门（厨师、负责人要在这个部门）、开饭时间（不能重叠）、员工入口地址（开通卡片的二维码用）。

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MEAL_EMOJI, MEAL_LABELS, type CanteenSettings, type MealWindow } from '@shared/canteen';
import { api, errorMessage } from '../../lib/api';
import { Button, Card, ConfirmCheck, Field, Input, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useOverview } from './CanteenPage';
import { useDepartments } from './RosterTab';

export function SettingsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const overview = useOverview();
  const departments = useDepartments();
  const [form, setForm] = useState<CanteenSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (overview.data && !form) setForm(overview.data.settings);
  }, [overview.data, form]);
  if (!form || !overview.data) return <Skeleton className="h-64" />;

  const setMeal = (meal: MealWindow['meal'], patch: Partial<MealWindow>) => setForm({ ...form, meals: form.meals.map((m) => (m.meal === meal ? { ...m, ...patch } : m)) });
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      setForm(await api.put<CanteenSettings>('/api/erp/canteen/settings', form));
      void qc.invalidateQueries({ queryKey: ['canteen'] });
      toast({ tone: 'success', title: '设置存好了' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const createDept = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await api.post<CanteenSettings>('/api/erp/canteen/department', { name: '员工食堂' });
      setForm({ ...form, departmentId: s.departmentId });
      void qc.invalidateQueries({ queryKey: ['canteen'] });
      toast({ tone: 'success', title: '「员工食堂」部门建好了，也设成了食堂部门' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]" data-testid="canteen-settings">
      <Card className="space-y-5 p-5">
        <div>
          <SectionTitle>食堂部门</SectionTitle>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="厨师、食堂负责人要在这个部门里" className="min-w-[220px] flex-1">
              <Select value={form.departmentId ?? ''} onChange={(e) => setForm({ ...form, departmentId: e.target.value ? Number(e.target.value) : null })} aria-label="食堂部门">
                <option value="">（还没选）</option>
                {departments.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            {!departments.data?.some((d) => d.name === '员工食堂') && (
              <Button variant="secondary" onClick={() => void createDept()} disabled={busy} data-testid="canteen-create-dept">
                一键新建「员工食堂」部门
              </Button>
            )}
          </div>
        </div>

        <div>
          <SectionTitle>开饭时间</SectionTitle>
          <p className="mt-1 text-[12.5px] text-ink-3">负责人扫码时按这个时间认是哪一顿；不在开饭时间扫码不记。结束时间早于开始表示到第二天（例如夜宵 22:00–01:00）。</p>
          <div className="mt-3 space-y-2.5">
            {form.meals.map((m) => (
              <div key={m.meal} className="flex flex-wrap items-center gap-3" data-testid={`canteen-meal-${m.meal}`}>
                <div className="w-28">
                  <ConfirmCheck checked={m.enabled} onChange={(v) => setMeal(m.meal, { enabled: v })}>
                    {MEAL_EMOJI[m.meal]} {MEAL_LABELS[m.meal]}
                  </ConfirmCheck>
                </div>
                <Input type="time" className="w-32" fullWidth={false} value={m.start} disabled={!m.enabled} onChange={(e) => setMeal(m.meal, { start: e.target.value })} aria-label={`${MEAL_LABELS[m.meal]}开始`} />
                <span className="text-ink-3">到</span>
                <Input type="time" className="w-32" fullWidth={false} value={m.end} disabled={!m.enabled} onChange={(e) => setMeal(m.meal, { end: e.target.value })} aria-label={`${MEAL_LABELS[m.meal]}结束`} />
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>员工入口地址</SectionTitle>
          <Field
            label="员工手机打开柚子饭堂的网址"
            className="mt-3"
            hint="备案前用测试地址（例如 Tailscale 给的 https 地址）；备案后填 https://staff.你的域名。开通卡片上的二维码就是它。"
          >
            <Input value={form.portalUrl} onChange={(e) => setForm({ ...form, portalUrl: e.target.value })} placeholder="https://staff.example.com" aria-label="员工入口地址" />
          </Field>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <Button onClick={() => void save()} loading={busy} data-testid="canteen-save-settings">
          保存设置
        </Button>
      </Card>

      <div className="space-y-4">
        <Notice tone={overview.data.portOpen ? 'success' : 'warning'} title={overview.data.portOpen ? '员工端口开着' : '员工端口还没开'}>
          {overview.data.portOpen
            ? '员工的手机经网关服务器的 HTTPS 转发到这个端口打开柚子饭堂。'
            : '部署时设 CANTEEN_PORT 与 CANTEEN_CODE_SECRET（openssl rand -hex 32），再在网关服务器的 Caddy 里加 staff 站点转发过来（docs/CANTEEN.md 第 9 节）。部署由 Codex 按 main 的版本标签做。'}
        </Notice>
        <Card className="p-5 text-[13px] leading-relaxed text-ink-2">
          <p className="font-bold text-ink">谁能做什么</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>员工：看菜单、给菜点赞、亮饭卡码、看自己吃了几顿</li>
            <li>厨师：再加上编辑、发布菜单</li>
            <li>食堂负责人：再加上扫码打卡、手动登记、撤销当天自己登记错的</li>
            <li>这里（店主、店总）：名单、开通卡片、用餐记录、设置</li>
          </ul>
          <p className="mt-3">员工账号只能登录柚子饭堂，没有任何管理后台的权限。</p>
        </Card>
      </div>
    </div>
  );
}
