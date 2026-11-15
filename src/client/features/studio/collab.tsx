// UI 工作台编辑器 8.1.2 第 4 步（docs/WORKBENCH_V811.md 第 13 节）：中英文案、设计包、「谁在改」、批注。
//   · 中英文案：一份版面里所有的字列成一张表，中英对着改；导出 CSV 给人翻译、导回来按编号对上；
//   · 设计包：草稿连同用到的图导出成一个文件；导进来交回编辑器（照常存草稿、可撤销），再发布；
//   · 谁在改：开着编辑器每 15 秒报到一次，顶上写着还有谁在改同一个界面（别处存过时照旧提示刷新）；
//   · 批注：「批注」打开后点画布上的地方留言（挂在点到的那一块上），右边一条条看、回复、标解决。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { applyCopy, collectCopy, copyFromCsv, copyToCsv, type StudioCommentView, type StudioDoc, type StudioPresence, type StudioSurface } from '@shared/studio';
import { api, errorMessage } from '../../lib/api';
import { readImportFile } from '../../lib/import-file';
import { cn, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Textarea } from '../../components/ui';

type Change = (fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => void;

const download = (text: string, name: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // 挂到页面上再点：有的浏览器不认没挂上的链接的文件名
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ───────────────────────── 中英文案 ─────────────────────────

export function CopyDialog({ doc, onChange, onClose }: { doc: StudioDoc; onChange: Change; onClose: () => void }) {
  const toast = useToast();
  const rows = useMemo(() => collectCopy(doc), [doc]);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const shown = onlyMissing ? rows.filter((r) => r.zh.trim() && !r.en.trim()) : rows;
  const missing = rows.filter((r) => r.zh.trim() && !r.en.trim()).length;
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (key: string, lang: 'zh' | 'en', value: string) => onChange((d) => applyCopy(d, [{ key, [lang]: value }]).doc, `copy.${key}.${lang}`);
  const importCsv = async (file: File) => {
    try {
      const { text } = await readImportFile(file);
      const { updates, error } = copyFromCsv(text);
      if (error) {
        toast({ tone: 'error', title: error });
        return;
      }
      const r = applyCopy(doc, updates);
      if (r.changed) onChange(() => r.doc);
      toast({ tone: 'success', title: r.changed ? `导回来了：改了 ${r.changed} 处` : '导回来了：没有要改的' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  return (
    <Dialog open title="中英文案" description="这份版面里所有的字：中文、英文对着改（改了马上进草稿，可以撤销）；也可以导出给人翻译、再导回来" onClose={onClose} width="max-w-4xl">
      <div className="space-y-3" data-testid="studio-copy">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <label className="flex items-center gap-1.5 text-ink-2">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} data-testid="studio-copy-missing" />
            只看英文没填的（{missing}）
          </label>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => download(copyToCsv(rows), `中英文案-${doc.surface}.csv`, 'text/csv;charset=utf-8')} data-testid="studio-copy-export">
            导出 CSV
          </Button>
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} data-testid="studio-copy-import">
            导回来
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importCsv(f);
            }}
            data-testid="studio-copy-file"
          />
        </div>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-[13px] leading-relaxed text-ink-3">
            {rows.length ? '英文都填好了' : '这份版面里还没有自己加的字：在左栏「插入」里加文字、按钮，字就列在这里。内置功能块里的字（菜名、版权行……）在后台对应的设置里改。'}
          </p>
        ) : (
          <div className="max-h-[56vh] overflow-y-auto rounded-md border border-line">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-paper-2 text-left text-ink-3">
                <tr>
                  <th className="w-28 px-2 py-1.5 font-normal">屏</th>
                  <th className="w-36 px-2 py-1.5 font-normal">名字</th>
                  <th className="px-2 py-1.5 font-normal">中文</th>
                  <th className="px-2 py-1.5 font-normal">英文</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key} className="border-t border-line align-top" data-testid={`studio-copy-row-${r.nodeId}`}>
                    <td className="px-2 py-1.5 text-ink-3">{r.screenLabel}</td>
                    <td className="truncate px-2 py-1.5">{r.label}</td>
                    <td className="px-1 py-1">
                      <Textarea rows={1} className="min-h-8 text-[12.5px]" value={r.zh} onChange={(e) => set(r.key, 'zh', e.target.value)} />
                    </td>
                    <td className="px-1 py-1">
                      <Textarea
                        rows={1}
                        className={cn('min-h-8 text-[12.5px]', r.zh.trim() && !r.en.trim() && 'border-yuzu')}
                        value={r.en}
                        placeholder="没填时显示中文"
                        onChange={(e) => set(r.key, 'en', e.target.value)}
                        data-testid={`studio-copy-en-${r.nodeId}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 设计包 ─────────────────────────

export function PackDialog({ surface, flush, onImported, onClose }: { surface: StudioSurface; flush: () => Promise<boolean>; onImported: (doc: StudioDoc) => void; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const exportPack = async () => {
    setBusy('export');
    try {
      // 导出的是存好的草稿：先把没存的存上
      if (!(await flush())) {
        toast({ tone: 'error', title: '草稿没存上，先处理顶上的提示再导出' });
        return;
      }
      const res = await fetch(`/api/studio/${surface}/pack`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`导出没成功（${res.status}）`);
      download(await res.text(), `设计包-${surface}-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const importPack = async (file: File) => {
    setBusy('import');
    try {
      const text = await file.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('这不是工作台导出的设计包（不是 JSON 文件）');
      }
      const r = await api.post<{ doc: StudioDoc; assets: number; added: number }>(`/api/studio/${surface}/pack`, body, { timeoutMs: 120_000 });
      onImported(r.doc);
      const pics = r.assets ? `；${r.assets} 张图${r.added ? `里新存了 ${r.added} 张（其余本来就有）` : '这里本来就有'}` : '';
      toast({ tone: 'success', title: '设计包导进来了', body: `版面换成了设计包里的（可以撤销）${pics}。看一眼再发布。` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open title="设计包" description="把这份版面连同用到的图存成一个文件，在别的地方（比如从演示库到正式服）导进来接着改、发布" onClose={onClose}>
      <div className="space-y-4" data-testid="studio-pack">
        <div className="rounded-md border border-line px-3 py-2.5">
          <div className="text-[13px] font-bold">导出</div>
          <p className="mt-0.5 text-[12px] text-ink-3">存好的草稿 + 用到的图，一个 .json 文件。</p>
          <Button size="sm" variant="primary" className="mt-2" loading={busy === 'export'} onClick={() => void exportPack()} data-testid="studio-pack-export">
            导出设计包
          </Button>
        </div>
        <div className="rounded-md border border-line px-3 py-2.5">
          <div className="text-[13px] font-bold">导进来</div>
          <p className="mt-0.5 text-[12px] text-ink-3">编辑器里的版面换成设计包里的（可以撤销）；图按内容核对过才存。导进来以后照常发布。</p>
          <Button size="sm" variant="secondary" className="mt-2" loading={busy === 'import'} onClick={() => fileRef.current?.click()} data-testid="studio-pack-import">
            选设计包文件
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importPack(f);
            }}
            data-testid="studio-pack-file"
          />
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────── 谁在改 ─────────────────────────

/** 开着编辑器每 15 秒报到一次，返回还有谁在改同一个界面 */
export function usePresence(surface: StudioSurface): StudioPresence[] {
  const [others, setOthers] = useState<StudioPresence[]>([]);
  useEffect(() => {
    let alive = true;
    const ping = () =>
      api
        .post<StudioPresence[]>(`/api/studio/${surface}/presence`, {})
        .then((r) => alive && setOthers(r))
        .catch(() => undefined);
    void ping();
    const t = window.setInterval(ping, 15_000);
    const onFocus = () => void ping();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [surface]);
  return others;
}

export function PresenceChip({ others }: { others: StudioPresence[] }) {
  if (!others.length) return null;
  return (
    <span
      className="mr-2 max-w-28 shrink truncate whitespace-nowrap rounded-full bg-yuzu-soft px-2 py-0.5 text-[11.5px] text-yuzu-deep min-[1400px]:max-w-48"
      title={`${others.map((o) => o.name).join('、')} 也开着这个界面的编辑器：两个人同时改，后存的会提示刷新`}
      data-testid="studio-presence"
    >
      {others.length > 1 ? `${others[0]!.name} 等 ${others.length} 人也在改` : `${others[0]!.name} 也在改`}
    </span>
  );
}

// ───────────────────────── 批注 ─────────────────────────

export const commentsKey = (surface: StudioSurface) => ['studio', 'comments', surface] as const;

export function useComments(surface: StudioSurface) {
  return useQuery({ queryKey: commentsKey(surface), queryFn: () => api.get<StudioCommentView[]>(`/api/studio/${surface}/comments`), refetchInterval: 30_000 });
}

/** 画布上的批注：没解决的是红的圆点（第几条），点一下看那一条；在加批注时盖一层，点哪里就在哪里写 */
export function CommentPins({
  comments,
  screen,
  scale,
  adding,
  draft,
  active,
  onPlace,
  onPick,
}: {
  comments: StudioCommentView[];
  screen: string;
  scale: number;
  adding: boolean;
  draft: { x: number; y: number } | null;
  active: number | null;
  onPlace: (p: { x: number; y: number; nodeId: string | null }) => void;
  onPick: (id: number) => void;
}) {
  const roots = comments.filter((c) => c.parentId === null && c.screen === screen && !c.resolvedAt);
  return (
    <>
      {adding && (
        <div
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // 点到的那一块（画布里带 data-studio-node 的最里面一层）
            e.currentTarget.style.pointerEvents = 'none';
            const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-studio-node]');
            e.currentTarget.style.pointerEvents = '';
            onPlace({ x: Math.round((e.clientX - r.left) / scale), y: Math.round((e.clientY - r.top) / scale), nodeId: under?.dataset.studioNode ?? null });
          }}
          data-testid="studio-comment-layer"
        />
      )}
      {roots.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className={cn(
            'absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full rounded-bl-none border-2 border-white text-[11px] font-bold text-white shadow',
            active === c.id ? 'bg-[#2f7cf6]' : 'bg-clay',
          )}
          style={{ left: c.x * scale, top: c.y * scale }}
          onClick={() => onPick(c.id)}
          title={c.body}
          data-testid={`studio-comment-pin-${c.id}`}
        >
          {i + 1}
        </button>
      ))}
      {draft && (
        <span
          className="pointer-events-none absolute z-10 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full rounded-bl-none border-2 border-white bg-[#2f7cf6] shadow"
          style={{ left: draft.x * scale, top: draft.y * scale }}
        />
      )}
    </>
  );
}

