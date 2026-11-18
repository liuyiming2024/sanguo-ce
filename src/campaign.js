// 策略层：纯逻辑，不引用 DOM / canvas / localStorage，可在 node --test 里整局推演。
// 地图是 144×108 真实地理栅格；资源按「已占领地块的时产」聚合，不是按城拍脑袋。
// 与战斗层唯一耦合是 mailbox：带 atSec 时间戳的事件队列，战斗层按累计秒数消费。
import { CITIES, ROADS, cityById, routeByCities, neighbors } from './map-data.js';
import { createTerrain } from './terrain.js';
import { calendarLabel, calendarParts, formatCalendar } from './calendar.js';
import { createCommandLog, createActorRegistry, appendCommand } from './sync.js';
import {
  routeCities, findRoute, hasAdjacentTerritory, claimTile, tilesPerTurn,
} from './pathfind.js';
import { generalFor, facilityLevel } from './generals.js';
import { cityObstacles, nearestFree } from './siege-grid.js';

export function createCampaign(cfg, { playerFaction = 'cao', seed = 20261114 } = {}) {
  const terrain = createTerrain(cfg);
  const cities = {};
  for (const c of CITIES) {
    cities[c.id] = {
      id: c.id, owner: c.owner, pop: c.pop, wall: c.wall,
      garrison: Math.round(c.pop * cfg.city.popToTroopRatio),
      grain: Math.round(c.pop * 2.4),
      morale: cfg.hidden.moraleStart,
      fatigue: 0, alert: cfg.hidden.alertStart, formation: cfg.hidden.formationStart,
      commander: { name: `${c.name}守将`, faction: c.owner, state: 'inOffice', capturedBy: null },
      besieged: false, battleId: null,
    };
  }
  const resources = {};
  for (const f of cfg.factions) resources[f.id] = { wood: 0, stone: 0, iron: 0, grain: 0 };

  const state = {
    cfg, turn: 0, playerFaction, rngSeed: seed, terrain,
    cities, resources,
    yield: {},              // 每旬流量（显示用），resources 是可花费的累积库存
    orders: [],
    mailbox: [],
    // 城池小地图的部队池：己方城放 inside（城内布防），敌方城放 camp（城外扎营）。
    // 每个 unit 是独立实体，供框选 / 拖拽部署 / 单兵控制 / 存活数结算。
    forces: {},        // cityId -> { inside: [unit], camp: [unit] }
    intel: {},         // cityId -> { turn, garrison, wall, morale }（侦察结果）
    forts: [],         // { c, r, faction, turn } 前线垒寨
    // 界面层共用、但要跟着存档走的状态：设施等级 / 部队编成 / 铜钱 / 设置。
    // 全部是纯 JSON，逻辑层依旧不引用 DOM / localStorage。
    facilities: {},
    armies: [],
    copper: 0,
    claimedTasks: [],
    reports: [],
    // 章回剧情：身份由剧情给定（司空府参军事），不做势力三选一。
    chapter: 'ch1',
    storyBaseline: { cities: Object.values(cities).filter((c) => c.owner === playerFaction).length,
      land: terrain.tiles.filter((t) => t.owner === playerFaction).length },
    storyFlags: {},
    storyChoices: {},
    chapterHistory: [],
    storyMails: [],
    // 多人地基：actor 注册 + 带序号的命令日志 + rng 调用数。
    actors: createActorRegistry(cfg, playerFaction),
    commandLog: createCommandLog(seed),
    rngCalls: 0,
    settings: { idleStop: true, snap: true },
    nextOrderId: 1, nextForceId: 1, nextUnitId: 1, nextBattleId: 1,
    battles: {},
    stats: {
      turns: 0, ordersIssued: 0, arrivals: 0, tilesClaimed: 0,
      battlesOpened: 0, battlesClosed: 0, recruits: 0, aiOrders: 0,
      scouts: 0, develops: 0, forts: 0, cancelled: 0, deployed: 0,
      byType: {},
    },
  };

  // 开局把各城守军展开成小地图里的独立实体：全部在城内。
  // 玩家后续出征抵达敌城，部队才进「城外大营」（见抵达结算）。
  for (const city of CITIES) {
    const n = Math.min(2400, Math.round(state.cities[city.id].garrison * 0.35));
    state.forces[city.id] = {
      inside: makeUnits(state, {
        daodun: Math.round(n * 0.6), gongnu: Math.round(n * 0.25),
        changqiang: Math.round(n * 0.15),
      }, city.owner, 'inside', city.id),
      camp: [],
    };
  }
  return state;
}

