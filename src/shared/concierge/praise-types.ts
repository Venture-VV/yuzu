/** 管家好评：仅企业登录内共享；一条有效记录计一次，不以图片张数计数。 */
export interface PraiseStaff {
  id: string;
  name: string;
  active: boolean;
}

export interface PraiseRanking extends PraiseStaff {
  count: number;
  /** 0 条记录不占榜；相同次数同名次。 */
  rank: number | null;
}

export interface PraiseRecord {
  id: string;
  staffId: string;
  staffName: string;
  staffActive: boolean;
  occurredOn: string;
  source: string;
  content: string;
  guestName: string;
  memberId: string;
  memberName: string;
  memberCode: string;
  status: 'active' | 'voided';
  version: number;
  uploadIds: string[];
  createdById: string;
  createdByName: string;
  createdAt: string;
  voidedById: string;
  voidedByName: string;
  voidedAt: string;
  voidReason: string;
}

export interface PraiseCenterData {
  today: string;
  timezone: string;
  month: string;
  previousMonth: string;
  monthCount: number;
  previousMonthCount: number;
  totalCount: number;
  /** 录入候选，仅在岗且有管家职责的真实员工。 */
  staff: PraiseStaff[];
  currentMonthRanking: PraiseRanking[];
  previousMonthRanking: PraiseRanking[];
  canOperate: boolean;
  canManage: boolean;
}

export interface PraisePage {
  records: PraiseRecord[];
  nextCursor: string | null;
}

export interface SavePraiseInput {
  staffId: string;
  occurredOn: string;
  source: string;
  content: string;
  guestName: string;
  memberId?: string;
  uploadIds: string[];
}

export interface VoidPraiseInput {
  id: string;
  version: number;
  reason: string;
}
