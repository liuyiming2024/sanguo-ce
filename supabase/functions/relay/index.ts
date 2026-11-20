// 三国策 · 军令帖短号中转（服务端直连）
//
// 部署：supabase functions deploy relay --project-ref <ref>
// 前置：supabase/schema.sql 已在 SQL Editor 执行过。
//
// 凭据边界（本文件的全部意义）：
//  · 连接串只从环境变量读，绝不写进源码、绝不回给前端。
//    SUPABASE_DB_URL 是 Edge Function 运行时内置；若你的项目没注入，
//    在项目 Secrets 里设 DATABASE_URL 亦可（二选一，形状见 docs）。
//  · 前端 createFunctionStore() 不带任何鉴权请求头，
//    所以本函数不需要校验 anon key；它自己就是唯一入口。
//  · 错误只回泛化文案，细节进服务端日志，避免把库结构/连接信息漏出去。
//
// 契约（与 src/ticket-store.js 的 createFunctionStore 逐字对齐）：
//   POST { op:'put'|'get'|'del', id?, rec? }
//   → { ok:true, conflict?:boolean, row?:object } | { ok:false, error }
//
// 已知边界：无速率限制、无审计日志、过期行不自动清理；短号是取件码不是密码。

import { Pool } from 'npm:pg@16';

const CORS = {
  'Access-Control-Allow-Origin': '*',           // 公开无 key 中转，不含 Cookie / 凭据
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const ID_RE = /^[2-9A-HJ-NP-Z]{6}$/;
const MAX_PAYLOAD = 20000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const conn = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
const pool = conn ? new Pool({ connectionString: conn, max: 3, idleTimeoutMillis: 10000 }) : null;

function fail(e) {
  console.error('[relay]', e);
  return json({ ok: false, error: '中转暂不可用，请稍后再试' }, 200);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: '只收 POST' }, 405);
  if (!pool) return json({ ok: false, error: '服务端未配置数据库连接串' }, 200);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: '请求体不是 JSON' }, 200); }
  const { op, id, rec } = body ?? {};
  if (!['put', 'get', 'del'].includes(op)) return json({ ok: false, error: 'op 非法' }, 200);
  if (typeof id !== 'string' || !ID_RE.test(id)) return json({ ok: false, error: '短号格式不符' }, 200);

  const client = await pool.connect();
  try {
    if (op === 'put') {
      const p = String(rec?.payload ?? '');
      if (!p || p.length > MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(p)) {
        return json({ ok: false, error: '军令帖格式或长度不符' }, 200);
      }
      // 过期时间服务端重算，不信客户端（与 schema.sql 的 RLS with check 同口径）。
      const expires = new Date(Date.now() + TTL_MS).toISOString();
      const r = await client.queryArray(
        `insert into public.tickets (id, payload, hash, version, map_id, turn, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`,
        [id, p, String(rec?.hash ?? ''), String(rec?.version ?? ''),
         String(rec?.map_id ?? 'guandu'), Number(rec?.turn ?? 0) | 0, expires],
      );
      return json({ ok: true, conflict: (r.rowCount ?? 0) === 0 });
    }
    if (op === 'get') {
      const r = await client.queryObject(
        `select payload, hash, version, map_id, turn, expires_at
           from public.tickets where id = $1 and expires_at > now()`, [id]);
      const row = r.rows[0] ?? null;
      return json({ ok: true, row: row ? { ...row, expires_at: String(row.expires_at) } : null });
    }
    await client.queryArray('delete from public.tickets where id = $1', [id]);
    return json({ ok: true });
  } catch (e) { return fail(e); }
  finally { client.release(); }
});
