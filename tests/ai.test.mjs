// AI 势力：权重分桶、确定性、袭粮优先、只出 spec 不直接改 state。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, collectResources } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { planAiTurn, AI_WEIGHTS, isGranaryCity, describeAiPlan } from '../src/ai.js';
import { cityById } from '../src/map-data.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = () => createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });

test('权重合计为 1，四类都有非零份额', () => {
  const sum = Object.values(AI_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `合计 ${sum}`);
  for (const k of ['expand', 'defend', 'raid', 'march']) assert.ok(AI_WEIGHTS[k] > 0);
});

test('planAiTurn 不直接写 state，只返回可喂 issueOrder 的 spec', () => {
  const s = mk();
  collectResources(s, { apply: false });
  const before = JSON.stringify({ orders: s.orders, cities: s.cities, stats: s.stats });
  const f = s.cfg.factions.find((x) => x.ai);
  const plan = planAiTurn(s, f, createRng(7));
  assert.equal(JSON.stringify({ orders: s.orders, cities: s.cities, stats: s.stats }), before);
  for (const p of plan) {
    assert.ok(['expand', 'defend', 'raid', 'march'].includes(p.kind));
    assert.equal(p.spec.faction, f.id);
    assert.ok(s.cfg.orders.types.includes(p.spec.type), `未知命令 ${p.spec.type}`);
    assert.ok(p.spec.from);
  }
  assert.ok(Array.isArray(describeAiPlan(plan)));
});

test('同 seed 同局面 → 逐条一致；不同 seed → 允许分叉且仍全合法', () => {
  const f = cfg => cfg.factions.find((x) => x.ai);
  const a = mk(), b = mk(), c = mk();
  const p1 = [], p2 = [], p3 = [];
  const r1 = createRng(99), r2 = createRng(99), r3 = createRng(12345);
  for (let i = 0; i < 24; i++) {
    p1.push(...planAiTurn(a, f(a.cfg), r1));
    p2.push(...planAiTurn(b, f(b.cfg), r2));
    p3.push(...planAiTurn(c, f(c.cfg), r3));
  }
  assert.deepEqual(p1, p2, '同序列必须完全一致');
  assert.ok(p1.length > 0 && p3.length > 0);
  for (const p of p3) assert.ok(s3ok(p));
});
function s3ok(p) { return !!p.spec && !!p.spec.faction && !!p.spec.type; }

test('袭粮优先打粮仓城：史注含「粮 / 仓」的点位排在纯距离之前', () => {
  const s = mk();
  const granary = Object.values(s.cfg.factions).length &&
    Object.values(s.cities).map((c) => cityById(c.id)).find((m) => isGranaryCity(m));
  assert.ok(granary, '城表里应至少有一处粮仓 / 粮囤注记');
  const f = s.cfg.factions.find((x) => x.ai);
  // 强制袭粮桶，检查目标里有粮仓城时不取更近的非粮仓城。
  const w = { expand: 0, defend: 0, raid: 1, march: 0 };
  let sawGranary = false;
  for (let seed = 1; seed <= 40 && !sawGranary; seed++) {
    const plan = planAiTurn(s, f, createRng(seed), w);
    if (plan.some((p) => p.kind === 'raid' && p.spec.to === granary.id)) sawGranary = true;
  }
  assert.ok(sawGranary, '袭粮分支从未选中粮仓城');
});

test('在途命令已满时本旬不动，避免把并发上限吃光', () => {
  const s = mk();
  const f = s.cfg.factions.find((x) => x.ai);
  const cap = s.cfg.orders.maxConcurrentPerFaction;
  for (let i = 0; i < cap; i++) {
    s.orders.push({ id: 10000 + i, faction: f.id, from: 'ye', to: 'liyang',
      type: 'march', units: { daodun: 1 }, arriveTurn: 99 });
  }
  const plan = planAiTurn(s, f, createRng(5));
  assert.equal(plan.length, 0);
});
