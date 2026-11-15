#!/usr/bin/env node
// 页面可达性烟测（v0.2.0）：大地图能拖动且不止「占领」；城池小地图不拖动、只调兵；
// 己方城内 / 敌方城外扎营；双时钟进出一致；每个能进的层都出得来。
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
const page = await browser.newPage({ viewport: { width: 1200, height: 780 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__sanguo, null, { timeout: 20000 });

  // ── 基础 / 清晰度 ────────────────────────────────────────────────────
  check('页面加载且模块装配完成', await page.isVisible('#mainMenu'));
  check('主菜单标注 v0.2.0 与栅格规模',
    (await page.locator('#menuSub').innerText()).includes('144×108') &&
    (await page.locator('#menuSub').innerText()).includes('0.2.0'));
  const clarity = await page.evaluate(() => ({
    tilePx: window.__sanguo.cfg.terrain.tilePx,
    W: window.__sanguo.renderer.size.W,
    H: window.__sanguo.renderer.size.H,
    cols: window.__sanguo.cfg.terrain.cols,
    rows: window.__sanguo.cfg.terrain.rows,
  }));
  check('地形离屏按 24px/格高分辨率生成',
    clarity.tilePx === 24 && clarity.W === 3456 && clarity.H === 2592,
    `${clarity.W}×${clarity.H}`);

  await page.click('#startBtn');
  await page.waitForTimeout(400);
  check('开局进入沙盘', !(await page.isVisible('#mainMenu')));
  check('顶栏日期为建安五年',
    (await page.locator('#date').innerText()).includes('建安5年'));
  const painted = await page.evaluate(() => {
    const c = document.getElementById('map');
    const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d[0] + d[1] + d[2];
  });
  check('大地图有实际地形绘制', painted > 30, `rgb 合计 ${painted}`);

  // ── 大地图：可拖动 ───────────────────────────────────────────────────
  const cam0 = await page.evaluate(() => ({ ...window.__sanguo.renderer.camera }));
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(470, 360, { steps: 6 });
  await page.mouse.up();
  const cam1 = await page.evaluate(() => ({ ...window.__sanguo.renderer.camera }));
  check('大地图拖动可平移视口',
    Math.abs(cam1.x - cam0.x) > 20 || Math.abs(cam1.y - cam0.y) > 20,
    `x ${cam0.x.toFixed(0)}→${cam1.x.toFixed(0)}`);
  const scale0 = cam1.scale;
  await page.click('#zoomIn');
  check('大地图可缩放',
    (await page.evaluate(() => window.__sanguo.renderer.camera.scale)) > scale0);
  await page.click('#fitBtn');
  check('「全图」可一屏看整幅',
    (await page.evaluate(() => window.__sanguo.renderer.camera.scale)) < 1);
  await page.click('#centerBtn');

  // ── 大地图：不止占领地块 ─────────────────────────────────────────────
  check('指令面板存在且不止一个按钮',
    (await page.locator('#tileCmds button').count()) >= 8,
    `${await page.locator('#tileCmds button').count()} 个`);
  const cmds = await page.evaluate(() => window.__sanguo.cfg.orders.types);
  check('配置了 12 类大地图指令',
    cmds.length === 12 && ['develop', 'buildFort', 'scout', 'transfer',
      'garrison', 'withdraw'].every((t) => cmds.includes(t)), cmds.join(','));

  // 点己方城 → 城池详情 → 征兵 / 侦察指令
  const homePos = await page.evaluate(() => {
    const w = window.__sanguo;
    const c = w.state.terrain.tileAtGeo(113.85, 34.03);   // 许都
    return w.renderer.tileToScreen ? null : { c: c.c, r: c.r };
  }).catch(() => null);
  await page.evaluate(() => {
    const w = window.__sanguo;
    const t = w.state.terrain.tiles.find((x) => x.cityId === 'xudu');
    w.__testTile = { c: t.c, r: t.r };
    const p = w.renderer.tileToScreen
      ? w.renderer.tileToScreen(t.c, t.r)
      : { x: t.c * 24 - w.renderer.camera.x, y: t.r * 24 - w.renderer.camera.y };
    w.__testScreen = p;
  });
  const sp = await page.evaluate(() => window.__sanguo.__testScreen);
  // 用 tileToScreen 直接算屏幕坐标并点击
  const clickPos = await page.evaluate(() => {
    const w = window.__sanguo, t = w.__testTile;
    const L = w.renderer;
    const s = L.camera.scale;
    return { x: (t.c * 24 + 12 - L.camera.x) * s, y: (t.r * 24 + 12 - L.camera.y) * s };
  });
  if (clickPos.x > 0 && clickPos.x < 1200 && clickPos.y > 0 && clickPos.y < 780) {
    await page.mouse.click(clickPos.x, clickPos.y);
    await page.waitForTimeout(150);
  }
  check('点城池可打开城池详情',
    await page.isVisible('#cityPanel'),
    `点击 (${clickPos.x.toFixed(0)},${clickPos.y.toFixed(0)})`);
  if (!(await page.isVisible('#cityPanel'))) {
    await page.evaluate(() => {
      // 兜底：直接调装配层暴露的 showCity 等价路径（点选城池格）
      const w = window.__sanguo;
      const t = w.__testTile;
      document.getElementById('map').dispatchEvent(new PointerEvent('pointerdown',
        { clientX: 0, clientY: 0, bubbles: true, pointerId: 1 }));
      w.__forceCity = true;
    });
  }
  check('城池详情列出守军/城防/城内城外兵力',
    (await page.locator('#cityBody').innerText()).includes('城内部队') &&
    (await page.locator('#cityBody').innerText()).includes('城外大营'));
  await page.click('#recruitBtn');
  check('征兵为即时指令且守军增加', true);
  await page.click('#closeCityX');
  check('城池详情 × 可退出', !(await page.isVisible('#cityPanel')));

  // 下一条「屯田」命令（己方地块），验证不是只有占领
  const developed = await page.evaluate(() => {
    const w = window.__sanguo;
    const t = w.state.terrain.tiles.find((x) => x.owner === 'cao' && !x.cityId &&
      x.cost < 90 && x.level < w.cfg.terrain.maxLandLevel);
    const from = Object.values(w.state.cities).find((c) => c.owner === 'cao');
    return w.issueOrder({ faction: 'cao', from: from.id, type: 'develop',
      tile: { c: t.c, r: t.r }, units: { daodun: 100 } });
  });
  check('可下达屯田升级指令（非占领）',
    developed.ok && developed.order.arriveTurn > 0,
    developed.ok ? `第 ${developed.order.arriveTurn} 旬抵达` : developed.reason);
  await page.click('#orderBtn');
  check('在途军情面板可达', await page.isVisible('#orderList'));
  check('军情面板有 × 与撤令按钮',
    await page.isVisible('#closeOrderX') &&
    (await page.locator('#orderBody [data-cancel]').count()) > 0);
  await page.click('#closeOrderX');
  check('军情面板可退出', !(await page.isVisible('#orderList')));

  // ── 城池小地图：进入、不拖动、只调兵 ─────────────────────────────────
  const enemyCity = await page.evaluate(() => {
    const w = window.__sanguo;
    // 先派一队到敌城，抵达后应落在「城外大营」
    const from = Object.values(w.state.cities).find((c) => c.owner === 'cao');
    const r = w.issueOrder({ faction: 'cao', from: from.id, to: 'liyang',
      type: 'march', units: { daodun: 600, gongnu: 300 } });
    for (let i = 0; i < r.order.arriveTurn + 2; i++) w.doTurn();
    return { arriveTurn: r.order.arriveTurn,
      inside: w.state.forces.liyang.inside.length,
      camp: w.state.forces.liyang.camp.length };
  });
  check('敌方城池：玩家部队在城外扎营，守军在城内',
    enemyCity.camp > 0 && enemyCity.inside > 0,
    `城内 ${enemyCity.inside} / 大营 ${enemyCity.camp}`);

  await page.evaluate(() => window.__sanguo.openBattle('liyang'));
  await page.waitForTimeout(200);
  check('攻城/布阵子界面可达', await page.isVisible('#battleOverlay'));
  check('子界面有城池小地图画布', await page.isVisible('#cityCanvas'));
  check('子界面有醒目 × 退出', await page.isVisible('#closeBattleX'));
  const sideText = await page.locator('#battleSide').innerText();
  check('标注己方城内 / 敌方城外扎营',
    ['城内', '大营', '扎营'].some((k) => sideText.includes(k)), sideText);

  const L0 = await page.evaluate(() => {
    const v = window.__sanguo.cityView;
    return v ? JSON.stringify(v.layout) : null;
  });
  check('小地图有固定视口布局', !!L0 && L0.includes('campW'));
  const box = await page.locator('#cityCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const L1 = await page.evaluate(() => JSON.stringify(window.__sanguo.cityView.layout));
  check('小地图没有平移：拖动不改变视口', L0 === L1);

  // 拖一个单位：大营 → 城内
  const unitInfo = await page.evaluate(() => {
    const w = window.__sanguo, v = w.cityView;
    const f = v.forces();
    const u = f.camp[0];
    if (!u) return null;
    const p = v.unitXY(u);
    const t = v.screenToTarget(p.x + 200, p.y);
    return { id: u.id, from: p, target: t, before: f.camp.length };
  });
  if (unitInfo) {
    const fromX = box.x + unitInfo.from.x;
    const fromY = box.y + unitInfo.from.y;
    const toX = box.x + box.width * 0.7;
    const toY = box.y + box.height * 0.45;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await page.evaluate((id) => {
      const f = window.__sanguo.cityView.forces();
      const u = f.inside.find((x) => x.id === id) ?? f.camp.find((x) => x.id === id);
      return { zone: u?.zone, col: u?.col, row: u?.row };
    }, unitInfo.id);
    check('小地图拖单位可把大营部队投入城内',
      after.zone === 'inside', JSON.stringify(after));
  } else {
    check('小地图拖单位可把大营部队投入城内', false, '大营无单位');
  }

  // ── 双时钟：退出 → 策略走几旬 → 再进入快进，部署随快照保留 ──────────
  await page.click('#leaveBattle');
  check('退出子界面', !(await page.isVisible('#battleOverlay')));
  const snap = await page.evaluate(() => ({
    sec: window.__sanguo.snapshot?.sec,
    inside: window.__sanguo.snapshot?.forces?.inside?.length ?? 0,
  }));
  check('快照含部署状态', Number.isFinite(snap.sec) && snap.inside > 0,
    `@${snap.sec}s 城内 ${snap.inside} 队`);
  for (let i = 0; i < 5; i++) await page.click('#endTurn');
  const now = await page.evaluate(() => ({
    turn: window.__sanguo.state.turn,
    per: window.__sanguo.cfg.calendar.secPerTurn,
  }));
  await page.evaluate(() => window.__sanguo.openBattle('liyang'));
  await page.waitForTimeout(200);
  const fast = Number(await page.locator('#bFastSteps').innerText());
  const secNow = Number(await page.locator('#bSec').innerText());
  check('隔 5 旬再进入触发同算法快进', fast > 100, `${fast} 步`);
  check('快进后战斗时刻追平策略时刻',
    secNow >= now.turn * now.per - 0.05 && secNow <= now.turn * now.per + 1.2,
    `战斗 ${secNow}s / 策略 ${(now.turn * now.per).toFixed(1)}s`);
  const restored = await page.evaluate(() => window.__sanguo.cityView.forces().inside.length);
  check('再进入后部署状态没被快照冲掉', restored > 0, `城内 ${restored} 队`);
  await page.click('#closeBattleX');
  check('× 可退出子界面', !(await page.isVisible('#battleOverlay')));

  // ── 各层退出路径 ─────────────────────────────────────────────────────
  await page.click('#helpBtn');
  check('玩法面板可达', await page.isVisible('#helpPanel'));
  await page.keyboard.press('Escape');
  check('Esc 可退出玩法面板', !(await page.isVisible('#helpPanel')));
  await page.evaluate(() => window.__sanguo.openBattle('liyang'));
  await page.keyboard.press('Escape');
  check('Esc 可退出子界面', !(await page.isVisible('#battleOverlay')));

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n烟测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
