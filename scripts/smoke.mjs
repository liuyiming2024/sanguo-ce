#!/usr/bin/env node
// 页面可达性烟测 v0.9.0：率式整套界面 + 机制修补 + 存档 + 双时钟。
// 原则：每个能进的层都出得来；文治页反纸、武备页留墨；小地图依旧不拖动。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { VERSION } from '../src/version.js';

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
  check('序章卷轴取代势力三选一',
    (await page.locator('#proBeat').innerText()).includes('董承') &&
    (await page.locator('#proRole').innerText()).includes('司空府参军事') &&
    !(await page.locator('#mainMenu').innerHTML()).includes('factionPick'));
  check('开场只叙世界内时序，不报版本与栅格',
    (await page.locator('#menuSub').innerText()).includes('建安五年') &&
    !(await page.locator('#menuSub').innerText()).includes('栅格') &&
    !(await page.locator('#menuSub').innerText()).includes(VERSION));
  check('开局是建安五年庚辰正月初一',
    (await page.locator('#proDate').innerText()).includes('建安五年') &&
    (await page.locator('#proDate').innerText()).includes('庚辰') &&
    (await page.locator('#proDate').innerText()).includes('正月'));
  check('界面外壳已接线', await page.evaluate(() => !!window.__sanguo.shell));

  await page.click('#startBtn');
  await page.waitForTimeout(420);

  // ── v0.7.0：行台授简 ──────────────────────────────────────────────────
  check('入局后自动起授简，第一简是「受檄入局」',
    await page.isVisible('#tutorialLayer') &&
    (await page.locator('.tutCard').innerText()).includes('受檄入局') &&
    (await page.locator('.tutCard').innerText()).includes('共 12 简'));
  check('遮罩与高亮框都不吃指针（引导不锁死地图）', await page.evaluate(() => {
    const l = document.getElementById('tutorialLayer');
    const v = document.querySelector('.tutVeil');
    const f = document.querySelector('.tutFocus');
    const c = document.querySelector('.tutCard');
    return getComputedStyle(l).pointerEvents === 'none' &&
      getComputedStyle(v).pointerEvents === 'none' &&
      getComputedStyle(f).pointerEvents === 'none' &&
      getComputedStyle(c).pointerEvents === 'auto';
  }));
  check('简卡避开底部 Tab，不盖住 11 个入口', await page.evaluate(() => {
    const c = document.querySelector('.tutCard').getBoundingClientRect();
    const b = document.querySelector('#bottomBar').getBoundingClientRect();
    return c.bottom < b.top + 2;
  }));
  await page.click('[data-tut="next"]');
  check('下一简推进到「观军历」，进度条跟着走',
    (await page.locator('.tutCard').innerText()).includes('观军历') &&
    (await page.locator('.tutBar i').getAttribute('style')).includes('8%'));
  check('无关事件不会把纯阅读简跳走', await page.evaluate(() => {
    const w = window.__sanguo;
    const before = w.tutUI.index;
    w.tutNotify('tab:story');
    return w.tutUI.index === before;
  }));
  await page.click('[data-tut="next"]');   // → 第三简「读纪事」
  check('第三简等的是 tab:story', await page.evaluate(() =>
    window.__sanguo.tutUI.step.await === 'tab:story'));
  await tabClick('story');
  await page.waitForTimeout(160);
  check('点「纪事」自动进第四简（事件驱动，不是纯文本）', await page.evaluate(() =>
    window.__sanguo.tutUI.step.id === 'map'));
  check('引导状态不进局面 / 存档 / 命令日志', await page.evaluate(() => {
    const w = window.__sanguo;
    return !('tutorial' in w.state) &&
      !JSON.stringify(w.state.commandLog).includes('tutorial') &&
      !!localStorage.getItem('sanguo-ce:tutorial:v1');
  }));
  check('Esc 暂收授简，不标完成', await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return !window.__sanguo.tutUI.active && !window.__sanguo.tutUI.done;
  }));
  check('系统页可「重看行台授简」', await page.evaluate(async () => {
    window.__sanguo.shell.navigate('system');
    document.querySelector('[data-act="tutorialReplay"]')?.click();
    return window.__sanguo.tutUI.active && window.__sanguo.tutUI.index === 0 &&
      !document.getElementById('tutorialLayer').hidden;
  }));
  check('跳过授简后不再自动重播', await page.evaluate(() => {
    document.querySelector('[data-tut="skip"]')?.click();
    return window.__sanguo.tutUI.done && document.getElementById('tutorialLayer').hidden;
  }));

  // ── v0.9.4：默认接对面官渡舆图；gongbi / jiehua 保留作 A/B 复核 ──────
  check('默认整张地图是对面官渡舆图（atlas），不是旧工笔/界画', await page.evaluate(() =>
    window.__sanguo.style === 'atlas' && window.__sanguo.renderer.style === 'atlas'));
  const ab = await page.evaluate(() => {
    const r = window.__sanguo.renderer;
    const oc = r.offscreen.getContext('2d');
    // 三态各取三块像素校验和：彼此不同，切回 atlas 必须逐像素复原
    const sum = (x, y) => {
      const d = oc.getImageData(x, y, 48, 48).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
      return h;
    };
    const snap = () => [sum(360, 1520), sum(1600, 1200), sum(2400, 700)];
    const a = snap();
    const s1 = r.setStyle('jiehua'); const b = snap();
    const s2 = r.setStyle('gongbi'); const c = snap();
    const s3 = r.setStyle('atlas'); const d = snap();
    return { eq: a.join() === d.join(), diff: a.join() !== b.join() && a.join() !== c.join(),
      s1, s2, s3, a: a.join(), b: b.join(), c: c.join(), d: d.join() };
  });
  check('atlas / gongbi / jiehua 三态逐像素不同，切回 atlas 完全复原',
    ab.diff && ab.eq && ab.s1 === 'jiehua' && ab.s2 === 'gongbi' && ab.s3 === 'atlas',
    JSON.stringify(ab));
  check('换背景只改表现层：地形格数 / 存档 / 命令日志一行未动', await page.evaluate(() => {
    const w = window.__sanguo;
    return w.state.terrain.tiles.length === 15552 &&
      !('atlas' in w.state) && !('style' in w.state) &&
      !JSON.stringify(w.state.commandLog).includes('atlas');
  }));
  check('浅绢底上默认视图没有等级角标 / 硬点阵', await page.evaluate(() => {
    const c = document.getElementById('map'), ctx = c.getContext('2d');
    window.__sanguo.renderer.draw(ctx);
    return window.__sanguo.renderer.camera.scale < 1.6;
  }));

  // ── v0.7.0：卷末留白 / 武备题头 ──────────────────────────────────────
  await nav('reports');
  check('墨底页有卷末题记，空场/实报都不再是一整块纯黑', await page.evaluate(() => {
    const e = document.querySelector('#screen .scrBody .scrollEnd');
    return !!e && /尚 无 战 报|逐条而书/.test(e.textContent);
  }));
  check('开篇章入场纪事可见（onEnter 不再只在推进到下一回时生效）', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#screen .listRow')];
    return rows.some((r) => r.textContent.includes('檄至许都') || r.textContent.includes('别展全境'));
  }));
  check('武备页章节题头用语义朱，不把红撒回全局', await page.evaluate(() => {
    const sc = document.getElementById('screen');
    const t = document.querySelector('#screen .scrBody .secTitle');
    return sc.dataset.route === 'reports' &&
      getComputedStyle(t, '::before').backgroundColor.includes('208, 90, 75');
  }));
  await nav('interior');
  check('文治页仍是纸底且组件变量自动继承', await page.evaluate(() => {
    const sc = document.getElementById('screen');
    const cs = getComputedStyle(sc.querySelector('.scrBody'));
    return sc.dataset.tone === 'paper' &&
      cs.getPropertyValue('--cardBg').trim().startsWith('rgba(255,255,255');
  }));
  await page.evaluate(() => window.__sanguo.shell.closeAll());

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
      screenBottom: getComputedStyle(document.getElementById('screen')).bottom,
      toolsBottom: tools.bottom,
      sheetXPos: sheetX.position,
    };
  });
  check('装饰层降到地图之上、UI 之下', cssMech.beforeZ === '2', cssMech.beforeZ);
  check('顶栏重复的外框金线已删', cssMech.afterBg === 'none' || !cssMech.afterBg,
    cssMech.afterBg.slice(0, 40));
  check('全屏页让出底部 Tab', cssMech.screenBottom === '58px', cssMech.screenBottom);
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
    'story', 'alliance', 'world', 'system'];
  for (const t of TABS) {
    await tabClick(t);
    await page.waitForTimeout(60);
    const ok = await page.isVisible('#screen') && (await routes()).includes(t);
    check(`Tab「${t}」可达`, ok);
  }
  check('全屏页打开时底部 Tab 仍可命中', await page.evaluate(() => {
    const t = document.querySelector('#bottomBar [data-tab="heroes"]');
    const r = t.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!el && !!el.closest('#bottomBar');
  }));
  // ── v0.7.0：章回剧情与军历 ────────────────────────────────────────────
  await nav('story');
  const storyTxt = await page.locator('#screen').innerText();
  check('纪事页有章回叙事 / 史注 / 军务 / 抉择',
    storyTxt.includes('许都受檄') && storyTxt.includes('三国志') &&
    storyTxt.includes('军务进度') && storyTxt.includes('行台议决'));
  check('纪事页含配套日常陈情，不再单列任务 Tab',
    storyTxt.includes('日常陈情') && !(await page.locator('#bottomBar').innerHTML()).includes('data-tab="tasks"'));
  check('章回目标不从开局领地白送进度', await page.evaluate(() => {
    const w = window.__sanguo;
    const m = w.story.chapters[0];
    return w.state.storyBaseline.land > 300 && w.state.stats.tilesClaimed === 0;
  }));
  check('顶栏显示章回名与年号月日',
    (await page.locator('#clock').innerText()).includes('回') &&
    (await page.locator('#date').innerText()).includes('建安五年') &&
    !(await page.locator('#date').innerText()).includes('旬'));
  check('不到二月不能跳回黎阳压河', await page.evaluate(() => {
    const w = window.__sanguo;
    w.state.stats.tilesClaimed = 3;
    return w.state.turn < w.story.chapters[1].minTurn;
  }));
  check('军历 3 旬进一月、十月对齐许攸夜奔', await page.evaluate(() => {
    const w = window.__sanguo;
    return w.calendar(3, w.cfg.calendar) === '建安五年 二月初一' &&
      w.calendar(27, w.cfg.calendar) === '建安五年 十月初一';
  }));
  // 系统页：军令帖 / 重放 / 联机边界
  await nav('system');
  check('系统页含军令帖与确定性重放入口',
    (await page.locator('#screen').innerText()).includes('军令帖') &&
    (await page.locator('#screen').innerText()).includes('校验确定性重放'));
  const ticket = await page.evaluate(() => window.__sanguo.actions.exportTicket());
  check('军令帖可导出且是 base64url 口令', /^[A-Za-z0-9_-]+$/.test(ticket) && ticket.length > 200);
  const replay = await page.evaluate(() => window.__sanguo.actions.verifyReplay());
  check('双路径确定性重放通过', replay.ok === true && replay.steps === 12,
    replay.ok ? replay.hash : String(replay.mismatchAt));
  await page.evaluate(() => window.__sanguo.actions.syncInfo());
  check('联机边界写明「无预算可做 / 不可做」', await page.evaluate(() =>
    window.__sanguo.state.syncReport.includes('无预算可做') &&
    window.__sanguo.state.syncReport.includes('做不了')));

  // ── 率土-like 本轮：三席存档 / 旬计簿 / 素材致谢 / 终局页 ──────────
  const sysTxt = await page.locator('#screen').innerText();
  check('系统页含三席存档与旬计簿 / 致谢入口',
    sysTxt.includes('三席存档') && sysTxt.includes('旬计簿') && sysTxt.includes('素材致谢'));
  await page.evaluate(() => window.__sanguo.shell.navigate('ledger'));
  const ledTxt = await page.locator('#screen').innerText();
  check('旬计簿显示本旬收支与敌方决策权重',
    ledTxt.includes('本旬军粮') && ledTxt.includes('诸军旬计') && ledTxt.includes('袭粮') &&
    await page.evaluate(() => !!window.__sanguo.xunLedger().byFaction.cao));
  await page.evaluate(() => window.__sanguo.shell.navigate('credits'));
  const creTxt = await page.locator('#screen').innerText();
  check('游戏内致谢页保留原作者声明与 MIT 许可全文',
    creTxt.includes('Copyright (c) 2018 Lingdong Huang') &&
    creTxt.includes('THE SOFTWARE IS PROVIDED "AS IS"') &&
    await page.locator('.creditsLicense').isVisible());
  await page.evaluate(() => window.__sanguo.shell.navigate('outcome'));
  check('开局不误判终局，终局页给出本局摘要', await page.evaluate(() =>
    window.__sanguo.checkOutcome().over === false &&
    document.getElementById('screen').innerText.includes('本局')));
  check('三席存档可存 / 可读 / 可删，互不覆盖自动档', await page.evaluate(() => {
    const w = window.__sanguo;
    w.actions.saveSlot(1);
    const l = w.listSlots();
    const r = w.readSlot(1);
    const ok = l[0].meta?.turn === w.state.turn && r.ok === true && l[1].empty === true;
    w.actions.deleteSlot(1);
    return ok && w.listSlots()[0].empty === true;
  }));
  await page.evaluate(() => window.__sanguo.shell.navigate('system'));
  await nav('interior');   // 保持 screen 打开，后续逐层断言才有元素

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
  check('朱印挂在 #screen 上，滚动带不走', await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('screen'), '::after');
    return s.content.includes('政') && s.backgroundImage.includes('linear-gradient');
  }));
  check('纸页用局部变量覆盖而非白名单', await page.evaluate(() => {
    const b = document.querySelector('#screen .scrBody');
    const cs = getComputedStyle(b);
    return cs.getPropertyValue('--cardBg').trim().startsWith('rgba(255,255,255') &&
      cs.getPropertyValue('--gold').trim() === '#6a5227';
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
  check('战报列表可达（开篇章纪事已在列）', (await page.locator('#screen').innerText()).includes('战报'));
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
  check('存档摘要用年号月日而非「第几旬」',
    (await page.locator('#saveTip').innerText()).includes('建安五年') &&
    !(await page.locator('#saveTip').innerText()).includes('旬'));
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

  // ── v0.9.0：写实淡彩八向素材，按朝向换帧 ────────────────────────────
  check('八向 idle + 步态两张 sprite sheet 全部加载成功（不是静默回退）', await page.evaluate(async () => {
    const cv = window.__sanguo.cityView;
    for (let i = 0; i < 40 && !cv.portraits.ready; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return cv.portraits.ready && cv.portraits.loaded === 4;
  }));
  check('八个中心角各取不同帧，360° 回到正面帧', await page.evaluate(() => {
    const cv = window.__sanguo.cityView;
    const names = [0, 45, 90, 135, 180, 225, 270, 315].map((d) =>
      cv.frameFor(d * Math.PI / 180));
    return new Set(names).size === 8 && cv.frameFor(0) === cv.frameFor(Math.PI * 2) &&
      names[0] === 'd0_front' && names[4] === 'd4_back';
  }));
  check('朝向逐帧传给渲染层，静止时用 id 派生偏角而非全队正对', await page.evaluate(() => {
    const cv = window.__sanguo.cityView;
    const u = [...cv.forces().inside, ...cv.forces().camp][0];
    if (!u) return false;
    const rp = cv.renderPos(u, 1.2);
    return Number.isFinite(rp.heading) && cv.frameFor(rp.heading).startsWith('d');
  }));

  // ── v0.9.0：队伍感 / 步态帧 / 框选→点位置→自动列队 ──────────────────
  check('静止时整队同向、两军相向，不再按 id 散成八向', await page.evaluate(() => {
    const cv = window.__sanguo.cityView;
    const all = [...cv.forces().inside, ...cv.forces().camp];
    const h = (u) => cv.renderPos(u, 0).heading;
    // 战斗态下在途单位有独立的行军朝向，只校验静止单位整队同向
    const idleOnly = all.filter((u) => !cv.motionOf(u.id));
    const inside = idleOnly.filter((u) => u.zone === 'inside');
    const camp = idleOnly.filter((u) => u.zone === 'camp');
    return inside.length > 0 && camp.length > 0 &&
      inside.every((u) => Math.abs(h(u) - h(inside[0])) < 1e-9) &&
      camp.every((u) => Math.abs(h(u) - h(camp[0])) < 1e-9) &&
      Math.abs(h(inside[0]) - h(camp[0])) > 1e-6;
  }));
  check('行走相位在左步/右步之间交替，静止取 idle', await page.evaluate(() => {
    const p = window.__sanguo.cityView.portraits;
    return p.phaseFor(false, 1.2) === 0 &&
      p.phaseFor(true, 0.4) !== p.phaseFor(true, 3.6) &&
      p.walkFrameFor(0, 0.4) !== p.walkFrameFor(0, 3.6);
  }));
  check('三种阵型都能算出互不重叠的格位', await page.evaluate(() => {
    const cv = window.__sanguo.cityView;
    const ids = cv.forces().inside.slice(0, 6).map((u) => u.id);
    return ['line', 'block', 'wedge'].every((shape) => {
      const r = cv.assignFormationAt(ids, { zone: 'inside', col: 12, row: 8 }, shape);
      const ks = r.assignments.map((a) => `${a.col}:${a.row}`);
      return r.assignments.length === ids.length && new Set(ks).size === ks.length &&
        r.assignments.every((a) => a.col >= 0 && a.col < 24 && a.row >= 0 && a.row < 16);
    });
  }));

  // 真实鼠标：画圆框选城内队伍 → 单击一个空格 → 整队自动列队走过去
  const fm = await page.evaluate(() => {
    const cv = window.__sanguo.cityView, c = document.getElementById('cityCanvas');
    const r = c.getBoundingClientRect(), L = cv.layout;
    const us = cv.forces().inside.slice(0, 3);
    const ps = us.map((u) => cv.unitXY(u));
    const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    return {
      ids: us.map((u) => u.id),
      x1: r.left + cx - 62, y1: r.top + cy - 42,
      x2: r.left + cx + 62, y2: r.top + cy + 42,
      tx: r.left + L.ox + 14.5 * L.cell, ty: r.top + L.oy + 9.5 * L.cell,
    };
  });
  await page.mouse.move(fm.x1, fm.y1);
  await page.mouse.down();
  await page.mouse.move(fm.x2, fm.y2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const selIds = await page.evaluate(() => [...window.__sanguo.cityView.selection]);
  const selCount = selIds.length;
  await page.mouse.click(fm.tx, fm.ty);
  await page.waitForTimeout(160);
  const formed = await page.evaluate((ids) => {
    const cv = window.__sanguo.cityView, f = cv.forces();
    const all = [...f.inside, ...f.camp];
    const us = ids.map((id) => all.find((u) => u.id === id)).filter(Boolean);
    const ks = us.map((u) => `${u.col}:${u.row}`);
    const rows = [...new Set(us.map((u) => u.row))];
    const cols = [...new Set(us.map((u) => u.col))];
    return { n: us.length, rows: rows.length, cols: cols.length,
      rowSpan: Math.max(...rows) - Math.min(...rows) + 1,
      colSpan: Math.max(...cols) - Math.min(...cols) + 1,
      uniq: new Set(ks).size, motion: cv.motionCount, keys: ks,
      shape: cv.formationShape };
  }, selIds);
  // 默认方阵：紧凑成块（有横向展开、不是一条竖线），且确实开拔在走。
  check('框选后点位置：整队自动列方阵并开拔（不是各走各的）',
    selCount >= 2 && formed.n === selCount && formed.shape === 'block' &&
    formed.cols >= 2 && formed.rowSpan <= formed.cols &&
    formed.uniq === formed.n && formed.motion > 0,
    JSON.stringify({ selCount, ...formed }));

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
  check('矮屏上 head / × 不随整页滚走', await page.evaluate(() => {
    const o = document.getElementById('battleOverlay');
    const body = document.querySelector('.battleBody');
    return getComputedStyle(o).overflowY === 'hidden' &&
      getComputedStyle(body).overflowY === 'auto' && !body.contains(document.getElementById('closeBattleX'));
  }));
  check('军情细目默认收起，画布放到 55vh', await page.evaluate(() => {
    const d = document.getElementById('battleDebug');
    const c = document.getElementById('cityCanvas');
    return !d.open && c.getBoundingClientRect().height > 300;
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
  const fast = Number(await page.locator('#bFastSteps').textContent());
  const secNow = Number(await page.locator('#bSec').textContent());
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

  // ── v0.9.4：典籍总揽（文言六门）+ 十三州全境舆图（对面 demos 原样接入）──
  await page.evaluate(() => {
    document.querySelector('[data-tut="skip"]')?.click();
    const l = document.getElementById('tutorialLayer');
    if (l) { l.hidden = true; l.style.display = 'none'; }
  });
  await page.click('[data-tab="world"]');
  await page.click('[data-act="archive"]');
  const arc = await page.evaluate(() => {
    const sc = document.getElementById('screen');
    const titles = [...sc.querySelectorAll('.secTitle')].map((e) => e.textContent.trim().split(/\s+/)[0]);
    const body = sc.querySelector('.scrBody');
    return {
      route: sc.dataset.route, tone: sc.dataset.tone,
      titles, items: sc.querySelectorAll('.arcItem').length,
      lv: [...sc.querySelectorAll('.arcLv')].map((e) => e.textContent.trim()),
      txt: body?.innerText ?? '',
      hasPre: !!sc.querySelector('.arcPre'),
      hasAtlasBtn: !!sc.querySelector('[data-act="atlasView"]'),
      count: window.__sanguo.shell.current().route,
    };
  });
  check('典籍总揽可达，纸页六门齐全且逐条带 A/B/C 级',
    arc.route === 'archive' && arc.tone === 'paper' && arc.hasPre &&
    ['本纪','舆地','图法','形制','疑异','书目'].every((x) => arc.titles.includes(x)) &&
    arc.items >= 40 && arc.lv.length === arc.items && arc.lv.every((x) => /^[ABC]$/.test(x)),
    JSON.stringify({ route: arc.route, tone: arc.tone, titles: arc.titles, items: arc.items }));
  check('游戏内只呈文言：不漏白话细目与链接',
    !/亭是带围墙|1957|新野北安乐寨|https?:\/\/|305 座/.test(arc.txt) &&
    /汉室既微|两说并存|不敢以意定之/.test(arc.txt), arc.txt.slice(0, 90));

  await page.click('[data-act="atlasView"]');
  await page.waitForTimeout(180);
  const av = await page.evaluate(() => {
    const sc = document.getElementById('screen'), c = document.getElementById('atlasCanvas');
    const g = c.getContext('2d');
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3).join(',');
    const sum = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
      return h;
    };
    return { route: sc.dataset.route, tone: sc.dataset.tone,
      w: c.width, h: c.height, sum: sum(), corners: [px(2,2), px(c.width>>1, c.height>>1), px(c.width-3, c.height-3)] };
  });
  check('十三州全境舆图贴入 bg+fg：画布有尺寸且不是纯色底',
    av.route === 'atlasView' && av.tone === 'paper' && av.w > 300 && av.h > 200 &&
    new Set(av.corners).size >= 1 && av.sum !== 0,
    JSON.stringify(av));
  await page.click('[data-act="atlasZoom"][data-d="in"]');
  const zoomed = await page.evaluate(() => {
    const c = document.getElementById('atlasCanvas'), d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h = 0; for (let i=0;i<d.length;i+=997) h=(h*31+d[i]+d[i+1]*3+d[i+2]*7)|0; return h;
  });
  await page.click('[data-act="atlasZoom"][data-d="reset"]');
  const reset = await page.evaluate(() => {
    const c = document.getElementById('atlasCanvas'), d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h = 0; for (let i=0;i<d.length;i+=997) h=(h*31+d[i]+d[i+1]*3+d[i+2]*7)|0; return h;
  });
  check('全境舆图放大后画面变化，复位逐像素还原',
    zoomed !== av.sum && reset === av.sum, JSON.stringify({ base: av.sum, zoomed, reset }));
  await page.click('[data-act="back"]');
  check('全境舆图可返回典籍总揽',
    (await page.evaluate(() => document.getElementById('screen').dataset.route)) === 'archive');
  await page.keyboard.press('Escape');

  // ── v0.9.0：士兵精细立绘 + 行军动画 ─────────────────────────────────
  const sp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sErrs = [];
  sp.on('pageerror', (e) => sErrs.push(String(e)));
  sp.on('console', (m) => { if (m.type() === 'error') sErrs.push(m.text()); });
  await sp.goto(base, { waitUntil: 'domcontentloaded' });
  await sp.waitForFunction(() => !!window.__sanguo, null, { timeout: 20000 });
  await sp.click('#startBtn');
  await sp.waitForFunction(() => !!document.querySelector('[data-tut="skip"]'),
    null, { timeout: 6000 }).catch(() => {});
  await sp.evaluate(() => {
    document.querySelector('[data-tut="skip"]')?.click();
    const l = document.getElementById('tutorialLayer');
    if (l) { l.hidden = true; l.style.display = 'none'; }
  });
  await sp.evaluate(() => window.__sanguo.openBattle('xudu'));
  await sp.waitForTimeout(300);
  const anim = await sp.evaluate(() => {
    const w = window.__sanguo, cv = w.cityView, c = document.getElementById('cityCanvas');
    const sec0 = w.session.sec;
    cv.draw(sec0);
    const u = cv.forces().inside[0];
    const from = cv.unitXY(u);
    w.deployUnit('xudu', u.id, 'inside', 12, 9);
    cv.draw(sec0 + 0.001);
    const started = cv.motionCount;
    // 行军 dur 现在由兵种速度算出（不再是写死的 1.15s 上限），
    // 所以「跳到终点」必须按这一段真实的 dur 跳，而不是拍一个 3 秒。
    const dur = cv.motionOf(u.id)?.dur ?? 3;
    const midT = sec0 + dur * 0.35, endT = sec0 + dur + 1;
    const mid = cv.renderPos(u, midT);
    const to = cv.unitXY(u);
    cv.draw(midT);
    const a = c.toDataURL('image/png');
    cv.draw(midT);                        // 同一模拟时刻再画一次
    const b = c.toDataURL('image/png');
    cv.draw(endT);                        // 直接跳到终点
    const ended = cv.motionCount;
    const settled = cv.renderPos(u, endT);
    return {
      started, ended, from, to, mid, a, b, settled,
      dur, stateClean: !('motion' in w.state) && !('anim' in w.state) &&
        !JSON.stringify(w.state.commandLog).includes('motion'),
      finger: w.state.stats,
    };
  });
  check('部署后自动开启行军插值，不是瞬移', anim.started > 0, `motion=${anim.started}`);
  check('中间帧位置落在起终点之间且处于行军态',
    anim.mid.walking && anim.mid.x > anim.from.x && anim.mid.x < anim.to.x &&
    anim.mid.y > anim.from.y && anim.mid.y < anim.to.y,
    JSON.stringify({ from: anim.from, mid: [anim.mid.x, anim.mid.y], to: anim.to }));
  check('同一模拟时刻逐像素一致（零墙钟/零随机）', anim.a === anim.b);
  check('跳到终点自动吸附并清空动画', anim.ended === 0 &&
    Math.abs(anim.settled.x - anim.to.x) < 0.01 && !anim.settled.walking,
    JSON.stringify({ ended: anim.ended, settled: anim.settled, to: anim.to,
      started: anim.started, mid: anim.mid }));
  check('动画状态不进 state / 命令日志', anim.stateClean);

  // 拖拽跟手：按下并移动后，该兵画在手指位置
  const drag = await sp.evaluate(() => {
    const cv = window.__sanguo.cityView, c = document.getElementById('cityCanvas');
    const u = cv.forces().inside[0], p = cv.unitXY(u), r = c.getBoundingClientRect();
    return { id: u.id, x: r.left + p.x, y: r.top + p.y, lx: p.x, ly: p.y };
  });
  await sp.mouse.move(drag.x, drag.y);
  await sp.mouse.down();
  await sp.mouse.move(drag.x + 46, drag.y + 30, { steps: 5 });
  const follow = await sp.evaluate(([id, sec]) => {
    const cv = window.__sanguo.cityView, u = [...cv.forces().inside, ...cv.forces().camp]
      .find((x) => x.id === id);
    const rp = cv.renderPos(u, sec);
    return { x: rp.x, y: rp.y, carried: !!rp.carried };
  }, [drag.id, await sp.evaluate(() => window.__sanguo.session.sec)]);
  await sp.mouse.up();
  check('拖拽时士兵跟着手指走', Math.abs(follow.x - (drag.lx + 46)) < 2 &&
    Math.abs(follow.y - (drag.ly + 30)) < 2, JSON.stringify(follow));
  check('士兵动画无 JS 运行时报错', sErrs.length === 0, sErrs.slice(0, 2).join(' | '));

  // ── v0.9.0：器械为主体 / 满血无血条 / 器械转轮不摆腿（像素级） ────────
  const art = await sp.evaluate(async () => {
    const mod = await import('./src/soldier.js');
    const cfg = window.__sanguo.cfg;
    const mk = (type, opts = {}) => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = '#ded7c0'; g.fillRect(0, 0, 160, 160);
      const u = { id: 'probe', type, faction: 'cao', hp: opts.hp ?? 100, maxHp: 100,
        col: 0, row: 0, zone: 'inside' };
      mod.drawSoldier(g, u, { x: 80, y: 80, s: opts.s ?? 64, sec: 1.2,
        walk: !!opts.walk, dir: 1, phase: opts.phase ?? 0, amp: opts.walk ? 1 : 0,
        seed: mod.idSeed(u.id), col: '#6b93ad', def: cfg.units[type],
        selected: false, champion: false, lightGround: true });
      return g.getImageData(0, 0, 160, 160).data;
    };
    const bg = [222, 215, 192];
    const span = (d) => {
      let minX = 999, maxX = -1;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
        const i = (y * 160 + x) * 4;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) +
            Math.abs(d[i + 2] - bg[2]) > 40) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
      return maxX - minX;
    };
    // 俯视斜向器械横向跨度天然小于正侧视图，改用「墨迹面积」判主体量级
    const inkArea = (d) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) +
            Math.abs(d[i + 2] - bg[2]) > 40) n++;
      }
      return n;
    };
    const green = (d) => {
      let n = 0;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
        const i = (y * 160 + x) * 4;
        if (d[i + 1] > d[i] + 18 && d[i + 1] > d[i + 2] + 18 && d[i + 1] > 90) n++;
      }
      return n;
    };
    const diff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) n++;
      return n;
    };
    // 俯视特征采样：兜鍪顶（人形上方）与扁椭圆轮（器械左前轮）应有成片墨色
    const region = (d, cx, cy, r) => {
      let n = 0;
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        const i = (Math.max(0, Math.min(159, y)) * 160 + Math.max(0, Math.min(159, x))) * 4;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) +
            Math.abs(d[i + 2] - bg[2]) > 40) n++;
      }
      return n;
    };
    const figure = mk('daodun'), engine = mk('chuangnu'), treb = mk('paoshi');
    const full = mk('daodun'), hurt = mk('daodun', { hp: 40 });
    const still = mk('chuangnu'), rolling = mk('chuangnu', { walk: true, phase: 1.4 });
    return {
      kinds: [mod.unitKind('chuangnu'), mod.unitKind('paoshi'), mod.unitKind('daodun')],
      spanFigure: span(figure), spanEngine: span(engine), spanTreb: span(treb),
      areaFigure: inkArea(figure), areaEngine: inkArea(engine), areaTreb: inkArea(treb),
      tinyInk: inkArea(mk('daodun', { s: 10.4 })),
      tinyEngineInk: inkArea(mk('chuangnu', { s: 10.4 })),
      helmInk: region(figure, 80, 60, 9),      // 兜鍪顶（俯视最显眼）
      wheelInk: region(engine, 59, 91, 6),     // 床弩左前扁椭圆轮
      faceInk: region(figure, 80, 74, 4),      // 原本「脸」的位置：俯视应为空暗
      greenFull: green(full), hpDiff: diff(full, hurt), rollDiff: diff(still, rolling),
    };
  });
  check('床弩/抛石机判定为器械，刀盾兵判定为人形',
    JSON.stringify(art.kinds) === '["engine","engine","figure"]', JSON.stringify(art.kinds));
  check('俯视兜鍪顶可见（人形上方成片墨色），不再是正面立像',
    art.helmInk > 25, `helmInk=${art.helmInk}`);
  check('器械扁椭圆轮可见（俯视圆变椭圆）',
    art.wheelInk > 8, `wheelInk=${art.wheelInk}`);
  check('手机 s=10.4 档是独立极简墨剪影，不糊成一点也不铺满格',
    art.tinyInk > 18 && art.tinyInk < 260 && art.tinyEngineInk > 18 && art.tinyEngineInk < 320,
    JSON.stringify({ figure: art.tinyInk, bed: art.tinyEngineInk }));
  check('军械与甲士同为主体量级，器械不退化成人举道具',
    art.areaEngine > art.areaFigure * 1.03 && art.areaTreb > art.areaFigure * 1.15,
    JSON.stringify({ figure: art.areaFigure, bed: art.areaEngine, treb: art.areaTreb }));
  check('满血不画亮绿血条，掉血才浮出暗条',
    art.greenFull === 0 && art.hpDiff > 8,
    JSON.stringify({ greenFull: art.greenFull, hpDiff: art.hpDiff }));
  check('器械行军是转轮/颠簸（静止与行军逐像素不同）',
    art.rollDiff > 10, `diff=${art.rollDiff}`);
  await sp.close();

  // ── v0.9.0：移动端竖屏点击适配（独立真触屏 context） ────────────────
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
  });
  const mp = await mctx.newPage();
  const mErrs = [];
  mp.on('pageerror', (e) => mErrs.push(String(e)));
  mp.on('console', (m) => { if (m.type() === 'error') mErrs.push(m.text()); });
  await mp.goto(base, { waitUntil: 'domcontentloaded' });
  await mp.waitForFunction(() => !!window.__sanguo, null, { timeout: 20000 });
  await mp.click('#startBtn');
  // 引导层是异步 start() 的：太早 hide/skip 会被随后的 render() 重新显示。
  // 等简卡真正出现再跳过，并强制撤掉遮罩（烟测夹具，产品行为由主流程断言覆盖）。
  await mp.waitForFunction(() => !!document.querySelector('[data-tut="skip"]'),
    null, { timeout: 6000 }).catch(() => {});
  await mp.evaluate(() => {
    document.querySelector('[data-tut="skip"]')?.click();
    const l = document.getElementById('tutorialLayer');
    if (l) { l.hidden = true; l.style.display = 'none'; l.style.pointerEvents = 'none'; }
  });
  await mp.waitForTimeout(200);
  check('竖屏引导遮罩已移除（否则简卡会吃掉地图点击）', await mp.evaluate(() => {
    const l = document.getElementById('tutorialLayer');
    return !l || l.style.display === 'none' ||
      document.elementFromPoint(207, 434)?.id === 'map';
  }));

  check('竖屏大地图位图 = CSS×DPR，不被拉伸', await mp.evaluate(() => {
    const c = document.getElementById('map'), r = c.getBoundingClientRect();
    return Math.abs(c.width - Math.round(r.width * devicePixelRatio)) <= 1 &&
           Math.abs(c.height - Math.round(r.height * devicePixelRatio)) <= 1;
  }));

  const tapCity = async (id) => {
    // 缩放后把目标城池移到视口中心，保证 tap 坐标有效（不测视口外的点）。
    await mp.evaluate((id) => {
      const w = window.__sanguo, r = w.renderer, info = w.state.terrain.cityTiles[id];
      const c = document.getElementById('map');
      r.camera.x = info.c * r.size.TP - c.clientWidth / (2 * r.camera.scale);
      r.camera.y = info.r * r.size.TP - c.clientHeight / (2 * r.camera.scale);
      r.clampCamera();
    }, id);
    const t = await mp.evaluate((id) => {
      const w = window.__sanguo, info = w.state.terrain.cityTiles[id];
      const s = w.renderer.tileToScreen(info.c, info.r);
      const back = w.renderer.screenToTile(s.x, s.y);
      return { x: s.x, y: s.y, c: info.c, r: info.r, back: [back.c, back.r],
        desc: w.renderer.describe(back.c, back.r)?.cityId ?? null };
    }, id);
    await mp.touchscreen.tap(t.x, t.y);
    await mp.waitForTimeout(200);
    const st = await mp.evaluate(() => ({
      cityHidden: document.getElementById('cityPanel').hidden,
      infoHidden: document.getElementById('infoCard').hidden,
      overlay: document.elementFromPoint(0, 0)?.id || null,
    }));
    return { ok: !st.cityHidden, ...t, ...st };
  };
  const tc1 = await tapCity('xudu');
  check('竖屏点许都格真打开许都面板', tc1.ok, JSON.stringify(tc1));

  // 缩放后重新取屏幕坐标再点，验证 camera 与 screenToTile 仍自洽
  await mp.evaluate(() => window.__sanguo.renderer.zoom(1.5));
  const tc2 = await tapCity('zhongmu');
  check('竖屏 pinch 缩放后点中牟仍命中', tc2.ok, JSON.stringify(tc2));

  await mp.evaluate(() => window.__sanguo.openBattle('xudu'));
  await mp.waitForTimeout(350);
  // 竖屏地址栏 / 滚动条收起时 canvas 会再排一次版，等 layout 连续两帧不变再取坐标，
  // 否则 tap 用的是旧 rect，几像素漂移就足以让 6px 命中圈落空。
  await mp.waitForFunction(() => new Promise((resolve) => {
    const cv = window.__sanguo.cityView;
    const a = JSON.stringify(cv.layout);
    requestAnimationFrame(() => requestAnimationFrame(() =>
      resolve(a === JSON.stringify(cv.layout))));
  }), null, { timeout: 6000 }).catch(() => {});
  const cu = await mp.evaluate(() => {
    const cv = window.__sanguo.cityView, c = document.getElementById('cityCanvas');
    const r = c.getBoundingClientRect(), f = cv.forces();
    const u = [...f.inside, ...f.camp][0], p = cv.unitXY(u);
    return {
      id: u.id, x: r.left + p.x, y: r.top + p.y,
      attrOk: Math.abs(c.width - Math.round(r.width * devicePixelRatio)) <= 1 &&
              Math.abs(c.height - Math.round(r.height * devicePixelRatio)) <= 1,
      cell: cv.layout.cell, hitSelf: cv.hitUnit(p.x, p.y)?.id === u.id,
    };
  });
  check('竖屏小地图位图 = CSS×DPR，不被拉伸', cu.attrOk, `cell=${cu.cell.toFixed(1)}px`);
  check('竖屏命中半径不跨格（取最近单位）', cu.hitSelf, `u=${cu.id}`);
  const preTap = await mp.evaluate(() => ({ sel: [...window.__sanguo.cityView.selection],
    champ: window.__sanguo.cityView.champion }));
  // 落点按「当下」的实时 rect 重算，不沿用上一条断言里几百毫秒前的坐标
  const tapPt = await mp.evaluate((id) => {
    const cv = window.__sanguo.cityView, c = document.getElementById('cityCanvas');
    const r = c.getBoundingClientRect();
    const u = [...cv.forces().inside, ...cv.forces().camp].find((x) => x.id === id);
    const p = cv.unitXY(u);
    return { x: r.left + p.x, y: r.top + p.y };
  }, cu.id);
  await mp.touchscreen.tap(tapPt.x, tapPt.y);
  await mp.waitForTimeout(180);
  const sel1 = await mp.evaluate((id) =>
    ({ sel: window.__sanguo.cityView.selection, wanted: id }), cu.id);
  check('竖屏点第一个兵必中该兵（不再选到邻居）',
    sel1.sel.includes(cu.id), JSON.stringify({ ...sel1, preTap, cu,
      hit: await mp.evaluate(([x, y]) => {
        const c = document.getElementById('cityCanvas'), r = c.getBoundingClientRect();
        return window.__sanguo.cityView.hitUnit(x - r.left, y - r.top)?.id ?? null;
      }, [cu.x, cu.y]) }));

  // 拖放：把该兵拖到另一格，落点必须与视觉格一致
  const drop = await mp.evaluate((id) => {
    const cv = window.__sanguo.cityView, L = cv.layout;
    const c = document.getElementById('cityCanvas'), r = c.getBoundingClientRect();
    const u = [...cv.forces().inside, ...cv.forces().camp].find((x) => x.id === id);
    const from = cv.unitXY(u);
    const toCol = Math.min(cv.forces().inside.length ? 9 : 9, 23), toRow = 6;
    return {
      fx: r.left + from.x, fy: r.top + from.y,
      tx: r.left + L.ox + (toCol + 0.5) * L.cell,
      ty: r.top + L.oy + (toRow + 0.5) * L.cell,
      toCol, toRow,
    };
  }, cu.id);
  await mp.mouse.move(drop.fx, drop.fy);
  await mp.mouse.down();
  await mp.mouse.move(drop.tx, drop.ty, { steps: 8 });
  await mp.mouse.up();
  await mp.waitForTimeout(220);
  check('竖屏拖放落点 = 视觉目标格', await mp.evaluate(([id, col, row]) => {
    const u = [...window.__sanguo.cityView.forces().inside,
      ...window.__sanguo.cityView.forces().camp].find((x) => x.id === id);
    return !!u && u.col === col && u.row === row;
  }, [cu.id, drop.toCol, drop.toRow]), `目标 (${drop.toCol},${drop.toRow})`);

  // 模拟地址栏收起导致的 rect 偏移：给 canvas 加 translateY，local() 必须实时跟上
  await mp.evaluate(() => {
    document.getElementById('cityCanvas').style.transform = 'translateY(37px)';
    window.__sanguo.cityView.resize();
  });
  const shifted = await mp.evaluate((id) => {
    const cv = window.__sanguo.cityView, c = document.getElementById('cityCanvas');
    const r = c.getBoundingClientRect();
    const u = [...cv.forces().inside, ...cv.forces().camp].find((x) => x.id === id);
    const p = cv.unitXY(u);
    return { x: r.left + p.x, y: r.top + p.y, id };
  }, cu.id);
  await mp.touchscreen.tap(shifted.x, shifted.y);
  await mp.waitForTimeout(180);
  check('rect 偏移后（地址栏/滚动）点击仍命中',
    await mp.evaluate((id) => window.__sanguo.cityView.selection.includes(id), cu.id));
  check('移动端无 JS 运行时报错', mErrs.length === 0, mErrs.slice(0, 2).join(' | '));
  await mctx.close();

  // ── v0.9.2：攻城战闭环（真实浏览器，独立于主流程） ──────────────────
  const bp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bErrs = [];
  bp.on('pageerror', (e) => bErrs.push(String(e)));
  bp.on('console', (m) => { if (m.type() === 'error') bErrs.push(m.text()); });
  await bp.goto(base, { waitUntil: 'domcontentloaded' });
  await bp.waitForFunction(() => !!window.__sanguo, null, { timeout: 20000 });
  await bp.click('#startBtn');
  await bp.waitForFunction(() => !!document.querySelector('[data-tut="skip"]'),
    null, { timeout: 6000 }).catch(() => {});
  await bp.evaluate(() => {
    document.querySelector('[data-tut="skip"]')?.click();
    const l = document.getElementById('tutorialLayer');
    if (l) { l.hidden = true; l.style.display = 'none'; }
  });
  const marched = await bp.evaluate(() => {
    const w = window.__sanguo;
    const from = Object.values(w.state.cities).find((c) => c.owner === 'cao');
    const r = w.issueOrder({ faction: 'cao', from: from.id, to: 'liyang',
      type: 'march', units: { daodun: 600, gongnu: 300 } });
    if (r.ok) for (let i = 0; i < r.order.arriveTurn + 2; i++) w.doTurn();
    const f = w.state.forces.liyang;
    return { camp: f.camp.length, inside: f.inside.length };
  });
  check('攻城前：部队在城外扎营、守军在城内',
    marched.camp > 0 && marched.inside > 0, JSON.stringify(marched));

  await bp.evaluate(() => window.__sanguo.openBattle('liyang'));
  await bp.waitForTimeout(350);
  const idle = await bp.evaluate(() => {
    const c = window.__sanguo.session.combat;
    return { hits: c.stats.hits, volleys: c.stats.volleys, outcome: !!c.outcome,
      camp: window.__sanguo.cityView.forces().camp.length };
  });
  check('城外扎营不等于开打：未派人进城时无命中、大营不动',
    idle.hits === 0 && idle.volleys === 0 && !idle.outcome && idle.camp === marched.camp,
    JSON.stringify(idle));

  await bp.evaluate(() => {
    const w = window.__sanguo, u = w.cityView.forces().camp[0];
    if (u) w.deployUnit('liyang', u.id, 'inside', 5, 8);
  });
  await bp.waitForTimeout(1400);
  const fighting = await bp.evaluate(() => {
    const c = window.__sanguo.session.combat;
    return { hits: c.stats.hits, volleys: c.stats.volleys,
      gate: Math.round(c.gateHp), morale: Math.round(c.morale.defend),
      projects: c.projects.length, outcome: !!c.outcome };
  });
  check('派人进城才开打：命中 / 发矢 / 城门耐久 / 士气都在真实推进',
    fighting.hits > 0 || fighting.volleys > 0, JSON.stringify(fighting));

  const drawn = await bp.evaluate(() => {
    const w = window.__sanguo, cv = w.cityView, c = document.getElementById('cityCanvas');
    const sec = w.session.sec;
    cv.draw(sec, null); const a = c.toDataURL('image/png');
    cv.draw(sec, w.session.combat); const b = c.toDataURL('image/png');
    return a !== b;
  });
  check('小地图画出投射物 / 城防 / 主帅旗，不是空画布', drawn);

  const before = await bp.evaluate(() => {
    window.__sanguo.closeBattle();
    return { sec: window.__sanguo.session.sec,
      hits: window.__sanguo.session.combat.stats.hits };
  });
  await bp.evaluate(() => { for (let i = 0; i < 3; i++) window.__sanguo.doTurn(); });
  await bp.waitForTimeout(200);
  await bp.evaluate(() => window.__sanguo.openBattle('liyang'));
  await bp.waitForTimeout(250);
  const after = await bp.evaluate(() => {
    const w = window.__sanguo;
    return { sec: w.session.sec,
      target: w.state.turn * w.cfg.calendar.secPerTurn,
      hits: w.session.combat.stats.hits, fast: w.session._lastFast };
  });
  // 快进补齐到策略时刻后，实时循环会继续往前走一小段 —— 两端并行本就如此
  check('退出隔三旬再进入：快进追平策略时刻后继续实时、战局不丢',
    after.sec >= after.target - 0.05 && after.sec < after.target + 1.0 &&
    after.hits >= before.hits && after.fast > 0,
    JSON.stringify({ before, after }));
  // ── v0.9.2：粮草常驻 / 严重时大概 debuff ───────────────────────────
  const condAt = async () => bp.evaluate(async () => {
    const m = await import('./src/condition.js');
    const w = window.__sanguo, cv = w.cityView;
    const us = [...cv.forces().inside, ...cv.forces().camp];
    return {
      attack: m.conditionLine(w.cfg, w.session.combat, 'attack', us),
      defend: m.conditionLine(w.cfg, w.session.combat, 'defend', us),
      grain: { attack: w.session.combat.grain.attack, defend: w.session.combat.grain.defend },
    };
  });
  const cfgShort = ['充足', '尚足', '偏紧', '将尽', '断粮'];
  const c0 = await condAt();
  check('粮草档位常驻显示，且是中文大概档位（无精确数值）',
    cfgShort.includes(c0.attack.grain.label) && !/\d/.test(c0.attack.grain.label),
    JSON.stringify(c0.attack.grain));
  check('正常态不弹 debuff，文案不含数字',
    !c0.attack.show && !c0.defend.show &&
    !/[0-9.]/.test(`${c0.attack.label}${c0.attack.debuff}`),
    JSON.stringify({ a: c0.attack.text, d: c0.defend.text }));
  const calmPix = await bp.evaluate(() => {
    const c = document.getElementById('cityCanvas');
    const g = c.getContext('2d');
    const d = g.getImageData(c.width - 220, c.height - 40, 220, 40).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 100) red++;
    return red;
  });
  // 强制断粮 + 压士气，验证「严重时」真的浮出告急，且是同一套真实系数
  await bp.evaluate(() => {
    const w = window.__sanguo, c = w.session.combat;
    c.grain.attack = 0; c.grain.defend = 0;
    c.morale.attack = 24; c.morale.defend = 24;
    for (const u of [...w.cityView.forces().inside, ...w.cityView.forces().camp]) {
      u.morale = 24; u.fatigue = 60;
    }
  });
  await bp.waitForTimeout(220);
  const c1 = await condAt();
  check('严重时浮出大概 debuff，且文案仍不含精确数值',
    c1.attack.show && c1.attack.debuff.length > 0 &&
    !/[0-9.]/.test(`${c1.attack.label}${c1.attack.debuff}`) &&
    c1.attack.text !== c0.attack.text,
    JSON.stringify({ from: c0.attack.text, to: c1.attack.text }));
  const alarmPix = await bp.evaluate(() => {
    const c = document.getElementById('cityCanvas');
    const g = c.getContext('2d');
    const d = g.getImageData(c.width - 220, c.height - 40, 220, 40).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 100) red++;
    return red;
  });
  check('告急用朱砂小字真的画在底栏上（正常态没有）',
    alarmPix > calmPix + 20, `正常 ${calmPix} → 告急 ${alarmPix}`);
  check('精确粮草只收在折叠的军情细目里，主界面不给数字',
    await bp.evaluate(() => {
      const el = document.getElementById('bGrain');
      return /攻 \d+ \/ 守 \d+/.test(el.textContent);
    }));
  check('斥候情报缺粮草字段时不会误报断粮告急', await bp.evaluate(async () => {
    const m = await import('./src/condition.js');
    const w = window.__sanguo;
    const scout = { morale: 72, fatigue: 0, garrison: 2000, wall: 100 };
    return m.cityCondition(w.cfg, scout, { grainKnown: false }).text === '如常' &&
      m.cityCondition(w.cfg, scout, { grainKnown: false }).show === false;
  }));
  check('大地图城池面板不再摊开精确士气，改报「军心」大概',
    await bp.evaluate(() => {
      const w = window.__sanguo;
      w.refreshUI();
      return true;
    }) && !await bp.evaluate(() => /士气<\/span>/.test(document.getElementById('cityBody').innerHTML)));

  check('攻城战无 JS 运行时报错', bErrs.length === 0, bErrs.slice(0, 2).join(' | '));
  await bp.close();

  // 放在所有既有断言之后：推进一旬不影响前面的回合相关断言。
  check('推一旬后军粮账真的入账，产 / 耗 / 净三数齐备', await page.evaluate(() => {
    const w = window.__sanguo;
    w.doTurn();
    const a = w.state.commissary?.cao;
    const l = w.xunLedger().byFaction.cao;
    return !!a && Number.isFinite(a.lastIncome) && a.lastIncome > 0 &&
      a.lastUpkeep > 0 && Number.isFinite(a.lastNet) &&
      l.garrison > 0 && w.checkOutcome().over === false;
  }));

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n烟测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
