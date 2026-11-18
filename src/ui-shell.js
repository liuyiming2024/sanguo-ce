// 率土式整套界面外壳。
// 一条原则：逻辑层（campaign / battle-session / terrain）一行不改其职责，
// 这里只负责「像那个游戏」—— 顶部资源条、底部主菜单 Tab、全屏子页面、
// 每个页面都有 × 与返回、Esc 逐级退出。所有数值从 state 实时派生，不是写死的假界面。
import { CITIES, cityById } from './map-data.js';
import { createAtlas } from './atlas.js';
import { dateLabel } from './campaign.js';
import { formatCalendar } from './calendar.js';
import {
  currentChapter, chapterIndex, chapterById, goalProgress, canAdvance,
  chapterHeadline, allMails,
} from './story.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n ?? 0).toLocaleString('zh-CN');

/** 卷末题记：墨底页下方不再是一整块纯黑，留白要有人撑着。 */
const scrollEnd = (line = '建安五年 · 官渡行台') => `
  <div class="scrollEnd">
    <div class="endSeal">记</div>
    <h4>卷 末</h4>
    <p>${esc(line)}</p>
    <div class="endLine"></div>
  </div>`;

/** 空态不是两行小字加 800px 黑：给一枚淡印、一句题记、一条渐隐线。 */
const emptyScroll = (title, note) => `
  <div class="scrollEnd" style="margin-top:34px;padding-top:26px">
    <div class="endSeal">待</div>
    <h4>${esc(title)}</h4>
    <p>${esc(note)}</p>
    <div class="endLine"></div>
  </div>`;


const TABS = [
  { id: 'map', name: '地图', glyph: '舆' },
  { id: 'interior', name: '内政', glyph: '城' },
  { id: 'heroes', name: '武将', glyph: '将' },
  { id: 'tactics', name: '战法', glyph: '策' },
  { id: 'army', name: '部队', glyph: '阵' },
  { id: 'reports', name: '战报', glyph: '报' },
  { id: 'mail', name: '邮件', glyph: '书' },
  { id: 'story', name: '纪事', glyph: '纪' },
  { id: 'alliance', name: '同盟', glyph: '盟' },
  { id: 'world', name: '天下', glyph: '势' },
  { id: 'system', name: '系统', glyph: '设' },
];

const TITLE = {
  chapterRead: ['章回回看', ''],
  interior: ['内政 · 设施', '城主府为本，左军事、右内政'],
  facility: ['设施详情', '升级立即生效'],
  heroes: ['武将', '点将台 · 在野与在任'],
  hero: ['武将详情', '五维 / 兵种 / 战法'],
  tactics: ['战法', '军师计策，不悖物理'],
  tactic: ['战法详情', ''],
  army: ['部队', '大营 / 中军 / 前锋'],
  heroPick: ['配置武将', '选一位放入该位置'],
  march: ['出征', '先探后战，量力而行'],
  reports: ['战报', '探路 / 交战 / 占领'],
  report: ['战报详情', ''],
  mail: ['邮件', '军情 · 私信 · 同盟'],
  mailRead: ['邮件', ''],
  story: ['官渡纪事', '章回 · 军务 · 抉择'],
  tasks: ['任务', '主线与日常'],
  alliance: ['同盟', '合纵连横'],
  world: ['天下', '建安五年 · 天下大势'],
  system: ['系统', '设置与存档'],
  archive: ['典籍总揽', '建安五年 · 官渡行台藏书'],
  atlasView: ['十三州全境舆图', '西止玉门 · 东含乐浪 · 南含日南'],
  help: ['玩法', ''],
};

/** 升级消耗：页面展示与扣费共用同一公式，避免两处算出不同数字。 */
export function facilityCost(f, lv) {
  const mul = Math.pow(1.32, lv);
  return Object.fromEntries(Object.entries(f.cost).map(([k, v]) => [k, Math.round(v * mul)]));
}

// 文治页反纸：内政 / 政令 / 任务 / 邮件 / 同盟 / 天下 / 系统 / 玩法。
// 武将、战法、部队、出征、战报仍走墨底，一深一浅才有翻页节奏。
const PAPER_ROUTES = new Set(['interior', 'facility', 'story', 'tasks', 'mail', 'mailRead',
  'alliance', 'world', 'system', 'help', 'archive', 'atlasView']);

