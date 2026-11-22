// 汉末军历：显示层用「年号 + 月 + 日」，不再出现「第几旬」。
// 内部 turn 仍是 1 旬（10 日）的离散步，逻辑层 / A* / 双时钟一行不改；
// 只是把旬映射成「初一 / 十一 / 廿一」，3 旬进一月，12 月进一年。
// 建安元年 = 196，故年号数 = 公元年 - 195。建安五年 = 200 = 庚辰。
const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DAYS = ['初一', '十一', '廿一'];   // 上旬 / 中旬 / 下旬
const SEASONS = ['孟春', '仲春', '季春', '孟夏', '仲夏', '季夏',
  '孟秋', '仲秋', '季秋', '孟冬', '仲冬', '季冬'];
const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

export function cnYear(n) {
  if (n <= 0) return String(n);
  if (n < 10) return CN[n];
  if (n === 10) return '十';
  if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '');
  const t = Math.floor(n / 10), o = n % 10;
  return CN[t] + '十' + (o ? CN[o] : '');
}

export function calendarParts(turn, cal) {
  const per = cal.xunPerMonth ?? 3;
  const x = (cal.startXun ?? 1) - 1 + Math.max(0, Math.floor(turn));
  const monthOffset = Math.floor(x / per);
  const xun = ((x % per) + per) % per;
  const m0 = (cal.startMonth ?? 1) - 1 + monthOffset;
  const year = (cal.startYear ?? 200) + Math.floor(m0 / 12);
  const monthIdx = ((m0 % 12) + 12) % 12;
  const eraNo = year - 195;
  const gz = (year - 4) % 60;
  return {
    year, eraNo, era: `建安${cnYear(eraNo)}年`,
    ganzhi: GAN[gz % 10] + ZHI[gz % 12],
    month: MONTHS[monthIdx], monthIdx: monthIdx + 1,
    day: DAYS[Math.min(xun, DAYS.length - 1)], xun,
    season: SEASONS[monthIdx],
    turn,
  };
}

/** style: short「建安五年 二月初一」/ full「建安五年 庚辰 · 二月 · 初一」/ date「二月初一」 */
export function formatCalendar(turn, cal, style = 'short') {
  const p = calendarParts(turn, cal);
  if (style === 'date') return p.month + p.day;
  if (style === 'full') return `${p.era} ${p.ganzhi} · ${p.month} · ${p.day}`;
  if (style === 'season') return `${p.era} · ${p.season} · ${p.month}${p.day}`;
  return `${p.era} ${p.month}${p.day}`;
}

/** 兼容入口：状态里带 cfg，直接取 turn。 */
export function calendarLabel(state, style = 'short') {
  return formatCalendar(state.turn ?? 0, state.cfg?.calendar ?? {}, style);
}

/** 行军 / 战报里的「第 N 旬抵达」→「四月十一 抵达」 */
export function arrivalLabel(turn, cal) {
  return formatCalendar(turn, cal, 'date');
}
