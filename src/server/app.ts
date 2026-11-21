import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import type { Sql } from './db';
import { registerGrantRoutes } from './auth/grants';
import { registerAuthRoutes } from './auth/routes';
import { SESSION_COOKIE, resolveSession } from './auth/session';
import { AppError } from './lib/errors';
import { createProtection } from './lib/protect';
import { decodedPath, isApiRequest, routePath } from './lib/paths';
import type { Deps } from './lib/context';
import { DEFAULT_STORE_ID, runInStore } from './lib/store-context';
import { registerAdminRoutes } from './modules/admin';
import { registerPositionCatalogRoutes } from './modules/position-catalog';
import type { PingReply } from '@shared/resilience';
import { registerAuditRoutes } from './modules/audit';
import { registerClientErrorRoutes } from './modules/client-errors';
import { registerCatalogRoutes } from './modules/catalog';
import { registerFrontdeskRoutes } from './modules/frontdesk/routes';
import { registerDeptStockRoutes } from './modules/inventory/dept-stock';
import { registerDocRoutes } from './modules/inventory/docs';
import { registerReceiptImportRoutes } from './modules/inventory/direct-import';
import { registerLedgerImportRoutes } from './modules/inventory/ledger-import';
import { registerMasterRoutes } from './modules/inventory/master';
import { registerPayableRoutes } from './modules/inventory/payables';
import { registerCycleRoutes } from './modules/inventory/cycles';
import { registerImportRoutes } from './modules/inventory/imports';
import { registerExpenseRoutes } from './modules/expenses';
import { registerBudgetRoutes } from './modules/budgets';
import { registerInvoiceRoutes } from './modules/invoices';
import { registerErpOpsRoutes } from './modules/erp-ops';
import { registerPurchaseLedgerRoutes } from './modules/purchase-ledger';
import { registerLegacyRoutes } from './modules/legacy';
import { registerRequestRoutes } from './modules/requests';
import { registerRequestStockRoutes } from './modules/request-stock';
import { registerRequestImportRoutes } from './modules/request-import';
import { registerRequestDraftRoutes } from './modules/request-drafts';
import { registerRequestSheetRoutes } from './modules/request-sheet';
import { registerPurchasingRoutes } from './modules/inventory/purchasing';
import { registerUrgentContractRoutes } from './modules/inventory/urgent-contract';
import { registerPurchaseRulesRoutes } from './modules/inventory/purchase-rules';
import { registerFileRoutes } from './modules/inventory/files';
import { registerAttachmentRoutes } from './modules/inventory/attachments';
import { registerAdmissionRoutes } from './modules/inventory/admission';
import { registerScoreRoutes } from './modules/inventory/scores';
import { registerSlowRoutes } from './modules/inventory/slow';
import { registerReconLinkRoutes } from './modules/inventory/recon-links';
import { registerSupplierPortalRoutes } from './modules/inventory/supplier-portal';
import { registerPayTerminalRoutes } from './modules/pay-terminal';
import { registerPlatformVerifyRoutes } from './modules/platform-verify';
import { registerOtaRoutes } from './modules/ota';
import { registerIntegrationsAdminRoutes } from './modules/integrations-admin';
import { registerReceivableRoutes } from './modules/receivables';
import { registerAssetRoutes } from './modules/assets';
import { registerExpiryRoutes } from './modules/inventory/expiry';
import { registerCompareRoutes } from './modules/inventory/compare';
import { registerGiftRoutes } from './modules/inventory/gifts';
import { registerTransferRoutes } from './modules/inventory/transfers';
import { registerPettyAccountRoutes } from './modules/petty-accounts';
import { registerPettyPoolRoutes } from './modules/petty-pool';
import { registerReplenishRoutes } from './modules/inventory/replenish';
import { registerSourcingRoutes } from './modules/inventory/sourcing';
import { registerPurchaseFlowRoutes } from './modules/purchase-flow';
import { registerApprovalRoutes } from './modules/approvals/routes';
import { registerContractRoutes } from './modules/contracts/routes';
import { registerTemplateRoutes } from './modules/contracts/templates';
import { registerContractDocRoutes } from './modules/contracts/doc-templates';
import { registerPaymentRoutes } from './modules/payments/routes';
import { registerReportRoutes } from './modules/inventory/reports';
import { registerLedgerRoutes } from './modules/ledger';
import { registerOrderRoutes } from './modules/orders';
import { registerMemberRoutes } from './modules/members';
import { registerMemberTagRoutes } from './modules/member-tags';
import { registerCustomFieldRoutes } from './modules/custom-fields';
import { registerSalesInvoiceRoutes } from './modules/sales-invoices';
import { registerBankRoutes } from './modules/bank';
import { registerPaymentBatchRoutes } from './modules/payment-batches';
import { registerMemberRecordRoutes } from './modules/member-records';
import { registerCouponRoutes } from './modules/coupons';
import { registerSignGiftRoutes } from './modules/gifts';
import { registerCampaignRoutes } from './modules/coupon-campaigns';
import { registerGiftOutRoutes } from './modules/gift-outs';
import { registerStockUsageRoutes } from './modules/stock-usage';
import { registerLinenRoutes } from './modules/linen';
import { registerCostRoutes } from './modules/inventory/cost';
import { registerAutoReplenishRoutes } from './modules/inventory/auto-replenish';
import { registerCouponUsageRoutes } from './modules/coupon-usage';
import { registerMarketingCostRoutes } from './modules/marketing-cost';
import { registerMembershipRoutes } from './modules/membership';
import { registerBenefitRoutes } from './modules/benefits';
import { registerVipLockerRoutes } from './modules/vip-lockers';
import { registerBenefitTierRoutes } from './modules/benefit-tiers';
import { registerTrialRoutes } from './modules/member-trials';
import { registerDeviceRoutes } from './modules/devices';
import { registerOpeningRoutes } from './modules/opening';
import { registerMemberHistoryRoutes } from './modules/member-history';
import { registerPrintRoutes } from './modules/print';
import { registerShiftRoutes } from './modules/shifts';
import { registerDashboardRoutes } from './modules/dashboard';
import { registerDashboardReportRoutes } from './modules/reports';
import { registerSettingsRoutes } from './modules/settings';
import { registerStoreRoutes } from './modules/stores';
import { registerWecomRoutes } from './modules/wecom';
import { registerAiRoutes } from './modules/ai';
import { registerSettlementRoutes } from './modules/settlement';
import { registerStaffRoutes } from './modules/staff';
import { registerTechnicianRoutes } from './modules/technicians';
import { registerTechnicianAdminRoutes } from './modules/technician-admin';
import { registerClockroomRoutes } from './modules/clockroom';
import { registerDiningRoutes } from './modules/dining';
import { registerTableRoutes } from './modules/tables';
import { registerDining808Routes } from './modules/dining-808';
import { registerDiningReceiptRoutes } from './modules/dining-receipt';
import { registerEmenuRoutes } from './modules/emenu/routes';
import { registerStudioRoutes } from './modules/studio';
import { registerRoomRoutes } from './modules/rooms';
import { registerSpaceRoutes } from './modules/spaces';
import { registerFloorplanRoutes } from './modules/floorplans';
import { registerFloorMapRoutes } from './modules/floormap';
import { registerUsageRoutes } from './modules/usages';
import { registerBookingRoutes } from './modules/bookings';
import { registerCountCardRoutes } from './modules/count-cards';
import { registerMemberCardRoutes } from './modules/member-cards';
import { registerPlatformRoutes } from './modules/platform-redemptions';
import { registerGuideRoutes } from './modules/guide';
import { registerLocationRoutes } from './modules/locations';
import { registerCommissionRoutes } from './modules/commission';
import { registerWalletRoutes } from './modules/wallet';
import { registerMemberRefundRoutes } from './modules/member-refunds';
import { registerMemberAdminRoutes } from './modules/member-admin';
import { registerErpModuleGate, registerErpRoutes } from './modules/erp';
import { registerMpStaffRoutes } from './modules/mp/staff';
import { registerCanteenAdminRoutes } from './modules/canteen/admin-routes';
import { registerConciergeRoutes } from './modules/concierge/routes';
import { registerCustomerRoutes } from './modules/customer/routes';
import { registerPatrolAdminRoutes } from './modules/patrol/routes';
import { registerTablesV8115Routes } from './modules/tables-v8115';
import { registerDishRoutes } from './modules/dishes';
import { registerDishImportRoutes } from './modules/dishes-import';
import { registerRoomCenterRoutes } from './modules/room-center';

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // 例如 "null"，按跨站处理
  }
}

