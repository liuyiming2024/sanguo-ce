// 城池单独界面（小地图）。与大地图的关键区别：
//   · 固定视口，整张城内网格一屏放下 —— 不拖动、不缩放、不平移。
//   · 唯一交互是「调兵」：把单位在 城外大营 ↔ 城内 之间拖拽部署。
//   · 己方城池：部队初始在城内（布防）；敌方城池：部队初始在城外扎营（派人进去打）。
//   · 圆框选 + 二次拖拽定方向（全部远程单位齐射 / 近战突击）+ 单击单兵接管。
// 全部在主画布按屏幕像素绘制，不经过离屏缩放，所以不会糊。
//
// v0.7.1 移动端竖屏适配：canvas 属性尺寸严格等于 CSS 尺寸 × DPR（不再钳制到
// 320×260，否则位图被浏览器拉伸 → 手指点与画面系统性错位）；竖屏收窄大营、
// 单位图标与命中半径随 cell 自适应；hitUnit 取「最近单位」而不是倒序第一个，
// 否则窄屏相邻单位重叠时点 A 会选中 B。逻辑网格仍是 24×16，存档/部署不变。
import { CITIES } from './map-data.js';

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

  let dpr = 1, W = 800, H = 420;
  let layout = null;
  let circle = null, dragUnit = null, pointer = null;
  let selection = new Set(), champion = null;
  let callbacks = { onDeploy: () => {}, onSelect: () => {}, onDirection: () => {}, onChampion: () => {} };

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
    layout = { campW, wallX, innerX, innerW, cell, ox, oy, gridW, gridH, padTop, narrow };
    return true;
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
  function draw(sec = 0) {
    // 被动尺寸变化（地址栏收起、横竖屏、面板展开）未必会触发 resize 事件；
    // 每帧用 clientWidth 做一次轻量校验，发现位图与 CSS 尺寸不符就重建。
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0 &&
        (Math.abs(canvas.clientWidth - W) > 1 || Math.abs(canvas.clientHeight - H) > 1 ||
         canvas.width !== Math.round(canvas.clientWidth * dpr))) resize();
    if (!layout && !resize()) return;   // 容器还没布局好，等下一帧
    const L = layout;
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
    const p = unitXY(u);
    const def = cfg.units[u.type];
    const col = factionColor(u.faction);
    const s = Math.max(6, Math.min(CV.unitPx, L.cell * 0.82));
    const k = s / 20;
    const sel = selection.has(u.id);
    const bob = Math.sin(sec * 2.2 + u.col * 0.7 + u.row * 0.5) * 0.8 * k;

    // 地面投影
    ctx.fillStyle = rgba('#000000', 0.35);
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 9 * k, 6 * k, 2.2 * k, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // 披风
    ctx.fillStyle = rgba(col, 0.55);
    ctx.beginPath(); ctx.moveTo(-3 * k, -6 * k); ctx.lineTo(-8 * k, 7 * k);
    ctx.lineTo(-2 * k, 4 * k); ctx.closePath(); ctx.fill();
    // 躯干（粗描边 + 阵营色芯）
    ctx.strokeStyle = INK; ctx.lineWidth = 5.5 * k;
    ctx.beginPath(); ctx.moveTo(0, -5 * k); ctx.lineTo(0, 4 * k); ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.9); ctx.lineWidth = 2.6 * k;
    ctx.beginPath(); ctx.moveTo(0, -5 * k); ctx.lineTo(0, 4 * k); ctx.stroke();
    // 双腿
    ctx.strokeStyle = INK; ctx.lineWidth = 3.2 * k;
    ctx.beginPath();
    ctx.moveTo(0, 4 * k); ctx.lineTo(-4 * k, 10 * k);
    ctx.moveTo(0, 4 * k); ctx.lineTo(4 * k, 10 * k); ctx.stroke();
    // 头 + 盔
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(0, -9 * k, 4.4 * k, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgba('#cfc8ae', 0.9);
    ctx.beginPath(); ctx.arc(0, -9.5 * k, 3.1 * k, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0, -11 * k, 2.2 * k, 0, Math.PI * 2); ctx.fill();
    // 盔缨
    ctx.strokeStyle = col; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.moveTo(0, -13 * k); ctx.lineTo(2 * k, -17 * k); ctx.stroke();

    // 武器：按兵种区分，不靠文字标签
    ctx.strokeStyle = rgba('#d8cfae', 0.95); ctx.lineWidth = 2 * k;
    ctx.strokeStyle = '#e2ddc7';
    const proj = def?.projectile;
    if (u.type === 'junshi') {
      // 军师：羽扇
      ctx.fillStyle = rgba('#8fb5a0', 0.9);
      ctx.beginPath(); ctx.ellipse(6 * k, -4 * k, 4 * k, 2.6 * k, -0.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba('#e8dcb4', 0.8); ctx.lineWidth = 1 * k;
      ctx.beginPath(); ctx.moveTo(3 * k, -2 * k); ctx.lineTo(6 * k, -4 * k); ctx.stroke();
    } else if (proj === 'stone') {
      ctx.fillStyle = rgba('#9a9278', 0.95);
      ctx.fillRect(4 * k, -8 * k, 6 * k, 6 * k);
      ctx.strokeStyle = rgba('#e2ddc7', 0.8); ctx.lineWidth = 1.2 * k;
      ctx.beginPath(); ctx.moveTo(3 * k, 2 * k); ctx.lineTo(10 * k, -10 * k); ctx.stroke();
    } else if (proj === 'bolt') {
      ctx.strokeStyle = rgba('#cfc4a2', 0.95); ctx.lineWidth = 2.4 * k;
      ctx.beginPath(); ctx.moveTo(3 * k, 3 * k); ctx.lineTo(11 * k, -8 * k); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(8 * k, -6 * k); ctx.lineTo(12 * k, -5 * k); ctx.stroke();
    } else if (proj) {
      // 弓弩
      ctx.strokeStyle = rgba('#d8c89a', 0.95); ctx.lineWidth = 1.8 * k;
      ctx.beginPath(); ctx.arc(7 * k, -3 * k, 6 * k, -1.1, 1.1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(7 * k, -9 * k); ctx.lineTo(7 * k, 3 * k); ctx.stroke();
    } else if (u.type === 'changqiang') {
      ctx.strokeStyle = rgba('#d8cfae', 0.95); ctx.lineWidth = 1.8 * k;
      ctx.beginPath(); ctx.moveTo(5 * k, 10 * k); ctx.lineTo(9 * k, -15 * k); ctx.stroke();
      ctx.fillStyle = rgba('#e8dcb4', 0.95);
      ctx.beginPath(); ctx.moveTo(9 * k, -15 * k); ctx.lineTo(7 * k, -11 * k);
      ctx.lineTo(11 * k, -11 * k); ctx.closePath(); ctx.fill();
    } else if (u.type === 'zhongjia') {
      ctx.fillStyle = rgba('#a8a08a', 0.9);
      ctx.fillRect(-5 * k, -4 * k, 10 * k, 8 * k);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.2 * k;
      ctx.strokeRect(-5 * k, -4 * k, 10 * k, 8 * k);
    } else {
      // 刀盾
      ctx.fillStyle = rgba(col, 0.75);
      ctx.beginPath(); ctx.arc(-6 * k, -2 * k, 4 * k, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba('#e2ddc7', 0.95); ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.moveTo(4 * k, 6 * k); ctx.lineTo(9 * k, -11 * k); ctx.stroke();
    }
    ctx.restore();

    // 血条
    const hp = Math.max(0, u.hp / (u.maxHp || 1));
    ctx.fillStyle = rgba('#0b100e', 0.8);
    ctx.fillRect(p.x - 9 * k, p.y - 20 * k, 18 * k, 3 * k);
    ctx.fillStyle = hp > 0.5 ? rgba('#8fc27f', 0.95) : rgba('#e2a06b', 0.95);
    ctx.fillRect(p.x - 9 * k, p.y - 20 * k, 18 * k * hp, 3 * k);

    // 选中环 + champion 菱形
    if (sel || u.id === champion) {
      const pulse = 0.85 + Math.sin(sec * 4) * 0.15;
      ctx.strokeStyle = u.id === champion ? GOLD : rgba('#e8d9a8', 0.95);
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 10 * k, 10 * k * pulse, 4 * k * pulse, 0, 0, Math.PI * 2); ctx.stroke();
      if (u.id === champion) {
        ctx.fillStyle = GOLD;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 26 * k); ctx.lineTo(p.x + 4, p.y - 22 * k);
        ctx.lineTo(p.x, p.y - 18 * k); ctx.lineTo(p.x - 4, p.y - 22 * k); ctx.closePath(); ctx.fill();
      }
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
      const p = unitXY(dragUnit);
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
    ctx.fillText(`框选 ${selection.size} · 拖单位部署 · 再拖一次定方向`, W - 12, 8);
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba(TEXT, 0.7);
    ctx.font = '10px "WenQuanYi Micro Hei", serif';
    ctx.fillText('不拖动 · 不缩放 · 固定视口', 12, H - 16);
  }

  // ── 交互：只调兵，绝不平移 ───────────────────────────────────────────
  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e);
    const u = hitUnit(p.x, p.y);
    pointer = { sx: p.x, sy: p.y, x: p.x, y: p.y, t: e.timeStamp, moved: 0, unit: u };
    dragUnit = u ?? null;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }, sig);

  canvas.addEventListener('pointermove', (e) => {
    if (!pointer) return;
    const p = local(e);
    pointer.moved = Math.max(pointer.moved, Math.hypot(p.x - pointer.sx, p.y - pointer.sy));
    pointer.x = p.x; pointer.y = p.y;
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
    const dist = Math.hypot(p.x - P.sx, p.y - P.sy);

    // A) 拖单位 → 部署到大营 / 城内格
    if (dragUnit) {
      dragUnit = null;
      if (dist > CV.dragThresholdPx) {
        const t = screenToTarget(p.x, p.y);
        callbacks.onDeploy(dragUnit?.id ?? P.unit.id, t.zone, t.col, t.row, P.unit);
      } else {
        // 单击单位 = 单兵接管
        champion = P.unit.id;
        selection = new Set([P.unit.id]);
        for (const u of allUnits()) { u.selected = u.id === champion; u.champion = u.id === champion; }
        callbacks.onChampion(champion);
      }
      circle = null;
      return;
    }

    // B) 短拖 = 圆框选；若已有框选，这次的向量作为「往哪方向」
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
      for (const u of allUnits()) u.selected = selection.has(u.id);
      callbacks.onSelect(ids);
      circle = { x: cx, y: cy, r: rr };
      setTimeout(() => { circle = null; }, 800);
      return;
    }

    // C) 单击空白 = 清除选择
    circle = null;
    selection = new Set(); champion = null;
    for (const u of allUnits()) { u.selected = false; u.champion = false; }
    callbacks.onSelect([]);
    callbacks.onChampion(null);
  }, sig);
  for (const ev of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, () => { pointer = null; dragUnit = null; circle = null; }, sig);
  }

  return {
    resize, draw,
    dispose() { ac.abort(); },
    get selection() { return [...selection]; },
    get champion() { return champion; },
    get layout() { return layout; },
    get viewport() { return { W, H, dpr, attrW: canvas.width, attrH: canvas.height }; },
    hitUnit,
    setCallbacks(cb) { callbacks = { ...callbacks, ...cb }; },
    unitXY, screenToTarget, forces,
  };
}
