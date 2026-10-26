import type { Duty, Role } from '@shared/permissions';
import type { AppConfig } from '../config';
import type { Sql } from '../db';

export interface Deps {
  sql: Sql;
  config: AppConfig;
}

export interface Actor {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  /** 库存与采购职责，可叠加 */
  duties: Duty[];
  mustChangePassword: boolean;
}

/** 一次业务操作的上下文。at 仅供合成数据与测试指定业务发生时间。 */
export interface OpContext {
  actor: Actor;
  ip?: string;
  at?: Date;
}
