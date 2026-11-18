// 城内网格障碍与 A*（v0.9.2）。纯逻辑：无 DOM / 墙钟 / 随机源，同输入同输出。
//
// 用户口径：「编队移动不是直线 tween，要沿城内网格绕障碍走」。
// 格继续管哪格能走，笔只管它长什么样 —— 这一层与大地图地形完全隔离。
import { headingFromDelta } from './direction.js';

export const DIRS8 = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export const keyOf = (c, r) => `${c}:${r}`;

/** 城内不可通行格：府衙 3×3、四处仓井 2×2、城墙列（城门通道保留）。 */
export function cityObstacles(cfg) {
  const CV = cfg.cityView;
  const { cols, rows, gate, yamen } = CV;
  const blocked = new Set();
  const add = (c, r) => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) blocked.add(keyOf(c, r));
  };
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) add(yamen.col + dc, yamen.row + dr);
  for (const [wc, wr] of CV.warehouses ?? []) {
    for (let dc = 0; dc <= 1; dc++) for (let dr = 0; dr <= 1; dr++) add(wc + dc, wr + dr);
  }
  // 城墙：col 0 只有城门那一格与其上下各一格是通道
  for (let r = 0; r < rows; r++) {
    if (Math.abs(r - gate.row) > 1) add(0, r);
  }
  return blocked;
}

/** 街巷加宽格（每 4 格）通行代价更低，鼓励沿街列队，不制造飞线。 */
function stepCost(c, r) {
  return (c % 4 === 0 || r % 4 === 0) ? 0.76 : 1;
}

/**
 * 8 向 A*。禁止贴角穿墙：走对角时两个正交邻格必须都可通行。
 * @returns {ok, path:[{col,row}], cost, adjusted}
 *   path 含起点与终点；终点被占时自动取最近可通行格并置 adjusted=true。
 */
export function findCityPath(from, to, opts = {}) {
  const { cols = 24, rows = 16, blocked = new Set(), occupied = new Set() } = opts;
  const inb = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;
  const free = (c, r) => inb(c, r) && !blocked.has(keyOf(c, r)) && !occupied.has(keyOf(c, r));
  const s = { col: Math.round(from.col), row: Math.round(from.row) };
  let g = { col: Math.round(to.col), row: Math.round(to.row) };
  let adjusted = false;
  if (!free(g.col, g.row)) {
    const alt = nearestFree(g, { cols, rows, blocked, occupied });
    if (!alt) return { ok: false, reason: '目标附近无可通行格' };
    g = alt; adjusted = true;
  }
  if (!inb(s.col, s.row)) return { ok: false, reason: '起点越界' };
  // 起点被占（例如自己站在障碍里）仍允许走出去
  const startId = s.row * cols + s.col, goalId = g.row * cols + g.col;
  if (startId === goalId) return { ok: true, path: [s], cost: 0, adjusted };

  const G = new Map([[startId, 0]]);
  const parent = new Map();
  const closed = new Set();
  const open = [{ id: startId, col: s.col, row: s.row, f: 0 }];
  const h = (c, r) => Math.hypot(c - g.col, r - g.row) * 0.76;
  let guard = 0;
  while (open.length && guard++ < cols * rows * 8) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bi].f || (open[i].f === open[bi].f && open[i].id < open[bi].id)) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);
    if (cur.id === goalId) {
      const path = [];
      let id = cur.id;
      while (id !== undefined) {
        const c = id % cols, r = Math.floor(id / cols);
        path.push({ col: c, row: r });
        id = parent.get(id);
      }
      path.reverse();
      return { ok: true, path, cost: G.get(goalId), adjusted };
    }
    for (const [dc, dr, base] of DIRS8) {
      const nc = cur.col + dc, nr = cur.row + dr;
      if (!free(nc, nr)) continue;
      if (dc && dr && (!free(cur.col + dc, cur.row) || !free(cur.col, cur.row + dr))) continue;
      const nid = nr * cols + nc;
      if (closed.has(nid)) continue;
      const ng = (G.get(cur.id) ?? Infinity) + base * stepCost(nc, nr);
      if (ng < (G.get(nid) ?? Infinity)) {
        G.set(nid, ng); parent.set(nid, cur.id);
        open.push({ id: nid, col: nc, row: nr, f: ng + h(nc, nr) });
      }
    }
  }
  return { ok: false, reason: '不可达' };
}

export function nearestFree(target, opts = {}) {
  const { cols = 24, rows = 16, blocked = new Set(), occupied = new Set() } = opts;
  const free = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows &&
    !blocked.has(keyOf(c, r)) && !occupied.has(keyOf(c, r));
  if (free(target.col, target.row)) return { col: target.col, row: target.row };
  for (let rad = 1; rad <= Math.max(cols, rows); rad++) {
    const cand = [];
    for (let dc = -rad; dc <= rad; dc++) for (let dr = -rad; dr <= rad; dr++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
      const c = target.col + dc, r = target.row + dr;
      if (free(c, r)) cand.push({ col: c, row: r, d: Math.hypot(dc, dr), id: r * cols + c });
    }
    cand.sort((a, b) => a.d - b.d || a.id - b.id);
    if (cand.length) return { col: cand[0].col, row: cand[0].row };
  }
  return null;
}

/** 溃散时往哪个出口跑：城门通道，再退到城外大营。 */
export function nearestExit(from, cfg) {
  const g = cfg.cityView.gate;
  return { col: 0, row: g.row, heading: headingFromDelta(g.col - from.col, g.row - from.row, 0) };
}

/** 路径的累计长度（用于按距离给整段行军定时，避免远近不同却同秒到）。 */
export function pathLength(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++)
    d += Math.hypot(path[i].col - path[i - 1].col, path[i].row - path[i - 1].row);
  return d;
}
