// 管家部拍小票、选图压缩（8.1.3 从 Workspace.tsx 拆出来，内容没改）
import { loadReceipt } from "./api";
import { conciergeFetch as fetch } from "./api";

import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
  Camera,
  ImagePlus,
} from "lucide-react";
import type {
  Member,
  Receipt,
  Upload,
  CatalogItem,
} from "./types";
import { runReceiptOcr } from "./receipt-ocr";
import {
  applyDraftCatalog,
} from "./ReceiptExperience";
import type { ReceiptDraft } from "./ReceiptExperience";
import { Dialog, Field, amount, uid } from "./WorkspaceParts";

export async function prepareImages(files: File[]): Promise<File[]> {
  const result: File[] = [];
  for (const file of files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error(
        "目前支持JPEG、PNG、WebP图片。HEIC请先转换为JPEG后选择。",
      );
    if (file.size <= 4 * 1024 * 1024) {
      result.push(file);
      continue;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器无法处理图片，请改用JPEG截图。");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob || blob.size > 4 * 1024 * 1024)
        throw new Error("图片超过4MB，请分段拍摄或压缩后重试。");
      result.push(
        new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
          type: "image/jpeg",
        }),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (result.reduce((n, f) => n + f.size, 0) > 12 * 1024 * 1024)
    throw new Error("本次图片总量超过12MB，请减少页数或压缩后重试。");
  return result;
}

export function CaptureReceipt({
  catalog,
  members,
  memberId,
  onClose,
  onDone,
}: {
  catalog: CatalogItem[];
  members: Member[];
  memberId: string;
  onClose: () => void;
  onDone: (draft: ReceiptDraft) => void;
}) {
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState(memberId);
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploaded, setUploaded] = useState<Upload[]>([]);
  const [raw, setRaw] = useState<ReceiptDraft | null>(null);
  const prepared = useRef<File[]>([]);
  const requestId = useRef("");
  const draftRef = useRef<Receipt | null>(null);
  const resultRef = useRef<ReceiptDraft | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  function close() {
    if (working) return;
    if (
      (files.length || uploaded.length) &&
      !confirm(
        "确定关闭拍单？已上传图片仍保存在服务器，未确认内容不会计入消费。",
      )
    )
      return;
    onClose();
  }
  function choose(list: FileList | null) {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    if (next.length > 4) {
      setError("每次最多4张，可将同一张长单分段拍摄。");
      return;
    }
    setFiles(next);
    setUploaded([]);
    setRaw(null);
    resultRef.current = null;
    setError("");
  }
  async function recognize() {
    if (working || !files.length) return;
    setWorking(true);
    setError("");
    try {
      let pages = prepared.current;
      let savedUploads = uploaded;
      if (!savedUploads.length) {
        setStage("正在准备与保存图片");
        setProgress(0);
        pages = await prepareImages(files);
        prepared.current = pages;
        const fd = new FormData();
        for (const f of pages) fd.append("files", f);
        fd.append("memberId", selected);
        const res = await fetch("/api/concierge/uploads", {
          method: "POST",
          body: fd,
        });
        const body = (await res.json()) as {
          uploads?: Upload[];
          error?: string;
        };
        if (!res.ok || !body.uploads?.length)
          throw new Error(body.error || "图片保存失败，请重试。");
        savedUploads = body.uploads;
        setUploaded(savedUploads);
      }
      const uploadIds = savedUploads.map((u) => u.id);
      requestId.current ||= uid();
      if (!draftRef.current) {
        setStage("正在保存可恢复草稿");
        const response = await fetch("/api/concierge/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "saveReceipt",
            requestId: requestId.current,
            payload: {
              memberId: selected,
              number: "",
              store: "",
              occurredAt: "",
              kind: "结算单",
              status: "待补全",
              amount: "",
              payments: [],
              itemsText: "",
              rawText: "",
              note: "照片已保存，等待识别与核对",
              uploadIds,
              originalReceiptId: "",
            },
          }),
        });
        const body = (await response.json()) as { id?: string; error?: string };
        if (!response.ok || !body.id)
          throw new Error(body.error || "草稿保存失败，图片已保留，请重试。");
        const saved = await loadReceipt(body.id);
        if (!saved) throw new Error("草稿已保存，但暂时未同步，请重试。");
        draftRef.current = saved;
      }
      setStage("图片与草稿已保存，正在加载本地识别");
      const result = await runReceiptOcr(
        pages,
        (p: number, message?: string) => {
          setProgress(p);
          setStage(message || "正在识别票面文字");
        },
      );
      const occurredAt =
        result.occurredAt &&
        !Number.isNaN(new Date(result.occurredAt).getTime())
          ? new Date(result.occurredAt).toISOString()
          : "";
      let draft: ReceiptDraft = {
        ...result,
        items: applyDraftCatalog(result.items || [], catalogRef.current),
        review: {
          mode: "exceptions",
          checkedIssueKeys: [],
          summaryConfirmed: false,
        },
        occurredAt,
        memberId: selected,
        uploadIds,
        receiptId: draftRef.current.id,
        version: draftRef.current.version,
      };
      resultRef.current = draft;
      const update = await fetch("/api/concierge/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveReceipt",
          requestId: uid(),
          payload: {
            id: draftRef.current.id,
            version: draftRef.current.version,
            memberId: selected,
            number: result.number || "",
            store: result.store || "",
            occurredAt,
            kind: "结算单",
            status: "待核对",
            amount: result.amount || "",
            payments: result.payments || [],
            items: draft.items || [],
            review: {
              mode: "exceptions",
              checkedIssueKeys: [],
              summaryConfirmed: false,
            },
            totals: result.totals || {},
            details: result.details || {},
            warnings: result.warnings || [],
            itemsReviewed: false,
            itemsText: result.itemsText || "",
            rawText: result.rawText || "",
            note: "本地识别草稿，待人工核对",
            uploadIds,
            originalReceiptId: "",
          },
        }),
      });
      const updated = (await update.json()) as { error?: string };
      if (!update.ok)
        throw new Error(
          updated.error || "识别草稿保存失败，原图与初始草稿已保留。",
        );
      const saved = await loadReceipt(draftRef.current!.id);
      if (saved) {
        draftRef.current = saved;
        draft = {
          ...draft,
          version: saved.version,
          payments: saved.payments.map((p) => ({
            method: p.method,
            amount: amount(p.amountCents),
            memberId: p.memberId,
            originalMethod: p.originalMethod || p.method,
          })),
          items: saved.items?.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unitPrice: amount(i.unitPriceCents),
            amount: amount(i.amountCents),
            rawText: i.rawText,
            ocrName: i.ocrName ?? i.name,
            catalogItemId: i.catalogItemId,
            packageIncluded: i.packageIncluded,
          })),
          review: saved.review || draft.review,
          totals: saved.totals
            ? {
                subtotal: amount(saved.totals.subtotalCents),
                due: amount(saved.totals.dueCents),
                rounding: amount(saved.totals.roundingCents),
                paid: amount(saved.totals.paidCents),
              }
            : draft.totals,
          details: saved.details || draft.details,
          warnings: saved.warnings || draft.warnings,
          itemsReviewed: saved.itemsReviewed,
        };
      }
      resultRef.current = draft;
      setRaw(draft);
      setProgress(1);
      setStage("识别草稿已保存，请核对关键字段");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "识别失败，可重试或直接核对图片。",
      );
    } finally {
      setWorking(false);
    }
  }
  useEffect(() => {
    if (raw && uploaded.length) {
      onDone({ ...raw, uploadIds: uploaded.map((u) => u.id) });
    }
  }, [raw, uploaded, onDone]);
  return (
    <Dialog
      title="拍摄消费单"
      subtitle="先保存照片，再识别为草稿；核对后才确认消费。"
      onClose={close}
    >
      <div className="modal-content capture-content">
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <Field label="关联会员（不确定可稍后选择）">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={working || !!uploaded.length}
          >
            <option value="">待核实会员</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} · {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="capture-upload">
          <Camera size={36} />
          <h3>拍清票头、项目明细和结算区</h3>
          <p>
            拍到每项名称、数量和金额；长单可分段并保留少量重叠。最多4张，JPEG /
            PNG / WebP。
          </p>
          <div className="capture-buttons">
            <label className={`btn btn-primary ${working ? "disabled" : ""}`}>
              <Camera size={17} />
              拍照
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                disabled={working || !!uploaded.length}
                onChange={(e) => {
                  choose(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="btn btn-secondary">
              <ImagePlus size={17} />
              选照片
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={working || !!uploaded.length}
                onChange={(e) => {
                  choose(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        {files.length > 0 && (
          <div className="capture-previews">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`}>
                <img src={previews[i]} alt={`消费凭证第${i + 1}页`} />
                <span>第{i + 1}页</span>
                {!working && !uploaded.length && (
                  <button
                    aria-label={`移除第${i + 1}页`}
                    onClick={() => {
                      setFiles(files.filter((_, n) => n !== i));
                      prepared.current = [];
                    }}
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {(working || uploaded.length > 0) && (
          <div className="ocr-progress">
            <div>
              <span>{stage || "图片已保存，可继续核对"}</span>
              <strong>{Math.round(progress * 100)}%</strong>
            </div>
            <progress value={progress} max={1} />
            <small>
              识别在当前浏览器进行；耗时取决于设备、页数和图片清晰程度。
            </small>
          </div>
        )}
        <div className="detail-notice">
          <ShieldCheck size={15} />
          识别不发起扣款，也不修改会员余额。无法识别的内容保留待核，不补成零。
        </div>
      </div>
      <div className="modal-footer">
        <button
          className="btn btn-secondary"
          onClick={close}
          disabled={working}
        >
          取消
        </button>
        {uploaded.length > 0 && !working && (
          <button
            className="btn btn-secondary"
            onClick={() =>
              onDone({
                ...resultRef.current,
                memberId: selected,
                uploadIds: uploaded.map((u) => u.id),
                rawText: resultRef.current?.rawText || raw?.rawText || "",
                receiptId: draftRef.current?.id,
                version: draftRef.current?.version,
              })
            }
          >
            直接核对图片
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={() => void recognize()}
          disabled={working || !files.length}
        >
          {working ? (
            <RefreshCw size={16} className="spin" />
          ) : (
            <Sparkles size={16} />
          )}{" "}
          {working
            ? "正在处理…"
            : uploaded.length
              ? "重试识别"
              : "保存图片并识别"}
        </button>
      </div>
    </Dialog>
  );
}
