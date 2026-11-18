// UI 工作台的接口返回（8.1.1，docs/WORKBENCH_V811.md 第 5、9 节）。

import type { StudioDoc, StudioSurface } from './format';

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
  /** 定时发布（8.1.2，GZ27）：定在什么时候生效（空 = 发布时就生效） */
  effectiveAt: string | null;
  /** 还没生效就撤销了：这一版永远不生效 */
  cancelledAt: string | null;
  cancelledBy: string | null;
  /** 平板（手机）现在用的就是这一版（版本列表里给） */
  current?: boolean;
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
  /** 定时发布、还没到时间（也没撤销）的几版，早的在前（8.1.2） */
  scheduled: StudioVersionView[];
}

/** 工作台的总览（后台「工作台」分区） */
export interface StudioOverview {
  surfaces: {
    surface: StudioSurface;
    label: string;
    draftUpdatedAt: string | null;
    draftUpdatedBy: string | null;
    published: StudioVersionView | null;
    inherited: boolean;
    /** 下一个定时生效的（8.1.2） */
    scheduled: StudioVersionView | null;
    /** 没解决的批注几条（8.1.2） */
    openComments: number;
  }[];
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

/** 批注（8.1.2，GZ28）：画布上某一屏某个位置的留言；回复挂在第一条下面；解决了标一下 */
export interface StudioCommentView {
  id: number;
  /** 哪一屏（改组件时是「@组件编号」） */
  screen: string;
  /** 挂在哪一块上（可以没有） */
  nodeId: string | null;
  /** 画布上的位置（设计稿的像素） */
  x: number;
  y: number;
  parentId: number | null;
  body: string;
  createdById: number;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** 「谁在改」（8.1.2）：这一个界面的编辑器还有谁开着（最近 45 秒里报过到） */
export interface StudioPresence {
  staffId: number;
  name: string;
  seenAt: string;
}

/**
 * 设计包（8.1.2）：一份版面连同用到的图，导出成一个文件，在别的环境（演示库 → 正式服）导进来接着改、发布。
 * 图按内容的摘要存（导进来时重新核对内容与编号对得上、格式合格）。
 */
export interface StudioPack {
  kind: 'yuzu-studio-pack';
  version: 1;
  surface: StudioSurface;
  exportedAt: string;
  doc: StudioDoc;
  assets: { id: string; name: string; mime: string; data: string }[];
}
