// UI 工作台的素材（8.1.1，docs/WORKBENCH_V811.md 第 3、5 节，GZ10）：PNG、JPG、WebP、SVG，单张最大 5 MB；按内容的 SHA-256 存、
// 同一张只存一份（全公司共用，只追加）。
//
// 只认真的图片：按文件头认格式（不信文件名、不信页面报的类型）。SVG 不改写、只把关：里面有脚本、事件属性、外部链接、
// 内嵌网页（foreignObject、iframe……）的一律不收，请设计师导出时选「不含脚本」再传；送出去时再加上禁止脚本的
// Content-Security-Policy（直接打开地址也跑不了脚本），平板上只当 <img> 用（<img> 里的 SVG 本来就不跑脚本）。

import { createHash } from 'node:crypto';
import { badRequest, unprocessable } from '../../lib/errors';

export const STUDIO_ASSET_MAX = 5 * 1024 * 1024;
export type StudioAssetMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

export interface ParsedAsset {
  id: string;
  mime: StudioAssetMime;
  bytes: Buffer;
  width: number | null;
  height: number | null;
}

const SVG_FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /<\s*script\b/i, why: '脚本（script）' },
  { re: /<\s*(foreignObject|iframe|embed|object|audio|video|handler|listener)\b/i, why: '内嵌的网页或媒体' },
  { re: /\son[a-z]+\s*=/i, why: '事件属性（onload 之类）' },
  { re: /javascript\s*:/i, why: 'javascript: 链接' },
  { re: /(xlink:)?href\s*=\s*["']\s*(?!#)/i, why: '外部链接（href 只能指向图里自己的 #编号）' },
  { re: /url\(\s*["']?\s*(?!#)/i, why: '外部的 url()' },
  { re: /@import/i, why: '@import' },
  { re: /<!ENTITY/i, why: '实体声明（ENTITY）' },
];

/** PNG：IHDR 里的宽高 */
function pngSize(b: Buffer): [number, number] | null {
  return b.length >= 24 && b.toString('ascii', 12, 16) === 'IHDR' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}

/** JPEG：找到 SOF 段读宽高 */
function jpegSize(b: Buffer): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return null;
}

/** WebP：VP8 / VP8L / VP8X 三种头 */
function webpSize(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  return null;
}

/** SVG：viewBox 或 width / height（只认数字） */
function svgSize(text: string): [number, number] | null {
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(text);
  if (vb) return [Math.round(Number(vb[1])), Math.round(Number(vb[2]))];
  const w = /\swidth\s*=\s*["']\s*([\d.]+)(px)?\s*["']/i.exec(text);
  const h = /\sheight\s*=\s*["']\s*([\d.]+)(px)?\s*["']/i.exec(text);
  return w && h ? [Math.round(Number(w[1])), Math.round(Number(h[1]))] : null;
}

/** 认格式、核大小、量宽高、算摘要；不是图片或不合要求的拒绝 */
export function parseStudioAsset(base64: string): ParsedAsset {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw badRequest('图片内容不对（要 Base64）');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw badRequest('图片是空的');
  if (bytes.length > STUDIO_ASSET_MAX) throw unprocessable('ASSET_TOO_LARGE', '图片最大 5 MB：压缩一下再传');
  let mime: StudioAssetMime;
  let size: [number, number] | null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mime = 'image/png';
    size = pngSize(bytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = 'image/jpeg';
    size = jpegSize(bytes);
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp';
    size = webpSize(bytes);
  } else {
    const text = bytes.toString('utf8');
    if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) {
      throw unprocessable('ASSET_TYPE', '只收 PNG、JPG、WebP、SVG 图片');
    }
    const bad = SVG_FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.why);
    if (bad.length) throw unprocessable('ASSET_SVG_UNSAFE', `这张 SVG 里有${bad.join('、')}，不能用：设计软件导出时选「不含脚本 / 不内嵌链接」再传，或者导出成 PNG`);
    mime = 'image/svg+xml';
    size = svgSize(text);
  }
  const valid = size && size[0] > 0 && size[1] > 0 && size[0] < 100_000 && size[1] < 100_000 ? size : null;
  return { id: createHash('sha256').update(bytes).digest('hex'), mime, bytes, width: valid?.[0] ?? null, height: valid?.[1] ?? null };
}

/** 送图时的响应头：长期缓存（内容不会变）；SVG 加上禁止脚本的 CSP */
export function assetHeaders(mime: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': mime, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  if (mime === 'image/svg+xml') h['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
  return h;
}
