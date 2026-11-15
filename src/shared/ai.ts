// AI 辅助（8.0.22，docs/AI_V8022.md）：只读、只出文字——每天的经营小结、问数、合同条款提示。

export interface AiRules {
  /** 整项开关（功能开关默认开；没配模型服务时什么都不发，页面写「还没配置」） */
  enabled: boolean;
  dailySummary: boolean;
  questions: boolean;
  contractHints: boolean;
  /** 小结推企业微信（配了群机器人才推，MD11） */
  pushWecom: boolean;
  /** 拒答时由服务端换一个模型接着答（MD9） */
  fallbacks: boolean;
  /** 每人每天最多问几次（MD10） */
  dailyQuestionLimit: number;
}

export const DEFAULT_AI_RULES: AiRules = {
  enabled: true,
  dailySummary: true,
  questions: true,
  contractHints: true,
  pushWecom: true,
  fallbacks: true,
  dailyQuestionLimit: 50,
};

export type AiMode = 'off' | 'mock' | 'live';
export type AiSummaryStatus = 'running' | 'done' | 'failed' | 'unconfigured';
export type AiQuestionStatus = 'running' | 'done' | 'failed' | 'refused';
/** 问数一次最多来回几次（模型挑工具、服务端执行） */
export const AI_MAX_TOOL_ROUNDS = 6;
/** 问题最长几个字 */
export const AI_QUESTION_MAX = 500;

/** 小结用的事实包：都是汇总数，金额写成元的字符串，没有任何会员的明细 */
export interface AiDailyFacts {
  date: string;
  store: string;
  revenue: { net: string; receivable: string; checkouts: number; guests: number; perGuest: string; refund: string };
  compare: { lastWeekSameDay: string; avg7: string };
  byMethod: { method: string; amount: string }[];
  topItems: { category: string; name: string; quantity: number; amount: string }[];
  members: { newMembers: number; rechargePaid: string; rechargeCount: number; walletConsumed: string };
  anomalies: { kind: string; count: number }[];
  /** ERP 待办（本周应付、待审批、快到期、逾期应收）：只有一家店时写在这家店的小结里，几家店时写在全公司的里 */
  erpTodo?: string[];
}

/** 全公司合并的那一份（有几家店时）：各店的事实包 + ERP 待办 */
export interface AiCompanyFacts {
  date: string;
  stores: AiDailyFacts[];
  erpTodo: string[];
}

export interface AiSummaryView {
  id: number;
  storeId: number | null;
  storeName: string;
  businessDate: string;
  status: AiSummaryStatus;
  text: string | null;
  facts: AiDailyFacts | AiCompanyFacts | null;
  model: string | null;
  error: string | null;
  attempts: number;
  pushedAt: string | null;
  pushError: string | null;
  updatedAt: string;
}

/** 看板上「昨日小结」一块要的：这一天、这一份（还没生成时为空）、能不能重新生成 */
export interface AiSummaryResponse {
  date: string;
  scope: 'store' | 'all';
  summary: AiSummaryView | null;
}

/** 页面上要知道的 AI 辅助状态（不含密钥） */
export interface AiStatus {
  mode: AiMode;
  /** 正式时用的模型（模拟是 mock，没配是空） */
  model: string | null;
  rules: AiRules;
  /** 今天问了几次（每人） */
  usedToday: number;
}

export interface AiQuestionView {
  id: number;
  staffName: string;
  question: string;
  answer: string | null;
  status: AiQuestionStatus;
  tools: { name: string; input: unknown; ok: boolean }[];
  error: string | null;
  createdAt: string;
}

export interface AiContractHint {
  kind: 'missing' | 'mismatch' | 'risk';
  title: string;
  detail: string;
}

export const AI_HINT_KIND_LABELS: Record<AiContractHint['kind'], string> = { missing: '缺了的条款', mismatch: '对不上的地方', risk: '要留意的风险' };

/** 合同条款提示的请求：表单上现在的内容（还没保存的也行） */
export interface AiContractHintsInput {
  category: string;
  counterparty: string;
  content: unknown;
  /** 正文（按模板生成的、或手写的），可以没有 */
  body?: string;
}
