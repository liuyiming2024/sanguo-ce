// 装配层：唯一引用 DOM / rAF 的地方。
// 大地图（可拖动、可缩放、只下指令）与城池小地图（固定视口、只调兵）是两个界面；
// 策略层回合日历与攻城会话的双时钟并行推进，互不阻塞。
import { createRng } from './rng.js?v=0.2.0';
import {
  createCampaign, dateLabel, advanceTurn, issueOrder, cancelOrder,
  collectResources, isHostile, cityOverview, getForces, deployUnit, makeUnits,
} from './campaign.js?v=0.2.0';
import { reachableTiles, hasAdjacentTerritory, routeCities, findRoute } from './pathfind.js?v=0.2.0';
import { createMapRenderer } from './map-render.js?v=0.2.0';
import { createCityView } from './city-view.js?v=0.2.0';
import {
  createSession, enterSession, leaveSession, tickSession, restoreSession,
} from './battle-session.js?v=0.2.0';
import { CITIES, cityById } from './map-data.js?v=0.2.0';
import { TYPE_LABEL } from './terrain.js?v=0.2.0';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const cityCanvas = $('cityCanvas');

let cfg, state, rng, renderer, cityView = null;
let session = null, snapshot = null, battleCityId = null;
let auto = true, accTurn = 0, last = 0, started = false;
let selection = null, selectedCity = null, toastTimer = null;

function toast(msg) {
  const n = $('toast');
  n.textContent = msg;
  n.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('show'), 2600);
}
function log(msg) {
  const box = $('log');
  const d = document.createElement('div');
  d.textContent = msg;
  box.prepend(d);
  while (box.children.length > 5) box.lastChild.remove();
}

// ── 出发城选择：直线距离最近的己方城（不每次跑 A*） ─────────────────────
function bestFromCity(tile) {
  const own = Object.values(state.cities).filter((c) => c.owner === state.playerFaction);
  if (!own.length) return { id: CITIES[0].id };
  const target = tile.cityId ? cityById(tile.cityId) : tile;
  const lon = target?.lon ?? (LON_MIN + tile.c / (state.terrain.cols - 1) * (LON_MAX - LON_MIN));
  const lat = target?.lat ?? (LAT_MAX - tile.r / (state.terrain.rows - 1) * (LAT_MAX - LAT_MIN));
  own.sort((a, b) => {
    const ca = cityById(a.id), cb = cityById(b.id);
    return Math.hypot(ca.lon - lon, ca.lat - lat) - Math.hypot(cb.lon - lon, cb.lat - lat);
  });
  return { id: own[0].id };
}
const LON_MIN = 112.75, LON_MAX = 116.15, LAT_MIN = 32.65, LAT_MAX = 36.65;

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
  $('orderCount').textContent = state.orders.filter((o) => o.faction === state.playerFaction).length;
  const owners = {};
  for (const c of CITIES) owners[c.id] = state.cities[c.id].owner;
  renderer.setCityOwners(owners);
  renderer.invalidateBorders();
  renderer.setOrders(state.orders);
  renderer.setReachable(reachableTiles(state.terrain, state.playerFaction, 1400));
  if (selection) showInfo(selection.c, selection.r);
  if (selectedCity) showCity(selectedCity);
  renderOrderList();
  refreshBattleUI();
}

const CMD_LABEL = {
  claim: '占领', develop: '屯田', buildFort: '筑垒', scout: '侦察',
  march: '出征', transfer: '调动', garrison: '驻守', withdraw: '撤兵',
  recruit: '征兵', fireDirectional: '齐射', stratagem: '计策',
};

