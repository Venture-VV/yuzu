// 会员停用 / 启用、换手机号、合并（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 3、4 节；PENDING_DECISIONS M76–M79）。前后端共用。

export type MemberStatus = 'active' | 'frozen';
export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = { active: '在用', frozen: '已停用' };

/** 停用 / 启用记录（只追加）；合并时停用来源会员也记一条 */
export interface MemberStatusEvent {
  id: number;
  memberId: number;
  fromStatus: MemberStatus;
  toStatus: MemberStatus;
  reason: string;
  staffName: string;
  businessDate: string;
  createdAt: string;
  /** 合并时停用的：合并单号 */
  mergeNo: string | null;
}

/** 换手机号记录（只追加） */
export interface MemberPhoneChange {
  id: number;
  memberId: number;
  oldPhone: string;
  newPhone: string;
  reason: string;
  staffName: string;
  /** 当场授权的人；经办人自己有「改会员手机号」权限时为空 */
  approverName: string | null;
  businessDate: string;
  createdAt: string;
}

export interface MergeParty {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
}

/** 合并单 */
export interface MemberMergeDetail {
  id: number;
  mergeNo: string;
  source: MergeParty;
  target: MergeParty;
  /** 转过去的本金、赠金 */
  principal: number;
  bonus: number;
  reason: string;
  staffName: string;
  businessDate: string;
  createdAt: string;
  /** 目标会员的档阶因合并变了（取了来源会员的）：从哪一档到哪一档；没变为空 */
  grade: { from: string; to: string } | null;
}

/** 合并前核对（只读）：两位的余额与档阶、合并以后目标会员的档阶、不能合并的原因 */
export interface MergeCheck {
  source: MergeParty & { principal: number; bonus: number; grade: string; status: MemberStatus };
  target: MergeParty & { principal: number; bonus: number; grade: string; status: MemberStatus };
  /** 要转过去的本金、赠金（到期的赠金按此刻作废后） */
  principal: number;
  bonus: number;
  /** 合并以后目标会员的档阶；changed 为真时取的是来源会员的 */
  gradeAfter: string;
  gradeChanged: boolean;
  /** 不能合并的原因（空为可以） */
  problems: string[];
}

/** 会员详情「储值与账户」下面的记录：停用 / 启用、换号、并进来的、并到了谁 */
export interface MemberAccountHistory {
  statusEvents: MemberStatusEvent[];
  phoneChanges: MemberPhoneChange[];
  mergedFrom: MemberMergeDetail[];
  mergedInto: MemberMergeDetail | null;
}
