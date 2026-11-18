import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  FORMATIONS, FORMATION_LABEL, formationOffsets, assignFormation, formationSummary,
} from '../src/formation.js';

const U = (n, col = 2, row = 3) => Array.from({ length: n }, (_, i) => ({
  id: `u${i}`, zone: 'inside', col: col + i, row,
}));
const occupiedOf = (units) => new Set(units.map((u) => `${u.col}:${u.row}`));

test('阵型偏移：确定性、无重复、覆盖三种阵型', () => {
  for (const shape of FORMATIONS) {
    const a = formationOffsets(shape, 4).slice(0, 12);
    const b = formationOffsets(shape, 4).slice(0, 12);
    assert.deepEqual(a, b, `${shape} 排序不确定`);
    assert.equal(new Set(a.map((o) => `${o.dc}:${o.dr}`)).size, a.length);
    assert.ok(a.length === 12);
  }
  assert.equal(FORMATIONS.length, 3);
  assert.equal(FORMATION_LABEL.wedge, '楔形');
});

test('横队 5 队：同一行连续展开，中心落在目标格', () => {
  const r = assignFormation({ units: U(5), target: { zone: 'inside', col: 10, row: 8 },
    cols: 24, rows: 16, shape: 'line' });
  assert.equal(r.assignments.length, 5);
  assert.ok(r.assignments.every((a) => a.row === 8), '横队必须同行');
  const cs = r.assignments.map((a) => a.col).sort((x, y) => x - y);
  assert.deepEqual(cs, [8, 9, 10, 11, 12]);
  assert.ok(r.assignments.some((a) => a.col === 10 && a.row === 8));
  assert.equal(new Set(r.assignments.map((a) => `${a.col}:${a.row}`)).size, 5);
});

test('方阵 12 队：无重复、全在界内、紧凑成块', () => {
  const r = assignFormation({ units: U(12), target: { zone: 'inside', col: 10, row: 8 },
    cols: 24, rows: 16, shape: 'block' });
  assert.equal(r.assignments.length, 12);
  assert.ok(r.assignments.every((a) => a.col >= 0 && a.col < 24 && a.row >= 0 && a.row < 16));
  assert.equal(new Set(r.assignments.map((a) => `${a.col}:${a.row}`)).size, 12);
  const rows = new Set(r.assignments.map((a) => a.row));
  assert.ok(rows.size <= 4, '方阵不该拉成一条线');
});

test('楔形 8 队：尖端朝目标，全在界内', () => {
  const r = assignFormation({ units: U(8), target: { zone: 'inside', col: 10, row: 8 },
    cols: 24, rows: 16, shape: 'wedge' });
  assert.equal(r.assignments.length, 8);
  assert.equal(new Set(r.assignments.map((a) => `${a.col}:${a.row}`)).size, 8);
  assert.ok(r.assignments.every((a) => a.col >= 0 && a.col < 24 && a.row >= 0 && a.row < 16));
});

test('目标贴边 / 贴角：自动向内收，不越界、不丢队', () => {
  for (const t of [{ col: 0, row: 0 }, { col: 23, row: 15 }, { col: 0, row: 15 }]) {
    for (const shape of FORMATIONS) {
      const r = assignFormation({ units: U(9), target: { zone: 'inside', ...t },
        cols: 24, rows: 16, shape });
      assert.equal(r.assignments.length, 9, `${shape} @${t.col},${t.row} 丢队`);
      assert.ok(r.assignments.every((a) => a.col >= 0 && a.col < 24 && a.row >= 0 && a.row < 16));
      assert.equal(new Set(r.assignments.map((a) => `${a.col}:${a.row}`)).size, 9);
    }
  }
});

test('已占用格避让：不让两队叠在同一格', () => {
  const occ = new Set(['8:8', '9:8', '10:8', '11:8', '12:8', '13:8']);
  const r = assignFormation({ units: U(4), target: { zone: 'inside', col: 10, row: 8 },
    cols: 24, rows: 16, occupied: occ, shape: 'line' });
  assert.equal(r.assignments.length, 4);
  assert.ok(r.assignments.every((a) => !occ.has(`${a.col}:${a.row}`)), '踩到了别的队伍');
  assert.equal(new Set(r.assignments.map((a) => `${a.col}:${a.row}`)).size, 4);
});

