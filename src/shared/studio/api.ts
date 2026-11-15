// UI 工作台的接口返回（8.1.1，docs/WORKBENCH_V811.md 第 5、9 节）。

import type { StudioDoc, StudioSurface } from './format';
import type { StudioIssue } from './check';

/** 已发布的一版 */
export interface StudioVersionView {
  /** 全局编号（平板按它取版面，内容不会变，可以长期缓存） */
  id: number;
  /** 这家店的第几版（v1、v2……） */
  version: number;
  kind: 'publish' | 'rollback';
  /** 回滚时是照第几版重发的 */
  rollbackOf: number | null;
  note: string;
  /** 改了哪几屏（theme、start、menu……） */
  screensChanged: string[];
  publishedAt: string;
  publishedBy: string;
}

/** 编辑器打开时取的：草稿、已发布的最新一版 */
export interface StudioState {
  surface: StudioSurface;
  draft: {
    doc: StudioDoc;
    /** 草稿的版本号：存草稿时带上，对不上拒绝（别人刚改过）；0 = 还没存过（是默认版面或本店的） */
    rev: number;
    updatedAt: string | null;
    updatedBy: string | null;
  };
  published: StudioVersionView | null;
  /** 这家店没发布过、平板用的是本店（编号 1）的 */
  inherited: boolean;
  /** 平板菜单开着中英切换（英文没填的检查里提醒） */
  langSwitch: boolean;
}

/** 工作台的总览（后台「工作台」分区） */
export interface StudioOverview {
  surfaces: { surface: StudioSurface; label: string; draftUpdatedAt: string | null; draftUpdatedBy: string | null; published: StudioVersionView | null; inherited: boolean }[];
}

export interface StudioAssetView {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  uploadedAt: string;
  uploadedBy: string;
}

/** 平板读的：这家店现在用哪一版（没有发布过的为空，用内置的默认版面） */
export interface StudioPublishedRef {
  id: number;
  version: number;
}

export interface StudioPreviewCode {
  code: string;
  expiresAt: string;
}

/** 发布被检查拦下时，错误详情里带的问题 */
export interface StudioCheckFailed {
  issues: StudioIssue[];
}
