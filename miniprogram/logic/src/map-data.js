import { QUANJING } from './quanjing-data.js';
// 建安五年（200）官渡战线局部地理锚点。
// 城池、水系、山脊、泽薮、关隘都用史实名 + 近似经纬度；这是「近似投影」而非考古复原，
// 目的是给 144×108 栅格提供真实地理骨架，让地形不是随机噪声拼贴。
// 逻辑层、渲染层、寻路层都只读这一份表。

export let LON_MIN = 112.75, LON_MAX = 116.15;
export let LAT_MIN = 32.65, LAT_MAX = 36.65;

const C = (id, name, lon, lat, owner, pop, wall, rank, note) =>
  ({ id, name, lon, lat, owner, pop, wall, rank, note });

// rank: 1=都城/州治 2=郡治 3=县/渡口重镇 4=营垒
const GUANDU_CITIES = [
  C('xudu',    '许都', 113.85, 34.03, 'cao',  92000, 100, 1, '建安元年迁都，天子所在'),
  C('ye',      '邺',   114.40, 36.30, 'yuan', 88000, 100, 1, '袁绍本据，冀州治'),
  C('runan',   '汝南', 114.36, 33.01, 'liu',  36000,  80, 2, '刘备扰许南'),
  C('chenliu', '陈留', 114.53, 34.66, 'cao',  41000,  88, 2, '兖州粮仓'),
  C('liyang',  '黎阳', 114.55, 35.68, 'yuan', 31000,  92, 2, '袁军河北前营'),
  C('puyang',  '濮阳', 115.03, 35.75, 'cao',  29000,  82, 2, '黄河南岸重镇'),
  C('yangdi',  '阳翟', 113.52, 34.14, 'cao',  27000,  78, 2, '颍川治所'),
  C('qiaoxian','谯县', 115.78, 33.85, 'cao',  33000,  76, 2, '曹氏乡里'),
  C('zhongmu', '中牟', 114.03, 34.72, 'cao',  24000,  74, 3, '许都北门户，圃田泽在侧'),
  C('baima',   '白马', 114.45, 35.55, 'cao',  18000,  84, 3, '建安五年二月，关羽斩颜良处'),
  C('yanjin',  '延津', 114.20, 35.15, 'cao',  15000,  72, 3, '延津渡，文丑殁于此'),
  C('guandu',  '官渡', 114.00, 34.55, 'cao',  12000,  90, 4, '袁曹相持处，鸿沟畔'),
];

// 汉末黄河故道（荥阳北 → 延津 → 白马 → 黎阳 → 东北入冀），近似折线。
// 与今日黄河走向不同，按《水经注》所载东汉河道方向拟合。
const GUANDU_RIVER_HUANGHE = [
  [112.78, 34.98], [113.05, 35.02], [113.35, 35.10], [113.62, 35.16],
  [113.88, 35.12], [114.20, 35.15], [114.42, 35.48], [114.55, 35.68],
  [114.86, 35.74], [115.18, 35.78], [115.48, 36.02], [115.78, 36.25],
  [116.10, 36.48],
];

// 支流：颍水、汝水、鸿沟/汴水、淇水、荡水。线宽比黄河窄。
const GUANDU_RIVERS_MINOR = [
  { name: '颍水', width: 1, pts: [[113.10, 33.20], [113.30, 33.55], [113.48, 33.90], [113.62, 34.12], [113.85, 34.28], [114.10, 34.40]] },
  { name: '汝水', width: 1, pts: [[113.90, 32.70], [114.10, 32.95], [114.36, 33.15], [114.62, 33.40], [114.82, 33.72], [115.05, 33.95]] },
  { name: '鸿沟', width: 1, pts: [[113.55, 34.30], [113.78, 34.42], [114.00, 34.55], [114.22, 34.62], [114.53, 34.66]] },
  { name: '淇水', width: 1, pts: [[114.05, 36.55], [114.25, 36.20], [114.40, 35.90], [114.55, 35.68]] },
  { name: '荡水', width: 1, pts: [[114.15, 36.45], [114.32, 36.32], [114.40, 36.30]] },
];

// 古泽薮：圃田泽（中牟西北）、大野泽（东北隅）、荥泽（荥阳北）。
const GUANDU_LAKES = [
  { name: '圃田泽', lon: 113.90, lat: 34.80, rx: 0.20, ry: 0.10 },
  { name: '荥泽',   lon: 113.30, lat: 35.02, rx: 0.14, ry: 0.08 },
  { name: '大野泽', lon: 115.62, lat: 35.42, rx: 0.30, ry: 0.16 },
];

