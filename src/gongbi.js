// 工笔青绿设色（v0.7.0）。
//
// 与「界画」的全部区别在一句话：不再遍历 tiles 画符号。
//   格仍然只管「哪格是山、哪格能走」（terrain.js / A* / 存档一行没动），
//   画面改由三样连续的东西构成：
//     ① 分染：低分辨率「类型场」平滑放大 → 柔和连续设色，没有硬格边；
//     ② 白描：山脊 / 河道 / 官道用现成折线勾成连续线，不是逐格拼线段；
//     ③ 点景：树丛、田埂、芦苇、楼阁按区域锚点成组画，不逐格铺。
//   等级角标、可达点阵、方格选框这些「沙盘仪表」也随之柔化。
//
// 零位图、零 Math.random、零 ctx.filter；全部确定性 hash，同 seed 逐字节一致。
import {
  CITIES, RIVER_HUANGHE, RIVERS_MINOR, RIDGES, LAKES, PASSES, ROADS, project,
} from './map-data.js';
import { T } from './terrain.js';

// 绢本 + 矿物颜料：色都往灰里收半档，不用纯白纯黑，也不亮金正红。
const C = {
  paper: '#cdc4a7', paperHi: '#ded6bc', paperLo: '#bcb395',
  ink: '#2f3a33', inkSoft: '#53604f', inkFaint: '#6d7869',
  mala: '#7f9c84', malaHi: '#9ab397', malaLo: '#4f6f5e',
  azur: '#5f8089', azurHi: '#88a8aa', azurLo: '#3c5b64',
  ochre: '#a4835a', ochreHi: '#c6a87f', ochreLo: '#7d6244',
  water: '#a6c0bb', waterHi: '#c6dcd5', waterLo: '#7d9c9d',
  cinnabar: '#a6483a', cinnabarHi: '#c4695a',
  tileWhite: '#e8dfc6',
};

// 分染用的「类型场」色：比上面的矿物色更淡，作为底层罩染。
const FIELD = {
  plain: '#bcc09f', farmland: '#c8caa0', forest: '#9aae89',
  hill: '#a2b296', mountain: '#8ba694', river: '#a9c3bd', lake: '#a6c0bb',
  marsh: '#adb89f', road: '#c8b892', city: '#d2c19d', wall: '#bcae90',
  gate: '#cbb691', ford: '#aac4bf', pass: '#c2ac86',
};

function hash(x, y, s = 1) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const hex2rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** 折线加密：线性插值，让连续线有足够采样点做峰峦 / 波纹起伏。 */
function densify(P, per = 12) {
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(P[P.length - 1]);
  return out;
}

/** 一条连续曲线：中点 quadratic，首尾不脱节。 */
function curve(P) {
  const p = new Path2D();
  if (P.length < 2) return p;
  p.moveTo(P[0].x, P[0].y);
  for (let i = 1; i < P.length - 1; i++) {
    const mx = (P[i].x + P[i + 1].x) / 2, my = (P[i].y + P[i + 1].y) / 2;
    p.quadraticCurveTo(P[i].x, P[i].y, mx, my);
  }
  const a = P[P.length - 2], b = P[P.length - 1];
  p.quadraticCurveTo(a.x, a.y, b.x, b.y);
  return p;
}

function normals(P) {
  return P.map((p, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    return { x: -dy / L, y: dx / L };
  });
}

