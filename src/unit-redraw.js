// 单位／将领立绘重绘层（第十九轮）。纯 canvas 路径，无 DOM、无 state、
// 无墙钟、无随机源、无位图。相位只取 sec + id 派生种子，同 sec 逐像素一致。
//
// 这是「重绘」不是「调色」：五档各写一套主体画法，不共用同一图章循环。
// 旧版 soldier.js / general-portrait.js 一个字节不动，作为 classic 基线。
// 公共骨架只管地面投影、动势变换、血条与选中环；主体按皮肤分派。

const has = (v) => Math.max(0, Math.min(1, v ?? 1));
const A = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
function h1(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function poly(ctx, pts, fill, stroke, lw = 1) {
  if (!pts.length) return;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function line(ctx, x1, y1, x2, y2, c, w = 1) {
  ctx.strokeStyle = c; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function arc(ctx, x, y, r, c, w = 1, a0 = 0, a1 = Math.PI * 2, fill = null) {
  ctx.beginPath(); ctx.arc(x, y, r, a0, a1);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (c) { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke(); }
}

// 每档一套色板；night 档是「画在深墨底上」的浅笔。
const PAL = {
  gongbi: { ink: '#2a2320', iron: '#3f5f62', hi: '#cddcc8', ironLo: '#26383a',
    red: '#a63129', gold: '#c8a86a', wood: '#7a5c38', cloth: '#4a6b58', paper: '#e9e3d1' },
  rubbing: { ink: '#141a18', ink2: '#2c332e', paper: '#e9e3d1', red: '#9b2b22' },
  baimiao: { ink: '#3a3228', ink2: '#6b5e4a', red: '#b0412f', paper: '#e9e3d1' },
  shadow: { amber: '#c98a3e', red: '#a63129', green: '#4a6b58', ink: '#3a2a1c',
    hole: '#efe6cc', gold: '#d8b266' },
  night: { ink: '#0d1512', pale: '#d8d2bb', dim: '#8b9a8c', gold: '#d0b070', red: '#d0705a' },
};

// ── 工具：不规则封闭笔路（不用标准椭圆／矩形做主体） ──────────────────
function blob(ctx, cx, cy, rx, ry, n, seed, fill, stroke, lw) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const q = 0.78 + h1(seed, i, 3) * 0.36;
    pts.push([cx + Math.cos(a) * rx * q, cy + Math.sin(a) * ry * q]);
  }
  poly(ctx, pts, fill, stroke, lw);
}
// 飞白：在墨块上划几道纸色断笔，读成拓片的剥蚀
function flyWhite(ctx, cx, cy, rx, seed, col, k) {
  for (let i = 0; i < 4; i++) {
    const t = h1(seed, i, 11), dx = (t - .5) * rx * 1.6;
    const y = cy - rx * .5 + i * rx * .27;
    line(ctx, cx + dx - rx * .18, y, cx + dx + rx * .12, y - .4 * k, col, .7 * k);
  }
}

// ────────────────────────────────────────────────────────────────────
// B · 工笔札甲：密甲片、护心镜、盾面云纹、盔缨，矿物色硬边平涂
// ────────────────────────────────────────────────────────────────────
function gongbiBody(ctx, u, o) {
  const { k, detail, P, sway, armSw, flutter, seed, engine } = o;
  const heavy = u.type === 'zhongjia';
  const sd = Math.round(seed * 100);
  if (engine) {
    // 床弩／抛石机：俯视木架 + 榫卯短销 + 朱色弦索，甲片式密排横撑
    const L = (u.type === 'paoshi' ? 15 : 13) * k;
    poly(ctx, [[-L, 1.2 * k], [L * .8, -1.4 * k], [L * .9, 1.3 * k], [-L * .9, 3.2 * k]],
      P.wood, P.ink, .9 * k);
    for (let i = -2; i <= 2; i++) {
      line(ctx, i * 4.2 * k, -1.1 * k, i * 4.2 * k + .6 * k, 2.9 * k, A(P.ink, .62), .8 * k);
    }
    if (u.type === 'paoshi') {
      poly(ctx, [[3 * k, -2.4 * k], [8 * k, -5 * k], [9.4 * k, -1 * k], [4 * k, 1 * k]],
        P.iron, P.ink, .8 * k);
      line(ctx, 6 * k, -3.6 * k, 9 * k, -10 * k + flutter, P.red, 1.2 * k);
      blob(ctx, 9.2 * k, -10.4 * k, 1.8 * k, 1.5 * k, 7, sd, P.ironLo, P.ink, .6 * k);
    } else {
      line(ctx, -L * .8, -1 * k, L * .9, -3.4 * k, P.red, 1.4 * k);
      line(ctx, L * .5, -3 * k, L * .9, -6.2 * k + flutter, P.gold, 1 * k);
    }
    arc(ctx, -L * .55, 3 * k, 2.6 * k, P.ink, .8 * k, 0, Math.PI * 2, P.ironLo);
    arc(ctx, L * .45, 2.4 * k, 2.6 * k, P.ink, .8 * k, 0, Math.PI * 2, P.ironLo);
    return;
  }
  // 战裙
  poly(ctx, [[-3.6 * k + sway * .2, .4 * k], [3.6 * k + sway * .2, .4 * k],
    [4.4 * k + sway * .3, 3.4 * k], [-4.4 * k + sway * .3, 3.4 * k]],
    P.cloth, P.ink, .9 * k);
  // 躯干顶面：短梯形 + 密甲片
  poly(ctx, [[-3.2 * k, -7.6 * k], [3.2 * k, -7.6 * k],
    [3.7 * k, .6 * k], [-3.7 * k, .6 * k]], P.iron, P.ink, 1 * k);
  const rows = detail >= 2 ? 5 : detail >= 1 ? 3 : 2;
  for (let i = 0; i < rows; i++) {
    const yy = -6.6 * k + i * (7.2 / rows) * k;
    line(ctx, -3.1 * k, yy, 3.1 * k, yy - .25 * k, A(P.hi, .5), .55 * k);
    if (detail >= 1) for (let j = -2; j <= 2; j++)
      line(ctx, j * 1.3 * k, yy, j * 1.3 * k + .2 * k, yy + 1 * k, A(P.ink, .45), .5 * k);
  }
  // 护心镜：小圆而非大色块，一圈金边
  arc(ctx, 0, -3.6 * k, 1.35 * k, P.gold, .7 * k, 0, Math.PI * 2, A(P.hi, .82));
  arc(ctx, 0, -3.6 * k, .55 * k, null, 0, 0, Math.PI * 2, P.ink);
  // 肩甲：两片带兽首的斜展硬边
  for (const side of [-1, 1]) {
    poly(ctx, [[side * 2.9 * k, -7.4 * k], [side * 6.1 * k, -8.2 * k],
      [side * 6.8 * k, -5.4 * k], [side * 3.4 * k, -4.6 * k]],
      heavy ? P.gold : P.iron, P.ink, .9 * k);
    arc(ctx, side * 5.6 * k, -6.8 * k, .6 * k, P.ink, .5 * k, 0, Math.PI * 2, P.red);
  }
  // 兜鍪顶：菱形 + 盔脊 + 朱缨
  poly(ctx, [[-2.5 * k, -8.2 * k], [0, -11.4 * k], [2.5 * k, -8.2 * k],
    [0, -7.2 * k]], P.ironLo, P.ink, .9 * k);
  line(ctx, 0, -11.4 * k, 0, -7.2 * k, P.hi, .7 * k);
  line(ctx, 0, -11.2 * k, 1.1 * k + flutter, -13.8 * k, P.red, 1.5 * k);
  line(ctx, .8 * k + flutter, -13.4 * k, 2.2 * k + flutter, -14.2 * k, P.red, 1 * k);
  // 盾：斜置可见盾面 + 朱色云纹（断续弧，不贯通）
  const sx = -5.4 * k - armSw, sy = -3 * k;
  poly(ctx, [[sx - 1.9 * k, sy - 3.4 * k], [sx + 1.5 * k, sy - 3.9 * k],
    [sx + 2.2 * k, sy + 2.2 * k], [sx - 1.4 * k, sy + 2.8 * k]], P.wood, P.ink, .9 * k);
  for (let i = 0; i < 3; i++) {
    arc(ctx, sx, sy - 1.6 * k + i * 1.5 * k, 1.5 * k, A(P.red, .62), .6 * k,
      .2 + i * .3, 2.1 + i * .3);
  }
  // 兵器：斜杆 + 戟枝 + 缨
  const wx = 5.2 * k + armSw;
  line(ctx, wx, 2.6 * k, wx + 2.2 * k, -12.6 * k, P.ink, 1.15 * k);
  line(ctx, wx + 2.2 * k, -12.6 * k, wx + 4.4 * k, -11.2 * k, P.hi, .9 * k);
  line(ctx, wx + 1.9 * k, -11 * k, wx + .2 * k, -11.8 * k, P.hi, .8 * k);
  line(ctx, wx + 2.1 * k, -11.8 * k, wx + 3.1 * k, -13.6 * k, P.red, 1.1 * k);
}
function gongbiTiny(ctx, o) {
  const { k, P, seed, dir } = o;
  const sd = Math.round(seed * 100);
  poly(ctx, [[-2.6 * k, 1.5 * k], [2.6 * k, 1.5 * k], [1.9 * k, -2.2 * k], [-1.9 * k, -2.2 * k]],
    P.iron, P.ink, .7 * k);
  poly(ctx, [[-1.7 * k, -2.2 * k], [0, -4.6 * k], [1.7 * k, -2.2 * k]], P.ironLo, P.ink, .6 * k);
  for (const side of [-1, 1])
    poly(ctx, [[side * 1.6 * k, -2 * k], [side * 3.3 * k, -2.6 * k],
      [side * 3.1 * k, -.8 * k]], P.gold, P.ink, .55 * k);
  line(ctx, 2.4 * k * dir, 1 * k, 3.6 * k * dir, -4.6 * k, P.ink, .9 * k);
  line(ctx, 0, -4.4 * k, 1 * k + h1(sd, 1, 3) * .6 * k, -6 * k, P.red, .8 * k);
}

// ────────────────────────────────────────────────────────────────────
// C · 墨影拓片：大块墨剪影 + 飞白断笔 + 一点朱印，几乎不勾线
// ────────────────────────────────────────────────────────────────────
function rubbingBody(ctx, u, o) {
  const { k, P, sway, flutter, seed, engine } = o;
  const sd = Math.round(seed * 100);
  if (engine) {
    blob(ctx, 0, -1 * k, 13 * k, 3.6 * k, 11, sd, P.ink, null, 0);
    flyWhite(ctx, 0, -1 * k, 11 * k, sd, A(P.paper, .38), k);
    line(ctx, 2 * k, -3 * k, 8 * k, -10 * k + flutter, P.ink, 2.4 * k);
    blob(ctx, 8.4 * k, -10.6 * k, 2.1 * k, 1.8 * k, 7, sd + 3, P.ink2, null, 0);
    // 朱印：一小块不规则方章，不是 rect
    poly(ctx, [[-11 * k, 1.4 * k], [-8 * k, 1.1 * k], [-7.8 * k, 3.8 * k], [-10.8 * k, 4 * k]],
      A(P.red, .82), null, 0);
    return;
  }
  // 人形一笔合成：头 + 肩 + 躯干 + 战裙连成一块不规则墨影
  const pts = [
    [-1.9 * k + sway * .2, -10.2 * k], [0, -12.1 * k], [2 * k + sway * .2, -10 * k],
    [5.6 * k, -8.1 * k], [6.4 * k, -5.2 * k], [4.2 * k, -3.4 * k],
    [3.9 * k, 1.2 * k], [4.8 * k, 3.4 * k], [-4.8 * k, 3.4 * k],
    [-3.9 * k, 1.2 * k], [-4.2 * k, -3.4 * k], [-6.4 * k, -5.2 * k],
    [-5.6 * k, -8.1 * k],
  ];
  poly(ctx, pts, P.ink, null, 0);
  flyWhite(ctx, 0, -3 * k, 5.4 * k, sd, A(P.paper, .34), k);
  // 盾：一块偏侧的淡墨影，靠留白读出边界
  blob(ctx, -6.2 * k, -3 * k, 2.4 * k, 3.2 * k, 9, sd + 5, P.ink2, null, 0);
  // 兵器：一道粗墨斜笔，收笔分叉
  line(ctx, 5 * k, 3 * k, 8.4 * k, -12.8 * k + flutter, P.ink, 2 * k);
  line(ctx, 8 * k, -11.4 * k, 10 * k, -12.2 * k, P.ink, 1.1 * k);
  // 朱印
  poly(ctx, [[6.2 * k, 2 * k], [8.4 * k, 1.8 * k], [8.6 * k, 4.1 * k], [6.4 * k, 4.3 * k]],
    A(P.red, .74), null, 0);
}
function rubbingTiny(ctx, o) {
  const { k, P, seed } = o;
  const sd = Math.round(seed * 100);
  blob(ctx, 0, -1 * k, 3.1 * k, 4.6 * k, 9, sd, P.ink, null, 0);
  flyWhite(ctx, 0, -1 * k, 2.6 * k, sd, A(P.paper, .32), k);
}

// ────────────────────────────────────────────────────────────────────
// D · 朱线白描：完全不填色，纯线描；朱色只给盔缨／旗／血条
// ────────────────────────────────────────────────────────────────────
function baimiaoBody(ctx, u, o) {
  const { k, P, sway, armSw, flutter, engine, detail } = o;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const W = 1.15 * k;
  if (engine) {
    line(ctx, -13 * k, 1.4 * k, 12 * k, -1.6 * k, P.ink, W);
    line(ctx, -13 * k, 3.2 * k, 12 * k, .6 * k, P.ink2, .8 * k);
    for (let i = -2; i <= 2; i++)
      line(ctx, i * 4.4 * k, 1.1 * k, i * 4.4 * k + .5 * k, 3 * k, P.ink2, .7 * k);
    arc(ctx, -8 * k, 3 * k, 2.3 * k, P.ink, W, .15, Math.PI * .92);
    arc(ctx, 8 * k, 2.3 * k, 2.3 * k, P.ink, W, .15, Math.PI * .92);
    line(ctx, 3 * k, -1 * k, 8 * k, -10 * k + flutter, P.red, W);
    return;
  }
  // 兜鍪：两笔弧 + 盔脊
  ctx.beginPath();
  ctx.moveTo(-2.7 * k, -8 * k);
  ctx.quadraticCurveTo(0, -12.4 * k, 2.7 * k, -8 * k);
  ctx.strokeStyle = P.ink; ctx.lineWidth = W; ctx.stroke();
  line(ctx, 0, -11.2 * k, 0, -7.6 * k, P.ink2, .7 * k);
  line(ctx, 0, -11.2 * k, 1.2 * k + flutter, -14 * k, P.red, 1.4 * k);
  // 肩线、躯干两笔外轮廓
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 2.6 * k, -7.8 * k);
    ctx.quadraticCurveTo(side * 6.4 * k, -8.4 * k, side * 6.2 * k, -4.9 * k);
    ctx.strokeStyle = P.ink; ctx.lineWidth = W; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(side * 3.1 * k, -7.4 * k);
    ctx.quadraticCurveTo(side * 3.9 * k + sway * .3, -3 * k, side * 4.1 * k, 3.2 * k);
    ctx.strokeStyle = P.ink; ctx.lineWidth = W; ctx.stroke();
  }
  line(ctx, -4.1 * k, 3.2 * k, 4.1 * k, 3.2 * k, P.ink2, .8 * k);
  if (detail >= 1) for (let i = 0; i < 3; i++)
    line(ctx, -2.9 * k, -5.8 * k + i * 2.7 * k, 2.9 * k, -5.8 * k + i * 2.7 * k,
      P.ink2, .6 * k);
  // 盾：一笔不闭合轮廓
  ctx.beginPath();
  ctx.moveTo(-7.6 * k - armSw, -6.2 * k);
  ctx.quadraticCurveTo(-8.4 * k - armSw, -1 * k, -5.4 * k - armSw, -.4 * k);
  ctx.strokeStyle = P.ink; ctx.lineWidth = W; ctx.stroke();
  // 兵器 + 朱缨
  line(ctx, 5.2 * k + armSw, 2.8 * k, 7.6 * k + armSw, -12.4 * k, P.ink, W);
  line(ctx, 7.6 * k, -12.4 * k, 9.8 * k, -11 * k, P.red, 1 * k);
}
function baimiaoTiny(ctx, o) {
  const { k, P, dir } = o;
  ctx.lineCap = 'round';
  line(ctx, 0, -1.8 * k, 0, 1.8 * k, P.ink, 1 * k);
  ctx.beginPath(); ctx.arc(0, -3 * k, 1.2 * k, Math.PI, Math.PI * 2);
  ctx.strokeStyle = P.ink; ctx.lineWidth = 1 * k; ctx.stroke();
  line(ctx, -2.4 * k, -1 * k, 2.4 * k, -1 * k, P.ink, .9 * k);
  line(ctx, 2 * k * dir, 1 * k, 3.2 * k * dir, -4.4 * k, P.red, .9 * k);
}