// 山脊骨架：嵩山—箕山（西）、太行南段（北）、泰山余脉（东北）。
// 每条折线带一个影响宽度（经度/纬度单位），用于抬高高程。
const GUANDU_RIDGES = [
  { name: '嵩山', width: 0.16, height: 0.92, pts: [[112.82, 33.55], [113.02, 33.90], [113.12, 34.28], [113.05, 34.62], [113.22, 34.92]] },
  { name: '箕山', width: 0.12, height: 0.74, pts: [[113.28, 33.35], [113.52, 33.62], [113.66, 33.95], [113.55, 34.20]] },
  { name: '太行', width: 0.20, height: 0.96, pts: [[114.05, 36.62], [114.35, 36.40], [114.62, 36.18], [114.86, 35.95], [115.10, 35.80]] },
  { name: '历山', width: 0.10, height: 0.62, pts: [[115.35, 36.55], [115.60, 36.38], [115.82, 36.20]] },
];

// 关隘 / 渡口 / 津要：单独标在格子上，是山脉与河流的唯一通行点。
// 「辕辕关」已正名为「轘辕关」（嵩山轘辕道十二折）；本层只改字，不动坐标。
// 官渡地望（中牟说 / 原阳说）、酸枣故城、大野泽今地、历山今地诸异说并录不断，
// 逻辑层坐标一律保持原值——这是存档与寻路的边界，不是考据欠账；
// 实验层舆图已按取数表校正/删去，见 docs/东汉郡国今地核查权威口径.md。
const GUANDU_PASSES = [
  { name: '虎牢关', lon: 113.18, lat: 34.82, kind: 'pass', note: '成皋之险，洛阳东门户' },
  { name: '轘辕关', lon: 113.08, lat: 34.42, kind: 'pass', note: '嵩山轘辕道' },
  { name: '延津渡', lon: 114.20, lat: 35.15, kind: 'ford' },
  { name: '白马津', lon: 114.45, lat: 35.55, kind: 'ford' },
  { name: '黎阳津', lon: 114.55, lat: 35.68, kind: 'ford' },
  { name: '濮阳津', lon: 115.03, lat: 35.75, kind: 'ford' },
  { name: '官渡口', lon: 114.00, lat: 34.55, kind: 'ford' },
];

// 汉末主要道路。via 是沿途真实地名/地形拐点，道路会沿这条折线铺格，
// 不是两点直线；遇河自动由 ford 打通，遇山由 pass 打通。
const R = (a, b, kind, name, via = []) => ({ a, b, kind, name, via });
const GUANDU_ROADS = [
  R('xudu', 'chenliu', 'road', '许陈道', [[113.95, 34.20], [114.20, 34.42], [114.45, 34.58]]),
  R('xudu', 'zhongmu', 'road', '许北道', [[113.88, 34.22], [113.95, 34.48]]),
  R('xudu', 'yangdi',  'road', '颍川道', [[113.72, 34.08], [113.60, 34.10]]),
  R('xudu', 'runan',   'road', '许汝道', [[113.95, 33.78], [114.10, 33.48], [114.25, 33.20]]),
  R('xudu', 'qiaoxian','road', '许谯道', [[114.20, 33.90], [114.60, 33.82], [115.10, 33.80], [115.50, 33.84]]),
  R('chenliu', 'zhongmu', 'road', '陈中道', [[114.35, 34.70], [114.18, 34.72]]),
  R('chenliu', 'baima',   'road', '陈白道', [[114.52, 34.90], [114.50, 35.18], [114.47, 35.40]]),
  R('zhongmu', 'guandu',  'road', '中官道', [[113.98, 34.62]]),
  R('guandu',  'yanjin',  'road', '官延道', [[114.06, 34.80], [114.14, 35.00]]),
  R('yanjin',  'baima',   'ford', '延津—白马', [[114.32, 35.35]]),
  R('baima',   'puyang',  'road', '白濮道', [[114.70, 35.66], [114.90, 35.74]]),
  R('baima',   'liyang',  'ford', '白马津'),
  R('puyang',  'liyang',  'road', '河朔道', [[114.82, 35.72]]),
  R('liyang',  'ye',      'road', '黎邺道', [[114.48, 35.92], [114.42, 36.10]]),
  R('qiaoxian','runan',   'road', '谯汝道', [[115.35, 33.50], [114.90, 33.28]]),
  R('yangdi',  'runan',   'road', '颍汝道', [[113.70, 33.70], [114.02, 33.40]]),
];

