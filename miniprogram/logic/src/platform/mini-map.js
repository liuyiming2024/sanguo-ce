// 绘制指令层：皮与引擎之间的薄契约（P4「程序化回退」的数据侧）。
//
// 不碰 DOM / Canvas / wx / 位图，只把 state.terrain.tiles（144×108）降采样成
// 一份纯 JSON 的格网色块 + fillRect 指令。浏览器端把指令喂给 2d ctx，
// 小程序端用 WXML view 色块（或 wxCanvas 拿到的 ctx）消费同一份数据。
//
// 这就是「首包零位图也能跑」的可视口径：四张 sheet 不进包时，格网仍由
// 逻辑层数据确定性生成；皮重写只重写怎么画，不重写画什么。
// 同 seed + 同 state 必得同一份 cells，故可进端侧烟测逐字段断言。

export const MINI_MAP = {
  cols: 18, rows: 14,
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

/**
 * 纯函数：把整幅栅格降采样成 cols×rows 的 owner 色块矩阵。
 * @returns {{ cols:number, rows:number, srcCols:number, srcRows:number,
 *             cells:Array<{c,r,owner,color,city:boolean}>, legend:object }}
 */
export function miniMapCells(state, opts = {}) {
  const cols = opts.cols ?? MINI_MAP.cols;
  const rows = opts.rows ?? MINI_MAP.rows;
  const tiles = state?.terrain?.tiles ?? [];
  const cfg = state?.cfg?.terrain;
  const W = cfg?.cols ?? (Math.round(Math.sqrt(tiles.length * 4 / 3)) || 144);
  const H = cfg?.rows ?? (Math.round(tiles.length / W) || 108);
  const at = (c, r) => (r >= 0 && r < H && c >= 0 && c < W ? tiles[r * W + c] : null);

  const cells = [];
  for (let or = 0; or < rows; or++) {
    const r0 = Math.floor(or * H / rows), r1 = Math.max(r0 + 1, Math.floor((or + 1) * H / rows));
    for (let oc = 0; oc < cols; oc++) {
      const c0 = Math.floor(oc * W / cols), c1 = Math.max(c0 + 1, Math.floor((oc + 1) * W / cols));
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
    legend: { ...MINI_MAP.palette },
  };
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
  return { cols: m.cols, rows: m.rows, ops };
}

/** WXML 色块用的扁平列表（与 cells 同序，只带渲染需要的字段）。 */
export function miniMapView(state, opts = {}) {
  const m = miniMapCells(state, opts);
  return { cols: m.cols, rows: m.rows,
    cells: m.cells.map((c) => ({ k: `${c.c}-${c.r}`, color: c.color,
      city: c.city, owner: c.owner, terrain: c.terrain })) };
}