// ── ① 分染：类型场平滑放大 ─────────────────────────────────────────────
function paintField(g, env) {
  const { W, H, terrain } = env;
  const { cols, rows, tiles } = terrain;

  // 绢底：暖黄褐，两端略压暗，中间留亮。
  const bg = g.createLinearGradient(0, 0, W * 0.35, H);
  bg.addColorStop(0, C.paperHi); bg.addColorStop(0.55, C.paper); bg.addColorStop(1, C.paperLo);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // 纸性：几十条贯穿全幅的极淡横纹（连续线，不是每格一个噪点方块）。
  g.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    const y = hash(i, 91) * H;
    g.strokeStyle = rgba(hash(i, 7) > 0.5 ? '#ffffff' : C.ochreLo, 0.018 + hash(i, 13) * 0.014);
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= W; x += 160) g.lineTo(x, y + Math.sin((x / W) * 6 + i) * 1.6);
    g.stroke();
  }

  // 类型场：每格 1px，放大到全尺寸 = 柔和分染，格边自然消失。
  const sc = document.createElement('canvas');
  sc.width = cols; sc.height = rows;
  const sg = sc.getContext('2d');
  const img = sg.createImageData(cols, rows);
  for (let i = 0; i < tiles.length; i++) {
    const [r, gg, b] = hex2rgb(FIELD[tiles[i].type] ?? FIELD.plain);
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 224;
  }
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.globalAlpha = 0.74;
  g.drawImage(sc, 0, 0, W, H);
  g.globalAlpha = 1;
}

// ── ② 白描 · 山：沿山脊折线生成连续峰峦带 ─────────────────────────────
function paintRidges(g, env) {
  const { W, TP } = env;
  for (let ri = 0; ri < RIDGES.length; ri++) {
    const rg = RIDGES[ri];
    const ctr = densify(rg.pts.map(([lo, la]) => project(lo, la, W, env.H)), 16);
    const N = ctr.length, nv = normals(ctr);
    // width 在 terrain.js 里是 W*width*0.5 的半带宽；工笔里收一点，避免四条脊糊成一片。
    const half = W * rg.width * 0.5 * 0.36;
    const upper = [], lower = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const peak = 0.66 + 0.26 * Math.sin(t * Math.PI * (6 + ri) + ri * 1.7)
        + 0.13 * Math.sin(t * Math.PI * (17 + ri * 3) + ri);
      const w = half * Math.max(0.35, peak);
      upper.push({ x: ctr[i].x + nv[i].x * w, y: ctr[i].y + nv[i].y * w });
      lower.push({ x: ctr[i].x - nv[i].x * half * 0.60, y: ctr[i].y - nv[i].y * half * 0.60 });
    }
    const body = new Path2D();
    body.moveTo(upper[0].x, upper[0].y);
    for (let i = 1; i < N; i++) body.lineTo(upper[i].x, upper[i].y);
    for (let i = N - 1; i >= 0; i--) body.lineTo(lower[i].x, lower[i].y);
    body.closePath();

    // 罩染：石绿 → 石青，沿「平均法线」方向分出阴阳面。
    const mid = Math.floor(N / 2);
    const gx = ctr[0].x, gy = ctr[0].y;
    const grad = g.createLinearGradient(
      upper[mid].x, upper[mid].y, lower[mid].x, lower[mid].y);
    grad.addColorStop(0, rgba(C.malaHi, 0.70));
    grad.addColorStop(0.42, rgba(C.mala, 0.66));
    grad.addColorStop(1, rgba(C.azur, 0.60));
    g.fillStyle = grad; g.fill(body);   // 罩染，不盖死底下的类型场

    // 分染加层：脊顶一道浅石绿，坡脚一道赭石，都是连续线不是色块。
    g.save(); g.clip(body);
    g.strokeStyle = rgba(C.malaHi, 0.42); g.lineWidth = half * 0.5;
    g.stroke(curve(upper));
    g.strokeStyle = rgba(C.ochreLo, 0.30); g.lineWidth = half * 0.42;
    g.stroke(curve(lower));
    g.restore();

    // 铁线描：脊线细墨勾，坡脚更淡。
    g.strokeStyle = rgba(C.ink, 0.88); g.lineWidth = 2.1;
    g.stroke(curve(upper));
    g.strokeStyle = rgba(C.inkSoft, 0.48); g.lineWidth = 1.2;
    g.stroke(curve(lower));

    // 皴：顺着坡势的短弧，按脊线成组，不逐格。
    g.strokeStyle = rgba(C.ink, 0.36); g.lineWidth = 1.15;
    for (let i = 2; i < N - 2; i += 2) {
      const a = upper[i], b = lower[i];
      for (let k = 0; k < 3; k++) {
        const u = 0.22 + k * 0.22;
        const sx = a.x + (b.x - a.x) * u, sy = a.y + (b.y - a.y) * u;
        const dx = (b.x - a.x) / half, dy = (b.y - a.y) / half;
        g.beginPath(); g.moveTo(sx, sy);
        g.quadraticCurveTo(sx + dy * 9, sy - dx * 9, sx + dy * 17 - dx * 6, sy - dx * 17 - dy * 6);
        g.stroke();
      }
    }
    // 峰峦：沿脊线一个个勾出山头，石青分染阴面。工笔以线造型，不靠一整块色。
    for (let i = 5; i < N - 5; i += 7) {
      const a = upper[i], b = lower[i], nv0 = nv[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;      // 向坡内
      const h = L * (0.34 + hash(i, ri, 41) * 0.22);
      const apex = { x: a.x + ux * h, y: a.y + uy * h - L * 0.10 };
      const footL = { x: a.x - nv0.x * L * 0.30, y: a.y - nv0.y * L * 0.30 };
      const footR = { x: a.x + nv0.x * L * 0.30, y: a.y + nv0.y * L * 0.30 };
      const pk = new Path2D();
      pk.moveTo(footL.x, footL.y);
      pk.quadraticCurveTo(a.x - nv0.x * L * 0.10 + ux * h * 0.4,
        a.y - nv0.y * L * 0.10 + uy * h * 0.4, apex.x, apex.y);
      pk.quadraticCurveTo(a.x + nv0.x * L * 0.10 + ux * h * 0.4,
        a.y + nv0.y * L * 0.10 + uy * h * 0.4, footR.x, footR.y);
      // 阴面分染
      g.save();
      const shade = new Path2D();
      shade.moveTo(apex.x, apex.y);
      shade.quadraticCurveTo(a.x + nv0.x * L * 0.10 + ux * h * 0.4,
        a.y + nv0.y * L * 0.10 + uy * h * 0.4, footR.x, footR.y);
      shade.lineTo(a.x + ux * h * 0.75, a.y + uy * h * 0.75);
      shade.closePath();
      g.fillStyle = rgba(C.azurLo, 0.24); g.fill(shade);
      g.restore();
      g.strokeStyle = rgba(C.ink, 0.62); g.lineWidth = 1.35;
      g.stroke(pk);
    }

    // 远峰：脊线外侧偶尔一笔淡墨，拉出层次。
    g.strokeStyle = rgba(C.azurLo, 0.16); g.lineWidth = 1.2;
    for (let i = 8; i < N - 8; i += 22) {
      const p = upper[i], n = nv[i];
      g.beginPath();
      g.moveTo(p.x + n.x * TP * 1.2, p.y + n.y * TP * 1.2);
      g.quadraticCurveTo(p.x + n.x * TP * 2.1, p.y + n.y * TP * 2.1 - TP * 0.7,
        p.x + n.x * TP * 3.0, p.y + n.y * TP * 3.0);
      g.stroke();
    }
  }
}

