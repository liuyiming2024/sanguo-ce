// C1 兑现度回归：长局对演不是「跑过就算」，要把三条病态钉成红灯。
// 旧版 200 旬实测：城仓恒满、零断粮、reserve 跌到 −34 万而真实库存涨到 8 万、
// AI 一旬旬空转。本文件用 120 旬 × 2 seed 守住二次定标后的口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, collectResources } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { xunLedger, COMMISSARY } from '../src/economy.js';
import { targetScore, isGranaryCity, AI_TARGET, planAiTurn } from '../src/ai.js';
import { cityById } from '../src/map-data.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const TURNS = 120;
const mk = (seed) => {
  const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed });
  // 装配层给的开局周转粮；纯逻辑测试里显式注入，避免「库存 0 发不出令」的假象。
  s.resources[s.playerFaction].grain = COMMISSARY.startReserve;
  collectResources(s, { apply: false });
  return s;
};
const run = (seed) => {
  const s = mk(seed);
  const rng = createRng(seed);
  let firstStarve = -1, lateRejected = 0, prevRejected = 0, badNumbers = 0;
  for (let i = 1; i <= TURNS; i++) {
    advanceTurn(s, rng);
    const pool = s.resources[s.playerFaction].grain;
    if (!Number.isFinite(pool) || pool < 0) badNumbers++;
    const starving = Object.values(s.cities).filter((c) =>
      c.owner === s.playerFaction && c.starving).length;
    if (firstStarve < 0 && starving > 0) firstStarve = i;
    const rejected = s.stats.aiRejected ?? 0;
    if (i > TURNS / 2) lateRejected += Math.max(0, rejected - prevRejected);
    prevRejected = rejected;
  }
  return { s, firstStarve, lateRejected, badNumbers };
};

test('城仓初值与 condition.js 同源：守军 × 每兵口粮 × fullTurns', () => {
  const s = mk(7);
  const upkeep = cfg.hidden.grainUpkeepPerUnitTurn;
  const full = cfg.condition.hunger.fullTurns;
  for (const c of Object.values(s.cities)) {
    assert.equal(c.grain, Math.round(c.garrison * upkeep * full),
      `${c.id} 城仓又退回「人口 ×2.4」的巨仓口径`);
  }
});

test('每兵旬耗粮与领地旬产粮同量级：常态略盈，不是恒饿也不是恒撑', () => {
  const s = mk(7);
  const before = Object.values(s.cities).filter((c) => c.owner === s.playerFaction)
    .reduce((a, c) => a + c.grain, 0);
  const y = collectResources(s, { apply: false });
  const garrison = Object.values(s.cities).filter((c) => c.owner === s.playerFaction)
    .reduce((a, c) => a + c.garrison, 0);
  const upkeep = garrison * cfg.hidden.grainUpkeepPerUnitTurn;
  assert.ok(y[s.playerFaction].grain > upkeep * 0.8 && y[s.playerFaction].grain < upkeep * 3,
    `旬产 ${y[s.playerFaction].grain} 与旬耗 ${upkeep} 不在同一量级，断粮永远不会或立刻发生`);
  assert.ok(before > 0);
});

test('120 旬内断粮真的会发生，且不是第 1 旬就全境饿死', () => {
  for (const seed of [7, 31]) {
    const r = run(seed);
    assert.ok(r.firstStarve > 1 && r.firstStarve <= TURNS,
      `seed ${seed}: 首次断粮旬 ${r.firstStarve}，C1「让缺粮真会发生」没兑现`);
  }
});

test('旬计簿 reserve 就是真实库存：不再另起一本跌到 −34 万的虚拟账', () => {
  for (const seed of [7, 31]) {
    const { s } = run(seed);
    const led = xunLedger(s).byFaction[s.playerFaction];
    const real = Math.round(s.resources[s.playerFaction].grain * 10) / 10;
    assert.equal(led.reserve, real, `seed ${seed}: 旬计簿 ${led.reserve} ≠ 顶栏库存 ${real}`);
    assert.ok(led.reserve >= 0);
    assert.equal(s.commissary[s.playerFaction].lastTurn, s.turn);
  }
});

test('AI 不再长局空转：后半程被拒命令几乎不增长（断粮改走救荒）', () => {
  for (const seed of [7, 31]) {
    const r = run(seed);
    assert.ok(r.lateRejected <= 6,
      `seed ${seed}: 后 60 旬又拒了 ${r.lateRejected} 条，AI 仍在硬征兵/硬出征`);
    assert.equal(r.badNumbers, 0, '库存出现 NaN 或负数');
  }
});

test('同 seed 双跑：军粮账 / 城仓 / 统计逐字段一致（C1 仍接确定性重放）', () => {
  const a = run(99), b = run(99);
  assert.deepEqual(a.s.commissary, b.s.commissary);
  assert.equal(a.firstStarve, b.firstStarve);
  assert.equal(a.s.stats.aiOrders, b.s.stats.aiOrders);
  assert.equal(a.s.stats.aiRejected, b.s.stats.aiRejected);
  for (const [id, c] of Object.entries(a.s.cities)) {
    assert.equal(c.grain, b.s.cities[id].grain, `${id} 城仓分叉`);
    assert.equal(c.starving, b.s.cities[id].starving);
    assert.equal(c.morale, b.s.cities[id].morale);
  }
});

test('AI 目标评分：软目标优于坚城，粮仓城在袭粮桶里更优先', () => {
  const s = mk(7);
  const cf = cityById('ye');
  const soft = { id: 'guandu', garrison: 300, wall: 20 };
  const hard = { id: 'ye', garrison: 9000, wall: 180 };
  assert.ok(cf, '邺应在城表里');
  assert.ok(targetScore(soft, cf, false) < targetScore(hard, cf, false),
    '守军九千的坚城不该排在三百守军的空城前面');
  const gran = Object.values(s.cities).map((c) => cityById(c.id)).find(isGranaryCity);
  if (gran) {
    const c = s.cities[gran.id] ?? { id: gran.id, garrison: 1000, wall: 60 };
    assert.equal(targetScore(c, cf, true) < targetScore(c, cf, false), true,
      '袭粮桶里粮仓城分数应更低（更优先）');
  }
  assert.ok(AI_TARGET.granaryRaidBonus > AI_TARGET.granaryBonus);
});

test('断粮时 AI 出的是救荒策，不是必被拒的征兵 / 出征', () => {
  const s = mk(7);
  const f = s.cfg.factions.find((x) => x.ai);
  for (const c of Object.values(s.cities)) {
    if (c.owner !== f.id) continue;
    c.starving = true; c.grain = 0;
  }
  // commissary 由 settleXun 懒初始化；纯逻辑测试里显式补一份，
  // 与「城池 starving 标记」两条判定路径都覆盖到。
  s.commissary ??= {};
  s.commissary[f.id] = { ...(s.commissary[f.id] ?? {}), starvingCities:
    Object.values(s.cities).filter((c) => c.owner === f.id).length };
  const plan = planAiTurn(s, f, createRng(5));
  for (const p of plan) {
    assert.equal(p.relief, true, '断粮时仍出了常规军令');
    assert.ok(['claim', 'withdraw'].includes(p.spec.type),
      `救荒策不该是 ${p.spec.type}`);
  }
});
