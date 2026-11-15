import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calendarParts, formatCalendar, calendarLabel, arrivalLabel, cnYear } from '../src/calendar.js';

const cfg = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url), 'utf8'));
const cal = cfg.calendar;

test('开局是建安五年（庚辰）正月初一，不再出现「第几旬」', () => {
  const p = calendarParts(0, cal);
  assert.equal(p.era, '建安五年');
  assert.equal(p.ganzhi, '庚辰');
  assert.equal(p.month, '正月');
  assert.equal(p.day, '初一');
  assert.equal(p.season, '孟春');
  assert.equal(formatCalendar(0, cal), '建安五年 正月初一');
  assert.ok(!formatCalendar(0, cal).includes('旬'));
  assert.equal(formatCalendar(0, cal, 'full'), '建安五年 庚辰 · 正月 · 初一');
});

test('3 旬进一月，初一 / 十一 / 廿一，跨年换年号', () => {
  assert.equal(formatCalendar(1, cal), '建安五年 正月十一');
  assert.equal(formatCalendar(2, cal), '建安五年 正月廿一');
  assert.equal(formatCalendar(3, cal), '建安五年 二月初一');
  assert.equal(formatCalendar(12, cal), '建安五年 五月初一');
  assert.equal(formatCalendar(36, cal), '建安六年 正月初一');
  assert.equal(formatCalendar(72, cal), '建安七年 正月初一');
  assert.equal(calendarParts(36, cal).ganzhi, '辛巳');
  assert.equal(calendarParts(72, cal).ganzhi, '壬午');
});

test('章回 minTurn 与史实月份一一对齐', () => {
  const story = JSON.parse(readFileSync(new URL('../config/story.json', import.meta.url), 'utf8'));
  const at = (id) => story.chapters.find((c) => c.id === id).minTurn;
  assert.equal(formatCalendar(at('ch1'), cal), '建安五年 正月初一'); // 董承谋泄 / 檄至许都
  assert.equal(formatCalendar(at('ch2'), cal), '建安五年 二月初一'); // 颜良围白马
  assert.equal(formatCalendar(at('ch3'), cal), '建安五年 四月初一'); // 公北救延，荀攸分势
  assert.equal(formatCalendar(at('ch5'), cal), '建安五年 八月初一'); // 绍连营稍前，官渡相持
  assert.equal(formatCalendar(at('ch6'), cal), '建安五年 十月初一'); // 许攸来奔
  assert.equal(formatCalendar(at('ch8'), cal), '建安六年 正月初一'); // 河北既定
});

test('汉字年号与到达标签（行军 / 战报里用）', () => {
  assert.equal(cnYear(5), '五');
  assert.equal(cnYear(10), '十');
  assert.equal(cnYear(13), '十三');
  assert.equal(cnYear(20), '二十');
  assert.equal(arrivalLabel(5, cal), '二月廿一');
  assert.equal(calendarLabel({ turn: 9, cfg }, 'season'), '建安五年 · 孟夏 · 四月初一');
});
