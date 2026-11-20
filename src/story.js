// 章回剧情：纯逻辑，不引用 DOM / canvas / localStorage。
// 与任务线共用同一套 state 派生；章节 minTurn 与军历月份对齐，
// 不到史实月份不能跳回（建安五年二月才轮得到颜良围白马）。
import { formatCalendar } from './calendar.js';

export const chapterById = (story, id) => story.chapters.find((c) => c.id === id) ?? null;
export const chapterIndex = (story, id) => story.chapters.findIndex((c) => c.id === id);
export const currentChapter = (story, state) => chapterById(story, state.chapter ?? story.chapters[0].id) ?? story.chapters[0];

export function landCount(state) {
  return state.terrain.tiles.reduce((a, t) => a + (t.owner === state.playerFaction ? 1 : 0), 0);
}
export function cityCount(state) {
  return Object.values(state.cities).filter((c) => c.owner === state.playerFaction).length;
}
const byType = (state, t) => state.stats?.byType?.[t] ?? 0;

/** 目标求值：返回 {cur, n, done, label}。所有数值都从 state 派生，不是写死进度。 */
export function goalProgress(state, chapter) {
  const g = chapter.goal ?? { type: 'land', n: 1, label: '' };
  const map = {
    land: () => landCount(state),
    cities: () => cityCount(state),
    // 净行动口径：开局已有 9 城 468 格，绝对数会白送进度。
    claim: () => state.stats?.tilesClaimed ?? 0,
    citiesGain: () => cityCount(state) - (state.storyBaseline?.cities ?? cityCount(state)),
    scout: () => state.stats?.scouts ?? 0,
    march: () => byType(state, 'march'),
    develop: () => state.stats?.develops ?? 0,
    forts: () => state.forts?.length ?? 0,
    withdrawOrGarrison: () => byType(state, 'withdraw') + byType(state, 'transfer') + byType(state, 'garrison'),
    orders: () => state.stats?.ordersIssued ?? 0,
  };
  const cur = (map[g.type] ?? map.land)();
  return { cur, n: g.n, done: cur >= g.n, label: g.label, type: g.type };
}

export function chapterHeadline(story, state) {
  const c = currentChapter(story, state);
  return `${c.no} · ${c.title}`;
}

export function canAdvance(story, state) {
  const idx = chapterIndex(story, state.chapter ?? story.chapters[0].id);
  const cur = story.chapters[idx] ?? story.chapters[0];
  const next = story.chapters[idx + 1];
  if (!next) return { ok: false, reason: '章回已合卷，此后自由经略', final: true };
  const gp = goalProgress(state, cur);
  if (!gp.done) return { ok: false, reason: `本回目标未竟：${gp.label}（${gp.cur}/${gp.n}）` };
  if (state.turn < next.minTurn) {
    return { ok: false, reason: `待时至 ${formatCalendar(next.minTurn, state.cfg.calendar, 'short')} · ${next.era}` };
  }
  return { ok: true, next, current: cur };
}

/** 应用抉择 / 奖励里的 effect 片段。全部是纯 state 变更，可重放。 */
export function applyEffect(state, effect) {
  if (!effect) return;
  const pool = state.resources[state.playerFaction];
  for (const k of ['wood', 'stone', 'iron', 'grain']) {
    if (Number.isFinite(effect[k])) pool[k] = Math.max(0, Math.round((pool[k] ?? 0) + effect[k]));
  }
  if (Number.isFinite(effect.copper)) state.copper = Math.max(0, (state.copper ?? 0) + effect.copper);
  if (Array.isArray(effect.facility)) {
    const [id, n] = effect.facility;
    state.facilities[id] = (state.facilities[id] ?? 0) + n;
  }
  if (Array.isArray(effect.cityWall)) {
    const [id, n] = effect.cityWall;
    if (state.cities[id]) state.cities[id].wall = Math.max(0, state.cities[id].wall + n);
  }
  if (Array.isArray(effect.morale)) {
    const [id, n] = effect.morale;
    if (state.cities[id]) state.cities[id].morale = Math.max(0, Math.min(100, state.cities[id].morale + n));
  }
  if (Array.isArray(effect.garrison)) {
    const [id, n] = effect.garrison;
    if (state.cities[id]) state.cities[id].garrison = Math.max(0, state.cities[id].garrison + n);
  }
  if (effect.flag) (state.storyFlags ??= {})[effect.flag] = true;
  for (const id of effect.intel ?? []) writeIntel(state, id);
}

