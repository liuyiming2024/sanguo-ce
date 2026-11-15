// 装配层：唯一引用 DOM / rAF / localStorage 的地方。
// 策略层（回合）与战斗层（固定步长实时）并行推进，互不阻塞。
import { createRng } from './rng.js?v=0.1.0';
import { createCampaign, dateLabel, advanceTurn, issueOrder, collectResources, isHostile } from './campaign.js?v=0.1.0';
import { reachableTiles, hasAdjacentTerritory, tilesPerTurn } from './pathfind.js?v=0.1.0';
import { createMapRenderer } from './map-render.js?v=0.1.0';
import { createSession, enterSession, leaveSession, tickSession, restoreSession } from './battle-session.js?v=0.1.0';
import { CITIES, cityById } from './map-data.js?v=0.1.0';
import { TYPE_LABEL } from './terrain.js?v=0.1.0';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');

let cfg, state, rng, renderer, session = null, snapshot = null;
let auto = true, accTurn = 0, last = 0, started = false;
let selection = null, pendingSelection = null;
let toastTimer = null;

function toast(msg) {
  const n = $('toast');
  n.textContent = msg;
  n.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('show'), 2400);
}

function log(msg) {
  const box = $('log');
  const d = document.createElement('div');
  d.textContent = msg;
  box.prepend(d);
  while (box.children.length > 5) box.lastChild.remove();
}

// ── UI 刷新 ─────────────────────────────────────────────────────────────
function refreshUI() {
  if (!state) return;
  $('date').textContent = dateLabel(state);
  $('clock').textContent = `第 ${state.turn} 旬`;
  const pf = cfg.factions.find((f) => f.id === state.playerFaction);
  $('factionTag').textContent = pf.name;
  $('factionTag').style.borderColor = pf.color;
  $('factionTag').style.color = pf.color;
  const r = state.resources[state.playerFaction] ?? { wood: 0, stone: 0, iron: 0, grain: 0, tiles: 0 };
  $('rWood').textContent = Math.round(r.wood);
  $('rStone').textContent = Math.round(r.stone);
  $('rIron').textContent = Math.round(r.iron);
  $('rGrain').textContent = Math.round(r.grain);
  $('rTiles').textContent = r.tiles;
  const owners = {};
  for (const c of CITIES) owners[c.id] = state.cities[c.id].owner;
  renderer.setCityOwners(owners);
  renderer.invalidateBorders();
  renderer.setOrders(state.orders);
  renderer.setReachable(reachableTiles(state.terrain, state.playerFaction, 1200));
  if (selection) showInfo(selection.c, selection.r);
}

function showInfo(c, r) {
  const d = renderer.describe(c, r);
  if (!d) return;
  selection = { c, r };
  renderer.setSelection(selection);
  $('infoCard').hidden = false;
  const ownerF = cfg.factions.find((f) => f.id === d.owner);
  $('infoTitle').textContent = d.name ? `${d.name} · ${d.label}` : `${d.label}（${c},${r}）`;
  const rows = [
    ['地形', d.label], ['底层地貌', TYPE_LABEL[d.base] ?? d.base],
    ['土地等级', `${d.level} 级`], ['高程', d.elev],
    ['通行代价', d.cost >= 90 ? '不可通行' : d.cost.toFixed(2)],
    ['归属', ownerF?.name ?? '无主'],
  ];
  $('infoBody').innerHTML =
    rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') +
    `<div class="yields">${['wood', 'stone', 'iron', 'grain'].map((k) =>
      `<div>${{ wood: '木', stone: '石', iron: '铁', grain: '粮' }[k]} <b>${d.yield[k].toFixed(1)}</b>/旬</div>`).join('')}</div>` +
    `<div class="note">${d.cityId ? `${cityById(d.cityId)?.note ?? ''}` :
      (d.cost >= 90 ? '山河阻隔，须经关隘或津渡。' : '占领需与己方领地相连，行军按地形逐格计时。')}</div>`;

  const canClaim = !d.cityId && d.cost < 90 && d.owner !== state.playerFaction &&
    hasAdjacentTerritory(state.terrain, state.playerFaction, c, r);
  $('claimBtn').disabled = !canClaim;
  $('marchBtn').disabled = !d.cityId || !isHostile(state, d.cityId, state.playerFaction);
  $('marchBtn').textContent = d.cityId ? `向${cityById(d.cityId).name}出征` : '向此城出征';
}

