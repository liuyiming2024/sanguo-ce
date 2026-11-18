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
  assert.deepEqual(m.phases, ['idle', 'stepL', 'stepR'], '走路需要三相位帧');
  assert.equal(m.sheets.walk, 'trooper-walk-sheet.png');
  m.frames.forEach((f, i) => {
    assert.equal(f.index, i);
    assert.equal(f.name, DIR8[i]);
    assert.equal(f.angle, i * 45);
    for (const n of [f.file, f.walkL, f.walkR]) {
      assert.ok(existsSync(new URL(`../assets/units/${n}`, import.meta.url)), `缺素材 ${n}`);
    }
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
  assert.ok(/kind: engine \? 'engine' : 'trooper'/.test(cv),
    '器械必须走独立的八向刚体旋转帧，不能套人形位图');
  assert.ok(/lastHeading/.test(cv) && /heading: rp\.heading/.test(cv),
    '朝向必须逐帧传给渲染层，不能只靠 dir 镜像');
});


test('v0.9.2：整圈 360° 无缝，负角 / 超圈 / 跨 0 边界都确定性落帧', () => {
  const TAU = Math.PI * 2;
  // 0 与 360° 必须同帧（回到正面），不能多出一帧或跳到背面
  assert.equal(dirIndex(0), dirIndex(TAU));
  assert.equal(dirIndex(-TAU), dirIndex(0));
  assert.equal(normAngle(TAU * 2.5), Math.PI);
  assert.equal(dirIndex(TAU * 2.5), dirIndex(Math.PI));
  // 每 1° 扫一整圈：不抛错、不越界、每个扇区都命中、相邻角最多跳一帧
  const seen = new Set();
  let jumps = 0;
  let prev = dirIndex(0);
  for (let deg = 0; deg < 360; deg++) {
    const d = dirIndex(deg * Math.PI / 180);
    assert.ok(Number.isInteger(d) && d >= 0 && d < 8);
    seen.add(d);
    const delta = (d - prev + 8) % 8;
    assert.ok(delta <= 1, `${deg}° 一次跳了 ${delta} 帧`);
    if (delta) jumps++;
    prev = d;
  }
  assert.equal(seen.size, 8, '八个扇区没有全部覆盖');
  assert.equal(jumps, 8, '整圈应该恰好换 8 次帧（含首尾回绕）');
  // 八个中心角各取不同帧；扇区边界归后一扇区，两侧确定性不重叠
  const centers = sectorCenters().map(dirIndex);
  assert.equal(new Set(centers).size, 8);
  assert.deepEqual(centers, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(!Number.isNaN(normAngle(NaN)) && normAngle(Infinity) === 0);
  // headingFromDelta 与 dirIndex 闭环：位移转一整圈仍落回同一帧
  for (let i = 0; i < 16; i++) {
    const a = i * TAU / 16;
    assert.equal(dirIndex(headingFromDelta(Math.sin(a), Math.cos(a))),
      dirIndex(a), `${i * 22.5}° 位移与角度不一致`);
  }
});

test('v0.9.2：换方向时中轴线（脚底中心）不漂移 —— 所有帧同一锚点', () => {
  const p = readFileSync(new URL('../src/portrait.js', import.meta.url), 'utf8');
  const m = JSON.parse(readFileSync(new URL('../assets/units/trooper.json', import.meta.url), 'utf8'));
  assert.equal(m.anchor, '脚底中心');
  assert.equal(m.footY, 780, '脚底基线必须全帧统一');
  assert.ok(m.frames.every((f) => f.index >= 0 && f.index < 8));
  // 统一画布 + 统一基线：帧宽只由画布比例决定，不随 dirIndex 变
  assert.ok(/const h = s \* 1\.62;/.test(p) &&
    /const w = h \* \(fr\.sw \/ fr\.sh\)/.test(p),
    '单位尺寸不能按方向帧分别计算，否则中轴会左右漂');
  // drawImage 的落点恒为 -w/2, -dh；没有任何以 d / heading 为自变量的 x 偏移
  assert.ok(/ctx\.drawImage\(fr\.sheet, fr\.sx, 0, fr\.sw, fr\.sh, -w \/ 2, -dh, w, dh\)/.test(p),
    '帧落点必须是固定居中，不能按方向改 dx');
  assert.ok(!/fr\.sx[^)]*heading|dirIndex\([^)]*\)\s*\*\s*(w|s|L\.cell)/.test(p),
    '出现了随方向帧缩放/平移中轴的表达式');
  // 地面投影画在斜轴变换之前，用的是不变的 o.x —— 换帧时脚底不挪
  const shadow = p.slice(p.indexOf('地面投影始终在地面平面上'), p.indexOf('ctx.translate(x, y + bob)'));
  assert.ok(/ctx\.ellipse\(x, y \+ 1\.4/.test(shadow) && !/heading|dirIndex|fr\.sx/.test(shadow));
  // 斜轴变换是全体帧共用的常量，不按方向换
  assert.ok(/export const GROUND_SHEAR = -0\.17;/.test(p) &&
    /ctx\.transform\(1, 0, GROUND_SHEAR, 1, 0, 0\)/.test(p));
  // 人形不吃 rotate（只有器械行军的极轻摆角），转身不靠把整张图旋一下
  assert.ok(/const tilt = engine && o\.walk/.test(p));
});
