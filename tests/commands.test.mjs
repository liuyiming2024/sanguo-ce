import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createCampaign, advanceTurn, issueOrder, cancelOrder, collectResources,
  getForces, deployUnit, makeUnits, cityOverview,
} from '../src/campaign.js';
import { createSession, enterSession, leaveSession, restoreSession } from '../src/battle-session.js';
import { hasAdjacentTerritory } from '../src/pathfind.js';
import { createRng } from '../src/rng.js';
import { CITIES } from '../src/map-data.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = (opt = {}) => createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114, ...opt });
const run = (s, turns, seed = 7) => {
  const rng = createRng(seed);
  const all = [];
  for (let i = 0; i < turns; i++) all.push(...advanceTurn(s, rng));
  return all;
};
const ready = () => { const s = mk(); s.cfg.factions.forEach((f) => { f.ai = false; }); collectResources(s); return s; };

test('配置：0.9.0、24px/格、12 类大地图指令、城池小地图尺寸', () => {
  assert.equal(cfg.meta.version, '0.9.0');
  assert.equal(cfg.terrain.tilePx, 24);
  assert.equal(cfg.orders.types.length, 12);
  for (const t of ['claim', 'develop', 'buildFort', 'scout', 'march', 'transfer',
    'garrison', 'withdraw', 'recruit', 'fireDirectional', 'stratagem']) {
    assert.ok(cfg.orders.types.includes(t), `缺少指令 ${t}`);
  }
  assert.equal(cfg.cityView.cols, 24);
  assert.equal(cfg.cityView.rows, 16);
  assert.ok(cfg.cityView.campRatio > 0 && cfg.cityView.campRatio < 0.5);
});

test('屯田：己方地块等级 +1 且产出提高', () => {
  const s = ready();
  const t = s.terrain.tiles.find((x) => x.owner === 'cao' && !x.cityId &&
    x.cost < 90 && x.level < cfg.terrain.maxLandLevel && x.base === 'farmland');
  assert.ok(t, '应存在己方良田');
  const lv0 = t.level, y0 = t.y.grain;
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'develop',
    tile: { c: t.c, r: t.r }, units: { daodun: 100 } });
  assert.equal(r.ok, true, r.reason);
  run(s, r.order.arriveTurn - s.turn + 1);
  assert.equal(t.level, lv0 + 1);
  assert.ok(t.y.grain > y0, `${y0} → ${t.y.grain}`);
  assert.equal(s.stats.develops, 1);
});

test('筑垒：己方地块出现垒寨且通行代价下降', () => {
  const s = ready();
  const t = s.terrain.tiles.find((x) => x.owner === 'cao' && !x.cityId && x.cost < 90 && !x.fort);
  assert.ok(t);
  const c0 = t.cost;
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'buildFort',
    tile: { c: t.c, r: t.r }, units: { daodun: 200 } });
  assert.equal(r.ok, true, r.reason);
  run(s, r.order.arriveTurn - s.turn + 1);
  assert.equal(t.fort, 'cao');
  assert.ok(t.cost <= c0);
  assert.equal(s.stats.forts, 1);
});

test('非己方地块不能屯田 / 筑垒；未连地不能占领', () => {
  const s = ready();
  const far = s.terrain.tiles.find((x) => !x.owner && x.cost < 90 &&
    !hasAdjacentTerritory(s.terrain, 'cao', x.c, x.r));
  assert.ok(far);
  assert.equal(issueOrder(s, { faction: 'cao', from: 'xudu', type: 'develop',
    tile: { c: far.c, r: far.r }, units: { daodun: 100 } }).ok, false);
  assert.equal(issueOrder(s, { faction: 'cao', from: 'xudu', type: 'buildFort',
    tile: { c: far.c, r: far.r }, units: { daodun: 100 } }).ok, false);
  const bad = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'claim',
    tile: { c: far.c, r: far.r } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /相连|铺路/);
});

