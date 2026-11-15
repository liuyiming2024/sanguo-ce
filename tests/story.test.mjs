import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, issueOrder, advanceTurn } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import {
  currentChapter, chapterIndex, goalProgress, canAdvance, chapterHeadline,
  applyOpening, chooseOption, advanceChapter, claimChapterReward, landCount, cityCount,
} from '../src/story.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const story = JSON.parse(readFileSync(new URL('../config/story.json', import.meta.url), 'utf8'));

function mk(ai = false) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.factions.forEach((f) => { f.ai = ai; });
  const s = createCampaign(c, { seed: 20261114, playerFaction: 'cao' });
  s.facilities = { chengzhufu: 5, minju: 6 };
  s.armies = [{ slots: ['caocao', 'xiahou', 'xuchu'], stamina: 100 }];
  s.copper = 1000;
  s.claimedTasks = [];
  s.settings = { idleStop: true, snap: true };
  return { c, s, rng: createRng(20261114) };
}
const run = (s, rng, n) => { for (let i = 0; i < n; i++) advanceTurn(s, rng); };
const giveLand = (s, n) => {
  let k = 0;
  for (const t of s.terrain.tiles) {
    if (k >= n) break;
    if (!t.owner && t.cost < 90) { t.owner = 'cao'; k++; }
  }
};

test('序章给定身份，不再三选一；开局侧重两种都生效', () => {
  const a = mk().s, b = mk().s;
  const oa = applyOpening(a, story, 'farm');
  const ob = applyOpening(b, story, 'scout');
  assert.equal(oa.id, 'farm');
  assert.equal(ob.id, 'scout');
  assert.equal(a.storyFlags.opening, 'farm');
  assert.equal(b.storyFlags.opening, 'scout');
  assert.equal(a.resources.cao.grain, 2500);
  assert.equal(a.facilities.chengzhufu, 6);
  assert.equal(b.copper, 1800);
  assert.equal(b.intel.baima.turn, 0);
  assert.equal(b.intel.liyang.owner, 'yuan');
  assert.equal(currentChapter(story, a).id, 'ch1');
  assert.equal(chapterHeadline(story, a), '第一回 · 许都受檄');
  assert.equal(story.meta.faction, 'cao');
});

test('章回目标全部从 state 派生，不是写死进度', () => {
  const { s } = mk();
  const ch1 = story.chapters[0];
  assert.equal(s.storyBaseline.land, landCount(s));
  assert.equal(s.storyBaseline.cities, cityCount(s));
  assert.equal(goalProgress(s, ch1).cur, 0);
  assert.equal(goalProgress(s, ch1).done, false, '开局 468 格不该白送章回进度');
  s.stats.tilesClaimed = 3;
  assert.equal(goalProgress(s, ch1).done, true);
  const ch8 = story.chapters.find((c) => c.goal.type === 'citiesGain');
  assert.equal(goalProgress(s, ch8).cur, 0, '开局 9 城不该白送终回进度');
  // 侦察 / 出征 / 垒寨 / 城池
  const c2 = story.chapters.find((c) => c.goal.type === 'scout');
  assert.equal(goalProgress(s, c2).cur, s.stats.scouts);
  assert.equal(goalProgress(s, story.chapters.find((c) => c.goal.type === 'forts')).cur, s.forts.length);
  const before8 = goalProgress(s, ch8).cur;
  Object.values(s.cities).filter((c) => c.owner !== 'cao').slice(0, 2).forEach((c) => { c.owner = 'cao'; });
  assert.equal(goalProgress(s, ch8).cur, before8 + 2, 'citiesGain 应是相对开局基线的净增');
});

test('不到史实月份不能跳回：目标已竟也须待时至二月初一', () => {
  const { s, rng } = mk();
  s.stats.tilesClaimed = 3;
  assert.equal(goalProgress(s, story.chapters[0]).done, true);
  let g = canAdvance(story, s);
  assert.equal(g.ok, false);
  assert.match(g.reason, /待时至 建安五年 二月初一/);
  run(s, rng, 3);
  g = canAdvance(story, s);
  assert.equal(g.ok, true);
  assert.equal(g.next.id, 'ch2');
  assert.equal(g.next.title, '黎阳压河');
});

