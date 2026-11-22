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
 * 绘制指令消费层：把 miniMapDrawOps() 产出的归一化指令（坐标 0..1）
 * 乘上画布宽高喂给任意 duck-typed 2d ctx。
 *
 * 这一层刻意纯函数化：不引用 document / window / wx / Path2D / Image，
 * 只调用传入 ctx 的方法。于是 Node 里用「记录型假 ctx」就能逐条断言
 * 调用序列，真机上把 wxCanvas() 拿到的真 ctx 传进来即可，数据层一行不改。
 *
 * @returns {number} 实际画出的指令条数（未知 type 静默跳过，不抛异常）
 */
export function applyDrawOps(ctx, ops, width, height, { dpr = 1, clear = true } = {}) {
  if (!ctx || !Array.isArray(ops)) return 0;
  const W = width * dpr, H = height * dpr;
  if (!(Number.isFinite(W) && Number.isFinite(H)) || W <= 0 || H <= 0) return 0;
  if (clear && typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, W, H);
  let n = 0;
  for (const o of ops) {
    if (o.type === 'fillRect') {
      if (typeof ctx.fillStyle !== 'undefined') ctx.fillStyle = o.fill;
      ctx.fillRect(o.x * W, o.y * H, o.w * W, o.h * H);
      n++;
    } else if (o.type === 'circle') {
      if (typeof ctx.fillStyle !== 'undefined') ctx.fillStyle = o.fill;
      // miniMapDrawOps 的 r 是相对 min(1/cols, 1/rows) 的归一化量，
      // 这里按画布短边还原，保证 W≠H 时仍是正圆而非椭圆。
      if (typeof ctx.beginPath === 'function') ctx.beginPath();
      if (typeof ctx.arc === 'function') {
        ctx.arc(o.x * W, o.y * H, o.r * Math.min(W, H), 0, Math.PI * 2);
        ctx.fill?.();
      }
      n++;
    }
  }
  return n;
}

/** 取宿主像素比：优先新 API，回落旧 API，最后按 2 兜底，不抛异常。 */
export function hostDpr(wx) {
  try {
    const d = wx?.getWindowInfo?.()?.pixelRatio ?? wx?.getSystemInfoSync?.()?.pixelRatio;
    return Number.isFinite(d) && d > 0 ? d : 2;
  } catch { return 2; }
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
