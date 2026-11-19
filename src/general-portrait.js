// 将领立绘（v0.9.4）。纯程序化 canvas：不加载位图、不进 state / 存档 / 命令日志。
//
// 口径：不同将领要有不同的立绘。姓名 + 五维做确定性哈希，派生
// 盔形 / 袍色 / 兵器 / 须眉 / 旗章，同一将领任何时刻画出来都一样。
// 只用路径与渐变，没有 rect 方阵、没有复制图章。
const ROBES = [
  [78, 62, 46],    // 赭褐：厚重
  [56, 76, 62],    // 墨绿
  [92, 58, 48],    // 绛
  [64, 72, 92],    // 靛青
  [104, 88, 60],   // 土金
];
const BANNERS = ['#a63129', '#3f6b58', '#8a6a3c', '#4a5c7a', '#7a4a3e'];

function hashOf(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}
const pick = (h, n, salt) => (Math.imul(h ^ salt, 2654435761) >>> 0) % n;

/** 由武将五维决定气质：力高从武，智高从文，政高从沉，统高从整。 */
export function generalLook(gen) {
  const h = hashOf(gen?.name ?? '守将');
  const G = {
    force: gen?.force ?? 58, intellect: gen?.intellect ?? 55,
    command: gen?.command ?? 62, politics: gen?.politics ?? 54,
  };
  const martial = G.force >= G.intellect + 6;
  const scholarly = G.intellect >= G.force + 6;
  // 盔形：0 兜鍪（武）/ 1 束发 / 2 儒冠（文）
  const helm = martial ? 0 : scholarly ? 2 : 1 + pick(h, 2, 11);
  // 兵器：0 长戟 / 1 剑 / 2 羽扇 / 3 弓
  const weapon = martial ? (G.force > 86 ? 0 : pick(h, 2, 23))
               : scholarly ? 2 : pick(h, 4, 37);
  return {
    h, name: gen?.name ?? '守将',
    robe: ROBES[pick(h, ROBES.length, 3)],
    banner: BANNERS[pick(h, BANNERS.length, 5)],
    helm, weapon,
    beard: pick(h, 3, 41) !== 0 && !scholarly,
    brow: pick(h, 3, 53),            // 眉形：平 / 挑 / 浓
    plume: pick(h, 3, 67),          // 盔缨：无 / 单 / 双
    scar: pick(h, 5, 79) === 0,     // 少量将领带面痕
    cape: pick(h, 3, 89) !== 0,     // 披风有无：剪影差异最明显的一笔
    capeCut: pick(h, 3, 97),        // 披风下摆：齐 / 斜 / 破
    helmVar: pick(h, 2, 103),       // 兜鍪：尖顶 / 平顶，避免两名武将同款
    weaponVar: pick(h, 2, 109),     // 长兵：戟（带枝）/ 槊（素杆）
    bannerShape: pick(h, 3, 113),   // 旗章：方 / 燕尾 / 三角
  };
}

