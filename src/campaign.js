// 策略层：纯逻辑，不引用 DOM / canvas / localStorage，可在 node --test 里整局推演。
// 地图是 144×108 真实地理栅格；资源按「已占领地块的时产」聚合，不是按城拍脑袋。
// 与战斗层唯一耦合是 mailbox：带 atSec 时间戳的事件队列，战斗层按累计秒数消费。
import { CITIES, ROADS, cityById, routeByCities, neighbors } from './map-data.js';
import { createTerrain } from './terrain.js';
import {
  routeCities, findRoute, hasAdjacentTerritory, claimTile, tilesPerTurn,
} from './pathfind.js';

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

  return {
    cfg, turn: 0, playerFaction, rngSeed: seed, terrain,
    cities, resources,
    orders: [],
    mailbox: [],
    nextOrderId: 1, nextForceId: 1, nextUnitId: 1, nextBattleId: 1,
    battles: {},
    stats: {
      turns: 0, ordersIssued: 0, arrivals: 0, tilesClaimed: 0,
      battlesOpened: 0, battlesClosed: 0, recruits: 0, aiOrders: 0,
    },
  };
}

/** 建安五年二月上旬起，1 回合 = 1 旬。 */
export function dateLabel(state) {
  const { xunPerMonth } = state.cfg.calendar;
  const x = state.cfg.calendar.startXun - 1 + state.turn;
  const monthOffset = Math.floor(x / xunPerMonth);
  const xun = (x % xunPerMonth) + 1;
  const m0 = state.cfg.calendar.startMonth - 1 + monthOffset;
  const year = state.cfg.calendar.startYear + Math.floor(m0 / 12);
  const month = (m0 % 12) + 1;
  return `建安${year - 195}年 · ${month}月${['上旬', '中旬', '下旬'][xun - 1]}`;
}

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
  return Math.round(state.cities[id].pop * state.cfg.city.popToTroopRatio);
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
export function issueOrder(state, spec) {
  const { faction, from, units = {}, type = 'march' } = spec;
  const src = state.cities[from];
  if (!src) return { ok: false, reason: '出发城不存在' };
  if (src.owner !== faction) return { ok: false, reason: '该城不归此势力' };
  if (!state.cfg.orders.types.includes(type)) return { ok: false, reason: `未知命令 ${type}` };
  if (state.orders.filter((o) => o.faction === faction).length >=
      state.cfg.orders.maxConcurrentPerFaction) {
    return { ok: false, reason: '在途命令已达上限' };
  }
  const total = Object.values(units).reduce((a, b) => a + b, 0);

  if (type === 'recruit') {
    const cost = Math.round(total * 3);
    if (src.grain < cost) return { ok: false, reason: '粮草不足' };
    src.grain -= cost;
    src.garrison += total;
    state.stats.recruits++;
    state.stats.ordersIssued++;
    return { ok: true, instant: true, cost };
  }

  // 定向齐射 / 军师计策是城内战斗指令，不是大地图行军：不走 A*，
  // 直接按时间戳投进邮箱，由 BattleSession 在子界面里消费。
  if (type === 'fireDirectional' || type === 'stratagem') {
    const arriveTurn = state.turn + state.cfg.orders.minArriveTurn;
    const order = {
      id: state.nextOrderId++, type, faction, from, to: spec.to ?? from,
      units: {}, path: [], cost: 0, km: 0,
      issuedTurn: state.turn, arriveTurn,
      atSec: arriveTurn * state.cfg.calendar.secPerTurn,
      selection: spec.selection ?? [], direction: spec.direction ?? null,
      stratagem: spec.stratagem ?? null,
    };
    state.orders.push(order);
    state.stats.ordersIssued++;
    return { ok: true, order };
  }

  const g = state.terrain.cityCenter(from);
  if (!g?.gate) return { ok: false, reason: '出发城无城门' };
  const start = { c: g.gate[0], r: g.gate[1] };

  let target, dest, routeInfo;
  if (type === 'claim') {
    const t = spec.tile;
    if (!t) return { ok: false, reason: '缺少目标地块' };
    if (!hasAdjacentTerritory(state.terrain, faction, t.c, t.r)) {
      return { ok: false, reason: '目标地块未与己方领地相连（需先铺路）' };
    }
    target = { c: t.c, r: t.r };
    dest = null;
    routeInfo = findRoute(state.terrain, start, target, state.cfg);
  } else {
    dest = state.cities[spec.to];
    if (!dest) return { ok: false, reason: '目标城不存在' };
    routeInfo = routeCities(state.terrain, from, spec.to, state.cfg);
    if (routeInfo.ok) target = routeInfo.path[routeInfo.path.length - 1];
  }
  if (!routeInfo?.ok) return { ok: false, reason: routeInfo?.reason ?? '无路可通' };
  if (type !== 'claim' && !(total > 0)) return { ok: false, reason: '没有派兵' };
  if (type !== 'claim' && src.garrison < total) return { ok: false, reason: '守军不足' };

  const arriveTurn = state.turn + Math.max(
    state.cfg.orders.minArriveTurn, routeInfo.turns);
  // 占地只是派一队去插旗，兵不「消耗」；到达后不回写是因为从未扣减。
  if (type !== 'claim') src.garrison -= total;
  src.fatigue = Math.min(100, src.fatigue + state.cfg.hidden.fatiguePerMarchTurn);

  const order = {
    id: state.nextOrderId++, type, faction, from,
    to: spec.to ?? null, tile: spec.tile ?? null,
    units, path: routeInfo.path, cost: routeInfo.cost, km: routeInfo.km,
    issuedTurn: state.turn, arriveTurn,
    atSec: arriveTurn * state.cfg.calendar.secPerTurn,
    selection: spec.selection ?? [],
    direction: spec.direction ?? null,
    stratagem: spec.stratagem ?? null,
  };
  state.orders.push(order);
  state.stats.ordersIssued++;
  return { ok: true, order };
}

