// 城池单独界面（小地图）。与大地图的关键区别：
//   · 固定视口，整张城内网格一屏放下 —— 不拖动、不缩放、不平移。
//   · 唯一交互是「调兵」：把单位在 城外大营 ↔ 城内 之间拖拽部署。
//   · 己方城池：部队初始在城内（布防）；敌方城池：部队初始在城外扎营（派人进去打）。
//   · 圆框选 + 二次拖拽定方向（全部远程单位齐射 / 近战突击）+ 单击单兵接管。
// 全部在主画布按屏幕像素绘制，不经过离屏缩放，所以不会糊。
//
// v0.9.0 移动端竖屏适配：canvas 属性尺寸严格等于 CSS 尺寸 × DPR（不再钳制到
// 320×260，否则位图被浏览器拉伸 → 手指点与画面系统性错位）；竖屏收窄大营、
// 单位图标与命中半径随 cell 自适应；hitUnit 取「最近单位」而不是倒序第一个，
// 否则窄屏相邻单位重叠时点 A 会选中 B。逻辑网格仍是 24×16，存档/部署不变。
//
// v0.9.0：床弩/抛石机改为「器械为主体」，不再画人举着小弩。器械类行军只转轮
// + 颠簸，不摆腿（soldier.js 内部按 unitKind 分派）；这里只管「从哪走到哪」。
// v0.9.0：士兵精细重绘 + 行军动画。立绘移到 soldier.js（汉末札甲/兜鍪/顿项/
// 护心镜 + 按兵种兵器），motion 全是渲染层私有状态，
// 不写 state、不进存档/命令日志/状态指纹；相位只取 sec（模拟时间）+ id 派生种子。
import { CITIES } from './map-data.js';
import { drawSoldier, idSeed, unitKind } from './soldier.js';
import { generalLook, drawGeneralPortrait } from './general-portrait.js';
import { GENERAL_SKILL_LABEL, GENERAL_SKILL_COLOR } from './siege-combat.js';
import { createPortraits } from './portrait.js';
import { headingFromDelta, normAngle } from './direction.js';
import { assignFormation, FORMATIONS, FORMATION_LABEL } from './formation.js';
import { findCityPath, cityObstacles } from './siege-grid.js';
import { formatCalendar } from './calendar.js';
import { conditionLine } from './condition.js';

