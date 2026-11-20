// 军令帖短号中转：短号、校验、store 接口、Supabase REST 形状、跨端编解码交叉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeTicket, decodeTicket } from '../src/sync.js';
import {
  SHORT_ID_ALPHABET, SHORT_ID_LENGTH, MAX_TICKET_CHARS,
  makeShortId, normalizeShortId, describeTicket, assertPublicKey,
  createMemoryStore, createRestStore, createSupabaseStore, createFunctionStore, putTicket, takeTicket,
} from '../src/ticket-store.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const jwt = (role) => `hdr.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;
const ANON = jwt('anon');

function ticket(extra = {}) {
  return encodeTicket({
    v: 1, game: 'sanguo-ce-guandu', version: '0.9.4', date: '建安六年 三月',
    hash: 'a1b2c3d4e5f60718',
    save: { v: 1, mapId: 'quanjing', turn: 11, cities: { 邺: { owner: 'yuan' } } },
    logTail: [{ seq: 0, type: 'advanceTurn' }],
    ...extra,
  });
}

function recorder(responder) {
  const calls = [];
  const fn = async (url, opt) => {
    const c = { url: String(url), method: opt.method, headers: opt.headers, body: opt.body };
    calls.push(c);
    const r = responder(c, calls.length - 1) ?? {};
    const status = r.status ?? 200;
    return { status, ok: status >= 200 && status < 300, text: async () => r.text ?? '' };
  };
  return { fn, calls };
}

test('短号：字符集无手抄歧义、长度固定、注入 rng 可复现', () => {
  const rng = () => 0.5;
  const id = makeShortId({ rng });
  assert.equal(id.length, SHORT_ID_LENGTH);
  assert.ok([...id].every((ch) => SHORT_ID_ALPHABET.includes(ch)));
  assert.equal(id, makeShortId({ rng }), '注入 rng 后短号必须确定，便于单测');
  for (const bad of ['0', '1', 'I', 'O']) assert.equal(SHORT_ID_ALPHABET.includes(bad), false);
  assert.equal(normalizeShortId(' k7m-2qp '), 'K7M2QP');
  for (const bad of ['', 'K7M2Q', 'K7M2QP0', 'K7M2Q!', 'abcdefg']) {
    assert.throws(() => normalizeShortId(bad), /6 位/, `${bad} 不该被接受`);
  }
  // 6 位 / 32 字符，空间约 10.7 亿；连续取样不应撞号（确定性 rng 除外）
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(makeShortId());
  assert.ok(seen.size >= 199, '短号随机源退化');
});

test('describeTicket 入库出库都校：空、超长、非法字符、错 game、错存档版本', () => {
  const t = ticket();
  const d = describeTicket(t);
  assert.equal(d.mapId, 'quanjing');
  assert.equal(d.turn, 11);
  assert.equal(d.hash, 'a1b2c3d4e5f60718');
  assert.throws(() => describeTicket(''), /请先粘贴/);
  assert.throws(() => describeTicket('x'.repeat(MAX_TICKET_CHARS + 1)), /字符上限/);
  assert.throws(() => describeTicket('abc+def/ghi'), /非法字符/);
  assert.throws(() => describeTicket(encodeTicket({ game: 'other', save: { v: 1 } })), /不是三国策/);
  assert.throws(() => describeTicket(encodeTicket({ game: 'sanguo-ce-guandu', save: { v: 2 } })), /存档格式不兼容/);
});

test('assertPublicKey 只放行 anon：拦 service_role 字样、JWT role 与登录用户 token', () => {
  assert.equal(assertPublicKey(ANON), ANON);
  assert.ok(assertPublicKey('self-hosted-plain-key'), '自托管非 JWT key 也应可用');
  assert.throws(() => assertPublicKey(''), /缺 anon/);
  assert.throws(() => assertPublicKey('sb_service_role_xxx'), /service_role/);
  assert.throws(() => assertPublicKey(jwt('service_role')), /service_role key/);
  assert.throws(() => assertPublicKey(jwt('authenticated')), /role 是 authenticated/);
});

