// 负责人扫码：手机相机读二维码。有 BarcodeDetector（安卓 Chrome）就用它，没有（iPhone）就用 jsQR 逐帧识别；
// 也能从相册选一张饭卡码的截图识别（同样要联网交给门店系统核对，截图过了一分半钟就作废）。

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

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

type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) => { data: string } | null;
let jsQr: Promise<JsQr> | null = null;
// 下载失败（例如第一次扫码时刚好断网）不记住失败：下一帧、下一次再试
const loadJsQr = () =>
  (jsQr ??= import('jsqr').then(
    (m) => (m.default ?? m) as unknown as JsQr,
    (error: unknown) => {
      jsQr = null;
      throw error;
    },
  ));

/** 打开扫码页时（还联网）就把 jsQR 取下来：离线外壳会缓存它，之后断网也能识别 */
export function preloadDecoder() {
  void loadJsQr().catch(() => undefined);
}

/** 从画面（视频帧或图片）读一个二维码：先用系统自带的，再用 jsQR */
async function decodeFrom(source: CanvasImageSource, width: number, height: number, canvas: HTMLCanvasElement, maxSide: number): Promise<string | null> {
  const native = await nativeDetector();
  if (native) {
    try {
      const found = await native.detect(source);
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch {
      /* 交给 jsQR */
    }
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(source, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  return (await loadJsQr())(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

export class CameraError extends Error {
  constructor(
    readonly kind: 'insecure' | 'denied' | 'missing' | 'other',
    message: string,
  ) {
    super(message);
  }
}

/** 打开后置相机，把识别到的文字交给 onText（同一个码 2.5 秒内只报一次）；返回停止函数 */
export async function startScanner(video: HTMLVideoElement, onText: (text: string) => void): Promise<() => void> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('insecure', '相机要在 https 地址下才能用：请用管理员给的 https 网址打开柚子饭堂');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', '没有相机权限：请在浏览器设置里允许柚子饭堂使用相机，再点「开始扫码」');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('missing', '没找到可用的相机');
    throw new CameraError('other', '相机打不开，可以先用「从相册选」或「手动登记」');
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  await video.play().catch(() => undefined);
  const canvas = document.createElement('canvas');
  let stopped = false;
  let last = { text: '', at: 0 };
  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const text = await decodeFrom(video, video.videoWidth, video.videoHeight, canvas, 720);
        if (text && !(text === last.text && Date.now() - last.at < 2500)) {
          last = { text, at: Date.now() };
          onText(text);
        }
      } catch {
        /* 这一帧读不了，下一帧再试 */
      }
    }
    if (!stopped) setTimeout(() => void tick(), 180);
  };
  void tick();
  return () => {
    stopped = true;
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
}

/** 从相册选的图片里读二维码 */
export async function decodeImageFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    return await decodeFrom(bitmap, bitmap.width, bitmap.height, document.createElement('canvas'), 1400);
  } finally {
    bitmap.close();
  }
}
