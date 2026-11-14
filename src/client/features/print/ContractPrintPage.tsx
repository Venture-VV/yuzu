// 合同打印页（8.0.21，docs/FINANCE_V8021.md 第 6 节，CW-E）：A4，按模板排好的正文与两张表；浏览器「打印 → 存为 PDF」就是 PDF。
// 页眉写门店、合同编号与版本（起草中的写「草稿」）。导出以后照旧走法务审查、签署与用印。

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api, errorMessage } from '../../lib/api';

interface Doc {
  contractNo: string;
  title: string;
  versionLabel: string;
  headerText: string;
  templateName: string | null;
  blocks: ({ kind: 'heading'; text: string } | { kind: 'para'; text: string } | { kind: 'table'; header: string[]; rows: string[][] })[];
}

export function ContractPrintPage() {
  const id = Number(useParams().id);
  const q = useQuery({ queryKey: ['print', 'contract', id], queryFn: () => api.get<Doc>(`/api/erp/contracts/${id}/document`), enabled: Number.isInteger(id) && id > 0, refetchOnWindowFocus: false });
  const d = q.data;
  return (
    <div className="min-h-screen bg-paper-2 py-6 print:bg-white print:py-0">
      <style>{'@page { size: A4; margin: 18mm 16mm; } @media print { .no-print { display: none !important; } }'}</style>
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center gap-3 px-2">
        <button type="button" onClick={() => window.print()} disabled={!d} className="h-10 rounded-md bg-pine px-4 text-[14px] font-semibold text-paper disabled:opacity-50" data-testid="contract-print-go">
          打印 / 存为 PDF
        </button>
        <span className="text-[13px] text-ink-3">{d?.templateName ? `按模板「${d.templateName}」排版` : d ? '没用模板：合同要素与两张表' : ''}</span>
      </div>
      <article className="mx-auto w-[210mm] max-w-full bg-white px-[16mm] py-[14mm] text-[12pt] leading-[1.75] text-black shadow-card print:w-auto print:p-0 print:shadow-none" data-testid="print-contract">
        {q.error ? (
          <p className="text-clay">{errorMessage(q.error)}</p>
        ) : !d ? (
          <p className="text-ink-3">正在准备……</p>
        ) : (
          <>
            <p className="mb-4 border-b border-black/60 pb-1 text-[9pt] text-black/70">{d.headerText}</p>
            {d.blocks.map((b, i) =>
              b.kind === 'heading' ? (
                i === 0 ? (
                  <h1 key={i} className="mb-5 text-center text-[18pt] font-bold">
                    {b.text}
                  </h1>
                ) : (
                  <h2 key={i} className="mb-1 mt-4 text-[13pt] font-bold">
                    {b.text}
                  </h2>
                )
              ) : b.kind === 'para' ? (
                <p key={i} className="mb-2 whitespace-pre-wrap text-justify indent-[2em]">
                  {b.text}
                </p>
              ) : (
                <table key={i} className="mb-3 w-full border-collapse text-[10.5pt]">
                  <thead>
                    <tr>
                      {b.header.map((h) => (
                        <th key={h} className="border border-black px-2 py-1 text-left font-bold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k} className="border border-black px-2 py-1">
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ),
            )}
            <div className="mt-10 grid grid-cols-2 gap-8 text-[11pt]">
              <p>甲方（盖章）：<br />代表签字：<br />日期：</p>
              <p>乙方（盖章）：<br />代表签字：<br />日期：</p>
            </div>
          </>
        )}
      </article>
    </div>
  );
}