// ────────────────────────────────────────────────────────────────────
// E · 皮影戏偶：平面分段 + 镂空孔 + 关节铆钉，暖透光色
// ────────────────────────────────────────────────────────────────────
function shadowPart(ctx, pts, fill, hole, seed, k, cx, cy, r = .8 * k) {
  poly(ctx, pts, fill, A('#3a2a1c', .72), .65 * k);
  // 镂空：两三枚不规则小孔
  for (let i = 0; i < 2; i++) {
    const qx = cx + (h1(seed, i, 7) - .5) * 2.4 * k;
    const qy = cy + (h1(seed, i, 13) - .5) * 2.4 * k;
    blob(ctx, qx, qy, r * .55, r * .7, 6, seed + i, hole, null, 0);
  }
}
function shadowBody(ctx, u, o) {
  const { k, P, sway, armSw, flutter, seed, engine } = o;
  const sd = Math.round(seed * 100);
  if (engine) {
    poly(ctx, [[-12 * k, 1 * k], [11 * k, -1.6 * k], [12 * k, 2.2 * k], [-11 * k, 4 * k]],
      A(P.amber, .82), A(P.ink, .7), .7 * k);
    blob(ctx, 0, 1.4 * k, 2 * k, 1.5 * k, 6, sd, P.hole, null, 0);
    for (const side of [-1, 1]) {
      arc(ctx, side * 8 * k, 3 * k, 2.4 * k, P.ink, .7 * k, 0, Math.PI * 2, A(P.green, .78));
      arc(ctx, side * 8 * k, 3 * k, .5 * k, null, 0, 0, Math.PI * 2, P.gold);
    }
    line(ctx, 3 * k, -1 * k, 8 * k, -9 * k + flutter, P.red, 1.3 * k);
    return;
  }
  // 头（带侧脸轮廓）、躯干、两臂、两腿各自一块，关节处铆钉
  poly(ctx, [[-1.9 * k + sway * .2, -10.6 * k], [.6 * k, -11.6 * k],
    [2.4 * k, -9.4 * k], [1.4 * k, -7.2 * k], [-1.6 * k, -7.4 * k]],
    A(P.amber, .9), A(P.ink, .75), .7 * k);
  blob(ctx, .6 * k, -9.5 * k, .5 * k, .5 * k, 5, sd, P.hole, null, 0);
  shadowPart(ctx, [[-2.7 * k, -7.2 * k], [2.7 * k, -7.2 * k],
    [3.1 * k, .4 * k], [-3.1 * k, .4 * k]], A(P.red, .84), P.hole, sd + 2, k, 0, -3.4 * k);
  for (const side of [-1, 1]) {
    shadowPart(ctx, [[side * 2.6 * k, -7 * k], [side * 5.6 * k, -7.8 * k],
      [side * 6.4 * k + armSw, -3.6 * k], [side * 3.2 * k, -3.8 * k]],
      A(P.green, .84), P.hole, sd + (side + 2) * 9, k, side * 4.6 * k, -5.6 * k, .6 * k);
    arc(ctx, side * 3 * k, -6.8 * k, .62 * k, null, 0, 0, Math.PI * 2, P.gold);
    poly(ctx, [[side * .4 * k, .2 * k], [side * 2.9 * k, .2 * k],
      [side * 3.2 * k + sway * .3, 3.4 * k], [side * .6 * k, 3.4 * k]],
      A(P.amber, .86), A(P.ink, .7), .65 * k);
    arc(ctx, side * 1.7 * k, .3 * k, .55 * k, null, 0, 0, Math.PI * 2, P.gold);
  }
  // 盾：带镂空的独立片
  poly(ctx, [[-8 * k - armSw, -5.6 * k], [-5.4 * k - armSw, -5.8 * k],
    [-4.8 * k - armSw, -.6 * k], [-7.6 * k - armSw, -.2 * k]],
    A(P.green, .8), A(P.ink, .7), .65 * k);
  blob(ctx, -6.4 * k - armSw, -3.2 * k, .8 * k, 1.1 * k, 6, sd + 5, P.hole, null, 0);
  // 兵器：皮影长杆 + 朱缨
  line(ctx, 6 * k + armSw, 2.8 * k, 8.4 * k + armSw, -12.6 * k, P.ink, 1.2 * k);
  line(ctx, 8.4 * k, -12.6 * k, 10 * k, -11.2 * k, P.red, 1.2 * k);
  arc(ctx, 6 * k, -4 * k, .6 * k, null, 0, 0, Math.PI * 2, P.gold);
}
function shadowTiny(ctx, o) {
  const { k, P, seed } = o;
  const sd = Math.round(seed * 100);
  poly(ctx, [[-2.2 * k, -2.4 * k], [2.2 * k, -2.4 * k], [2.6 * k, 1.8 * k], [-2.6 * k, 1.8 * k]],
    A(P.red, .86), A(P.ink, .7), .6 * k);
  blob(ctx, 0, -1.4 * k, .7 * k, .8 * k, 6, sd, P.hole, null, 0);
  poly(ctx, [[-1.6 * k, -3.8 * k], [1.6 * k, -3.8 * k], [1.2 * k, -2.4 * k], [-1.2 * k, -2.4 * k]],
    A(P.amber, .9), A(P.ink, .7), .6 * k);
}