test('侦察：写入情报但不改守军、不开战', () => {
  const s = ready();
  const before = s.cities.liyang.garrison;
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'scout', to: 'liyang' });
  assert.equal(r.ok, true, r.reason);
  const evs = run(s, r.order.arriveTurn - s.turn + 1);
  assert.ok(evs.some((e) => e.type === 'scout'));
  assert.ok(s.cities.liyang.garrison >= before, '侦察不该削守军（期间可正常募兵）');
  assert.equal(s.cities.liyang.besieged, false);
  assert.ok(s.intel.liyang);
  assert.equal(s.intel.liyang.owner, 'yuan');
  assert.ok(s.intel.liyang.garrison > 0);
  assert.equal(s.stats.scouts, 1);
});

test('调动 / 驻守只对己方城；出征只对敌方城', () => {
  const s = ready();
  assert.equal(issueOrder(s, { faction: 'cao', from: 'xudu', to: 'liyang',
    type: 'transfer', units: { daodun: 100 } }).ok, false);
  assert.equal(issueOrder(s, { faction: 'cao', from: 'xudu', to: 'chenliu',
    type: 'march', units: { daodun: 100 } }).ok, false);
  const t = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'chenliu',
    type: 'transfer', units: { daodun: 300 } });
  assert.equal(t.ok, true, t.reason);
  const g = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'zhongmu',
    type: 'garrison', units: { daodun: 300 } });
  assert.equal(g.ok, true, g.reason);
});

test('撤令：退还兵员与已扣资源', () => {
  const s = ready();
  const grain0 = s.resources.cao.grain;
  const g0 = s.cities.xudu.garrison;
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'liyang',
    type: 'march', units: { daodun: 400 } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.cities.xudu.garrison, g0 - 400);
  const c = cancelOrder(s, r.order.id);
  assert.equal(c.ok, true);
  assert.equal(c.refunded, 400);
  assert.equal(s.cities.xudu.garrison, g0);
  assert.ok(Math.abs(s.resources.cao.grain - grain0) < 1e-9);
  assert.equal(s.orders.length, 0);
  assert.equal(s.stats.cancelled, 1);
  assert.equal(cancelOrder(s, r.order.id).ok, false);
});

test('资源不足时明确拒绝，不产生在途命令', () => {
  const s = ready();
  s.resources.cao.stone = 0; s.resources.cao.grain = 0;
  const near = s.terrain.tiles.find((x) => !x.owner && x.cost < 90 &&
    hasAdjacentTerritory(s.terrain, 'cao', x.c, x.r));
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'claim',
    tile: { c: near.c, r: near.r } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不足/);
  assert.equal(s.orders.length, 0);
});

test('大地图出征抵达：己方城进「城内」，敌方城进「城外大营」', () => {
  const s = ready();
  const own = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'chenliu',
    type: 'transfer', units: { daodun: 600, gongnu: 300 } });
  const enemy = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'liyang',
    type: 'march', units: { daodun: 600, gongnu: 300 } });
  assert.equal(own.ok, true, own.reason);
  assert.equal(enemy.ok, true, enemy.reason);
  run(s, Math.max(own.order.arriveTurn, enemy.order.arriveTurn) - s.turn + 1);
  const fOwn = getForces(s, 'chenliu'), fEnemy = getForces(s, 'liyang');
  assert.ok(fOwn.inside.length > 0, '己方城应有城内单位');
  assert.equal(fOwn.camp.length, 0);
  assert.ok(fEnemy.camp.length > 0, '敌方城应在城外扎营');
  assert.ok(fEnemy.camp.every((u) => u.faction === 'cao'), '大营里应是玩家的部队');
  assert.equal(s.cities.liyang.besieged, true);
});

test('单位实体独立：id 唯一、有兵种/阵营/血量/格位/人数', () => {
  const s = ready();
  const units = makeUnits(s, { daodun: 600, gongnu: 300 }, 'cao', 'camp', 'liyang');
  assert.ok(units.length >= 3);
  assert.equal(new Set(units.map((u) => u.id)).size, units.length);
  for (const u of units) {
    assert.equal(u.zone, 'camp');
    assert.equal(u.faction, 'cao');
    assert.equal(u.cityId, 'liyang');
    assert.ok(u.hp > 0 && u.hp === u.maxHp);
    assert.ok(Number.isInteger(u.col) && Number.isInteger(u.row));
    assert.ok(u.troops > 0);
    assert.ok(cfg.units[u.type]);
  }
  // 一个实体代表一小队，不会几千个单位把小地图塞爆
  assert.ok(units.length <= 24);
});