/** 建安五年二月上旬起，1 回合 = 1 旬。 */
export function dateLabel(state, style = 'short') {
  return calendarLabel(state, style);
}
export { calendarParts, formatCalendar };

export function elapsedSec(state) {
  return state.turn * state.cfg.calendar.secPerTurn;
}

export function cityHidden(state, id) {
  const c = state.cities[id];
  return {
    morale: c.morale, fatigue: c.fatigue, grain: c.grain,
    alert: c.alert, formation: c.formation,
  };
}

export function troopCap(state, id) {
  const cfg = state.cfg;
  const lv = facilityLevel(state, id);
  const gen = generalFor(cfg, state, id);
  const F = cfg.facilities.effects;
  const k = 1 + lv * 0.01 + (gen.command - 50) / cfg.generals.effects.commandTroopCapDiv;
  return Math.round(state.cities[id].pop * cfg.city.popToTroopRatio * k);
}

function pushMail(state, e) {
  state.mailbox.push({ id: state.nextOrderId++, ...e });
  state.mailbox.sort((a, b) => a.atSec - b.atSec || a.id - b.id);
}

/** 城池易主时同步栅格归属，否则「地图上的颜色」和「策略层的归属」会分叉。 */
function syncCityOwner(state, cityId, faction) {
  const info = state.terrain.cityTiles[cityId];
  if (!info) return;
  const rad = info.rad + state.cfg.terrain.cityRadiusTiles;
  for (let dr = -rad; dr <= rad; dr++) {
    for (let dc = -rad; dc <= rad; dc++) {
      const t = state.terrain.at(info.c + dc, info.r + dr);
      if (t) t.owner = faction;
    }
  }
}

/**
 * 下达命令。所有命令都带 arriveTurn，绝不即时生效（recruit 例外）。
 * claim = 率土式占地块（需连地）；march = 城→城出征，走 A* 逐格计时。
 */
function recordOrder(state, spec, order) {
  (state.stats.byType ??= {})[spec.type] = (state.stats.byType[spec.type] ?? 0) + 1;
  appendCommand(state.commandLog, {
    turn: state.turn,
    actor: spec.faction ?? state.playerFaction,
    type: 'issueOrder',
    payload: { ...spec, orderId: order?.id ?? null },
    rngBefore: state.rngCalls, rngAfter: state.rngCalls,
  });
}

