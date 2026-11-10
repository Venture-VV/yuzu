import { useMemo } from 'react';
import { qrShape } from '@shared/qr-svg';

/** 圆角小方块的二维码；三个定位角用 eye 颜色画成圆角方框 */
export function QrCode({ text, className, color = '#3B2F2A', eye = '#24493A', label }: { text: string; className?: string; color?: string; eye?: string; label?: string }) {
  const shape = useMemo(() => qrShape(text), [text]);
  const pad = 2;
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${shape.size + pad * 2} ${shape.size + pad * 2}`}
      className={className}
      role="img"
      aria-label={label ?? '二维码'}
      data-qr={text}
      shapeRendering="geometricPrecision"
    >
      <rect x={-pad} y={-pad} width={shape.size + pad * 2} height={shape.size + pad * 2} fill="#fff" rx="2.5" />
      <path d={shape.modules} fill={color} />
      {shape.eyes.map((e) => (
        <g key={`${e.x}-${e.y}`}>
          <rect x={e.x + 0.5} y={e.y + 0.5} width="6" height="6" rx="1.8" fill="none" stroke={eye} strokeWidth="1" />
          <rect x={e.x + 2} y={e.y + 2} width="3" height="3" rx="0.9" fill={eye} />
        </g>
      ))}
    </svg>
  );
}
