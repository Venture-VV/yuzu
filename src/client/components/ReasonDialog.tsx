import { useState, type ReactNode } from 'react';
import { useResetOnOpen } from '../lib/useResetOnOpen';
import { Dialog } from './Overlay';
import { Button, Field, Textarea } from './ui';

/** 需要填写原因的操作：退回修改、撤回、冲销、关闭等。原因会写进单据的经办记录。 */
export function ReasonDialog({
  open,
  title,
  description,
  label = '原因',
  confirmLabel,
  danger,
  busy,
  extra,
  testId,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  label?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  extra?: ReactNode;
  /** 浏览器用例用：原因输入框为 `${testId}-reason`，确认按钮为 `${testId}-confirm` */
  testId?: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useResetOnOpen(open, () => setReason(''));
  const ok = reason.trim().length >= 2;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={busy} onClick={() => onConfirm(reason.trim())} data-testid={testId ? `${testId}-confirm` : undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label} htmlFor="reason-text" hint="至少 2 个字，会记在经办记录里">
        <Textarea id="reason-text" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} data-testid={testId ? `${testId}-reason` : undefined} />
      </Field>
      {extra}
    </Dialog>
  );
}
