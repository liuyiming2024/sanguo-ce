// 策略层「无人值守战斗」简算：纯逻辑、零 DOM / 零墙钟 / 零位图。
//
// 为什么单独一层：campaign.js 里 march 抵达敌城只开 battleId + 扎大营，
// 真正结算在 siege-combat.js 的子界面里由玩家逐帧打完再 resolveBattle 回写。
// 于是 AI 出的征永远没人去打 —— 长局 200 旬城数 9:3 纹丝不动、无自然终局。
// 这一层只补「AI 发起、且玩家没在子界面里」的滞留战斗：
//   · 不碰 battle-session.js / siege-combat.js，双时钟与手动攻城原样保留；
//   · 玩家自己发起的战斗永不自动结算，仗还是自己打；
//   · 结果仍走既有 resolveBattle() 回写 owner / garrison / wall / forces；
//   · 进 commandLog 一条 autoResolve，重放可追溯。
//
// 随机源刻意用「seed ⊕ battleId」的独立派生流，不消耗主 rng：
// 这样既有 AI 决策序列、rngCalls、双时钟快进的随机序列一个字节都不变，
// 同 seed 双跑与「离开一旬再回来」依旧逐字段一致。

import { createRng } from './rng.js';
import { appendCommand } from './sync.js';
import {
  moraleFactor, fatigueFactor, formationFactor, hungerFactor,
} from './condition.js';

