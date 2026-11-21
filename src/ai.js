// AI 势力：纯逻辑层。零 DOM / 墙钟 / Math.random，全部随机经注入的 rng，
// 随命令日志与快照一起重放 —— 盯着打与隔旬快进回来，敌方军令逐条一致。
//
// 与 campaign.js 的契约：planAiTurn 只「出主意」，返回 spec 数组；
// 真正落库由 advanceTurn 调 issueOrder，保证所有命令仍走同一条命令日志。
// 四种决策按固定权重分桶（可预测），但目标由 rng 在候选里挑（有变数）。
import { cityById } from './map-data.js';
import { hasAdjacentTerritory } from './pathfind.js';

/** 四类决策的固定权重；合计 1，改这里就改性格，不动任何逻辑。 */
export const AI_WEIGHTS = {
  expand: 0.40,   // 扩地：占相邻无主地，铺路连地
  defend: 0.18,   // 守城：被围则就地征兵
  raid:   0.17,   // 袭粮：优先打粮仓、夺高产田
  march:  0.25,   // 出征：打最近敌城
};

/** 粮仓城：史注里带「粮 / 仓 / 囤」的城池，袭粮分支优先取它。 */
export function isGranaryCity(meta) {
  return !!meta && /粮|仓|囤|粟/.test(`${meta.note ?? ''}${meta.name ?? ''}`);
}

/**
 * 一旬一策。返回 [{ kind, spec }]，spec 可直接喂 issueOrder。
 * rng 消耗顺序固定：pick 己方城 → next 分桶 → 分支内各自消耗，绝不受 UI 影响。
 */
export function planAiTurn(state, faction, rng, weights = AI_WEIGHTS) {
  if (!faction?.ai) return [];
  const ownCities = Object.values(state.cities).filter((c) => c.owner === faction.id);
  if (!ownCities.length) return [];

  // 在途命令已满就本旬不动，避免 AI 把并发上限吃光（issueOrder 也会挡，这里省一次调用）。
  const inflight = state.orders.filter((o) => (o.faction ?? state.playerFaction) === faction.id).length;
  const cap = state.cfg.orders?.maxConcurrentPerFaction ?? 20;
  if (inflight >= cap) return [];

  const from = rng.pick(ownCities);
  const roll = rng.next();
  const kind = pickBucket(roll, weights);

  if (kind === 'raid') {
    // 袭粮就是断对方粮道：直取粮仓城，不先去铺路占地，否则这一桶永远退化成扩地。
    return planMarch(state, faction, from, rng, true);
  }

  if (kind === 'expand') {
    const tiles = state.terrain.tiles;
    const cands = tiles.filter((t) => !t.owner && t.cost < 90 &&
      hasAdjacentTerritory(state.terrain, faction.id, t.c, t.r) &&
      (t.y?.grain ?? 0) > 1);
    const pool = cands.length ? cands.slice(0, 400) : tiles.filter((t) => !t.owner && t.cost < 90 &&
      hasAdjacentTerritory(state.terrain, faction.id, t.c, t.r)).slice(0, 400);
    if (!pool.length) return [];
    const pick = rng.pick(pool);
    return [{ kind, spec: {
      faction: faction.id, from: from.id, type: 'claim',
      tile: { c: pick.c, r: pick.r }, units: { daodun: 300 },
    } }];
  }

  if (kind === 'defend') {
    const besieged = ownCities.filter((c) => c.besieged);
    const target = besieged.length ? rng.pick(besieged) : from;
    const n = Math.min(600, Math.max(120, Math.round(target.garrison * 0.08)));
    return [{ kind, spec: {
      faction: faction.id, from: target.id, type: 'recruit', units: { daodun: n },
    } }];
  }

  return planMarch(state, faction, from, rng, false);
}

function planMarch(state, faction, from, rng, preferGranary) {
  const enemies = Object.values(state.cities).filter((c) => c.owner !== faction.id);
  if (!enemies.length) return [];
  const cf = cityById(from.id);
  const sorted = enemies.slice().sort((a, b) => {
    const ca = cityById(a.id), cb = cityById(b.id);
    const da = Math.hypot(ca.lon - cf.lon, ca.lat - cf.lat);
    const db = Math.hypot(cb.lon - cf.lon, cb.lat - cf.lat);
    // 袭粮：粮仓城优先于距离，仍以距离作次级排序，保证可预测。
    if (preferGranary) {
      const ga = isGranaryCity(ca) ? 1 : 0, gb = isGranaryCity(cb) ? 1 : 0;
      if (ga !== gb) return gb - ga;
    }
    return da - db;
  });
  const target = sorted[0];
  const n = Math.min(1200 + rng.int(900), Math.floor(from.garrison * 0.3));
  if (n < 100) return [];
  return [{ kind: preferGranary ? 'raid' : 'march', spec: {
    faction: faction.id, from: from.id, to: target.id, type: 'march',
    units: { daodun: Math.round(n * 0.6), gongnu: Math.round(n * 0.4) },
  } }];
}

function pickBucket(roll, w) {
  let acc = 0;
  for (const k of ['expand', 'defend', 'raid', 'march']) {
    acc += w[k] ?? 0;
    if (roll < acc) return k;
  }
  return 'march';
}

/** 给界面 / 测试看的决策说明，不参与状态变更。 */
export function describeAiPlan(plan) {
  const LABEL = { expand: '扩地', defend: '守城', raid: '袭粮', march: '出征' };
  return plan.map((p) => `${LABEL[p.kind] ?? p.kind}·${p.spec.type}${p.spec.to ? `→${p.spec.to}` : ''}`);
}