export function createShell({ cfg, uiData, story, historica, actions, getState, getReports, onRoute }) {
  const screen = document.getElementById('screen');
  const tabsEl = document.getElementById('bottomBar');
  let stack = [];
  let onChange = () => {};

  const state = () => getState();
  const pf = () => state().playerFaction;
  const R = () => state().resources[pf()] ?? { wood: 0, stone: 0, iron: 0, grain: 0 };
  const ownCities = () => CITIES.filter((c) => state().cities[c.id]?.owner === pf());
  const landCount = () => state().terrain.tiles.reduce((a, t) => a + (t.owner === pf() ? 1 : 0), 0);
  const facLv = (id) => state().facilities?.[id] ??
    uiData.facilities.find((f) => f.id === id)?.lv ?? 0;
  const heroById = (id) => uiData.heroes.find((h) => h.id === id);

  // ── 导航栈 ────────────────────────────────────────────────────────────
  function navigate(route, params = {}) {
    if (route === 'map') { stack = []; }
    else {
      // 主菜单 Tab 是根页面：切页即重置栈，子页面（facility/hero/...）才压栈。
      if (TABS.some((t) => t.id === route)) stack = [];
      stack.push({ route, params });
    }
    render();
  }
  function back() {
    stack.pop();
    render();
  }
  function closeAll() { stack = []; render(); }
  function current() { return stack.length ? stack[stack.length - 1] : { route: 'map', params: {} }; }

  // ── 页面片段 ──────────────────────────────────────────────────────────
  function statGrid(items) {
    return `<div class="statGrid">${items.map(([k, v, u]) =>
      `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}<small>${esc(u ?? '')}</small></div></div>`).join('')}</div>`;
  }
  const sec = (t, sub = '') =>
    `<div class="secTitle">${esc(t)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;

  function pageInterior() {
    const s = state();
    const core = uiData.facilities.find((f) => f.branch === 'core');
    const mil = uiData.facilities.filter((f) => f.branch === 'mil');
    const eco = uiData.facilities.filter((f) => f.branch === 'eco');
    const facHtml = (f) => {
      const lv = facLv(f.id);
      const locked = core && f.need > 0 && facLv('chengzhufu') < f.need;
      return `<div class="fac${locked ? ' locked' : ''}" data-act="fac" data-id="${f.id}">
        <div class="glyph">${esc(f.name[0])}</div>
        <div style="flex:1;min-width:0">
          <div class="fn">${esc(f.name)}</div>
          <div class="fl">Lv.${lv} / ${f.max}${locked ? ` · 需城主府 ${f.need} 级` : ''}</div>
          <div class="fbar"><i class="barFill" style="width:${Math.round(lv / f.max * 100)}%"></i></div>
        </div></div>`;
    };
    const col = (tag, list) => `<div class="facCol"><div class="colTag">${tag}</div>${list.map(facHtml).join('')}</div>`;
    return `
      ${sec('主城 · 设施', `${ownCities().length} 座己方城池 · 领地 ${fmt(landCount())} 格`)}
      <p class="hintLine">点击任一设施查看效果与升级消耗。建筑以城主府等级为核心，军事与内政两支可并行发展。</p>
      ${statGrid([
        ['木材', fmt(R().wood), ''], ['石料', fmt(R().stone), ''],
        ['铁矿', fmt(R().iron), ''], ['粮草', fmt(R().grain), ''],
        ['势力值', fmt(landCount() * 12 + ownCities().length * 300), ''],
        ['铜钱', fmt(s.copper ?? 0), ''],
      ])}
      <div class="cityGround">
        <div class="facilityGrid">
          ${col('军 事', mil)}
          <div class="facCol">
            <div class="colTag">城 主 府</div>
            <div class="facCore" data-act="fac" data-id="${core.id}">
              <div class="roof">⌂</div>
              <div class="fn">${esc(core.name)}</div>
              <div class="fl">Lv.${facLv(core.id)} / ${core.max}</div>
              <div class="note">${esc(core.desc)}</div>
            </div>
          </div>
          ${col('内 政', eco)}
        </div>
      </div>
      <div style="margin-top:14px">${sec('快捷内政')}
        <div class="cardList">
          <div class="card" data-act="quick" data-id="tax"><h3>税收</h3><div class="meta">民居 Lv.${facLv('minju')} · 消耗政令 1</div><div class="desc">按民居等级收取铜钱，立即到账。</div></div>
          <div class="card" data-act="quick" data-id="trade"><h3>交易</h3><div class="meta">集市 Lv.${facLv('jishi')}</div><div class="desc">四类资源按比例互换，损耗 20%。</div></div>
          <div class="card" data-act="quick" data-id="hold"><h3>坚守</h3><div class="meta">城墙 Lv.${facLv('chengqiang')}</div><div class="desc">本城进入固守，耐久流失减半，持续 3 旬。</div></div>
          <div class="card" data-act="quick" data-id="recruit"><h3>征兵</h3><div class="meta">募兵所 Lv.${facLv('mubingsuo')}</div><div class="desc">消耗粮草补充本城守军 500。</div></div>
        </div></div>`;
  }

  function pageFacility(p) {
    const f = uiData.facilities.find((x) => x.id === p.id);
    if (!f) return '<p class="hintLine">未找到该设施。</p>';
    const lv = facLv(f.id);
    const cost = facilityCost(f, lv);
    const coreLv = facLv('chengzhufu');
    const locked = f.need > 0 && coreLv < f.need;
    const full = lv >= f.max;
    const label = { wood: '木', stone: '石', iron: '铁', grain: '粮' };
    return `
      <div class="detail">
        <div class="portrait"><div class="pname">${esc(f.name)}</div><div class="pseal">${esc(f.branch === 'mil' ? '军' : f.branch === 'eco' ? '政' : '本')}</div></div>
        <div>
          ${sec('设施 · ' + f.name, `Lv.${lv} / ${f.max}`)}
          <p class="readBody">${esc(f.desc)}\n\n当前效果：${esc(f.effect)}\n满级激活：${esc(f.unlockAtMax)}\n前置：城主府 ${f.need} 级（当前 ${coreLv} 级${locked ? '，未满足' : '，已满足'}）</p>
          ${sec('升级消耗', full ? '已升至最高等级' : `Lv.${lv} → Lv.${lv + 1}`)}
          <div class="statGrid">${Object.entries(cost).map(([k, v]) =>
            `<div class="stat"><div class="k">${label[k] ?? k}</div><div class="v">${fmt(v)}</div></div>`).join('')}</div>
          <p class="hintLine">现有：木 ${fmt(R().wood)} · 石 ${fmt(R().stone)} · 铁 ${fmt(R().iron)} · 粮 ${fmt(R().grain)}</p>
          ${full
            ? '<div class="verdict">已升至最高等级<small>满级效果已激活</small></div>'
            : locked
              ? `<div class="verdict">城主府需达 ${f.need} 级方可继续升级<small>先升级城主府解锁</small></div>
                 <button class="bigBtn ghost" data-act="fac" data-id="chengzhufu">前往城主府</button>`
              : `<button class="bigBtn" data-act="upg" data-id="${f.id}">升 级</button>`}
          <button class="bigBtn ghost" data-act="back">返回设施总览</button>
        </div>
      </div>`;
  }

  function heroCard(h) {
    return `<div class="card" data-act="hero" data-id="${h.id}">
      <div class="stamp">${esc(h.faction)}</div>
      <div class="stars">${'★'.repeat(h.star)}${'☆'.repeat(5 - h.star)}</div>
      <h3>${esc(h.name)}</h3>
      <div class="meta">${esc(h.type)}兵 · C ${h.cost} · 兵力 ${fmt(h.troops)}<br>主战法：${esc(h.tactic)}</div>
      <div class="desc">${esc(h.bio)}</div></div>`;
  }
  function pageHeroes() {
    const own = uiData.heroes.filter((h) =>
      (pf() === 'cao' && h.faction === '魏') ||
      (pf() === 'yuan' && h.faction === '群') ||
      (pf() === 'liu' && h.faction === '蜀'));
    const other = uiData.heroes.filter((h) => !own.includes(h));
    return `${sec('在任武将', `${own.length} 位 · 点将台按势力归类`)}
      <div class="cardList">${own.map(heroCard).join('')}</div>
      ${sec('天下群雄', '尚未录用 / 敌方在阵')}
      <div class="cardList">${other.map(heroCard).join('')}</div>`;
  }
  function pageHero(p) {
    const h = heroById(p.id);
    if (!h) return '<p class="hintLine">未找到该武将。</p>';
    const keys = ['统率', '武力', '智力', '政治', '忠诚'];
    // 五维雷达：五边形，不用「圆圈中间一个汉字」
    const cx = 110, cy = 105, rad = 78;
    const pt = (i, v) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      const r = rad * (v / 100);
      return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
    };
    const axes = h.dim.map((_, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      return `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * rad).toFixed(1)}" y2="${(cy + Math.sin(a) * rad).toFixed(1)}" stroke="rgba(200,168,106,.25)"/>`;
    }).join('');
    const poly = h.dim.map(pt).join(' ');
    return `<div class="detail">
      <div class="portrait">
        <div class="pname">${esc(h.name)}</div><div class="pseal">${esc(h.faction)}</div>
        <div class="stars" style="margin-top:12px">${'★'.repeat(h.star)}</div>
      </div>
      <div>
        ${sec('五维', `统率 ${h.dim[0]} · 成长上限 100`)}
        <svg viewBox="0 0 220 210" style="width:100%;max-width:220px;display:block;margin:0 auto 10px">
          <polygon points="${[0, 1, 2, 3, 4].map((i) => {
            const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
            return `${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`;
          }).join(' ')}" fill="none" stroke="rgba(200,168,106,.4)"/>
          ${axes}
          <polygon points="${poly}" fill="rgba(166,49,41,.32)" stroke="#d05a4b" stroke-width="1.5"/>
          ${h.dim.map((v, i) => {
            const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
            const r = rad * (v / 100);
            return `<circle cx="${(cx + Math.cos(a) * r).toFixed(1)}" cy="${(cy + Math.sin(a) * r).toFixed(1)}" r="2.4" fill="#e8c882"/>`;
          }).join('')}
        </svg>
        ${keys.map((k, i) => `<div class="dimRow"><div class="dk">${k}</div>
          <div class="dbar"><i class="barFill" style="width:${h.dim[i]}%"></i></div><div class="dv">${h.dim[i]}</div></div>`).join('')}
        ${sec('履历')}
        <p class="readBody">${esc(h.bio)}\n\n兵种：${esc(h.type)}　COST：${h.cost}\n当前兵力：${fmt(h.troops)}\n主战法：${esc(h.tactic)}\n体力：100 / 100（每次出征消耗 20，每旬恢复 20）</p>
        <button class="bigBtn ghost" data-act="back">返回武将库</button>
      </div></div>`;
  }

  function pageTactics() {
    return `${sec('战法库', `${uiData.tactics.length} 策 · 军师为辅助，不改物理法则`)}
      <p class="hintLine">军师为辅助：计策只作用于士气、行军、城防与齐射方向，不引入额外物理法则。</p>
      <div class="cardList">${uiData.tactics.map((t) => `
        <div class="card" data-act="tactic" data-id="${t.id}">
          <div class="stamp">${esc(t.rarity)}</div>
          <h3>${esc(t.name)}</h3>
          <div class="meta"><span class="rarity">${esc(t.type)}</span>传承 · ${esc(t.holder)}</div>
          <div class="desc">${esc(t.desc)}</div></div>`).join('')}</div>`;
  }
  function pageTactic(p) {
    const t = uiData.tactics.find((x) => x.id === p.id);
    if (!t) return '<p class="hintLine">未找到该战法。</p>';
    return `${sec(t.name, `${t.rarity} 级 · ${t.type}`)}
      <p class="readBody">${esc(t.desc)}\n\n可传承武将：${esc(t.holder)}\n类型：${esc(t.type)}战法\n\n在城池布阵界面框选部队后二次拖拽指定方向，远程单位齐射、近战单位突击；军师计策经「军情」按时间戳投递到战斗层。</p>
      <button class="bigBtn ghost" data-act="back">返回战法库</button>`;
  }

  function pageArmy() {
    const s = state();
    const armies = s.armies ?? [];
    const unlocked = 1 + Math.floor((facLv('xiaochang') - 1) / 2);
    return `${sec('部队编成', `校场 Lv.${facLv('xiaochang')} · 已解锁 ${Math.min(unlocked, armies.length)} 支部队`)}
      <p class="hintLine">每支部队由大营、中军、前锋三位置组成，大营必须配置武将方可出征。点空位放入武将。</p>
      ${armies.map((a, i) => {
        const locked = i >= unlocked;
        const pos = ['大营', '中军', '前锋'];
        return `<div class="troopCard" style="${locked ? 'opacity:.45' : ''}">
          <div class="th"><b>第 ${i + 1} 部队</b>
            <span style="font-size:11px;color:var(--dim)">${locked ? '校场等级不足' : `兵力 ${fmt(a.slots.reduce((x, id) => x + (heroById(id)?.troops ?? 0), 0))} · 体力 ${a.stamina ?? 100}/100`}</span>
            <span class="spacer"></span>
            ${locked ? '' : `<button class="bigBtn ghost" style="width:auto;min-height:32px;margin:0;padding:4px 12px" data-act="march" data-army="${i}">出征</button>`}
          </div>
          <div class="slots">${pos.map((pn, k) => {
            const h = heroById(a.slots[k]);
            return `<div class="slot${h ? '' : ' empty'}" ${locked ? '' : `data-act="slot" data-army="${i}" data-slot="${k}"`}>
              <div class="pos">${pn}</div>
              <div class="hn">${h ? esc(h.name) : '＋ 配置'}</div>
              <div class="ht">${h ? `${h.type}兵 · ${fmt(h.troops)}` : '空位'}</div></div>`;
          }).join('')}</div></div>`;
      }).join('')}`;
  }
  function pageHeroPick(p) {
    const army = Number(p.army), slot = Number(p.slot);
    const s = state();
    const own = uiData.heroes.filter((h) =>
      (pf() === 'cao' && h.faction === '魏') ||
      (pf() === 'yuan' && h.faction === '群') ||
      (pf() === 'liu' && h.faction === '蜀'));
    const taken = (s.armies ?? []).flatMap((a, i) => a.slots.map((id, k) => (i === army && k === slot ? null : id))).filter(Boolean);
    return `${sec(`第 ${army + 1} 部队 · ${['大营', '中军', '前锋'][slot]}`, '点一位武将放入')}
      <div class="cardList">${own.map((h) => `<div class="card" style="${taken.includes(h.id) ? 'opacity:.4' : ''}"
        data-act="assign" data-army="${army}" data-slot="${slot}" data-id="${h.id}">
        <div class="stamp">${esc(h.type)}</div><h3>${esc(h.name)}</h3>
        <div class="meta">${'★'.repeat(h.star)} · C ${h.cost}<br>统 ${h.dim[0]} 武 ${h.dim[1]} 智 ${h.dim[2]}</div>
        <div class="desc">${taken.includes(h.id) ? '已在其他位置' : esc(h.tactic)}</div></div>`).join('')}</div>
      <button class="bigBtn ghost" data-act="back">返回部队</button>`;
  }

  function pageMarch(p) {
    const s = state();
    const target = p.cityId ? cityById(p.cityId) : null;
    const tile = p.tile;
    const name = target ? target.name : tile ? `(${tile.c},${tile.r})` : '—';
    const hostile = target ? s.cities[target.id]?.owner !== pf() : true;
    const d = tile && s.terrain?.at ? s.terrain.at(tile.c, tile.r) : null;
    const level = d?.level ?? (target ? 5 : 3);
    const garrison = target ? s.cities[target.id]?.garrison ?? 0 : Math.round(600 * level);
    const distKm = p.km ?? 0;
    const turns = p.turns ?? s.cfg.orders.minArriveTurn;
    const arrive = s.turn + turns;
    const armyIdx = Number(p.army ?? 0);
    const army = s.armies?.[armyIdx] ?? { slots: [], stamina: 100 };
    const troops = army.slots.reduce((x, id) => x + (heroById(id)?.troops ?? 0), 0);
    const ratio = troops / Math.max(1, garrison);
    const verdict = ratio > 2.2 ? ['兵不血刃', '敌我悬殊，几无战损']
      : ratio > 1.4 ? ['损失在所难免', '可胜，但需预备补兵']
        : ratio > 0.85 ? ['杀敌一千，自损八百', '势均力敌，建议先增援']
          : ['敌军兵力强盛', '恐难取胜，宜先侦察与屯田'];
    const label = { wood: '木', stone: '石', iron: '铁', grain: '粮' };
    return `${sec('出征 · ' + name, hostile ? '敌对目标' : '己方城池')}
      <div class="marchGrid">
        <div class="panel"><h3>目标情报</h3>
          <div class="kv"><span>目标</span><b>${esc(name)}</b></div>
          <div class="kv"><span>土地等级</span><b>Lv.${level}</b></div>
          <div class="kv"><span>守军预估</span><b>${fmt(garrison)}</b></div>
          <div class="kv"><span>归属</span><b>${target ? esc((s.cfg.factions.find((f) => f.id === s.cities[target.id]?.owner) ?? {}).name ?? '—') : '无主 / 敌方'}</b></div>
          <div class="kv"><span>行军距离</span><b>${distKm.toFixed(0)} km</b></div>
          <div class="kv"><span>行军回合</span><b>${turns} 旬</b></div>
          <div class="kv"><span>预计抵达</span><b>${esc(formatCalendar(arrive, s.cfg.calendar, 'short'))}</b></div>
          <div class="kv"><span>体力消耗</span><b>20（剩余 ${(army.stamina ?? 100) - 20}）</b></div>
          <div class="kv"><span>连地</span><b>${p.adjacent === false ? '未相连，需先铺路' : '已相连'}</b></div>
        </div>
        <div class="panel"><h3>部队 · 第 ${armyIdx + 1} 队</h3>
          ${['大营', '中军', '前锋'].map((pn, k) => {
            const h = heroById(army.slots[k]);
            return `<div class="kv"><span>${pn}</span><b>${h ? `${esc(h.name)} · ${fmt(h.troops)}` : '未配置'}</b></div>`;
          }).join('')}
          <div class="kv"><span>总兵力</span><b>${fmt(troops)}</b></div>
          <div class="kv"><span>兵种</span><b>${army.slots.map((id) => heroById(id)?.type).filter(Boolean).join(' / ') || '—'}</b></div>
          <div class="kv"><span>现有资源</span><b>${Object.entries(s.resources[pf()] ?? {}).filter(([k]) => label[k]).map(([k, v]) => `${label[k]} ${fmt(v)}`).join(' · ')}</b></div>
          <div class="verdict">${verdict[0]}<small>${verdict[1]} · 兵力对比 ${ratio.toFixed(2)} : 1</small></div>
        </div>
      </div>
      <p class="hintLine" style="margin-top:12px">行军前三分钟内可撤兵并返还 10 点体力；三分钟后须经历战斗方可返回。抵达敌方城池后部队在城外扎营，进入城池布阵界面方可派人进城。</p>
      <button class="bigBtn" data-act="confirmMarch" data-army="${armyIdx}" data-city="${esc(p.cityId ?? '')}" data-c="${tile?.c ?? ''}" data-r="${tile?.r ?? ''}">确 认 出 征</button>
      <button class="bigBtn ghost" data-act="back">再想想</button>`;
  }

  function pageReports() {
    const list = getReports();
    return `${sec('战报', `${list.length} 条 · 最近在上`)}
      ${list.length ? list.map((r, i) => `<div class="listRow" data-act="report" data-id="${i}">
        <span class="tag ${r.red ? 'red' : ''}">${esc(r.tag)}</span>
        <div><div class="t">${esc(r.title)}</div><div class="s">${esc(formatCalendar(r.turn, state().cfg.calendar, 'short'))} · ${esc(r.sub)}</div></div>
        <span class="arrow">›</span></div>`).join('')
        : emptyScroll('尚 无 战 报', '出征、占领、侦察与屯田之后，这里会逐条记下。')}`;
  }
  function pageReport(p) {
    const r = getReports()[Number(p.id)];
    if (!r) return '<p class="hintLine">战报不存在。</p>';
    return `${sec(r.title, `${formatCalendar(r.turn, state().cfg.calendar, 'short')} · ${r.tag}`)}
      <p class="readBody">${esc(r.body)}</p>
      <button class="bigBtn ghost" data-act="back">返回战报列表</button>`;
  }
  function pageMail() {
    const mailList = allMails(uiData, state());
    return `${sec('邮件', `${mailList.length} 封`)}
      ${mailList.length ? mailList.map((m) => `<div class="listRow" data-act="mailRead" data-id="${m.id}">
        <span class="tag">${esc(m.tag)}</span>
        <div><div class="t">${esc(m.title)}</div><div class="s">${esc(m.from)}</div></div>
        <span class="arrow">›</span></div>`).join('')
        : emptyScroll('尚 无 书 信', '章回推进时，行台会收到私信与军情露布。')}`;
  }
  function pageMailRead(p) {
    const m = allMails(uiData, state()).find((x) => x.id === p.id);
    if (!m) return '<p class="hintLine">邮件不存在。</p>';
    return `${sec(m.title, m.from)}
      <p class="readBody">${esc(m.body)}</p>
      <button class="bigBtn ghost" data-act="back">返回收件箱</button>`;
  }

  function pageStory() {
    const s = state();
    const cur = currentChapter(story, s);
    const idx = chapterIndex(story, cur.id);
    const next = story.chapters[idx + 1];
    const gp = goalProgress(s, cur);
    const gate = canAdvance(story, s);
    const chosenId = (s.storyChoices ?? {})[cur.choice?.id];
    const claimed = (s.claimedTasks ?? []).includes(cur.id);
    const pct = Math.min(100, gp.cur / Math.max(1, gp.n) * 100);

    const choiceHtml = cur.choice ? `
      ${sec('行台议决', cur.choice.prompt)}
      <div class="cardList">${cur.choice.options.map((o) => `
        <div class="card choiceCard${chosenId === o.id ? ' chosen' : ''}" data-act="choose" data-id="${o.id}">
          ${o.historical ? '<div class="stamp">史</div>' : ''}
          <h3>${esc(o.text)}</h3>
          <div class="meta">${esc(o.desc)}</div>
          <div class="desc">${esc(o.note ?? '')}</div>
          ${chosenId === o.id ? '<div class="chosenTag">已定</div>' : ''}
        </div>`).join('')}</div>` : '';

    const past = story.chapters.slice(0, idx).reverse().map((c) => `
      <div class="listRow" data-act="chapterRead" data-id="${c.id}">
        <span class="tag">${esc(c.no)}</span>
        <div><div class="t">${esc(c.title)}</div><div class="s">${esc(c.era)} · ${esc(c.historical.slice(0, 26))}…</div></div>
        <span class="arrow">›</span></div>`).join('');

    return `<div class="arcEntry"><button class="bigBtn ghost" type="button" data-act="archive">典 籍 总 揽 · 六门 →</button></div>

      ${sec('官渡章回', `${dateLabel(s, 'full')} · ${story.meta.role}`)}
      <div class="chapterHero">
        <div class="chNo">${esc(cur.no)}</div>
        <h3>${esc(cur.title)}</h3>
        <div class="chEra">${esc(cur.era)} · 第 ${idx + 1} / ${story.chapters.length} 回</div>
        <p class="readBody">${esc(cur.beat)}</p>
        <div class="chSource">${esc(cur.historical)}<small>— ${esc(cur.source)}</small></div>
      </div>

      ${sec('本回军务', gp.label)}
      <div class="goalCard">
        <div class="kv"><span>军务进度</span><b>${gp.cur} / ${gp.n}</b></div>
        <div class="progress"><i class="barFill" style="width:${pct}%"></i></div>
        <div class="goalNote ${gate.ok ? 'ready' : ''}">${gate.ok
          ? `军务已竟，时至 ${esc(next.era)}：可入「${esc(next.no)} · ${esc(next.title)}」`
          : esc(gate.reason)}</div>
        <div class="kv"><span>本回犒赏</span><b>${esc(cur.reward.text)}</b></div>
        <div class="kv"><span>领取状态</span><b>${claimed ? '已随推进发讫' : '推进时一次发清'}</b></div>
      </div>
      ${choiceHtml}
      <button class="bigBtn" data-act="advance">${gate.ok ? `入 ${esc(next.no)} · ${esc(next.title)}` : '推进章回'}</button>
      <p class="hintLine" style="margin-top:8px">章回与军历月份绑定：不到史实月份（如二月颜良围白马、十月许攸夜奔）不能跳回。军务目标与大地图指令共用同一套 state 派生。</p>

      ${past ? `${sec('已过章回', `${idx} 回`)}${past}` : ''}
      ${dailyTasks()}
    `;
  }

  function pageChapterRead(p) {
    const c = chapterById(story, p.id);
    if (!c) return '<p class="hintLine">无此章回。</p>';
    return `${sec(c.title, `${c.no} · ${c.era}`)}
      <p class="readBody">${esc(c.beat)}\n\n${esc(c.historical)}\n— ${esc(c.source)}</p>
      <button class="bigBtn ghost" data-act="back">返回纪事</button>`;
  }

  function dailyTasks() {
    const s = state();
    const vals = [landCount(), s.stats.develops, facLv('chengzhufu'),
      s.stats.scouts, s.stats.recruits, s.stats.ordersIssued];
    const goals = [3, 1, 6, 1, 1, 1];
    return `${sec('日常陈情', dateLabel(s, 'full'))}
      ${uiData.tasks.map((t, i) => {
        const done = vals[i] >= goals[i];
        const claimed = (s.claimedTasks ?? []).includes(t.id);
        return `<div class="listRow" style="cursor:default">
          <span class="tag">${esc(t.kind)}</span>
          <div style="flex:1">
            <div class="t">${esc(t.name)}</div><div class="s">${esc(t.desc)} · 奖励 ${esc(t.reward)}</div>
            <div class="progress"><i class="barFill" style="width:${Math.min(100, vals[i] / goals[i] * 100)}%"></i></div>
            <div class="s" style="margin-top:4px">${esc(t.progress)} ${vals[i]} / ${goals[i]}</div>
          </div>
          ${claimed ? '<span class="tag" style="border-color:var(--line);color:var(--dim)">已领取</span>'
            : done ? `<button class="bigBtn ghost" style="width:auto;min-height:34px;margin:0;padding:5px 12px" data-act="claim" data-id="${t.id}">领取</button>`
              : '<span class="tag" style="border-color:var(--line);color:var(--dim)">进行中</span>'}
        </div>`;
      }).join('')}`;
  }

  function pageAlliance() {
    const s = state();
    const f = s.cfg.factions.find((x) => x.id === pf());
    const members = CITIES.filter((c) => s.cities[c.id]?.owner === pf());
    return `${sec('同盟', `${f?.name ?? ''} · 所据州郡`)}
      ${statGrid([
        ['盟主', f?.name ?? '—', ''], ['同盟等级', String(Math.min(10, 1 + Math.floor(s.turn / 4))), ''],
        ['成员（城池）', String(members.length), '座'], ['同盟加成', `+${Math.min(20, 2 + Math.floor(s.turn / 3))}%`, '资源'],
      ])}
      ${sec('同盟公告')}
      <p class="readBody">建安五年二月，各城按领地多寡分摊粮草。黄河诸津渡不得擅离，白马、延津有警，先报许都。\n\n攻城所获城池按战功归属，俘虏主帅者记首功。</p>
      ${sec('治所 · 成员')}
      ${members.map((c) => `<div class="listRow" data-act="focusCity" data-id="${c.id}">
        <span class="tag">${c.rank === 1 ? '都' : c.rank === 2 ? '郡' : '县'}</span>
        <div><div class="t">${esc(c.name)}</div><div class="s">守军 ${fmt(s.cities[c.id].garrison)} · 城防 ${Math.round(s.cities[c.id].wall)}</div></div>
        <span class="arrow">›</span></div>`).join('')}
      ${sec('捐献')}
      <p class="hintLine">捐献资源提升同盟等级，等级越高全体成员资源产出加成越高。</p>
      <div class="cmdGroup" style="max-width:340px">
        <button data-act="donate" data-id="wood">捐木材 500</button>
        <button data-act="donate" data-id="stone">捐石料 500</button>
        <button data-act="donate" data-id="iron">捐铁矿 500</button>
        <button data-act="donate" data-id="grain">捐粮草 500</button>
      </div>
      ${sec('同盟日志')}
      <p class="readBody">${dateLabel(s, 'short')} · ${f?.name ?? ''}据${members.map((c) => c.name).slice(0, 4).join('、')}等城。\n建安五年 正月初一 · 同盟初创，盟主 ${f?.name ?? ''}。</p>`;
  }

  function pageWorld() {
    const s = state();
    const byOwner = {};
    for (const c of CITIES) {
      const o = s.cities[c.id]?.owner ?? '—';
      (byOwner[o] ??= []).push(c);
    }
    const landByOwner = {};
    for (const t of s.terrain.tiles) if (t.owner) landByOwner[t.owner] = (landByOwner[t.owner] ?? 0) + 1;
    return `<div class="arcEntry"><button class="bigBtn ghost" type="button" data-act="archive">典 籍 总 揽 · 六门 →</button></div>
${sec('天下大势', dateLabel(s, 'full'))}
      <p class="hintLine">赛季目标：据官渡、断乌巢、擒河北主帅。城池归属与领地格数随每旬实时变化。</p>
      ${statGrid([
        ['全图格数', fmt(s.terrain.cols * s.terrain.rows), '格'],
        ['己方领地', fmt(landByOwner[pf()] ?? 0), '格'],
        ['城池总数', String(CITIES.length), '座'],
        ['在途命令', String(s.orders.length), '道'],
      ])}
      ${sec('各势力形势')}
      ${s.cfg.factions.map((f) => {
        const cities = byOwner[f.id] ?? [];
        return `<div class="troopCard">
          <div class="th"><b style="color:${f.color}">${esc(f.name)}</b>
            <span style="font-size:11px;color:var(--dim)">都城 ${esc(f.capital)} · 城池 ${cities.length} 座 · 领地 ${fmt(landByOwner[f.id] ?? 0)} 格</span>
            <span class="spacer"></span><span style="font-size:11px;color:var(--gold)">势力值 ${fmt((landByOwner[f.id] ?? 0) * 12 + cities.length * 300)}</span></div>
          <div class="progress"><i class="barFill" style="width:${Math.min(100, cities.length / CITIES.length * 100 + 8)}%"></i></div>
          <p class="hintLine" style="margin:8px 0 0">${cities.map((c) => c.name).join(' · ') || '暂无城池'}</p>
        </div>`;
      }).join('')}
      ${sec('州郡城池', '点一座跳转大地图')}
      <div class="cardList">${CITIES.map((c) => `<div class="card" data-act="focusCity" data-id="${c.id}">
        <div class="stamp">${esc((s.cfg.factions.find((f) => f.id === s.cities[c.id]?.owner) ?? {}).name?.[0] ?? '—')}</div>
        <h3>${esc(c.name)}</h3><div class="meta">经度 ${c.lon} · 纬度 ${c.lat}<br>守军 ${fmt(s.cities[c.id].garrison)}</div>
        <div class="desc">${esc(c.note ?? '')}</div></div>`).join('')}</div>`;
  }

  function pageSystem() {
    const s = state();
    return `<div class="arcEntry"><button class="bigBtn ghost" type="button" data-act="archive">典 籍 总 揽 · 六门 →</button></div>
${sec('系统设置', `v${cfg.meta.version} · 存档版本 1`)}
      <div class="listRow" style="cursor:default"><span class="tag">节奏</span>
        <div style="flex:1"><div class="t">自动推进回合</div><div class="s">每 ${cfg.calendar.secPerTurn} 秒走 1 旬</div></div>
        <button class="bigBtn ghost" style="width:auto;min-height:36px;margin:0;padding:5px 14px" data-act="toggleAuto">${actions.getAuto() ? '关闭' : '开启'}</button></div>
      <div class="listRow" style="cursor:default"><span class="tag">画面</span>
        <div style="flex:1"><div class="t">静止时停绘</div><div class="s">大地图无变化不重绘，省电；城池布阵界面仍保持动画</div></div>
        <button class="bigBtn ghost" style="width:auto;min-height:36px;margin:0;padding:5px 14px" data-act="toggleIdle">${actions.getSetting('idleStop') ? '关闭' : '开启'}</button></div>
      <div class="listRow" style="cursor:default"><span class="tag">辅助</span>
        <div style="flex:1"><div class="t">地块吸附</div><div class="s">窄屏点选自动吸附到最近可通行格</div></div>
        <button class="bigBtn ghost" style="width:auto;min-height:36px;margin:0;padding:5px 14px" data-act="toggleSnap">${actions.getSetting('snap') ? '关闭' : '开启'}</button></div>
      ${sec('行台授简', '初入官渡十二简 · 可随时重看')}
      <p class="hintLine">授简是本机界面状态，不进局面、不进命令日志、不进军令帖；遮罩不挡指针，每一简都可手动跳过。当前：${esc(actions.getTutorialLabel?.() ?? '未读')}。</p>
      <button class="tutReplay" type="button" data-act="tutorialReplay">重 看 行 台 授 简</button>

      ${sec('存档', '手机切走 / 锁屏 / 刷新后仍是这一局')}
      <p class="hintLine">按「保存」写入本机；下次打开主菜单会出现「继续上一局」。</p>
      <div class="cmdGroup" style="max-width:420px">
        <button data-act="save">保存进度</button>
        <button data-act="load">读取进度</button>
        <button data-act="newgame">新开一局</button>
        <button data-act="delsave">删除存档</button>
      </div>
      <p class="readBody" style="margin-top:12px">当前局面：${dateLabel(s, 'full')}\n己方 ${esc((s.cfg.factions.find((f) => f.id === pf()) ?? {}).name ?? '')} · 领地 ${fmt(landCount())} 格 · 在途命令 ${s.orders.length} 道\n城池 ${ownCities().length} 座 · 事件记录 ${getReports().length} 条</p>

      ${sec('军令帖 · 无服务器异步对演', '零预算可做')}
      <p class="hintLine">不设服务器也能两人对演：导出本局口令（存档 + 带序号的命令日志）交给对方，对方导入后接着下命令，再把口令传回。逻辑时间只有年号月日对应的 turn，没有墙钟；RNG 状态随命令入日志，两端序列不分叉。</p>
      <textarea class="ticketBox" id="ticketBox" readonly placeholder="点「导出」生成本局口令">${esc(s.exportedTicket ?? '')}</textarea>
      <div class="cmdGroup">
        <button type="button" data-act="exportTicket">导出本局口令</button>
        <button type="button" data-act="importTicket">导入对方口令</button>
        <button type="button" data-act="verifyReplay">校验确定性重放</button>
        <button type="button" data-act="syncInfo">联机边界说明</button>
      </div>
      <div class="syncNote">${esc(s.syncReport ?? `命令日志 ${s.commandLog?.entries?.length ?? 0} 条 · actor 三态 human / ai / remote · 状态指纹可直接比对`)}</div>
      <button class="bigBtn ghost" data-act="help">查看玩法说明</button>`;
  }

  /** 典籍总揽：文言总纲 + 六门全文，一页可总览，不藏细目考据。 */
  function pageArchive() {
    const H = historica ?? { meta: {}, cats: [] };
    const nav = H.cats.map((c) =>
      `<button class="bigBtn ghost" type="button" data-act="arcCat" data-id="${esc(c.id)}">${esc(c.glyph)} · ${esc(c.name)}</button>`).join('');
    const cats = H.cats.map((c) => `
      <div class="secTitle" id="arc-${esc(c.id)}">${esc(c.name)}<small>${esc(c.intro)}</small></div>
      <div class="cardList arcList">${c.items.map((it) => `
        <div class="card arcItem"><span class="arcLv">${esc(it.lv)}</span>
          <h3>${esc(it.t)}</h3>
          <div class="desc">${esc(it.s)}</div>
          <div class="meta">${esc(it.n)}</div>
        </div>`).join('')}</div>`).join('');
    return `<p class="readBody arcPre">${esc(H.meta.preface ?? '')}</p>
      <div class="arcNav">${nav}
        <button class="bigBtn" type="button" data-act="atlasView">十三州全境舆图 →</button>
      </div>
      ${cats}
      <p class="readBody arcCol">${esc(H.meta.colophon ?? '')}</p>
      <button class="bigBtn ghost" type="button" data-act="back">返回</button>`;
  }

  /** 全境舆图：对面 demos 的 bg + fg 原样贴入，可拖可缩，只读浏览。 */
  function pageAtlasView() {
    return `<div class="arcNav">
        <button class="bigBtn ghost" type="button" data-act="atlasZoom" data-d="in">放 大</button>
        <button class="bigBtn ghost" type="button" data-act="atlasZoom" data-d="out">缩 小</button>
        <button class="bigBtn ghost" type="button" data-act="atlasZoom" data-d="reset">复 位</button>
        <button class="bigBtn ghost" type="button" data-act="atlasDetail" aria-pressed="false">中原详图</button>
      </div>
      <canvas id="atlasCanvas" aria-label="建安五年十三州全境舆图"></canvas>
      <p class="readBody">此图全幅十三州，与行台沙盘之豫兖战区非同一图幅。背景层为地表成因，
        地物层为州郡、关津、烽燧、长城与主景题识；势力归属不预绘，由局内动态给出。
        笔法、连续场、色板与史料锚点悉仍其旧，见 docs/十三州全境取数表.md。</p>
      <button class="bigBtn ghost" type="button" data-act="back">返回典籍总揽</button>`;
  }

  function pageHelp() {
    return `<p class="readBody">一、大地图可拖动、双指捏合缩放、滚轮缩放，右下「全图」看整幅，缩略图定位。\n\n二、1 回合 = 1 旬。点「结束下一旬」或开「自动推进」；日历不因进入城池而冻结，两端并行。\n\n三、底部主菜单：内政（设施升级）、武将、战法、部队（大营/中军/前锋编成）、战报、邮件、纪事（八回章回与日常陈情）、同盟、天下、系统。每一层都能用 × 或 Esc 逐级退出。\n\n四、点地块弹出信息卷轴：占领需连地，另有屯田、筑垒、侦察、调动、驻守、撤兵。点城池可进「城池布阵」；出征前有胜负预判与行军时间。\n\n五、城池布阵是固定视口的小地图，不拖动，只调兵：己方城部队在城内，敌方城部队在城外扎营；把大营的兵拖进城里＝派人进去打。圆框选后二次拖拽定方向，所有远程单位齐射。\n\n六、退出城池拍快照，隔几旬再进入用同一固定步长空跑补齐，不另写结算公式。切到后台会自动存档。</p>
    <button class="bigBtn ghost" data-act="back">返回</button>`;
  }

  const PAGES = {
    interior: pageInterior, facility: pageFacility, heroes: pageHeroes, hero: pageHero,
    tactics: pageTactics, tactic: pageTactic, army: pageArmy, heroPick: pageHeroPick,
    march: pageMarch, reports: pageReports, report: pageReport,
    mail: pageMail, mailRead: pageMailRead, story: pageStory,
    chapterRead: pageChapterRead, tasks: dailyTasks,
    alliance: pageAlliance, world: pageWorld, system: pageSystem, help: pageHelp,
    archive: pageArchive, atlasView: pageAtlasView,
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────
  function renderTabs() {
    tabsEl.innerHTML = TABS.map((t) => {
      const active = t.id !== 'map' && current().route === t.id;
      const badge = t.id === 'reports' ? `<span class="badge" id="tabReportCount">${getReports().length}</span>`
        : t.id === 'tasks' ? '' : '';
      return `<button type="button" data-tab="${t.id}" aria-pressed="${active}" title="${esc(t.name)}">
        <span class="ti">${t.glyph}</span>${esc(t.name)}${badge}</button>`;
    }).join('') + `<button type="button" data-tab="map" aria-pressed="${current().route === 'map'}" style="display:none" id="tabMapGhost">地图</button>`;
  }

  function render() {
    const cur = current();
    const prevScroll = screen.querySelector('.scrBody')?.scrollTop ?? 0;
    renderTabs();
    if (!stack.length) { screen.hidden = true; screen.innerHTML = ''; onChange(); return; }
    const [title, sub] = TITLE[cur.route] ?? [cur.route, ''];
    let body = (PAGES[cur.route] ?? (() => '<p class="hintLine">页面建设中。</p>'))(cur.params ?? {});
    const tone = PAPER_ROUTES.has(cur.route) ? 'paper' : 'ink';
    screen.dataset.tone = tone;
    screen.dataset.route = cur.route;
    // 墨底页末尾补一卷末题记：留白有人撑着，不靠加纹样。
    if (tone === 'ink' && !body.includes('class="scrollEnd"')) {
      body += scrollEnd(cur.route === 'reports' ? '官渡战报 · 逐条而书' : undefined);
    }
    screen.hidden = false;
    screen.innerHTML = `
      <div class="scrHead">
        <button class="back" type="button" data-act="back">‹ 返回</button>
        <h2>${esc(title)}</h2><span class="sub">${esc(sub)}</span>
        <span class="spacer"></span>
        <button class="x" type="button" data-act="close" aria-label="关闭页面">×</button>
      </div>
      <div class="scrBody">${body}</div>`;
    // 用 div 承载的卡片要能被 Tab 到、能被 Enter/Space 激活，否则键盘用户看不到落点。
    const nb = screen.querySelector('.scrBody');
    if (nb) nb.scrollTop = prevScroll;
    for (const el of screen.querySelectorAll('[data-act]')) {
      if (el.tagName === 'BUTTON' || el.tagName === 'SELECT') continue;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', (el.querySelector('h3,.t,.fn')?.textContent ?? el.textContent ?? '').trim().slice(0, 24) || '操作');
    }
    onRoute?.(cur.route);
    if (cur.route === 'atlasView') mountAtlas();
    onChange();
  }

  // ── 十三州全境舆图：demos 的 bg+fg 原样贴入，只加拖/缩，不重画笔法 ────
  let atlasInst = null;
  function mountAtlas() {
    const c = screen.querySelector('#atlasCanvas');
    if (!c) return;
    const a = createAtlas({});                 // 全境默认图幅 93–126E / 15–43N
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    const ctx = c.getContext('2d');
    const base = Math.min(cw / a.W, ch / a.H);
    let zoom = 1, px = 0, py = 0, detail = false;
    function paint() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0e1310'; ctx.fillRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(cw / 2 + px, ch / 2 + py);
      ctx.scale(zoom * base, zoom * base);
      ctx.translate(-a.W / 2, -a.H / 2);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(a.bg, 0, 0);
      if (a.fg) ctx.drawImage(a.fg, 0, 0);
      ctx.restore();
      // 对面最新一版把注记从离屏层拿出来：按比例尺三级显字、屏幕固定字号。
      // 在 1400×1100 坐标系下调用，再整体映射到实际画布，缩放时字不糊。
      ctx.save();
      ctx.translate(cw / 2 - a.W / 2 * base, ch / 2 - a.H / 2 * base);
      ctx.scale(base, base);
      a.drawLabels(ctx, { zoom, panX: px / base, panY: py / base, detail });
      ctx.restore();
    }
    let dragging = false, lx = 0, ly = 0;
    c.addEventListener('pointerdown', (e) => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      px += e.clientX - lx; py += e.clientY - ly;
      lx = e.clientX; ly = e.clientY; paint();
    });
    c.addEventListener('pointerup', () => { dragging = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n = Math.max(0.5, Math.min(6, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const r = c.getBoundingClientRect(), cx = e.clientX - r.left - cw / 2, cy = e.clientY - r.top - ch / 2;
      px = cx - (cx - px) * (n / zoom); py = cy - (cy - py) * (n / zoom);
      zoom = n; paint();
    }, { passive: false });
    paint();
    atlasInst = {
      zoom(what) {
        if (what === 'reset') { zoom = 1; px = 0; py = 0; }
        else zoom = Math.max(0.5, Math.min(6, zoom * (what === 'in' ? 1.28 : 1 / 1.28)));
        paint();
      },
      toggleDetail(btn) {
        detail = !detail;
        btn?.setAttribute('aria-pressed', String(detail));
        if (btn) btn.textContent = detail ? '返回全境' : '中原详图';
        if (detail) zoom = Math.max(zoom, 1.3);
        paint();
      },
    };
  }

  // ── 事件委托：所有按钮一处处理 ────────────────────────────────────────
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const id = b.dataset.tab;
    if (id === 'map') closeAll(); else navigate(id);
  });
  screen.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest?.('[data-act][role="button"]');
    if (!el) return;
    e.preventDefault();
    el.click();
  });
  screen.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'back': back(); break;
      case 'close': closeAll(); break;
      case 'fac': navigate('facility', { id }); break;
      case 'upg': actions.upgradeFacility(id); render(); break;
      case 'hero': navigate('hero', { id }); break;
      case 'tactic': navigate('tactic', { id }); break;
      case 'slot': navigate('heroPick', { army: el.dataset.army, slot: el.dataset.slot }); break;
      case 'assign':
        actions.assignHero(Number(el.dataset.army), Number(el.dataset.slot), id);
        back(); break;
      case 'march': navigate('march', { army: el.dataset.army, ...(current().params ?? {}) }); break;
      case 'confirmMarch': {
        const r = actions.issueMarch({
          army: Number(el.dataset.army),
          cityId: el.dataset.city || null,
          tile: el.dataset.c !== '' ? { c: Number(el.dataset.c), r: Number(el.dataset.r) } : null,
        });
        if (r?.ok !== false) back();
        break;
      }
      case 'report': navigate('report', { id }); break;
      case 'mailRead': navigate('mailRead', { id }); break;
      case 'claim': actions.claimTask(id); render(); break;
      case 'advance': {
        const r = actions.advanceChapter();
        if (r?.ok) render();
        break;
      }
      case 'choose': actions.chooseOption(id); render(); break;
      case 'chapterRead': navigate('chapterRead', { id }); break;
      case 'donate': actions.donate(id, 500); render(); break;
      case 'focusCity': actions.focusCity(id); closeAll(); break;
      case 'quick': actions.quick(id); render(); break;
      case 'toggleAuto': actions.setAuto(!actions.getAuto()); render(); break;
      case 'toggleIdle': actions.setSetting('idleStop', !actions.getSetting('idleStop')); render(); break;
      case 'toggleSnap': actions.setSetting('snap', !actions.getSetting('snap')); render(); break;
      case 'save': actions.saveGame(); break;
      case 'load': actions.loadGame(); break;
      case 'newgame': actions.newGame(); break;
      case 'delsave': actions.deleteSave(); break;
      case 'tutorialReplay': actions.replayTutorial(); break;
      case 'exportTicket': actions.exportTicket(); render(); break;
      case 'importTicket': actions.importTicket(screen.querySelector('#ticketBox')?.value ?? ''); render(); break;
      case 'verifyReplay': actions.verifyReplay(); render(); break;
      case 'syncInfo': actions.syncInfo(); render(); break;
      case 'help': actions.openHelp(); break;
      case 'archive': navigate('archive'); break;
      case 'arcCat': {
        const key = String(id ?? '').replace(/[^a-z0-9_-]/gi, '');
        const el2 = key ? screen.querySelector(`#arc-${key}`) : null;
        if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'atlasView': navigate('atlasView'); break;
      case 'atlasZoom': atlasInst?.zoom(el.dataset.d); break;
      case 'atlasDetail': atlasInst?.toggleDetail(el); break;
      default: break;
    }
  });

  // 初始就把主菜单 Tab 渲染出来：装配层创建外壳时还没发生任何导航。
  renderTabs();

  return {
    navigate, back, closeAll, render, current,
    get depth() { return stack.length; },
    set onChange(fn) { onChange = fn; },
    get routes() { return stack.map((x) => x.route); },
  };
}