function showInfo(c, r) {
  const d = renderer.describe(c, r);
  if (!d) return;
  selection = { c, r };
  renderer.setSelection(selection);
  $('infoCard').hidden = false;
  $('cityPanel').hidden = true;
  selectedCity = null;
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
    `<div class="note">${d.cityId ? (cityById(d.cityId)?.note ?? '') :
      d.cost >= 90 ? '山河阻隔，须经关隘或津渡。' : '占领需与己方领地相连；屯田/筑垒只能对己方地块。'}</div>`;

  const adjacent = hasAdjacentTerritory(state.terrain, state.playerFaction, c, r);
  const ownTile = d.owner === state.playerFaction;
  const hostileCity = d.cityId && isHostile(state, d.cityId, state.playerFaction);
  const ownCity = d.cityId && !hostileCity;
  const enable = {
    claim: !d.cityId && d.cost < 90 && !ownTile && adjacent,
    develop: ownTile && !d.cityId && d.cost < 90 && d.level < cfg.terrain.maxLandLevel,
    buildFort: ownTile && !d.cityId && d.cost < 90,
    scout: !!d.cityId,
    march: !!hostileCity,
    transfer: !!ownCity,
    garrison: !!ownCity,
    withdraw: !!d.cityId && (getForces(state, d.cityId).camp
      .some((u) => u.faction === state.playerFaction)),
  };
  for (const btn of $('tileCmds').querySelectorAll('button')) {
    btn.disabled = !enable[btn.dataset.cmd];
    const cost = cfg.orders.cost?.[btn.dataset.cmd];
    btn.title = cost ? Object.entries(cost).map(([k, v]) =>
      `${{ wood: '木', stone: '石', iron: '铁', grain: '粮' }[k]} ${v}`).join(' · ') : '';
  }
}

function showCity(cityId) {
  const o = cityOverview(state, cityId);
  if (!o) return;
  selectedCity = cityId;
  $('cityPanel').hidden = false;
  $('infoCard').hidden = true;
  const ownerF = cfg.factions.find((f) => f.id === o.owner);
  const meta = cityById(cityId);
  $('cityTitle').textContent = `${meta.name} · ${ownerF?.name ?? ''}`;
  const rows = [
    ['城池等级', meta.rank === 1 ? '都城' : meta.rank === 2 ? '郡治' : meta.rank === 3 ? '县邑' : '营垒'],
    ['人口', o.pop.toLocaleString()],
    ['守军', o.garrison.toLocaleString()],
    ['城防', Math.round(o.wall)],
    ['士气', o.morale],
    ['粮草', o.grain.toLocaleString()],
    ['城内部队', `${o.inside} 队`],
    ['城外大营', `${o.camp} 队`],
    ['垒寨', o.forts],
    ['状态', o.besieged ? '被围' : '安定'],
  ];
  $('cityBody').innerHTML = rows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') +
    `<div class="note" style="margin-top:8px;color:#8e9a8b;line-height:1.5">${meta.note}</div>`;
  const intel = $('cityIntel');
  if (o.intel && o.intel.owner !== state.playerFaction) {
    intel.hidden = false;
    intel.innerHTML = `斥候回报（第 ${o.intel.turn} 旬）：守军 ${o.intel.garrison.toLocaleString()} · 城防 ${o.intel.wall} · 士气 ${o.intel.morale}`;
  } else intel.hidden = true;
  $('recruitBtn').disabled = o.owner !== state.playerFaction;
  $('scoutCityBtn').disabled = o.owner === state.playerFaction;
  $('battleBtn').textContent = `进入${meta.name}`;
}

function renderOrderList() {
  const list = state.orders.filter((o) => o.faction === state.playerFaction);
  if (!list.length) { $('orderBody').innerHTML = '<div class="empty">暂无在途命令。</div>'; return; }
  $('orderBody').innerHTML = list.map((o) => {
    const dest = o.to ? cityById(o.to)?.name : o.tile ? `(${o.tile.c},${o.tile.r})` : '—';
    return `<div class="orderItem">
      <div class="head"><span>${CMD_LABEL[o.type] ?? o.type} → ${dest}</span><b>第 ${o.arriveTurn} 旬</b></div>
      <div class="sub">${o.path?.length ?? 0} 格 · ${(o.km ?? 0).toFixed(0)} km · 第 ${o.issuedTurn} 旬下令</div>
      <button data-cancel="${o.id}" type="button">撤令（退兵退资源）</button>
    </div>`;
  }).join('');
  for (const b of $('orderBody').querySelectorAll('[data-cancel]')) {
    b.addEventListener('click', () => {
      const r = cancelOrder(state, Number(b.dataset.cancel));
      toast(r.ok ? `已撤令，退还 ${r.refunded} 兵` : r.reason);
      refreshUI();
    });
  }
}