// ────────────────────────────────────────────────────────────────────
// F · 夜墨反白：深底上的浅金／纸白笔，线为主、少量淡墨块
// ────────────────────────────────────────────────────────────────────
function nightBody(ctx, u, o) {
  const { k, P, sway, armSw, flutter, seed, engine, detail } = o;
  const sd = Math.round(seed * 100);
  ctx.lineCap = 'round';
  if (engine) {
    poly(ctx, [[-12 * k, 1 * k], [11 * k, -1.4 * k], [12 * k, 2 * k], [-11 * k, 3.6 * k]],
      A(P.dim, .18), A(P.pale, .66), .9 * k);
    for (let i = -2; i <= 2; i++)
      line(ctx, i * 4.2 * k, -1 * k, i * 4.2 * k + .5 * k, 2.8 * k, A(P.pale, .42), .7 * k);
    arc(ctx, -8 * k, 2.8 * k, 2.3 * k, A(P.gold, .7), .9 * k);
    arc(ctx, 8 * k, 2 * k, 2.3 * k, A(P.gold, .7), .9 * k);
    line(ctx, 3 * k, -1 * k, 8 * k, -9.6 * k + flutter, P.gold, 1.2 * k);
    return;
  }
  // 淡墨块交代体积，浅笔勾轮廓
  blob(ctx, 0, -3.4 * k, 3.4 * k, 4.6 * k, 9, sd, A(P.dim, .22), null, 0);
  ctx.beginPath();
  ctx.moveTo(-2.5 * k, -8 * k);
  ctx.quadraticCurveTo(0, -11.8 * k, 2.5 * k, -8 * k);
  ctx.strokeStyle = A(P.pale, .82); ctx.lineWidth = 1.15 * k; ctx.stroke();
  line(ctx, 0, -11.4 * k, 0, -7.6 * k, A(P.gold, .6), .7 * k);
  line(ctx, 0, -11.2 * k, 1.2 * k + flutter, -13.8 * k, P.red, 1.3 * k);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 2.5 * k, -7.8 * k);
    ctx.quadraticCurveTo(side * 6.2 * k, -8.6 * k, side * 6.1 * k, -5 * k);
    ctx.strokeStyle = A(P.pale, .78); ctx.lineWidth = 1.05 * k; ctx.stroke();
    line(ctx, side * 3.1 * k, -7.4 * k, side * 4 * k + sway * .3, 3.2 * k,
      A(P.pale, .6), .9 * k);
  }
  line(ctx, -4 * k, 3.2 * k, 4 * k, 3.2 * k, A(P.gold, .5), .8 * k);
  if (detail >= 1) for (let i = 0; i < 3; i++)
    line(ctx, -2.8 * k, -5.6 * k + i * 2.6 * k, 2.8 * k, -5.6 * k + i * 2.6 * k,
      A(P.pale, .38), .6 * k);
  ctx.beginPath();
  ctx.moveTo(-7.4 * k - armSw, -6 * k);
  ctx.quadraticCurveTo(-8.2 * k - armSw, -1 * k, -5.2 * k - armSw, -.4 * k);
  ctx.strokeStyle = A(P.gold, .66); ctx.lineWidth = 1 * k; ctx.stroke();
  line(ctx, 5.2 * k + armSw, 2.8 * k, 7.6 * k + armSw, -12.4 * k, A(P.pale, .8), 1.1 * k);
  line(ctx, 7.6 * k, -12.4 * k, 9.6 * k, -11 * k, P.red, 1 * k);
}
function nightTiny(ctx, o) {
  const { k, P, dir } = o;
  ctx.lineCap = 'round';
  line(ctx, 0, -1.8 * k, 0, 1.8 * k, A(P.pale, .8), 1.1 * k);
  ctx.beginPath(); ctx.arc(0, -3 * k, 1.2 * k, Math.PI, Math.PI * 2);
  ctx.strokeStyle = A(P.gold, .8); ctx.lineWidth = 1 * k; ctx.stroke();
  line(ctx, -2.4 * k, -1 * k, 2.4 * k, -1 * k, A(P.pale, .7), .9 * k);
  line(ctx, 2 * k * dir, 1 * k, 3.2 * k * dir, -4.4 * k, P.red, .9 * k);
}

