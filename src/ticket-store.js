// 军令帖短号中转层。
//
// 整段 base64url 口令几千字符，微信分享 path 塞不下，聊天里也难看。
// 这一层把它换成 6 位短号：口令存进一张表，短号走会话 / 剪贴板 / 分享卡片。
//
// 边界写清楚，免得后来人误解：
//  · 这里只做「存 / 取 / 删一段字符串」，不重放局面、不裁定胜负、不推进旬历。
//    权威状态机、命令日志、状态指纹仍全在 src/sync.js 与策略层，一行没搬。
//  · 短号不是加密，是「不易猜中的取件码」。库里放的是明文军令帖，
//    拿到短号即可读帖；不要把口令换成的东西当成秘密凭证。
//  · store 是可插拔接口：put / get / del。memory 供单测与离线回退，
//    rest 供 PostgREST（Supabase）与将来自有域名反代 / 云函数中转共用。
//  · 前端只准用 anon public key。service_role key 一旦进页面即等同泄露，
//    assertPublicKey() 在这里硬拦，不靠自觉。

import { decodeTicket } from './sync.js';

export const SHORT_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉 0/1/I/O，避免手抄歧义
export const SHORT_ID_LENGTH = 6;
export const MAX_TICKET_CHARS = 20000;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function randomBytes(n, rng) {
  if (rng) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.floor(rng() * 256) & 255;
    return a;
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const a = new Uint8Array(n);
    globalThis.crypto.getRandomValues(a);
    return a;
  }
  // 短号不参与玩法状态，回退到宿主随机源即可；单测一律注入 rng 保确定性。
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}

export function makeShortId({ rng, length = SHORT_ID_LENGTH } = {}) {
  const bytes = randomBytes(length, rng);
  let s = '';
  for (let i = 0; i < length; i++) s += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
  return s;
}

export function normalizeShortId(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s\-—_]/g, '');
  if (!new RegExp(`^[${SHORT_ID_ALPHABET}]{${SHORT_ID_LENGTH}}$`).test(s)) {
    throw new Error('短号须为 6 位，且不含 0 / 1 / I / O');
  }
  return s;
}

/** 入出库都校一遍：表里不该被塞进别的字符串，也不该塞超长文本。 */
export function describeTicket(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('请先粘贴军令帖');
  if (t.length > MAX_TICKET_CHARS) throw new Error(`军令帖超过 ${MAX_TICKET_CHARS} 字符上限`);
  if (!/^[A-Za-z0-9_-]+$/.test(t)) throw new Error('军令帖含非法字符');
  const d = decodeTicket(t);
  if (d.game !== 'sanguo-ce-guandu') throw new Error('不是三国策的军令帖');
  if (!d.save || d.save.v !== 1) throw new Error('存档格式不兼容');
  return {
    text: t, hash: d.hash ?? '', version: d.version ?? '', date: d.date ?? '',
    mapId: d.save.mapId ?? 'guandu', turn: d.save.turn ?? 0,
  };
}

function jwtRole(key) {
  const seg = String(key).split('.');
  if (seg.length !== 3) return null;
  try {
    const p = seg[1].replace(/-/g, '+').replace(/_/g, '/');
    let json;
    if (typeof Buffer !== 'undefined') json = Buffer.from(p, 'base64').toString('utf8');
    else json = decodeURIComponent(escape(atob(p)));
    return JSON.parse(json).role ?? null;
  } catch { return null; }
}

/**
 * Supabase 的 anon key 按设计可公开（配合 RLS），不是秘密；
 * service_role key 绕过 RLS，authenticated JWT 属于某个登录用户，两者都不能硬编码进页面。
 */
export function assertPublicKey(key) {
  const k = String(key ?? '').trim();
  if (!k) throw new Error('缺 anon public key');
  if (/service_role/i.test(k)) throw new Error('service_role key 绝不能放进前端');
  const role = jwtRole(k);
  if (role === 'service_role') throw new Error('service_role key 绝不能放进前端');
  if (role && role !== 'anon') {
    throw new Error(`这张 key 的 role 是 ${role}，只能用 anon public key`);
  }
  return k;
}

// ── store 接口：put(rec) / get(id) / del(id) ────────────────────────────────

