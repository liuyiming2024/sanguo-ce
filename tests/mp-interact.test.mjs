// 可交互格网回归：视口相机 + 命中层 + P1 最后一个适配点（input.js）被消费。
//
// 全部从 miniprogram/logic/ **镜像** import，不是主 src/；命中用假事件、假 rect，
// 不依赖真机与 DOM。默认全图输出与上一轮 18×14 基线逐字一致也在这里守住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import('../miniprogram/utils/slice-core.js');
const mm = await import('../miniprogram/logic/src/platform/mini-map.js');
const inp = await import('../miniprogram/logic/src/platform/input.js');
const cv = await import('../miniprogram/logic/src/platform/canvas.js');
const read = (p) => readFileSync(join(root, p), 'utf8');

function mockStorage() {
  const m = new Map();
  return { name: 'mock', getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const boot = (seed = 7) => core.bootSlice({ seed,
  host: { storage: mockStorage(), now: () => 1760000000000 } });

// ── ① 默认视口 = 旧 18×14 基线，一字未改 ────────────────────────────
test('默认全图与显式传全图 box 逐字一致：旧 18×14 回归基线没破', () => {
  const s = boot();
  const a = mm.miniMapCells(s.state);
  const b = mm.miniMapCells(s.state, { box: mm.fullBox(s.state) });
  assert.deepEqual(a, b);
  assert.equal(a.cols, 18);
  assert.equal(a.rows, 14);
  assert.equal(a.cells.length, 252);
  assert.equal(a.zoom, 1);
  assert.deepEqual(a.box, { c0: 0, r0: 0, c1: a.srcCols, r1: a.srcRows });
  const v = mm.miniMapView(s.state);
  assert.equal(v.cells.length, 252);
  const ops = mm.miniMapDrawOps(s.state);
  assert.equal(ops.ops.filter((o) => o.type === 'fillRect').length, 252);
  assert.equal(ops.zoom, 1);
});

test('指定 box 看局部：格数不变、zoom 变化、色块随视口改变', () => {
  const s = boot(31);
  const all = mm.miniMapView(s.state);
  const half = mm.miniMapView(s.state, { box: { c0: 0, r0: 0, c1: 72, r1: 54 } });
  assert.equal(half.cells.length, 252);
  assert.ok(half.zoom > 1.9 && half.zoom < 2.1);
  assert.ok(half.cells.some((c, i) => c.color !== all.cells[i].color),
    '换了视口色块却没变，box 没接进降采样');
  // 同 state + 同 box 必须确定
  assert.deepEqual(half, mm.miniMapView(s.state, { box: { c0: 0, r0: 0, c1: 72, r1: 54 } }));
});

// ── ② 相机纯函数 ────────────────────────────────────────────────────
test('fullBox / clampBox：负坐标、超界、过小跨度都夹回合法区间', () => {
  const s = boot();
  const { W, H } = mm.miniMapSize(s.state);
  assert.deepEqual(mm.fullBox(s.state), { c0: 0, r0: 0, c1: W, r1: H });
  const bad = mm.clampBox({ c0: -50, r0: -50, c1: 5, r1: 5 }, W, H);
  assert.ok(bad.c0 >= 0 && bad.r0 >= 0);
  assert.ok(bad.c1 - bad.c0 >= mm.MINI_MAP.minSpanC);
  assert.ok(bad.r1 - bad.r0 >= mm.MINI_MAP.minSpanR);
  const over = mm.clampBox({ c0: W - 2, r0: H - 2, c1: W + 99, r1: H + 99 }, W, H);
  assert.ok(over.c1 <= W && over.r1 <= H);
  assert.ok(over.c1 > over.c0 && over.r1 > over.r0);
  assert.deepEqual(mm.clampBox(null, W, H), mm.clampBox({}, W, H));
});

test('panBox 平移带夹取：推到边界也不会露出图外', () => {
  const s = boot();
  const { W, H } = mm.miniMapSize(s.state);
  let b = mm.zoomBox(mm.fullBox(s.state), 3, { x: 0.5, y: 0.5 }, W, H);
  b = mm.panBox(b, -10000, -10000, W, H);
  assert.equal(b.c0, 0); assert.equal(b.r0, 0);
  b = mm.panBox(b, 10000, 10000, W, H);
  assert.equal(b.c1, W); assert.equal(b.r1, H);
  const span = b.c1 - b.c0;
  const moved = mm.panBox(b, -3, 0, W, H);
  assert.equal(moved.c1 - moved.c0, span, '平移不该改变跨度');
});

test('zoomBox 锚点保持：以左上 / 右下为锚缩放时该角不动', () => {
  const s = boot();
  const { W, H } = mm.miniMapSize(s.state);
  const full = mm.fullBox(s.state);
  const tl = mm.zoomBox(full, 2, { x: 0, y: 0 }, W, H);
  assert.equal(tl.c0, 0); assert.equal(tl.r0, 0);
  const br = mm.zoomBox(full, 2, { x: 1, y: 1 }, W, H);
  assert.equal(br.c1, W); assert.equal(br.r1, H);
  const mid = mm.zoomBox(full, 2, { x: 0.5, y: 0.5 }, W, H);
  assert.equal(mid.c0, 36); assert.equal(mid.r0, 27);
  assert.equal(mid.c1, 108); assert.equal(mid.r1, 81);
  // 缩到底后不再变小；非法 factor 当 1
  const tiny = mm.zoomBox(full, 1e9, { x: 0.5, y: 0.5 }, W, H);
  assert.equal(tiny.c1 - tiny.c0, mm.MINI_MAP.minSpanC);
  assert.deepEqual(mm.zoomBox(full, 0, {}, W, H), full);
  assert.deepEqual(mm.zoomBox(full, -3, {}, W, H), full);
});

test('createMiniCamera：同串操作确定、get box 是副本、reset 回全图', () => {
  const s = boot(99);
  const a = mm.createMiniCamera(s.state), b = mm.createMiniCamera(s.state);
  const seq = (c) => { c.zoom(2, { x: 0.3, y: 0.7 }); c.pan(5, -3); c.zoom(1.4); return c.box; };
  assert.deepEqual(seq(a), seq(b), '相机不确定，端侧重绘会分叉');
  const box = a.box;
  box.c0 = 999;                       // 外部改副本不该污染内部
  assert.notEqual(a.box.c0, 999);
  assert.ok(a.zoomLevel() > 1);
  a.reset();
  assert.equal(a.zoomLevel(), 1);
  assert.deepEqual(a.box, mm.fullBox(s.state));
  assert.equal(a.opts().cols, 18);
  assert.equal(a.opts().rows, 14);
  assert.ok(a.opts().box);
});

// ── ③ 命中 ──────────────────────────────────────────────────────────
test('hitTestMiniMap：四角有结果、越界/非法返回 null、tileIndex 自洽', () => {
  const s = boot();
  const opts = mm.createMiniCamera(s.state).opts();
  for (const p of [{ x: 0, y: 0 }, { x: 0.999, y: 0.999 }, { x: 0.5, y: 0.5 }]) {
    const h = mm.hitTestMiniMap(s.state, opts, p);
    assert.ok(h, `点 ${JSON.stringify(p)} 没命中`);
    assert.equal(h.tileIndex, h.sr * 144 + h.sc);
    assert.ok(h.sc >= 0 && h.sc < 144 && h.sr >= 0 && h.sr < 108);
    assert.match(h.color, /^#[0-9a-f]{6}$/i);
  }
  for (const p of [null, { x: -0.01, y: 0.5 }, { x: 1, y: 0.5 },
    { x: 0.5, y: 1.2 }, { x: NaN, y: 0.5 }, { x: 0.5 }]) {
    assert.equal(mm.hitTestMiniMap(s.state, opts, p), null);
  }
});

test('命中与降采样同源：cell.owner/terrain 与实际 tile 不冲突；放大后同点命中不同源格', () => {
  const s = boot();
  const cam = mm.createMiniCamera(s.state);
  const p = { x: 0.5, y: 0.5 };
  const h0 = mm.hitTestMiniMap(s.state, cam.opts(), p);
  cam.zoom(3, { x: 0.5, y: 0.5 });
  const h1 = mm.hitTestMiniMap(s.state, cam.opts(), p);
  assert.ok(h1.zoom > h0.zoom);
  assert.notDeepEqual({ sc: h0.sc, sr: h0.sr }, { sc: h1.sc, sr: h1.sr });
  const tile = s.state.terrain.tiles[h1.tileIndex];
  assert.equal(h1.owner, tile.owner ?? '');
  assert.equal(h1.terrain, tile.type ?? h1.terrain);
  assert.equal(h1.cityId, tile.cityId ?? null);
});

test('resolveMiniMapHit：mouse / touch / changedTouches / detail 四形状 + rect 偏移', () => {
  const s = boot();
  const cam = mm.createMiniCamera(s.state);
  const opts = cam.opts();
  const rect = { left: 20, top: 10, width: 200, height: 100 };
  const cases = [
    [{ clientX: 120, clientY: 60 }, 'mouse'],
    [{ touches: [{ clientX: 120, clientY: 60 }] }, 'touch'],
    [{ changedTouches: [{ clientX: 120, clientY: 60 }] }, 'changedTouch'],
    [{ detail: { clientX: 120, clientY: 60 } }, 'detail'],
  ];
  let first = null;
  for (const [e, source] of cases) {
    const h = mm.resolveMiniMapHit(e, rect, s.state, opts);
    assert.ok(h, `${source} 没命中`);
    assert.equal(h.source, source);
    assert.ok(Math.abs(h.norm.x - 0.5) < 1e-9);
    assert.ok(Math.abs(h.norm.y - 0.5) < 1e-9);
    if (!first) first = { sc: h.sc, sr: h.sr };
    else assert.deepEqual({ sc: h.sc, sr: h.sr }, first, '四种形状命中不一致');
  }
  // 缺 rect 尺寸 / 点在画布外 / 空事件 → null
  assert.equal(mm.resolveMiniMapHit({ clientX: 120, clientY: 60 }, { left: 0, top: 0 }, s.state, opts), null);
  assert.equal(mm.resolveMiniMapHit({ clientX: 999, clientY: 60 }, rect, s.state, opts), null);
  assert.equal(mm.resolveMiniMapHit(null, rect, s.state, opts), null);
});

// ── ④ P1 最后一个适配点：input.js 多指归一真被消费 ──────────────────
test('normalizeTouches / touchDistance / midpoint / pinchRatio', () => {
  const two = { touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] };
  assert.equal(inp.normalizeTouches(two).length, 2);
  assert.equal(inp.touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }), 5);
  assert.deepEqual(inp.midpoint({ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 20 }),
    { clientX: 5, clientY: 10 });
  const open = { touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }] };
  assert.equal(inp.pinchRatio(two, open), 2);
  assert.equal(inp.pinchRatio(open, two), 0.5);
  assert.equal(inp.pinchRatio(two, { touches: [{ clientX: 0, clientY: 0 }] }), 1);
  assert.equal(inp.pinchRatio({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 0 }] }, open), 1);
  // changedTouches 回落 + 非法点过滤
  assert.equal(inp.normalizeTouches({ changedTouches: [{ clientX: 1, clientY: 2 }] }).length, 1);
  assert.equal(inp.normalizeTouches({ touches: [{ clientX: 1, clientY: 2 }, { x: 3 }] }).length, 1);
  assert.equal(inp.normalizeTouches(null).length, 0);
});

