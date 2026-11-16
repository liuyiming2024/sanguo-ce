// 士兵立绘与行军姿态（v0.7.2）。
//
// 纯绘制层：无 DOM、无 state、无墙钟、无 Math.random。
// 所有相位只取调用方传入的 sec（战斗时刻＝模拟时间）+ 由 unit id 派生的静态偏移，
// 因此同 sec 逐像素一致；暂停/退出时 sec 冻结，动画一起冻结；隔月快进后
// tween 直接吸附终点，不会补跑一段谁也没看见的行军。
//
// 造型按汉末甲胄：札甲甲片、护肩、护心镜、腰带垂带、战裙褶、兜鍪顿项、
// 护鼻眉庇、盔缨；军师改纶巾羽扇。阵营色只作盔缨 / 胸纹 / 盾心 / 披风里衬，
// 主体一律压灰的冷铁与赭革，不用亮金正红。
// 兵器按兵种分支：环首刀盾 / 长枪红缨 / 弓弩 / 床弩 / 抛石 / 重甲槌 / 羽扇。

const INK = '#0b100e';
// 两套设色：底色深浅不同时自动切换，保证甲片不会融进地面。
const PAL_ON_INK = {                       // 深墨底：冷灰铁甲 + 亮高光
  plate: '#aab4a8', plateLo: '#5f6d63', plateHi: '#dce1d2',
  trim: '#b9a472', leather: '#7d6a4e', leatherHi: '#a08b68',
  cloth: '#3a463c', clothHi: '#5b6a58',
  steel: '#cdd4ca', steelLo: '#8b958c',
  wood: '#8c7350', skin: '#c9bda2', jade: '#8fb5a0',
  outline: '#0b100e', seam: '#3a463c',
};
const PAL_ON_PAPER = {                     // 浅绢/纸底：墨绿札甲 + 石绿高光
  plate: '#54685a', plateLo: '#2f3d33', plateHi: '#a9bda8',
  trim: '#8e7442', leather: '#6b583c', leatherHi: '#96794f',
  cloth: '#2c382f', clothHi: '#4b5c49',
  steel: '#7b8b80', steelLo: '#4a5950',
  wood: '#7a6244', skin: '#9c9078', jade: '#5f8a74',
  outline: '#17211a', seam: '#17211a',
};
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

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

/**
 * @param o {x,y,s,sec,walk,dir,phase,amp,seed,col,def,selected,champion}
 *   x/y 画布 CSS 像素；s 单位像素尺寸；walk 是否在行军；phase 步频相位；
 *   amp 起步/收步包络；dir 左右朝向；col 阵营色。
 */
