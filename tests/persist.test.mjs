import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, issueOrder, getForces, deployUnit, collectResources } from '../src/campaign.js';
import { createRng, rngFromSnapshot } from '../src/rng.js';
import {
  serializeGame, deserializeGame, saveToStorage, readFromStorage, clearStorage,
} from '../src/persist.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const uiData = JSON.parse(readFileSync(new URL('../config/ui-data.json', import.meta.url), 'utf8'));

function mk() {
  const c = JSON.parse(JSON.stringify(cfg));
  c.factions.forEach((f) => { f.ai = false; });
  const s = createCampaign(c, { seed: 20261114 });
  s.facilities = Object.fromEntries(uiData.facilities.map((f) => [f.id, f.lv]));
  s.armies = [
    { slots: ['caocao', 'xiahou', 'xuchu'], stamina: 100 },
    { slots: [null, null, null], stamina: 100 },
    { slots: [null, null, null], stamina: 100 },
  ];
  s.copper = 1200;
  s.settings = { idleStop: true, snap: true };
  s.claimedTasks = [];
  s.reports = [{ turn: 0, title: '开局', tag: '系统', body: '建安五年' }];
  collectResources(s, { apply: false });
  return { c, s, rng: createRng(20261114) };
}

test('存档是纯 JSON，不含循环引用 / 函数 / DOM', () => {
  const { c, s, rng } = mk();
  const raw = serializeGame({ cfg: c, state: s, rng, snapshot: null, ui: { auto: true } });
  const text = JSON.stringify(raw);
  assert.ok(text.length > 100);
  assert.equal(JSON.parse(text).v, 1);
  assert.equal(raw.version, '0.5.0');
});

test('地形按 seed 重建，只存与初始地图不同的格子', () => {
  const { c, s, rng } = mk();
  // 改几格领地 / 等级 / 垒寨
  const t = s.terrain.tiles.find((x) => !x.owner && x.cost < 90);
  t.owner = 'cao'; t.level += 1; t.fort = 'cao'; t.y.grain += 12.5;
  const raw = serializeGame({ cfg: c, state: s, rng, snapshot: null, ui: {} });
  assert.ok(raw.tiles.length >= 1, '差异格应被记录');
  assert.ok(raw.tiles.length < 200, '不该把 15552 格全量塞进 localStorage');
  assert.ok(raw.tiles[0][0] >= 0 && raw.tiles[0][0] < c.terrain.cols * c.terrain.rows);
  assert.ok(!('terrain' in raw), 'cfg / terrain 实例不该进存档');
});

test('整局往返：回合 / 资源 / 设施 / 部队 / 命令 / 情报 / 部署 / 报告 / 设置逐字段一致', () => {
  const { c, s, rng } = mk();
  collectResources(s);   // 让库存有值，命令才能扣资源
  // 推进几旬并下命令，制造非初始状态
  const dev = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'develop',
    tile: { c: s.terrain.tiles.find((x) => x.owner === 'cao' && !x.cityId && x.cost < 90).c,
      r: s.terrain.tiles.find((x) => x.owner === 'cao' && !x.cityId && x.cost < 90).r },
    units: { daodun: 100 } });
  assert.equal(dev.ok, true, dev.reason);
  const march = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'liyang',
    type: 'march', units: { daodun: 600 } });
  assert.equal(march.ok, true, march.reason);
  for (let i = 0; i < 6; i++) advanceTurn(s, rng);
  s.facilities.chengzhufu = 7;
  s.armies[1].slots[0] = 'guojia';
  s.armies[0].stamina = 60;
  s.claimedTasks.push('t1');
  s.copper = 4321;
  s.settings.idleStop = false;
  s.intel.liyang = { turn: 4, garrison: 1800, wall: 92, morale: 70, owner: 'yuan' };
  const f = getForces(s, 'liyang');
  if (f.camp.length) deployUnit(s, 'liyang', f.camp[0].id, 'inside', 9, 6);

  const rngSnap = rng.snapshot();
  const raw = serializeGame({ cfg: c, state: s, rng,
    snapshot: { cityId: 'liyang', sec: 24.5, forces: { inside: [], camp: [] } },
    ui: { auto: false, camera: { x: 123, y: 456, scale: 1.4 }, battleCityId: 'liyang' } });
  const back = deserializeGame(c, JSON.parse(JSON.stringify(raw)));
  assert.ok(back);
  const b = back.state;
  assert.equal(b.turn, s.turn);
  assert.equal(b.playerFaction, s.playerFaction);
  assert.deepEqual(b.resources.cao, s.resources.cao);
  assert.deepEqual(b.facilities, s.facilities);
  assert.deepEqual(b.armies, s.armies);
  assert.deepEqual(b.claimedTasks, s.claimedTasks);
  assert.deepEqual(b.settings, s.settings);
  assert.deepEqual(b.reports, s.reports);
  assert.deepEqual(b.intel, s.intel);
  assert.equal(b.copper, s.copper);
  assert.equal(b.orders.length, s.orders.length);
  assert.equal(b.forces.liyang.inside.length, s.forces.liyang.inside.length);
  assert.equal(b.forces.liyang.camp.length, s.forces.liyang.camp.length);
  assert.equal(b.nextOrderId, s.nextOrderId);
  assert.equal(b.nextUnitId, s.nextUnitId);
  assert.equal(back.snapshot.cityId, 'liyang');
  assert.equal(back.snapshot.sec, 24.5);
  assert.deepEqual(back.ui.camera, { x: 123, y: 456, scale: 1.4 });
  assert.equal(back.ui.auto, false);
  assert.equal(back.ui.battleCityId, 'liyang');
  assert.deepEqual(back.rngSnapshot, rngSnap);
});

