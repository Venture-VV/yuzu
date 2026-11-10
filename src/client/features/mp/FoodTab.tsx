// 后台「微信小程序」→「扫码点餐」（小程序线第三期 3c，docs/MP_PHASE3.md 第 3 节；权限 mp.food：店主、店总）：
//   · 开关与小程序可点的菜（在进厨房的菜里勾），带版本号一起保存，结果待确认照其他开关；
//   · 桌码：每张启用的桌台一个（门店系统配了签名密钥 MP_CODE_SECRET 才有），A4 打印、裁开放在桌上；
//   · 今天小程序下了几单，最近 50 单。
// 菜品、价格、估清、桌台照旧在后台「餐饮」里维护；退菜照旧请服务员在点单页作废。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatYuan } from '@shared/money';
import type { MpAdminData, MpFoodAdminData, MpFoodAdminTable } from '@shared/mp';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Card, ConfirmCheck, Field, Notice, Segmented, Skeleton } from '../../components/ui';
import { mpAdminKey, PendingUpdates, updateFailed } from './mpAdminShared';
import { sendUpdate, useMpPending } from './mpPending';
import { encodeDigits, qrSvgPath } from './qr';

const foodKey = ['mp', 'food'] as const;

export function FoodTab({ data }: { data: MpAdminData }) {
  const q = useQuery({ queryKey: foodKey, queryFn: () => api.get<MpFoodAdminData>('/api/admin/mp/food') });
  const pending = useMpPending('food_rules_update');
  if (!q.data) return <Skeleton className="h-48" />;
  return (
    <div className="space-y-4">
      {pending.length > 0 && <PendingUpdates ops={pending} data={data} />}
      {!q.data.diningEnabled && (
        <Notice tone="warning" title="餐饮功能还关着">
          在后台「餐饮」里开了餐饮功能，小程序才能点；关着时点餐页写「还没开放」。
        </Notice>
      )}
      <RulesForm key={data.foodRules.version} d={q.data} rules={data.foodRules} pending={pending.length > 0} />
      <TableCodes d={q.data} />
      <Recent d={q.data} />
    </div>
  );
}

