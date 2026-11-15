// 装配层 v0.3.0：唯一引用 DOM / rAF / localStorage 的地方。
// 策略层（campaign）、战斗层（battle-session）、地形（terrain）仍是纯逻辑；
// 界面外壳（ui-shell）只做展示与导航；存档（persist）只做序列化。
import { createRng, rngFromSnapshot } from './rng.js?v=0.3.0';
import {
  createCampaign, dateLabel, advanceTurn, issueOrder, cancelOrder,
  collectResources, isHostile, cityOverview, getForces, deployUnit,
} from './campaign.js?v=0.3.0';
import {
  reachableTiles, hasAdjacentTerritory, routeCities,
} from './pathfind.js?v=0.3.0';
import { createMapRenderer } from './map-render.js?v=0.3.0';
import { createCityView } from './city-view.js?v=0.3.0';
import {
  createSession, enterSession, leaveSession, tickSession, restoreSession,
} from './battle-session.js?v=0.3.0';
import { CITIES, cityById } from './map-data.js?v=0.3.0';
import { TYPE_LABEL } from './terrain.js?v=0.3.0';
import { createShell, facilityCost } from './ui-shell.js?v=0.3.0';
import {
  serializeGame, deserializeGame, saveToStorage, readFromStorage, clearStorage,
} from './persist.js?v=0.3.0';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const cityCanvas = $('cityCanvas');
const LON_MIN = 112.75, LON_MAX = 116.15, LAT_MIN = 32.65, LAT_MAX = 36.65;

let cfg, uiData, state, rng, renderer, cityView = null, shell = null;
let session = null, snapshot = null, battleCityId = null;
let auto = true, accTurn = 0, last = 0, started = false, dirty = true;
let selection = null, selectedCity = null, toastTimer = null, saveTick = 0;
let reports = [];

const heroById = (id) => uiData?.heroes.find((h) => h.id === id) ?? null;
const faction = () => cfg.factions.find((f) => f.id === state.playerFaction);
const R = () => state.resources[state.playerFaction];
const markDirty = () => { dirty = true; };

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
  markDirty();
}
function pushReport(r) {
  reports.unshift({ turn: state?.turn ?? 0, red: false, ...r });
  if (reports.length > 200) reports.length = 200;
  if (state) state.reports = reports;
  markDirty();
}

// ── 新局初始化（boot / 新开一局 / 势力选择共用） ─────────────────────────
function newCampaign(factionId) {
  const s = createCampaign(cfg, { playerFaction: factionId, seed: cfg.terrain.seed });
  s.facilities = Object.fromEntries(uiData.facilities.map((f) => [f.id, f.lv]));
  const roster = {
    cao: ['caocao', 'xiahou', 'xuchu'],
    yuan: ['yuanshao', 'yanliang', 'wenchou'],
    liu: ['liubei', 'guanyu', null],
  }[factionId] ?? ['caocao', 'xiahou', 'xuchu'];
  s.armies = [
    { slots: [...roster], stamina: 100 },
    { slots: [null, null, null], stamina: 100 },
    { slots: [null, null, null], stamina: 100 },
  ];
  s.copper = 1200;
  s.settings = { idleStop: true, snap: true };
  s.claimedTasks = [];
  s.reports = [];
  collectResources(s, { apply: false });   // 只算流量，开局库存保持 0
  return s;
}

// ── 出发城：直线距离最近的己方城（不每次跑 A*） ─────────────────────────
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

