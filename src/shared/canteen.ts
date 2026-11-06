/** 员工服务协议：只有独立员工资料与食堂数据，不包含 ERP 会话或会员/财务数据。 */
export const CANTEEN_ROLES = ['employee', 'chef', 'manager'] as const;
export type CanteenRole = (typeof CANTEEN_ROLES)[number];
export const CANTEEN_MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export type CanteenMeal = (typeof CANTEEN_MEALS)[number];
export const CANTEEN_MEAL_LABELS: Record<CanteenMeal, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };
export interface CanteenEmployee {
  id: string;
  employeeNo: string;
  name: string;
  departmentId: number;
  departmentName: string;
  role: CanteenRole;
  active: boolean;
  mustChangePassword: boolean;
}
export interface CanteenRosterEmployee extends CanteenEmployee {
  passwordHash: string;
  credentialVersion: string;
}
export interface CanteenMenuInput {
  id: string;
  date: string;
  meal: CanteenMeal;
  title: string;
  dishes: string[];
  notes: string;
  published: boolean;
  version: number;
}
export interface CanteenMenu extends CanteenMenuInput {
  updatedAt: string;
  updatedBy: string;
}
export interface CanteenCheckin {
  id: number;
  requestId: string;
  employeeId: string;
  employeeNo: string;
  name: string;
  departmentName: string;
  scannerId: string;
  scannerName: string;
  checkedAt: string;
}
export interface CanteenSyncInput {
  revision: number;
  canteenDepartmentId: number | null;
  employees: CanteenRosterEmployee[];
  afterCheckinId: number;
}
export interface CanteenSyncOutput {
  rosterSyncedAt: string;
  menus: CanteenMenu[];
  checkins: CanteenCheckin[];
  nextCheckinId: number;
  hasMore: boolean;
}
export interface CanteenSession {
  employee: CanteenEmployee;
  serverTime: string;
  syncAt: string;
  instance: string;
  version: string;
  commit: string;
}
export interface CanteenCode { code: string; expiresAt: string; serverTime: string; employeeNo: string }
