// 绘制指令层：皮与引擎之间的薄契约（P4「程序化回退」的数据侧）。
//
// 不碰 DOM / Canvas / wx / 位图，只把 state.terrain.tiles（144×108）降采样成
// 一份纯 JSON 的格网色块 + fillRect 指令。浏览器端把指令喂给 2d ctx，
// 小程序端用 WXML view 色块（或 wxCanvas 拿到的 ctx）消费同一份数据。
//
// 同 seed + 同 state + 同视口 必得同一份 cells，故可进端侧烟测逐字段断言。
//
// 本轮从「18×14 静态缩略」推进成「带视口与命中的可交互格网」：
//   · box 视口：默认全图时输出与旧版逐字一致（回归基线不破），传 box 看局部
//   · camera：pan / zoomAt / reset 全是纯函数，无墙钟、无随机
//   · 命中：resolveMiniMapHit 复用 input.js 的 normalizePointer，把
//     mouse / touch / changedTouches / detail 四种事件形状 + 实时 rect 归一成格坐标
// 三条皮（浏览器 2d ctx / 小程序 WXML 色块 / 小程序 canvas 2d）共用同一份数据。

import { normalizePointer } from './input.js';

export const MINI_MAP = {
  cols: 18, rows: 14,
  // 视口最小跨度（源格）：再放大就只是把同一格铺满，没信息量了。
  minSpanC: 12, minSpanR: 9,
  palette: {
    cao: '#3e5c46',      // 司空府 · 青绿
    yuan: '#8c2f24',     // 河北 · 绛
    liu: '#9c7b3f',      // 客势 · 赭
    neutral: '#d8cdb0',  // 无主 · 纸
  },
  // 平局时的确定性优先级，绝不靠 Object.keys 顺序
  tie: ['cao', 'yuan', 'liu', ''],
  cityInk: '#20211f',
  // 无主格按主导地貌给淡色：零位图时仍能看出山河大势，不至于整幅纸白。
  terrainPalette: {
    plain: '#e2d9bf', farmland: '#cfd2ad', forest: '#b9c4a6',
    hill: '#cfc2a2', mountain: '#b9ae96', river: '#a9bfc0',
    lake: '#9fb8bb', marsh: '#c3c6b0', road: '#d6c9a8',
    city: '#c8b98f', wall: '#c8b98f', gate: '#c8b98f',
    ford: '#a9bfc0', pass: '#b9ae96',
  },
  terrainTie: ['river', 'lake', 'marsh', 'mountain', 'hill', 'forest',
    'farmland', 'plain', 'road', 'city', 'wall', 'gate', 'ford', 'pass'],
  _note: '降采样取覆盖范围内 owner / 地貌众数；平局按固定序，不引入随机与墙钟。',
};

function ownerOf(t) { return t?.owner ?? ''; }

