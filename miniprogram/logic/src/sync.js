// 多人联机的「零预算」地基。
//
// 结论先写在这里：**无预算可以做地基，也可以做异步对演；做不了跨设备实时房间。**
// 这一层不引用任何后端、账号、墙钟或网络库，只把现有策略层包装成
// 「权威状态机 + 带序号的命令日志 + 可比对的状态指纹」。
// 以后要接服务器，只需要把 applyEntry 搬到服务端、把 Transport 换成 WebSocket，
// 策略层 / 战斗层 / 界面层一行不动。
//
// 三个必须现在定的口径：
//  1. 逻辑时间只有 turn（旬），没有 Date.now() —— 两端不会因本地时钟分叉。
//  2. RNG 状态随命令一起记入日志，恢复后序列不分叉。
//  3. 所有状态变更都经 applyEntry(state, entry)，UI 不直接写 state。

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** FNV-1a 32bit × 2 轮，输出 16 位十六进制，够用于两端快速比对。 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 只取影响玩法的字段；刻意排除 cfg / terrain 全量位图 / savedAt / ui / DOM。 */
export function stateFingerprint(state) {
  const pf = state.playerFaction;
  const cities = {};
  for (const [id, c] of Object.entries(state.cities ?? {})) {
    cities[id] = [c.owner, c.garrison, Math.round(c.wall), Math.round(c.morale),
      c.pop, c.grain, !!c.besieged, c.commander?.state ?? 'inOffice'];
  }
  const orderOf = (o) => [o.id, o.type, o.from, o.to ?? null, o.tile?.c ?? null,
    o.tile?.r ?? null, o.issuedTurn, o.arriveTurn, o.faction,
    o.path?.length ?? 0, Math.round((o.km ?? 0) * 10) / 10,
    stableStringify(o.units ?? {})];
  const unitOf = (u) => [u.id, u.type, u.faction, u.hp, u.zone, u.col, u.row, u.count];
  const forces = {};
  for (const [id, f] of Object.entries(state.forces ?? {})) {
    forces[id] = [(f.inside ?? []).map(unitOf), (f.camp ?? []).map(unitOf)];
  }
  // 地形：紧凑增量串，只记与「无主 / 无垒 / 等级」不同的格子。
  const tiles = [];
  const tarr = state.terrain?.tiles ?? [];
  for (let i = 0; i < tarr.length; i++) {
    const t = tarr[i];
    if (t.owner || t.fort || t.level > 1 || (t.cost !== undefined && t.cost < 90 && t.fort)) {
      tiles.push([i, t.owner ?? '', t.level ?? 0, t.fort ?? '', Math.round((t.cost ?? 0) * 100)]);
    }
  }
  return {
    v: 1, turn: state.turn, chapter: state.chapter ?? null,
    storyFlags: state.storyFlags ?? {}, storyChoices: state.storyChoices ?? {},
    chapterHistory: state.chapterHistory ?? [], claimedTasks: state.claimedTasks ?? [],
    resources: state.resources?.[pf] ?? {}, copper: state.copper ?? 0,
    cities, orders: (state.orders ?? []).map(orderOf),
    mailbox: (state.mailbox ?? []).map((e) => [e.atSec, e.kind, e.city ?? null, e.faction ?? null]),
    forces, intel: state.intel ?? {}, forts: state.forts ?? [],
    facilities: state.facilities ?? {}, armies: state.armies ?? [],
    actors: state.actors ?? {}, settings: state.settings ?? {},
    stats: state.stats ?? {},
    nextIds: [state.nextOrderId, state.nextForceId, state.nextUnitId, state.nextBattleId],
    tiles,
    rngCalls: state.rngCalls ?? 0,
  };
}