export function issueOrder(state, spec) {
  const { faction, from, units = {}, type = 'march' } = spec;
  const cfg = state.cfg;
  const src = state.cities[from];
  if (!src) return { ok: false, reason: '出发城不存在' };
  if (src.owner !== faction) return { ok: false, reason: '该城不归此势力' };
  if (!cfg.orders.types.includes(type)) return { ok: false, reason: `未知命令 ${type}` };
  if (state.orders.filter((o) => o.faction === faction).length >=
      cfg.orders.maxConcurrentPerFaction) {
    return { ok: false, reason: '在途命令已达上限' };
  }
  const total = Object.values(units).reduce((a, b) => a + b, 0);

  // ── 即时指令：征兵 ───────────────────────────────────────────────────
  if (type === 'recruit') {
    const cost = Math.round(total * 3);
    if (src.grain < cost) return { ok: false, reason: '粮草不足' };
    src.grain -= cost;
    src.garrison += total;
    state.stats.recruits++;
    state.stats.ordersIssued++;
    recordOrder(state, spec, null);
    return { ok: true, instant: true, cost };
  }

  // ── 城内战斗指令：齐射 / 计策，直接投邮箱，不走大地图 A* ─────────────
  if (type === 'fireDirectional' || type === 'stratagem') {
    const arriveTurn = state.turn + cfg.orders.minArriveTurn;
    const order = {
      id: state.nextOrderId++, type, faction, from, to: spec.to ?? from,
      units: {}, path: [], cost: 0, km: 0,
      issuedTurn: state.turn, arriveTurn,
      atSec: arriveTurn * cfg.calendar.secPerTurn,
      selection: spec.selection ?? [], direction: spec.direction ?? null,
      stratagem: spec.stratagem ?? null,
    };
    state.orders.push(order);
    state.stats.ordersIssued++;
    recordOrder(state, spec, order);
    return { ok: true, order };
  }

  // 资源开销在几何/连地/兵员校验通过后才检查，避免「粮不足」掩盖真正的规则错误。
  const cost = cfg.orders.cost?.[type] ?? null;

  const g = state.terrain.cityCenter(from);
  if (!g?.gate) return { ok: false, reason: '出发城无城门' };
  const start = { c: g.gate[0], r: g.gate[1] };

  const TILE_CMDS = ['claim', 'develop', 'buildFort'];
  const CITY_CMDS = ['march', 'transfer', 'garrison', 'scout', 'withdraw', 'reinforce'];
  let target, dest = null, routeInfo;

  if (TILE_CMDS.includes(type)) {
    const t = spec.tile;
    if (!t) return { ok: false, reason: '缺少目标地块' };
    if (!state.terrain.inBounds(t.c, t.r)) return { ok: false, reason: '地块越界' };
    const tile = state.terrain.at(t.c, t.r);
    if (tile.cost >= 90) return { ok: false, reason: '地形不可通行' };
    if (type === 'claim') {
      if (!hasAdjacentTerritory(state.terrain, faction, t.c, t.r)) {
        return { ok: false, reason: '目标地块未与己方领地相连（需先铺路）' };
      }
      if (tile.owner === faction) return { ok: false, reason: '已是己方领地' };
    } else if (tile.owner !== faction) {
      return { ok: false, reason: '只能对己方地块屯田 / 筑垒' };
    }
    if (type === 'buildFort' && tile.fort) return { ok: false, reason: '此处已有垒寨' };
    target = { c: t.c, r: t.r };
    routeInfo = findRoute(state.terrain, start, target, cfg);
  } else if (CITY_CMDS.includes(type)) {
    dest = state.cities[spec.to];
    if (!dest) return { ok: false, reason: '目标城不存在' };
    if ((type === 'transfer' || type === 'garrison') && dest.owner !== faction) {
      return { ok: false, reason: '调动 / 驻守只能对己方城池' };
    }
    if (type === 'march' && dest.owner === faction) {
      return { ok: false, reason: '己方城池请用「调动」' };
    }
    // 增援是对已在打的敌城继续投兵；抵达时与 march 同路径（部队进大营 + 邮箱 reinforce）
    if (type === 'reinforce' && dest.owner === faction) {
      return { ok: false, reason: '增援只能对敌方城池' };
    }
    routeInfo = routeCities(state.terrain, from, spec.to, cfg);
    if (routeInfo.ok) target = routeInfo.path[routeInfo.path.length - 1];
  } else {
    return { ok: false, reason: `命令 ${type} 未接线` };
  }
  if (!routeInfo?.ok) return { ok: false, reason: routeInfo?.reason ?? '无路可通' };

  // 兵员校验：插旗不扣兵；撤退是从大营收兵，也不扣出发城守军。
  const free = ['claim', 'withdraw', 'scout'];
  if (!free.includes(type) && !(total > 0)) return { ok: false, reason: '没有派兵' };
  if (!free.includes(type) && src.garrison < total) return { ok: false, reason: '守军不足' };

  if (cost) {
    const pool = state.resources[faction];
    for (const [k, v] of Object.entries(cost)) {
      if ((pool?.[k] ?? 0) < v) return { ok: false, reason: `${k} 不足（需 ${v}）` };
    }
    for (const [k, v] of Object.entries(cost)) pool[k] -= v;
  }
  if (!free.includes(type)) src.garrison -= total;
  src.fatigue = Math.min(100, src.fatigue + cfg.hidden.fatiguePerMarchTurn);

  const arriveTurn = state.turn + Math.max(cfg.orders.minArriveTurn, routeInfo.turns);
  const order = {
    id: state.nextOrderId++, type, faction, from,
    to: spec.to ?? null, tile: spec.tile ?? null,
    units, path: routeInfo.path, cost: routeInfo.cost, km: routeInfo.km,
    issuedTurn: state.turn, arriveTurn,
    atSec: arriveTurn * cfg.calendar.secPerTurn,
    selection: spec.selection ?? [], direction: spec.direction ?? null,
    stratagem: spec.stratagem ?? null,
    spent: cost ? { ...cost } : null,
  };
  state.orders.push(order);
  state.stats.ordersIssued++;
  recordOrder(state, spec, order);
  return { ok: true, order };
}