function refreshBattleUI() {
  if (!session) return;
  $('bTurn').textContent = state.turn;
  $('bCampaignSec').textContent = (state.turn * cfg.calendar.secPerTurn).toFixed(1);
  $('bSec').textContent = session.sec.toFixed(1);
  $('bSnapSec').textContent = snapshot ? snapshot.sec.toFixed(1) : '—';
  $('bFastSteps').textContent = session._lastFast ?? 0;
  $('bSteps').textContent = session.stepsRun;
  $('bMorale').textContent = Math.round(session.morale);
  $('bWall').textContent = Math.round(session.cityWall);
  $('bMail').textContent = session.pendingOrders.length;
}

// ── 回合推进 ────────────────────────────────────────────────────────────
function doTurn() {
  const evs = advanceTurn(state, rng);
  for (const e of evs.slice(0, 4)) {
    if (e.type === 'claim') log(`${cfg.factions.find((f) => f.id === e.faction)?.name} 占据 (${e.c},${e.r})`);
    else if (e.type === 'battleOpen') log(`${cityById(e.city)?.name} 遭围，攻城子界面已开启`);
    else if (e.type === 'arriveEnemy') log(`援军 ${e.count} 抵达 ${cityById(e.city)?.name}`);
    else if (e.type === 'arriveOwn') log(`友军 ${e.count} 抵达 ${cityById(e.city)?.name}`);
    else if (e.type === 'aiClaim' || e.type === 'aiMarch') log(`${e.faction === 'yuan' ? '袁绍' : '刘备'} 下令`);
  }
  refreshUI();
  refreshBattleUI();
}

// ── 攻城子界面：进入 / 退出 / 隔月再进 ──────────────────────────────────
function openBattle() {
  const target = CITIES.find((c) => state.cities[c.id].besieged) ??
    CITIES.find((c) => isHostile(state, c.id, state.playerFaction)) ?? CITIES[0];
  if (!session) {
    session = snapshot ? restoreSession(cfg, state, snapshot)
      : createSession(cfg, state, target.id, { rngSnapshot: rng.snapshot() });
  }
  const r = enterSession(session, rng);
  if (!r.ok) { toast(r.reason); return; }
  session._lastFast = r.fastForwardSteps;
  $('battleCity').textContent = cityById(session.cityId)?.name ?? '—';
  $('battleOverlay').hidden = false;
  if (r.fastForwardSteps > 0) {
    toast(`离开期间策略走了 ${state.turn - (snapshot?.campaignTurn ?? state.turn)} 旬，已空跑 ${r.fastForwardSteps} 步补齐`);
    log(`快进 ${r.fastForwardSteps} 步 → 战斗时刻 ${session.sec.toFixed(1)}s`);
  }
  refreshBattleUI();
}

function closeBattle() {
  if (!session) return;
  snapshot = leaveSession(session, rng);
  $('battleOverlay').hidden = true;
  toast(`已拍快照 @ ${snapshot.sec.toFixed(1)}s，策略日历继续走`);
  log(`退出战场，快照 ${snapshot.sec.toFixed(1)}s / 第 ${snapshot.campaignTurn} 旬`);
  refreshBattleUI();
}

