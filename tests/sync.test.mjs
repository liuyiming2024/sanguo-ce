import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, issueOrder, deployUnit, getForces } from '../src/campaign.js';
import { createRng } from '../src/rng.js';
import { serializeGame, deserializeGame } from '../src/persist.js';
import {
  stableStringify, fnv1a, stateFingerprint, hashState,
  createCommandLog, appendCommand, verifyReplay,
  createLoopbackTransport, createBroadcastTransport,
  encodeTicket, decodeTicket, createActorRegistry,
} from '../src/sync.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mkCfg = () => {
  const c = JSON.parse(JSON.stringify(cfg));
  c.factions.forEach((f) => { f.ai = false; });
  return c;
};
const mk = (c = mkCfg()) => createCampaign(c, { seed: 20261114, playerFaction: 'cao' });

test('stableStringify 与键顺序无关，fnv1a 稳定', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(fnv1a('建安五年'), fnv1a('建安五年'));
  assert.notEqual(fnv1a('建安五年'), fnv1a('建安六年'));
});

test('状态指纹只含玩法字段，不含 cfg / terrain 位图 / DOM', () => {
  const s = mk();
  const fp = stateFingerprint(s);
  assert.ok(!('cfg' in fp) && !('terrain' in fp) && !('savedAt' in fp));
  assert.equal(fp.turn, 0);
  assert.equal(fp.chapter, 'ch1');
  assert.ok(Array.isArray(fp.tiles));
  assert.doesNotThrow(() => JSON.stringify(fp));
});

test('同状态指纹一致，推进 / 下令 / 部署后变化', () => {
  const c = mkCfg();
  const a = mk(c), b = mk(c);
  assert.equal(hashState(a), hashState(b));
  const rng = createRng(20261114);
  advanceTurn(a, rng);
  assert.notEqual(hashState(a), hashState(b));
  advanceTurn(b, createRng(20261114));
  assert.equal(hashState(a), hashState(b), '同一命令序列应得到同一指纹');

  const before = hashState(b);
  const r = issueOrder(b, { faction: 'cao', from: 'xudu', type: 'scout', to: 'liyang' });
  assert.equal(r.ok, true, r.reason);
  assert.notEqual(hashState(b), before);
});

test('命令日志 seq 递增、纯 JSON、带 actor 与 turn、rng 快照位', () => {
  const log = createCommandLog(42);
  for (let i = 0; i < 5; i++) {
    const e = appendCommand(log, {
      turn: i, actor: i % 2 ? 'yuan' : 'cao', type: 'issueOrder',
      payload: { to: 'liyang' }, rngBefore: i, rngAfter: i + 1,
    });
    assert.equal(e.seq, i);
  }
  assert.equal(log.entries.length, 5);
  assert.equal(log.seq, 5);
  assert.doesNotThrow(() => JSON.stringify(log));
  assert.equal(log.entries[3].rngAfter, 4);
});

test('双路径重放：A 直接建局 / B 存档往返，12 步指纹逐步一致', () => {
  const c = mkCfg();
  const base = mk(c);
  const raw = serializeGame({ cfg: c, state: base, rng: createRng(20261114), snapshot: null, ui: {} });
  const restored = deserializeGame(c, JSON.parse(JSON.stringify(raw))).state;
  const entries = Array.from({ length: 12 }, (_, i) => ({
    seq: i, turn: i, actor: '__turn__', type: 'advanceTurn', payload: {},
  }));
  const applyEntry = (st) => advanceTurn(st, createRng(20261114 + st.turn));
  const r = verifyReplay({
    createStateA: () => base,
    createStateB: () => restored,
    entries, applyEntry,
  });
  assert.equal(r.ok, true, `第 ${r.mismatchAt} 步分叉: ${r.reason ?? ''}`);
  assert.equal(r.steps, 12);
  assert.match(r.hash, /^[0-9a-f]{16}$/);
});

test('人为制造分叉时 verifyReplay 能抓到具体步号', () => {
  const c = mkCfg();
  let delta = 0;
  const r = verifyReplay({
    createStateA: () => mk(c),
    createStateB: () => mk(c),
    entries: Array.from({ length: 6 }, (_, i) => ({ seq: i, turn: i, actor: '__turn__', type: 'x' })),
    applyEntry: (st, e) => {
      if (e.seq === 3 && ++delta === 1) st.copper += 1;  // 只有 A 被改动
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.mismatchAt, 3);
});

test('loopback 传输：A 发的命令只有 B 收到，且顺序一致', () => {
  const t = createLoopbackTransport(['A', 'B']);
  t.send('A', { type: 'issueOrder' });
  t.send('A', { type: 'advanceTurn' });
  t.send('B', { type: 'deployUnit' });
  assert.deepEqual(t.drain('B').map((x) => x.cmd.type), ['issueOrder', 'advanceTurn']);
  assert.deepEqual(t.drain('A').map((x) => x.cmd.type), ['deployUnit']);
  assert.deepEqual(t.drain('B'), []);
  t.close();
  assert.deepEqual(t.peers(), ['A', 'B']);
});

test('BroadcastChannel 不可用时安全降级为 loopback', () => {
  const saved = globalThis.BroadcastChannel;
  try {
    delete globalThis.BroadcastChannel;
    const t = createBroadcastTransport('test-fallback', 'me');
    assert.equal(t.kind, 'loopback');
    t.send('me', { type: 'x' });
    assert.equal(t.drain('peer').length, 1);
    t.close();
  } finally {
    if (saved !== undefined) globalThis.BroadcastChannel = saved;
  }
});

test('BroadcastChannel 可用时 unref，close 后不挂住事件循环', () => {
  const saved = globalThis.BroadcastChannel;
  if (typeof saved === 'undefined') return;  // 无原生支持时上一例已覆盖降级
  const t = createBroadcastTransport('test-native', 'me');
  assert.equal(t.kind, 'broadcast');
  assert.doesNotThrow(() => t.send('me', { type: 'x' }));
  assert.doesNotThrow(() => t.close());
});

test('军令帖：中文存档口令可往返，含指纹与命令日志尾', () => {
  const c = mkCfg();
  const s = mk(c);
  const rng = createRng(20261114);
  const payload = {
    v: 1, game: 'sanguo-ce-guandu', date: '建安五年 正月初一',
    hash: hashState(s),
    save: serializeGame({ cfg: c, state: s, rng, snapshot: null, ui: {} }),
    logTail: s.commandLog.entries.slice(-80),
  };
  const ticket = encodeTicket(payload);
  assert.match(ticket, /^[A-Za-z0-9_-]+$/);
  const back = decodeTicket(ticket);
  assert.equal(back.date, '建安五年 正月初一');
  assert.equal(back.hash, payload.hash);
  assert.equal(back.save.turn, 0);
  const restored = deserializeGame(c, back.save).state;
  assert.equal(hashState(restored), hashState(s), '口令往返后局面应完全一致');
});

test('actor 注册：human / ai 两态，remote 字段已预留', () => {
  const a = createActorRegistry(cfg, 'cao');
  assert.equal(a.cao.kind, 'human');
  assert.equal(a.yuan.kind, 'ai');
  assert.equal(a.liu.name, '刘备');
  a.yuan.kind = 'remote';
  a.yuan.peerId = 'peer-B';
  assert.equal(a.yuan.peerId, 'peer-B');
  const s = mk();
  assert.equal(s.actors.cao.kind, 'human');
  assert.equal(s.actors.yuan.kind, 'ai');
});