// ── ② 白描 · 水：双钩河岸 + 长水纹 ─────────────────────────────────────
function paintWaters(g, env) {
  const { W, H, TP } = env;
  const rivers = [[RIVER_HUANGHE, TP * 1.15, '黄河'],
    ...RIVERS_MINOR.map((rv) => [rv.pts, TP * 0.42, rv.name])];
  for (let k = 0; k < rivers.length; k++) {
    const [pts, width] = rivers[k];
    const ctr = densify(pts.map(([lo, la]) => project(lo, la, W, H)), 14);
    const nv = normals(ctr), N = ctr.length;
    const L = [], R = [];
    for (let i = 0; i < N; i++) {
      const w = width * (0.86 + 0.16 * Math.sin(i * 0.21 + k));
      L.push({ x: ctr[i].x + nv[i].x * w, y: ctr[i].y + nv[i].y * w });
      R.push({ x: ctr[i].x - nv[i].x * w, y: ctr[i].y - nv[i].y * w });
    }
    const body = new Path2D();
    body.moveTo(L[0].x, L[0].y);
    for (let i = 1; i < N; i++) body.lineTo(L[i].x, L[i].y);
    for (let i = N - 1; i >= 0; i--) body.lineTo(R[i].x, R[i].y);
    body.closePath();
    g.fillStyle = rgba(C.water, 0.72); g.fill(body);
    g.save(); g.clip(body);
    g.fillStyle = rgba(C.waterLo, 0.28);
    g.fillRect(0, 0, W, H);
    g.restore();

    // 双钩岸线：墨线 + 赭石淡线，连续。
    for (const bank of [L, R]) {
      g.strokeStyle = rgba(C.inkSoft, 0.52); g.lineWidth = 1.25;
      g.stroke(curve(bank));
      g.strokeStyle = rgba(C.ochreLo, 0.24); g.lineWidth = 2.6;
      g.stroke(curve(bank));
    }
    // 水纹：沿流向的长曲线，带正弦起伏；不是每格两条短 bezier。
    g.lineWidth = 1;
    for (let m = -4; m <= 4; m++) {
      const off = (m / 5) * width * 0.76;
      const P = ctr.map((p, i) => ({
        x: p.x + nv[i].x * (off + Math.sin(i * 0.28 + m) * 2.2 + Math.sin(i * 0.09 + k) * 2.4),
        y: p.y + nv[i].y * (off + Math.sin(i * 0.28 + m) * 2.2 + Math.sin(i * 0.09 + k) * 2.4),
      }));
      g.strokeStyle = rgba(m % 2 ? C.waterHi : C.tileWhite, 0.24 + (m === 0 ? 0.12 : 0));
      g.stroke(curve(P));
    }
  }

  // 泽薮：椭圆淡染 + 双钩岸 + 芦苇
  for (const lk of LAKES) {
    const p = project(lk.lon, lk.lat, W, H);
    const q = project(lk.lon + lk.rx, lk.lat - lk.ry, W, H);
    const rx = Math.max(TP * 2, Math.abs(q.x - p.x)), ry = Math.max(TP * 1.4, Math.abs(q.y - p.y));
    g.beginPath(); g.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
    g.fillStyle = rgba(C.water, 0.74); g.fill();
    g.strokeStyle = rgba(C.inkSoft, 0.50); g.lineWidth = 1.2; g.stroke();
    g.beginPath(); g.ellipse(p.x, p.y, rx - 3, ry - 3, 0, 0, Math.PI * 2);
    g.strokeStyle = rgba(C.ochreLo, 0.22); g.lineWidth = 2.2; g.stroke();
    for (let i = 0; i < 4; i++) {
      const xx = p.x + (i - 1.5) * (rx / 3.4), yy = p.y + (i - 1.5) * (ry / 3.4);
      g.strokeStyle = rgba(C.waterHi, 0.38); g.lineWidth = 1;
      g.beginPath(); g.moveTo(xx - 9, yy); g.quadraticCurveTo(xx, yy - 2, xx + 9, yy); g.stroke();
    }
  }
}