// ── 交互 ────────────────────────────────────────────────────────────────
let drag = null;
function bindPointer() {
  canvas.addEventListener('pointerdown', (e) => {
    if (!started) return;
    const rect = canvas.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
      t: e.timeStamp, rect, moved: 0, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy));
    // 长距离拖动 = 平移；短距离先画圆预览
    if (drag.moved > 140) {
      canvas.classList.add('dragging');
      renderer.pan(dx, dy);
      renderer.setCircle(null);
    } else if (drag.moved > 12) {
      const w = renderer.worldFromScreen(drag.sx - drag.rect.left, drag.sy - drag.rect.top);
      const cur = renderer.worldFromScreen(e.clientX - drag.rect.left, e.clientY - drag.rect.top);
      renderer.setCircle({ x: (w.x + cur.x) / 2, y: (w.y + cur.y) / 2,
        r: Math.max(12, Math.hypot(cur.x - w.x, cur.y - w.y) / 2) });
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    canvas.classList.remove('dragging');
    const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    const dur = e.timeStamp - d.t;
    if (dist > 140 || dur > 900) { renderer.setCircle(null); return; }  // 平移结束
    if (dist > 12) {
      // 短拖 = 圆框选；若上一次已有框选，这次拖的向量作为「往哪方向」
      const w = renderer.worldFromScreen(d.sx - d.rect.left, d.sy - d.rect.top);
      const cur = renderer.worldFromScreen(e.clientX - d.rect.left, e.clientY - d.rect.top);
      if (pendingSelection) {
        const dir = { x: cur.x - w.x, y: cur.y - w.y };
        const r = issueOrder(state, {
          faction: state.playerFaction, from: fromCityForSelection().id,
          to: state.cities[pendingSelection.cityId] ? pendingSelection.cityId : null,
          type: 'fireDirectional', selection: pendingSelection.ids,
          direction: dir, units: {},
        });
        toast(r.ok ? `定向指令已下发（${pendingSelection.ids.length} 个单位）` : r.reason);
        pendingSelection = null;
        renderer.setCircle(null);
        refreshUI();
        return;
      }
      const cx = (w.x + cur.x) / 2, cy = (w.y + cur.y) / 2;
      const rr = Math.max(14, Math.hypot(cur.x - w.x, cur.y - w.y) / 2);
      const TP = renderer.size.TP;
      const ids = [];
      const c0 = Math.floor((cx - rr) / TP), c1 = Math.ceil((cx + rr) / TP);
      const r0 = Math.floor((cy - rr) / TP), r1 = Math.ceil((cy + rr) / TP);
      for (let c = Math.max(0, c0); c <= Math.min(state.terrain.cols - 1, c1); c++) {
        for (let r = Math.max(0, r0); r <= Math.min(state.terrain.rows - 1, r1); r++) {
          const tc = c * TP + TP / 2, tr = r * TP + TP / 2;
          if (Math.hypot(tc - cx, tr - cy) <= rr) ids.push(`${c},${r}`);
        }
      }
      pendingSelection = { ids, cityId: null };
      toast(`圈选 ${ids.length} 格 · 再拖一次指定方向（所有远程单位齐射）`);
      setTimeout(() => renderer.setCircle(null), 700);
      return;
    }
    // 单击选格
    renderer.setCircle(null);
    const p = renderer.screenToTile(e.clientX - d.rect.left, e.clientY - d.rect.top);
    if (state.terrain.inBounds(p.c, p.r)) showInfo(p.c, p.r);
  });
  for (const ev of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, () => { drag = null; canvas.classList.remove('dragging'); renderer.setCircle(null); });
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
}

function fromCityForSelection() {
  return Object.values(state.cities).find((c) => c.owner === state.playerFaction) ??
    { id: CITIES[0].id };
}

function bindUI() {
  $('endTurn').addEventListener('click', () => { accTurn = 0; doTurn(); });
  $('autoBtn').addEventListener('click', () => {
    auto = !auto;
    $('autoBtn').setAttribute('aria-pressed', String(auto));
    $('autoBtn').textContent = auto ? '自动推进 开' : '自动推进 关';
  });
  $('zoomIn').addEventListener('click', () => renderer.zoom(1.2));
  $('zoomOut').addEventListener('click', () => renderer.zoom(1 / 1.2));
  $('centerBtn').addEventListener('click', () => {
    renderer.camera.scale = Math.max(0.55, Math.min(1.1, canvas.clientHeight / renderer.size.H * 1.4));
    renderer.camera.x = (renderer.size.W - canvas.clientWidth / renderer.camera.scale) / 2;
    renderer.camera.y = (renderer.size.H - canvas.clientHeight / renderer.camera.scale) / 2;
    renderer.clampCamera();
  });
  $('battleBtn').addEventListener('click', openBattle);
  $('leaveBattle').addEventListener('click', closeBattle);
  $('closeBattleX').addEventListener('click', closeBattle);
  $('helpBtn').addEventListener('click', () => { $('helpPanel').hidden = false; });
  for (const id of ['closeHelp', 'closeHelpX']) {
    $(id).addEventListener('click', () => { $('helpPanel').hidden = true; });
  }
  $('closeInfoX').addEventListener('click', () => {
    $('infoCard').hidden = true; renderer.setSelection(null); selection = null;
  });
  $('claimBtn').addEventListener('click', () => {
    if (!selection) return;
    const from = fromCityForSelection();
    const r = issueOrder(state, {
      faction: state.playerFaction, from: from.id, type: 'claim',
      tile: { c: selection.c, r: selection.r }, units: { daodun: 300 },
    });
    if (!r.ok) { toast(r.reason); return; }
    toast(`已下令占地，预计第 ${r.order.arriveTurn} 旬抵达（${r.order.path.length} 格）`);
    log(`铺路命令 → (${selection.c},${selection.r})，${r.order.km.toFixed(0)}km / ${r.order.turns} 旬`);
    refreshUI();
  });
  $('marchBtn').addEventListener('click', () => {
    if (!selection) return;
    const d = renderer.describe(selection.c, selection.r);
    if (!d?.cityId) return;
    const from = fromCityForSelection();
    const r = issueOrder(state, {
      faction: state.playerFaction, from: from.id, to: d.cityId, type: 'march',
      units: { daodun: 800, gongnu: 500 },
    });
    if (!r.ok) { toast(r.reason); return; }
    toast(`出征令已下，预计第 ${r.order.arriveTurn} 旬抵达`);
    log(`出征 ${cityById(d.cityId).name}：${r.order.km.toFixed(0)}km / ${r.order.turns} 旬 / ${r.order.path.length} 格`);
    refreshUI();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('helpPanel').hidden) { $('helpPanel').hidden = true; return; }
      if (!$('battleOverlay').hidden) { closeBattle(); return; }
      if (!$('infoCard').hidden) { $('infoCard').hidden = true; renderer.setSelection(null); selection = null; return; }
    }
    if (!started) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); accTurn = 0; doTurn(); }
    if (e.key === 'b' || e.key === 'B') {
      $('battleOverlay').hidden ? openBattle() : closeBattle();
    }
  });

  $('factionPick').addEventListener('change', () => {
    const f = cfg.factions.find((v) => v.id === $('factionPick').value);
    $('pickNote').textContent = `${f.name} · 都城 ${f.capital} · 起始城池 ${CITIES.filter((c) => c.owner === f.id).length} 座`;
  });
  $('startBtn').addEventListener('click', () => {
    state.playerFaction = $('factionPick').value;
    // 视角对准玩家都城
    const home = CITIES.find((c) => c.owner === state.playerFaction) ?? CITIES[0];
    const p = state.terrain.tileAtGeo(home.lon, home.lat);
    renderer.camera.scale = 1.15;
    renderer.camera.x = p.c * renderer.size.TP - canvas.clientWidth / 2 / 1.15;
    renderer.camera.y = p.r * renderer.size.TP - canvas.clientHeight / 2 / 1.15;
    renderer.clampCamera();
    $('mainMenu').hidden = true;
    started = true;
    rng.resume?.();
    collectResources(state);
    refreshUI();
    toast(`${cfg.factions.find((f) => f.id === state.playerFaction).name} · ${dateLabel(state)}`);
  });
}