export const AUTO_RESOLVE = {
  graceTurns: 4,        // AI 抵达后几旬无人接手就简算；给玩家留出救援 / 亲自接战的窗口
  onlyAiAttacker: true, // 玩家发起的战斗永不自动结算
  variance: 0.30,       // ±15% 战力扰动
  wallDiv: 180,         // 城防每 180 折算 1 倍守方加成
  survivorWin: [0.45, 0.30],  // 攻方破城后存活比例 = a + b·r
  survivorHold: [0.60, 0.30], // 守方却敌后存活比例
  _note: '策略层简算，不是子界面逐帧战斗；不产生 mailbox / atSec 事件，也不进战斗层快照。',
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 由「库存 / 兵数 / 每兵旬耗粮」折出 0–100 的粮草档，与 condition.js 同口径。 */
function grainPct(cfg, stock, troops) {
  const upkeep = cfg.hidden.grainUpkeepPerUnitTurn;
  const full = cfg.condition?.hunger?.fullTurns ?? 30;
  const turns = (stock ?? 0) / Math.max(1e-6, troops * upkeep);
  return clamp(Math.round(100 * turns / full), 0, 100);
}

/**
 * 战力：复用 condition.js 的四个真实系数（士气 / 疲劳 / 阵型 / 断粮），
 * 不另造一套数值。纯函数，同 state 同分，便于单测逐项核对。
 */
export function fieldStrength(cfg, { troops, morale, fatigue = 0,
  formation = cfg.hidden.formationStart, grain = 100, wall = 0 } = {}) {
  const B = cfg.battle;
  const k = moraleFactor(B, morale ?? cfg.hidden.moraleStart)
    * fatigueFactor(B, fatigue)
    * formationFactor(B, formation)
    * hungerFactor(cfg, grain);
  return {
    k,
    power: Math.max(1, troops ?? 0) * (0.75 + 0.5 * k) * (1 + (wall ?? 0) / AUTO_RESOLVE.wallDiv),
  };
}

/**
 * 处理所有「滞留且无人接手」的战斗。返回 events（由 advanceTurn 汇出给界面）。
 * @param {object} state
 * @param {object} _rng 主随机源，刻意不消耗；保留在签名里是为了与 advanceTurn 对齐。
 * @param {{ graceTurns?: number, activeBattleId?: number|null,
 *           resolveBattle?: Function }} opts  resolveBattle 由 campaign.js 注入，
 *          避免 field-resolve.js ← campaign.js 的循环 import。
 */
export function resolveDormantBattles(state, _rng, opts = {}) {
  const cfg = state.cfg;
  const grace = opts.graceTurns ?? AUTO_RESOLVE.graceTurns;
  const active = opts.activeBattleId ?? null;
  const resolveBattle = opts.resolveBattle ?? (() => { throw new Error('resolveBattle 未注入'); });
  const out = [];
  const battles = Object.values(state.battles ?? {}).sort((a, b) => a.id - b.id);

  for (const b of battles) {
    if (b.id === active) continue;                       // 玩家正在子界面里打，绝不插手
    if (AUTO_RESOLVE.onlyAiAttacker && b.attacker === state.playerFaction) continue;
    if (state.turn - b.startTurn < grace) continue;      // 还没到救援窗口

    const city = b.city;
    const c = state.cities[city];
    const f = state.forces[city] ?? { inside: [], camp: [] };
    if (!c) continue;

    const atkTroops = (f.camp ?? [])
      .filter((u) => u.faction === b.attacker && (u.hp ?? 1) > 0)
      .reduce((a, u) => a + (u.troops ?? u.count ?? 0), 0);
    const defTroops = c.garrison;

    // 独立派生流：不碰主 rng，AI 序列 / rngCalls / 双时钟全部原样。
    const r = createRng((state.rngSeed >>> 0) ^ Math.imul(b.id, 7919) ^ 0x5f3759df);
    const atkGrain = grainPct(cfg, state.resources?.[b.attacker]?.grain, atkTroops);
    const defGrain = grainPct(cfg, c.grain, defTroops);
    const atk = fieldStrength(cfg, {
      troops: atkTroops, morale: cfg.hidden.moraleStart,
      fatigue: cfg.hidden.fatiguePerMarchTurn, grain: atkGrain, wall: 0,
    });
    const def = fieldStrength(cfg, {
      troops: defTroops, morale: c.morale, fatigue: c.fatigue,
      formation: c.formation, grain: defGrain, wall: c.wall,
    });

    const roll = r.next();
    const surv = r.next();
    const variance = 1 - AUTO_RESOLVE.variance / 2 + AUTO_RESOLVE.variance * roll;
    // 大营空了（撤兵 / 被截粮）就是退兵，不靠随机数硬翻盘。
    const won = atkTroops > 0 && atk.power * variance > def.power;
    const [a, bRange] = won ? AUTO_RESOLVE.survivorWin : AUTO_RESOLVE.survivorHold;
    const survivors = Math.max(0, Math.round((won ? atkTroops : defTroops) * (a + bRange * surv)));
    const defender = c.owner;

    appendCommand(state.commandLog, {
      turn: state.turn, actor: '__auto__', type: 'autoResolve',
      payload: {
        city, battleId: b.id, attacker: b.attacker, defender, won,
        atkTroops, defTroops, survivors, resolveSeed: (state.rngSeed >>> 0) ^ Math.imul(b.id, 7919) ^ 0x5f3759df,
      },
      rngBefore: state.rngCalls, rngAfter: state.rngCalls,  // 独立流，主序列不动
    });

    // 复用既有回写：owner / 栅格归属 / wall / morale / garrison / forces.inside。
    // 返回值这里不必判，因为 battles[b.id] 刚从 state.battles 里取出来，必存在。
    resolveBattle(state, {
      city, battleId: b.id, attacker: b.attacker, won, survivors,
      commanderCaptured: won && surv > 0.7, endTurn: state.turn,
    });

    // 简算不保留逐帧残部：把大营里该攻方的单位清掉，否则 200 旬后
    // forces.camp 会无限堆积，存档与状态指纹一起膨胀。
    const ff = state.forces[city];
    if (ff) ff.camp = (ff.camp ?? []).filter((u) => u.faction !== b.attacker);

    out.push({
      type: 'autoResolve', city, battleId: b.id, attacker: b.attacker,
      defender, won, survivors, owner: state.cities[city].owner,
    });
  }
  return out;
}
