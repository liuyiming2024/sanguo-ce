// 适配点 ②：指针输入归一。
//
// 浏览器给 MouseEvent（clientX / clientY），小程序给 touch 事件
// （e.touches[0].clientX / clientY，或 e.changedTouches）。主工程装配层
// 那套「一律 clientX/clientY + 实时 rect 补一次命中」的经验可复用，
// 这里只把「取坐标」这一步收成纯函数，渲染层代码本轮不改。
//
// 本轮补多指：双指捏合需要一组触点与两指距离，仍纯函数、不碰 DOM。

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

/** 一组触点归一：小程序 touch 事件优先 touches，抬手时回落 changedTouches。 */
export function normalizeTouches(e) {
  const arr = e?.touches?.length ? e.touches
    : (e?.changedTouches?.length ? e.changedTouches : null);
  if (!Array.isArray(arr)) {
    const one = normalizePointer(e);
    return one ? [one] : [];
  }
  const out = [];
  for (const p of arr) {
    if (!Number.isFinite(p?.clientX) || !Number.isFinite(p?.clientY)) continue;
    out.push({ clientX: p.clientX, clientY: p.clientY });
  }
  return out;
}

/** 连续两点取中心（双指捏合的中点），纯函数，不碰 DOM。 */
export function midpoint(a, b) {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
}

/** 两点欧氏距离（纯数，不碰宿主）。 */
export function touchDistance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * 两次双指采样的缩放比：>1 是张开（放大视野 = 拉近），<1 是捏合。
 * 任一次不足两指或距离为 0 时返回 1（不缩放），绝不抛异常。
 */
export function pinchRatio(before, after) {
  const a = normalizeTouches(before), b = normalizeTouches(after);
  if (a.length < 2 || b.length < 2) return 1;
  const d0 = touchDistance(a[0], a[1]), d1 = touchDistance(b[0], b[1]);
  return d0 > 0 && Number.isFinite(d1) ? d1 / d0 : 1;
}
