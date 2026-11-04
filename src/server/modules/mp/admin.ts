// 后台「小程序」模块（小程序线，docs/MINIPROGRAM.md 第 5 节）：对顾客开放的开关、门店信息、首页轮播、项目介绍、图片。
// 修改带版本号，对不上拒绝（没收到结果再保存不会改两次）；新建轮播带操作编号，重提返回原来那条；图片按内容摘要去重。
// 加锁：每次只锁要改的那一行（门店、轮播或项目介绍）；开关照规则类设置统一走 saveRuleSetting。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import {
  DEFAULT_MP_RULES,
  MP_RULES_KEY,
  type MpAdminData,
  type MpBannerAbandonResult,
  type MpBannerAdmin,
  type MpBannerOpLookup,
  type MpItemIntroAdmin,
  type MpRules,
  type MpStoreAdmin,
} from '@shared/mp';
import { MAX_IMAGE_BYTES } from '@shared/requests';
import type { Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { loadRechargeRules } from './recharge';
import { loadCouponRules, loadFoodRules, loadInviteRules, loadMpRules, loadReminderRules } from './rules';

type StoreRow = Omit<MpStoreAdmin, 'latitude' | 'longitude'> & { latitude: string | null; longitude: string | null };
const toStore = (s: StoreRow): MpStoreAdmin => ({ ...s, latitude: s.latitude === null ? null : Number(s.latitude), longitude: s.longitude === null ? null : Number(s.longitude) });

export async function mpAdminData(db: Db): Promise<MpAdminData> {
  const stores = await db<StoreRow[]>`
    SELECT id, code, name, is_home, hours, address, phone, latitude, longitude, notice, image_id, visible, sort_order, version, updated_at
    FROM mp_stores ORDER BY sort_order, id`;
  const banners = await db<MpBannerAdmin[]>`
    SELECT id, title, link, image_id, starts_on, ends_on, sort_order, active, version FROM mp_banners ORDER BY active DESC, sort_order, id`;
  const items = await db<MpItemIntroAdmin[]>`
    SELECT i.id AS item_id, i.name, i.category, i.active, coalesce(x.intro, '') AS intro, x.image_id, coalesce(x.version, 0) AS version
    FROM service_items i LEFT JOIN mp_item_intros x ON x.item_id = i.id
    ORDER BY i.active DESC, i.sort_order, i.id`;
  return {
    rules: await loadMpRules(db),
    rechargeRules: await loadRechargeRules(db),
    couponRules: await loadCouponRules(db),
    reminderRules: await loadReminderRules(db),
    inviteRules: await loadInviteRules(db),
    foodRules: await loadFoodRules(db),
    stores: stores.map(toStore),
    banners,
    items,
  };
}

// ── 开关 ──

const RulesInput = z.object({
  enabled: z.boolean('请选择是否对顾客开放'),
  /** 后台看到的版本号（后台都带）；没带的不核对：自动化脚本收尾时不管现在是什么都关上 */
  version: z.number().int().min(0).optional(),
});

export async function saveMpRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpRules> {
  const input = parse(RulesInput, raw);
  return saveRuleSetting(
    deps.sql,
    MP_RULES_KEY,
    loadMpRules,
    (before) => {
      const current = { ...DEFAULT_MP_RULES, ...before };
      if (input.version !== undefined && input.version !== current.version) throw conflict('VERSION_CONFLICT', '开关刚被别人改过，请刷新后再改');
      // 内容没变也加一：后台「放弃这次修改」靠它让原来那次请求的版本号对不上
      return { ...current, enabled: input.enabled, version: current.version + 1 };
    },
    ctx,
  );
}

// ── 门店信息 ──

const StoreInput = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1, '请填写门店名称').max(32, '门店名称最多 32 个字'),
    hours: z.string().trim().max(60, '营业时间最多 60 个字').default(''),
    address: z.string().trim().max(120, '地址最多 120 个字').default(''),
    phone: z.string().trim().max(30, '电话最多 30 个字').default(''),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    notice: z.string().trim().max(300, '公告最多 300 字').default(''),
    imageId: z.number().int().positive().nullable().default(null),
    visible: z.boolean().default(true),
  })
  .refine((v) => (v.latitude === null) === (v.longitude === null), '定位的纬度、经度要一起填');

const CodeParam = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,23}$/, '门店编号不正确') });