test('memory store：冲突不覆盖、过期读不到、取后即焚', async () => {
  let clock = Date.parse('2026-11-20T00:00:00Z');
  const store = createMemoryStore({ now: () => clock });
  const t = ticket();
  const a = await putTicket(store, t, { now: () => clock });
  assert.equal(a.id.length, 6);
  const got = await takeTicket(store, a.id);
  assert.equal(got.text, t);
  assert.deepEqual(decodeTicket(got.text), decodeTicket(t));

  // 同一短号再写，应报冲突而不是把别人的帖盖掉
  const r = await store.put({ id: a.id, payload: 'other', expires_at: new Date(clock + 9e5).toISOString() });
  assert.equal(r.conflict, true);
  assert.equal((await takeTicket(store, a.id)).text, t);

  clock += 8 * 24 * 3600 * 1000;
  assert.equal(await takeTicket(store, a.id), null, '七日之期已过');

  const b = await putTicket(store, t, { now: () => clock });
  await takeTicket(store, b.id, { burn: true });
  assert.equal(await takeTicket(store, b.id), null, '取后即焚应删掉该行');
});

test('putTicket 遇主键冲突会换号重试，不覆盖已有帖', async () => {
  const store = createMemoryStore();
  const firstRng = () => 0.11, retryRng = () => 0.79;
  const first = await putTicket(store, ticket(), { rng: firstRng });
  const expected = makeShortId({ rng: retryRng });
  assert.notEqual(first.id, expected, '两次注入 rng 应给出不同短号');
  // 用 id 参数模拟「用户指定了已被占用的号」，第二次应自动换号。
  const rec = await putTicket(store, ticket({ hash: 'ffffffffffffffff' }),
    { id: first.id, rng: retryRng });
  assert.equal(rec.id, expected, '被占用的短号必须换掉');
  assert.equal((await takeTicket(store, first.id)).hash, 'a1b2c3d4e5f60718', '原帖不应被覆盖');
  assert.equal((await takeTicket(store, rec.id)).hash, 'ffffffffffffffff');
});

test('Supabase REST 形状：URL / 头 / 409 冲突 / 空结果 / 过期 / 焚帖', async () => {
  const t = ticket();
  const rec = recorder((c) => {
    if (c.method === 'POST') return { status: 201, text: '' };
    if (c.method === 'DELETE') return { status: 204, text: '' };
    const past = c.url.includes('YYYYYY') ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z';
    if (c.url.includes('ZZZZZZ')) return { status: 200, text: '[]' };
    return {
      status: 200,
      text: JSON.stringify([{ id: 'K7M2QP', payload: t, hash: 'a1b2c3d4e5f60718',
        version: '0.9.4', map_id: 'quanjing', turn: 11, expires_at: past }]),
    };
  });
  const store = createSupabaseStore({
    url: 'https://example.supabase.co/', anonKey: ANON, fetchImpl: rec.fn,
  });
  assert.equal(store.kind, 'supabase');
  assert.equal(store.endpoint, 'https://example.supabase.co/rest/v1/tickets');

  const put = await putTicket(store, t);
  const c0 = rec.calls[0];
  assert.equal(c0.method, 'POST');
  assert.equal(c0.url, 'https://example.supabase.co/rest/v1/tickets');
  assert.equal(c0.headers.apikey, ANON);
  assert.equal(c0.headers.Authorization, `Bearer ${ANON}`);
  assert.equal(c0.headers.Prefer, 'return=minimal');
  assert.equal(JSON.parse(c0.body).payload, t);
  assert.equal(JSON.parse(c0.body).map_id, 'quanjing');
  assert.equal(c0.url.includes(ANON), false, 'key 不能落进 URL query / 日志');

  const got = await takeTicket(store, put.id);
  assert.equal(got.text, t);
  const c1 = rec.calls[1];
  assert.match(c1.url, /select=id,payload,hash,version,map_id,turn,expires_at/);
  assert.match(c1.url, /id=eq\./);

  assert.equal(await takeTicket(store, 'ZZZZZZ'), null, '空数组应返回 null');
  assert.equal(await takeTicket(store, 'YYYYYY'), null, '过期行读侧要过滤');

  await takeTicket(store, put.id, { burn: true });
  assert.ok(rec.calls.some((c) => c.method === 'DELETE' && /id=eq\./.test(c.url)));
});

test('409 视为冲突、非 2xx 抛错、坏 JSON 抛错，都不静默吞', async () => {
  const conflict = recorder(() => ({ status: 409, text: '{"code":"23505","message":"duplicate key"}' }));
  const s1 = createSupabaseStore({ url: 'https://example.supabase.co', anonKey: ANON, fetchImpl: conflict.fn });
  await assert.rejects(() => putTicket(s1, ticket(), { maxRetries: 1 }), /短号连续冲突/);
  assert.equal(conflict.calls.length, 1);

  const fail = recorder(() => ({ status: 401, text: '{"message":"Invalid API key"}' }));
  const s2 = createSupabaseStore({ url: 'https://example.supabase.co', anonKey: ANON, fetchImpl: fail.fn });
  await assert.rejects(() => putTicket(s2, ticket()), /写入失败 401/);

  const bad = recorder(() => ({ status: 200, text: 'not-json' }));
  const s3 = createSupabaseStore({ url: 'https://example.supabase.co', anonKey: ANON, fetchImpl: bad.fn });
  await assert.rejects(() => takeTicket(s3, 'K7M2QP'), /不是 JSON/);
});

