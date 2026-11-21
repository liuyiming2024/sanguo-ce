// 终局判定：只读 state、不写字段、不进指纹；败 / 胜 / 未终三态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign } from '../src/campaign.js';
import { hashState } from '../src/sync.js';
import { checkOutcome, outcomeSummary } from '../src/outcome.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = () => createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });

test('checkOutcome 不写 state：指纹前后完全一致', () => {
  const s = mk();
  const h = hashState(s);
  const before = JSON.stringify(s.cities);
  checkOutcome(s);
  assert.equal(hashState(s), h);
  assert.equal(JSON.stringify(s.cities), before);
});

test('开局未终，摘要给出己方 / 敌方城数', () => {
  const s = mk();
  const o = checkOutcome(s);
  assert.equal(o.over, false);
  assert.equal(o.kind, 'playing');
  const sum = outcomeSummary(s);
  assert.ok(sum.own > 0 && sum.hostile > 0);
  assert.equal(sum.own + sum.hostile, sum.total);
});

test('己方城池尽失 → 败，标题与正文给出可交代的结局', () => {
  const s = mk();
  for (const c of Object.values(s.cities)) if (c.owner === s.playerFaction) c.owner = 'yuan';
  const o = checkOutcome(s);
  assert.equal(o.over, true);
  assert.equal(o.kind, 'defeat');
  assert.ok(o.title && o.body);
});

test('敌城尽取 → 胜，但不强制结档（章回可续）', () => {
  const s = mk();
  for (const c of Object.values(s.cities)) c.owner = s.playerFaction;
  const o = checkOutcome(s);
  assert.equal(o.over, true);
  assert.equal(o.kind, 'victory');
  assert.ok(o.body.includes('可另开'));
});

test('全境断粮且守军崩溃 → 粮尽众散', () => {
  const s = mk();
  for (const c of Object.values(s.cities)) {
    if (c.owner !== s.playerFaction) continue;
    c.starving = true; c.garrison = 10; c.morale = 5;
  }
  const o = checkOutcome(s);
  assert.equal(o.over, true);
  assert.equal(o.kind, 'defeat');
  assert.match(o.title, /粮/);
});

test('仅部分断粮、或断粮但尚有可用守军，不判负', () => {
  const s = mk();
  const own = Object.values(s.cities).filter((c) => c.owner === s.playerFaction);
  own[0].starving = true;
  assert.equal(checkOutcome(s).over, false);
  for (const c of own) { c.starving = true; c.garrison = 9000; c.morale = 80; }
  assert.equal(checkOutcome(s).over, false);
});
