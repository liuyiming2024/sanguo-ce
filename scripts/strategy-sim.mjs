#!/usr/bin/env node
// 策略对演：补上「系数只由 idle 长局定标、未试玩」这块边界。
// 不是真人试玩，但是四种玩家策略 × 多 seed 的确定性对局，用来证明
// 「玩家作为 / 不作为」会走出不同局面，而不是只有一条固定的 200 旬曲线。
//
// 纯逻辑、零 DOM / 零墙钟；所有动作仍走 issueOrder → 同一条命令日志。
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, collectResources, issueOrder } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { hasAdjacentTerritory } from '../src/pathfind.js';
import { checkOutcome } from '../src/outcome.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const TURNS = Number(process.env.TURNS ?? 200);
const SEEDS = (process.env.SEEDS ?? '7,31').split(',').map(Number);
const STRATEGIES = ['idle', 'recruit', 'claim', 'mixed'];

/** 找一块相邻己方领地、高产、无主的格；对演只用它，不引入新随机。 */
function nextClaim(state, pf) {
  const tiles = state.terrain.tiles;
  for (const t of tiles) {
    if (t.owner || t.cost >= 90 || (t.y?.grain ?? 0) <= 1) continue;
    if (hasAdjacentTerritory(state.terrain, pf, t.c, t.r)) return t;
  }
  return null;
}
function myCities(state, pf) {
  return Object.values(state.cities).filter((c) => c.owner === pf);
}

function act(state, pf, strategy, turn) {
  const mine = myCities(state, pf);
  if (!mine.length) return 0;
  if (strategy === 'idle') return 0;
  const doRecruit = strategy === 'recruit' || (strategy === 'mixed' && turn % 16 === 0);
  const doClaim = strategy === 'claim' || (strategy === 'mixed' && turn % 8 === 0);
  let n = 0;
  if (doRecruit && turn % 8 === 0) {
    // 守军最多的城征兵：不挑软柿子，尽量贴近「玩家会做的保守操作」。
    const from = mine.slice().sort((a, b) => b.garrison - a.garrison)[0];
    if (issueOrder(state, { faction: pf, from: from.id, type: 'recruit',
      units: { daodun: 300 } }).ok) n++;
  }
  if (doClaim) {
    const t = nextClaim(state, pf);
    if (t) {
      const from = mine[0];
      if (issueOrder(state, { faction: pf, from: from.id, type: 'claim',
        tile: { c: t.c, r: t.r }, units: { daodun: 300 } }).ok) n++;
    }
  }
  return n;
}

console.log(`策略对演：${TURNS} 旬 × ${SEEDS.length} seed × ${STRATEGIES.length} 策略`);
console.log('策略      seed  己城 敌城 领地  末库存  断粮旬 易主  终局旬  玩家发令  简算破城');
for (const strategy of STRATEGIES) {
  for (const seed of SEEDS) {
    const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed });
    s.resources[s.playerFaction].grain = 600;
    collectResources(s, { apply: false });
    const rng = createRng(seed);
    const pf = s.playerFaction;
    let firstStarve = -1, firstOutcome = -1, flips = 0, issued = 0, autoWon = 0;
    let owners = Object.fromEntries(Object.entries(s.cities).map(([id, c]) => [id, c.owner]));
    for (let i = 1; i <= TURNS; i++) {
      const evs = advanceTurn(s, rng);   // 先结算上一旬，再下本旬令，贴近真实操作顺序
      for (const e of evs) if (e.type === 'autoResolve' && e.won) autoWon++;
      for (const [id, c] of Object.entries(s.cities)) {
        if (owners[id] !== c.owner) { flips++; owners[id] = c.owner; }
      }
      if (firstStarve < 0 && myCities(s, pf).some((c) => c.starving)) firstStarve = i;
      const o = checkOutcome(s);
      if (firstOutcome < 0 && o.over) firstOutcome = i;
      issued += act(s, pf, strategy, i);
    }
    const mine = myCities(s, pf);
    const land = s.terrain.tiles.filter((t) => t.owner === pf).length;
    console.log(strategy.padEnd(9), String(seed).padStart(4),
      String(mine.length).padStart(4), String(Object.keys(s.cities).length - mine.length).padStart(5),
      String(land).padStart(5),
      String(Math.round(s.resources[pf].grain)).padStart(8),
      String(firstStarve).padStart(7), String(flips).padStart(5),
      String(firstOutcome).padStart(8), String(issued).padStart(10),
      String(autoWon).padStart(10));
  }
}