test('mini-map.js 真的 import 了 input.js：P1 四个适配点全部被消费', () => {
  const src = read('src/platform/mini-map.js');
  assert.match(src, /from '\.\/input\.js'/);
  assert.match(src, /normalizePointer\(/);
  // 四个适配点：storage（persist/save-slots）、canvas（画布页）、
  // input（本轮命中）、index（app.js 注入）——逐个核引用点
  assert.match(read('src/persist.js'), /platform\/index\.js/);
  assert.match(read('miniprogram/pages/canvas/index.js'), /platform\/canvas\.js/);
  assert.match(read('miniprogram/app.js'), /installHost/);
});

// ── ⑤ 两条皮都消费可交互层，且基线不破 ──────────────────────────────
test('色块页：点格 / 缩放 / 复位都在，仍是零 Canvas 回归基线', () => {
  const js = read('miniprogram/pages/slice/index.js');
  const wxml = read('miniprogram/pages/slice/index.wxml');
  assert.match(js, /miniCamera\(/);
  assert.match(js, /miniHit\(/);
  assert.match(js, /onCellTap\(/);
  assert.match(js, /onZoomIn\(/);
  assert.match(js, /onReset\(/);
  assert.match(wxml, /data-i="\{\{index\}\}"/);
  assert.match(wxml, /bindtap="onCellTap"/);
  for (const bad of ['<canvas', '<image', 'getContext', 'createSelectorQuery', 'drawImage']) {
    assert.ok(!js.includes(bad) && !wxml.includes(bad), `色块页破了零 Canvas 基线：${bad}`);
  }
});

test('画布页：touch 三事件 + 捏合 + 实时 rect 命中，零位图不破', () => {
  const js = read('miniprogram/pages/canvas/index.js');
  const wxml = read('miniprogram/pages/canvas/index.wxml');
  for (const k of ['onTouchStart(', 'onTouchMove(', 'onTouchEnd(', 'pinchRatio(',
    'normalizeTouches(', 'miniResolveHit(', '_rect()', 'this._cam.pan(', 'this._cam.zoom(']) {
    assert.ok(js.includes(k), `画布页缺 ${k}`);
  }
  assert.match(wxml, /bindtouchstart="onTouchStart"/);
  assert.match(wxml, /bindtouchmove="onTouchMove"/);
  assert.match(wxml, /bindtouchend="onTouchEnd"/);
  assert.ok(!/\.(png|jpe?g|webp)\b/i.test(wxml), '画布页引用了位图');
});

test('wxCanvas 返回实时 rect，假 wx 无 left/top 时按 0 兜底', async () => {
  const node = { width: 0, height: 0, getContext: () => ({ fake: true }) };
  const wx = { createSelectorQuery: () => ({
    select: () => ({ fields: () => ({ exec: (cb) =>
      cb([{ node, width: 300, height: 200, left: 20, top: 10, right: 320, bottom: 210 }]) }) }),
  }) };
  const c = await cv.wxCanvas('#mini', wx, { dpr: 2 });
  assert.deepEqual(c.rect, { left: 20, top: 10, right: 320, bottom: 210, width: 300, height: 200 });
  const wx2 = { createSelectorQuery: () => ({
    select: () => ({ fields: () => ({ exec: (cb) => cb([{ node, width: 300, height: 200 }]) }) }),
  }) };
  const c2 = await cv.wxCanvas('#mini', wx2, { dpr: 1 });
  assert.equal(c2.rect.left, 0);
  assert.equal(c2.rect.top, 0);
});

test('镜像一致：MANIFEST 含改过的三个平台文件，--check 绿', () => {
  const mf = JSON.parse(read('miniprogram/logic/MANIFEST.json'));
  for (const f of ['src/platform/mini-map.js', 'src/platform/input.js',
    'src/platform/canvas.js', 'src/platform/index.js']) {
    assert.ok(mf.files.some((x) => x.path === f), `MANIFEST 缺 ${f}`);
  }
  const out = execFileSync(process.execPath,
    [join(root, 'scripts/sync-miniprogram.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /镜像一致/);
});
