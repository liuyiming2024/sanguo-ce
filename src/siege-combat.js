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

const alive = (u) => u && u.state !== 'dead' && u.state !== 'escaped' && u.state !== 'captured' && (u.hp ?? 1) > 0;
const dist = (a, b) => Math.hypot(a.col - b.col, a.row - b.row);

/* 将领技能按五维派生：力高从速攻、智高从干扰、统高从发育、政高从防御，
   其余按最高维兜底。对照墨战卡牌四类（发育/速攻/防御/干扰），但技能是
   将领自己在场上放，不是局前选卡 —— 用户口径「他应该是一个特殊的兵」。 */
export function pickGeneralSkill(gen) {
  const G = { force: gen?.force ?? 58, intellect: gen?.intellect ?? 55,
              command: gen?.command ?? 62, politics: gen?.politics ?? 54 };
  if (G.force >= 90) return 'fengshi';
  if (G.force >= 84) return 'luanwu';
  if (G.intellect >= 86) return 'yibing';
  if (G.politics >= 90) return 'yibing';
  if (G.command >= 72) return 'duzhan';
  if (G.politics >= 76) return 'duzhan';
  const top = Object.entries(G).sort((a, b) => b[1] - a[1])[0][0];
  return top === 'force' ? 'luanwu' : top === 'intellect' ? 'yibing'
       : top === 'command' ? 'duzhan' : 'gushou';
}
export const GENERAL_SKILL_LABEL = {
  fengshi: '锋矢突阵', yibing: '疑兵', duzhan: '督战', gushou: '固守', luanwu: '乱舞',
};
export const GENERAL_SKILL_COLOR = {
  fengshi: 'rgba(196,92,58,.92)', yibing: 'rgba(96,132,150,.92)',
  duzhan: 'rgba(200,168,106,.92)', gushou: 'rgba(120,146,112,.92)',
  luanwu: 'rgba(166,49,41,.92)',
};

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
  /* 主将不再是「坐在府衙里的一个框」：它是一支真实的特殊兵，
     与刀盾/弓弩同样进 all 循环 —— 有格位、会走 A*、会索敌、会出手、
     会被投射物命中、会被 applyDamage 打死；倒下直接崩己方士气并进终局判定。
     不塞进 forcesRef.inside，所以不污染策略层兵力表 / 存档回写。 */
  const cmd = {
    id: `general-${cityId}`, type: 'jiangjun', isGeneral: true,
    name: gen.name, side: 'defend', faction: defender, zone: 'inside',
    // 离府衙留三格：立绘与题名不压在府衙建筑上（实拍确认贴太近会读成一团）
    col: Math.max(1, cfg.cityView.yamen.col - 4), row: cfg.cityView.yamen.row,
    hp: B.commanderHp, maxHp: B.commanderHp, guard: 0, troops: 1,
    state: 'fight', exposed: false, loyalty: gen.loyalty,
    morale: cfg.hidden.moraleStart, fatigue: 0, alert: cfg.hidden.alertStart,
    formation: cfg.hidden.formationStart, cooldown: 0,
    stratagemCooldown: B.stratagemCooldownSec * 0.5,
    path: null, pathIdx: 0, pathAt: 0, targetId: null,
    heading: -Math.PI / 2, assaultDir: null,
    // 技能 / 攻击样式：确定性，不引入新随机源，快照可直接 JSON 往返
    // 首放要早：短兵相接可能两三秒就分出胜负，冷却 4.5s 会让整场放不出技能
    skill: pickGeneralSkill(gen), skillCd: 1.2,
    attackSeq: 0, styleBias: (gen.force ?? 58) >= 84 ? 2 : (gen.intellect ?? 55) >= 84 ? 1 : 0,
    anim: null, guardUntil: 0, confusedUntil: 0, restUntil: 0, empowered: 0,
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
  const GS = cfg.battle.generalSkill ?? {};
  if (u.guardUntil > c.sec) dmg *= GS.guardDmgK ?? 0.45;
  u.hp = Math.max(0, (u.hp ?? cfg.units[u.type].hp) - dmg);
  c.stats.hits++;
  if (u.hp <= 0) {
    u.state = 'dead'; c.stats.kills++;
    c.events.push({ sec: +c.sec.toFixed(3), kind: 'unitDown', id: u.id, side: u.side, by: src?.id ?? null });
    const side = u.side;
    c.morale[side] = Math.max(0, c.morale[side] - cfg.battle.moraleLossPerAllyDown);
    // 将领是真兵，阵亡不是一行文案：己方士气直接归零，下一帧 judge 立刻判城破
    if (u.isGeneral) {
      c.morale[side] = 0;
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'commander', state: 'dead', name: u.name });
    }
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

