// 行台授简：纯逻辑状态机，不引用 DOM / localStorage / 墙钟。
//
// 边界：这是「本机界面状态」，不是局面状态。
//   - 不进 campaign state（策略层保持纯逻辑）
//   - 不进 commandLog（不能污染联机重放的指纹）
//   - 不进军令帖（导入对方存档不该继承对方看过几简）
// 存与读由装配层单独用一个 localStorage key 负责；这里只做序列化形状。
export const TUTORIAL_VERSION = 1;

export function createTutorial(def) {
  return {
    v: TUTORIAL_VERSION,
    index: 0,
    done: false,
    skipped: false,
    active: false,
    seen: {},
    completedBy: {},
    _def: def,
  };
}

export const stepCount = (t) => t._def?.steps?.length ?? 0;
export const currentStep = (t) => {
  if (!t || t.done || t.skipped) return null;
  return t._def?.steps?.[Math.min(t.index, stepCount(t) - 1)] ?? null;
};
export const isActive = (t) => !!t && t.active && !t.done && !t.skipped && !!currentStep(t);
export const progress = (t) => {
  const n = stepCount(t);
  return n ? Math.min(100, Math.round(t.index / n * 100)) : 0;
};

/** 推进一简。via: 'manual' | 'event' | 'restart'，记下来供统计与烟测。 */
export function advance(t, via = 'manual', event = null) {
  if (!isActive(t)) return { ok: false, reason: '授简未在进行中' };
  const cur = currentStep(t);
  t.seen[cur.id] = true;
  t.completedBy[cur.id] = event ? `event:${event}` : via;
  t.index += 1;
  if (t.index >= stepCount(t)) {
    t.done = true;
    t.active = false;
    return { ok: true, finished: true, from: cur.id };
  }
  return { ok: true, finished: false, from: cur.id, to: currentStep(t).id };
}

export function prev(t) {
  if (!t || t.index <= 0) return { ok: false, reason: '已是第一简' };
  t.index -= 1;
  t.done = false;
  t.active = true;
  return { ok: true, to: currentStep(t).id };
}

export function skip(t) {
  if (!t) return { ok: false };
  t.skipped = true;
  t.done = true;
  t.active = false;
  return { ok: true };
}

export function restart(t) {
  if (!t) return { ok: false };
  t.index = 0;
  t.done = false;
  t.skipped = false;
  t.active = true;
  t.completedBy = {};
  return { ok: true, to: currentStep(t).id };
}

/** 暂停（Esc / 退出授简）：不标完成，系统页可重看。 */
export function dismiss(t) {
  if (!t) return { ok: false };
  t.active = false;
  return { ok: true };
}

/**
 * 事件驱动：只认「当前这一简」声明的 await，避免乱点把简跳过去。
 * 纯阅读简（await=null）不吃事件，只能手动点下一简。
 */
export function notify(t, event) {
  if (!isActive(t)) return { ok: false, reason: 'inactive' };
  const cur = currentStep(t);
  if (!cur.await || cur.await !== event) return { ok: false, reason: 'not-current-await' };
  return advance(t, 'event', event);
}

/** 把「事件 → 简」反查出来，供自检与烟测确认每个 await 都有接线。 */
export function awaitedEvents(def) {
  return (def?.steps ?? []).map((s) => s.await).filter(Boolean);
}

export function serializeTutorial(t) {
  return {
    v: TUTORIAL_VERSION,
    index: t.index,
    done: t.done,
    skipped: t.skipped,
    seen: t.seen,
    completedBy: t.completedBy,
  };
}

export function restoreTutorial(def, raw) {
  const t = createTutorial(def);
  if (!raw || raw.v !== TUTORIAL_VERSION) return t;
  const n = stepCount(t);
  t.index = Math.max(0, Math.min(n - 1, Number.isInteger(raw.index) ? raw.index : 0));
  t.done = !!raw.done;
  t.skipped = !!raw.skipped;
  t.seen = raw.seen && typeof raw.seen === 'object' ? { ...raw.seen } : {};
  t.completedBy = raw.completedBy && typeof raw.completedBy === 'object' ? { ...raw.completedBy } : {};
  t.active = false;   // 恢复后由装配层决定是否续播
  return t;
}

/** 是否需要自动起播：没看完、没跳过、且不是刚被 Esc 暂停。 */
export function shouldAutoStart(t) {
  return !!t && !t.done && !t.skipped && t.index < stepCount(t);
}
