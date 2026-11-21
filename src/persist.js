// 手机上的隐含契约：状态属于「这局」，不属于「这个页面」。
// 来消息、锁屏、切 App、刷新，回来必须还是刚才那一局。
//
// 这里刻意不碰策略层（campaign.js 保持纯逻辑、不引用 localStorage）。
// 15552 格地形按 seed 重建，只把「和初始地图不一样」的格子存进存档 ——
// 通常几十到几百格，localStorage 完全装得下，也不会把 36MB 位图塞进去。
import { createCampaign } from './campaign.js';
import { createTerrain } from './terrain.js';

export const SAVE_KEY = 'sanguo-ce:save:v1';

const OWNER_IDX = ['', 'cao', 'yuan', 'liu'];

/** 把当前局面压成一份纯 JSON（不含 cfg、不含 DOM、不含循环引用）。 */
export function serializeGame({ cfg, state, rng, snapshot, ui }) {
  const baseline = createTerrain(cfg);
  const tiles = [];
  for (let i = 0; i < state.terrain.tiles.length; i++) {
    const t = state.terrain.tiles[i], b = baseline.tiles[i];
    if (t.owner !== b.owner || t.level !== b.level || t.fort !== b.fort ||
        t.cost !== b.cost || t.y.grain !== b.y.grain) {
      tiles.push([
        i, OWNER_IDX.indexOf(t.owner ?? ''), t.level,
        OWNER_IDX.indexOf(t.fort ?? ''), t.cost,
        t.y.wood, t.y.stone, t.y.iron, t.y.grain,
      ]);
    }
  }
  return {
    v: 1, version: cfg.meta.version,
    mapId: state.mapId ?? 'guandu',
    savedAt: Date.now(),
    seed: state.rngSeed,
    playerFaction: state.playerFaction,
    turn: state.turn,
    rng: rng.snapshot(),
    cities: state.cities,
    resources: state.resources,
    yield: state.yield,
    commissary: state.commissary ?? {},
    orders: state.orders,
    mailbox: state.mailbox,
    forces: state.forces,
    intel: state.intel,
    forts: state.forts,
    battles: state.battles,
    stats: state.stats,
    facilities: state.facilities,
    armies: state.armies,
    copper: state.copper,
    settings: state.settings,
    reports: state.reports ?? [],
    claimedTasks: state.claimedTasks ?? [],
    chapter: state.chapter ?? 'ch1',
    storyBaseline: state.storyBaseline ?? { cities: 0, land: 0 },
    storyFlags: state.storyFlags ?? {},
    storyChoices: state.storyChoices ?? {},
    chapterHistory: state.chapterHistory ?? [],
    storyMails: state.storyMails ?? [],
    dispatchedIds: state.dispatchedIds ?? [],
    chapterEnteredTurn: state.chapterEnteredTurn ?? {},
    actors: state.actors ?? {},
    commandLog: state.commandLog ?? { v: 1, seq: 0, entries: [] },
    rngCalls: state.rngCalls ?? 0,
    nextIds: [state.nextOrderId, state.nextForceId, state.nextUnitId, state.nextBattleId],
    tiles,
    snapshot: snapshot ?? null,
    ui: {
      auto: ui?.auto ?? true,
      camera: ui?.camera ?? null,
      battleCityId: ui?.battleCityId ?? null,
    },
  };
}

/** 从存档重建：地形按 seed 重算，再叠加差异；其余字段直接覆盖。 */
export function deserializeGame(cfg, raw) {
  if (!raw || raw.v !== 1) return null;
  const state = createCampaign(cfg, {
    playerFaction: raw.playerFaction ?? 'cao',
    seed: raw.seed ?? cfg.terrain.seed,
  });
  state.turn = raw.turn ?? 0;
  state.rngSeed = raw.seed ?? cfg.terrain.seed;
  for (const [i, oi, level, fi, cost, w, s, ir, g] of (raw.tiles ?? [])) {
    const t = state.terrain.tiles[i];
    if (!t) continue;
    t.owner = OWNER_IDX[oi] ?? null;
    t.fort = OWNER_IDX[fi] ?? null;
    t.level = level;
    t.cost = cost;
    t.y = { wood: w, stone: s, iron: ir, grain: g };
  }
  const keys = ['resources', 'yield', 'commissary', 'orders', 'mailbox',
    'forces', 'intel', 'forts', 'battles', 'stats',
    'facilities', 'armies', 'copper', 'settings', 'reports', 'claimedTasks',
    'chapter', 'storyBaseline', 'storyFlags', 'storyChoices', 'chapterHistory', 'storyMails',
    'dispatchedIds', 'chapterEnteredTurn',
    'actors', 'commandLog', 'rngCalls', 'mapId'];
  for (const k of keys) if (raw[k] != null) state[k] = raw[k];
  // 城表迁移：新版本在城表里补了点位时，旧存档不能把新增城吞掉。
  // 以重建的城表为底，只让存档覆盖它认得的 id，其余保留初始值。
  if (raw.cities) {
    for (const [id, saved] of Object.entries(raw.cities)) {
      if (state.cities[id]) state.cities[id] = saved;
    }
  }
  state.dispatchedIds ??= [];
  state.chapterEnteredTurn ??= {};
  if (Array.isArray(raw.nextIds)) {
    [state.nextOrderId, state.nextForceId, state.nextUnitId, state.nextBattleId] = raw.nextIds;
  }
  return {
    state,
    rngSnapshot: raw.rng,
    snapshot: raw.snapshot ?? null,
    ui: raw.ui ?? {},
    savedAt: raw.savedAt ?? 0,
  };
}

/** 浏览器侧：存 / 读 / 清。任何异常都静默降级为「没有存档」，不影响开局。 */
export function saveToStorage(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch { return false; }
}
export function readFromStorage() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
export function clearStorage() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* 忽略 */ }
}