function refreshBattleUI() {
  if (!session) return;
  $('bTurn').textContent = state.turn;
  $('bCampaignSec').textContent = (state.turn * cfg.calendar.secPerTurn).toFixed(1);
  $('bSec').textContent = session.sec.toFixed(1);
  $('bSnapSec').textContent = snapshot ? snapshot.sec.toFixed(1) : '—';
  $('bFastSteps').textContent = session._lastFast ?? 0;
  $('bSteps').textContent = session.stepsRun;
  const f = getForces(state, session.cityId);
  $('bForces').textContent = `${f.inside.length} / ${f.camp.length}`;
  $('bMorale').textContent = `${Math.round(session.morale)} / ${Math.round(session.cityWall)}`;
  $('bMail').textContent = session.pendingOrders.length;
}

// ── 回合推进 ────────────────────────────────────────────────────────────
function doTurn() {
  const evs = advanceTurn(state, rng);
  for (const e of evs.slice(0, 5)) {
    const fn = cfg.factions.find((f) => f.id === e.faction)?.name;
    if (e.type === 'claim') log(`${fn} 占据 (${e.c},${e.r})`);
    else if (e.type === 'develop') log(`${fn} 屯田 → ${e.level} 级地`);
    else if (e.type === 'fort') log(`${fn} 筑垒寨 (${e.c},${e.r})`);
    else if (e.type === 'scout') log(`斥候回报 ${cityById(e.city)?.name}`);
    else if (e.type === 'battleOpen') log(`${cityById(e.city)?.name} 遭围`);
    else if (e.type === 'arriveEnemy') log(`援军 ${e.count} 抵 ${cityById(e.city)?.name} 城外扎营`);
    else if (e.type === 'arriveOwn') log(`部队 ${e.count} 入 ${cityById(e.city)?.name}`);
    else if (e.type === 'withdraw') log(`撤兵 ${e.count} 回营`);
    else if (e.type === 'aiClaim' || e.type === 'aiMarch') log(`${e.faction === 'yuan' ? '袁绍' : '刘备'} 下令`);
  }
  refreshUI();
}

// ── 大地图下命令 ────────────────────────────────────────────────────────
function sendCommand(type) {
  if (!selection) return;
  const d = renderer.describe(selection.c, selection.r);
  const from = bestFromCity(d.cityId ? { cityId: d.cityId } : { c: selection.c, r: selection.r }).id;
  const spec = { faction: state.playerFaction, from, type };
  if (d.cityId) spec.to = d.cityId; else spec.tile = { c: selection.c, r: selection.r };
  const TROOPS = { daodun: 500, gongnu: 300 };
  if (['march', 'transfer', 'garrison'].includes(type)) spec.units = { ...TROOPS };
  if (type === 'scout') spec.units = {};
  const r = issueOrder(state, spec);
  if (!r.ok) { toast(r.reason); return; }
  const dest = d.cityId ? cityById(d.cityId).name : `(${selection.c},${selection.r})`;
  toast(r.instant ? `${CMD_LABEL[type]}完成` :
    `${CMD_LABEL[type]} → ${dest}，第 ${r.order.arriveTurn} 旬抵达（${r.order.path.length} 格）`);
  log(`${CMD_LABEL[type]} ${dest}：${r.order.km?.toFixed(0) ?? 0}km / ${r.order.path?.length ?? 0} 格`);
  refreshUI();
}

