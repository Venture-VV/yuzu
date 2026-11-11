/** Optional device-local Chinese name recognition. No receipt data is uploaded. */
type Box = { x0: number; y0: number; x1: number; y1: number };
type Page = {
  blocks?: Array<{
    paragraphs?: Array<{
      lines?: Array<{
        text: string;
        bbox: Box;
        words?: Array<{ text: string; bbox: Box }>;
      }>;
    }>;
  }>;
};
type Region = { top: number; bottom: number; quantityLeft: number };
export type ReceiptNameJob = {
  id: string;
  itemIndex: number;
  source: string;
  rectangle: { left: number; top: number; width: number; height: number };
};
export type ReceiptNameLine = ReceiptNameJob & {
  text: string;
  confidence: number;
};
type NamedItem = { name: string; rawText: string };

/** Each job is one printed text line; wrapped product names stay separate here. */
export function planReceiptNameLines(
  page: Page,
  region: Region,
  rows: Array<Box | undefined>,
  width: number,
  height: number,
): ReceiptNameJob[] {
  if (!rows.length || rows.some((row) => !row)) return [];
  const centers = rows.map((row) => (row!.y0 + row!.y1) / 2);
  const jobs: ReceiptNameJob[] = [];
  for (const line of (page.blocks || []).flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []),
  )) {
    const center = (line.bbox.y0 + line.bbox.y1) / 2;
    if (
      center < region.top ||
      center >= region.bottom ||
      /记入场|入场[:：]|手牌号/.test(line.text.replace(/\s/g, ""))
    )
      continue;
    const words = (line.words || []).filter(
      (word) => word.bbox.x0 < region.quantityLeft - 5,
    );
    if (!words.length) continue;
    let itemIndex = centers.findIndex(
      (value, index) =>
        center <
        (index < centers.length - 1
          ? (value + centers[index + 1]!) / 2
          : region.bottom),
    );
    if (itemIndex < 0) itemIndex = centers.length - 1;
    const left = Math.max(
      0,
      Math.floor(Math.min(...words.map((word) => word.bbox.x0))) - 4,
    );
    const right = Math.min(
      width,
      region.quantityLeft - 5,
      Math.ceil(Math.max(...words.map((word) => word.bbox.x1))) + 4,
    );
    const top = Math.max(0, Math.floor(line.bbox.y0) - 4),
      bottom = Math.min(height, Math.ceil(line.bbox.y1) + 4);
    if (right - left < 8 || bottom - top < 8) continue;
    jobs.push({
      id: `name-${jobs.length}`,
      itemIndex,
      source: words.map((word) => word.text).join(""),
      rectangle: { left, top, width: right - left, height: bottom - top },
    });
  }
  return jobs.slice(0, 120);
}

/** Apply names only. Amounts, quantities and row count are never changed. */
export function applyReceiptNameLines(
  items: NamedItem[],
  lines: ReceiptNameLine[],
): string[] {
  const groups = items.map(() => [] as ReceiptNameLine[]);
  for (const line of lines) {
    let index = line.itemIndex;
    if (
      index > 0 &&
      /^限.{0,12}(?:食|用|饮|只|份)/.test(line.text.replace(/\s/g, "")) &&
      !/\d+\.\d{2}/.test(line.text)
    )
      index--;
    if (groups[index]!) groups[index]!.push(line);
  }
  const warnings: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const group = groups[index]!;
    if (!group.length) continue;
    const previous = items[index]!.name;
    const accepted = group.filter(
      (line) =>
        line.text.trim() &&
        Number.isFinite(line.confidence) &&
        line.confidence >= 0.5,
    );
    let candidate = accepted.map((line) => line.text.trim()).join("");
    if (/^[-－]/.test(previous) && candidate && !/^[-－]/.test(candidate))
      candidate = `-${candidate}`;
    const scores = group.map((line) => line.confidence),
      mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const uncertain =
      accepted.length !== group.length ||
      mean < 0.82 ||
      Math.min(...scores) < 0.65;
    if (candidate && /[\u3400-\u9fffA-Za-z]/.test(candidate))
      items[index]!.name = candidate;
    else
      warnings.push(
        `第${index + 1}项名称增强未可靠识别，已保留首次名称，请对照原图核对。`,
      );
    if (uncertain)
      warnings.push(
        `第${index + 1}项名称识别不确定，请对照原图核对名称或从项目库选择。`,
      );
    items[index]!.rawText +=
      `\n首次名称识别：${previous}\n本机中文名称识别：${candidate || "未可靠识别"}\n名称识别原行：\n${group.map((line) => `${line.source} → ${line.text || "未识别"}（${Math.round(line.confidence * 100)}%）`).join("\n")}`;
  }
  return warnings;
}