function When({ at }: { at: string }) {
  return <span className="text-[11px] text-ink-3">{new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>;
}

export function CommentsPanel({
  surface,
  screen,
  screenLabel,
  adding,
  onAdding,
  draft,
  onDraftDone,
  active,
  onActive,
  onGoScreen,
}: {
  surface: StudioSurface;
  screen: string;
  screenLabel: (key: string) => string;
  /** 点「别的屏」里的一条：画布换到那一屏 */
  onGoScreen: (screen: string) => void;
  adding: boolean;
  onAdding: (on: boolean) => void;
  draft: { x: number; y: number; nodeId: string | null } | null;
  onDraftDone: () => void;
  active: number | null;
  onActive: (id: number | null) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useComments(surface);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<Record<number, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  // 同一条没发出去（或不知道发没发出去）的批注、回复重发时用同一个操作编号：服务端原样返回那一条，不会记成两条；
  // 改了字再发而上一次其实记下了的，服务端拒绝，刷新就看得到记下的那条
  const draftKey = useRef(uuid());
  const replyKeys = useRef<Record<number, string>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: commentsKey(surface) });
  const post = async (body: Record<string, unknown>, clientKey: string) => {
    setBusy(true);
    try {
      await api.post(`/api/studio/${surface}/comments`, { clientKey, ...body });
      refresh();
      return true;
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (id: number, resolved: boolean) => {
    try {
      await api.post(`/api/studio/comments/${id}/resolve`, { resolved });
      refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  const all = q.data ?? [];
  const roots = all.filter((c) => c.parentId === null && (showResolved || !c.resolvedAt));
  const here = roots.filter((c) => c.screen === screen);
  const elsewhere = roots.filter((c) => c.screen !== screen);
  const thread = (c: StudioCommentView, index: number | null): ReactNode => (
    <div
      key={c.id}
      className={cn('rounded-md border px-2.5 py-2', active === c.id ? 'border-[#2f7cf6]' : 'border-line', c.resolvedAt && 'opacity-60')}
      onClick={() => onActive(c.id)}
      data-testid={`studio-comment-${c.id}`}
    >
      <div className="flex items-center gap-1.5 text-[12px]">
        {index !== null && <span className="flex size-5 items-center justify-center rounded-full bg-clay text-[10.5px] font-bold text-white">{index}</span>}
        <span className="font-bold">{c.createdBy}</span>
        <When at={c.createdAt} />
        <div className="flex-1" />
        <button type="button" className="text-[11.5px] text-pine hover:underline" onClick={() => void resolve(c.id, !c.resolvedAt)} data-testid={`studio-comment-resolve-${c.id}`}>
          {c.resolvedAt ? '重新打开' : '解决了'}
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{c.body}</p>
      {all
        .filter((r) => r.parentId === c.id)
        .map((r) => (
          <div key={r.id} className="mt-1.5 border-l-2 border-line pl-2 text-[12.5px]">
            <span className="font-bold">{r.createdBy}</span> <When at={r.createdAt} />
            <p className="whitespace-pre-wrap leading-relaxed">{r.body}</p>
          </div>
        ))}
      {c.resolvedAt ? (
        <p className="mt-1 text-[11px] text-ink-3">{c.resolvedBy} 标了解决</p>
      ) : (
        <div className="mt-1.5 flex gap-1.5">
          <input
            className="h-7 min-w-0 flex-1 rounded border border-line bg-card px-2 text-[12px] outline-none focus:border-pine"
            placeholder="回复"
            value={reply[c.id] ?? ''}
            onChange={(e) => setReply((m) => ({ ...m, [c.id]: e.target.value }))}
            data-testid={`studio-comment-reply-${c.id}`}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!reply[c.id]?.trim() || busy}
            onClick={() => {
              const key = (replyKeys.current[c.id] ??= uuid());
              void post({ screen: c.screen, x: c.x, y: c.y, parentId: c.id, body: reply[c.id]!.trim() }, key).then((ok) => {
                if (!ok) return;
                delete replyKeys.current[c.id];
                setReply((m) => ({ ...m, [c.id]: '' }));
              });
            }}
            data-testid={`studio-comment-reply-send-${c.id}`}
          >
            回复
          </Button>
        </div>
      )}
    </div>
  );
  return (
    <div className="space-y-3" data-testid="studio-comments">
      <div className="flex items-center gap-2">
        <Button size="sm" variant={adding ? 'primary' : 'secondary'} onClick={() => onAdding(!adding)} data-testid="studio-comment-add">
          {adding ? '点画布上要说的地方' : '加一条批注'}
        </Button>
        <label className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-3">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 显示已解决的
        </label>
      </div>
      {draft && (
        <div className="space-y-1.5 rounded-md border border-[#2f7cf6] px-2.5 py-2" data-testid="studio-comment-draft">
          <div className="text-[11.5px] text-ink-3">
            在「{screenLabel(screen)}」这个位置{draft.nodeId ? '（挂在点到的那一块上）' : ''}
          </div>
          <Textarea rows={3} autoFocus maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="想说什么：哪里要改、为什么" data-testid="studio-comment-text" />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText('');
                draftKey.current = uuid();
                onDraftDone();
              }}
            >
              不写了
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!text.trim()}
              onClick={() =>
                void post({ screen, x: draft.x, y: draft.y, nodeId: draft.nodeId, body: text.trim() }, draftKey.current).then((ok) => {
                  if (!ok) return;
                  draftKey.current = uuid();
                  setText('');
                  onDraftDone();
                })
              }
              data-testid="studio-comment-send"
            >
              留言
            </Button>
          </div>
        </div>
      )}
      {q.isPending ? null : q.isError && !q.data ? (
        <LoadFailed title="批注取不回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          {here.length === 0 && !draft && (
            <p className="text-[12px] text-ink-3">这一屏没有{showResolved ? '' : '没解决的'}批注。打开「加一条批注」，点画布上要说的地方写一句；设计师和店主都能回复、标解决。</p>
          )}
          {here.map((c) => thread(c, roots.filter((x) => x.screen === screen && !x.resolvedAt).indexOf(c) + 1 || null))}
          {elsewhere.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="text-[11.5px] font-bold text-ink-3">别的屏</div>
              {elsewhere.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="block w-full rounded px-1 py-0.5 text-left text-[12px] text-ink-2 hover:bg-paper-2"
                  title="去那一屏看"
                  onClick={() => {
                    onGoScreen(c.screen);
                    onActive(c.id);
                  }}
                  data-testid={`studio-comment-go-${c.id}`}
                >
                  <span className="text-ink-3">{screenLabel(c.screen)}：</span>
                  {c.body.slice(0, 40)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
