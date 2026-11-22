// 适配点 ③：画布节点获取。
//
// 浏览器 document.querySelector(css).getContext('2d')；
// 小程序没有 DOM，得用 wx.createSelectorQuery().select(css).fields({node:true,size:true})
// 异步拿 node，再 node.getContext('2d')，且要按 dpr 缩放 width/height。
//
// 本轮只暴露接口与回调式适配，不改动主工程任何渲染层代码：
// 「皮必须重写，但重写的是皮，不是引擎」——引擎层压根不该知道画布从哪来。

/** 浏览器：同步取 2d context。无 DOM 时返回 null，交给调用方降级。 */
export function browserCanvas(selector, { alpha = false } = {}) {
  if (typeof document === 'undefined' || !document.querySelector) return null;
  const el = document.querySelector(selector);
  if (!el?.getContext) return null;
  return { node: el, ctx: el.getContext('2d', { alpha }), width: el.width, height: el.height };
}

/**
 * 小程序：异步取 node。调用方传 wx，返回 Promise。
 * 尺寸按 dpr 换算，逻辑坐标仍由渲染层自己算；这里不构造任何 Path2D / Image。
 */
export function wxCanvas(selector, wx, { dpr = 2 } = {}) {
  return new Promise((resolve, reject) => {
    if (!wx?.createSelectorQuery) { reject(new Error('wxCanvas 需要传入 wx')); return; }
    wx.createSelectorQuery()
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => {
        const r = res?.[0];
        if (!r?.node) { resolve(null); return; }
        const node = r.node;
        node.width = Math.round(r.width * dpr);
        node.height = Math.round(r.height * dpr);
        resolve({ node, ctx: node.getContext('2d'),
          width: r.width, height: r.height, dpr });
      });
  });
}
