// P2「最小可玩切片」：只接 campaign + 推旬 + 战报文本 + 本机读档。
// 零 PNG、零 Canvas、零地图渲染、零结算层；页面只做注入与 setData，
// 所有局面逻辑在 utils/slice-core.js（可在 Node 里整条跑，见 tests/miniprogram-slice.test.mjs）。
import {
  bootSlice, pushTurn, hideSlice, showSlice, sliceSummary, SLICE_VERSION,
} from '../../utils/slice-core.js';
import { storage as platformStorage } from '../../logic/src/platform/index.js';

Page({
  data: {
    version: SLICE_VERSION,
    summary: null,
    lines: [],
    lifecycle: '冷启动',
    hash: '',
    err: '',
  },

  onLoad() {
    this._slice = bootSlice();
    this._hidden = false;
    this.setData({
      summary: sliceSummary(this._slice.state),
      hash: this._slice.hash,
      lifecycle: '冷启动 · 局面已建',
      lines: ['建安五年 · 一旬一推。此页只验逻辑层，不带战场、不带地图。'],
    });
  },

  onPush() {
    if (!this._slice) return;
    try {
      const r = pushTurn(this._slice);
      const next = [...r.lines, ...this.data.lines].slice(0, 24);
      if (!r.lines.length) next.unshift(`第 ${r.turn} 旬 · 无大事`);
      this.setData({ summary: r.summary, hash: r.summary.hash, lines: next, err: '' });
      if (r.outcome.over) {
        wx.showToast({ title: r.outcome.title, icon: 'none' });
      }
    } catch (e) {
      this.setData({ err: e.message || '推旬失败' });
    }
  },

  onHide() {
    if (!this._slice) return;
    const snap = hideSlice(this._slice);
    this._hidden = true;
    this._expectHash = snap.hash;
  },

  onShow() {
    // onLoad 之后也会触发一次 onShow；只有真切过后台才做恢复比对。
    if (!this._hidden || !this._slice) return;
    const r = showSlice({
      storage: platformStorage(),
      expectHash: this._expectHash,
    });
    if (!r.ok) {
      this.setData({ lifecycle: `回前台 · 读档失败（${r.reason}）`, err: r.reason });
      return;
    }
    this._slice = { state: r.state, rng: r.rng, cfg: r.cfg };
    this._hidden = false;
    this.setData({
      summary: r.summary,
      hash: r.hash,
      lifecycle: r.consistent
        ? '切后台回来 · 逐字段一致 ✓'
        : '切后台回来 · 指纹分叉（需排查）',
      err: '',
    });
  },

  onRead() {
    // 显式读档：冷启动后也能验「存档往返」，不必真的切 App。
    const r = showSlice({ storage: platformStorage() });
    if (!r.ok) { this.setData({ err: r.reason, lifecycle: '读档失败' }); return; }
    this._slice = { state: r.state, rng: r.rng, cfg: r.cfg };
    this._hidden = false;
    this.setData({
      summary: r.summary, hash: r.hash, err: '',
      lifecycle: `读档 · 第 ${r.turn} 旬`,
    });
  },

  onNew() {
    this._slice = bootSlice();
    this._hidden = false;
    this.setData({
      summary: sliceSummary(this._slice.state),
      hash: this._slice.hash,
      lines: ['另开一局'], lifecycle: '冷启动 · 局面已建', err: '',
    });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },
});
