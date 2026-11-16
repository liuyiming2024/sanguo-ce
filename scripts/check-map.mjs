// 静态自检：配置、地形生成、连通性、导航控件、版本指纹。CI 与本地共用。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTerrain, terrainStats } from '../src/terrain.js';
import { CITIES, PASSES, ROADS, validateMap } from '../src/map-data.js';
import { validateConnectivity, routeCities, tilesPerTurn, hasAdjacentTerritory } from '../src/pathfind.js';
import { createCampaign, collectResources, issueOrder } from '../src/campaign.js';
import { calendarParts, formatCalendar, cnYear } from '../src/calendar.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'config/campaign.json'), 'utf8'));
const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };

// 配置
ok(cfg.meta.version === '0.6.0', 'meta.version 与生成物指纹不一致');
ok(cfg.terrain.tilePx === 24, '地形离屏分辨率不足，文字会糊');
ok(cfg.orders.types.length === 12, '大地图指令不足 12 类');
ok(cfg.cityView && cfg.cityView.cols === 24 && cfg.cityView.rows === 16, '缺少城池小地图配置');
ok(cfg.terrain.cols * cfg.terrain.rows >= 10000, '栅格规模不足，称不上「足够复杂」');
ok(cfg.calendar.secPerTurn > 0 && cfg.battle.fixedStepSec > 0, '时间参数不合法');
ok(cfg.gems === undefined, '新库不该带宝石/矿工系统');
for (const banned of ['wizard', 'giant', 'miner']) ok(!cfg.units[banned], `不该存在魔法/矿工兵种 ${banned}`);
ok(cfg.units.junshi?.support === true && cfg.units.junshi?.dmg === 0, '军师必须是零伤害辅助');
const ranged = Object.entries(cfg.units).filter(([, u]) => u.projectile);
ok(ranged.length >= 3, '远程兵种不足（弓弩/床弩/抛石机）');

// 锚点
const mapProblems = validateMap();
problems.push(...mapProblems.map((p) => `地图锚点: ${p}`));
ok(CITIES.length === 12, `城池数 ${CITIES.length}，应为 12`);
ok(PASSES.length >= 7, '关隘/津渡不足');

