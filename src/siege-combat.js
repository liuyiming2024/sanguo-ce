// 攻城战斗结算（v0.9.2）。纯逻辑：无 DOM / 墙钟 / Math.random，固定步长，
// 实时与快照快进共用同一个 stepCombat，因此「盯着打」与「隔月回来」必然一致。
//
// 口径界线：战斗层只产 battleResult（胜负 / 主帅是否被擒 / 存活兵力 / 耗时）；
// 归属变更、兵力扣减、俘虏登记全部交给 campaign.resolveBattle（策略层）。
// 战斗层可以改单位实体的 hp / 格位 / 士气 / 疲劳，因为这些本来就是部队状态，
// 要跟着快照走；但不碰城池归属、不碰资源、不写命令日志。
import { cityObstacles, findCityPath, nearestExit, keyOf } from './siege-grid.js';
import { headingFromDelta, normAngle } from './direction.js';
import { generalFor, facilityLevel } from './generals.js';
import {
  moraleFactor, fatigueFactor, formationFactor, hungerFactor, marchFactor,
  initialGrain, conditionLine,
} from './condition.js';

const alive = (u) => u && u.state !== 'dead' && u.state !== 'escaped' && (u.hp ?? 1) > 0;
const dist = (a, b) => Math.hypot(a.col - b.col, a.row - b.row);

export function createCombat(cfg, campaign, cityId, forcesRef, rngSnapshot) {
  const city = campaign.cities[cityId];
  const defender = city.owner;
  const all = [...(forcesRef?.inside ?? []), ...(forcesRef?.camp ?? [])];
  const attacker = all.find((u) => u.faction !== defender)?.faction ?? campaign.playerFaction;
  const gen = generalFor(cfg, campaign, cityId);
  // 设施是全局表，等级总和可能几十级；城防初始值只取前 6 级的加成，
  // 否则一座满设施城的城门耐久会撑到四位数，耐久条直接溢出画面。
  const lvl = Math.min(6, facilityLevel(campaign, cityId));
  const F = cfg.facilities.effects;
  const B = cfg.battle;
  const cmd = {
    id: `cmd-${cityId}`, name: gen.name, side: 'defend',
    col: Math.max(1, cfg.cityView.yamen.col - 2), row: cfg.cityView.yamen.row,
    hp: B.commanderHp, maxHp: B.commanderHp, guard: 0,
    state: 'inOffice', loyalty: gen.loyalty,
  };
  return {
    cityId, defender, attacker, general: gen,
    sec: 0, blockedKeys: [...cityObstacles(cfg)],
    projects: [], nextProjectileId: 1, nextStratagem: 0,
    morale: { attack: cfg.hidden.moraleStart,
      defend: Math.min(B.moraleMax, cfg.hidden.moraleStart + F.moralePerLevel * lvl) },
    alert: { attack: cfg.hidden.alertStart, defend: cfg.hidden.alertStart },
    // 粮草不是假血条：按「存粮够吃几旬」从策略层真实库存/城存粮折算。
    grain: initialGrain(cfg, campaign, cityId, forcesRef, attacker),
    wall: B.wallHp + F.wallRepairPerLevel * lvl,
    gateHp: B.gateHp + F.gateHpPerLevel * lvl,
    yamenHp: B.yamenHp,
    // 耐久条分母随实际初始值走，不能用配置常量硬除
    wallMax: B.wallHp + F.wallRepairPerLevel * lvl,
    gateHpMax: B.gateHp + F.gateHpPerLevel * lvl,
    yamenHpMax: B.yamenHp,
    commander: cmd,
    events: [], outcome: null, result: null,
    rngSnapshot: rngSnapshot ?? { state: 20261114, calls: 0 },
    stats: { hits: 0, kills: 0, volleys: 0, stratagems: 0, routed: 0 },
  };
}

function unitsIn(session) {
  const f = session.forcesRef;
  if (!f) return [];
  return f.inside.filter(alive);
}

