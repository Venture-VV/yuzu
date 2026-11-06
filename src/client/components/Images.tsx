// 图片（v0.7.8，需求单与采购单的行）：上传前在浏览器里压缩成 JPEG（最长边 1600 像素、质量 0.8），
// 压缩后单张不超过 1 MB；缩略图点开看大图。图片地址要登录才能看（同源 cookie）。

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { IMAGE_MAX_EDGE, IMAGE_QUALITY, MAX_IMAGE_BYTES, MAX_LINE_IMAGES, type ImageRef } from '@shared/requests';
import { api, errorMessage } from '../lib/api';
import { cn } from '../lib/utils';
import { Dialog } from './Overlay';

async function compress(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('只能上传图片');
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('canvas');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
    if (blob) return blob;
  } catch {
    /* 浏览器不支持就原样上传（服务端再核对大小与格式） */
  }
  return file;
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(blob);
  });

async function prepare(file: File): Promise<{ blob: Blob; mime: string; data: string }> {
  const blob = await compress(file);
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片压缩后仍超过 1 MB，请换一张或裁小一点');
  const mime = blob.type === 'image/png' || blob.type === 'image/webp' ? blob.type : 'image/jpeg';
  return { blob, mime, data: await toBase64(blob) };
}

async function uploadCompressed(file: File): Promise<{ ref: ImageRef; blob: Blob }> {
  const { blob, mime, data } = await prepare(file);
  return { ref: await api.post<ImageRef>('/api/erp/images', { mime, data }, { timeoutMs: 30_000 }), blob };
}

/** 压缩好、转成上传用的 { mime, data }：走自己接口的图片用（合同扫描件，v0.7.31） */
export async function imagePayload(file: File): Promise<{ mime: string; data: string }> {
  const { mime, data } = await prepare(file);
  return { mime, data };
}

export async function uploadImage(file: File): Promise<ImageRef> {
  return (await uploadCompressed(file)).ref;
}

/** 只读缩略图；点开看大图 */
export function ImageThumbs({ images, size = 44, className }: { images: ImageRef[]; size?: number; className?: string }) {
  const [open, setOpen] = useState<ImageRef | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <span className={cn('flex flex-wrap gap-1.5', className)}>
        {images.map((img, i) => (
          <button
            key={img.id}
            type="button"
            onClick={() => setOpen(img)}
            className="overflow-hidden rounded-md border border-line bg-paper-2 hover:border-line-strong"
            style={{ width: size, height: size }}
            aria-label={`查看图片 ${i + 1}`}
          >
            <img src={img.url} alt="" loading="lazy" className="size-full object-cover" />
          </button>
        ))}
      </span>
      <Dialog open={!!open} onClose={() => setOpen(null)} title="图片" footer={null}>
        {open && <img src={open.url} alt="" className="mx-auto max-h-[70vh] w-auto rounded-md" />}
      </Dialog>
    </>
  );
}

/**
 * 可编辑的图片：上传（压缩）、删除；最多 max 张。
 * onBusyChange 告诉表单还有没有图片在上传：上传完之前表单不能提交，否则提交的是上传前的图片（v0.7.9 修正）。
 */
export function ImagePicker({
  value,
  onChange,
  max = MAX_LINE_IMAGES,
  disabled,
  testId,
  onBusyChange,
}: {
  value: ImageRef[];
  onChange: (next: ImageRef[]) => void;
  max?: number;
  disabled?: boolean;
  testId?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;
  useEffect(() => {
    busyRef.current?.(busy);
  }, [busy]);
  // 上传中这一行被删掉：别让表单一直以为还在上传
  useEffect(() => () => busyRef.current?.(false), []);
  // 这次刚传的图，缩略图用本机压缩好的那份（Codex 自动审查 2cfd28b）：服务端按内容去重，别人传过同一张图时返回的是那张的编号，
  // 只有「部门申购」的账号在需求单保存之前看不到它（数据隔离只放行自己上传的、本部门与自己提的需求单里的）；保存后就在自己的需求单里了
  const local = useRef(new Map<number, string>());
  useEffect(() => {
    const urls = local.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...value];
    try {
      for (const f of [...files].slice(0, max - value.length)) {
        const { ref: img, blob } = await uploadCompressed(f);
        if (!local.current.has(img.id)) local.current.set(img.id, URL.createObjectURL(blob));
        if (!next.some((x) => x.id === img.id)) next.push(img);
      }
      onChange(next);
    } catch (e) {
      onChange(next);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((img, i) => (
          <span key={img.id} className="relative size-14 overflow-hidden rounded-md border border-line bg-paper-2">
            <img src={local.current.get(img.id) ?? img.url} alt="" className="size-full object-cover" />
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x.id !== img.id))}
                className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-ink/70 text-paper"
                aria-label={`删除图片 ${i + 1}`}
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {value.length < max && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => input.current?.click()}
            className="flex size-14 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-line-strong text-[11px] text-ink-3 hover:bg-paper-2 disabled:opacity-50"
            data-testid={testId}
          >
            <ImagePlus className="size-4" />
            {busy ? '上传中' : '加图片'}
          </button>
        )}
        <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void add(e.target.files)} data-testid={testId ? `${testId}-input` : undefined} />
      </div>
      {error && <p className="text-[12px] font-semibold text-clay">{error}</p>}
    </div>
  );
}
