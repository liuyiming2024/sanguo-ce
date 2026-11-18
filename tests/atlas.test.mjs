// 对面的全境舆图生成方式已抽成 src/atlas.js。本测用假 canvas 在纯 Node 下
// 把整套笔法完整跑一遍：证明它不依赖 DOM、不引用被删的 demos 交互变量、
// 同参数逐指令一致、图幅参数确实生效。浏览器 CDN 403 时装不上 Chromium，
// 这条是本地能拿到的最硬证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAtlas } from '../src/atlas.js';

const simp = (v) => {
  if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length <= 8 ? v.map(simp) : `[arr ${v.length}]`;
  if (v && typeof v === 'object') {
    if ('width' in v && 'height' in v) return `<canvas ${v.width}x${v.height}>`;
    if ('data' in v) return `<image ${v.width}x${v.height}>`;
    return '<obj>';
  }
  return `<${typeof v}>`;
};

function stubCanvas(log) {
  const c = { width: 0, height: 0 };
  const store = {};
  const grad = { addColorStop() {} };
  const base = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    measureText: (s) => ({ width: String(s).length * 10 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (k in t) {
        const v = t[k];
        if (typeof v === 'function') {
          return (...a) => { log.push([String(k), ...a.map(simp)]); return v(...a); };
        }
        return v;
      }
      if (k in store) return store[k];
      return (...a) => { log.push([String(k), ...a.map(simp)]); };
    },
    set(t, k, v) {
      store[k] = v;
      log.push(['=', String(k), simp(v)]);
      return true;
    },
  });
  c.getContext = () => ctx;
  return c;
}

const run = (opts) => {
  const log = [];
  const a = createAtlas({ ...opts, createCanvas: () => stubCanvas(log) });
  return { a, log, hash: createHash('sha256').update(JSON.stringify(log)).digest('hex') };
};

test('全份 bg+fg：整套笔法在纯 Node 下完整跑通，不抛异常', () => {
  const { a, log } = run({});
  assert.ok(a.bg && a.fg, 'bg / fg 两层都要返回');
  assert.equal(a.W, 1400);
  assert.equal(a.H, 1100);
  assert.ok(log.length > 5000, `绘制指令只有 ${log.length} 条，疑似 makeBg/makeFg 没跑完`);
  // 关键笔法原语都真的被调用了
  for (const k of ['beginPath', 'moveTo', 'lineTo', 'fill', 'stroke', 'save', 'restore',
    'translate', 'fillText', 'createImageData', 'putImageData', 'drawImage', 'setLineDash']) {
    assert.ok(log.some((r) => r[0] === k), `缺笔法调用 ${k}`);
  }
});

test('同 seed 同参数逐指令一致（确定性，无墙钟无随机）', () => {
  const x = run({}), y = run({});
  assert.equal(x.hash, y.hash);
  assert.equal(x.log.length, y.log.length);
});

test('不同图幅 / 不同 seed 会真的改变绘制，不是写死 1400×1100', () => {
  const all = run({});
  const war = run({ LON0: 112.75, LON1: 116.15, LAT0: 32.65, LAT1: 36.65 });
  const other = run({ seed: 202006 });
  assert.notEqual(all.hash, war.hash, '图幅参数没生效');
  assert.notEqual(all.hash, other.hash, 'seed 参数没生效');
  assert.notEqual(war.a.lon2x(114), all.a.lon2x(114), '投影函数没跟参数走');
});

test('战区只要背景层：fg=false 时不生成地物层，指令量明显更少', () => {
  const full = run({});
  const bgOnly = run({ fg: false, LON0: 112.75, LON1: 116.15, LAT0: 32.65, LAT1: 36.65 });
  assert.equal(bgOnly.a.fg, null);
  assert.ok(bgOnly.a.bg, '背景层仍要生成');
  const fgOnly = run({ LON0: 112.75, LON1: 116.15, LAT0: 32.65, LAT1: 36.65 });
  assert.ok(bgOnly.log.length < fgOnly.log.length, 'fg=false 应跳过 makeFg');
  // 战区贴 bg 不能把十三州主景 / 长城三重一并画进来
  assert.ok(!bgOnly.log.some((r) => r[0] === 'fillText' &&
    /居延|玉门|日南|乐浪/.test(String(r[1] ?? ''))), '战区背景不该出现全境主景题识');
});
