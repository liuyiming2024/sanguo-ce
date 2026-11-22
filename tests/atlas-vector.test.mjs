// 典籍页矢量即时层（src/atlas.js）的纯 Node 覆盖。
// Node 没有 Path2D，这里给一个最小 stub：只要能存路径字符串、能被 fill/stroke
// 接住即可。测的是「录制 → 网格索引 → 视口裁剪 → 重放」这条链确定、不抛错，
// 不测浏览器像素（那由 Chromium 烟测负责）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createAtlas } from '../src/atlas.js';

const orig = globalThis.Path2D;
globalThis.Path2D = class Path2DStub {
  constructor(d) { this.d = String(d); }
};
// 文件级临时挂上，跑完用 after 钩子还原，不污染同进程里别的测试文件。
after(() => { globalThis.Path2D = orig; });

/** 记录一切绘制指令的假 ctx：任何未定义方法都当成一次绘制调用。 */
function fakeCtx(log) {
  const t = {};
  return new Proxy(t, {
    get(o, k) {
      if (k === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getLineDash') return () => [];
      if (k in o) return o[k];
      return (...args) => { log.push([k, ...args.map((x) => (x && typeof x === 'object' ? '[obj]' : x))]); };
    },
    set(o, k, v) {
      log.push(['set:' + String(k), v && typeof v === 'object' ? '[obj]' : v]);
      o[k] = v; return true;
    },
  });
}
const mkCanvas = (log) => () => ({ width: 0, height: 0, getContext: () => fakeCtx(log) });
const make = (opts = {}) => createAtlas({ createCanvas: mkCanvas([]), ...opts });

const FULL = { eff: 1, vx0: 0, vx1: 1400, vy0: 0, vy1: 1100, showFeatures: true };
const CLOSE = { eff: 4, vx0: 620, vx1: 780, vy0: 470, vy1: 630, showFeatures: true };

// 五个用例共享一份主实例（每次 createAtlas 要录 5.5 万笔，重复建会拖慢 CI）；
// 只有「确定性对比」与「fg=false」各需要再建一份。
const A = make();
A.setVectorTier(3); A.applyVectorTier();

test('矢量层可录制：hasVector / 档位封顶 / 首次重录 / 重放不抛错', () => {
  assert.equal(A.hasVector, true, '给了 Path2D stub 就该走矢量层');
  assert.equal(typeof A.drawVector, 'function');
  assert.equal(A.setVectorTier(9), 3, '超过 3 仍封顶，避免 28 万条 Path2D');
  assert.equal(A.applyVectorTier(), false, '同档同分图不该重复重录');
  const out = [];
  const shown = A.drawVector(fakeCtx(out), FULL);
  assert.ok(shown > 1000, `全幅只重放 ${shown} 笔，疑似没录全`);
  assert.ok(out.some((r) => r[0] === 'fill' || r[0] === 'stroke'), '没有实际绘制指令');
  assert.ok(out.some((r) => r[0] === 'fillText' || r[0] === 'strokeText'), '题识文字没重放');
});

test('视口裁剪真的生效：局部放大时重放笔数显著少于全幅', () => {
  const full = A.drawVector(fakeCtx([]), FULL);
  const close = A.drawVector(fakeCtx([]), CLOSE);
  assert.ok(close > 0, '局部视口不该一笔不画');
  assert.ok(close < full * 0.35, `局部 ${close} 笔 / 全幅 ${full} 笔，网格索引没起作用`);
});

test('同 seed 同参数：矢量重放逐指令一致（确定性，不进随机源）', () => {
  const run = () => {
    const a = make();
    a.setVectorTier(2); a.applyVectorTier();
    const out = [];
    const n = a.drawVector(fakeCtx(out), FULL);
    return { n, text: JSON.stringify(out) };
  };
  const x = run(), y = run();
  assert.equal(x.n, y.n);
  assert.equal(x.text, y.text);
});

test('切分图后矢量层重录，切回全境逐笔回到原状', () => {
  const before = A.drawVector(fakeCtx([]), FULL);
  A.setFocus('hebei');
  assert.equal(A.applyVectorTier(), true, '换分图必须重录');
  const after = A.drawVector(fakeCtx([]), FULL);
  assert.notEqual(before, after, '河北详图专属地物没进矢量层');
  A.setFocus('all');
  assert.equal(A.applyVectorTier(), true);
  assert.equal(A.drawVector(fakeCtx([]), FULL), before, '切回全境应逐笔回到原状');
});

test('默认位图接口未被矢量层破坏（bg/fg 仍返回，fg=false 仍生效）', () => {
  assert.ok(A.bg && A.fg, 'bg / fg 两层都要返回');
  const bgOnly = make({ fg: false });
  assert.equal(bgOnly.fg, null);
  assert.ok(bgOnly.bg);
});