/** 取消在途命令：退还兵员与资源（撤令不是撤兵，部队还没出发）。 */
export function cancelOrder(state, orderId) {
  const i = state.orders.findIndex((o) => o.id === orderId);
  if (i < 0) return { ok: false, reason: '命令不存在或已抵达' };
  const o = state.orders[i];
  const src = state.cities[o.from];
  const count = Object.values(o.units ?? {}).reduce((a, b) => a + b, 0);
  if (!['claim', 'withdraw', 'scout'].includes(o.type)) src.garrison += count;
  if (o.spent) {
    const pool = state.resources[o.faction];
    for (const [k, v] of Object.entries(o.spent)) pool[k] += v;
  }
  state.orders.splice(i, 1);
  state.stats.cancelled++;
  appendCommand(state.commandLog, {
    turn: state.turn, actor: o.faction ?? state.playerFaction, type: 'cancelOrder',
    payload: { orderId }, rngBefore: state.rngCalls, rngAfter: state.rngCalls,
  });
  return { ok: true, order: o, refunded: count };
}

/** 部队池：按城取，懒创建。inside = 城内，camp = 城外大营。 */
export function getForces(state, cityId) {
  if (!state.forces[cityId]) state.forces[cityId] = { inside: [], camp: [] };
  return state.forces[cityId];
}

/** 把一份兵种配额展开成独立单位实体（供小地图框选 / 拖拽 / 单兵控制）。 */
export function makeUnits(state, unitsSpec, faction, zone, cityId) {
  const out = [];
  let n = 0;
  for (const [type, count] of Object.entries(unitsSpec ?? {})) {
    const def = state.cfg.units[type];
    if (!def) continue;
    // 一个实体代表一小队，避免几千个单位把小地图塞爆；数量做上限钳制。
    const squads = Math.max(1, Math.min(12, Math.ceil(count / 120)));
    for (let k = 0; k < squads; k++) {
      const idx = n++;
      let col = zone === 'inside' ? 2 + (idx % 6) : 1 + (idx % 4);
      let row = zone === 'inside' ? 3 + Math.floor(idx / 6) * 2 : 3 + Math.floor(idx / 4) * 2;
      // 城内初始布防不能落在府衙 / 仓井 / 城墙上，否则 A* 起点即被堵死。
      if (zone === 'inside') {
        const blocked = cityObstacles(state.cfg);
        const alt = nearestFree({ col, row }, { cols: state.cfg.cityView.cols,
          rows: state.cfg.cityView.rows, blocked, occupied: new Set() });
        if (alt) { col = alt.col; row = alt.row; }
      }
      out.push({
        id: `u${state.nextUnitId++}`, type, faction, zone, cityId,
        hp: def.hp, maxHp: def.hp,
        col: Math.min(col, state.cfg.cityView.cols - 2),
        row: Math.min(row, state.cfg.cityView.rows - 2),
        selected: false, champion: false,
        troops: Math.round(count / squads),
      });
    }
  }
  return out;
}