export async function saveStore(deps: Deps, rawParams: unknown, raw: unknown, ctx: OpContext): Promise<MpStoreAdmin> {
  const { code } = parse(CodeParam, rawParams);
  const v = parse(StoreInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [row] = await tx<{ id: number; version: number }[]>`SELECT id, version FROM mp_stores WHERE code = ${code} FOR UPDATE`;
    if (!row) throw notFound('门店不存在');
    if (row.version !== v.version) throw conflict('VERSION_CONFLICT', '门店信息刚被别人改过，请刷新后再改');
    await tx`
      UPDATE mp_stores SET name = ${v.name}, hours = ${v.hours}, address = ${v.address}, phone = ${v.phone},
             latitude = ${v.latitude}, longitude = ${v.longitude}, notice = ${v.notice}, image_id = ${v.imageId}, visible = ${v.visible},
             version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
      WHERE id = ${row.id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'mp_content_saved', targetType: 'mp_store', targetId: row.id, detail: { code, ...v }, ip: ctx.ip });
  });
  return (await mpAdminData(deps.sql)).stores.find((s) => s.code === code)!;
}

// ── 图片 ──

const ImageInput = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp'], '只能上传 JPEG、PNG、WebP 图片'),
  data: z.string().min(16).max(1_500_000),
});

/** 按文件头认图片格式（与采购单图片同样的认法） */
function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function saveMpImage(db: Db, raw: unknown, actor: Actor): Promise<{ id: number }> {
  const input = parse(ImageInput, raw);
  const buf = Buffer.from(input.data, 'base64');
  if (buf.length === 0) throw badRequest('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw unprocessable('IMAGE_TOO_LARGE', '图片压缩后仍超过 1 MB，请换一张或裁小一点');
  const kind = sniff(buf);
  if (!kind || kind !== input.mime) throw unprocessable('IMAGE_INVALID', '文件不是有效的 JPEG、PNG 或 WebP 图片');
  const sha = createHash('sha256').update(buf).digest('hex');
  const [row] = await db<{ id: number }[]>`
    INSERT INTO mp_images (sha256, mime, data, size_bytes, created_by) VALUES (${sha}, ${kind}, ${buf}, ${buf.length}, ${actor.id})
    ON CONFLICT (sha256) DO NOTHING RETURNING id`;
  return { id: row?.id ?? (await db<{ id: number }[]>`SELECT id FROM mp_images WHERE sha256 = ${sha}`)[0]!.id };
}

// ── 首页轮播 ──

const dateOrNull = z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').nullable().default(null);
const BannerFields = z.object({
  title: z.string().trim().min(1, '请填写标题').max(40, '标题最多 40 个字'),
  imageId: z.number('请先上传图片').int().positive('请先上传图片'),
  link: z.enum(['none', 'prices', 'guide', 'store']).default('none'),
  startsOn: dateOrNull,
  endsOn: dateOrNull,
  sortOrder: z.number().int().min(-9999).max(9999).default(0),
});
const BannerCreate = BannerFields.extend({ clientKey: z.uuid('操作编号不正确') }).refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, '结束日期不能早于开始日期');
const BannerUpdate = BannerFields.extend({ version: z.number().int().positive(), active: z.boolean() }).refine(
  (v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn,
  '结束日期不能早于开始日期',
);

async function bannerOf(db: Db, id: number): Promise<MpBannerAdmin> {
  const [b] = await db<MpBannerAdmin[]>`SELECT id, title, link, image_id, starts_on, ends_on, sort_order, active, version FROM mp_banners WHERE id = ${id}`;
  if (!b) throw notFound('轮播不存在');
  return b;
}

export async function createBanner(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpBannerAdmin & { replayed: boolean }> {
  const v = parse(BannerCreate, raw);
  const result = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_banner:${v.clientKey}`}))`;
    const [prev] = await tx<{ id: number }[]>`SELECT id FROM mp_banners WHERE client_key = ${v.clientKey}`;
    if (prev) return { id: prev.id, replayed: true };
    // 这个编号已经确认作废（结果不确定时后台作废的）：晚到的原请求不再新建
    const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${v.clientKey} AND op_type = 'mp_banner'`;
    if (fenced) throw conflict('OP_ABANDONED', '这次新建已经作废，请重新填写');
    const [img] = await tx`SELECT 1 FROM mp_images WHERE id = ${v.imageId}`;
    if (!img) throw badRequest('图片不存在，请重新上传');
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO mp_banners (title, image_id, link, starts_on, ends_on, sort_order, client_key, created_by)
      VALUES (${v.title}, ${v.imageId}, ${v.link}, ${v.startsOn}, ${v.endsOn}, ${v.sortOrder}, ${v.clientKey}, ${ctx.actor.id}) RETURNING id`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'mp_content_saved', targetType: 'mp_banner', targetId: row!.id, detail: { created: true, ...v }, ip: ctx.ip });
    return { id: row!.id, replayed: false };
  });
  return { ...(await bannerOf(deps.sql, result.id)), replayed: result.replayed };
}

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/** 按操作编号查回新建轮播（只读、不加锁）：建了返回那一条；登记了作废返回作废；都没有不能断定没新建 */
export async function lookupBannerOp(db: Db, rawKey: unknown): Promise<MpBannerOpLookup> {
  const { clientKey } = parse(AbandonInput, { clientKey: rawKey });
  const [prev] = await db<{ id: number }[]>`SELECT id FROM mp_banners WHERE client_key = ${clientKey}`;
  if (prev) return { found: true, abandoned: false, banner: await bannerOf(db, prev.id) };
  const [fenced] = await db`SELECT 1 FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_banner'`;
  return { found: false, abandoned: !!fenced, banner: null };
}

