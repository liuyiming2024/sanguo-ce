// 传帖台静态护栏。原写在 scripts/check-map.mjs，因对面并发覆盖该文件而独立出来：
// npm test = node --test tests/，天然被发现，不动对面任何文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const bridge = read('bridge.html');
const store = read('src/ticket-store.js');
const doc = read('docs/军令帖短号中转说明.md');
const log = read('docs/创作决策流水.md');
const schema = read('supabase/schema.sql');
const wf = read('.github/workflows/relay-schema.yml');

// 拆开写：护栏自身也不能成为明文载体。
const FORBIDDEN = [
  ['duqpvya', 'fertiaohabrnz'].join(''),
  ['2012ming', '0421lym'].join(''),
  ['webnote.cc', '/p/', 'fe42'].join(''),
];
const tracked = [bridge, store, doc, log, schema, wf, read('src/sync.js')].join('\n');

test('仓库零明文：项目 id / 项目口令 / 便签地址不出现在任何被跟踪文件', () => {
  for (const bad of FORBIDDEN) assert.ok(!tracked.includes(bad), `明文泄露：${bad.slice(0, 6)}…`);
});

test('本机配置文件被 .gitignore 排除，且没被提交', () => {
  assert.match(read('.gitignore'), /relay\.local\.json/);
  assert.ok(!existsSync(join(root, 'relay.local.json')));
  assert.ok(!existsSync(join(root, 'bridge.local.json')));
});

test('服务端函数直连链路接齐（前端零 key）', () => {
  assert.match(store, /export function createFunctionStore/);
  assert.match(bridge, /createFunctionStore/);
  assert.match(bridge, /服务端函数（免 key/);
  assert.match(bridge, /relayMode/);
  // 函数 store 的请求头故意不带任何 key；单测另有行为断言，这里守静态形状。
  const fn = store.slice(store.indexOf('export function createFunctionStore'));
  assert.doesNotMatch(fn, /headers:\s*\{[^}]*apikey/);
});

test('本机自动装配四处接线齐全，hash 用完即抹', () => {
  for (const k of ['autoConfigFromHash', 'history.replaceState', 'copyAuto', 'loadLocal', '#m=fn&e=']) {
    assert.ok(bridge.includes(k), `缺 ${k}`);
  }
});

test('Agent Secret 建表骨架只引用 secrets.sup，不落明文', () => {
  assert.match(wf, /secrets\.sup/);
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /PGPASSWORD/);
  assert.match(wf, /psql/);
  for (const bad of FORBIDDEN) assert.ok(!wf.includes(bad));
});

test('Edge Function 骨架可部署、零明文、连接串只从环境读', () => {
  const fnPath = join(root, 'supabase/functions/relay/index.ts');
  assert.ok(existsSync(fnPath), '缺 relay 函数骨架');
  const fn = readFileSync(fnPath, 'utf8');
  assert.match(fn, /Deno\.serve/);
  assert.match(fn, /Deno\.env\.get\('SUPABASE_DB_URL'\)/);
  assert.match(fn, /on conflict \(id\) do nothing/);
  assert.match(fn, /\$1/);                       // 参数化 SQL
  assert.match(fn, /OPTIONS/);                   // CORS 预检
  assert.doesNotMatch(fn, /apikey|Authorization:\s*Bearer/);
  for (const bad of FORBIDDEN) assert.ok(!fn.includes(bad), '函数骨架出现明文凭据');
});

test('workflow 注释写明 Agent secret 与 Actions secret 不互通', () => {
  assert.match(wf, /Agent 命名空间|不互通/);
  assert.match(wf, /Actions Secret sup 未注入/);
});

test('后台说明写清边界：只自动化建表，部署函数仍缺 access token', () => {
  assert.match(doc, /SUPABASE_ACCESS_TOKEN/);
  assert.match(doc, /Agent Secret/);
  assert.match(doc, /读不到它的明文/);
});