// ── 存档 ────────────────────────────────────────────────────────────────
function saveGame(silent = false) {
  const data = serializeGame({
    cfg, state, rng, snapshot,
    ui: { auto, camera: { ...renderer.camera }, battleCityId },
  });
  const ok = saveToStorage(data);
  if (!silent) toast(ok ? `已保存 · 第 ${state.turn} 旬` : '本机存储不可用，未能保存');
  return ok;
}
function autoSave(force = false) {
  if (!started) return;
  if (!force && ++saveTick % 3 !== 0) return;
  try { saveGame(true); } catch { /* 存储不可用不影响游戏 */ }
}
function loadGame() {
  const raw = readFromStorage();
  if (!raw) { toast('没有找到存档'); return false; }
  const r = deserializeGame(cfg, raw);
  if (!r) { toast('存档版本不兼容'); return false; }
  state = r.state;
  rng = rngFromSnapshot(r.rngSnapshot ?? { state: 0, calls: 0 });
  snapshot = r.snapshot ?? null;
  reports = (state.reports ?? []).slice();
  state.reports = reports;
  state.claimedTasks ??= [];
  state.settings ??= { idleStop: true, snap: true };
  auto = r.ui?.auto ?? true;
  battleCityId = r.ui?.battleCityId ?? null;
  // terrain 换了实例，渲染器与城池视图都要重建。
  if (cityView) { cityView.dispose(); cityView = null; }
  renderer = createMapRenderer(canvas, { terrain: state.terrain, cfg });
  if (r.ui?.camera) { Object.assign(renderer.camera, r.ui.camera); renderer.clampCamera(); }
  session = snapshot ? restoreSession(cfg, state, snapshot) : null;
  $('autoBtn').setAttribute('aria-pressed', String(auto));
  $('autoBtn').textContent = auto ? '自' : '停';
  $('mainMenu').hidden = true;
  started = true;
  refreshUI();
  markDirty();
  toast(`已继续上一局 · ${dateLabel(state)}`);
  log(`读取存档：${dateLabel(state)}，领地 ${state.terrain.tiles.filter((t) => t.owner === state.playerFaction).length} 格`);
  return true;
}

// ── UI 刷新 ─────────────────────────────────────────────────────────────
function refreshUI() {
  if (!state) return;
  $('date').textContent = dateLabel(state);
  $('clock').textContent = `第 ${state.turn} 旬`;
  const pf = faction();
  $('factionTag').textContent = pf.name;
  $('factionTag').style.borderColor = pf.color;
  $('factionTag').style.color = pf.color;
  const r = R() ?? { wood: 0, stone: 0, iron: 0, grain: 0 };
  $('rWood').textContent = Math.round(r.wood).toLocaleString('zh-CN');
  $('rStone').textContent = Math.round(r.stone).toLocaleString('zh-CN');
  $('rIron').textContent = Math.round(r.iron).toLocaleString('zh-CN');
  $('rGrain').textContent = Math.round(r.grain).toLocaleString('zh-CN');
  const land = state.terrain.tiles.reduce((a, t) => a + (t.owner === state.playerFaction ? 1 : 0), 0);
  $('rTiles').textContent = land.toLocaleString('zh-CN');
  $('hudPower').textContent = (land * 12 + CITIES.filter((c) => state.cities[c.id].owner === state.playerFaction).length * 300).toLocaleString('zh-CN');
  $('hudCopper').textContent = Math.round(state.copper ?? 0).toLocaleString('zh-CN');
  const w = uiData.weather[state.turn % uiData.weather.length];
  $('hudWeather').textContent = w;
  $('hudOrder').textContent = `${Math.min(20, 20 - state.orders.filter((o) => o.faction === state.playerFaction).length)}/20`;
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
  if (shell?.depth > 0) shell.render();
  markDirty();
}

