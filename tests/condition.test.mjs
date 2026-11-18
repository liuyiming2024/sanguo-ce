// v0.9.2：粮草常驻显示大概档位；士气等隐藏属性只在严重时给模糊 debuff。
// 重点是「大概不能骗人」：档位所用的系数必须与真实伤害/行军同源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cfg from '../config/campaign.json' with { type: 'json' };
import {
  clamp, moraleFactor, fatigueFactor, formationFactor, hungerFactor,
  marchFactor, baselineFactor, initialGrain, grainTier, deriveCondition,
  conditionLine, cityCondition,
} from '../src/condition.js';
import { createCampaign, collectResources } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { createSession, advanceBattleStep, enterSession, leaveSession, restoreSession } from '../src/battle-session.js';

const mkCombat = (morale, grain, fatigue = 0, formation = cfg.hidden.formationStart) => ({
  attacker: 'cao', defender: 'yuan',
  morale: { attack: morale, defend: morale },
  grain: { attack: grain, defend: grain },
  _units: [
    { side: 'attack', faction: 'cao', hp: 100, state: 'fight', morale, fatigue, formation },
    { side: 'defend', faction: 'yuan', hp: 100, state: 'fight', morale, fatigue, formation },
  ],
});
const line = (c, side = 'attack') => conditionLine(cfg, c, side, c._units);

test('粮草档位按降序取第一个满足，满仓不是「断粮」', () => {
  assert.equal(grainTier(cfg, 100).label, '充足');
  assert.equal(grainTier(cfg, 55).label, '尚足');
  assert.equal(grainTier(cfg, 23).label, '偏紧');
  assert.equal(grainTier(cfg, 10).label, '将尽');
  assert.equal(grainTier(cfg, 0).label, '断粮');
  assert.ok(cfg.condition.grainTiers.every((x, i, a) => i === 0 || x.min < a[i - 1].min));
});

test('开局正常状态：粮草档位常驻，debuff 不显示，文案无精确数字', () => {
  const c = mkCombat(72, 100);
  const l = line(c);
  assert.equal(l.show, false);
  assert.equal(l.text, '粮草 · 充足');
  assert.equal(l.grain.label, '充足');
  assert.equal(l.tier, 0);
  for (const s of ['attack', 'defend']) {
    const d = deriveCondition(cfg, c, s, c._units);
    assert.ok(!/\d/.test(`${d.label}${d.debuff}${d.grain.label}`), '大概文案里混进了阿拉伯数字');
  }
});

test('轻度缺粮只是档位变化，不触发 debuff（「严重时」才给）', () => {
  const l = line(mkCombat(72, 23));
  assert.equal(l.grain.label, '偏紧');
  assert.equal(l.show, false, '轻度缺粮不该弹告急');
});

test('严重时浮出模糊 debuff，仍不含任何精确数值', () => {
  for (const [m, g, f] of [[60, 10, 20], [30, 0, 45], [24, 0, 60]]) {
    const d = deriveCondition(cfg, mkCombat(m, g, f), 'attack', mkCombat(m, g, f)._units);
    assert.ok(d.show, `士气${m}/粮${g}/疲${f} 应判严重`);
    assert.ok(d.tier >= cfg.condition.showFromTier);
    assert.ok(d.debuff.length > 0);
    assert.ok(!/[0-9.]/.test(`${d.label}${d.debuff}${d.grain.label}`),
      '大概文案里出现数字/小数');
  }
  const a = line(mkCombat(72, 100)), b = line(mkCombat(24, 0, 60));
  assert.notEqual(a.text, b.text);
});

test('档位与真实减益同源：断粮确实降伤害、缓行军、压士气恢复', () => {
  const full = hungerFactor(cfg, 100), none = hungerFactor(cfg, 0);
  assert.ok(full === 1 && none < 1 && none >= cfg.condition.hunger.floor);
  assert.ok(marchFactor(cfg, 0) < marchFactor(cfg, 100));
  assert.ok(marchFactor(cfg, 0) >= cfg.condition.hunger.marchFloor);
  // 同一份系数被 damageOf 引用，不是 UI 另写一套公式
  const combat = readFileSync(new URL('../src/siege-combat.js', import.meta.url), 'utf8');
  assert.ok(/const hungerK = hungerFactor\(cfg, c\.grain\[u\.side\]\)/.test(combat));
  assert.ok(/marchFactor\(cfg, c\.grain\[u\.side\]\)/.test(combat));
  assert.ok(/moraleFactor\(B, u\.morale\)/.test(combat) &&
    /fatigueFactor\(B, u\.fatigue\)/.test(combat) &&
    /formationFactor\(B, u\.formation\)/.test(combat));
  assert.ok(Math.abs(baselineFactor(cfg) - moraleFactor(cfg.battle, 72) *
    formationFactor(cfg.battle, 80)) < 1e-9);
});

