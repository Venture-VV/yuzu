# v8.1.20 交接说明 · 库存：出入库台账（导入、导出、下载模板）

主线 [PR #142](https://github.com/Venture-VV/yuzu/pull/142)。店主 2026-11-21 转来《ERP 需求汇总更新：库存页面导入台账调整》与新模板：「在现有ERP系统“库存页面”这一次局部更新，根据文档需求开发」。

- 设计：`docs/ERP_V8120.md`。
- 默认做法：`docs/PENDING_DECISIONS.md`「8.1.20」LD1–LD10（LD1–LD3 店主已定）。
- 迁移：`200_ledger_imports.sql`（物料库位、导入记录、单据挂导入、业务类型 `ledger_import`）。

## 0. 升级后会看到的变化

- 「库管入库」页右上角多了三个按钮：导入出入库台账、导出台账、下载模板。
- 库存页「库管入库」旁边的「导入入库台账」改叫「出入库台账」，导入页换成新模板；旧模板下载不到了。
- 物料资料多了「库位」。

## 1. 范围

- 服务端：`src/server/modules/inventory/ledger-import.ts`（新：模板、核对、导入、导出、查回）；`docs.ts`（`createLedgerDoc`）；`direct-import.ts`（旧模板停用）；`master.ts`（库位）；登记处（`app.ts`、`fences.ts`、`audit.ts`、`erp-ops.ts`、`shared/erp.ts`）。
- 页面：`LedgerImportPage.tsx`（新，代替 `DirectImportPage.tsx`）、`LedgerActions.tsx`（右上角三个按钮）、`DocFormPage.tsx`、`StockTab.tsx`、`MasterTab.tsx`、`ErpPendingPanel.tsx`。
- 高风险目录：迁移 `200`（要 Codex 审查）。

## 2. 已执行的验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint` / `typecheck` / `check:code` / `check:docs` / `check:gov` / `format:check` | 通过 |
| `npm run test:unit` | 通过 |
| `tests/ledger-import.test.ts`、`tests/direct-receipts.test.ts` | 14 条通过 |
| 浏览器 `e2e/erp-8120.spec.ts`、`e2e/erp-819.spec.ts`（门店电脑，独立演示库） | 3 条通过 |

## 3. 验收要点

1. 物资经办（lixiao）进「库管入库」，右上角三个按钮在，原来的表单、明细、确认收货不变。
2. 下载模板：三个工作表（出入库台账、填写说明、选项），表头两行与门店的版式一样，多一列「单价」。
3. 填一份：两种物料，一种有入库 2 次与出库 2 次（两个部门），一种只有入库；预览没有问题 → 导入：按天、供应商合成库管入库，按天、部门、领料人合成部门领料，库存对得上，库位写进物料档案。
4. 同一份文件再导入被拒；把单价、供应商、部门写错、出库多于库存，预览写明哪一行哪一列。
5. 导出台账（这个月）：上期、每次入库出库、库存量与系统一致，标题有「系统导出」；原样再导入被拒。
6. `node dist/server/cli.js check` 全部 ✓。

## 4. 给测试 AI 的指令

```
【主线·测试】→ 主线 · main v8.1.20 · <完整 SHA>
在独立演示库上验收 v8.1.20（docs/HANDOFF_V8120.md、docs/ERP_V8120.md）：
1. npx vitest run tests/ledger-import.test.ts tests/direct-receipts.test.ts（TEST_DATABASE_URL 指向独立测试库）。
2. E2E_BASE_URL=http://127.0.0.1:<端口> npx playwright test e2e/erp-8120.spec.ts e2e/erp-819.spec.ts e2e/inventory.spec.ts --project=门店电脑。
3. 照第 3 节手工核对 1–6，导出的台账与导入用的文件附在 PR 上。
```
