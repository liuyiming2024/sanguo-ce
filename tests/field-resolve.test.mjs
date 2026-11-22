// 「边界继续处理」的回归：战线推进 / 断粮减产 / 无人值守简算 / 不抢玩家的仗。
// 旧版 200 旬：城数 9:3 纹丝不动、库存单调涨、AI 抵达后战斗永久挂着。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, collectResources, resolveBattle } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { resolveDormantBattles, fieldStrength, AUTO_RESOLVE } from '../src/field-resolve.js';
import { COMMISSARY, xunLedger } from '../src/economy.js';
import { checkOutcome } from '../src/outcome.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = (seed = 7) => {
  const s = createCampaign(JSON.parse(JSON.stringify(cfg)), { seed });
  s.resources[s.playerFaction].grain = COMMISSARY.startReserve;
  collectResources(s, { apply: false });
  return s;
};
/** 造一场「AI 发起、滞留满 grace 旬」的攻城，攻方驻大营。 */
function seedBattle(s, { attacker, troops = 60_000, grace = AUTO_RESOLVE.graceTurns } = {}) {
  const id = attacker ?? 'yuan';
  const cityId = Object.values(s.cities).find((c) => c.owner === s.playerFaction).id;
  const bid = s.nextBattleId++;
  s.battles[bid] = { id: bid, city: cityId, attacker: id,
    startTurn: s.turn - grace, startSec: (s.turn - grace) * cfg.calendar.secPerTurn };
  s.cities[cityId].battleId = bid;
  s.cities[cityId].besieged = true;
  s.cities[cityId].garrison = 120;         // 软目标，保证简算能破城以便验回写
  s.forces[cityId].camp.push({ id: 'atk-test', type: 'daodun', faction: id,
    hp: 100, zone: 'camp', col: 1, row: 3, troops });
  return { cityId, bid };
}

test('fieldStrength 是纯函数：断粮 / 城防 / 士气都按 condition.js 的系数折进去', () => {
  const base = { troops: 1000, morale: 72, fatigue: 0, grain: 100, wall: 0 };
  const a = fieldStrength(cfg, base), b = fieldStrength(cfg, base);
  assert.equal(a.power, b.power);
  assert.ok(fieldStrength(cfg, { ...base, grain: 0 }).power < a.power, '断粮不该反而更强');
  assert.ok(fieldStrength(cfg, { ...base, wall: 200 }).power > a.power, '城防该加守方');
  assert.ok(fieldStrength(cfg, { ...base, morale: 20 }).power < a.power, '低军心该削弱');
  assert.ok(AUTO_RESOLVE.graceTurns >= 2 && AUTO_RESOLVE.onlyAiAttacker === true);
});

test('AI 滞留战斗被简算：城池易主、battle 收束、大营不堆积、命令日志可追溯', () => {
  const s = mk();
  const { cityId, bid } = seedBattle(s);
  const before = s.rngCalls;
  const evs = resolveDormantBattles(s, null, { resolveBattle });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'autoResolve');
  assert.equal(evs[0].won, true);
  assert.equal(s.cities[cityId].owner, 'yuan', '城池没有易主');
  assert.equal(s.cities[cityId].battleId, null);
  assert.equal(s.cities[cityId].besieged, false);
  assert.equal(s.battles[bid], undefined);
  assert.equal(s.forces[cityId].camp.length, 0, '简算后大营残部没清，长局会无限堆积');
  const log = s.commandLog.entries.filter((e) => e.type === 'autoResolve');
  assert.equal(log.length, 1);
  assert.equal(log[0].payload.battleId, bid);
  assert.equal(log[0].rngBefore, before);
  assert.equal(log[0].rngAfter, before, '独立派生流不该动主 rngCalls');
  assert.equal(s.rngCalls, before);
});

test('玩家自己发起的战斗永不自动结算，仗还是自己打', () => {
  const s = mk();
  const { cityId, bid } = seedBattle(s, { attacker: s.playerFaction });
  const evs = resolveDormantBattles(s, null, { resolveBattle });
  assert.equal(evs.length, 0);
  assert.equal(s.cities[cityId].battleId, bid, '玩家的仗被抢走了');
  assert.ok(s.battles[bid]);
});

test('玩家正在子界面里打的那一场被跳过（activeBattleId）', () => {
  const s = mk();
  const { bid } = seedBattle(s);
  assert.equal(resolveDormantBattles(s, null, { resolveBattle, activeBattleId: bid }).length, 0);
  assert.ok(s.battles[bid]);
  assert.equal(resolveDormantBattles(s, null, { resolveBattle, activeBattleId: null }).length, 1);
});

