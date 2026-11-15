// 授简界面层：唯一引用 DOM 的部分。
//
// 两条硬约束（都是被前面的版本踩过的坑）：
//  1. 遮罩 pointer-events:none，只有简卡与按钮吃指针 —— 高亮「拖地图 / 点地块」
//     这类步骤时，用户必须真的能操作底下的元素，否则会被引导锁死。
//  2. 简卡永远避开底栏（v0.4 把 #screen 让到 bottom:58px 才把 Tab 还回来），
//     不能因为多了一层引导又把 11 个入口盖掉。
import {
  createTutorial, currentStep, stepCount, isActive, progress,
  advance, prev, skip, restart, dismiss, notify,
  serializeTutorial, restoreTutorial,
} from './tutorial.js';

const STORE_KEY = 'sanguo-ce:tutorial:v1';

export function createTutorialUI({ def, onChange } = {}) {
  const layer = document.getElementById('tutorialLayer');
  const veil = layer.querySelector('.tutVeil');
  const focus = layer.querySelector('.tutFocus');
  const card = layer.querySelector('.tutCard');
  const t = createTutorial(def);
  let raf = 0, lastRectKey = '', onToast = null;

  function readStore() {
    try {
      const s = localStorage.getItem(STORE_KEY);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  }
  function writeStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serializeTutorial(t))); return true; }
    catch { return false; }
  }

  function rectsFor(selector) {
    if (!selector) return [];
    let els = [];
    try { els = [...document.querySelectorAll(selector)]; } catch { return []; }
    return els
      .filter((el) => {
        if (el.hidden || el.closest('[hidden]')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.right > 0 && r.bottom > 0 &&
        r.left < innerWidth && r.top < innerHeight);
  }

  function union(rs) {
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
    const r2 = Math.max(...rs.map((r) => r.right)), b2 = Math.max(...rs.map((r) => r.bottom));
    return { left: x, top: y, right: r2, bottom: b2, width: r2 - x, height: b2 - y };
  }

  function placeCard(u, place) {
    const cw = Math.min(358, innerWidth - 24);
    const ch = card.offsetHeight || 300;
    const topBar = 56, bottomBar = 66, pad = 12;
    let left = (innerWidth - cw) / 2, top = (innerHeight - ch) / 2;

    if (u && place !== 'center') {
      if (place === 'top') { left = u.left + u.width / 2 - cw / 2; top = u.top - ch - 16; }
      else if (place === 'bottom') { left = u.left + u.width / 2 - cw / 2; top = u.bottom + 16; }
      else if (place === 'left') { left = Math.min(innerWidth - cw - pad, u.right + 16); top = u.top + u.height / 2 - ch / 2; }
      else if (place === 'right') { left = u.left - cw - 16; top = u.top + u.height / 2 - ch / 2; }
      // 上下放不下就翻到另一侧；左右放不下就贴边。
      if ((top < topBar || top + ch > innerHeight - bottomBar)) {
        if (place === 'top') top = Math.min(innerHeight - bottomBar - ch, u.bottom + 16);
        else if (place === 'bottom') top = Math.max(topBar, u.top - ch - 16);
      }
      if (place === 'left' && u.right + 16 + cw > innerWidth) left = Math.max(pad, u.left - cw - 16);
      if (place === 'right' && u.left - cw - 16 < pad) left = Math.min(innerWidth - cw - pad, u.right + 16);
    }
    card.style.left = `${Math.max(pad, Math.min(innerWidth - cw - pad, left))}px`;
    card.style.top = `${Math.max(topBar, Math.min(innerHeight - bottomBar - ch, top))}px`;
    card.style.width = `${cw}px`;
  }

  function reposition() {
    if (!isActive(t)) return;
    const step = currentStep(t);
    const rs = rectsFor(step?.target);
    const u = union(rs);
    const full = u && (u.width * u.height) / (innerWidth * innerHeight) > 0.55;
    // 目标还没出现（例如信息卷轴尚未点开）时，不挖洞，只压一层淡暗。
    if (!u || full) {
      focus.style.opacity = '0';
      veil.dataset.mode = 'soft';
    } else {
      focus.style.opacity = '1';
      veil.dataset.mode = 'spot';
      const p = 7;
      focus.style.left = `${u.left - p}px`;
      focus.style.top = `${u.top - p}px`;
      focus.style.width = `${u.width + p * 2}px`;
      focus.style.height = `${u.height + p * 2}px`;
    }
    placeCard(u, step?.place ?? 'center');
    lastRectKey = `${u ? [u.left, u.top, u.width, u.height].map(Math.round).join(',') : 'none'}|${innerWidth}x${innerHeight}`;
  }

  function watch() {
    if (!isActive(t)) { raf = 0; return; }
    const step = currentStep(t);
    const u = union(rectsFor(step?.target));
    const key = `${u ? [u.left, u.top, u.width, u.height].map(Math.round).join(',') : 'none'}|${innerWidth}x${innerHeight}`;
    if (key !== lastRectKey) reposition();
    raf = requestAnimationFrame(watch);
  }

  function render() {
    const step = currentStep(t);
    if (!isActive(t) || !step) { layer.hidden = true; return; }
    layer.hidden = false;
    const n = stepCount(t), i = t.index + 1, last = i === n;
    card.innerHTML = `
      <div class="tutSeal" aria-hidden="true">${def.meta.seal}</div>
      <div class="tutNo">${step.no} · 共 ${n} 简</div>
      <h3>${esc(step.title)}</h3>
      <p class="tutBeat">${esc(step.beat)}</p>
      <div class="tutQuote">${esc(step.quote)}</div>
      <div class="tutTip">${step.await ? '▸ ' : '· '}${esc(step.tip)}</div>
      <div class="tutBar"><i style="width:${progress(t)}%"></i></div>
      <div class="tutBtns">
        <button type="button" data-tut="prev"${i === 1 ? ' disabled' : ''}>上一简</button>
        <button type="button" data-tut="skip">跳过授简</button>
        <button type="button" data-tut="next" class="btn-primary">${last ? '合 卷 · 自 行 经 略' : '下 一 简 →'}</button>
      </div>`;
    reposition();
    if (!raf) raf = requestAnimationFrame(watch);
    onChange?.(step, i, n);
  }

  function finish(msg) {
    if (!raf) return;
    cancelAnimationFrame(raf); raf = 0;
    if (msg) onToast?.(msg);
  }
  function hide() {
    t.active = false;
    layer.hidden = true;
    finish();
  }
  function start({ resume = false, toast } = {}) {
    onToast = toast ?? onToast;
    t.active = true;
    t.skipped = false;
    t.done = false;
    render();
  }
  function resumeOrStart({ toast } = {}) {
    const raw = readStore();
    const r = restoreTutorial(def, raw);
    t.index = r.index; t.done = r.done; t.skipped = r.skipped;
    t.seen = r.seen; t.completedBy = r.completedBy;
    if (t.done || t.skipped) { t.active = false; return false; }
    start({ toast });
    return true;
  }
  function replay({ toast } = {}) {
    restart(t);
    writeStore();
    start({ toast });
    return true;
  }
  function doAdvance(via, event) {
    const r = advance(t, via, event);
    if (!r.ok) return r;
    writeStore();
    if (r.finished) {
      hide();
      onToast?.('授简合卷 · 此后自行经略');
    } else render();
    return r;
  }
  function onEvent(event) {
    // notify() 内部已 advance 一步，这里只负责落盘与重绘，不能再 advance 一次。
    const r = notify(t, event);
    if (!r.ok) return r;
    writeStore();
    if (t.done) {
      hide();
      onToast?.('授简合卷 · 此后自行经略');
    } else render();
    return r;
  }

  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tut]');
    if (!b) return;
    const a = b.dataset.tut;
    if (a === 'next') doAdvance('manual');
    else if (a === 'prev') { const r = prev(t); if (r.ok) { writeStore(); render(); } }
    else if (a === 'skip') { skip(t); writeStore(); hide(); onToast?.('已跳过授简 · 系统页可重看'); }
  });

  function onKey(e) {
    if (!isActive(t)) return false;
    if (e.key === 'Escape') {
      e.preventDefault(); dismiss(t); writeStore(); hide();
      onToast?.('授简暂收 · 系统页可「重看行台授简」'); return true;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); doAdvance('manual'); return true; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); const r = prev(t); if (r.ok) { writeStore(); render(); } return true; }
    return false;
  }

  return {
    get state() { return t; },
    get active() { return isActive(t); },
    get index() { return t.index; },
    get done() { return t.done; },
    get skipped() { return t.skipped; },
    get step() { return currentStep(t); },
    start, resumeOrStart, replay, hide, render, reposition,
    notify: onEvent, advance: doAdvance, onKey, writeStore,
    storeKey: STORE_KEY,
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