function writeIntel(state, cityId) {
  const c = state.cities[cityId];
  if (!c) return;
  state.intel[cityId] = {
    turn: state.turn, garrison: c.garrison, wall: Math.round(c.wall),
    morale: Math.round(c.morale), owner: c.owner, source: '斥候 / 章回',
  };
}

/** 序章抉择：身份由剧情给定（司空府参军事），这里只选开局侧重，不是势力三选一。 */
export function applyOpening(state, story, optionId) {
  const ch = story.chapters[0];
  const opt = ch.choice?.options?.find((o) => o.id === optionId) ?? ch.choice?.options?.[0];
  if (!opt) return null;
  applyEffect(state, opt.effect);
  (state.storyFlags ??= {}).opening = opt.id;
  (state.storyChoices ??= {})[ch.choice.id] = opt.id;
  return opt;
}

/** 开篇章的入场纪事。
 *  advanceChapter 只处理「推进到下一回」，开篇这一回是装配层直接赋 chapters[0].id，
 *  从不经过推进，所以 onEnter 里的 report / mail / flags 一直不会生效（官渡第一回亦然）。
 *  这里只返回数据、不改 state；city / intel 仍归推进时应用，避免改开局城池数值。
 */
export function openingDispatches(story) {
  const ch = story.chapters[0];
  const on = ch?.onEnter ?? {};
  return {
    chapterId: ch?.id ?? null,
    flags: { ...(on.flags ?? {}) },
    report: on.report ? { ...on.report, turn: 0 } : null,
    mail: on.mail ? { ...on.mail, turn: 0, id: `story-${ch.id}` } : null,
  };
}

/** 按旬分批投递的军情露布。
 *  章回入场时只发一封私信 / 一条纪事；其余史事按「入场后第几旬」陆续到，
 *  不再是开局一次性灌完。纯函数，不改 state；跳旬快进时用 >= 一次补齐，
 *  已发的靠 state.dispatchedIds 去重，重放 / 读档都不重复投递。
 *  chapterEnteredTurn 记的是本章实际入场旬（全境两章被装配层重映射过）。
 */
export function dueDispatches(story, state) {
  const cur = currentChapter(story, state);
  const list = cur?.dispatches ?? [];
  if (!list.length) return [];
  const enterTurn = state.chapterEnteredTurn?.[cur.id] ?? 0;
  const done = new Set(state.dispatchedIds ?? []);
  const out = [];
  for (const d of list) {
    if (done.has(d.id)) continue;
    if (state.turn < enterTurn + d.afterTurn) continue;
    out.push({
      id: d.id, chapterId: cur.id, kind: d.kind, turn: state.turn,
      report: d.kind === 'report' ? { ...d.report, turn: state.turn } : null,
      mail: d.kind === 'mail' ? { ...d.mail, turn: state.turn, id: d.id } : null,
    });
  }
  return out;
}

/** 把 dueDispatches 的结果落到 state（纯 state 变更，可重放、可存档）。 */
export function applyDispatches(state, list) {
  const applied = [];
  const done = (state.dispatchedIds ??= []);
  for (const d of list) {
    if (done.includes(d.id)) continue;
    if (d.report) (state.reports ??= []).unshift({ red: false, ...d.report });
    if (d.mail) (state.storyMails ??= []).push(d.mail);
    done.push(d.id);
    applied.push(d.id);
  }
  return applied;
}

