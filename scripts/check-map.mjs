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
ok(cfg.meta.version === '0.8.0', 'meta.version 与生成物指纹不一致');
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
ok(html.includes('?v=0.8.0'), 'HTML 入口缺少版本指纹');
ok(main.includes("?v=0.8.0"), 'ESM import 缺少版本指纹');
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
ok(/style: styleOpt = 'gongbi'/.test(mr7) &&
   /get\('style'\) === 'jiehua' \? 'jiehua' : 'gongbi'/.test(main7),
  '默认必须是工笔，且保留 ?style=jiehua 复核开关');
ok(/setStyle\(/.test(mr7) && /get style\(\)/.test(mr7), '缺 A/B 切换接口');
ok(!/import .*campaign|import .*persist|localStorage|Math\.random/.test(gb),
  '工笔层污染了策略层 / 存档 / 确定性');
ok(/camera\.scale < 1\.6/.test(mr7), '等级角标必须默认不出现');
ok(/ctx\.rect\(p\.c \* TP, p\.r \* TP, TP, TP\)/.test(mr7),
  '可达区必须是整片淡染，不是逐格硬圆点');
ok(/ctx\.arc\(cx, cy, TP \* 0\.62/.test(mr7), '选中态必须脱离方格框');
ok(!/strokeRidge|BRUSH_|setBrush|brushOn/.test(mr7 + main7),
  '失败的「单条山脊一笔」实验残骸未清干净');
ok(!/绢帛|宣纸|毛笔|界画那头是/.test(gb), '工笔层不该再拿材质给平铺找说法');


// ── v0.8.0：移动端竖屏点击适配 ─────────────────────────────────────────
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


// ── v0.8.0 / v0.8.0：立绘 + 行军动画 + 器械为主体 ─────────────────────
const sol = readFileSync(join(root, 'src/soldier.js'), 'utf8');
const cv8 = cv7;
ok(/export function drawSoldier\(ctx, u, o\)/.test(sol) &&
   /drawSoldier\(ctx, u, \{/.test(cv8), '精细立绘没接进小地图');
ok(!/Math\.random|Date\.now|performance\.now|new Image|drawImage/.test(sol + cv8),
  '士兵层出现墙钟/随机源/位图，破坏确定性与零位图架构');
ok(/phase: \(sec - m\.startSec\) \* 11 \+ m\.seed/.test(cv8),
  '行军相位必须只取模拟时间 sec + id 派生种子');
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

// v0.8.0：器械为主体、遮面去呆萌；v0.8.0：整套改斜俯视
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

if (problems.length) {
  console.error(`\n✗ 静态自检未通过（${problems.length} 项）：\n - ` + problems.join('\n - '));
  process.exit(1);
}
// ── v0.8.0：写实淡彩八向素材 + 按朝向换帧 ─────────────────────────────
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
   /Math\.floor\(a \/ SECTOR \+ 0\.5\) % 8/.test(dirMod),
  '八向索引必须是确定性最近邻量化，不能靠 scale(-1,1) 镜像');
ok(/headingFromDelta/.test(dirMod) && /normAngle/.test(dirMod),
  '缺「位移向量 → 朝向」与角度规整');
ok(/createPortraits/.test(portMod) && /drawImage\(img/.test(portMod) &&
   /dirIndex\(o\.heading/.test(portMod),
  '位图皮肤必须按 heading 取帧，不是固定一张');
ok(!/Date\.|performance\.|Math\.random/.test(portMod.replace(/^\/\/[\s\S]*?\*\//, '')),
  '位图皮肤不能引入墙钟或随机源，否则破坏确定性重放');
ok(/unitKind\(u\.type\) !== 'engine' && portraits\.ready && portraits\.draw/.test(cv8b) &&
   /drawSoldier\(ctx, u, \{/.test(cv8b),
  '素材未就绪必须能回退程序化俯视路径，不能白屏');
ok(/lastHeading/.test(cv8b) && /heading: rp\.heading/.test(cv8b),
  '朝向必须逐帧传下去且静止时保留，不能每次回弹正面');
ok(/不进 state|不进存档|不进命令日志|不进状态指纹/.test(portMod),
  '缺「渲染层不污染局面」的边界说明');
ok(/trooper-sheet|trooper\.json|assets\/units/.test(readFileSync(join(root, 'README.md'), 'utf8')),
  'README 缺八向素材说明');

console.log('\n✓ 地图/连通性/导航/指纹/界面机制/历法章回/联机地基/审美收尾/授简自检全绿');
