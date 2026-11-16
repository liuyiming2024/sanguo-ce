// 士兵 / 军械立绘（v0.7.3）——按 AI 生成的造型参考板转写成程序化路径。
//
// 参考板给的硬规矩，逐条落成 canvas 路径（不是把位图贴进游戏）：
//  1. 器械为主体：床弩、抛石机画成带轮木架的大型军械，占满单位画面；
//     旁边只留一个约 1/4 高的墨甲操作兵作比例尺。不再是「人举着小弩/小石头」。
//  2. 人不露脸：兜鍪压到眉、顿项护颊、面甲遮脸，只留一道极细冷光眼缝；
//     全程无肤色、无眼鼻嘴、无圆脑袋 —— 呆萌的来源一次性拔掉。
//  3. 比例拉长：七头身，窄肩收腰长腿，不再是 5 头身的短粗小人。
//  4. 札甲细密横向叠压、素铁护心镜、战裙至膝、胫甲黑靴、矩形木盾、环首直刀。
//  5. 冷铁灰 + 赭褐木 + 墨黑三层，暗部占七成，只有轮廓一道冷光；
//     阵营色缩到盾边 / 胸纹 / 弩身一道细线，绝不亮金正红。
//  6. 器械不摆腿：轮转 + 颠簸 + 斜臂微摆，人形摆腿幅度也收小，不蹦跳。
//
// 仍是纯绘制层：无 DOM、无 state、无墙钟、无随机源。相位只取 sec（模拟时间）
// + id 派生种子，同 sec 逐像素一致；暂停冻结；隔月快进直接吸附终点。

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// 浅绢底 / 深墨底两套设色。主体一律很暗，亮色只用于甲片边缘的冷光。
const PAL_ON_PAPER = {
  iron: '#222b26', ironLo: '#151c18', ironHi: '#93a596',
  lamella: '#2c3831', lamellaEdge: '#57685c',
  wood: '#6b5638', woodLo: '#463726', woodHi: '#a08a64',
  cloth: '#242e28', cord: '#4a4335',
  edge: '#c9d6c6', ink: '#111814',
};
const PAL_ON_INK = {
  iron: '#1c2520', ironLo: '#0d1310', ironHi: '#b6c4b3',
  lamella: '#314036', lamellaEdge: '#6c8073',
  wood: '#7a6244', woodLo: '#4a3a28', woodHi: '#b09a70',
  cloth: '#1a231e', cord: '#5b5340',
  edge: '#d7e2d2', ink: '#080c0a',
};
export const SOLDIER_PAL = PAL_ON_PAPER;

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

