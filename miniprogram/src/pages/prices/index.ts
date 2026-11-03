// 价目表：门票（12 小时、24 小时）与价目表项目（按分类，各档价格），直接读门店系统的价目表，后台改价这里跟着变；
// 项目介绍与图片在后台「微信小程序 → 项目介绍」补。
import type { PriceTier } from '../../../../src/shared/catalog';
import type { MpPriceItem, MpPrices } from '../../../../src/shared/mp';
import { imageUrl, messageOf, show } from '../../utils/api';
import { appData } from '../../utils/app-state';
import { minutes, price } from '../../utils/format';

const TIERS: PriceTier[] = ['standard', 'professional', 'premium'];
const TIER_LABELS: Record<PriceTier, string> = { standard: '标准', professional: '专业', premium: '优选' };
const WELLNESS = /按摩|SPA|spa|理疗|疗愈|护理|足|推拿|指压/;

interface Cell {
  label: string;
  value: string;
}
interface Row {
  key: string;
  name: string;
  meta: string;
  intro: string;
  image: string;
  cells: Cell[];
}
interface Tab {
  key: string;
  label: string;
}

function tabsOf(d: MpPrices): Tab[] {
  const tabs: Tab[] = d.tickets.length ? [{ key: 'tickets', label: '门票' }] : [];
  const seen: Record<string, boolean> = {};
  for (const i of d.items) {
    if (seen[i.category]) continue;
    seen[i.category] = true;
    tabs.push({ key: 'cat:' + i.category, label: i.category });
  }
  return tabs;
}

/** 首页的 TASTE、WELLNESS 指到哪一类 */
function resolveTab(tabs: Tab[], want: string | null): string | null {
  if (!want) return null;
  if (want === 'wellness') {
    const hit = tabs.filter((t) => t.key !== 'tickets' && WELLNESS.test(t.label))[0];
    return hit ? hit.key : null;
  }
  return tabs.some((t) => t.key === want) ? want : null;
}

/** 价格为 0 的（儿童免票等）写「免费」 */
const priceText = (cents: number) => (cents === 0 ? '免费' : price(cents));

function itemMeta(i: MpPriceItem): string {
  const parts: string[] = [];
  if (i.durationMinutes) parts.push(minutes(i.durationMinutes));
  if (i.gender === 'female') parts.push('仅女宾');
  if (i.gender === 'male') parts.push('仅男宾');
  return parts.join(' · ');
}

function rowsOf(d: MpPrices, key: string): { rows: Row[]; tiers: string } {
  if (key === 'tickets') {
    return {
      tiers: '12 小时 · 24 小时',
      rows: d.tickets.map((t, n) => ({
        key: 't' + n,
        name: t.name,
        meta: t.note,
        intro: '',
        image: '',
        cells: [
          { label: '12 小时', value: priceText(t.price12h) },
          { label: '24 小时', value: priceText(t.price24h) },
        ],
      })),
    };
  }
  const items = d.items.filter((i) => 'cat:' + i.category === key);
  // 这一类用到的档位（标准、专业、优选，按这个顺序）
  const tiers = TIERS.filter((t) => items.some((i) => i.prices.some((p) => p.tier === t)));
  return {
    tiers: tiers.length > 1 ? tiers.map((t) => TIER_LABELS[t]).join(' · ') : '',
    rows: items.map((i) => ({
      key: 'i' + i.id,
      name: i.name,
      meta: itemMeta(i),
      intro: i.intro,
      image: i.imageId ? imageUrl(i.imageId) : '',
      cells: tiers.map((t) => {
        const p = i.prices.filter((x) => x.tier === t)[0];
        return { label: tiers.length > 1 ? TIER_LABELS[t] : '', value: p ? priceText(p.price) : '—' };
      }),
    })),
  };
}

Page({
  data: {
    status: 'loading' as 'loading' | 'ready' | 'error',
    message: '',
    stale: false,
    tabs: [] as Tab[],
    tab: '',
    title: '',
    tiers: '',
    rows: [] as Row[],
  },
  prices: null as MpPrices | null,

  onLoad() {
    this.load();
  },

  onShow() {
    // 首页的 TASTE、WELLNESS 跳过来时打开对应的分类
    const want = appData().pricesTab;
    appData().pricesTab = null;
    if (want) this.wanted = want;
    if (this.prices && this.wanted) {
      const key = resolveTab(this.data.tabs, this.wanted);
      this.wanted = null;
      if (key) this.pick(key);
    }
  },
  wanted: null as string | null,

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (!this.prices) this.setData({ status: 'loading' });
    try {
      const { data, stale } = await show<MpPrices>('/v1/prices');
      this.prices = data;
      const tabs = tabsOf(data);
      const wanted = resolveTab(tabs, this.wanted);
      this.wanted = null;
      const keep = tabs.some((t) => t.key === this.data.tab) ? this.data.tab : '';
      const key = wanted || keep || (tabs[0] ? tabs[0].key : '');
      this.setData({ status: tabs.length ? 'ready' : 'error', message: tabs.length ? '' : '价目表正在整理，请到前台咨询', stale, tabs });
      if (key) this.pick(key);
    } catch (e) {
      if (this.prices) wx.showToast({ title: messageOf(e), icon: 'none' });
      else this.setData({ status: 'error', message: messageOf(e) });
    }
  },

  pick(key: string) {
    if (!this.prices) return;
    const tab = this.data.tabs.filter((t) => t.key === key)[0];
    const { rows, tiers } = rowsOf(this.prices, key);
    this.setData({ tab: key, title: tab ? tab.label : '', tiers, rows });
  },

  onTab(e: WechatMiniprogram.TouchEvent) {
    this.pick(String(e.currentTarget.dataset.key));
  },

  onImage(e: WechatMiniprogram.TouchEvent) {
    const src = String(e.currentTarget.dataset.src);
    wx.previewImage({ urls: [src], current: src });
  },

  onShareAppMessage() {
    return { title: '汤崎 TOUCHILL · 价目表', path: '/pages/prices/index' };
  },
});