/** 推进到下一回：校验 → 领奖 → 应用上一回抉择 → 入场史实事件。 */
export function advanceChapter(state, story, { autoChoose = true } = {}) {
  const gate = canAdvance(story, state);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  // 上一回若有未选抉择，默认取史实路线（第一个），保证重放确定性。
  const cur = gate.current;
  if (cur.choice && !(state.storyChoices ?? {})[cur.choice.id]) {
    if (!autoChoose) return { ok: false, reason: `请先在本回作出抉择：${cur.choice.prompt}` };
    const opt = cur.choice.options[0];
    (state.storyChoices ??= {})[cur.choice.id] = opt.id;
    applyEffect(state, opt.effect);
  }

  // 本回犒赏在推进时一次发清，并标记已领，避免与「领取」按钮双发。
  const pool = state.resources[state.playerFaction];
  for (const k of ['wood', 'stone', 'iron', 'grain']) {
    if (Number.isFinite(cur.reward[k])) pool[k] = Math.round((pool[k] ?? 0) + cur.reward[k]);
  }
  if (Number.isFinite(cur.reward.copper)) state.copper = (state.copper ?? 0) + cur.reward.copper;
  (state.claimedTasks ??= []).push(cur.id);

  const next = gate.next;
  state.chapter = next.id;
  (state.chapterHistory ??= []).push({ id: cur.id, turn: state.turn, completed: true });
  (state.chapterEnteredTurn ??= {})[next.id] = state.turn;
  (state.storyFlags ??= {}).chapterEntered = next.id;

  const on = next.onEnter ?? {};
  for (const [k, v] of Object.entries(on.flags ?? {})) (state.storyFlags ??= {})[k] = v;
  for (const e of on.city ?? []) {
    const c = state.cities[e.id];
    if (!c) continue;
    if (e.owner) c.owner = e.owner;
    if (Number.isFinite(e.garrison)) c.garrison = Math.max(0, c.garrison + e.garrison);
    if (Number.isFinite(e.wall)) c.wall = Math.max(0, c.wall + e.wall);
    if (Number.isFinite(e.morale)) c.morale = Math.max(0, Math.min(100, c.morale + e.morale));
    if (e.besieged !== undefined) c.besieged = e.besieged;
  }
  for (const id of on.intel ?? []) writeIntel(state, id);

  return {
    ok: true, chapter: next, previous: cur,
    report: on.report ? { ...on.report, turn: state.turn } : null,
    mail: on.mail ? { ...on.mail, turn: state.turn, id: `story-${next.id}` } : null,
    rewardText: cur.reward.text,
  };
}

/** 章回抉择（在当前回里手动改选，可重复，最后一次生效前会回滚很麻烦，所以只允许未进入下一回时改）。 */
export function chooseOption(state, story, optionId) {
  const cur = currentChapter(story, state);
  if (!cur.choice) return { ok: false, reason: '本回没有抉择' };
  if ((state.chapterHistory ?? []).some((h) => h.id === cur.id)) {
    // 已入场过，允许改但只记标记，不重复发 effect（避免刷资源）
    (state.storyChoices ??= {})[cur.choice.id] = optionId;
    return { ok: true, changedOnly: true };
  }
  const opt = cur.choice.options.find((o) => o.id === optionId);
  if (!opt) return { ok: false, reason: '无此抉择' };
  applyEffect(state, opt.effect);
  (state.storyChoices ??= {})[cur.choice.id] = optionId;
  return { ok: true, option: opt };
}

export function claimChapterReward(state, story, id) {
  if ((state.claimedTasks ?? []).includes(id)) return { ok: false, reason: '已领取' };
  const ch = chapterById(story, id);
  if (!ch) return { ok: false, reason: '无此章回' };
  const idx = chapterIndex(story, id);
  const curIdx = chapterIndex(story, state.chapter);
  if (idx >= curIdx) return { ok: false, reason: '本回尚未完结' };
  const gp = goalProgress(state, ch);
  if (!gp.done) return { ok: false, reason: '目标未竟' };
  const pool = state.resources[state.playerFaction];
  for (const k of ['wood', 'stone', 'iron', 'grain']) {
    if (Number.isFinite(ch.reward[k])) pool[k] = Math.round((pool[k] ?? 0) + ch.reward[k]);
  }
  if (Number.isFinite(ch.reward.copper)) state.copper = (state.copper ?? 0) + ch.reward.copper;
  (state.claimedTasks ??= []).push(id);
  return { ok: true, text: ch.reward.text };
}

/** 邮件：静态 4 封 + 章回解锁的史实私信。 */
export function allMails(uiData, state) {
  return [...(uiData.mails ?? []), ...(state.storyMails ?? [])];
}
