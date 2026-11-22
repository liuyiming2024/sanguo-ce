// AI 势力：纯逻辑层。零 DOM / 墙钟 / Math.random，全部随机经注入的 rng，
// 随命令日志与快照一起重放 —— 盯着打与隔旬快进回来，敌方军令逐条一致。
//
// 与 campaign.js 的契约：planAiTurn 只「出主意」，返回 spec 数组；
// 真正落库由 advanceTurn 调 issueOrder，保证所有命令仍走同一条命令日志。
// 四种决策按固定权重分桶（可预测），但目标由评分与 rng 共同决定（有变数）。
import { cityById } from './map-data.js';
import { hasAdjacentTerritory } from './pathfind.js';

/** 四类决策的固定权重；合计 1，改这里就改性格，不动任何逻辑。 */
export const AI_WEIGHTS = {
  expand: 0.40,   // 扩地：占相邻无主高产田，铺路连地
  defend: 0.18,   // 守城：被围则就地征兵
  raid:   0.17,   // 袭粮：优先打粮仓城
  march:  0.25,   // 出征：按目标评分挑敌城
};

/**
 * 出征目标评分权重：越小越优先。
 * 旧版只按经纬度直线距离排，于是「最近但守军七千的坚城」永远压过
 * 「稍远一点、守军六百的空城」—— 像对手闭着眼往墙上撞。
 * 现在把守军、城防、粮仓都折进同一个分数，全程只读 state，不引入新随机。
 */
export const AI_TARGET = {
  dist: 1.0,          // 经纬度直线距离（度）
  garrisonDiv: 1200,  // 守军每 1200 折算 1 度距离
  wallDiv: 200,       // 城防每 200 折算 1 度距离
  granaryBonus: 1.2,  // 平时粮仓城的吸引力
  granaryRaidBonus: 4.0, // 袭粮桶里粮仓城的吸引力
};

/** 粮仓城：史注里带「粮 / 仓 / 囤 / 粟」的城池，袭粮分支优先取它。 */
export function isGranaryCity(meta) {
  return !!meta && /粮|仓|囤|粟/.test(`${meta.note ?? ''}${meta.name ?? ''}`);
}

/** 目标评分：纯函数，同 state 同分，便于单测逐项核对。 */
export function targetScore(c, cf, preferGranary) {
  const meta = cityById(c.id);
  const dist = Math.hypot((meta?.lon ?? 0) - cf.lon, (meta?.lat ?? 0) - cf.lat);
  const granary = isGranaryCity(meta)
    ? (preferGranary ? AI_TARGET.granaryRaidBonus : AI_TARGET.granaryBonus) : 0;
  return dist * AI_TARGET.dist
    + (c.garrison ?? 0) / AI_TARGET.garrisonDiv
    + (c.wall ?? 0) / AI_TARGET.wallDiv
    - granary;
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

  // 断粮时不再硬征兵 / 硬出征：那两道命令必被 canAffordTroops 拒，
  // AI 会一旬旬空转（长局里 aiRejected 飙到几百）。改走「找粮 / 减耗」。
  //
  // 口径修正（长局 500 旬实测）：旧版「任一城饿就全势力停战」，配上断粮减产后
  // 两路 AI 各有一两座饿城，于是 400 旬后双方集体救荒、战线彻底冻结。
  // 现在按「饿城比例 ≥ 1/3」判：局部饥荒不该让全局罢兵，饿城多的才收手。
  const hungry = ownCities.filter((c) => c.starving).length;
  const reported = state.commissary?.[faction.id]?.starvingCities ?? 0;
  const starving = Math.max(hungry, reported) >= Math.max(1, Math.ceil(ownCities.length / 3));
  if (starving) return planRelief(state, faction, from, rng);

  if (kind === 'raid') {
    // 袭粮就是断对方粮道：直取粮仓城，不先去铺路占地，否则这一桶永远退化成扩地。
    return planMarch(state, faction, from, rng, true);
  }

  if (kind === 'expand') return planExpand(state, faction, from, rng, 'expand');

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

/** 扩地候选：优先高产田，没有则退普通可通行格；前 400 格防大图遍历爆炸。 */
function expandPool(state, faction) {
  const tiles = state.terrain.tiles;
  const adjacent = (t) => !t.owner && t.cost < 90 &&
    hasAdjacentTerritory(state.terrain, faction.id, t.c, t.r);
  const rich = tiles.filter((t) => adjacent(t) && (t.y?.grain ?? 0) > 1);
  const pool = rich.length ? rich : tiles.filter(adjacent);
  return pool.slice(0, 400);
}

function planExpand(state, faction, from, rng, kind) {
  const pool = expandPool(state, faction);
  if (!pool.length) return [];
  const pick = rng.pick(pool);
  return [{ kind, relief: kind !== 'expand', spec: {
    faction: faction.id, from: from.id, type: 'claim',
    tile: { c: pick.c, r: pick.r }, units: { daodun: 300 },
  } }];
}

/** 粮尽则止兵：先抢高产田增产，再撤在途减耗，都不成便休整一旬。 */
function planRelief(state, faction, from, rng) {
  const pool = state.resources?.[faction.id] ?? {};
  if ((pool.grain ?? 0) >= (state.cfg.orders?.cost?.claim?.grain ?? 15)) {
    const relief = planExpand(state, faction, from, rng, 'expand');
    if (relief.length) return relief.map((p) => ({ ...p, relief: true }));
  }
  const marching = state.orders.filter((o) =>
    (o.faction ?? state.playerFaction) === faction.id && o.type === 'march');
  if (marching.length) {
    const o = rng.pick(marching);
    return [{ kind: 'defend', relief: true, spec: {
      faction: faction.id, from: o.from, to: o.to, type: 'withdraw',
    } }];
  }
  return [];
}

function planMarch(state, faction, from, rng, preferGranary) {
  const enemies = Object.values(state.cities).filter((c) => c.owner !== faction.id);
  if (!enemies.length) return [];
  const cf = cityById(from.id);
  const sorted = enemies.slice().sort((a, b) =>
    targetScore(a, cf, preferGranary) - targetScore(b, cf, preferGranary));
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
  return plan.map((p) => `${p.relief ? '救荒·' : ''}${LABEL[p.kind] ?? p.kind}·${p.spec.type}${p.spec.to ? `→${p.spec.to}` : ''}`);
}
