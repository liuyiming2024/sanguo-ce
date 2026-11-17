// 士兵 / 军械立绘 v0.7.4 —— 斜俯视。
//
// 用户点破的透视错位：小地图是俯视战场，之前画的却是**正面/正侧面站立的
// 全身立绘**，像证件照贴在地上。这轮按 AI 生成的俯视造型参考板重画：
//   · 俯角约 58°，不是西式 30° 等距棋盘；用中国界画「顶面 + 侧面 + 地面投影」
//     三层表达高度：顶面亮、侧面暗、脚下椭圆投影。近大远小很弱，散点式。
//   · 人形：看见的是兜鍪顶（菱形 + 盔脊）、两侧斜展的肩甲、被压缩成短梯形的
//     躯干、斜置可见盾面的矩形木盾；**脸完全不可见**（俯视看不到），没有眼缝、
//     没有肤色、没有五官。兵器是地面平面里的一道斜线 + 一截抬起的柄。
//   · 器械：床弩 / 抛石机是俯视木架（斜向长梁、榫卯横销、扁椭圆轮、V 形弩臂、
//     配重箱顶面、吊索石弹），不是正面侧视图；操作兵只是极小的俯视菱形比例尺。
//   · 「适量度」：俯视本来就看不到正面甲片，细节按 s 三档收敛 —— 桌面 3 道
//     甲片横弧、手机 1 道，扬尘只在真正行军时 2 点，满血不画血条。
//   · 「不像中国的」：色板从冷灰铁改墨青（花青）+ 赭石木 + 墨线，木构件画
//     榫卯短销，硬边平涂、无发光无渐变，取汉画像石拓片 / 界画舆图的语汇。
//
// 仍是纯绘制层：无 DOM、无 state、无墙钟、无随机源、无位图（参考图只定造型）。
// 相位只取 sec（模拟时间）+ id 派生种子，同 sec 逐像素一致；暂停冻结；
// 隔月快进直接吸附终点。

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// 墨青 / 赭石 / 素铁。浅绢底与深墨底两套，主体一律压暗。
const PAL_ON_PAPER = {
  iron: '#243438', ironLo: '#141e20', ironHi: '#8ea6a0',
  lamella: '#2e4244', lamellaEdge: '#66817c',
  wood: '#6d5637', woodLo: '#443322', woodHi: '#9c855e',
  cloth: '#23302f', cord: '#4a4335',
  edge: '#c2d2cc', ink: '#101a1c',
};
const PAL_ON_INK = {
  iron: '#1a292c', ironLo: '#0b1416', ironHi: '#aec4bb',
  lamella: '#31484a', lamellaEdge: '#7c968e',
  wood: '#7a6244', woodLo: '#4a3a28', woodHi: '#ae9870',
  cloth: '#1a2526', cord: '#5b5340',
  edge: '#d0ded6', ink: '#070e10',
};
export const SOLDIER_PAL = PAL_ON_PAPER;

/** 俯视投影参数：地面纵深压缩、高度抬升。约 58° 俯角，比等距更陡。 */
export const VIEW = { cos: 0.53, sin: 0.85 };

/** 由 id 派生的确定性种子：同 id 永远同一姿态偏移，不写进任何状态。 */
export function idSeed(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * 6.2831853;
}
function h32(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 器械类主体是军械，不是人形。渲染层据此决定动画语义。 */
export function unitKind(type) {
  return (type === 'chuangnu' || type === 'paoshi') ? 'engine' : 'figure';
}

// ── 硬边路径工具 ────────────────────────────────────────────────────────
function poly(ctx, pts, fill, stroke, lw = 1) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function line(ctx, x1, y1, x2, y2, color, lw) {
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
/** 冷边光：只勾顶面的一条棱，不发光、不渐变。 */
function rim(ctx, pts, color, lw = 0.7) {
  ctx.strokeStyle = rgba(color, 0.55); ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}
/** 俯视里的「厚度」：顶面下缘补一道暗侧面，把高度交代清楚。 */
function lip(ctx, pts, depth, fill) {
  const base = pts.slice(-2);   // 取末端两点作下缘
  poly(ctx, [base[0], base[1],
    [base[1][0], base[1][1] + depth], [base[0][0], base[0][1] + depth]],
    fill, null);
}
/** 扁椭圆轮：俯视下圆变成椭圆，辐条随行军在椭圆内旋转。 */
function wheelTop(ctx, P, cx, cy, rx, ry, rot, detail) {
  ctx.fillStyle = P.woodLo;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = P.ink; ctx.lineWidth = Math.max(0.6, rx * 0.18);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = rgba(P.woodHi, 0.8); ctx.lineWidth = Math.max(0.5, rx * 0.12);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.86, ry * 0.86, 0, 0, Math.PI * 2); ctx.stroke();
  if (detail >= 1) {
    for (let i = 0; i < 4; i++) {
      const a = rot + i * Math.PI / 2;
      line(ctx, cx, cy, cx + Math.cos(a) * rx * 0.78, cy + Math.sin(a) * ry * 0.78,
        rgba(P.woodHi, 0.6), Math.max(0.45, rx * 0.1));
    }
  }
  ctx.fillStyle = P.iron;
  ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.6, rx * 0.16), 0, Math.PI * 2); ctx.fill();
}
/** 榫卯短销：木梁交接处一道横墨线，界画木构的语汇。 */
function tenon(ctx, P, x, y, w, k) {
  line(ctx, x - w / 2, y, x + w / 2, y, rgba(P.ink, 0.8), Math.max(0.5, 0.7 * k));
}

