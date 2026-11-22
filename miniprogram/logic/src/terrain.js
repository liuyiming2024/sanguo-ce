// 复杂栅格地形：144×108 格，确定性生成（同一 seed 永远同一张图）。
// 不是随机噪声拼贴：高程场叠加真实经纬度锚点（嵩山/太行、汉末黄河故道、
// 颍汝鸿沟、圃田/荥/大野泽、虎牢/轘辕关、汉末道路折线、十二座史实名城）。
// 每格有地形、底层地貌、土地等级、四资源时产、通行代价、归属与所属城。
import {
  CITIES, RIVER_HUANGHE, RIVERS_MINOR, LAKES, RIDGES, PASSES, ROADS,
  LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, geoToTile, cityById,
} from './map-data.js';

export const T = {
  PLAIN: 'plain', FARMLAND: 'farmland', FOREST: 'forest', HILL: 'hill',
  MOUNTAIN: 'mountain', RIVER: 'river', LAKE: 'lake', MARSH: 'marsh',
  ROAD: 'road', CITY: 'city', WALL: 'wall', GATE: 'gate',
  FORD: 'ford', PASS: 'pass',
};

export const TYPE_LABEL = {
  plain: '平原', farmland: '良田', forest: '林地', hill: '丘陵',
  mountain: '山地', river: '大河', lake: '泽薮', marsh: '沼泽',
  road: '官道', city: '城郭', wall: '城墙', gate: '城门',
  ford: '津渡', pass: '关隘',
};

// ── 确定性噪声 ──────────────────────────────────────────────────────────
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}
function fbm(x, y, seed, octaves = 5) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 7919) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

// 点到线段距离（格坐标）
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 折线最短距离：给出格点到整条折线的距离，用于刷河/山/路。 */
function polylineDist(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return best;
}

function geoPolyline(points, cols, rows) {
  return points.map(([lon, lat]) => {
    const p = geoToTile(lon, lat, cols, rows);
    return [p.c, p.r];
  });
}

