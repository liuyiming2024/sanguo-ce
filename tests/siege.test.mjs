// v0.9.2：攻城战闭环 —— 网格寻路 / 隐藏属性 / 投射物 / 溃散擒主帅 /
// 双时钟一致性 / 终局回写不回退。全部纯逻辑，无 DOM / 墙钟 / Math.random。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cfg from '../config/campaign.json' with { type: 'json' };
import { createCampaign, getForces, deployUnit, resolveBattle } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { createSession, advanceBattleStep, enterSession, leaveSession, restoreSession } from '../src/battle-session.js';
import { cityObstacles, findCityPath, nearestFree, keyOf } from '../src/siege-grid.js';
import { generalFor, facilityLevel } from '../src/generals.js';

const mk = () => {
  const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });
  s.cfg.factions.forEach((f) => { f.ai = false; });
  return s;
};

test('城内障碍：府衙 3×3 / 四处仓井 / 城墙列，城门留通道', () => {
  const b = cityObstacles(cfg);
  assert.ok(b.has(keyOf(19, 8)) && b.has(keyOf(18, 7)) && b.has(keyOf(20, 9)));
  assert.ok(b.has(keyOf(6, 3)) && b.has(keyOf(7, 4)));
  assert.ok(!b.has(keyOf(0, 8)) && !b.has(keyOf(0, 7)) && !b.has(keyOf(0, 9)));
  assert.ok(b.has(keyOf(0, 0)) && b.has(keyOf(0, 15)));
});

test('A* 绕开府衙而不是直线穿过，且禁止贴角穿墙', () => {
  const blocked = cityObstacles(cfg);
  const r = findCityPath({ col: 2, row: 8 }, { col: 22, row: 8 },
    { cols: 24, rows: 16, blocked });
  assert.ok(r.ok, r.reason);
  assert.ok(r.path.length > 2);
  assert.ok(r.path.every((p) => !blocked.has(keyOf(p.col, p.row))),
    '路径踩进了障碍格');
  // 相邻两步若走对角，两个正交邻格必须都可通行
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1], b = r.path[i];
    if (a.col !== b.col && a.row !== b.row) {
      assert.ok(!blocked.has(keyOf(b.col, a.row)) && !blocked.has(keyOf(a.col, b.row)),
        '贴角穿越了障碍');
    }
  }
  const alt = nearestFree({ col: 19, row: 8 }, { cols: 24, rows: 16, blocked });
  assert.ok(alt && !blocked.has(keyOf(alt.col, alt.row)));
});

test('五维与设施等级只进公式、不写进界面字段', () => {
  const s = mk();
  const g = generalFor(cfg, s, 'xudu');
  assert.equal(g.name, '荀彧');
  assert.ok(g.intellect > g.force && g.politics > 90);
  const g2 = generalFor(cfg, s, 'baima');
  assert.equal(g2.name, '颜良');
  assert.ok(g2.force > 85);
  s.facilities = { chengzhufu: 3, mofang: 2 };
  assert.ok(facilityLevel(s, 'xudu') >= 5);
});

test('城外扎营不等于开打：不派人进城，守军不动、大营不空', () => {
  const s = mk();
  const f = getForces(s, 'liyang');
  f.camp.push({ id: 'atk1', type: 'daodun', faction: 'cao', zone: 'camp',
    hp: 100, maxHp: 100, col: 1, row: 3, troops: 120 });
  const rng = createRng(9);
  const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
  enterSession(sess, rng);
  const before = f.inside.map((u) => `${u.col}:${u.row}`).join('|');
  for (let i = 0; i < 120; i++) advanceBattleStep(sess, cfg.battle.fixedStepSec);
  assert.equal(f.camp.length, 1, '大营被系统自动搬空了');
  assert.equal(f.inside.map((u) => `${u.col}:${u.row}`).join('|'), before,
    '没派人进去，守军却自己乱走');
  assert.equal(sess.combat.outcome, null);
  assert.equal(sess.combat.stats.kills, 0);
});

