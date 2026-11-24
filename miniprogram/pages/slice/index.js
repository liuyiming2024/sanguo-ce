// P2「最小可玩切片」：只接 campaign + 推旬 + 战报文本 + 本机读档。
// 零 PNG、零 Canvas、零地图渲染、零结算层；页面只做注入与 setData，
// 所有局面逻辑在 utils/slice-core.js（可在 Node 里整条跑，见 tests/miniprogram-slice.test.mjs）。
//
// 本轮加「可交互」但仍守零 Canvas 基线：点 WXML 色块查格、按钮缩放视口。
// 相机与命中都在镜像逻辑层，页面只传 data-i 和按钮事件。
import {
  bootSlice, pushTurn, hideSlice, showSlice, sliceSummary, miniMap,
  miniCamera, miniHit, SLICE_VERSION,
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
    mini: null,
    cellW: 100 / 18,
    zoom: '1.00',
    hit: null,
  },

  _resetCamera() {
    this._cam = miniCamera(this._slice.state);
    this.setData({ hit: null });
  },

  _refreshMini() {
    if (!this._slice) return;
    if (!this._cam) this._cam = miniCamera(this._slice.state);
    const m = miniMap(this._slice.state, this._cam.opts());
    this.setData({ mini: m, cellW: 100 / m.cols,
      zoom: this._cam.zoomLevel().toFixed(2) });
  },

  onLoad() {
    this._slice = bootSlice();
    this._hidden = false;
    this._resetCamera();
    this._refreshMini();
    this.setData({
      summary: sliceSummary(this._slice.state),
      hash: this._slice.hash,
      lifecycle: '冷启动 · 局面已建',
      lines: ['建安五年 · 一旬一推。此页只验逻辑层，不带战场、不带地图。'],
    });
  },

  /** 点色块：data-i → 输出格 → 归一化点 → 镜像层的命中换算。 */
  onCellTap(e) {
    if (!this._slice || !this.data.mini) return;
    const i = Number(e?.currentTarget?.dataset?.i);
    if (!Number.isInteger(i) || i < 0) return;
    const m = this.data.mini;
    const oc = i % m.cols, or = Math.floor(i / m.cols);
    const hit = miniHit(this._slice.state, this._cam.opts(),
      { x: (oc + 0.5) / m.cols, y: (or + 0.5) / m.rows });
    this.setData({ hit: hit ? {
      where: `${hit.sc},${hit.sr}（格 ${hit.c},${hit.r}）`,
      owner: hit.owner || '无主', terrain: hit.terrain,
      city: hit.cityId || '—',
    } : null });
  },

  onZoomIn() { this._cam.zoom(1.6); this.setData({ hit: null }); this._refreshMini(); },
  onZoomOut() { this._cam.zoom(1 / 1.6); this.setData({ hit: null }); this._refreshMini(); },
  onReset() { this._cam.reset(); this.setData({ hit: null }); this._refreshMini(); },

  onPush() {
    if (!this._slice) return;
    try {
      const r = pushTurn(this._slice);
      const next = [...r.lines, ...this.data.lines].slice(0, 24);
      if (!r.lines.length) next.unshift(`第 ${r.turn} 旬 · 无大事`);
      this.setData({ summary: r.summary, hash: r.summary.hash, lines: next, err: '' });
      this._refreshMini();
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
    this._resetCamera();
    this._refreshMini();
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
    this._resetCamera();
    this._refreshMini();
    this.setData({
      summary: r.summary, hash: r.hash, err: '',
      lifecycle: `读档 · 第 ${r.turn} 旬`,
    });
  },

  onNew() {
    this._slice = bootSlice();
    this._hidden = false;
    this._resetCamera();
    this._refreshMini();
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
