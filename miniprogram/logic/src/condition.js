// 军情档位：只读战斗状态派生「大概」的显示，不写任何状态。
//
// 关键口径（v0.9.2）：粮草常驻显示档位；士气 / 疲劳 / 阵型这些隐藏属性
// 平时不摊开精确数值，只在严重时浮出一个模糊的 debuff。
// 更要紧的是「大概」不能骗人 —— 档位所用的系数，就是 damageOf / moveToward
// 真正乘上去的那几个函数。同一份系数，一个进公式，一个翻成中文约数。
//
// 纯函数：无 DOM、无墙钟、无 Math.random、不写 combat / 存档 / 命令日志。

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 士气伤害系数（与 damageOf 同源）。 */
export function moraleFactor(B, morale) {
  return B.dmgMoraleFloor + (1 - B.dmgMoraleFloor) * clamp(morale ?? 0, 0, 100) / 100;
}
/** 疲劳伤害系数。 */
export function fatigueFactor(B, fatigue) {
  return Math.max(0.5, 1 - (fatigue ?? 0) / B.dmgFatigueDiv);
}
/** 阵型完整度伤害系数。 */
export function formationFactor(B, formation) {
  return B.dmgFormationFloor + (1 - B.dmgFormationFloor) * clamp(formation ?? 100, 0, 100) / 100;
}
/** 断粮伤害系数：粮草低于阈值才开始衰减，下限锁住，不会归零。 */
export function hungerFactor(cfg, grain) {
  const H = cfg.condition.hunger;
  const v = clamp(grain ?? 100, 0, 100);
  if (v >= H.startBelow) return 1;
  const t = (H.startBelow - v) / H.startBelow;
  return Math.max(H.floor, 1 - (1 - H.floor) * t);
}
/** 断粮行军系数：走得慢是玩家能看见的 debuff，不只是数字。 */
export function marchFactor(cfg, grain) {
  const H = cfg.condition.hunger;
  return H.marchFloor + (1 - H.marchFloor) * hungerFactor(cfg, grain);
}

/**
 * 战斗层粮草初值：0–100 = 「这批粮够吃几旬」/ 30 旬。
 * 攻方用势力库存与其出征兵数，守方用城存粮与守军数，口径与策略层
 * grainUpkeepPerUnitTurn 一致，所以子界面显示的档位是真后勤，不是假血条。
 */
export function initialGrain(cfg, campaign, cityId, forcesRef, attacker) {
  const C = cfg.condition.hunger;
  const upkeep = cfg.hidden.grainUpkeepPerUnitTurn;
  const city = campaign.cities[cityId] ?? {};
  const all = [...(forcesRef?.inside ?? []), ...(forcesRef?.camp ?? [])];
  const atkTroops = Math.max(1, all.filter((u) => u.faction === attacker)
    .reduce((s, u) => s + (u.troops ?? 1), 0));
  const defTroops = Math.max(1, city.garrison ?? 1);
  const pct = (stock, troops) => {
    const turns = (stock ?? 0) / Math.max(1e-6, troops * upkeep);
    return clamp(Math.round(100 * turns / C.fullTurns), C.minStart, 100);
  };
  return {
    attack: pct(campaign.resources?.[attacker]?.grain ?? 0, atkTroops),
    defend: pct(city.grain ?? 0, defTroops),
  };
}

/** 粮草档位：常驻显示，只有中文标签，没有数值。 */
export function grainTier(cfg, grain) {
  // 档位表按 min 降序，取第一个满足的；不能取最后一个（会落到「断粮」）。
  for (const x of cfg.condition.grainTiers) {
    if ((grain ?? 0) >= x.min) return { label: x.label, min: x.min };
  }
  const last = cfg.condition.grainTiers[cfg.condition.grainTiers.length - 1];
  return { label: last.label, min: last.min };
}

/** 正常状态的战力系数：开局士气/阵型本就不是满值，拿它当 debuff 的零点。 */
export function baselineFactor(cfg) {
  return moraleFactor(cfg.battle, cfg.hidden.moraleStart)
    * fatigueFactor(cfg.battle, 0)
    * formationFactor(cfg.battle, cfg.hidden.formationStart)
    * 1;
}