test('派人进城才开打：投射物飞行、战损、军师计策生效', () => {
  const s = mk();
  const f = getForces(s, 'liyang');
  f.camp.push({ id: 'atk1', type: 'gongnu', faction: 'cao', zone: 'camp',
    hp: 70, maxHp: 70, col: 1, row: 3, troops: 120 });
  f.camp.push({ id: 'atk2', type: 'junshi', faction: 'cao', zone: 'camp',
    hp: 60, maxHp: 60, col: 1, row: 5, troops: 60 });
  const rng = createRng(11);
  const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
  enterSession(sess, rng);
  deployUnit(s, 'liyang', 'atk1', 'inside', 4, 8);
  deployUnit(s, 'liyang', 'atk2', 'inside', 3, 8);
  const hp0 = f.inside.filter((u) => u.faction === 'yuan').reduce((n, u) => n + u.hp, 0);
  for (let i = 0; i < 600; i++) advanceBattleStep(sess, cfg.battle.fixedStepSec);
  assert.ok(sess.combat.stats.hits > 0, '没有任何命中');
  assert.ok(sess.combat.stats.volleys > 0, '远程没有发矢');
  assert.ok(sess.combat.stats.stratagems > 0, '军师计策没有触发');
  const hp1 = f.inside.filter((u) => u.faction === 'yuan' && (u.hp ?? 0) > 0)
    .reduce((n, u) => n + u.hp, 0);
  assert.ok(hp1 < hp0, '打了十秒守军毫发无损');
});

test('士气崩 → 溃散 → 主帅失护卫 → 被擒/阵亡 → 终局结果', () => {
  const s = mk();
  const f = getForces(s, 'liyang');
  const rng = createRng(5);
  const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
  enterSession(sess, rng);
  const c = sess.combat;
  // 直接压到溃散阈值以下并清掉护卫，验证状态机而非靠慢磨
  c.morale.defend = cfg.battle.moraleRoutThreshold - 1;
  for (const u of f.inside) {
    if (u.faction === 'yuan') { u.hp = 0; u.state = 'dead'; }
  }
  // 必须先「派人进去打」：城外扎营本身不触发交战判定
  f.camp.push({ id: 'atk1', type: 'daodun', faction: 'cao', zone: 'camp',
    hp: 100, maxHp: 100, col: 1, row: 3, troops: 120 });
  deployUnit(s, 'liyang', 'atk1', 'inside', 4, 8);
  for (let i = 0; i < 6 && !c.outcome; i++) advanceBattleStep(sess, cfg.battle.fixedStepSec);
  assert.ok(c.outcome, '守军尽没后应立刻判终局');
  assert.ok(c.result && c.result.won);
  assert.ok(c.result.reason.length > 0);
  assert.ok(c.result.endTurn >= 0);
  assert.ok(typeof c.result.commanderCaptured === 'boolean');
});

test('双时钟：一直盯着打 与 退出隔几旬再回来 逐字段一致', () => {
  const build = () => {
    const s = mk();
    const f = getForces(s, 'liyang');
    f.camp.push({ id: 'atk1', type: 'gongnu', faction: 'cao', zone: 'camp',
      hp: 70, maxHp: 70, col: 1, row: 3, troops: 120 });
    f.camp.push({ id: 'atk2', type: 'daodun', faction: 'cao', zone: 'camp',
      hp: 100, maxHp: 100, col: 1, row: 5, troops: 120 });
    const rng = createRng(21);
    const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
    enterSession(sess, rng);
    deployUnit(s, 'liyang', 'atk1', 'inside', 4, 8);
    deployUnit(s, 'liyang', 'atk2', 'inside', 5, 8);
    return { s, sess, rng };
  };
  // 16 模拟秒 = 4 旬（secPerTurn=4）。B 在第 1 旬退出，策略层照走到第 4 旬，
  // 再点进来由同一个 advanceBattleStep 无渲染快进补齐 —— 两边总步数必须相等。
  const N = 960, LEAVE = 240;
  const A = build();
  for (let i = 0; i < N; i++) advanceBattleStep(A.sess, cfg.battle.fixedStepSec);

  const B = build();
  for (let i = 0; i < LEAVE; i++) advanceBattleStep(B.sess, cfg.battle.fixedStepSec);
  const snap = leaveSession(B.sess, B.rng);
  B.s.turn = 4;                       // 两端并行：战斗停跑，日历继续
  const B2 = restoreSession(cfg, B.s, snap);
  const ff = enterSession(B2, B.rng);
  assert.ok(ff.ok && ff.fastForwardSteps === N - LEAVE,
    `快进步数应为 ${N - LEAVE}，实得 ${ff.fastForwardSteps}`);

  assert.equal(B2.stepsRun, A.sess.stepsRun);
  assert.equal(B2.combat.stats.hits, A.sess.combat.stats.hits);
  assert.equal(B2.combat.stats.volleys, A.sess.combat.stats.volleys);
  assert.equal(B2.combat.stats.kills, A.sess.combat.stats.kills);
  assert.equal(B2.combat.stats.stratagems, A.sess.combat.stats.stratagems);
  assert.equal(Math.round(B2.combat.gateHp), Math.round(A.sess.combat.gateHp));
  assert.equal(Math.round(B2.combat.morale.defend), Math.round(A.sess.combat.morale.defend));
  assert.equal(B2.combat.commander.state, A.sess.combat.commander.state);
  assert.equal(B2.combat.rngSnapshot.calls, A.sess.combat.rngSnapshot.calls);
  assert.equal(!!B2.combat.outcome, !!A.sess.combat.outcome);
});

