import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTerrain, terrainStats, T } from '../src/terrain.js';
import { CITIES, ROADS, PASSES, LAKES, RIDGES, validateMap, geoToTile, cityById } from '../src/map-data.js';
import { findRoute, routeCities, hasAdjacentTerritory, claimTile, validateConnectivity, kmPerTile, tilesPerTurn } from '../src/pathfind.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = () => createTerrain(cfg);

test('地图锚点合法：城池/道路/关隘都在图幅内且路网连通', () => {
  assert.deepEqual(validateMap(), []);
  assert.equal(CITIES.length, 12);
  assert.ok(ROADS.length >= 16);
  assert.ok(PASSES.length >= 7);
  assert.ok(LAKES.length >= 3);
  assert.ok(RIDGES.length >= 3);
  // 真实历史名，不是「城1/城2」
  for (const n of ['许都', '邺', '官渡', '白马', '延津', '黎阳', '陈留', '中牟', '汝南']) {
    assert.ok(CITIES.some((c) => c.name === n), `缺少 ${n}`);
  }
  for (const n of ['虎牢关', '延津渡', '白马津']) {
    assert.ok(PASSES.some((p) => p.name === n), `缺少 ${n}`);
  }
});

test('144×108 栅格生成确定性：同一 seed 两幅图逐字节一致', () => {
  const a = mk(), b = mk();
  assert.equal(a.tiles.length, cfg.terrain.cols * cfg.terrain.rows);
  assert.equal(a.tiles.length, 144 * 108);
  for (let i = 0; i < a.tiles.length; i++) {
    const x = a.tiles[i], y = b.tiles[i];
    assert.equal(x.type, y.type, `格 ${i} 类型分叉`);
    assert.equal(x.level, y.level, `格 ${i} 等级分叉`);
    assert.equal(x.owner, y.owner, `格 ${i} 归属分叉`);
    assert.ok(Math.abs(x.elev - y.elev) < 1e-12);
  }
});

test('地形分层齐全：山河湖泽林田路城郭关隘津渡都存在', () => {
  const s = terrainStats(mk());
  assert.equal(s.total, 15552);
  expect(s.counts, 'plain', 1000);
  expect(s.counts, 'farmland', 100);
  expect(s.counts, 'forest', 100);
  expect(s.counts, 'hill', 100);
  expect(s.counts, 'mountain', 100);
  expect(s.counts, 'river', 100);
  expect(s.counts, 'lake', 10);
  expect(s.counts, 'marsh', 50);
  expect(s.counts, 'road', 100);
  expect(s.counts, 'city', 20);
  expect(s.counts, 'wall', 20);
  expect(s.counts, 'gate', 12);
  expect(s.counts, 'ford', 3);
  expect(s.counts, 'pass', 1);
  assert.ok(s.owned > 300, `初始领地格数 ${s.owned} 太少`);
  assert.ok(s.passable > 10000, `可通行格数 ${s.passable}`);
});

function expect(counts, type, min) {
  assert.ok((counts[type] ?? 0) >= min, `${type} 只有 ${counts[type] ?? 0} 格，期望 ≥${min}`);
}

test('十二座城都有城郭、城门与初始归属', () => {
  const t = mk();
  for (const c of CITIES) {
    const info = t.cityTiles[c.id];
    assert.ok(info, `${c.name} 无城郭`);
    assert.ok(info.rad >= 1);
    assert.ok(info.gate, `${c.name} 无城门`);
    const gt = t.at(info.gate[0], info.gate[1]);
    assert.equal(gt.type, T.GATE, `${c.name} 城门类型 ${gt.type}`);
    assert.equal(gt.owner, c.owner);
    assert.equal(t.at(info.c, info.r).cityId, c.id);
  }
});

test('全图连通：任意两城城门之间 A* 可达', () => {
  const t = mk();
  const problems = validateConnectivity(t, cfg, CITIES.map((c) => c.id));
  assert.deepEqual(problems, []);
  const r = routeCities(t, 'xudu', 'ye', cfg);
  assert.equal(r.ok, true);
  assert.ok(r.path.length > 30, `许都→邺 路径只有 ${r.path.length} 格`);
  assert.ok(r.turns >= 1 && Number.isInteger(r.turns));
});