test('粮草初值接策略层真实库存/城存粮，不是假的固定 100', () => {
  const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });
  collectResources(s);
  const f = s.forces.liyang;
  f.camp.push({ id: 'atk1', type: 'daodun', faction: 'cao', zone: 'camp',
    hp: 100, maxHp: 100, col: 1, row: 3, troops: 6000 });
  const g = initialGrain(cfg, s, 'liyang', f, 'cao');
  assert.ok(g.attack < 100, '出征兵多时攻方粮草应低于满仓');
  assert.ok(g.attack >= cfg.condition.hunger.minStart);
  assert.ok(g.defend > 0 && g.defend <= 100);
  const poor = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });
  poor.resources.cao.grain = 0;
  assert.equal(initialGrain(cfg, poor, 'liyang', f, 'cao').attack,
    cfg.condition.hunger.minStart);
});

test('策略层城池军心：平时如常，断粮+低士气才给大概 debuff', () => {
  const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });
  const c = s.cities.xudu;
  assert.equal(cityCondition(cfg, c).text, '如常');
  const bad = { ...c, morale: 20, fatigue: 70, grain: 0 };
  const d = cityCondition(cfg, bad);
  assert.ok(d.show && d.debuff.length > 0 && !/[0-9.]/.test(`${d.label}${d.debuff}`));
  // 斥候情报没有粮草字段，不能把 undefined 当断粮，否则所有情报都报「军心大乱」
  const scout = { morale: 72, fatigue: 0, garrison: 2000, wall: 100 };
  assert.equal(cityCondition(cfg, scout, { grainKnown: false }).text, '如常');
  // 记录成因：不传 grainKnown 时缺失字段确实会被当成断粮 → 所有情报都告急。
  assert.ok(cityCondition(cfg, scout).tier >= 2,
    '缺粮草字段若不显式声明，应确实被误判为断粮');
});

test('纯函数：不写 combat / 不进存档或命令日志 / 无墙钟无随机', () => {
  const src = readFileSync(new URL('../src/condition.js', import.meta.url), 'utf8');
  const body = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/Date\.|performance\.|Math\.random|localStorage|setTimeout|setInterval/.test(body));
  const c = mkCombat(50, 12, 30);
  const before = JSON.stringify(c);
  deriveCondition(cfg, c, 'attack', c._units);
  conditionLine(cfg, c, 'defend', c._units);
  assert.equal(JSON.stringify(c), before, '派生函数改写了战斗状态');
  const pers = readFileSync(new URL('../src/persist.js', import.meta.url), 'utf8');
  const sync = readFileSync(new URL('../src/sync.js', import.meta.url), 'utf8');
  assert.ok(!/condition/i.test(pers) && !/condition/i.test(sync));
});

test('双时钟：隔旬快进回来，粮草档位与 debuff 与一直盯着打完全一致', () => {
  const build = () => {
    const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });
    s.cfg.factions.forEach((f) => { f.ai = false; });
    const f = s.forces.liyang;
    f.camp.push({ id: 'atk1', type: 'gongnu', faction: 'cao', zone: 'camp',
      hp: 70, maxHp: 70, col: 1, row: 3, troops: 120 });
    const rng = createRng(21);
    const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
    enterSession(sess, rng);
    s.forces.liyang.camp[0].zone = 'inside';
    s.forces.liyang.inside.push(s.forces.liyang.camp.shift());
    return { s, sess, rng };
  };
  const N = 960, LEAVE = 240;
  const A = build();
  for (let i = 0; i < N; i++) advanceBattleStep(A.sess, cfg.battle.fixedStepSec);
  const B = build();
  for (let i = 0; i < LEAVE; i++) advanceBattleStep(B.sess, cfg.battle.fixedStepSec);
  const snap = leaveSession(B.sess, B.rng);
  B.s.turn = 4;
  const B2 = restoreSession(cfg, B.s, snap);
  enterSession(B2, B.rng);
  const units = [...B2.forcesRef.inside, ...B2.forcesRef.camp];
  const au = [...A.sess.forcesRef.inside, ...A.sess.forcesRef.camp];
  for (const side of ['attack', 'defend']) {
    const a = deriveCondition(cfg, A.sess.combat, side, au);
    const b = deriveCondition(cfg, B2.combat, side, units);
    assert.equal(b.tier, a.tier);
    assert.equal(b.label, a.label);
    assert.equal(b.grain.label, a.grain.label);
    assert.equal(Math.round(b.factors.k * 1e6), Math.round(a.factors.k * 1e6));
  }
});
