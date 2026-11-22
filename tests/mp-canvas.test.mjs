// 画布链路 + 分包方案回归。
//
// 关键：applyDrawOps / wxCanvas / hostDpr 都从 **miniprogram/logic/ 镜像** import，
// 不是主 src/ ——「搬过去那份真能用」才被验证。ctx 是记录型假对象，
// 所以整条「归一化指令 → 2d 调用序列」在纯 Node 里可逐条断言，不依赖真机。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import('../miniprogram/utils/slice-core.js');
const canvas = await import('../miniprogram/logic/src/platform/canvas.js');
const read = (p) => readFileSync(join(root, p), 'utf8');

function mockStorage() {
  const m = new Map();
  return { name: 'mock', getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const boot = (seed = 7) => core.bootSlice({ seed, host: { storage: mockStorage(), now: () => 1760000000000 } });

function mockCtx() {
  const calls = [];
  return {
    fillStyle: '',
    calls,
    clearRect: (...a) => calls.push({ op: 'clearRect', args: a }),
    fillRect: (...a) => calls.push({ op: 'fillRect', args: a, fill: this?.fillStyle }),
    beginPath: () => calls.push({ op: 'beginPath' }),
    arc: (...a) => calls.push({ op: 'arc', args: a, fill: this?.fillStyle }),
    fill: () => calls.push({ op: 'fill' }),
  };
}

// 上面的 this 在箭头函数里拿不到实例，改成显式闭包版，记录 fill 才准。
function recorder() {
  const calls = [];
  const c = {
    fillStyle: '',
    calls,
    clearRect: (...a) => calls.push({ op: 'clearRect', args: a }),
    fillRect: (...a) => calls.push({ op: 'fillRect', args: a, fill: c.fillStyle }),
    beginPath: () => calls.push({ op: 'beginPath' }),
    arc: (...a) => calls.push({ op: 'arc', args: a, fill: c.fillStyle }),
    fill: () => calls.push({ op: 'fill' }),
  };
  return c;
}

// ── 指令消费层 ────────────────────────────────────────────────────
test('applyDrawOps：fillRect / circle 指令数、坐标缩放、颜色全部对得上', () => {
  const s = boot();
  const out = core.miniMapOps(s.state);
  const rects = out.ops.filter((o) => o.type === 'fillRect');
  const circles = out.ops.filter((o) => o.type === 'circle');
  const ctx = recorder();
  const n = canvas.applyDrawOps(ctx, out.ops, 360, 280, { dpr: 1 });
  assert.equal(n, out.ops.length);
  assert.equal(ctx.calls[0].op, 'clearRect');
  assert.deepEqual(ctx.calls[0].args, [0, 0, 360, 280]);
  assert.equal(ctx.calls.filter((c) => c.op === 'fillRect').length, rects.length);
  assert.equal(ctx.calls.filter((c) => c.op === 'arc').length, circles.length);
  // 每条 fillRect 的 x/y/w/h 都落在画布内，且等于归一化值 × 宽高
  const drawn = ctx.calls.filter((c) => c.op === 'fillRect');
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i], c = drawn[i];
    assert.ok(Math.abs(c.args[0] - r.x * 360) < 1e-9);
    assert.ok(Math.abs(c.args[1] - r.y * 280) < 1e-9);
    assert.ok(Math.abs(c.args[2] - r.w * 360) < 1e-9);
    assert.ok(Math.abs(c.args[3] - r.h * 280) < 1e-9);
    assert.equal(c.fill, r.fill, '颜色没从指令带到 ctx');
    assert.ok(c.args[0] >= 0 && c.args[0] + c.args[2] <= 360 + 1e-9);
    assert.ok(c.args[1] >= 0 && c.args[1] + c.args[3] <= 280 + 1e-9);
  }
});

