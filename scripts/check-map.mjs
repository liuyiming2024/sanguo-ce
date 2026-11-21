// 静态自检：配置、地形生成、连通性、导航控件、版本指纹。CI 与本地共用。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTerrain, terrainStats } from '../src/terrain.js';
import { CITIES, PASSES, ROADS, validateMap, useMap, MAPS } from '../src/map-data.js';
import { validateConnectivity, routeCities, tilesPerTurn, hasAdjacentTerritory } from '../src/pathfind.js';
import { createCampaign, collectResources, issueOrder } from '../src/campaign.js';
import { calendarParts, formatCalendar, cnYear } from '../src/calendar.js';
import { VERSION } from '../src/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'config/campaign.json'), 'utf8'));
const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };

// 配置
// 版本号唯一来源：src/version.js。配置文件、HTML、模块 import 都不再存字面量。
ok(/^0\.\d+\.\d+$/.test(VERSION), 'VERSION 格式非法，大版本号必须保持 0');
ok(!('version' in cfg.meta) && !('version' in cfg),
  '配置里又写了版本字面量，改版本只需动 src/version.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const maniCfg = JSON.parse(readFileSync(join(root, 'assets/units/trooper.json'), 'utf8'));
ok(!('version' in pkg) && !('version' in maniCfg),
  'package.json / trooper.json 不该再存版本字面量');
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
ok(main.includes('cfg.meta.version = VERSION'),
  '装配层没把 VERSION 注入 cfg，存档与军令帖会丢版本');
for (const id of ['map', 'topBar', 'infoCard', 'closeInfoX', 'battleOverlay',
  'closeBattleX', 'leaveBattle', 'helpPanel', 'closeHelpX', 'mainMenu', 'startBtn',
  'cityCanvas', 'cityPanel', 'closeCityX', 'orderList', 'closeOrderX', 'tileCmds',
  'enterCityBtn', 'fitBtn', 'orderBtn', 'screen', 'bottomBar', 'mapTools',
  'hudSystem', 'continueBtn', 'saveTip', 'marchCityBtn']) {
  ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
}
ok(html.includes('src/version.js') && html.includes('?v=${VERSION}'),
  'HTML 入口没从 version.js 注入缓存指纹');
// 排除 version.js 自身；文件头的历史注释（v0.9.0 / v0.9.2）不是版本常量，
// 升版本时不需要动，所以只拦「带引号」的版本字面量与 ?v= 硬编码戳。
const allSrc = readdirSync(join(root, 'src'))
  .filter((f) => f.endsWith('.js') && f !== 'version.js')
  .map((f) => readFileSync(join(root, 'src', f), 'utf8')).join('\n');
const allMjs = readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.mjs'))
  .map((f) => readFileSync(join(root, 'scripts', f), 'utf8')).join('\n');
ok(!/\?v=\d/.test(html + main + allSrc + allMjs),
  '代码里又出现硬编码 ?v= 版本戳，升版本会漏改');
ok(!/['"]0\.9\.\d['"]/.test(allSrc),
  '源码里除了 version.js 不该还有带引号的版本字面量');
ok(html.match(/class="x"/g)?.length >= 3, '可进入的层缺少可见 × 退出');
for (const f of ['src/main.js', 'src/map-render.js', 'src/terrain.js', 'src/pathfind.js',
  'src/campaign.js', 'src/battle-session.js', 'src/city-view.js', 'src/map-data.js',
  'src/rng.js', 'src/ui-shell.js', 'src/persist.js',
  'src/calendar.js', 'src/story.js', 'src/sync.js',
  'config/campaign.json', 'config/ui-data.json', 'config/story.json',
  'config/tutorial.json', 'src/tutorial.js', 'src/tutorial-ui.js',
  'src/direction.js', 'src/portrait.js', 'tests/direction.test.mjs',
  'assets/units/trooper.json', 'assets/units/trooper-sheet.png',
  'tests/tutorial.test.mjs', 'styles/main.css',
  'tests/commands.test.mjs', 'tests/persist.test.mjs',
  'tests/calendar.test.mjs', 'tests/story.test.mjs', 'tests/sync.test.mjs',
  'scripts/smoke.mjs', 'scripts/serve.mjs', '.nojekyll']) {
  ok(existsSync(join(root, f)), `缺少文件 ${f}`);
}

// ── v0.9.2：方向整圈覆盖 / 中轴线不漂 ────────────────────────────────
const dirMod9 = readFileSync(join(root, 'src/direction.js'), 'utf8');
const portMod9 = readFileSync(join(root, 'src/portrait.js'), 'utf8');
const mani9 = JSON.parse(readFileSync(join(root, 'assets/units/trooper.json'), 'utf8'));
ok(/export function normAngle|export function dirIndex|export function sectorCenters/.test(dirMod9),
  '缺整圈朝向量化函数');
ok(mani9.anchor === '脚底中心' && mani9.footY === 780 && mani9.frames.length === 8,
  '八向帧没有共用统一的脚底中轴基线');
ok(/ctx\.drawImage\(fr\.sheet, fr\.sx, 0, fr\.sw, fr\.sh, -w \/ 2, -dh, w, dh\)/.test(portMod9),
  '换方向帧时改变了 drawImage 落点，中轴线会漂');
ok(/export const GROUND_SHEAR = -0\.17;/.test(portMod9) &&
   /const tilt = engine && o\.walk/.test(portMod9),
  '斜轴必须是全帧共用常量；人形转身不能靠 rotate 整张图');

// ── v0.9.2：粮草显示 / 严重时大概 debuff ─────────────────────────────
const condMod = readFileSync(join(root, 'src/condition.js'), 'utf8');
const condBody = condMod.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
ok(!/Date\.|performance\.|Math\.random|localStorage|setTimeout|setInterval/.test(condBody),
  '军情档位模块不能引入墙钟或随机源');
ok(/export function hungerFactor|export function marchFactor|export function conditionLine/.test(condMod),
  '缺粮草/行军/文案派生函数');
const condCfg = JSON.parse(readFileSync(join(root, 'config/campaign.json'), 'utf8')).condition;
ok(condCfg && condCfg.grainTiers.length >= 4 && condCfg.debuffTiers.length >= 4,
  '缺粮草/减益档位表');
ok(condCfg.grainTiers.every((x) => !/[0-9.]/.test(x.label)) &&
   condCfg.debuffTiers.every((x) => !/[0-9.]/.test(x.label + x.debuff)),
  '大概档位文案里混进了精确数字');
ok(condCfg.showFromTier >= 2, 'debuff 必须只在严重档才显示');
const sc9 = readFileSync(join(root, 'src/siege-combat.js'), 'utf8');
ok(/hungerFactor\(cfg, c\.grain\[u\.side\]\)/.test(sc9) &&
   /marchFactor\(cfg, c\.grain\[u\.side\]\)/.test(sc9),
  '界面档位与真实减益必须同源，不能另写一套公式');
const cv9 = readFileSync(join(root, 'src/city-view.js'), 'utf8');
ok(!/士气 攻 \$\{Math\.round\(c\.morale/.test(cv9),
  '子界面底栏仍在摊开精确士气数值');
ok(/conditionLine\(cfg, c, 'attack'/.test(cv9) && /conditionLine\(cfg, c, 'defend'/.test(cv9) &&
   /粮草 · 攻/.test(cv9), '子界面缺常驻粮草档位');
const main9 = readFileSync(join(root, 'src/main.js'), 'utf8');
ok(/\['军心', cityCondition\(cfg, o\)\.text\]/.test(main9), '城池面板仍在摊开精确士气');
ok(/\$\('bGrain'\)/.test(main9) && /bGrain/.test(readFileSync(join(root, 'index.html'), 'utf8')),
  '精确粮草未收进军情细目');

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
ok(/#screen\[data-tone="paper"\] \.scrBody\{[\s\S]{0,500}--cardBg/.test(css),
  '纸页缺局部变量继承（不该靠逐条点名覆盖）');
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
ok((shell.includes("data-tone") || shell.includes('dataset.tone')) && shell.includes('PAPER_ROUTES'),
  '界面外壳未区分文武底色');
ok(shell.includes("setAttribute('role', 'button')"), 'div 卡片缺键盘可访问性');
const persist = readFileSync(join(root, 'src/persist.js'), 'utf8');
ok(persist.includes('localStorage') && persist.includes('facilities') &&
   persist.includes('claimedTasks'), '存档边界未覆盖整套界面状态');
const main3 = readFileSync(join(root, 'src/main.js'), 'utf8');
ok(main3.includes('visibilitychange') && main3.includes('pagehide'), '切后台 / 锁屏未自动存档');
ok(main3.includes('pointers.size === 2') && main3.includes('snapTile'), '移动端缺捏合缩放 / 地块吸附');
ok(main3.includes('idleStop'), '静止停绘未接线');

// ── v0.7.0：年号历法 / 章回剧情 / 联机地基 ─────────────────────────────
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

// ── v0.7.0 实拍收尾：地图装饰密度 ──────────────────────────────────────
const mrender = readFileSync(join(root, 'src/map-render.js'), 'utf8');
ok(/lineWidth = 5;/.test(mrender) && /lineWidth = 2\.4;/.test(mrender),
  '官道仍是 8/4.2 金带');
ok(!/if \(nb\(1, 1\)\) links\.push/.test(mrender),
  '8 向全连会把官道织成金网');
ok(/\(t\.c \+ t\.r\) & 1\) continue/.test(mrender), '山形未隔格抽样');
ok(/cssW - mw - 14 - \(cssW > 720 \? 62 : 56\)/.test(mrender),
  '缩略导航被右下工具列压住');
ok(/0\.97\)\s*;\s*ctx\.fillRect\(mx - 5, my - 5/.test(mrender) ||
   /fillStyle = rgba\([^)]*0\.97\); ctx\.fillRect\(mx - 5, my - 5/.test(mrender),
  '缩略导航缺实底');
const html4 = readFileSync(join(root, 'index.html'), 'utf8');
ok(html4.includes('class="battleDebug"') && html4.includes('军情细目 · 展开'),
  '调试 9 格仍是一级 UI');
ok(!/已拍快照 @/.test(readFileSync(join(root, 'src/main.js'), 'utf8')),
  'toast 仍在报调试数字');

// ── v0.7.0：行台授简 / 卷末留白 / 武备题头 ─────────────────────────────
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


// ── v0.7.0：工笔青绿设色 —— 去网格化的硬约束 ──────────────────────────
const gb = readFileSync(join(root, 'src/gongbi.js'), 'utf8');
const mr7 = readFileSync(join(root, 'src/map-render.js'), 'utf8');
const main7 = main5;
ok(/export function paintGongbi/.test(gb) && /paintGongbi\(g,/.test(mr7), '工笔管线没接进渲染层');
ok(/createImageData\(cols, rows\)/.test(gb) && /drawImage\(sc, 0, 0, W, H\)/.test(gb),
  '分染必须是「低分辨率类型场平滑放大」，不是逐格填色块');
ok(!/fillRect\(t\.c \* TP, t\.r \* TP, TP, TP\)/.test(gb),
  '工笔里仍存在逐格方块（沙盘感的根源）');
ok(!/for \(const t of terrain\.tiles\)[\s\S]{0,900}links\.push/.test(gb),
  '官道仍在织 8 向 links 网带');
ok((gb.match(/quadraticCurveTo/g) ?? []).length >= 6,
  '山 / 水 / 路必须是连续曲线白描，不是逐格线段');
ok(/densify\(/.test(gb) && /normals\(/.test(gb), '缺折线加密与法线，连续峰峦/河岸不成立');
ok(/createLinearGradient[\s\S]{0,280}malaHi[\s\S]{0,280}azur/.test(gb),
  '山体缺石绿→石青的阴阳分染');
ok(/夹叶|双钩/.test(gb) && /重檐/.test(gb), '点景缺夹叶树丛 / 工笔楼阁');
ok(/style: styleOpt = 'atlas'/.test(mr7) &&
   /get\('style'\)/.test(main7) && /mapStyle\(\)/.test(main7),
  '默认背景必须是对面的全境笔法，且 ?style= 可复核');
ok(/setStyle\(/.test(mr7) && /get style\(\)/.test(mr7) &&
   /next === 'gongbi' \? 'gongbi' : 'atlas'/.test(mr7),
  '缺三态画风切换接口（atlas / gongbi / jiehua）');
ok(!/import .*campaign|import .*persist|localStorage|Math\.random/.test(gb),
  '工笔层污染了策略层 / 存档 / 确定性');
ok(/camera\.scale < 1\.6/.test(mr7), '等级角标必须默认不出现');
ok(/ctx\.rect\(p\.c \* TP, p\.r \* TP, TP, TP\)/.test(mr7),
  '可达区必须是整片淡染，不是逐格硬圆点');
ok(/inkCircle\(ctx, cx, cy, TP \* 0\.62/.test(mr7) &&
   !/ctx\.arc\(cx, cy, TP \* 0\.62/.test(mr7) &&
   !/ctx\.strokeRect\(selection\.c/.test(mr7),
  '选中态必须脱离方格框（手绘墨圈，不是 arc 也不是 strokeRect）');
// 主地图 / 作战区：景物与框不再有标准几何（HUD 控件与铺色 fillRect 除外）
ok(/inkCircle\(ctx, circle\.x/.test(mr7) && !/ctx\.arc\(circle\.x/.test(mr7),
  '主地图框选圈必须是手画墨圈，与城内小地图一致');
const gd7 = readFileSync(join(root, 'src/guandu.js'), 'utf8');
ok(!/ctx\.ellipse\(/.test(gd7) && /function wq\(/.test(gd7),
  '作战区蒲苇椭圆与标准四边形已清成抖笔');
ok(!/strokeRidge|BRUSH_|setBrush|brushOn/.test(mr7 + main7),
  '失败的「单条山脊一笔」实验残骸未清干净');
ok(!/绢帛|宣纸|毛笔|界画那头是/.test(gb), '工笔层不该再拿材质给平铺找说法');


// ── v0.9.0：移动端竖屏点击适配 ─────────────────────────────────────────
const cv7 = readFileSync(join(root, 'src/city-view.js'), 'utf8');
const main71 = readFileSync(join(root, 'src/main.js'), 'utf8');
const mr71 = readFileSync(join(root, 'src/map-render.js'), 'utf8');
ok(!/Math\.max\(320, rect\.width\)|Math\.max\(260, rect\.height\)/.test(cv7) &&
   !/rect\.width \|\| 800|rect\.height \|\| 600/.test(mr71),
  '任何尺寸钳制/兜底都会让位图被拉伸，导致点击与画面错位');
ok(/W = rect\.width;[\s\S]{0,120}H = rect\.height;/.test(cv7),
  'canvas 属性尺寸必须严格等于 CSS 尺寸 × DPR');
ok(/if \(rect\.width < 1 \|\| rect\.height < 1\) return false/.test(cv7),
  '首次布局 / 地址栏动画期间拿到 0 尺寸不能重建位图');
ok(/let best = null, bd = Infinity/.test(cv7) && /d < bd/.test(cv7),
  'hitUnit 必须取最近单位，倒序第一个在窄屏会稳定选错人');
ok(/layout\?\.cell \?\? 20\) \* 0\.48/.test(cv7),
  '命中半径必须随 cell 自适应，不能超过半格');
ok(/W < 560/.test(cv7) && /narrow \? 0\.14/.test(cv7),
  '竖屏必须收窄左侧大营，给 24 列城内网格留宽度');
ok(/const up = localPos\(e\)/.test(main71) && !/d\.rect\.left/.test(main71),
  '抬起时必须用实时 rect，不能缓存 down 时的 rect');
ok(/window\.visualViewport/.test(main71) && /vv\.addEventListener\('resize'/.test(main71) &&
   /vv\.addEventListener\('scroll'/.test(main71),
  'iOS 地址栏收起只改 visualViewport，不监听就不会重算位图');
ok(/orientationchange/.test(main71), '横竖屏切换缺重排');
ok(/canvas\.width !== Math\.round\(W \* dpr\)/.test(cv7) &&
   /canvas\.width !== Math\.round\(cssW \* dpr\)/.test(mr71),
  '缺 draw 内尺寸自愈，事件没送达时仍会错位');
ok(/get viewport\(\)/.test(cv7) && /hitUnit,/.test(cv7), '缺烟测用的视口/命中探针');


// ── v0.9.0 / v0.9.0：立绘 + 行军动画 + 器械为主体 ─────────────────────
const sol = readFileSync(join(root, 'src/soldier.js'), 'utf8');
const cv8 = cv7;
ok(/export function drawSoldier\(ctx, u, o\)/.test(sol) &&
   /drawSoldier\(ctx, u, \{/.test(cv8), '精细立绘没接进小地图');
ok(!/Math\.random|Date\.now|performance\.now|new Image|drawImage/.test(sol + cv8),
  '士兵层出现墙钟/随机源/位图，破坏确定性与零位图架构');
ok(/phase: \(sec - m\.startSec\) \* phaseRate \+ m\.seed/.test(cv8) &&
   /const phaseRate = 11 \* \(spd \/ 34\)/.test(cv8),
  '行军相位必须只取模拟时间 sec + id 派生种子，且速率随真实速度缩放');
ok(/const unitSpeed = Math\.max\(4, Math\.min\(68/.test(cv8) &&
   /const dur = Math\.max\(0\.28, total \/ unitSpeed\)/.test(cv8) &&
   !/total \/ 420/.test(cv8),
  '行军耗时必须由兵种速度与距离算出，不能再用 420 魔法常数让人飞奔');
ok(/speed: unitSpeed/.test(cv8) && !/stride:/.test(cv8),
  'motion 必须带真实速度，且不留未消费的 stride 死字段');
ok(/let formationShape = 'block'/.test(cv8),
  '默认阵型必须是方阵，不能默认拉成横队/纵队');
ok(/function syncMotion/.test(cv8) && /function tweenAt/.test(cv8) &&
   /function renderPos/.test(cv8), '缺行军插值三层');
ok(/if \(a\.t >= 1\) \{ motion\.delete/.test(cv8),
  '隔月快进后必须直接吸附终点，不能补跑没人的行军');
ok(/releasePos = \{ x: p\.x, y: p\.y \}/.test(cv8) && /dragPos = \{ x: p\.x, y: p\.y \}/.test(cv8),
  '松手位置必须作为行军起点、拖拽必须跟手');
ok(/const changed = Math\.abs\(prevW - W\) > 1/.test(cv8) && /if \(changed\) \{ motion\.clear/.test(cv8),
  '只有视口真变了才清 motion；每帧自愈 resize 会杀死动画');
ok(!/\bmotion\b[\s\S]{0,400}\bstate\./.test(cv8) && !/campaign\.forces\[[^\]]+\]\s*=\s*motion/.test(cv8),
  '动画状态污染了 state / 存档');
ok(/lightGround/.test(cv8) && /PAL_ON_PAPER|PAL_ON_INK/.test(sol),
  '底色深浅变化时必须自动切换甲色，否则浅绢底上甲片会融掉');

// v0.9.0：器械为主体、遮面去呆萌；v0.9.0：整套改斜俯视
ok(/export function unitKind/.test(sol) && /unitKind,/.test(cv8), '缺器械/人形分派接口');
ok(/type === 'chuangnu'\) drawBedCrossbow/.test(sol) && /drawTrebuchet/.test(sol),
  '床弩 / 抛石机没有画成军械主体');
ok(/function wheelTop/.test(sol) && /function drawCrewTop/.test(sol),
  '军械缺俯视扁椭圆轮或比例尺操作兵');
ok(/drawCrewTop\(ctx, P, -12\.2/.test(sol) && /drawCrewTop\(ctx, P, -10\.8/.test(sol),
  '两具军械都必须只留极小操作兵，不能画成主体人形');
// ── 俯视：脸不可见、顶面可见、不用正侧面立像 ──
ok(/export const VIEW = \{ cos: 0\.53, sin: 0\.85 \}/.test(sol),
  '缺斜俯视投影参数（约 58°，不是 30° 等距）');
ok(/兜鍪顶/.test(sol) && /肩甲/.test(sol) && /顿项/.test(sol),
  '俯视里必须看见兜鍪顶 / 肩甲 / 顿项，而不是正面脸');
ok(!/P\.skin|skin:|face|脸 =/.test(sol) &&
   /脸完全不可见|脸完全不见|看不到五官/.test(sol) &&
   !/line\(ctx, -1\.7 \* k, -9\.1/.test(sol),
  '俯视不该有正面眼缝或肤色 —— 那是正侧面立像的残留');
ok(/function lip\(/.test(sol) && /function wheelTop\(/.test(sol) && /扁椭圆/.test(sol),
  '缺「顶面 + 侧面 + 地面投影」三层：厚度 lip / 扁椭圆轮');
ok(/地面平面|地平面内|地面上的长斜线/.test(sol),
  '兵器与弩臂必须落在地面平面内，不是竖在身侧的正面道具');
ok(/const shield = \(/.test(sol) && /斜置/.test(sol),
  '盾必须斜置可见盾面（俯视），圆盾/竖直贴片都是错的');
ok(!/盔缨|长缨|ctx\.moveTo\(0, -16/.test(sol) && !/line\(ctx, 0, -13\.4/.test(sol),
  '盔缨/天线是呆萌残留');
ok(/墨青|花青/.test(sol) && /榫卯/.test(sol),
  '缺中式设色与木构语汇，容易滑向西式等距 SLG');
ok(/const sway = !engine && walk/.test(sol) && /const wheelRot = engine && walk/.test(sol) &&
   /const jolt = walk/.test(sol),
  '俯视下人形左右晃、器械转轮 + 颠簸；不能再摆腿（那是正面视角）');
ok(/if \(walk && amp > 0\.3\)/.test(sol) && /i < 2/.test(sol),
  '扬尘要按尺度收敛到 2 点，别铺一片（适量度）');
ok(/const k = s \/ 17/.test(sol),
  '俯视定标必须按压缩后的 13k 归一，否则手机单位只有 5px 高');
ok(/if \(s < 13\)/.test(sol) && /function drawTiny/.test(sol),
  '手机档必须换一套极简俯视墨剪影，不能把大图直接缩小（适量度）');
ok(/const tilt = \(seed \/ 6\.2831853 - 0\.5\)/.test(sol) &&
   /ctx\.rotate\(engine \? tilt : -0\.30 \+ tilt\)/.test(sol),
  '缺 id 派生的静态朝向微扰：军阵不该是复制粘贴的正对图标');
ok(/if \(hp < 0\.999 \|\| o\.selected \|\| o\.champion\)/.test(sol),
  '满血不该画亮绿血条，否则默认画面被 UI 抢戏');
ok(!/ref-sheet|ref-topdown|\.webp|\.png['"]/.test(sol + readFileSync(join(root, 'index.html'), 'utf8')),
  'AI 参考图只能当造型参考，不能作为运行时位图贴进游戏');
for (const [t, pat] of [
  ['daodun', /环首直刀/], ['changqiang', /type === 'changqiang'/],
  ['gongnu', /横弩/], ['chuangnu', /type === 'chuangnu'/],
  ['paoshi', /drawTrebuchet/], ['zhongjia', /type === 'zhongjia'/],
  ['junshi', /type === 'junshi'/],
]) ok(pat.test(sol), `兵种 ${t} 缺独立兵器/造型分支`);
ok(/札甲|兜鍪|顿项|护心镜/.test(sol), '缺汉末甲胄结构，退回火柴人');

// ── v0.9.0：写实淡彩八向素材 + 按朝向换帧 ─────────────────────────────
const dirMod = readFileSync(join(root, 'src/direction.js'), 'utf8');
const portMod = readFileSync(join(root, 'src/portrait.js'), 'utf8');
const cv8b = readFileSync(join(root, 'src/city-view.js'), 'utf8');
const mani = JSON.parse(readFileSync(join(root, 'assets/units/trooper.json'), 'utf8'));
ok(mani.frames.length === 8 && mani.frames.every((f, i) => f.angle === i * 45),
  '八向 manifest 角度必须 0..315 每 45°');
ok(mani.frames.every((f) => existsSync(join(root, 'assets/units', f.file))),
  '八向 manifest 里有找不到的素材文件');
ok(existsSync(join(root, 'assets/units/trooper-sheet.png')) &&
   existsSync(join(root, 'assets/units/trooper.json')), '缺 sprite sheet 或 manifest');
ok(mani.frames.every((f) => {
  const b = readFileSync(join(root, 'assets/units', f.file));
  return b.subarray(1, 4).toString() === 'PNG' && b[25] === 6 &&
    b.readUInt32BE(16) === mani.canvas[0] && b.readUInt32BE(20) === mani.canvas[1];
}), '八张素材必须是同尺寸 RGBA PNG（统一脚底基线）');
ok(/export function dirIndex/.test(dirMod) && /export const DIR8/.test(dirMod) &&
   /Math\.floor\(snapped\) % 8/.test(dirMod) && /1e-9/.test(dirMod),
  '八向索引必须是确定性最近邻量化 + 扇区边界吸附，不能靠 scale(-1,1) 镜像');
ok(/headingFromDelta/.test(dirMod) && /normAngle/.test(dirMod),
  '缺「位移向量 → 朝向」与角度规整');
ok(/createPortraits/.test(portMod) && /drawImage\(fr\.sheet, fr\.sx, 0, fr\.sw, fr\.sh/.test(portMod) &&
   /dirIndex\(heading/.test(portMod) && /walkPhase\(o\.walk, o\.phase\)/.test(portMod),
  '位图皮肤必须按 heading 取方向帧、按模拟相位取步态帧，不是固定一张');
ok(/trooper-sheet\.png/.test(portMod) && /trooper-walk-sheet\.png/.test(portMod) &&
   /engine-sheet\.png/.test(portMod) && /trooper-tiny-sheet\.png/.test(portMod),
  '人形 idle/walk、器械八向、手机 tiny 四张 sprite sheet 都必须加载');
ok(!/Date\.|performance\.|Math\.random/.test(portMod.replace(/^\/\/[\s\S]*?\*\//, '')),
  '位图皮肤不能引入墙钟或随机源，否则破坏确定性重放');
ok(/portraits\.ready && portraits\.draw\(ctx, \{ \.\.\.common/.test(cv8b) &&
   /drawSoldier\(ctx, u, \{/.test(cv8b),
  '素材未就绪必须能回退程序化俯视路径，不能白屏');
ok(/heading: rp\.heading/.test(cv8b) && /unitIdleHeading/.test(cv8b),
  '朝向必须逐帧下传，且静止时整队统一朝向（不是按 id 散布）');
ok(/assignFormation/.test(cv8b) && /onFormationMove/.test(cv8b),
  '缺「框选 → 点位置 → 自动列队」接线');
ok(/不进 state|不进存档|不进命令日志|不进状态指纹/.test(portMod),
  '缺「渲染层不污染局面」的边界说明');
ok(/trooper-sheet|trooper\.json|assets\/units/.test(readFileSync(join(root, 'README.md'), 'utf8')),
  'README 缺八向素材说明');

// ── v0.9.0：背面三帧验收锁 / 24 帧步态 / 自动列队 ──────────────────────
ok(!('version' in mani) && mani.phases?.length === 3 &&
   mani.phases.join(',') === 'idle,stepL,stepR',
  'manifest 必须是 8 向 × 3 相位');
ok(mani.sheets?.idle === 'trooper-sheet.png' &&
   mani.sheets?.walk === 'trooper-walk-sheet.png' &&
   existsSync(join(root, 'assets/units/trooper-walk-sheet.png')),
  '缺 idle / walk sprite sheet');
ok(mani.frames.every((f) => {
  const names = [f.file, f.walkL, f.walkR];
  return names.every((n) => n && existsSync(join(root, 'assets/units', n))) &&
    new Set(names).size === 3;
}), '每方向必须有 idle / 左步 / 右步三张互不相同的帧');
ok(readdirSync(join(root, 'assets/units')).filter((f) => f.endsWith('.png')).length >= 26,
  '24 帧 + 2 sheet 共 26 张 PNG 不齐');

// 背面三帧经人工验收：看不到护心镜 / 腰前蝴蝶结 / 盾面铆钉。
// 把验收结论固化成源图 sha256，防止误把旧的「假背面」图放回仓库。
const { createHash } = await import('node:crypto');
const srcDir = join(root, 'assets/units/src');
ok(existsSync(srcDir) && readdirSync(srcDir).length >= 10,
  '缺 8 张人形源图 + 2 张器械基准（都要能一键复现）');
ok(existsSync(join(srcDir, 'src-engine-ballista.jpg')) &&
   existsSync(join(srcDir, 'src-engine-trebuchet.jpg')),
  '缺器械写实基准图');
for (const [dir, hash] of Object.entries(mani.srcSha256 ?? {})) {
  const f = join(srcDir, `src-${dir}.jpg`);
  if (!existsSync(f)) { ok(false, `源图缺失 ${dir}`); continue; }
  const real = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
  ok(real === hash, `源图 ${dir} 与验收版本不符（可能退回了假背面）`);
}
ok(existsSync(join(root, 'scripts/build_units.py')), '缺可复现的资产构建脚本');
ok(/step_frame/.test(readFileSync(join(root, 'scripts/build_units.py'), 'utf8')) &&
   /INTER_NEAREST/.test(readFileSync(join(root, 'scripts/build_units.py'), 'utf8')),
  '步态必须由 idle 确定性派生，不能靠 AI 逐张画腿');

const formMod = readFileSync(join(root, 'src/formation.js'), 'utf8');
const mainMod = readFileSync(join(root, 'src/main.js'), 'utf8');
ok(/export function assignFormation/.test(formMod) &&
   /export function formationOffsets/.test(formMod) &&
   /FORMATIONS = \['line', 'block', 'wedge'\]/.test(formMod),
  '编队必须是可选阵型的纯逻辑层');
ok(!/document|canvas|Date\.|performance\.|Math\.random/.test(formMod.replace(/^\/\/[\s\S]*?\*\//, '')),
  '编队层不能碰 DOM / 墙钟 / 随机源，否则重放会分叉');
ok(/onFormationMove/.test(mainMod) && /deployUnit\(state, cityId, a\.id/.test(mainMod),
  '编队结果必须逐队写回部署，不能只画个圈');

// ── v0.9.4：对面两版舆图接入 / 典籍总揽 / 文档总揽 ────────────────────
const atlas = readFileSync(join(root, 'src/atlas.js'), 'utf8');
const shellSrc = readFileSync(join(root, 'src/ui-shell.js'), 'utf8');
const hist = JSON.parse(readFileSync(join(root, 'config/historica.json'), 'utf8'));
const docSum = readFileSync(join(root, 'docs/建安五年官渡舆图史料汇总.md'), 'utf8');
const demos = readdirSync(join(root, 'demos'));

ok(/export function createAtlas/.test(atlas) &&
   /opts\.LON0 \?\? 93/.test(atlas) && /opts\.seed \?\? 202005/.test(atlas),
  '全境内核必须参数化图幅与 seed，不能写死在内部');
ok(!/document\.getElementById|addEventListener|Math\.random|Date\.now|performance\.now|new Image/.test(atlas),
  'atlas.js 不能带 DOM 交互 / 墙钟 / 随机源 / 位图，否则确定性与零位图破功');
const gd = readFileSync(join(root, 'src/guandu.js'), 'utf8');
const gink = readFileSync(join(root, 'src/ink-stroke.js'), 'utf8');
ok(/export function renderGuanduLayers/.test(gd) && /export const InkStroke/.test(gink),
  '对面官渡舆图内核与 MIT 笔触原语必须各自可复用');
const gdCode = gd.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ok(!/document\.getElementById|addEventListener|requestAnimationFrame|Math\.random|Date\.now|performance\.now|new Image/.test(gdCode),
  '官渡内核不能带 DOM 交互 / 墙钟 / 随机源 / 位图');
ok(/renderLayers\(\)/.test(gd) && /inscriptions\(\)/.test(gd) && /passesFords\(\)/.test(gd),
  '背景层与地物层要整套跑完，不许只画一半');
ok(/G_LON_MIN/.test(gd) && /crop: \{ sx/.test(gd),
  '裁切矩形必须由 map-data.js 的游戏图幅反算，不能写死像素');
ok(/renderGuanduLayers\(\{\}\)/.test(mr7) &&
   /g\.drawImage\(a\.bg, sx, sy, sw, sh, 0, 0, W, H\)/.test(mr7) &&
   /g\.drawImage\(a\.feat, sx, sy, sw, sh, 0, 0, W, H\)/.test(mr7),
  '战区大地图必须整份贴入 bg + feat，并按 crop 精确对齐逻辑格');
ok(/if \(style !== 'atlas'\) drawAnnotations\(ctx\)/.test(mr7),
  '对面已画城名/关津/题识，上层静态注记必须让开，否则重影');
ok(/createAtlas\(\{\}\)/.test(shellSrc) && /a\.bg/.test(shellSrc) && /a\.fg/.test(shellSrc),
  '典籍页全境舆图浏览必须用 bg + fg 全份（十三州图幅）');
ok(demos.includes('建安五年全境舆图.html') && demos.includes('官渡舆图笔势重绘.html'),
  '对面 demos 实验文件必须完整保留，不能覆盖');

const catIds = hist.cats.map((c) => c.id);
ok(JSON.stringify(catIds) === JSON.stringify(['benji','yudi','tufa','xingzhi','yiyi','shumu']),
  '典籍六门必须齐全且有序');
ok(hist.cats.every((c) => c.items.length >= 6 && c.items.every((i) =>
     i.t && i.s && i.n && /^[ABC]$/.test(i.lv))),
  '典籍每条必须有 题 / 文言 / 出处 / A·B·C 级');
const rawHist = readFileSync(join(root, 'config/historica.json'), 'utf8');
ok(!/https?:\/\/|亭是带围墙|1957|新野北安乐寨|南宋苏州|305 座/.test(rawHist),
  '白话细目考据与链接只能留 docs/，不许漏进游戏内文言卷');
ok(/archive: pageArchive, atlasView: pageAtlasView/.test(shellSrc) &&
   /data-act="archive"/.test(shellSrc) && /mountAtlas\(\)/.test(shellSrc),
  '典籍页 / 全境页 / 入口 / canvas 挂载缺一不可');
ok(/'archive', 'atlasView'/.test(shellSrc), '典籍与全境页必须走纸页 data-tone="paper"');
ok(/fetch\('\.\/config\/historica\.json'\)/.test(mainMod) && /historica, actions/.test(mainMod),
  '装配层必须加载并传入典籍数据源');

for (const sec of ['## 12. 史料总揽', '## 13. 细目考据存目', '## 14. 游戏内', '## 15. 重难', '## 16. 资料总揽']) {
  ok(docSum.includes(sec), `史料主文档缺 ${sec}`);
}
ok(/实施总纲|疑难点|落地文件/.test(docSum) && /config\/historica\.json/.test(docSum),
  '§12 必须是「出处→可信度→落地→入图→游戏内→疑难点」的实施总揽');
ok(/16\.2 资料总目/.test(docSum) && /16\.6 未闭环/.test(docSum) &&
   /docs\/全境州郡取数表\.md/.test(docSum) && /不进游戏/.test(docSum),
  '§16 后台总目必须续写在既有主文档里：总目、未闭环、全境底本、文白分工缺一不可');
ok(!/全境那一套只用于/.test(docSum),
  '「全境内核只用于典籍页」是过时口径，已另开 ?map=quanjing 可玩图幅，不得回潮');
ok(/不进游戏/.test(docSum) && /白话/.test(docSum),
  '§13 必须明确标注「后台用 · 白话 · 不进游戏」');
ok(existsSync(join(root, 'docs/十三州全境取数表.md')) &&
   existsSync(join(root, 'docs/背景层落地清单.md')) &&
   existsSync(join(root, 'demos/third-party/ATTRIBUTION.md')),
  '对面 docs / 许可文件必须保留');

// ── 全境图幅：同一套玩法多铺一张图，数据自洽且可切换回来 ──────────────
ok(existsSync(join(root, 'src/quanjing-data.js')), '全境州郡表缺失');
ok(story.chapters.filter((c) => c.mapId === 'quanjing').length === 2, '全境两章缺料');
ok(/id="hudMap"/.test(html4), '图幅切换钮未接进 HUD');
ok(/mapStyle\(\)/.test(main4), '装配层没按图幅选渲染风格');
useMap('quanjing');
const qProblems = validateMap();
ok(qProblems.length === 0, `全境图幅 validateMap 未过：${qProblems.join('；')}`);
ok(CITIES.length >= 28, '全境州郡点不足 28');
ok(MAPS.quanjing.bounds.LON_MAX - MAPS.quanjing.bounds.LON_MIN > 20, '全境图幅没有铺开');
const qBoundsOk = [CITIES, PASSES].every((arr) => arr.every((p) =>
  p.lon >= MAPS.quanjing.bounds.LON_MIN && p.lon <= MAPS.quanjing.bounds.LON_MAX &&
  p.lat >= MAPS.quanjing.bounds.LAT_MIN && p.lat <= MAPS.quanjing.bounds.LAT_MAX));
ok(qBoundsOk, '全境城池/关隘越出图幅');

// ── 全境两章：章回文案 / 州郡事件 / 纪事（2026-11-19） ────────────────
const q9 = story.chapters.find((c) => c.id === 'ch9');
const q10 = story.chapters.find((c) => c.id === 'ch10');
const MECH_WORDS = ['命令日志', '隔旬快进', '实时同解', '累计逻辑步', '快照',
  'state', '点地、下令', 'canvas', '栅格', '调试面板'];
ok(!!q9 && !!q10, '全境两章 ch9 / ch10 缺一');
ok(q9 && ['雒阳', '长安', '邺', '蓟', '临淄', '襄阳', '江陵', '成都', '番禺']
  .every((n) => q9.beat.includes(n)), '第九回章回文案没落到具体州郡');
ok(q10 && ['谯', '邺', '新野', '襄阳', '南郑']
  .every((n) => q10.beat.includes(n)), '第十回章回文案没落到具体州郡');
ok(q10 && q10.historical.includes('夏五月薨'), '第十回史注须写明薨在五月，不提前到正月');
for (const c of [q9, q10]) {
  ok(c && MECH_WORDS.every((w) => !c.beat.includes(w)), `「${c?.id}」叙事漏出工程 / 调试语`);
  ok(c && !!c.onEnter?.report?.body && !!c.onEnter?.mail?.body, `「${c?.id}」缺入场纪事或私信`);
  ok(c && MECH_WORDS.every((w) => !(c.onEnter.report.body + c.onEnter.mail.body).includes(w)),
    `「${c?.id}」纪事漏出工程语`);
}
ok(q9 && !q9.onEnter.city && !q9.onEnter.intel,
  '第九回是开篇章，配 city / intel 会成为永远读不到的死字段');
ok(q10 && q10.onEnter.city?.length >= 4 && q10.onEnter.intel?.length >= 4,
  '第十回州郡事件 / 斥候情报不足');
const qIds = new Set(CITIES.map((c) => c.id));   // 此处 useMap('quanjing') 已生效
ok(q10 && q10.onEnter.city.every((e) => qIds.has(e.id) && e.owner === undefined &&
     ['garrison', 'wall', 'morale'].some((k) => Number.isFinite(e[k]))),
  '州郡事件 id 越界、改了归属或没有实效');
ok(q10 && q10.onEnter.intel.every((id) => qIds.has(id)), '斥候情报 id 越界');
ok(hist.cats.find((c) => c.id === 'benji')?.items.some((i) => i.t === '全境两章'),
  '典籍本纪门缺「全境两章」文言一条');
const mainSrc = readFileSync(join(root, 'src/main.js'), 'utf8');
const storySrc = readFileSync(join(root, 'src/story.js'), 'utf8');
ok(/export function openingDispatches/.test(storySrc) && /openingDispatches\(story\)/.test(mainSrc),
  '开篇章 onEnter 注入函数缺失');
ok((mainSrc.match(/reports = \(state\.reports \?\? \[\]\)\.slice\(\)/g) ?? []).length >= 2,
  'boot 与「新开一局」都要同步全局 reports，否则开篇章纪事看不到');
ok(!/reports = \[\]; state\.reports = reports/.test(mainSrc), '「新开一局」又把开篇章纪事清空了');
const qDoc = readFileSync(join(root, 'docs/全境两章纪事底本.md'), 'utf8');
ok(/后台开发用 · 白话 · 不进游戏/.test(qDoc) && /州郡事件台账/.test(qDoc) && /文白分工/.test(qDoc),
  '全境两章白话底本缺总目 / 台账 / 分工');
useMap('guandu');

// ── 率土-like 旬循环：资源闭环 / AI 对手 / 三席存档 / 终局 / 玩家可见署名 ──
for (const f of ['src/economy.js', 'src/ai.js', 'src/save-slots.js', 'src/outcome.js',
  'tests/economy.test.mjs', 'tests/ai.test.mjs', 'tests/save-slots.test.mjs',
  'tests/outcome.test.mjs']) {
  ok(existsSync(join(root, f)), `缺少本轮新增文件 ${f}`);
}
const econ = readFileSync(join(root, 'src/economy.js'), 'utf8');
const aiSrc = readFileSync(join(root, 'src/ai.js'), 'utf8');
const slots = readFileSync(join(root, 'src/save-slots.js'), 'utf8');
const outc = readFileSync(join(root, 'src/outcome.js'), 'utf8');
const camp = readFileSync(join(root, 'src/campaign.js'), 'utf8');
// shellSrc 在 §v0.9.4 已声明，这里直接复用，不重复 readFileSync。
const mainAll = readFileSync(join(root, 'src/main.js'), 'utf8');
const inkHead = readFileSync(join(root, 'src/ink-stroke.js'), 'utf8');
const guanduHead = readFileSync(join(root, 'src/guandu.js'), 'utf8');
const cssAll = readFileSync(join(root, 'styles/main.css'), 'utf8');

// 旧版致命 bug 不许回潮：每城各加一次全势力产量、AI 每两旬只两招。
ok(!/c\.grain\s*\+=\s*\(own\?\.grain/.test(camp),
  '城仓又把全势力总产量整份记了一遍，断粮 debuff 会永远不触发');
ok(!/state\.turn % 2 !== 0/.test(camp), 'AI 又退回「每两旬一次、只有铺路/出征」');
ok(/settleXun\(state, yieldByOwner\)/.test(camp) && /import .*economy\.js/.test(camp),
  'advanceTurn 没接旬结算');
ok(/planAiTurn\(state, f, rng\)/.test(camp) && /import .*ai\.js/.test(camp),
  'AI 决策没接进 advanceTurn');
ok(/export function settleXun/.test(econ) && /export function canAffordTroops/.test(econ) &&
   /yieldByOwner\?\.\[fid\]\?\.grain/.test(econ), '旬结算缺产量分摊或发令约束');
ok(/export const AI_WEIGHTS/.test(aiSrc) &&
   ['expand', 'defend', 'raid', 'march'].every((k) => aiSrc.includes(`${k}:`)),
   'AI 四类权重分桶不全');
// 剥掉行注释再扫：文件头「零 DOM / 墙钟 / Math.random」是宣言，不是真调用。
const aiCode = aiSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok(/export function planAiTurn/.test(aiSrc) && !/Math\.random|Date\.|localStorage|document\./.test(aiCode),
   'AI 层引入了墙钟 / 随机 / DOM，重放会分叉');
ok(/export const SLOT_COUNT = 3/.test(slots) && /export function restoreBackup/.test(slots) &&
   /export function backupSlot/.test(slots), '三席存档 / 坏档回退缺件');
ok(/export function checkOutcome/.test(outc) && /outcomeShown/.test(mainAll) &&
   /checkOutcome\(state\)/.test(mainAll), '终局判定没接进旬末');
ok(/listSlots/.test(mainAll) && /loadSlot/.test(mainAll) && /saveSlot/.test(mainAll),
   '三席存档没接进装配层');
ok(/commissary/.test(readFileSync(join(root, 'src/persist.js'), 'utf8')),
   '军粮账没进存档，读档后旬计簿会跳变');

// MIT 署名：源码头 + 玩家可见页 + 许可全文，三处缺一不可。
ok(/Copyright \(c\) 2018 Lingdong Huang/.test(inkHead) &&
   /demos\/third-party\/LICENSE-/.test(inkHead), 'ink-stroke.js 头上游声明或许可路径');
ok(/Copyright \(c\) 2018 Lingdong Huang/.test(guanduHead) &&
   /pageCredits/.test(guanduHead), 'guandu.js 头缺上游声明或致谢页锚点');
ok(/function pageCredits/.test(shellSrc) && /Copyright \(c\) 2018 Lingdong Huang/.test(shellSrc) &&
   /THE SOFTWARE IS PROVIDED "AS IS"/.test(shellSrc), '游戏内致谢页缺原作者声明或许可全文');
ok(/data-act="credits"/.test(shellSrc) && /case 'credits'/.test(shellSrc),
   '致谢页没有可点入口或事件分发');
ok(/\.creditsLicense/.test(cssAll), '许可全文没有可读样式');
for (const [p, label] of [['src/economy.js', '旬结算'], ['src/ai.js', 'AI'],
  ['src/save-slots.js', '三席存档'], ['src/outcome.js', '终局']]) {
  const t = readFileSync(join(root, p), 'utf8');
  ok(!/['"]0\.9\.\d['"]/.test(t), `${label} 写了版本字面量，版本唯一源被破坏`);
}
// 明文护栏：便签正文 / 项目 ref / 任何 token 形状不许进源码。
// 片段拼接而非整串字面，护栏文件自身也不会被推送脚本的明文扫描误拒。
const BAD_SECRETS = [
  ['2012', 'ming0421lym'], ['duqpvya', 'fertiaohabrnz'],
  ['webnote', '.cc/p/'], ['gh', 'p_'], ['PGPASSWORD: ', '2012'],
].map((parts) => parts.join(''));
const scannedSrc = econ + aiSrc + slots + outc + camp + shellSrc + mainAll + inkHead + guanduHead;
for (const bad of BAD_SECRETS) {
  ok(!scannedSrc.includes(bad), `源码出现明文 ${bad.slice(0, 4)}…`);
}

if (problems.length) {
  console.error(`\n✗ 静态自检未通过（${problems.length} 项）：\n - ` + problems.join('\n - '));
  process.exit(1);
}
console.log('\n✓ 地图/连通性/导航/指纹/界面机制/历法章回/联机地基/审美收尾/授简自检全绿');