// ── ② 白描 · 官道：一条淡赭细线，不再织网 ─────────────────────────────
function paintRoads(g, env) {
  const { W, H } = env;
  for (const rd of ROADS) {
    const a = CITIES.find((c) => c.id === rd.a), b = CITIES.find((c) => c.id === rd.b);
    if (!a || !b) continue;
    const pts = [[a.lon, a.lat], ...(rd.via ?? []), [b.lon, b.lat]]
      .map(([lo, la]) => project(lo, la, W, H));
    const raw = densify(pts, 10);
    const nv = normals(raw);
    // 官道随地形微曲，不做几何直线：确定性正弦，不碰数据格。
    const P = raw.map((p, i) => ({
      x: p.x + nv[i].x * (Math.sin(i * 0.13 + k0(rd)) * 3.2 + Math.sin(i * 0.041) * 2.2),
      y: p.y + nv[i].y * (Math.sin(i * 0.13 + k0(rd)) * 3.2 + Math.sin(i * 0.041) * 2.2),
    }));
    const path = curve(P);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = rgba(C.ochreLo, 0.08); g.lineWidth = 7; g.stroke(path);
    g.strokeStyle = rgba(C.ochre, 0.42); g.lineWidth = 1.6; g.stroke(path);
    // 车辙：沿路稀疏两点一组，不是逐格双线。
    g.fillStyle = rgba(C.inkSoft, 0.24);
    for (let i = 12; i < P.length - 12; i += 30) {
      const q = P[i], n = normals(P)[i];
      g.fillRect(q.x + n.x * 2 - 0.6, q.y + n.y * 2 - 0.6, 1.2, 1.2);
      g.fillRect(q.x - n.x * 2 - 0.6, q.y - n.y * 2 - 0.6, 1.2, 1.2);
    }
  }
}

