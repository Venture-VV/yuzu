// UI 工作台编辑器、样例截图里手机界面的功能块（8.1.2）。
//
// 小程序的功能块（版头大图、门店信息、会员卡）由小程序线在小程序里画（真实数据、带逻辑，docs/STUDIO_MP.md 第 4 节）；
// 这里画一个照小程序现在的样子的示意（大小、颜色跟版面里的属性走），让设计师看得出放在哪、多大、什么颜色。
// 员工食堂（8.1.2）的各段同样画示意：真实的样子在员工手机上看（预览码），颜色跟主题走。

import type { CSSProperties, ReactNode } from 'react';
import { colorValue, type StudioBlockNode, type StudioSurfaceDef } from '@shared/studio';

const propColor = (surface: StudioSurfaceDef, v: unknown, fallback: string) => colorValue(typeof v === 'string' && v !== 'auto' ? v : fallback, surface.cssVar);
const eyebrow: CSSProperties = { fontFamily: 'var(--mp-en)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase' };
const tag: CSSProperties = { position: 'absolute', left: 8, top: 8, padding: '2px 6px', borderRadius: 4, background: 'rgb(0 0 0 / 0.38)', color: '#fff', fontSize: 10, lineHeight: '14px' };

function MpBanner({ node, surface }: { node: StudioBlockNode; surface: StudioSurfaceDef }) {
  const shade = typeof node.props.shade === 'number' ? node.props.shade : 0.2;
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        color: colorValue('$cardInk', surface.cssVar),
        background: 'radial-gradient(90% 70% at 78% 18%, rgba(235, 222, 202, 0.42) 0%, rgba(235, 222, 202, 0) 62%), linear-gradient(168deg, #8e6c4f 0%, #54402f 100%)',
      }}
    >
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
    <div
      style={{
        flex: 1,
        height: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${colorValue('$ink', surface.cssVar)}`,
        borderRadius: 4,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {label}
    </div>
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

// ── 员工食堂（8.1.2）：各段在员工手机上由柚子饭堂画（真实的菜单、饭卡码、按岗位的入口）；这里画一个照现在样子的示意 ──

const cn = (token: string) => `var(--color-${token})`;
const cnCard: CSSProperties = { borderRadius: 20, background: cn('card'), boxShadow: '3px 3px 0 rgb(92 70 57 / 0.16)', border: `1px solid ${cn('line')}`, boxSizing: 'border-box' };
const cnTag: CSSProperties = { ...tag, top: 6, left: 'auto', right: 6 };

function CnPlaceholder({ height, label, children }: { height: number; label: string; children?: ReactNode }) {
  return (
    <div style={{ ...cnCard, position: 'relative', height, padding: '12px 16px', color: cn('ink'), fontSize: 15, fontWeight: 700 }}>
      {children}
      <span style={cnTag}>{label}</span>
    </div>
  );
}

function CnQr() {
  // 饭卡码：外圈倒计时（柚黄）、白底、深色点阵——大小、留白、颜色锁定
  const cells = Array.from({ length: 21 * 21 }, (_, i) => ((i * 7919) % 13 < 6 ? 1 : 0));
  return (
    <div
      style={{
        width: 330,
        borderRadius: 34,
        padding: 7,
        marginTop: 24,
        background: `conic-gradient(${cn('yuzu')} 260deg, ${cn('yuzu-soft')} 0deg)`,
        boxShadow: '0 16px 40px -18px rgb(92 70 57 / 0.55)',
      }}
    >
      <div style={{ position: 'relative', borderRadius: 27, background: '#fff', padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(21, 1fr)', gap: 1, aspectRatio: '1 / 1' }}>
          {cells.map((c, i) => (
            <span key={i} style={{ background: c ? '#3B2F2A' : 'transparent', borderRadius: 2 }} />
          ))}
        </div>
        <span style={{ ...tag, top: 'auto', bottom: 8 }}>饭卡码：大小、留白、颜色锁定</span>
      </div>
    </div>
  );
}

function canteenBlocks(): Record<string, (n: StudioBlockNode) => ReactNode> {
  const eye: CSSProperties = { fontFamily: 'var(--font-en)', fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: cn('ink-3') };
  return {
    'cn.greeting': () => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: cn('ink') }}>
        <div style={{ flex: 1 }}>
          <div style={eye}>Yuzu Canteen · 汤崎</div>
          <div style={{ marginTop: 4, fontSize: 14, fontWeight: 700, color: cn('ink-2') }}>中午好，</div>
          <div style={{ fontSize: 26, fontWeight: 900 }}>林小柚</div>
        </div>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 999,
            background: cn('card'),
            border: `2px solid ${cn('wood-4')}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 30,
          }}
        >
          🍊
        </div>
      </div>
    ),
    'cn.notices': () => (
      <div style={{ position: 'relative', borderRadius: 16, padding: '10px 16px', background: '#dee7ee', color: cn('relax'), fontSize: 14, fontWeight: 700 }}>
        提示条（没网、菜单是上次的、要不要饭点提醒；没有时不占地方）
      </div>
    ),
    'cn.focusMeal': () => (
      <CnPlaceholder height={260} label="现在吃什么（真实菜单）">
        <div style={{ fontSize: 18, fontWeight: 900 }}>🍱 午餐 10:30–14:30</div>
        {['番茄炒蛋', '红烧排骨', '清炒时蔬'].map((d) => (
          <div key={d} style={{ marginTop: 14, fontSize: 16 }}>
            ● {d}
          </div>
        ))}
      </CnPlaceholder>
    ),
    'cn.codeButton': () => (
      <div
        style={{
          height: 56,
          borderRadius: 16,
          background: cn('yuzu'),
          color: cn('ink'),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 17,
          fontWeight: 700,
          boxShadow: '0 3px 0 rgb(92 70 57 / 0.25)',
        }}
      >
        🎫 亮出饭卡码
      </div>
    ),
    'cn.entries': () => (
      <CnPlaceholder height={64} label="按岗位显示">
        负责人：扫码打卡、柚子信箱；巡场的人：巡场打卡
      </CnPlaceholder>
    ),
    'cn.talk': () => (
      <CnPlaceholder height={96} label="跟柚子说">
        <div style={eye}>Talk to Yuzu</div>
        <div style={{ marginTop: 4, fontSize: 17, fontWeight: 900 }}>✉ 跟柚子说</div>
      </CnPlaceholder>
    ),
    'cn.today': () => (
      <CnPlaceholder height={200} label="今天的菜单（真实菜单）">
        <div style={{ fontSize: 15, fontWeight: 800, color: cn('ink-2') }}>今天的菜单</div>
        <div style={{ marginTop: 12 }}>🥣 早餐 07:00–10:00</div>
        <div style={{ marginTop: 12 }}>🍲 晚餐 17:00–20:00</div>
      </CnPlaceholder>
    ),
    'cn.footer': () => <div style={{ paddingTop: 8, textAlign: 'center', fontSize: 13, color: cn('ink-3') }}>这个月在饭堂吃了 12 顿 · 喜欢的菜记得点个赞</div>,
    'cn.profile': () => (
      <CnPlaceholder height={82} label="我的名片">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 32 }}>🍊</span>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900 }}>林小柚</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: cn('ink-2') }}>工号 A007 · 前厅部</div>
          </div>
        </div>
      </CnPlaceholder>
    ),
    'cn.qr': () => <CnQr />,
    'cn.codeHint': () => (
      <div style={{ marginTop: 24, textAlign: 'center', color: cn('ink') }}>
        <div style={{ fontSize: 18, fontWeight: 900 }}>给食堂负责人扫一扫</div>
        <div style={{ marginTop: 4, fontSize: 14, color: cn('ink-2') }}>30 秒后自动换码 · 截图没用哦</div>
        <div style={{ marginTop: 12, display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: '#e8e6d6', color: cn('organic'), fontSize: 13, fontWeight: 700 }}>✓ 已连上门店</div>
      </div>
    ),
    'cn.mascot': () => <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: cn('ink-3') }}>🍊 吃饱饱，下午才有力气呀</div>,
  };
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
  if (surface.key === 'canteen') return canteenBlocks();
  return {};
}
