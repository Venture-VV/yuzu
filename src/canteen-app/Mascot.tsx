// 吉祥物「柚柚」：一颗圆滚滚的柚子，顶着一片叶子。表情：开心、好吃、困了（不在开饭时间）、哎呀（出错）、眨眼。
// 纯 SVG，随页面一起打包，离线也能显示。

export type Mood = 'happy' | 'yum' | 'sleepy' | 'oops' | 'wink';

export function Mascot({ mood = 'happy', className, title }: { mood?: Mood; className?: string; title?: string }) {
  const eyes = (() => {
    if (mood === 'sleepy') {
      return (
        <g stroke="#3B2F2A" strokeWidth="2.6" strokeLinecap="round" fill="none">
          <path d="M41 63q5 4 10 0" />
          <path d="M69 63q5 4 10 0" />
        </g>
      );
    }
    const left =
      mood === 'wink' ? (
        <path d="M41 63q5-4 10 0" stroke="#3B2F2A" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      ) : (
        <g>
          <ellipse cx="46" cy="62" rx={mood === 'oops' ? 3.6 : 4.4} ry={mood === 'oops' ? 3.6 : 5.2} fill="#3B2F2A" />
          <circle cx="47.6" cy="59.8" r="1.5" fill="#fff" />
        </g>
      );
    return (
      <>
        {left}
        <ellipse cx="74" cy="62" rx={mood === 'oops' ? 3.6 : 4.4} ry={mood === 'oops' ? 3.6 : 5.2} fill="#3B2F2A" />
        <circle cx="75.6" cy="59.8" r="1.5" fill="#fff" />
      </>
    );
  })();
  const mouth = (() => {
    switch (mood) {
      case 'yum':
        return (
          <g>
            <path d="M52.5 70.5q7.5 11 15 0z" fill="#8B3A2E" />
            <ellipse cx="60" cy="75.4" rx="3.6" ry="2.2" fill="#FF8E8E" />
          </g>
        );
      case 'sleepy':
        return <ellipse cx="60" cy="74" rx="2.6" ry="2" fill="#8B3A2E" />;
      case 'oops':
        return <ellipse cx="60" cy="74" rx="3.4" ry="4" fill="#8B3A2E" />;
      default:
        return <path d="M53.5 71.5q6.5 6.5 13 0" stroke="#3B2F2A" strokeWidth="2.6" strokeLinecap="round" fill="none" />;
    }
  })();
  return (
    <svg viewBox="0 0 120 120" className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <radialGradient id="yy-body" cx="0.38" cy="0.32" r="0.75">
          <stop offset="0" stopColor="#FFE07A" />
          <stop offset="0.6" stopColor="#FFC93C" />
          <stop offset="1" stopColor="#F5A623" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="109" rx="30" ry="5" fill="#3B2F2A" opacity=".08" />
      {/* 身体：圆里带一点凹凸 */}
      <path
        d="M60 25c11 0 20 3 27 9 7 6 12 15 13 25 1 11-2 21-9 29-7 8-18 14-31 14S36 96 29 88c-7-8-10-18-9-29 1-10 6-19 13-25 7-6 16-9 27-9z"
        fill="url(#yy-body)"
      />
      <g fill="#FFF3C4" opacity=".55">
        <circle cx="38" cy="45" r="1.4" />
        <circle cx="44" cy="38" r="1.1" />
        <circle cx="33" cy="54" r="1.1" />
        <circle cx="84" cy="44" r="1.2" />
        <circle cx="88" cy="53" r="1" />
        <circle cx="52" cy="35" r="1" />
      </g>
      <ellipse cx="44" cy="42" rx="9" ry="5" fill="#fff" opacity=".35" transform="rotate(-25 44 42)" />
      {/* 叶子与梗 */}
      <path d="M59 28c-.5-3 0-6 1.6-8.5" stroke="#8B5E3C" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M61 24c4-10 15-14 26-11-3 10-14 15-26 11z" fill="#5DAE6B" />
      <path d="M63 23c6-4 13-6 20-7" stroke="#2F7D3E" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity=".7" />
      {/* 脸 */}
      {eyes}
      <ellipse cx="37" cy="72" rx="6.2" ry="3.6" fill="#FF8E7A" opacity=".5" />
      <ellipse cx="83" cy="72" rx="6.2" ry="3.6" fill="#FF8E7A" opacity=".5" />
      {mouth}
      {mood === 'sleepy' && (
        <g fill="#6B5B53" fontFamily="system-ui, sans-serif" fontWeight="700">
          <text x="92" y="30" fontSize="11">z</text>
          <text x="100" y="20" fontSize="8">z</text>
        </g>
      )}
      {mood === 'oops' && <path d="M90 40c3 5 4 8 1.5 10s-6-1-4.5-4z" fill="#7CC6F2" />}
    </svg>
  );
}
