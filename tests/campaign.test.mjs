import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createCampaign, dateLabel, elapsedSec, advanceTurn, issueOrder,
  collectResources, resolveBattle, cityHidden, troopCap, isHostile,
} from '../src/campaign.js';
import { hasAdjacentTerritory, routeCities } from '../src/pathfind.js';
import { createRng, rngFromSnapshot } from '../src/rng.js';
import { CITIES } from '../src/map-data.js';
import { terrainStats } from '../src/terrain.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
// 每个用例用配置副本，便于单独关掉 AI 而不污染其它用例。
const mk = (opt = {}) => createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114, ...opt });
const run = (s, turns, seed = 7) => {
  const rng = createRng(seed);
  const all = [];
  for (let i = 0; i < turns; i++) all.push(...advanceTurn(s, rng));
  return all;
};

test('日历：建安五年二月上旬起，1 回合 = 1 旬，3 旬进一月', () => {
  const s = mk();
  assert.equal(dateLabel(s), '建安5年 · 2月上旬');   // 200 = 建安五年
  run(s, 1); assert.equal(dateLabel(s), '建安5年 · 2月中旬');
  run(s, 2); assert.equal(dateLabel(s), '建安5年 · 3月上旬');
  assert.equal(s.turn, 3);
  assert.equal(elapsedSec(s), 3 * cfg.calendar.secPerTurn);
});

test('初始状态：12 城、完整栅格、三势力资源独立', () => {
  const s = mk();
  assert.equal(Object.keys(s.cities).length, 12);
  assert.equal(s.terrain.tiles.length, 144 * 108);
  for (const f of cfg.factions) {
    assert.ok(s.resources[f.id]);
    assert.equal(typeof s.resources[f.id].wood, 'number');
  }
  const st = terrainStats(s.terrain);
  assert.ok(st.owned > 300);
});

test('资源按已占领地块时产聚合，占领新地会提高产量', () => {
  const s = mk();
  const before = collectResources(s).cao;
  assert.ok(before.grain > 0 && before.tiles > 100);
  const t = s.terrain.tiles.find((x) => !x.owner && x.cost < 90 && x.y.grain > 1 &&
    hasAdjacentTerritory(s.terrain, 'cao', x.c, x.r));
  assert.ok(t, '应存在一块可占的高产田');
  t.owner = 'cao';
  const after = collectResources(s).cao;
  assert.ok(after.grain > before.grain, `${before.grain} → ${after.grain}`);
  assert.equal(after.tiles, before.tiles + 1);
});

