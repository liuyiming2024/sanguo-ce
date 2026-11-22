#!/usr/bin/env node
// 长局平衡对演：纯逻辑、零 DOM、零墙钟。多个 seed 各跑 N 旬，按 20 旬采样。
// 目的不是「证明平衡」，而是把病态（全境断粮 / 库存恒 0 / AI 发令全被拒 / 早终局）暴露成数字。
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, collectResources } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { xunLedger } from '../src/economy.js';
import { checkOutcome } from '../src/outcome.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const TURNS = Number(process.env.TURNS ?? 200);
const SEEDS = (process.env.SEEDS ?? '7,31,99,2026,20261114').split(',').map(Number);
const STEP = 20;

const snap = (s) => {
  const pf = s.playerFaction;
  const all = Object.values(s.cities);
  const own = all.filter((c) => c.owner === pf);
  const led = xunLedger(s).byFaction[pf];
  const land = s.terrain.tiles.reduce((a, t) => a + (t.owner === pf ? 1 : 0), 0);
  return {
    turn: s.turn, own: own.length, enemy: all.length - own.length, land,
    grainStock: Math.round(s.resources[pf].grain),
    income: led.income, upkeep: led.upkeep, net: led.lastNet,
    reserve: led.reserve, starving: led.starving,
    morale: Math.round(own.reduce((a, c) => a + c.morale, 0) / (own.length || 1)),
    orders: s.orders.length, ai: s.stats.aiOrders, aiKind: { ...(s.stats.aiByKind ?? {}) },
    aiRejected: s.stats.aiRejected ?? 0,
    battles: s.stats.battlesOpened, closed: s.stats.battlesClosed,
    outcome: checkOutcome(s).kind,
  };
};

for (const seed of SEEDS) {
  const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed });
  const rng = createRng(seed);
  collectResources(s, { apply: false });
  const rows = [snap(s)];
  let firstStarve = -1, firstOutcome = -1, zeroStockTurns = 0, lastAi = 0, rejectedDelta = 0;
  for (let i = 1; i <= TURNS; i++) {
    advanceTurn(s, rng);
    if (s.resources[s.playerFaction].grain <= 0) zeroStockTurns++;
    const o = checkOutcome(s);
    if (firstOutcome < 0 && o.over) firstOutcome = i;
    const starving = Object.values(s.cities).filter((c) => c.owner === s.playerFaction && c.starving).length;
    if (firstStarve < 0 && starving > 0) firstStarve = i;
    rejectedDelta = (s.stats.aiRejected ?? 0) - (rows[rows.length - 1].aiRejected ?? 0);
    if (i % STEP === 0 || i === 1) rows.push(snap(s));
    lastAi = s.stats.aiOrders;
  }
  const last = rows[rows.length - 1];
  console.log(`\n=== seed ${seed} / ${TURNS} 旬 ===`);
  console.log('turn  own enemy land  stock  income  upkeep  net  reserve starve morale orders aiOK aiRej battles outcome');
  for (const r of rows) {
    console.log(String(r.turn).padStart(4), String(r.own).padStart(4), String(r.enemy).padStart(5),
      String(r.land).padStart(5), String(r.grainStock).padStart(7),
      String(r.income).padStart(7), String(r.upkeep).padStart(8), String(r.net).padStart(6),
      String(r.reserve).padStart(8), String(r.starving).padStart(6), String(r.morale).padStart(6),
      String(r.orders).padStart(6), String(r.ai).padStart(4), String(r.aiRejected).padStart(5),
      String(r.battles).padStart(7), r.outcome);
  }
  console.log(`首次断粮旬=${firstStarve} 首次终局旬=${firstOutcome} 库存见底旬数=${zeroStockTurns}/${TURNS} AI落令=${lastAi}`);
}
