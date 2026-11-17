import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { DIR8, DIR8_LABEL, normAngle, dirIndex, headingFromDelta,
  frameName, frameLabel, indexOfFrame, sectorCenters } from '../src/direction.js';

test('八向表与素材 manifest 严格一致', () => {
  const m = JSON.parse(readFileSync(new URL('../assets/units/trooper.json', import.meta.url), 'utf8'));
  assert.equal(m.frames.length, 8);
  assert.equal(m.canvas[0], 560);
  assert.equal(m.footY, 780);
  m.frames.forEach((f, i) => {
    assert.equal(f.index, i);
    assert.equal(f.name, DIR8[i]);
    assert.equal(f.angle, i * 45);
    assert.ok(existsSync(new URL(`../assets/units/${f.file}`, import.meta.url)),
      `缺素材 ${f.file}`);
  });
  assert.equal(DIR8_LABEL.length, 8);
  assert.equal(new Set(DIR8).size, 8);
});

test('八张素材都是真 PNG、尺寸一致、带 alpha 通道', () => {
  for (const n of DIR8) {
    const p = new URL(`../assets/units/trooper-${n}.png`, import.meta.url);
    assert.ok(existsSync(p) && statSync(p).size > 100_000, `${n} 太小或不存在`);
    const b = readFileSync(p);
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    assert.equal(b[25], 6, `${n} 不是 RGBA`);   // color type 6 = RGBA
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    assert.equal(w, 560); assert.equal(h, 820);
  }
  const sheet = new URL('../assets/units/trooper-sheet.png', import.meta.url);
  assert.ok(existsSync(sheet));
});

test('角度规整：负数 / 超圈 / NaN / Infinity 都确定性', () => {
  assert.equal(normAngle(0), 0);
  assert.ok(Math.abs(normAngle(-Math.PI / 4) - Math.PI * 7 / 4) < 1e-12);
  assert.ok(Math.abs(normAngle(Math.PI * 2 + 0.5) - 0.5) < 1e-12);
  assert.equal(normAngle(NaN), 0);
  assert.equal(normAngle(Infinity), 0);
  assert.equal(normAngle(-Infinity), 0);
});

test('八个中心角各自落在自己的帧，扇区无重叠无空洞', () => {
  sectorCenters().forEach((a, i) => assert.equal(dirIndex(a), i));
  // 每个扇区内采样 9 点都归同一帧，边界确定性归入后一扇区
  for (let i = 0; i < 8; i++) {
    const c = i * Math.PI / 4;
    for (let k = -3; k <= 3; k++) {
      assert.equal(dirIndex(c + k * Math.PI / 32), i);
    }
  }
  assert.equal(dirIndex(Math.PI / 8), 1);   // 正好在边界 → 后一扇区
  // 最近邻量化下 360°-ε 与 0° 是同一朝向，都归正面帧（不会跳到 315°）
  assert.equal(dirIndex(Math.PI * 2 - 1e-9), 0);
  assert.equal(dirIndex(Math.PI * 2), 0);
});

test('位移向量 → 朝向：朝下为正面，顺时针递增；零向量用 fallback', () => {
  assert.equal(dirIndex(headingFromDelta(0, 10)), 0);
  assert.equal(dirIndex(headingFromDelta(10, 0)), 2);
  assert.equal(dirIndex(headingFromDelta(0, -10)), 4);
  assert.equal(dirIndex(headingFromDelta(-10, 0)), 6);
  assert.equal(dirIndex(headingFromDelta(10, 10)), 1);
  assert.equal(dirIndex(headingFromDelta(0, 0, Math.PI)), 4);
  assert.equal(dirIndex(headingFromDelta(NaN, 3, 0)), 0);
});

test('帧名 / 标签 / 反查一致', () => {
  assert.equal(frameName(0), 'd0_front');
  assert.equal(frameName(Math.PI), 'd4_back');
  assert.equal(frameLabel(Math.PI / 2), '正右 90°');
  assert.equal(indexOfFrame('d7_front_left'), 7);
  assert.equal(indexOfFrame('不存在'), -1);
});

test('渲染层是可选皮肤：不进状态、无墙钟、无随机、保留程序化回退', () => {
  const p = readFileSync(new URL('../src/portrait.js', import.meta.url), 'utf8');
  const cv = readFileSync(new URL('../src/city-view.js', import.meta.url), 'utf8');
  const pers = readFileSync(new URL('../src/persist.js', import.meta.url), 'utf8');
  const sync = readFileSync(new URL('../src/sync.js', import.meta.url), 'utf8');
  const body = p.replace(/^\/\/[\s\S]*?\*\//, '');   // 去掉文件头注释再查
  assert.ok(!/Date\.|performance\.|Math\.random|setTimeout\(|setInterval\(/.test(body),
    '位图层不能引入墙钟或随机源');
  assert.ok(!/portrait/i.test(pers) && !/portrait/i.test(sync),
    '加载状态污染了存档或状态指纹');
  assert.ok(/portraits\.ready && portraits\.draw/.test(cv) &&
    /drawSoldier\(ctx, u, \{/.test(cv), '素材未就绪必须回退程序化路径');
  assert.ok(/unitKind\(u\.type\) !== 'engine'/.test(cv),
    '器械必须保留程序化俯视木架，不能套人形位图');
  assert.ok(/lastHeading/.test(cv) && /heading: rp\.heading/.test(cv),
    '朝向必须逐帧传给渲染层，不能只靠 dir 镜像');
});