test('终局回写按 battleEndTurn，不回退到开战回合，也不清空大营', () => {
  const s = mk();
  s.turn = 7;
  const f = getForces(s, 'liyang');
  f.camp.push({ id: 'camp1', type: 'daodun', faction: 'cao', zone: 'camp',
    hp: 100, maxHp: 100, col: 1, row: 3, troops: 120 });
  const bid = s.nextBattleId++;
  s.battles[bid] = { id: bid, city: 'liyang', attacker: 'cao', startTurn: 2 };
  s.cities.liyang.battleId = bid;
  const r = resolveBattle(s, {
    city: 'liyang', battleId: bid, won: false, attacker: 'cao',
    commanderCaptured: false, survivors: 300, endTurn: 9,
  });
  assert.ok(r.ok && r.endTurn === 9, '终局被回退到开战回合');
  assert.equal(s.cities.liyang.battleId, null);
  assert.equal(f.camp.length, 1, '退兵把城外大营清空了');
});


test('v0.9.2：战斗粮草由策略层真实存粮折算，且随快照恢复', () => {
  const s = mk();
  const f = getForces(s, 'liyang');
  f.camp.push({ id: 'atk1', type: 'daodun', faction: 'cao', zone: 'camp',
    hp: 100, maxHp: 100, col: 1, row: 3, troops: 6000 });
  const rng = createRng(31);
  const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
  const g0 = sess.combat.grain.attack;
  assert.ok(g0 > 0 && g0 < 100, `攻方粮草应由出征兵数与势力库存折算，实得 ${g0}`);
  assert.ok(sess.combat.grain.defend > 0 && sess.combat.grain.defend <= 100);
  enterSession(sess, rng);
  deployUnit(s, 'liyang', 'atk1', 'inside', 4, 8);
  for (let i = 0; i < 300; i++) advanceBattleStep(sess, cfg.battle.fixedStepSec);
  assert.ok(sess.combat.grain.attack < g0, '战斗推进应消耗粮草');
  const snap = leaveSession(sess, rng);
  const s2 = restoreSession(cfg, s, snap);
  assert.equal(s2.combat.grain.attack, snap.combat.grain.attack,
    '快照恢复丢了粮草，退出再进来档位会跳');
});

test('v0.9.2：断粮是真实 debuff，同样步数下打出的伤害更低', () => {
  const build = (grain) => {
    const s = mk();
    const f = getForces(s, 'liyang');
    f.camp.push({ id: 'atk1', type: 'gongnu', faction: 'cao', zone: 'camp',
      hp: 70, maxHp: 70, col: 1, row: 3, troops: 120 });
    const rng = createRng(41);
    const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
    enterSession(sess, rng);
    deployUnit(s, 'liyang', 'atk1', 'inside', 6, 8);
    // 固定成同一场景，只改粮草；消耗关掉，保证是断粮系数本身造成的差异
    sess.combat.grain.attack = grain;
    sess.cfg = JSON.parse(JSON.stringify(sess.cfg));
    sess.cfg.battle.grainDrainPerSec = 0;
    return { s, sess };
  };
  const hpSum = (x) => getForces(x.s, 'liyang').inside
    .filter((u) => u.faction === 'yuan').reduce((n, u) => n + (u.hp ?? 0), 0);
  const A = build(100), B = build(0);
  for (let i = 0; i < 420; i++) {
    advanceBattleStep(A.sess, cfg.battle.fixedStepSec);
    advanceBattleStep(B.sess, cfg.battle.fixedStepSec);
  }
  assert.equal(A.sess.combat.stats.hits, B.sess.combat.stats.hits,
    '两组命中数应相同，否则比较的不是同一份系数');
  assert.ok(hpSum(B) > hpSum(A),
    `断粮应真实降低伤害：满粮守军剩 ${hpSum(A)}，断粮剩 ${hpSum(B)}`);
});