const INK = '#0b100e';
const TEXT = '#e2ddc7', DIM = '#9aa896', GOLD = '#e8c882';
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function createCityView(canvas, { cfg, campaign, getCityId, playerFaction }) {
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const CV = cfg.cityView;
  const ctx = canvas.getContext('2d');
  const cityOf = () => CITIES.find((c) => c.id === getCityId());
  const factionColor = (fid) => cfg.factions.find((f) => f.id === fid)?.color ?? '#8899aa';
  // 城内地面被工笔色板改成浅绢底后，冷灰甲会融进地面。按底色明度切换设色，
  // 不碰画风本身：另一边把底色改回墨绿，士兵会自动换回冷灰铁甲。
  const lightGround = (() => {
    const h = cfg.presentation?.cityFloor ?? '#3c3f35';
    const n = parseInt(h.slice(1), 16);
    return ((n >> 16 & 255) * 0.299 + (n >> 8 & 255) * 0.587 + (n & 255) * 0.114) > 130;
  })();

  let dpr = 1, W = 800, H = 420;
  let layout = null;
  let circle = null, dragUnit = null, pointer = null;
  let selection = new Set(), champion = null;
  // 默认方阵：用户口径「列队不是让你列纵队啊，是让你列方阵嘛」。
  // 框选后点位置直接收成方阵，不再默认拉成一长条横队 / 纵队。
  let formationShape = 'block';  // 横队 / 方阵 / 楔形，HUD 右上热区点击切换
  const pathByUnit = new Map();  // 一次性 A* 路线，渲染层私有，不进 state
  let currentCombat = null;
  // ── 行军动画（渲染层私有，绝不进 state） ──────────────────────────────
  const motion = new Map();    // id -> {fx,fy,tx,ty,startSec,dur,dir,seed,heading}
  const lastKey = new Map();   // id -> "zone:col:row"，用来检测逻辑位置变化
  const lastXY = new Map();    // id -> 上一帧的逻辑画布位置
  const lastHeading = new Map(); // id -> 最近一次朝向（静止时保留，不回弹到正面）
  // 写实淡彩八向位图皮肤：素材未就绪 / 加载失败时自动回退程序化俯视路径。
  // 这是可选渲染层，不进 state、不进存档、不进命令日志、不进状态指纹。
  const portraits = createPortraits();
  let dragPos = null, releasePos = null, releaseId = null;
  let callbacks = { onDeploy: () => {}, onSelect: () => {}, onDirection: () => {},
    onChampion: () => {}, onFormationMove: () => {}, onFormationChange: () => {} };

  const forces = () => campaign.forces[getCityId()] ?? { inside: [], camp: [] };
  const allUnits = () => [...forces().inside, ...forces().camp];

  function resize() {
    dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    // 首次显示 / 地址栏动画期间可能拿到 0：此时不重建，避免把位图压成 0×0。
    if (rect.width < 1 || rect.height < 1) return false;
    // 关键：属性尺寸必须逐像素等于 CSS 尺寸 × DPR。任何 Math.max 钳制都会让
    // 浏览器拉伸位图，而 local() 用的是 CSS 坐标 —— 于是「点的位置」和「实际位置」分家。
    W = rect.width;
    H = rect.height;
    // canvas 有 1px 边框：clientWidth 比 rect.width 恒小 2px。若用 >1 判定，
    // 会每帧都 resize()，而 resize 会清掉 motion —— 行军动画永远开不起来。
    const prevW = layout?.W ?? -99, prevH = layout?.H ?? -99;
    const changed = Math.abs(prevW - W) > 1 || Math.abs(prevH - H) > 1;
    const aw = Math.round(W * dpr), ah = Math.round(H * dpr);
    if (canvas.width !== aw) canvas.width = aw;
    if (canvas.height !== ah) canvas.height = ah;
    const narrow = W < 560;
    // 竖屏把左侧大营收窄，24 列城内网格才能多拿宽度；横屏保持原比例。
    const campW = W * (narrow ? 0.14 : CV.campRatio);
    const wallX = campW;
    const innerX = wallX + (narrow ? 8 : 16);
    const innerW = Math.max(40, W - innerX - (narrow ? 6 : 14));
    const padTop = narrow ? 24 : 34, padBottom = narrow ? 14 : 26;
    const cell = Math.max(4, Math.min(innerW / CV.cols, (H - padTop - padBottom) / CV.rows));
    const gridW = cell * CV.cols, gridH = cell * CV.rows;
    const ox = innerX + (innerW - gridW) / 2;
    const oy = padTop + (H - padTop - padBottom - gridH) / 2;
    layout = { W, H, campW, wallX, innerX, innerW, cell, ox, oy, gridW, gridH, padTop, narrow };
    // 只有视口真的变了才清：按旧像素记的起终点此时才失效。
    // 自愈性 resize（尺寸没变，只补 attr）必须保留 motion。
    if (changed) { motion.clear(); lastKey.clear(); lastXY.clear(); }
    return true;
  }

  function tweenAt(m, sec) {
    const t = Math.max(0, Math.min(1, (sec - m.startSec) / m.dur));
    const e = t * t * (3 - 2 * t);            // smoothstep：起步/收步都慢
    if (!m.pts || m.pts.length < 2 || !m.segs || m.segs.length !== m.pts.length) {
      return { x: m.fx + (m.tx - m.fx) * e, y: m.fy + (m.ty - m.fy) * e, t,
        heading: m.heading ?? 0 };
    }
    // 沿 A* waypoint 逐段走：不是一条直线穿过府衙 / 仓井。
    const total = m.segs.at(-1) || 1;
    const target = e * total;
    let i = 0;
    while (i < m.segs.length - 2 && m.segs[i + 1] < target) i++;
    const a = m.pts[i], b = m.pts[i + 1];
    const span = Math.max(1e-6, m.segs[i + 1] - m.segs[i]);
    const k = Math.max(0, Math.min(1, (target - m.segs[i]) / span));
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, t,
      heading: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /** 每帧开头：把「逻辑位置被改了」翻译成一段从旧点到新点的行军。 */
  function syncMotion(sec) {
    const seen = new Set();
    for (const u of allUnits()) {
      seen.add(u.id);
      const key = `${u.zone}:${u.col}:${u.row}`;
      const to = unitXY(u);
      const prev = lastKey.get(u.id);
      lastKey.set(u.id, key);
      if (prev === undefined) { lastXY.set(u.id, { x: to.x, y: to.y }); continue; }
      if (prev !== key) {
        // 起点优先级：刚松手的手指位置 > 正在进行的 tween 当前点 > 上一帧逻辑位置
        let from = null;
        if (releaseId === u.id && releasePos) from = { x: releasePos.x, y: releasePos.y };
        const m = motion.get(u.id);
        if (!from && m) from = tweenAt(m, sec);
        if (!from) from = lastXY.get(u.id) ?? { x: to.x, y: to.y };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        if (dist < 1.2) { motion.delete(u.id); pathByUnit.delete(u.id); }
        else {
          const heading = headingFromDelta(to.x - from.x, to.y - from.y,
            lastHeading.get(u.id) ?? 0);
          // 优先用编队 / 部署算出的 A* 路线；没有才退回单段直线。
          const L = layout;
          const raw = pathByUnit.get(u.id); pathByUnit.delete(u.id);
          let pts = null, segs = null, total = dist;
          if (raw && raw.length > 1) {
            pts = [{ x: from.x, y: from.y }];
            for (const q of raw.slice(1)) {
              const p = { x: L.ox + (q.col + 0.5) * L.cell,
                y: L.oy + (q.row + 0.5) * L.cell };
              if (Math.hypot(p.x - pts.at(-1).x, p.y - pts.at(-1).y) > 1) pts.push(p);
            }
            if (Math.hypot(to.x - pts.at(-1).x, to.y - pts.at(-1).y) > 1) pts.push({ x: to.x, y: to.y });
            if (pts.length > 1) {
              segs = [0];
              for (let k = 1; k < pts.length; k++)
                segs.push(segs.at(-1) + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
              total = segs.at(-1);
            } else pts = null;
          }
          // 跨步与速度物理绑定（v0.9.3）：
          //   视觉步幅由 soldier.js 的 k = s/17 与 amp 决定（随单位宽度缩放）；
          //   步频基准 1.75 步/秒（步态周期 2π/11 ≈ 0.571s）；
          //   行军速度按兵种 def.speed 归一，dur = dist / unitSpeed；
          //   renderPos 里 phaseRate = 11 × (unitSpeed / 34) 同步缩放步频。
          // 三者同源：快走快摆、慢走慢摆，不可能「腿小抖、身飞奔」。
          // 速度钳制 4–68 px/s（约 3.4 身位/秒 @ s=20），重甲不会跑成博尔特。
          const def = cfg.units[u.type] ?? { speed: 20 };
          const unitSpeed = Math.max(4, Math.min(68, (def.speed / 26) * 34));
          const dur = Math.max(0.28, total / unitSpeed);
          motion.set(u.id, {
            fx: from.x, fy: from.y, tx: to.x, ty: to.y,
            startSec: sec, dur,
            dir: to.x >= from.x ? 1 : -1, seed: idSeed(u.id), heading,
            speed: unitSpeed, pts, segs,
          });
          lastHeading.set(u.id, heading);
        }
      }
      lastXY.set(u.id, { x: to.x, y: to.y });
    }
    for (const id of [...lastKey.keys()]) {
      if (!seen.has(id)) { lastKey.delete(id); lastXY.delete(id); motion.delete(id); lastHeading.delete(id); }
    }
    releaseId = null; releasePos = null;
  }

  /** 返回该单位这一帧该画在哪、是否在走路、步频相位与朝向。 */
  // 队伍不是散兵：同区同向、两军相向（大营朝城内，城内朝城门）。
  // 行军结束自动归队，不保留上一次的移动朝向 —— 这是「自动列队」的一半。
  const unitIdleHeading = (unit) => unit.zone === 'camp' ? Math.PI / 2 : -Math.PI / 2;
  function renderPos(u, sec) {
    const idleHeading = () => normAngle(unitIdleHeading(u));
    const still = (x, y) => ({ x, y, walking: false, dir: 1, phase: 0, amp: 0,
      heading: idleHeading() });
    if (dragUnit?.id === u.id && dragPos) {
      return { x: dragPos.x, y: dragPos.y, walking: false, dir: 1, phase: 0, amp: 0,
        heading: idleHeading(), carried: true };
    }
    const m = motion.get(u.id);
    if (!m) { const p = unitXY(u); return still(p.x, p.y); }
    const a = tweenAt(m, sec);
    // 离开一个月再回来：sec 跳变远超 dur，直接吸附终点，不补跑一段没人的行军。
    if (a.t >= 1) { motion.delete(u.id); return still(m.tx, m.ty); }
    const amp = Math.min(1, Math.sin(Math.PI * a.t) * 1.15);
    // 相位速率按真实速度缩放：跨步频率 ∝ 速度，保证快走快摆、慢走慢摆，
    // 不会出现「身速 60px/s、腿速 1.75 步/s」的错位。基准 11 rad/s @ 34px/s。
    const spd = m.speed ?? 34;
    const phaseRate = 11 * (spd / 34);
    return { x: a.x, y: a.y, walking: true, dir: m.dir,
      phase: (sec - m.startSec) * phaseRate + m.seed, amp,
      heading: normAngle(a.heading ?? m.heading ?? 0) };
  }

  const unitXY = (u) => {
    const L = layout;
    if (u.zone === 'camp') {
      const f = forces();
      const i = f.camp.findIndex((x) => x.id === u.id);
      // 竖屏大营窄，改 2 列；行距随 canvas 高度收放，保证不挤出可视区。
      const cols = L.narrow ? 2 : 4;
      const usable = Math.max(16, L.campW - 12);
      const rowGap = L.narrow ? Math.min(46, (H - L.padTop - 70) / Math.max(1, Math.ceil(f.camp.length / cols))) : 52;
      return {
        x: 6 + (i % cols) * (usable / cols) + usable / cols / 2,
        y: L.padTop + 30 + Math.floor(i / cols) * rowGap,
      };
    }
    return { x: L.ox + (u.col + 0.5) * L.cell, y: L.oy + (u.row + 0.5) * L.cell };
  };

  function screenToTarget(x, y) {
    const L = layout;
    if (x < L.wallX) return { zone: 'camp', col: 0, row: 0 };
    const col = Math.floor((x - L.ox) / L.cell);
    const row = Math.floor((y - L.oy) / L.cell);
    if (col < 0 || col >= CV.cols || row < 0 || row >= CV.rows) {
      return { zone: 'inside', col: Math.max(0, Math.min(CV.cols - 1, col)),
        row: Math.max(0, Math.min(CV.rows - 1, row)) };
    }
    return { zone: 'inside', col, row };
  }

  function hitUnit(x, y) {
    // 半径不能超过半个格，否则竖屏相邻单位会一起落进命中圈；
    // 且必须取「距离最近」的那个，倒序第一个在窄屏会稳定选错人。
    const r = Math.max(4, Math.min(CV.unitPx * 0.75, (layout?.cell ?? 20) * 0.48));
    let best = null, bd = Infinity;
    for (let i = allUnits().length - 1; i >= 0; i--) {
      const u = allUnits()[i], p = unitXY(u);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= r && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // ── 绘制 ─────────────────────────────────────────────────────────────
  function draw(sec = 0, combat = null) {
    currentCombat = combat;
    // 被动尺寸变化（地址栏收起、横竖屏、面板展开）未必会触发 resize 事件；
    // 每帧用 clientWidth 做一次轻量校验，发现位图与 CSS 尺寸不符就重建。
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0 &&
        (Math.abs(canvas.clientWidth - W) > 3 || Math.abs(canvas.clientHeight - H) > 3 ||
         canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr))) resize();
    if (!layout && !resize()) return;   // 容器还没布局好，等下一帧
    const L = layout;
    syncMotion(sec);                   // 逻辑位置 → 行军插值，全在渲染层
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 底纹
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#232b25'); bg.addColorStop(1, '#171e1a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 1400; i++) {
      const x = (i * 7919 % 1000) / 1000 * W, y = (i * 104729 % 1000) / 1000 * H;
      ctx.fillStyle = i % 2 ? 'rgba(255,246,220,.018)' : 'rgba(0,0,0,.03)';
      ctx.fillRect(x, y, 1, 1);
    }

    drawCamp(L, sec);
    drawWall(L, sec);
    drawInner(L, sec);
    for (const u of allUnits()) drawUnit(u, L, sec);
    if (combat) drawCombat(L, combat, sec);
    drawOverlays(L, sec);
    drawHud(L);
  }

  function drawCamp(L, sec) {
    // 营地地面 + 斜纹
    ctx.fillStyle = rgba('#2c3a30', 0.75);
    ctx.fillRect(0, L.padTop, L.campW, H - L.padTop - 18);
    ctx.strokeStyle = rgba('#8a9a7c', 0.10); ctx.lineWidth = 1;
    for (let x = -H; x < L.campW; x += 12) {
      ctx.beginPath(); ctx.moveTo(x, H - 18); ctx.lineTo(x + H, L.padTop); ctx.stroke();
    }
    // 栅栏
    ctx.strokeStyle = rgba('#c1b18a', 0.55); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(L.campW - 2, L.padTop); ctx.lineTo(L.campW - 2, H - 18); ctx.stroke();
    ctx.fillStyle = rgba('#a39570', 0.65);
    for (let y = L.padTop + 4; y < H - 20; y += 13) {
      ctx.beginPath(); ctx.moveTo(L.campW - 8, y); ctx.lineTo(L.campW - 2, y - 4);
      ctx.lineTo(L.campW + 4, y); ctx.lineTo(L.campW + 4, y + 6);
      ctx.lineTo(L.campW - 8, y + 6); ctx.closePath(); ctx.fill();
    }

    // 帐篷：按大营单位数量画，带旗与篝火
    const f = forces();
    const n = Math.max(2, f.camp.length);
    const cols = 4;
    const cw = (L.campW - 40) / cols;
    for (let i = 0; i < Math.min(n, 16); i++) {
      const x = 20 + (i % cols) * cw + cw / 2;
      const y = L.padTop + 40 + Math.floor(i / cols) * 52;
      const col = factionColor(f.camp[i]?.faction ?? playerFaction);
      ctx.fillStyle = rgba('#121a14', 0.7);
      ctx.beginPath(); ctx.moveTo(x - 16, y + 20); ctx.lineTo(x, y - 6);
      ctx.lineTo(x + 16, y + 20); ctx.closePath(); ctx.fill();
      ctx.fillStyle = rgba(col, 0.55);
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 16, y + 20);
      ctx.lineTo(x, y + 20); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = rgba('#e6dec4', 0.55); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 16, y + 20); ctx.lineTo(x, y - 6);
      ctx.lineTo(x + 16, y + 20); ctx.stroke();
      // 帐篷门
      ctx.fillStyle = rgba('#0d1210', 0.8);
      ctx.beginPath(); ctx.moveTo(x - 3, y + 20); ctx.lineTo(x, y + 8);
      ctx.lineTo(x + 3, y + 20); ctx.closePath(); ctx.fill();
      // 旗
      ctx.strokeStyle = rgba('#e6dec4', 0.8); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 16, y + 20); ctx.lineTo(x + 16, y - 12); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x + 16, y - 12); ctx.lineTo(x + 28, y - 8);
      ctx.lineTo(x + 16, y - 4); ctx.closePath(); ctx.fill();
    }
    // 篝火（相位取模拟时间）
    const fx = L.campW * 0.5, fy = H - 44;
    const pulse = 0.7 + Math.sin(sec * 3.1) * 0.25;
    ctx.fillStyle = rgba('#e8a24a', 0.55 * pulse);
    ctx.beginPath(); ctx.arc(fx, fy, 7 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgba('#f6d78a', 0.8);
    ctx.beginPath(); ctx.moveTo(fx, fy - 8); ctx.lineTo(fx + 4, fy + 2);
    ctx.lineTo(fx - 4, fy + 2); ctx.closePath(); ctx.fill();
  }

  function drawWall(L, sec) {
    const x = L.wallX;
    ctx.fillStyle = rgba('#0d1210', 0.8);
    ctx.fillRect(x - 4, L.padTop - 6, 14, H - L.padTop - 8);
    ctx.fillStyle = rgba('#9a9278', 0.75);
    ctx.fillRect(x - 2, L.padTop - 4, 10, H - L.padTop - 12);
    ctx.fillStyle = rgba('#d8cfae', 0.55);
    for (let y = L.padTop; y < H - 20; y += 12) {
      ctx.fillRect(x - 4, y, 5, 6);
      ctx.fillRect(x + 6, y + 6, 5, 6);
    }
    // 角楼
    for (const y of [L.padTop - 4, H - 26]) {
      ctx.fillStyle = rgba('#121a15', 0.9); ctx.fillRect(x - 9, y - 5, 24, 22);
      ctx.fillStyle = rgba('#cfc4a2', 0.85); ctx.fillRect(x - 7, y - 3, 20, 18);
      ctx.fillStyle = rgba('#3a4237', 0.9); ctx.fillRect(x - 4, y, 14, 12);
    }
    // 城门洞（gate.row 对应）
    const gy = L.oy + (CV.gate.row + 0.5) * L.cell;
    ctx.fillStyle = rgba('#0b100e', 0.95);
    ctx.fillRect(x - 6, gy - L.cell * 0.9, 18, L.cell * 1.8);
    ctx.fillStyle = rgba(factionColor(campaign.cities[getCityId()]?.owner), 0.5);
    ctx.fillRect(x - 3, gy - L.cell * 0.7, 12, L.cell * 1.4);
    ctx.strokeStyle = rgba(GOLD, 0.7); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - 6, gy - L.cell * 0.9); ctx.lineTo(x + 12, gy - L.cell * 0.9);
    ctx.moveTo(x - 6, gy + L.cell * 0.9); ctx.lineTo(x + 12, gy + L.cell * 0.9); ctx.stroke();
  }

  function drawInner(L, sec) {
    const { ox, oy, cell, gridW, gridH } = L;
    // 城内地面
    ctx.fillStyle = rgba(cfg.presentation.cityFloor ?? '#3c3f35', 0.9);
    ctx.fillRect(ox, oy, gridW, gridH);
    // 坊墙网格（细双线）
    ctx.strokeStyle = rgba('#c8c0a2', 0.22); ctx.lineWidth = 1;
    for (let c = 0; c <= CV.cols; c++) {
      ctx.beginPath(); ctx.moveTo(ox + c * cell, oy); ctx.lineTo(ox + c * cell, oy + gridH); ctx.stroke();
    }
    for (let r = 0; r <= CV.rows; r++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + r * cell); ctx.lineTo(ox + gridW, oy + r * cell); ctx.stroke();
    }
    // 街巷：每 4 格加宽，带车辙
    ctx.fillStyle = rgba(cfg.presentation.cityStreet ?? '#8a8267', 0.22);
    for (let c = 0; c < CV.cols; c += 4) ctx.fillRect(ox + c * cell, oy, cell, gridH);
    for (let r = 0; r < CV.rows; r += 4) ctx.fillRect(ox, oy + r * cell, gridW, cell);
    ctx.strokeStyle = rgba('#e0d6b4', 0.12); ctx.lineWidth = 0.8;
    for (let c = 0; c < CV.cols; c += 4) {
      ctx.beginPath(); ctx.moveTo(ox + c * cell + cell / 2, oy);
      ctx.lineTo(ox + c * cell + cell / 2, oy + gridH); ctx.stroke();
    }
    // 府衙：重檐 + 台阶 + 旗
    const yx = ox + (CV.yamen.col + 0.5) * cell, yy = oy + (CV.yamen.row + 0.5) * cell;
    const rw = cell * 3.4, rh = cell * 2.4;
    ctx.fillStyle = rgba('#121a15', 0.85); ctx.fillRect(yx - rw / 2 - 3, yy - rh / 2 - 3, rw + 6, rh + 6);
    ctx.fillStyle = rgba('#b9ad86', 0.55); ctx.fillRect(yx - rw / 2, yy - rh / 2, rw, rh);
    ctx.fillStyle = rgba('#5c6b52', 0.85); ctx.fillRect(yx - rw / 2 + 4, yy - rh / 2 + 4, rw - 8, rh - 8);
    ctx.strokeStyle = rgba('#e8dcb4', 0.7); ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(yx - rw / 2 - 8, yy - rh / 2); ctx.lineTo(yx, yy - rh / 2 - 12);
    ctx.lineTo(yx + rw / 2 + 8, yy - rh / 2); ctx.stroke();
    ctx.fillStyle = rgba('#c9b98d', 0.5);
    ctx.fillRect(yx - rw / 2 - 4, yy + rh / 2, rw + 8, 4);
    // 仓 / 井
    for (const [c, r] of [[6, 3], [6, 12], [14, 3], [14, 12]]) {
      const x = ox + (c + 0.5) * cell, y = oy + (r + 0.5) * cell;
      ctx.fillStyle = rgba('#8a8267', 0.6);
      ctx.fillRect(x - cell * 0.8, y - cell * 0.8, cell * 1.6, cell * 1.6);
      ctx.strokeStyle = rgba('#e0d6b4', 0.35); ctx.lineWidth = 1;
      ctx.strokeRect(x - cell * 0.8, y - cell * 0.8, cell * 1.6, cell * 1.6);
    }
    // 外框
    ctx.strokeStyle = rgba(GOLD, 0.45); ctx.lineWidth = 1.5;
    ctx.strokeRect(ox - 1, oy - 1, gridW + 2, gridH + 2);
  }

  function drawUnit(u, L, sec) {
    const s = Math.max(6, Math.min(CV.unitPx, L.cell * 0.82));
    const rp = renderPos(u, sec);
    const common = {
      x: rp.x, y: rp.y, s, sec,
      walk: rp.walking, dir: rp.dir, phase: rp.phase, amp: rp.amp,
      heading: rp.heading, hp: (u.hp ?? 1) / (u.maxHp || 1),
      selected: selection.has(u.id), champion: u.id === champion,
    };
    // 人形与器械都走八向写实位图：人形真转身 / 器械刚体旋转投影，
    // 不再镜像翻转，也不再让器械退回程序化木架。素材未就绪才回退。
    const engine = unitKind(u.type) === 'engine';
    if (portraits.ready && portraits.draw(ctx, { ...common,
      kind: engine ? 'engine' : 'trooper',
      engine: u.type === 'paoshi' ? 'trebuchet' : 'ballista' })) return;
    drawSoldier(ctx, u, {
      ...common, seed: idSeed(u.id), col: factionColor(u.faction),
      def: cfg.units[u.type], lightGround,
    });
  }

  /** 单兵部署也沿 A* 走，不穿府衙 / 仓井。 */
  function setUnitPath(id, from, to) {
    const r = findCityPath(from, to, { cols: CV.cols, rows: CV.rows,
      blocked: cityObstacles(cfg) });
    if (r.ok && r.path.length > 1) pathByUnit.set(id, r.path);
  }

  /** 战斗层只读可视化：投射物、主帅、城防、士气、终局。不写任何状态。 */
  function drawCombat(L, c, sec) {
    const gx = (col) => L.ox + (col + 0.5) * L.cell;
    const gy = (row) => L.oy + (row + 0.5) * L.cell;

    // 城门 / 府衙耐久：细金条，不盖住城池名称
    const bars = [
      { x: L.wallX + 14, y: L.padTop + 4, label: '城门',
        v: c.gateHp / (c.gateHpMax ?? cfg.battle.gateHp), col: '#c8a86a' },
      { x: gx(CV.yamen.col) - L.cell * 1.6, y: gy(CV.yamen.row) - L.cell * 1.5,
        label: '府衙', v: c.yamenHp / (c.yamenHpMax ?? cfg.battle.yamenHp), col: '#b98f6a' },
    ];
    ctx.font = '10px "WenQuanYi Micro Hei", serif';
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    for (const b of bars) {
      ctx.fillStyle = 'rgba(10,14,12,.55)'; ctx.fillRect(b.x, b.y, 62, 5);
      ctx.fillStyle = rgba(b.col, 0.85); ctx.fillRect(b.x, b.y, 62 * Math.max(0, Math.min(1, b.v)), 5);
      ctx.fillStyle = rgba(TEXT, 0.7);
      ctx.fillText(`${b.label} ${Math.round(b.v * 100)}%`, b.x, b.y + 6);
    }

    /* ── 主将：真兵、有立绘、有血条、有技能、有四种攻击笔势 ──
       不再是「一个框写着谁坐镇中央」。立绘按姓名 + 五维确定性生成，
       动画只读 combat.anim，不写状态、不进快照。 */
    const cmd = c.commander;
    if (cmd && cmd.state !== 'captured' && cmd.state !== 'dead') {
      const x = gx(cmd.col), y = gy(cmd.row);
      const look = generalLook(c.general);
      const anim = cmd.anim;
      const prog = anim ? Math.max(0, Math.min(1, (sec - anim.t0) / (anim.dur || .42))) : 1;
      const live = prog < 1;
      const flash = live ? (1 - prog) * .85 : 0;
      const skillCol = anim?.skill ? GENERAL_SKILL_COLOR[anim.skill] : null;

      // 攻击笔势：每种样式一条不同的运笔，不是同一个动画循环播放
      if (live && anim.style) {
        const R = L.cell * (0.6 + prog * 0.75);
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = skillCol || rgba(GOLD, .9 - prog * .55);
        ctx.lineWidth = 1.2 + (1 - prog) * 1.6;
        const A = (a, r) => [x + Math.cos(a) * r, y - L.cell * .4 + Math.sin(a) * r];
        if (anim.style === 'zhipi') {                 // 直劈：一道竖直短笔
          ctx.beginPath(); ctx.moveTo(...A(-1.9, R * .35));
          ctx.quadraticCurveTo(x, y - L.cell * .4, ...A(-1.25, R)); ctx.stroke();
        } else if (anim.style === 'hengsao') {       // 横扫：一段大弧
          ctx.beginPath(); ctx.moveTo(...A(2.9, R));
          ctx.quadraticCurveTo(...A(1.6, R * 1.25), ...A(-.15, R)); ctx.stroke();
        } else if (anim.style === 'tujin') {         // 突进：拖影两笔
          for (let i = 0; i < 2; i++) {
            ctx.globalAlpha = (1 - prog) * (i ? .45 : 1);
            ctx.beginPath(); ctx.moveTo(x - R * (.8 + i * .35), y - L.cell * .4);
            ctx.lineTo(x + R * .55, y - L.cell * .4 - i * 2); ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else if (anim.style === 'xuli') {          // 蓄势：收拢的断续环
          for (let i = 0; i < 7; i++) {
            const a = i / 7 * Math.PI * 2 + prog * .8;
            ctx.beginPath(); ctx.moveTo(...A(a, R * (1.3 - prog * .55)));
            ctx.lineTo(...A(a + .22, R * (1.3 - prog * .55))); ctx.stroke();
          }
          if (prog > .62) {
            ctx.beginPath(); ctx.moveTo(...A(-1.9, R * .3));
            ctx.lineTo(...A(-1.35, R * 1.3)); ctx.stroke();
          }
        } else if (anim.style === 'fengshi') {       // 锋矢：长拖影 + 放射短笔
          ctx.beginPath(); ctx.moveTo(x - R * 1.8, y - L.cell * .4);
          ctx.lineTo(x + R * 1.2, y - L.cell * .4); ctx.stroke();
          for (let i = -2; i <= 2; i++) {
            ctx.beginPath(); ctx.moveTo(x + R * .9, y - L.cell * .4);
            ctx.lineTo(x + R * 1.45, y - L.cell * .4 + i * 3.2); ctx.stroke();
          }
        } else if (anim.style === 'luanwu') {        // 乱舞：四道错开短笔
          for (let i = 0; i < 4; i++) {
            const a = -.9 + i * .55 + prog * .6;
            ctx.beginPath(); ctx.moveTo(...A(a, R * .35));
            ctx.lineTo(...A(a + .18, R * (1 + i * .1))); ctx.stroke();
          }
        } else if (anim.style === 'yibing') {        // 疑兵：散点墨花
          for (let i = 0; i < 8; i++) {
            const a = i / 8 * Math.PI * 2 + prog;
            ctx.beginPath(); ctx.moveTo(...A(a, R * .7));
            ctx.lineTo(...A(a, R * (.9 + (i % 3) * .18))); ctx.stroke();
          }
        } else if (anim.style === 'duzhan') {        // 督战：三层断续涟漪（不用整圆）
          for (let i = 0; i < 3; i++) {
            const rr = R * (.55 + i * .32 + prog * .25);
            ctx.globalAlpha = (1 - prog) * (.8 - i * .2);
            ctx.beginPath(); ctx.moveTo(x - rr, y - L.cell * .4);
            ctx.quadraticCurveTo(x, y - L.cell * .4 - rr * 1.1, x + rr, y - L.cell * .4);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else if (anim.style === 'gushou') {        // 固守：护罩弧
          ctx.beginPath(); ctx.moveTo(x - R * .9, y - L.cell * .15);
          ctx.quadraticCurveTo(x, y - L.cell * 1.55, x + R * .9, y - L.cell * .15); ctx.stroke();
        } else if (anim.style === 'xiuzheng') {     // 车悬：后撤收势，两笔错开
          for (let i = 0; i < 2; i++) {
            ctx.globalAlpha = (1 - prog) * (i ? .4 : .9);
            ctx.beginPath(); ctx.moveTo(x + (i ? 2 : 0), y - L.cell * .9);
            ctx.lineTo(x - R * .7 - i * 3, y - L.cell * .35); ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      }

      // 霸体：锋矢突阵期间一圈断续短弧，读得出「免控」
      if (cmd.guardUntil > sec) {
        ctx.save(); ctx.strokeStyle = 'rgba(200,168,106,.72)'; ctx.lineWidth = 1.1;
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * Math.PI * 2 + sec * .6;
          const cx = x + Math.cos(a) * L.cell * .8, cy = y - L.cell * .4 + Math.sin(a) * L.cell * .8;
          ctx.beginPath(); ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a + .3) * 4, cy + Math.sin(a + .3) * 4); ctx.stroke();
        }
        ctx.restore();
      }
      drawGeneralPortrait(ctx, look, x, y + L.cell * .46, L.cell * 1.75,
        { hpK: Math.max(0, Math.min(1, (cmd.hp ?? 90) / (cmd.maxHp ?? 90))),
          flash, skill: skillCol });
      // 题名移到立绘上方：淡墨衬是一笔不规则短弧，不是矩形面板，不压府衙
      const ty = y - L.cell * 1.72, tx = x - L.cell * 1.05;
      ctx.save();
      ctx.strokeStyle = 'rgba(24,30,24,.58)'; ctx.lineWidth = L.cell * .82;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx - 2, ty + 8);
      ctx.quadraticCurveTo(tx + L.cell * 1.1, ty + 6, tx + L.cell * 2.15, ty + 9);
      ctx.stroke();
      ctx.font = '10px "WenQuanYi Micro Hei", serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = rgba(TEXT, .92);
      const st = { fight: cmd.exposed ? '失护卫' : '交锋', inOffice: '在任', exposed: '失护卫' }[cmd.state] ?? '交锋';
      ctx.fillText(`${cmd.name} · ${st}`, tx, ty);
      ctx.fillStyle = skillCol || rgba('#c8a86a', .90);
      ctx.fillText(`${GENERAL_SKILL_LABEL[cmd.skill] ?? ''}${cmd.skillCd > 0 ? ` ${cmd.skillCd.toFixed(1)}s` : ' · 可发'}`,
        tx, ty + 12);
      ctx.restore();
    } else if (cmd && (cmd.state === 'dead' || cmd.state === 'captured')) {
      const x = gx(cmd.col), y = gy(cmd.row);
      ctx.font = '9px "WenQuanYi Micro Hei", serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = rgba('#a63129', .9);
      ctx.fillText(`${cmd.name} · ${cmd.state === 'dead' ? '阵亡' : '被擒'}`, x + 4, y - 6);
    }

    // 投射物：箭/弩矢是短直线，石弹是带弧高的圆点；全部按格坐标飞
    for (const p of c.projects ?? []) {
      const x = gx(p.col), y = gy(p.row);
      const lift = p.arc ? 3.5 * Math.sin(Math.PI * Math.max(0, Math.min(1, 1 - p.ttl / 4.5))) : 0;
      ctx.strokeStyle = p.side === 'attack' ? rgba('#d8c89a', 0.9) : rgba('#a9d4e6', 0.9);
      ctx.lineWidth = p.type === 'stone' ? 2.4 : 1.3;
      if (p.type === 'stone') {
        ctx.fillStyle = rgba('#8b8676', 0.95);
        ctx.beginPath(); ctx.arc(x, y - lift, Math.max(1.6, L.cell * 0.16), 0, Math.PI * 2); ctx.fill();
      } else {
        const n = Math.hypot(p.vx, p.vy) || 1;
        const len = L.cell * (p.type === 'bolt' ? 0.66 : 0.42);
        ctx.beginPath();
        ctx.moveTo(x - (p.vx / n) * len, y - lift - (p.vy / n) * len);
        ctx.lineTo(x, y - lift); ctx.stroke();
      }
    }

    // 战况底栏：粮草档位常驻（玩家要能管粮），士气等隐藏属性平时不摊开
    // 精确数值；只有跌到严重档才浮出一句「大概」的 debuff。
    // 精确系数与快进步数一律收在「军情细目 · 展开」里，不升格成一级 UI。
    const units = [...forces().inside, ...forces().camp];
    const ca = conditionLine(cfg, c, 'attack', units);
    const cd = conditionLine(cfg, c, 'defend', units);
    const narrow = W < 560;
    ctx.font = narrow ? '10px "WenQuanYi Micro Hei", serif'
      : '11px "WenQuanYi Micro Hei", serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba(narrow ? TEXT : GOLD, narrow ? 0.62 : 0.78);
    ctx.fillText(narrow
      ? `粮 · 攻${ca.grain.label} 守${cd.grain.label}`
      : `粮草 · 攻 ${ca.grain.label} · 守 ${cd.grain.label}`, 12, H - 14);
    // 严重时取更坏的一方，朱砂只用在告急这一处，不撒回全局。
    const worse = ca.tier >= cd.tier ? ca : cd;
    ctx.textAlign = 'right';
    if (worse.show) {
      ctx.fillStyle = rgba('#d05a4b', 0.92);
      ctx.fillText(narrow ? worse.label : `${worse.label} · ${worse.debuff}`,
        W - 12, H - 14);
    } else {
      ctx.fillStyle = rgba(TEXT, 0.5);
      ctx.fillText('军情如常', W - 12, H - 14);
    }
    ctx.textAlign = 'left';

    if (c.outcome) {
      const won = c.outcome.won;
      const bw = Math.min(W - 40, 360), bh = 54;
      const bx = (W - bw) / 2, by = H * 0.42;
      ctx.fillStyle = 'rgba(10,14,12,.88)'; ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = rgba(won ? GOLD : '#a63129', 0.9); ctx.lineWidth = 1.4;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.textAlign = 'center'; ctx.fillStyle = won ? rgba(GOLD, 0.95) : rgba('#e9a99d', 0.95);
      ctx.font = '600 17px "WenQuanYi Micro Hei", serif';
      ctx.fillText(won ? `城破 · ${c.outcome.reason}` : `退兵 · ${c.outcome.reason}`, W / 2, by + 12);
      ctx.font = '11px "WenQuanYi Micro Hei", serif'; ctx.fillStyle = rgba(TEXT, 0.72);
      ctx.fillText(`${formatCalendar(c.result?.endTurn ?? 0, cfg.calendar, 'date')} · 存活 ${c.result?.survivors ?? 0}`,
        W / 2, by + 34);
      ctx.textAlign = 'left';
    }
  }

  function drawOverlays(L, sec) {
    if (circle) {
      ctx.strokeStyle = rgba(GOLD, 0.95); ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(GOLD, 0.09); ctx.fill();
    }
    if (dragUnit) {
      const p = dragPos ?? unitXY(dragUnit);
      ctx.strokeStyle = rgba(GOLD, 0.9); ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(p.x, p.y, CV.unitPx * 0.8, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawHud(L) {
    // 固定屏幕像素字号，不随任何缩放变化 → 永远清晰
    const f = forces();
    ctx.font = '600 14px "WenQuanYi Micro Hei", serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = GOLD;
    ctx.fillText(`${cityOf()?.name ?? getCityId()} · ${campaign.cities[getCityId()]?.owner === playerFaction ? '我方城池' : '敌方城池'}`, 12, 8);
    ctx.font = '11px "WenQuanYi Micro Hei", serif';
    ctx.fillStyle = DIM;
    ctx.fillText(`城外大营 ${f.camp.length} 队`, 12, L.padTop + 6);
    ctx.fillText(`城内 ${f.inside.length} 队`, L.wallX + 18, 8);
    ctx.textAlign = 'right';
    ctx.fillText(`框选 ${selection.size} · 点位置自动列队 · 阵型 ${FORMATION_LABEL[formationShape]} ⇄`, W - 12, 8);
    ctx.textAlign = 'left';
    // 左下留给「粮草档位」，这句操作说明已在子界面抬头里写过，
    // 再画一行会和新底栏撞字（实拍确认）。
  }

  // ── 交互：只调兵，绝不平移 ───────────────────────────────────────────
  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e);
    // 命中单位永远优先：竖屏第一行兵可能正好落在 HUD 文字下方，不能被热区吃掉。
    const hit = hitUnit(p.x, p.y);
    // HUD 右上热区：只在没点到兵时生效，点一下循环切换阵型
    if (!hit && p.y < 20 && p.x > W - 200) {
      formationShape = FORMATIONS[(FORMATIONS.indexOf(formationShape) + 1) % FORMATIONS.length];
      callbacks.onFormationChange?.(formationShape);
      pointer = null; dragUnit = null; dragPos = null;
      return;
    }
    const u = hit;
    // 位移一律用 client 坐标：竖屏地址栏收起 / 软键盘会让 canvas rect 在
    // 按下与抬起之间漂移，两套坐标系算 dist 会把「单击」误判成「拖动部署」。
    pointer = { sx: p.x, sy: p.y, x: p.x, y: p.y,
      csx: e.clientX, csy: e.clientY, t: e.timeStamp, moved: 0, unit: u };
    dragUnit = u ?? null;
    dragPos = u ? { x: p.x, y: p.y } : null;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }, sig);

  canvas.addEventListener('pointermove', (e) => {
    if (!pointer) return;
    const p = local(e);
    pointer.moved = Math.max(pointer.moved,
      Math.hypot(e.clientX - pointer.csx, e.clientY - pointer.csy));
    pointer.x = p.x; pointer.y = p.y;
    if (dragUnit && dragPos) dragPos = { x: p.x, y: p.y };   // 兵跟着手指走
    if (!dragUnit && pointer.moved > CV.dragThresholdPx) {
      circle = {
        x: (pointer.sx + p.x) / 2, y: (pointer.sy + p.y) / 2,
        r: Math.max(CV.circleMinPx, Math.hypot(p.x - pointer.sx, p.y - pointer.sy) / 2),
      };
    }
  }, sig);

  canvas.addEventListener('pointerup', (e) => {
    if (!pointer) return;
    const P = pointer; pointer = null;
    const p = local(e);
    // 松手位置交给下一帧 syncMotion 当行军起点：兵从手指处走到目标格，不瞬移。
    if (dragUnit && dragPos) { releasePos = { x: p.x, y: p.y }; releaseId = dragUnit.id; }
    dragPos = null;
    const dist = Math.hypot(e.clientX - P.csx, e.clientY - P.csy);

    // 单击判定用 client 坐标，不受 canvas rect 在按下/抬起之间漂移影响。
    // 抬起时补一次命中测试：真机地址栏收起会让 down 与 up 的布局不同，
    // 只靠 down 的 hitUnit 会稳定漏选 —— up 命中以当前画面为准。
    const clicked = dragUnit ?? P.unit ??
      (dist <= CV.dragThresholdPx ? hitUnit(p.x, p.y) : null);

    // 优先级：拖单位部署 ＞ 框选后单击编队 ＞ 单击单兵接管 ＞ 短拖框选/定向 ＞ 单击清除
    // A) 拖单位 → 部署到大营 / 城内格
    if (dragUnit && dist > CV.dragThresholdPx) {
      const id = dragUnit.id;
      dragUnit = null;
      const t = screenToTarget(p.x, p.y);
      if (t.zone === 'inside' && P.unit?.zone === 'inside') {
        setUnitPath(id, { col: P.unit.col, row: P.unit.row }, { col: t.col, row: t.row });
      }
      callbacks.onDeploy(id, t.zone, t.col, t.row, P.unit);
      circle = null;
      return;
    }

    // B) 已有框选 + 单击 → 点这个位置，整队自动列队走过去。
    // 单兵接管（champion 非空）不算「框选一队」，单击仍是选人，避免一次点击被吃掉。
    if (dist <= CV.dragThresholdPx && selection.size > 0 && !champion) {
      const t = screenToTarget(p.x, p.y);
      const chosen = allUnits().filter((u) => selection.has(u.id));
      const occupied = new Set(allUnits()
        .filter((u) => !selection.has(u.id) && u.zone === 'inside')
        .map((u) => `${u.col}:${u.row}`));
      const res = assignFormation({
        units: chosen.map((u) => ({ id: u.id, zone: u.zone, col: u.col, row: u.row })),
        target: t, cols: CV.cols, rows: CV.rows, occupied,
        blocked: cityObstacles(cfg), shape: formationShape,
      });
      if (res.assignments.length) {
        callbacks.onFormationMove(res, t);
        // 动作闭环：列队完成后清空选择，下一次单击重新是「选人 / 清选择」
        selection = new Set(); champion = null; circle = null;
        for (const u of allUnits()) { u.selected = false; u.champion = false; }
        callbacks.onSelect([]);
        return;
      }
    }

    // C) 单击单位 → 单兵接管
    if (dist <= CV.dragThresholdPx && clicked) {
      dragUnit = null;
      champion = clicked.id;
      selection = new Set([clicked.id]);
      for (const u of allUnits()) { u.selected = u.id === champion; u.champion = u.id === champion; }
      callbacks.onChampion(champion);
      circle = null;
      return;
    }

    // D) 短拖 = 圆框选；若已有框选，这次的向量作为「往哪方向」
    if (dist > CV.dragThresholdPx) {
      if (selection.size > 0 && !circle) {
        callbacks.onDirection({ x: p.x - P.sx, y: p.y - P.sy }, [...selection]);
        circle = null;
        return;
      }
      const cx = (P.sx + p.x) / 2, cy = (P.sy + p.y) / 2;
      const rr = Math.max(CV.circleMinPx, dist / 2);
      const ids = [];
      for (const u of allUnits()) {
        const q = unitXY(u);
        if (Math.hypot(q.x - cx, q.y - cy) <= rr) ids.push(u.id);
      }
      selection = new Set(ids);
      champion = null;                 // 框选是「一队」，不再是单兵接管
      for (const u of allUnits()) {
        u.selected = selection.has(u.id); u.champion = false;
      }
      callbacks.onSelect(ids);
      circle = { x: cx, y: cy, r: rr };
      setTimeout(() => { circle = null; }, 800);
      return;
    }

    // E) 单击空白 = 清除选择
    circle = null;
    selection = new Set(); champion = null;
    for (const u of allUnits()) { u.selected = false; u.champion = false; }
    callbacks.onSelect([]);
    callbacks.onChampion(null);
  }, sig);
  for (const ev of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, () => {
      pointer = null; dragUnit = null; dragPos = null; circle = null;
    }, sig);
  }

  return {
    resize, draw,
    dispose() { ac.abort(); },
    get selection() { return [...selection]; },
    get champion() { return champion; },
    get layout() { return layout; },
    get viewport() { return { W, H, dpr, attrW: canvas.width, attrH: canvas.height }; },
    get motionCount() { return motion.size; },
    unitKind,
    setPaths(result) {
      for (const a of result?.assignments ?? []) {
        if (a.path && a.path.length > 1) pathByUnit.set(a.id, a.path);
      }
    },
    setUnitPath,
    motionOf: (id) => motion.get(id) ?? null,
    get portraits() { return portraits; },
    frameFor: (heading) => portraits.frameFor(heading),
    headingOf: (id) => lastHeading.get(id) ?? 0,
    get formationShape() { return formationShape; },
    setFormation: (v) => { if (FORMATIONS.includes(v)) formationShape = v; },
    assignFormationAt: (ids, target, shape) => {
      const chosen = allUnits().filter((u) => ids.includes(u.id));
      const occupied = new Set(allUnits()
        .filter((u) => !ids.includes(u.id) && u.zone === 'inside')
        .map((u) => `${u.col}:${u.row}`));
      return assignFormation({ units: chosen.map((u) => ({ id: u.id, zone: u.zone,
        col: u.col, row: u.row })), target, cols: CV.cols, rows: CV.rows,
        occupied, blocked: cityObstacles(cfg), shape: shape ?? formationShape });
    },
    renderPos, hitUnit,
    setCallbacks(cb) { callbacks = { ...callbacks, ...cb }; },
    unitXY, screenToTarget, forces,
  };
}