/**
 * 新建轮播结果不确定时确认作废这个编号（迁移 044）：与新建取同一把咨询锁（这个编号），二者不交错。
 * 已经建了返回那一条；还没有就登记作废，之后原请求即使到达也不会新建（OP_ABANDONED）。
 */
export async function abandonBannerCreate(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpBannerAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  const result = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_banner:${clientKey}`}))`;
    const [prev] = await tx<{ id: number }[]>`SELECT id FROM mp_banners WHERE client_key = ${clientKey}`;
    if (prev) return { id: prev.id };
    const inserted = await tx`
      INSERT INTO mp_op_fences (key, op_type, staff_id) VALUES (${clientKey}, 'mp_banner', ${ctx.actor.id})
      ON CONFLICT (key, op_type) DO NOTHING RETURNING key`;
    if (inserted.length) {
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'mp_op_abandoned', targetType: 'mp_banner', targetId: clientKey, detail: { clientKey }, ip: ctx.ip });
    }
    return { id: null };
  });
  return result.id === null ? { state: 'abandoned' } : { state: 'done', banner: await bannerOf(deps.sql, result.id) };
}

export async function updateBanner(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<MpBannerAdmin> {
  const v = parse(BannerUpdate, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [row] = await tx<{ version: number }[]>`SELECT version FROM mp_banners WHERE id = ${id} FOR UPDATE`;
    if (!row) throw notFound('轮播不存在');
    if (row.version !== v.version) throw conflict('VERSION_CONFLICT', '这条轮播刚被别人改过，请刷新后再改');
    const [img] = await tx`SELECT 1 FROM mp_images WHERE id = ${v.imageId}`;
    if (!img) throw badRequest('图片不存在，请重新上传');
    await tx`
      UPDATE mp_banners SET title = ${v.title}, image_id = ${v.imageId}, link = ${v.link}, starts_on = ${v.startsOn}, ends_on = ${v.endsOn},
             sort_order = ${v.sortOrder}, active = ${v.active}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'mp_content_saved', targetType: 'mp_banner', targetId: id, detail: { ...v }, ip: ctx.ip });
  });
  return bannerOf(deps.sql, id);
}

// ── 项目介绍 ──

const IntroInput = z.object({
  /** 还没写过介绍时为 0 */
  version: z.number().int().min(0),
  intro: z.string().trim().max(300, '介绍最多 300 字').default(''),
  imageId: z.number().int().positive().nullable().default(null),
});

export async function saveItemIntro(deps: Deps, itemId: number, raw: unknown, ctx: OpContext): Promise<MpItemIntroAdmin> {
  const v = parse(IntroInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [item] = await tx`SELECT 1 FROM service_items WHERE id = ${itemId}`;
    if (!item) throw notFound('项目不存在');
    if (v.imageId !== null) {
      const [img] = await tx`SELECT 1 FROM mp_images WHERE id = ${v.imageId}`;
      if (!img) throw badRequest('图片不存在，请重新上传');
    }
    const [row] = await tx<{ version: number }[]>`SELECT version FROM mp_item_intros WHERE item_id = ${itemId} FOR UPDATE`;
    if ((row?.version ?? 0) !== v.version) throw conflict('VERSION_CONFLICT', '这个项目的介绍刚被别人改过，请刷新后再改');
    if (row) {
      await tx`UPDATE mp_item_intros SET intro = ${v.intro}, image_id = ${v.imageId}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now() WHERE item_id = ${itemId}`;
    } else {
      // 两人同时第一次写同一个项目：主键兜底，后到的一方当作版本号对不上
      const inserted = await tx`
        INSERT INTO mp_item_intros (item_id, intro, image_id, updated_by) VALUES (${itemId}, ${v.intro}, ${v.imageId}, ${ctx.actor.id})
        ON CONFLICT (item_id) DO NOTHING RETURNING item_id`;
      if (inserted.length === 0) throw conflict('VERSION_CONFLICT', '这个项目的介绍刚被别人改过，请刷新后再改');
    }
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'mp_content_saved', targetType: 'mp_item_intro', targetId: itemId, detail: { ...v }, ip: ctx.ip });
  });
  return (await mpAdminData(deps.sql)).items.find((i) => i.itemId === itemId)!;
}
