// 项目计价：按所选价格档取服务端当前价格，生成随明细留存的快照。会员消费与前台挂账共用。
// 页面提交的合计与这里算出的不一致时，由调用方拒绝（PRICE_CHANGED），员工按新价格重新确认。

import { defaultTier, lineName, PRICE_TIER_LABELS, sortTiers, tierPrice, type PriceTier, type TierPrice } from '@shared/catalog';
import type { Db } from '../db';
import { conflict } from '../lib/errors';

export interface PricedItem {
  id: number;
  name: string;
  category: string;
  active: boolean;
  gender: 'male' | 'female' | null;
  technicianRequired: boolean;
  prices: TierPrice[];
}

/**
 * 各档价格（JSON 数组）。没有分档价格记录的项目（例如直接写库建的项目）按 price 作为唯一的「标准」档，
 * 与分档之前的计价完全一致。
 */
export const pricesColumn = (db: Db) => db`
  coalesce((SELECT json_agg(json_build_object('tier', p.tier, 'price', p.price))
            FROM service_item_prices p WHERE p.item_id = i.id),
           json_build_array(json_build_object('tier', 'standard', 'price', i.price)))`;

export async function loadPricedItems(db: Db, ids: number[]): Promise<Map<number, PricedItem>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db<PricedItem[]>`
    SELECT i.id, i.name, i.category, i.active, i.gender, i.technician_required,
           ${pricesColumn(db)} AS prices
    FROM service_items i WHERE i.id IN ${db(unique)}`;
  return new Map(rows.map((r) => [r.id, { ...r, prices: sortTiers(r.prices) }]));
}

export interface PricedLine {
  itemId: number;
  name: string;
  tier: PriceTier;
  unitPrice: number;
  quantity: number;
  amount: number;
}

/**
 * 按所选档位计价；不带档位（升级前留下的待确认请求、旧页面）时取默认档。
 * 项目停用、或项目没有所选的档位时拒绝，页面刷新项目后重新选择。
 */
export function priceLine(item: PricedItem | undefined, tier: PriceTier | undefined, quantity: number, unavailable: string): PricedLine {
  if (!item || !item.active) throw conflict('ITEM_UNAVAILABLE', unavailable);
  const t = tier ?? defaultTier(item.prices);
  const price = t ? tierPrice(item.prices, t) : null;
  if (!t || price === null) {
    throw conflict('ITEM_UNAVAILABLE', `「${item.name}」没有「${PRICE_TIER_LABELS[tier ?? 'standard']}」档价格，请刷新后重新选择`);
  }
  return { itemId: item.id, name: lineName(item.name, item.prices, t), tier: t, unitPrice: price, quantity, amount: price * quantity };
}
