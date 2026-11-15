// 攻城子界面的「双时钟」骨架。
//
// 关键口径：战斗层不是一直空转的后台进程。点「进入」才按固定步长实时跑；
// 点「退出」拍快照 + 停跑，但策略层日历照常推进。隔一个月再点进来，
// 用 **同一个 advanceBattleStep()** 以固定步长无渲染空跑到当前时刻 —— 
// 不另写一套解析结算公式，因此「一直盯着打」与「离开再回来」结果必然一致。
//
// 第一轮不实现真实战斗结算，只把接口、快照、快进、邮箱回放与 RNG 状态定死。
export function createSession(cfg, campaign, cityId, { rngSnapshot = null } = {}) {
  const dt = cfg.battle.fixedStepSec;
  return {
    cfg, campaign, cityId,
    sec: campaign.turn * cfg.calendar.secPerTurn,
    turnAtEnter: campaign.turn,
    active: false,
    stepsRun: 0,
    rngSnapshot: rngSnapshot ?? { state: 0, calls: 0 },
    pendingOrders: [],
    units: [],            // 占位：后续接城内网格与单兵实体
    morale: campaign.cities[cityId]?.morale ?? cfg.hidden.moraleStart,
    cityWall: campaign.cities[cityId]?.wall ?? cfg.city.wallStart,
    commanderState: campaign.cities[cityId]?.commander.state ?? 'inOffice',
    history: [],
  };
}

/** 唯一的状态推进函数：实时与快进共用，保证两条路径完全一致。 */
export function advanceBattleStep(session, dt) {
  const prev = session.sec;
  session.sec += dt;
  session.stepsRun++;

  // 邮箱：按事件落在哪个固定步回放。用「整数步索引」而不是浮点秒比较，
  // 否则 1/60 累加 480 次后的 7.999999999999977 会漏掉 atSec=8 的事件，
  // 而放宽容差又会让同一步被重复消费。步索引天然唯一且帧率无关。
  const step = session.cfg.battle.fixedStepSec;
  const stepIdx = Math.round(session.sec / step);
  const prevIdx = Math.round(prev / step);
  const mb = session.campaign.mailbox;
  for (let i = 0; i < mb.length; i++) {
    const e = mb[i];
    const eIdx = Math.round(e.atSec / step);
    if (eIdx > prevIdx && eIdx <= stepIdx) {
      session.pendingOrders.push(e);
      session.history.push({ atSec: e.atSec, kind: e.kind, city: e.city ?? null });
    }
  }
  // 隐藏属性按秒漂移（与策略层同一口径）
  session.morale = Math.min(session.cfg.hidden.moraleMax,
    session.morale + session.cfg.hidden.moraleDriftPerSec * dt);
  session.cityWall = Math.max(0,
    session.cityWall - session.cfg.city.siegeWallDrainPerSec * dt * 0.02);
  return session;
}

/** 点「进入子界面」：补齐离开期间的时间，再接实时循环。 */
export function enterSession(session, rng) {
  const targetSec = session.campaign.turn * session.cfg.calendar.secPerTurn;
  const steps = Math.max(0, Math.round((targetSec - session.sec) / session.cfg.battle.fixedStepSec));
  if (steps > session.cfg.calendar.maxFastForwardSteps) {
    return { ok: false, reason: '快进步数超过上限' };
  }
  for (let i = 0; i < steps; i++) advanceBattleStep(session, session.cfg.battle.fixedStepSec);
  if (steps > 0) session.sec = targetSec;   // 消除浮点累加漂移
  // RNG 状态恢复：序列不分叉
  if (session.rngSnapshot && rng?.restore) rng.restore(session.rngSnapshot);
  session.active = true;
  session.turnAtEnter = session.campaign.turn;
  return { ok: true, fastForwardSteps: steps, sec: session.sec, pending: session.pendingOrders.length };
}

/** 实时推进一小段（由 rAF 累加器驱动）。 */
export function tickSession(session, realDt) {
  if (!session.active) return 0;
  const dt = session.cfg.battle.fixedStepSec;
  let acc = (session._acc ?? 0) + realDt;
  let n = 0;
  const guard = Math.ceil(realDt / dt) + 8;
  while (acc >= dt && n < guard) {
    acc -= dt;
    advanceBattleStep(session, dt);
    n++;
  }
  session._acc = acc;
  return n;
}

/** 点「退出子界面」：拍快照、停跑。策略层日历继续走，战斗层完全静止。 */
export function leaveSession(session, rng) {
  session.active = false;
  session._acc = 0;
  return {
    cityId: session.cityId,
    sec: session.sec,
    campaignTurn: session.campaign.turn,
    stepsRun: session.stepsRun,
    rngSnapshot: rng?.snapshot ? rng.snapshot() : session.rngSnapshot,
    pendingOrders: session.pendingOrders.slice(),
    units: session.units.slice(),
    morale: session.morale,
    cityWall: session.cityWall,
    commanderState: session.commanderState,
    historyTail: session.history.slice(-20),
  };
}

/** 从快照恢复一个已存在的会话（刷新页面 / 重新进入）。 */
export function restoreSession(cfg, campaign, snap) {
  const s = createSession(cfg, campaign, snap.cityId, { rngSnapshot: snap.rngSnapshot });
  s.sec = snap.sec;
  s.stepsRun = snap.stepsRun;
  s.pendingOrders = snap.pendingOrders?.slice() ?? [];
  s.units = snap.units?.slice() ?? [];
  s.morale = snap.morale;
  s.cityWall = snap.cityWall;
  s.commanderState = snap.commanderState;
  s.history = snap.historyTail?.slice() ?? [];
  return s;
}
