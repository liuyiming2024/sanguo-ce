// 单位样式皮肤：回退基线、确定性、重绘差异（第十九轮）。
// 纯 Node，无 DOM / 无位图 / 无墙钟；用记录型 fake ctx 比对命令序列。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_SKINS, setUnitSkin, getUnitSkin, getUnitSkinInfo, isClassicSkin,
  drawSoldier, drawGeneralPortrait, drawInkTrooper, redrawIds, idSeed, unitKind,
} from '../src/unit-skin.js';
import { drawSoldier as baseSoldier } from '../src/soldier.js';
import { generalLook, drawGeneralPortrait as baseGeneral } from '../src/general-portrait.js';

function recorder() {
  const calls = [];
  const target = {};
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => { calls.push([k, ...args]); };
    },
    set(t, k, v) { t[k] = v; calls.push(['=', k, v]); return true; },
  });
  return { ctx, calls };
}
const sig = calls => JSON.stringify(calls);
const U = (type, extra = {}) => ({ type, hp: 70, maxHp: 100, faction: 'cao', ...extra });
const O = (extra = {}) => ({
  x: 100, y: 100, s: 26, sec: 1.2, walk: true, dir: 1, phase: 0.7, amp: 1,
  seed: idSeed('u-1'), col: '#a63129', selected: false, champion: false,
  lightGround: true, def: null, ...extra,
});

test('皮肤表完整，六档 id 唯一且含 classic 基线', () => {
  assert.equal(UNIT_SKINS.length, 6);
  assert.equal(new Set(UNIT_SKINS.map(s => s.id)).size, 6);
  assert.equal(UNIT_SKINS[0].id, 'classic');
  assert.equal(redrawIds().length, 5);
  for (const s of UNIT_SKINS) {
    assert.ok(s.title && s.short && s.desc && s.caveat, `${s.id} 缺说明`);
  }
});

test('默认 classic；切换合法 / 拒绝非法；切回基线生效', () => {
  setUnitSkin('classic');
  assert.equal(getUnitSkin(), 'classic');
  assert.equal(isClassicSkin(), true);
  assert.equal(getUnitSkinInfo().letter, 'A');
  assert.equal(setUnitSkin('___不存在___'), false);
  assert.equal(getUnitSkin(), 'classic');
  for (const id of ['gongbi', 'rubbing', 'baimiao', 'shadow', 'night']) {
    assert.equal(setUnitSkin(id), true);
    assert.equal(getUnitSkin(), id);
  }
  assert.equal(setUnitSkin('classic'), true);
  assert.equal(isClassicSkin(), true);
});

test('classic 档 drawSoldier 与原 soldier.js 逐命令一致（回退硬证据）', () => {
  setUnitSkin('classic');
  for (const t of ['qingbing', 'zhongjia', 'chuangnu', 'paoshi']) {
    for (const s of [10, 16, 26, 48]) {
      const a = recorder(), b = recorder();
      drawSoldier(a.ctx, U(t), O({ s }));
      baseSoldier(b.ctx, U(t), O({ s }));
      assert.equal(sig(a.calls), sig(b.calls), `${t} s=${s} 基线不一致`);
    }
  }
});

test('classic 档将领与原 general-portrait.js 逐命令一致', () => {
  setUnitSkin('classic');
  const look = generalLook({ name: '曹操', force: 72, intellect: 91, command: 96, politics: 94 });
  const a = recorder(), b = recorder();
  drawGeneralPortrait(a.ctx, look, 100, 200, 90, { hpK: .6, flash: .3, skill: '#c8a86a' });
  baseGeneral(b.ctx, look, 100, 200, 90, { hpK: .6, flash: .3, skill: '#c8a86a' });
  assert.equal(sig(a.calls), sig(b.calls));
});

test('classic 档主地图简笔返回 false（调用方走原 inkTrooper）', () => {
  setUnitSkin('classic');
  const { ctx } = recorder();
  assert.equal(drawInkTrooper(ctx, 10, 10, 20, 0, 0, '#000'), false);
});

test('五档重绘都能画、逐命令确定、且与基线不同', () => {
  for (const id of redrawIds()) {
    setUnitSkin(id);
    for (const t of ['qingbing', 'zhongjia', 'chuangnu', 'paoshi']) {
      const a = recorder(), b = recorder();
      drawSoldier(a.ctx, U(t), O());
      drawSoldier(b.ctx, U(t), O());
      assert.ok(a.calls.length > 20, `${id}/${t} 什么都没画`);
      assert.equal(sig(a.calls), sig(b.calls), `${id}/${t} 同参不确定`);
    }
    setUnitSkin('classic');
    const base = recorder(); baseSoldier(base.ctx, U('qingbing'), O());
    setUnitSkin(id);
    const redraw = recorder(); drawSoldier(redraw.ctx, U('qingbing'), O());
    assert.notEqual(sig(base.calls), sig(redraw.calls), `${id} 与基线没有差别`);
  }
  setUnitSkin('classic');
});

test('重绘将领：姓名 + 五维派生特征真的影响形状（不是同一图章）', () => {
  const gens = [
    { name: '曹操', force: 72, intellect: 91, command: 96, politics: 94 },
    { name: '关羽', force: 98, intellect: 76, command: 93, politics: 62 },
    { name: '诸葛亮', force: 38, intellect: 100, command: 92, politics: 98 },
    { name: '张飞', force: 99, intellect: 42, command: 84, politics: 38 },
  ];
  for (const id of redrawIds()) {
    setUnitSkin(id);
    const sigs = gens.map(g => {
      const r = recorder();
      drawGeneralPortrait(r.ctx, generalLook(g), 100, 200, 120, { hpK: .8 });
      assert.ok(r.calls.length > 20, `${id} 将领没画`);
      return sig(r.calls);
    });
    assert.equal(new Set(sigs).size, gens.length, `${id} 四名将领画成了同一个图章`);
  }
  setUnitSkin('classic');
});

test('重绘档主地图简笔也能画且确定', () => {
  for (const id of redrawIds()) {
    setUnitSkin(id);
    const a = recorder(), b = recorder();
    assert.equal(drawInkTrooper(a.ctx, 10, 10, 42, 1.2, .7, '#333'), true);
    assert.equal(drawInkTrooper(b.ctx, 10, 10, 42, 1.2, .7, '#333'), true);
    assert.equal(sig(a.calls), sig(b.calls));
  }
  setUnitSkin('classic');
});

test('unitKind / idSeed 等转出与原模块一致（调用方零改动）', () => {
  assert.equal(unitKind('chuangnu'), 'engine');
  assert.equal(unitKind('paoshi'), 'engine');
  assert.equal(unitKind('zhongjia'), 'figure');
  assert.equal(typeof idSeed('abc'), 'number');
});
