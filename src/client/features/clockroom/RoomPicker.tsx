// 服务的房间（v0.7.16 房态图）：派钟时选、派钟后换。可选的是空间台账里在用、可售的技师服务类空间，按楼层分组、带现在的占用；
// 房间满了不拦（容量只是参考），只在选项里写「已满」。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardSession, ClockroomBoard } from '@shared/clockroom';
import type { ClockSpace } from '@shared/floormap';
import { spaceLabel } from '@shared/spaces';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Notice, Select } from '../../components/ui';
import { useClockSpaces } from '../rooms/floormap-api';

export function occupancyText(s: ClockSpace): string {
  const used = s.serving + s.waiting;
  if (used === 0) return '空闲';
  const parts = [s.serving ? `服务中 ${s.serving}` : '', s.waiting ? `待上钟 ${s.waiting}` : ''].filter(Boolean).join('、');
  return s.capacity && used >= s.capacity ? `${parts}（已满 ${used}/${s.capacity}）` : `${parts}${s.capacity ? `（${used}/${s.capacity}）` : ''}`;
}

export function RoomSelect({
  id,
  value,
  onChange,
  spaces,
  current,
  testId,
}: {
  id?: string;
  value: number | null;
  onChange: (id: number | null) => void;
  spaces: ClockSpace[] | undefined;
  /** 钟单原来的房间（已不在可选列表里时也显示出来） */
  current?: BoardSession['space'];
  testId?: string;
}) {
  const floors = [...new Set((spaces ?? []).map((s) => s.floorCode))];
  const missing = current && !(spaces ?? []).some((s) => s.id === current.id) ? current : null;
  return (
    <Select id={id} value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} data-testid={testId}>
      <option value="">不选房间</option>
      {missing && <option value={missing.id}>{spaceLabel(missing.code, missing.displayName)}（已停用或不可售）</option>}
      {floors.map((f) => (
        <optgroup key={f} label={f}>
          {(spaces ?? [])
            .filter((s) => s.floorCode === f)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {spaceLabel(s.code, s.displayName)} · {occupancyText(s)}
              </option>
            ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** 换房间：派钟后改服务的房间、补选（前台挂账建的钟单没有房间）、清掉；带上页面看到的房间，别人刚换过就拒绝 */
export function RoomDialog({ session: s, onClose, onSaved }: { session: BoardSession | null; onClose: () => void; onSaved: (b: ClockroomBoard) => void }) {
  const open = !!s;
  const qc = useQueryClient();
  const spaces = useClockSpaces(open);
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setValue(s?.space?.id ?? null);
    setError(null);
  });
  if (!s) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.post<ClockroomBoard>(`/api/clockroom/sessions/${s.id}/space`, { spaceId: value, expectedVersion: s.spaceVersion }));
    } catch (e) {
      // 被拒绝（别人刚换过、房间停用了）或结果不明：刷新钟房看板，按看板上的房间再选。
      // 请求带着看到的版本号，结果不明的那次就算迟到生效，也盖不掉之后的修改
      setError(
        e instanceof UncertainError
          ? `${e.message}，不确定换好了没有：钟房看板已刷新，关掉看钟单上现在的房间，不对再换`
          : errorMessage(e),
      );
      void qc.invalidateQueries({ queryKey: ['clockroom'] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`${s.space ? '换房间' : '选房间'} · ${s.techNo} 号 ${s.techName}`}
      description={`${s.tagCode} ${s.guest} · ${s.itemName} × ${s.clocks}。房态图按这里的房间显示服务中；记进钟房日志。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={value === (s.space?.id ?? null)} onClick={() => void save()} data-testid="room-dialog-save">
            {value === null && s.space ? '清掉房间' : '保存'}
          </Button>
        </>
      }
    >
      <Field label="服务的房间" htmlFor="room-dialog-select" hint="空间台账里在用、可售的技师服务类房间；满了也能选，只是提示">
        <RoomSelect id="room-dialog-select" value={value} onChange={setValue} spaces={spaces.data} current={s.space} testId="room-dialog-select" />
      </Field>
      {spaces.error && <Notice tone="error" title={errorMessage(spaces.error)} className="mt-3" />}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