// ── 城池小地图（攻城子界面） ────────────────────────────────────────────
function openBattle(cityId = selectedCity ?? battleCityId ?? CITIES[0].id) {
  battleCityId = cityId;
  if (!session || session.cityId !== cityId) {
    session = snapshot && snapshot.cityId === cityId
      ? restoreSession(cfg, state, snapshot)
      : createSession(cfg, state, cityId, { rngSnapshot: rng.snapshot() });
  }
  const r = enterSession(session, rng);
  if (!r.ok) { toast(r.reason); return; }
  session._lastFast = r.fastForwardSteps;
  const meta = cityById(cityId);
  const own = state.cities[cityId].owner === state.playerFaction;
  $('battleCity').textContent = meta.name;
  $('battleSide').textContent = own ? '我方城池 · 部队在城内' : '敌方城池 · 部队在城外扎营';
  $('battleTip').textContent = own
    ? '固定视口，不拖动：把城内部队拖到城外大营，或在城内重新布阵。'
    : '固定视口，不拖动：把城外大营的部队拖进城里 = 派人进去打；拖回大营 = 撤出。';
  $('battleOverlay').hidden = false;

  if (!cityView) {
    cityView = createCityView(cityCanvas, {
      cfg, campaign: state, getCityId: () => battleCityId,
      playerFaction: state.playerFaction,
    });
  }
  cityView.setCallbacks({
    onDeploy: (id, zone, col, row) => {
      const res = deployUnit(state, cityId, id, zone, col, row);
      toast(res.ok
        ? (zone === 'inside' ? '已投入城内' : '已撤回城外大营')
        : res.reason);
      refreshBattleUI();
    },
    onSelect: (ids) => { if (ids.length) toast(`框选 ${ids.length} 队 · 再拖一次指定方向`); },
    onDirection: (vec, ids) => {
      const from = bestFromCity({ cityId }).id;
      const res = issueOrder(state, {
        faction: state.playerFaction, from, type: 'fireDirectional',
        to: cityId, selection: ids, direction: vec,
      });
      toast(res.ok ? `定向指令下发 ${ids.length} 队（远程齐射 / 近战突击）` : res.reason);
      refreshUI();
    },
    onChampion: (id) => { if (id) toast('单兵接管：该单位已标记为主控'); },
  });
  cityView.resize();
  if (r.fastForwardSteps > 0) {
    toast(`离开期间策略走了若干旬，已空跑 ${r.fastForwardSteps} 步补齐`);
    log(`快进 ${r.fastForwardSteps} 步 → 战斗时刻 ${session.sec.toFixed(1)}s`);
  }
  refreshBattleUI();
}

function closeBattle() {
  if (!session) return;
  snapshot = leaveSession(session, rng);
  $('battleOverlay').hidden = true;
  toast(`已拍快照 @ ${snapshot.sec.toFixed(1)}s，策略日历继续走`);
  log(`退出城池，快照 ${snapshot.sec.toFixed(1)}s / 第 ${snapshot.campaignTurn} 旬`);
  refreshBattleUI();
}

