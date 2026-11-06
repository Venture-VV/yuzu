// 注册二维码（docs/CANTEEN.md 第 14 节，K12）：员工扫码打开柚子饭堂，看完柚子的开场，在「新同事登记」填用户名、手机号、密码就开好账号。
// 口令就在二维码和链接里（#reg=口令），外面的人拿到员工入口地址也登记不了；换一个口令旧的二维码马上作废。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, RefreshCw } from 'lucide-react';
import { displayActivationCode, type CanteenRegistration } from '@shared/canteen';
import { api, errorMessage } from '../../lib/api';
import { Badge, Button, Card, ConfirmCheck, Notice, SectionTitle } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { QrCode } from '../../../canteen-app/QrCode';
import { PrintButton } from '../print/PrintButton';

export function RegistrationCard({ registration, portalUrl }: { registration: CanteenRegistration; portalUrl: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<'code' | 'toggle' | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['canteen'] });

  const rotate = async () => {
    setBusy('code');
    try {
      await api.post<CanteenRegistration>('/api/erp/canteen/registration/code');
      setConfirmRotate(false);
      refresh();
      toast({ tone: 'success', title: registration.code ? '换好了：旧的二维码已经作废，请重新打印海报' : '注册二维码生成好了' });
    } catch (e) {
      toast({ tone: 'error', title: '没换成', body: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (enabled: boolean) => {
    setBusy('toggle');
    try {
      await api.put<CanteenRegistration>('/api/erp/canteen/registration', { enabled });
      refresh();
    } catch (e) {
      toast({ tone: 'error', title: '没改成', body: errorMessage(e) });
    } finally {
      setBusy(null);
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
      <SectionTitle aside={registration.code ? <Badge tone={registration.enabled ? 'pine' : 'neutral'}>{registration.enabled ? '开着' : '关了'}</Badge> : undefined}>
        注册二维码
      </SectionTitle>
      <p className="text-[13px] leading-relaxed text-ink-2">
        员工用手机扫这个码，看完柚子的开场，在「新同事登记」填用户名、手机号、密码就开好账号（普通员工）。发到员工群、或打印海报贴在饭堂都行。已经有 <b>{registration.selfRegistered}</b> 位自己登记。
      </p>
      {!registration.code ? (
        <Button variant="primary" loading={busy === 'code'} onClick={() => void rotate()} data-testid="canteen-reg-create">
          生成注册二维码
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-4">
            {registration.link ? (
              <QrCode text={registration.link} className="size-36 shrink-0 rounded-lg ring-1 ring-line" label="注册二维码" />
            ) : (
              <div className="flex size-36 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-strong p-3 text-center text-[12px] text-ink-3">先在左边填员工入口地址，才有二维码</div>
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-[12px] text-ink-3">注册口令（没扫码的同事手动输入）</p>
                <p className="num font-mono text-[22px] font-bold tracking-[0.15em]" data-testid="canteen-reg-code">
                  {displayActivationCode(registration.code)}
                </p>
              </div>
              {registration.link && (
                <div>
                  <p className="text-[12px] text-ink-3">注册链接</p>
                  <p className="text-[12.5px] break-all select-all" data-testid="canteen-reg-link">
                    {registration.link}
                  </p>
                  <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(registration.link!)}>
                    复制链接
                  </Button>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {registration.link && (
              <PrintButton path="/print/canteen-poster" paper="a4" size="sm" testId="canteen-print-poster">
                打印注册海报
              </PrintButton>
            )}
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} onClick={() => setConfirmRotate((v) => !v)}>
              换一个口令
            </Button>
          </div>
          {confirmRotate && (
            <Notice tone="warning" title="换了口令，旧的二维码、链接、海报马上作废" data-testid="canteen-reg-rotate-confirm">
              已经登记的人不受影响。换好以后请重新打印海报、重新发链接。
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="danger" loading={busy === 'code'} onClick={() => void rotate()}>
                  确定换
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRotate(false)}>
                  先不换
                </Button>
              </div>
            </Notice>
          )}
          <ConfirmCheck checked={registration.enabled} onChange={(v) => busy !== 'toggle' && void toggle(v)}>
            开着自己登记（关掉以后扫码也登记不了；已经登记的人照常用）
          </ConfirmCheck>
          {!portalUrl && <Notice tone="warning">还没填员工入口地址：员工没法扫码打开，只能手动输入口令。</Notice>}
          <p className="text-[12.5px] leading-relaxed text-ink-3">有同事离职：在「员工名单」里停用他，再在这里换一个口令（免得他用别的手机号再登记一次）。</p>
        </>
      )}
    </Card>
  );
}