test('确定性：同输入逐字段一致；离目标近的站前排', () => {
  const units = U(6, 0, 0);
  const opts = { units, target: { zone: 'inside', col: 12, row: 8 },
    cols: 24, rows: 16, shape: 'line', occupied: new Set() };
  assert.deepEqual(assignFormation(opts), assignFormation({ ...opts }));
  const r = assignFormation(opts);
  const d = (u) => Math.hypot(u.col - 12, u.row - 8);
  assert.ok(d(units.find((u) => u.id === r.assignments[0].id)) <=
            d(units.find((u) => u.id === r.assignments.at(-1).id)) + 1e-9);
});

test('点在城外大营：整队撤回，按稳定 id 顺序给位置', () => {
  const r = assignFormation({ units: U(4), target: { zone: 'camp', col: 0, row: 0 },
    cols: 24, rows: 16 });
  assert.equal(r.assignments.length, 4);
  assert.ok(r.assignments.every((a) => a.zone === 'camp'));
  assert.deepEqual(r.assignments.map((a) => a.id), ['u0', 'u1', 'u2', 'u3']);
  assert.deepEqual(r.assignments.map((a) => a.col), [0, 1, 2, 3]);
});

test('队伍朝向：从重心指向目标，正右为 π/2', () => {
  const r = assignFormation({ units: U(3, 2, 8),
    target: { zone: 'inside', col: 12, row: 8 }, cols: 24, rows: 16 });
  assert.ok(Math.abs(r.heading - Math.PI / 2) < 1e-9);
  const back = assignFormation({ units: U(3, 2, 8),
    target: { zone: 'inside', col: 0, row: 8 }, cols: 24, rows: 16 });
  // normAngle 把 -π/2 规整到 3π/2（正左 270° 帧）
  assert.ok(Math.abs(back.heading - Math.PI * 1.5) < 1e-9);
});

test('空选 / 无目标：安全返回空，不抛错', () => {
  assert.deepEqual(assignFormation({ units: [], target: null }).assignments, []);
  assert.deepEqual(assignFormation({ units: U(2), target: null }).assignments, []);
  assert.equal(formationSummary({ assignments: [], formation: 'line' }), '无可调动的队伍');
  assert.equal(formationSummary({ assignments: new Array(5), formation: 'block' }), '方阵 · 5 队归位');
});

test('24 帧资产齐备，步态帧与 idle 确实不同（不是复制同一张）', () => {
  const dir = new URL('../assets/units/', import.meta.url);
  const m = JSON.parse(readFileSync(new URL('trooper.json', dir), 'utf8'));
  assert.ok(!('version' in m), '资产清单不该再存版本字面量');
  assert.deepEqual(m.phases, ['idle', 'stepL', 'stepR']);
  const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'));
  assert.ok(pngs.length >= 26, `只有 ${pngs.length} 张 PNG`);
  for (const f of m.frames) {
    for (const n of [f.file, f.walkL, f.walkR]) {
      assert.ok(existsSync(new URL(n, dir)), `缺 ${n}`);
    }
    const sha = (n) => createHash('sha256')
      .update(readFileSync(new URL(n, dir))).digest('hex');
    assert.notEqual(sha(f.file), sha(f.walkL));
    assert.notEqual(sha(f.file), sha(f.walkR));
    assert.notEqual(sha(f.walkL), sha(f.walkR), `${f.name} 左右步没区别`);
  }
});

test('源图 hash 锁：背面三帧是验收后的重画版，不是「正面把脸遮住」', () => {
  const dir = new URL('../assets/units/', import.meta.url);
  const m = JSON.parse(readFileSync(new URL('trooper.json', dir), 'utf8'));
  for (const back of ['d3_back_right', 'd4_back', 'd5_back_left']) {
    const f = new URL(`src-${back}.jpg`, new URL('src/', dir));
    assert.ok(existsSync(f), `缺源图 ${back}`);
    const real = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
    assert.equal(real, m.srcSha256[back], `${back} 被换回了假背面`);
  }
});
