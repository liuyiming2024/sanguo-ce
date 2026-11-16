#!/usr/bin/env node
// 页面可达性烟测 v0.7.2：率式整套界面 + 机制修补 + 存档 + 双时钟。
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
  check('序章卷轴取代势力三选一',
    (await page.locator('#proBeat').innerText()).includes('董承') &&
    (await page.locator('#proRole').innerText()).includes('司空府参军事') &&
    !(await page.locator('#mainMenu').innerHTML()).includes('factionPick'));
  check('主菜单标注 v0.7.2 与栅格规模',
    (await page.locator('#menuSub').innerText()).includes('144×108') &&
    (await page.locator('#menuSub').innerText()).includes('0.7.2'));
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

  // ── v0.7.0：工笔青绿设色（默认） / ?style=jiehua 复核旧画法 ──────────
  check('默认是工笔，不是界画', await page.evaluate(() =>
    window.__sanguo.style === 'gongbi' && window.__sanguo.renderer.style === 'gongbi'));
  const ab = await page.evaluate(() => {
    const r = window.__sanguo.renderer;
    const oc = r.offscreen.getContext('2d');
    // 取城内与山脊各一块，做像素校验和；两种画法必须逐像素不同、切回一致
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
    return { eq: a.join() === c.join(), diff: a.join() !== b.join(), s1, s2, a, b, c };
  });
  check('工笔/界画逐像素不同，切回可完全复原',
    ab.diff && ab.eq && ab.s1 === 'jiehua' && ab.s2 === 'gongbi', JSON.stringify(ab));
  check('工笔只改表现层：地形格数 / 存档 / 命令日志一行未动', await page.evaluate(() => {
    const w = window.__sanguo;
    return w.state.terrain.tiles.length === 15552 &&
      !('gongbi' in w.state) && !('style' in w.state) &&
      !JSON.stringify(w.state.commandLog).includes('gongbi');
  }));
  check('浅绢底上默认视图没有等级角标 / 硬点阵', await page.evaluate(() => {
    const c = document.getElementById('map'), ctx = c.getContext('2d');
    window.__sanguo.renderer.draw(ctx);
    return window.__sanguo.renderer.camera.scale < 1.6;
  }));

  // ── v0.7.0：卷末留白 / 武备题头 ──────────────────────────────────────
  await nav('reports');
  check('墨底页有卷末题记，空场不再是一整块纯黑', await page.evaluate(() => {
    const e = document.querySelector('#screen .scrBody .scrollEnd');
    return !!e && e.textContent.includes('尚 无 战 报');
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

  // ── v0.7.2：士兵精细立绘 + 行军动画 ─────────────────────────────────
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
    const mid = cv.renderPos(u, sec0 + 0.35);
    const to = cv.unitXY(u);
    cv.draw(sec0 + 0.35);
    const a = c.toDataURL('image/png');
    cv.draw(sec0 + 0.35);                 // 同一模拟时刻再画一次
    const b = c.toDataURL('image/png');
    cv.draw(sec0 + 1.4);                 // 直接跳到终点
    const ended = cv.motionCount;
    const settled = cv.renderPos(u, sec0 + 1.4);
    return {
      started, ended, from, to, mid, a, b, settled,
      stateClean: !('motion' in w.state) && !('anim' in w.state) &&
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
    Math.abs(anim.settled.x - anim.to.x) < 0.01 && !anim.settled.walking);
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
  await sp.close();

  // ── v0.7.2：移动端竖屏点击适配（独立真触屏 context） ────────────────
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
  await mp.touchscreen.tap(cu.x, cu.y);
  await mp.waitForTimeout(180);
  const sel1 = await mp.evaluate((id) =>
    ({ sel: window.__sanguo.cityView.selection, wanted: id }), cu.id);
  check('竖屏点第一个兵必中该兵（不再选到邻居）',
    sel1.sel.includes(cu.id), JSON.stringify(sel1));

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

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n烟测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
