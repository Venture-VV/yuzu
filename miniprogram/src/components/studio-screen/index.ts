// 工作台 · 一整屏版面容器（首页、活动页、我的页共用）：普通节点交给 studio-node，功能块留静态具名 slot 由所在页面画真实业务模块。
import type { MpStudioAction } from '../../../../src/shared/mp';

Component({
  options: {
    multipleSlots: true,
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },
  properties: {
    screen: {
      type: Object,
      value: null,
    },
  },
  methods: {
    onNodeAction(e: WechatMiniprogram.CustomEvent<MpStudioAction>) {
      if (e && e.detail) this.triggerEvent('action', e.detail);
    },
  },
});
