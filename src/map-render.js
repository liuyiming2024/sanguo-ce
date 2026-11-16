// 分层程序化地形渲染。刻意不做「一个圆圈中间写汉字」那种极简标记：
// 底纹 → 地貌色块 → 山形 → 树冠/田埂/芦苇 → 河面波纹 → 官道车辙
// → 城郭（城墙垛口 + 角楼 + 城门 + 旗纛）→ 地名注记 → 领地边界与动态层。
// 全部离屏预渲染一次，主画布只做视口 blit + 动态叠加；不使用 ctx.filter / Math.random。
//
// v0.6.0 实拍结论：单条山脊的一笔不成立，默认仍是界画。
//   曾试过把 RIDGES[0] 沿折线连成一条路径、笔压 3.2→0.8 / .55→.08 叠上去，
//   一格未删、一格未改。实拍里全图气没变（默认视口只多 17 个像素），
//   把镜头推近后那一笔读成划痕而非山脊：墨色比皴暗、与等宽等浓的格状山形
//   异质。按预案整体退回，不推广到河与官道。
//   ?brush=on 仅保留作 A/B 复核开关，默认关闭；想让笔成立得先解决
//   「笔与皴的明度/朝向关系」，那已经不是最小一步了。
import { CITIES, RIVERS_MINOR, RIDGES, LAKES, PASSES, geoToTile, project } from './map-data.js';
import { T, TYPE_LABEL } from './terrain.js';

const PAL = {
  plain: '#3f4c3c', farmland: '#5d6641', forest: '#2c4133', hill: '#4a4e3c',
  mountain: '#333a33', river: '#275365', lake: '#316a73', marsh: '#455a48',
  road: '#8a7c5c', city: '#6a6757', wall: '#56574b', gate: '#8d846a',
  ford: '#6c8c8f', pass: '#8a7a58',
};
const INK = '#101614', TEXT = '#ded7bd', TEXT_DIM = '#a9b19c',
  DIM = '#aab6a2', GOLD = '#d8b46a';