function ensureUnitState(cfg, u, side) {
  if (u.side === undefined) {
    u.side = side;
    u.morale = cfg.hidden.moraleStart;
    u.fatigue = 0;
    u.alert = cfg.hidden.alertStart;
    u.formation = cfg.hidden.formationStart;
    u.cooldown = 0;
    u.stratagemCooldown = cfg.battle.stratagemCooldownSec * 0.5;
    u.state = 'fight';
    u.path = null; u.pathIdx = 0; u.pathAt = 0;
    u.targetId = null;
    u.heading = side === 'attack' ? Math.PI / 2 : -Math.PI / 2;
    u.assaultDir = null;
  }
  return u;
}

function moveToward(cfg, c, u, goal, dt, blocked, occupied) {
  const def = cfg.units[u.type];
  const speedTiles = Math.max(0.35, def.speed / cfg.battle.pxPerTile);
  const now = u.pathAt + dt;
  u.pathAt = now;
  if (!u.path || u.pathIdx >= u.path.length - 1 || now > 0.9 || u.pathGoalKey !== keyOf(goal.col, goal.row)) {
    const p = findCityPath(u, goal, {
      cols: cfg.cityView.cols, rows: cfg.cityView.rows,
      blocked, occupied,
    });
    if (p.ok) { u.path = p.path; u.pathIdx = 0; u.pathGoalKey = keyOf(goal.col, goal.row); }
    else u.path = null;
    u.pathAt = 0;
  }
  // 断粮时行军迟滞：debuff 不只是文字，兵是真的走得慢。
  let budget = speedTiles * dt * marchFactor(cfg, c.grain[u.side]);
  while (budget > 0 && u.path && u.pathIdx < u.path.length - 1) {
    const next = u.path[u.pathIdx + 1];
    const dx = next.col - u.col, dy = next.row - u.row;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) { u.pathIdx++; continue; }
    const step = Math.min(budget, d);
    u.col += (dx / d) * step; u.row += (dy / d) * step;
    u.heading = normAngle(headingFromDelta(dx, dy, u.heading));
    budget -= step;
    if (step >= d - 1e-6) u.pathIdx++;
  }
}

function damageOf(cfg, c, def, gen, u, targetSide) {
  const B = cfg.battle, E = cfg.generals.effects;
  // 与 condition.js 同源：界面上那句「约减一两成」就是这几个系数乘出来的。
  const moraleK = moraleFactor(B, u.morale);
  const fatigueK = fatigueFactor(B, u.fatigue);
  const formK = formationFactor(B, u.formation);
  const hungerK = hungerFactor(cfg, c.grain[u.side]);
  const g = def.projectile
    ? (gen.intellect - 50) / E.intellectRangedDiv
    : (gen.force - 50) / E.forceMeleeDiv;
  // 守方主帅统率只加成守军（拦截效率），攻方用自己主帅的统率折算士气
  const cmdK = 1 + (targetSide === 'defend' ? (gen.command - 50) / E.commandMoraleDiv : 0);
  return def.dmg * moraleK * fatigueK * formK * hungerK * (1 + g) * cmdK;
}

function applyDamage(cfg, c, u, dmg, src, rng) {
  u.hp = Math.max(0, (u.hp ?? cfg.units[u.type].hp) - dmg);
  c.stats.hits++;
  if (u.hp <= 0) {
    u.state = 'dead'; c.stats.kills++;
    c.events.push({ sec: +c.sec.toFixed(3), kind: 'unitDown', id: u.id, side: u.side, by: src?.id ?? null });
    const side = u.side;
    c.morale[side] = Math.max(0, c.morale[side] - cfg.battle.moraleLossPerAllyDown);
  }
}

function spawnProjectile(cfg, c, u, def, dirX, dirY, dmg) {
  const n = Math.hypot(dirX, dirY) || 1;
  const sp = cfg.battle.projectileSpeed[def.projectile] ?? 8;
  c.projects.push({
    id: c.nextProjectileId++, type: def.projectile, side: u.side,
    col: u.col, row: u.row, vx: (dirX / n) * sp, vy: (dirY / n) * sp,
    dmg, ttl: cfg.battle.projectileTtlSec[def.projectile] ?? 3,
    ownerId: u.id, arc: def.projectile === 'stone' ? 1 : 0,
  });
  c.stats.volleys++;
}

