#!/usr/bin/env node
// 页面可达性烟测：地图真的画出来了、每个能进的层都能退出来、双时钟进出一致。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4400;
const base = process.env.BASE_URL || `http://127.0.0.1:${PORT}/`;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
async function waitPort(port, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

let server = null;
if (!process.env.BASE_URL) {
  server = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs')], {
    cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  if (!(await waitPort(PORT))) { console.error('静态服务未启动'); server.kill(); process.exit(1); }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__sanguo, null, { timeout: 15000 });

  check('页面加载且模块装配完成', await page.isVisible('#mainMenu'));
  check('主菜单展示栅格规模',
    (await page.locator('#menuSub').innerText()).includes('144×108'),
    await page.locator('#menuSub').innerText());
  check('势力可任选（三个选项）',
    (await page.locator('#factionPick option').count()) === 3);

  await page.selectOption('#factionPick', 'yuan');
  check('切换势力后说明同步',
    (await page.locator('#pickNote').innerText()).includes('袁绍'));
  await page.selectOption('#factionPick', 'cao');
  await page.click('#startBtn');
  await page.waitForTimeout(300);
  check('开局进入沙盘，主菜单收起', !(await page.isVisible('#mainMenu')));
  check('顶栏日期为建安五年',
    (await page.locator('#date').innerText()).includes('建安5年'),
    await page.locator('#date').innerText());
  check('资源四数已按地块计算',
    Number(await page.locator('#rGrain').innerText()) > 0);

  // 地图真的画出来了：取一块非背景像素
  const painted = await page.evaluate(() => {
    const c = document.getElementById('map');
    const g = c.getContext('2d');
    const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], w: c.width, h: c.height };
  });
  check('Canvas 有实际地形绘制', painted.r + painted.g + painted.b > 30,
    `rgb(${painted.r},${painted.g},${painted.b}) ${painted.w}×${painted.h}`);

  // 点格子 → 信息卡 + × 可退出
  await page.mouse.click(500, 360);
  await page.waitForTimeout(120);
  check('点格弹出地块信息卡', await page.isVisible('#infoCard'));
  const info = await page.locator('#infoBody').innerText();
  check('信息卡含地形/等级/四资源',
    info.includes('地形') && info.includes('土地等级') && info.includes('木'));
  await page.click('#closeInfoX');
  check('信息卡 × 可退出', !(await page.isVisible('#infoCard')));

  // 玩法面板
  await page.click('#helpBtn');
  check('玩法面板可达', await page.isVisible('#helpPanel'));
  check('玩法面板有 ×', await page.isVisible('#closeHelpX'));
  await page.keyboard.press('Escape');
  check('Esc 可退出玩法面板', !(await page.isVisible('#helpPanel')));

  // 连地铺路：找一个相邻可占格，走真实 UI 命令
  const near = await page.evaluate(() => {
    const w = window.__sanguo;
    const list = w.reachable();
    return list[0] ?? null;
  });
  check('存在可出征/可铺路的相邻地块', !!near, JSON.stringify(near));
  const claim = await page.evaluate((p) => {
    const w = window.__sanguo;
    const from = Object.values(w.state.cities).find((c) => c.owner === w.state.playerFaction);
    return w.issueOrder({ faction: w.state.playerFaction, from: from.id,
      type: 'claim', tile: { c: p.c, r: p.r } });
  }, near);
  check('铺路命令返回在途（非即时）',
    claim.ok && claim.order.arriveTurn > 0, JSON.stringify({ ok: claim.ok, a: claim.order?.arriveTurn }));

  // 双时钟：进入 → 退出 → 策略走几旬 → 再进入快进
  await page.click('#battleBtn');
  await page.waitForTimeout(120);
  check('攻城子界面可达', await page.isVisible('#battleOverlay'));
  check('子界面有醒目 × 退出', await page.isVisible('#closeBattleX'));
  check('子界面显示策略时刻与战斗时刻',
    (await page.locator('#bTurn').innerText()).length > 0 &&
    (await page.locator('#bSec').innerText()).length > 0);
  const secIn = await page.locator('#bSec').innerText();
  await page.click('#leaveBattle');
  check('退出子界面', !(await page.isVisible('#battleOverlay')));
  const snapSec = await page.evaluate(() => window.__sanguo.snapshot?.sec);
  check('退出拍下快照', Number.isFinite(snapSec), `快照 @ ${snapSec}s`);

  for (let i = 0; i < 5; i++) await page.click('#endTurn');
  const { turnNow, per } = await page.evaluate(() => ({
    turnNow: window.__sanguo.state.turn,
    per: window.__sanguo.cfg.calendar.secPerTurn,
  }));
  await page.click('#battleBtn');
  await page.waitForTimeout(120);
  const fast = Number(await page.locator('#bFastSteps').innerText());
  const secNow = Number(await page.locator('#bSec').innerText());
  check('隔 5 旬再进入触发快进',
    fast > 100, `快进 ${fast} 步`);
  // 子界面打开后 rAF 会继续实时推进几帧，所以允许略超目标时刻。
  check('快进后战斗时刻追平策略时刻',
    secNow >= turnNow * per - 0.05 && secNow <= turnNow * per + 1.0,
    `战斗 ${secNow}s / 策略 ${turnNow * per}s`);
  check('二次进入仍可退出', await page.isVisible('#closeBattleX'));
  await page.keyboard.press('Escape');
  check('Esc 可退出子界面', !(await page.isVisible('#battleOverlay')));

  // 缩放 / 回中
  const s0 = await page.evaluate(() => window.__sanguo.renderer.camera.scale);
  await page.click('#zoomIn');
  const s1 = await page.evaluate(() => window.__sanguo.renderer.camera.scale);
  check('缩放按钮生效', s1 > s0, `${s0.toFixed(2)} → ${s1.toFixed(2)}`);
  await page.click('#centerBtn');
  check('回中不报错', true);

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n烟测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