/**
 * @param o {x,y,s,sec,walk,dir,phase,amp,seed,col,def,selected,champion,lightGround}
 *   x/y 是该单位在地面上的立足点（画布 CSS 像素）。
 */
export function drawSoldier(ctx, u, o) {
  const { x, y, s, sec, walk, dir, phase, amp, seed, col } = o;
  // 俯视后单位全高约 13k（立像时是 26k）。定标必须按压缩后的 13k 归一，
  // 否则 s=10.4 的手机单位只有 5px 高，再极简也读不出来（v0.7.4 初版的坑）。
  const k = s / 17;
  const detail = s >= 18 ? 2 : s >= 11 ? 1 : 0;
  const P = o.lightGround ? PAL_ON_PAPER : PAL_ON_INK;
  const type = u.type;
  const engine = unitKind(type) === 'engine';
  // 每队略有偏角（id 派生、静态、确定性）：军阵不该是复制粘贴的正对图标。
  // 只改朝向不动 x/y，命中判定与逻辑格位完全不受影响。
  const tilt = (seed / 6.2831853 - 0.5) * (engine ? 0.18 : 0.34);

  // ── 手机档（s < 13）：10px 下多层甲片必然糊成一团。改画一枚高对比的
  //    俯视墨剪影：兜鍪顶 + 两肩 + 短躯干 + 一根兵器 / 斜梁与两轮。
  //    这是「适量度」的落地：不是把大图缩小，是按尺度换一套更少的笔画。
  if (s < 13) {
    drawTiny(ctx, u, { x, y, k, P, col, engine, walk, phase, amp, sec, seed, dir, tilt,
      selected: o.selected, champion: o.champion,
      hp: Math.max(0, Math.min(1, (u.hp ?? 1) / (u.maxHp || 1))) });
    return;
  }

  // ── 姿态：俯视下人形是「左右晃 + 前后颠」，器械是「轮转 + 颠簸」 ──────
  const jolt = walk ? Math.sin(phase * 1.8) * 0.35 * k * amp : 0;
  const bob = !engine ? Math.sin(sec * 1.3 + seed) * 0.12 * k : 0;
  const sway = !engine && walk ? Math.sin(phase) * 1.15 * k * amp : 0;  // 不再摆腿
  const armSw = !engine && walk ? Math.sin(phase + 0.8) * 0.6 * k * amp : 0;
  const wheelRot = engine && walk ? phase * 0.62 : 0;
  const armSwing = engine && walk ? Math.sin(phase * 0.5) * 0.05 * amp : 0;
  const flutter = walk ? Math.sin(phase * 0.7 + seed) * 0.5 * k * amp
                       : Math.sin(sec * 0.9 + seed) * 0.16 * k;

  // 地面投影：俯视下宽而扁
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  ctx.beginPath();
  ctx.ellipse(x, y + (engine ? 2.4 : 1.8) * k,
    (engine ? 12 : 5.4) * k, (engine ? 3.4 : 2.4) * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 扬尘：只在真的行军时 2 点（「适量度」），不铺一片
  if (walk && amp > 0.3) {
    ctx.save();
    for (let i = 0; i < 2; i++) {
      const t = ((phase * 0.16 + i * 0.5 + h32(i, Math.round(seed * 100), 7)) % 1 + 1) % 1;
      const dx = -(3 + t * (engine ? 8 : 5)) * k;
      ctx.fillStyle = rgba(P.ironHi, (1 - t) * 0.18 * amp);
      ctx.beginPath();
      ctx.arc(x + dir * dx, y + (2 - t * 1.4) * k, (0.5 + t * 0.7) * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.translate(x, y + bob + jolt);
  ctx.scale(dir, 1);
  // 斜俯视的动势：中国界画 / 画像石里的人不是正对画幅的印章，
  // 统一带一条约 -17° 的斜轴，头顶偏左上、脚下偏右下。
  ctx.rotate(engine ? tilt : -0.30 + tilt);
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';

  if (engine) {
    if (type === 'chuangnu') drawBedCrossbow(ctx, P, { k, detail, col, wheelRot, armSwing, flutter });
    else drawTrebuchet(ctx, P, { k, detail, col, wheelRot, armSwing, flutter });
  } else {
    drawFigure(ctx, P, u, { k, detail, col, sway, armSw, flutter, sec, seed });
    drawWeapon(ctx, P, u, { k, detail, col, armSw, flutter });
  }
  ctx.restore();

  // ── 血条 / 选中环：满血不画，不抢画面 ────────────────────────────────
  const hp = Math.max(0, Math.min(1, (u.hp ?? 1) / (u.maxHp || 1)));
  if (hp < 0.999 || o.selected || o.champion) {
    const bw = (engine ? 20 : 12) * k, bh = Math.max(1, 1.4 * k);
    const by = y - 11 * k;
    ctx.fillStyle = 'rgba(10,14,12,.3)'; ctx.fillRect(x - bw / 2, by, bw, bh);
    ctx.fillStyle = hp > 0.5 ? 'rgba(82,110,96,.6)' : 'rgba(146,78,54,.85)';
    ctx.fillRect(x - bw / 2, by, bw * hp, bh);
  }
  if (o.selected || o.champion) {
    const pulse = 0.88 + Math.sin(sec * 3.2 + seed) * 0.12;
    ctx.strokeStyle = o.champion ? 'rgba(200,168,106,.9)' : 'rgba(178,202,194,.75)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(x, y + (engine ? 2.4 : 1.8) * k,
      (engine ? 12.5 : 6.2) * k * pulse, (engine ? 3.8 : 2.9) * k * pulse,
      0, 0, Math.PI * 2);
    ctx.stroke();
    if (o.champion) {
      poly(ctx, [[x, y - 15 * k], [x + 2.6, y - 12.5 * k],
        [x, y - 10 * k], [x - 2.6, y - 12.5 * k]], 'rgba(200,168,106,.95)', null);
    }
  }
}

// ── 人形：从上方看，兜鍪顶 + 两片肩甲 + 短梯形躯干 ─────────────────────
function drawFigure(ctx, P, u, { k, detail, col, sway, armSw, flutter }) {
  const heavy = u.type === 'zhongjia';
  // 俯视压缩：躯干顶面只占 6k 高，头顶再往上 4k；整体高度 ≈ 13k（立像时 26k）
  const topY = -8.3 * k;

  // 1. 战裙 / 下摆：地面平面里的扁梯形，露在躯干下方一点
  poly(ctx, [
    [-3.4 * k + sway * 0.25, 0.4 * k], [3.4 * k + sway * 0.25, 0.4 * k],
    [4.2 * k + sway * 0.3, 3.2 * k], [-4.2 * k + sway * 0.3, 3.2 * k],
  ], P.ironLo, P.ink, 0.9 * k);
  if (detail >= 1) {
    line(ctx, -3.6 * k, 2.2 * k, 3.6 * k, 2.2 * k, rgba(P.lamellaEdge, 0.4), 0.5 * k);
  }
  // 靴尖：俯视只露两个小尖
  for (const side of [-1, 1]) {
    poly(ctx, [[side * 2.3 * k, 2.6 * k], [side * 3.6 * k, 2.6 * k],
      [side * 4 * k, 4 * k], [side * 2.6 * k, 4 * k]], P.ink, null);
  }

  // 2. 躯干顶面：短梯形，札甲横弧（俯视下是弧不是直线）
  const body = [
    [-3.1 * k + sway, -5.6 * k], [3.1 * k + sway, -5.6 * k],
    [2.5 * k + sway * 0.6, 0.8 * k], [-2.5 * k + sway * 0.6, 0.8 * k],
  ];
  poly(ctx, body, P.lamella, P.ink, 1.1 * k);
  rim(ctx, [body[0], body[1]], P.edge, 0.65 * k);
  if (detail >= 1) {
    const rows = detail >= 2 ? 3 : 1;
    ctx.strokeStyle = rgba(P.lamellaEdge, 0.45); ctx.lineWidth = 0.55 * k;
    for (let r = 0; r < rows; r++) {
      const yy = (-4.2 + r * 1.8) * k;
      ctx.beginPath();
      ctx.moveTo(-2.9 * k + sway, yy);
      ctx.quadraticCurveTo(sway, yy + 0.7 * k, 2.9 * k + sway, yy);
      ctx.stroke();
    }
  }
  // 素铁护心镜：俯视里是躯干中央一小块方铁
  poly(ctx, [[-1.2 * k + sway, -3.2 * k], [1.2 * k + sway, -3.2 * k],
    [1.2 * k + sway, -1.6 * k], [-1.2 * k + sway, -1.6 * k]],
    P.iron, rgba(P.ironHi, 0.4), 0.55 * k);
  // 阵营色：躯干一道极窄横纹
  ctx.fillStyle = rgba(col, 0.55);
  ctx.fillRect(-1.6 * k + sway, -0.4 * k, 3.2 * k, 0.6 * k);
  if (detail >= 1) {
    line(ctx, 1.8 * k + sway, 0.6 * k, 2 * k + flutter * 0.2, 3 * k,
      rgba(col, 0.45), 0.6 * k);
  }

  // 3. 肩甲：两片斜展的平行四边形 —— 俯视里最像「人」的特征
  for (const side of [-1, 1]) {
    const sx = side * 3 * k + sway;
    poly(ctx, [
      [sx, -6.2 * k], [sx + side * 2.9 * k, -7.2 * k],
      [sx + side * 3.3 * k, -4.6 * k], [sx + side * 0.3 * k, -3.9 * k],
    ], P.iron, P.ink, 0.9 * k);
    if (detail >= 2) {
      line(ctx, sx + side * 0.5 * k, -5.8 * k, sx + side * 2.8 * k, -6.6 * k,
        rgba(P.ironHi, 0.45), 0.5 * k);
    }
  }
  if (heavy && detail >= 1) {
    for (const side of [-1, 1]) {
      line(ctx, side * 3.4 * k + sway, -7 * k, side * 6.2 * k + sway, -7.7 * k,
        rgba(P.ironHi, 0.4), 0.7 * k);
    }
  }

  // 4. 兜鍪顶：俯视的绝对主体，菱形 + 盔脊；顿项在后缘，脸完全不见
  const helm = [
    [-3 * k + sway, topY + 1.4 * k], [-1.7 * k + sway, topY - 1.2 * k],
    [1.7 * k + sway, topY - 1.2 * k], [3 * k + sway, topY + 1.4 * k],
    [0, topY + 2.6 * k],
  ];
  poly(ctx, helm, P.iron, P.ink, 1.1 * k);
  rim(ctx, [helm[1], helm[2], helm[3]], P.edge, 0.7 * k);
  // 盔脊（中线）+ 阵营色一道细线
  line(ctx, 0 + sway, topY - 1.2 * k, 0 + sway, topY + 2.4 * k,
    rgba(P.ironHi, 0.55), 0.7 * k);
  line(ctx, -1.5 * k + sway, topY + 0.2 * k, 1.5 * k + sway, topY + 0.2 * k,
    rgba(col, 0.6), 0.7 * k);
  // 顿项：兜鍪后缘两片，护住颈后；下方是阴影，不是脸
  poly(ctx, [[-3 * k + sway, topY + 1.4 * k], [-3.5 * k + sway, topY + 3.4 * k],
    [-1.2 * k + sway, topY + 3.6 * k], [-1 * k + sway, topY + 2.4 * k]],
    P.lamella, P.ink, 0.7 * k);
  poly(ctx, [[3 * k + sway, topY + 1.4 * k], [3.5 * k + sway, topY + 3.4 * k],
    [1.2 * k + sway, topY + 3.6 * k], [1 * k + sway, topY + 2.4 * k]],
    P.lamella, P.ink, 0.7 * k);
  // 盔檐下一道暗影：俯视看不到五官，只留这道投影
  poly(ctx, [[-2.1 * k + sway, topY + 2.5 * k], [2.1 * k + sway, topY + 2.5 * k],
    [1.6 * k + sway, topY + 4 * k], [-1.6 * k + sway, topY + 4 * k]],
    P.ironLo, null);
  // 军师：纶巾顶改方巾，仍不露脸
  if (u.type === 'junshi') {
    poly(ctx, [[-2.8 * k + sway, topY - 1.6 * k], [2.8 * k + sway, topY - 1.6 * k],
      [2.6 * k + sway, topY + 1.8 * k], [-2.6 * k + sway, topY + 1.8 * k]],
      P.cloth, P.ink, 0.9 * k);
    line(ctx, -2.8 * k + sway, topY + 0.2 * k, 2.8 * k + sway, topY + 0.2 * k,
      rgba(P.woodHi, 0.5), 0.6 * k);
    if (detail >= 1) {
      for (const side of [-1, 1]) {
        line(ctx, side * 2.6 * k + sway, topY + 0.8 * k,
          side * 4 * k + flutter * 0.25, topY + 3.2 * k, rgba(P.cloth, 0.9), 0.8 * k);
      }
    }
  }
}

// ── 兵器：地面平面内的一道斜线 + 斜置盾面 ───────────────────────────────
function drawWeapon(ctx, P, u, { k, detail, col, armSw, flutter }) {
  const type = u.type;
  if (type === 'junshi') {
    // 令旗：旗杆是地面斜线，旗面是俯视里的一小片斜 parallelogram
    line(ctx, 3.4 * k, 0.6 * k, 10.4 * k, -3.2 * k, P.woodHi, 1.1 * k);
    poly(ctx, [[10.4 * k, -3.2 * k], [13.2 * k + flutter * 0.2, -5.2 * k],
      [11.8 * k, -1.4 * k]], P.iron, rgba(col, 0.65), 0.6 * k);
    return;
  }
  if (type === 'changqiang') {
    // 长枪：地面上的长斜线，枪尖一小块冷铁，红缨压到极短
    line(ctx, 3.6 * k, 2.2 * k, 13.6 * k + armSw * 0.2, -6.4 * k, P.wood, 1.3 * k);
    poly(ctx, [[13.6 * k + armSw * 0.2, -6.4 * k], [15.2 * k + armSw * 0.2, -8.4 * k],
      [12.4 * k + armSw * 0.2, -7.6 * k]], P.iron, rgba(P.ironHi, 0.55), 0.6 * k);
    line(ctx, 13.4 * k, -6.2 * k, 12.4 * k, -4.6 * k, rgba(col, 0.5), 0.8 * k);
    return;
  }
  if (type === 'gongnu') {
    // 横弩：身前一道横向长条，弩臂在地面平面内向前张成浅 V
    poly(ctx, [[-4 * k, -1.4 * k], [10 * k, -1.4 * k],
      [10 * k, -0.2 * k], [-4 * k, -0.2 * k]], P.woodHi, P.ink, 0.7 * k);
    poly(ctx, [[10 * k, -1.4 * k], [13 * k, -4.4 * k],
      [12.2 * k, -5.2 * k], [9.4 * k, -1.2 * k]], P.lamella, P.ink, 0.6 * k);
    poly(ctx, [[10 * k, -0.2 * k], [13 * k, 2.8 * k],
      [12.2 * k, 3.6 * k], [9.4 * k, 0 * k]], P.lamella, P.ink, 0.6 * k);
    line(ctx, 13 * k, -5 * k, 2 * k, -0.8 * k, rgba(P.ironHi, 0.5), 0.55 * k);
    line(ctx, 13 * k, 3.2 * k, 2 * k, -0.8 * k, rgba(P.ironHi, 0.5), 0.55 * k);
    ctx.fillStyle = rgba(col, 0.45); ctx.fillRect(1 * k, -1.1 * k, 6 * k, 0.5 * k);
    return;
  }
  // 矩形木盾：斜置，看得见盾面（俯视）与一条厚度侧面
  const shield = (x, w, h1, h2) => {
    const L = x * k, R = (x + w) * k;
    poly(ctx, [[L, h1 * k], [R, h1 * k - 1.4 * k],
      [R + 0.6 * k, h2 * k - 1.4 * k], [L + 0.6 * k, h2 * k]],
      P.wood, P.ink, 1 * k);
    lip(ctx, [[L + 0.6 * k, h2 * k], [R + 0.6 * k, h2 * k - 1.4 * k]], 0.8 * k, P.woodLo);
    if (detail >= 1) {
      for (let i = 1; i < 4; i++) {
        const t = i / 4;
        line(ctx, L + (R - L) * t, h1 * k - 1.4 * k * t,
          L + (R - L) * t + 0.4 * k, h2 * k - 1.4 * k * t,
          rgba(P.woodLo, 0.7), 0.5 * k);
      }
    }
    line(ctx, R, h1 * k - 1.4 * k, R + 0.6 * k, h2 * k - 1.4 * k,
      rgba(col, 0.5), 0.9 * k);
    rim(ctx, [[L, h1 * k], [R, h1 * k - 1.4 * k]], P.edge, 0.55 * k);
  };
  if (type === 'zhongjia') {
    shield(-9.4, 4.2, -3.4, 6.4);
    // 短槌：地面一截木柄 + 方锤头
    line(ctx, 3.8 * k, 0.8 * k, 9.4 * k + armSw * 0.2, -2 * k, P.woodLo, 1.7 * k);
    poly(ctx, [[9 * k + armSw * 0.2, -3.4 * k], [12.4 * k + armSw * 0.2, -3.4 * k],
      [12.4 * k + armSw * 0.2, -0.2 * k], [9 * k + armSw * 0.2, -0.2 * k]],
      P.lamella, P.ink, 0.7 * k);
    return;
  }
  shield(-9, 3.8, -2.8, 5.8);
  // 环首直刀：地面长斜线，刃一道冷光
  line(ctx, 3.6 * k, 1.6 * k, 12.8 * k + armSw * 0.2, -5.2 * k, P.woodLo, 1.1 * k);
  line(ctx, 6.4 * k, 0.4 * k, 14.2 * k + armSw * 0.2, -7 * k, P.ironHi, 1.3 * k);
  line(ctx, 6.4 * k, 0.4 * k, 14.2 * k + armSw * 0.2, -7 * k, P.ink, 0.45 * k);
  if (detail >= 2) {
    ctx.strokeStyle = rgba(P.woodHi, 0.7); ctx.lineWidth = 0.6 * k;
    ctx.beginPath(); ctx.arc(3.6 * k, 1.6 * k, 0.9 * k, 0, Math.PI * 2); ctx.stroke();
  }
}

// ── 军械一：床弩（斜向长梁 + 扁椭圆轮 + V 形弩臂 + 绞盘顶面） ───────────
function drawBedCrossbow(ctx, P, { k, detail, col, wheelRot, armSwing, flutter }) {
  // 底座：俯视里是一根斜向长梁（纵深压缩），带厚度侧面
  const beam = [
    [-11 * k, 3.2 * k], [8 * k, -3.2 * k],
    [8 * k, -1.2 * k], [-11 * k, 5.2 * k],
  ];
  poly(ctx, beam, P.wood, P.ink, 1 * k);
  lip(ctx, [beam[2], beam[3]], 0.9 * k, P.woodLo);
  rim(ctx, [beam[0], beam[1]], P.edge, 0.6 * k);
  // 横梁（榫卯交接）
  for (const t of [-0.55, 0.1, 0.7]) {
    const bx = -11 * k + 19 * k * t, by = 3.2 * k - 6.4 * k * t;
    line(ctx, bx, by - 2.2 * k, bx + 3.4 * k, by + 2.2 * k, P.woodHi, 1.4 * k);
    tenon(ctx, P, bx + 1.7 * k, by, 2.4 * k, k);
  }
  // 四个扁椭圆轮（俯视）
  for (const [wx, wy] of [[-8.4, 4.4], [6.6, -2.6], [-8.4, 6.2], [6.6, -0.8]]) {
    wheelTop(ctx, P, wx * k, wy * k, 2.2 * k, 1.15 * k, wheelRot, detail);
  }
  // 绞盘：尾部一个椭圆木筒 + 十字轴
  ctx.fillStyle = P.woodLo;
  ctx.beginPath(); ctx.ellipse(-10.2 * k, 1.4 * k, 2.8 * k, 1.7 * k, -0.35, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = P.ink; ctx.lineWidth = 0.8 * k; ctx.stroke();
  if (detail >= 1) {
    line(ctx, -12.6 * k, 0.6 * k, -7.8 * k, 2.2 * k, rgba(P.woodHi, 0.8), 0.8 * k);
    line(ctx, -10.2 * k, -0.2 * k, -10.2 * k, 3 * k, rgba(P.woodHi, 0.6), 0.6 * k);
  }
  // 双弩臂：在地面平面内向前张成 V（俯视，不上扬）
  for (const side of [-1, 1]) {
    const ex = 13.4 * k, ey = side * 5.4 * k + armSwing * 12 * k;
    poly(ctx, [
      [7.2 * k, -2.8 * k + side * 0.6 * k], [ex, ey],
      [ex - 1.4 * k, ey + side * 0.9 * k], [7.2 * k, -1.4 * k + side * 0.6 * k],
    ], P.lamella, P.ink, 0.7 * k);
  }
  // 弦：两臂端点到中央箭槽的浅 V
  line(ctx, 13.4 * k, -5.4 * k, 1.4 * k, -2.2 * k, rgba(P.ironHi, 0.5), 0.6 * k);
  line(ctx, 13.4 * k, 5.4 * k, 1.4 * k, -2.2 * k, rgba(P.ironHi, 0.5), 0.6 * k);
  // 长矢沿中轴
  line(ctx, -6 * k, 1.8 * k, 13.8 * k, -2.6 * k, P.ironHi, 0.9 * k);
  poly(ctx, [[13.8 * k, -2.6 * k], [12 * k, -3.6 * k], [12 * k, -1.5 * k]],
    P.iron, P.ink, 0.5 * k);
  ctx.fillStyle = rgba(col, 0.4);
  ctx.fillRect(-4 * k, 0.6 * k, 10 * k, 0.5 * k);
  if (detail >= 1) {
    line(ctx, -10.6 * k, 3.6 * k, -12 * k - flutter * 0.2, 6 * k, rgba(P.cord, 0.75), 0.55 * k);
  }
  // 操作兵：俯视里只有兜鍪顶菱形 + 两肩，极小
  drawCrewTop(ctx, P, -12.2 * k, 7.2 * k, 0.85);
}

// ── 军械二：抛石机（A 架俯视投影 + 斜臂 + 配重箱顶面 + 吊索石弹） ───────
function drawTrebuchet(ctx, P, { k, detail, col, wheelRot, armSwing, flutter }) {
  // 底座双梁（俯视斜向）
  for (const off of [-1.5, 1.5]) {
    poly(ctx, [
      [-9.6 * k, 3.4 * k + off * k], [8.4 * k, -2 * k + off * k],
      [8.4 * k, -0.6 * k + off * k], [-9.6 * k, 4.8 * k + off * k],
    ], off < 0 ? P.wood : P.woodLo, P.ink, 0.85 * k);
  }
  ctx.fillStyle = rgba(col, 0.35);
  ctx.fillRect(-8 * k, 4.6 * k, 15 * k, 0.5 * k);
  // 两个扁椭圆轮
  for (const [wx, wy] of [[-7.6, 5.4], [7, -1.6], [-7.6, 7], [7, 0]]) {
    wheelTop(ctx, P, wx * k, wy * k, 2 * k, 1.05 * k, wheelRot, detail);
  }
  // A 架俯视投影：两根斜柱从底座两角交于支点（斜上方看到的是「人字」）
  const pivot = [0.6 * k, -4.2 * k];
  line(ctx, -7.4 * k, 4 * k, pivot[0], pivot[1], P.wood, 2.1 * k);
  line(ctx, 7.4 * k, 1.4 * k, pivot[0], pivot[1], P.wood, 2.1 * k);
  line(ctx, -3.4 * k, 0 * k, 4.4 * k, -1.8 * k, P.woodLo, 1.3 * k);
  tenon(ctx, P, pivot[0], pivot[1], 2.2 * k, k);
  ctx.fillStyle = P.iron;
  ctx.beginPath(); ctx.arc(pivot[0], pivot[1], 1.3 * k, 0, Math.PI * 2); ctx.fill();
  // 斜臂：地平面内从配重端（左后）到吊索端（右前），行军微摆
  const a = armSwing;
  const b0 = [-9.4 * k, -7.2 * k - a * 18 * k];
  const b1 = [10.2 * k, 5.4 * k + a * 18 * k];
  line(ctx, b0[0], b0[1], b1[0], b1[1], P.woodHi, 2 * k);
  line(ctx, b0[0], b0[1], b1[0], b1[1], rgba(P.ink, 0.6), 0.5 * k);
  // 配重箱顶面（俯视矩形，带厚度侧面）
  poly(ctx, [[b0[0] - 2.6 * k, b0[1] - 1.6 * k], [b0[0] + 2.2 * k, b0[1] - 2.4 * k],
    [b0[0] + 2.8 * k, b0[1] + 1.2 * k], [b0[0] - 2 * k, b0[1] + 2 * k]],
    P.woodLo, P.ink, 0.85 * k);
  if (detail >= 1) {
    line(ctx, b0[0] - 2.2 * k, b0[1] - 0.4 * k, b0[0] + 2.4 * k, b0[1] - 0.8 * k,
      rgba(P.woodHi, 0.55), 0.5 * k);
  }
  // 吊索 + 石弹（地面一小块，带冷边光）
  const sx = b1[0] + 1.2 * k, sy = b1[1] + 1.2 * k;
  line(ctx, b1[0], b1[1], sx + flutter * 0.2, sy + 3 * k, rgba(P.cord, 0.85), 0.6 * k);
  const stone = [
    [sx - 1.8 * k, sy + 2.6 * k], [sx + 1.5 * k, sy + 2.2 * k],
    [sx + 2 * k, sy + 4.6 * k], [sx - 1.2 * k, sy + 5 * k],
  ];
  poly(ctx, stone, P.lamella, P.ink, 0.7 * k);
  rim(ctx, [stone[0], stone[1]], P.edge, 0.55 * k);
  drawCrewTop(ctx, P, -10.8 * k, 7.4 * k, 0.85);
}

/** 操作兵俯视：只见兜鍪顶菱形 + 两片肩，无脸无肤色，纯作比例尺。 */
function drawCrewTop(ctx, P, x, y, scale) {
  const k = scale;
  poly(ctx, [[x - 1.1 * k, y], [x, y - 1.5 * k], [x + 1.1 * k, y],
    [x, y + 1.2 * k]], P.iron, P.ink, 0.45);
  poly(ctx, [[x - 2.1 * k, y - 0.2 * k], [x - 1 * k, y - 0.6 * k],
    [x - 0.9 * k, y + 0.8 * k], [x - 2 * k, y + 0.6 * k]], P.lamella, P.ink, 0.35);
  poly(ctx, [[x + 2.1 * k, y - 0.2 * k], [x + 1 * k, y - 0.6 * k],
    [x + 0.9 * k, y + 0.8 * k], [x + 2 * k, y + 0.6 * k]], P.lamella, P.ink, 0.35);
  line(ctx, x, y + 1.2 * k, x, y + 2.6 * k, P.ironLo, 0.9 * k);
}


// ── 手机 tiny 档：按尺度换一套更少的笔画 ───────────────────────────────
function drawTiny(ctx, u, { x, y, k, P, col, engine, walk, phase, amp, sec, seed, dir, tilt,
  selected, champion, hp }) {
  // 地面投影
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1.8 * k, (engine ? 9 : 4.6) * k, 2.1 * k, 0, 0, Math.PI * 2);
  ctx.fill();

  const sway = !engine && walk ? Math.sin(phase) * 0.8 * k * amp : 0;
  const rot = engine && walk ? phase * 0.6 : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  if (!engine) ctx.rotate(-0.3 + tilt);
  else ctx.rotate(tilt);

  if (engine) {
    // 斜梁 + 两个扁椭圆轮 + 一根斜臂 / 弩臂，不画榫卯辐条与操作兵
    poly(ctx, [[-8 * k, 2.4 * k], [7 * k, -2.4 * k],
      [7 * k, -1.2 * k], [-8 * k, 3.6 * k]], P.wood, P.ink, 0.9 * k);
    for (const [wx, wy] of [[-6.2, 3.6], [5.6, -1.8]]) {
      ctx.fillStyle = P.woodLo;
      ctx.beginPath(); ctx.ellipse(wx * k, wy * k, 1.9 * k, 0.95 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = P.ink; ctx.lineWidth = 0.7 * k; ctx.stroke();
      if (walk) {
        line(ctx, wx * k, wy * k,
          wx * k + Math.cos(rot) * 1.4 * k, wy * k + Math.sin(rot) * 0.7 * k,
          rgba(P.woodHi, 0.7), 0.5 * k);
      }
    }
    if (u.type === 'paoshi') {
      line(ctx, -1 * k, -3.4 * k, 9 * k, 3.6 * k, P.woodHi, 1.4 * k);
      poly(ctx, [[-3.4 * k, -4.4 * k], [-0.4 * k, -5 * k],
        [0 * k, -2.4 * k], [-3 * k, -1.8 * k]], P.woodLo, P.ink, 0.6 * k);
    } else {
      poly(ctx, [[6 * k, -2.2 * k], [11 * k, -5 * k],
        [10 * k, -3.8 * k], [6 * k, -1 * k]], P.lamella, P.ink, 0.6 * k);
      poly(ctx, [[6 * k, -1.2 * k], [11 * k, 1.8 * k],
        [10 * k, 3 * k], [6 * k, 0 * k]], P.lamella, P.ink, 0.6 * k);
      line(ctx, -3 * k, 1.2 * k, 11.4 * k, -1.6 * k, P.ironHi, 0.8 * k);
    }
  } else {
    // 战裙下缘
    poly(ctx, [[-3 * k + sway, 0.4 * k], [3 * k + sway, 0.4 * k],
      [3.6 * k, 2.8 * k], [-3.6 * k, 2.8 * k]], P.ironLo, null);
    // 躯干：一块实心短梯形
    poly(ctx, [[-2.8 * k + sway, -5.4 * k], [2.8 * k + sway, -5.4 * k],
      [2.2 * k + sway, 0.6 * k], [-2.2 * k + sway, 0.6 * k]],
      P.lamella, P.ink, 0.9 * k);
    // 两片肩甲
    for (const side of [-1, 1]) {
      const sx = side * 2.8 * k + sway;
      poly(ctx, [[sx, -5.6 * k], [sx + side * 2.1 * k, -6.2 * k],
        [sx + side * 2.3 * k, -4.2 * k], [sx, -3.8 * k]], P.iron, P.ink, 0.7 * k);
    }
    // 兜鍪顶：俯视最显眼的菱形，带一道盔脊与阵营色
    poly(ctx, [[-2.6 * k + sway, -7 * k], [-1.4 * k + sway, -9 * k],
      [1.4 * k + sway, -9 * k], [2.6 * k + sway, -7 * k], [0, -5.8 * k]],
      P.iron, P.ink, 0.8 * k);
    line(ctx, 0 + sway, -9 * k, 0 + sway, -6 * k, rgba(P.ironHi, 0.5), 0.5 * k);
    line(ctx, -1.2 * k + sway, -7.6 * k, 1.2 * k + sway, -7.6 * k,
      rgba(col, 0.7), 0.6 * k);
    // 一根兵器：按兵种换长度与末端
    const L = u.type === 'changqiang' ? 11 : u.type === 'gongnu' ? 8 : 8.4;
    line(ctx, 2.8 * k, 0.6 * k, L * k, -5.2 * k, P.ironHi, 1 * k);
    if (u.type === 'daodun' || u.type === 'zhongjia') {
      poly(ctx, [[-7.4 * k, -2 * k], [-4 * k, -2.8 * k],
        [-3.4 * k, 4.6 * k], [-6.8 * k, 5.4 * k]], P.wood, P.ink, 0.7 * k);
    }
    if (u.type === 'junshi') {
      poly(ctx, [[L * k, -5.2 * k], [L * k + 2 * k, -7 * k],
        [L * k + 1 * k, -3.2 * k]], P.iron, rgba(col, 0.6), 0.5 * k);
    }
  }
  ctx.restore();

  if (hp < 0.999 || selected || champion) {
    const bw = (engine ? 16 : 10) * k, bh = Math.max(1, 1.3 * k);
    ctx.fillStyle = 'rgba(10,14,12,.35)'; ctx.fillRect(x - bw / 2, y - 10 * k, bw, bh);
    ctx.fillStyle = hp > 0.5 ? 'rgba(82,110,96,.65)' : 'rgba(146,78,54,.9)';
    ctx.fillRect(x - bw / 2, y - 10 * k, bw * hp, bh);
  }
  if (selected || champion) {
    ctx.strokeStyle = champion ? 'rgba(200,168,106,.9)' : 'rgba(178,202,194,.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y + 1.8 * k, (engine ? 10 : 5.6) * k, 2.8 * k, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}