/** 小地图拖拽部署：把单位在 大营 ↔ 城内 之间移动，或改城内格位。 */
export function deployUnit(state, cityId, unitId, zone, col, row) {
  const f = getForces(state, cityId);
  let u = f.inside.find((x) => x.id === unitId) ?? f.camp.find((x) => x.id === unitId);
  if (!u) return { ok: false, reason: '单位不存在' };
  if (zone !== 'inside' && zone !== 'camp') return { ok: false, reason: '目标区域不合法' };
  // 敌方城池：己方部队只能在城外大营待命，投入需显式「派人进城」。
  if (zone === 'inside' && state.cities[cityId]?.owner !== u.faction &&
      !state.__allowAssault) {
    // 不拒绝：这正是「派人进去打」。标记已投入，结算时按存活数回写。
  }
  f.inside = f.inside.filter((x) => x.id !== unitId);
  f.camp = f.camp.filter((x) => x.id !== unitId);
  u.zone = zone;
  u.col = Math.max(0, Math.min(state.cfg.cityView.cols - 1, col | 0));
  u.row = Math.max(0, Math.min(state.cfg.cityView.rows - 1, row | 0));
  (zone === 'inside' ? f.inside : f.camp).push(u);
  state.stats.deployed++;
  appendCommand(state.commandLog, {
    turn: state.turn, actor: state.playerFaction, type: 'deployUnit',
    payload: { cityId, unitId, zone, col, row },
    rngBefore: state.rngCalls, rngAfter: state.rngCalls,
  });
  return { ok: true, unit: u, inside: f.inside.length, camp: f.camp.length };
}

/** 城池详情：守军、城防、士气、部队池、侦察情报。 */
export function cityOverview(state, cityId) {
  const c = state.cities[cityId];
  if (!c) return null;
  const f = getForces(state, cityId);
  const ownedTiles = state.terrain.tiles.filter((t) => t.cityId === cityId);
  return {
    id: cityId, name: cityId, owner: c.owner, pop: c.pop,
    garrison: c.garrison, wall: c.wall, morale: Math.round(c.morale),
    grain: Math.round(c.grain), fatigue: Math.round(c.fatigue),
    besieged: c.besieged,
    inside: f.inside.length, camp: f.camp.length,
    intel: state.intel[cityId] ?? null,
    forts: state.forts.filter((x) => x.faction === c.owner).length,
    tiles: ownedTiles.length,
  };
}

/** 地块产出聚合：只统计已占领格，围城中的城池产量减半。 */
export function collectResources(state, { apply = true } = {}) {
  const out = {};
  for (const f of state.cfg.factions) out[f.id] = { wood: 0, stone: 0, iron: 0, grain: 0, tiles: 0 };
  for (const t of state.terrain.tiles) {
    if (!t.owner || !out[t.owner]) continue;
    const o = out[t.owner];
    o.tiles++;
    for (const k of ['wood', 'stone', 'iron', 'grain']) o[k] += t.y[k] ?? 0;
  }
  for (const [fid, o] of Object.entries(out)) {
    for (const k of ['wood', 'stone', 'iron', 'grain']) o[k] = Math.round(o[k] * 10) / 10;
    // 城内设施加成：伐木/采石/炼铁/磨坊每级各 +3%，城主府每级全局 +2%。
    if (fid === state.playerFaction) {
      const fl = state.facilities ?? {};
      const bonus = {
        wood: 1 + (fl.famuchang ?? 0) * 0.03,
        stone: 1 + (fl.caishichang ?? 0) * 0.03,
        iron: 1 + (fl.liantiechang ?? 0) * 0.03,
        grain: 1 + (fl.mofang ?? 0) * 0.03,
      };
      const lv = facilityLevel(state);
      const glob = 1 + (fl.chengzhufu ?? 0) * 0.02 + lv * state.cfg.facilities.effects.yieldPerLevel * 0.01;
      for (const k of ['wood', 'stone', 'iron', 'grain']) {
        o[k] = Math.round(o[k] * bonus[k] * glob * 10) / 10;
      }
      if (apply) state.copper = Math.round((state.copper ?? 0) + 120 * (fl.minju ?? 0));
    }
    state.yield[fid] = { ...o };
    const stock = state.resources[fid];
    stock.tiles = o.tiles;
    // apply=false 只刷新「每旬流量」用于界面显示，不重复入账。
    // 设施升级后调它，避免同旬被加两次资源。
    if (!apply) continue;
    for (const k of ['wood', 'stone', 'iron', 'grain']) {
      stock[k] = Math.round((stock[k] + o[k]) * 10) / 10;
    }
  }
  return out;
}

