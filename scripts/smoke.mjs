#!/usr/bin/env node
// 页面可达性烟测 v0.3.0：率式整套界面 + 机制修补 + 存档 + 双时钟。
// 原则：每个能进的层都出得来；文治页反纸、武备页留墨；小地图依旧不拖动。
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
  headless: true, executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 780 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const nav = (r, p = {}) => page.evaluate(([r, p]) => window.__sanguo.shell.navigate(r, p), [r, p]);
const routes = () => page.evaluate(() => window.__sanguo.shell.routes);
const tabClick = (id) => page.evaluate((id) =>
  document.querySelector(`[data-tab="${id}"]`)?.click(), id);

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__sanguo, null, { timeout: 20000 });

  // ── 基础 ──────────────────────────────────────────────────────────────
  check('页面加载且模块装配完成', await page.isVisible('#mainMenu'));
  check('主菜单标注 v0.3.0 与栅格规模',
    (await page.locator('#menuSub').innerText()).includes('144×108') &&
    (await page.locator('#menuSub').innerText()).includes('0.3.0'));
  check('界面外壳已接线', await page.evaluate(() => !!window.__sanguo.shell));

  await page.click('#startBtn');
  await page.waitForTimeout(350);
  check('开局进入沙盘', !(await page.isVisible('#mainMenu')));
  check('底部主菜单 Tab 齐全', (await page.locator('#bottomBar [data-tab]').count()) >= 11,
    `${await page.locator('#bottomBar [data-tab]').count()} 个`);
  check('顶栏 HUD 显示势力值 / 铜钱 / 政令 / 天气',
    (await page.locator('#hudPower').innerText()).length > 0 &&
    (await page.locator('#hudWeather').innerText()).length > 0);

  // ── CSS 机制修补（评审最小清单） ──────────────────────────────────────
  const cssMech = await page.evaluate(() => {
    const before = getComputedStyle(document.body, '::before');
    const after = getComputedStyle(document.body, '::after');
    const tools = getComputedStyle(document.getElementById('mapTools'));
    const sheetX = getComputedStyle(document.querySelector('#infoCard .x'));
    return {
      beforeZ: before.zIndex, afterZ: after.zIndex,
      afterBg: after.backgroundImage,
      toolsBottom: tools.bottom,
      sheetXPos: sheetX.position,
    };
  });
  check('装饰层降到地图之上、UI 之下', cssMech.beforeZ === '2' && cssMech.afterZ === '3',
    `${cssMech.beforeZ}/${cssMech.afterZ}`);
  check('金线是贯通渐变而非两个点',
    cssMech.afterBg.includes('linear-gradient') && cssMech.afterBg.includes('12%'),
    cssMech.afterBg.slice(0, 60));
  check('env() 有降级：mapTools.bottom 不是 auto',
    cssMech.toolsBottom !== 'auto' && cssMech.toolsBottom.endsWith('px'), cssMech.toolsBottom);
  check('.x 有基类：sheet 关闭按钮绝对定位', cssMech.sheetXPos === 'absolute');

  const painted = await page.evaluate(() => {
    const c = document.getElementById('map');
    return c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[0] +
      c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[1] +
      c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[2];
  });
  check('大地图有实际地形绘制', painted > 30, `rgb 合计 ${painted}`);

  // ── 大地图：拖动 / 缩放 / 全图 ────────────────────────────────────────
  const cam0 = await page.evaluate(() => ({ ...window.__sanguo.renderer.camera }));
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(470, 360, { steps: 6 });
  await page.mouse.up();
  const cam1 = await page.evaluate(() => ({ ...window.__sanguo.renderer.camera }));
  check('大地图单指拖动可平移',
    Math.abs(cam1.x - cam0.x) > 20 || Math.abs(cam1.y - cam0.y) > 20,
    `x ${cam0.x.toFixed(0)}→${cam1.x.toFixed(0)}`);
  await page.click('#zoomIn');
  check('可缩放', (await page.evaluate(() => window.__sanguo.renderer.camera.scale)) > cam1.scale);
  await page.click('#fitBtn');
  check('「全」可一屏看整幅', (await page.evaluate(() => window.__sanguo.renderer.camera.scale)) < 1);
  await page.click('#centerBtn');

  // ── 整套界面：每个 Tab 可进、可出 ────────────────────────────────────
  const TABS = ['interior', 'heroes', 'tactics', 'army', 'reports', 'mail',
    'tasks', 'alliance', 'world', 'system'];
  for (const t of TABS) {
    await tabClick(t);
    await page.waitForTimeout(60);
    const ok = await page.isVisible('#screen') && (await routes()).includes(t);
    check(`Tab「${t}」可达`, ok);
  }
  check('每层都有 × 与返回',
    await page.isVisible('#screen .x') && await page.isVisible('#screen .back'));
  check('.scrHead 建立定位上下文，标题栏 × 是 flex item',
    await page.evaluate(() => {
      const h = document.querySelector('.scrHead');
      const x = document.querySelector('.scrHead .x');
      return getComputedStyle(h).position === 'relative' && getComputedStyle(x).position === 'static';
    }));

  // 文治页反纸 / 武备页留墨
  await nav('interior');
  const paper = await page.evaluate(() => ({
    tone: document.getElementById('screen').dataset.tone,
    color: getComputedStyle(document.querySelector('#screen .scrBody')).color,
    bg: getComputedStyle(document.querySelector('#screen .scrBody')).backgroundImage,
  }));
  check('文治页反一张蚕白纸底', paper.tone === 'paper' &&
    paper.color === 'rgb(32, 37, 31)' && paper.bg.includes('linear-gradient'), paper.tone);
  check('纸面右下有朱印', await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('#screen .scrBody'), '::before');
    return s.content.includes('政') && s.backgroundImage.includes('linear-gradient');
  }));
  await nav('heroes');
  check('武备页仍是墨底', await page.evaluate(() =>
    document.getElementById('screen').dataset.tone === 'ink'));

  // 内政：设施总览 → 详情 → 升级
  await nav('interior');
  check('设施俯视图：军事 / 城主府 / 内政三栏',
    (await page.locator('.facilityGrid .facCol').count()) === 3);
  check('设施卡片数量完整', (await page.locator('.fac').count()) >= 16,
    `${await page.locator('.fac').count()} 个`);
  await nav('facility', { id: 'chengzhufu' });
  check('设施详情含升级消耗与效果', (await page.locator('#screen').innerText()).includes('升级消耗'));
  const upBefore = await page.evaluate(() => {
    const w = window.__sanguo;
    for (const k of ['wood', 'stone', 'iron', 'grain']) w.state.resources.cao[k] = 999999;
    return w.state.facilities.chengzhufu;
  });
  await page.evaluate(() => window.__sanguo.actions.upgradeFacility('chengzhufu'));
  const upAfter = await page.evaluate(() => window.__sanguo.state.facilities.chengzhufu);
  check('升级真生效且立即刷新产出', upAfter === upBefore + 1 || upBefore >= 10,
    `Lv.${upBefore} → Lv.${upAfter}`);

  // 武将详情：五维雷达（不是「圆圈中间一个汉字」）
  await nav('hero', { id: 'caocao' });
  check('武将详情有五边形雷达与五维条',
    (await page.locator('#screen svg polygon').count()) >= 2 &&
    (await page.locator('#screen .dimRow').count()) === 5);
  // 战法
  await nav('tactics');
  check('战法库全部为军师计策，无魔法兵种',
    (await page.locator('#screen .card').count()) >= 6 &&
    (await page.locator('#screen').innerText()).includes('军师为辅助') &&
    await page.evaluate(() => !window.__sanguo.cfg.units.wizard && !window.__sanguo.cfg.units.giant));

  // 部队编成 → 配将
  await nav('army');
  check('部队三位置（大营 / 中军 / 前锋）', (await page.locator('#screen .slots').count()) === 3);
  await nav('heroPick', { army: 1, slot: 0 });
  check('配将页可达', (await routes()).includes('heroPick'));
  await page.evaluate(() => window.__sanguo.actions.assignHero(1, 0, 'guojia'));
  check('配将写入部队状态', await page.evaluate(() =>
    window.__sanguo.state.armies[1].slots[0] === 'guojia'));

  // 出征页：胜负预判 + 行军时间
  await nav('march', { army: 0, cityId: 'liyang', km: 210, turns: 5, adjacent: true });
  const marchTxt = await page.locator('#screen').innerText();
  check('出征页含预判 / 行军回合 / 体力', marchTxt.includes('预计抵达') &&
    marchTxt.includes('体力消耗') &&
    ['兵不血刃', '损失在所难免', '杀敌一千', '敌军兵力强盛'].some((k) => marchTxt.includes(k)));

  // 列表页：战报 / 邮件 / 任务 / 同盟 / 天下
  await nav('reports');
  check('战报列表可达（含空态）', (await page.locator('#screen').innerText()).includes('战报'));
  await nav('mail');
  check('邮件列表有条目', (await page.locator('#screen .listRow').count()) >= 3);
  await nav('mailRead', { id: 'm1' });
  check('邮件可展开阅读', (await page.locator('#screen .readBody').innerText()).length > 20);
  await nav('tasks');
  check('任务页有进度条', (await page.locator('#screen .progress').count()) >= 5);
  await nav('alliance');
  check('同盟页有成员与捐献', (await page.locator('#screen').innerText()).includes('捐献'));
  await nav('world');
  check('天下页列出三势力形势', (await page.locator('#screen .troopCard').count()) >= 3);
  await nav('system');
  check('系统页有存档 / 停绘 / 吸附开关',
    (await page.locator('#screen').innerText()).includes('保存进度') &&
    (await page.locator('#screen').innerText()).includes('静止时停绘'));

  // Esc 逐级退出，逐层回到地图
  await nav('interior');
  await nav('facility', { id: 'minju' });
  check('导航栈深度为 2', (await routes()).length === 2);
  await page.keyboard.press('Escape');
  check('Esc 退一层回到内政', (await routes()).length === 1 && (await routes())[0] === 'interior');
  await page.keyboard.press('Escape');
  check('Esc 退回大地图', (await routes()).length === 0 && !(await page.isVisible('#screen')));

  // ── 存档：保存 → 刷新 → 继续上一局 ───────────────────────────────────
  await page.evaluate(() => window.__sanguo.shell.closeAll());
  for (let i = 0; i < 4; i++) await page.click('#endTurn');
  const turnBefore = await page.evaluate(() => window.__sanguo.state.turn);
  const saved = await page.evaluate(() => window.__sanguo.saveGame());
  check('存档写入本机', saved === true || saved === undefined);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__sanguo, null, { timeout: 20000 });
  check('刷新后主菜单出现「继续上一局」', await page.isVisible('#continueBtn'));
  check('存档摘要显示回合与势力',
    (await page.locator('#saveTip').innerText()).includes(`第 ${turnBefore} 旬`));
  await page.click('#continueBtn');
  await page.waitForTimeout(200);
  const turnAfter = await page.evaluate(() => window.__sanguo.state.turn);
  check('续局回到保存时的回合', turnAfter >= turnBefore && turnAfter < turnBefore + 3,
    `第 ${turnBefore} → ${turnAfter} 旬`);
  check('续局恢复了设施与部队编成', await page.evaluate(() =>
    window.__sanguo.state.facilities.chengzhufu >= 5 &&
    window.__sanguo.state.armies[1].slots[0] === 'guojia'));

  // ── 静止停绘 ──────────────────────────────────────────────────────────
  await page.evaluate(() => window.__sanguo.actions.setAuto(false));
  await page.waitForTimeout(400);
  const snapA = await page.evaluate(() => document.getElementById('map').toDataURL());
  await page.waitForTimeout(350);
  const snapB = await page.evaluate(() => document.getElementById('map').toDataURL());
  check('静止时不重绘（省电）', snapA === snapB);
  await page.click('#zoomIn');
  await page.waitForTimeout(120);
  const snapC = await page.evaluate(() => document.getElementById('map').toDataURL());
  check('有交互后恢复绘制', snapB !== snapC);
  await page.evaluate(() => window.__sanguo.actions.setAuto(true));

  // ── 地块 sheet 与命令 ─────────────────────────────────────────────────
  const developed = await page.evaluate(() => {
    const w = window.__sanguo;
    const t = w.state.terrain.tiles.find((x) => x.owner === 'cao' && !x.cityId &&
      x.cost < 90 && x.level < w.cfg.terrain.maxLandLevel);
    const from = Object.values(w.state.cities).find((c) => c.owner === 'cao');
    return w.issueOrder({ faction: 'cao', from: from.id, type: 'develop',
      tile: { c: t.c, r: t.r }, units: { daodun: 100 } });
  });
  check('大地图可下屯田指令（不止占领）', developed.ok, developed.ok ? `第 ${developed.order.arriveTurn} 旬抵达` : developed.reason);
  await page.click('#orderBtn');
  check('军情面板可达且有 × 与撤令', await page.isVisible('#orderList') &&
    await page.isVisible('#closeOrderX') &&
    (await page.locator('#orderBody [data-cancel]').count()) > 0);
  await page.click('#closeOrderX');

  // ── 城池小地图：不拖动、只调兵 ───────────────────────────────────────
  const enemyCity = await page.evaluate(() => {
    const w = window.__sanguo;
    const from = Object.values(w.state.cities).find((c) => c.owner === 'cao');
    const r = w.issueOrder({ faction: 'cao', from: from.id, to: 'liyang',
      type: 'march', units: { daodun: 600, gongnu: 300 } });
    if (r.ok) for (let i = 0; i < r.order.arriveTurn + 2; i++) w.doTurn();
    return { inside: w.state.forces.liyang.inside.length, camp: w.state.forces.liyang.camp.length };
  });
  check('敌方城池：玩家部队在城外扎营，守军在城内',
    enemyCity.camp > 0 && enemyCity.inside > 0,
    `城内 ${enemyCity.inside} / 大营 ${enemyCity.camp}`);
  await page.evaluate(() => window.__sanguo.openBattle('liyang'));
  await page.waitForTimeout(180);
  check('攻城 / 布阵子界面可达', await page.isVisible('#battleOverlay'));
  check('子界面有城池小地图与醒目 ×', await page.isVisible('#cityCanvas') && await page.isVisible('#closeBattleX'));
  const sideText = await page.locator('#battleSide').innerText();
  check('标注己方城内 / 敌方城外扎营', ['城内', '大营', '扎营'].some((k) => sideText.includes(k)), sideText);

  const L0 = await page.evaluate(() => JSON.stringify(window.__sanguo.cityView.layout));
  const box = await page.locator('#cityCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  check('小地图没有平移：拖动不改变视口',
    L0 === await page.evaluate(() => JSON.stringify(window.__sanguo.cityView.layout)));

  const unitInfo = await page.evaluate(() => {
    const v = window.__sanguo.cityView, f = v.forces();
    const u = f.camp[0];
    return u ? { id: u.id, from: v.unitXY(u) } : null;
  });
  if (unitInfo) {
    await page.mouse.move(box.x + unitInfo.from.x, box.y + unitInfo.from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.45, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await page.evaluate((id) => {
      const f = window.__sanguo.cityView.forces();
      const u = f.inside.find((x) => x.id === id) ?? f.camp.find((x) => x.id === id);
      return u?.zone;
    }, unitInfo.id);
    check('拖大营部队可投入城内', after === 'inside', String(after));
  } else check('拖大营部队可投入城内', false, '大营无单位');

  // 矮屏：底部退出按钮不被裁
  await page.setViewportSize({ width: 390, height: 667 });
  await page.waitForTimeout(120);
  check('矮屏上退出按钮仍在可滚区域内', await page.evaluate(() => {
    const o = document.getElementById('battleOverlay');
    const b = document.getElementById('leaveBattle');
    return getComputedStyle(o).overflowY === 'auto' && b.getBoundingClientRect().height > 0 &&
      b.getBoundingClientRect().top < o.scrollHeight + 200;
  }));
  await page.setViewportSize({ width: 1200, height: 780 });

  // ── 双时钟 ────────────────────────────────────────────────────────────
  await page.click('#leaveBattle');
  const snapInfo = await page.evaluate(() => ({
    sec: window.__sanguo.snapshot?.sec,
    inside: window.__sanguo.snapshot?.forces?.inside?.length ?? 0,
  }));
  check('退出拍快照且保留部署', Number.isFinite(snapInfo.sec) && snapInfo.inside > 0,
    `@${snapInfo.sec}s 城内 ${snapInfo.inside} 队`);
  for (let i = 0; i < 5; i++) await page.click('#endTurn');
  const now = await page.evaluate(() => ({
    turn: window.__sanguo.state.turn, per: window.__sanguo.cfg.calendar.secPerTurn,
  }));
  await page.evaluate(() => window.__sanguo.openBattle('liyang'));
  await page.waitForTimeout(180);
  const fast = Number(await page.locator('#bFastSteps').innerText());
  const secNow = Number(await page.locator('#bSec').innerText());
  check('隔 5 旬再进入触发同算法快进', fast > 100, `${fast} 步`);
  check('快进后战斗时刻追平策略时刻',
    secNow >= now.turn * now.per - 0.05 && secNow <= now.turn * now.per + 1.2,
    `战斗 ${secNow}s / 策略 ${(now.turn * now.per).toFixed(1)}s`);
  check('再进入后部署状态没被快照冲掉',
    (await page.evaluate(() => window.__sanguo.cityView.forces().inside.length)) > 0);
  await page.keyboard.press('Escape');
  check('Esc 可退出城池界面', !(await page.isVisible('#battleOverlay')));

  // 玩法面板
  await page.click('#helpBtn');
  check('玩法面板可达', await page.isVisible('#helpPanel'));
  await page.click('#closeHelp');
  check('玩法面板可退出', !(await page.isVisible('#helpPanel')));

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n烟测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
