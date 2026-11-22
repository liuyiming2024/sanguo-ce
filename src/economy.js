// 旬结算：率土-like 的「旬」闭环。
//
// 旧版两处失真，这里一次改掉：
//  ① 每座城都加「全势力总产量」（c.grain += yieldByOwner[owner].grain），
//     12 城等于把全境产粮记 12 遍，粮草只涨不跌，断粮 debuff 永远不触发；
//  ② resources[f].grain（发令扣的势力库存）与 cities[id].grain（征兵扣的城仓）
//     两套账互不往来，于是「征兵还是屯田」没有代价。
//
// 新口径：地块产量按各城「所辖己方地块数」分摊进城仓；驻军与在途部队按旬耗粮；
// 不足即断粮 —— 掉军心、逃兵、征兵受阻。势力库存仍照旧由 collectResources 累加，
// 但发令前多一道军粮账校验，逼出「先屯田增产 / 撤兵减耗，再谈征发」的取舍。
//
// 纯逻辑：无 DOM、无墙钟、无 Math.random。派生账 commissary 刻意不进
// stateFingerprint —— 它由 yield / garrison / orders 完全决定，同序列重放必然同值。

export const COMMISSARY = {
  garrisonUpkeep: 0.12,   // 与 cfg.hidden.grainUpkeepPerUnitTurn 同源
  fieldUpkeep: 0.07,      // 在途部队约为驻军两倍口粮
  starvationGrace: 2,     // 连续断粮几旬后军心崩、开始逃兵
  startReserve: 600,      // 开局周转粮（势力库存初值，由装配层注入）
  routRate: 0.015,        // 断粮每旬逃兵比例
  rationRate: 1.0,        // 势力库存按旬承担全部驻军/在途耗粮：库存 = 产 − 耗的累积
  starvingYield: 0.6,     // 断粮城所辖地块本旬产量打折：缺粮不只掉军心，还压产粮
};

/** 懒初始化：旧存档没有这本账，读进来第一旬自动补上，不改其它字段。 */
export function commissaryOf(state, fid) {
  (state.commissary ??= {});
  if (!state.commissary[fid]) {
    state.commissary[fid] = {
      grain: COMMISSARY.startReserve, shortageTurns: 0,
      lastIncome: 0, lastUpkeep: 0, lastNet: 0, lastTurn: -1,
    };
  }
  return state.commissary[fid];
}

/**
 * 一旬结算。由 advanceTurn 在 collectResources 之后调用一次。
 * 返回旬计簿（纯展示，可进战报），并写 state.commissary / 各城 starving。
 */