// ── 五档画家表 ──────────────────────────────────────────────────────
const PAINTERS = {
  gongbi:  { pal: PAL.gongbi,  body: gongbiBody,  tiny: gongbiTiny },
  rubbing: { pal: PAL.rubbing, body: rubbingBody, tiny: rubbingTiny },
  baimiao: { pal: PAL.baimiao, body: baimiaoBody, tiny: baimiaoTiny },
  shadow:  { pal: PAL.shadow,  body: shadowBody,  tiny: shadowTiny },
  night:   { pal: PAL.night,   body: nightBody,   tiny: nightTiny },
};

/** 重绘士兵主入口：公共骨架 + 按档分派主体。返回 true 表示已画。 */
export function drawRedrawnSoldier(ctx, u, o, id) {
  const Pm = PAINTERS[id];
  if (!Pm) return false;
  const { x, y, s, sec, walk, dir, phase, amp, seed, col } = o;
  const k = s / 17;
  const detail = s >= 18 ? 2 : s >= 11 ? 1 : 0;
  const P = Pm.pal;
  const engine = u.type === 'chuangnu' || u.type === 'paoshi';
  const tilt = (seed / 6.2831853 - .5) * (engine ? .18 : .34);
  const jolt = walk ? Math.sin(phase * 1.8) * .35 * k * amp : 0;
  const bob = !engine ? Math.sin(sec * 1.3 + seed) * .12 * k : 0;
  const sway = !engine && walk ? Math.sin(phase) * 1.15 * k * amp : 0;
  const armSw = !engine && walk ? Math.sin(phase + .8) * .6 * k * amp : 0;
  const flutter = walk ? Math.sin(phase * .7 + seed) * .5 * k * amp
                       : Math.sin(sec * .9 + seed) * .16 * k;
  const light = id === 'night';

  // 地面投影：深底档用浅墨晕，浅底档用墨影
  ctx.save();
  ctx.fillStyle = light ? 'rgba(0,0,0,.46)' : 'rgba(0,0,0,.34)';
  ctx.beginPath();
  ctx.ellipse(x, y + (engine ? 2.4 : 1.8) * k,
    (engine ? 12 : 5.4) * k, (engine ? 3.4 : 2.4) * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(x, y + bob + jolt);
  ctx.scale(dir, 1);
  ctx.rotate(engine ? tilt : -.30 + tilt);
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  const q = { k, detail, P, col, sway, armSw, flutter, seed, sec, engine, dir, amp, phase, walk };

  if (s < 13) Pm.tiny(ctx, q);
  else Pm.body(ctx, u, q);
  ctx.restore();

  // 血条 / 选中环：语义与基线一致（满血不画、champion 菱形）
  const hp = has((u.hp ?? 1) / (u.maxHp || 1));
  const bw = (engine ? 20 : 12) * k, bh = Math.max(1, 1.4 * k), by = y - 13 * k;
  if (hp < .999 || o.selected || o.champion) {
    ctx.fillStyle = light ? 'rgba(220,214,190,.24)' : 'rgba(10,14,12,.3)';
    ctx.fillRect(x - bw / 2, by, bw, bh);
    ctx.fillStyle = hp > .5 ? (light ? '#d0b070' : 'rgba(82,110,96,.6)')
      : (light ? '#d0705a' : 'rgba(146,78,54,.85)');
    ctx.fillRect(x - bw / 2, by, bw * hp, bh);
  }
  if (o.selected || o.champion) {
    const pulse = .88 + Math.sin(sec * 3.2 + seed) * .12;
    ctx.strokeStyle = o.champion ? 'rgba(200,168,106,.9)' : (light ? 'rgba(216,210,187,.8)' : 'rgba(178,202,194,.75)');
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(x, y + (engine ? 2.4 : 1.8) * k,
      (engine ? 12.5 : 6.2) * k * pulse, (engine ? 3.8 : 2.9) * k * pulse,
      0, 0, Math.PI * 2);
    ctx.stroke();
    if (o.champion) poly(ctx, [[x, y - 16 * k], [x + 2.6 * k, y - 13.5 * k],
      [x, y - 11 * k], [x - 2.6 * k, y - 13.5 * k]], 'rgba(200,168,106,.95)', null);
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// 将领重绘：五档各一套构图，不是同一半身像换色。
// 关键：helm / weapon / cape / capeCut / beard / bannerShape / plume 这些由
// 姓名 + 五维派生的特征**必须真正改变形状**，否则四名将领画出来还是一个图章。
function generalCommon(ctx, look, x, y, s, opts, id) {
  const { hpK = 1, flash = 0, skill = null } = opts;
  const k = s / 30;
  const P = PAL[id] || PAL.baimiao;
  const L = (dx, dy) => [x + dx * k, y + dy * k];
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  return { k, P, L, hpK, flash, skill, sd: look.h % 997, x, y, look };
}
function generalFinish(ctx, C) {
  const { k, hpK, skill, x, y } = C;
  if (skill) {
    ctx.strokeStyle = skill; ctx.lineWidth = 1.2 * k;
    for (let i = 0; i < 9; i++) {
      if ((C.sd + i * 7) % 4 === 0) continue;
      const a = i / 9 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 9 * k, y - 12 * k + Math.sin(a) * 9 * k);
      ctx.lineTo(x + Math.cos(a) * 11.5 * k, y - 12 * k + Math.sin(a) * 11.5 * k);
      ctx.stroke();
    }
  }
  const bw = 13 * k;
  ctx.fillStyle = 'rgba(10,14,12,.68)'; ctx.fillRect(x - bw / 2, y + 1.4 * k, bw, 2.2 * k);
  ctx.fillStyle = hpK > .5 ? '#c8a86a' : hpK > .22 ? '#c07a3e' : '#a63129';
  ctx.fillRect(x - bw / 2, y + 1.4 * k, bw * hpK, 2.2 * k);
  ctx.restore();
}
function bannerPath(ctx, C, color, stroke, lw) {
  const { L, look } = C;
  ctx.strokeStyle = stroke; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(...L(-5.4, -2)); ctx.lineTo(...L(-6.2, -27)); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(...L(-6.2, -27)); ctx.lineTo(...L(-1.2, -26.4));
  if (look.bannerShape === 1) { ctx.lineTo(...L(-2.4, -22.6)); ctx.lineTo(...L(-1.2, -20.4)); }
  else if (look.bannerShape === 2) ctx.lineTo(...L(-3.7, -20.8));
  else ctx.lineTo(...L(-1.2, -20.4));
  ctx.lineTo(...L(-6.2, -21)); ctx.closePath(); ctx.fill();
}
// 折线（不闭合）：各档用不同颜色／线宽调用，形制由 look 决定
function pl(ctx, pts, col, w) {
  if (!pts?.length) return;
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(...pts[0]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
  ctx.stroke();
}
function helmPts(C) {
  const { L, look } = C;
  if (look.helm === 2)   // 儒冠：方中带斜
    return [L(-3.2, -22.6), L(-2.6, -26.6), L(2.9, -26.2), L(2.7, -22.6), L(2.7, -20.8), L(-2.9, -20.8)];
  if (look.helm === 0)   // 兜鍪：尖顶 / 平顶两型
    return look.helmVar
      ? [L(-3.4, -22.4), L(-1.2, -26.6), L(1.2, -28.4), L(3.3, -22.4), L(2.7, -20.4), L(-2.9, -20.4)]
      : [L(-3.4, -22.4), L(-.8, -26.8), L(1.6, -27.2), L(3.3, -22.4), L(2.7, -20.4), L(-2.9, -20.4)];
  return [L(-2.9, -22.4), L(-.6, -26.2), L(1.2, -26.6), L(2.9, -22.4), L(2.6, -20.8), L(-2.6, -20.8)]; // 束发低髻
}
function capePts(C) {
  const { L, look } = C;
  if (!look.cape) return null;
  const sw = 7.2 + (look.h % 4) * .5;
  const base = [L(-3.6, -17.6), L(-sw, -8), L(-sw * .8, -1)];
  if (look.capeCut === 1) base.push(L(sw * .5, -3.6));
  else if (look.capeCut === 2) base.push(L(-1, -4.4), L(1.4, -1.6), L(3.4, -4));
  else base.push(L(sw * .8, -1));
  base.push(L(sw, -8), L(3.6, -17.6));
  return base;
}
function robePts(C) {
  const { L, look } = C, sh = 5.2 + (look.h % 5) * .28;
  return [L(-sh, -2), L(-sh - 1.1, -12), L(-3.4, -16.5), L(3.4, -16.5),
    L(sh + 1.1, -12), L(sh, -2)];
}
function facePts(C) {
  const { L, look } = C;
  // 眉形 / 面痕 / 须 都由 look 派生，不只是换袍色
  return { browY: look.brow === 0 ? -21.2 : look.brow === 1 ? -21.6 : -20.9,
    beard: !!look.beard, scar: !!look.scar };
}
/** 兵器四型：长戟/槊、剑、羽扇、弓；weaponVar 决定戟枝或素杆。 */
function weaponStrokes(C, main, accent, W) {
  const { L, look } = C;
  if (look.weapon === 0) {
    main([L(5.6, -2), L(7.4, -29)], W);
    main([L(7.4, -29), L(9.4, -26.4)], W * .8);
    if (!look.weaponVar) main([L(6.2, -25), L(9.6, -24.2)], W * .8);
    else main([L(7.2, -28.4), L(8.4, -30.6)], W * .8);
    accent([L(7.4, -28.8), L(8.4, -31)], W * .9);
  } else if (look.weapon === 1) {
    main([L(5.2, -6), L(8.8, -21)], W);
    main([L(3.6, -7.4), L(7.2, -5.4)], W);
    accent([L(8.4, -20), L(9.4, -22)], W * .8);
  } else if (look.weapon === 2) {
    main([L(5.2, -8), L(6.6, -15)], W);
    for (let i = -2; i <= 2; i++) main([L(6.6, -15), L(6.6 + i * 1.8, -20.6)], W * .6);
    accent([L(5.6, -8.6), L(4.8, -10)], W * .8);
  } else {
    main([L(6.4, -5), L(10.2, -14), L(6.4, -23)], W);
    main([L(6.4, -5), L(6.4, -23)], W * .7);
    accent([L(10, -13), L(11.2, -14)], W * .7);
  }
}
function plumeStrokes(C, col, W) {
  const { L, look } = C;
  for (let i = 0; i < (look.plume || 0); i++) {
    const off = (i - (look.plume - 1) / 2) * 1.5;
    pl(ctx0, [L(off, -26.2), L(off + 1.2, -29.4), L(off + 2.5, -30.4)], col, W);
  }
}
// plumeStrokes 用闭包注入 ctx，避免每档重复
let ctx0 = null;

function generalGongbi(ctx, C) {
  const { k, P, L, sd, flash, look } = C;
  const cape = capePts(C);
  if (cape) poly(ctx, cape, A('#4a6b58', .55), A(P.ink, .5), .7 * k);
  poly(ctx, robePts(C), `rgba(${look.robe.join(',')},.94)`,
    flash > 0 ? A('#f3e7d2', Math.min(.9, flash)) : A(P.ink, .78), .9 * k);
  // 札甲：甲片行数由统率派生，肩宽也随 look 变
  const rows = 4 + (look.command % 3);
  poly(ctx, [L(-3.4, -16.6), L(3.4, -16.6), L(4.2, -6.4), L(-4.2, -6.4)],
    P.iron, A(P.ink, .8), .8 * k);
  for (let i = 0; i < rows; i++) {
    const yy = -15.4 + i * (9 / rows);
    line(ctx, ...L(-3.4, yy), ...L(3.4, yy), A(P.hi, .48), .5 * k);
    for (let j = -2; j <= 2; j++) line(ctx, ...L(j * 1.4, yy), ...L(j * 1.4, yy + .9), A(P.ink, .4), .45 * k);
  }
  arc(ctx, ...L(0, -11), 1.5 * k, P.gold, .7 * k, 0, Math.PI * 2, A(P.hi, .8));
  poly(ctx, [L(-2.6, -17.4), L(-3.1, -22.4), L(-.4, -23.8), L(2.6, -22.8),
    L(2.4, -18.2), L(-.4, -16.8)], 'rgba(214,190,158,.96)', A(P.ink, .6), .55 * k);
  const F = facePts(C);
  line(ctx, ...L(-2.1, F.browY), ...L(-.2, F.browY - (look.brow === 1 ? .9 : 0)), A(P.ink, .85), .8 * k);
  if (F.scar) line(ctx, ...L(1.4, -21.8), ...L(2.2, -19.4), A('#964a3a', .7), .5 * k);
  if (F.beard) {
    ctx.beginPath(); ctx.moveTo(...L(-1.4, -18.4));
    ctx.quadraticCurveTo(...L(0, -14.8), ...L(1.6, -18.6));
    ctx.strokeStyle = A(P.ink, .8); ctx.lineWidth = 1.1 * k; ctx.stroke();
  }
  poly(ctx, helmPts(C), P.ironLo, A(P.gold, .7), .7 * k);
  ctx0 = ctx; plumeStrokes(C, P.red, 1.2 * k);
  weaponStrokes(C, (pts, w) => pl(ctx, pts, A(P.hi, .9), w),
    (pts, w) => pl(ctx, pts, P.red, w), 1.1 * k);
  bannerPath(ctx, C, look.banner, A(P.ink, .85), .8 * k);
  poly(ctx, [L(3.2, -3.4), L(5.4, -3.2), L(5.6, -1), L(3.4, -1.2)], A(P.red, .78), null, 0);
}
function generalRubbing(ctx, C) {
  const { k, P, L, sd, look } = C;
  // 侧面拓片：剪影外轮廓随披风与冠形变化，飞白剥蚀，朱印题名
  const cape = capePts(C);
  const pts = cape ? cape.map(q => [q[0], q[1] - 1 * k])
    : [L(-5.2, -1), L(-4.4, -14), L(-3.2, -18.4)];
  pts.push(L(-1.2, -26.8), L(2.4, -25.6), L(3.4, -21.4), L(6.2, -18.6),
    L(6.8, -13), L(5.4, -2), L(7.4, -1), L(-6.4, -1));
  poly(ctx, pts, P.ink, null, 0);
  flyWhite(ctx, ...L(0, -11), 5.6 * k, sd, A(P.paper, .32), k);
  ctx.beginPath(); ctx.moveTo(...L(-.6, -24));
  ctx.quadraticCurveTo(...L(2.8, -22.6), ...L(1.4, -19.2));
  ctx.strokeStyle = A(P.paper, .7); ctx.lineWidth = 1.1 * k; ctx.stroke();
  // 冠／兵器都按 look 给不同轮廓：羽扇是散锋，弓是一段弧，长兵是一根粗杆
  const hp = helmPts(C);
  poly(ctx, hp.map(q => [q[0], q[1] - .4 * k]), P.ink2, null, 0);
  weaponStrokes(C, (ps, w) => pl(ctx, ps, P.ink, w * 1.9),
    (ps, w) => pl(ctx, ps, A(P.red, .8), w), 1.1 * k);
  poly(ctx, [L(-7.6, -4.2), L(-4.8, -4), L(-4.6, -1.6), L(-7.4, -1.8)], A(P.red, .84), null, 0);
  line(ctx, ...L(-6.9, -3.4), ...L(-5.4, -3.3), A(P.paper, .7), .6 * k);
  bannerPath(ctx, C, look.banner, A(P.ink, .9), .9 * k);
}
function generalBaimiao(ctx, C) {
  const { k, P, L, flash, look } = C;
  const W = 1.1 * k, ink = flash > 0 ? A(P.red, Math.min(.9, flash + .2)) : P.ink;
  ctx.lineCap = 'round';
  const cape = capePts(C);
  if (cape) pl(ctx, cape, A(P.ink2, .5), .7 * k);
  pl(ctx, robePts(C), ink, W);
  line(ctx, ...L(0, -16.6), ...L(0, -2.6), A(P.ink2, .55), .7 * k);
  ctx.beginPath(); ctx.moveTo(...L(-2.6, -17.2));
  ctx.quadraticCurveTo(...L(-3.2, -22.4), ...L(-.4, -23.6));
  ctx.quadraticCurveTo(...L(2.9, -23.2), ...L(2.5, -18.4));
  ctx.strokeStyle = ink; ctx.lineWidth = W; ctx.stroke();
  const F = facePts(C);
  line(ctx, ...L(-2.1, F.browY), ...L(-.2, F.browY - (look.brow === 1 ? .9 : 0)), ink, .8 * k);
  if (F.scar) line(ctx, ...L(1.4, -21.8), ...L(2.2, -19.4), A('#964a3a', .7), .5 * k);
  if (F.beard) {
    ctx.beginPath(); ctx.moveTo(...L(-1.4, -18.2));
    ctx.quadraticCurveTo(...L(0, -15), ...L(1.4, -18.6));
    ctx.strokeStyle = ink; ctx.lineWidth = .9 * k; ctx.stroke();
  }
  pl(ctx, helmPts(C), ink, W);
  ctx0 = ctx; plumeStrokes(C, P.red, 1.2 * k);
  weaponStrokes(C, (ps, w) => pl(ctx, ps, ink, w),
    (ps, w) => pl(ctx, ps, P.red, w), W);
  bannerPath(ctx, C, look.banner, ink, .8 * k);
}
function generalShadow(ctx, C) {
  const { k, P, L, sd, look } = C;
  const hole = P.hole;
  const seg = (pts, fill, cx, cy, seed) => {
    poly(ctx, pts.map(p => L(...p)), fill, A(P.ink, .72), .65 * k);
    blob(ctx, ...L(cx, cy), .7 * k, .9 * k, 6, seed, hole, null, 0);
  };
  const cape = capePts(C);
  if (cape) poly(ctx, cape, A('#4a6b58', .5), A(P.ink, .6), .6 * k);
  seg([[-4.6, -1], [4.6, -1], [3.8, -13], [-3.8, -13]], A('#c98a3e', .86), 0, -7, sd);
  seg([[-3, -13], [3, -13], [2.6, -18.4], [-2.6, -18.4]], A(look.banner, .84), 0, -15.6, sd + 2);
  poly(ctx, [L(-2.2, -18.6), L(-2.6, -23.4), L(.8, -24.6), L(3, -22),
    L(2.2, -18.4)], A(P.amber, .9), A(P.ink, .72), .65 * k);
  blob(ctx, ...L(1, -21.6), .45 * k, .45 * k, 5, sd + 4, hole, null, 0);
  for (const px of [-3.6, 3.6]) for (const py of [-13, -18])
    arc(ctx, ...L(px, py), .6 * k, null, 0, 0, Math.PI * 2, P.gold);
  seg([[3.2, -17.4], [6.4, -16.2], [7.2, -9], [4, -10]], A('#4a6b58', .84), 5.4, -13, sd + 7);
  // 冠按 look 换形制，兵器按 look 换四型
  poly(ctx, helmPts(C).map(q => [q[0], q[1] - .2 * k]), A(P.gold, .9), A(P.ink, .7), .6 * k);
  weaponStrokes(C, (ps, w) => pl(ctx, ps, P.ink, w),
    (ps, w) => pl(ctx, ps, P.red, w), 1.2 * k);
  bannerPath(ctx, C, look.banner, A(P.ink, .8), .8 * k);
}
function generalNight(ctx, C) {
  const { k, P, L, flash, look } = C;
  const pale = flash > 0 ? A('#f0e6cc', Math.min(.95, flash + .3)) : A(P.pale, .82);
  ctx.lineCap = 'round';
  blob(ctx, ...L(0, -9), 5.6 * k, 9 * k, 9, C.sd, A(P.dim, .16), null, 0);
  const cape = capePts(C);
  if (cape) pl(ctx, cape, A(P.gold, .36), .8 * k);
  pl(ctx, robePts(C), pale, 1.15 * k);
  ctx.beginPath(); ctx.moveTo(...L(-2.6, -17.2));
  ctx.quadraticCurveTo(...L(-3.2, -22.4), ...L(-.4, -23.6));
  ctx.quadraticCurveTo(...L(2.9, -23.2), ...L(2.5, -18.4));
  ctx.strokeStyle = pale; ctx.lineWidth = 1.1 * k; ctx.stroke();
  const F = facePts(C);
  line(ctx, ...L(-2.1, F.browY), ...L(-.2, F.browY - (look.brow === 1 ? .9 : 0)), A(P.gold, .9), .8 * k);
  if (F.beard) {
    ctx.beginPath(); ctx.moveTo(...L(-1.4, -18.2));
    ctx.quadraticCurveTo(...L(0, -15), ...L(1.4, -18.6));
    ctx.strokeStyle = A(P.pale, .7); ctx.lineWidth = .9 * k; ctx.stroke();
  }
  pl(ctx, helmPts(C), A(P.gold, .85), 1.1 * k);
  ctx0 = ctx; plumeStrokes(C, P.red, 1.2 * k);
  weaponStrokes(C, (ps, w) => pl(ctx, ps, A(P.pale, .8), w),
    (ps, w) => pl(ctx, ps, P.red, w), 1.1 * k);
  bannerPath(ctx, C, look.banner, A(P.gold, .8), .85 * k);
}
const GENERALS = {
  gongbi: generalGongbi, rubbing: generalRubbing, baimiao: generalBaimiao,
  shadow: generalShadow, night: generalNight,
};

/** 重绘将领主入口。返回 true 表示已画。 */
export function drawRedrawnGeneral(ctx, look, x, y, s, opts, id) {
  const fn = GENERALS[id];
  if (!fn) return false;
  const C = generalCommon(ctx, look, x, y, s, opts, id);
  ctx.beginPath();
  ctx.moveTo(...C.L(-7, 0));
  ctx.quadraticCurveTo(...C.L(0, 1.8), ...C.L(7.4, -.4));
  ctx.strokeStyle = id === 'night' ? 'rgba(216,210,187,.28)' : 'rgba(18,24,20,.34)';
  ctx.lineWidth = 1.6 * C.k; ctx.stroke();
  fn(ctx, C);
  generalFinish(ctx, C);
  return true;
}

/** 主地图驻军／行军队列的程序化简笔：按档给一笔不同的人形。 */
export function drawRedrawnTrooper(ctx, x, y, s, heading, phase, col, id) {
  const P = PAL[id];
  if (!P) return false;
  const sway = Math.sin(phase * 2.1) * s * .06;
  const hx = Math.cos(heading) * s * .5, hy = Math.sin(heading) * s * .32;
  ctx.save(); ctx.translate(x, y); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (id === 'rubbing') {
    blob(ctx, sway, -s * .4, s * .3, s * .5, 9, 3, P.ink, null, 0);
    line(ctx, sway, -s * .1, sway + hx, -s * .1 + hy, P.ink, Math.max(1, s * .14));
  } else if (id === 'shadow') {
    poly(ctx, [[sway - s * .22, -s * .6], [sway + s * .22, -s * .6],
      [sway + s * .26, -s * .08], [sway - s * .26, -s * .08]], A(P.red, .86), A(P.ink, .7), 1);
    blob(ctx, sway, -s * .78, s * .18, s * .18, 6, 7, A(P.amber, .9), null, 0);
    line(ctx, sway + s * .2, -s * .3, sway + s * .2 + hx, -s * .3 + hy, P.ink, Math.max(1, s * .12));
  } else if (id === 'night') {
    ctx.strokeStyle = A(P.pale, .82); ctx.lineWidth = Math.max(1, s * .13);
    ctx.beginPath(); ctx.moveTo(0, -s * .1); ctx.lineTo(sway, -s * .64); ctx.stroke();
    ctx.beginPath(); ctx.arc(sway, -s * .76, s * .13, Math.PI, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sway, -s * .42); ctx.lineTo(sway + hx, -s * .42 + hy); ctx.stroke();
  } else if (id === 'gongbi') {
    // 兜鍪三角 + 肩甲 + 短躯干 + 朱缨 + 盾片，读成「一个人」而不是一根斜笔
    poly(ctx, [[sway - s * .2, -s * .58], [sway, -s * .88], [sway + s * .2, -s * .58]],
      P.ironLo, P.ink, 1);
    poly(ctx, [[sway - s * .26, -s * .56], [sway + s * .26, -s * .56],
      [sway + s * .22, -s * .1], [sway - s * .22, -s * .1]], P.iron, P.ink, 1);
    for (const side of [-1, 1])
      poly(ctx, [[sway + side * s * .2, -s * .56], [sway + side * s * .38, -s * .6],
        [sway + side * s * .34, -s * .38]], P.gold, P.ink, 1);
    line(ctx, sway - s * .16, -s * .3, sway + s * .16, -s * .3, P.hi, Math.max(1, s * .07));
    poly(ctx, [[sway - s * .42, -s * .52], [sway - s * .24, -s * .54],
      [sway - s * .22, -s * .12], [sway - s * .4, -s * .1]], P.wood, P.ink, 1);
    line(ctx, sway + s * .22, -s * .12, sway + s * .22 + hx, -s * .52 + hy,
      P.ink, Math.max(1, s * .11));
    line(ctx, sway, -s * .88, sway + s * .12, -s * 1.06, P.red, Math.max(1, s * .09));
  } else { // baimiao
    ctx.strokeStyle = P.ink; ctx.lineWidth = Math.max(1, s * .12);
    ctx.beginPath(); ctx.moveTo(0, -s * .1); ctx.lineTo(sway, -s * .62); ctx.stroke();
    ctx.beginPath(); ctx.arc(sway, -s * .76, s * .14, Math.PI, Math.PI * 2); ctx.stroke();
    line(ctx, sway - s * .24, -s * .48, sway + s * .24, -s * .48, P.ink, Math.max(1, s * .1));
    line(ctx, sway, -s * .46, sway + hx, -s * .46 + hy, P.red, Math.max(1, s * .1));
    for (const side of [-1, 1])
      line(ctx, sway, -s * .12, sway + side * s * .18, s * .2, P.ink, Math.max(1, s * .09));
  }
  ctx.restore();
  return true;
}

export const REDRAW_IDS = Object.keys(PAINTERS);