test('grace 未满不结算：留出救援 / 亲自接战的窗口', () => {
  const s = mk();
  const { bid } = seedBattle(s, { grace: 1 });
  assert.equal(resolveDormantBattles(s, null, { resolveBattle }).length, 0);
  assert.ok(s.battles[bid]);
  s.turn += 10;
  assert.equal(resolveDormantBattles(s, null, { resolveBattle }).length, 1);
});

test('断粮减产：饿城所辖地块本旬产量按 starvingYield 打折', () => {
  const s = mk();
  const full = collectResources(s, { apply: false })[s.playerFaction].grain;
  const cityId = Object.values(s.cities).find((c) => c.owner === s.playerFaction).id;
  const tiles = s.terrain.tiles.filter((t) => t.cityId === cityId && t.owner === s.playerFaction);
  assert.ok(tiles.length > 0, '测试城没有所辖地块');
  for (const c of Object.values(s.cities)) if (c.owner === s.playerFaction) c.starving = true;
  const famine = collectResources(s, { apply: false })[s.playerFaction].grain;
  assert.ok(famine < full, `断粮后产量没降：${full} → ${famine}`);
  assert.ok(famine >= full * COMMISSARY.starvingYield * 0.9,
    '减产过头（不该把无主格也算进去）');
});

test('200 旬长局：战线真的推进（城池易主），库存不再单调涨', () => {
  const s = mk(99);
  const rng = createRng(99);
  let owners = Object.fromEntries(Object.entries(s.cities).map(([id, c]) => [id, c.owner]));
  let flips = 0, negativeNet = 0;
  for (let i = 1; i <= 200; i++) {
    const evs = advanceTurn(s, rng);
    for (const e of evs) if (e.type === 'autoResolve' && e.won) flips++;
    for (const [id, c] of Object.entries(s.cities)) {
      if (owners[id] !== c.owner) { flips += 1000; owners[id] = c.owner; }
    }
    if (i > 100 && xunLedger(s).byFaction[s.playerFaction].lastNet < 0) negativeNet++;
  }
  assert.ok(flips >= 1000, '200 旬一次易主都没有，战线又冻住了');
  assert.ok(negativeNet > 0, '后半程净额从未转负，「库存单调涨」没处理掉');
  assert.ok(s.stats.battlesClosed > 0, '开了战却从没收束');
  assert.equal(checkOutcome(s).kind, 'playing', '不动作时不该秒终局');
});

test('同 seed 双跑：城池归属 / 军粮账 / 统计逐字段一致（简算仍接确定性重放）', () => {
  const run = () => {
    const s = mk(31);
    const rng = createRng(31);
    for (let i = 1; i <= 120; i++) advanceTurn(s, rng);
    return s;
  };
  const a = run(), b = run();
  for (const [id, c] of Object.entries(a.cities)) {
    assert.equal(c.owner, b.cities[id].owner, `${id} 归属分叉`);
    assert.equal(c.grain, b.cities[id].grain, `${id} 城仓分叉`);
    assert.equal(c.garrison, b.cities[id].garrison);
  }
  assert.deepEqual(a.commissary, b.commissary);
  assert.equal(a.stats.battlesClosed, b.stats.battlesClosed);
  assert.deepEqual(a.commandLog.entries.filter((e) => e.type === 'autoResolve'),
    b.commandLog.entries.filter((e) => e.type === 'autoResolve'));
});

test('简算不消耗主 rng：AI 决策序列与 rngCalls 一字节不受影响', () => {
  const a = mk(7), b = mk(7);
  // a 只跑 6 旬，b 在第 3 旬插入一场会被简算的滞留战斗。
  const ra = createRng(7), rb = createRng(7);
  for (let i = 1; i <= 6; i++) advanceTurn(a, ra);
  for (let i = 1; i <= 6; i++) {
    if (i === 3) seedBattle(b, { grace: 0 });
    advanceTurn(b, rb);
  }
  assert.equal(a.rngCalls, b.rngCalls);
  // a 的 AI 决策序列（battle 之外）不该因为 b 多打了一场而错位，
  // 这里用「前两旬的 AI 落令种类」作可观测锚点。
  assert.deepEqual(
    a.commandLog.entries.filter((e) => e.type === 'issueOrder').slice(0, 4).map((e) => e.payload.type),
    b.commandLog.entries.filter((e) => e.type === 'issueOrder').slice(0, 4).map((e) => e.payload.type));
});