/** 一个回合：地块产出 → 城池恢复 → 在途结算 → AI。完全不关心战斗是否可见。 */
export function advanceTurn(state, rng) {
  const { cfg } = state;
  const events = [];
  state.turn++;
  state.stats.turns++;
  appendCommand(state.commandLog, {
    turn: state.turn, actor: '__turn__', type: 'advanceTurn', payload: {},
    rngBefore: state.rngCalls, rngAfter: state.rngCalls,
  });
  if (rng?.snapshot) state.rngCalls = rng.snapshot().calls;
  const yieldByOwner = collectResources(state);   // 同时把流量累加进库存

  for (const c of Object.values(state.cities)) {
    const own = yieldByOwner[c.owner];
    const cap = troopCap(state, c.id);
    const growth = Math.round(c.pop * (c.besieged ? 0.0004 : 0.0011));
    c.pop = Math.max(1000, c.pop + growth);
    c.grain += (own?.grain ?? 0) * (c.besieged ? 0.45 : 1);
    c.grain -= c.garrison * cfg.hidden.grainUpkeepPerUnitTurn;
    c.grain = Math.max(0, c.grain);
    if (!c.besieged && c.garrison < cap) {
      c.garrison += Math.min(cap - c.garrison,
        Math.max(1, Math.round(c.pop * cfg.city.garrisonRecruitPerTurn)));
    }
    c.wall = Math.min(cfg.city.wallStart, c.wall + cfg.city.wallRepairPerTurn);
    c.fatigue = Math.max(0, c.fatigue - cfg.hidden.fatigueRecoverPerTurn);
    c.morale = Math.min(cfg.hidden.moraleMax,
      c.morale + cfg.hidden.moraleDriftPerSec * cfg.calendar.secPerTurn);
    if (c.grain < c.garrison) c.morale = Math.max(0, c.morale - 1.4);
    if (c.besieged) c.morale = Math.max(0, c.morale - 0.8);
  }

  const arrived = state.orders.filter((o) => o.arriveTurn <= state.turn);
  state.orders = state.orders.filter((o) => o.arriveTurn > state.turn);
  for (const o of arrived) {
    state.stats.arrivals++;
    const count = Object.values(o.units ?? {}).reduce((x, y) => x + y, 0);

    // 城内战斗指令：按时间戳投邮箱
    if (o.type === 'fireDirectional' || o.type === 'stratagem') {
      pushMail(state, {
        kind: o.type, atSec: o.atSec, city: o.to, faction: o.faction,
        selection: o.selection, direction: o.direction, stratagem: o.stratagem,
      });
      events.push({ type: 'battleOrder', order: o });
      continue;
    }

    // 对地块指令
    if (o.tile) {
      const t = state.terrain.at(o.tile.c, o.tile.r);
      if (o.type === 'claim') {
        const r = claimTile(state.terrain, o.tile.c, o.tile.r, o.faction);
        if (r.ok) { state.stats.tilesClaimed++; events.push({ type: 'claim', ...r.tile, faction: o.faction }); }
        else events.push({ type: 'claimFailed', reason: r.reason });
      } else if (o.type === 'develop') {
        t.level = Math.min(state.cfg.terrain.maxLandLevel, t.level + 1);
        recomputeYield(state, t);
        state.stats.develops++;
        events.push({ type: 'develop', c: t.c, r: t.r, level: t.level, faction: o.faction });
      } else if (o.type === 'buildFort') {
        t.fort = o.faction;
        t.cost = Math.min(t.cost, 0.8);
        state.forts.push({ c: t.c, r: t.r, faction: o.faction, turn: state.turn });
        state.stats.forts++;
        events.push({ type: 'fort', c: t.c, r: t.r, faction: o.faction });
      }
      continue;
    }

    // 侦察：只写情报，不改兵力 / 不开战
    if (o.type === 'scout') {
      const d = state.cities[o.to];
      state.intel[o.to] = {
        turn: state.turn, garrison: d.garrison, wall: Math.round(d.wall),
        morale: Math.round(d.morale), owner: d.owner,
      };
      state.stats.scouts++;
      events.push({ type: 'scout', city: o.to, faction: o.faction });
      continue;
    }

    // 撤退：从敌城大营把兵收回出发城
    if (o.type === 'withdraw') {
      const f = getForces(state, o.to);
      const back = f.camp.filter((u) => u.faction === o.faction);
      f.camp = f.camp.filter((u) => u.faction !== o.faction);
      const recovered = back.reduce((a, u) => a + (u.troops ?? 0), 0);
      state.cities[o.from].garrison += recovered;
      events.push({ type: 'withdraw', city: o.to, count: recovered });
      continue;
    }

    const dest = state.cities[o.to];
    if (!dest) continue;
    const own = dest.owner === o.faction;

    // 生成小地图里的独立单位实体：己方城放城内，敌方城放城外大营。
    const f = getForces(state, o.to);
    const zone = own ? 'inside' : 'camp';
    const made = makeUnits(state, o.units, o.faction, zone, o.to);
    f[zone].push(...made);

    if (own) {
      dest.garrison += count;
      dest.fatigue = Math.min(100, dest.fatigue + cfg.hidden.fatiguePerMarchTurn);
      if (o.type === 'garrison') {
        dest.wall = Math.min(cfg.city.wallStart, dest.wall + 6);
        dest.formation = Math.min(100, dest.formation + 5);
      }
      events.push({ type: 'arriveOwn', city: o.to, count, units: made.length });
    } else {
      dest.besieged = true;
      if (!dest.battleId) {
        dest.battleId = state.nextBattleId++;
        state.battles[dest.battleId] = {
          id: dest.battleId, city: o.to, attacker: o.faction,
          startTurn: state.turn, startSec: state.turn * cfg.calendar.secPerTurn,
        };
        state.stats.battlesOpened++;
        events.push({ type: 'battleOpen', battleId: dest.battleId, city: o.to });
      }
      pushMail(state, {
        kind: 'reinforce', atSec: o.atSec, city: o.to, faction: o.faction,
        units: o.units, count, battleId: dest.battleId,
      });
      events.push({ type: 'arriveEnemy', city: o.to, count, units: made.length });
    }
  }

  // AI：每 2 回合做一次，优先占相邻空地铺路，其次派兵打最近敌城。确定性。
  for (const f of cfg.factions) {
    if (!f.ai || state.turn % 2 !== 0) continue;
    const ownCities = Object.values(state.cities).filter((c) => c.owner === f.id);
    if (!ownCities.length) continue;
    const from = rng.pick(ownCities);
    if (rng.chance(0.45)) {
      // 铺路：找一块与己方领地相邻的无主可通行格
      const { tiles } = state.terrain;
      const cands = tiles.filter((t) => !t.owner && t.cost < 90 &&
        hasAdjacentTerritory(state.terrain, f.id, t.c, t.r));
      if (cands.length) {
        const pick = rng.pick(cands.slice(0, 400));
        const r = issueOrder(state, {
          faction: f.id, from: from.id, type: 'claim',
          tile: { c: pick.c, r: pick.r }, units: { daodun: 300 },
        });
        if (r.ok) { state.stats.aiOrders++; events.push({ type: 'aiClaim', faction: f.id }); }
        continue;
      }
    }
    const enemy = Object.values(state.cities)
      .filter((c) => c.owner !== f.id)
      .sort((a, b) => {
        const ca = cityById(a.id), cb = cityById(b.id), cf = cityById(from.id);
        return Math.hypot(ca.lon - cf.lon, ca.lat - cf.lat)
             - Math.hypot(cb.lon - cf.lon, cb.lat - cf.lat);
      })[0];
    if (!enemy) continue;
    const n = Math.min(1200 + rng.int(900), Math.floor(from.garrison * 0.3));
    if (n < 100) continue;
    const r = issueOrder(state, {
      faction: f.id, from: from.id, to: enemy.id,
      units: { daodun: Math.round(n * 0.6), gongnu: Math.round(n * 0.4) }, type: 'march',
    });
    if (r.ok) { state.stats.aiOrders++; events.push({ type: 'aiMarch', faction: f.id }); }
  }

  return events;
}

