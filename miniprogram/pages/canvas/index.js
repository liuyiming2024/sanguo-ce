// P4 第二路径：把 src/platform/canvas.js 从「只给接口」推到「真被消费」。
//
// 和切片页是两条独立路径：
//   · pages/slice/ 走 WXML 色块，零 PNG / 零 Canvas（回归基线，保持不动）
//   · pages/canvas/ 走 <canvas type="2d"> + wxCanvas() 拿 ctx，
//     用 applyDrawOps() 把 miniMapDrawOps() 的纯 JSON 指令画出来
//
// 数据层完全共用：miniMapOps(state) 的指令一个字没改，浏览器端把同一份
// 指令喂给 2d ctx 也行。这就是「皮必须重写，但重写的是皮，不是引擎」。
import { wxCanvas, applyDrawOps, hostDpr } from '../../logic/src/platform/canvas.js';
import { bootSlice, pushTurn, sliceSummary, miniMapOps } from '../../utils/slice-core.js';

Page({
  data: {
    painted: 0,
    dpr: 2,
    size: '',
    summary: null,
    err: '',
    status: '等待画布节点',
  },

  onLoad() {
    this._slice = bootSlice();
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

  _draw() {
    if (!this._c || !this._slice) return;
    try {
      const out = miniMapOps(this._slice.state);
      const n = applyDrawOps(this._c.ctx, out.ops,
        this._c.width, this._c.height, { dpr: this._c.dpr });
      this.setData({
        painted: n, err: '',
        status: `已画 ${n} 条指令 · ${out.cols}×${out.rows} 格`,
      });
    } catch (e) {
      this._fail(e.message || '绘制失败');
    }
  },

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
