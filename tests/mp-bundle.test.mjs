// P4 资源分包核算 + 零位图格网 + B6 存档表示差异的回归。
//
// 关键：格网与存档都从 miniprogram/logic/ **镜像**跑，不是主 src/，
// 这样「搬过去那份真的能用」才被验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import('../miniprogram/utils/slice-core.js');
const mpMini = await import('../miniprogram/logic/src/platform/mini-map.js');
const mpSync = await import('../miniprogram/logic/src/sync.js');
const read = (p) => readFileSync(join(root, p), 'utf8');

function mockStorage() {
  const m = new Map();
  return { name: 'mock', getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const host = (s) => ({ storage: s, now: () => 1760000000000 });
const boot = (seed = 7) => core.bootSlice({ seed, host: host(mockStorage()) });

// ── 零位图格网（程序化回退的数据侧） ────────────────────────────────
test('miniMapCells 是纯函数：同 state 必得同一份色块，不碰宿主', () => {
  const s = boot();
  const a = core.miniMap(s.state), b = core.miniMap(s.state);
  assert.deepEqual(a, b, '格网不确定，端侧重绘会分叉');
  assert.equal(a.cols, 18);
  assert.equal(a.rows, 14);
  assert.equal(a.cells.length, a.cols * a.rows);
  for (const c of a.cells) {
    assert.match(c.color, /^#[0-9a-f]{6}$/i);
    assert.ok(['cao', 'yuan', 'liu', ''].includes(c.owner));
    assert.equal(typeof c.city, 'boolean');
    assert.equal(typeof c.terrain, 'string');
  }
  // 开局必有三方领地与城点，否则格网是空图
  assert.ok(a.cells.some((c) => c.owner === 'cao'));
  assert.ok(a.cells.some((c) => c.owner === 'yuan'));
  assert.ok(a.cells.some((c) => c.city));
});

test('miniMapDrawOps 是纯 JSON 指令：坐标归一 0..1、类型白名单、可跨端传', () => {
  const s = boot();
  const out = core.miniMapOps(s.state);
  assert.equal(out.cols, 18);
  const types = new Set(out.ops.map((o) => o.type));
  assert.ok([...types].every((t) => ['fillRect', 'circle'].includes(t)));
  for (const o of out.ops) {
    for (const k of ['x', 'y']) {
      assert.ok(o[k] >= 0 && o[k] <= 1, `${o.type} 的 ${k} 越界`);
    }
    assert.ok(o.fill.startsWith('#'));
  }
  const json = JSON.stringify(out);
  assert.equal(JSON.parse(json).ops.length, out.ops.length);
  assert.ok(json.length > 1000);
  // 源码层不许出现宿主 API
  const src = read('src/platform/mini-map.js');
  for (const bad of ['document.', 'window.', 'wx.', 'getContext', 'new Image', 'Math.random', 'Date.now']) {
    assert.ok(!src.includes(bad), `绘制指令层出现 ${bad}`);
  }
});

test('推旬后格网随战线变化：领地色块不是死的静态图', () => {
  const s = boot(99);
  const before = core.miniMap(s.state);
  for (let i = 0; i < 40; i++) core.pushTurn(s);
  const after = core.miniMap(s.state);
  assert.equal(after.cells.length, before.cells.length);
  // 40 旬内 AI 会占地，至少应有格子的 owner 或地貌着色变化
  assert.ok(after.cells.some((c, i) => c.owner !== before.cells[i].owner || c.color !== before.cells[i].color),
    '推了 40 旬格网纹丝不动，数据没接上 state');
});

test('切片页用 WXML 色块消费格网：零 PNG、零 canvas、零宿主渲染 API', () => {
  const wxml = read('miniprogram/pages/slice/index.wxml');
  const js = read('miniprogram/pages/slice/index.js');
  assert.match(wxml, /wx:for="\{\{mini\.cells\}\}"/);
  assert.match(js, /_refreshMini\(\)/);
  assert.equal((js.match(/this\._refreshMini\(\);/g) ?? []).length >= 4, true);
  for (const bad of ['<canvas', '<image', 'getContext', 'createSelectorQuery', 'drawImage']) {
    assert.ok(!wxml.includes(bad) && !js.includes(bad), `切片页出现 ${bad}`);
  }
  assert.ok(!/\.(png|jpe?g|webp)\b/i.test(wxml), '切片页引用了位图文件');
});

// ── 包体核算（P4 的硬结论） ─────────────────────────────────────────
test('check-mp-bundle.mjs --check 绿：首包零位图、底稿不入包、舆图无位图引用', () => {
  const out = execFileSync(process.execPath,
    [join(root, 'scripts/check-mp-bundle.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /包体核算通过/);
  assert.match(out, /0 位图/);
});

test('运行时只加载 4 张 sheet，且 3 张各自超微信单个分包 2 MB', () => {
  const portrait = read('src/portrait.js');
  const sheets = [...portrait.matchAll(/load\('([^']+\.png)',\s*'([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(sheets.length, 4);
  const LIMIT = 2 * 1024 * 1024;
  const over = sheets.filter((f) => {
    const p = join(root, 'assets/units', f);
    return existsSync(p) && statSync(p).size > LIMIT;
  });
  assert.equal(over.length, 3, `超包张数变了：${over.join(',')}`);
  assert.ok(sheets.some((f) => f.includes('tiny')));
  // 「按章分包两张舆图」的前提不成立：舆图是程序化代码，无位图文件引用
  const atlas = read('src/guandu.js') + read('src/atlas.js');
  assert.equal((atlas.match(/\.(png|jpe?g|webp)\b/gi) ?? []).length, 0);
});

test('miniprogram/ 首包内任何一个文件都不是位图', () => {
  const walk = (d) => {
    const out = [];
    for (const n of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = `${d}/${n.name}`;
      if (n.isDirectory()) {
        if (p === 'miniprogram/assets') continue;   // subpackages 产物，不计主包
        out.push(...walk(p));
      } else out.push(p);
    }
    return out;
  };
  const files = walk('miniprogram');
  assert.ok(files.length >= 40);
  assert.equal(files.filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)).length, 0);
  // 本地 build 过分包产物时，每组必须 ≤ 2 MB（微信单个分包上限）
  const a = join(root, 'miniprogram/assets');
  if (existsSync(a)) {
    for (const n of readdirSync(a, { withFileTypes: true })) {
      if (!n.isDirectory()) continue;
      const g = walk(`miniprogram/assets/${n.name}`);
      const bytes = g.reduce((sum, f) => sum + statSync(join(root, f)).size, 0);
      assert.ok(bytes <= 2 * 1024 * 1024, `分包 ${n.name} ${bytes} B 超 2 MB`);
    }
  }
});

// ── B6：存档规范化的两处「表示差异」，不是分叉 ───────────────────────
test('B6 已定位、不改核心：undefined↔{} / undefined↔\'\' 不改变状态指纹与判定', () => {
  const s = boot(31);
  for (let i = 0; i < 6; i++) core.pushTurn(s);
  const h0 = mpSync.hashState(s.state);
  const snap = core.hideSlice(s);
  const back = core.showSlice({ storage: mockStorage(), raw: snap.raw,
    expectHash: h0, host: host(mockStorage()) });
  assert.equal(back.ok, true);
  assert.equal(back.consistent, true, '存档往返后状态指纹分叉');
  assert.equal(mpSync.hashState(back.state), h0);
  // 两处表示差异确实存在，但都 falsy、不进判定；对面 logic-slice.mjs 亦按
  // 「比对存档 JSON（平台真正传递的形态）」抹平，故无需动 campaign.js / persist.js。
  const a = s.state, b = back.state;
  const undefToEmpty = (a.chapterEnteredTurn === undefined && b.chapterEnteredTurn !== undefined)
    || (b.chapterEnteredTurn === undefined && a.chapterEnteredTurn !== undefined)
    || (a.chapterEnteredTurn === undefined && b.chapterEnteredTurn && Object.keys(b.chapterEnteredTurn).length === 0);
  assert.ok(undefToEmpty || JSON.stringify(a.chapterEnteredTurn ?? {}) === JSON.stringify(b.chapterEnteredTurn ?? {}),
    'chapterEnteredTurn 表示差异没被规范化成等价形态');
  // 继续推旬，rng 序列不分叉
  const after = core.pushTurn({ state: back.state, rng: back.rng, cfg: back.cfg });
  assert.equal(after.turn, 7);
});
