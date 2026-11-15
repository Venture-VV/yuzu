// UI 工作台编辑器、样例截图里手机界面的功能块（8.1.2）。
//
// 小程序的功能块（版头大图、门店信息、会员卡）由小程序线在小程序里画（真实数据、带逻辑，docs/STUDIO_MP.md 第 4 节）；
// 这里画一个照小程序现在的样子的示意（大小、颜色跟版面里的属性走），让设计师看得出放在哪、多大、什么颜色。

import type { CSSProperties, ReactNode } from 'react';
import { colorValue, type StudioBlockNode, type StudioSurfaceDef } from '@shared/studio';

const propColor = (surface: StudioSurfaceDef, v: unknown, fallback: string) => colorValue(typeof v === 'string' && v !== 'auto' ? v : fallback, surface.cssVar);
const eyebrow: CSSProperties = { fontFamily: 'var(--mp-en)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase' };
const tag: CSSProperties = { position: 'absolute', left: 8, top: 8, padding: '2px 6px', borderRadius: 4, background: 'rgb(0 0 0 / 0.38)', color: '#fff', fontSize: 10, lineHeight: '14px' };

function MpBanner({ node, surface }: { node: StudioBlockNode; surface: StudioSurfaceDef }) {
  const shade = typeof node.props.shade === 'number' ? node.props.shade : 0.2;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', color: colorValue('$cardInk', surface.cssVar), background: 'radial-gradient(90% 70% at 78% 18%, rgba(235, 222, 202, 0.42) 0%, rgba(235, 222, 202, 0) 62%), linear-gradient(168deg, #8e6c4f 0%, #54402f 100%)' }}>
      <div style={{ position: 'absolute', inset: 0, background: `rgb(0 0 0 / ${shade})` }} />
      {node.props.wordmark !== false && (
        <div style={{ position: 'absolute', left: 18, right: 18, bottom: 22 }}>
          <div style={{ fontSize: 30, fontWeight: 600, lineHeight: '34px', letterSpacing: '0.2em' }}>汤崎</div>
          <div style={{ ...eyebrow, fontSize: 9, letterSpacing: '0.32em', marginTop: 6 }}>TOUCHILL</div>
          <div style={{ width: 32, height: 1, margin: '14px 0 11px', background: colorValue('$cardMuted', surface.cssVar) }} />
          <div style={{ fontSize: 17, fontWeight: 500, letterSpacing: '0.1em' }}>都市新旅生活目的地</div>
          <div style={{ ...eyebrow, fontSize: 9, letterSpacing: '0.24em', marginTop: 3 }}>YOUR NEXT URBAN PLEASURE</div>
        </div>
      )}
      <span style={tag}>版头大图：小程序后台配的轮播图{node.props.autoplay === false ? '（不自动轮播）' : ''}</span>
    </div>
  );
}

function MpStore({ node, surface }: { node: StudioBlockNode; surface: StudioSurfaceDef }) {
  const muted = colorValue('$muted', surface.cssVar);
  const fact = (k: string, v: string) => (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderTop: `1px solid ${colorValue('$line', surface.cssVar)}`, fontSize: 13, lineHeight: '19px' }}>
      <span style={{ width: 56, flex: 'none', color: muted }}>{k}</span>
      <span style={{ flex: 1 }}>{v}</span>
    </div>
  );
  const button = (label: string) => (
    <div style={{ flex: 1, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${colorValue('$ink', surface.cssVar)}`, borderRadius: 4, fontSize: 13, fontWeight: 600 }}>{label}</div>
  );
  return (
    <div style={{ padding: '20px 18px 8px' }}>
      <div style={{ position: 'relative', padding: '16px 16px 12px', borderRadius: 8, background: propColor(surface, node.props.card, '$surface') }}>
        <div style={{ ...eyebrow, color: muted }}>Store</div>
        <div style={{ fontSize: 18, fontWeight: 600, lineHeight: '26px', margin: '2px 0 10px' }}>汤崎·前海店</div>
        {fact('营业时间', '10:00–次日 02:00')}
        {fact('地址', '深圳市南山区前海路 88 号')}
        {fact('电话', '0755-8888 0000')}
        {node.props.buttons !== false && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            {button('导航到店')}
            {button('拨打电话')}
          </div>
        )}
        <span style={{ ...tag, left: 'auto', right: 8 }}>门店信息（小程序取真实数据）</span>
      </div>
    </div>
  );
}

function MpMemberCard({ node, surface }: { node: StudioBlockNode; surface: StudioSurfaceDef }) {
  const ink = propColor(surface, node.props.ink, '$cardInk');
  return (
    <div style={{ padding: '20px 18px 4px' }}>
      <div
        style={{
          position: 'relative',
          height: 176,
          padding: '20px 20px 18px',
          borderRadius: 12,
          color: ink,
          background: `linear-gradient(135deg, ${propColor(surface, node.props.from, '$cardA')} 0%, ${propColor(surface, node.props.to, '$cardB')} 100%)`,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ ...eyebrow, fontSize: 10, opacity: 0.8 }}>Member</div>
        <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>金卡会员 · 林女士</div>
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, opacity: 0.8 }}>储值余额</div>
            <div style={{ fontFamily: 'var(--mp-en)', fontSize: 24, fontWeight: 600 }}>¥1,280.00</div>
          </div>
          <div style={{ fontSize: 13 }}>会员码 ›</div>
        </div>
        <span style={{ ...tag, left: 'auto', right: 8 }}>会员卡（小程序取真实数据）</span>
      </div>
    </div>
  );
}

/** 手机界面的功能块在编辑器、样例截图里怎么画 */
export function phoneEditorBlocks(surface: StudioSurfaceDef): Record<string, (n: StudioBlockNode) => ReactNode> {
  if (surface.key === 'mp') {
    return {
      'mp.banner': (n) => <MpBanner node={n} surface={surface} />,
      'mp.store': (n) => <MpStore node={n} surface={surface} />,
      'mp.memberCard': (n) => <MpMemberCard node={n} surface={surface} />,
    };
  }
  return {};
}
