// 攻城子界面的「双时钟」骨架。
//
// 关键口径：战斗层不是一直空转的后台进程。点「进入」才按固定步长实时跑；
// 点「退出」拍快照 + 停跑，但策略层日历照常推进。隔一个月再点进来，
// 用 **同一个 advanceBattleStep()** 以固定步长无渲染空跑到当前时刻 —— 
// 不另写一套解析结算公式，因此「一直盯着打」与「离开再回来」结果必然一致。
//
// v0.9.1：接上真实战斗结算。实时与快进仍共用同一个 advanceBattleStep，
// 战斗层用自己独立的确定性 RNG（与策略层隔离），终局只产 battleResult，
// 归属/兵力/俘虏由 campaign.resolveBattle 回写，绝不回退到开战回合。
import { createCombat, stepCombat, combatSummary } from './siege-combat.js';
import { rngFromSnapshot } from './rng.js';
import { resolveBattle } from './campaign.js';
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
    // 城池小地图的单位实体：直接引用 campaign.forces[cityId]，
    // 退出时拍深拷贝进快照，页面刷新/再次进入可原样恢复部署。
    forcesRef: campaign.forces?.[cityId] ?? null,
    units: [],            // 兼容占位
    morale: campaign.cities[cityId]?.morale ?? cfg.hidden.moraleStart,
    cityWall: campaign.cities[cityId]?.wall ?? cfg.city.wallStart,
    commanderState: campaign.cities[cityId]?.commander.state ?? 'inOffice',
    history: [],
    // 战斗层：纯 JSON 状态 + 独立 RNG 实例（实例本身不进快照，状态进）。
    combat: createCombat(cfg, campaign, cityId, campaign.forces?.[cityId] ?? null,
      rngSnapshot ?? { state: 20261114, calls: 0 }),
    combatRng: null,
    resolution: null,
  };
  s.combatRng = rngFromSnapshot(s.combat.rngSnapshot);
  return s;
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
  // 真实战斗结算：唯一的推进函数，实时 / 快进都走这里。
  // 没有攻方单位在城内时只漂移隐藏属性，不会凭空开打（「派人进去打」）。
  if (session.combat && !session.combat.outcome) {
    if (!session.combatRng) session.combatRng = rngFromSnapshot(session.combat.rngSnapshot);
    stepCombat(session, dt, session.combatRng);
    const c = session.combat;
    // UI 读的这两个镜像值从战局同步，不再另写一套漂移公式
    session.morale = c.morale.defend;
    session.cityWall = Math.round(c.gateHp * 0.4 + c.wall * 0.6);
    session.commanderState = c.commander.state;
    // 终局只做一次：战斗层产结果，策略层改归属 / 扣兵力 / 登记俘虏
    if (c.outcome && !c._resolved) {
      c._resolved = true;
      session.resolution = resolveBattle(session.campaign, c.result);
      session.history.push({ atSec: session.sec, kind: 'battleEnd',
        city: session.cityId, reason: c.outcome.reason });
    }
  }
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
  // 战斗层 RNG 从快照重建即可；绝不 restore 策略层 rng —— 那会让离开期间
  // 策略层已经消耗过的随机序列整体回退，是两端并行下的隐藏分叉源。
  if (!session.combatRng) session.combatRng = rngFromSnapshot(session.combat.rngSnapshot);
  session.active = true;
  session.turnAtEnter = session.campaign.turn;
  // 若策略层部队池被清空（例如刷新后重建），用快照恢复部署。
  // 部署恢复统一由 restoreSession 的按 id 合并处理，这里不再覆盖策略层部队池。
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
    forces: {
      inside: (session.forcesRef?.inside ?? []).map((u) => ({ ...u })),
      camp: (session.forcesRef?.camp ?? []).map((u) => ({ ...u })),
    },
    morale: session.morale,
    cityWall: session.cityWall,
    commanderState: session.commanderState,
    historyTail: session.history.slice(-20),
    combat: JSON.parse(JSON.stringify(session.combat)),
    resolution: session.resolution,
  };
}

/** 从快照恢复一个已存在的会话（刷新页面 / 重新进入）。 */
export function restoreSession(cfg, campaign, snap) {
  const s = createSession(cfg, campaign, snap.cityId, { rngSnapshot: snap.rngSnapshot });
  s.sec = snap.sec;
  s.stepsRun = snap.stepsRun;
  s.pendingOrders = snap.pendingOrders?.slice() ?? [];
  s.units = snap.units?.slice() ?? [];
  s.forcesSnapshot = snap.forces ?? null;
  if (snap.forces && campaign.forces) {
    // 两端并行：离开期间策略层可能又到了援军（已写进 campaign.forces）。
    // 快照只负责恢复「旧单位的部署位置」，不能把新单位冲掉；按 id 合并。
    const cur = campaign.forces[snap.cityId] ?? { inside: [], camp: [] };
    const snapUnits = [...snap.forces.inside, ...snap.forces.camp];
    const byId = new Map(cur.inside.concat(cur.camp).map((u) => [u.id, u]));
    for (const u of snapUnits) {
      if (byId.has(u.id)) Object.assign(byId.get(u.id), u);   // 恢复部署/血量
      else cur[ u.zone === 'inside' ? 'inside' : 'camp' ].push({ ...u });  // 刷新页面后补回
    }
    // 按 zone 重新归位，避免快照与当前 zone 不一致
    const all = cur.inside.concat(cur.camp);
    cur.inside = all.filter((u) => u.zone === 'inside');
    cur.camp = all.filter((u) => u.zone === 'camp');
    campaign.forces[snap.cityId] = cur;
  }
  s.forcesRef = campaign.forces?.[snap.cityId] ?? null;
  s.morale = snap.morale;
  s.cityWall = snap.cityWall;
  s.commanderState = snap.commanderState;
  s.history = snap.historyTail?.slice() ?? [];
  if (snap.combat) {
    s.combat = JSON.parse(JSON.stringify(snap.combat));
    // 事件表只留尾部，防止离开一个月后快照无限膨胀
    s.combat.events = (s.combat.events ?? []).slice(-40);
    s.combatRng = rngFromSnapshot(s.combat.rngSnapshot);
    // 两端并行：离开期间策略层新抵达的援军按 id 合并进战局（新单位下一帧
    // 由 stepCombat 的 ensureUnitState 接管），旧单位沿用快照里的战斗状态。
    s.combat.blockedKeys = s.combat.blockedKeys ?? [];
  } else {
    s.combatRng = rngFromSnapshot(s.combat.rngSnapshot);
  }
  s.resolution = snap.resolution ?? null;
  return s;
}
