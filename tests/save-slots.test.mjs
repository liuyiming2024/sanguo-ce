// 多档存档：三席并存、覆盖前留备份、坏档回退、meta 不读整局。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listSlots, readSlot, saveSlot, backupSlot, restoreBackup, deleteSlot,
  isUsableSave, slotIndex, SLOT_COUNT,
} from '../src/save-slots.js';

// 最小 localStorage mock，键级隔离，每个用例前清空。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const raw = (turn) => ({ v: 1, version: '0.9.4', mapId: 'guandu', turn,
  seed: 1, playerFaction: 'cao', rng: { state: 1, calls: 0 },
  cities: { xudu: { owner: 'cao' } }, tiles: [], resources: {}, orders: [] });

test('档位编号：只认 1..3，其余一律拒绝', () => {
  assert.equal(SLOT_COUNT, 3);
  assert.equal(slotIndex(1), 1);
  assert.equal(slotIndex(3), 3);
  for (const bad of [0, 4, -1, 1.5, '2x', null, undefined]) assert.equal(slotIndex(bad), null);
});

test('isUsableSave 只认最小契约，坏结构不猜字段', () => {
  assert.equal(isUsableSave(raw(3)), true);
  assert.equal(isUsableSave(null), false);
  assert.equal(isUsableSave({ ...raw(3), v: 2 }), false);
  assert.equal(isUsableSave({ ...raw(3), tiles: 'x' }), false);
  assert.equal(isUsableSave({ ...raw(3), rng: null }), false);
});

test('三席互不覆盖，列档只读 meta 不反序列化整局', () => {
  store.clear();
  assert.ok(listSlots().every((s) => s.empty));
  assert.equal(saveSlot(1, raw(3)).ok, true);
  assert.equal(saveSlot(2, raw(9)).ok, true);
  const l = listSlots();
  assert.equal(l[0].meta.turn, 3);
  assert.equal(l[1].meta.turn, 9);
  assert.equal(l[2].empty, true);
  assert.equal(readSlot(1).raw.turn, 3);
  assert.equal(readSlot(2).raw.turn, 9);
  // 覆盖第 1 席不影响第 2 席
  assert.equal(saveSlot(1, raw(20)).ok, true);
  assert.equal(readSlot(2).raw.turn, 9);
  assert.equal(readSlot(1).raw.turn, 20);
});

test('覆盖前备份：写坏后能一键回退，原文不删', () => {
  store.clear();
  saveSlot(1, raw(3));
  backupSlot(1);
  saveSlot(1, raw(4));
  const key = 'sanguo-ce:slot:1';
  store.set(key, '{ 这不是 JSON');
  const bad = readSlot(1);
  assert.equal(bad.ok, false);
  assert.equal(bad.corrupt, true);
  assert.equal(store.get(key), '{ 这不是 JSON', '坏档原文必须保留');
  assert.equal(bad.backupUsable, true);
  const r = restoreBackup(1);
  assert.equal(r.ok, true);
  assert.equal(r.raw.turn, 3, '应回退到备份那一旬');
  assert.equal(readSlot(1).ok, true);
});

test('空席 / 坏档 / 删除：都不抛异常，删除连带清备份与 meta', () => {
  store.clear();
  assert.equal(readSlot(2).ok, false);
  assert.equal(restoreBackup(2).ok, false);
  saveSlot(2, raw(7)); backupSlot(2);
  assert.equal(deleteSlot(2), true);
  assert.equal(listSlots()[1].empty, true);
  assert.equal(readSlot(2).ok, false);
  assert.equal(restoreBackup(2).ok, false, '备份也应一并清掉');
});

test('写入失败或数据不合法时明确返回，不静默成功', () => {
  store.clear();
  assert.equal(saveSlot(9, raw(1)).ok, false);
  assert.equal(saveSlot(1, { v: 2 }).ok, false);
});