test('命令不即时生效：arriveTurn > 当前回合，且路径来自 A*', () => {
  const s = mk();
  const r = issueOrder(s, {
    faction: 'cao', from: 'xudu', to: 'liyang', type: 'march',
    units: { daodun: 500, gongnu: 300 },
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.order.arriveTurn > s.turn);
  assert.ok(r.order.path.length > 2);
  assert.ok(r.order.atSec > elapsedSec(s));
  assert.equal(r.order.from, 'xudu');
  assert.equal(r.order.to, 'liyang');
  assert.ok(s.orders.length === 1);
});

test('铺路命令必须连地：远离领地的格子直接拒绝', () => {
  const s = mk();
  s.cfg.factions.forEach((f) => { f.ai = false; });
  collectResources(s);   // 资源池按领地计算，命令要扣粮
  const far = s.terrain.tiles.find((x) => !x.owner && x.cost < 90 &&
    x.c > s.terrain.cols * 0.72 && !hasAdjacentTerritory(s.terrain, 'cao', x.c, x.r));
  assert.ok(far);
  const bad = issueOrder(s, {
    faction: 'cao', from: 'xudu', type: 'claim', tile: { c: far.c, r: far.r },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /相连|铺路/);

  const near = s.terrain.tiles.find((x) => !x.owner && x.cost < 90 &&
    hasAdjacentTerritory(s.terrain, 'cao', x.c, x.r));
  assert.ok(near);
  const ok = issueOrder(s, {
    faction: 'cao', from: 'xudu', type: 'claim', tile: { c: near.c, r: near.r },
  });
  assert.equal(ok.ok, true, ok.reason);
  const before = s.cities.xudu.garrison;
  run(s, ok.order.arriveTurn - s.turn + 1);
  assert.equal(s.terrain.at(near.c, near.r).owner, 'cao');
  assert.ok(s.stats.tilesClaimed >= 1);
  assert.ok(s.cities.xudu.garrison >= before,
    `占地不该消耗守军（期间可正常募兵）：${before} → ${s.cities.xudu.garrison}`);
});

test('定向齐射 / 军师计策直接投邮箱，不走大地图 A*', () => {
  const s = mk();
  const r = issueOrder(s, {
    faction: 'cao', from: 'xudu', type: 'fireDirectional',
    selection: ['10,10', '10,11'], direction: { x: 1, y: -0.2 },
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.order.path.length, 0);
  run(s, cfg.orders.minArriveTurn);
  assert.ok(s.mailbox.some((e) => e.kind === 'fireDirectional'));
});

test('敌方城池抵达时开启攻城会话并标围城', () => {
  const s = mk();
  const r = issueOrder(s, {
    faction: 'cao', from: 'xudu', to: 'liyang', type: 'march',
    units: { daodun: 900 },
  });
  assert.equal(r.ok, true, r.reason);
  const evs = run(s, r.order.arriveTurn - s.turn + 1);
  assert.ok(evs.some((e) => e.type === 'battleOpen'));
  assert.equal(s.cities.liyang.besieged, true);
  assert.ok(s.cities.liyang.battleId);
  assert.ok(s.stats.battlesOpened >= 1, '至少应有玩家这一场围城');
});

test('战斗终局回写以 battleEndTurn 为准，并同步栅格归属', () => {
  const s = mk();
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'liyang',
    type: 'march', units: { daodun: 900 } });
  run(s, r.order.arriveTurn - s.turn + 1);
  const bid = s.cities.liyang.battleId;
  run(s, 5);                       // 并行期间日历又走了 5 旬
  const endTurn = s.turn;
  const res = resolveBattle(s, {
    battleId: bid, city: 'liyang', attacker: 'cao', won: true,
    commanderCaptured: true, survivors: 420, endTurn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.endTurn, endTurn, '不能按开战回合回写');
  assert.equal(s.cities.liyang.owner, 'cao');
  assert.equal(s.cities.liyang.commander.state, 'captured');
  assert.equal(s.cities.liyang.besieged, false);
  assert.equal(s.cities.liyang.battleId, null);
  assert.equal(s.cities.liyang.garrison, 420);
  // 栅格颜色与策略归属一致
  const info = s.terrain.cityTiles.liyang;
  assert.equal(s.terrain.at(info.c, info.r).owner, 'cao');
});

test('AI 每两旬决策，会铺路或出征；整局推演确定性', () => {
  const a = mk(), b = mk();
  const ea = run(a, 30, 11), eb = run(b, 30, 11);
  assert.ok(a.stats.aiOrders > 0, `AI 一次都没动 ${a.stats.aiOrders}`);
  assert.equal(a.stats.aiOrders, b.stats.aiOrders);
  assert.equal(a.stats.arrivals, b.stats.arrivals);
  assert.equal(a.turn, b.turn);
  assert.deepEqual(a.resources, b.resources);
  assert.equal(ea.length, eb.length);
});

test('人口、士气、疲劳、粮草随回合演进且不越界', () => {
  const s = mk();
  const h0 = cityHidden(s, 'xudu');
  run(s, 20);
  const h = cityHidden(s, 'xudu');
  assert.ok(s.cities.xudu.pop > CITIES.find((c) => c.id === 'xudu').pop);
  assert.ok(h.grain > 0);
  assert.ok(h.morale >= cfg.hidden.moraleMin && h.morale <= cfg.hidden.moraleMax);
  assert.ok(h.fatigue >= 0 && h.fatigue <= 100);
  assert.ok(troopCap(s, 'xudu') > 0);
  assert.equal(isHostile(s, 'liyang', 'cao'), true);
  assert.equal(isHostile(s, 'xudu', 'cao'), false);
});

test('RNG 快照恢复后序列完全一致', () => {
  const r = createRng(12345);
  const seq1 = [r.next(), r.next(), r.next()];
  const snap = r.snapshot();
  const seq2 = [r.next(), r.next(), r.next(), r.next()];
  const r2 = rngFromSnapshot(snap);
  assert.deepEqual([r2.next(), r2.next(), r2.next(), r2.next()], seq2);
  assert.notDeepEqual(seq1, seq2);
});

test('兵种表无魔法：没有巫师/巨人/矿工，军师是辅助且零伤害', () => {
  for (const banned of ['wizard', 'giant', 'miner']) {
    assert.ok(!cfg.units[banned], `不该存在 ${banned}`);
  }
  assert.equal(cfg.units.junshi.support, true);
  assert.equal(cfg.units.junshi.dmg, 0);
  assert.equal(cfg.units.junshi.projectile, null);
  const ranged = Object.entries(cfg.units).filter(([, u]) => u.projectile);
  assert.ok(ranged.length >= 3, '弓弩/床弩/抛石机都该是远程');
  for (const [k, u] of ranged) assert.equal(u.kind, 'ranged', k);
});
