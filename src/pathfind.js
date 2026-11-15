// 格子级寻路：8 向 A*（禁止贴角穿山），代价取 terrain.tile.cost。
// 「连地」采用率土式规则：目标格必须与己方领地连通（8 邻域内有己方格），
// 出征不是飞地；主力沿 A* 路径逐格行军，耗时按累计代价折算成回合。
import { LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, distKm, cityById } from './map-data.js';

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export function kmPerTile(terrain) {
  return distKm(
    { lon: LON_MIN, lat: LAT_MIN },
    { lon: LON_MIN + (LON_MAX - LON_MIN) / (terrain.cols - 1), lat: LAT_MIN },
  );
}

export function tilesPerTurn(cfg, terrain) {
  const k = kmPerTile(terrain);
  return cfg.orders.marchKmPerTurn / Math.max(0.1, k);
}

const walkable = (t) => t && t.cost < 90;

/** 8 向 A*。返回 {ok, path:[{c,r}], cost, km, turns}，不可达返回 {ok:false}。 */
export function findRoute(terrain, from, to, cfg) {
  const { cols, rows, at, inBounds } = terrain;
  if (!inBounds(from.c, from.r) || !inBounds(to.c, to.r)) return { ok: false, reason: '起点或终点越界' };
  if (!walkable(at(from.c, from.r))) return { ok: false, reason: '起点不可通行' };
  if (!walkable(at(to.c, to.r))) return { ok: false, reason: '终点不可通行' };

  const start = from.r * cols + from.c;
  const goal = to.r * cols + to.c;
  const g = new Map([[start, 0]]);
  const parent = new Map();
  const open = [{ id: start, c: from.c, r: from.r, f: 0 }];
  const closed = new Set();
  const h = (c, r) => Math.hypot(c - to.c, r - to.r) * 1.0;  // 最小单格代价 0.55，取 1 略激进但仍可接受

  let guard = 0;
  const maxGuard = cols * rows * 4;
  while (open.length && guard++ < maxGuard) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);
    if (cur.id === goal) {
      const path = [];
      let id = goal;
      while (id !== undefined) {
        path.push({ c: id % cols, r: Math.floor(id / cols) });
        id = parent.get(id);
      }
      path.reverse();
      const cost = g.get(goal);
      const km = (path.length - 1) * kmPerTile(terrain);
      const turns = Math.max(cfg.orders.minArriveTurn,
        Math.ceil(cost / tilesPerTurn(cfg, terrain)));
      return { ok: true, path, cost, km, turns, steps: guard };
    }
    for (const [dc, dr, mult] of DIRS) {
      const nc = cur.c + dc, nr = cur.r + dr;
      if (!inBounds(nc, nr)) continue;
      const nt = at(nc, nr);
      if (!walkable(nt)) continue;
      // 禁止斜穿两个障碍角
      if (dc && dr) {
        if (!walkable(at(cur.c + dc, cur.r)) && !walkable(at(cur.c, cur.r + dr))) continue;
      }
      const nid = nr * cols + nc;
      if (closed.has(nid)) continue;
      const ng = g.get(cur.id) + nt.cost * mult;
      if (ng < (g.get(nid) ?? Infinity)) {
        g.set(nid, ng);
        parent.set(nid, cur.id);
        open.push({ id: nid, c: nc, r: nr, f: ng + h(nc, nr) });
      }
    }
  }
  return { ok: false, reason: '无路可通' };
}

/** 城 → 城：从两城城门出发的 A*。 */
export function routeCities(terrain, fromId, toId, cfg) {
  const a = terrain.cityCenter(fromId), b = terrain.cityCenter(toId);
  if (!a?.gate || !b?.gate) return { ok: false, reason: '城门缺失' };
  return findRoute(terrain, { c: a.gate[0], r: a.gate[1] }, { c: b.gate[0], r: b.gate[1] }, cfg);
}

/** 连地判定：目标格 8 邻域内必须已有己方领地（或目标本身即己方）。 */
export function hasAdjacentTerritory(terrain, faction, c, r) {
  const { at, inBounds } = terrain;
  if (!inBounds(c, r)) return false;
  if (at(c, r).owner === faction) return true;
  for (const [dc, dr] of DIRS) {
    const nc = c + dc, nr = r + dr;
    if (inBounds(nc, nr) && at(nc, nr).owner === faction) return true;
  }
  return false;
}

/** BFS 列出某势力当前可出征的地块（用于地图高亮），上限防止全图刷爆。 */
export function reachableTiles(terrain, faction, cap = 4000) {
  const { cols, rows, at, inBounds, tiles } = terrain;
  const out = [];
  for (const t of tiles) {
    if (t.owner === faction) continue;
    if (!walkable(t)) continue;
    if (hasAdjacentTerritory(terrain, faction, t.c, t.r)) out.push({ c: t.c, r: t.r });
    if (out.length >= cap) break;
  }
  return out;
}

/** 占领一格：归属易主，并把它作为新的连地锚点。 */
export function claimTile(terrain, c, r, faction) {
  const { at, inBounds } = terrain;
  if (!inBounds(c, r)) return { ok: false, reason: '越界' };
  const t = at(c, r);
  if (!walkable(t)) return { ok: false, reason: '地形不可占领' };
  if (t.cityId) return { ok: false, reason: '城郭需经战斗结算' };
  const prev = t.owner;
  t.owner = faction;
  return { ok: true, prev, tile: { c, r, type: t.type, level: t.level } };
}

/** 全图连通性自检：任意两城城门之间必须可达。 */
export function validateConnectivity(terrain, cfg, cityIds) {
  const problems = [];
  for (let i = 0; i < cityIds.length; i++) {
    for (let j = i + 1; j < cityIds.length; j++) {
      const r = routeCities(terrain, cityIds[i], cityIds[j], cfg);
      if (!r.ok) {
        problems.push(`${cityById(cityIds[i])?.name} ↔ ${cityById(cityIds[j])?.name}: ${r.reason}`);
      }
    }
  }
  return problems;
}