const CMD_LABEL = {
  claim: '占领', develop: '屯田', buildFort: '筑垒', scout: '侦察',
  march: '出征', transfer: '调动', garrison: '驻守', withdraw: '撤兵',
  recruit: '征兵', fireDirectional: '齐射', stratagem: '计策', reinforce: '增援',
};
const RES_LABEL = { wood: '木', stone: '石', iron: '铁', grain: '粮' };

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
    ['土地等级', `${d.level} 级`], ['通行代价', d.cost >= 90 ? '不可通行' : d.cost.toFixed(2)],
    ['归属', ownerF?.name ?? '无主'],
  ];
  $('infoBody').innerHTML =
    rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') +
    `<div class="yields">${['wood', 'stone', 'iron', 'grain'].map((k) =>
      `<div>${RES_LABEL[k]} <b>${d.yield[k].toFixed(1)}</b>/旬</div>`).join('')}</div>` +
    `<div class="note">${d.cityId ? (cityById(d.cityId)?.note ?? '') :
      d.cost >= 90 ? '山河阻隔，须经关隘或津渡。' : '占领需与己方领地相连；屯田 / 筑垒只能对己方地块。'}</div>`;

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
    withdraw: !!d.cityId && getForces(state, d.cityId).camp.some((u) => u.faction === state.playerFaction),
  };
  for (const btn of $('tileCmds').querySelectorAll('button')) {
    btn.disabled = !enable[btn.dataset.cmd];
    const cost = cfg.orders.cost?.[btn.dataset.cmd];
    btn.title = cost ? Object.entries(cost).map(([k, v]) => `${RES_LABEL[k] ?? k} ${v}`).join(' · ') : '';
  }
  markDirty();
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
    ['人口', o.pop.toLocaleString('zh-CN')], ['守军', o.garrison.toLocaleString('zh-CN')],
    ['城防', Math.round(o.wall)], ['士气', o.morale], ['粮草', o.grain.toLocaleString('zh-CN')],
    ['城内部队', `${o.inside} 队`], ['城外大营', `${o.camp} 队`],
    ['垒寨', o.forts], ['状态', o.besieged ? '被围' : '安定'],
  ];
  $('cityBody').innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') +
    `<div class="note" style="margin-top:8px;color:var(--dim);line-height:1.5">${meta.note ?? ''}</div>`;
  const intel = $('cityIntel');
  if (o.intel && o.intel.owner !== state.playerFaction) {
    intel.hidden = false;
    intel.innerHTML = `斥候回报（第 ${o.intel.turn} 旬）：守军 ${o.intel.garrison.toLocaleString('zh-CN')} · 城防 ${o.intel.wall} · 士气 ${o.intel.morale}`;
  } else intel.hidden = true;
  $('recruitBtn').disabled = o.owner !== state.playerFaction;
  $('scoutCityBtn').disabled = o.owner === state.playerFaction;
  $('battleBtn').title = `进入${meta.name}布阵`;
  markDirty();
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
  for (const e of evs.slice(0, 6)) {
    const fn = cfg.factions.find((f) => f.id === e.faction)?.name ?? '';
    if (e.type === 'claim') { log(`${fn} 占据 (${e.c},${e.r})`); pushReport({ title: `占据土地 (${e.c},${e.r})`, tag: '占领', sub: fn, body: `第 ${state.turn} 旬，${fn} 于 (${e.c},${e.r}) 插旗，领地相连。` }); }
    else if (e.type === 'develop') { log(`${fn} 屯田 → ${e.level} 级地`); pushReport({ title: `屯田完成 · ${e.level} 级地`, tag: '内政', sub: `(${e.c},${e.r})`, body: '产出已按新等级重算。' }); }
    else if (e.type === 'fort') { log(`${fn} 筑垒寨 (${e.c},${e.r})`); pushReport({ title: '垒寨落成', tag: '内政', sub: `(${e.c},${e.r})`, body: '通行代价下降，可作为前进据点。' }); }
    else if (e.type === 'scout') { log(`斥候回报 ${cityById(e.city)?.name}`); pushReport({ title: `斥候回报 · ${cityById(e.city)?.name}`, tag: '侦察', sub: '第 ' + state.turn + ' 旬', body: '守军、城防、士气与归属情报已写入军情卷。' }); }
    else if (e.type === 'battleOpen') { log(`${cityById(e.city)?.name} 遭围`); pushReport({ title: `${cityById(e.city)?.name} 遭围`, tag: '战报', red: true, sub: '第 ' + state.turn + ' 旬', body: '先头部队已抵城外扎营，攻城子界面已开启。' }); }
    else if (e.type === 'arriveEnemy') { log(`援军 ${e.count} 抵 ${cityById(e.city)?.name} 城外扎营`); pushReport({ title: `援军抵达 · ${cityById(e.city)?.name}`, tag: '行军', sub: `${e.count} 兵`, body: '部队在城外大营待命，可进入城池布阵派人进城。' }); }
    else if (e.type === 'arriveOwn') log(`部队 ${e.count} 入 ${cityById(e.city)?.name}`);
    else if (e.type === 'withdraw') log(`撤兵 ${e.count} 回营`);
    else if (e.type === 'aiClaim' || e.type === 'aiMarch') log(`${fn || '敌方'} 下令`);
  }
  refreshUI();
  autoSave();
}

