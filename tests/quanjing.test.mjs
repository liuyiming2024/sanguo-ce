import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useMap, MAPS, CITIES, validateMap } from '../src/map-data.js';
import { createCampaign, advanceTurn } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { serializeGame, deserializeGame } from '../src/persist.js';
import { routeCities } from '../src/pathfind.js';
import { canAdvance, advanceChapter } from '../src/story.js';

const cfg0 = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const story0 = JSON.parse(readFileSync(new URL('../config/story.json', import.meta.url), 'utf8'));

function quanjing() {
  useMap('quanjing');
  const cfg = { ...cfg0,
    terrain: { ...cfg0.terrain, seed: MAPS.quanjing.seed, riverWidthTiles: 1, cityRadiusTiles: 1, cityWalls: false },
    meta: { ...cfg0.meta, subtitle: MAPS.quanjing.subtitle } };
  const two = story0.chapters.filter((c) => c.mapId === 'quanjing');
  const story = { ...story0, meta: { ...story0.meta, prologue: MAPS.quanjing.prologue },
    chapters: two.map((c, i) => ({ ...c, minTurn: i * 6 })) };
  return { cfg, story };
}

test('全境：州郡表自洽、十二旧城 id 仍在、图幅真的铺开', () => {
  quanjing();
  assert.deepEqual(validateMap(), []);
  assert.ok(CITIES.length >= 28);
  assert.ok(MAPS.quanjing.bounds.LON_MAX - MAPS.quanjing.bounds.LON_MIN > 20);
  for (const id of ['xudu', 'ye', 'guandu', 'baima', 'liyang']) {
    assert.ok(CITIES.some((c) => c.id === id), `${id} 在全境图里丢了`);
  }
  useMap('guandu');
});

test('全境：同一套策略层能建局面、推旬、行军，不另起一套', () => {
  const { cfg } = quanjing();
  const rng = createRng(cfg.terrain.seed);
  const s = createCampaign(cfg, { playerFaction: 'cao', seed: cfg.terrain.seed });
  s.mapId = 'quanjing';
  assert.equal(Object.keys(s.cities).length, CITIES.length);
  assert.equal(s.terrain.tiles.length, cfg.terrain.cols * cfg.terrain.rows);
  advanceTurn(s, rng);
  assert.equal(s.turn, 1);
  const r = routeCities(s.terrain, 'xudu', 'chengdu', cfg);
  assert.ok(r && r.path && r.path.length > 2, '全境跨州行军应能沿道路图找到路径');
  const unreachable = CITIES.filter((c) => !routeCities(s.terrain, 'xudu', c.id, cfg).ok);
  assert.deepEqual(unreachable.map((c) => c.name), [], '全境州郡必须全部可达');
  const raw = serializeGame({ cfg, state: s, rng, snapshot: null, ui: {} });
  assert.equal(raw.mapId, 'quanjing');
  const back = deserializeGame(cfg, raw);
  assert.equal(back.state.mapId, 'quanjing');
  assert.equal(back.state.turn, 1);
  useMap('guandu');
});

test('全境两章：仍是同一套章回逻辑，目标/月份/抉择都生效', () => {
  const { cfg, story } = quanjing();
  assert.equal(story.chapters.length, 2);
  assert.equal(story.chapters[0].id, 'ch9');
  assert.equal(story.chapters[1].id, 'ch10');
  const s = createCampaign(cfg, { playerFaction: 'cao', seed: cfg.terrain.seed });
  s.chapter = story.chapters[0].id;
  const g0 = canAdvance(story, s);
  assert.equal(g0.ok, false);
  s.stats.tilesClaimed = story.chapters[0].goal.n;
  s.turn = story.chapters[1].minTurn;
  const g1 = canAdvance(story, s);
  assert.equal(g1.ok, true);
  assert.equal(g1.next.id, 'ch10');
  const r = advanceChapter(s, story);
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.chapter, 'ch10');
  useMap('guandu');
});