function consumeOrders(session, c, cfg) {
  for (const e of session.pendingOrders) {
    if (e._done || e.city !== c.cityId) continue;
    e._done = true;
    if (e.kind === 'fireDirectional') {
      const dir = e.direction ?? { x: 1, y: 0 };
      for (const u of unitsIn(session)) {
        if (e.selection?.length && !e.selection.includes(u.id)) continue;
        const def = cfg.units[u.type];
        if (!def) continue;
        if (def.projectile) {
          spawnProjectile(cfg, c, u, def, dir.x, dir.y, damageOf(cfg, c, def, c.general, u, u.side === 'attack' ? 'defend' : 'attack'));
          u.cooldown = Math.max(u.cooldown, cfg.battle.rangedCooldownSec);
        } else {
          // 近战单位吃同一条指令 = 向该方向突击，不是站着不动
          u.assaultDir = { x: dir.x, y: dir.y, ttl: 3.2 };
        }
      }
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'volley', n: e.selection?.length ?? 0 });
    } else if (e.kind === 'stratagem' && e.stratagem) {
      // 军令帖里的计策由玩家指定，交给最近一名军师执行
      for (const u of unitsIn(session)) {
        if (cfg.units[u.type]?.support && u.side === 'attack') { u.pendingStratagem = e.stratagem; break; }
      }
    } else if (e.kind === 'reinforce') {
      c.morale.attack = Math.min(100, c.morale.attack + 4);
      c.morale.defend = Math.max(0, c.morale.defend - cfg.battle.moraleLossPerEnemyReinforce);
      // 两端并行：援军按抵达时刻进「城外大营」，不打断正在进行的战斗，
      // 也不由系统替玩家投入 —— 投入始终是把兵拖进城里的那个动作。
    }
  }
}

function runStratagem(cfg, campaign, c, u, dt) {
  u.stratagemCooldown -= dt;
  if (u.stratagemCooldown > 0) return;
  const T = cfg.tactics;
  const names = Object.keys(T);
  const name = u.pendingStratagem && T[u.pendingStratagem]
    ? u.pendingStratagem : names[c.nextStratagem++ % names.length];
  u.pendingStratagem = null;
  const t = T[name];
  u.stratagemCooldown = cfg.battle.stratagemCooldownSec;
  if (t.morale) c.morale[u.side] = Math.min(100, c.morale[u.side] + t.morale);
  if (t.alert) {
    const foe = u.side === 'attack' ? 'defend' : 'attack';
    c.alert[foe] = Math.max(0, c.alert[foe] + t.alert);
  }
  if (t.wall) c.wall = Math.max(0, c.wall + t.wall);
  if (t.gate) c.gateHp = Math.max(0, c.gateHp + t.gate);
  c.stats.stratagems++;
  c.events.push({ sec: +c.sec.toFixed(3), kind: 'stratagem', name, by: u.id, side: u.side });
}

function stepProjectiles(cfg, c, dt, units) {
  const B = cfg.battle;
  const keep = [];
  for (const p of c.projects) {
    p.col += p.vx * dt; p.row += p.vy * dt; p.ttl -= dt;
    if (p.ttl <= 0 || p.col < -1 || p.col > cfg.cityView.cols + 1 ||
        p.row < -1 || p.row > cfg.cityView.rows + 1) continue;
    let hit = null;
    for (const u of units) {
      if (u.side === p.side || !alive(u)) continue;
      if (Math.hypot(u.col - p.col, u.row - p.row) <= B.hitRadiusTiles) { hit = u; break; }
    }
    if (hit) {
      applyDamage(cfg, c, hit, p.dmg, { id: p.ownerId }, null);
      if (p.type === 'stone') {
        // 石弹溅射：不引入魔法，只是范围内多受一份递减伤害
        for (const u of units) {
          if (u === hit || u.side === p.side || !alive(u)) continue;
          if (Math.hypot(u.col - p.col, u.row - p.row) <= 1.25)
            applyDamage(cfg, c, u, p.dmg * 0.55, { id: p.ownerId }, null);
        }
      }
      continue;
    }
    // 器械不在敌方身边时，投射物可打城门 / 府衙
    if (p.side === 'attack' && p.arc && p.col >= 0) {
      if (Math.abs(p.row - cfg.cityView.gate.row) < 1.2 && p.col < 2.4) {
        c.gateHp = Math.max(0, c.gateHp - p.dmg * 0.8);
        c.events.push({ sec: +c.sec.toFixed(3), kind: 'gateHit', dmg: +(p.dmg * 0.8).toFixed(2) });
        continue;
      }
    }
    keep.push(p);
  }
  c.projects = keep;
}