/** 源图尺寸：优先 state.cfg.terrain，回落按格数推 4:3。 */
export function miniMapSize(state) {
  const tiles = state?.terrain?.tiles ?? [];
  const cfg = state?.cfg?.terrain;
  const W = cfg?.cols ?? (Math.round(Math.sqrt(tiles.length * 4 / 3)) || 144);
  const H = cfg?.rows ?? (Math.round(tiles.length / W) || 108);
  return { W, H };
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

/** 全图视口。 */
export function fullBox(state) {
  const { W, H } = miniMapSize(state);
  return { c0: 0, r0: 0, c1: W, r1: H };
}

/** 视口夹取：跨度不小于 minSpan、不超全图，左上角不越界。 */
export function clampBox(box, W, H, minC = MINI_MAP.minSpanC, minR = MINI_MAP.minSpanR) {
  const mc = Math.min(W, Math.max(1, minC)), mr = Math.min(H, Math.max(1, minR));
  let c0 = clampNum(box?.c0, 0, W - mc), r0 = clampNum(box?.r0, 0, H - mr);
  let c1 = clampNum(box?.c1, c0 + mc, W), r1 = clampNum(box?.r1, r0 + mr, H);
  // 兜底：极端输入下仍保证合法闭开区间
  if (c1 <= c0) c1 = Math.min(W, c0 + mc);
  if (r1 <= r0) r1 = Math.min(H, r0 + mr);
  return { c0, r0, c1, r1 };
}

/** 平移：dc/dr 是「源格」增量，正数视野往右/下走。 */
export function panBox(box, dc, dr, W, H) {
  const b = clampBox(box, W, H);
  const spanC = b.c1 - b.c0, spanR = b.r1 - b.r0;
  const c0 = clampNum(b.c0 + dc, 0, W - spanC);
  const r0 = clampNum(b.r0 + dr, 0, H - spanR);
  return { c0, r0, c1: c0 + spanC, r1: r0 + spanR };
}

/**
 * 以 anchor（归一化 0..1，相对当前视口）为中心缩放。
 * factor > 1 = 拉近（视野跨度变小，看得更细）；< 1 = 拉远。
 * 缩放前后 anchor 指向的源格位置保持不动，这是「指哪缩哪」的关键。
 */
export function zoomBox(box, factor, anchor = { x: 0.5, y: 0.5 }, W, H,
  minC = MINI_MAP.minSpanC, minR = MINI_MAP.minSpanR) {
  const b = clampBox(box, W, H, minC, minR);
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const spanC = b.c1 - b.c0, spanR = b.r1 - b.r0;
  const mc = Math.min(W, Math.max(1, minC)), mr = Math.min(H, Math.max(1, minR));
  const newC = clampNum(spanC / f, mc, W), newR = clampNum(spanR / f, mr, H);
  const ax = clampNum(anchor?.x ?? 0.5, 0, 1), ay = clampNum(anchor?.y ?? 0.5, 0, 1);
  const c0 = b.c0 + ax * (spanC - newC), r0 = b.r0 + ay * (spanR - newR);
  return clampBox({ c0, r0, c1: c0 + newC, r1: r0 + newR }, W, H, minC, minR);
}

/** 从 opts 取视口：opts.box / opts.view 皆可，缺省全图。 */
export function boxOf(state, opts = {}) {
  const { W, H } = miniMapSize(state);
  return clampBox(opts.box ?? opts.view ?? fullBox(state), W, H);
}

/** 当前放大倍率（全图 = 1）。 */
export function boxZoom(state, box) {
  const { H } = miniMapSize(state);
  const b = boxOf(state, { box });
  return H / (b.r1 - b.r0);
}

/**
 * 轻量相机：页面持有它，一串操作后 box 完全确定，无墙钟 / 无随机 / 不碰宿主。
 * 每次操作返回 box 的副本；get box 也返回副本，外部改不动内部状态。
 */
export function createMiniCamera(state, opts = {}) {
  const { W, H } = miniMapSize(state);
  const cols = opts.cols ?? MINI_MAP.cols, rows = opts.rows ?? MINI_MAP.rows;
  let box = boxOf(state, opts);
  const copy = () => ({ ...box });
  return {
    get box() { return copy(); },
    pan(dc, dr) { box = panBox(box, dc, dr, W, H); return copy(); },
    zoom(factor, anchor) { box = zoomBox(box, factor, anchor, W, H); return copy(); },
    reset() { box = fullBox(state); return copy(); },
    zoomLevel() { return boxZoom(state, box); },
    opts() { return { cols, rows, box: copy() }; },
  };
}

/** 某个输出格覆盖的源格范围：cells 与 hit 共用，保证两处口径一致。 */
function bucket(oc, or, cols, rows, b) {
  const BW = b.c1 - b.c0, BH = b.r1 - b.r0;
  const c0 = b.c0 + Math.floor(oc * BW / cols);
  const c1 = Math.max(c0 + 1, b.c0 + Math.floor((oc + 1) * BW / cols));
  const r0 = b.r0 + Math.floor(or * BH / rows);
  const r1 = Math.max(r0 + 1, b.r0 + Math.floor((or + 1) * BH / rows));
  return { c0, c1, r0, r1 };
}

/**
 * 纯函数：把栅格（或指定视口）降采样成 cols×rows 的 owner 色块矩阵。
 * opts.box / opts.view 给定视口；不给时输出与旧版 18×14 全图逐字一致。
 */
export function miniMapCells(state, opts = {}) {
  const cols = opts.cols ?? MINI_MAP.cols;
  const rows = opts.rows ?? MINI_MAP.rows;
  const tiles = state?.terrain?.tiles ?? [];
  const { W, H } = miniMapSize(state);
  const b = boxOf(state, opts);
  const at = (c, r) => (r >= 0 && r < H && c >= 0 && c < W ? tiles[r * W + c] : null);

  const cells = [];
  for (let or = 0; or < rows; or++) {
    for (let oc = 0; oc < cols; oc++) {
      const { c0, c1, r0, r1 } = bucket(oc, or, cols, rows, b);
      const tally = { cao: 0, yuan: 0, liu: 0, '': 0 };
      const byType = {};
      let city = false;
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const t = at(c, r);
          const o = ownerOf(t);
          if (Object.prototype.hasOwnProperty.call(tally, o)) tally[o]++;
          else tally['']++;   // 未知归属一律按无主计，不抛异常
          const ty = t?.type ?? 'plain';
          byType[ty] = (byType[ty] ?? 0) + 1;
          if (t?.cityId) city = true;
        }
      }
      let owner = MINI_MAP.tie[0], best = -1;
      for (const k of MINI_MAP.tie) {
        if (tally[k] > best) { best = tally[k]; owner = k; }
      }
      let major = 'plain', bestType = -1;
      for (const k of MINI_MAP.terrainTie) {
        if ((byType[k] ?? 0) > bestType) { bestType = byType[k] ?? 0; major = k; }
      }
      const color = owner
        ? (MINI_MAP.palette[owner] ?? MINI_MAP.palette.neutral)
        : (MINI_MAP.terrainPalette[major] ?? MINI_MAP.palette.neutral);
      cells.push({ c: oc, r: or, owner, terrain: major, city, color });
    }
  }
  return {
    cols, rows, srcCols: W, srcRows: H, cells,
    box: { ...b }, zoom: boxZoom(state, b),
    legend: { ...MINI_MAP.palette },
  };
}