function hash(x, y, s = 1) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function createMapRenderer(canvas, { terrain, cfg, brush = false }) {
  const TP = cfg.terrain.tilePx;
  const W = terrain.cols * TP, H = terrain.rows * TP;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const g = off.getContext('2d');

  const camera = { x: 0, y: 0, scale: 1 };
  let brushOn = brush;                 // 默认 false：界画；?brush=on 才启用实验笔
  let selection = null, circle = null, reachable = [], orders = [], cityOwners = {};
  let dpr = 1, cssW = 1, cssH = 1;

  // ── 一次运笔（实验范围：仅 RIDGES[0] 嵩山，默认关闭） ────────────────────────────
  const BRUSH_RIDGE = 0;
  const BRUSH_SCALE = TP / 6;      // 3.2→0.8 是格尺度，换算到离屏像素

  /**
   * 一条路径，quadraticCurveTo 连完；再按「运笔进度」分带重复描同一路径，
   * 每带换一次笔压（线宽 3.2→0.8、浓 .55→.08）。路径从头到尾只有一条，
   * 不是 N 段独立线段——所以叫一次运笔，不是给整齐找说法。
   */
  function strokeRidge(g, rg) {
    const P = rg.pts.map(([lon, lat]) => project(lon, lat, W, H));
    const n = P.length;
    if (n < 3) return;

    const path = new Path2D();
    path.moveTo(P[0].x, P[0].y);
    for (let i = 1; i < n - 1; i++) {
      const mx = (P[i].x + P[i + 1].x) / 2, my = (P[i].y + P[i + 1].y) / 2;
      path.quadraticCurveTo(P[i].x, P[i].y, mx, my);
    }
    path.quadraticCurveTo(P[n - 2].x, P[n - 2].y, P[n - 1].x, P[n - 1].y);

    // 运笔方向按首尾 y 定（这几条山脊在图上都是南北向，y 单调）。
    const yFrom = P[0].y, yTo = P[n - 1].y;
    const N = 28;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let k = 0; k < N; k++) {
      const t0 = k / N, t1 = (k + 1) / N, t = (t0 + t1) / 2;
      const ya = yFrom + (yTo - yFrom) * t0, yb = yFrom + (yTo - yFrom) * t1;
      const top = Math.min(ya, yb) - 1, h = Math.abs(yb - ya) + 2;
      g.save();
      g.beginPath(); g.rect(0, top, W, h); g.clip();
      g.strokeStyle = rgba(INK, 0.55 + (0.08 - 0.55) * t);
      g.lineWidth = (3.2 + (0.8 - 3.2) * t) * BRUSH_SCALE;
      g.stroke(path);                       // 同一条路径，只换笔压
      g.restore();
    }
    g.restore();

    // 折点处一次分叉枯笔：极细、极淡、中间带两处飞白断口。
    for (let i = 1; i < n - 1; i++) {
      const a = P[i - 1], p = P[i], b = P[i + 1];
      const va = { x: p.x - a.x, y: p.y - a.y }, vb = { x: b.x - p.x, y: b.y - p.y };
      const la = Math.hypot(va.x, va.y) || 1, lb = Math.hypot(vb.x, vb.y) || 1;
      let dx = va.x / la - vb.x / lb, dy = va.y / la - vb.y / lb;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      const len = TP * 1.5;
      g.save();
      g.lineCap = 'round';
      g.lineWidth = 0.7 * BRUSH_SCALE;
      // 三段短笔，中间留白 —— 枯笔不是一条实线
      for (const [u0, u1, alpha] of [[0, 0.28, 0.26], [0.40, 0.66, 0.17], [0.78, 1, 0.08]]) {
        g.strokeStyle = rgba(INK, alpha);
        g.beginPath();
        g.moveTo(p.x + dx * len * u0, p.y + dy * len * u0);
        g.lineTo(p.x + dx * len * u1, p.y + dy * len * u1);
        g.stroke();
      }
      g.restore();
    }
  }

  // ── 离屏静态地形 ──────────────────────────────────────────────────────
  function buildBase() {
    // 1) 底纹 + 细颗粒
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#212823'); bg.addColorStop(0.5, '#1b211f'); bg.addColorStop(1, '#242b25');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 26000; i++) {
      const x = hash(i, 11) * W, y = hash(i, 29) * H;
      g.fillStyle = hash(i, 47) > 0.5 ? 'rgba(255,246,220,.020)' : 'rgba(0,0,0,.035)';
      g.fillRect(x, y, 1, 1);
    }

    // 2) 地貌色块（按类型分组，一次路径批量填充）+ 明暗微差
    const groups = {};
    for (const t of terrain.tiles) (groups[t.type] ??= []).push(t);
    for (const [type, arr] of Object.entries(groups)) {
      g.fillStyle = PAL[type] ?? PAL.plain;
      g.beginPath();
      for (const t of arr) g.rect(t.c * TP, t.r * TP, TP, TP);
      g.fill();
      // 每格一点确定性明暗，避免大色块死板
      for (const t of arr) {
        const v = hash(t.c, t.r, 3);
        if (v > 0.72) { g.fillStyle = 'rgba(255,246,214,.045)'; g.fillRect(t.c * TP, t.r * TP, TP, TP); }
        else if (v < 0.26) { g.fillStyle = 'rgba(0,0,0,.075)'; g.fillRect(t.c * TP, t.r * TP, TP, TP); }
      }
    }

    // 3) 山地：三角山形簇 + 亮面 + 等高线（皴法一行不动，笔是叠上去的）
    for (const t of terrain.tiles) {
      if (t.type !== T.MOUNTAIN && t.type !== T.HILL) continue;
      if ((t.c + t.r) & 1) continue;   // 隔格抽样：山形不再铺满半屏
      const x = t.c * TP, y = t.r * TP;
      const big = t.type === T.MOUNTAIN;
      const h = big ? 11 + hash(t.c, t.r, 7) * 7 : 5 + hash(t.c, t.r, 7) * 3;
      g.fillStyle = big ? rgba('#1c241e', 0.55) : rgba('#2a3327', 0.4);
      g.beginPath();
      g.moveTo(x + 1, y + TP);
      g.lineTo(x + TP * 0.5, y + TP - h);
      g.lineTo(x + TP - 1, y + TP);
      g.closePath(); g.fill();
      g.fillStyle = big ? rgba('#69735c', 0.42) : rgba('#5c6647', 0.3);
      g.beginPath();
      g.moveTo(x + TP * 0.5, y + TP - h);
      g.lineTo(x + TP - 1, y + TP);
      g.lineTo(x + TP * 0.5, y + TP);
      g.closePath(); g.fill();
      if (big && hash(t.c, t.r, 9) > 0.62) {
        g.strokeStyle = rgba('#c8d2b4', 0.16);
        g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(x + TP * 0.5, y + TP - h + 2);
        g.lineTo(x + TP * 0.86, y + TP - 1);
        g.stroke();
      }
    }

    // 4) 林地：树冠三层 + 短干
    for (const t of terrain.tiles) {
      if (t.type !== T.FOREST) continue;
      const cx = t.c * TP + TP / 2, cy = t.r * TP + TP * 0.62;
      const s = 0.8 + hash(t.c, t.r, 13) * 0.5;
      g.strokeStyle = rgba('#121b14', 0.7); g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, cy + 3); g.lineTo(cx, cy - 2 * s); g.stroke();
      for (const [dy, r, col] of [[0, 3.1, '#1e3526'], [-1.7, 2.5, '#2b4832'], [-3.2, 1.7, '#3b5a3d']]) {
        g.fillStyle = col;
        g.beginPath(); g.arc(cx, cy + dy * s, r * s, 0, Math.PI * 2); g.fill();
      }
    }

    // 5) 良田：田埂 + 斜向条纹
    for (const t of terrain.tiles) {
      if (t.type !== T.FARMLAND) continue;
      const x = t.c * TP, y = t.r * TP;
      g.strokeStyle = rgba('#20281b', 0.32); g.lineWidth = 0.8;
      for (let k = 1; k < 4; k++) {
        g.beginPath(); g.moveTo(x + 1, y + k * TP / 4); g.lineTo(x + TP - 1, y + k * TP / 4 - 1); g.stroke();
      }
      g.fillStyle = rgba('#b6bb72', 0.13);
      g.fillRect(x + 2, y + 2, TP - 4, 1);
    }

    // 6) 沼泽：草叶 + 水点
    for (const t of terrain.tiles) {
      if (t.type !== T.MARSH) continue;
      const x = t.c * TP, y = t.r * TP;
      g.strokeStyle = rgba('#9fbd86', 0.62); g.lineWidth = 1.3;
      for (let k = 0; k < 3; k++) {
        const px = x + 2 + hash(t.c * 7 + k, t.r, 17) * (TP - 4);
        const py = y + TP - 2;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + (k - 1) * 1.4, py - 3 - k); g.stroke();
      }
      g.fillStyle = rgba('#7fa9ac', 0.28);
      g.fillRect(x + TP * 0.3, y + TP * 0.35, 2, 1);
    }

    // 7) 水面：横向波纹 + 河岸亮边（对 river/lake 格）
    for (const t of terrain.tiles) {
      if (t.type !== T.RIVER && t.type !== T.LAKE && t.type !== T.FORD) continue;
      const x = t.c * TP, y = t.r * TP;
      const lake = t.type === T.LAKE;
      g.fillStyle = lake ? rgba('#6fa0a6', 0.16) : rgba('#6fa0a6', 0.10);
      g.fillRect(x, y, TP, TP);
      g.strokeStyle = lake ? rgba('#bfe2e0', 0.34) : rgba('#b2d6d8', 0.46);
      g.lineWidth = 1.2;
      for (let k = 0; k < 2; k++) {
        const yy = y + 3 + k * 5 + hash(t.c, t.r, 23) * 2;
        g.beginPath();
        g.moveTo(x + 1, yy);
        g.bezierCurveTo(x + 4, yy - 1.4, x + 8, yy + 1.4, x + TP - 1, yy);
        g.stroke();
      }
      // 河岸：与非水格相邻的边画亮线
      for (const [dc, dr, sx1, sy1, sx2, sy2] of [
        [-1, 0, x, y, x, y + TP], [1, 0, x + TP, y, x + TP, y + TP],
        [0, -1, x, y, x + TP, y], [0, 1, x, y + TP, x + TP, y + TP],
      ]) {
        const n = terrain.inBounds(t.c + dc, t.r + dr) ? terrain.at(t.c + dc, t.r + dr) : null;
        if (n && n.type !== T.RIVER && n.type !== T.LAKE && n.type !== T.FORD) {
          g.strokeStyle = rgba('#a8bda0', 0.26); g.lineWidth = 1;
          g.beginPath(); g.moveTo(sx1, sy1); g.lineTo(sx2, sy2); g.stroke();
        }
      }
    }

    // 8) 官道：深底 + 浅芯双线 + 车辙点（按连通的 road/ford/pass 格）
    for (const t of terrain.tiles) {
      if (!t.road) continue;
      const x = t.c * TP, y = t.r * TP;
      const cx = x + TP / 2, cy = y + TP / 2;
      const nb = (dc, dr) => {
        const n = terrain.inBounds(t.c + dc, t.r + dr) ? terrain.at(t.c + dc, t.r + dr) : null;
        return n?.road ? 1 : 0;
      };
      // 正交半段为主，斜向只在「别无通路」时补：不再织成金色网带。
      const links = [];
      if (nb(1, 0)) links.push([cx, cy, x + TP, cy]);
      if (nb(-1, 0)) links.push([cx, cy, x, cy]);
      if (nb(0, 1)) links.push([cx, cy, cx, y + TP]);
      if (nb(0, -1)) links.push([cx, cy, cx, y]);
      if (nb(1, 1) && !nb(1, 0) && !nb(0, 1)) links.push([cx, cy, x + TP, y + TP]);
      if (nb(-1, -1) && !nb(-1, 0) && !nb(0, -1)) links.push([cx, cy, x, y]);
      if (nb(1, -1) && !nb(1, 0) && !nb(0, -1)) links.push([cx, cy, x + TP, y]);
      if (nb(-1, 1) && !nb(-1, 0) && !nb(0, 1)) links.push([cx, cy, x, y + TP]);
      if (!links.length) links.push([x + 2, cy, x + TP - 2, cy]);
      for (const [a, b, c, d] of links) {
        g.strokeStyle = rgba('#181b14', 0.50); g.lineWidth = 5;
        g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
        g.strokeStyle = rgba('#cbb98a', 0.70); g.lineWidth = 2.4;
        g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
        g.strokeStyle = rgba('#f0e2b8', 0.22); g.lineWidth = 0.8;
        g.beginPath(); g.moveTo(a, b - 1); g.lineTo(c, d - 1); g.stroke();
      }
      if (t.type === T.FORD) {
        g.fillStyle = rgba('#d8c89a', 0.5);
        for (let k = -1; k <= 1; k++) g.fillRect(cx + k * 3 - 1, cy - 1, 2, 2);
      }
    }

    // 9) 城郭：城墙垛口 + 角楼 + 城门洞 + 旗纛 + 竖排城名
    for (const city of CITIES) {
      const info = terrain.cityTiles[city.id];
      const rad = info.rad;
      const x0 = (info.c - rad) * TP, y0 = (info.r - rad) * TP;
      const size = (rad * 2 + 1) * TP;
      const f = cfg.factions.find((v) => v.id === city.owner);
      const col = f?.color ?? '#8899aa';

      // 城内地面
      g.fillStyle = rgba('#78735f', 0.30); g.fillRect(x0, y0, size, size);
      // 街巷十字
      g.strokeStyle = rgba('#d8cba4', 0.20); g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0 + size / 2, y0); g.lineTo(x0 + size / 2, y0 + size);
      g.moveTo(x0, y0 + size / 2); g.lineTo(x0 + size, y0 + size / 2); g.stroke();
      // 府衙
      g.fillStyle = rgba('#c9b98d', 0.22);
      g.fillRect(x0 + size / 2 - 4, y0 + size / 2 - 4, 8, 8);

      // 城墙（带垛口）
      g.strokeStyle = rgba('#0d1210', 0.75); g.lineWidth = 3;
      g.strokeRect(x0 + 1.5, y0 + 1.5, size - 3, size - 3);
      g.strokeStyle = rgba('#b9b199', 0.75); g.lineWidth = 1.6;
      g.strokeRect(x0 + 2.5, y0 + 2.5, size - 5, size - 5);
      g.fillStyle = rgba('#d8cfae', 0.62);
      for (let k = 0; k < size - 6; k += 5) {
        g.fillRect(x0 + 2 + k, y0, 3, 3);
        g.fillRect(x0 + 2 + k, y0 + size - 3, 3, 3);
        g.fillRect(x0, y0 + 2 + k, 3, 3);
        g.fillRect(x0 + size - 3, y0 + 2 + k, 3, 3);
      }
      // 角楼
      for (const [ax, ay] of [[x0, y0], [x0 + size - 7, y0],
        [x0, y0 + size - 7], [x0 + size - 7, y0 + size - 7]]) {
        g.fillStyle = rgba('#1a201b', 0.8); g.fillRect(ax, ay, 7, 7);
        g.fillStyle = rgba('#cfc4a2', 0.8); g.fillRect(ax + 1, ay + 1, 5, 5);
        g.fillStyle = rgba('#3a4237', 0.9); g.fillRect(ax + 2, ay + 2, 3, 3);
      }
      // 城门：缺口 + 门洞
      const gp = info.gate;
      const gx = gp[0] * TP, gy = gp[1] * TP;
      g.fillStyle = rgba('#20261f', 0.95); g.fillRect(gx + 1, gy + 1, TP - 2, TP - 2);
      g.fillStyle = rgba(col, 0.5); g.fillRect(gx + 3, gy + 3, TP - 6, TP - 5);
      // 旗纛（杆 + 三角旗）
      const fx = x0 + size + 3, fy = y0 + 2;
      g.strokeStyle = rgba('#e6dec4', 0.85); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx, fy + 22); g.stroke();
      g.fillStyle = col;
      g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + 12, fy + 4); g.lineTo(fx, fy + 9);
      g.closePath(); g.fill();
      g.strokeStyle = rgba('#0d1210', 0.6); g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + 12, fy + 4); g.lineTo(fx, fy + 9); g.stroke();

      // 城名/注记改为屏幕空间绘制（见 drawAnnotations），不进离屏位图。
    }
  }

  buildBase();
  if (brushOn) strokeRidge(g, RIDGES[BRUSH_RIDGE]);   // 叠在全部格状静态层之上

  // ── 主画布 ────────────────────────────────────────────────────────────
  function resize() {
    dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    cssW = rect.width || 800; cssH = rect.height || 600;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    clampCamera();
  }

  function clampCamera() {
    const s = camera.scale;
    const maxX = Math.max(0, W - cssW / s), maxY = Math.max(0, H - cssH / s);
    camera.x = Math.max(0, Math.min(maxX, camera.x));
    camera.y = Math.max(0, Math.min(maxY, camera.y));
  }

  function zoom(factor, cx = cssW / 2, cy = cssH / 2) {
    const old = camera.scale;
    const next = Math.max(0.42, Math.min(2.8, old * factor));
    if (next === old) return;
    camera.x += cx / old - cx / next;
    camera.y += cy / old - cy / next;
    camera.scale = next;
    clampCamera();
  }
  function pan(dx, dy) {
    camera.x -= dx / camera.scale;
    camera.y -= dy / camera.scale;
    clampCamera();
  }

  function screenToTile(sx, sy) {
    const wx = camera.x + sx / camera.scale;
    const wy = camera.y + sy / camera.scale;
    return { c: Math.floor(wx / TP), r: Math.floor(wy / TP) };
  }
  function tileToScreen(c, r) {
    return { x: (c * TP + TP / 2 - camera.x) * camera.scale,
      y: (r * TP + TP / 2 - camera.y) * camera.scale };
  }

  /** 领地边界：只画 owner 变化的格边，并缓存为 Path2D（每回合重建一次，不逐帧遍历）。 */
  let borderPaths = null;
  function rebuildBorders() {
    const paths = new Map();
    for (const f of cfg.factions) paths.set(f.id, new Path2D());
    for (const t of terrain.tiles) {
      if (!t.owner || !paths.has(t.owner)) continue;
      const p = paths.get(t.owner);
      const x = t.c * TP, y = t.r * TP;
      const O = (dc, dr) => {
        const n = terrain.inBounds(t.c + dc, t.r + dr) ? terrain.at(t.c + dc, t.r + dr) : null;
        return n?.owner !== t.owner;
      };
      if (O(-1, 0)) { p.moveTo(x, y); p.lineTo(x, y + TP); }
      if (O(1, 0)) { p.moveTo(x + TP, y); p.lineTo(x + TP, y + TP); }
      if (O(0, -1)) { p.moveTo(x, y); p.lineTo(x + TP, y); }
      if (O(0, 1)) { p.moveTo(x, y + TP); p.lineTo(x + TP, y + TP); }
    }
    borderPaths = [...paths.entries()].map(([id, path]) => ({
      color: cfg.factions.find((f) => f.id === id)?.color ?? '#8899aa', path,
    }));
  }
  function drawBorders(ctx) {
    if (!borderPaths) rebuildBorders();
    ctx.lineWidth = 1.1 / camera.scale;
    for (const b of borderPaths) {
      ctx.strokeStyle = rgba(b.color, 0.55);
      ctx.stroke(b.path);
    }
  }

  /** 城池旗色按当前归属覆盖（城池易主后地图要跟着变）。 */
  function drawCityFlags(ctx) {
    for (const city of CITIES) {
      const owner = cityOwners[city.id] ?? city.owner;
      const f = cfg.factions.find((v) => v.id === owner);
      if (!f || owner === city.owner) continue;
      const info = terrain.cityTiles[city.id];
      const size = (info.rad * 2 + 1) * TP;
      const x0 = (info.c - info.rad) * TP, y0 = (info.r - info.rad) * TP;
      const fx = x0 + size + 3, fy = y0 + 2;
      ctx.fillStyle = f.color;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + 12, fy + 4);
      ctx.lineTo(fx, fy + 9); ctx.closePath(); ctx.fill();
    }
  }

  function drawOrders(ctx) {
    for (const o of orders) {
      if (!o.path?.length) continue;
      const f = cfg.factions.find((v) => v.id === o.faction);
      ctx.strokeStyle = rgba(f?.color ?? GOLD, 0.8);
      ctx.lineWidth = 2 / camera.scale;
      ctx.setLineDash([5 / camera.scale, 4 / camera.scale]);
      ctx.beginPath();
      o.path.forEach((p, i) => {
        const x = p.c * TP + TP / 2, y = p.r * TP + TP / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      // 箭头（末端）
      const a = o.path[Math.max(0, o.path.length - 2)], b = o.path[o.path.length - 1];
      const ang = Math.atan2(b.r - a.r, b.c - a.c);
      const bx = b.c * TP + TP / 2, by = b.r * TP + TP / 2;
      ctx.fillStyle = rgba(f?.color ?? GOLD, 0.9);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 6 * Math.cos(ang - 0.5), by - 6 * Math.sin(ang - 0.5));
      ctx.lineTo(bx - 6 * Math.cos(ang + 0.5), by - 6 * Math.sin(ang + 0.5));
      ctx.closePath(); ctx.fill();
    }
  }

  /** 信息层：世界坐标定位，但字号/线宽按 1/scale 换算 → 永远是固定屏幕像素。 */
  function drawAnnotations(ctx) {
    const k = 1 / camera.scale;
    const cityFont = 13 * k, noteFont = 11 * k, smallFont = 9 * k;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';

    // 城名：竖排压在城郭右侧，带描边；不是居中大字，也不是圆圈里一个汉字
    for (const city of CITIES) {
      const info = terrain.cityTiles[city.id];
      const size = (info.rad * 2 + 1) * TP;
      const x0 = (info.c - info.rad) * TP, y0 = (info.r - info.rad) * TP;
      const owner = cityOwners[city.id] ?? city.owner;
      const f = cfg.factions.find((v) => v.id === owner);
      const lx = x0 + size + TP * 0.55, ly = y0 + 2;
      // 读图层级：都城 > 郡治 > 县邑/营垒。只差字号与明度，不加新颜色或纹样。
      const rankFont = city.rank === 1 ? 17 : city.rank === 2 ? 14 : 12;
      const cf = rankFont * k;
      const ink = city.rank === 1 ? GOLD : city.rank === 2 ? TEXT : rgba(TEXT, 0.84);
      ctx.font = `600 ${cf}px "WenQuanYi Micro Hei", serif`;
      [...city.name].forEach((ch, i) => {
        const yy = ly + i * cf * 1.12;
        ctx.strokeStyle = rgba('#080d0b', 0.95); ctx.lineWidth = (city.rank === 1 ? 3.2 : 2.6) * k;
        ctx.strokeText(ch, lx, yy);
        ctx.fillStyle = ink;
        ctx.fillText(ch, lx, yy);
      });
      // 势力色小方章 + 等级
      const foot = ly + city.name.length * cf * 1.12;
      ctx.fillStyle = f?.color ?? '#8899aa';
      ctx.fillRect(lx, foot + 3 * k, (city.rank === 1 ? 13 : 9) * k, 3 * k);
      ctx.font = `${smallFont}px "WenQuanYi Micro Hei", serif`;
      ctx.fillStyle = DIM;
      ctx.fillText(city.rank === 1 ? '都' : city.rank === 2 ? '郡' : city.rank === 3 ? '县' : '垒',
        lx + (city.rank === 1 ? 16 : 12) * k, foot);
    }

    // 关隘 / 津渡：符号 + 名称，符号尺寸固定屏幕像素
    for (const p of PASSES) {
      const q = geoToTile(p.lon, p.lat, terrain.cols, terrain.rows);
      const x = (q.c + 0.5) * TP, y = (q.r + 0.5) * TP;
      const col = p.kind === 'ford' ? '#a8d8d6' : GOLD;
      ctx.fillStyle = col; ctx.strokeStyle = rgba('#080d0b', 0.9); ctx.lineWidth = 1.2 * k;
      ctx.beginPath();
      if (p.kind === 'ford') ctx.arc(x, y, 4 * k, 0, Math.PI * 2);
      else {
        ctx.moveTo(x, y - 5 * k); ctx.lineTo(x + 4.5 * k, y + 4 * k);
        ctx.lineTo(x - 4.5 * k, y + 4 * k); ctx.closePath();
      }
      ctx.fill(); ctx.stroke();
      ctx.font = `600 ${smallFont}px "WenQuanYi Micro Hei", serif`;
      ctx.strokeStyle = rgba('#080d0b', 0.95); ctx.lineWidth = 2.4 * k;
      ctx.strokeText(p.name, x + 8 * k, y - 5 * k);
      ctx.fillStyle = col;
      ctx.fillText(p.name, x + 8 * k, y - 5 * k);
    }

    // 地理注记：山名 / 水名 / 泽名，沿锚点小字排布
    const note = (text, lon, lat, color, rot = 0) => {
      const p = project(lon, lat, W, H);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(rot);
      ctx.font = `italic ${noteFont}px "WenQuanYi Micro Hei", serif`;
      ctx.strokeStyle = rgba('#080d0b', 0.9); ctx.lineWidth = 2.4 * k;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = color; ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    for (const rg of RIDGES) {
      const mid = rg.pts[Math.floor(rg.pts.length / 2)];
      note(rg.name, mid[0], mid[1], rgba('#d2dcbf', 0.9), -0.5);
    }
    for (const rv of RIVERS_MINOR) {
      const mid = rv.pts[Math.floor(rv.pts.length / 2)];
      note(rv.name, mid[0], mid[1], rgba('#b6e0e0', 0.92), 0.18);
    }
    for (const lk of LAKES) note(lk.name, lk.lon, lk.lat, rgba('#bfe6e4', 0.92), 0);
    note('黄 河', 113.72, 35.02, rgba('#d2eeee', 0.95), -0.15);
    note('官 渡', 113.93, 34.48, rgba(GOLD, 0.95), 0);
  }

  /** 土地等级角标：只在放大到能看清时画，字号固定屏幕像素。 */
  function drawLevels(ctx) {
    if (camera.scale < 1.25) return;
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba(TEXT, 0.8);
    ctx.strokeStyle = rgba('#080d0b', 0.8); ctx.lineWidth = 2 / camera.scale;
    const k = 1 / camera.scale;
    for (const t of terrain.tiles) {
      if (t.level < 5 || t.cityId || t.type === T.RIVER) continue;
      const x = t.c * TP + 2, y = t.r * TP + 2;
      ctx.strokeText(String(t.level), x, y);
      ctx.fillText(String(t.level), x, y);
    }
  }

  /** 屏幕空间 HUD：图廓、比例尺、缩略导航（右下角）。完全不受缩放影响。 */
  function drawScreenHud(ctx) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = rgba(GOLD, 0.28); ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, cssW - 6, cssH - 6);

    // 缩略导航：全图 + 当前视口框，解决「放大后不知道自己在哪」
    const mw = Math.min(190, cssW * 0.24), mh = mw * (H / W);
    // 让开右下工具列（约 62px），否则缩略图被压在按钮底下。
    const mx = cssW - mw - 14 - (cssW > 720 ? 62 : 56), my = cssH - mh - 58;
    ctx.fillStyle = rgba('#0b100e', 0.97);
    ctx.fillRect(mx - 5, my - 5, mw + 10, mh + 10);
    ctx.strokeStyle = rgba(GOLD, 0.62); ctx.lineWidth = 1.5;
    ctx.strokeRect(mx - 5, my - 5, mw + 10, mh + 10);
    ctx.fillStyle = rgba('#0b100e', 0.97);
    ctx.fillRect(mx - 5, my - 22, 76, 16);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, mx, my, mw, mh);
    const vx = mx + (camera.x / W) * mw, vy = my + (camera.y / H) * mh;
    const vw = (cssW / camera.scale / W) * mw, vh = (cssH / camera.scale / H) * mh;
    ctx.strokeStyle = rgba(GOLD, 0.95); ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, Math.max(3, vw), Math.max(3, vh));
    ctx.font = '9px "WenQuanYi Micro Hei", serif';
    ctx.fillStyle = rgba(TEXT, 0.85);
    ctx.fillText(`全图 ${terrain.cols}×${terrain.rows}`, mx, my - 10);

    // 比例尺
    ctx.font = '10px "WenQuanYi Micro Hei", serif';
    ctx.fillStyle = rgba(TEXT, 0.7);
    ctx.fillText(`建安五年 · 豫兖战线 · 1 格 ≈ ${kmPerTileLabel()} km · 缩放 ${camera.scale.toFixed(2)}×`,
      14, cssH - 20);
    ctx.restore();
  }
  function kmPerTileLabel() {
    const lonStep = (114.0 - 113.0) * 111 * Math.cos(34.5 * Math.PI / 180);
    return (lonStep / terrain.cols * 3.4).toFixed(1);
  }

  function draw(ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e1411';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale,
      -camera.x * camera.scale * dpr, -camera.y * camera.scale * dpr);
    // 接近 1:1 时用高质量插值；缩到很小则最近邻保住细线锐度。
    ctx.imageSmoothingEnabled = camera.scale >= 0.8;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0);

    drawBorders(ctx);
    drawCityFlags(ctx);
    drawAnnotations(ctx);      // 文字/注记在屏幕空间，不随离屏缩放糊掉
    drawLevels(ctx);

    if (reachable.length) {
      ctx.fillStyle = rgba(GOLD, 0.42);
      for (const p of reachable) {
        ctx.beginPath();
        ctx.arc(p.c * TP + TP / 2, p.r * TP + TP / 2, 2.4 / camera.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    drawOrders(ctx);

    if (selection) {
      ctx.strokeStyle = GOLD; ctx.lineWidth = 2.2 / camera.scale;
      ctx.strokeRect(selection.c * TP + 1, selection.r * TP + 1, TP - 2, TP - 2);
      ctx.strokeStyle = rgba(GOLD, 0.4); ctx.lineWidth = 1 / camera.scale;
      ctx.strokeRect((selection.c - 1) * TP, (selection.r - 1) * TP, TP * 3, TP * 3);
    }
    if (circle) {
      ctx.strokeStyle = rgba('#e8d9a8', 0.95); ctx.lineWidth = 1.8 / camera.scale;
      ctx.setLineDash([5 / camera.scale, 4 / camera.scale]);
      ctx.beginPath(); ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba('#e8d9a8', 0.10); ctx.fill();
    }
    ctx.restore();
    drawScreenHud(ctx);
  }

  return {
    resize, draw,
    zoom, pan, screenToTile, tileToScreen, clampCamera,
    camera, get dpr() { return dpr; },
    setSelection(p) { selection = p; },
    setCircle(c) { circle = c; },
    setReachable(list) { reachable = list; },
    setOrders(list) { orders = list; },
    setCityOwners(map) { cityOwners = map; borderPaths = null; },
    setBrush(on) {
      if (brushOn !== !!on) {
        brushOn = !!on; buildBase();
        if (brushOn) strokeRidge(g, RIDGES[BRUSH_RIDGE]);
      }
      return brushOn;
    },
    get brushOn() { return brushOn; },
    get offscreen() { return off; },   // 烟测做逐像素 A/B 用，不参与渲染
    invalidateBorders() { borderPaths = null; },
    get size() { return { W, H, TP }; },
    describe(c, r) { return terrain.describe(c, r); },
    terrain,
  };
}