/** 战斗终局回写：以 battleEndTurn 为准，绝不回退到开战那一回合。 */
export function resolveBattle(state, result) {
  const c = state.cities[result.city];
  const b = state.battles[result.battleId];
  if (!c || !b) return { ok: false, reason: '战斗或城池不存在' };
  const endTurn = result.endTurn ?? state.turn;
  c.besieged = false;
  c.battleId = null;
  if (result.won) {
    c.owner = result.attacker;
    syncCityOwner(state, result.city, result.attacker);
    c.commander.state = result.commanderCaptured ? 'captured' : 'inOffice';
    c.commander.faction = result.attacker;
    c.commander.capturedBy = result.commanderCaptured ? result.attacker : null;
    c.wall = Math.max(20, c.wall * 0.4);
    c.morale = Math.max(c.morale, 45);
  } else {
    c.commander.state = 'inOffice';
    c.wall = Math.min(state.cfg.city.wallStart, c.wall + 8);
  }
  c.garrison = Math.max(0, result.survivors ?? c.garrison);
  c.fatigue = Math.min(100, c.fatigue + 10);
  // 终局兵力回写按存活数，绝不凭空抹掉：城破后大营仍是城外驻军，
  // 退兵则把城内攻方残部收回大营 —— 这正是「先打着，然后再退出」。
  const f = getForces(state, result.city);
  if (result.won) {
    for (const u of f.inside) u.faction = result.attacker;
  } else {
    const back = f.inside.filter((u) => u.faction === result.attacker && (u.hp ?? 1) > 0);
    f.inside = f.inside.filter((u) => !back.includes(u));
    for (const u of back) {
      u.zone = 'camp'; u.col = 1; u.row = 3 + (f.camp.length % 6) * 2;
      f.camp.push(u);
    }
  }
  delete state.battles[result.battleId];
  state.stats.battlesClosed++;
  return { ok: true, endTurn, city: result.city, owner: c.owner };
}

export function isHostile(state, cityId, faction) {
  return state.cities[cityId]?.owner !== faction;
}
export function factionById(cfg, id) {
  return cfg.factions.find((f) => f.id === id) ?? null;
}

export { CITIES, ROADS, cityById, neighbors, routeByCities, tilesPerTurn };


/** 屯田后重算单格四资源（与 terrain.js 的派生规则同源）。 */
function recomputeYield(state, t) {
  const Y = state.cfg.terrain.yield;
  const lv = 0.55 + t.level * 0.19;
  for (const k of ['wood', 'stone', 'iron', 'grain']) {
    const b = Y[k]?.[t.base] ?? 0;
    t.y[k] = Math.round(b * lv * 100) / 100;
  }
  if (t.cityId) t.y.grain = Math.round(t.y.grain * 1.4 * 100) / 100;
}