/**
 * 命中：point 是相对画布的归一化坐标 0..1。
 * 返回降采样色块信息 + 该格中心对应的**真实源格**信息，越界返回 null。
 */
export function hitTestMiniMap(state, opts = {}, point = null) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const cols = opts.cols ?? MINI_MAP.cols, rows = opts.rows ?? MINI_MAP.rows;
  if (point.x < 0 || point.y < 0 || point.x >= 1 || point.y >= 1) return null;
  const oc = Math.floor(point.x * cols), or = Math.floor(point.y * rows);
  const m = miniMapCells(state, opts);
  const cell = m.cells.find((c) => c.c === oc && c.r === or);
  if (!cell) return null;

  const b = m.box;
  const { c0, c1, r0, r1 } = bucket(oc, or, cols, rows, b);
  const sc = Math.floor((c0 + c1) / 2), sr = Math.floor((r0 + r1) / 2);
  const tiles = state?.terrain?.tiles ?? [];
  const tile = tiles[sr * m.srcCols + sc] ?? null;
  return {
    c: oc, r: or,                       // 输出格坐标
    sc, sr, tileIndex: tile ? sr * m.srcCols + sc : null,
    owner: tile?.owner ?? '',
    terrain: tile?.type ?? cell.terrain,
    cityId: tile?.cityId ?? null,
    city: cell.city,
    color: cell.color,
    box: b,
    zoom: m.zoom,
  };
}

/**
 * 事件 → 命中：主工程那套「一律 clientX/clientY + 实时 rect 补一次命中」。
 * rect = { left, top, width, height }（由宿主 selectorQuery 实时给）。
 * mouse / touch / changedTouches / detail 四种形状统统经 normalizePointer 归一。
 */
export function resolveMiniMapHit(e, rect, state, opts = {}) {
  const p = normalizePointer(e);
  if (!p || !rect?.width || !rect?.height) return null;
  const x = (p.clientX - (rect.left ?? 0)) / rect.width;
  const y = (p.clientY - (rect.top ?? 0)) / rect.height;
  const hit = hitTestMiniMap(state, opts, { x, y });
  return hit ? { ...hit, source: p.source, norm: { x, y } } : null;
}

/**
 * 纯绘制指令：坐标归一化到 0..1，宿主自己乘画布宽高。
 * 没有任何函数 / ctx / DOM 引用，JSON.stringify 后就能跨端传。
 */
export function miniMapDrawOps(state, opts = {}) {
  const m = miniMapCells(state, opts);
  const w = 1 / m.cols, h = 1 / m.rows;
  const ops = m.cells.map((c) => ({
    type: 'fillRect', x: c.c * w, y: c.r * h, w, h, fill: c.color,
  }));
  for (const c of m.cells) {
    if (!c.city) continue;
    ops.push({ type: 'circle', x: (c.c + 0.5) * w, y: (c.r + 0.5) * h,
      r: Math.min(w, h) * 0.22, fill: MINI_MAP.cityInk });
  }
  return { cols: m.cols, rows: m.rows, zoom: m.zoom, box: m.box, ops };
}

/** WXML 色块用的扁平列表（与 cells 同序，只带渲染需要的字段）。 */
export function miniMapView(state, opts = {}) {
  const m = miniMapCells(state, opts);
  return { cols: m.cols, rows: m.rows, zoom: m.zoom, box: m.box,
    cells: m.cells.map((c) => ({ k: `${c.c}-${c.r}`, color: c.color,
      city: c.city, owner: c.owner, terrain: c.terrain })) };
}
