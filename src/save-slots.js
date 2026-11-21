// 多档存档：本机三席 + 自动档并存，坏档可救。
//
// 与 persist.js 的分工：serializeGame / deserializeGame 只管「一局局面怎么压成 JSON」，
// 这里管「放哪几格、坏了怎么办」。刻意分开，策略层与序列化层一行不动。
//
// 坏档救援三道：
//  ① 写入前先把上一份可用档复制到 :bak，覆盖写坏了还能回退；
//  ② 读取时 JSON 解析失败 / 版本不符，不删原文，标 corrupt 交界面处置；
//  ③ 每席带 meta（存时 / 回合 / 图幅 / 城数），列档不必反序列化整局。
//
// 浏览器侧：localStorage 不可用时全部静默降级，绝不影响开局。

const PREFIX = 'sanguo-ce:slot:';
export const SLOT_COUNT = 3;
export const SLOT_LABELS = ['甲', '乙', '丙'];

const key = (i) => `${PREFIX}${i}`;
const bakKey = (i) => `${PREFIX}${i}:bak`;
const metaKey = (i) => `${PREFIX}${i}:meta`;

export function slotIndex(i) {
  const n = Number(i);
  return Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT ? n : null;
}

/** 结构校验：只认能喂 deserializeGame 的最小契约，不猜字段。 */
export function isUsableSave(raw) {
  return !!raw && typeof raw === 'object' && raw.v === 1 &&
    typeof raw.turn === 'number' && Number.isFinite(raw.turn) &&
    !!raw.cities && typeof raw.cities === 'object' &&
    Array.isArray(raw.tiles) && !!raw.rng && typeof raw.rng === 'object';
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}
function safeDel(k) {
  try { localStorage.removeItem(k); } catch { /* 忽略 */ }
}

export function slotMeta(i) {
  const n = slotIndex(i);
  if (!n) return null;
  try { return JSON.parse(safeGet(metaKey(n)) ?? 'null'); } catch { return null; }
}

/** 列档：不反序列化整局，只读 meta；坏档也列出来，让使用者能删 / 能救。 */
export function listSlots() {
  const out = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const text = safeGet(key(i));
    if (text == null) { out.push({ i, label: SLOT_LABELS[i - 1], empty: true, corrupt: false, meta: null }); continue; }
    let raw = null, corrupt = false;
    try { raw = JSON.parse(text); } catch { corrupt = true; }
    if (!corrupt && !isUsableSave(raw)) corrupt = true;
    out.push({ i, label: SLOT_LABELS[i - 1], empty: false, corrupt, meta: slotMeta(i),
      bytes: text.length, hasBackup: safeGet(bakKey(i)) != null });
  }
  return out;
}

/** 读档：返回 { ok, raw, corrupt, backupUsable, slot }。原文一律不删。 */
export function readSlot(i) {
  const n = slotIndex(i);
  if (!n) return { ok: false, reason: '档位不存在' };
  const text = safeGet(key(n));
  if (text == null) return { ok: false, reason: '空档' };
  let raw = null;
  try { raw = JSON.parse(text); } catch { /* 落到 corrupt */ }
  if (isUsableSave(raw)) return { ok: true, raw, slot: n, meta: slotMeta(n) };
  const bak = safeGet(bakKey(n));
  let bakRaw = null;
  try { bakRaw = JSON.parse(bak ?? 'null'); } catch { /* 忽略 */ }
  return { ok: false, corrupt: true, slot: n,
    backupUsable: isUsableSave(bakRaw), backupRaw: isUsableSave(bakRaw) ? bakRaw : null,
    reason: '该档损坏或版本不兼容' };
}

/** 存档：先把当前可用档复制到 :bak，再覆盖；meta 单列，列档不读整局。 */
export function saveSlot(i, data) {
  const n = slotIndex(i);
  if (!n || !isUsableSave(data)) return { ok: false, reason: '档位或局面不合法' };
  if (!safeSet(key(n), JSON.stringify(data))) return { ok: false, reason: '本机存储不可用' };
  const meta = {
    savedAt: Date.now(), turn: data.turn, mapId: data.mapId ?? 'guandu',
    chapter: data.chapter ?? null,
    cities: Object.keys(data.cities ?? {}).length,
    playerFaction: data.playerFaction ?? null,
  };
  safeSet(metaKey(n), JSON.stringify(meta));
  return { ok: true, slot: n, meta };
}

/** 回退到备份档：坏档救援的唯一写入口，不碰自动档。 */
export function restoreBackup(i) {
  const n = slotIndex(i);
  if (!n) return { ok: false, reason: '档位不存在' };
  const bak = safeGet(bakKey(n));
  let raw = null;
  try { raw = JSON.parse(bak ?? 'null'); } catch { /* 忽略 */ }
  if (!isUsableSave(raw)) return { ok: false, reason: '备份不可用' };
  if (!safeSet(key(n), JSON.stringify(raw))) return { ok: false, reason: '本机存储不可用' };
  safeSet(metaKey(n), JSON.stringify({
    savedAt: Date.now(), turn: raw.turn, mapId: raw.mapId ?? 'guandu',
    chapter: raw.chapter ?? null, cities: Object.keys(raw.cities ?? {}).length,
    playerFaction: raw.playerFaction ?? null, restoredFromBackup: true,
  }));
  return { ok: true, slot: n, raw };
}

/** 备份当前档（在覆盖前由界面调用，也可单独用）。 */
export function backupSlot(i) {
  const n = slotIndex(i);
  if (!n) return false;
  const cur = safeGet(key(n));
  if (cur == null) return false;
  try { if (!isUsableSave(JSON.parse(cur))) return false; } catch { return false; }
  return safeSet(bakKey(n), cur);
}

export function deleteSlot(i) {
  const n = slotIndex(i);
  if (!n) return false;
  safeDel(key(n)); safeDel(metaKey(n)); safeDel(bakKey(n));
  return true;
}
