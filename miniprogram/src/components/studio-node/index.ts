// 工作台 · 单个版面节点的递归渲染组件（docs/STUDIO_MP.md 第 3 节）。
// virtualHost: true 让内部根 view 直接作为父 flex / 自由定位容器的子项，避免自定义组件宿主盒子干扰尺寸撑满与间距。
import type { MpStudioAction } from '../../../../src/shared/mp';
import type { RenderNode } from '../../utils/studio-style';

Component({
  options: {
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },
  properties: {
    node: {
      type: Object,
      value: null,
    },
  },
  methods: {
    onTap() {
      const n = (this.data as { node: RenderNode | null }).node;
      if (!n || !n.hasAction || !n.action) return;
      this.triggerEvent('action', n.action);
    },
    onChildAction(e: WechatMiniprogram.CustomEvent<MpStudioAction>) {
      if (e && e.detail) this.triggerEvent('action', e.detail);
    },
  },
});