export function createMemoryStore({ now = () => Date.now() } = {}) {
  const rows = new Map();
  return {
    kind: 'memory',
    async put(rec) {
      if (rows.has(rec.id)) return { conflict: true };
      rows.set(rec.id, { ...rec });
      return { conflict: false };
    },
    async get(id) {
      const r = rows.get(id);
      if (!r) return null;
      const exp = Date.parse(r.expires_at);
      if (Number.isFinite(exp) && exp <= now()) { rows.delete(id); return null; }
      return { ...r };
    },
    async del(id) { return rows.delete(id); },
  };
}

/**
 * 通用 PostgREST 形状：endpoint 指向表资源根，headers 自带鉴权。
 * 换成自有域名反代 / 云函数中转时只换 endpoint 与 headers，上层 putTicket / takeTicket 不动。
 */
export function createRestStore({ endpoint, headers = {}, fetchImpl, kind = 'rest' } = {}) {
  const base = String(endpoint ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺表资源地址');
  const f = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  if (typeof f !== 'function') throw new Error('当前环境没有 fetch，需显式传入 fetchImpl');
  const baseHeaders = { 'Content-Type': 'application/json', ...headers };

  async function call(method, url, body, extra = {}) {
    const res = await f(url, {
      method,
      headers: { ...baseHeaders, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, text: await (res.text?.() ?? Promise.resolve('')) };
  }

  return {
    kind,
    endpoint: base,
    async put(rec) {
      const r = await call('POST', base, rec, { Prefer: 'return=minimal' });
      // 主键冲突：PostgREST 返回 409 / 23505。换一个短号重试，绝不能覆盖别人的帖。
      if (r.status === 409 || /23505|duplicate key/i.test(r.text)) return { conflict: true };
      if (!r.ok) throw new Error(`写入失败 ${r.status}：${r.text.slice(0, 180)}`);
      return { conflict: false };
    },
    async get(id) {
      const r = await call('GET', `${base}?id=eq.${encodeURIComponent(id)}&select=id,payload,hash,version,map_id,turn,expires_at`);
      if (!r.ok) throw new Error(`取帖失败 ${r.status}：${r.text.slice(0, 180)}`);
      let rows = [];
      try { rows = JSON.parse(r.text || '[]'); } catch { throw new Error('取帖返回的不是 JSON'); }
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return null;
      const exp = Date.parse(row.expires_at);
      if (Number.isFinite(exp) && exp <= Date.now()) return null;
      return row;
    },
    async del(id) {
      const r = await call('DELETE', `${base}?id=eq.${encodeURIComponent(id)}`, undefined,
        { Prefer: 'return=minimal' });
      if (!r.ok) throw new Error(`焚帖失败 ${r.status}：${r.text.slice(0, 180)}`);
      return true;
    },
  };
}

export function createSupabaseStore({ url, anonKey, table = 'tickets', fetchImpl } = {}) {
  const key = assertPublicKey(anonKey);
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('项目地址须为 https 开头');
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error('表名非法');
  return createRestStore({
    endpoint: `${base}/rest/v1/${table}`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    fetchImpl,
    kind: 'supabase',
  });
}

// ── 上层动作 ─────────────────────────────────────────────────────────────

export async function putTicket(store, ticketText, {
  rng, id, ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), maxRetries = 5,
} = {}) {
  const d = describeTicket(ticketText);
  for (let i = 0; i < maxRetries; i++) {
    const sid = i === 0 && id ? normalizeShortId(id) : makeShortId({ rng });
    const expires_at = new Date(now() + ttlMs).toISOString();
    const rec = {
      id: sid, payload: d.text, hash: d.hash, version: d.version,
      map_id: d.mapId, turn: d.turn, expires_at,
    };
    const r = await store.put(rec);
    if (!r.conflict) return { id: sid, ...d, expiresAt: expires_at };
  }
  throw new Error('短号连续冲突，请稍后再试');
}

export async function takeTicket(store, shortId, { burn = false } = {}) {
  const id = normalizeShortId(shortId);
  const row = await store.get(id);
  if (!row) return null;
  const d = describeTicket(row.payload);
  if (burn) await store.del(id);
  return { id, ...d, expiresAt: row.expires_at ?? null };
}