export function settleXun(state, yieldByOwner) {
  const cfg = state.cfg;
  const upkeepPerUnit = cfg.hidden?.grainUpkeepPerUnitTurn ?? COMMISSARY.garrisonUpkeep;
  const ledger = { turn: state.turn, byFaction: {}, starving: [] };

  for (const f of cfg.factions) {
    const fid = f.id;
    const ownCities = Object.values(state.cities).filter((c) => c.owner === fid);
    const totalIncome = yieldByOwner?.[fid]?.grain ?? state.yield?.[fid]?.grain ?? 0;

    // ① 产量分摊：按各城「所辖己方地块数」权重，无地城按人口兜底，绝不整份重复记。
    // 一次遍历建索引，避免 32 城 × 15552 格逐城 reduce。
    const tileCount = new Map();
    for (const t of state.terrain.tiles) {
      if (t.owner === fid && t.cityId) tileCount.set(t.cityId, (tileCount.get(t.cityId) ?? 0) + 1);
    }
    const weights = ownCities.map((c) => {
      const n = tileCount.get(c.id) ?? 0;
      return n > 0 ? n : Math.max(1, Math.round(c.pop / 10000));
    });
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;

    // ② 在途军粮按发令城归集，从该城城仓扣。
    const fieldByCity = {};
    for (const o of state.orders) {
      if ((o.faction ?? state.playerFaction) !== fid) continue;
      const n = Object.values(o.units ?? {}).reduce((a, b) => a + b, 0);
      fieldByCity[o.from] = (fieldByCity[o.from] ?? 0) + n * COMMISSARY.fieldUpkeep;
    }

    let income = 0, garrisonUpkeep = 0, fieldUpkeep = 0, routed = 0;
    ownCities.forEach((c, i) => {
      const share = totalIncome * (weights[i] / wSum) * (c.besieged ? 0.45 : 1);
      const gUp = c.garrison * upkeepPerUnit;
      const fUp = fieldByCity[c.id] ?? 0;
      income += share; garrisonUpkeep += gUp; fieldUpkeep += fUp;
      c.grain = Math.round((c.grain + share - gUp - fUp) * 100) / 100;
      if (c.grain >= 0) {
        c.starving = false;
        c.starveTurns = 0;
      } else {
        c.grain = 0;
        c.starving = true;
        c.starveTurns = (c.starveTurns ?? 0) + 1;
        c.morale = Math.max(cfg.hidden?.moraleMin ?? 0, c.morale - 2.2);
        if (c.starveTurns > COMMISSARY.starvationGrace) {
          const lost = Math.min(c.garrison, Math.round(c.garrison * COMMISSARY.routRate));
          c.garrison -= lost; routed += lost;
        }
        ledger.starving.push({ city: c.id, faction: fid, turns: c.starveTurns });
      }
    });

    // ③ 势力军粮账：只记「本旬流量 / 净额 / 断粮旬数」，不另起一本虚拟储备。
    // 长局实测教训：旧版把每旬净额累加成 reserve，200 旬跌到 −34 万，
    // 而势力库存反而涨到 8 万 —— 两个数字互不相干，玩家看了只会更糊涂。
    // 现在 reserve 直接读 state.resources[fid].grain（顶栏「粮」那本账），
    // 它与 collectResources 的入账、发令扣费、配给扣粮是同一份，逐字可对。
    const acct = commissaryOf(state, fid);
    const net = Math.round((income - garrisonUpkeep - fieldUpkeep) * 10) / 10;
    acct.lastIncome = Math.round(income * 10) / 10;
    acct.lastUpkeep = Math.round((garrisonUpkeep + fieldUpkeep) * 10) / 10;
    acct.lastNet = net;
    acct.lastTurn = state.turn;
    const starvingCities = ownCities.filter((c) => c.starving).length;
    acct.starvingCities = starvingCities;
    // 断粮只看城仓，不看总净额：大城亏、小城盈时总账仍可能为正，
    // 但已经在饿肚子的那座城不该因为「全局尚有余粮」被放过。
    acct.shortageTurns = starvingCities > 0 ? acct.shortageTurns + 1 : 0;

    // ④ 势力库存配给：state.resources[fid].grain 才是发令时真正扣的那一本账。
    // collectResources 每旬先把全境产粮入账，这里再把驻军/在途耗粮整份扣回去，
    // 于是库存 = 历旬结余累积。「多征兵 / 多出征 → 由盈转亏 → 发不出令」，
    // 「屯田增产 / 撤兵减耗 → 回血」。城仓管城池死活，库存管能不能出兵。
    const ration = Math.round((garrisonUpkeep + fieldUpkeep) * COMMISSARY.rationRate * 10) / 10;
    const pool = state.resources?.[fid];
    if (pool) {
      pool.grain = Math.round((pool.grain - ration) * 10) / 10;
      // 库存见底不写成负数：断粮的后果落在城仓（掉军心 / 逃兵）与征发锁上，
      // 不把资源池压成 NaN 或让下游扣费出现负数判定。
      if (pool.grain < 0) pool.grain = 0;
    }
    acct.ration = ration;

    const garrison = ownCities.reduce((a, c) => a + c.garrison, 0);
    const field = state.orders.filter((o) => (o.faction ?? state.playerFaction) === fid)
      .reduce((a, o) => a + Object.values(o.units ?? {}).reduce((x, y) => x + y, 0), 0);
    ledger.byFaction[fid] = {
      name: f.name, income: Math.round(income * 10) / 10,
      garrison, field,
      garrisonUpkeep: Math.round(garrisonUpkeep * 10) / 10,
      fieldUpkeep: Math.round(fieldUpkeep * 10) / 10,
      net, reserve: Math.round((state.resources?.[fid]?.grain ?? 0) * 10) / 10,
      routed, cities: ownCities.length,
      shortageTurns: acct.shortageTurns,
    };
  }
  return ledger;
}

/** 只读汇总，供界面显示；绝不写 state。 */
export function xunLedger(state) {
  const out = { turn: state.turn, byFaction: {} };
  for (const f of state.cfg.factions) {
    const acct = state.commissary?.[f.id] ?? {
      grain: COMMISSARY.startReserve, shortageTurns: 0, lastIncome: 0, lastUpkeep: 0, lastNet: 0,
    };
    const cities = Object.values(state.cities).filter((c) => c.owner === f.id);
    const garrison = cities.reduce((a, c) => a + c.garrison, 0);
    const field = state.orders.filter((o) => (o.faction ?? state.playerFaction) === f.id)
      .reduce((a, o) => a + Object.values(o.units ?? {}).reduce((x, y) => x + y, 0), 0);
    out.byFaction[f.id] = {
      name: f.name, income: acct.lastIncome,
      garrison, field, upkeep: acct.lastUpkeep, lastNet: acct.lastNet,
      reserve: Math.round((state.resources?.[f.id]?.grain ?? 0) * 10) / 10,
      shortageTurns: acct.shortageTurns,
      locked: acct.shortageTurns >= COMMISSARY.starvationGrace,
      cities: cities.length,
      starving: cities.filter((c) => c.starving).length,
    };
  }
  return out;
}

/** 发令前的真实约束：粮账连续告罄则锁征发，屯田 / 撤兵 / 侦察仍放行。 */
export function canAffordTroops(state, faction, type) {
  const FREE = ['claim', 'develop', 'buildFort', 'scout', 'withdraw',
    'fireDirectional', 'stratagem', 'cancelOrder'];
  if (FREE.includes(type)) return { ok: true };
  const acct = commissaryOf(state, faction);
  if (acct.shortageTurns < COMMISSARY.starvationGrace) return { ok: true };
  return {
    ok: false,
    reason: `军粮告罄（连续 ${acct.shortageTurns} 旬入不敷出）：先屯田增产或撤兵减耗`,
  };
}

export function shortageReport(state) {
  const l = xunLedger(state).byFaction?.[state.playerFaction];
  if (!l || l.starving === 0 && !l.locked) return null;
  return {
    title: '军粮不继 · 征发暂止', tag: '内政', red: true,
    sub: `断粮 ${l.starving} 城 · 净额 ${l.lastNet}`,
    body: `本旬产粮 ${l.income}，驻军 ${l.garrison}、在途 ${l.field} 共耗 ${l.upkeep}。`
      + '屯田增产、撤兵减耗，或待新粮入仓后方可再征发。',
  };
}