// ── ③ 点景：按区域锚点成组，不逐格 ────────────────────────────────────
function paintScenery(g, env) {
  const { TP, terrain } = env;
  const tiles = terrain.tiles;
  for (const t of tiles) {
    // 林地：每 4×4 取一丛双钩夹叶
    if (t.type === T.FOREST && t.c % 3 === 1 && t.r % 3 === 1 && hash(t.c, t.r, 13) > 0.24) {
      const x = t.c * TP + TP / 2, y = t.r * TP + TP * 0.6;
      const s = 0.9 + hash(t.c, t.r, 17) * 0.5;
      for (let k = -1; k <= 1; k++) {
        const tx = x + k * 5.5 * s, ty = y + (k === 0 ? -2 : 1) * s;
        g.strokeStyle = rgba(C.ink, 0.72); g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(tx, ty + 4 * s); g.lineTo(tx, ty - 3 * s); g.stroke();
        // 夹叶：三片小叶，细墨勾 + 石绿点染
        for (const [dx, dy] of [[-2.6, -3.6], [0, -5.4], [2.6, -3.6]]) {
          g.beginPath();
          g.ellipse(tx + dx * s, ty + dy * s, 2.5 * s, 1.7 * s, dx * 0.24, 0, Math.PI * 2);
          g.fillStyle = rgba(C.malaLo, 0.78); g.fill();
          g.strokeStyle = rgba(C.ink, 0.66); g.lineWidth = 0.9; g.stroke();
        }
      }
    }
    // 山地：每 5×5 一组短皴，顺着固定坡向
    if ((t.type === T.MOUNTAIN || t.type === T.HILL) &&
        t.c % 5 === 2 && t.r % 5 === 2 && hash(t.c, t.r, 23) > 0.45) {
      const x = t.c * TP + TP / 2, y = t.r * TP + TP / 2;
      g.strokeStyle = rgba(C.ink, 0.32); g.lineWidth = 1.1;
      for (let k = 0; k < 3; k++) {
        const yy = y + (k - 1) * 4;
        g.beginPath(); g.moveTo(x - 6, yy + 3);
        g.quadraticCurveTo(x, yy - 2, x + 6, yy + 1); g.stroke();
      }
    }
    // 良田：每 6×6 一组长田埂（贯穿 6 格），不是每格四条短线
    if (t.type === T.FARMLAND && t.c % 6 === 3 && t.r % 6 === 3) {
      const x = t.c * TP - TP * 2.5, y = t.r * TP;
      g.strokeStyle = rgba(C.ochreLo, 0.30); g.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const yy = y + (k + 0.5) * TP * 2;
        g.beginPath(); g.moveTo(x, yy);
        for (let xx = 0; xx <= TP * 6; xx += TP) g.lineTo(x + xx, yy + Math.sin(xx / TP + k) * 1.2);
        g.stroke();
      }
    }
    // 沼泽：成簇芦苇
    if (t.type === T.MARSH && t.c % 4 === 1 && t.r % 4 === 1 && hash(t.c, t.r, 31) > 0.4) {
      const x = t.c * TP + TP / 2, y = t.r * TP + TP * 0.72;
      g.strokeStyle = rgba(C.inkSoft, 0.46); g.lineWidth = 1.1;
      for (let k = -1; k <= 1; k++) {
        g.beginPath(); g.moveTo(x + k * 3, y);
        g.quadraticCurveTo(x + k * 4, y - 5, x + k * 6 + 1, y - 8 - k); g.stroke();
      }
    }
  }
}