test('小地图拖拽部署：大营 → 城内 → 大营，坐标被钳制在网格内', () => {
  const s = ready();
  const f = getForces(s, 'liyang');
  const made = makeUnits(s, { gongnu: 500 }, 'cao', 'camp', 'liyang');
  f.camp.push(...made);
  const inside0 = f.inside.length, camp0 = f.camp.length;
  const id = f.camp[0].id;
  let r = deployUnit(s, 'liyang', id, 'inside', 12, 7);
  assert.equal(r.ok, true);
  assert.equal(r.inside, inside0 + 1);
  assert.equal(r.camp, camp0 - 1);
  const moved = f.inside.find((u) => u.id === id);
  assert.equal(moved.zone, 'inside');
  assert.equal(moved.col, 12);
  r = deployUnit(s, 'liyang', id, 'inside', 999, -3);
  assert.equal(r.ok, true);
  assert.equal(moved.col, cfg.cityView.cols - 1);
  assert.equal(moved.row, 0);
  r = deployUnit(s, 'liyang', id, 'camp', 3, 3);
  assert.equal(r.ok, true);
  assert.equal(r.camp, camp0);
  assert.equal(r.inside, inside0);
  assert.equal(deployUnit(s, 'liyang', 'nope', 'inside', 1, 1).ok, false);
});

test('城池详情：守军/城防/城内城外兵力/情报齐全', () => {
  const s = ready();
  getForces(s, 'liyang').camp.push(...makeUnits(s, { daodun: 400 }, 'cao', 'camp', 'liyang'));
  const o = cityOverview(s, 'liyang');
  assert.equal(o.id, 'liyang');
  assert.equal(o.owner, 'yuan');
  assert.ok(o.garrison > 0 && o.wall > 0);
  assert.ok(o.camp > 0);
  assert.ok(o.inside > 0);
  assert.equal(o.intel, null);
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'scout', to: 'liyang' });
  run(s, r.order.arriveTurn - s.turn + 1);
  assert.ok(cityOverview(s, 'liyang').intel);
});

test('快照保留部署状态：退出 → 重新进入 → 城内/大营数量一致', () => {
  const s = ready();
  const f = getForces(s, 'liyang');
  f.camp.push(...makeUnits(s, { daodun: 600 }, 'cao', 'camp', 'liyang'));
  const rng = createRng(3);
  const sess = createSession(cfg, s, 'liyang', { rngSnapshot: rng.snapshot() });
  enterSession(sess, rng);
  deployUnit(s, 'liyang', f.camp[0].id, 'inside', 9, 6);
  const snap = leaveSession(sess, rng);
  assert.ok(snap.forces.inside.length >= 1);
  assert.equal(snap.forces.camp.length, f.camp.length);
  run(s, 4);
  // 模拟刷新：清空策略层部队池，用快照恢复
  s.forces.liyang = { inside: [], camp: [] };
  const s2 = restoreSession(cfg, s, snap);
  enterSession(s2, rng);
  assert.ok(s.forces.liyang.inside.length >= 1);
  assert.ok(s2.forcesRef.inside.some((u) => u.col === 9));
});

test('开局每座城都有守军实体，敌方城的守军在城内、玩家攻城部队在大营', () => {
  const s = ready();
  for (const c of CITIES) {
    const f = getForces(s, c.id);
    assert.ok(f.inside.length > 0, `${c.name} 没有守军实体`);
    assert.equal(f.camp.length, 0);
    assert.ok(f.inside.every((u) => u.faction === c.owner));
    assert.ok(f.inside.every((u) => u.zone === 'inside'));
  }
});

test('定向齐射指令携带 selection 与方向向量，不走 A*', () => {
  const s = ready();
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'liyang',
    type: 'fireDirectional', selection: ['u1', 'u2', 'u3'],
    direction: { x: 24, y: -8 } });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.order.selection, ['u1', 'u2', 'u3']);
  assert.deepEqual(r.order.direction, { x: 24, y: -8 });
  assert.equal(r.order.path.length, 0);
  run(s, cfg.orders.minArriveTurn);
  const e = s.mailbox.find((m) => m.kind === 'fireDirectional');
  assert.ok(e);
  assert.equal(e.selection.length, 3);
});