/** 将领的一个战斗步：不是「找最近敌人打一下」的循环，而是四种攻击样式
    轮换 + 一个按五维派生的主动技能。样式序号确定性推进，重放必然一致。
    伤害仍走通用 applyDamage，所以将领真会挨打、会被打死。 */
function generalAct(cfg, c, u, dt, foes, friends, blocked, occupied) {
  const B = cfg.battle, GS = B.generalSkill ?? {}, ST = B.generalAttack?.styles ?? [];
  u.skillCd = Math.max(0, (u.skillCd ?? 0) - dt);
  let target = null, best = Infinity;
  for (const v of foes) {
    if (!alive(v)) continue;
    const d = dist(u, v);
    if (d < best) { best = d; target = v; }
  }
  const def = cfg.units[u.type];
  const rangeTiles = def.range / B.pxPerTile;
  const baseDmg = def.dmg;
  const anim = (style, dur = .42, extra = {}) => {
    u.anim = { style, skill: null, t0: c.sec, dur, ...extra };
  };
  // 车悬阵：连续五次出手后短先后撤休整，不是把同一个挥砍动画无限循环。
  if (u.restUntil > c.sec) {
    const back = u.side === 'defend' ? 1 : -1;
    u.col = Math.max(0, Math.min(cfg.cityView.cols - 1, u.col + back * dt * 1.6));
    u.anim = { style: 'xiuzheng', skill: null, t0: c.sec, dur: .3 };
    return;
  }

  // ── 主动技能：冷却到且有敌在附近才放，放完这一帧不再普攻 ──
  // 技能是战局级手段（对照墨战卡牌）：半城之内有敌即可发，且开局必放一次，
  // 否则文士型守将（荀彧/审配）守在府衙附近时整场放不出技能。
  if (u.skillCd <= 0 && target && (best <= 9.0 || c.sec < 5)) {
    const sk = u.skill;
    if (sk === 'fengshi') {
      // 锋矢阵：前端将领临时霸体，突进期间不被疑兵/减伤打断
      u.guardUntil = c.sec + (GS.fengshiGuardSec ?? 2.2);
      u.empowered = GS.empoweredHits ?? 2;
      // 速攻：向敌突进一段，落点对周围一片高伤
      const dx = (target.col - u.col), dy = (target.row - u.row), d = Math.hypot(dx, dy) || 1;
      const L = GS.lungeTiles ?? 1.15;
      u.col = Math.max(0, Math.min(cfg.cityView.cols - 1, u.col + dx / d * L));
      u.row = Math.max(0, Math.min(cfg.cityView.rows - 1, u.row + dy / d * L));
      u.heading = normAngle(headingFromDelta(dx, dy, u.heading));
      for (const v of foes) if (alive(v) && dist(u, v) <= (GS.sweepRadius ?? 1.6))
        applyDamage(cfg, c, v, baseDmg * 1.55, u, null);
    } else if (sk === 'luanwu') {
      // 多段：不是一次大数字，是四下连续短笔
      u.empowered = 1;
      const n = GS.luanwuHits ?? 4;
      for (let i = 0; i < n; i++)
        if (alive(target)) applyDamage(cfg, c, target, baseDmg * .58, u, null);
      u.heading = normAngle(headingFromDelta(target.col - u.col, target.row - u.row, u.heading));
    } else if (sk === 'yibing') {
      // 连锁流：先破防（疑兵），后输出 —— 下两击加重，不是孤立放个技能
      u.empowered = GS.empoweredHits ?? 2;
      // 干扰：范围内敌人短暂丢失目标（只漂移、不索敌）
      let n = 0;
      for (const v of foes) if (alive(v) && dist(u, v) <= 2.6) {
        v.confusedUntil = c.sec + (GS.confuseSec ?? 1.7); n++;
      }
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'generalSkill', skill: sk, n });
    } else if (sk === 'duzhan') {
      u.empowered = 1;
      // 发育：己方士气抬一档，近旁友军回气，主将自己不凭空满血
      c.morale[u.side] = Math.min(B.moraleMax, c.morale[u.side] + (GS.moraleGain ?? 12));
      let n = 0;
      for (const v of friends) if (alive(v) && dist(u, v) <= 3.2) {
        v.morale = Math.min(100, (v.morale ?? 0) + 18); n++;
      }
      u.hp = Math.min(u.maxHp, u.hp + baseDmg * .35);
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'generalSkill', skill: sk, n });
    } else {
      // 防御：短时减伤 + 少量回气
      u.guardUntil = c.sec + (GS.guardSec ?? 4.2);
      u.hp = Math.min(u.maxHp, u.hp + baseDmg * .55);
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'generalSkill', skill: sk, n: 0 });
    }
    if (sk === 'fengshi' || sk === 'luanwu')
      c.events.push({ sec: +c.sec.toFixed(3), kind: 'generalSkill', skill: sk, n: 1 });
    c.events.push({ sec: +c.sec.toFixed(3), kind: 'generalAnim', style: sk, name: u.name });
    u.skillCd = GS.cd?.[sk] ?? 10;
    u.anim = { style: null, skill: sk, t0: c.sec, dur: .9 };
    u.cooldown = .45;
    return;
  }

  // ── 普攻：四种样式按确定性序号轮换，起手/收势各不相同 ──
  if (target && best <= rangeTiles + .45 && u.cooldown <= 0 && ST.length) {
    const st = ST[(u.attackSeq + u.styleBias) % ST.length];
    u.attackSeq++;
    u.targetId = target.id;
    if (st.lunge) {
      const dx = target.col - u.col, dy = target.row - u.row, d = Math.hypot(dx, dy) || 1;
      u.col = Math.max(0, Math.min(cfg.cityView.cols - 1, u.col + dx / d * st.lunge));
      u.row = Math.max(0, Math.min(cfg.cityView.rows - 1, u.row + dy / d * st.lunge));
    }
    const victims = st.targets > 1
      ? foes.filter((v) => alive(v) && dist(u, v) <= rangeTiles + .9).slice(0, st.targets)
      : [target];
    const boost = u.empowered > 0 ? (GS.empoweredDmgK ?? 1.28) : 1;
    if (u.empowered > 0) u.empowered--;
    for (const v of victims) if (alive(v))
      applyDamage(cfg, c, v, baseDmg * st.dmg * boost, u, null);
    u.cooldown = st.cd;
    // 车悬：第五击后撤休整，下一轮从别的样式重新起手
    if (u.attackSeq % (GS.restEvery ?? 5) === 0) u.restUntil = c.sec + (GS.restSec ?? .62);
    u.heading = normAngle(headingFromDelta(target.col - u.col, target.row - u.row, u.heading));
    anim(st.id, st.windup ? .62 : .42, { windup: st.windup ?? 0 });
    c.events.push({ sec: +c.sec.toFixed(3), kind: 'generalAnim', style: st.id, name: u.name });
  } else if (target && best > rangeTiles) {
    moveToward(cfg, c, u, { col: Math.round(target.col), row: Math.round(target.row) },
      dt, blocked, occupied);
  }
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
  const all = active ? [...unitsIn(session), ...(alive(c.commander) ? [c.commander] : [])] : [];
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
    // 疑兵：只原地漂移，不索敌不出手，时间由 c.sec 给出（快照可还原）
    if (u.confusedUntil > c.sec) continue;
    // 将领是特殊的兵：有自己的技能与四种攻击样式，不复用普通兵的单一循环
    if (u.isGeneral) {
      const foes = u.side === 'attack' ? attack : defend;
      const friends = u.side === 'attack' ? attack : defend;
      const myKey = keyOf(Math.round(u.col), Math.round(u.row));
      const occ = new Set([...occupied]); occ.delete(myKey);
      generalAct(cfg, c, u, dt, foes, friends, blocked, occ);
      continue;
    }
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
        // 将领不随众溃散：真兵要死战到底，护卫散尽即暴露
        if (u.isGeneral) { u.exposed = true; continue; }
        u.state = 'rout';
        c.events.push({ sec: +c.sec.toFixed(3), kind: 'rout', id: u.id, side });
      }
    }
  }

  // 主将与被擒：护卫清空 + 攻方贴身 + 守方士气崩，才可能被生擒。
  // 主将自己也在 defend 里真刀真枪地打，这里不再把它从 inOffice 翻成 exposed。
  const guards = defend.filter((u) => alive(u) && !u.isGeneral && u.state !== 'rout' &&
    dist(u, c.commander) <= B.commanderExposeRadius + 1).length;
  const intruders = attack.filter((u) => alive(u) && dist(u, c.commander) <= B.commanderExposeRadius);
  c.commander.guard = guards;
  if (alive(c.commander) && guards < B.commanderGuardMin && intruders.length > 0)
    c.commander.exposed = true;
  if (alive(c.commander) && c.commander.exposed && intruders.length > 0) {
    const nearest = Math.min(...intruders.map((u) => dist(u, c.commander)));
    if (nearest < 1.15 && c.morale.defend < B.moraleRoutThreshold * 1.8) {
      const p = B.captureChanceBase - c.commander.loyalty / B.captureLoyaltyDiv;
      // rng.chance 调用次数与旧版一致，实时 / 快进 / 重放的随机序列不变
      c.commander.state = rng.chance(Math.max(0.08, Math.min(0.92, p))) ? 'captured' : 'dead';
      c.commander.hp = 0; c.morale.defend = 0;
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
  const d2 = [...unitsIn(session).filter((u) => u.side === 'defend'),
              ...(alive(c.commander) ? [c.commander] : [])];
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
