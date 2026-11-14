// 会员详情上的「微信」一行（8.0.19，docs/IA_V8017.md 第 3.4 节，IA4）：看这位会员绑没绑小程序；
// 换手机号、换微信时有「解绑会员的微信」权限的人在这里解绑，不用再去后台「微信小程序 → 绑定」里重新找一遍人。
//
// 接口、操作编号与「结果待确认」都用小程序线现成的（只引用、不改它的文件）：
//   · 读：GET /api/admin/mp/members/:id/bindings（能查会员的都能读）；
//   · 解绑：sendUnbind——提交前把操作编号与原请求存在本机，存不了不发；没收到结果的记在本机，
//     到后台「微信小程序 → 绑定」上方查回、按原内容重新提交（这里只提示、不另起一笔）。

import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import type { MpBindingRow } from '@shared/mp';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { formatDate, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input } from '../../components/ui';
import { MpPendingReadError, MpPendingStoreError, sendUnbind, useMpPending } from '../mp/mpPending';

export function MemberWechatCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const session = useSession();
  // 与后台「微信小程序 → 绑定」同一个查询键：哪边解绑了，另一边跟着变
  const bindings = useQuery({
    queryKey: ['mp', 'bindings', member.id],
    queryFn: () => api.get<MpBindingRow[]>(`/api/admin/mp/members/${member.id}/bindings`),
    retry: false,
  });
  const pending = useMpPending('unbind').filter((op) => op.memberId === member.id);
  const [unbinding, setUnbinding] = useState<MpBindingRow | null>(null);
  // 读不到（接口不在、没权限）就不显示这一行：它只是多一个入口，不挡别的
  if (!bindings.data) return null;
  const active = bindings.data.filter((b) => !b.unboundAt);
  const past = bindings.data.length - active.length;
  // 没开小程序的门店不显示这一行（8.0.19，W10）；关掉以前绑的还绑着时照旧显示，好让人解绑
  if (!session.miniProgram && active.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-card px-4 py-3 text-[13.5px]" data-testid="member-wechat">
      <MessageCircle className="size-4 shrink-0 text-ink-3" />
      <span className="font-bold text-ink">微信小程序</span>
      {active.length === 0 ? (
        <span className="text-ink-3" data-testid="member-wechat-none">
          没有绑定{past > 0 ? `（以前绑过 ${past} 次，已解绑）` : ''}
        </span>
      ) : (
        active.map((b) => (
          <span key={b.id} className="flex flex-wrap items-center gap-x-2" data-testid={`member-wechat-binding-${b.id}`}>
            <span className="text-ink-2">
              已绑定 · 微信 …{b.openidTail} · 手机 {b.phone} · <span className="num">{formatDate(b.boundAt)}</span> 绑的{b.mock ? '（模拟）' : ''}
            </span>
            {can('mp.unbind') && (
              <Button size="sm" variant="secondary" disabled={pending.length > 0} onClick={() => setUnbinding(b)} data-testid="member-wechat-unbind">
                解绑
              </Button>
            )}
          </span>
        ))
      )}
      {pending.length > 0 && (
        <span className="basis-full text-[12.5px] font-semibold text-clay" data-testid="member-wechat-pending">
          有一笔解绑没收到结果。请到{' '}
          <Link to="/admin/mp" className="underline">
            后台「微信小程序 → 绑定」
          </Link>{' '}
          上方查回或按原内容重新提交，不要另起一笔。
        </span>
      )}
      {unbinding && <UnbindDialog binding={unbinding} member={member} onClose={() => setUnbinding(null)} />}
    </div>
  );
}

function UnbindDialog({ binding, member, onClose }: { binding: MpBindingRow; member: MemberDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  // 这次解绑一直用同一个操作编号：提交前存在本机，没收到结果时按原内容重新提交，只解绑一次
  const [clientKey] = useState(uuid);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await sendUnbind({
        key: clientKey,
        memberId: member.id,
        bindingId: binding.id,
        reason,
        summary: `${member.name} 的微信 …${binding.openidTail}（${reason.trim()}）`,
        staffName: session.staff.displayName,
      });
      await qc.invalidateQueries({ queryKey: ['mp', 'bindings', member.id] });
      toast({ tone: 'success', title: '已解绑', body: '请客人用新的微信或手机号在小程序里重新绑定' });
      onClose();
    } catch (error) {
      if (error instanceof UncertainError) {
        toast({ tone: 'error', title: '解绑结果待确认', body: '没收到结果，不知道解绑没有。这一笔记在本机，请到后台「微信小程序 → 绑定」上方按原内容重新提交，不要另起一笔。' });
        onClose();
      } else if (error instanceof MpPendingStoreError || error instanceof MpPendingReadError) {
        toast({ tone: 'error', title: '没有解绑', body: '这台电脑的浏览器存不了（或读不出）操作记录，请求没有发出去。请换一个浏览器窗口再试。' });
      } else {
        toast({ tone: 'error', title: '没有解绑', body: errorMessage(error) });
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="解绑这个微信"
      description={`${member.name} · 微信 …${binding.openidTail}，绑定时的手机号 ${binding.phone}。核对是本人再解绑。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={saving} disabled={!reason.trim()} onClick={() => void save()} data-testid="member-wechat-unbind-submit">
            解绑
          </Button>
        </>
      }
    >
      <Field label="原因" hint="例如：换手机号、换微信、手机丢了" htmlFor="member-wechat-unbind-reason">
        <Input id="member-wechat-unbind-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus data-testid="member-wechat-unbind-reason" />
      </Field>
    </Dialog>
  );
}
