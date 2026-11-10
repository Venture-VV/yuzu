// 注册二维码（docs/CANTEEN.md 第 14 节，K12）：员工扫码（或点员工群里的链接）打开柚子饭堂，看完柚子的开场，
// 在「新同事登记」填用户名、手机号、密码就开好账号（普通员工）。不要注册口令（店主 2026-11-07）：管理员在这里打开自己登记，
// 拿到员工入口地址的人就能登记；名单里看得到谁是自己登记的，不认识的停用，不想再有人登记就关掉。
// 开关带上看到的 rev（对不上拒绝）：没收到结果时不当作「没改成」，刷新看现在的；晚到的那一下不会把开关改回去。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import type { CanteenRegistration } from '@shared/canteen';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { Badge, Button, Card, ConfirmCheck, Notice, SectionTitle } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { QrCode } from '../../../canteen-app/QrCode';
import { PrintButton } from '../print/PrintButton';

export function RegistrationCard({ registration, portalUrl }: { registration: CanteenRegistration; portalUrl: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['canteen'] });

  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    const what = enabled ? '打开自己登记' : '关掉自己登记';
    try {
      await api.put<CanteenRegistration>('/api/erp/canteen/registration', { enabled, rev: registration.rev });
      refresh();
      if (enabled) toast({ tone: 'success', title: '自己登记打开了', body: '把注册二维码发到员工群、或打印海报贴在饭堂' });
    } catch (e) {
      // 没收到结果、或者服务端说刚改过：都刷新看现在的，不当作没改成
      if (e instanceof UncertainError) {
        refresh();
        toast({ tone: 'info', title: `${what}：没收到结果`, body: '可能已经改好了。已经刷新，看看现在的开关；再点会接着现在的来' });
      } else if (e instanceof ApiError && e.code === 'REGISTRATION_CHANGED') {
        refresh();
        toast({ tone: 'info', title: '开关刚改过', body: '可能是刚才那一下已经改好了：已经刷新，看看现在的' });
      } else toast({ tone: 'error', title: '没改成', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'success', title: '链接复制好了，可以发到员工群' });
    } catch {
      toast({ tone: 'error', title: '没复制成，请手动选中链接复制' });
    }
  };

  return (
    <Card className="space-y-4 p-5" data-testid="canteen-registration">
      <SectionTitle aside={<Badge tone={registration.enabled ? 'pine' : 'neutral'}>{registration.enabled ? '开着' : '关着'}</Badge>}>注册二维码</SectionTitle>
      <p className="text-[13px] leading-relaxed text-ink-2">
        员工用手机扫这个码（或打开链接），看完柚子的开场，在「新同事登记」填用户名、手机号、密码就开好账号（普通员工），不用口令。发到员工群、或打印海报贴在饭堂都行。已经有{' '}
        <b>{registration.selfRegistered}</b> 位自己登记。
      </p>
      {!registration.enabled ? (
        <Button variant="primary" loading={busy} onClick={() => void toggle(true)} data-testid="canteen-reg-open">
          打开自己登记
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-4">
            {registration.link ? (
              <QrCode text={registration.link} className="size-36 shrink-0 rounded-lg ring-1 ring-line" label="注册二维码" />
            ) : (
              <div className="flex size-36 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-strong p-3 text-center text-[12px] text-ink-3">先在左边填员工入口地址，才有二维码</div>
            )}
            {registration.link && (
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-[12px] text-ink-3">注册链接</p>
                <p className="text-[12.5px] break-all select-all" data-testid="canteen-reg-link">
                  {registration.link}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(registration.link!)}>
                    复制链接
                  </Button>
                  <PrintButton path="/print/canteen-poster" paper="a4" size="sm" testId="canteen-print-poster">
                    打印注册海报
                  </PrintButton>
                </div>
              </div>
            )}
          </div>
          <ConfirmCheck checked={registration.enabled} onChange={(v) => void toggle(v)}>
            开着自己登记（关掉以后扫码也登记不了；已经登记的人照常用）
          </ConfirmCheck>
          {!portalUrl && <Notice tone="warning">还没填员工入口地址：员工没法扫码打开。</Notice>}
        </>
      )}
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        拿到员工入口地址的人都能登记成普通员工：「员工名单」里看得到谁是自己登记的，不认识的停用就好；不想再有人登记就关掉。有同事离职，在「员工名单」里停用他就行：停用以后他登录不了，用他的手机号也登记不了。
      </p>
    </Card>
  );
}
