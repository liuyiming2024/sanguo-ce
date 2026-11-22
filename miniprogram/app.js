// 轻量验证版：全局不持有局面。
// P1：启动时把小程序的本机存储注入 src/platform/，镜像逻辑层因此一行不用改。
// 传帖台页面仍用 wx.getStorageSync 管自己的近帖，两边互不干扰。
import { installHost } from './utils/slice-core.js';

App({
  onLaunch() {
    installHost({ wx });
  },
});