test('createRestStore 可换 endpoint / headers，不绑死某一家后端', async () => {
  const rec = recorder(() => ({ status: 201, text: '' }));
  const s = createRestStore({ endpoint: 'https://relay.example.com/t/', headers: { 'X-Token': 't' }, fetchImpl: rec.fn });
  await putTicket(s, ticket());
  assert.equal(rec.calls[0].url, 'https://relay.example.com/t');
  assert.equal(rec.calls[0].headers['X-Token'], 't');
});

test('静态护栏：建表脚本开 RLS、只给 anon 写读删；前端页面不写死任何凭证', () => {
  const sql = read('supabase/schema.sql');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /grant select, insert, delete on public\.tickets to anon/);
  assert.equal(/grant update/.test(sql), false, '短号一旦发出，帖不可被改写');
  for (const p of ['tickets_anon_insert', 'tickets_anon_select', 'tickets_anon_delete']) {
    assert.ok(sql.includes(p), `缺 RLS 策略 ${p}`);
  }
  assert.match(sql, /expires_at <= now\(\) \+ interval '7 days'/);
  const bridge = read('bridge.html');
  assert.match(bridge, /src\/version\.js/, '版本仍只从唯一常量读入');
  assert.equal(bridge.includes('src/main.js'), false, '传帖台不该加载游戏逻辑');
  assert.equal(/AKID|ghp_|sb_secret|SUPABASE_SERVICE/.test(bridge + read('src/ticket-store.js')), false,
    '源码里出现凭证字面量');
  const src = read('src/ticket-store.js');
  assert.match(src, /assertPublicKey/);
  assert.equal(src.includes('stateFingerprint'), false, '中转层不该碰状态指纹');
});


// ── 服务端函数直连：前端零 key ─────────────────────────────────────────────
test('createFunctionStore 请求不带 apikey / Authorization，且 put/get/del 可跑通', async () => {
  const rows = new Map();
  const seen = [];
  const fn = async (url, opt) => {
    seen.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
    const { op, id, rec } = JSON.parse(opt.body);
    if (op === 'put') {
      if (rows.has(rec.id)) return { ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true, conflict: true })) };
      rows.set(rec.id, rec);
      return { ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true })) };
    }
    if (op === 'get') {
      const r = rows.get(id);
      return { ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true, row: r ? { ...r, expires_at: '2099-01-01T00:00:00Z' } : null })) };
    }
    rows.delete(id);
    return { ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true })) };
  };
  const store = createFunctionStore({ endpoint: 'https://example.supabase.co/functions/v1/relay', fetchImpl: fn });
  assert.equal(store.kind, 'function');
  const rec = { id: 'K7M2QP', payload: 'x', hash: '', version: '0.9.4', map_id: 'guandu', turn: 1, expires_at: '2099-01-01T00:00:00Z' };
  assert.deepEqual(await store.put(rec), { conflict: false });
  assert.equal((await store.get('K7M2QP')).payload, 'x');
  assert.equal(await store.del('K7M2QP'), true);
  assert.equal(await store.get('K7M2QP'), null);
  assert.ok(seen.every((r) => !('apikey' in r.headers) && !('Authorization' in r.headers)), '函数模式不许带任何 key');
  assert.ok(seen.every((r) => r.url === 'https://example.supabase.co/functions/v1/relay'));
  assert.deepEqual([...new Set(seen.map((r) => r.body.op))].sort(), ['del', 'get', 'put']);
});

test('createFunctionStore 拒非 https、把服务端 ok:false 当错误抛出', async () => {
  assert.throws(() => createFunctionStore({ endpoint: 'http://x/f', fetchImpl: async () => ({}) }), /https/);
  const bad = createFunctionStore({ endpoint: 'https://x/f', fetchImpl: async () => ({ ok: false, text: () => Promise.resolve('{"ok":false,"error":"库未建"}') }) });
  await assert.rejects(() => bad.get('K7M2QP'), /库未建/);
});