// ── 大地图交互 ──────────────────────────────────────────────────────────
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
    if (drag.moved > 40) {
      canvas.classList.add('dragging');
      renderer.pan(dx, dy);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    canvas.classList.remove('dragging');
    const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    if (dist > 9) return;                 // 拖动 = 平移，不选中
    const p = renderer.screenToTile(e.clientX - d.rect.left, e.clientY - d.rect.top);
    if (!state.terrain.inBounds(p.c, p.r)) return;
    const tile = renderer.describe(p.c, p.r);
    if (tile.cityId) showCity(tile.cityId);
    else showInfo(p.c, p.r);
    renderer.setSelection({ c: p.c, r: p.r });
  });
  for (const ev of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, () => { drag = null; canvas.classList.remove('dragging'); });
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoom(e.deltaY < 0 ? 1.14 : 1 / 1.14, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
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
    renderer.camera.scale = 1.0;
    const home = CITIES.find((c) => c.owner === state.playerFaction) ?? CITIES[0];
    const p = state.terrain.tileAtGeo(home.lon, home.lat);
    renderer.camera.x = p.c * renderer.size.TP - canvas.clientWidth / 2;
    renderer.camera.y = p.r * renderer.size.TP - canvas.clientHeight / 2;
    renderer.clampCamera();
  });
  $('fitBtn').addEventListener('click', () => {
    const s = Math.min(canvas.clientWidth / renderer.size.W,
      canvas.clientHeight / renderer.size.H) * 0.97;
    renderer.camera.scale = Math.max(0.2, s);
    renderer.camera.x = (renderer.size.W - canvas.clientWidth / s) / 2;
    renderer.camera.y = (renderer.size.H - canvas.clientHeight / s) / 2;
    renderer.clampCamera();
  });
  $('battleBtn').addEventListener('click', () => openBattle());
  $('leaveBattle').addEventListener('click', closeBattle);
  $('closeBattleX').addEventListener('click', closeBattle);
  $('helpBtn').addEventListener('click', () => { $('helpPanel').hidden = false; });
  for (const id of ['closeHelp', 'closeHelpX']) {
    $(id).addEventListener('click', () => { $('helpPanel').hidden = true; });
  }
  $('closeInfoX').addEventListener('click', () => {
    $('infoCard').hidden = true; renderer.setSelection(null); selection = null;
  });
  $('closeCityX').addEventListener('click', () => {
    $('cityPanel').hidden = true; selectedCity = null;
  });
  $('closeOrderX').addEventListener('click', () => { $('orderList').hidden = true; });
  $('orderBtn').addEventListener('click', () => {
    renderOrderList();
    $('orderList').hidden = !$('orderList').hidden;
  });
  $('enterCityBtn').addEventListener('click', () => openBattle(selectedCity));
  $('recruitBtn').addEventListener('click', () => {
    if (!selectedCity) return;
    const r = issueOrder(state, { faction: state.playerFaction, from: selectedCity,
      type: 'recruit', units: { daodun: 500 } });
    toast(r.ok ? '征兵 +500（即时）' : r.reason);
    refreshUI();
  });
  $('scoutCityBtn').addEventListener('click', () => {
    if (!selectedCity) return;
    const from = bestFromCity({ cityId: selectedCity }).id;
    const r = issueOrder(state, { faction: state.playerFaction, from,
      type: 'scout', to: selectedCity });
    toast(r.ok ? `斥候出发，第 ${r.order.arriveTurn} 旬回报` : r.reason);
    refreshUI();
  });
  for (const btn of $('tileCmds').querySelectorAll('button')) {
    btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('helpPanel').hidden) { $('helpPanel').hidden = true; return; }
      if (!$('battleOverlay').hidden) { closeBattle(); return; }
      if (!$('orderList').hidden) { $('orderList').hidden = true; return; }
      if (!$('cityPanel').hidden) { $('cityPanel').hidden = true; selectedCity = null; return; }
      if (!$('infoCard').hidden) {
        $('infoCard').hidden = true; renderer.setSelection(null); selection = null; return;
      }
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
    $('centerBtn').click();
    $('mainMenu').hidden = true;
    started = true;
    collectResources(state);
    refreshUI();
    toast(`${cfg.factions.find((f) => f.id === state.playerFaction).name} · ${dateLabel(state)} · 点城池进布阵`);
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
    if (session?.active) {
      tickSession(session, realDt);
      refreshBattleUI();
    }
  }
  renderer.draw(ctx);
  // 城池小地图：固定视口、不拖动，相位取模拟时间（不用墙钟）
  if (cityView && !$('battleOverlay').hidden) cityView.draw(session?.sec ?? 0);
  requestAnimationFrame(frame);
}

// ── 启动 ────────────────────────────────────────────────────────────────
async function boot() {
  cfg = await fetch('./config/campaign.json?v=0.2.0').then((r) => r.json());
  rng = createRng(cfg.terrain.seed);
  state = createCampaign(cfg, { seed: cfg.terrain.seed });
  renderer = createMapRenderer(canvas, { terrain: state.terrain, cfg });
  renderer.worldFromScreen = (sx, sy) => ({
    x: renderer.camera.x + sx / renderer.camera.scale,
    y: renderer.camera.y + sy / renderer.camera.scale,
  });

  $('factionPick').innerHTML = cfg.factions.map((f) =>
    `<option value="${f.id}">${f.name}（${f.capital}）</option>`).join('');
  $('factionPick').value = 'cao';
  $('pickNote').textContent = `曹操 · 都城 许都 · 起始城池 ${CITIES.filter((c) => c.owner === 'cao').length} 座`;
  $('menuSub').textContent = `${cfg.meta.subtitle} · ${cfg.terrain.cols}×${cfg.terrain.rows} 栅格 · v${cfg.meta.version}`;
  renderer.resize();
  renderer.camera.scale = 1.0;
  window.addEventListener('resize', () => {
    renderer.resize();
    if (cityView) cityView.resize();
  });
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
    get cityView() { return cityView; },
    renderer,
    doTurn, issueOrder: (s) => issueOrder(state, s),
    cancelOrder: (id) => cancelOrder(state, id),
    deployUnit: (cityId, id, zone, col, row) => deployUnit(state, cityId, id, zone, col, row),
    openBattle, closeBattle,
    describe: (c, r) => renderer.describe(c, r),
    reachable: () => reachableTiles(state.terrain, state.playerFaction, 1400),
    cityOverview: (id) => cityOverview(state, id),
  };
}

boot().catch((err) => {
  $('menuSub').textContent = `加载失败：${err.message}`;
  console.error(err);
});