// ── 主循环：两端并行 ────────────────────────────────────────────────────
function frame(now) {
  const realDt = last ? Math.min(0.25, (now - last) / 1000) : 0;
  last = now;
  if (started) {
    if (auto) {
      accTurn += realDt;
      const per = cfg.calendar.secPerTurn;
      let guard = 0;
      while (accTurn >= per && guard++ < 4) { accTurn -= per; doTurn(); }
    }
    // 战斗层：只有子界面打开时才实时跑；退出后完全静止，靠 enterSession 快进补齐。
    if (session?.active) {
      tickSession(session, realDt);
      refreshBattleUI();
    }
  }
  renderer.draw(ctx);
  requestAnimationFrame(frame);
}

// ── 启动 ────────────────────────────────────────────────────────────────
async function boot() {
  cfg = await fetch('./config/campaign.json?v=0.1.0').then((r) => r.json());
  rng = createRng(cfg.terrain.seed);
  state = createCampaign(cfg, { seed: cfg.terrain.seed });
  renderer = createMapRenderer(canvas, { terrain: state.terrain, cfg });
  // 渲染层补一个屏幕→世界像素的换算，供框选圆使用
  renderer.worldFromScreen = (sx, sy) => ({
    x: renderer.camera.x + sx / renderer.camera.scale,
    y: renderer.camera.y + sy / renderer.camera.scale,
  });
  $('factionPick').innerHTML = cfg.factions.map((f) =>
    `<option value="${f.id}">${f.name}（${f.capital}）</option>`).join('');
  $('factionPick').value = 'cao';
  $('pickNote').textContent = `曹操 · 都城 许都 · 起始城池 ${CITIES.filter((c) => c.owner === 'cao').length} 座`;
  $('menuSub').textContent = `${cfg.meta.subtitle} · ${cfg.terrain.cols}×${cfg.terrain.rows} 栅格`;
  renderer.resize();
  window.addEventListener('resize', () => renderer.resize());
  bindPointer();
  bindUI();
  collectResources(state);
  refreshUI();
  requestAnimationFrame(frame);

  window.__sanguo = {
    get state() { return state; },
    get cfg() { return cfg; },
    get session() { return session; },
    get snapshot() { return snapshot; },
    renderer,
    doTurn, issueOrder: (s) => issueOrder(state, s),
    openBattle, closeBattle,
    describe: (c, r) => renderer.describe(c, r),
    reachable: () => reachableTiles(state.terrain, state.playerFaction, 1200),
    tilesPerTurn: () => tilesPerTurn(cfg, state.terrain),
  };
}

boot().catch((err) => {
  $('menuSub').textContent = `加载失败：${err.message}`;
  console.error(err);
});