export class ReceiptNameOcrSession {
  private worker: Worker | undefined;
  private initialized: Promise<void> | undefined;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sequence = 0;
  private closed = false;
  private totalLines = 0;

  private fail(message: string) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = undefined;
  }
  private call(
    action: string,
    payload: Record<string, unknown>,
    milliseconds: number,
    transfer: Transferable[] = [],
  ): Promise<any> {
    if (this.closed || !this.worker)
      return Promise.reject(new Error("本机中文名称识别不可用"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("本机中文名称识别超时，已保留首次识别名称"),
        milliseconds,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker!.postMessage({ id, action, ...payload }, transfer);
      } catch {
        this.fail("当前浏览器无法启动本机中文名称识别");
      }
    });
  }
  private initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      if (typeof Worker === "undefined")
        throw new Error("当前浏览器不支持本机中文名称增强");
      this.worker = new Worker(
        new URL("/concierge/ocr/name-worker.js", window.location.origin).href,
      );
      this.worker.onmessage = (event) => {
        const response = event.data as {
          id?: number;
          error?: string;
          result?: unknown;
        };
        const pending = this.pending.get(response.id || 0);
        if (!pending) return;
        this.pending.delete(response.id!);
        clearTimeout(pending.timer);
        if (response.error) {
          pending.reject(new Error(response.error));
          this.fail(response.error);
        } else pending.resolve(response.result);
      };
      this.worker.onerror = () =>
        this.fail("本机中文名称引擎加载失败，已保留首次识别名称");
      await this.call("init", {}, 45000);
    })();
    return this.initialized;
  }
  async recognize(
    canvas: HTMLCanvasElement,
    jobs: ReceiptNameJob[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ReceiptNameLine[]> {
    if (!jobs.length) return [];
    await this.initialize();
    const started = Date.now(),
      lines: ReceiptNameLine[] = [];
    for (const job of jobs) {
      if (++this.totalLines > 240 || Date.now() - started > 90000)
        throw new Error("本次名称行数或识别时间过长，已保留首次识别名称");
      const rectangle = job.rectangle,
        ratio = rectangle.width / rectangle.height;
      if (ratio > 2048 / 48)
        throw new Error("项目名称行过长，请分段拍摄或核对首次识别名称");
      const paddedWidth = Math.max(320, Math.floor(48 * ratio)),
        resizedWidth = Math.min(paddedWidth, Math.ceil(48 * ratio));
      const crop = document.createElement("canvas");
      crop.width = resizedWidth;
      crop.height = 48;
      const context = crop.getContext("2d");
      if (!context) throw new Error("当前浏览器无法处理项目名称图片");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, resizedWidth, 48);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        canvas,
        rectangle.left,
        rectangle.top,
        rectangle.width,
        rectangle.height,
        0,
        0,
        resizedWidth,
        48,
      );
      const rgba = context.getImageData(0, 0, resizedWidth, 48).data;
      crop.width = 0;
      crop.height = 0;
      const result = await this.call(
        "line",
        { width: resizedWidth, paddedWidth, rgba: rgba.buffer },
        12000,
        [rgba.buffer],
      );
      if (
        typeof result?.text !== "string" ||
        !Number.isFinite(result.confidence)
      )
        throw new Error("本机中文名称结果不完整");
      lines.push({
        ...job,
        text: result.text.slice(0, 500),
        confidence: Math.max(0, Math.min(1, result.confidence)),
      });
      onProgress?.(lines.length, jobs.length);
    }
    return lines;
  }
  async dispose() {
    if (this.closed) return;
    try {
      if (this.worker) await this.call("release", {}, 3000);
    } catch {
      /* Terminating this dedicated worker also frees its WASM memory. */
    } finally {
      this.fail("本机中文名称识别已结束");
    }
  }
}