// ── 大地图下命令 ────────────────────────────────────────────────────────
function sendCommand(type) {
  if (!selection) return;
  const d = renderer.describe(selection.c, selection.r);
  const from = bestFromCity(d.cityId ? { cityId: d.cityId } : { c: selection.c, r: selection.r }).id;
  const spec = { faction: state.playerFaction, from, type };
  if (d.cityId) spec.to = d.cityId;
  else spec.tile = { c: selection.c, r: selection.r };
  const TROOPS = { daodun: 500, gongnu: 300 };
  if (['march', 'transfer', 'garrison'].includes(type)) spec.units = { ...TROOPS };
  const r = issueOrder(state, spec);
  if (!r.ok) { toast(r.reason); return; }
  const dest = d.cityId ? cityById(d.cityId).name : `(${selection.c},${selection.r})`;
  toast(r.instant ? `${CMD_LABEL[type]}完成` : `${CMD_LABEL[type]} → ${dest}，第 ${r.order.arriveTurn} 旬抵达`);
  log(`${CMD_LABEL[type]} ${dest}：${r.order.km?.toFixed(0) ?? 0} km / ${r.order.path?.length ?? 0} 格`);
  refreshUI();
}

// ── 界面 actions（ui-shell 唯一回调出口） ───────────────────────────────
const actions = {
  getAuto: () => auto,
  setAuto(v) {
    auto = v;
    $('autoBtn').setAttribute('aria-pressed', String(auto));
    $('autoBtn').textContent = auto ? '自' : '停';
    refreshUI();
  },
  getSetting: (k) => !!state.settings?.[k],
  setSetting(k, v) { state.settings[k] = v; markDirty(); refreshUI(); },

  upgradeFacility(id) {
    const f = uiData.facilities.find((x) => x.id === id);
    if (!f) return { ok: false, reason: '设施不存在' };
    const lv = state.facilities[id] ?? f.lv;
    if (lv >= f.max) return { ok: false, reason: '已升至最高等级' };
    const core = state.facilities.chengzhufu ?? 0;
    if (f.need > 0 && core < f.need) return { ok: false, reason: `需城主府 ${f.need} 级` };
    const cost = facilityCost(f, lv);
    const pool = R();
    for (const [k, v] of Object.entries(cost)) {
      if ((pool[k] ?? 0) < v) return { ok: false, reason: `${RES_LABEL[k] ?? k} 不足（需 ${v}）` };
    }
    for (const [k, v] of Object.entries(cost)) pool[k] -= v;
    state.facilities[id] = lv + 1;
    collectResources(state, { apply: false });   // 只刷新流量，不重复入账
    toast(`${f.name} 升至 Lv.${lv + 1}`);
    pushReport({ title: `${f.name} 升级 · Lv.${lv + 1}`, tag: '内政', sub: f.effect, body: '升级效果立即生效，资源产量已按新等级重算。' });
    refreshUI();
    return { ok: true };
  },

  assignHero(army, slot, heroId) {
    const h = heroById(heroId);
    if (!h || !state.armies[army]) return;
    for (const a of state.armies) {
      const i = a.slots.indexOf(heroId);
      if (i >= 0) a.slots[i] = null;
    }
    state.armies[army].slots[slot] = heroId;
    toast(`${h.name} 已编入第 ${army + 1} 部队`);
    refreshUI();
  },

  issueMarch({ army = 0, cityId = null, tile = null }) {
    const a = state.armies[army] ?? state.armies[0];
    if (!a?.slots?.[0]) return { ok: false, reason: '大营未配置武将' };
    if ((a.stamina ?? 100) < 20) return { ok: false, reason: '体力不足（需 20）' };
    const troops = a.slots.reduce((x, id) => x + (heroById(id)?.troops ?? 0), 0);
    const src = cityId ? bestFromCity({ cityId }).id
      : bestFromCity({ c: tile.c, r: tile.r }).id;
    let spec;
    let destName;
    if (cityId) {
      destName = cityById(cityId)?.name ?? cityId;
      spec = {
        faction: state.playerFaction, from: src, to: cityId,
        type: isHostile(state, cityId, state.playerFaction) ? 'march' : 'transfer',
        units: { daodun: Math.round(troops * 0.6), gongnu: Math.round(troops * 0.4) },
      };
    } else if (tile) {
      destName = `(${tile.c},${tile.r})`;
      spec = { faction: state.playerFaction, from: src, type: 'claim', tile };
    } else return { ok: false, reason: '没有指定目标' };
    const r = issueOrder(state, spec);
    if (!r.ok) return r;
    a.stamina = Math.max(0, (a.stamina ?? 100) - 20);
    toast(`第 ${army + 1} 部队出征 ${destName}，第 ${r.order.arriveTurn} 旬抵达`);
    log(`出征 ${destName}：${troops} 兵 / ${(r.order.km ?? 0).toFixed(0)} km`);
    pushReport({ title: `出征 · ${destName}`, tag: '出征', sub: `第 ${army + 1} 部队 · ${troops} 兵`,
      body: `${r.order.path?.length ?? 0} 格 / ${(r.order.km ?? 0).toFixed(0)} km，预计第 ${r.order.arriveTurn} 旬抵达。行军前三分钟可撤兵。` });
    refreshUI();
    return { ok: true };
  },

  claimTask(id) {
    if ((state.claimedTasks ?? []).includes(id)) return;
    const pool = R();
    pool.wood = (pool.wood ?? 0) + 2000;
    pool.stone = (pool.stone ?? 0) + 1200;
    pool.grain = (pool.grain ?? 0) + 1200;
    state.copper = (state.copper ?? 0) + 500;
    state.claimedTasks.push(id);
    toast('任务奖励已领取');
    refreshUI();
  },
  donate(kind, n) {
    const pool = R();
    if ((pool[kind] ?? 0) < n) { toast(`${RES_LABEL[kind] ?? kind} 不足`); return; }
    pool[kind] -= n;
    state.copper = (state.copper ?? 0) + 80;
    toast(`已捐献 ${RES_LABEL[kind] ?? kind} ${n}`);
    refreshUI();
  },
  quick(id) {
    const pool = R();
    const mainCity = CITIES.find((c) => state.cities[c.id]?.owner === state.playerFaction);
    if (id === 'tax') {
      const gain = 200 + 120 * (state.facilities.minju ?? 0);
      state.copper = (state.copper ?? 0) + gain;
      toast(`税收 +${gain} 铜钱`);
    } else if (id === 'trade') {
      if ((pool.wood ?? 0) < 1000) { toast('木材不足 1000'); return; }
      pool.wood -= 1000; pool.stone = (pool.stone ?? 0) + 800;
      toast('以木 1000 换石 800（损耗 20%）');
    } else if (id === 'hold') {
      for (const c of CITIES) {
        if (state.cities[c.id]?.owner === state.playerFaction) {
          state.cities[c.id].wall = Math.min(cfg.city.wallStart, state.cities[c.id].wall + 15);
        }
      }
      toast('全境坚守：城防 +15，持续 3 旬');
    } else if (id === 'recruit') {
      if ((pool.grain ?? 0) < 1500) { toast('粮草不足 1500'); return; }
      pool.grain -= 1500;
      if (mainCity) state.cities[mainCity.id].garrison += 500;
      state.stats.recruits++;
      toast(`征兵 +500 · ${mainCity?.name ?? ''}`);
    }
    refreshUI();
  },
  focusCity(id) {
    const c = cityById(id);
    if (!c) return;
    const p = state.terrain.tileAtGeo(c.lon, c.lat);
    renderer.camera.scale = Math.max(renderer.camera.scale, 0.9);
    renderer.camera.x = p.c * renderer.size.TP - canvas.clientWidth / 2 / renderer.camera.scale;
    renderer.camera.y = p.r * renderer.size.TP - canvas.clientHeight / 2 / renderer.camera.scale;
    renderer.clampCamera();
    markDirty();
  },
  saveGame: () => saveGame(),
  loadGame,
  newGame() { clearStorage(); location.reload(); },
  deleteSave() { clearStorage(); toast('存档已删除'); },
  openHelp() { $('helpPanel').hidden = false; },
};

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
  $('battleCity').textContent = meta?.name ?? cityId;
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
      toast(res.ok ? (zone === 'inside' ? '已投入城内' : '已撤回城外大营') : res.reason);
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
  markDirty();
}