/** 地块产出聚合：只统计已占领格，围城中的城池产量减半。 */
export function collectResources(state) {
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
    state.resources[fid] = { ...o };
  }
  return out;
}

/** 一个回合：地块产出 → 城池恢复 → 在途结算 → AI。完全不关心战斗是否可见。 */
export function advanceTurn(state, rng) {
  const { cfg } = state;
  const events = [];
  state.turn++;
  state.stats.turns++;
  const yieldByOwner = collectResources(state);

  for (const f of cfg.factions) {
    const y = yieldByOwner[f.id];
    state.resources[f.id] = { ...y };
  }

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
    const count = Object.values(o.units).reduce((a, b) => a + b, 0);
    if (o.type === 'claim') {
      const r = claimTile(state.terrain, o.tile.c, o.tile.r, o.faction);
      if (r.ok) { state.stats.tilesClaimed++; events.push({ type: 'claim', ...r.tile, faction: o.faction }); }
      else events.push({ type: 'claimFailed', reason: r.reason });
      continue;
    }
    if (o.type === 'fireDirectional' || o.type === 'stratagem') {
      pushMail(state, {
        kind: o.type, atSec: o.atSec, city: o.to, faction: o.faction,
        selection: o.selection, direction: o.direction, stratagem: o.stratagem,
      });
      events.push({ type: 'battleOrder', order: o });
      continue;
    }
    const dest = state.cities[o.to];
    if (!dest) continue;
    if (dest.owner === o.faction) {
      dest.garrison += count;
      dest.fatigue = Math.min(100, dest.fatigue + cfg.hidden.fatiguePerMarchTurn);
      events.push({ type: 'arriveOwn', city: o.to, count });
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
      events.push({ type: 'arriveEnemy', city: o.to, count, battleId: dest.battleId });
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