function judge(cfg, c, attack, defend, rng) {
  const B = cfg.battle;
  if (c.commander.state === 'captured' || c.commander.state === 'dead')
    return { won: true, reason: c.commander.state === 'captured' ? '主帅被擒' : '主帅阵亡' };
  if (c.yamenHp <= 0 && defend.length === 0) return { won: true, reason: '府衙陷落' };
  if (defend.length === 0 && attack.length > 0) return { won: true, reason: '守军尽没' };
  if (attack.length === 0) return { won: false, reason: '攻方尽退' };
  if (c.sec >= B.maxBattleSec) return { won: false, reason: '师老粮尽，攻方撤退' };
  return null;
}

/** 唯一战斗推进函数。dt 固定；rng 是战斗层自己的确定性源，与策略层隔离。 */
export function stepCombat(session, dt, rng) {
  const c = session.combat;
  if (!c || c.outcome) return c;
  const cfg = session.cfg, B = cfg.battle;
  c.sec += dt;
  const f = session.forcesRef;
  if (!f) return c;
  const blocked = new Set(c.blockedKeys);
  const occupied = new Set();

  // 先到先打 = 玩家派进城里的第一批立刻开打，不等后续援军；
  // 「在城外扎营」本身不等于开打，守军不会自己乱走、大营不会被系统搬空。
  // 阵营按「城池归属」实时判定：攻方把兵拖进城里，side 自动成立。
  for (const u of f.inside) {
    if (u.side === undefined) ensureUnitState(cfg, u, u.faction === c.defender ? 'defend' : 'attack');
  }
  // 城内没有攻方 = 纯扎营 / 布防：只漂移隐藏属性与消费邮箱，不推进交战。
  const active = f.inside.some((u) => alive(u) && u.faction !== c.defender);
  const all = active ? unitsIn(session) : [];
  // 只把「别的单位占据的格」当占用，自己脚下不算
  for (const u of all) occupied.add(keyOf(Math.round(u.col), Math.round(u.row)));
  consumeOrders(session, c, cfg);

  const attack = all.filter((u) => u.side === 'attack');
  const defend = all.filter((u) => u.side === 'defend');

  for (const u of all) {
    const def = cfg.units[u.type];
    if (!def) continue;
    u.cooldown = Math.max(0, u.cooldown - dt);
    u.fatigue = Math.min(100, u.fatigue + B.fatiguePerSec * dt * 100 / 60);
    u.morale = Math.max(0, Math.min(100, u.morale + (c.morale[u.side] - u.morale) * 0.02));
    if (def.support) { runStratagem(cfg, session.campaign, c, u, dt); continue; }
    if (u.state === 'rout') {
      const ex = nearestExit(u, cfg);
      u.col = Math.max(0, u.col - B.routSpeedTilesPerSec * dt);
      u.row += Math.sign(ex.row - u.row) * Math.min(Math.abs(ex.row - u.row), B.routSpeedTilesPerSec * dt * 0.5);
      if (u.col <= 0.05) { u.state = 'escaped'; u.zone = 'camp'; c.stats.routed++; }
      continue;
    }
    if (u.assaultDir) {
      u.assaultDir.ttl -= dt;
      u.col = Math.max(0, Math.min(cfg.cityView.cols - 1, u.col + u.assaultDir.x * 0.0006 * def.speed * dt));
      u.row = Math.max(0, Math.min(cfg.cityView.rows - 1, u.row + u.assaultDir.y * 0.0006 * def.speed * dt));
      u.heading = normAngle(headingFromDelta(u.assaultDir.x, u.assaultDir.y, u.heading));
      if (u.assaultDir.ttl <= 0) u.assaultDir = null;
    }

    const foes = u.side === 'attack' ? defend : attack;
    let target = null, best = Infinity;
    for (const v of foes) {
      if (!alive(v)) continue;
      const d = dist(u, v);
      if (d < best) { best = d; target = v; }
    }
    const rangeTiles = def.range / B.pxPerTile;
    const myKey = keyOf(Math.round(u.col), Math.round(u.row));
    const otherOcc = new Set([...occupied]); otherOcc.delete(myKey);

    if (target && best <= rangeTiles && u.cooldown <= 0) {
      u.targetId = target.id;
      const dmg = damageOf(cfg, c, def, c.general, u, target.side);
      if (def.projectile) {
        spawnProjectile(cfg, c, u, def, target.col - u.col, target.row - u.row, dmg);
        u.cooldown = B.rangedCooldownSec * (def.projectile === 'stone' ? 1.7 : 1);
      } else {
        applyDamage(cfg, c, target, dmg, u, rng);
        u.cooldown = B.meleeCooldownSec;
        u.heading = normAngle(headingFromDelta(target.col - u.col, target.row - u.row, u.heading));
      }
    } else if (target && best > rangeTiles) {
      moveToward(cfg, c, u, { col: Math.round(target.col), row: Math.round(target.row) }, dt, blocked, otherOcc);
    } else if (!target && u.side === 'attack') {
      // 无近敌：器械与重甲拆城门 / 府衙，其余向府衙推进
      const goal = { col: c.gateHp > 0 ? cfg.cityView.gate.col + 2 : cfg.cityView.yamen.col - 2,
        row: cfg.cityView.yamen.row };
      if (def.projectile || def.kind === 'siege') {
        const dGate = Math.hypot(u.col - cfg.cityView.gate.col, u.row - cfg.cityView.gate.row);
        const dYamen = Math.hypot(u.col - cfg.cityView.yamen.col, u.row - cfg.cityView.yamen.row);
        if (u.cooldown <= 0 && (dGate <= rangeTiles || dYamen <= rangeTiles)) {
          const dmg = damageOf(cfg, c, def, c.general, u, 'defend');
          if (dYamen <= rangeTiles && c.gateHp <= 0) {
            c.yamenHp = Math.max(0, c.yamenHp - dmg);
            c.events.push({ sec: +c.sec.toFixed(3), kind: 'yamenHit', dmg: +dmg.toFixed(2) });
          } else {
            c.gateHp = Math.max(0, c.gateHp - dmg);
            c.wall = Math.max(0, c.wall - dmg * 0.45);
            c.events.push({ sec: +c.sec.toFixed(3), kind: 'gateHit', dmg: +dmg.toFixed(2) });
          }
          u.cooldown = B.siegeCooldownSec;
        } else if (dGate > rangeTiles && dYamen > rangeTiles) {
          moveToward(cfg, c, u, goal, dt, blocked, otherOcc);
        }
      } else moveToward(cfg, c, u, goal, dt, blocked, otherOcc);
    }
  }

  if (active || c.projects.length) stepProjectiles(cfg, c, dt, all);

  // 隐藏属性漂移：粮草、士气、警觉、城防修复（政治影响修复速度）
  const E = cfg.generals.effects;
  const repair = Math.max(0, (c.general.politics - 50) / E.politicsWallRepairDiv) * dt;
  c.wall = Math.min(c.wallMax ?? B.wallHp, c.wall + repair);
  for (const side of ['attack', 'defend']) {
    c.grain[side] = Math.max(0, c.grain[side] - B.grainDrainPerSec * dt * 100);
    if (c.grain[side] < 12) c.morale[side] = Math.max(0, c.morale[side] - 0.35 * dt * 10);
    // 粮尽难以回气：恢复量按同一份断粮系数衰减，下限锁住不会负恢复。
    const recoverK = Math.max(cfg.condition.hunger.moraleRecoverFloor,
      hungerFactor(cfg, c.grain[side]));
    c.morale[side] = Math.min(B.moraleMax,
      c.morale[side] + B.moraleRecoverPerSec * dt * recoverK);
    c.alert[side] = Math.min(100, c.alert[side] + 0.02 * dt * 10);
    if (c.morale[side] < B.moraleRoutThreshold) {
      for (const u of all) if (u.side === side && u.state === 'fight') {
        u.state = 'rout';
        c.events.push({ sec: +c.sec.toFixed(3), kind: 'rout', id: u.id, side });
      }
    }
  }

  // 主帅：护卫被清空 + 攻方近身 → 暴露 → 士气崩才进入被擒判定
  const guards = defend.filter((u) => alive(u) && u.state !== 'rout' &&
    dist(u, c.commander) <= B.commanderExposeRadius + 1).length;
  const intruders = attack.filter((u) => alive(u) && dist(u, c.commander) <= B.commanderExposeRadius);
  c.commander.guard = guards;
  if (c.commander.state === 'inOffice' && guards < B.commanderGuardMin && intruders.length > 0)
    c.commander.state = 'exposed';
  if (c.commander.state === 'exposed' && intruders.length > 0) {
    const nearest = Math.min(...intruders.map((u) => dist(u, c.commander)));
    if (nearest < 1.15 && c.morale.defend < B.moraleRoutThreshold * 1.8) {
      const p = B.captureChanceBase - c.commander.loyalty / B.captureLoyaltyDiv;
      c.commander.state = rng.chance(Math.max(0.08, Math.min(0.92, p))) ? 'captured' : 'dead';
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'commander',
        state: c.commander.state, name: c.commander.name });
    }
  }

  // 溃散逃出的单位回城外大营：撤出按存活数回写，不凭空抹掉
  const escaped = f.inside.filter((u) => u.state === 'escaped');
  if (escaped.length) {
    f.inside = f.inside.filter((u) => u.state !== 'escaped');
    for (const u of escaped) {
      u.col = 1; u.row = 3 + (f.camp.length % 6) * 2;
      f.camp.push(u);
    }
  }

  const a2 = unitsIn(session).filter((u) => u.side === 'attack');
  const d2 = unitsIn(session).filter((u) => u.side === 'defend');
  const verdict = active ? judge(cfg, c, a2, d2, rng) : null;
  if (verdict) {
    c.outcome = verdict;
    c.result = combatResult(session, a2, d2);
  }
  c.rngSnapshot = (rng ?? session.combatRng).snapshot();
  return c;
}

