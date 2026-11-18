// 分层程序化地形渲染。刻意不做「一个圆圈中间写汉字」那种极简标记：
// 底纹 → 地貌色块 → 山形 → 树冠/田埂/芦苇 → 河面波纹 → 官道车辙
// → 城郭（城墙垛口 + 角楼 + 城门 + 旗纛）→ 地名注记 → 领地边界与动态层。
// 全部离屏预渲染一次，主画布只做视口 blit + 动态叠加；不使用 ctx.filter / Math.random。
//
// v0.9.4：默认背景层换成对面的《建安五年全境舆图》渲染内核（见 atlas.js）。
//   连续场 + 变宽短笔，笔法与色板原样接进来；只把图幅参数化到官渡战区，
//   且只取 bg（背景层）：城郭/关津/领地/朱题由上层按局内状态动态画，不重复。
//   gongbi / jiehua 两种旧画法保留作 A/B 复核（?style=gongbi|jiehua）。
//   terrain.js / map-data.js / A* / 存档 / 策略层一行未动。
import { CITIES, RIVERS_MINOR, RIDGES, LAKES, PASSES, geoToTile, project } from './map-data.js';
import { T, TYPE_LABEL } from './terrain.js';
import { paintGongbi, GONGBI } from './gongbi.js';
import { createAtlas } from './atlas.js';

const PAL = {
  plain: '#3f4c3c', farmland: '#5d6641', forest: '#2c4133', hill: '#4a4e3c',
  mountain: '#333a33', river: '#275365', lake: '#316a73', marsh: '#455a48',
  road: '#8a7c5c', city: '#6a6757', wall: '#56574b', gate: '#8d846a',
  ford: '#6c8c8f', pass: '#8a7a58',
};
const INK = '#101614', TEXT = '#ded7bd', TEXT_DIM = '#a9b19c',
  DIM = '#aab6a2', GOLD = '#d8b46a';

// 浅绢底上原来的亮字会隐形，注记/HUD 换一套墨色；界画分支仍用旧色。
const TH_DARK = { stroke: '#080d0b', text: '#e9e3d1', gold: '#d8b46a', dim: '#a9b19c',
  pass: '#a8d8d6', ridge: '#d2dcbf', water: '#b6e0e0', lake: '#bfe6e4', huanghe: '#d2eeee',
  frame: '#d8b46a', hud: '#0b100e', reach: '#d8b46a' };
const TH_LIGHT = { stroke: '#efe8d2', text: '#26302a', gold: '#8a6b34', dim: '#5c6b5a',
  pass: '#3c6f78', ridge: '#3f5a48', water: '#37636b', lake: '#37636b', huanghe: '#2f5f66',
  frame: '#2f3a33', hud: '#cdc4a7', reach: '#a6483a' };
function theme(st) { return st === 'jiehua' ? TH_DARK : TH_LIGHT; }

