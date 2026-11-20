// 老账号第一次登录选新岗位（8.1.18，docs/POSITIONS_V8118.md GW7）：系统岗位改成「部门 → 负责人 / 员工」以后，
// 原来的账号自己选一次现在的岗位，确认后不再提示。能选的部门与岗位按原来的岗位与职责限定（服务端 selfSelectablePositions，店主定方案 B）；
// 选的结果后台员工名单标「自选岗位」，总裁核对、可以再改。
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ADMIN_LEVEL_LABELS, ORG_DEPARTMENTS, positionOf, type AdminLevel, type OrgDepartment, type PositionKey } from '@shared/positions';
import type { SessionInfo } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { LogoMark } from '../../components/Brand';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Field, Notice, Segmented, Select, Skeleton } from '../../components/ui';

interface PositionOption {
  key: PositionKey;
  department: OrgDepartment;
  title: string;
  level: AdminLevel;
  levelLabel: string;
}

export function ChoosePositionPage() {
  const session = useSession();
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ['auth', 'position-options'], queryFn: () => api.get<{ options: PositionOption[] }>('/api/auth/position-options') });
  const [dept, setDept] = useState<OrgDepartment | ''>('');
  const [position, setPosition] = useState<PositionKey | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = options.data?.options ?? [];
  const depts = ORG_DEPARTMENTS.filter((d) => list.some((o) => o.department === d.key));
  const inDept = list.filter((o) => o.department === dept);

  const submit = async () => {
    if (!position) return;
    setSaving(true);
    setError(null);
    try {
      const info = await api.post<SessionInfo>('/api/auth/position', { position });
      qc.setQueryData(qk.session, info);
    } catch (err) {
      setError(errorMessage(err));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="paper-grain flex min-h-dvh items-center justify-center bg-paper px-4 py-10" data-testid="choose-position">
      <div className="w-full max-w-[460px] animate-rise">
        <LogoMark className="size-11" />
        <h1 className="mt-6 text-[26px] font-bold tracking-tight">选择你现在的岗位</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          你好，{session.staff.displayName}。系统的岗位改成了「部门 → 负责人 / 员工」，请先选你现在所在的部门与岗位；确认后按新岗位的权限使用，以后不再提示。
        </p>
        <Card className="mt-7 flex flex-col gap-5 p-6">
          {options.isPending ? (
            <Skeleton className="h-24" />
          ) : options.isError ? (
            <LoadFailed title="可选的岗位没读到" onRetry={() => void options.refetch()} retrying={options.isFetching} />
          ) : (
            <>
              <Field label="部门" htmlFor="cp-dept">
                <Select
                  id="cp-dept"
                  value={dept}
                  onChange={(e) => {
                    const d = e.target.value as OrgDepartment | '';
                    setDept(d);
                    const first = list.filter((o) => o.department === d);
                    setPosition(first.length === 1 ? first[0]!.key : null);
                    setConfirming(false);
                  }}
                  data-testid="choose-position-dept"
                >
                  <option value="">请选择部门</option>
                  {depts.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {inDept.length > 1 && (
                <Field label="岗位">
                  <Segmented
                    value={position ?? ''}
                    onChange={(v) => {
                      setPosition(v as PositionKey);
                      setConfirming(false);
                    }}
                    className="w-full"
                    options={inDept.map((o) => ({ value: o.key, label: `${o.key.endsWith('.lead') ? '负责人' : o.key.endsWith('.staff') ? '员工' : o.title}（${o.levelLabel}）` }))}
                  />
                </Field>
              )}
              {position && (
                <p className="flex flex-wrap items-center gap-2 text-[13.5px]">
                  已选：<b>{positionOf(position).title}</b>
                  <Badge tone="lake">{ADMIN_LEVEL_LABELS[positionOf(position).level]}</Badge>
                </p>
              )}
              <p className="text-[12.5px] text-ink-3">按原来的岗位与职责列出能选的部门与岗位；找不到自己的岗位、或选错了，请联系总裁在后台「员工账号」里改。</p>
              {error && <Notice tone="error" title={error} />}
              {confirming && position ? (
                <Notice tone="warning" title={`确认选「${positionOf(position).title}」？`}>
                  <div className="mt-2 flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                      再看看
                    </Button>
                    <Button variant="primary" size="sm" loading={saving} onClick={() => void submit()} data-testid="choose-position-confirm">
                      确认
                    </Button>
                  </div>
                </Notice>
              ) : (
                <Button variant="primary" size="lg" disabled={!position} onClick={() => setConfirming(true)} data-testid="choose-position-submit">
                  选好了
                </Button>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