function closeBattle() {
  if (!session) return;
  snapshot = leaveSession(session, rng);
  $('battleOverlay').hidden = true;
  toast(`已拍快照 @ ${snapshot.sec.toFixed(1)}s，策略日历继续走`);
  log(`退出城池，快照 ${snapshot.sec.toFixed(1)}s / 第 ${snapshot.campaignTurn} 旬`);
  refreshBattleUI();
  autoSave(true);
  markDirty();
}

// ── 大地图交互：单指平移 / 双指捏合 / 点击吸附 ─────────────────────────
const pointers = new Map();
let drag = null, pinch = null;
function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, rect: r };
}
function snapTile(p) {
  if (!state.settings?.snap || window.innerWidth > 720) return p;
  const cur = state.terrain.at(p.c, p.r);
  if (cur && cur.cost < 90) return p;
  let best = p, cost = Infinity;
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    const c = p.c + dc, r = p.r + dr;
    if (!state.terrain.inBounds(c, r)) continue;
    const t = state.terrain.at(c, r);
    if (t && t.cost < 90 && t.cost < cost) { cost = t.cost; best = { c, r }; }
  }
  return best;
}
function bindPointer() {
  canvas.addEventListener('pointerdown', (e) => {
    if (!started) return;
    const p = localPos(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        scale: renderer.camera.scale,
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
        camX: renderer.camera.x, camY: renderer.camera.y,
      };
      drag = null;
      canvas.classList.remove('dragging');
    } else if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
        t: e.timeStamp, rect: p.rect, moved: 0, id: e.pointerId };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = localPos(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const next = Math.max(0.42, Math.min(2.8, pinch.scale * (d / pinch.dist)));
      const wx = pinch.camX + pinch.cx / pinch.scale;
      const wy = pinch.camY + pinch.cy / pinch.scale;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      renderer.camera.scale = next;
      renderer.camera.x = wx - mx / next;
      renderer.camera.y = wy - my / next;
      renderer.clampCamera();
      markDirty();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy));
    if (drag.moved > 12) { canvas.classList.add('dragging'); renderer.pan(dx, dy); markDirty(); }
  });

  canvas.addEventListener('pointerup', (e) => {
    const d = drag;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;      // 还有手指在屏上，不当作点击
    drag = null;
    canvas.classList.remove('dragging');
    if (!d) return;
    const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    if (dist > 9) return;               // 拖动 = 平移，不选中
    const p = renderer.screenToTile(e.clientX - d.rect.left, e.clientY - d.rect.top);
    const hit = snapTile(p);
    if (!state.terrain.inBounds(hit.c, hit.r)) return;
    const tile = renderer.describe(hit.c, hit.r);
    if (tile.cityId) showCity(tile.cityId);
    else showInfo(hit.c, hit.r);
    renderer.setSelection({ c: hit.c, r: hit.r });
    markDirty();
  });
  for (const ev of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) drag = null;
      canvas.classList.remove('dragging');
    });
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoom(e.deltaY < 0 ? 1.14 : 1 / 1.14, e.clientX - rect.left, e.clientY - rect.top);
    markDirty();
  }, { passive: false });
}