// ── 主生成器 ────────────────────────────────────────────────────────────
export function createTerrain(cfg) {
  const TCFG = cfg.terrain;
  const cols = TCFG.cols, rows = TCFG.rows;
  const seed = TCFG.seed;
  const tiles = new Array(cols * rows);
  const at = (c, r) => tiles[r * cols + c];
  const inBounds = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  // 1) 基础高程场：fbm + 山脊锚点抬升。
  const ridgeLines = RIDGES.map((rg) => ({ ...rg, line: geoPolyline(rg.pts, cols, rows) }));
  const riverMain = geoPolyline(RIVER_HUANGHE, cols, rows);
  const riversMinor = RIVERS_MINOR.map((rv) => ({ ...rv, line: geoPolyline(rv.pts, cols, rows) }));
  const lakes = LAKES.map((lk) => {
    const p = geoToTile(lk.lon, lk.lat, cols, rows);
    const q = geoToTile(lk.lon + lk.rx, lk.lat - lk.ry, cols, rows);
    return { ...lk, c: p.c, r: p.r, rxT: Math.abs(q.c - p.c), ryT: Math.abs(q.r - p.r) };
  });

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nx = c / cols, ny = r / rows;
      const n = fbm(nx * 7.2, ny * 7.2, seed, TCFG.noiseOctaves);
      const n2 = fbm(nx * 15.5 + 31, ny * 15.5 + 17, seed + 991, 3);
      let elev = n * 0.62 + n2 * 0.18;
      // 山脊：距离衰减抬升
      for (const rg of ridgeLines) {
        const d = polylineDist(c, r, rg.line);
        const w = rg.width * cols * 0.5;
        if (d < w * 2.2) {
          const falloff = Math.max(0, 1 - d / (w * 2.2));
          elev += rg.height * falloff * falloff * 0.85;
        }
      }
      // 河谷：大河附近压低高程
      const dr = polylineDist(c, r, riverMain);
      if (dr < 9) elev -= (1 - dr / 9) * 0.18;
      elev = Math.max(0, Math.min(1.25, elev));

      let base;
      if (elev > 0.86) base = T.MOUNTAIN;
      else if (elev > 0.66) base = T.HILL;
      else if (n2 > 0.66 && elev < 0.5) base = T.FOREST;
      else if (elev < 0.28 && n2 < 0.38) base = T.MARSH;
      else if (n > 0.52 && elev < 0.5) base = T.FARMLAND;
      else base = T.PLAIN;

      tiles[r * cols + c] = {
        c, r,
        lon: LON_MIN + (c / (cols - 1)) * (LON_MAX - LON_MIN),
        lat: LAT_MAX - (r / (rows - 1)) * (LAT_MAX - LAT_MIN),
        base, type: base, elev,
        level: 1, y: { wood: 0, stone: 0, iron: 0, grain: 0 },
        cost: 1, owner: null, garrison: 0,
        cityId: null, name: null, road: false, ford: false, pass: false,
        feature: null,
      };
    }
  }

  // 2) 泽薮：椭圆覆盖成湖 + 一圈沼泽。
  for (const lk of lakes) {
    for (let r = Math.floor(lk.r - lk.ryT * 1.6); r <= Math.ceil(lk.r + lk.ryT * 1.6); r++) {
      for (let c = Math.floor(lk.c - lk.rxT * 1.6); c <= Math.ceil(lk.c + lk.rxT * 1.6); c++) {
        if (!inBounds(c, r)) continue;
        const d = Math.hypot((c - lk.c) / Math.max(1, lk.rxT), (r - lk.r) / Math.max(1, lk.ryT));
        const t = at(c, r);
        if (d <= 1) { t.type = T.LAKE; t.feature = lk.name; }
        else if (d <= 1.55 && t.type !== T.MOUNTAIN) { t.type = T.MARSH; t.feature = lk.name; }
      }
    }
  }

  // 3) 水系：黄河主干宽 2 格，支流窄 1 格；两侧生成滩涂/沼泽。
  function paintRiver(line, halfWidth, name, minor = false) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = polylineDist(c, r, line);
        const t = at(c, r);
        if (d <= halfWidth) {
          t.type = T.RIVER; t.feature = name; t.minor = minor;
        } else if (d <= halfWidth + 1.6 && t.type !== T.MOUNTAIN && t.type !== T.LAKE) {
          if (t.type !== T.MARSH) t.type = T.MARSH;
          t.feature = t.feature ?? name;
        }
      }
    }
  }
  paintRiver(riverMain, TCFG.riverWidthTiles, '黄河');
  for (const rv of riversMinor) paintRiver(rv.line, rv.width, rv.name, true);

  // 4) 城郭：按 rank 决定规模，外墙 + 角楼 + 城门；城门朝第一条道路方向。
  const cityTiles = {};
  for (const city of CITIES) {
    const p = geoToTile(city.lon, city.lat, cols, rows);
    const cc = Math.round(p.c), cr = Math.round(p.r);
    // 全境粗格：州郡缩成一格的点城（含城门），不铺 5×5 外墙，
    // 否则经纬度相近的州治会互相把对方城门盖成墙，A* 全线断掉。
    const compact = TCFG.cityWalls === false;
    const rad = compact ? 0 : (city.rank === 1 ? 2 : city.rank === 2 ? 2 : 1);
    if (compact) {
      const t = at(cc, cr);
      t.base = T.FARMLAND;
      t.type = T.GATE;
      t.cityId = city.id; t.owner = city.owner;
      t.feature = city.name;
      t.level = city.rank === 1 ? 9 : city.rank === 2 ? 7 : 5;
      t.gate = { cityId: city.id, side: 'C', c: cc, r: cr };
      // 点城也要有出口：粗格下山/河可能正好压在城门四周，
      // 不挖一格外道 A* 会从起点就判死。
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = cc + dc, r = cr + dr;
        if (!inBounds(c, r)) continue;
        const q = at(c, r);
        if (q.cityId) continue;
        if (q.type === T.RIVER || q.type === T.LAKE) { q.type = T.FORD; q.ford = true; }
        else if (q.type === T.MOUNTAIN) { q.type = T.PASS; q.pass = true; }
        else if (q.cost >= 90 || q.type === T.WALL) q.type = T.ROAD;
        q.road = true; q._linked = true; q.feature = `${city.name}外道`;
      }
      cityTiles[city.id] = { c: cc, r: cr, rad: 0, gate: [cc, cr], cells: [{ c: cc, r: cr, gate: true }] };
      continue;
    }
    const cells = [];
    // 朝第一个邻居的方向开一门（若没有则用东）
    const nb = ROADS.find((x) => x.a === city.id || x.b === city.id);
    const other = nb ? cityById(nb.a === city.id ? nb.b : nb.a) : null;
    let gateSide = 'E';
    if (other) {
      const q = geoToTile(other.lon, other.lat, cols, rows);
      const dx = q.c - cc, dy = q.r - cr;
      gateSide = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
    }
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const c = cc + dc, r = cr + dr;
        if (!inBounds(c, r)) continue;
        const t = at(c, r);
        const edge = Math.abs(dc) === rad || Math.abs(dr) === rad;
        t.base = T.FARMLAND;
        t.type = edge ? T.WALL : T.CITY;
        t.cityId = city.id;
        t.owner = city.owner;
        t.feature = city.name;
        t.level = city.rank === 1 ? 9 : city.rank === 2 ? 7 : 5;
        cells.push({ c, r, edge });
      }
    }
    // 城门：外墙中点一格
    const gp = {
      E: [cc + rad, cr], W: [cc - rad, cr], S: [cc, cr + rad], N: [cc, cr - rad],
    }[gateSide];
    if (inBounds(gp[0], gp[1])) {
      const g = at(gp[0], gp[1]);
      g.type = T.GATE; g.cityId = city.id; g.owner = city.owner;
      g.gate = { cityId: city.id, side: gateSide, c: gp[0], r: gp[1] };
      cells.push({ c: gp[0], r: gp[1], gate: true });
    }
    cityTiles[city.id] = { c: cc, r: cr, rad, gate: gp, cells };
  }

  // 5) 道路：沿 via 折线刷格；遇河/山自动降级为津渡/关隘以保证连通。
  function roadPolyline(rd) {
    const a = cityById(rd.a), b = cityById(rd.b);
    const pts = [[a.lon, a.lat], ...rd.via, [b.lon, b.lat]];
    return geoPolyline(pts, cols, rows);
  }
  for (const rd of ROADS) {
    const line = roadPolyline(rd);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = polylineDist(c, r, line);
        if (d > TCFG.roadWidthTiles + 0.35) continue;
        const t = at(c, r);
        if (t.cityId) continue;                     // 不覆盖城郭
        if (t.type === T.RIVER) {
          t.type = T.FORD; t.ford = true; t.road = true; t.feature = rd.name;
        } else if (t.type === T.MOUNTAIN) {
          t.type = T.PASS; t.pass = true; t.road = true; t.feature = rd.name;
        } else if (t.type === T.LAKE) {
          // 湖上不修路：绕行由 A* 处理
        } else {
          t.type = T.ROAD; t.road = true; t.feature = rd.name;
        }
      }
    }
  }

  // 6) 关隘 / 津渡锚点：强制打通（把山/河改成 pass/ford 并连到最近道路）。
  for (const p of PASSES) {
    const g = geoToTile(p.lon, p.lat, cols, rows);
    const c = Math.round(g.c), r = Math.round(g.r);
    if (!inBounds(c, r)) continue;
    const t = at(c, r);
    if (t.cityId) continue;   // 城池自带城门，不能被津渡覆盖掉
    t.type = p.kind === 'ford' ? T.FORD : T.PASS;
    t[p.kind] = true;
    t.road = true;
    t.feature = p.name;
    t.name = p.name;
    // 半径 1 也打通，避免斜向卡死
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = inBounds(c + dc, r + dr) ? at(c + dc, r + dr) : null;
      if (q && !q.cityId && !q.gate && (q.type === T.RIVER || q.type === T.MOUNTAIN)) {
        q.type = t.type; q[p.kind] = true; q.road = true; q.feature = p.name;
      }
    }
  }

  // 6.5) 城门接线：城门若被河/山/泽完全封死（例如汝南城门正对汝水），
  // 沿城门朝向刷一条短堤道到原生可通行地，保证任意两城 A* 可达。
  // 只刷到第一块非山水的地形为止，不会在全图切出笔直长路。
  for (const city of CITIES) {
    const info = cityTiles[city.id];
    const [gc, gr] = info.gate;
    const dx = Math.sign(gc - info.c), dy = Math.sign(gr - info.r);
    let c = gc, r = gr;
    for (let k = 0; k < 10; k++) {
      c += dx; r += dy;
      if (!inBounds(c, r)) break;
      const t = at(c, r);
      if (t.cityId) continue;
      const blocked = [T.RIVER, T.LAKE, T.MOUNTAIN, T.WALL].includes(t.type);
      if (!blocked && !t._linked) break;      // 已接上原生可通行地
      if (t.type === T.RIVER || t.type === T.LAKE) { t.type = T.FORD; t.ford = true; }
      else if (t.type === T.MOUNTAIN) { t.type = T.PASS; t.pass = true; }
      else t.type = T.ROAD;
      t.road = true; t._linked = true;
      t.feature = `${city.name}外道`;
    }
  }

  // 6.6) 全境粗格：道路图的每一条边都在格网上刻一条可通行带。
  // 粗格下折线刷格会在山/泽/河处留断层，直线通路能兜住连通性，
  // 且只在 cityWalls:false 的点城图上跑，官渡本图一行不受影响。
  if (TCFG.cityWalls === false) {
    for (const rd of ROADS) {
      const a = cityTiles[rd.a], b = cityTiles[rd.b];
      if (!a || !b) continue;
      const steps = Math.max(1, Math.abs(b.c - a.c), Math.abs(b.r - a.r)) * 2;
      for (let k = 0; k <= steps; k++) {
        const c = Math.round(a.c + (b.c - a.c) * k / steps);
        const r = Math.round(a.r + (b.r - a.r) * k / steps);
        if (!inBounds(c, r)) continue;
        const t = at(c, r);
        if (t.cityId) continue;
        if (t.type === T.RIVER || t.type === T.LAKE) { t.type = T.FORD; t.ford = true; }
        else if (t.type === T.MOUNTAIN) { t.type = T.PASS; t.pass = true; }
        else if ([T.RIVER, T.LAKE, T.MOUNTAIN, T.WALL].includes(t.type)) t.type = T.ROAD;
        t.road = true; t._linked = true; t.feature = rd.name;
      }
    }
  }

  // 7) 初始领地：城郭外扩 cityRadiusTiles 圈，山/水不占。
  for (const city of CITIES) {
    const info = cityTiles[city.id];
    const rad = info.rad + TCFG.cityRadiusTiles;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const c = info.c + dc, r = info.r + dr;
        if (!inBounds(c, r)) continue;
        const t = at(c, r);
        if (t.owner) continue;
        if ([T.RIVER, T.LAKE, T.MOUNTAIN, T.WALL].includes(t.type)) continue;
        t.owner = city.owner;
      }
    }
  }

  // 8) 派生：土地等级、四资源产出、通行代价。
  const Y = TCFG.yield, COST = TCFG.moveCost;
  for (const t of tiles) {
    if (!t.type) t.type = t.base;
    // 等级：高程/林地/距城加成，山地与水域不产资源
    if ([T.RIVER, T.LAKE, T.WALL, T.GATE, T.ROAD, T.FORD, T.PASS, T.CITY].includes(t.type)) {
      t.level = t.cityId ? 9 : 1;
    } else {
      const nearCity = CITIES.reduce((m, ci) => {
        const p = geoToTile(ci.lon, ci.lat, cols, rows);
        return Math.min(m, Math.hypot(t.c - p.c, t.r - p.r));
      }, Infinity);
      const bonus = nearCity < 12 ? 2 : nearCity < 24 ? 1 : 0;
      const wild = t.type === T.MOUNTAIN || t.type === T.FOREST ? 2 : 0;
      t.level = Math.max(1, Math.min(TCFG.maxLandLevel,
        Math.round(2 + t.elev * 3 + fbm(t.c * 0.11, t.r * 0.11, seed + 555, 3) * 3 + bonus + wild)));
    }
    const basis = Y;
    const lv = 0.55 + t.level * 0.19;
    if (![T.RIVER, T.LAKE, T.WALL, T.GATE, T.ROAD, T.FORD, T.PASS].includes(t.type)) {
      for (const k of ['wood', 'stone', 'iron', 'grain']) {
        const b = basis[k]?.[t.base] ?? 0;
        t.y[k] = Math.round(b * lv * 100) / 100;
      }
      // 城郭周边良田加成
      if (t.cityId) t.y.grain = Math.round(t.y.grain * 1.4 * 100) / 100;
    }
    t.cost = COST[t.type] ?? 1;
  }

  const terrain = {
    cfg, cols, rows, tiles, at, inBounds, cityTiles,
    riverMain, riversMinor, ridgeLines, lakes,
    // 索引：按类型/归属快速取格
    byOwner(owner) { return tiles.filter((t) => t.owner === owner); },
    cityCenter(id) {
      const x = cityTiles[id];
      return x ? { c: x.c, r: x.r, gate: x.gate } : null;
    },
    tileAtGeo(lon, lat) {
      const p = geoToTile(lon, lat, cols, rows);
      const c = Math.round(p.c), r = Math.round(p.r);
      return inBounds(c, r) ? at(c, r) : null;
    },
    describe(c, r) {
      const t = inBounds(c, r) ? at(c, r) : null;
      if (!t) return null;
      return {
        c, r, type: t.type, label: TYPE_LABEL[t.type] ?? t.type,
        base: t.base, level: t.level, elev: Math.round(t.elev * 100),
        yield: t.y, cost: t.cost, owner: t.owner,
        cityId: t.cityId, name: t.name ?? t.feature ?? null,
      };
    },
  };
  return terrain;
}

/** 统计用：各类地形格数，给自检与文档看。 */
export function terrainStats(terrain) {
  const counts = {};
  let owned = 0, passable = 0;
  for (const t of terrain.tiles) {
    counts[t.type] = (counts[t.type] ?? 0) + 1;
    if (t.owner) owned++;
    if (t.cost < 90) passable++;
  }
  return { total: terrain.cols * terrain.rows, counts, owned, passable };
}
