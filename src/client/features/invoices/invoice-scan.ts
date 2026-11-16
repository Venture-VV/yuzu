// 8.0.21 发票识别（docs/FINANCE_V8021.md 第 2 节，CW-A / CW1）：全部在浏览器本机做，图片、PDF 不传给任何第三方。
//   1. PDF：用 pdf.js 取第一页的文字（数电票 PDF 里就是文字，不用识别），再画成图找二维码；
//   2. 图片：画到画布上找二维码（系统自带的 BarcodeDetector，没有就用 jsQR；整张找不到再放大左上角找）；
//   3. 二维码、PDF 文字都没有，才用管家部那套本机文字识别（tesseract，资源随构建带着，按需加载）。
// 识别结果只是填进表单，每一格标「识别」，人核对后才能保存。

import { parseInvoiceQr, parseInvoiceText, type RecognizedInvoice } from '@shared/invoice-recognize';

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: 'dontInvert' | 'attemptBoth' }) => { data: string } | null;

let detector: Detector | null | undefined;
async function nativeDetector(): Promise<Detector | null> {
  if (detector !== undefined) return detector;
  detector = null;
  const BD = (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (BD) {
    try {
      const formats = (await BD.getSupportedFormats?.()) ?? ['qr_code'];
      if (formats.includes('qr_code')) detector = new BD({ formats: ['qr_code'] });
    } catch {
      detector = null;
    }
  }
  return detector;
}

/** 在画布的一块（默认整张）里找二维码 */
async function decodeQr(canvas: HTMLCanvasElement, area?: { x: number; y: number; w: number; h: number }): Promise<string | null> {
  const a = area ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  // 小的一块放大到 1200 像素再找（票面上的二维码只有 2 厘米左右）
  const scale = Math.min(3, 1200 / Math.max(a.w, a.h));
  const work = document.createElement('canvas');
  work.width = Math.max(1, Math.round(a.w * scale));
  work.height = Math.max(1, Math.round(a.h * scale));
  const g = work.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, a.x, a.y, a.w, a.h, 0, 0, work.width, work.height);
  const native = await nativeDetector();
  if (native) {
    try {
      const found = await native.detect(work);
      const hit = found.find((f) => parseInvoiceQr(f.rawValue));
      if (hit) return hit.rawValue;
    } catch {
      /* 交给 jsQR */
    }
  }
  const jsQr = (await import('jsqr')).default as unknown as JsQr;
  const img = g.getImageData(0, 0, work.width, work.height);
  return jsQr(img.data, work.width, work.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

async function findQr(canvas: HTMLCanvasElement): Promise<RecognizedInvoice | null> {
  const w = canvas.width;
  const h = canvas.height;
  // 增值税发票的二维码在左上角；数电票在左上角，有的版式在右上角
  for (const area of [undefined, { x: 0, y: 0, w: w * 0.4, h: h * 0.45 }, { x: w * 0.6, y: 0, w: w * 0.4, h: h * 0.45 }]) {
    const raw = await decodeQr(canvas, area).catch(() => null);
    const parsed = raw ? parseInvoiceQr(raw) : null;
    if (parsed) return parsed;
  }
  return null;
}

async function imageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('这张图片打不开：请用 JPG、PNG 或 PDF');
  });
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('浏览器不支持画布，识别不了');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function pdfFirstPage(file: File): Promise<{ canvas: HTMLCanvasElement; text: string }> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('');
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('浏览器不支持画布，识别不了');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: g, viewport }).promise;
    return { canvas, text };
  } finally {
    void task.destroy();
  }
}

async function ocrText(canvas: HTMLCanvasElement, onProgress: (message: string) => void): Promise<string> {
  const { loadLocalTesseract } = await import('../concierge/receipt-ocr');
  onProgress('正在加载本机识别引擎（第一次要下载几十兆）');
  const T = await loadLocalTesseract();
  const origin = window.location.origin;
  const worker = await T.createWorker(['chi_sim', 'eng'], 1, {
    workerPath: `${origin}/concierge/ocr/worker.min.js`,
    corePath: `${origin}/concierge/ocr/core`,
    langPath: `${origin}/concierge/ocr/lang`,
    workerBlobURL: false,
    logger: (e) => {
      if (e.status === 'recognizing text') onProgress(`正在识别票面文字 ${Math.round(e.progress * 100)}%`);
    },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO, preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const { data } = await worker.recognize(canvas);
    return (data as { text?: string }).text ?? '';
  } finally {
    void worker.terminate();
  }
}

/** 识别一张发票（图片或 PDF）：认不出抛错，错误信息直接给人看 */
export async function recognizeInvoiceFile(file: File, onProgress: (message: string) => void = () => undefined): Promise<RecognizedInvoice> {
  if (file.size > 15 * 1024 * 1024) throw new Error('文件超过 15MB，请拍近一点或换一份');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  onProgress(isPdf ? '正在读 PDF' : '正在找二维码');
  const { canvas, text } = isPdf ? await pdfFirstPage(file) : { canvas: await imageToCanvas(file), text: '' };
  const fromText = text ? parseInvoiceText(text) : null;
  const qr = await findQr(canvas);
  if (qr) {
    // 二维码给号码、日期、不含税金额；PDF 文字补上价税合计、税额、开票方
    return {
      ...(fromText ?? {}),
      ...qr,
      method: 'qr',
      ...(fromText?.totalCents !== undefined ? { totalCents: fromText.totalCents } : {}),
      ...(fromText?.taxCents !== undefined ? { taxCents: fromText.taxCents } : {}),
    };
  }
  if (fromText) return fromText;
  onProgress('没找到二维码，改用文字识别');
  const ocr = parseInvoiceText(await ocrText(canvas, onProgress));
  if (!ocr) throw new Error('没认出发票号码、日期与金额：请拍正、拍清楚整张票面，或者手填');
  return ocr;
}