// 地形
const t = createTerrain(cfg);
const st = terrainStats(t);
console.log(`地形：${st.total} 格 / 已占领 ${st.owned} / 可通行 ${st.passable}`);
for (const [k, v] of Object.entries(st.counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(5)}`);
}
for (const type of ['plain', 'farmland', 'forest', 'hill', 'mountain', 'river',
  'lake', 'marsh', 'road', 'city', 'wall', 'gate', 'ford', 'pass']) {
  ok((st.counts[type] ?? 0) > 0, `地形缺少 ${type}`);
}
ok(st.owned > 300, `初始领地只有 ${st.owned} 格`);
ok(st.passable > 10000, `可通行格 ${st.passable} 太少`);

// 确定性
const t2 = createTerrain(cfg);
ok(t.tiles.every((x, i) => x.type === t2.tiles[i].type && x.owner === t2.tiles[i].owner),
  '同一 seed 两次生成结果不一致');

// 连通性
const conn = validateConnectivity(t, cfg, CITIES.map((c) => c.id));
problems.push(...conn.map((p) => `连通性: ${p}`));
const sample = routeCities(t, 'xudu', 'ye', cfg);
ok(sample.ok, `许都→邺 不可达: ${sample.reason}`);
console.log(`许都→邺：${sample.path?.length} 格 / ${sample.cost?.toFixed(1)} 代价 / ${sample.turns} 旬，每旬约 ${tilesPerTurn(cfg, t).toFixed(1)} 格`);

// 策略层烟测
const s = createCampaign(cfg, { seed: cfg.terrain.seed });
const yield0 = collectResources(s).cao;
ok(yield0.grain > 0 && yield0.tiles > 100, '初始地块产出为空');
const near = s.terrain.tiles.find((x) => !x.owner && x.cost < 90 && x.y.grain > 1 &&
  hasAdjacentTerritory(s.terrain, 'cao', x.c, x.r));
ok(!!near, '找不到可铺路的相邻高产田');
collectResources(s);
const r = issueOrder(s, { faction: 'cao', from: 'xudu', to: 'chenliu',
  type: 'transfer', units: { daodun: 500 } });
ok(r.ok, `许都→陈留出征失败: ${r.reason}`);
ok(r.order?.arriveTurn > 0, '命令不应即时生效');

// 导航/指纹静态检查
const html = readFileSync(join(root, 'index.html'), 'utf8');
const main = readFileSync(join(root, 'src/main.js'), 'utf8');
for (const id of ['map', 'topBar', 'infoCard', 'closeInfoX', 'battleOverlay',
  'closeBattleX', 'leaveBattle', 'helpPanel', 'closeHelpX', 'mainMenu', 'startBtn',
  'cityCanvas', 'cityPanel', 'closeCityX', 'orderList', 'closeOrderX', 'tileCmds',
  'enterCityBtn', 'fitBtn', 'orderBtn', 'screen', 'bottomBar', 'mapTools',
  'hudSystem', 'continueBtn', 'saveTip', 'marchCityBtn']) {
  ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
}
ok(html.includes('?v=0.6.0'), 'HTML 入口缺少版本指纹');
ok(main.includes("?v=0.6.0"), 'ESM import 缺少版本指纹');
ok(html.match(/class="x"/g)?.length >= 3, '可进入的层缺少可见 × 退出');
for (const f of ['src/main.js', 'src/map-render.js', 'src/terrain.js', 'src/pathfind.js',
  'src/campaign.js', 'src/battle-session.js', 'src/city-view.js', 'src/map-data.js',
  'src/rng.js', 'src/ui-shell.js', 'src/persist.js',
  'src/calendar.js', 'src/story.js', 'src/sync.js',
  'config/campaign.json', 'config/ui-data.json', 'config/story.json',
  'config/tutorial.json', 'src/tutorial.js', 'src/tutorial-ui.js',
  'tests/tutorial.test.mjs', 'styles/main.css',
  'tests/commands.test.mjs', 'tests/persist.test.mjs',
  'tests/calendar.test.mjs', 'tests/story.test.mjs', 'tests/sync.test.mjs',
  'scripts/smoke.mjs', 'scripts/serve.mjs', '.nojekyll']) {
  ok(existsSync(join(root, f)), `缺少文件 ${f}`);
}

if (problems.length) {
  console.error('\n✗ 自检失败：');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}
// ── 界面层机制自检（评审里「会真在屏幕上出事」的几条） ──────────────────
const css = readFileSync(join(root, 'styles/main.css'), 'utf8');
ok(/body::before\{[^}]*z-index:2/.test(css) && !/body::after\{/.test(css),
  '装饰层只能压地图；被顶栏盖住又与顶栏金线重复的外框金线应删除');
ok(!/--goldDim/.test(css), '--goldDim 成死变量');
ok(/\.hudExtra\{[^}]*flex:0 0 auto/.test(css), 'flex 简写被 flex-shrink 覆盖，应合成一行');
ok(/#bottomBar\{[^}]*padding:0 8px;padding:0 8px env\(/.test(css), 'env() 缺降级双写');
ok(/\.x\{position:absolute/.test(css), '.x 没有基类，定位靠碰巧匹配');
ok(/\.sheetCard\{[^}]*overflow:hidden/.test(css) && /\.sheetScroll\{[^}]*overflow:auto/.test(css),
  'sheet 的 × 挂在滚动容器上，长内容会滚走');
ok(/\.scrHead\{position:relative/.test(css) && /\.scrHead \.x\{position:static/.test(css),
  'scrHead 未建立定位上下文 / 标题栏 × 未回归 flex item');
ok(/#topBar \.res\{[^}]*min-width:0/.test(css) && /\.hudExtra\{[^}]*min-width:0/.test(css),
  'flex 子项缺 min-width:0，资源一多会挤爆顶栏');
ok(/#battleOverlay\{[^}]*overflow:hidden/.test(css) && /\.battleBody\{[^}]*overflow-y:auto/.test(css),
  '整页滚动会让 head / × 一起滚走，应把滚动下移给 battleBody');
ok(/#cityCanvas\{[^}]*flex:0 0 min\(55vh/.test(css), '画布应放到 55vh');
ok(/\.cmdGroup button\.primary[\s\S]{0,400}?background:var\(--ink\)/.test(css) ||
   /\.btn-primary[\s\S]{0,300}?background:var\(--ink\)/.test(css),
  '主操作缺墨底反金重量');
ok(/#screen\{position:absolute;top:0;left:0;right:0;bottom:58px/.test(css),
  '全屏页盖住底部 Tab，翻页不该像开关灯');
ok(/#screen\[data-tone="paper"\]::after/.test(css) &&
   !/#screen\[data-tone="paper"\] \.scrBody::before/.test(css),
  '朱印挂在滚动容器上会被长战报带出视口');
ok(/--cardBg:/.test(css) && /--groundBg:/.test(css) &&
   /#screen\[data-tone="paper"\] \.scrBody\{[\s\S]*?--cardBg:rgba\(255,255,255/.test(css),
  '纸页应是局部变量覆盖，不是逐组件白名单');
const paperOverrides = (css.match(/#screen\[data-tone="paper"\] \.scrBody \.[\w-]+/g) ?? []).length;
ok(paperOverrides <= 6, `纸页仍有点名覆盖 ${paperOverrides} 处，应靠变量继承`);
ok(/#screen\[data-tone="paper"\]/.test(css), '文治页缺蚕白纸底');
ok(/--serif:"Noto Serif CJK SC","Source Han Serif SC"/.test(css),
  '字体栈首位是 macOS 专属，Windows 会掉到黑体');
ok(/prefers-reduced-motion:reduce/.test(css) && /:focus-visible/.test(css),
  '缺 reduced-motion / focus-visible 降级');
ok(/--gold2:#a08a58/.test(css) && /--dimDeep:#8b957f/.test(css),
  '小字号对比度未提亮（gold2 / tiny 低于 AA）');

const ui = JSON.parse(readFileSync(join(root, 'config/ui-data.json'), 'utf8'));
ok(ui.facilities.length >= 15, '设施树不完整');
ok(ui.heroes.length >= 10 && ui.tactics.length >= 6, '武将 / 战法数据缺失');
ok(ui.tasks.length >= 5 && ui.mails.length >= 3, '任务 / 邮件数据缺失');
const shell = readFileSync(join(root, 'src/ui-shell.js'), 'utf8');
ok(shell.includes("data-tone") && shell.includes('PAPER_ROUTES'), '界面外壳未区分文武底色');
ok(shell.includes("setAttribute('role', 'button')"), 'div 卡片缺键盘可访问性');
const persist = readFileSync(join(root, 'src/persist.js'), 'utf8');
ok(persist.includes('localStorage') && persist.includes('facilities') &&
   persist.includes('claimedTasks'), '存档边界未覆盖整套界面状态');
const main3 = readFileSync(join(root, 'src/main.js'), 'utf8');
ok(main3.includes('visibilitychange') && main3.includes('pagehide'), '切后台 / 锁屏未自动存档');
ok(main3.includes('pointers.size === 2') && main3.includes('snapTile'), '移动端缺捏合缩放 / 地块吸附');
ok(main3.includes('idleStop'), '静止停绘未接线');

// ── v0.6.0：年号历法 / 章回剧情 / 联机地基 ─────────────────────────────
ok(cfg.calendar.startMonth === 1 && cfg.calendar.xunPerMonth === 3,
  '军历须自正月起，3 旬进一月，才能与史实章回月份对齐');
ok(formatCalendar(0, cfg.calendar) === '建安五年 正月初一', '开局日期不是建安五年正月初一');
ok(formatCalendar(3, cfg.calendar) === '建安五年 二月初一', '二月未对齐（颜良围白马）');
ok(formatCalendar(9, cfg.calendar) === '建安五年 四月初一', '四月未对齐（声东击西）');
ok(formatCalendar(27, cfg.calendar) === '建安五年 十月初一', '十月未对齐（许攸夜奔）');
ok(calendarParts(0, cfg.calendar).ganzhi === '庚辰', '干支年不是庚辰');
ok(cnYear(13) === '十三' && cnYear(5) === '五', '汉字年号有误');
ok(!formatCalendar(0, cfg.calendar).includes('旬'), '界面日期不该出现「第几旬」');

const story = JSON.parse(readFileSync(join(root, 'config/story.json'), 'utf8'));
ok(story.chapters.length >= 8, '章回不足 8 回');
ok(story.meta.faction === 'cao' && !!story.meta.role, '身份未由剧情给定');
ok(story.chapters.every((c, i, a) => i === 0 || c.minTurn > a[i - 1].minTurn),
  '章回 minTurn 未按史实时序递增');
ok(story.chapters.every((c) => c.beat && c.historical && c.source && c.goal && c.reward && c.choice),
  '章回缺叙事 / 史注 / 目标 / 犒赏 / 抉择');
ok(story.chapters.every((c) => c.onEnter?.report), '章回入场缺史实战报');
ok(!html.includes('factionPick') && html.includes('class="prologue"'),
  '仍在做势力三选一，序章卷轴未取代势力下拉');
ok(html.includes('id="proBeat"') && html.includes('data-open="farm"'), '序章未取代势力下拉');
ok(!readFileSync(join(root, 'src/main.js'), 'utf8').includes('factionPick'), 'main.js 仍绑定势力下拉');

const sync = readFileSync(join(root, 'src/sync.js'), 'utf8');
ok(sync.includes('export function hashState') && sync.includes('appendCommand') &&
   sync.includes('verifyReplay') && sync.includes('createBroadcastTransport') &&
   sync.includes('encodeTicket'), '联机地基缺命令日志 / 指纹 / 重放 / 传输 / 口令');
const main4 = readFileSync(join(root, 'src/main.js'), 'utf8');
ok(main4.includes('exportTicket') && main4.includes('verifyReplay') && main4.includes('syncInfo'),
  '系统页未接线军令帖 / 重放校验');
ok(main4.includes('chapterHeadline(story, state)'), '顶栏未显示章回名');
ok(!/第 \$\{[^}]*turn\} 旬/.test(main4), '装配层仍有「第 N 旬」文案');

// ── v0.6.0 实拍收尾：地图装饰密度 ──────────────────────────────────────
const mrender = readFileSync(join(root, 'src/map-render.js'), 'utf8');
ok(/lineWidth = 5;/.test(mrender) && /lineWidth = 2\.4;/.test(mrender),
  '官道仍是 8/4.2 金带');
ok(!/if \(nb\(1, 1\)\) links\.push/.test(mrender),
  '8 向全连会把官道织成金网');
ok(/\(t\.c \+ t\.r\) & 1\) continue/.test(mrender), '山形未隔格抽样');
ok(/cssW - mw - 14 - \(cssW > 720 \? 62 : 56\)/.test(mrender),
  '缩略导航被右下工具列压住');
ok(/rgba\('#0b100e', 0\.97\)/.test(mrender), '缩略导航缺实底');
const html4 = readFileSync(join(root, 'index.html'), 'utf8');
ok(html4.includes('class="battleDebug"') && html4.includes('军情细目 · 展开'),
  '调试 9 格仍是一级 UI');
ok(!/已拍快照 @/.test(readFileSync(join(root, 'src/main.js'), 'utf8')),
  'toast 仍在报调试数字');

// ── v0.6.0：行台授简 / 卷末留白 / 武备题头 ─────────────────────────────
const tutDef = JSON.parse(readFileSync(join(root, 'config/tutorial.json'), 'utf8'));
const tutCss = readFileSync(join(root, 'styles/main.css'), 'utf8');
const tutUi = readFileSync(join(root, 'src/tutorial-ui.js'), 'utf8');
const shell5 = readFileSync(join(root, 'src/ui-shell.js'), 'utf8');
const persist5 = readFileSync(join(root, 'src/persist.js'), 'utf8');
const sync5 = readFileSync(join(root, 'src/sync.js'), 'utf8');
const main5 = readFileSync(join(root, 'src/main.js'), 'utf8');

ok(tutDef.steps.length === 12, '授简不是十二简');
ok(tutDef.steps.every((x) => x.id && x.no && x.title && x.beat && x.quote && x.tip && x.place),
  '授简某简缺叙事/引文/提示/位置');
ok(tutDef.steps.every((x, i, a) => i === 0 || a[i - 1].id !== x.id), '授简 id 重复');
const awaits = tutDef.steps.map((x) => x.await).filter(Boolean);
ok(new Set(awaits).size === awaits.length, '两简等同一事件会互相抢');
ok(awaits.every((e) => main5.includes(`tutNotify('${e}')`) || e.startsWith('tab:')),
  '存在未接线的授简事件');
ok(main5.includes('onRoute: (route) => tutNotify(`tab:${route}`)'), 'tab 事件缺路由回调');
ok(html4.includes('id="tutorialLayer"') && html4.includes('class="tutCard"') &&
   html4.includes('class="tutFocus"'), '缺授简层 DOM');
ok(/#tutorialLayer\{[^}]*pointer-events:none/.test(tutCss) &&
   /\.tutCard\{[^}]*pointer-events:auto/.test(tutCss),
  '遮罩必须不吃指针，简卡必须可点');
ok(/bottomBar = 66/.test(tutUi) && /#screen\{position:absolute;top:0;left:0;right:0;bottom:58px/.test(tutCss),
  '简卡定位必须避开底部 Tab');
ok(/data-tut="skip"/.test(tutUi) && /data-tut="prev"/.test(tutUi) &&
   /onKey/.test(tutUi), '缺跳过 / 上一简 / Esc 三条退路');
ok(tutUi.includes("sanguo-ce:tutorial:v1"), '缺独立存储 key');
ok(!/tutorial/i.test(persist5) && !/tutorial/i.test(sync5) &&
   !/state\.tutorial\s*=/.test(main5), '引导状态污染了存档 / 指纹 / 军令帖');
ok(shell5.includes('const scrollEnd') && shell5.includes('const emptyScroll'),
  '缺卷末留白与空态组件');
ok(shell5.includes("screen.dataset.route = cur.route") &&
   /#screen\[data-route="march"\]/.test(tutCss), '武备页缺语义朱题头');
ok(shell5.includes('data-act="tutorialReplay"') && main5.includes('replayTutorial()'),
  '系统页缺「重看行台授简」');
ok(shell5.includes("emptyScroll('尚 无 战 报'") &&
   main5.includes('尚 无 在 途 军 令'), '空态仍是两行小字加纯黑');
ok(/tutNotify\('battleOpened'\)/.test(main5) && /tutNotify\('battleClosed'\)/.test(main5),
  '进出城池未联动授简');
ok(!/已拍快照 @/.test(main5) && !/快进 .*步/.test(main5), 'toast/log 仍在报调试数字');

console.log('\n✓ 地图/连通性/导航/指纹/界面机制/历法章回/联机地基/审美收尾/授简自检全绿');
