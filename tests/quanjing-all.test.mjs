// all 三件事的整合验证：新野/叶两座实点、按旬露布、旧档城表迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useMap, MAPS, CITIES, geoToTile } from '../src/map-data.js';
import { createTerrain } from '../src/terrain.js';
import { createCampaign, advanceTurn } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { routeCities } from '../src/pathfind.js';
import { serializeGame, deserializeGame } from '../src/persist.js';
import { dueDispatches, applyDispatches, advanceChapter, openingDispatches } from '../src/story.js';

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
const mk = ({ cfg }) => createCampaign(cfg, { playerFaction: 'cao', seed: cfg.terrain.seed });

test('新野 / 叶进了全境城表，格位与四向外道都不撞既有城', () => {
  const { cfg } = quanjing();
  const cols = cfg.terrain.cols, rows = cfg.terrain.rows;
  const at = (id) => {
    const c = CITIES.find((x) => x.id === id);
    assert.ok(c, `缺城 ${id}`);
    const p = geoToTile(c.lon, c.lat, cols, rows);
    return [Math.round(p.c), Math.round(p.r)];
  };
  const tiles = Object.fromEntries(CITIES.map((c) => [c.id, at(c.id)]));
  for (const id of ['xinye', 'yexian']) {
    const [c, r] = tiles[id];
    for (const [other, p] of Object.entries(tiles)) {
      if (other === id) continue;
      assert.notDeepEqual(p, [c, r], `${id} 与 ${other} 落在同一格，点城会互相盖掉`);
      assert.ok(Math.abs(p[0] - c) + Math.abs(p[1] - r) > 1,
        `${id} 与 ${other} 紧邻一格，四向外道会撞城门`);
    }
  }
  assert.ok(CITIES.length >= 32, `全境城数 ${CITIES.length}，两城没都进表`);
  useMap('guandu');
});

test('扩表后 32 城逐城可达，validateMap 零问题', () => {
  const { cfg } = quanjing();
  const s = mk({ cfg });
  const terrain = s.terrain;
  const unreachable = CITIES.filter((c) => !routeCities(terrain, 'xudu', c.id, cfg).ok);
  assert.deepEqual(unreachable.map((c) => c.name), [], '扩表后有州郡不可达');
  for (const id of ['xinye', 'yexian']) {
    const r = routeCities(terrain, 'xudu', id, cfg);
    assert.ok(r.ok && r.path.length > 2, `${id} 从许都不可达`);
  }
  useMap('guandu');
});

test('按旬露布：入场不发、到旬才发、跳旬一次补齐、重放不重复', () => {
  const s = quanjing();
  const st = mk(s);
  st.chapter = s.story.chapters[0].id;
  st.chapterEnteredTurn = { ch9: st.turn };
  st.dispatchedIds = [];
  const rng = createRng(s.cfg.terrain.seed);
  const op = openingDispatches(s.story);
  st.reports = op.report ? [{ turn: st.turn, red: false, ...op.report }] : [];
  st.storyMails = op.mail ? [op.mail] : [];

  assert.deepEqual(dueDispatches(s.story, st), [], '开篇章入场不该立刻把六条露布全发了');
  for (let i = 0; i < 2; i++) advanceTurn(st, rng);
  const due2 = dueDispatches(s.story, st);
  assert.equal(due2.length, 1);
  assert.equal(due2[0].id, 'q9-t2-cangting');
  assert.equal(due2[0].report.turn, st.turn);
  const applied = applyDispatches(st, due2);
  assert.deepEqual(applied, ['q9-t2-cangting']);
  assert.ok(st.reports[0].title === '仓亭捷报');
  assert.deepEqual(dueDispatches(s.story, st), [], '已发的不能再发');

  // 直接跳到第五旬：中间 2 条一次补齐，顺序按 afterTurn 升序
  st.turn = 5;
  const rest = dueDispatches(s.story, st);
  assert.deepEqual(rest.map((d) => d.id), ['q9-t4-huanxu', 'q9-t5-hebei']);
  assert.equal(rest.find((d) => d.kind === 'mail').mail.id, 'q9-t4-huanxu');
  applyDispatches(st, rest);
  assert.equal(st.dispatchedIds.length, 3);
  assert.equal(st.storyMails.length, 2);   // 开篇章一封 + 露布一封

  // 推进到第十回，ch10 露布按「本章入场旬」起算，不吃 ch9 的偏移
  st.stats.tilesClaimed = s.story.chapters[0].goal.n;
  st.turn = 6;
  const adv = advanceChapter(st, s.story);
  assert.equal(adv.ok, true, adv.reason);
  assert.equal(st.chapterEnteredTurn.ch10, 6);
  assert.deepEqual(dueDispatches(s.story, st), [], '刚入第十回不该立刻发露布');
  st.turn = 8;
  assert.deepEqual(dueDispatches(s.story, st).map((d) => d.id), ['q10-t2-yexia']);
  useMap('guandu');
});

test('存档往返：露布去重表 / 入场旬不丢，旧档缺城时补回新两城', () => {
  const s = quanjing();
  const st = mk(s);
  st.chapter = 'ch9';
  st.dispatchedIds = ['q9-t2-cangting'];
  st.chapterEnteredTurn = { ch9: 0 };
  const rng = createRng(s.cfg.terrain.seed);
  const raw = serializeGame({ cfg: s.cfg, state: st, rng, snapshot: null, ui: {} });
  const back = deserializeGame(s.cfg, raw).state;
  assert.deepEqual(back.dispatchedIds, ['q9-t2-cangting']);
  assert.deepEqual(back.chapterEnteredTurn, { ch9: 0 });
  for (const id of ['xinye', 'yexian']) assert.ok(back.cities[id], `往返后丢了 ${id}`);

  // 模拟 v0.9.4 旧档：cities 里只有 30 城，没有 dispatchedIds / chapterEnteredTurn
  const old = { ...raw, cities: Object.fromEntries(
    Object.entries(raw.cities).filter(([id]) => !['xinye', 'yexian'].includes(id))) };
  delete old.dispatchedIds; delete old.chapterEnteredTurn;
  const migrated = deserializeGame(s.cfg, old).state;
  assert.ok(migrated.cities.xinye && migrated.cities.yexian,
    '旧档合并迁移没把新两城补回来');
  assert.equal(Object.keys(migrated.cities).length, CITIES.length);
  assert.deepEqual(migrated.dispatchedIds, []);
  assert.deepEqual(migrated.chapterEnteredTurn, {});
  // 旧档里已有城的数值必须原样保留，不能被重建值覆盖
  assert.equal(migrated.cities.ye.garrison, old.cities.ye.garrison);
  useMap('guandu');
});

test('露布正文是文言：无工程语、无 URL、无坐标今地', () => {
  const all = story0.chapters.flatMap((c) => c.dispatches ?? []);
  assert.equal(all.length, 6);
  for (const d of all) {
    const txt = (d.report?.body ?? '') + (d.mail?.body ?? '');
    assert.ok(txt.length > 20, `${d.id} 正文过短`);
    for (const w of ['命令日志', '隔旬快进', '实时同解', '快照', 'canvas', 'state',
      'debug', '调试', 'https://', 'http://', '今地', '可信度']) {
      assert.equal(txt.includes(w), false, `「${d.id}」漏出「${w}」`);
    }
  }
});