function RulesForm({ d, rules, pending }: { d: MpFoodAdminData; rules: MpAdminData['foodRules']; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [enabled, setEnabled] = useState(rules.enabled);
  const [itemIds, setItemIds] = useState<number[]>(rules.itemIds);
  const [saving, setSaving] = useState(false);
  const groups = [...new Set(d.dishes.map((x) => x.group))];
  const save = async () => {
    setSaving(true);
    try {
      await sendUpdate({
        type: 'food_rules_update',
        url: '/api/admin/mp/food/rules',
        target: 'food_rules',
        body: { enabled, itemIds, version: rules.version },
        summary: '扫码点餐的设置',
        staffName: session.staff.displayName,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: mpAdminKey }), qc.invalidateQueries({ queryKey: foodKey })]);
      toast({ tone: 'success', title: '扫码点餐的设置已保存' });
    } catch (error) {
      updateFailed(toast, error);
      void qc.invalidateQueries({ queryKey: mpAdminKey });
    } finally {
      setSaving(false);
    }
  };
  const toggle = (id: number, on: boolean) => setItemIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">扫码点餐</p>
          <p className="text-[13px] text-ink-3">
            在店的会员（手牌挂上了会员卡）在小程序「我的 → 点餐」点菜、扫桌上的码写送到哪张桌；与服务员在点单页下单一样进厨房出品单、扣估清，
            挂在自己的手牌账单上，结账照旧在前台。一单最多 {d.limits.maxQuantity} 份、{formatYuan(d.limits.maxTotal)}（在「经营规则 → 可调的数值」里改），
            一道菜最多 {d.limits.maxLineQuantity} 份、最多 {d.limits.maxLines} 道菜；顾客自己不能退菜。
          </p>
          {pending && <p className="text-[12.5px] text-ember">设置的修改结果待确认，先在上方处理</p>}
        </div>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel="扫码点餐开关"
          onChange={(v) => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: '关闭', disabled: pending },
            { value: 'on', label: '开通', disabled: pending },
          ]}
        />
      </div>
      <Field label="小程序可点的菜" hint="只列进厨房的菜（后台「餐饮」里挂了出品档口的）；价格、估清照「餐饮」，没勾的请服务员点">
        {d.dishes.length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有进厨房的菜：在后台「餐饮」里把菜挂到出品档口</p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => {
              const list = d.dishes.filter((x) => x.group === g);
              const all = list.every((x) => itemIds.includes(x.id));
              return (
                <div key={g} className="space-y-1.5">
                  <div className="flex items-center gap-3">
                    <p className="text-[13px] font-semibold text-ink-2">{g}</p>
                    <button
                      type="button"
                      className="text-[12.5px] text-lake underline-offset-2 hover:underline"
                      onClick={() => setItemIds((ids) => (all ? ids.filter((id) => !list.some((x) => x.id === id)) : [...new Set([...ids, ...list.map((x) => x.id)])]))}
                    >
                      {all ? '这一组都不勾' : '这一组都勾上'}
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {list.map((x) => (
                      <ConfirmCheck key={x.id} checked={itemIds.includes(x.id)} onChange={(on) => toggle(x.id, on)}>
                        {x.name} <span className="num text-ink-3">{formatYuan(x.price)}</span>
                        {x.remaining === 0 && <span className="text-ember"> · 今天估清</span>}
                      </ConfirmCheck>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="num text-[13px] text-ink-3">勾了 {itemIds.filter((id) => d.dishes.some((x) => x.id === id)).length} 道</p>
        <Button variant="primary" loading={saving} disabled={pending} onClick={save}>
          保存扫码点餐的设置
        </Button>
      </div>
    </Card>
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function qrSvg(code: string, className = ''): string {
  const qr = encodeDigits(code);
  const n = qr.size + 8;
  return `<svg class="${className}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${n}" height="${n}" fill="#fff"/><path d="${qrSvgPath(qr)}" fill="#000"/></svg>`;
}

/** A4 打印：一页四张，沿虚线裁开放在桌上；在隐藏的框里打印，不开新窗口 */
function printTableCodes(storeName: string, tables: MpFoodAdminTable[]) {
  const cards = tables
    .filter((t) => t.code)
    .map(
      (t) => `<div class="card">
  <p class="store">${esc(storeName)}</p>
  <p class="title">扫码点餐</p>
  <p class="table">${esc(t.name)}</p>
  ${qrSvg(t.code!, 'qr')}
  <p class="steps">打开本店的微信小程序 → 我的 → 点餐 → 扫这张码</p>
  <p class="fine">手牌挂上会员卡才能点 · 菜挂在手牌的账单上，结账在前台 · 退菜请服务员</p>
</div>`,
    )
    .join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>桌码</title><style>
@page { size: A4 portrait; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #000; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.card { height: 130mm; border: 1px dashed #000; padding: 7mm 6mm; text-align: center; break-inside: avoid; display: flex; flex-direction: column; align-items: center; }
.store { margin: 0; font-size: 11pt; letter-spacing: 0.3em; }
.title { margin: 3mm 0 0; font-size: 18pt; font-weight: 700; letter-spacing: 0.2em; }
.table { margin: 1mm 0 3mm; font-size: 30pt; font-weight: 700; }
.qr { width: 56mm; height: 56mm; }
.steps { margin: 4mm 0 0; font-size: 11pt; }
.fine { margin: 2mm 0 0; font-size: 8.5pt; }
</style></head><body><div class="grid">${cards}</div></body></html>`;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const done = () => frame.remove();
  win.addEventListener('afterprint', done);
  setTimeout(done, 120_000);
  win.focus();
  win.print();
}

function TableCodes({ d }: { d: MpFoodAdminData }) {
  const session = useSession();
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">桌码</p>
          <p className="text-[13px] text-ink-3">
            每张启用的桌台一个码：码里只有桌台编号与一段签名，桌台改名照样认，停用的不认；拍照带出店也点不了（要有在店手牌）。
            顾客在小程序「点餐」里扫，出品单上写送到这张桌。
          </p>
        </div>
        <Button variant="secondary" disabled={!d.tableCodeReady || d.tables.length === 0} onClick={() => printTableCodes(session.storeName, d.tables)}>
          打印桌码（A4）
        </Button>
      </div>
      {!d.tableCodeReady ? (
        <Notice tone="warning" title="门店系统还没配签名密钥">
          桌码用门店系统的 MP_CODE_SECRET 签名（与会员码同一个）。请部署的同事在门店系统的 .env 里配好（至少 32 个字符），重启后这里就有桌码；没配时顾客照样能点，只是不写桌号。
        </Notice>
      ) : d.tables.length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有启用的桌台：在后台「餐饮 → 桌台」里建</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {d.tables.map((t) => (
            <div key={t.id} className="rounded-md border border-line p-2 text-center" data-testid="mp-table-code">
              {t.code ? (
                <div className="mx-auto aspect-square w-full max-w-28" dangerouslySetInnerHTML={{ __html: qrSvg(t.code, 'size-full') }} />
              ) : (
                <p className="py-6 text-[12px] text-ink-3">桌台编号太大，生成不了</p>
              )}
              <p className="mt-1 text-[13.5px] font-semibold text-ink">{t.name}</p>
              {t.area && <p className="text-[12px] text-ink-3">{t.area}</p>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Recent({ d }: { d: MpFoodAdminData }) {
  return (
    <Card className="p-0">
      <div className="space-y-1 border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">最近的点单</p>
        <p className="num text-[13px] text-ink-3">
          今天：{d.today.orders} 单 · {formatYuan(d.today.total)}（按手牌的营业日；账以前台账单为准，退了的菜在账单里作废）
        </p>
      </div>
      {d.recent.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有小程序的点单</p>
      ) : (
        <div className="divide-y divide-line">
          {d.recent.map((r) => (
            <div key={r.id} className="space-y-0.5 px-4 py-2.5 text-[13.5px]" data-testid="mp-food-order">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="num text-ink-3">{formatDateTime(r.createdAt)}</span>
                <span className="font-semibold text-ink">{r.memberName}</span>
                <span className="num">手牌 {r.tagCode}</span>
                {r.deliverTo && <span>送到 {r.deliverTo}</span>}
                {r.orderNo && <span className="num text-ink-3">出品单 {r.orderNo}</span>}
                <span className="num ml-auto font-semibold">{formatYuan(r.total)}</span>
              </div>
              <p className="text-[12.5px] text-ink-3">{r.lines.map((l) => `${l.name} ×${l.quantity}${l.note ? `（${l.note}）` : ''}`).join('、')}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