test('applyDrawOps 是纯函数：同 state 两次调用序列逐字一致；dpr 只翻倍不改结构', () => {
  const s = boot(31);
  const out = core.miniMapOps(s.state);
  const a = recorder(), b = recorder(), c2 = recorder();
  canvas.applyDrawOps(a, out.ops, 300, 200, { dpr: 1 });
  canvas.applyDrawOps(b, out.ops, 300, 200, { dpr: 1 });
  canvas.applyDrawOps(c2, out.ops, 300, 200, { dpr: 2 });
  assert.deepEqual(a.calls, b.calls, '画布重绘分叉');
  const ra = a.calls.find((x) => x.op === 'fillRect');
  const rc = c2.calls.find((x) => x.op === 'fillRect');
  assert.ok(Math.abs(rc.args[0] - 2 * ra.args[0]) < 1e-9);
  assert.ok(Math.abs(rc.args[2] - 2 * ra.args[2]) < 1e-9);
  assert.deepEqual(c2.calls[0].args, [0, 0, 600, 400]);
  assert.equal(a.calls.length, c2.calls.length);
});

test('applyDrawOps 边界：clear=false、未知 type、非法宽高、空 ctx 都不抛异常', () => {
  const ctx = recorder();
  assert.equal(canvas.applyDrawOps(ctx, [{ type: 'fillRect', x: 0, y: 0, w: 1, h: 1, fill: '#000000' }],
    100, 100, { clear: false }), 1);
  assert.equal(ctx.calls[0].op, 'fillRect');
  assert.equal(canvas.applyDrawOps(recorder(), [{ type: 'unknown' }], 100, 100), 0);
  assert.equal(canvas.applyDrawOps(recorder(), [], 0, 100), 0);
  assert.equal(canvas.applyDrawOps(null, [], 100, 100), 0);
  assert.equal(canvas.applyDrawOps(recorder(), null, 100, 100), 0);
});

test('hostDpr：新 API 优先、旧 API 回落、异常兜底 2', () => {
  assert.equal(canvas.hostDpr({ getWindowInfo: () => ({ pixelRatio: 3 }) }), 3);
  assert.equal(canvas.hostDpr({ getSystemInfoSync: () => ({ pixelRatio: 1.5 }) }), 1.5);
  assert.equal(canvas.hostDpr({ getWindowInfo: () => ({}) }), 2);
  assert.equal(canvas.hostDpr({ getWindowInfo: () => { throw new Error('x'); } }), 2);
  assert.equal(canvas.hostDpr(null), 2);
});

test('applyDrawOps 源码段不碰任何宿主 API（皮重写只重写皮）', () => {
  const src = read('src/platform/canvas.js');
  const i = src.indexOf('export function applyDrawOps');
  const j = src.indexOf('/** 取宿主像素比', i);
  assert.ok(i > 0 && j > i);
  const body = src.slice(i, j);
  for (const bad of ['document.', 'window.', 'wx.', 'Path2D', 'new Image', 'Date.now', 'Math.random']) {
    assert.ok(!body.includes(bad), `applyDrawOps 出现 ${bad}`);
  }
  assert.match(body, /export function applyDrawOps/);
});

test('wxCanvas 契约：给假 wx 能拿到 node/ctx/尺寸并按 dpr 缩放', async () => {
  const node = { width: 0, height: 0, getContext: () => ({ fake: true }) };
  const wx = { createSelectorQuery: () => ({
    select: () => ({ fields: () => ({ exec: (cb) => cb([{ node, width: 300, height: 200 }]) }) }),
  }) };
  const c = await canvas.wxCanvas('#mini', wx, { dpr: 2 });
  assert.equal(c.width, 300);
  assert.equal(c.height, 200);
  assert.equal(c.dpr, 2);
  assert.equal(node.width, 600);
  assert.equal(node.height, 400);
  assert.equal(c.ctx.fake, true);
  // 节点不存在时 resolve(null)，由页面降级，不 reject 崩掉
  const wx2 = { createSelectorQuery: () => ({
    select: () => ({ fields: () => ({ exec: (cb) => cb([null]) }) }),
  }) };
  assert.equal(await canvas.wxCanvas('#mini', wx2), null);
});

