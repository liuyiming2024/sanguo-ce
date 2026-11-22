#!/usr/bin/env node
// 小程序 P2 的前置证据：逻辑层整包可搬，且「切后台拍快照 → 回来无渲染快进」
// 在纯 Node 环境逐字段一致。
//
// 这条脚本刻意不碰 DOM / Canvas / PNG / localStorage / 墙钟以外的任何宿主 API：
// 只 import src/ 的纯逻辑模块与 config/ 的数据，用 JSON 字符串模拟平台 storage
// 传回来的存档。能跑通就等于证明「小程序端 import 进来一行不用改」这句话，
// 也证明 onHide / onShow 的解法不是纸面推演。
//
// 它验证的是 P2 的**内核前提**，不是 P2 本身：端侧 WXML/WXSS 页面仍需要
// 小程序运行时才能验，本仓库没有，故不写未经运行验证的页面。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createCampaign, advanceTurn, collectResources } from '../src/campaign.js';
import { createRng, rngFromSnapshot } from '../src/rng.js';
import { serializeGame, deserializeGame } from '../src/persist.js';
import { xunLedger, shortageReport } from '../src/economy.js';
import { checkOutcome } from '../src/outcome.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const SEED = Number(process.env.SEED ?? 20261114);
const TURNS = Number(process.env.TURNS ?? 8);
const SPLIT = Number(process.env.SPLIT ?? 3);   // 第几旬「切后台」
const clone = (o) => JSON.parse(JSON.stringify(o));

// 稳定序列化：键排序，排除存档元数据（savedAt 是墙钟，本就不进 state）
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  }
  return v;
}
// 比的是**存档 JSON**，不是内存对象：平台 storage 只认 JSON，onHide/onShow
// 真正传递的就是这一份。serializeGame 已把 undefined 规范成 {} / [] / ''，
// 于是「实时态 chapterEnteredTurn=undefined」与「恢复态 ={}」这类表示差异
// 不会污染语义比对；两份 JSON 一致才是跨端可搬的判据。
function archive(state, rng) {
  const raw = serializeGame({
    cfg, state, rng, snapshot: null,
    ui: { auto: true, camera: null, battleCityId: null },
  });
  const o = stable(raw);
  delete o.savedAt;          // 墙钟元数据，本就不进状态
  return { text: JSON.stringify(o), obj: o };
}

// ── 路径 A：一直盯着打的 TURNS 旬 ────────────────────────────────
const A = createCampaign(clone(cfg), { seed: SEED });
const rngA = createRng(SEED);
collectResources(A, { apply: false });
for (let i = 0; i < SPLIT; i++) advanceTurn(A, rngA);

// onHide：拍一份纯 JSON 快照，走一遍序列化再回来，模拟平台 storage 只认 JSON
const raw = serializeGame({
  cfg, state: A, rng: rngA, snapshot: null,
  ui: { auto: true, camera: null, battleCityId: null },
});
const wire = clone(raw);
assert.equal(typeof wire.rng.state, 'number', 'RNG 状态必须能进 JSON');
assert.equal(typeof wire.rng.calls, 'number', 'RNG 调用计数必须能进 JSON');

// ── 路径 B：onShow，从快照恢复后无渲染快进余下旬 ──────────────────
const back = deserializeGame(cfg, clone(wire));
const rngB = rngFromSnapshot(wire.rng);
for (let i = SPLIT; i < TURNS; i++) advanceTurn(back.state, rngB);
for (let i = SPLIT; i < TURNS; i++) advanceTurn(A, rngA);

// ── 逐字段比对 ─────────────────────────────────────────────────
const a = archive(A, rngA), b = archive(back.state, rngB);
if (a.text !== b.text) {
  // 给可定位的第一处分叉，而不是只抛一句「不一致」
  // 取并集：JSON.stringify 会丢掉值为 undefined 的键，只遍历 a 会漏掉
  // 「A 无此键 / B 有此键」这一类分叉。
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      console.error('首处分叉字段:', k);
      console.error('  A =', String(JSON.stringify(a[k])).slice(0, 300));
      console.error('  B =', String(JSON.stringify(b[k])).slice(0, 300));
      break;
    }
  }
  assert.fail('快照快进与实时推进不一致');
}

// 战报文本（P2 要展示的最小可读产物）也必须一致
const ledgerA = xunLedger(A), ledgerB = xunLedger(back.state);
assert.deepEqual(stable(ledgerA), stable(ledgerB), '旬计簿派生不一致');
assert.deepEqual(stable(shortageReport(A)), stable(shortageReport(back.state)), '断粮战报不一致');
assert.equal(checkOutcome(A).kind, checkOutcome(back.state).kind, '终局判定不一致');

const l = xunLedger(A).byFaction[A.playerFaction];
console.log('逻辑切片通过：纯 Node，零 DOM / 零 PNG / 零 Canvas / 零宿主存储');
console.log(`  seed=${SEED}  推旬=${TURNS}  切后台于第 ${SPLIT} 旬  逐字段一致`);
console.log(`  RNG 快照 state=${wire.rng.state} calls=${wire.rng.calls}`);
console.log(`  旬计簿：本旬产 ${l.income} · 耗 ${l.upkeep} · 净 ${l.lastNet} · 断粮 ${l.starving} 城`);
console.log(`  战报：${shortageReport(A)?.sub ?? '（本旬无断粮，战报为空）'}`);
console.log(`  终局：${checkOutcome(A).kind}`);
