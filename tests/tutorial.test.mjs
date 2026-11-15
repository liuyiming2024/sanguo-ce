import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTutorial, currentStep, stepCount, isActive, progress,
  advance, prev, skip, restart, dismiss, notify, awaitedEvents,
  serializeTutorial, restoreTutorial, shouldAutoStart, TUTORIAL_VERSION,
} from '../src/tutorial.js';

const def = JSON.parse(readFileSync(new URL('../config/tutorial.json', import.meta.url), 'utf8'));
const mk = (d = def) => { const t = createTutorial(d); t.active = true; return t; };

test('十二简配置完整：叙事 / 引文 / 聚焦 / 位置 / 提示', () => {
  assert.equal(stepCount(mk()), 12);
  for (const s of def.steps) {
    assert.ok(s.id && s.no && s.title && s.beat && s.quote && s.tip, `${s.id} 缺字段`);
    assert.ok(['center', 'top', 'bottom', 'left', 'right'].includes(s.place), `${s.id} 位置非法`);
    assert.ok(s.target === null || typeof s.target === 'string', `${s.id} target 非法`);
  }
  assert.equal(new Set(def.steps.map((s) => s.id)).size, def.steps.length);
  assert.equal(def.meta.seal, '教');
});

test('顺序推进，第十二简合卷，done/active 正确', () => {
  const t = mk();
  assert.equal(currentStep(t).id, 'welcome');
  assert.equal(progress(t), 0);
  for (let i = 0; i < 11; i++) {
    const r = advance(t, 'manual');
    assert.equal(r.ok, true);
    assert.equal(r.finished, false);
  }
  assert.equal(progress(t), 92);
  const last = advance(t, 'manual');
  assert.equal(last.finished, true);
  assert.equal(t.done, true);
  assert.equal(t.active, false);
  assert.equal(isActive(t), false);
  assert.equal(currentStep(t), null);
  assert.equal(advance(t).ok, false);
});

test('事件只认当前那一简的 await，纯阅读简不吃事件', () => {
  const t = mk();
  assert.equal(notify(t, 'tab:story').ok, false, '第一简是纯阅读，不能被事件跳走');
  advance(t); // → calendar（纯阅读）
  assert.equal(notify(t, 'tab:story').ok, false);
  advance(t); // → chapter（await tab:story）
  assert.equal(currentStep(t).await, 'tab:story');
  assert.equal(notify(t, 'tileSelected').ok, false, '无关事件不能推进');
  const r = notify(t, 'tab:story');
  assert.equal(r.ok, true);
  assert.equal(currentStep(t).id, 'map');
  assert.equal(t.completedBy.chapter, 'event:tab:story');
});

test('上一简 / 跳过 / 重看 / Esc 暂收，四条退路都在', () => {
  const t = mk();
  advance(t); advance(t);
  assert.equal(currentStep(t).id, 'chapter');
  assert.equal(prev(t).ok, true);
  assert.equal(currentStep(t).id, 'calendar');
  assert.equal(prev(t).ok, true);
  assert.equal(prev(t).ok, false, '第一简不能再退');

  skip(t);
  assert.equal(t.skipped, true);
  assert.equal(isActive(t), false);
  assert.equal(shouldAutoStart(t), false);

  restart(t);
  assert.equal(t.index, 0);
  assert.equal(t.done, false);
  assert.equal(t.skipped, false);
  assert.equal(isActive(t), true);
  assert.deepEqual(t.completedBy, {});

  dismiss(t);
  assert.equal(isActive(t), false);
  assert.equal(t.done, false, 'Esc 不是标完成，只是暂收');
  assert.equal(shouldAutoStart(t), true, '暂收后仍可续播');
  t.active = true;
  assert.equal(isActive(t), true);
});

test('序列化往返：进度、seen、completedBy 都保留，恢复后不自动 active', () => {
  const t = mk();
  advance(t); advance(t);
  notify(t, 'tab:story');
  const raw = serializeTutorial(t);
  assert.equal(raw.v, TUTORIAL_VERSION);
  assert.equal(raw.index, 3);
  assert.equal(raw.seen.welcome, true);
  assert.doesNotThrow(() => JSON.stringify(raw));
  const r = restoreTutorial(def, raw);
  assert.equal(r.index, 3);
  assert.equal(r.active, false);
  assert.equal(r.seen.chapter, true);
  assert.equal(r.done, false);
  assert.equal(shouldAutoStart(r), true);
  r.active = true;
  assert.equal(currentStep(r).id, 'map');
});

test('坏存档 / 越界 index / 缺字段都安全降级', () => {
  assert.equal(restoreTutorial(def, null).index, 0);
  assert.equal(restoreTutorial(def, { v: 99, index: 7 }).index, 0);
  const r = restoreTutorial(def, { v: 1, index: 999, done: false });
  assert.equal(r.index, 11);
  const r2 = restoreTutorial(def, { v: 1, index: -5 });
  assert.equal(r2.index, 0);
});

test('每个 await 事件都在装配层有接线，且事件表无重复', () => {
  const evs = awaitedEvents(def);
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.equal(new Set(evs).size, evs.length, '两个简等同一个事件会互相抢');
  for (const e of evs) {
    assert.ok(main.includes(`tutNotify('${e}')`) || main.includes('`tab:${route}`'),
      `事件 ${e} 没有在 main.js 接线`);
  }
  assert.ok(main.includes('onRoute: (route) => tutNotify(`tab:${route}`)'),
    'tab:* 事件必须由外壳的路由回调发出');
});

test('引导状态不进局面 / 命令日志 / 军令帖', () => {
  const persist = readFileSync(new URL('../src/persist.js', import.meta.url), 'utf8');
  const sync = readFileSync(new URL('../src/sync.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(!/tutorial/i.test(persist), '存档不该含引导进度');
  assert.ok(!/tutorial/i.test(sync), '状态指纹不该含引导进度');
  assert.ok(!/state\.tutorial\s*=/.test(main), '不能把引导写进 campaign state');
  assert.ok(main.includes('sanguo-ce:tutorial:v1') === false,
    '独立 key 应只由 tutorial-ui 持有');
  const ui = readFileSync(new URL('../src/tutorial-ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes("const STORE_KEY = 'sanguo-ce:tutorial:v1'"), '缺独立存储 key');
  const css = readFileSync(new URL('../styles/main.css', import.meta.url), 'utf8');
  assert.ok(/#tutorialLayer\{[^}]*pointer-events:none/.test(css),
    '遮罩层必须整体不吃指针，否则被引导的地图操作会被锁死');
  assert.ok(/\.tutCard\{[^}]*pointer-events:auto/.test(css),
    '简卡与按钮必须能吃指针');
  assert.ok(/#screen\{[^}]*bottom:58px/.test(css) &&
    /bottomBar = 66/.test(ui), '简卡定位必须避开底部 Tab');
});