test('推进章回：犒赏一次发清、抉择取史实路线、入场触发白马被围', () => {
  const { s, rng } = mk();
  applyOpening(s, story, 'farm');
  s.stats.tilesClaimed = 3;
  run(s, rng, 3);
  const before = { ...s.resources.cao };
  const r = advanceChapter(s, story);
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.chapter, 'ch2');
  assert.equal(s.storyChoices.opening, 'farm');
  assert.equal(s.cities.baima.besieged, true);
  assert.equal(s.intel.baima.turn, 3);
  assert.ok(s.cities.liyang.garrison > 2200);
  assert.equal(r.report.title, '颜良围白马');
  assert.equal(r.mail.title, '白马告急');
  assert.equal(s.claimedTasks.includes('ch1'), true);
  assert.equal(s.resources.cao.wood, Math.round(before.wood + 2000));
  // 再领一次不会双发
  const again = claimChapterReward(s, story, 'ch1');
  assert.equal(again.ok, false);
  assert.equal(s.resources.cao.wood, Math.round(before.wood + 2000));
});

test('最后一回合卷后返回 final，不抛异常', () => {
  const { s } = mk();
  s.chapter = story.chapters[story.chapters.length - 1].id;
  const g = canAdvance(story, s);
  assert.equal(g.ok, false);
  assert.equal(g.final, true);
  assert.match(g.reason, /章回已合卷/);
});

test('章回抉择可改，但不重复发放 effect（不刷资源）', () => {
  const { s } = mk();
  const g0 = s.resources.cao.grain;
  const a = chooseOption(s, story, 'farm');
  assert.equal(a.ok, true);
  assert.equal(s.resources.cao.grain, g0 + 2500);
  const b = chooseOption(s, story, 'scout');
  assert.equal(b.ok, true);
  assert.equal(s.resources.cao.grain, g0 + 2500, '改选不该再发一次屯田粮');
  assert.equal(s.storyChoices.opening, 'scout');
});

test('史实节拍按章回推进：白马围 → 解围 → 官渡相持 → 乌巢焚粮', () => {
  const { s, rng } = mk();
  // 直接把每回目标造满，再按 minTurn 推时间，逐回推进
  const seq = [];
  for (let i = 0; i < story.chapters.length - 1; i++) {
    const cur = currentChapter(story, s);
    const g = goalProgress(s, cur);
    if (!g.done) {
      if (g.type === 'claim') s.stats.tilesClaimed = g.n;
      else if (g.type === 'citiesGain') {
        const enemies = Object.values(s.cities).filter((c) => c.owner !== 'cao');
        enemies.slice(0, g.n).forEach((c) => { c.owner = 'cao'; });
      }
      else if (g.type === 'land') giveLand(s, g.n + 2);
      else if (g.type === 'scout') s.stats.scouts += g.n;
      else if (g.type === 'march') s.stats.byType.march = (s.stats.byType.march ?? 0) + g.n;
      else if (g.type === 'forts') s.forts.push(...Array.from({ length: g.n }, (_, k) => ({ c: k, r: k, faction: 'cao', turn: s.turn })));
      else if (g.type === 'withdrawOrGarrison') s.stats.byType.withdraw = g.n;
      else if (g.type === 'cities') { /* 城池数不造，最后一回不必推进 */ }
    }
    const next = story.chapters[i + 1];
    while (s.turn < next.minTurn) advanceTurn(s, rng);
    const r = advanceChapter(s, story);
    assert.equal(r.ok, true, `第 ${i + 1} 回无法推进: ${r.reason}`);
    seq.push(r.chapter.id);
  }
  assert.deepEqual(seq.slice(0, 3), ['ch2', 'ch3', 'ch4']);
  assert.equal(s.storyFlags.baimaBesieged, true);
  assert.equal(s.storyFlags.baimaRelieved, true);
  assert.equal(s.storyFlags.yanliangDead, true);
  assert.equal(s.storyFlags.wenchouDead, true);
  assert.equal(s.cities.baima.besieged, false);
  assert.ok(s.storyMails.length === 0); // 邮件由装配层写入，逻辑层只返回
});

test('命令日志含章回推进所需的所有字段（可重放）', () => {
  const { s, rng } = mk();
  s.resources.cao.grain = 200;
  const r = issueOrder(s, { faction: 'cao', from: 'xudu', type: 'scout', to: 'liyang' });
  assert.equal(r.ok, true, r.reason);
  run(s, rng, 1);
  assert.ok(s.commandLog.entries.length >= 2);
  assert.ok(s.commandLog.entries.every((e) =>
    Number.isInteger(e.seq) && Number.isInteger(e.turn) && e.actor && e.type && e.payload));
  assert.doesNotThrow(() => JSON.stringify(s.commandLog));
  assert.equal(s.stats.byType.scout, 1);
});
