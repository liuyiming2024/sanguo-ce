// 适配点 ①：本机存储。
//
// 逻辑层 / 持久层只认 getItem / setItem / removeItem 三个同步方法，
// 宿主由 configurePlatform() 注入，不再直接碰 localStorage 或 wx.*。
// 三条驱动：
//   · 浏览器：localStorage（不可用时整条静默降级，绝不影响开局）
//   · 小程序：wx.getStorageSync / setStorageSync / removeStorageSync
//   · Node / 无宿主：进程内 Map（node --test 用，也可注入自己的 mock）
//
// 刻意保持与 localStorage 相同的同步签名：persist.js / save-slots.js 只需换
// 一处 import，不引入 Promise、不引入构建链。

function memoryDriver() {
  const m = new Map();
  return {
    name: 'memory',
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function browserDriver() {
  return {
    name: 'browser',
    getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    setItem: (k, v) => { try { localStorage.setItem(k, String(v)); return true; } catch { return false; } },
    removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
  };
}

/** 小程序驱动：调用方传 wx，避免本文件里出现全局 wx 依赖。 */
export function wxStorageDriver(wx) {
  if (!wx?.getStorageSync || !wx?.setStorageSync) {
    throw new Error('wxStorageDriver 需要传入可用的 wx 对象');
  }
  return {
    name: 'miniprogram',
    getItem: (k) => {
      try {
        const v = wx.getStorageSync(k);
        // 微信拿不到 key 时返回 ''（不是 null），归一成 null 才与浏览器同语义。
        return v === '' || v === undefined ? null : v;
      } catch { return null; }
    },
    setItem: (k, v) => {
      try { wx.setStorageSync(k, String(v)); return true; } catch { return false; }
    },
    removeItem: (k) => {
      try { wx.removeStorageSync(k); } catch { /* 忽略 */ }
    },
  };
}

export function detectStorage() {
  if (typeof localStorage !== 'undefined') return browserDriver();
  return memoryDriver();
}

export { memoryDriver, browserDriver };