// ── 图幅切换：同一套玩法，多铺一张图。所有下游模块读的是活绑定 ──────────
const GUANDU = {
  bounds: { LON_MIN: 112.75, LON_MAX: 116.15, LAT_MIN: 32.65, LAT_MAX: 36.65 },
  cities: GUANDU_CITIES, river: GUANDU_RIVER_HUANGHE, riversMinor: GUANDU_RIVERS_MINOR,
  lakes: GUANDU_LAKES, ridges: GUANDU_RIDGES, passes: GUANDU_PASSES, roads: GUANDU_ROADS,
};
export const MAPS = { guandu: GUANDU, quanjing: QUANJING };
export let CITIES = GUANDU_CITIES;
export let RIVER_HUANGHE = GUANDU_RIVER_HUANGHE;
export let RIVERS_MINOR = GUANDU_RIVERS_MINOR;
export let LAKES = GUANDU_LAKES;
export let RIDGES = GUANDU_RIDGES;
export let PASSES = GUANDU_PASSES;
export let ROADS = GUANDU_ROADS;
export let MAP_ID = 'guandu';

/** 换图幅：装配层在建局面之前调用；存档按 mapId 还原到同一张图。 */
export function useMap(id) {
  const m = MAPS[id] ?? GUANDU;
  MAP_ID = MAPS[id] ? id : 'guandu';
  ({ LON_MIN, LON_MAX, LAT_MIN, LAT_MAX } = m.bounds);
  CITIES = m.cities;
  RIVER_HUANGHE = m.river;
  RIVERS_MINOR = m.riversMinor;
  LAKES = m.lakes;
  RIDGES = m.ridges;
  PASSES = m.passes;
  ROADS = m.roads;
  return MAP_ID;
}

/** 经纬度 → 栅格坐标（不取整，供刷线插值用）。 */
export function geoToTile(lon, lat, cols, rows) {
  return {
    c: ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * (cols - 1),
    r: (1 - (lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * (rows - 1),
  };
}

/** 经纬度 → 屏幕/画布坐标（渲染与地图注记共用）。 */
export function project(lon, lat, w, h, pad = 0) {
  return {
    x: pad + ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * (w - pad * 2),
    y: pad + (1 - (lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * (h - pad * 2),
  };
}

/** 两城间公里数（中纬余弦折减），用于展示与粗略计时。 */
export function distKm(a, b) {
  const dx = (a.lon - b.lon) * 111 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const dy = (a.lat - b.lat) * 111;
  return Math.hypot(dx, dy);
}

export const cityById = (id) => CITIES.find((c) => c.id === id) ?? null;

export function neighbors(id) {
  const out = [];
  for (const r of ROADS) {
    if (r.a === id) out.push({ id: r.b, ...r });
    else if (r.b === id) out.push({ id: r.a, ...r });
  }
  return out;
}

/** Dijkstra 备用：只用于无 terrain 时的粗略估算；正式行军走 pathfind.findRoute。 */
export function routeByCities(from, to, kmPerTurn) {
  if (from === to) return { path: [from], km: 0, turns: 0 };
  const dist = new Map([[from, 0]]), prev = new Map(), seen = new Set();
  while (true) {
    let cur = null, best = Infinity;
    for (const [k, v] of dist) if (!seen.has(k) && v < best) { best = v; cur = k; }
    if (cur === null || cur === to) break;
    seen.add(cur);
    for (const e of neighbors(cur)) {
      const a = cityById(cur), b = cityById(e.id);
      const nd = best + distKm(a, b) * (e.kind === 'ford' ? 1.25 : 1);
      if (nd < (dist.get(e.id) ?? Infinity)) { dist.set(e.id, nd); prev.set(e.id, cur); }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  const km = dist.get(to);
  return { path, km, turns: Math.max(1, Math.ceil(km / kmPerTurn)) };
}

export function validateMap() {
  const problems = [];
  const ids = new Set(CITIES.map((c) => c.id));
  if (ids.size !== CITIES.length) problems.push('城池 id 重复');
  for (const r of ROADS) {
    if (!ids.has(r.a) || !ids.has(r.b)) problems.push(`道路端点不存在: ${r.a}-${r.b}`);
    if (r.a === r.b) problems.push(`自环: ${r.a}`);
  }
  for (const c of CITIES) {
    if (!neighbors(c.id).length) problems.push(`${c.name} 是孤岛`);
    if (c.lon < LON_MIN || c.lon > LON_MAX || c.lat < LAT_MIN || c.lat > LAT_MAX) {
      problems.push(`${c.name} 超出图幅`);
    }
  }
  for (const p of PASSES) {
    if (p.lon < LON_MIN || p.lon > LON_MAX || p.lat < LAT_MIN || p.lat > LAT_MAX) {
      problems.push(`${p.name} 超出图幅`);
    }
  }
  const seen = new Set([CITIES[0].id]), q = [CITIES[0].id];
  while (q.length) for (const n of neighbors(q.shift())) {
    if (!seen.has(n.id)) { seen.add(n.id); q.push(n.id); }
  }
  if (seen.size !== CITIES.length) problems.push('道路图不连通');
  return problems;
}