// ── ③ 城郭：工笔楼阁，白墙朱柱青瓦，细线勾勒 ──────────────────────────
function paintCities(g, env) {
  const { TP, terrain, cfg } = env;
  for (const city of CITIES) {
    const info = terrain.cityTiles[city.id];
    const rad = info.rad;
    const x0 = (info.c - rad) * TP, y0 = (info.r - rad) * TP;
    const size = (rad * 2 + 1) * TP;
    const f = cfg.factions.find((v) => v.id === city.owner);
    const col = f?.color ?? C.cinnabar;

    // 城内：淡赭地面 + 十字街（细墨）
    g.fillStyle = rgba(C.ochreHi, 0.26); g.fillRect(x0, y0, size, size);
    g.strokeStyle = rgba(C.inkSoft, 0.26); g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(x0 + size / 2, y0 + 4); g.lineTo(x0 + size / 2, y0 + size - 4);
    g.moveTo(x0 + 4, y0 + size / 2); g.lineTo(x0 + size - 4, y0 + size / 2);
    g.stroke();

    // 府衙：院墙 + 重檐正殿 + 朱柱
    const cx = x0 + size / 2, cy = y0 + size / 2;
    g.fillStyle = rgba(C.tileWhite, 0.72);
    g.fillRect(cx - size * 0.22, cy - size * 0.17, size * 0.44, size * 0.34);
    g.strokeStyle = rgba(C.ink, 0.66); g.lineWidth = 1.1;
    g.strokeRect(cx - size * 0.22, cy - size * 0.17, size * 0.44, size * 0.34);
    g.fillStyle = rgba(C.cinnabar, 0.62);
    for (let k = -2; k <= 2; k++) g.fillRect(cx + k * size * 0.085 - 1, cy - size * 0.13, 2, size * 0.26);
    // 青瓦重檐（两道横线 + 瓦纹）
    for (const yy of [cy - size * 0.19, cy - size * 0.14]) {
      g.fillStyle = rgba(C.azurLo, 0.88); g.fillRect(cx - size * 0.26, yy, size * 0.52, 3.2);
      g.strokeStyle = rgba(C.ink, 0.55); g.lineWidth = 0.7;
      for (let xx = -5; xx <= 5; xx++) {
        const px = cx + xx * size * 0.05;
        g.beginPath(); g.moveTo(px, yy); g.lineTo(px, yy + 3.2); g.stroke();
      }
    }

    // 城墙：白墙带 + 细墨勾 + 青瓦檐线 + 垛口细竖线
    const bw = 6;
    g.fillStyle = rgba(C.tileWhite, 0.70);
    g.fillRect(x0, y0, size, bw); g.fillRect(x0, y0 + size - bw, size, bw);
    g.fillRect(x0, y0, bw, size); g.fillRect(x0 + size - bw, y0, bw, size);
    g.strokeStyle = rgba(C.ink, 0.72); g.lineWidth = 1.15;
    g.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
    g.strokeRect(x0 + bw, y0 + bw, size - bw * 2, size - bw * 2);
    g.strokeStyle = rgba(C.azurLo, 0.78); g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(x0, y0 + bw / 2); g.lineTo(x0 + size, y0 + bw / 2);
    g.moveTo(x0, y0 + size - bw / 2); g.lineTo(x0 + size, y0 + size - bw / 2);
    g.moveTo(x0 + bw / 2, y0); g.lineTo(x0 + bw / 2, y0 + size);
    g.moveTo(x0 + size - bw / 2, y0); g.lineTo(x0 + size - bw / 2, y0 + size);
    g.stroke();
    g.strokeStyle = rgba(C.ink, 0.48); g.lineWidth = 0.9;
    for (let k = 0; k < size - 8; k += 5) {
      g.beginPath(); g.moveTo(x0 + 3 + k, y0); g.lineTo(x0 + 3 + k, y0 + 3);
      g.moveTo(x0 + 3 + k, y0 + size); g.lineTo(x0 + 3 + k, y0 + size - 3);
      g.moveTo(x0, y0 + 3 + k); g.lineTo(x0 + 3, y0 + 3 + k);
      g.moveTo(x0 + size, y0 + 3 + k); g.lineTo(x0 + size - 3, y0 + 3 + k);
      g.stroke();
    }

    // 角楼：白墙 + 朱柱 + 青瓦重檐 + 脊
    for (const [ax, ay] of [[x0, y0], [x0 + size - 11, y0],
      [x0, y0 + size - 11], [x0 + size - 11, y0 + size - 11]]) {
      g.fillStyle = rgba(C.tileWhite, 0.80); g.fillRect(ax + 1, ay + 1, 9, 9);
      g.strokeStyle = rgba(C.ink, 0.72); g.lineWidth = 1; g.strokeRect(ax + 1, ay + 1, 9, 9);
      g.fillStyle = rgba(C.cinnabar, 0.72); g.fillRect(ax + 2, ay + 4, 1.6, 5);
      g.fillRect(ax + 7.4, ay + 4, 1.6, 5);
      g.fillStyle = rgba(C.azurLo, 0.92); g.fillRect(ax - 1, ay - 1, 13, 2.6);
      g.fillRect(ax - 1, ay + 4.2, 13, 1.8);
      g.strokeStyle = rgba(C.ink, 0.6); g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(ax + 5.5, ay - 1); g.lineTo(ax + 5.5, ay - 3.4); g.stroke();
    }

    // 城门：门洞 + 朱门 + 门钉 + 门额
    const gp = info.gate;
    const gx = gp[0] * TP, gy = gp[1] * TP;
    g.fillStyle = rgba(C.ink, 0.86); g.fillRect(gx + 1, gy + 1, TP - 2, TP - 2);
    g.fillStyle = rgba(C.cinnabar, 0.82); g.fillRect(gx + 3, gy + 4, TP - 6, TP - 5);
    g.fillStyle = rgba(C.ochreHi, 0.9);
    for (let k = 0; k < 3; k++) g.fillRect(gx + 5 + k * 4, gy + 8, 1.4, 1.4);
    g.fillStyle = rgba(C.tileWhite, 0.82); g.fillRect(gx, gy - 1, TP, 3);
    g.strokeStyle = rgba(C.ink, 0.7); g.lineWidth = 0.9; g.strokeRect(gx, gy - 1, TP, 3);

    // 旗纛：细杆 + 三角旗（势力色压灰）
    const fx = x0 + size + 4, fy = y0 + 3;
    g.strokeStyle = rgba(C.ink, 0.75); g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx, fy + 24); g.stroke();
    g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + 13, fy + 4.5);
    g.lineTo(fx, fy + 10); g.closePath();
    g.fillStyle = rgba(col, 0.86); g.fill();
    g.strokeStyle = rgba(C.ink, 0.62); g.lineWidth = 0.9; g.stroke();
  }
}

/** 入口：一次性画进离屏 g。 */
function k0(rd) { return (rd.name?.length ?? 3) * 0.7; }

export function paintGongbi(g, env) {
  paintField(g, env);
  paintRidges(g, env);
  paintWaters(g, env);
  paintRoads(g, env);
  paintScenery(g, env);
  paintCities(g, env);

  // 图廓：淡墨双线 + 四角朱印小记，收住整幅。
  const { W, H } = env;
  g.strokeStyle = rgba(C.ink, 0.42); g.lineWidth = 1.4;
  g.strokeRect(6, 6, W - 12, H - 12);
  g.strokeStyle = rgba(C.inkSoft, 0.24); g.lineWidth = 0.8;
  g.strokeRect(10, 10, W - 20, H - 20);
}

export const GONGBI = C;