// ── 小工具：硬边多边形 / 墨线 / 冷边光 ──────────────────────────────────
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
/** 轮廓右侧一道冷白光：参考图里「暗部占七成，边缘一道冷光」的落地。 */
function rim(ctx, pts, color, lw = 0.7) {
  ctx.strokeStyle = rgba(color, 0.5); ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/**
 * @param o {x,y,s,sec,walk,dir,phase,amp,seed,col,def,selected,champion,lightGround}
 */
export function drawSoldier(ctx, u, o) {
  const { x, y, s, sec, walk, dir, phase, amp, seed, col } = o;
  const k = s / 26;                       // s = 单位全高；人形 26k 高、约 8k 宽（细长）
  const detail = s >= 18 ? 2 : s >= 11 ? 1 : 0;
  const P = o.lightGround ? PAL_ON_PAPER : PAL_ON_INK;
  const type = u.type;
  const engine = unitKind(type) === 'engine';

  // ── 姿态：器械不摆腿 ──────────────────────────────────────────────────
  const jolt = engine && walk ? Math.sin(phase * 1.8) * 0.55 * k * amp : 0;
  const bob = !engine && walk ? -Math.abs(Math.sin(phase)) * 0.55 * k * amp
                            : Math.sin(sec * 1.3 + seed) * 0.18 * k;
  const lean = !engine && walk ? 0.045 * amp : 0;
  const legSw = !engine && walk ? Math.sin(phase) * 1.5 * k * amp : 0;
  const armSw = !engine && walk ? -Math.sin(phase) * 1.0 * k * amp : 0;
  const wheel = engine && walk ? phase * 0.62 : 0;
  const armSwing = engine && walk ? Math.sin(phase * 0.5) * 0.045 * amp : 0;
  const flutter = walk ? Math.sin(phase * 0.7 + seed) * 0.9 * k * amp
                       : Math.sin(sec * 0.9 + seed) * 0.25 * k;

  // 地面投影：器械宽而扁，人形窄
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  ctx.ellipse(x, y + (engine ? 11.5 : 12.8) * k,
    (engine ? 10.5 : 4.3) * k, (engine ? 1.9 : 1.5) * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 扬尘：轮后 / 脚下，位置由 id + 步序确定性给出
  if (walk && amp > 0.12) {
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const t = ((phase * 0.16 + i * 0.37 + h32(i, Math.round(seed * 100), 7)) % 1 + 1) % 1;
      const dx = -(2 + t * (engine ? 9 : 6)) * k;
      const dy = (11 - t * 2.6) * k;
      ctx.fillStyle = rgba(P.ironHi, (1 - t) * 0.22 * amp);
      ctx.beginPath();
      ctx.arc(x + dir * dx, y + dy, (0.6 + t * 0.9) * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.translate(x, y + bob + jolt);
  if (!engine) ctx.rotate(lean);
  ctx.scale(dir, 1);
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';   // 硬边，不用圆头圆角

  if (engine) {
    if (type === 'chuangnu') drawBedCrossbow(ctx, P, { k, detail, col, wheel, armSwing, flutter });
    else drawTrebuchet(ctx, P, { k, detail, col, wheel, armSwing, flutter });
  } else {
    drawFigure(ctx, P, u, { k, detail, col, legSw, armSw, flutter, sec, seed });
    drawWeapon(ctx, P, u, { k, detail, col, armSw, flutter, sec });
  }
  ctx.restore();

  // ── 血条 / 选中环：不随镜像翻转，压暗压细 ────────────────────────────
  const hp = Math.max(0, Math.min(1, (u.hp ?? 1) / (u.maxHp || 1)));
  // 满血不画血条：参考板里没有一条亮绿 UI，默认画面越干净越肃杀；
  // 只有真掉血（或被选中）才浮出一道暗线。
  if (hp < 0.999 || o.selected || o.champion) {
    const bw = (engine ? 20 : 13) * k, bh = Math.max(1, 1.5 * k);
    const by = y - 17.5 * k;
    ctx.fillStyle = 'rgba(10,14,12,.32)'; ctx.fillRect(x - bw / 2, by, bw, bh);
    ctx.fillStyle = hp > 0.5 ? 'rgba(88,112,90,.62)' : 'rgba(146,78,54,.85)';
    ctx.fillRect(x - bw / 2, by, bw * hp, bh);
  }
  if (o.selected || o.champion) {
    const pulse = 0.88 + Math.sin(sec * 3.2 + seed) * 0.12;
    ctx.strokeStyle = o.champion ? 'rgba(200,168,106,.95)' : 'rgba(190,206,186,.8)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(x, y + (engine ? 11.5 : 12.8) * k,
      (engine ? 11 : 6) * k * pulse, (engine ? 3.4 : 2.6) * k * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (o.champion) {
      poly(ctx, [[x, y - 23 * k], [x + 3, y - 20 * k], [x, y - 17 * k], [x - 3, y - 20 * k]],
        'rgba(200,168,106,.95)', null);
    }
  }
}

// ── 人形基座：遮面黑甲步卒，七头身、窄肩长腿 ────────────────────────────
function drawFigure(ctx, P, u, { k, detail, col, legSw, armSw, flutter, sec, seed }) {
  const heavy = u.type === 'zhongjia';

  // 1. 双腿（直线胫甲，不是圆棍）+ 黑靴
  for (const side of [-1, 1]) {
    const sw = side * legSw * 0.5;
    line(ctx, side * 1.5 * k, 4 * k, side * 1.9 * k + sw, 9.4 * k, P.ironLo, 3.1 * k);
    line(ctx, side * 1.5 * k, 4 * k, side * 1.9 * k + sw, 9.4 * k, P.lamella, 1.7 * k);
    poly(ctx, [
      [side * 1.9 * k + sw - 1.4 * k, 9.2 * k],
      [side * 1.9 * k + sw + 1.4 * k, 9.2 * k],
      [side * 1.9 * k + sw + 2.3 * k, 11.6 * k],
      [side * 1.9 * k + sw - 2.1 * k, 11.6 * k],
    ], P.ink, P.lamellaEdge, 0.6 * k);
  }

  // 2. 战裙至膝，下摆带竖褶
  poly(ctx, [
    [-3.1 * k, 1.6 * k], [3.1 * k, 1.6 * k],
    [4.3 * k, 6.4 * k], [-4.3 * k, 6.4 * k],
  ], P.iron, P.ink, 1.1 * k);
  if (detail >= 1) {
    for (const xx of [-2.4, 0, 2.4]) {
      line(ctx, xx * k, 2.2 * k, xx * 1.2 * k, 6 * k, rgba(P.lamellaEdge, 0.5), 0.6 * k);
    }
    // 札甲横道（战裙下段）
    for (let r = 0; r < (detail >= 2 ? 3 : 1); r++) {
      line(ctx, -3.8 * k, (2.8 + r * 1.3) * k, 3.8 * k, (2.8 + r * 1.3) * k,
        rgba(P.lamellaEdge, 0.35), 0.5 * k);
    }
  }

  // 3. 躯干：收腰窄梯形
  const torso = [
    [-3.5 * k, -6.2 * k], [3.5 * k, -6.2 * k],
    [2.8 * k, 1.9 * k], [-2.8 * k, 1.9 * k],
  ];
  poly(ctx, torso, P.iron, P.ink, 1.2 * k);
  rim(ctx, [torso[1], torso[2]], P.edge, 0.7 * k);
  // 札甲：细密横向叠压的小甲片
  if (detail >= 1) {
    const rows = detail >= 2 ? 5 : 2;
    for (let r = 0; r < rows; r++) {
      const yy = (-5.3 + r * 1.5) * k;
      line(ctx, -3.2 * k, yy, 3.2 * k, yy, rgba(P.lamellaEdge, 0.42), 0.55 * k);
      if (detail >= 2) {
        for (const xx of [-2.2, -0.7, 0.8, 2.3]) {
          line(ctx, xx * k, yy, xx * k, yy + 1.35 * k, rgba(P.lamellaEdge, 0.4), 0.45 * k);
        }
      }
    }
  }
  // 素铁护心镜：一小块无纹方铁，不是亮金圆、也不是菱格布纹
  poly(ctx, [[-1.3 * k, -4.1 * k], [1.3 * k, -4.1 * k],
    [1.3 * k, -1.9 * k], [-1.3 * k, -1.9 * k]], P.lamella, rgba(P.ironHi, 0.4), 0.6 * k);
  // 阵营色：胸前一道极窄横纹
  ctx.fillStyle = rgba(col, 0.6);
  ctx.fillRect(-1.8 * k, 0.2 * k, 3.6 * k, 0.7 * k);
  // 腰带
  ctx.fillStyle = P.woodLo;
  ctx.fillRect(-3 * k, 1.3 * k, 6 * k, 1.3 * k);
  if (detail >= 1) {
    line(ctx, 1.6 * k, 2.3 * k, 1.9 * k + flutter * 0.2, 6.2 * k, rgba(col, 0.5), 0.7 * k);
  }

  // 4. 护肩：两片斜矩形，不用圆
  for (const side of [-1, 1]) {
    poly(ctx, [
      [side * 3.2 * k, -6.6 * k], [side * 5.4 * k, -6.1 * k],
      [side * 5.1 * k, -3.6 * k], [side * 3.3 * k, -4.2 * k],
    ], P.lamella, P.ink, 0.9 * k);
    if (detail >= 2) {
      line(ctx, side * 3.5 * k, -5.4 * k, side * 5.1 * k, -4.9 * k,
        rgba(P.ironHi, 0.45), 0.5 * k);
    }
  }

  // 5. 手臂：细直线 + 护腕
  for (const side of [-1, 1]) {
    const sw = side * armSw * 0.6;
    line(ctx, side * 4.2 * k, -5.4 * k, side * 4.6 * k + sw, -0.8 * k, P.iron, 2.4 * k);
    line(ctx, side * 4.2 * k, -5.4 * k, side * 4.6 * k + sw, -0.8 * k,
      rgba(P.lamellaEdge, 0.6), 0.6 * k);
    ctx.fillStyle = P.woodLo;
    ctx.fillRect(side * 4.6 * k + sw - 1.1 * k, -1.5 * k, 2.2 * k, 1.2 * k);
  }

  // 6. 兜鍪 + 顿项 + 面甲：完全不露脸
  if (u.type === 'junshi') {
    // 纶巾：方形墨巾 + 两侧窄带，无脸
    poly(ctx, [[-3.2 * k, -12.4 * k], [3.2 * k, -12.4 * k],
      [3 * k, -8.9 * k], [-3 * k, -8.9 * k]], P.cloth, P.ink, 1 * k);
    line(ctx, -3.2 * k, -10.2 * k, 3.2 * k, -10.2 * k, rgba(P.woodHi, 0.55), 0.7 * k);
    if (detail >= 1) {
      for (const side of [-1, 1]) {
        line(ctx, side * 3 * k, -10.6 * k, side * 4.4 * k + flutter * 0.3, -7.4 * k,
          rgba(P.cloth, 0.9), 0.9 * k);
      }
    }
  } else {
    // 顿项：两片护颊/护颈
    poly(ctx, [[-3.4 * k, -10.8 * k], [-3.8 * k, -6.8 * k],
      [-2.1 * k, -6.4 * k], [-2.4 * k, -10.6 * k]], P.lamella, P.ink, 0.8 * k);
    poly(ctx, [[3.4 * k, -10.8 * k], [3.8 * k, -6.8 * k],
      [2.1 * k, -6.4 * k], [2.4 * k, -10.6 * k]], P.lamella, P.ink, 0.8 * k);
    // 盔体：锥形硬边，不是圆球
    poly(ctx, [[-3.5 * k, -10.4 * k], [-1.9 * k, -13.4 * k],
      [1.9 * k, -13.4 * k], [3.5 * k, -10.4 * k]], P.iron, P.ink, 1.1 * k);
    rim(ctx, [[-1.9 * k, -13.4 * k], [1.9 * k, -13.4 * k], [3.5 * k, -10.4 * k]],
      P.edge, 0.7 * k);
    // 盔顶不立缨：参考图里只有压低的兜鍪与眉庇，任何竖起来的东西都会显轻
    // 眉庇压低
    line(ctx, -3.6 * k, -10.3 * k, 3.6 * k, -10.3 * k, P.woodHi, 1.2 * k);
  }
  // 面甲：黑色多边形罩住整张脸，只留一道极细冷光眼缝
  poly(ctx, [[-2.5 * k, -10.1 * k], [2.5 * k, -10.1 * k],
    [2.2 * k, -6.9 * k], [0, -5.9 * k], [-2.2 * k, -6.9 * k]],
    P.ironLo, P.ink, 0.9 * k);
  line(ctx, -1.7 * k, -9.1 * k, 1.7 * k, -9.1 * k, rgba(P.edge, 0.75), 0.65 * k);
  if (detail >= 2) {
    // 面甲竖向甲片缝，不是五官
    line(ctx, 0, -10 * k, 0, -6.4 * k, rgba(P.lamellaEdge, 0.4), 0.5 * k);
    line(ctx, -2.3 * k, -8 * k, 2.3 * k, -8 * k, rgba(P.lamellaEdge, 0.3), 0.45 * k);
  }
  if (heavy && detail >= 1) {
    // 重甲步：肩甲再加一层，甲片更密
    for (const side of [-1, 1]) {
      line(ctx, side * 3.4 * k, -6.3 * k, side * 5.6 * k, -5.6 * k,
        rgba(P.ironHi, 0.5), 0.8 * k);
    }
  }
}

// ── 兵器（人形挂载）：矩形木盾 / 长枪 / 横弩 / 令旗 ──────────────────────
function drawWeapon(ctx, P, u, { k, detail, col, armSw, flutter }) {
  const type = u.type;
  if (type === 'junshi') {
    // 令旗 + 简册：零伤害辅助，不做可爱羽扇
    line(ctx, 5.4 * k, 2 * k, 6.8 * k, -14.6 * k, P.woodHi, 1.3 * k);
    poly(ctx, [[6.8 * k, -14.6 * k], [11.6 * k + flutter * 0.3, -13.2 * k],
      [6.8 * k, -11.2 * k]], P.iron, rgba(col, 0.7), 0.7 * k);
    if (detail >= 1) {
      for (let i = 0; i < 3; i++) {
        line(ctx, -5.4 * k + i * 1.1 * k, -1 * k, -5.4 * k + i * 1.1 * k, 2.6 * k,
          rgba(P.woodHi, 0.7), 0.7 * k);
      }
    }
    return;
  }
  if (type === 'changqiang') {
    // 超长枪：枪杆比人高，暗红缨压到极短
    line(ctx, 5.6 * k, 11 * k, 8.8 * k + armSw * 0.2, -18.4 * k, P.wood, 1.5 * k);
    poly(ctx, [[8.8 * k + armSw * 0.2, -20.2 * k],
      [7.4 * k + armSw * 0.2, -16.4 * k], [10.2 * k + armSw * 0.2, -16.4 * k]],
      P.iron, rgba(P.ironHi, 0.6), 0.7 * k);
    line(ctx, 8.8 * k, -16.2 * k, 7.4 * k, -14.2 * k, rgba(col, 0.55), 1 * k);
    return;
  }
  if (type === 'gongnu') {
    // 横持长弩：弩身横贯胸前，弩臂两端上翘
    line(ctx, -2 * k, -3.2 * k, 12 * k, -3.2 * k, P.wood, 2 * k);
    poly(ctx, [[-2 * k, -3.2 * k], [-4.4 * k, -6.4 * k], [-3.2 * k, -6.8 * k], [-1 * k, -3.6 * k]],
      P.lamella, P.ink, 0.7 * k);
    poly(ctx, [[12 * k, -3.2 * k], [14.2 * k, -6.4 * k], [13 * k, -6.8 * k], [10.8 * k, -3.6 * k]],
      P.lamella, P.ink, 0.7 * k);
    line(ctx, -4.2 * k, -6.5 * k, 2 * k, -3.2 * k, rgba(P.ironHi, 0.6), 0.6 * k);
    line(ctx, 2 * k, -3.2 * k, 14 * k, -6.5 * k, rgba(P.ironHi, 0.6), 0.6 * k);
    ctx.fillStyle = rgba(col, 0.5);
    ctx.fillRect(2 * k, -4 * k, 6 * k, 0.6 * k);
    return;
  }
  if (type === 'zhongjia') {
    // 重甲：更大的矩形木盾 + 短槌
    rectShield(ctx, P, { k, detail, col, x: -6.2, w: 4.4, h1: -8.2, h2: 8.2 });
    line(ctx, 5.4 * k, 2 * k, 8.4 * k + armSw * 0.2, -6.4 * k, P.wood, 1.9 * k);
    poly(ctx, [[7.2 * k + armSw * 0.2, -7.6 * k], [11.4 * k + armSw * 0.2, -7.6 * k],
      [11.4 * k + armSw * 0.2, -4.6 * k], [7.2 * k + armSw * 0.2, -4.6 * k]],
      P.lamella, P.ink, 0.8 * k);
    return;
  }
  // 刀盾兵：高大矩形木盾 + 环首直刀
  rectShield(ctx, P, { k, detail, col, x: -5.8, w: 3.8, h1: -7.4, h2: 7.4 });
  line(ctx, 5.2 * k, 1.8 * k, 8.2 * k + armSw * 0.2, -6 * k, P.woodLo, 1.3 * k);
  line(ctx, 8.2 * k + armSw * 0.2, -6 * k, 11.4 * k + armSw * 0.2, -15.4 * k,
    P.ironHi, 1.6 * k);
  line(ctx, 8.2 * k + armSw * 0.2, -6 * k, 11.4 * k + armSw * 0.2, -15.4 * k,
    P.ink, 0.5 * k);
  if (detail >= 2) {
    // 环首
    ctx.strokeStyle = rgba(P.woodHi, 0.8); ctx.lineWidth = 0.7 * k;
    ctx.beginPath(); ctx.arc(5.2 * k, 1.8 * k, 1.1 * k, 0, Math.PI * 2); ctx.stroke();
  }
}

/** 矩形木盾：竖木板 + 铆钉 + 一道阵营色窄边，绝不用圆盾。 */
function rectShield(ctx, P, { k, detail, col, x, w, h1, h2 }) {
  const L = x * k - w * k / 2, R = x * k + w * k / 2;
  poly(ctx, [[L, h1 * k], [R, h1 * k], [R, h2 * k], [L, h2 * k]],
    P.wood, P.ink, 1.1 * k);
  if (detail >= 1) {
    for (let i = 1; i < 4; i++) {
      line(ctx, (L + (R - L) * i / 4), h1 * k, (L + (R - L) * i / 4), h2 * k,
        rgba(P.woodLo, 0.75), 0.6 * k);
    }
    line(ctx, L, (h1 + h2) * 0.5 * k, R, (h1 + h2) * 0.5 * k, rgba(P.woodHi, 0.5), 0.8 * k);
    for (const yy of [h1 + 1.6, h2 - 1.6]) {
      ctx.fillStyle = rgba(P.ironHi, 0.55);
      ctx.fillRect(L + 0.5 * k, yy * k, 0.8 * k, 0.8 * k);
      ctx.fillRect(R - 1.3 * k, yy * k, 0.8 * k, 0.8 * k);
    }
  }
  line(ctx, R, h1 * k, R, h2 * k, rgba(col, 0.55), 1.1 * k);
  rim(ctx, [[R, h1 * k], [R, h2 * k]], P.edge, 0.6 * k);
}

// ── 军械一：床弩（主体是带轮木架巨弩，操作兵只有比例尺大小） ────────────
function drawBedCrossbow(ctx, P, { k, detail, col, wheel, armSwing, flutter }) {
  // 底座木梁
  poly(ctx, [[-11 * k, 7.2 * k], [11 * k, 7.2 * k], [10.4 * k, 10.2 * k], [-10.4 * k, 10.2 * k]],
    P.wood, P.ink, 1.1 * k);
  if (detail >= 1) {
    line(ctx, -10 * k, 8.7 * k, 10 * k, 8.7 * k, rgba(P.woodLo, 0.7), 0.7 * k);
  }
  // 两个轮（辐条随行军旋转）
  for (const cx of [-7.6, 7.6]) drawWheel(ctx, P, cx * k, 10.4 * k, 2.9 * k, wheel, detail);
  // A 形支架
  line(ctx, -8.4 * k, 7.2 * k, 0, -1.6 * k, P.wood, 2.1 * k);
  line(ctx, 8.4 * k, 7.2 * k, 0, -1.6 * k, P.wood, 2.1 * k);
  line(ctx, -4.4 * k, 3.2 * k, 4.4 * k, 3.2 * k, P.woodLo, 1.4 * k);
  // 弩身横贯
  poly(ctx, [[-10 * k, -2.6 * k], [10 * k, -2.6 * k], [10 * k, -0.9 * k], [-10 * k, -0.9 * k]],
    P.woodHi, P.ink, 1 * k);
  ctx.fillStyle = rgba(col, 0.45);
  ctx.fillRect(-8 * k, -2.1 * k, 16 * k, 0.6 * k);
  // 双弩臂：近乎水平向前张开，不上扬 —— 上扬会读成翅膀，轻且俏皮
  for (const side of [-1, 1]) {
    const ex = side * 13.6 * k;
    poly(ctx, [
      [side * 8.6 * k, -2.3 * k], [ex, -5.8 * k + armSwing * 14 * k],
      [ex - side * 1.1 * k, -4.6 * k + armSwing * 14 * k], [side * 8.6 * k, -1.1 * k],
    ], P.lamella, P.ink, 0.8 * k);
  }
  // 弦：两臂端点到中央箭槽的浅 V
  line(ctx, -13.6 * k, -5.6 * k, 0, -1.9 * k, rgba(P.ironHi, 0.55), 0.65 * k);
  line(ctx, 13.6 * k, -5.6 * k, 0, -1.9 * k, rgba(P.ironHi, 0.55), 0.65 * k);
  // 长矢沿槽
  line(ctx, -3 * k, -1.8 * k, 12.6 * k, -1.8 * k, P.ironHi, 1 * k);
  poly(ctx, [[12.6 * k, -1.8 * k], [10.8 * k, -2.7 * k], [10.8 * k, -0.9 * k]],
    P.ironHi, P.ink, 0.5 * k);
  // 绞盘
  if (detail >= 1) {
    ctx.strokeStyle = P.woodHi; ctx.lineWidth = 1 * k;
    ctx.beginPath(); ctx.arc(5.6 * k, 4.8 * k, 2 * k, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = wheel * 0.5 + i * Math.PI / 2;
      line(ctx, 5.6 * k, 4.8 * k, 5.6 * k + Math.cos(a) * 2 * k,
        4.8 * k + Math.sin(a) * 2 * k, rgba(P.woodHi, 0.7), 0.6 * k);
    }
  }
  // 操作兵：极小墨甲剪影，无脸，只作比例尺
  drawCrew(ctx, P, -9.4 * k, 5.4 * k, 0.9);
  if (detail >= 1) {
    // 缆绳飘动
    line(ctx, -10 * k, 2 * k, -11.4 * k - flutter * 0.3, 6 * k, rgba(P.cord, 0.8), 0.6 * k);
  }
}

// ── 军械二：抛石机（斜臂 + 配重箱 + 吊索石弹 + 轮架） ──────────────────
function drawTrebuchet(ctx, P, { k, detail, col, wheel, armSwing, flutter }) {
  // 带轮底座
  poly(ctx, [[-10.5 * k, 7.6 * k], [10.5 * k, 7.6 * k],
    [10 * k, 10.2 * k], [-10 * k, 10.2 * k]], P.wood, P.ink, 1.1 * k);
  for (const cx of [-7.4, 7.4]) drawWheel(ctx, P, cx * k, 10.4 * k, 2.7 * k, wheel, detail);
  // A 形立柱
  line(ctx, -7.6 * k, 7.6 * k, 0, -5.2 * k, P.wood, 2.4 * k);
  line(ctx, 7.6 * k, 7.6 * k, 0, -5.2 * k, P.wood, 2.4 * k);
  line(ctx, -3.8 * k, 1.2 * k, 3.8 * k, 1.2 * k, P.woodLo, 1.5 * k);
  ctx.fillStyle = rgba(col, 0.4);
  ctx.fillRect(-8 * k, 9 * k, 16 * k, 0.6 * k);
  // 斜臂：左上（配重）→ 右下（吊索），行军时微摆
  const a = armSwing;
  const bx0 = -8.6 * k, by0 = -12.6 * k - a * 26 * k;
  const bx1 = 8.2 * k, by1 = 4.2 * k + a * 26 * k;
  ctx.save();
  ctx.translate(0, 0);
  poly(ctx, [
    [bx0 - 1 * k, by0 - 1.2 * k], [bx0 + 1 * k, by0 + 1.2 * k],
    [bx1 + 0.8 * k, by1 + 1.2 * k], [bx1 - 0.8 * k, by1 - 1.2 * k],
  ], P.woodHi, P.ink, 0.9 * k);
  ctx.restore();
  // 支点
  ctx.fillStyle = P.iron;
  ctx.beginPath(); ctx.arc(0, -4.4 * k, 1.6 * k, 0, Math.PI * 2); ctx.fill();
  // 配重箱（左上端）
  ctx.save();
  ctx.translate(bx0, by0); ctx.rotate(-0.18);
  poly(ctx, [[-2.6 * k, -1.6 * k], [2.6 * k, -1.6 * k],
    [2.6 * k, 2.4 * k], [-2.6 * k, 2.4 * k]], P.woodLo, P.ink, 0.9 * k);
  if (detail >= 1) {
    line(ctx, -2.6 * k, 0.4 * k, 2.6 * k, 0.4 * k, rgba(P.woodHi, 0.6), 0.6 * k);
  }
  ctx.restore();
  // 吊索 + 石弹
  const sx = bx1 + 1.4 * k, sy = by1 - 1 * k;
  line(ctx, bx1, by1, sx + flutter * 0.2, sy + 5.4 * k, rgba(P.cord, 0.9), 0.7 * k);
  const stone = [
    [sx - 2.2 * k, sy + 5 * k], [sx + 1.9 * k, sy + 4.6 * k],
    [sx + 2.5 * k, sy + 7.6 * k], [sx - 1.4 * k, sy + 8.2 * k],
  ];
  poly(ctx, stone, P.lamella, P.ink, 0.8 * k);
  rim(ctx, [stone[0], stone[1]], P.edge, 0.6 * k);
  // 操作兵
  drawCrew(ctx, P, -8.8 * k, 5.6 * k, 0.9);
}

/** 轮子：外圈 + 辐条（辐条随 wheel 旋转），墨线硬边。 */
function drawWheel(ctx, P, cx, cy, r, wheel, detail) {
  ctx.strokeStyle = P.ink; ctx.lineWidth = 1.8 * r / 3;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = P.woodHi; ctx.lineWidth = Math.max(0.6, r * 0.22);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  if (detail >= 1) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = wheel + i * Math.PI * 2 / n;
      line(ctx, cx, cy, cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86,
        rgba(P.woodHi, 0.65), Math.max(0.5, r * 0.13));
    }
  }
  ctx.fillStyle = P.iron;
  ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.7, r * 0.18), 0, Math.PI * 2); ctx.fill();
}

/** 极小墨甲操作兵：只作比例尺，无脸无肤色，绝不画成人形主体。 */
function drawCrew(ctx, P, x, y, scale) {
  const k = scale;
  // 头（兜鍪）+ 身 + 两腿，全黑剪影
  poly(ctx, [[x - 1 * k, y - 6 * k], [x + 1 * k, y - 6 * k],
    [x + 0.8 * k, y - 4.2 * k], [x - 0.8 * k, y - 4.2 * k]], P.ironLo, P.ink, 0.4);
  poly(ctx, [[x - 1.3 * k, y - 4.2 * k], [x + 1.3 * k, y - 4.2 * k],
    [x + 1 * k, y - 0.4 * k], [x - 1 * k, y - 0.4 * k]], P.ironLo, P.ink, 0.4);
  line(ctx, x - 0.5 * k, y - 0.4 * k, x - 0.7 * k, y + 2 * k, P.ironLo, 0.9 * k);
  line(ctx, x + 0.5 * k, y - 0.4 * k, x + 0.7 * k, y + 2 * k, P.ironLo, 0.9 * k);
  line(ctx, x - 0.9 * k, y - 5.2 * k, x + 0.9 * k, y - 5.2 * k,
    rgba(P.edge, 0.35), 0.35);
}
