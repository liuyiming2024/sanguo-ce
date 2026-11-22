// P5 端侧烟测最小集（Node 侧模拟小程序宿主）。
//
// 关键：测试 import 的是 miniprogram/logic/ 下的**镜像**逻辑层，不是主 src/。
// 这样「搬过去的那份真的能跑」才被验证，而不是主工程自己又跑了一遍。
// 宿主注入走镜像自己的 platform 实例（与主 src/ 是两份模块，互不相通）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import('../miniprogram/utils/slice-core.js');
const mpPlatform = await import('../miniprogram/logic/src/platform/index.js');
const mpSlots = await import('../miniprogram/logic/src/save-slots.js');
const { encodeTicket, decodeTicket } = await import('../src/sync.js');
const mpTicket = await import('../miniprogram/utils/ticket.js');

function mockStorage() {
  const m = new Map();
  return {
    name: 'mock',
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _size: () => m.size,
  };
}
const host = (s) => ({ storage: s, now: () => 1760000000000 });

test('镜像与源逐字一致：sync-miniprogram.mjs --check 必须绿', () => {
  const out = execFileSync(process.execPath,
    [join(root, 'scripts/sync-miniprogram.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /镜像一致/);
});

test('镜像闭包不含渲染 / 装配 / 结算层：皮必须重写，引擎原样搬', () => {
  const m = JSON.parse(readFileSync(join(root, 'miniprogram/logic/MANIFEST.json'), 'utf8'));
  const forbidden = ['main.js', 'map-render.js', 'atlas.js', 'ui-shell.js',
    'city-view.js', 'guandu.js', 'battle-session.js', 'siege-combat.js', 'ticket-store.js'];
  for (const f of m.files) {
    for (const bad of forbidden) assert.ok(!f.path.endsWith(bad), `镜像混进了 ${bad}`);
  }
  assert.ok(m.files.length >= 20, '闭包太小，逻辑层没搬全');
  assert.equal(m.version, '0.9.4');
});

test('冷启动 → 推旬：镜像逻辑层能建局、能推进、战报有文本', () => {
  const s = mockStorage();
  const slice = core.bootSlice({ seed: 7, host: host(s) });
  assert.equal(slice.state.turn, 0);
  assert.ok(slice.summary === undefined); // boot 不产摘要，页面另调 sliceSummary
  const before = core.sliceSummary(slice.state);
  assert.equal(before.version, '0.9.4');
  assert.ok(before.ownCities > 0 && before.hostileCities > 0);
  const r = core.pushTurn(slice);
  assert.equal(r.turn, 1);
  assert.ok(Array.isArray(r.lines));
  assert.ok(r.summary.hash !== before.hash, '推一旬后指纹没变，逻辑层没跑');
  assert.ok(r.outcome.kind === 'playing');
});

test('20 旬连推：断粮、开战、自动结算在小程序端同样会发生', () => {
  const s = mockStorage();
  const slice = core.bootSlice({ seed: 31, host: host(s) });
  let all = [];
  for (let i = 0; i < 20; i++) all = all.concat(core.pushTurn(slice).lines);
  const sum = core.sliceSummary(slice.state);
  assert.equal(sum.turn, 20);
  assert.ok(sum.land > 0);
  assert.equal(typeof sum.net, 'number');
  assert.ok(sum.hash.length === 16);
  assert.ok(all.length > 0, '20 旬一条军情都没有');
});

test('onHide 拍快照 / onShow 无渲染恢复：切后台回来逐字段一致', () => {
  const s = mockStorage();
  const slice = core.bootSlice({ seed: 7, host: host(s) });
  for (let i = 0; i < 5; i++) core.pushTurn(slice);
  const snap = core.hideSlice(slice);
  assert.ok(s._size() >= 1, 'onHide 没落本机存储');
  assert.equal(snap.hash.length, 16);
  // 模拟冷启动后重新进页面：platform 仍是同一宿主，但局面从存档重建。
  const r = core.showSlice({ storage: s, expectHash: snap.hash, host: host(s) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.turn, 5);
  assert.equal(r.consistent, true, '切后台回来指纹分叉');
  assert.equal(r.hash, snap.hash);
});

test('显式读档：冷启动后也能把第 N 旬局面往返回来', () => {
  const s = mockStorage();
  const a = core.bootSlice({ seed: 99, host: host(s) });
  for (let i = 0; i < 8; i++) core.pushTurn(a);
  const h = core.hideSlice(a).hash;
  const b = core.showSlice({ storage: s, expectHash: h, host: host(s) });
  assert.equal(b.ok, true);
  assert.equal(b.summary.turn, 8);
  assert.equal(b.summary.ownCities, core.sliceSummary(a.state).ownCities);
  assert.equal(b.summary.land, core.sliceSummary(a.state).land);
  // 恢复后还能继续推旬，rng 序列不分叉。
  const c = core.pushTurn({ state: b.state, rng: b.rng, cfg: b.cfg });
  assert.equal(c.turn, 9);
});

test('三席存档在小程序宿主下也能用（镜像 save-slots.js）', () => {
  const s = mockStorage();
  const slice = core.bootSlice({ seed: 7, host: host(s) });
  core.pushTurn(slice);
  const st = mpPlatform.storage();
  // 平台层注入的就是小程序驱动；用镜像的 save-slots 写一份再读回。
  const raw = core.hideSlice(slice).raw;
  assert.equal(mpSlots.saveSlot(1, raw).ok, true);
  const r = mpSlots.readSlot(1);
  assert.equal(r.ok, true);
  assert.equal(r.raw.turn, 1);
  assert.equal(mpSlots.listSlots()[0].empty, false);
  assert.equal(st.name, 'mock');
});

test('传帖台短号仍通：小程序 ticket.js 与主 src/sync.js 交叉解码无损', () => {
  // 复用 tests/miniprogram.test.mjs 的同一口径：对象 → JSON → base64url，
  // 含中文与增补平面字符，证明 P1/P2 改动没碰坏既有链路。
  const obj = { v: 1, game: 'sanguo-ce-guandu', version: '0.9.4',
    date: '建安五年 · 𠀀𪜀', hash: 'a1b2c3d4e5f60718',
    save: { v: 1, mapId: 'guandu', turn: 3 }, logTail: [] };
  const a = encodeTicket(obj), b = mpTicket.encodeTicket(obj);
  assert.equal(b, a, '小程序端编码与主工程不一致');
  assert.deepEqual(mpTicket.decodeTicket(a), obj);
  assert.deepEqual(decodeTicket(b), obj);
  assert.equal(mpTicket.inspectTicket(a).turn, 3);
});

test('切片页零宿主依赖：不碰 document / window / canvas / PNG', () => {
  const page = readFileSync(join(root, 'miniprogram/pages/slice/index.js'), 'utf8');
  const wxml = readFileSync(join(root, 'miniprogram/pages/slice/index.wxml'), 'utf8');
  for (const bad of ['document.', 'window.', 'getContext', 'createSelectorQuery', 'Image(', 'Path2D']) {
    assert.ok(!page.includes(bad), `切片页出现宿主 API ${bad}`);
  }
  // 只查标签与资源引用，不查说明文字（页脚写了「没有 Canvas」是文案，不是节点）。
  assert.ok(!/<image|<canvas|\.(png|jpe?g|webp|gif|svg)\b/i.test(wxml),
    '切片页挂了位图或 canvas 节点');
  assert.match(page, /onHide\(\)/);
  assert.match(page, /onShow\(\)/);
});

test('app.json 注册了切片页，app.js 注入了小程序存储驱动', () => {
  const app = JSON.parse(readFileSync(join(root, 'miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/slice/index'));
  assert.ok(app.pages.includes('pages/index/index'), '传帖台首页被挤掉了');
  const js = readFileSync(join(root, 'miniprogram/app.js'), 'utf8');
  assert.match(js, /installHost\(\{ wx \}\)/);
  assert.match(js, /App\(\{/);
});
