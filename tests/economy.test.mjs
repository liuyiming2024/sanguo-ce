// 旬结算：产量分摊、断粮真实化、发令约束、双路径确定性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, collectResources, advanceTurn, issueOrder } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { settleXun, xunLedger, canAffordTroops, COMMISSARY } from '../src/economy.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = () => createCampaign(JSON.parse(JSON.stringify(cfg)), { seed: 20261114 });

test('产量按城分摊，不再把全势力总产量给每座城各记一遍', () => {
  const s = mk();
  const y = collectResources(s, { apply: false });
  const total = y.cao.grain;
  const before = Object.values(s.cities).filter((c) => c.owner === 'cao')
    .map((c) => c.grain);
  const ledger = settleXun(s, y);
  const after = Object.values(s.cities).filter((c) => c.owner === 'cao')
    .map((c) => c.grain);
  // 旧版每城 += 全势力产量（944.7 × 9 城）；新版按权重分摊后总入账 = 一旬产量 − 一旬耗粮。
  const delta = after.reduce((a, b, i) => a + (b - before[i]), 0);
  assert.ok(delta < total * 1.2, `总入账 ${delta} 远超单旬产量 ${total}，疑似重复记粮`);
  assert.ok(Math.abs(delta - ledger.byFaction.cao.net) < 2,
    `城仓总变动 ${delta} 应等于旬净额 ${ledger.byFaction.cao.net}`);
  assert.ok(after.every((g) => g >= 0), '城仓不得为负');
});

test('驻军与在途按旬耗粮，净额与旬计簿一致', () => {
  const s = mk();
  const y = collectResources(s, { apply: false });
  const ledger = settleXun(s, y);
  const cao = ledger.byFaction.cao;
  assert.ok(cao.garrisonUpkeep > 0, '驻军耗粮应大于 0');
  assert.equal(cao.income, Math.round(cao.income * 10) / 10);
  assert.ok(Math.abs(cao.net - Math.round((cao.income - cao.garrisonUpkeep - cao.fieldUpkeep) * 10) / 10) < 0.11);
  const view = xunLedger(s).byFaction.cao;
  assert.equal(view.lastNet, cao.net);
  assert.equal(view.garrison, cao.garrison);
});

test('城仓掏空后断粮：掉军心、连旬后逃兵，且 starving 可回退', () => {
  const s = mk();
  const y = collectResources(s, { apply: false });
  const c = s.cities.xudu;
  c.grain = 0;
  // 人为放大驻军耗粮，使分摊产量无论如何都补不上。
  c.garrison = 2_000_000;
  const m0 = c.morale;
  for (let i = 0; i < 5; i++) { s.turn = i + 1; settleXun(s, y); }
  assert.equal(c.grain, 0);
  assert.equal(c.starving, true);
  assert.ok(c.starveTurns >= COMMISSARY.starvationGrace);
  assert.ok(c.morale < m0, '断粮应掉军心');
  // 恢复供粮后 starving 清零（把驻军降回、仓补满）。
  c.garrison = 100;
  c.grain = 100000;
  s.turn = 6; settleXun(s, y);
  assert.equal(c.starving, false);
  assert.equal(c.starveTurns, 0);
});

test('军粮告罄锁征发，但屯田 / 撤兵 / 侦察仍放行', () => {
  const s = mk();
  const y = collectResources(s, { apply: false });
  // 造一个明显入不敷出的局面：城仓清零 + 驻军巨大，连跑几旬。
  for (const c of Object.values(s.cities)) { c.grain = 0; c.garrison = 2_000_000; }
  for (let i = 0; i < 4; i++) { s.turn = i + 1; settleXun(s, y); }
  const acct = s.commissary.cao;
  assert.ok(acct.shortageTurns >= COMMISSARY.starvationGrace, '应先累计断粮旬数');
  assert.equal(canAffordTroops(s, 'cao', 'recruit').ok, false);
  assert.equal(canAffordTroops(s, 'cao', 'march').ok, false);
  for (const free of ['develop', 'withdraw', 'scout', 'claim', 'buildFort']) {
    assert.equal(canAffordTroops(s, 'cao', free).ok, true, `${free} 不该被锁`);
  }
});

test('旬结算进双时钟重放：同 seed 同命令序列，军粮账逐字段一致', () => {
  const a = mk(), b = mk();
  a.cfg.factions.forEach((f) => { f.ai = false; });
  b.cfg.factions.forEach((f) => { f.ai = false; });
  const ra = createRng(31), rb = createRng(31);
  for (let i = 0; i < 12; i++) { advanceTurn(a, ra); advanceTurn(b, rb); }
  assert.deepEqual(a.commissary, b.commissary);
  for (const [id, c] of Object.entries(a.cities)) {
    assert.equal(c.grain, b.cities[id].grain, `${id} 城仓分叉`);
    assert.equal(c.starving, b.cities[id].starving);
  }
});
