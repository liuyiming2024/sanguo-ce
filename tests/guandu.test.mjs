// 对面两版舆图生成方式都已接进 src/。浏览器 CDN 403 装不上 Chromium 时，
// 用假 canvas 在纯 Node 下把整套笔法跑完，验证：不依赖 DOM、确定性、
// 裁切矩形与游戏逻辑格精确对齐、三级注记可调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderGuanduLayers } from '../src/guandu.js';
import { createAtlas } from '../src/atlas.js';
import { LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, project } from '../src/map-data.js';

// 浏览器全局 Path2D 的极简替身：只承接路径构造，不做几何运算。
globalThis.Path2D = class {
  moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {}
  closePath() {} arc() {} rect() {} ellipse() {} addPath() {}
};

const simp = (v) => {
  if (v == null || ['number', 'string', 'boolean'].includes(typeof v)) return v;
  if (Array.isArray(v)) return v.length <= 8 ? v.map(simp) : `[arr ${v.length}]`;
  if (v && typeof v === 'object') {
    if ('width' in v && 'height' in v) return `<canvas ${v.width}x${v.height}>`;
    if ('data' in v) return `<image ${v.width}x${v.height}>`;
    if (typeof v.moveTo === 'function') return '<path>';
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
    measureText: (s) => ({ width: String(s).length * 10 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (k in t) {
        const v = t[k];
        if (typeof v === 'function') return (...a) => { log.push([String(k), ...a.map(simp)]); return v(...a); };
        return v;
      }
      if (k in store) return store[k];
      return (...a) => { log.push([String(k), ...a.map(simp)]); };
    },
    set(t, k, v) { store[k] = v; log.push(['=', String(k), simp(v)]); return true; },
  });
  c.getContext = () => ctx;
  return c;
}
const hash = (log) => createHash('sha256').update(JSON.stringify(log)).digest('hex');
const runGuandu = (opts = {}) => {
  const log = [];
  const a = renderGuanduLayers({ ...opts, createCanvas: () => stubCanvas(log) });
  return { a, log, h: hash(log) };
};
const runAtlas = (opts = {}) => {
  const log = [];
  const a = createAtlas({ ...opts, createCanvas: () => stubCanvas(log) });
  return { a, log, h: hash(log) };
};

test('官渡舆图 bg + feat 两层在纯 Node 下整套跑通', () => {
  const { a, log } = runGuandu();
  assert.ok(a.bg && a.feat, 'bg / feat 都要返回');
  assert.equal(a.bg.width, 1200 * a.SS);
  assert.equal(a.bg.height, 880 * a.SS);
  assert.ok(log.length > 20000, `绘制指令只有 ${log.length} 条，背景/地物层疑似没跑完`);
  for (const k of ['createImageData', 'putImageData', 'drawImage', 'fill', 'stroke',
    'fillText', 'strokeText', 'setTransform', 'save', 'restore', 'fillRect']) {
    assert.ok(log.some((r) => r[0] === k), `缺笔法调用 ${k}`);
  }
});

test('裁切矩形按经纬度反算，与游戏逻辑格精确对齐', () => {
  const { a } = runGuandu();
  const { sx, sy, sw, sh } = a.crop;
  assert.ok(sx > 0 && sy > 0 && sw > 0 && sh > 0);
  assert.ok(sx + sw <= a.bg.width + 0.01 && sy + sh <= a.bg.height + 0.01,
    '裁切窗口不能越出对面原图');
  // 四个角点：游戏 project() 的 (0,0)/(W,H) 必须落在裁切窗的两端
  const p0 = project(LON_MIN, LAT_MAX, 1000, 1000);
  const p1 = project(LON_MAX, LAT_MIN, 1000, 1000);
  assert.equal(p0.x, 0); assert.equal(p0.y, 0);
  assert.equal(p1.x, 1000); assert.equal(p1.y, 1000);
  // 官渡口 114.00,34.55 在对面图与游戏图里应落在同一相对位置
  const rel = (lon, lat) => {
    const px = a.PAD + (lon - 112.30) / (116.75 - 112.30) * (a.W - 2 * a.PAD);
    const py = a.PAD + (1 - (lat - 32.30) / (36.95 - 32.30)) * (a.H - 2 * a.PAD);
    return [(px * a.SS - sx) / sw, (py * a.SS - sy) / sh];
  };
  const [rx, ry] = rel(114.00, 34.55);
  const g = project(114.00, 34.55, 1, 1);
  assert.ok(Math.abs(rx - g.x) < 1e-9 && Math.abs(ry - g.y) < 1e-9,
    `官渡口相对位置不一致：对面 ${rx},${ry} vs 逻辑格 ${g.x},${g.y}`);
});

test('官渡内核确定性：同 seed 两次逐指令一致，换 seed 即变', () => {
  const x = runGuandu(), y = runGuandu(), z = runGuandu({ seed: 20261117 });
  assert.equal(x.h, y.h);
  assert.notEqual(x.h, z.h);
});

test('全境最新一版：三级注记分级可用，labels 随 makeFg 收集', () => {
  const { a, log } = runAtlas();
  assert.ok(a.bg && a.fg && typeof a.drawLabels === 'function');
  assert.ok(a.labels.length > 20, `注记只收集到 ${a.labels.length} 条`);
  assert.ok(a.labels.some((L) => L.kind === 'seal'), '缺一级朱题');
  assert.ok(a.labels.some((L) => L.level >= 3), '缺三级县邑注记');
  const dlog = [];
  const dctx = stubCanvas(dlog).getContext('2d');
  assert.doesNotThrow(() => a.drawLabels(dctx, { zoom: 1, panX: 0, panY: 0, detail: false }));
  assert.ok(dlog.some((r) => r[0] === 'fillText'), 'drawLabels 没有真的落字');
  const l1 = dlog.filter((r) => r[0] === 'fillText').length;
  dlog.length = 0;
  a.drawLabels(dctx, { zoom: 2.2, panX: 0, panY: 0, detail: true });
  const l3 = dlog.filter((r) => r[0] === 'fillText').length;
  assert.ok(l3 > l1, `三级 LOD 没生效：L1 ${l1} 字 / L3 ${l3} 字`);
});

test('全境内核同参数逐指令一致，fg=false 时跳过地物层', () => {
  const x = runAtlas(), y = runAtlas(), z = runAtlas({ fg: false, seed: 202006 });
  assert.equal(x.h, y.h);
  assert.equal(z.a.fg, null);
  assert.ok(z.log.length < x.log.length);
});