export function drawSoldier(ctx, u, o) {
  const { x, y, s, sec, walk, dir, phase, amp, seed, col } = o;
  const k = s / 20;
  const detail = s >= 17 ? 2 : s >= 11 ? 1 : 0;   // 手机窄屏自动降档，但轮廓/兵种不丢
  const def = o.def ?? {};
  const type = u.type;
  const proj = def.projectile;
  const P = o.lightGround ? PAL_ON_PAPER : PAL_ON_INK;

  // ── 姿态 ──────────────────────────────────────────────────────────────
  const lean = walk ? 0.085 * amp : 0;                 // 行进方向前倾（scale 会镜像）
  const bob = walk ? -Math.abs(Math.sin(phase)) * 1.25 * k * amp
                   : Math.sin(sec * 1.6 + seed) * 0.32 * k;   // 待机呼吸
  const legSw = walk ? Math.sin(phase) * 3.6 * k * amp : 0;
  const armSw = walk ? -Math.sin(phase) * 2.5 * k * amp : 0;
  const flutter = walk ? Math.sin(phase * 0.72 + seed) * 1.9 * k * amp
                       : Math.sin(sec * 1.1 + seed) * 0.55 * k;

  // 地面投影：行军时略拉长
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.38)';
  ctx.beginPath();
  ctx.ellipse(x, y + 10.5 * k, (6.2 + (walk ? 0.9 : 0)) * k, 2.3 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 扬尘：脚下三点，位置由 id + 步序确定性给出，向后飘
  if (walk && amp > 0.12) {
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const t = ((phase * 0.16 + i * 0.37 + h32(i, Math.round(seed * 100), 7)) % 1 + 1) % 1;
      const dx = -(2.5 + t * 8) * k;
      const dy = (9.5 - t * 3.2) * k;
      ctx.fillStyle = rgba(P.plateHi, (1 - t) * 0.28 * amp);
      ctx.beginPath();
      ctx.arc(x + dir * dx, y + dy, (0.7 + t * 1.1) * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(lean);
  ctx.scale(dir, 1);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // ── 1. 披风（身后先画） ───────────────────────────────────────────────
  if (type !== 'junshi') {
    ctx.fillStyle = rgba(P.cloth, 0.94);
    ctx.beginPath();
    ctx.moveTo(-3.6 * k, -7 * k);
    ctx.quadraticCurveTo(-9 * k - flutter, -0.5 * k, -7.2 * k - flutter * 0.6, 8 * k);
    ctx.lineTo(-1.8 * k, 5.5 * k);
    ctx.lineTo(-2.4 * k, -6.5 * k);
    ctx.closePath(); ctx.fill();
    if (detail >= 1) {
      ctx.strokeStyle = rgba(col, 0.52); ctx.lineWidth = 0.9 * k;
      ctx.beginPath();
      ctx.moveTo(-4.2 * k, -6 * k);
      ctx.quadraticCurveTo(-8 * k - flutter, 0.5 * k, -6.6 * k - flutter * 0.6, 7 * k);
      ctx.stroke();
    }
  }

  // ── 2. 战裙 / 袍摆 ───────────────────────────────────────────────────
  ctx.fillStyle = P.cloth;
  ctx.beginPath();
  ctx.moveTo(-4.2 * k, 1.2 * k); ctx.lineTo(4.2 * k, 1.2 * k);
  ctx.lineTo(6.3 * k, 8.6 * k); ctx.lineTo(-6.3 * k, 8.6 * k);
  ctx.closePath(); ctx.fill();
  if (detail >= 1) {
    ctx.strokeStyle = rgba(P.clothHi, 0.85); ctx.lineWidth = 0.8 * k;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 2.6 * k, 2 * k);
      ctx.lineTo(i * 3.6 * k + (walk ? legSw * 0.18 : 0), 8.2 * k);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(P.trim, 0.55); ctx.lineWidth = 0.9 * k;
    ctx.beginPath(); ctx.moveTo(-6.1 * k, 8.3 * k); ctx.lineTo(6.1 * k, 8.3 * k); ctx.stroke();
  }

  // ── 3. 双腿 + 靴 ─────────────────────────────────────────────────────
  const leg = (side, sw) => {
    ctx.strokeStyle = INK; ctx.lineWidth = 3.6 * k;
    ctx.beginPath();
    ctx.moveTo(side * 1.8 * k, 2.5 * k);
    ctx.lineTo(side * 2.6 * k + sw * 0.45, 6 * k);
    ctx.lineTo(side * 3.1 * k + sw, 9.4 * k);
    ctx.stroke();
    ctx.strokeStyle = rgba(P.leather, 0.95); ctx.lineWidth = 2.1 * k;
    ctx.beginPath();
    ctx.moveTo(side * 1.8 * k, 2.8 * k);
    ctx.lineTo(side * 2.6 * k + sw * 0.45, 6 * k);
    ctx.lineTo(side * 3.1 * k + sw, 9 * k);
    ctx.stroke();
    // 靴头朝前
    ctx.fillStyle = P.leather;
    ctx.beginPath();
    ctx.ellipse(side * 3.1 * k + sw + 1.1 * k, 9.6 * k, 2.2 * k, 1.1 * k, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  leg(-1, -legSw); leg(1, legSw);

  // ── 4. 札甲躯干 ──────────────────────────────────────────────────────
  const body = new Path2D();
  body.moveTo(-5.4 * k, -6.6 * k);
  body.lineTo(5.4 * k, -6.6 * k);
  body.lineTo(4.2 * k, 2.6 * k);
  body.lineTo(-4.2 * k, 2.6 * k);
  body.closePath();
  ctx.fillStyle = P.plate; ctx.fill(body);
  ctx.strokeStyle = P.outline; ctx.lineWidth = 1.45 * k; ctx.stroke(body);
  if (detail >= 1) {
    // 甲片横道（札甲），越往下越密
    ctx.strokeStyle = rgba(P.plateLo, 0.78); ctx.lineWidth = 0.85 * k;
    for (let i = 0; i < (detail >= 2 ? 4 : 2); i++) {
      const yy = (-4.6 + i * 2.0) * k;
      ctx.beginPath(); ctx.moveTo(-5 * k, yy); ctx.lineTo(5 * k, yy); ctx.stroke();
    }
    if (detail >= 2) {
      ctx.strokeStyle = rgba(P.plateHi, 0.6); ctx.lineWidth = 0.7 * k;
      for (let i = 0; i < 4; i++) {
        const yy = (-3.7 + i * 2.0) * k;
        ctx.beginPath(); ctx.moveTo(-4.8 * k, yy); ctx.lineTo(4.8 * k, yy); ctx.stroke();
      }
      // 纵向甲片缝
      ctx.strokeStyle = rgba(P.plateLo, 0.5); ctx.lineWidth = 0.6 * k;
      for (const xx of [-2.6, 0, 2.6]) {
        ctx.beginPath(); ctx.moveTo(xx * k, -6 * k); ctx.lineTo(xx * 0.8 * k, 2.2 * k); ctx.stroke();
      }
    }
    // 护心镜
    ctx.fillStyle = rgba(P.trim, 0.9);
    ctx.beginPath(); ctx.arc(0, -2.5 * k, 2 * k, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.9); ctx.lineWidth = 0.8 * k;
    ctx.beginPath(); ctx.arc(0, -2.5 * k, 1.2 * k, 0, Math.PI * 2); ctx.stroke();
  } else {
    // 低档：一道阵营色胸纹，保证 10px 也能读出归属
    ctx.fillStyle = rgba(col, 0.85); ctx.fillRect(-3 * k, -3 * k, 6 * k, 1.2 * k);
  }
  // 腰带 + 垂带
  ctx.fillStyle = P.leather; ctx.fillRect(-4.4 * k, 1.4 * k, 8.8 * k, 1.6 * k);
  if (detail >= 1) {
    ctx.fillStyle = rgba(col, 0.7);
    ctx.fillRect(2 * k, 2.8 * k, 1.4 * k, (4.2 + flutter * 0.3) * k);
  }

  // ── 5. 护肩 ──────────────────────────────────────────────────────────
  for (const side of [-1, 1]) {
    ctx.fillStyle = P.plateLo;
    ctx.beginPath();
    ctx.ellipse(side * 5.6 * k, -5.6 * k, 2.6 * k, 2.2 * k, side * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = P.outline; ctx.lineWidth = 1.1 * k; ctx.stroke();
    if (detail >= 1) {
      ctx.strokeStyle = rgba(P.plateHi, 0.7); ctx.lineWidth = 0.7 * k;
      ctx.beginPath();
      ctx.moveTo(side * 3.8 * k, -6.2 * k); ctx.lineTo(side * 7.2 * k, -5.1 * k);
      ctx.stroke();
    }
  }

  // ── 6. 手臂 + 护腕（走路摆臂） ────────────────────────────────────────
  const arm = (side, sw) => {
    ctx.strokeStyle = INK; ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.moveTo(side * 5.2 * k, -5.4 * k);
    ctx.lineTo(side * 6.6 * k + sw * 0.4, -1.6 * k);
    ctx.lineTo(side * 6.2 * k + sw, 0.8 * k);
    ctx.stroke();
    ctx.strokeStyle = rgba(P.plate, 0.95); ctx.lineWidth = 1.8 * k;
    ctx.beginPath();
    ctx.moveTo(side * 5.2 * k, -5.4 * k);
    ctx.lineTo(side * 6.6 * k + sw * 0.4, -1.6 * k);
    ctx.lineTo(side * 6.2 * k + sw, 0.8 * k);
    ctx.stroke();
    ctx.fillStyle = P.leatherHi;
    ctx.fillRect(side * 6.2 * k + sw - 1.1 * k, -0.3 * k, 2.2 * k, 1.6 * k);
  };
  arm(-1, -armSw); arm(1, armSw);

  // ── 7. 兜鍪 / 纶巾 ───────────────────────────────────────────────────
  if (type === 'junshi') {
    // 纶巾：方巾 + 两侧飘带，不戴兜鍪
    ctx.fillStyle = P.clothHi;
    ctx.fillRect(-4.4 * k, -14.6 * k, 8.8 * k, 4.4 * k);
    ctx.strokeStyle = P.outline; ctx.lineWidth = 1 * k;
    ctx.strokeRect(-4.4 * k, -14.6 * k, 8.8 * k, 4.4 * k);
    if (detail >= 1) {
      ctx.strokeStyle = rgba(P.trim, 0.8); ctx.lineWidth = 0.8 * k;
      ctx.beginPath(); ctx.moveTo(-4.4 * k, -12.4 * k); ctx.lineTo(4.4 * k, -12.4 * k); ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.strokeStyle = rgba(P.clothHi, 0.9); ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        ctx.moveTo(side * 4.2 * k, -12.8 * k);
        ctx.quadraticCurveTo(side * 7 * k, -10 * k + flutter, side * 6 * k, -6.6 * k + flutter);
        ctx.stroke();
      }
    }
  } else {
    // 顿项（后垂护颈片）
    ctx.fillStyle = P.plateLo;
    ctx.beginPath();
    ctx.moveTo(-4.6 * k, -10.8 * k); ctx.lineTo(-5.2 * k, -6.8 * k);
    ctx.lineTo(-2.8 * k, -6.2 * k); ctx.lineTo(-2.6 * k, -10.4 * k);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(4.6 * k, -10.8 * k); ctx.lineTo(5.2 * k, -6.8 * k);
    ctx.lineTo(2.8 * k, -6.2 * k); ctx.lineTo(2.6 * k, -10.4 * k);
    ctx.closePath(); ctx.fill();
    // 盔体
    ctx.fillStyle = P.plate;
    ctx.beginPath();
    ctx.moveTo(-4.6 * k, -10.2 * k);
    ctx.quadraticCurveTo(0, -17.4 * k, 4.6 * k, -10.2 * k);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = P.outline; ctx.lineWidth = 1.35 * k; ctx.stroke();
    // 眉庇 + 护鼻
    ctx.strokeStyle = rgba(P.trim, 0.95); ctx.lineWidth = 1.3 * k;
    ctx.beginPath(); ctx.moveTo(-4.6 * k, -10.4 * k); ctx.lineTo(4.6 * k, -10.4 * k); ctx.stroke();
    if (detail >= 1) {
      ctx.strokeStyle = rgba(P.plateLo, 0.9); ctx.lineWidth = 1 * k;
      ctx.beginPath(); ctx.moveTo(0, -10.4 * k); ctx.lineTo(0, -7.6 * k); ctx.stroke();
      ctx.strokeStyle = rgba(P.plateHi, 0.6); ctx.lineWidth = 0.7 * k;
      ctx.beginPath(); ctx.moveTo(-2 * k, -13.6 * k); ctx.lineTo(2 * k, -13.6 * k); ctx.stroke();
    }
    // 盔缨：一缕细缨向后飘，不是两根触角
    ctx.strokeStyle = rgba(col, 0.8); ctx.lineWidth = 1.0 * k;
    ctx.beginPath();
    ctx.moveTo(0, -16.2 * k);
    ctx.quadraticCurveTo(-1 * k, -17.8 * k, -2.8 * k - flutter * 0.6, -18.6 * k);
    ctx.stroke();
    if (detail >= 2) {
      ctx.lineWidth = 0.7 * k;
      ctx.beginPath();
      ctx.moveTo(-0.3 * k, -16.6 * k);
      ctx.quadraticCurveTo(0.5 * k, -17.6 * k, -0.1 * k - flutter * 0.25, -19 * k);
      ctx.stroke();
    }
  }
  // 面部
  // 颈 / 护颈暗线：把头和甲身分开，不然 20px 下糊成一团
  ctx.strokeStyle = P.outline; ctx.lineWidth = 1.6 * k;
  ctx.beginPath(); ctx.moveTo(-2.4 * k, -7 * k); ctx.lineTo(2.4 * k, -7 * k); ctx.stroke();
  ctx.fillStyle = P.skin;
  ctx.beginPath(); ctx.arc(0, -8.6 * k, 2.0 * k, 0, Math.PI * 2); ctx.fill();
  if (detail >= 2) {
    ctx.fillStyle = INK; ctx.fillRect(1 * k, -8.9 * k, 1.4 * k, 0.7 * k);
  }

  // ── 8. 兵器 / 器械（按兵种） ─────────────────────────────────────────
  drawWeapon(ctx, { type, proj, k, detail, col, walk, phase, amp, flutter, P });
  ctx.restore();   // ← 镜像/倾斜/呼吸结束，以下用绝对坐标

  // ── 9. 血条 / 选中环 / 主控菱形（不随镜像翻转） ──────────────────────
  const hp = Math.max(0, Math.min(1, (u.hp ?? 1) / (u.maxHp || 1)));
  const bw = 14 * k, bh = Math.max(1.2, 1.9 * k);
  ctx.fillStyle = 'rgba(11,16,14,.55)';
  ctx.fillRect(x - bw / 2, y - 25.5 * k, bw, bh);
  ctx.fillStyle = hp > 0.5 ? 'rgba(122,166,102,.9)' : 'rgba(200,126,80,.92)';
  ctx.fillRect(x - bw / 2, y - 25.5 * k, bw * hp, bh);
  if (o.selected || o.champion) {
    const pulse = 0.86 + Math.sin(sec * 4 + seed) * 0.14;
    ctx.strokeStyle = o.champion ? '#e8c882' : 'rgba(232,217,168,.95)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(x, y + 10.5 * k, 10.5 * k * pulse, 4.2 * k * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (o.champion) {
      ctx.fillStyle = '#e8c882';
      ctx.beginPath();
      ctx.moveTo(x, y - 32 * k); ctx.lineTo(x + 4, y - 28 * k);
      ctx.lineTo(x, y - 24 * k); ctx.lineTo(x - 4, y - 28 * k);
      ctx.closePath(); ctx.fill();
    }
  }
}

/** 兵器：所有兵种都有可辨识剪影，低档也保留一根主线。 */
function drawWeapon(ctx, { type, proj, k, detail, col, walk, phase, amp, flutter, P }) {
  const steel = rgba(P.steel, 0.96), steelLo = rgba(P.steelLo, 0.95);
  const wood = rgba(P.wood, 0.98), trim = rgba(P.trim, 0.9);
  const swing = walk ? Math.sin(phase) * 0.9 * k * amp : 0;

  if (type === 'junshi') {
    // 羽扇：扇面 + 扇骨 + 竹简
    ctx.fillStyle = rgba(P.jade, 0.92);
    ctx.beginPath();
    ctx.ellipse(9.4 * k, -4.6 * k + swing, 4.6 * k, 3.2 * k, -0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = trim; ctx.lineWidth = 0.9 * k;
    if (detail >= 1) {
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(6.2 * k, -2 * k);
        ctx.lineTo(9.4 * k + i * 1.5 * k, -7 * k + swing);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = wood; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.moveTo(6.2 * k, -0.4 * k); ctx.lineTo(9.4 * k, -4.6 * k + swing); ctx.stroke();
    return;
  }
  if (proj === 'stone') {
    // 抛石机：斜臂 + 配重 + 石弹（器械，兵在侧操作）
    ctx.strokeStyle = wood; ctx.lineWidth = 2.2 * k;
    ctx.beginPath(); ctx.moveTo(6 * k, 8 * k); ctx.lineTo(13 * k, -10 * k); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3 * k, 8 * k); ctx.lineTo(9 * k, 8 * k); ctx.stroke();
    ctx.fillStyle = steelLo;
    ctx.beginPath(); ctx.arc(13.6 * k, -10.6 * k + swing, 2.6 * k, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgba(P.plateLo, 0.95); ctx.fillRect(2.6 * k, -4 * k, 3.4 * k, 3.4 * k);
    return;
  }
  if (proj === 'bolt') {
    // 床弩：弩身 + 双弩臂 + 大矢
    ctx.strokeStyle = wood; ctx.lineWidth = 2.4 * k;
    ctx.beginPath(); ctx.moveTo(4.5 * k, 1 * k); ctx.lineTo(13 * k, -4.5 * k); ctx.stroke();
    ctx.strokeStyle = steel; ctx.lineWidth = 1.8 * k;
    ctx.beginPath(); ctx.moveTo(13 * k, -9.5 * k); ctx.lineTo(13 * k, 1 * k); ctx.stroke();
    ctx.strokeStyle = rgba(P.trim, 0.85); ctx.lineWidth = 0.9 * k;
    ctx.beginPath(); ctx.moveTo(5 * k, 2 * k); ctx.lineTo(13 * k, -9.5 * k);
    ctx.moveTo(5 * k, 2 * k); ctx.lineTo(13 * k, 1 * k); ctx.stroke();
    ctx.strokeStyle = steel; ctx.lineWidth = 1.3 * k;
    ctx.beginPath(); ctx.moveTo(7 * k, -1 * k); ctx.lineTo(15 * k, -4.8 * k); ctx.stroke();
    return;
  }
  if (proj) {
    // 弓弩：弓臂弧 + 弦 + 搭箭
    ctx.strokeStyle = wood; ctx.lineWidth = 1.9 * k;
    ctx.beginPath(); ctx.arc(9.6 * k, -3.4 * k, 6.6 * k, -1.15, 1.15); ctx.stroke();
    ctx.strokeStyle = rgba(P.plateHi, 0.8); ctx.lineWidth = 0.8 * k;
    ctx.beginPath(); ctx.moveTo(12.2 * k, -9.4 * k); ctx.lineTo(12.2 * k, 2.3 * k); ctx.stroke();
    if (detail >= 1) {
      ctx.strokeStyle = steel; ctx.lineWidth = 1.1 * k;
      ctx.beginPath(); ctx.moveTo(6.5 * k, -3.4 * k); ctx.lineTo(14.5 * k, -3.4 * k); ctx.stroke();
      ctx.fillStyle = steel;
      ctx.beginPath(); ctx.moveTo(14.5 * k, -3.4 * k); ctx.lineTo(12.6 * k, -4.2 * k);
      ctx.lineTo(12.6 * k, -2.6 * k); ctx.closePath(); ctx.fill();
    }
    return;
  }
  if (type === 'changqiang') {
    // 长枪：杆 + 枪尖 + 红缨
    ctx.strokeStyle = wood; ctx.lineWidth = 1.9 * k;
    ctx.beginPath(); ctx.moveTo(6.4 * k, 9.6 * k); ctx.lineTo(11.4 * k + swing, -17 * k); ctx.stroke();
    ctx.fillStyle = steel;
    ctx.beginPath();
    ctx.moveTo(11.4 * k + swing, -18.6 * k); ctx.lineTo(9.7 * k + swing, -14.2 * k);
    ctx.lineTo(13.1 * k + swing, -14.2 * k); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.92); ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.moveTo(11.4 * k + swing, -14 * k);
    ctx.quadraticCurveTo(9.2 * k + swing, -12 * k, 10.6 * k + swing, -10.4 * k);
    ctx.stroke();
    return;
  }
  if (type === 'zhongjia') {
    // 重甲：大盾 + 短槌（甲片在躯干已加密）
    ctx.fillStyle = rgba(P.plateLo, 0.95);
    ctx.beginPath();
    ctx.moveTo(-11 * k, -6 * k); ctx.lineTo(-6.4 * k, -6 * k);
    ctx.lineTo(-6.4 * k, 6 * k); ctx.lineTo(-8.7 * k, 9 * k); ctx.lineTo(-11 * k, 6 * k);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = P.outline; ctx.lineWidth = 1.25 * k; ctx.stroke();
    if (detail >= 1) {
      ctx.strokeStyle = trim; ctx.lineWidth = 0.9 * k;
      ctx.beginPath(); ctx.moveTo(-10.4 * k, -4 * k); ctx.lineTo(-7 * k, -4 * k);
      ctx.moveTo(-10.4 * k, 1 * k); ctx.lineTo(-7 * k, 1 * k); ctx.stroke();
      ctx.fillStyle = rgba(col, 0.8);
      ctx.beginPath(); ctx.arc(-8.7 * k, -1.5 * k, 1.5 * k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = wood; ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.moveTo(6.2 * k, 2 * k); ctx.lineTo(10 * k + swing, -9 * k); ctx.stroke();
    ctx.fillStyle = steelLo; ctx.fillRect(8.4 * k + swing, -11.5 * k, 4 * k, 3 * k);
    return;
  }
  // 刀盾兵：环首刀 + 盾
  ctx.fillStyle = rgba(P.plateLo, 0.95);
  ctx.beginPath(); ctx.ellipse(-8.6 * k, -1.6 * k, 3.6 * k, 4.8 * k, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = trim; ctx.lineWidth = 1.1 * k; ctx.stroke();
  if (detail >= 1) {
    ctx.strokeStyle = rgba(P.plateHi, 0.55); ctx.lineWidth = 0.8 * k;
    ctx.beginPath(); ctx.ellipse(-8.6 * k, -1.6 * k, 2 * k, 2.9 * k, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = rgba(col, 0.85);
    ctx.beginPath(); ctx.arc(-8.6 * k, -1.6 * k, 1.2 * k, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = wood; ctx.lineWidth = 1.6 * k;
  ctx.beginPath(); ctx.moveTo(7.2 * k, 2.4 * k); ctx.lineTo(11.2 * k + swing, -7.5 * k); ctx.stroke();
  ctx.strokeStyle = P.outline; ctx.lineWidth = 2.8 * k;
  ctx.beginPath();
  ctx.moveTo(11.2 * k + swing, -7.5 * k);
  ctx.quadraticCurveTo(14.2 * k + swing, -10.8 * k, 13.2 * k + swing, -14 * k);
  ctx.stroke();
  ctx.strokeStyle = rgba(P.plateHi, 0.95); ctx.lineWidth = 1.2 * k;
  ctx.beginPath();
  ctx.moveTo(11.2 * k + swing, -7.5 * k);
  ctx.quadraticCurveTo(14.2 * k + swing, -10.8 * k, 13.2 * k + swing, -14 * k);
  ctx.stroke();
  if (detail >= 2) {
    ctx.strokeStyle = trim; ctx.lineWidth = 0.9 * k;
    ctx.beginPath(); ctx.arc(6 * k, 3 * k, 1.4 * k, 0, Math.PI * 2); ctx.stroke();
  }
}

export const SOLDIER_PAL = PAL_ON_INK;