test('RNG 快照恢复后序列不分叉（快进与实时必须同序列）', () => {
  const { c, s, rng } = mk();
  for (let i = 0; i < 23; i++) rng.next();
  const snap = rng.snapshot();
  const expected = [rng.next(), rng.next(), rng.next(), rng.next(), rng.next()];
  const r2 = rngFromSnapshot(snap);
  assert.deepEqual([r2.next(), r2.next(), r2.next(), r2.next(), r2.next()], expected);
  assert.equal(r2.snapshot().calls, snap.calls + 5);
});

test('地形差异格在恢复后逐字段一致，其余格与 seed 重建结果一致', () => {
  const { c, s, rng } = mk();
  const t = s.terrain.tiles.find((x) => !x.owner && x.cost < 90);
  t.owner = 'yuan'; t.level = 7; t.fort = 'yuan'; t.cost = 0.8;
  t.y = { wood: 1.1, stone: 2.2, iron: 3.3, grain: 4.4 };
  const idx = s.terrain.tiles.indexOf(t);
  const raw = serializeGame({ cfg: c, state: s, rng, snapshot: null, ui: {} });
  const b = deserializeGame(c, JSON.parse(JSON.stringify(raw))).state;
  const u = b.terrain.tiles[idx];
  assert.equal(u.owner, 'yuan');
  assert.equal(u.level, 7);
  assert.equal(u.fort, 'yuan');
  assert.equal(u.cost, 0.8);
  assert.deepEqual(u.y, { wood: 1.1, stone: 2.2, iron: 3.3, grain: 4.4 });
  // 未改动的格子与按 seed 重新生成的完全一致
  const fresh = createCampaign(c, { seed: 20261114 });
  for (let i = 0; i < fresh.terrain.tiles.length; i++) {
    if (i === idx) continue;
    assert.equal(b.terrain.tiles[i].type, fresh.terrain.tiles[i].type, `格 ${i} 地貌不一致`);
    assert.equal(b.terrain.tiles[i].owner, fresh.terrain.tiles[i].owner, `格 ${i} 归属不一致`);
  }
});

test('存档版本不兼容时安全返回 null，不抛异常', () => {
  assert.equal(deserializeGame(cfg, null), null);
  assert.equal(deserializeGame(cfg, { v: 99 }), null);
  // 缺字段的 v1 存档按初始局面安全重建，不抛异常也不返回 null
  const b = deserializeGame(cfg, { v: 1, seed: 42, playerFaction: 'yuan' });
  assert.equal(b.state.playerFaction, 'yuan');
  assert.equal(b.state.turn, 0);
});

test('浏览器存储不可用时静默降级，不影响开局', () => {
  // Node 环境没有 localStorage；三个函数都不得抛异常
  assert.equal(typeof saveToStorage({ v: 1 }), 'boolean');
  assert.equal(readFromStorage(), null);
  assert.doesNotThrow(() => clearStorage());
});
