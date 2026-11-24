// P4 第二路径：把 src/platform/canvas.js 从「只给接口」推到「真被消费」。
// 本轮再加「可交互」：单指拖拽平移、双指捏合缩放、点击查格。
//
// 和切片页是两条独立路径：
//   · pages/slice/ 走 WXML 色块，零 PNG / 零 Canvas（回归基线，保持不动）
//   · pages/canvas/ 走 <canvas type="2d"> + wxCanvas() 拿 ctx，
//     用 applyDrawOps() 把 miniMapDrawOps() 的纯 JSON 指令画出来
//
// 数据层完全共用：miniMapOps(state, camera.opts()) 的指令一个字没改，
// 相机与命中也在镜像逻辑层（src/platform/mini-map.js / input.js），
// 页面只负责把 touch 事件喂进去 + setData。皮重写只重写皮，不是引擎。
import { wxCanvas, applyDrawOps, hostDpr } from '../../logic/src/platform/canvas.js';
import {
  bootSlice, pushTurn, sliceSummary, miniMapOps, miniCamera,
  miniResolveHit, normalizeTouches, pinchRatio,
} from '../../utils/slice-core.js';

Page({
  data: {
    painted: 0,
    dpr: 2,
    size: '',
    summary: null,
    err: '',
    status: '等待画布节点',
    zoom: '1.00',
    hit: null,
  },

  onLoad() {
    this._slice = bootSlice();
    this._cam = miniCamera(this._slice.state);
    this._touches0 = null;
    this._last = null;
    this._moved = false;
    this.setData({ summary: sliceSummary(this._slice.state), dpr: hostDpr(wx) });
  },

  onReady() {
    this._initCanvas();
  },

  _initCanvas() {
    const dpr = hostDpr(wx);
    wxCanvas('#mini', wx, { dpr })
      .then((c) => {
        if (!c?.ctx) {
          this._fail('拿不到 canvas 2d 节点（基础库或真机限制）');
          return;
        }
        this._c = c;
        this.setData({
          dpr: c.dpr, size: `${c.width}×${c.height}`, err: '',
          status: '画布就绪',
        });
        this._draw();
      })
      .catch((e) => this._fail(e.message || '画布初始化失败'));
  },

  _fail(reason) {
    // 不白屏、不静默吞掉：如实报错并留一条回色块页的路。
    this.setData({ err: reason, status: '画布不可用，可回色块页' });
    wx.showToast({ title: '画布不可用，已保留色块路径', icon: 'none' });
  },

  _rect() {
    return this._c?.rect ?? null;
  },

  _draw() {
    if (!this._c || !this._slice) return;
    try {
      const opts = this._cam.opts();
      const out = miniMapOps(this._slice.state, opts);
      const n = applyDrawOps(this._c.ctx, out.ops,
        this._c.width, this._c.height, { dpr: this._c.dpr });
      this.setData({
        painted: n, err: '', zoom: this._cam.zoomLevel().toFixed(2),
        status: `已画 ${n} 条指令 · ${out.cols}×${out.rows} 格`,
      });
    } catch (e) {
      this._fail(e.message || '绘制失败');
    }
  },

  // ── 手势：一律 clientX/clientY + 实时 rect 补一次命中 ──────────────
  onTouchStart(e) {
    const ts = normalizeTouches(e);
    this._touches0 = ts;
    this._last = ts[0] ?? null;
    this._moved = false;
  },

  onTouchMove(e) {
    const ts = normalizeTouches(e);
    const rect = this._rect();
    if (!rect || !ts.length) return;
    if (ts.length >= 2 && this._touches0?.length >= 2) {
      // 双指：距离比 → 缩放，锚点取两指中心（归一化到画布）
      const ratio = pinchRatio({ touches: this._touches0 }, { touches: ts });
      const mid = { clientX: (ts[0].clientX + ts[1].clientX) / 2,
        clientY: (ts[0].clientY + ts[1].clientY) / 2 };
      const anchor = { x: (mid.clientX - rect.left) / rect.width,
        y: (mid.clientY - rect.top) / rect.height };
      this._cam.zoom(ratio, anchor);
      this._touches0 = ts;
      this._last = null;
      this._moved = true;
      this._draw();
      return;
    }
    if (ts.length === 1 && this._last) {
      const p = ts[0];
      const dx = p.clientX - this._last.clientX, dy = p.clientY - this._last.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        const box = this._cam.box;
        // 手指往右/下拖 = 视野往左/上走，故取负；px → 源格按视口跨度换算
        this._cam.pan(-dx / rect.width * (box.c1 - box.c0),
          -dy / rect.height * (box.r1 - box.r0));
        this._moved = true;
        this._draw();
      }
      this._last = p;
    }
  },

  onTouchEnd(e) {
    if (!this._moved) {
      // 没移动过 = 点击：事件形状（touch/changedTouches）由 normalizePointer 归一
      const hit = miniResolveHit(e, this._rect(), this._slice.state, this._cam.opts());
      this.setData({ hit: hit ? {
        where: `${hit.sc},${hit.sr}（输出格 ${hit.c},${hit.r}）`,
        owner: hit.owner || '无主', terrain: hit.terrain,
        city: hit.cityId || '—', source: hit.source,
      } : null });
    }
    this._touches0 = null;
    this._last = null;
    this._moved = false;
  },

  onZoomIn() { this._cam.zoom(1.6); this._draw(); },
  onZoomOut() { this._cam.zoom(1 / 1.6); this._draw(); },
  onReset() { this._cam.reset(); this.setData({ hit: null }); this._draw(); },

  onPush() {
    if (!this._slice) return;
    pushTurn(this._slice);
    this.setData({ summary: sliceSummary(this._slice.state) });
    this._draw();
  },

  onRedraw() {
    this._draw();
  },

  onSlice() {
    wx.navigateTo({ url: '/pages/slice/index' });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },
});
