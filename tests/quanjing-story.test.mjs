// v0.9.4：全境两章补实际内容（章回文案 / 州郡事件 / 纪事），全部走既有 onEnter 机制。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useMap, MAPS, CITIES } from '../src/map-data.js';
import { createCampaign } from '../src/campaign.js';
import { openingDispatches, canAdvance, advanceChapter } from '../src/story.js';

const cfg0 = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const story0 = JSON.parse(readFileSync(new URL('../config/story.json', import.meta.url), 'utf8'));
const hist = JSON.parse(readFileSync(new URL('../config/historica.json', import.meta.url), 'utf8'));

const MECH = ['命令日志', '隔旬快进', '实时同解', '累计逻辑步', '快照', 'state',
  '点地、下令', 'canvas', '栅格', '调试面板'];

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

function mk(s) {
  return createCampaign(s.cfg, { playerFaction: 'cao', seed: s.cfg.terrain.seed });
}

test('两章叙事是章回体：有州郡有人物，不混工程术语', () => {
  const ch9 = story0.chapters.find((c) => c.id === 'ch9');
  const ch10 = story0.chapters.find((c) => c.id === 'ch10');
  for (const name of ['雒阳', '长安', '邺', '蓟', '临淄', '襄阳', '江陵', '成都', '番禺']) {
    assert.ok(ch9.beat.includes(name), `第九回漏了州郡「${name}」`);
  }
  for (const name of ['谯', '邺', '新野', '襄阳', '南郑']) {
    assert.ok(ch10.beat.includes(name), `第十回漏了州郡「${name}」`);
  }
  assert.ok(ch9.beat.includes('荀彧') && ch9.beat.includes('程昱'));
  assert.ok(ch10.historical.includes('夏五月薨'), '第十回史注须写明薨在五月，不提前到正月');
  for (const c of [ch9, ch10]) {
    for (const w of MECH) assert.equal(c.beat.includes(w), false, `「${c.id}」叙事漏出机制词「${w}」`);
    assert.ok(c.beat.length > 120 && c.historical && c.source, `${c.id} 文案过薄`);
    assert.ok(c.source.includes('三国志'), `${c.id} 出处未落实到正史`);
  }
});

test('州郡事件全部走既有 onEnter：开篇章只纪事，推进章才落 state', () => {
  useMap('quanjing');   // CITIES 是活绑定，默认仍是官渡十二城
  const ch9 = story0.chapters.find((c) => c.id === 'ch9');
  const ch10 = story0.chapters.find((c) => c.id === 'ch10');
  assert.deepEqual(Object.keys(ch9.onEnter).sort(), ['flags', 'mail', 'report']);
  assert.ok(ch9.onEnter.report.body.includes('其一') && ch9.onEnter.report.body.includes('其三'));
  assert.ok(ch9.onEnter.mail.body.length > 20);
  for (const k of ['city', 'intel', 'flags', 'report', 'mail']) {
    assert.ok(ch10.onEnter[k], `第十回缺 ${k}`);
  }
  const ids = new Set(CITIES.map((c) => c.id));
  for (const e of ch10.onEnter.city) {
    assert.ok(ids.has(e.id), `事件城「${e.id}」不在全境三十城表里`);
    assert.equal(e.owner, undefined, '州郡事件只改驻军/城防/士气，不改归属（三色是玩法约束）');
    assert.ok(['garrison', 'wall', 'morale'].some((k) => Number.isFinite(e[k])), `「${e.id}」事件无实效`);
  }
  for (const id of ch10.onEnter.intel) assert.ok(ids.has(id));
  for (const c of [ch9, ch10]) {
    const txt = c.onEnter.report.body + c.onEnter.mail.body;
    for (const w of MECH) assert.equal(txt.includes(w), false, `纪事漏出机制词「${w}」`);
    assert.equal(/https?:\/\//.test(txt), false);
  }
  useMap('guandu');
});

test('openingDispatches 补上开篇章 onEnter 从未生效的缺口，两图都成立', () => {
  const guandu = openingDispatches(story0);
  assert.equal(guandu.chapterId, 'ch1');
  assert.equal(guandu.report.title, '檄至许都');
  assert.equal(guandu.report.turn, 0);
  assert.equal(guandu.mail, null, '官渡第一回没配私信，不该凭空造');
  const { story } = quanjing();
  const q = openingDispatches(story);
  assert.equal(q.chapterId, 'ch9');
  assert.equal(q.flags.quanjingOpen, true);
  assert.equal(q.report.title, '别展全境 · 州郡棋布');
  assert.equal(q.mail.id, 'story-ch9');
  assert.equal(q.mail.turn, 0);
  useMap('guandu');
});

test('推进第十回：州郡事件真落 state，归属不变，斥候情报写回', () => {
  const s = quanjing();
  const st = mk(s);
  st.chapter = s.story.chapters[0].id;
  const before = Object.fromEntries(Object.entries(st.cities).map(([id, c]) =>
    [id, { garrison: c.garrison, wall: c.wall, morale: c.morale, owner: c.owner }]));
  st.stats.tilesClaimed = s.story.chapters[0].goal.n;
  st.turn = s.story.chapters[1].minTurn;
  assert.equal(canAdvance(s.story, st).ok, true);
  const r = advanceChapter(st, s.story);
  assert.equal(r.ok, true, r.reason);
  assert.equal(st.chapter, 'ch10');
  assert.equal(r.report.title, '全境既定 · 行台合卷');
  assert.equal(r.mail.id, 'story-ch10');
  assert.equal(st.storyFlags.campaignComplete, true);
  assert.equal(st.cities.qiaoxian.garrison, before.qiaoxian.garrison + 400);
  assert.equal(st.cities.qiaoxian.wall, before.qiaoxian.wall + 20);
  assert.equal(st.cities.ye.morale, before.ye.morale - 12);
  assert.equal(st.cities.wan.garrison, before.wan.garrison + 300);
  for (const [id, b] of Object.entries(before)) {
    assert.equal(st.cities[id].owner, b.owner, `「${id}」归属被章回改动，越过了玩法三色约束`);
  }
  for (const id of s.story.chapters[1].onEnter.intel) {
    assert.ok(st.intel[id], `「${id}」斥候情报没写回`);
  }
  useMap('guandu');
});

test('游戏内典籍只收文言一条「全境两章」，不落坐标/今地/白话辨正', () => {
  const benji = hist.cats.find((c) => c.id === 'benji');
  const it = benji.items.find((x) => x.t === '全境两章');
  assert.ok(it);
  assert.match(it.lv, /^[ABC]$/);
  assert.ok(it.n.includes('武帝纪'));
  for (const w of [...MECH, '亭是带围墙', '1957', '新野北安乐寨', '后台营造', 'http']) {
    assert.equal(it.s.includes(w), false, `文言卷漏出「${w}」`);
  }
});
