// 适配点 ②：指针输入归一。
//
// 浏览器给 MouseEvent（clientX / clientY），小程序给 touch 事件
// （e.touches[0].clientX / clientY，或 e.changedTouches）。主工程装配层
// 那套「一律 clientX/clientY + 实时 rect 补一次命中」的经验可复用，
// 这里只把「取坐标」这一步收成纯函数，渲染层代码本轮不改。

/** @returns {{ clientX:number, clientY:number, source:string } | null} */
export function normalizePointer(e) {
  if (!e) return null;
  const p = e.clientX !== undefined ? e
    : (e.touches?.[0] ?? e.changedTouches?.[0] ?? e.detail ?? null);
  if (!p || !Number.isFinite(p.clientX) || !Number.isFinite(p.clientY)) return null;
  return {
    clientX: p.clientX,
    clientY: p.clientY,
    source: e.clientX !== undefined ? 'mouse'
      : (e.touches?.[0] ? 'touch' : (e.changedTouches?.[0] ? 'changedTouch' : 'detail')),
  };
}

/** 连续两点取中心（双指捏合的中点），纯函数，不碰 DOM。 */
export function midpoint(a, b) {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
}