test('A* 不穿山不涉水：路径每格都可通行，且不斜穿两个障碍角', () => {
  const t = mk();
  const r = routeCities(t, 'yangdi', 'liyang', cfg);
  assert.equal(r.ok, true);
  for (const p of r.path) {
    const tile = t.at(p.c, p.r);
    assert.ok(tile.cost < 90, `(${p.c},${p.r}) 是 ${tile.type}，不该在路径上`);
  }
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1], b = r.path[i];
    const dc = b.c - a.c, dr = b.r - a.r;
    assert.ok(Math.abs(dc) <= 1 && Math.abs(dr) <= 1);
    if (dc && dr) {
      assert.ok(t.at(a.c + dc, a.r).cost < 90 || t.at(a.c, a.r + dr).cost < 90,
        `斜穿障碍角 @ (${a.c},${a.r})`);
    }
  }
});

test('官道确实更快：同一段路走 road 的总代价低于绕行', () => {
  const t = mk();
  const roads = t.tiles.filter((x) => x.type === T.ROAD);
  assert.ok(roads.length > 100);
  for (const x of roads.slice(0, 50)) assert.ok(x.cost < t.cfg.terrain.moveCost.plain);
  assert.ok(kmPerTile(t) > 1 && kmPerTile(t) < 4, `每格 ${kmPerTile(t)} km`);
  assert.ok(tilesPerTurn(cfg, t) > 10, `每回合 ${tilesPerTurn(cfg, t)} 格`);
});

test('连地规则：与己方领地不相邻的地块不能占领', () => {
  const t = mk();
  const faction = 'cao';
  const far = t.tiles.find((x) => !x.owner && x.cost < 90 &&
    x.c > t.cols * 0.7 && !hasAdjacentTerritory(t, faction, x.c, x.r));
  assert.ok(far, '应存在一块远离己方领地的空地');
  assert.equal(hasAdjacentTerritory(t, faction, far.c, far.r), false);
  const near = t.tiles.find((x) => !x.owner && x.cost < 90 &&
    hasAdjacentTerritory(t, faction, x.c, x.r));
  assert.ok(near, '应存在一块与己方领地相邻的空地');
  const r = claimTile(t, near.c, near.r, faction);
  assert.equal(r.ok, true);
  assert.equal(t.at(near.c, near.r).owner, faction);
  // 占完后，它旁边的格子变成可达（铺路推进）
  const next = t.tiles.find((x) => !x.owner && x.cost < 90 &&
    hasAdjacentTerritory(t, faction, x.c, x.r) &&
    Math.abs(x.c - near.c) <= 1 && Math.abs(x.r - near.r) <= 1);
  assert.ok(next, '铺路应能向外延伸');
});

test('山地/大河/城郭不可被普通占领', () => {
  const t = mk();
  for (const type of [T.MOUNTAIN, T.RIVER, T.LAKE, T.CITY, T.WALL]) {
    const x = t.tiles.find((q) => q.type === type);
    if (!x) continue;
    assert.equal(claimTile(t, x.c, x.r, 'cao').ok, false, `${type} 不该可占`);
  }
});

test('格点信息可读：地形、等级、四资源、通行代价、归属齐全', () => {
  const t = mk();
  const d = t.describe(t.cityTiles.xudu.c, t.cityTiles.xudu.r);
  assert.equal(d.cityId, 'xudu');
  assert.equal(d.owner, 'cao');
  assert.ok(d.level >= 1 && d.level <= 9);
  for (const k of ['wood', 'stone', 'iron', 'grain']) assert.ok(Number.isFinite(d.yield[k]));
  // 找一个 9 级地
  const hi = t.tiles.find((x) => x.level === 9 && !x.cityId);
  assert.ok(hi, '应存在 9 级野地');
});
