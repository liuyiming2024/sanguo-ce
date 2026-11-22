// 最小可玩切片的核心：不调用 wx / Page / App / DOM，可在 Node 里整条跑。
//
// P2 的目标只有一个——证明「逻辑层搬到小程序端能跑、能读档、能推旬」。
// 零 PNG、零 Canvas、零地图渲染、零结算层；战报只是文本。
// 页面层（pages/slice/index.js）只负责注入宿主 + setData，所有局面逻辑都在这里，
// 因此端侧烟测可以直接 import 本文件，不用 mock 小程序运行时。
import { createCampaign, advanceTurn, collectResources } from '../logic/src/campaign.js';
import { createRng, rngFromSnapshot } from '../logic/src/rng.js';
import { serializeGame, deserializeGame, SAVE_KEY } from '../logic/src/persist.js';
import { hashState } from '../logic/src/sync.js';
import { checkOutcome } from '../logic/src/outcome.js';
import { xunLedger } from '../logic/src/economy.js';
import { configurePlatform, wxStorageDriver, storage as platformStorage } from '../logic/src/platform/index.js';
import { CAMPAIGN } from '../logic/config/campaign.js';

export const SLICE_KEY = SAVE_KEY;
export const SLICE_VERSION = CAMPAIGN.meta.version;

/** 宿主注入：小程序传 wx，Node 测试传自己的 storage mock + 固定 now。 */
export function installHost({ wx, storage, now } = {}) {
  const s = storage ?? (wx ? wxStorageDriver(wx) : undefined);
  configurePlatform({
    ...(s ? { storage: s } : {}),
    ...(now ? { now } : {}),
  });
}

function freshCfg() {
  // 每次建局深拷贝，避免页面反复开新局时互相改到同一份配置。
  return JSON.parse(JSON.stringify(CAMPAIGN));
}

/** 冷启动：建局 + 开局周转粮 + 刷新每旬流量。 */
export function bootSlice({ seed = CAMPAIGN.terrain.seed, host } = {}) {
  if (host) installHost(host);
  const cfg = freshCfg();
  const state = createCampaign(cfg, { seed });
  const rng = createRng(seed);
  // 与主工程 boot() 同一口径：开局周转粮，否则库存 0 连占地都发不出。
  state.resources[state.playerFaction].grain = 600;
  collectResources(state, { apply: false });
  return { state, rng, cfg, hash: hashState(state) };
}

const EVENT_TEXT = {
  claim: (e) => `占据土地 (${e.c},${e.r})`,
  develop: (e) => `屯田 → ${e.level} 级地`,
  fort: (e) => `筑垒寨 (${e.c},${e.r})`,
  scout: (e) => `斥候回报 ${e.city}`,
  battleOpen: (e) => `${e.city} 遭围`,
  arriveEnemy: (e) => `援军 ${e.count} 抵 ${e.city} 城外`,
  arriveOwn: (e) => `部队 ${e.count} 入 ${e.city}`,
  withdraw: (e) => `撤兵 ${e.count} 回营`,
  autoResolve: (e) => `${e.city} ${e.won ? '城破' : '却敌'}`,
  aiClaim: () => '敌方下令占地',
  aiMarch: () => '敌方下令出征',
};

/** 推一旬：返回本旬战报文本与局面摘要。战报只是文本，不写 DOM。 */
export function pushTurn(slice) {
  const evs = advanceTurn(slice.state, slice.rng);
  const lines = [];
  for (const e of evs) {
    const f = EVENT_TEXT[e.type];
    if (f) lines.push(f(e));
  }
  const famine = xunLedger(slice.state).byFaction[slice.state.playerFaction];
  if (famine?.starving > 0) lines.push(`军粮不继 · 断粮 ${famine.starving} 城`);
  return { turn: slice.state.turn, lines, summary: sliceSummary(slice.state),
    outcome: checkOutcome(slice.state) };
}

/** 界面摘要：纯 JSON，无坐标 / 无像素 / 无 DOM。 */
export function sliceSummary(state) {
  const pf = state.playerFaction;
  const all = Object.values(state.cities);
  const own = all.filter((c) => c.owner === pf);
  const led = xunLedger(state).byFaction[pf];
  return {
    version: SLICE_VERSION,
    turn: state.turn,
    ownCities: own.length,
    hostileCities: all.length - own.length,
    land: state.terrain.tiles.filter((t) => t.owner === pf).length,
    grain: Math.round(state.resources[pf].grain),
    net: led?.lastNet ?? 0,
    starving: led?.starving ?? 0,
    battles: state.stats.battlesOpened,
    closed: state.stats.battlesClosed,
    hash: hashState(state),
  };
}

/** onHide：拍快照存本机，返回存档与当时的指纹。 */
export function hideSlice(slice) {
  const raw = serializeGame({
    cfg: slice.cfg, state: slice.state, rng: slice.rng, snapshot: null,
    ui: { auto: true, camera: null, battleCityId: null },
  });
  const hash = hashState(slice.state);
  try { platformStorage().setItem(SLICE_KEY, JSON.stringify(raw)); } catch { /* 静默降级 */ }
  return { raw, hash };
}

/**
 * onShow：读回快照、无渲染恢复、比对指纹。
 * 逻辑层零墙钟，所以「切后台回来逐字段一致」是天然成立的；
 * 这里把 hash 摆出来让页面与烟测都能看见，而不是嘴上说成立。
 */
export function showSlice({ storage, now, raw, expectHash, host } = {}) {
  if (host) installHost(host);
  const text = storage?.getItem(SLICE_KEY);
  const data = raw ?? (text ? JSON.parse(text) : null);
  if (!data) return { ok: false, reason: '无本机存档' };
  const cfg = freshCfg();
  const restored = deserializeGame(cfg, data);
  if (!restored) return { ok: false, reason: '存档版本不符' };
  const rng = rngFromSnapshot(restored.rngSnapshot);
  const hash = hashState(restored.state);
  return {
    ok: true,
    state: restored.state, rng, cfg,
    hash,
    consistent: expectHash ? hash === expectHash : null,
    turn: restored.state.turn,
    summary: sliceSummary(restored.state),
  };
}