// ── 控件绑定 ────────────────────────────────────────────────────────────
function bindUI() {
  $('endTurn').addEventListener('click', () => { accTurn = 0; doTurn(); });
  $('autoBtn').addEventListener('click', () => actions.setAuto(!auto));
  $('zoomIn').addEventListener('click', () => { renderer.zoom(1.2); markDirty(); });
  $('zoomOut').addEventListener('click', () => { renderer.zoom(1 / 1.2); markDirty(); });
  $('centerBtn').addEventListener('click', () => {
    renderer.camera.scale = 1.0;
    const home = CITIES.find((c) => c.owner === state.playerFaction) ?? CITIES[0];
    const p = state.terrain.tileAtGeo(home.lon, home.lat);
    renderer.camera.x = p.c * renderer.size.TP - canvas.clientWidth / 2;
    renderer.camera.y = p.r * renderer.size.TP - canvas.clientHeight / 2;
    renderer.clampCamera(); markDirty();
  });
  $('fitBtn').addEventListener('click', () => {
    const s = Math.min(canvas.clientWidth / renderer.size.W,
      canvas.clientHeight / renderer.size.H) * 0.97;
    renderer.camera.scale = Math.max(0.2, s);
    renderer.camera.x = (renderer.size.W - canvas.clientWidth / s) / 2;
    renderer.camera.y = (renderer.size.H - canvas.clientHeight / s) / 2;
    renderer.clampCamera(); markDirty();
  });
  $('battleBtn').addEventListener('click', () => openBattle());
  $('leaveBattle').addEventListener('click', closeBattle);
  $('closeBattleX').addEventListener('click', closeBattle);
  $('helpBtn').addEventListener('click', () => { $('helpPanel').hidden = false; });
  $('hudSystem').addEventListener('click', () => shell.navigate('system'));
  for (const id of ['closeHelp', 'closeHelpX']) {
    $(id).addEventListener('click', () => { $('helpPanel').hidden = true; });
  }
  $('closeInfoX').addEventListener('click', () => {
    $('infoCard').hidden = true; renderer.setSelection(null); selection = null; markDirty();
  });
  $('closeCityX').addEventListener('click', () => { $('cityPanel').hidden = true; selectedCity = null; });
  $('closeOrderX').addEventListener('click', () => { $('orderList').hidden = true; });
  $('orderBtn').addEventListener('click', () => {
    renderOrderList(); $('orderList').hidden = !$('orderList').hidden;
  });
  $('enterCityBtn').addEventListener('click', () => openBattle(selectedCity));
  $('marchCityBtn').addEventListener('click', () => {
    if (!selectedCity) return;
    const from = bestFromCity({ cityId: selectedCity }).id;
    const ri = routeCities(state.terrain, from, selectedCity, cfg);
    shell.navigate('march', {
      cityId: selectedCity, army: 0,
      km: ri.km ?? 0, turns: ri.turns ?? cfg.orders.minArriveTurn, adjacent: true,
    });
  });
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
    const r = issueOrder(state, { faction: state.playerFaction, from, type: 'scout', to: selectedCity });
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
      if (shell?.depth > 0) { shell.back(); return; }
      if (!$('orderList').hidden) { $('orderList').hidden = true; return; }
      if (!$('cityPanel').hidden) { $('cityPanel').hidden = true; selectedCity = null; return; }
      if (!$('infoCard').hidden) {
        $('infoCard').hidden = true; renderer.setSelection(null); selection = null; return;
      }
    }
    if (!started) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); accTurn = 0; doTurn(); }
    if (e.key === 'b' || e.key === 'B') $('battleOverlay').hidden ? openBattle() : closeBattle();
  });

  $('factionPick').addEventListener('change', () => {
    const f = cfg.factions.find((v) => v.id === $('factionPick').value);
    $('pickNote').textContent = `${f.name} · 都城 ${f.capital} · 起始城池 ${CITIES.filter((c) => c.owner === f.id).length} 座`;
  });
  $('startBtn').addEventListener('click', () => {
    const fid = $('factionPick').value;
    state = newCampaign(fid);
    renderer = createMapRenderer(canvas, { terrain: state.terrain, cfg });
    reports = []; state.reports = reports;
    session = null; snapshot = null; battleCityId = null;
    $('centerBtn').click();
    $('mainMenu').hidden = true;
    started = true;
    refreshUI();
    toast(`${faction().name} · ${dateLabel(state)} · 点城池进布阵`);
  });
  $('continueBtn').addEventListener('click', () => loadGame());

  document.addEventListener('visibilitychange', () => { if (document.hidden) autoSave(true); });
  window.addEventListener('pagehide', () => autoSave(true));
  window.addEventListener('resize', () => {
    renderer.resize();
    if (cityView) cityView.resize();
    markDirty();
  });
}