function hash(x, y, s = 1) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function createMapRenderer(canvas, { terrain, cfg, style: styleOpt = 'atlas' }) {
  const TP = cfg.terrain.tilePx;
  const W = terrain.cols * TP, H = terrain.rows * TP;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const g = off.getContext('2d');

  const camera = { x: 0, y: 0, scale: 1 };
  let style = styleOpt === 'jiehua' ? 'jiehua'
    : styleOpt === 'gongbi' ? 'gongbi' : 'atlas';   // 默认全境笔法；另两种供 A/B 复核
  let selection = null, circle = null, reachable = [], orders = [], cityOwners = {};
  let dpr = 1, cssW = 1, cssH = 1;

  // ── 离屏静态地形 ──────────────────────────────────────────────────────
  function buildJiehuaBase() {
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

  function buildGongbiBase() {
    paintGongbi(g, { W, H, TP, terrain, cfg });
  }
  function buildAtlasBase() {
    // 官渡战区图幅，与 map-data.js / terrain.js 的投影范围一致。
    const a = createAtlas({
      LON0: 112.75, LON1: 116.15, LAT0: 32.65, LAT1: 36.65,
      fg: false,                       // 地物留给上层动态绘制
    });
    // atlas 自带 1400×1100 绢底；等比铺满 3456×2592 离屏，笔宽随整体缩放，
    // 主画布再按 camera.scale 缩回，视觉密度与 demos 定稿一致。
    g.drawImage(a.bg, 0, 0, W, H);
  }
  function buildBase() {
    // 每次重建前把离屏上下文恢复到同一基线：lineCap / alpha / dash 等状态
    // 会被两种画法互相留下，否则 gongbi→jiehua→gongbi 无法逐像素复原。
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.setLineDash([]);
    g.lineCap = 'butt'; g.lineJoin = 'miter'; g.lineWidth = 1;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, W, H);
    if (style === 'jiehua') { buildJiehuaBase(); return; }
    if (style === 'atlas') { buildAtlasBase(); return; }
    buildGongbiBase();
  }
  buildBase();

  // ── 主画布 ────────────────────────────────────────────────────────────
  function resize() {
    dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    // 与 city-view 同理：属性尺寸必须严格等于 CSS 尺寸 × DPR。
    // 用 800/600 兜底会在真机地址栏动画期间把位图拉伸，导致点击错位。
    if (rect.width < 1 || rect.height < 1) return false;
    cssW = rect.width; cssH = rect.height;
    const aw = Math.round(cssW * dpr), ah = Math.round(cssH * dpr);
    if (canvas.width !== aw) canvas.width = aw;
    if (canvas.height !== ah) canvas.height = ah;
    clampCamera();
    return true;
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
    const gongbi = style !== 'jiehua';
    for (const b of borderPaths) {
      if (gongbi) {
        ctx.lineWidth = 9 / camera.scale;
        ctx.strokeStyle = rgba(b.color, 0.075);
        ctx.stroke(b.path);
      }
      ctx.lineWidth = 1.1 / camera.scale;
      ctx.strokeStyle = rgba(b.color, gongbi ? 0.30 : 0.55);
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
      ctx.strokeStyle = rgba(f?.color ?? GOLD, style !== 'jiehua' ? 0.62 : 0.8);
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
    const th = theme(style);

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
      const ink = city.rank === 1 ? th.gold : city.rank === 2 ? th.text : rgba(th.text, 0.82);
      ctx.font = `600 ${cf}px "WenQuanYi Micro Hei", serif`;
      [...city.name].forEach((ch, i) => {
        const yy = ly + i * cf * 1.12;
        ctx.strokeStyle = rgba(th.stroke, 0.95); ctx.lineWidth = (city.rank === 1 ? 3.2 : 2.6) * k;
        ctx.strokeText(ch, lx, yy);
        ctx.fillStyle = ink;
        ctx.fillText(ch, lx, yy);
      });
      // 势力色小方章 + 等级
      const foot = ly + city.name.length * cf * 1.12;
      ctx.fillStyle = f?.color ?? '#8899aa';
      ctx.fillRect(lx, foot + 3 * k, (city.rank === 1 ? 13 : 9) * k, 3 * k);
      ctx.font = `${smallFont}px "WenQuanYi Micro Hei", serif`;
      ctx.fillStyle = th.dim;
      ctx.fillText(city.rank === 1 ? '都' : city.rank === 2 ? '郡' : city.rank === 3 ? '县' : '垒',
        lx + (city.rank === 1 ? 16 : 12) * k, foot);
    }

    // 关隘 / 津渡：符号 + 名称，符号尺寸固定屏幕像素
    for (const p of PASSES) {
      const q = geoToTile(p.lon, p.lat, terrain.cols, terrain.rows);
      const x = (q.c + 0.5) * TP, y = (q.r + 0.5) * TP;
      const col = p.kind === 'ford' ? th.pass : th.gold;
      ctx.fillStyle = col; ctx.strokeStyle = rgba(th.stroke, 0.9); ctx.lineWidth = 1.2 * k;
      ctx.beginPath();
      if (p.kind === 'ford') ctx.arc(x, y, 4 * k, 0, Math.PI * 2);
      else {
        ctx.moveTo(x, y - 5 * k); ctx.lineTo(x + 4.5 * k, y + 4 * k);
        ctx.lineTo(x - 4.5 * k, y + 4 * k); ctx.closePath();
      }
      ctx.fill(); ctx.stroke();
      ctx.font = `600 ${smallFont}px "WenQuanYi Micro Hei", serif`;
      ctx.strokeStyle = rgba(th.stroke, 0.95); ctx.lineWidth = 2.4 * k;
      ctx.strokeText(p.name, x + 8 * k, y - 5 * k);
      ctx.fillStyle = col;
      ctx.fillText(p.name, x + 8 * k, y - 5 * k);
    }

    // 地理注记：山名 / 水名 / 泽名，沿锚点小字排布
    const note = (text, lon, lat, color, rot = 0) => {
      const p = project(lon, lat, W, H);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(rot);
      ctx.font = `italic ${noteFont}px "WenQuanYi Micro Hei", serif`;
      ctx.strokeStyle = rgba(th.stroke, 0.92); ctx.lineWidth = 2.4 * k;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = color; ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    for (const rg of RIDGES) {
      const mid = rg.pts[Math.floor(rg.pts.length / 2)];
      note(rg.name, mid[0], mid[1], rgba(th.ridge, 0.92), -0.5);
    }
    for (const rv of RIVERS_MINOR) {
      const mid = rv.pts[Math.floor(rv.pts.length / 2)];
      note(rv.name, mid[0], mid[1], rgba(th.water, 0.92), 0.18);
    }
    for (const lk of LAKES) note(lk.name, lk.lon, lk.lat, rgba(th.lake, 0.92), 0);
    note('黄 河', 113.72, 35.02, rgba(th.huanghe, 0.95), -0.15);
    note('官 渡', 113.93, 34.48, rgba(th.gold, 0.95), 0);
  }

  /** 土地等级角标：只在放大到能看清时画，字号固定屏幕像素。 */
  function drawLevels(ctx) {
    // 数字角标是最强的「沙盘仪表」信号；只在大幅放大后才极淡出现。
    if (camera.scale < 1.6) return;
    const th = theme(style);
    ctx.font = '8px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba(th.text, style !== 'jiehua' ? 0.30 : 0.8);
    ctx.strokeStyle = rgba(th.stroke, style !== 'jiehua' ? 0.5 : 0.8);
    ctx.lineWidth = 2 / camera.scale;
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
    const th = theme(style);
    ctx.strokeStyle = rgba(th.frame, 0.34); ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, cssW - 6, cssH - 6);

    // 缩略导航：全图 + 当前视口框，解决「放大后不知道自己在哪」
    const mw = Math.min(190, cssW * 0.24), mh = mw * (H / W);
    // 让开右下工具列（约 62px），否则缩略图被压在按钮底下。
    const mx = cssW - mw - 14 - (cssW > 720 ? 62 : 56), my = cssH - mh - 58;
    ctx.fillStyle = rgba(style !== 'jiehua' ? '#e9e3d1' : '#0b100e', 0.97);
    ctx.fillRect(mx - 5, my - 5, mw + 10, mh + 10);
    ctx.strokeStyle = rgba(th.frame, 0.62); ctx.lineWidth = 1.5;
    ctx.strokeRect(mx - 5, my - 5, mw + 10, mh + 10);
    ctx.fillStyle = rgba(style !== 'jiehua' ? '#e9e3d1' : '#0b100e', 0.97);
    ctx.fillRect(mx - 5, my - 22, 76, 16);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, mx, my, mw, mh);
    const vx = mx + (camera.x / W) * mw, vy = my + (camera.y / H) * mh;
    const vw = (cssW / camera.scale / W) * mw, vh = (cssH / camera.scale / H) * mh;
    ctx.strokeStyle = rgba(style !== 'jiehua' ? '#a6483a' : GOLD, 0.95); ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, Math.max(3, vw), Math.max(3, vh));
    ctx.font = '9px "WenQuanYi Micro Hei", serif';
    ctx.fillStyle = rgba(th.text, 0.85);
    ctx.fillText(`全图 ${terrain.cols}×${terrain.rows}`, mx, my - 10);

    // 比例尺
    ctx.font = '10px "WenQuanYi Micro Hei", serif';
    ctx.fillStyle = rgba(th.text, 0.7);
    ctx.fillText(`建安五年 · 豫兖战线 · 1 格 ≈ ${kmPerTileLabel()} km · 缩放 ${camera.scale.toFixed(2)}×`,
      14, cssH - 20);
    ctx.restore();
  }
  function kmPerTileLabel() {
    const lonStep = (114.0 - 113.0) * 111 * Math.cos(34.5 * Math.PI / 180);
    return (lonStep / terrain.cols * 3.4).toFixed(1);
  }

  function draw(ctx) {
    // 同 city-view：位图尺寸必须与 CSS 尺寸逐像素对应，否则点击与画面错位。
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0 &&
        (Math.abs(canvas.clientWidth - cssW) > 3 ||
         canvas.width !== Math.round(cssW * dpr))) resize();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = style !== 'jiehua' ? GONGBI.paperLo : '#0e1411';
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
      const th = theme(style);
      // 一片淡染，不是一格一个硬圆点。
      ctx.beginPath();
      for (const p of reachable) {
        ctx.rect(p.c * TP, p.r * TP, TP, TP);
      }
      // 只 fill 不 stroke：相邻 rect 连成一片淡染，一描边就又变回方格网。
      ctx.fillStyle = rgba(th.reach, style !== 'jiehua' ? 0.10 : 0.18);
      ctx.fill();
    }
    drawOrders(ctx);

    if (selection) {
      const th = theme(style);
      const cx = (selection.c + 0.5) * TP, cy = (selection.r + 0.5) * TP;
      if (style !== 'jiehua') {
        // 细线圈 + 淡晕，不再是方格框
        ctx.beginPath(); ctx.arc(cx, cy, TP * 0.82, 0, Math.PI * 2);
        ctx.fillStyle = rgba(th.reach, 0.07); ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy, TP * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(th.text, 0.78); ctx.lineWidth = 1.4 / camera.scale; ctx.stroke();
      } else {
        ctx.strokeStyle = GOLD; ctx.lineWidth = 2.2 / camera.scale;
        ctx.strokeRect(selection.c * TP + 1, selection.r * TP + 1, TP - 2, TP - 2);
        ctx.strokeStyle = rgba(GOLD, 0.4); ctx.lineWidth = 1 / camera.scale;
        ctx.strokeRect((selection.c - 1) * TP, (selection.r - 1) * TP, TP * 3, TP * 3);
      }
    }
    if (circle) {
      ctx.strokeStyle = rgba(style !== 'jiehua' ? '#a6483a' : '#e8d9a8', 0.95); ctx.lineWidth = 1.8 / camera.scale;
      ctx.setLineDash([5 / camera.scale, 4 / camera.scale]);
      ctx.beginPath(); ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(style !== 'jiehua' ? '#a6483a' : '#e8d9a8', 0.10); ctx.fill();
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
    setStyle(next) {
      const v = next === 'jiehua' ? 'jiehua' : next === 'gongbi' ? 'gongbi' : 'atlas';
      if (style !== v) { style = v; buildBase(); }
      return style;
    },
    get style() { return style; },
    get offscreen() { return off; },   // 烟测做逐像素 A/B 用，不参与渲染
    invalidateBorders() { borderPaths = null; },
    get size() { return { W, H, TP }; },
    describe(c, r) { return terrain.describe(c, r); },
    terrain,
  };
}