const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** 画在小地图格位上的半身立绘。x,y 为脚底中心；s 为整体高度（px）。 */
export function drawGeneralPortrait(ctx, look, x, y, s, opts = {}) {
  const { hpK = 1, flash = 0, skill = null } = opts;
  const k = s / 30;
  const L = (dx, dy) => [x + dx * k, y + dy * k];
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // 地面墨影：一笔不规则弧，不是椭圆
  ctx.beginPath();
  ctx.moveTo(...L(-7, 0));
  ctx.quadraticCurveTo(...L(0, 1.8), ...L(7.4, -.4));
  ctx.strokeStyle = 'rgba(18,24,20,.34)'; ctx.lineWidth = 1.6 * k; ctx.stroke();

  // 披风：先于袍画，三型下摆（齐 / 斜 / 破），不同将领剪影不同
  if (look.cape) {
    const sw = 7.2 + (look.h % 4) * .5;
    ctx.beginPath();
    ctx.moveTo(...L(-3.6, -17.6));
    ctx.quadraticCurveTo(...L(-sw, -8), ...L(-sw * .8, -1));
    if (look.capeCut === 1) ctx.lineTo(...L(sw * .5, -3.6));
    else if (look.capeCut === 2) {
      ctx.lineTo(...L(-1, -4.4)); ctx.lineTo(...L(1.4, -1.6)); ctx.lineTo(...L(3.4, -4));
    } else ctx.lineTo(...L(sw * .8, -1));
    ctx.quadraticCurveTo(...L(sw, -8), ...L(3.6, -17.6));
    ctx.closePath();
    ctx.fillStyle = rgb(look.robe, .62); ctx.fill();
    ctx.strokeStyle = 'rgba(24,30,24,.45)'; ctx.lineWidth = .7 * k; ctx.stroke();
  }
  // 袍：两笔外轮廓 + 一笔中缝，肩宽随体型确定性变化
  const shoulder = 5.2 + (look.h % 5) * .28;
  ctx.beginPath();
  ctx.moveTo(...L(-shoulder, -2));
  ctx.quadraticCurveTo(...L(-shoulder - 1.1, -12), ...L(-3.4, -16.5));
  ctx.lineTo(...L(3.4, -16.5));
  ctx.quadraticCurveTo(...L(shoulder + 1.1, -12), ...L(shoulder, -2));
  ctx.closePath();
  ctx.fillStyle = rgb(look.robe, .92); ctx.fill();
  ctx.strokeStyle = flash > 0 ? `rgba(243,231,210,${Math.min(.9, flash)})` : 'rgba(24,30,24,.72)';
  ctx.lineWidth = (flash > 0 ? 1.5 : .9) * k; ctx.stroke();
  // 中缝 / 甲片：不等距短笔，不排成阵列
  ctx.strokeStyle = 'rgba(226,214,186,.42)'; ctx.lineWidth = .7 * k;
  for (let i = 0; i < 3; i++) {
    const yy = -6 - i * 3.4 - (look.h % 3) * .4;
    ctx.beginPath(); ctx.moveTo(...L(-.6, yy)); ctx.lineTo(...L(.8, yy - .5)); ctx.stroke();
  }

  // 颈 / 面：一笔侧脸，不画正圆
  ctx.beginPath();
  ctx.moveTo(...L(-2.6, -17.2));
  ctx.quadraticCurveTo(...L(-3.2, -22.4), ...L(-.4, -23.6));
  ctx.quadraticCurveTo(...L(2.9, -23.2), ...L(2.5, -18.4));
  ctx.quadraticCurveTo(...L(.6, -16.8), ...L(-2.6, -17.2));
  ctx.closePath();
  ctx.fillStyle = 'rgba(214,190,158,.96)'; ctx.fill();
  ctx.strokeStyle = 'rgba(60,48,36,.6)'; ctx.lineWidth = .55 * k; ctx.stroke();
  // 眉：三种走向
  ctx.strokeStyle = 'rgba(42,34,26,.85)'; ctx.lineWidth = .8 * k;
  const by = look.brow === 0 ? -21.2 : look.brow === 1 ? -21.6 : -20.9;
  ctx.beginPath();
  if (look.brow === 1) { ctx.moveTo(...L(-2.1, by)); ctx.lineTo(...L(-.2, by - 1.1)); }
  else { ctx.moveTo(...L(-2.1, by - .5)); ctx.lineTo(...L(-.2, by)); }
  ctx.stroke();
  if (look.scar) {
    ctx.strokeStyle = 'rgba(150,74,58,.7)'; ctx.lineWidth = .5 * k;
    ctx.beginPath(); ctx.moveTo(...L(1.4, -21.8)); ctx.lineTo(...L(2.2, -19.4)); ctx.stroke();
  }
  if (look.beard) {
    ctx.strokeStyle = 'rgba(40,34,28,.8)'; ctx.lineWidth = 1.1 * k;
    ctx.beginPath(); ctx.moveTo(...L(-1.6, -18.2));
    ctx.quadraticCurveTo(...L(-.4, -15.2), ...L(1.2, -18.6)); ctx.stroke();
  }

  // 盔 / 冠：三种形制
  ctx.fillStyle = look.helm === 2 ? 'rgba(48,44,38,.94)' : 'rgba(72,68,58,.96)';
  ctx.strokeStyle = 'rgba(232,218,186,.55)'; ctx.lineWidth = .6 * k;
  ctx.beginPath();
  if (look.helm === 2) {           // 儒冠：方中带斜
    ctx.moveTo(...L(-3.2, -22.6)); ctx.lineTo(...L(-2.6, -26.4));
    ctx.lineTo(...L(2.9, -26.1)); ctx.lineTo(...L(2.7, -22.6));
  } else if (look.helm === 0) {   // 兜鍪：尖顶 / 平顶两型
    ctx.moveTo(...L(-3.4, -22.4));
    if (look.helmVar) {
      ctx.lineTo(...L(-1.2, -26.6)); ctx.lineTo(...L(1.2, -28.4));
      ctx.lineTo(...L(3.3, -22.4));
    } else {
      ctx.quadraticCurveTo(...L(0, -27.6), ...L(3.3, -22.4));
    }
    ctx.lineTo(...L(2.7, -20.4)); ctx.lineTo(...L(-2.9, -20.4));
  } else {                        // 束发：低髻
    ctx.moveTo(...L(-2.9, -22.4));
    ctx.quadraticCurveTo(...L(0, -26.6), ...L(2.9, -22.4));
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // 盔缨
  if (look.plume) {
    ctx.strokeStyle = look.banner; ctx.lineWidth = 1.15 * k;
    for (let i = 0; i < look.plume; i++) {
      const off = (i - (look.plume - 1) / 2) * 1.5;
      ctx.beginPath(); ctx.moveTo(...L(off, -26.2));
      ctx.quadraticCurveTo(...L(off + 1.2, -29.4), ...L(off + 2.5, -30.4)); ctx.stroke();
    }
  }

  // 兵器：四种，斜持不复制
  ctx.strokeStyle = 'rgba(232,222,198,.9)'; ctx.lineWidth = 1.05 * k;
  if (look.weapon === 0) {        // 长兵：戟（带枝）/ 槊（素杆）
    ctx.beginPath(); ctx.moveTo(...L(5.6, -2)); ctx.lineTo(...L(7.4, -29)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...L(7.4, -29)); ctx.lineTo(...L(9.4, -26.4)); ctx.stroke();
    if (!look.weaponVar) {
      ctx.beginPath(); ctx.moveTo(...L(6.2, -25)); ctx.lineTo(...L(9.6, -24.2)); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(...L(7.2, -28.4)); ctx.lineTo(...L(8.4, -30.6)); ctx.stroke();
    }
  } else if (look.weapon === 1) { // 剑
    ctx.beginPath(); ctx.moveTo(...L(5.2, -6)); ctx.lineTo(...L(8.8, -21)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...L(3.6, -7.4)); ctx.lineTo(...L(7.2, -5.4)); ctx.stroke();
  } else if (look.weapon === 2) { // 羽扇
    ctx.beginPath(); ctx.moveTo(...L(5.2, -8)); ctx.lineTo(...L(6.6, -15)); ctx.stroke();
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(...L(6.6, -15));
      ctx.quadraticCurveTo(...L(6.6 + i * 1.4, -19.4), ...L(6.6 + i * 1.8, -20.6)); ctx.stroke();
    }
  } else {                        // 弓
    ctx.beginPath(); ctx.moveTo(...L(6.4, -5));
    ctx.quadraticCurveTo(...L(10.2, -14), ...L(6.4, -23)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...L(6.4, -5)); ctx.lineTo(...L(6.4, -23)); ctx.stroke();
  }

  // 旗章：三型（方 / 燕尾 / 三角），颜色按将领派生，进一步拉开剪影
  ctx.strokeStyle = 'rgba(60,52,40,.9)'; ctx.lineWidth = .8 * k;
  ctx.beginPath(); ctx.moveTo(...L(-5.4, -2)); ctx.lineTo(...L(-6.2, -27)); ctx.stroke();
  ctx.fillStyle = look.banner;
  ctx.beginPath();
  ctx.moveTo(...L(-6.2, -27)); ctx.lineTo(...L(-1.2, -26.4));
  if (look.bannerShape === 1) { ctx.lineTo(...L(-2.4, -22.6)); ctx.lineTo(...L(-1.2, -20.4)); }
  else if (look.bannerShape === 2) ctx.lineTo(...L(-3.7, -20.8));
  else ctx.lineTo(...L(-1.2, -20.4));
  ctx.lineTo(...L(-6.2, -21)); ctx.closePath(); ctx.fill();

  // 技能光晕：一圈断续短笔，不是整圆
  if (skill) {
    ctx.strokeStyle = skill; ctx.lineWidth = 1.2 * k;
    for (let i = 0; i < 9; i++) {
      if ((look.h + i * 7) % 4 === 0) continue;
      const a = i / 9 * Math.PI * 2;
      const c = Math.cos(a), s2 = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x + c * 9 * k, y - 12 * k + s2 * 9 * k);
      ctx.lineTo(x + c * 11.5 * k, y - 12 * k + s2 * 11.5 * k);
      ctx.stroke();
    }
  }

  // 血条：贴脚底，随格位走
  const bw = 13 * k;
  ctx.fillStyle = 'rgba(10,14,12,.68)'; ctx.fillRect(x - bw / 2, y + 1.4 * k, bw, 2.2 * k);
  ctx.fillStyle = hpK > .5 ? '#c8a86a' : hpK > .22 ? '#c07a3e' : '#a63129';
  ctx.fillRect(x - bw / 2, y + 1.4 * k, bw * hpK, 2.2 * k);
  ctx.restore();
}
