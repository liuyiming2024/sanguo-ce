// 自动列队（v0.9.0）：框选一队人 → 点一个位置 → 算出每个人该站哪格。
//
// 用户口径：「他毕竟是队伍……最后要实现的功能是框选一些人，然后你点击一个位置
// 让他走过去，然后自动列队」。所以选中集不是各走各的，是一起排成队形过去。
//
// 这一层是纯逻辑：不碰 canvas / DOM / 墙钟 / 随机源；同输入永远同输出，
// 可直接进单测、进命令日志、进重放校验。格位由 city-view 交给 onDeploy 应用，
// 行军 tween 由渲染层按逻辑格位变化自动产生。
import { headingFromDelta } from './direction.js';

export const FORMATIONS = ['line', 'block', 'wedge'];
export const FORMATION_LABEL = { line: '横队', block: '方阵', wedge: '楔形' };

const key = (c, r) => `${c}:${r}`;

/**
 * 阵型相对偏移：以目标格为原点，按「谁站最前排」排好序。
 * 返回的偏移数量足够覆盖任意 n，调用方再按边界/占用剔除。
 * 排序只依赖整数，无任何随机源 —— 同 shape 永远同一串偏移。
 */
export function formationOffsets(shape = 'line', radius = 12) {
  const pool = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (shape === 'wedge') {
        // 楔形：尖朝前（-dr），每行比上一行宽两格
        const back = dr + radius;
        if (Math.abs(dc) > back) continue;
        pool.push({ dc, dr, d: back * 2 + Math.abs(dc) });
      } else if (shape === 'block') {
        const cheb = Math.max(Math.abs(dr), Math.abs(dc));
        pool.push({ dc, dr, d: cheb * 1000 + Math.abs(dr) * 20 + Math.abs(dc) });
      } else {
        // 横队：优先同一行向两侧展开，站满再往下一行
        pool.push({ dc, dr, d: Math.abs(dr) * 1000 + Math.abs(dc) * 20 + (dr < 0 ? 1 : 0) });
      }
    }
  }
  pool.sort((a, b) => a.d - b.d || a.dr - b.dr || a.dc - b.dc);
  return pool.map(({ dc, dr }) => ({ dc, dr }));
}

/**
 * @param opts { units, target, cols, rows, occupied?, shape?, zone? }
 *   units:    [{ id, zone, col, row }] 选中单位
 *   target:   { zone:'inside'|'camp', col, row }
 *   occupied: Set<"col:row"> 其他单位占用的格（不含选中单位自己）
 * @returns { assignments:[{id,zone,col,row}], heading, formation }
 *   heading 是从队伍当前重心指向目标的朝向弧度，供 UI / 行军转向用。
 */
export function assignFormation(opts) {
  const {
    units = [], target, cols = 24, rows = 16,
    occupied = new Set(), shape = 'line',
  } = opts;
  if (!target || units.length === 0) {
    return { assignments: [], heading: 0, formation: shape };
  }

  // 队伍朝向：重心 → 目标（用格坐标当平面，y 向下）
  const cx = units.reduce((s, u) => s + u.col, 0) / units.length;
  const cy = units.reduce((s, u) => s + u.row, 0) / units.length;
  const heading = headingFromDelta(target.col - cx, target.row - cy, 0);

  // 点在大营：整队撤回，营区没有网格，按稳定 id 顺序给位置
  if (target.zone === 'camp') {
    const ids = [...units].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return {
      assignments: ids.map((u, i) => ({ id: u.id, zone: 'camp', col: i, row: 0 })),
      heading, formation: shape,
    };
  }

  // 离目标近的站前排，同距按 id —— 确定性，且看起来是「一起走过去」
  const sorted = [...units].sort((a, b) => {
    const da = Math.hypot(a.col - target.col, a.row - target.row);
    const db = Math.hypot(b.col - target.col, b.row - target.row);
    return da - db || String(a.id).localeCompare(String(b.id));
  });

  const offsets = formationOffsets(FORMATIONS.includes(shape) ? shape : 'line',
    Math.max(cols, rows));
  const used = new Set();
  const assignments = [];
  for (const o of offsets) {
    if (assignments.length >= sorted.length) break;
    const c = target.col + o.dc, r = target.row + o.dr;
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const k = key(c, r);
    if (used.has(k) || occupied.has(k)) continue;
    used.add(k);
    assignments.push({ id: sorted[assignments.length].id, zone: 'inside', col: c, row: r, slot: assignments.length });
  }
  return { assignments, heading, formation: shape };
}

/** 给 UI 用的一句话播报，避免把格坐标直接抛给玩家。 */
export function formationSummary(result) {
  const n = result.assignments.length;
  if (!n) return '无可调动的队伍';
  return `${FORMATION_LABEL[result.formation] ?? '横队'} · ${n} 队归位`;
}