export function hashState(state) {
  const s = stableStringify(stateFingerprint(state));
  const a = fnv1a(s), b = fnv1a(s.split('').reverse().join(''));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// ── 命令日志 ────────────────────────────────────────────────────────────
export function createCommandLog(seed = 0) {
  return { v: 1, seed, seq: 0, entries: [] };
}

/**
 * 记一条命令。payload 必须是纯 JSON（命令的可序列化部分），
 * rngBefore / rngAfter 让日志自带随机序列，重放时不依赖外部 rng 对象。
 */
export function appendCommand(log, { turn, actor, type, payload = {}, rngBefore = null, rngAfter = null }) {
  const entry = { seq: log.seq++, turn, actor, type, payload, rngBefore, rngAfter };
  log.entries.push(entry);
  return entry;
}

export function logFromState(state) {
  return state.commandLog ?? createCommandLog(state.rngSeed ?? 0);
}

// ── 重放校验 ────────────────────────────────────────────────────────────
/**
 * 双路径对演：同一初始态（其中一条可由存档反序列化而来）按同一日志执行，
 * 每一步都比对指纹。任何一处「UI 直接写 state」「用了墙钟」「rng 调用顺序不同」都会在这里暴露。
 */
export function verifyReplay({ createStateA, createStateB, entries, applyEntry }) {
  const a = createStateA(), b = createStateB();
  const h0 = hashState(a);
  let mismatchAt = -1, expected = h0, actual = h0;
  if (hashState(b) !== h0) {
    return { ok: false, mismatchAt: -1, reason: '两条初始态指纹不同', expected: h0, actual: hashState(b) };
  }
  for (let i = 0; i < entries.length; i++) {
    applyEntry(a, entries[i]);
    applyEntry(b, entries[i]);
    expected = hashState(a); actual = hashState(b);
    if (expected !== actual) { mismatchAt = i; break; }
  }
  return { ok: mismatchAt === -1, mismatchAt, steps: mismatchAt === -1 ? entries.length : mismatchAt,
    hash: expected, expected, actual };
}

// ── 传输层（零服务器） ──────────────────────────────────────────────────
/**
 * loopback：同进程双端对演 / 单测用。
 * BroadcastChannel：同一浏览器多标签（零服务器，零成本，真实可用）。
 * 两者实现同一个接口：send(from, cmd) / drain(peer) / peers() / close()。
 */
export function createLoopbackTransport(ids = ['A', 'B']) {
  const queues = new Map(ids.map((id) => [id, []]));
  let seq = 0;
  return {
    kind: 'loopback',
    peers: () => [...ids],
    send(from, cmd) {
      const packed = { from, seq: seq++, cmd };
      for (const id of ids) if (id !== from) queues.get(id).push(packed);
      return packed;
    },
    drain(peer) { return queues.get(peer)?.splice(0) ?? []; },
    close() { queues.clear(); },
  };
}

export function createBroadcastTransport(channelName = 'sanguo-ce-guandu', selfId = 'A') {
  if (typeof BroadcastChannel === 'undefined') return createLoopbackTransport([selfId, 'peer']);
  const ch = new BroadcastChannel(channelName);
  // Node / 无 peer 环境下 BroadcastChannel 会 ref 住事件循环，导致进程不退出。
  ch.unref?.();
  const inbox = [];
  let seq = 0;
  ch.onmessage = (e) => { if (e.data?.from !== selfId) inbox.push(e.data); };
  return {
    kind: 'broadcast',
    peers: () => [selfId, 'peer'],
    send(_from, cmd) {
      const packed = { from: selfId, seq: seq++, cmd };
      ch.postMessage(packed);
      return packed;
    },
    drain() { return inbox.splice(0); },
    close() { ch.close(); },
  };
}

// ── 存档口令（play-by-email，真正的零预算「联机」） ─────────────────────
export function encodeTicket(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeTicket(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  let json;
  if (typeof Buffer !== 'undefined') json = Buffer.from(pad, 'base64').toString('utf8');
  else json = decodeURIComponent(escape(atob(pad)));
  return JSON.parse(json);
}

// ── actor 注册：human / ai / remote 三态，命令一律带 actor ───────────────
export function createActorRegistry(cfg, humanFaction) {
  const out = {};
  for (const f of cfg.factions) {
    out[f.id] = { kind: f.id === humanFaction ? 'human' : 'ai', name: f.name, peerId: null };
  }
  return out;
}