/** 把连续的综合战力系数翻成模糊档位。 */
function tierOf(cfg, loss) {
  const tiers = cfg.condition.debuffTiers;
  let t = tiers[0];
  for (const x of tiers) if (loss >= x.minLoss) t = x;
  return t;
}

/**
 * 派生某一方的军情。units 可取战斗层可见单位（没有 side 时按阵营推）。
 * 返回 label / debuff 全是中文约数，不含阿拉伯数字或小数；
 * factors 是精确系数，只给「军情细目 · 展开」用，不上主界面。
 */
export function deriveCondition(cfg, combat, side, units = []) {
  const B = cfg.battle;
  const mine = units.filter((u) => {
    if ((u.hp ?? 1) <= 0 || u.state === 'dead' || u.state === 'escaped') return false;
    const s = u.side ?? (u.faction === combat.attacker ? 'attack' : 'defend');
    return s === side;
  });
  const avg = (fn, dflt) => mine.length
    ? mine.reduce((s, u) => s + fn(u), 0) / mine.length : dflt;
  const morale = avg((u) => u.morale ?? combat.morale[side], combat.morale[side]);
  const fatigue = avg((u) => u.fatigue ?? 0, 0);
  const formation = avg((u) => u.formation ?? cfg.hidden.formationStart, cfg.hidden.formationStart);
  const grain = combat.grain[side];

  const fMorale = moraleFactor(B, morale);
  const fFatigue = fatigueFactor(B, fatigue);
  const fFormation = formationFactor(B, formation);
  const fHunger = hungerFactor(cfg, grain);
  const k = fMorale * fFatigue * fFormation * fHunger;
  // debuff 说的是「比正常状态差了多少」，不是「离理论满值差多少」——
  // 否则开局 72 士气 / 80 阵型就被判成军心动摇，严重档失去意义。
  const loss = clamp(1 - k / baselineFactor(cfg), 0, 1);
  const t = tierOf(cfg, loss);
  return {
    side, tier: t.tier, loss,
    show: t.tier >= cfg.condition.showFromTier,
    label: t.label, debuff: t.debuff,
    grain: grainTier(cfg, grain),
    factors: { morale: fMorale, fatigue: fFatigue, formation: fFormation, hunger: fHunger, k },
  };
}

/** 主界面一行：常驻粮草档位，严重时缀一个模糊 debuff。 */
export function conditionLine(cfg, combat, side, units = []) {
  const c = deriveCondition(cfg, combat, side, units);
  return {
    ...c,
    text: c.show ? `${c.label} · ${c.debuff}` : `粮草 · ${c.grain.label}`,
  };
}

/**
 * 策略层城池（无 combat 对象）的大概军心：平时如常，严重时给模糊 debuff。
 * grainKnown=false 用于斥候情报 —— 斥候探不到粮仓，不能拿缺失字段当断粮。
 */
export function cityCondition(cfg, city, { grainKnown = true } = {}) {
  const B = cfg.battle;
  const upkeep = cfg.hidden.grainUpkeepPerUnitTurn;
  const turns = (city.grain ?? 0) / Math.max(1e-6, (city.garrison ?? 1) * upkeep);
  const grainPct = grainKnown
    ? clamp(Math.round(100 * turns / cfg.condition.hunger.fullTurns), 0, 100)
    : 100;
  const k = moraleFactor(B, city.morale ?? cfg.hidden.moraleStart)
    * fatigueFactor(B, city.fatigue ?? 0)
    * formationFactor(B, cfg.hidden.formationStart)
    * hungerFactor(cfg, grainPct);
  const t = tierOf(cfg, clamp(1 - k / baselineFactor(cfg), 0, 1));
  return {
    tier: t.tier, show: t.tier >= cfg.condition.showFromTier,
    label: t.label, debuff: t.debuff, grain: grainTier(cfg, grainPct),
    text: t.tier >= cfg.condition.showFromTier ? `${t.label} · ${t.debuff}` : '如常',
  };
}