export async function buildApp(sql: Sql, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 64 * 1024,
    // 正式服在反向代理（Caddy）后面时设 TRUST_PROXY：来源 IP、https 按代理转来的算（8.0.0，docs/RELEASE_V800.md）
    trustProxy: config.trustProxy.length ? config.trustProxy : false,
  });
  const deps: Deps = { sql, config };

  await app.register(cookie);
  app.decorateRequest('actor', null as never);
  app.decorateRequest('hasSession', false);

  // 防护（8.1.3，docs/RESILIENCE_V813.md 第 3.5 节）：访问网段与过载保护在读会话之前（忙的时候不再多查一次库），
  // 频率限制在读完会话之后（登录了的按会话算）。拒绝都发生在处理之前，页面据此原样自动重发
  const protection = createProtection(config.protection);
  app.addHook('onRequest', protection.gate);
  app.addHook('onResponse', protection.done);
  app.addHook('onRequestAbort', protection.done);
  app.addHook('onClose', async () => protection.close());

  app.addHook('onRequest', async (req) => {
    // 按解码后的路径认接口：/%61pi/… 与 /api/… 进的是同一个接口，来源检查、读会话都要一样
    if (!isApiRequest(req)) return;
    // 页面问「连不连得上」：不读会话、不查库
    if (decodedPath(req.url) === '/api/ping') return;
    // 修改类请求必须来自本站页面（防止跨站请求伪造）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host) {
        throw new AppError(403, 'BAD_ORIGIN', '请求来源不正确');
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const actor = await resolveSession(sql, token, config.sessionTtlHours);
      if (actor) {
        req.actor = actor;
        req.hasSession = true;
      }
    }
  });

  app.addHook('onRequest', protection.limit);

  // 当前门店（8.0.22，docs/MULTISTORE_V8022.md 第 3 节）：处理请求时在这家店的上下文里——事务开头记上门店、
  // 业务表 store_id 的默认值取它；放在请求体解析以后（preHandler），处理函数整个在里面
  app.addHook('preHandler', (req, _reply, done) => {
    runInStore(req.actor?.storeId ?? DEFAULT_STORE_ID, done);
  });

  // 浏览器按声明的类型解析响应，不猜测内容类型（测试服 E2E 报告）；不让别的网站把页面嵌进去（防点击劫持），
  // 跳到别的网站时不带地址里的内容（8.0.0：正式服放公网之前补上，docs/RELEASE_V800.md）
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const e = error as { statusCode?: number; code?: string; message: string };
    if (e.code === '23514' || e.code === '23503') {
      req.log.warn({ err: error }, '数据库约束拦截');
      reply.status(422).send({ error: { code: 'CONSTRAINT', message: '数据校验未通过，操作未生效，请核对后重试' } });
      return;
    }
    if (e.code === '55P03' || e.code === '57014' || e.code === '40P01' || e.code === '40001') {
      // 等锁或执行超时、死锁、串行化冲突（8.1.3）：事务已回滚，操作没有生效；页面带原操作编号自动重发
      req.log.warn({ err: error }, e.code === '40P01' ? '死锁，事务已回滚' : e.code === '40001' ? '串行化冲突，事务已回滚' : '记账等待超时');
      const path = routePath(req);
      const what =
        path.startsWith('/api/inventory') || path.startsWith('/api/purchase') || path.startsWith('/api/payables')
          ? '相关物料或单据'
          : path.startsWith('/api/frontdesk') || path.startsWith('/api/emenu')
            ? '这张手牌或账单'
            : path.startsWith('/api/admin/spaces')
              ? '空间台账'
              : '该会员';
      reply.status(409).send({ error: { code: 'BUSY', message: `${what}正在被其他终端操作，本次未生效，请稍后重试` } });
      return;
    }
    if (e.code === 'P0001') {
      req.log.warn({ err: error }, '只追加保护拦截');
      reply.status(409).send({ error: { code: 'IMMUTABLE', message: '已入账记录不可修改' } });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: '请求格式不正确' } });
      return;
    }
    req.log.error({ err: error }, '未处理的错误');
    reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器出了点问题，操作可能未完成，请通过单号或流水核对结果' } });
  });

  app.get('/api/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, version: config.version, commit: config.commit, instance: config.instance, time: new Date().toISOString() };
  });

  // 页面问「连不连得上」（8.1.3 WL3）：不查数据库、不读会话、不受过载保护与频率限制；顺带告诉页面服务器上这一版页面的入口文件，
  // 和页面自己的不一样就是系统更新过了（提示条请员工方便时刷新）
  const clientEntry = readClientEntry(resolve(process.env.STATIC_DIR ?? 'dist/client'));
  app.get('/api/ping', async (_req, reply): Promise<PingReply> => {
    reply.header('cache-control', 'no-store');
    return { ok: true, version: config.version, commit: config.commit, instance: config.instance, client: clientEntry, time: new Date().toISOString() };
  });
  registerClientErrorRoutes(app);

  // ERP 关闭的模块：按接口前缀统一拦截（先于各接口注册，所有接口都经过它）
  registerErpModuleGate(app, deps);
  registerConciergeRoutes(app, deps);
  registerCustomerRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerGrantRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerMemberTagRoutes(app, deps);
  // 自定义字段（8.0.21，docs/FINANCE_V8021.md 第 1 节）
  registerCustomFieldRoutes(app, deps);
  registerMemberRecordRoutes(app, deps);
  registerCouponRoutes(app, deps);
  // 8.1.9 签赠（docs/GIFTS_V819.md）
  registerSignGiftRoutes(app, deps);
  registerCampaignRoutes(app, deps);
  registerGiftOutRoutes(app, deps);
  registerStockUsageRoutes(app, deps);
  registerCostRoutes(app, deps);
  registerAutoReplenishRoutes(app, deps);
  registerLinenRoutes(app, deps);
  registerCouponUsageRoutes(app, deps);
  registerMarketingCostRoutes(app, deps);
  registerMembershipRoutes(app, deps);
  registerBenefitRoutes(app, deps);
  registerVipLockerRoutes(app, deps);
  registerBenefitTierRoutes(app, deps);
  registerTrialRoutes(app, deps);
  registerDeviceRoutes(app, deps);
  registerWalletRoutes(app, deps);
  // 储值退回（v0.7.26）
  registerMemberRefundRoutes(app, deps);
  registerMemberAdminRoutes(app, deps);
  registerOpeningRoutes(app, deps);
  registerMemberHistoryRoutes(app, deps);
  registerShiftRoutes(app, deps);
  registerPrintRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerDashboardReportRoutes(app, deps);
  registerLedgerRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerSettlementRoutes(app, deps);
  registerStaffRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerStoreRoutes(app, deps);
  registerWecomRoutes(app, deps);
  registerAiRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerAdminRoutes(app, deps);
  // 分部门岗位职权配置（8.2.0 P05）
  registerPositionCatalogRoutes(app, deps);
  registerMasterRoutes(app, deps);
  registerDocRoutes(app, deps);
  // 8.1.9 库管入库的台账模板与一键导入（docs/ERP_V819.md 第 3.2 节）
  registerReceiptImportRoutes(app, deps);
  registerLedgerImportRoutes(app, deps);
  registerReportRoutes(app, deps);
  registerDeptStockRoutes(app, deps);
  registerPurchasingRoutes(app, deps);
  registerUrgentContractRoutes(app, deps);
  registerPurchaseRulesRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerAttachmentRoutes(app, deps);
  registerAdmissionRoutes(app, deps);
  registerScoreRoutes(app, deps);
  registerSlowRoutes(app, deps);
  registerReconLinkRoutes(app, deps);
  registerSupplierPortalRoutes(app, deps);
  registerPayTerminalRoutes(app, deps);
  registerPlatformVerifyRoutes(app, deps);
  registerOtaRoutes(app, deps);
  registerIntegrationsAdminRoutes(app, deps);
  registerReceivableRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerExpiryRoutes(app, deps);
  registerCompareRoutes(app, deps);
  registerGiftRoutes(app, deps);
  registerTransferRoutes(app, deps);
  registerPettyAccountRoutes(app, deps);
  registerReplenishRoutes(app, deps);
  registerSourcingRoutes(app, deps);
  // 采购流程图（8.0.17，只读）
  registerPurchaseFlowRoutes(app, deps);
  // 审批中心（v0.7.30）
  registerApprovalRoutes(app, deps);
  // 合同与法务审查（v0.7.31）
  registerTemplateRoutes(app, deps);
  // 合同模板与导出（8.0.21）：要在 /api/erp/contracts/:id 之前注册
  registerContractDocRoutes(app, deps);
  registerContractRoutes(app, deps);
  registerPaymentRoutes(app, deps);
  registerPayableRoutes(app, deps);
  registerCycleRoutes(app, deps);
  registerImportRoutes(app, deps);
  registerExpenseRoutes(app, deps);
  // 8.1.9 零采备用金（docs/ERP_V819.md 第 2 节）
  registerPettyPoolRoutes(app, deps);
  // 费用预算与进项发票台账（8.0.3）
  registerBudgetRoutes(app, deps);
  registerInvoiceRoutes(app, deps);
  // 开票申请（8.0.21）
  registerSalesInvoiceRoutes(app, deps);
  // 银行账户与网银流水（8.0.21）
  registerBankRoutes(app, deps);
  // 批量付款（8.0.21）
  registerPaymentBatchRoutes(app, deps);
  registerRequestRoutes(app, deps);
  // 8.1.10 核库转领用：库管核库、部门答复替代
  registerRequestStockRoutes(app, deps);
  registerRequestImportRoutes(app, deps);
  registerRequestDraftRoutes(app, deps);
  registerRequestSheetRoutes(app, deps);
  registerErpOpsRoutes(app, deps);
  registerPurchaseLedgerRoutes(app, deps);
  registerLegacyRoutes(app, deps);
  registerFrontdeskRoutes(app, deps);
  registerTechnicianRoutes(app, deps);
  registerClockroomRoutes(app, deps);
  registerDiningRoutes(app, deps);
  registerTableRoutes(app, deps);
  registerDining808Routes(app, deps);
  // 8.1.7 点菜单（小票可视化）
  registerDiningReceiptRoutes(app, deps);
  // 点餐系统 · 平板电子菜单（8.0.10）
  registerEmenuRoutes(app, deps);
  registerStudioRoutes(app, deps);
  registerRoomRoutes(app, deps);
  registerSpaceRoutes(app, deps);
  registerFloorplanRoutes(app, deps);
  registerFloorMapRoutes(app, deps);
  // 派对房等「开单即占用」的使用单（v0.7.19）
  registerUsageRoutes(app, deps);
  registerBookingRoutes(app, deps);
  registerCountCardRoutes(app, deps);
  registerMemberCardRoutes(app, deps);
  registerPlatformRoutes(app, deps);
  // 对客导览（v0.7.19）
  registerGuideRoutes(app, deps);
  registerLocationRoutes(app, deps);
  registerCommissionRoutes(app, deps);
  registerErpRoutes(app, deps);
  // 微信小程序（小程序线）：前台用会员码查会员、解绑会员的微信、后台「小程序」
  registerMpStaffRoutes(app, deps);
  // 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：管理后台的 /api/erp/canteen；员工用的 /api/canteen/* 只在员工端口上
  registerCanteenAdminRoutes(app, deps);
  // 安保巡场（8.0.9，docs/PATROL_V809.md）：管理后台的 /api/erp/patrol；员工用的 /api/canteen/patrol/* 在员工端口上
  registerPatrolAdminRoutes(app, deps);
  // 8.1.15 块 B（docs/DINING_V8115.md）：桌台动作——清台、维修、恢复、并台、拆台、桌台历史
  registerTablesV8115Routes(app, deps);
  // 菜品管理（8.1.15，docs/DISHES_V8115.md）：菜品表、新增 / 编辑、上下架、改价与改价记录、Excel 导出与导入
  registerDishRoutes(app, deps);
  registerDishImportRoutes(app, deps);
  // 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）：按房型看全店房间的五种状态，服务房间的登记、换房、续钟、并房、退房
  registerRoomCenterRoutes(app, deps);
  // 技师管理（8.1.15，docs/TECHNICIANS_V8115.md）：组别、班次与排班、休假；名册与钟房的接口在各自原来的模块里
  registerTechnicianAdminRoutes(app, deps);

  // 前端静态资源（构建产物），全部从本机提供，外网中断不影响使用。
  const staticDir = resolve(process.env.STATIC_DIR ?? 'dist/client');
  const hasClient = existsSync(resolve(staticDir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: staticDir,
      // 构建时已压缩好（scripts/compress-assets.mjs）：浏览器支持时直接发 .br / .gz，首次打开下载量约为原来的四分之一
      preCompressed: true,
      setHeaders(reply, path) {
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (isApiRequest(req) || !hasClient || req.method !== 'GET') {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    // 构建产物里的脚本、模型这类文件缺了就是缺了：回 404，不拿页面顶替。
    // （管家部本机 OCR 的识别库把收到的内容直接当模型用、还会存在浏览器里；回页面的话坏的那份会一直留着，8.0.12 整改）
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/assets/') || path.startsWith('/concierge/ocr/')) {
      reply.status(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not Found');
      return;
    }
    reply.header('cache-control', 'no-cache').sendFile('index.html');
  });

  return app;
}

/** 构建好的 index.html 里页面入口的脚本（/assets/index-xxxx.js）；没有构建产物（开发、测试）时为空 */
export function readClientEntry(staticDir: string): string | null {
  try {
    const html = readFileSync(resolve(staticDir, 'index.html'), 'utf8');
    return /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}