/** 只回传结果，不碰城池归属。battleId 按需补建，绝不回退到开战回合。 */
export function combatResult(session, attack = [], defend = []) {
  const campaign = session.campaign, cfg = session.cfg, c = session.combat;
  const city = campaign.cities[c.cityId];
  let battleId = city.battleId;
  if (!battleId || !campaign.battles[battleId]) {
    battleId = campaign.nextBattleId++;
    campaign.battles[battleId] = {
      id: battleId, city: c.cityId, attacker: c.attacker,
      startTurn: campaign.turn,
      startSec: campaign.turn * cfg.calendar.secPerTurn,
    };
    city.battleId = battleId; city.besieged = true;
  }
  const survivors = [...attack, ...defend].reduce((s, u) => s + (u.troops ?? 1), 0);
  return {
    city: c.cityId, battleId, won: !!c.outcome?.won, attacker: c.attacker,
    commanderCaptured: c.commander.state === 'captured',
    commanderState: c.commander.state,
    survivors,
    casualties: { attack: c.stats.kills, defend: c.stats.kills },
    shots: c.stats.volleys, stratagems: c.stats.stratagems,
    reason: c.outcome?.reason ?? '',
    endTurn: Math.floor(session.sec / cfg.calendar.secPerTurn),
    sec: +session.sec.toFixed(3),
  };
}

export function combatSummary(c, cfg = null, units = []) {
  if (!c) return '未开战';
  if (c.outcome) return `${c.outcome.won ? '城破' : '退兵'} · ${c.outcome.reason}`;
  // 主界面不再摊开精确士气：平时只报军情如常，严重时给一句大概的 debuff。
  if (cfg) {
    const a = conditionLine(cfg, c, 'attack', units);
    const d = conditionLine(cfg, c, 'defend', units);
    const alarm = a.show || d.show ? ` · ${a.show ? a.text : d.text}` : '';
    return `交战中 · ${alarm ? alarm.slice(3) : '军情如常'}`;
  }
  return '交战中 · 军情如常';
}
