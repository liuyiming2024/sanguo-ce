// 传帖台真浏览器点按验证（手动跑，不挂 CI：需要 Playwright + Chromium）
//   node scripts/bridge-smoke.mjs
//
// 用 playwright 的 route 拦截 /rest/v1/tickets，起一个内存假 PostgREST，
// 因此 **不连任何真实 Supabase 项目**；RLS / CORS / 控制台建表都不在这里验。
// 见 docs/军令帖短号中转说明.md §九。

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeTicket } from '../src/sync.js';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try { ({ chromium } = require('/usr/local/lib/node_modules/playwright')); }
  catch {
    console.error('缺 Playwright：请全局或本地安装 playwright 后重跑（CI 不跑本脚本）');
    process.exit(2);
  }
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 4413);
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
await new Promise((r) => setTimeout(r, 900));

const launch = { headless: true, args: ['--no-sandbox'] };
if (existsSync('/usr/bin/google-chrome')) launch.executablePath = '/usr/bin/google-chrome';
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
const requested = [];
let sawAnonHeader = false;
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (r) => requested.push(r.url()));

const rows = new Map();
await page.route('**/rest/v1/tickets*', async (route) => {
  const req = route.request(), u = new URL(req.url());
  if (req.method() === 'POST') {
    sawAnonHeader = (req.headers()['apikey'] || '') === 'test-anon-key';
    const b = JSON.parse(req.postData() || '{}');
    rows.set(b.id, { ...b, expires_at: b.expires_at || '2099-01-01T00:00:00Z' });
    await route.fulfill({ status: 201, contentType: 'application/json', body: '' });
  } else if (req.method() === 'DELETE') {
    const id = (u.searchParams.get('id') || '').replace('eq.', '');
    rows.delete(id);
    await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
  } else {
    const id = (u.searchParams.get('id') || '').replace('eq.', '');
    const r = rows.get(id);
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: r ? JSON.stringify([{ id: r.id, payload: r.payload, hash: r.hash,
        version: r.version, map_id: r.map_id, turn: r.turn, expires_at: r.expires_at }]) : '[]' });
  }
});

const ticket = encodeTicket({
  v: 1, game: 'sanguo-ce-guandu', version: '0.9.4', date: '建安六年 三月',
  hash: 'a1b2c3d4e5f60718',
  save: { v: 1, mapId: 'quanjing', turn: 11, cities: { 邺: { owner: 'yuan' } } },
  logTail: [{ seq: 0, type: 'advanceTurn' }],
});

const checks = [];
const ck = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

try {
  await page.goto(`http://127.0.0.1:${PORT}/bridge.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-version]')?.textContent !== '—', { timeout: 10000 });
  ck('传帖台加载无 JS 报错', errors.length === 0, errors.join(' | '));
  ck('版本从唯一常量注入', (await page.textContent('[data-version]')).trim() === '0.9.4');
  ck('不加载游戏主逻辑', !requested.some((u) => u.includes('/src/main.js')));

  // 早期脚本这里写成 locator(...).count() 未 await，Promise 恒真 → 断言失效；逐个 await 后才是真检查。
  const ids = ['supaUrl', 'supaKey', 'postText', 'doPost', 'getId', 'doGet', 'doBurn', 'cfgNote'];
  let allFields = true;
  for (const id of ids) if ((await page.locator('#' + id).count()) !== 1) allFields = false;
  ck('发帖 / 取帖 / 配置区齐全', allFields);

  await page.fill('#supaUrl', 'https://example.supabase.co');
  await page.fill('#supaKey', 'test-anon-key');
  await page.click('#saveCfg');
  ck('配置记于本机有独立提示', (await page.textContent('#cfgNote')).includes('已记于本机'));

  await page.fill('#postText', ticket);
  await page.click('#doPost');
  await page.waitForTimeout(200);
  const short = (await page.textContent('#shortId')).trim();
  ck('发帖换得六位短号', /^[2-9A-HJ-NP-Z]{6}$/.test(short), short);
  ck('发帖失败框未亮', await page.locator('#postErr').isHidden(), await page.textContent('#postErr'));
  ck('POST 已带 anon 头、key 不在 URL', rows.size === 1 && sawAnonHeader &&
    !requested.some((u) => u.includes('test-anon-key')));

  await page.fill('#getId', short.toLowerCase());
  await page.click('#doGet');
  await page.waitForTimeout(200);
  ck('凭短号取回整帖并显示旬次', (await page.textContent('#gTurn')).includes('第 11 旬'));
  ck('指纹与图幅正确', (await page.textContent('#gHash')).includes('a1b2c3d4') &&
    (await page.textContent('#gMap')) === 'quanjing');
  ck('复制整帖按钮可用', !(await page.locator('#copyTicket').isDisabled()));

  await page.click('#doBurn');
  await page.waitForTimeout(150);
  await page.click('#doGet');
  await page.waitForTimeout(150);
  ck('取后即焚后凭号取不到', !(await page.locator('#getErr').isHidden()) &&
    (await page.textContent('#getErr')).includes('无此短号'));

  // service_role 明文必须被拒，且不给页面留下可用配置
  await page.fill('#supaKey', 'sb_service_role_xxx');
  await page.fill('#postText', ticket);
  await page.click('#doPost');
  await page.waitForTimeout(150);
  ck('service_role key 被前端硬拦', (await page.textContent('#postErr')).includes('service_role'));
  ck('全程零 JS 报错', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  srv.kill();
}

const bad = checks.filter((c) => !c.ok);
console.log(`\n传帖台真浏览器验证：${checks.length - bad.length}/${checks.length} 通过`);
process.exit(bad.length ? 1 : 0);
