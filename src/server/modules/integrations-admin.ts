// 后台「对外接口」（8.0.21，docs/INTEGRATIONS_V8021.md 第 1 节）：每一样现在是哪种模式（只由运行环境决定，页面上改不了）、
// 门店开关（启用扫码收款、启用平台验券、自动对账的时间）、最近的对外调用（可以按业务对象查）。要「门店设置」。
// 开关保存走规则锁（saveRuleSetting），只改提交的字段。不显示、不记录任何密钥，只看「配没配」。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_INTEGRATION_SWITCHES, type IntegrationMode, type IntegrationSwitches } from '@shared/integrations';
import { guard } from '../auth/guard';
import { AI_DEFAULT_MODEL } from '../integrations/ai';
import { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from '../integrations/ai-deepseek';
import { INTEGRATION_KINDS, LIVE_ENV, modeOf, type AiService, type IntegrationKind } from '../integrations/config';
import { ctxOf, type Deps } from '../lib/context';
import { saveRuleSetting } from '../lib/rule-settings';
import { parse } from '../lib/validate';
import { loadIntegrationSwitches } from './pay-terminal';

const KIND_LABELS: Record<IntegrationKind, string> = {
  pay_terminal: '扫码收款（微信付款码、支付宝当面付）',
  platform_voucher: '平台验券（美团、抖音）',
  einvoice: '开票服务商（数电票）',
  bank_direct: '银企直连（批量付款直接付）',
  ota: 'OTA 渠道直连',
  ai: 'AI 辅助（经营小结、问数、合同条款提示）',
};
/** 正式实现已经写好、配了环境变量就直接用的（不用等联调）：页面上「已配置」不写「等联调」 */
const LIVE_READY: Partial<Record<IntegrationKind, (aiService: AiService) => string>> = {
  // 8.1.1 起默认 DeepSeek（MD8）；YUZU_AI_PROVIDER=claude 时 Claude
  ai: (aiService) =>
    aiService === 'claude'
      ? `配了 YUZU_AI_API_KEY 就直接调 Claude（YUZU_AI_PROVIDER=claude；默认 ${AI_DEFAULT_MODEL}，YUZU_AI_MODEL 可换；正式服在大陆连不上，要经代理 YUZU_AI_BASE_URL）。开关在下面「AI 辅助」`
      : `配了 YUZU_AI_API_KEY（DeepSeek 开放平台的 API key）就直接调 DeepSeek（默认 ${DEEPSEEK_DEFAULT_MODEL}，YUZU_AI_MODEL 可换 deepseek-flash；地址默认 ${DEEPSEEK_DEFAULT_BASE_URL}）。开关在下面「AI 辅助」`,
};
/** 这一版还只能用文件的（没有接口，也没有模拟） */
const FILE_ONLY: Partial<Record<IntegrationKind, string>> = {
  bank_direct: '这一版只导出网银批量付款文件（「付款 → 批量付款」），银行开通银企直连后联调',
  ota: '这一版导入渠道后台导出的订单表（「预约 → 渠道订单」），直连拉单以后再做',
};

export interface IntegrationKindInfo {
  kind: IntegrationKind;
  label: string;
  mode: IntegrationMode;
  note: string | null;
  /** 正式实现已经写好（配了就直接用，不用等联调） */
  liveReady: boolean;
  /** 正式接口要的环境变量配没配（只给名字与有没有，不给值） */
  live: { key: string; label: string; vars: string[]; configured: boolean }[];
}
export interface IntegrationCall {
  id: number;
  kind: IntegrationKind;
  provider: string;
  action: string;
  mode: 'mock' | 'live';
  refType: string | null;
  refId: number | null;
  request: Record<string, unknown>;
  ok: boolean;
  result: Record<string, unknown>;
  error: string | null;
  durationMs: number;
  staffName: string | null;
  createdAt: string;
}

const Switches = z.object({
  payTerminal: z.boolean(),
  platformVoucher: z.boolean(),
  voucherReconcileAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '对账时间写成 06:10 这样'),
});

export function registerIntegrationsAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  app.get('/api/admin/integrations', { preHandler: guard('settings.manage') }, async () => {
    const kinds: IntegrationKindInfo[] = INTEGRATION_KINDS.map((kind) => ({
      kind,
      label: KIND_LABELS[kind],
      mode: FILE_ONLY[kind] ? 'off' : modeOf(config.integrations, kind),
      note: FILE_ONLY[kind] ?? LIVE_READY[kind]?.(config.integrations.aiService ?? 'deepseek') ?? null,
      liveReady: !!LIVE_READY[kind],
      live: Object.entries(LIVE_ENV)
        .filter(([, v]) => v.kind === kind)
        .map(([key, v]) => ({ key, label: v.label, vars: v.vars, configured: config.integrations.liveConfigured.includes(key) })),
    }));
    return { kinds, switches: await loadIntegrationSwitches(sql), defaults: DEFAULT_INTEGRATION_SWITCHES };
  });
  app.put('/api/admin/integrations/switches', { preHandler: guard('settings.manage') }, async (req) =>
    saveRuleSetting(sql, 'integration_switches', loadIntegrationSwitches, (before): IntegrationSwitches => parse(Switches, { ...before, ...parse(Switches.partial(), req.body) }), ctxOf(req)),
  );
  app.get('/api/admin/integrations/calls', { preHandler: guard('settings.manage') }, async (req) => {
    const q = parse(
      z.object({ kind: z.enum(INTEGRATION_KINDS).optional(), refType: z.string().max(40).optional(), refId: z.coerce.number().int().positive().optional(), failed: z.enum(['1']).optional() }),
      req.query,
    );
    const rows = await sql<IntegrationCall[]>`
      SELECT c.id, c.kind, c.provider, c.action, c.mode, c.ref_type, c.ref_id, c.request_summary AS request, c.ok, c.result_summary AS result, c.error, c.duration_ms,
             s.display_name AS staff_name, c.created_at
      FROM integration_calls c LEFT JOIN staff s ON s.id = c.staff_id
      WHERE ${q.kind ? sql`c.kind = ${q.kind}` : sql`true`}
        AND ${q.refType ? sql`c.ref_type = ${q.refType}` : sql`true`}
        AND ${q.refId ? sql`c.ref_id = ${q.refId}` : sql`true`}
        AND ${q.failed ? sql`NOT c.ok` : sql`true`}
      ORDER BY c.id DESC LIMIT 100`;
    return rows.map((r) => ({ ...r, id: Number(r.id), refId: r.refId === null ? null : Number(r.refId) }));
  });
}
