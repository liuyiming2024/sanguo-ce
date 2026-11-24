// src/platform/ —— 薄适配层（P1）。
//
// 四个适配点：① storage ② input→clientX,Y ③ canvas 节点 ④ now / randomBytes 注入。
// 逻辑层与持久层只 import 这里，不再直接碰任何宿主 API；小程序端把同一份
// src/ 镜像过去，App 启动时 configurePlatform({ storage: wxStorageDriver(wx) })，
// 其余 ESM 相对路径一字不改。
//
// 这一层刻意不引入构建链、不引入 Promise（storage/now 全同步）、不引用 DOM。
// 浏览器默认驱动由 detectPlatform() 自动挑；Node 默认走内存 Map + 可注入时钟。

import { detectStorage, memoryDriver, wxStorageDriver, browserDriver } from './storage.js';

export { wxStorageDriver, memoryDriver, browserDriver };
export { normalizePointer, normalizeTouches, midpoint, touchDistance, pinchRatio } from './input.js';
export { browserCanvas, wxCanvas, applyDrawOps, hostDpr } from './canvas.js';

let _storage = null;
let _now = null;
let _randomBytes = null;

export function detectPlatform() {
  if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') return 'miniprogram';
  if (typeof window !== 'undefined' && typeof document !== 'undefined') return 'browser';
  return 'node';
}

/**
 * 注入宿主。可只覆盖其中一两项；未覆盖的按当前环境自动挑。
 * 测试里 configurePlatform({ now: () => 1234 }) 即可把「存时」钉死。
 */
export function configurePlatform(overrides = {}) {
  if (overrides.storage !== undefined) _storage = overrides.storage;
  if (overrides.now !== undefined) _now = overrides.now;
  if (overrides.randomBytes !== undefined) _randomBytes = overrides.randomBytes;
  return currentPlatform();
}

/** 恢复自动探测（单测之间互不污染）。 */
export function resetPlatform() {
  _storage = null; _now = null; _randomBytes = null;
  return currentPlatform();
}

export function currentPlatform() {
  return { platform: detectPlatform(), storageName: storage().name };
}

export function storage() {
  if (!_storage) _storage = detectStorage();
  return _storage;
}

/** 墙钟只在「存档元数据 / 短号过期」这类不影响玩法的地方用，且不进状态指纹。 */
export function now() {
  return (_now ?? Date.now)();
}

/**
 * 随机字节：默认用 Math.random 兜底，但调用方可注入确定性源。
 * 注意：策略 / 战斗 / 重放链路一律走 src/rng.js 的 createRng，不经过这里。
 */
export function randomBytes(n) {
  if (_randomBytes) return _randomBytes(n);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}
