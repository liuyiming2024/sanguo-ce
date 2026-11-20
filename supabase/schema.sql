-- 三国策 · 军令帖短号中转表
--
-- 用法：Supabase 控制台 → SQL Editor → 整段执行（幂等，可重复跑）。
-- 这一层只存「一段字符串 + 6 位取件码」，不存局面、不重放、不裁定胜负。
-- 前端只读 anon public key；RLS 是本表唯一的安全边界，不要关掉它。

create table if not exists public.tickets (
  id          text primary key,
  payload     text        not null check (char_length(payload) between 1 and 20000),
  hash        text        not null default '',
  version     text        not null default '',
  map_id      text        not null default 'guandu',
  turn        integer     not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days')
);

create index if not exists tickets_expires_at_idx on public.tickets (expires_at);

alter table public.tickets enable row level security;

-- 只给匿名角色「写、读、删」，刻意不给 update：短号一旦发出，帖不可被改写。
grant select, insert, delete on public.tickets to anon;

drop policy if exists tickets_anon_insert on public.tickets;
create policy tickets_anon_insert on public.tickets
  for insert to anon
  with check (
    char_length(id) = 6
    and id !~ '[^2-9A-HJ-NP-Z]'
    and char_length(payload) <= 20000
    and expires_at > now()
    and expires_at <= now() + interval '7 days'   -- 客户端不能把 TTL 拉成无限
  );

drop policy if exists tickets_anon_select on public.tickets;
create policy tickets_anon_select on public.tickets
  for select to anon
  using (expires_at > now());

drop policy if exists tickets_anon_delete on public.tickets;
create policy tickets_anon_delete on public.tickets
  for delete to anon
  using (expires_at > now());

-- 过期行不会自动消失，只是 RLS 与客户端都读不到。
-- 想回收空间可定期手工执行（不必上 pg_cron）：
--   delete from public.tickets where expires_at <= now();
--
-- 已知边界（见 docs/军令帖短号中转说明.md）：
--  · 匿名可写 = 任何人都能灌水；免费层不自带速率限制，需要 Edge Function 或网关补。
--  · 短号是「取件码」不是密码，32^6 空间约 10.7 亿，靠不可枚举性而非保密性。
--  · 库里是明文军令帖，不要往帖里放任何凭证、手机号、真实姓名。
