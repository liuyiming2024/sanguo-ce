import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampaign, advanceTurn, issueOrder } from '../src/campaign.js';
import {
  createSession, enterSession, leaveSession, tickSession,
  restoreSession, advanceBattleStep,
} from '../src/battle-session.js';
import { createRng } from '../src/rng.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const mk = () => createCampaign(cfg, { seed: 20261114 });
const turns = (s, n, seed = 7) => {
  const rng = createRng(seed);
  for (let i = 0; i < n; i++) advanceTurn(s, rng);
};

test('进入子界面：会话时刻对齐策略当前时刻', () => {
  const s = mk();
  turns(s, 3);
  const rng = createRng(9);
  const sess = createSession(cfg, s, 'guandu', { rngSnapshot: rng.snapshot() });
  const r = enterSession(sess, rng);
  assert.equal(r.ok, true);
  assert.equal(sess.active, true);
  assert.ok(Math.abs(sess.sec - s.turn * cfg.calendar.secPerTurn) < 1e-9);
  assert.ok(Math.abs(sess.morale - s.cities.guandu.morale) < 1e-9,
    `会话士气应继承城池当前值，实际 ${sess.morale} vs ${s.cities.guandu.morale}`);
});

test('退出后战斗层完全静止，策略日历继续走', () => {
  const s = mk();
  const rng = createRng(9);
  const sess = createSession(cfg, s, 'guandu', { rngSnapshot: rng.snapshot() });
  enterSession(sess, rng);
  tickSession(sess, 0.5);
  const snap = leaveSession(sess, rng);
  assert.equal(sess.active, false);
  const frozen = sess.sec;
  tickSession(sess, 5);              // 未激活，不该推进
  assert.equal(sess.sec, frozen);
  turns(s, 8);
  assert.equal(sess.sec, frozen, '退出期间战斗层应静止');
  assert.equal(s.turn, 8);
  assert.equal(snap.campaignTurn, 0);
  assert.equal(snap.stepsRun, sess.stepsRun);
});

test('隔一个月再点进去：用同一固定步长空跑补齐，不另写公式', () => {
  const s = mk();
  const rng = createRng(9);
  const sess = createSession(cfg, s, 'guandu', { rngSnapshot: rng.snapshot() });
  enterSession(sess, rng);
  tickSession(sess, 0.3);
  let snap = leaveSession(sess, rng);
  turns(s, 9);                       // 三旬 = 一个月

  const sess2 = restoreSession(cfg, s, snap);
  const r = enterSession(sess2, rng);
  assert.equal(r.ok, true);
  const expectedSteps = Math.round(
    (s.turn * cfg.calendar.secPerTurn - snap.sec) / cfg.battle.fixedStepSec);
  assert.equal(r.fastForwardSteps, expectedSteps);
  assert.ok(r.fastForwardSteps > 100, `隔月快进应有大量步数，实际 ${r.fastForwardSteps}`);
  assert.ok(Math.abs(sess2.sec - s.turn * cfg.calendar.secPerTurn) < 1e-9);
});

test('「一直盯着打」与「离开再回来」结果逐字段一致', () => {
  // A：全程实时（每次 rAF 给 1/60 秒，累计到目标时刻）
  const sA = mk(), rngA = createRng(31);
  const a = createSession(cfg, sA, 'guandu', { rngSnapshot: rngA.snapshot() });
  enterSession(a, rngA);
  // B：先打一小段，退出，策略走 6 旬，再进来快进
  const sB = mk(), rngB = createRng(31);
  const b = createSession(cfg, sB, 'guandu', { rngSnapshot: rngB.snapshot() });
  enterSession(b, rngB);

  const totalSec = 6 * cfg.calendar.secPerTurn;
  const dt = cfg.battle.fixedStepSec;
  const totalSteps = Math.round(totalSec / dt);

  // A：策略每满一旬推进一次，同时战斗逐帧推进（严格保持策略→战斗顺序）
  let acc = 0;
  for (let i = 0; i < totalSteps; i++) {
    acc += dt;
    if (acc >= cfg.calendar.secPerTurn - 1e-9) { acc -= cfg.calendar.secPerTurn; advanceTurn(sA, rngA); }
    advanceBattleStep(a, dt);
  }

  // B：先实时跑 0.25s，退出；策略走 6 旬（期间投放邮箱事件），再进来
  const warmSteps = Math.round(0.25 / dt);
  for (let i = 0; i < warmSteps; i++) advanceBattleStep(b, dt);
  const snap = leaveSession(b, rngB);
  for (let i = 0; i < 6; i++) advanceTurn(sB, rngB);
  // 对齐邮箱：A 侧也在同一策略序列上，所以两边 mailbox 内容一致
  const b2 = restoreSession(cfg, sB, snap);
  enterSession(b2, rngB);

  assert.ok(Math.abs(a.sec - b2.sec) < 1e-9, `时刻 ${a.sec} vs ${b2.sec}`);
  assert.equal(a.stepsRun - warmSteps, b2.stepsRun - warmSteps + 0);
  assert.ok(Math.abs(a.morale - b2.morale) < 1e-9, `士气 ${a.morale} vs ${b2.morale}`);
  assert.ok(Math.abs(a.cityWall - b2.cityWall) < 1e-9);
  assert.equal(a.pendingOrders.length, b2.pendingOrders.length);
});

test('邮箱事件按 atSec 顺序回放，不是月末一次性倾倒', () => {
  const s = mk();
  const rng = createRng(5);
  // 在两个不同回合下发定向指令
  issueOrder(s, { faction: 'cao', from: 'xudu', type: 'fireDirectional',
    selection: ['1,1'], direction: { x: 1, y: 0 } });
  advanceTurn(s, rng);
  issueOrder(s, { faction: 'cao', from: 'xudu', type: 'stratagem',
    stratagem: '鼓舞', selection: ['2,2'] });
  advanceTurn(s, rng);
  assert.equal(s.mailbox.length, 2);
  assert.ok(s.mailbox[0].atSec < s.mailbox[1].atSec);

  const sess = createSession(cfg, s, 'xudu', { rngSnapshot: rng.snapshot() });
  sess.sec = 0;   // 从第 0 秒开始回放邮箱
  // 快进到第 2 旬
  const target = s.turn * cfg.calendar.secPerTurn;
  let steps = 0;
  while (sess.sec < target - 1e-9 && steps++ < 5000) {
    advanceBattleStep(sess, cfg.battle.fixedStepSec);
  }
  assert.equal(sess.pendingOrders.length, 2);
  assert.equal(sess.pendingOrders[0].kind, 'fireDirectional');
  assert.equal(sess.pendingOrders[1].kind, 'stratagem');
  assert.ok(sess.history[0].atSec <= sess.history[1].atSec);
});

test('快进步数超过上限时明确拒绝，不静默截断', () => {
  const s = mk();
  const rng = createRng(1);
  const sess = createSession(cfg, s, 'xudu', { rngSnapshot: rng.snapshot() });
  sess.sec = -1e9;
  const r = enterSession(sess, rng);
  assert.equal(r.ok, false);
  assert.match(r.reason, /上限/);
});