// ── 画布页与回归基线 ──────────────────────────────────────────────
test('画布页真消费镜像：wxCanvas + applyDrawOps + miniMapOps + DPR + 降级', () => {
  const js = read('miniprogram/pages/canvas/index.js');
  const wxml = read('miniprogram/pages/canvas/index.wxml');
  assert.match(js, /from '\.\.\/\.\.\/logic\/src\/platform\/canvas\.js'/);
  assert.match(js, /wxCanvas\('#mini', wx/);
  assert.match(js, /applyDrawOps\(/);
  assert.match(js, /hostDpr\(/);
  assert.match(js, /miniMapOps\(/);
  assert.match(js, /onReady\(\)/, '小程序 canvas 节点必须等 onReady');
  assert.match(js, /_fail\(/, '拿不到节点必须有降级，不能白屏');
  assert.match(wxml, /<canvas type="2d" id="mini"/);
  assert.ok(!/\.(png|jpe?g|webp)\b/i.test(wxml), '画布页不该引用位图文件');
  assert.match(wxml, /onPush|onRedraw|onSlice/);
});

test('切片页仍是零 Canvas 回归基线，三页都注册，首页两个入口都在', () => {
  const sliceWxml = read('miniprogram/pages/slice/index.wxml');
  const sliceJs = read('miniprogram/pages/slice/index.js');
  for (const bad of ['<canvas', '<image', 'getContext', 'createSelectorQuery']) {
    assert.ok(!sliceWxml.includes(bad) && !sliceJs.includes(bad), `切片页破了零 Canvas 基线：${bad}`);
  }
  const app = JSON.parse(read('miniprogram/app.json'));
  assert.deepEqual(app.pages, ['pages/index/index', 'pages/slice/index', 'pages/canvas/index']);
  const home = read('miniprogram/pages/index/index.js');
  assert.match(home, /onSlice\(\)/);
  assert.match(home, /onCanvas\(\)/);
  assert.match(read('miniprogram/pages/index/index.wxml'), /打开「画布格网」/);
});

// ── 分包方案 ──────────────────────────────────────────────────────
test('mp-assets.mjs --check 绿：压缩后两组各 ≤ 2 MB、主包 ≤ 2 MB、总 ≤ 20 MB', () => {
  const out = execFileSync(process.execPath,
    [join(root, 'scripts/mp-assets.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /分包方案一致/);
  const plan = JSON.parse(read('miniprogram/assets-plan.json'));
  assert.equal(plan.sheets.length, 4);
  assert.equal(plan.subpackages.length, 2);
  for (const g of plan.subpackages) {
    assert.ok(g.bytes <= plan.thresholds.wxSub, `${g.root} 超单个分包 2 MB`);
    assert.ok(g.files.length > 0);
    assert.ok(g.files.every((f) => f.endsWith('.webp')), '分包里混进了 PNG');
  }
  assert.ok(plan.totalWebpBytes < 3 * 1024 * 1024, '压缩后总量不该还接近 13 MiB');
  assert.ok(plan.mainPackageBytes + plan.totalWebpBytes <= plan.thresholds.wxTotal);
  // plan 里的 PNG 字节必须与磁盘一致（防素材换了方案没更新）
  for (const s of plan.sheets) {
    assert.equal(statSync(join(root, 'assets/units', s.file)).size, s.pngBytes);
  }
});

test('app.subpackages.example.json 是待启用模板，app.json 本身仍未启用分包', () => {
  const ex = JSON.parse(read('miniprogram/app.subpackages.example.json'));
  assert.equal(ex.subpackages.length, 2);
  assert.equal(ex.subpackages[0].root, 'assets/units-infantry');
  assert.equal(ex.subpackages[1].root, 'assets/units-engine');
  const app = JSON.parse(read('miniprogram/app.json'));
  assert.equal(app.subpackages, undefined,
    '真分包需在真机跑 assets:build 后手动启用，不能现在就声明空分包');
  const gi = read('.gitignore');
  assert.match(gi, /miniprogram\/assets\//);
});

test('canvas.js 已同步进镜像：MANIFEST 的 hash 与源文件一致', () => {
  const mf = JSON.parse(read('miniprogram/logic/MANIFEST.json'));
  assert.ok(mf.files.some((f) => f.path === 'src/platform/canvas.js'));
  assert.ok(mf.files.some((f) => f.path === 'src/platform/mini-map.js'));
  const out = execFileSync(process.execPath,
    [join(root, 'scripts/sync-miniprogram.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /镜像一致/);
});