// ── 主循环：两端并行；静止时可停绘 ─────────────────────────────────────
function frame(now) {
  const realDt = last ? Math.min(0.25, (now - last) / 1000) : 0;
  last = now;
  const battleOpen = !$('battleOverlay').hidden;
  if (started) {
    if (auto) {
      accTurn += realDt;
      const per = cfg.calendar.secPerTurn;
      let guard = 0;
      while (accTurn >= per && guard++ < 4) { accTurn -= per; doTurn(); }
    }
    if (session?.active) { tickSession(session, realDt); refreshBattleUI(); }
  }
  const needDraw = !state?.settings?.idleStop || dirty || battleOpen || session?.active;
  if (needDraw) { renderer.draw(ctx); dirty = false; }
  if (cityView && battleOpen) cityView.draw(session?.sec ?? 0);
  requestAnimationFrame(frame);
}

// ── 启动 ────────────────────────────────────────────────────────────────
async function boot() {
  [cfg, uiData] = await Promise.all([
    fetch('./config/campaign.json?v=0.3.0').then((r) => r.json()),
    fetch('./config/ui-data.json?v=0.3.0').then((r) => r.json()),
  ]);
  rng = createRng(cfg.terrain.seed);
  state = newCampaign('cao');
  renderer = createMapRenderer(canvas, { terrain: state.terrain, cfg });
  shell = createShell({ cfg, uiData, actions, getState: () => state, getReports: () => reports });

  $('factionPick').innerHTML = cfg.factions.map((f) =>
    `<option value="${f.id}">${f.name}（${f.capital}）</option>`).join('');
  $('factionPick').value = 'cao';
  $('pickNote').textContent = `曹操 · 都城 许都 · 起始城池 ${CITIES.filter((c) => c.owner === 'cao').length} 座`;
  $('menuSub').textContent = `${cfg.meta.subtitle} · ${cfg.terrain.cols}×${cfg.terrain.rows} 栅格 · v${cfg.meta.version}`;

  const raw = readFromStorage();
  if (raw && raw.v === 1) {
    const d = new Date(raw.savedAt ?? Date.now());
    $('saveTip').hidden = false;
    $('saveTip').textContent = `本机存档：第 ${raw.turn} 旬 · ${raw.playerFaction === 'cao' ? '曹操' : raw.playerFaction === 'yuan' ? '袁绍' : '刘备'} · ${d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    $('continueBtn').hidden = false;
  }

  renderer.resize();
  renderer.camera.scale = 1.0;
  bindPointer();
  bindUI();
  refreshUI();
  requestAnimationFrame(frame);

  window.__sanguo = {
    get state() { return state; },
    get cfg() { return cfg; },
    get uiData() { return uiData; },
    get renderer() { return renderer; },
    get session() { return session; },
    get snapshot() { return snapshot; },
    get cityView() { return cityView; },
    get shell() { return shell; },
    get reports() { return reports; },
    get auto() { return auto; },
    doTurn, refreshUI,
    issueOrder: (s) => issueOrder(state, s),
    cancelOrder: (id) => cancelOrder(state, id),
    deployUnit: (cityId, id, zone, col, row) => deployUnit(state, cityId, id, zone, col, row),
    openBattle, closeBattle, saveGame, loadGame,
    describe: (c, r) => renderer.describe(c, r),
    reachable: () => reachableTiles(state.terrain, state.playerFaction, 1400),
    cityOverview: (id) => cityOverview(state, id),
    actions,
  };
}

boot().catch((err) => {
  $('menuSub').textContent = `加载失败：${err.message}`;
  console.error(err);
});
